window.__ModuleLoader__.load({ id: "dsh-streamfold", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * dsh-streamfold v0.2 —— 流式折叠（DSH Web 显示增强）
 *
 * 模型只有两条：
 *  1) 正在跑的那一轮：只自动展开本轮**最新的那一个**思考小窗；被取代的旧窗按 supersedeDelay 秒后折回一行摘要
 *     （工具卡默认不自动展开）；
 *  2) 其它所有轮次：过程行全量折叠成一条「已折叠 N 行 · 点击展开」；
 *     点开展开时，行回来了但**思考保持一行摘要**（不自动展开），想深看单条自己点。
 *
 * 边界（DSH 0.1.5-rc.2 实测，勿改）：
 *  - 行 wrapper：[data-chat-flow] > [data-chat-flow-kind][data-chat-turn][data-chat-flow-key]
 *  - 思考：根 [data-variant="think"]，正文 [class*="_thinkBody"]（仅展开时挂载）
 *  - 工具：根 [data-tool]，正文 [class*="_bodyScroll"] 或 [class*="_bodyWrap"]（仅展开时挂载）
 *  - 展开控件：[data-disclosure-row][aria-expanded]，祖先 [data-open]；正文条件挂载 → 必须先点开
 *  - 条件属性不可当判据：data-turn-process-inline / data-expanded 只在特定状态存在
 *  - 一次尝试只能触发一种事件：click 与 Enter 各 toggle 一次，同时发 = 白干
 */
const React = require("react");
const h = React.createElement;

const NS = "dsh-streamfold";
const NATIVE_NS = "ui-chat";
const NATIVE_FIELD = "transcriptView";
const DEFAULTS = {
  mode: "native",             // native = 官方标准/紧凑；fold = 本插件
  foldHistory: true,          // 非运行中的轮次是否自动折叠（默认是）
  keepInterleavedText: false, // 折叠时保留"穿插正文"行（只有正文，不含思考）
  windowHeight: 260,
  autoFollow: true,
  showJumpButton: true,
  animations: true,
  autoExpandReasoning: true,   // 运行中的那一轮自动展开思考
  autoExpandTools: false,      // 运行中的那一轮自动展开工具（默认不展开：工具卡自己点）
  settleToPrompt: true,        // 一轮跑完后平滑移到本轮提问处（读者已接管滚动时不动）
  pinPrompt: true,             // 置顶显示提问：跟着"正在看的那一轮"换，超过一行只显示一行
  smoothGrow: 0.15,            // 跟随底部时每帧吃掉多少差距（越小越柔）
  smoothMin: 1,                // 每 16ms 至少推进多少像素
  supersedeDelay: 2,           // 运行中旧的思考窗被取代后，延迟多少秒再自动折回
  sparks: true,                // 思考小窗底部的火星特效（独立模块，见「火星特效」一节）
  sparkColor: "#4fa8ff",       // 火星颜色（核心自动提亮成白热）
  sparkDensity: 1,             // 火星数量倍率（0.2~3）
  forgeSparks: true,           // 正文流式写头的"锻打"火星（独立开关，同一个火星模块）
  forgeSpeed: 1,               // 锻打火星速度倍率（0.2~4）
  forgeLife: 1.3,              // 锻打火星寿命（秒，0.2~5；实际在 ±30% 内随机）
};

/* ---------------------------------------------------------------- store -- */
const listeners = new Set();
let state = { ...DEFAULTS };
try {
  const cached = JSON.parse(localStorage.getItem(NS) || "null");
  if (cached && typeof cached === "object") state = normalize({ ...state, ...cached });
} catch { /* ignore */ }
function normalize(next) {
  if (typeof next.autoExpandReasoning === "string") next.autoExpandReasoning = next.autoExpandReasoning !== "off";
  if (typeof next.autoExpandTools === "string") next.autoExpandTools = next.autoExpandTools !== "off";
  return next;
}
let nativeValue = "standard";
let nativeScope = null;
/* 官方「工作步骤展示」档位（0.1.7）：与官方 TRANSCRIPT_VIEW_MODES 同步；
   normal/expanded 是上一代的取值，0.1.7 只在读取时按 standard/detailed 兼容。 */
const NATIVE_MODES = ["compact", "standard", "detailed", "verbose"];
const NATIVE_ALIAS = { normal: "standard", expanded: "detailed" };
const NATIVE_LABELS = { compact: "简洁", standard: "标准", detailed: "详细", verbose: "完全展开", fold: "折叠" };
let tChat = null;   // 官方 chat 词典：标签就跟官方设置页一致，改动由官方那边带过来
const modeLabel = (mode) => {
  const fallback = NATIVE_LABELS[mode] || mode;
  if (!tChat) return fallback;
  try {
    const text = tChat("settings.transcript." + mode);
    return typeof text === "string" && text !== "settings.transcript." + mode ? text : fallback;
  } catch { return fallback; }
};

const snapshot = () => state;
const emit = () => {
  sparks.setOptions({ on: state.sparks !== false, color: state.sparkColor, density: state.sparkDensity, forge: state.forgeSparks !== false, forgeSpeed: state.forgeSpeed, forgeLife: state.forgeLife });
  for (const fn of Array.from(listeners)) { try { fn(); } catch { /* ignore */ } }
};
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const persistLocal = () => { try { localStorage.setItem(NS, JSON.stringify(state)); } catch { /* ignore */ } };

function setSettings(patch) {
  state = normalize({ ...state, ...patch });
  persistLocal();
  emit();
}
function useSettings() {
  const [snap, setSnap] = React.useState(snapshot);
  React.useEffect(() => subscribe(() => setSnap(snapshot())), []);
  return snap;
}
function displayChoice() {
  if (state.mode === "fold") return "fold";
  return NATIVE_MODES.includes(nativeValue) ? nativeValue : "standard";
}
let nativePinned = false;   // 官方取值是否已校正（只做一次，避免写值 → 订阅 → 再写的回环）
let nativeProbing = false;  // 写入进行中（挡住订阅回调重入）
let nativeTries = 0;        // 写入被拒的次数（失败会经订阅回调回到这里，不能无限重写）
const NATIVE_TRIES_MAX = 3;
/** 折叠模式必须让官方「别自己折」：0.1.7 的四档里只有 verbose 是 foldCompletedTurns=false + stepGrouping=none
 *  （= 完全展开），其余三档官方自己就会折叠或分组，会和我们的折叠双重生效。
 *  镜像没就绪时不写、也不落定 —— 订阅回调会再来一次。 */
async function enforceNativeBaseline() {
  if (nativePinned || nativeProbing || nativeTries >= NATIVE_TRIES_MAX || state.mode !== "fold" || !nativeScope) return;
  const section = nativeScope.getSnapshot();
  if (!section || section.status !== "ready") return;
  nativeProbing = true;
  try {
    const value = section.value ? section.value[NATIVE_FIELD] : undefined;
    let ok = value === "verbose";
    // set() 的返回值 = 宿主是否接受写入。被拒（只读/内存态宿主）时必须当作没做成：
    // 否则我们谎报 nativeValue、官方那条 hidden 永远清不掉（React 的 layout effect 依赖不变、不会自愈）。
    if (!ok) {
      nativeTries += 1;
      try { ok = (await nativeScope.set(NATIVE_FIELD, "verbose")) === true; } catch { ok = false; }
    }
    if (!ok) return;                                  // 订阅回调会重试，最多 NATIVE_TRIES_MAX 次
    nativeValue = "verbose";
    nativePinned = true;
  } finally { nativeProbing = false; }
}
function chooseDisplay(choice) {
  if (choice === "fold") {
    // 以「官方不折叠」那一档为底：官方自己折了的话，点开我们折叠条时官方那份 hidden 还在，等于打架。
    // 「折叠」以官方「完全展开」为底：官方自己不折、不分组，折叠只由我们做。
    if (nativeScope) { try { Promise.resolve(nativeScope.set(NATIVE_FIELD, "verbose")).catch(() => {}); } catch { /* ignore */ } }
    nativeValue = "verbose";
    setSettings({ mode: "fold" });
    return;
  }
  setSettings({ mode: "native" });
  if (nativeScope) { try { Promise.resolve(nativeScope.set(NATIVE_FIELD, choice)).catch(() => {}); } catch { /* ignore */ } }
  nativeValue = choice;
}

/* ------------------------------------------------------------------ css -- */
const STYLE_ID = "dsh-streamfold/styles";
const CSS = [   // 本文件的样式表字符串（名字遮蔽了浏览器全局 CSS 对象，本插件已不再用 CSS.highlights）
  ":root{--dshsf-h:260px}",
  "[data-chat-flow]{overflow-anchor:none}",   // 滚动位置只由我们和读者决定，别让浏览器锚定插一脚
  "[data-dshsf-native-row]{display:none!important}",
  /* 限高滚动窗：一个位置只有一个滚动条 */
  "[data-dshsf-window]{max-height:var(--dshsf-h);overflow:auto;overscroll-behavior:contain;contain:content;scrollbar-gutter:stable;",
  "scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35)) transparent;",
  "border-radius:8px;padding:2px 8px 2px 6px;margin-right:4px;",
  "transition:background-color .2s ease,box-shadow .2s ease}",   // 高度由 tickFollow 每帧推进：固定过渡跟不上快输出，不要用
  "[data-dshsf-window='reasoning']{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}",
  /* 穿插正文小窗：折叠后仍保留的正文行，限高内滚 + 毛玻璃底（与思考小窗同一套跟随/回底） */
  "[data-dshsf-textwindow]{max-height:var(--dshsf-h);overflow:auto;overscroll-behavior:contain;contain:content;scrollbar-gutter:stable;",
  "scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35)) transparent;",
  "border-radius:12px;padding:8px 12px;margin:4px 0 8px;",
  "border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));",
  "background:rgba(127,127,127,.08);",
  "background:color-mix(in srgb,var(--dsw-alias-label-primary,#7a869a) 5%,transparent);",
  "backdrop-filter:blur(14px) saturate(150%);",
  "-webkit-backdrop-filter:blur(14px) saturate(150%);",
  "box-shadow:0 1px 3px rgba(0,0,0,.06)}",
  /* 穿插正文与正式答案之间的分隔线（用 l3：l1/l2 的 alpha 太低，画了看不见） */
  "[data-dshsf-answer-sep]{border-top:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.38));padding-top:10px}",
  "@keyframes dshsf-window-in{from{max-height:0;opacity:0;transform:translateY(-3px)}to{max-height:var(--dshsf-hw,var(--dshsf-h));opacity:1;transform:none}}",
  "html[data-dshsf-anim] [data-dshsf-window]{animation:dshsf-window-in .26s var(--ds-ease-out,cubic-bezier(.2,.8,.2,1)) backwards}",
  "[data-dshsf-window][data-dshsf-closing]{transition:max-height .2s var(--ds-ease-in,ease),opacity .2s ease}",
  "@keyframes dshsf-body-in{from{max-height:0;opacity:0}to{max-height:var(--dshsf-h0,2000px);opacity:1}}",
  "html[data-dshsf-anim] [data-dshsf-reveal]{animation:dshsf-body-in .26s var(--ds-ease-out,cubic-bezier(.2,.8,.2,1)) backwards;overflow:hidden}",
  "[class*='_bodyWrap'][data-dshsf-closing]{transition:max-height .2s var(--ds-ease-in,ease),opacity .2s ease}",
  "html[data-dshsf-anim] [data-context-injection-body][data-dshsf-reveal]{overflow:auto}",   // 官方这块正文自带内滚，别被上面的通用规则压成 hidden
  "[data-dshsf-reveal][data-dshsf-closing],[data-context-injection-body][data-dshsf-closing]{transition:max-height .2s var(--ds-ease-in,ease),opacity .2s ease}",
  "[data-dshsf-window]::-webkit-scrollbar,[data-dshsf-textwindow]::-webkit-scrollbar{width:8px;height:8px}",
  "[data-dshsf-window]::-webkit-scrollbar-thumb,[data-dshsf-textwindow]::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35));border-radius:4px}",
  "[data-dshsf-window]::-webkit-scrollbar-track,[data-dshsf-textwindow]::-webkit-scrollbar-track{background:transparent}",
  "[data-dshsf-window][data-dshsf-offbottom]{box-shadow:inset 0 -14px 12px -14px var(--dsw-alias-label-caption,rgba(0,0,0,.4))}",
  /* 折叠 / 折叠条 / 回到底部 */
  "[data-dshsf-row]{transition:max-height .3s var(--ds-ease-in-out,ease),opacity .22s ease}",
  "[data-dshsf-folded]{max-height:0;opacity:0;overflow:hidden;margin-top:0!important;margin-bottom:0!important}",
  // 折叠内容跳过渲染走 hidden="until-found"（长会话最大的一笔省项）：
  // 它和 content-visibility:hidden 一样不布局，但**允许 Ctrl+F 搜到**并在命中前派发 beforematch。
  // 注意：不能自己写 [data-x]{content-visibility:hidden}——那样内容不进布局树，Chrome 的查找就找不到它。
  "[data-dshsf-chip]{display:flex;align-items:center;gap:6px;width:100%;margin:2px 0 6px;padding:3px 10px;",
  "border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:999px;",
  "background:rgba(127,127,127,.08);",
  "background:color-mix(in srgb,var(--dsw-alias-label-primary,#7a869a) 5%,transparent);",
  "backdrop-filter:blur(14px) saturate(150%);",
  "-webkit-backdrop-filter:blur(14px) saturate(150%);",
  "color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px;cursor:pointer;text-align:left;",
  "transition:background-color .18s ease,color .18s ease}",
  "[data-dshsf-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary,#666)}",
  "[data-dshsf-jump]{position:sticky;bottom:6px;float:left;margin-left:6px;z-index:3;display:inline-flex;align-items:center;justify-content:center;gap:4px;",
  "padding:4px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));",
  "background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-secondary,#555);",
  "font-size:12px;line-height:18px;cursor:pointer;box-shadow:var(--dsw-elevation-panel,0 2px 8px rgba(0,0,0,.12));",
  "opacity:0;transform:translateY(4px);transition:opacity .2s ease,transform .2s ease}",
  "[data-dshsf-jump][data-dshsf-visible]{opacity:1;transform:translateY(0)}",
  /* 主窗口那颗回底按钮：外观与位置都用官方的，只把"何时出现"接管过来——默认藏起来，
     只有我们判定"读者接管了、而且确实离底"时才放出来（官方自己按 25px 阈值无滞回地切 = 闪）。 */
  "[class*='_toBottomSlot']{display:none}",
  "html[data-dshsf-jumpgate] [class*='_toBottomSlot']{display:flex}",
  "[data-dshsf-jump]>svg{display:block}",
  /* 置顶的提问：固定层贴在会话视口顶端，跟着"正在看的那一轮"换；超过一行只显示一行，它自己在视口里时让位。 */
  "[data-dshsf-pin]{position:fixed;z-index:7;display:none;cursor:pointer;box-sizing:border-box;",
  "padding:5px max(16px,calc((100% - var(--dsh-chat-content-width,100%)) / 2 + 16px));",
  "background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 90%,transparent);",
  "border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));",
  "color:var(--dsw-alias-label-secondary,#555);font-size:12px;line-height:18px;",
  "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  "[data-dshsf-pin][data-dshsf-visible]{display:block}",
  /* 火星特效：零高度 sticky 容器贴住可视底边，画布往上铺——容器不参与布局，窗口高度与 scrollHeight 都不受影响 */
  "[data-dshsf-spark]{position:fixed;left:0;top:0;display:block;pointer-events:none;z-index:9999;will-change:transform}",   // 固定层：位置由 JS 每帧摆
  /* 设置页 */
  ".dshsf-row{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}",
  ".dshsf-row:last-child{border-bottom:none}",
  ".dshsf-rowMain{flex:1;min-width:0}",
  ".dshsf-rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
  ".dshsf-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px}",
  ".dshsf-switch{position:relative;width:34px;height:20px;flex:none;border-radius:10px;cursor:pointer;padding:0;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));transition:background-color .18s ease}",
  ".dshsf-switch[aria-checked='true']{background:var(--dsw-alias-state-business-primary,#2f6fed);border-color:transparent}",
  ".dshsf-switch:after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .18s ease}",
  ".dshsf-switch[aria-checked='true']:after{transform:translateX(14px)}",
  ".dshsf-num{width:88px;padding:4px 8px;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,transparent));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
  ".dshsf-rangeWrap{display:flex;align-items:center;gap:10px;flex:none}",
  ".dshsf-range{width:150px;accent-color:var(--dsw-alias-state-business-primary,#2f6fed);cursor:pointer;background:transparent}",
  ".dshsf-rangeVal{min-width:34px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}",
  ".dshsf-rowCol{flex-direction:column;align-items:stretch;gap:8px}",
  ".dshsf-color{width:44px;height:24px;padding:0;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;cursor:pointer}",
  /* 「工作步骤展示」下拉：外形向官方设置页那排菜单靠（半透明卡片 + 大圆角 + 同一套色 token） */
  ".dshsf-select{position:relative;display:inline-flex;flex:none}",
  ".dshsf-selectBtn{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;min-width:76px;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,transparent));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;cursor:pointer;transition:background-color .16s ease}",
  ".dshsf-selectBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
  ".dshsf-caret{font-size:9px;line-height:1;color:var(--dsw-alias-label-secondary)}",
  ".dshsf-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:1100;min-width:132px;padding:3px;display:flex;flex-direction:column;border-radius:16px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#222));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.28))}",
  ".dshsf-menuItem{padding:6px 10px;font-size:12px;text-align:left;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;cursor:pointer}",
  ".dshsf-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
  ".dshsf-menuItem[data-active]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.16))}",
  ".dshsf-page{display:flex;flex-direction:column;gap:6px;padding:4px 2px 24px}",
  ".dshsf-intro{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:2px 0 10px}",
  ".dshsf-group{border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:12px;padding:2px 14px;background:var(--dsw-alias-bg-layer-1,transparent)}",
  ".dshsf-actions{display:flex;gap:8px;margin-top:14px}",
  ".dshsf-btn{padding:5px 14px;border-radius:8px;font-size:12px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary);transition:background-color .16s ease}",
  ".dshsf-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
  "@media (prefers-reduced-motion: reduce){[data-dshsf-window],[data-dshsf-textwindow],[data-dshsf-row],[data-dshsf-chip],[data-dshsf-jump],.dshsf-switch,.dshsf-switch:after{transition:none!important;animation:none!important}}",
].join("");

function injectStyles() {
  // 总是换成当前这一份：热重载时旧 style 标签还在，但规则可能是上个版本的 —— 不换掉，CSS 改动在刷新页面前
  // 根本不生效（表现就是"代码改了、界面没变"，比如官方那颗回底按钮藏不掉 → 屏幕上两个按钮）。
  for (const old of document.querySelectorAll("style[data-plugin-css='" + STYLE_ID + "']")) { try { old.remove(); } catch { /* ignore */ } }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-streamfold";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => { tag.remove(); };
}
function rootVars() {
  const root = document.getElementById("root") || document.documentElement;
  const h = Math.max(80, Number(state.windowHeight) || 260) + "px";
  if (root.style.getPropertyValue("--dshsf-h") !== h) root.style.setProperty("--dshsf-h", h);
  document.documentElement.toggleAttribute("data-dshsf-anim", state.animations !== false && allowAnim);
}

/* ------------------------------------------------------------- 常量/工具 -- */
const CHAT_FLOW = "[data-chat-flow]";
const ROW = "[data-chat-flow-kind]";
const TOGGLE = "[data-disclosure-row], [role='button'][aria-expanded]";   // 展开/收起控件：点它 = 我要读这一处
const THINK = '[data-variant="think"]';
const THINK_BODY = '[class*="_thinkBody"]';
const TOOL_CARD = "[data-tool], [data-sample='bash']";   // bash 卡走 BashRow，根上没有 data-tool
const CTX_BODY = "[data-context-injection-body]";        // 上下文注入行的正文（根上只有哈希 class，只能从正文反推根）
const TOOL_BODY = '[class*="_bodyScroll"], [class*="_bodyWrap"]';
// 一次遍历拿到"所有已挂载的正文"，替代三次全量查询（思考/工具/上下文各一次）
const BODY_ANY = '[class*="_thinkBody"], [class*="_bodyScroll"], [class*="_bodyWrap"], [data-context-injection-body]';
// 运行中的标记：思考行 data-state=running、正文 data-streaming、工具卡 data-state=running|preparing
// （工具执行期间没有流式文本，只靠前两个会误判成"跑完了" → 运行中来一次全量折叠）
const RUNNING = '[data-state="running"], [data-state="preparing"], [data-streaming]';
const RUN_GRACE_MS = 700;   // 运行标记消失多久才算真跑完（步骤/工具交接的空档不算）
let runningSticky = false;
let contractWarned = false;   // 官方收尾标记的契约自检只报一次
let lastRunningAt = 0;
let runGraceTimer = 0;
const INDEPENDENT = new Set(["user", "steering", "system-prompt", "turn-trigger", "turn-error", "turn-max-tokens", "turn-tail", "turn-process", "compaction", "manual-compaction", "command", "request-prompt"]);   // 前 8 个与官方 TURN_PROCESS_INDEPENDENT_KINDS 对齐（0.1.7 新增 turn-trigger）
const inViewport = (el) => { const r = el.getBoundingClientRect(); return r.bottom > -400 && r.top < (window.innerHeight || 800) + 600; };
const rowKind = (row) => row.getAttribute("data-chat-flow-kind");
const disclosureTarget = (root) => root.matches("[role='button'][aria-expanded], [data-expandable]") ? root
  : (root.querySelector("[data-disclosure-row]") || root.querySelector("[role='button'], [aria-expanded], button"));
let synthetic = false;   // 我方派发的事件（捕获拦截器要放行，否则会自己拦自己）
const clickOnce = (el) => {
  synthetic = true;
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return true;
  } catch { return false; } finally { synthetic = false; }
};
/** 把元素高度收到 0（先测高再过渡），结束回调里再让 React 真正收起。 */
function animateClose(el, done) {
  el.dataset.dshsfClosing = "1";
  el.style.overflow = "hidden";
  el.style.maxHeight = el.getBoundingClientRect().height + "px";
  void el.offsetHeight;
  requestAnimationFrame(() => { el.style.maxHeight = "0px"; el.style.opacity = "0"; });
  setTimeout(done, 200);
}
/** 用户点收起时先播动画再放行：捕获阶段拦下 React 的 onClick。 */
function wireDisclosure(root, isOpen, bodySel, onUserClose) {
  if (root.dataset.dshsfWired === "1") return;
  root.dataset.dshsfWired = "1";
  root.addEventListener("click", (event) => {
    if (synthetic || !isOpen(root)) return;                       // 我方事件 / 是展开动作 → 放行
    if (event.target instanceof Element && event.target.closest(bodySel)) return;   // 点在正文里 → 放行
    if (state.animations === false || !allowAnim) return;         // 关了动效就直接放行
    const body = bodyOf(root, bodySel);
    if (!body || body.dataset.dshsfClosing === "1") return;
    event.preventDefault();
    event.stopPropagation();
    if (onUserClose) onUserClose(root);
    animateClose(body, () => clickOnce(disclosureTarget(root)));
  }, true);
}
const thinkOpen = (root) => root.querySelector(THINK_BODY) !== null;
/** 展开正文：通用工具卡在 root 内（[data-tool] > _bodyWrap）；bash 卡的折叠行与正文是 .card 下的兄弟节点。 */
const bodyOf = (root, sel) => {
  const own = root.querySelector(sel);
  if (own) return own;
  const sibling = root.nextElementSibling;
  return sibling && sibling.matches && sibling.matches(sel) ? sibling : null;
};
const toolOpen = (root) => bodyOf(root, TOOL_BODY) !== null;

/** 一段子树里"除思考之外"的文字（思考整块跳过；hidden 的不算）。不看层级假设，避免结构一变就漏判。 */
/** hidden="until-found" 是折叠标记（内容还在，只是跳过渲染），不算官方藏起来的行。 */
const isHiddenNode = (node) => node.hasAttribute("hidden") && node.getAttribute("hidden") !== SKIP;
function rowText(el, skip, limit) {
  let out = "";
  const walk = (node) => {
    if (limit !== undefined && out.length >= limit) return;   // 只取前 limit 字：置顶条只显示一行，没必要走完整棵子树
    if (node.nodeType === 3) { out += node.nodeValue || ""; return; }
    if (node.nodeType !== 1) return;
    if (isHiddenNode(node) || node.hasAttribute("data-dshsf-jump")) return;
    if (skip !== undefined && skip(node)) return;
    if (node.matches && (node.matches(THINK) || node.matches(TOOL_CARD) || node.hasAttribute("data-context-injection-body"))) return;   // 过程块整块跳过（工具输出不是穿插正文，而且往往是最大的子树）
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return (limit !== undefined && out.length > limit ? out.slice(0, limit) : out).trim();
}
/** 只判"有没有正文"：命中第一个非空白文字就收工（比 rowText 便宜，扫描里每行都要用）。 */
function hasRowText(el) {
  const walk = (node) => {
    if (node.nodeType === 3) return (node.nodeValue || "").trim() !== "";
    if (node.nodeType !== 1) return false;
    if (isHiddenNode(node) || node.hasAttribute("data-dshsf-jump")) return false;
    if (node.matches && (node.matches(THINK) || node.matches(TOOL_CARD) || node.hasAttribute("data-context-injection-body"))) return false;   // 同上：别为工具输出白走一遍
    for (const child of node.childNodes) if (walk(child)) return true;
    return false;
  };
  return walk(el);
}
let textCache = new WeakMap();   // 行 → 有没有正文：跨扫描保留（已定轮的正文不会再变，WeakMap 不担心会话切换泄漏）
let hotRows = new WeakSet();     // 最近两轮的行：正文可能还在变 → 每次扫描重算
/** assistant-step 行里除思考外是否真有正文。 */
function hasText(row) {
  if (rowKind(row) !== "assistant-step") return false;
  if (!hotRows.has(row)) {
    const hit = textCache.get(row);
    if (hit !== undefined) return hit;      // 老轮次：正文不会再变，直接用上次结果（省掉整棵子树的文本遍历）
  }
  cost.counts.hasText = (cost.counts.hasText || 0) + 1;
  const t = performance.now();
  // 整行判：hasRowText 会跳过思考/工具卡/隐藏子树，正好回答"这一行有没有正式正文"。
  // 不再依赖 assistantBody 的具体层级 —— 0.1.7 的行结构变过，认错容器会让正文行被当成过程行，
  // 跑完收尾时连回答一起折掉（就是"全量折叠"）。
  const result = hasRowText(row);
  cost.phases.hasText = +((cost.phases.hasText || 0) + (performance.now() - t)).toFixed(2);
  textCache.set(row, result);
  return result;
}
/** 行里承载「正式正文」的容器。0.1.5 是 row > markdown > body；0.1.7 多包了一层，
 *  所以按「哪个子节点真的有字」挑，都认不出来才退回行本身（下游会跳过思考/工具卡子树）。 */
function assistantBody(row) {
  const inline = row.querySelector("[data-turn-process-inline]");
  if (inline && inline.parentElement) return inline.parentElement;
  const md = row.firstElementChild;
  if (!md) return row;
  const nested = md.firstElementChild;
  if (nested && (nested.textContent || "").trim() !== "") return nested;
  return md;
}

/* ------------------------------------------------------- 展开/收起（点） -- */
let busyWork = false;   // 本轮扫描是否还有没做完的展开/收起 → 继续排下一轮
let closeBudget = 0;    // 每次扫描最多收起 2 个思考（避免一次几十个重渲染）

function openThink(root) {
  if (thinkOpen(root)) { root.dataset.dshsfAuto = "1"; return false; }
  if (root.dataset.dshsfKeepOpen === "1") return false;      // 用户收起过，不抢
  const tries = Number(root.dataset.dshsfTries || "0");
  if (tries >= 8) return false;
  const now = Date.now();
  if (now - Number(root.dataset.dshsfAt || "0") < 260) return false;   // 等 React 提交
  root.dataset.dshsfAt = String(now);
  root.dataset.dshsfTries = String(tries + 1);
  const target = disclosureTarget(root);
  if (!target) return false;
  const tOpen = performance.now();          // 合成 click → 官方挂载/渲染正文，这是"net"往外的 React 成本
  if (!clickOnce(target)) return false;
  cost.phases.openThink = +((cost.phases.openThink || 0) + (performance.now() - tOpen)).toFixed(2);
  cost.counts.opens = (cost.counts.opens || 0) + 1;
  clearSearchHidden(root.closest(ROW) || root);
  autoThinks.add(root);
  root.dataset.dshsfAuto = "1";        // 这次展开是我方行为
  delete root.dataset.dshsfSupersededAt;   // 它又成了"最新那个"，撤销折叠宽限
  const pending = Number(root.dataset.dshsfCloseTimer || "0");
  if (pending) { clearTimeout(pending); delete root.dataset.dshsfCloseTimer; }
  tagThinkWindow(root.querySelector(THINK_BODY));   // 当场打标：晚一帧就会先闪一下没有小窗的样子
  return true;
}
/** 收起一块已展开的正文：能动画就先收下去再放行 React 的收起（否则正文会被直接卸载，看不到过程）。 */
function collapse(root, isOpen, bodySel, atKey, triesKey) {
  if (!isOpen(root)) return false;
  const tries = Number(root.dataset[triesKey] || "0");
  if (tries >= 6) return false;
  const now = Date.now();
  if (now - Number(root.dataset[atKey] || "0") < 260) return false;
  root.dataset[atKey] = String(now);
  root.dataset[triesKey] = String(tries + 1);
  const target = disclosureTarget(root);
  if (!target) return false;
  const body = bodyOf(root, bodySel);
  if (body && state.animations !== false && allowAnim && animBudget > 0 && body.dataset.dshsfClosing !== "1") {
    animBudget -= 1;
    layoutReads += 1;
    body.dataset.dshsfClosing = "1";
    body.setAttribute("data-dshsf-closing", "");
    body.style.overflow = "hidden";
    body.style.maxHeight = body.getBoundingClientRect().height + "px";
    void body.offsetHeight;
    requestAnimationFrame(() => { body.style.maxHeight = "0px"; body.style.opacity = "0"; });
    setTimeout(() => {
      const late = disclosureTarget(root);
      if (late) clickOnce(late);
    }, 200);
    return true;
  }
  return clickOnce(target);
}
function closeThink(root) {
  if (root.dataset.dshsfKeepOpen === "1") return false;      // 用户点开的，永远不动
  if (!thinkOpen(root)) { delete root.dataset.dshsfAuto; autoThinks.delete(root); return false; }
  if (root.dataset.dshsfAuto !== "1") { root.dataset.dshsfKeepOpen = "1"; autoThinks.delete(root); return false; }  // 非我方打开 = 用户
  autoThinks.delete(root);
  return collapse(root, thinkOpen, THINK_BODY, "dshsfCloseAt", "dshsfCloseTries");
}
function closeTool(root) {
  autoTools.delete(root);
  if (!toolOpen(root)) { delete root.dataset.dshsfToolAuto; return false; }
  if (root.dataset.dshsfToolAuto !== "1") return false;      // 用户自己开的，不动
  return collapse(root, toolOpen, TOOL_BODY, "dshsfToolCloseAt", "dshsfToolCloseTries");
}
/** 展开后按实测高度播揭示动画：固定 2000px 上限对矮卡片等于"瞬间全开"，只有量到真实高度才看得见展开。 */
let lastReveal = null;
let lastWindow = null;
const ANIM_MAX_PX = 1200;   // 超过这个高度就别逐帧算 max-height 了：一次展开要重排几百毫秒，肉眼看不出区别
function revealBody(body, preHeight) {
  if (!body || body.dataset.dshsfReveal === "1" || body.dataset.dshsfNoReveal === "1" || body.dataset.dshsfClosing === "1") return;
  if (state.animations === false || !allowAnim) return;
  let height = Math.ceil(preHeight === undefined ? body.getBoundingClientRect().height : preHeight);
  if (body.parentElement && body.parentElement.closest("[data-dshsf-window], [data-dshsf-textwindow]")) {
    height = Math.min(height, windowCap() + 40);       // 窗外那部分本来就被裁掉，动画目标不必长到几千像素
  } else if (height > ANIM_MAX_PX) {
    body.dataset.dshsfNoReveal = "1";                  // 太高：直接出现
    return;
  }
  body.dataset.dshsfReveal = "1";
  body.style.setProperty("--dshsf-h0", height + "px");
  const record = { wrap: body.className, h: height };
  lastReveal = record;
  // 诊断：40ms 后回读计算样式，看动画是否真的挂在元素上
  setTimeout(() => {
    const cs = getComputedStyle(body);
    lastReveal = { ...record, anim: cs.animationName, dur: cs.animationDuration, fill: cs.animationFillMode, now: Math.round(body.getBoundingClientRect().height), attr: document.documentElement.hasAttribute("data-dshsf-anim") };
  }, 40);
}
/** 被新窗取代后延迟折叠：起一个定时器；期间它又变回最新、或被用户接管，就不折了。 */
function scheduleSupersedeClose(root, ms) {
  const running = Number(root.dataset.dshsfCloseTimer || "0");
  if (running) clearTimeout(running);
  root.dataset.dshsfCloseTimer = String(setTimeout(() => {
    delete root.dataset.dshsfCloseTimer;
    const flow = chatScope();
    const row = root.closest(ROW);
    if (!row || !thinkOpen(root)) return;                                // 已经不在了
    if (root.dataset.dshsfAuto !== "1" || root.dataset.dshsfKeepOpen === "1") return;   // 被用户接管
    if (root === newestInTurn(flow, THINK, row.getAttribute("data-chat-turn"))) return;   // 又成最新了
    if (closeBudget <= 0) { scheduleSupersedeClose(root, 300); return; }  // 一次扫描的收起配额用完了，稍后再收
    if (closeThink(root)) closeBudget -= 1;
  }, Math.max(0, ms)));
}
function openTool(root) {
  if (toolOpen(root)) return false;
  if (root.dataset.dshsfKeepClosed === "1") return false;     // 用户自己收起的，不抢
  const tries = Number(root.dataset.dshsfToolTries || "0");
  if (tries >= 6) return false;
  const now = Date.now();
  if (now - Number(root.dataset.dshsfToolAt || "0") < 260) return false;
  root.dataset.dshsfToolAt = String(now);
  root.dataset.dshsfToolTries = String(tries + 1);
  const target = disclosureTarget(root);
  if (!target) return false;
  const tOpen = performance.now();
  if (!clickOnce(target)) return false;
  cost.phases.openTool = +((cost.phases.openTool || 0) + (performance.now() - tOpen)).toFixed(2);
  cost.counts.opens = (cost.counts.opens || 0) + 1;
  autoTools.add(root);
  root.dataset.dshsfToolAuto = "1";            // 这次展开是我方行为（运行中只留最新一个，更早的要收）
  revealBody(bodyOf(root, TOOL_BODY));         // React 对 click 同步提交，此刻正文已在 DOM 里
  return true;
}

/* ------------------------------------------------------------ 滚动小窗 -- */
/** 回底按钮只有图标：它是浮在正文上的控件，标签比按钮本身还显眼（官方那颗也只是个箭头）。 */
const JUMP_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 6.2 8 10.2 12 6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const jumpOf = new WeakMap();   // el -> 我方回底按钮：不靠 DOM 查询认亲，React 挪动/多实例残留都不会认错
/** 保证这个窗有回底按钮（且是直接子节点——sticky 贴底靠它）。多实例/热重载会留下残留：**留第一个、删其余**，
 *  这样两个控制器也会收敛到同一个节点，而不是各建一个、互相删来删去。 */
function ensureWindowJump(el) {
  let jump = jumpOf.get(el);                                  // 先信自己的登记：DOM 挪动/多实例都不会认错
  if (jump !== undefined && !jump.isConnected) jump = undefined;
  if (jump === undefined) jump = el.querySelector(":scope > [data-dshsf-jump]");   // 兜底：认领页面上残留的那个
  for (const extra of el.querySelectorAll(":scope > [data-dshsf-jump]")) if (extra !== jump) { try { extra.remove(); } catch { /* ignore */ } }
  if (jump === null || jump === undefined) {
    jump = jumpButton();
    jump.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.dataset.dshsfFollow = "1";
      el.scrollTo({ top: el.scrollHeight, behavior: state.animations === false || !allowAnim ? "auto" : "smooth" });
      jump.removeAttribute("data-dshsf-visible");
    });
  }
  if (jump.parentElement !== el || el.lastElementChild !== jump) el.appendChild(jump);
  jumpOf.set(el, jump);
  return jump;
}
function jumpButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.dshsfJump = "";
  btn.setAttribute("aria-label", "回到底部");
  btn.title = "回到底部";
  btn.innerHTML = JUMP_ICON;
  return btn;
}
const wired = new WeakSet();
const liveWindows = new Set();
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 24;

function wireWindow(el) {
  ensureWindowJump(el);
  liveWindows.add(el);
  if (wired.has(el)) return;
  wired.add(el);
  el.dataset.dshsfFollow = "1";
  const noteIntent = () => { el.dataset.dshsfIntentAt = String(performance.now()); };
  for (const type of ["wheel", "touchstart", "touchmove"]) el.addEventListener(type, noteIntent, { passive: true });
  el.addEventListener("pointerdown", (event) => { if (event.target === el) noteIntent(); }, { passive: true });
  el.addEventListener("scroll", () => {
    ensureTickLoop();   // 收敛后帧循环是停的：读者一滚就得排一帧，否则按钮要等下一次 DOM 变化才冒出来
    const mine = Number(el.dataset.dshsfMine);
    if (Number.isFinite(mine) && Math.abs(el.scrollTop - mine) <= 2) return;        // 我方推进造成的滚动，不算读者
    // 位置被**往回拉**（小于我方最后写入值）= 只有读者会这么做（我们的追赶只增加 scrollTop）；
    // 这条不依赖"600ms 内有输入信号"——输入信号只在 wheel/touch/拖滚动条时才有，漏一种读者就被当布局变化，
    // 跟随不收手 → 窗口被一直拽回底部 → 回底按钮永远不出现（"流式中的小窗没有回底按钮"就是这么来的）。
    const up = Number.isFinite(mine) && el.scrollTop < mine - 3;
    const since = performance.now() - Number(el.dataset.dshsfIntentAt || 0);
    if ((up || since <= USER_SCROLL_MS) && !atBottom(el)) el.dataset.dshsfFollow = "";
  }, { passive: true });
}

/** 思考正文挂载后立刻打小窗标记：扫描器最慢要等一次节流（~300ms），这段空档就是"展开瞬间没有小窗"。 */
function tagThinkWindow(body, preHeight) {
  if (!body || body.getAttribute("hidden") === SKIP) return;   // 为搜索藏起的正文不渲染：打小窗会强制布局，白花
  if (body.dataset.dshsfWindow === "reasoning") { wireWindow(body); return; }   // 已打过标：补登记（折叠期间被移出过清单）
  if (body.parentElement && body.parentElement.closest("[data-dshsf-window], [data-dshsf-textwindow]")) return;
  // 先按实测高度写 --dshsf-hw 再打标：固定 260px 上限对"刚起步只剩一两行"的新思考，
  // 动画十几毫秒就跑完了，看着跟没动效一样；按真实高度播才有完整 0.26s 的展开过程。
  const cap = Math.max(80, Number(state.windowHeight) || 260);
  const visible = Math.min(Math.round(preHeight === undefined ? body.getBoundingClientRect().height : preHeight), cap);
  body.style.setProperty("--dshsf-hw", Math.max(16, visible) + "px");
  body.dataset.dshsfH = String(Math.max(16, visible));
  body.dataset.dshsfWindow = "reasoning";
  wireWindow(body);
  const record = { h: Math.round(body.getBoundingClientRect().height), cap: visible };
  lastWindow = record;
  setTimeout(() => {                                   // 诊断：40ms 后回读，看动画是否真挂上并在长高
    const cs = getComputedStyle(body);
    lastWindow = { ...record, anim: cs.animationName, dur: cs.animationDuration, now: Math.round(body.getBoundingClientRect().height) };
  }, 40);
}

/** 每帧一次：先只读、后集中写（滚动卡顿的主因是读写交错）。 */
const supersedeDelay = () => Math.min(60, Math.max(0, num(state.supersedeDelay, 2)));   // 单位：秒
const windowCap = () => Math.max(80, Number(state.windowHeight) || 260);
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const smoothGrow = () => Math.min(0.9, Math.max(0.05, num(state.smoothGrow, 0.25)));   // 每帧吃掉的差距比例
const smoothMin = () => Math.min(12, Math.max(0, num(state.smoothMin, 2)));            // 每 16ms 的最小推进像素
const minStep = (dt) => smoothMin() * (dt / 16);                                       // 换算成本帧：与屏幕刷新率无关
// 自身耗时统计：只统计"我们的 JS"，不含浏览器的布局/绘制（那部分不在我们手里）
const cost = { frames: 0, tickMs: 0, scans: 0, scanMs: 0, lastMs: 0, maxMs: 0, phases: {}, counts: {}, worst: null, lastError: null, pinMs: 0, pinFrames: 0 };
/** 分位数：单次采样会被外部卡顿（远程桌面/后台节流/GC）污染，中位数才反映我们自己的成本。 */
function percentile(list, q) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
}
/** 分阶段按耗时排序取前几项——截图/粘贴时不用展开就能看到贵在哪。 */
function topPhases(phases) {
  return Object.keys(phases)
    .map((k) => [k, phases[k]])
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}
function resetCost() { scanSamples.length = 0; cost.frames = 0; cost.tickMs = 0; cost.scans = 0; cost.scanMs = 0; cost.lastMs = 0; cost.maxMs = 0; cost.phases = {}; cost.counts = {}; cost.worst = null; cost.lastError = null; cost.pinMs = 0; cost.pinFrames = 0; sparks.resetCost(); }
let followTickAt = 0;
let ticking = false;
let rafId = 0;              // 帧循环句柄（dispose 要能停掉它）
let disposed = false;       // 实例已收摊：所有异步入口早退（热重载后旧实例不许再动 DOM）
/** 未收敛就自己接着排帧：只靠 MutationObserver 的话，两次输出之间的那段就冻住不动了。 */
const TICK_MIN_MS = 8;     // 上限 120fps：60Hz 屏每帧都推进（16.7ms > 8ms），高刷屏最多 120fps
let lastTickRun = 0;
function tickLoop() {
  if (disposed) { ticking = false; return; }
  const now = performance.now();
  if (now - lastTickRun >= TICK_MIN_MS) {
    lastTickRun = now;
    if (!tickFollow()) { ticking = false; return; }
  }
  rafId = requestAnimationFrame(tickLoop);
}
function ensureTickLoop() {
  if (ticking || disposed) return;
  ticking = true;
  rafId = requestAnimationFrame(tickLoop);
}
function tickFollow() {
  const t0 = performance.now();
  const moving = tickFollowInner();
  cost.frames += 1;
  cost.tickMs += performance.now() - t0;
  return moving;
}
function tickFollowInner() {
  tickCount += 1;
  const now = performance.now();
  const dt = Math.min(64, Math.max(1, now - (followTickAt || now)));   // 下限 1ms：320Hz 帧间隔只有 3.1ms，别再钳
  followTickAt = now;
  let moving = mainFollowTick(dt);
  if (sparks.tick(dt)) moving = true;   // 火星：模块自带"该不该跑"，熄灭且不发光时返回 false（空闲零成本）
  if (liveWindows.size === 0) { if (moving) ensureTickLoop(); return moving; }
  const plan = [];
  for (const el of liveWindows) {
    if (!el.isConnected) { liveWindows.delete(el); continue; }
    if (el.clientHeight === 0) continue;
    const sh = el.scrollHeight;                     // 每帧只读一次：读尺寸在 DOM 脏的时候会强制重排
    const max = sh - el.clientHeight;
    const gap = max - el.scrollTop;
    const bottom = gap <= 24;
    const follow = state.autoFollow !== false && (bottom || el.dataset.dshsfFollow === "1");
    // 流式输出是一行一行来的：max-height 跟住内容高度（长出来而不是跳一格）
    const want = el.dataset.dshsfClosing === "1" ? null : Math.min(sh, windowCap());
    // 回底按钮查登记表（jumpOf），不再每帧每窗查一次 DOM：只要它还挂在窗口里就直接用，
    // 不在（被 React 挪走/删掉）才走 ensureWindowJump 的完整自愈（那里面有查询 + 去重 + 补挂）。
    const knownJump = jumpOf.get(el);
    const jump = knownJump !== undefined && knownJump.isConnected && knownJump.parentElement === el ? knownJump : null;
    plan.push({ el, jump, bottom, gap, follow, cur: el.scrollTop, want });
  }
  for (const item of plan) {
    if (item.want !== null) {
      const known = item.el.dataset.dshsfH;
      const cur = known === undefined ? item.want : Number(known);
      const gap = item.want - cur;
      if (Math.abs(gap) > 0.5) {
        const step = Math.min(Math.abs(gap), Math.max(minStep(dt), Math.abs(gap) * smoothGrow() * (dt / 16)));
        const next = (cur + Math.sign(gap) * step).toFixed(1);
        item.el.dataset.dshsfH = next;
        item.el.style.setProperty("--dshsf-hw", next + "px");   // 入场动画还在跑时，动画目标也跟着长（避免交接跳一下）
        item.el.style.maxHeight = next + "px";
        moving = true;
      } else if (known === undefined) {
        item.el.dataset.dshsfH = String(item.want);
      }
    }
    // 跟随中：朝底部"追"过去，而不是直接跳到 max —— 内容才有顺流而下的感觉
    if (item.follow && item.gap > 0.5) {
      const step = Math.min(item.gap, Math.max(minStep(dt), item.gap * smoothGrow() * (dt / 16)));
      const next = item.cur + step;
      item.el.scrollTop = next;
      item.el.dataset.dshsfMine = String(next);     // 记下"这是我写的"，scroll 监听据此分辨是不是读者
      moving = true;
    }
    if (item.bottom && item.el.dataset.dshsfFollow !== "1") item.el.dataset.dshsfFollow = "1";
    item.el.toggleAttribute("data-dshsf-offbottom", item.gap > 24);
    if (!item.jump) item.jump = ensureWindowJump(item.el);   // 自愈：登记过的窗任何时候都必须有按钮
    if (item.jump) {
      // 读者接管了 → 给按钮；跟随中只有"落后很多"才给（追赶时的轻微落后不该让按钮一闪一闪）
      // 显隐带滞回：点亮要"读者接管或落后很多"，熄灭只在真正回到贴底（gap<12）——
      // 跟随状态/差距在阈值附近抖动时按钮不该跟着闪。
      if (state.showJumpButton === false) item.jump.removeAttribute("data-dshsf-visible");
      else if (item.jump.hasAttribute("data-dshsf-visible")) { if (item.gap < 12) item.jump.removeAttribute("data-dshsf-visible"); }
      else if (item.gap > 24 && (!item.follow || item.gap > 120)) item.jump.setAttribute("data-dshsf-visible", "");
    }
  }
  if (moving) ensureTickLoop();
  return moving;
}

/* -------------------------------------------------------------- 折叠 -- */
const manualState = new Map();   // turn -> "open" | "fold"

/** 会话切换：manualState 按轮号存、wasRunning/lastRunningAt 是模块级 —— 不清就会串到新会话：
 *  新会话同号轮次继承 "fold"（运行中那一轮被瞬间折掉），或让新会话误触发"跑完回到提问处"。
 *  会话 id 由官方挂在对话根上（[data-conversation-session]）。 */
let sessionKey = null;
function syncSession() {
  // 同上：只在"当前会话"里找，document 序第一个可能正是不相关的那个会话根
  // （那会让切主会话不触发复位，或反过来把主会话的手动展开状态清掉）。
  const scope = chatScope();
  const holder = scope.querySelector("[data-conversation-session]") || document.querySelector("[data-conversation-session]");
  const key = holder ? holder.getAttribute("data-conversation-session") : null;
  if (key === null || key === "") return;      // 当前视图没有会话信息（设置页/嵌入态）：状态不动
  if (sessionKey === null) { sessionKey = key; return; }
  if (key === sessionKey) return;
  sessionKey = key;
  manualState.clear();
  wasRunning = false;
  lastRunningAt = 0;
  runningSticky = false;
  clearTimeout(runGraceTimer);
  for (const chip of document.querySelectorAll("[data-dshsf-chip]")) { try { chip.remove(); } catch { /* ignore */ } }
}
/** 折叠/展开一行：用真实高度驱动 max-height，动画只在用户交互后启用。 */
/** 折叠动画播完再挂 content-visibility（挂早了动画直接被跳过，看着就是硬切）。 */
const SKIP = "until-found";
const isSkipped = (row) => row.getAttribute("hidden") === SKIP;
/* 官方 useSearchableHidden 也用 hidden="until-found"（同一个字面量，见内核 ui-chat），
   所以摘的时候必须认归属：只摘我们自己挂过的那一份，别把官方设的也一起摘了
   （React 的 layout effect 只在依赖变化时重设，被外部摘掉不会自愈）。 */
const ownsSkip = (el) => el.hasAttribute("data-dshsf-hidden");
function setSkipHidden(el) { el.setAttribute("data-dshsf-hidden", ""); el.setAttribute("hidden", SKIP); }
function clearSkipHidden(el) {
  if (!ownsSkip(el)) return;
  el.removeAttribute("data-dshsf-hidden");
  el.removeAttribute("hidden");
}
function skipSoon(row) {
  setTimeout(() => {
    if (!row.hasAttribute("data-dshsf-folded")) return;
    setSkipHidden(row);
    for (const el of row.querySelectorAll("[data-dshsf-window], [data-dshsf-textwindow]")) liveWindows.delete(el);   // 不渲染的窗不必每帧跟进
  }, 320);
}
function applyFold(row, fold, animate) {
  if (!row.hasAttribute("data-dshsf-row")) row.setAttribute("data-dshsf-row", "");

  const folded = row.hasAttribute("data-dshsf-folded");
  if (fold === folded) {
    if (fold && !isSkipped(row)) skipSoon(row);   // 已经是折的状态（热重载/旧状态）也补挂
    return;
  }
  if (!animate || animBudget <= 0) {   // 配额用完 → 直接切（一次要动几十个元素时，动画本来也看不清）
    // 瞬时路径：不读、不 flush，一次布局都不做
    row.style.maxHeight = "";
    row.style.overflow = "";
    row.toggleAttribute("data-dshsf-folded", fold);
    if (fold) setSkipHidden(row);
    else { clearSkipHidden(row); delete row.dataset.dshsfCards; }   // 展开后子树可能再变：计数缓存作废
    return;
  }
  animBudget -= 1;
  row.style.overflow = "hidden";
  if (fold) {
    layoutReads += 1;
    row.style.maxHeight = row.getBoundingClientRect().height + "px";
    void row.offsetHeight;
    row.setAttribute("data-dshsf-folded", "");
    row.style.maxHeight = "0px";
    skipSoon(row);
    return;
  }
  clearSkipHidden(row);   // 先摘掉（只摘我们挂的那份），否则量到的高度是 0（内容根本没渲染）
  row.removeAttribute("data-dshsf-folded");
  delete row.dataset.dshsfCards;
  row.style.maxHeight = "";
  layoutReads += 1;
  const height = row.getBoundingClientRect().height;
  if (height > ANIM_MAX_PX) { row.style.overflow = ""; return; }   // 太高的行直接展开，省掉 0.3s 的逐帧重排
  row.style.maxHeight = "0px";
  void row.offsetHeight;
  requestAnimationFrame(() => { row.style.maxHeight = height + "px"; });
  setTimeout(() => { if (!row.hasAttribute("data-dshsf-folded")) { row.style.maxHeight = ""; row.style.overflow = ""; } }, 340);
}
/**
 * 批量折叠：先全部量高 → 写起始 max-height → 一次 flush → 写终值。
 * 逐个"量一个写一个"会让每次量都强制一次整树重排：一次折叠几十行就是几十次重排
 * （实测这台 i5-2300 上一次扫描 885ms，全在 syncTurns 里）。
 */
function foldBatch(rows, animate) {
  const targets = rows.filter((row) => !row.hasAttribute("data-dshsf-folded"));
  if (targets.length === 0) return;
  if (!animate || targets.length > ANIM_BUDGET) { for (const row of targets) applyFold(row, true, false); return; }
  layoutReads += 1;
  const heights = targets.map((row) => row.getBoundingClientRect().height);   // ① 只读
  for (let i = 0; i < targets.length; i += 1) {                                // ② 写起始值
    if (!targets[i].hasAttribute("data-dshsf-row")) targets[i].setAttribute("data-dshsf-row", "");
    targets[i].style.overflow = "hidden";
    targets[i].style.maxHeight = heights[i] + "px";
  }
  layoutReads += 1;
  void targets[0].offsetHeight;                                               // ③ 一次 flush，让过渡有起点
  for (const row of targets) {                                                // ④ 写终值
    row.setAttribute("data-dshsf-folded", "");
    row.style.maxHeight = "0px";
    skipSoon(row);
  }
}
/** 数一段子树里的匹配元素：嵌在同类里的（工具卡套工具卡）只算最外层那一个。 */
function countCards(row, selector) {
  cost.counts.cards = (cost.counts.cards || 0) + 1;
  const t = performance.now();
  let n = 0;
  for (const el of row.querySelectorAll(selector)) {
    const outer = el.parentElement && el.parentElement.closest(selector);
    if (outer && row.contains(outer)) continue;
    n += 1;
  }
  cost.phases.cards = +((cost.phases.cards || 0) + (performance.now() - t)).toFixed(2);
  return n;
}
/** 折叠条文案要的两个计数。冷行（不在最近两轮）折叠后子树不会再变 → 缓存进 dataset：
 *  否则每次扫描都要对**每个折叠行**各走两遍子树查询（长会话流式期间每 300ms 一次）。
 *  键里带轮号：React 跨会话可能复用同一个 DOM 节点，只比 dataset 会读到上一轮的计数。
 *  行一被展开就必须删缓存（下面 applyFold/unfoldAll 各删一次），否则再次折叠会沿用旧数字。 */
function cardsOf(row, turn) {
  const cached = row.dataset.dshsfCards;
  if (cached !== undefined && !hotRows.has(row)) {
    const cut = cached.indexOf("|");
    if (cut > 0 && cached.slice(0, cut) === turn) {
      const parts = cached.slice(cut + 1).split(",");
      return [Number(parts[0]) || 0, Number(parts[1]) || 0];
    }
  }
  const thinks = countCards(row, THINK);
  const tools = countCards(row, TOOL_CARD);
  if (!hotRows.has(row)) row.dataset.dshsfCards = turn + "|" + thinks + "," + tools;
  return [thinks, tools];
}
function unfoldAll(container) {
  for (const row of container.querySelectorAll("[data-dshsf-row]")) {
    clearSkipHidden(row);
    row.removeAttribute("data-dshsf-folded");
    delete row.dataset.dshsfCards;
    row.style.maxHeight = "";
    row.style.overflow = "";
  }
}
function clearChips(container) {
  for (const chip of container.querySelectorAll("[data-dshsf-chip]")) chip.remove();
}

/* ------------------------------------------------------ 搜索准备（Ctrl+F） -- */
/**
 * 折回一行摘要的思考，正文是被 React 卸载的（DisclosureRow 的 children 条件挂载）——不在 DOM 里，
 * 浏览器自然搜不到。Ctrl+F 时把正文补挂载出来，再用 hidden=until-found 藏回去：
 * 界面外观不变、渲染照样跳过，但内容回到 DOM，能被搜到（命中时 beforematch 把它亮出来）。
 * 工具卡的正文同理，但一次要渲染几百个大块，代价太高，这里只补思考。
 */
let searchPrepRunning = false;
function hideForSearch(body) {
  if (!body || body.getAttribute("hidden") === SKIP) return;   // 已经藏着（含官方挂的那份）：照样能搜，别再动
  setSkipHidden(body);                                            // 认归属：摘的时候只摘我们自己挂的那份
  body.dataset.dshsfSearch = "1";
  liveWindows.delete(body);          // 不渲染的窗不必每帧跟进（与折叠行同一套处理）
}
/** 搜索用的隐藏标记要撤掉（被搜到 / 用户自己点开 / 手动展开这一轮）。 */
function clearSearchHidden(scope) {
  if (!scope || !scope.querySelectorAll) return;
  for (const body of scope.querySelectorAll("[data-dshsf-search]")) {
    body.removeAttribute("data-dshsf-search");
    clearSkipHidden(body);           // 同上：官方 useSearchableHidden 的 hidden 归官方

    wireWindow(body);                // 重新回到每帧清单（它会从 16px 平滑长到窗口上限）
  }
}
function searchPrep() {
  if (searchPrepRunning) return;
  const flow = chatScope();
  const roots = Array.from(flow.querySelectorAll(THINK)).filter((root) => !thinkOpen(root));
  if (roots.length === 0) return;
  searchPrepRunning = true;
  let cursor = 0;
  const chunk = () => {
    let done = 0;
    while (cursor < roots.length && done < 12) {          // 分片挂载：别让 Ctrl+F 卡住主线程
      const root = roots[cursor++];
      done += 1;
      if (!root.isConnected || thinkOpen(root)) continue;
      if (!clickOnce(disclosureTarget(root))) continue;    // 合成 click → React 挂载正文
      root.dataset.dshsfKeepOpen = "1";                    // 别让扫描当成"我方开的"又收回去（收回去正文又没了）
      hideForSearch(root.querySelector(THINK_BODY));       // 挂上就藏回去，界面外观不变（隐藏的前提是 until-found 所以照样能搜）
      // 行整行藏着（折叠轮次）时不必再藏正文，但正文同样挂上了 —— 展开那一轮时它才现形
    }
    if (cursor < roots.length) setTimeout(chunk, 0);
    else searchPrepRunning = false;
  };
  chunk();
}

/** 会话里的全部行（文档顺序）。
 *  0.1.5：行是 `[data-chat-flow]` 的直接子节点；0.1.7 把每个「过程组」各自包了一层
 *  `[data-chat-flow]`（组内还有自己的滚动体），按 children 取只能看到一个组 —— 所以在
 *  主滚动容器里按属性收，两个版本都对。 */
function chatRows() {
  const scope = mainScroller() || document;
  const rows = Array.from(scope.querySelectorAll("[data-chat-flow-kind]"));
  if (rows.length) lastRowSeen = rows[rows.length - 1];   // 供帧路径做缓存校验：省掉每帧一次全文档查询
  return rows;
}
/** 这一轮是否已经跑完：官方在 turn/end 之后才给该轮的 footer 行加 data-actions-reveal
 *  （跑动中的那一轮不渲染 actions）。这是"跑完"的确定性标记 —— 比流式/工具状态稳得多：
 *  模型在两步之间、工具执行期间都没有流式标记，靠它们判断会在运行中来一次折叠。
 *  0.1.7 的 tail 行：<div data-turn-tail="<轮次>" data-actions-reveal="always|hover">。 */
function turnClosed(turn) {
  if (turn === null || turn === undefined || turn === "") return false;
  // 作用域必须跟折叠/滚动一致：右栏开着子代理会话时页面上同时有两个会话根（ui-subagent 用
  // variant:"embedded" 走同一套骨架），而轮号两边都从 1 开始撞号 —— document 上查到的那条 tail
  // 未必属于本会话（会让"正在跑的这一轮"被误判成已收尾 → 运行中折一次）。
  const tail = chatScope().querySelector('[data-turn-tail="' + turn + '"]');
  return tail !== null && tail.hasAttribute("data-actions-reveal");
}
/** 本轮正式回答行 = 最后一个「有正文」的 assistant-step 行（没有正文行才退回最后一个 assistant-step）。
 *  0.1.7 会把一个 step 拆成 reasoning / response 两个行，只看"最后一个"未必落在正文上。
 *  按轮次 memo：一次扫描里 syncTurns 与 syncTextWindows 都要用，避免双倍整树遍历。 */
let answerRowCache = new Map();
function answerRowOf(turnRows) {
  const key = turnRows.length ? turnRows[0].getAttribute("data-chat-turn") : null;
  if (key !== null && answerRowCache.has(key)) return answerRowCache.get(key);
  const assistantRows = turnRows.filter((row) => rowKind(row) === "assistant-step");
  const textRows = assistantRows.filter((row) => hasText(row));
  const answerRow = textRows.length ? textRows[textRows.length - 1] : (assistantRows.length ? assistantRows[assistantRows.length - 1] : null);
  if (key !== null) answerRowCache.set(key, answerRow);
  return answerRow;
}
function collectTurns() {
  const rows = chatRows();
  const turns = new Map();
  for (const row of rows) {
    const turn = row.getAttribute("data-chat-turn") || "0";
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn).push(row);
  }
  // 运行中那一轮 = 带运行标记的那一行所属的轮次。比"最后一行"可靠：0.1.7 会往末尾补
  // 独立的 tail / 收尾行，它们的 data-chat-turn 未必等于正在跑的那一轮。
  const mark = chatScope().querySelector(RUNNING);
  const markRow = mark && mark.closest ? mark.closest(ROW) : null;
  const runningTurn = markRow ? markRow.getAttribute("data-chat-turn") : null;
  return { rows, turns, lastTurn: rows.length ? rows[rows.length - 1].getAttribute("data-chat-turn") : null, runningTurn };
}

function syncTurns(flow, running, collected) {
  const { turns, lastTurn, runningTurn } = collected || collectTurns();
  const animate = state.animations !== false && allowAnim;
  // 批量折叠收集到"整个扫描"这一层：foldBatch 每次要"读一遍 + flush 一遍"布局，
  // 逐轮调用 = 每轮两遍（18 轮就 36 遍）：单次扫描的主要成本都在这里
  const toFoldAll = [];
  const toUnfoldAll = [];
  const thinkFoldsAll = [];
  let tFilter = 0; let tRows = 0; let tChip = 0;
  let forgeBody = null;      // 本轮答案行的正文（写头所在），锻打火星挂它
  for (const [turn, turnRows] of turns) {
    const tF = performance.now();
    const isRunningTurn = running && turn === (runningTurn === null || runningTurn === undefined ? lastTurn : runningTurn);
    const manual = manualState.get(turn);
    const assistantRows = turnRows.filter((row) => rowKind(row) === "assistant-step");
    const answerRow = answerRowOf(turnRows);
    // 锻打锚点用**整行**（flowItem 在一轮里是稳定的），不用会随 React 重渲染被换掉的段落：
    // 段落一换，火星就得等下一次扫描才回得来（看着像闪）；行稳定则挂上去的画布一直有效。
    if (isRunningTurn && answerRow) forgeBody = answerRow;
    // 可折叠候选：过程行（答案行 / 独立行除外；按设置保留穿插正文行）
    const foldableSet = new Set();
    const foldable = turnRows.filter((row) => {
      if (row === answerRow || INDEPENDENT.has(rowKind(row))) return false;
      if (state.keepInterleavedText !== false && rowKind(row) === "assistant-step" && hasText(row)) return false;
      foldableSet.add(row);
      return true;
    });
    const shouldFold = manual === "fold"
      || (manual !== "open" && !isRunningTurn && (state.foldHistory !== false || running));
    tFilter += performance.now() - tF;
    const tR = performance.now();
    let folded = 0;
    let thinks = 0;      // 折起来的思考段数
    let tools = 0;       // 折起来的工具调用数
    for (const row of turnRows) {
      const fold = shouldFold && foldableSet.has(row);
      const isFolded = row.hasAttribute("data-dshsf-folded");
      if (fold === isFolded) {
        if (fold && !isSkipped(row)) skipSoon(row);
        if (!row.hasAttribute("data-dshsf-row")) row.setAttribute("data-dshsf-row", "");
      } else if (fold) toFoldAll.push(row);
      else toUnfoldAll.push(row);
      if (fold) {
        folded += 1;
        const cards = cardsOf(row, turn);
        thinks += cards[0];
        tools += cards[1];
      }
      // 非运行中的轮次：思考回到一行摘要（我只收自己展开的那些）
      if (!isRunningTurn && rowKind(row) === "assistant-step") {
        for (const root of row.querySelectorAll(THINK)) {
          // 行没被折掉（答行、保留的穿插正文行）时，它里面的思考也得跟着收：
          // 折叠状态下连"一行摘要"都不该露头；用户手动展开本轮（manual=open）时还原成可点摘要
          if (!fold) {
            if (shouldFold) thinkFoldsAll.push(root);   // 收集起来批量折：逐个折 = 每个 2 次强制重排
            else applyFold(root, false, animate);
          }
          if (!thinkOpen(root)) { delete root.dataset.dshsfAuto; continue; }
          if (closeBudget <= 0) { busyWork = true; break; }
          if (closeThink(root)) closeBudget -= 1;
        }
      }
    }
    tRows += performance.now() - tR;
    const tC = performance.now();
    // 折叠条：有可折叠内容就给，位置固定在该轮过程的最上面
    const chipId = "dshsf-chip-" + turn;
    const existing = flow.querySelector("#" + chipId);
    // 运行中的轮次不给折叠条：跑动过程中不该冒出"收起本轮过程"这种按钮
    // （用户手动折过的例外 —— 否则没有入口再展开）
    if (foldable.length === 0 || (isRunningTurn && manual !== "fold")) { if (existing) existing.remove(); continue; }
    let chip = existing;
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.id = chipId;
      chip.dataset.dshsfChip = turn;
      chip.addEventListener("click", () => {
        const anyFolded = flow.querySelector('[data-chat-turn="' + turn + '"][data-dshsf-folded]') !== null;
        manualState.set(turn, anyFolded ? "open" : "fold");
        allowAnim = true;
        followOn = false;                                  // 先撒手再展开：跟随会把刚展开的内容拖回底部，按钮就飞了
        const before = chip.getBoundingClientRect().top;
        scan();
        anchorDuring(chip, before, 500);
      });
    }
    const anchor = turnRows.find((row) => !INDEPENDENT.has(rowKind(row))) || turnRows[0];
    if (anchor && chip.nextElementSibling !== anchor && anchor.parentElement) anchor.parentElement.insertBefore(chip, anchor);
    const summary = [];
    if (thinks > 0) summary.push(thinks + " 轮思考");
    if (tools > 0) summary.push(tools + " 次工具调用");
    const label = folded > 0
      ? "已折叠 " + (summary.length ? summary.join(" · ") : folded + " 行") + " · 点击展开"
      : "收起本轮过程";
    if (chip.textContent !== label) chip.textContent = label;   // 没变就别写：textContent 赋值是一次真实 DOM 变更
    tChip += performance.now() - tC;
  }
  sparks.forge(forgeBody);                               // 只有运行中才有写头；跑完自动撒手（火星烧完即摘画布）
  const tB = performance.now();
  foldBatch(toFoldAll.concat(thinkFoldsAll), animate);   // 整个扫描只做一次批量折：读一遍 + flush 一遍
  for (const row of toUnfoldAll) applyFold(row, false, animate);
  cost.phases.turnFilter = +tFilter.toFixed(2);
  cost.phases.turnRows = +tRows.toFixed(2);
  cost.phases.turnChip = +tChip.toFixed(2);
  cost.phases.turnBatch = +(performance.now() - tB).toFixed(2);
}

/**
 * 把被点的那一行钉在原来的屏幕位置，覆盖整段展开动画——不然内容一长，按钮就飞了、没法接着读。
 * 关键是"同步补"：React 提交、我方 scan 都在同一个任务里改布局，等到下一帧 rAF 再补，
 * 中间那一帧就会先画出去（看着闪一下）。所以这里给三处补偿：
 *   ① anchorSync() 当场补（scan 之后 / 微任务里，都赶在绘制之前）；
 *   ② ResizeObserver 补——官方自己也在 ResizeObserver 里吸底（followRef: el.scrollTop = scrollHeight），
 *      它的 observer 注册得比我们早、回调也就先跑；我们在同一轮投递里后补一次，仍赶在 paint 之前，
 *      所以它那一跳根本画不出去（这就是"闪一下"的来源）；
 *   ③ 逐帧补（折叠/展开是 CSS 过渡，高度要长 340ms）；
 *   ④ 期间关掉浏览器自带的滚动锚定——这两件事会互相打架。
 */
let anchorCtl = null;   // { el, top, until, scroller, prevAnchor, announced }
let anchorRO = null;    // 布局一变就补：RO 回调在 layout 之后、paint 之前，正好压住官方那个吸底跳转
function anchorStop() {
  if (!anchorCtl) return;
  try { anchorCtl.scroller.style.overflowAnchor = anchorCtl.prevAnchor || ""; } catch { /* ignore */ }
  try { if (anchorRO) anchorRO.disconnect(); } catch { /* ignore */ }
  anchorCtl = null;
}
function anchorSync() {
  if (!anchorCtl) return false;
  const { el, scroller } = anchorCtl;
  if (performance.now() > anchorCtl.until || !el.isConnected) { anchorStop(); return false; }
  const delta = el.getBoundingClientRect().top - anchorCtl.top;
  if (delta === 0) return false;
  scroller.scrollTop += delta;
  anchorCtl.top = el.getBoundingClientRect().top;
  if (!anchorCtl.announced) {
    anchorCtl.announced = true;
    try { scroller.dispatchEvent(new Event("scroll", { bubbles: true })); } catch { /* ignore */ }
  }
  return true;
}
function anchorDuring(node, before, ms) {
  const scroller = mainScroller();
  if (!scroller) return;
  anchorStop();
  anchorCtl = { el: node, top: before, until: performance.now() + ms, scroller, prevAnchor: scroller.style.overflowAnchor, announced: false };
  try { scroller.style.overflowAnchor = "none"; } catch { /* ignore */ }
  try {
    if (!anchorRO) anchorRO = new ResizeObserver(() => anchorSync());
    anchorRO.disconnect();
    anchorRO.observe(node);
    const flow = chatScope();
    if (flow && flow !== document) anchorRO.observe(flow.firstElementChild || flow);
  } catch { /* 没有 ResizeObserver 就退回 rAF 逐帧补 */ }
  anchorSync();
  const step = () => {
    if (!anchorCtl || anchorCtl.el !== node) return;          // 已被新的锚定取代
    anchorSync();
    if (performance.now() < anchorCtl.until) requestAnimationFrame(step);
    else anchorStop();
  };
  requestAnimationFrame(step);
}
/**
 * 我方即将让内容长高（自动展开小窗/卡片）时，主窗口继续保持贴底。
 * 官方贴底逻辑（onScrollRef）用当前 scrollTop 重算 isAtBottom = floor - scrollTop <= 25：
 * 内容长高而 scrollTop 没跟上，一旦差值 > 25 就被判成"读者离开了底部"，这一轮后面都不再跟随。
 * 我们只在自己写过的位置上继续贴底，位置被人动过（你上滚）就立刻撒手。
 */
const ANIM_BUDGET = 3;    // 一次扫描最多播几个"高度动画"：加载/切会话/收尾这类批量场景直接切，播放反而看不清
const scanSamples = [];   // 最近 N 次扫描的墙钟耗时（算分位数用；max 会被外部卡顿污染）
const SCAN_SAMPLES = 40;
let animBudget = ANIM_BUDGET;
const autoThinks = new Set();   // 我方自动展开过的思考根（只有它们需要"被取代后折回"）
const autoTools = new Set();    // 同上，工具卡
let lastAnnounceAt = 0;   // 上次补发 scroll 事件的时刻（压官方吸底用）
let announcedHeight = -1; // 上次补发时的内容高度：长高那一帧必须补，等不了 400ms
let announcedTop = -1;    // 上次补发时的位置：位移太小时补发会踩到官方"读者没动过"那条分支
let stealCount = 0;       // 诊断：官方吸底抢跑、把我们写下的位置一把抹平的次数（正常应为 0）
let undoCount = 0;        // 诊断：抢跑在帧循环里被回补的次数（提交阶段直接贴底那条路）
let guardCount = 0;       // 诊断：抢跑在自家 ResizeObserver 里被回补的次数（官方吸底那条路）
let moveCount = 0;        // 诊断：帧循环真正推进过多少帧（流式期间应持续增长）
const followFlips = [];   // 诊断：followOn 最近几次翻转（按钮闪 = 跟随在抖 → 看这里）
let lastFollowSeen = true;
/** 记一次跟随翻转。why=谁翻的、top/wrote=翻转瞬间的位置与我方最后写入值（不相等 = 有别人动过）。 */
function noteFlip(on, gap, info) {
  lastFollowSeen = on;
  followFlips.push({ t: Math.round(performance.now()), on, gap: Math.round(gap), ...info });
  if (followFlips.length > 10) followFlips.shift();
}
let stealMax = 0;         // 诊断：单次抢跑最多把我们往前推了多少像素
const stealTail = [];     // 诊断：最近几次抢跑的像素数（判断是"小幅抖动"还是"整段抹平"）
let layoutReads = 0;      // 扫描里"读布局"的次数：DOM 脏的时候每读一次就强制一遍重排
let tickCount = 0;        // 帧循环跑过多少次（诊断：看优化前后量级）
let announceCount = 0;    // 补发过多少次 scroll 事件（诊断用）
const ANNOUNCE_MS = 400;
let followOn = true;      // 主窗口是否跟随底部：真实输入关掉，回到贴底自动恢复
let followWrote = null;   // 我方最后一次写入的位置：用来分辨这个 scroll 是不是我们造成的
let followScroller = null;
let scrollIntentAt = 0;   // 最近一次"读者真的要滚动"的输入时刻
let followHeight = -1;    // 上一次 tick 时的内容高度：位置变了但长度没变 = 有人在跳转，不是布局
/**
 * 只有真实输入才算读者滚动。展开/折叠、浏览器滚动锚定（内容在视口上方长高时自动调 scrollTop）
 * 都会产生 scroll 事件——位置变了不等于人动了，否则点一次展开就会把贴底取消掉。
 */
const USER_SCROLL_MS = 600;
function noteScrollIntent(event) {
  if (event && event.type === "keydown") {
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
    if (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key)) return;
  }
  scrollIntentAt = performance.now();
}
/** 点在滚动条上时事件目标就是滚动容器自身（点内容不会）。 */
function onScrollerPointerDown(event) { if (event.target === event.currentTarget) noteScrollIntent(event); }
/** 每帧一次的主窗口跟随：官方只在 ResizeObserver 回调且"没在采样"时贴底，靠不住；
 *  我们每帧贴到 floor（同值写入不产生 scroll 事件），读者一动就关、回到贴底再自动恢复。 */
function mainFollowTick(dt) {
  const scroller = mainScroller();
  if (!scroller) { hidePinBar(); return false; }   // 不在会话视图（设置页/别的面板）：body 上的固定层不能留着
  if (scroller !== followScroller) {
    if (followScroller) {
      followScroller.removeEventListener("scroll", onMainScroll);
      followScroller.removeEventListener("pointerdown", onScrollerPointerDown);
    }
    followScroller = scroller;
    guardComposer = undefined;    // 首次扫描时 followScroller 还是 null，guardObserve 会把 composer 记成 null 并永久提前返回
    takeOverSnap(scroller);
    followScroller.addEventListener("scroll", onMainScroll, { passive: true });
    followScroller.addEventListener("pointerdown", onScrollerPointerDown, { passive: true });
  }

  followHeight = scroller.scrollHeight;                       // 每帧刷新：scroll 事件据此判断"是布局长高了还是有人在跳"
  pinTick(scroller);                                          // 置顶条：读一遍行/容器位置并摆好（固定层，不改会话布局）
  const floor = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  // 一次性平滑移动（跑完一轮 → 移到提问处；点置顶条也走这里）：**必须在"跟随关掉"的早退之前**推进，
  // 否则 glide 会永久挂着（动效开着就永远不动、动效关了就瞬跳），还会把 guard 拖在激活态拽住视角。
  const gliding = glideTick(scroller, floor, dt);
  // 跟随关掉时：不再推进跟随，但置顶条与回底按钮的显隐仍归帧循环管（否则按钮被 CSS 永久藏着）
  if (state.autoFollow === false) {
    if (!gliding) updateJumpGate(floor - scroller.scrollTop, false);   // 滑动期间不改按钮显隐（和跟随时一致）
    return gliding;
  }
  // 官方还有几条不经过采样标记、直接贴底的路：React 提交阶段的 `tipMoved && atBottomRef → toBottom`、
  // 它自己 ResizeObserver 里的 `followRef`、以及 onScroll 里"读者没动过"当场 sample → toBottom。
  // 只要 pending 被官方自己的 sample() 清掉，下一次提交/下一帧就会把我们攒的滞后一次抹平——
  // 用户看到的就是"正文每来一坨字跳一下"。这些写入都发生在绘制之前，所以在同一个绘制周期里
  // 把位置还给追赶点：视觉上只剩正常的逐帧推进，和官方谁先谁后无关。
  if (followOn && followWrote !== null && followWrote < floor - 1 && scroller.scrollTop > followWrote + 1) {
    stealCount += 1;
    const px = Math.round(scroller.scrollTop - followWrote);
    if (px > stealMax) stealMax = px;
    stealTail.push(px);
    if (stealTail.length > 8) stealTail.shift();
    if (floor - followWrote <= SNAP_UNDO_MAX) { writeTop(scroller, followWrote); undoCount += 1; }
  }
  const gap = floor - scroller.scrollTop;                      // 必须放在回补之后：回补会改位置
  if (gap <= 25) followOn = true;                              // 已经贴底（可能官方自己贴的）→ 恢复跟随
  if (followOn !== lastFollowSeen) noteFlip(followOn, gap, { why: followOn ? "tick/贴底恢复" : "tick/其他", wrote: followWrote === null ? null : Math.round(followWrote) });
  if (!gliding) updateJumpGate(gap, followOn);
  if (gliding) return true;
  if (!followOn || gap <= 0.5) return false;
  // 主会话也走同一套平滑：每帧吃掉一部分差距，而不是直接跳到 floor
  // 与小窗完全同一套：纯比例追赶（不再有"最大滞后"兜底步，避免一帧跳几十像素）
  const step = Math.min(gap, Math.max(minStep(dt), gap * smoothGrow() * (dt / 16)));
  const next = scroller.scrollTop + step;
  writeTop(scroller, next);
  followWrote = next;          // 写后读回会逼一次布局：目标值本来就算好了（step ≤ gap，不会被钳）
  moveCount += 1;
  // 接管官方吸底：它只在"不在滚动采样期"时才写 scrollTop，而采样标记由 scroll 事件置位。
  // 同一帧里 rAF 回调早于 ResizeObserver 回调，所以这里补一个 scroll 事件，它那一帧就会认为自己在采样
  // → 不吸底；位置又始终在它 25px 判定内 → 它的 atBottom 保持为真，自带的"回到底部"按钮也不会冒出来。
  // 它的采样标记由 sample() 在"本批第一个 scroll 事件之后 500ms"清一次（后续事件不续期），所以补发必须
  // **赶上内容长高那一帧**——那是官方 ResizeObserver 唯一会触发的时机，也是唯一会吸底的时机。
  // 固定周期补发会在"被清掉之后、下次补发之前"留一段空档，那几帧的吸底会把我们的滞后一次抹平 = 跳一格。
  // 位移不足 0.6px 时不补：官方会把它当成"读者没动过"而当场 sample（含一次 React 重渲染），
  // 而这点滞后本来也看不见。
  const now = performance.now();
  const moved = Math.abs(scroller.scrollTop - announcedTop) > 0.6;
  if ((followHeight !== announcedHeight && moved) || now - lastAnnounceAt >= ANNOUNCE_MS) {
    lastAnnounceAt = now;
    announcedHeight = followHeight;
    announcedTop = scroller.scrollTop;
    announceCount += 1;
    try { scroller.dispatchEvent(new Event("scroll")); } catch { /* ignore */ }
  }
  return true;
}
function onMainScroll(event) {
  const el = event.currentTarget;
  if (followWrote === null || Math.abs(el.scrollTop - followWrote) > 2) {   // 位置不是我写下的 → 不是我们自己造成的
    // 读者动过滚轮/触摸/翻页键/滚动条 → 撒手；没有输入信号但长度没变却动了位置 = 有人在跳转（导航轨/外部程序）→ 也算读者
    if (performance.now() - scrollIntentAt <= USER_SCROLL_MS || el.scrollHeight === followHeight) {
      if (followOn) noteFlip(false, el.scrollHeight - el.clientHeight - el.scrollTop, {
        why: "scroll", top: Math.round(el.scrollTop), wrote: followWrote === null ? null : Math.round(followWrote),
        h: el.scrollHeight, fh: followHeight, intent: Math.round(performance.now() - scrollIntentAt),
      });
      followOn = false;
    }
    // 其余：展开/折叠让内容长高、浏览器锚定顺手改 scrollTop —— 不是读者，保持贴底
  }
  ensureTickLoop();   // 回底按钮的显隐在帧循环里定：读者一滚就得排一帧（收敛后循环本来是停的）
}

let scrollerCache = null;   // 滚动容器几乎不变，但找它要逐级 getComputedStyle（每帧都做就是每秒上百次样式解析）
let flowCache = null;     // 会话根（[data-chat-flow]）与最后一行：帧路径每帧都要用，不能每帧全文档查
let lastRowSeen = null;
function chatFlow() {
  if (flowCache && flowCache.isConnected) return flowCache;
  flowCache = document.querySelector(CHAT_FLOW);
  return flowCache;
}
function mainScroller() {
  const flow = chatFlow();
  guardObserve(flow);   // 顺带：这个函数每帧被调一次，是唯一稳定拿到 flow 的地方，guard 的 observer 就在这儿挂（缓存后不额外查 DOM）
  const probe = lastRowSeen && lastRowSeen.isConnected ? lastRowSeen : flow;
  if (scrollerCache && scrollerCache.isConnected && probe && scrollerCache.contains(probe)) return scrollerCache;
  // 取「最外层」可滚动祖先：0.1.7 每个过程组自带一个内滚动体，从行往上第一个撞到的不是会话滚动条
  let node = probe ? probe.parentElement : null;
  let found = null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) found = node;
    node = node.parentElement;
  }
  scrollerCache = found;
  return found;
}

/** 查询用的「会话根」。0.1.7 里 `[data-chat-flow]` 是每个过程组各一个，拿它当范围只看到一个组；
 *  主滚动容器才是覆盖整个会话的那一层（0.1.5 上它同样包含全部行）。 */
function chatScope() { return mainScroller() || document; }

/* ------------------------------------------------- 跑完一轮 → 移到提问处 -- */
const SETTLE_PAD = 12;       // 提问行停在视口顶端往下多少像素
const SETTLE_MAX_MS = 1400;  // 一次性滑动的兜底时长（正常 300~800ms 收敛）
let glide = null;            // { el, until }：正在做的一次性平滑移动（目标元素每帧重算：折叠/展开改了布局也跟得上）
let wasRunning = false;      // 上一次扫描时这一轮是否在跑（true→false = 刚跑完）
/** 元素顶端在滚动容器里的位置（绝对 scrollTop 坐标）。 */
function viewTop(scroller, el) {
  return scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}
/** 会话里所有用户发言行（文档顺序）：置顶条与「跑完回到提问处」共用。 */
function userRows() {
  return chatRows().filter((el) => el.getAttribute("data-chat-flow-kind") === "user");
}
function lastUserRow() {
  const rows = userRows();
  return rows.length === 0 ? null : rows[rows.length - 1];
}
/** 本轮跑完：平滑移到本轮提问处。关掉开关、读者已接管滚动、或找不到提问行时都不动。 */
function settleToPrompt(flow) {
  if (state.settleToPrompt === false) return;
  if (!followOn) return;                       // 读者自己接管了滚动 → 别动他的位置
  const scroller = mainScroller();
  if (scroller === null) return;
  const row = lastUserRow();
  if (row === null) return;
  const floor = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const want = Math.min(floor, Math.max(0, viewTop(scroller, row) - SETTLE_PAD));
  followOn = false;                            // 主动离开底部：别让跟随再把我们拽回底部
  if (state.animations === false) { writeTop(scroller, want); return; }   // 动效关掉 → 直接到位
  glide = { el: row, until: performance.now() + SETTLE_MAX_MS };
  ensureTickLoop();
}

/** 推进一次性平滑移动：目标每帧重算（折叠/展开改了布局也追得上），和跟随同一条追赶公式。
 *  返回"这一帧动了吗"——调用方据此跳过跟随并让帧循环继续。与「触底自动跟随」开关无关。 */
function glideTick(scroller, floor, dt) {
  if (glide === null) return false;
  if (!glide.el.isConnected || performance.now() > glide.until) { glide = null; return false; }
  const want = Math.min(floor, Math.max(0, viewTop(scroller, glide.el) - SETTLE_PAD));
  const dy = want - scroller.scrollTop;
  if (Math.abs(dy) <= 0.5) { glide = null; return false; }
  const step = Math.min(Math.abs(dy), Math.max(minStep(dt), Math.abs(dy) * smoothGrow() * (dt / 16)));
  const next = scroller.scrollTop + Math.sign(dy) * step;
  writeTop(scroller, next);
  followWrote = next;          // 同上：写完不读回
  moveCount += 1;
  ensureTickLoop();
  return true;
}

/* ----------------------------------------------------- 置顶显示提问 -- */
let pinRows = [];              // 所有用户发言行（扫描时更新，文档顺序）
let pinPick = -1;              // 上一帧钉住的下标（下一帧先验它还成不成立，省掉二分）
let pinRow = null;             // 当前置顶的那一行（帧里按"正在看哪一轮"选出来）
let pinBar = null;             // 固定层上的置顶条
const pinTextOf = new WeakMap();   // 行 → 单行文本（滚动来回不用重算）
/** 用户行里"人说的话"：rowText 已经跳过隐藏节点与过程块，这里再跳过时间戳/操作按钮，压成一行。 */
const promptText = (row) => rowText(row, (n) => n.matches("[class*='_time'],[class*='_actions']"), 400).replace(/\s+/g, " ").trim();
function ensurePinBar() {
  if (pinBar !== null && pinBar.isConnected) return pinBar;
  for (const old of document.querySelectorAll("[data-dshsf-pin]")) { try { old.remove(); } catch { /* ignore */ } }   // 旧实例残留：只留一个
  const bar = document.createElement("div");
  bar.setAttribute("data-dshsf-pin", "");
  bar.title = "回到本轮提问";
  bar.addEventListener("click", () => {
    const el = mainScroller();
    if (el === null || pinRow === null || !pinRow.isConnected) return;
    followOn = false;                                    // 主动离开底部：和「跑完回到提问处」同一套滑行
    glide = { el: pinRow, until: performance.now() + SETTLE_MAX_MS };
    ensureTickLoop();
  });
  (document.body || document.documentElement).appendChild(bar);
  pinBar = bar;
  return bar;
}
/** 每帧：钉住"你正在看的那一轮"的提问——视口顶端之上最后一条用户发言（行位置单调，二分即可，O(log n) 次测量）。
 *  只有整行都滚到视口上方才露面：不重复占屏、边界上也不闪。位置贴滚动容器顶边，宽度跟容器一致。 */
function pinTick(scroller) {
  const t0 = performance.now();
  try {
    pinTickInner(scroller);
  } finally {
    cost.pinMs += performance.now() - t0;
    cost.pinFrames += 1;
  }
}
function hidePinBar() { if (pinBar !== null && pinBar.hasAttribute("data-dshsf-visible")) pinBar.removeAttribute("data-dshsf-visible"); }
function pinTickInner(scroller) {
  const hide = hidePinBar;
  if (state.pinPrompt !== true || pinRows.length === 0) { hide(); return; }
  const bar = ensurePinBar();
  const box = scroller.getBoundingClientRect();
  const line = box.top + 2;
  const above = (i) => i >= 0 && i < pinRows.length && pinRows[i].getBoundingClientRect().top < line;
  // 滚动是连续的：上一帧的落点若还成立（它在线之上、下一行在线之下）就直接用 —— 常态 2 次测量，不用二分
  let pick = -1;
  if (above(pinPick) && !above(pinPick + 1)) pick = pinPick;
  else {
    let lo = 0, hi = pinRows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (above(mid)) { pick = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
  }
  pinPick = pick;
  const row = pick < 0 ? pinRows[0] : pinRows[pick];
  if (!row.isConnected) { hide(); return; }
  pinRow = row;
  const rect = row.getBoundingClientRect();
  const show = box.height > 40 && box.top < window.innerHeight - 40 && rect.bottom < line;
  const top = Math.round(box.top) + "px";
  const left = Math.round(box.left) + "px";
  const width = Math.round(box.width) + "px";
  if (bar.style.top !== top) bar.style.top = top;
  if (bar.style.left !== left) bar.style.left = left;
  if (bar.style.width !== width) bar.style.width = width;
  let text = pinTextOf.get(row);
  if (text === undefined) { text = promptText(row); pinTextOf.set(row, text); }
  if (bar.textContent !== text) bar.textContent = text;
  if (show !== bar.hasAttribute("data-dshsf-visible")) {
    if (show) bar.setAttribute("data-dshsf-visible", "");
    else bar.removeAttribute("data-dshsf-visible");
  }
}

/**
 * 官方那颗回底按钮的**点击**：官方是 `toBottom → el.scrollTop = el.scrollHeight`（瞬跳，容器也没有
 * `scroll-behavior:smooth`）。捕获阶段截下这次点击，改成置 followOn + 排帧 —— 回底就交给与我们跟随完全
 * 同一条追赶公式，平滑滑下去。跟随/动效关掉时放行，退回官方那条瞬跳（否则点了没反应）。
 */
function onToBottomClick(event) {
  if (synthetic || !(event.target instanceof Element)) return;
  if (state.autoFollow === false || state.animations === false) return;
  const btn = event.target.closest("button[class*='_toBottom']");   // 图标在按钮里，取最近的那个按钮
  if (btn === null || btn.closest("[data-dshsf-window], [data-dshsf-textwindow]") !== null) return;   // 小窗里的按钮不是它
  event.preventDefault();
  event.stopPropagation();          // React 的 onClick 在根上冒泡阶段，捕获阶段拦得住
  followOn = true;
  document.documentElement.removeAttribute("data-dshsf-jumpgate");   // 按钮立刻收起：我们已经在往回走了
  ensureTickLoop();
}

/**
 * 主窗口的回底按钮**不自绘**：外观、位置、点击行为都用官方那颗（`[class*='_toBottomSlot']` 里的按钮），
 * 我们只接管"它什么时候出现"——CSS 默认把它藏起来，判定要显示时才给 html 挂 `data-dshsf-jumpgate`。
 * 官方自己是"gap>25 就渲染"（无滞回），跟随中的正常落后会让它一开一关地闪；我们按带滞回的规则给：
 *   点亮 = 读者接管（!followOn）且确实离底（gap>24）；熄灭 = 回到贴底（gap<12）/ 关掉开关。
 * 元素在不在 DOM 里仍由官方决定，但那只影响"能不能显示"；闪不闪由我们说了算。
 */
/** 官方那颗按钮的显隐（带滞回；状态只有一处＝html 上的 data-dshsf-jumpgate）。
 *  点亮 = 读者接管（!followOn）且确实离底（gap>24）；熄灭 = 回到贴底（gap<12）或关掉开关。
 *  单独抽出来是因为"跟随关掉"那条早退路径也必须维护它——否则 CSS 默认藏着的官方按钮永远不会露面。 */
function updateJumpGate(gap, follow) {
  const root = document.documentElement;
  if (state.showJumpButton === false) { root.removeAttribute("data-dshsf-jumpgate"); return; }
  if (root.hasAttribute("data-dshsf-jumpgate")) { if (gap < 12) root.removeAttribute("data-dshsf-jumpgate"); }
  else if (gap > 24 && !follow) root.setAttribute("data-dshsf-jumpgate", "");
}

/**
 * 官方吸底写在它自己的 ResizeObserver 回调里（observe 的正是 [data-chat-flow]），一帧就把我们的滞后抹平。
 * 我们的 observer 注册得晚 → 同一轮投递里排在它后面、仍在 layout 之后 paint 之前：在这一刻把位置改回
 * 我方追赶点，那一跳根本画不出去（与 anchorRO 同一条路子）。只回补"本来就在贴底、且只被抢走一小段"的：
 * 换会话 / 导航跳转这类大位移不碰（距离上限），读者自己滚（followOn 已翻假）也不碰。
 * 附带好处：官方记录的 observedTop 停在 floor，我们回补后的位置与它差着一段追赶距离，
 * 它下一次 onScroll 会判成"读者动过"→ 不再立刻 sample，pending 也就守住了。
 */
const SNAP_UNDO_MAX = 600;   // 一次最多回补多少像素：超过这个数就不是吸底抢跑，是有人在跳转
let guardRO = null;
let guardFlow = null;
let guardComposer;           // 官方那条 RO 还 observe 了 composer：它一变也会吸底，所以我们也得盯（undefined=还没查过，null=查过没有）
/**
 * 官方吸底的最后一条路是**直接赋值** `el.scrollTop = el.scrollHeight`（toBottom 与 followRef 都这么写），
 * 采样标记压不住它，只能事后回补——而回补总有"晚一帧"的窗口（官方在别的绘制阶段落地那一跳就画出去了，
 * 看着就是闪）。所以在滚动容器实例上装一个 setter：**跟随期间（我方最近 0.8s 内写过）把这种"一步贴到底"
 * 的写入直接丢掉**，位置从此只有我们一个写入者；读者/官方跳转（写的是具体行位置）照旧放行。
 * 窗口一过（流停了、我们不再写）过滤自动失效，官方自己的行为原样恢复。
 */
let ownWrite = false;        // 我方写入：setter 直接放行
let writeAt = 0;             // 我方最近一次写主滚动容器的时刻（0 = 从没写过 → 不过滤）
let snapTaken = null;        // 已接管的容器：{ el }
let snapBlocked = 0;         // 诊断：被丢掉的官方贴底写入次数
function writeTop(el, value) {
  ownWrite = true;
  try { el.scrollTop = value; } finally { ownWrite = false; }
  writeAt = performance.now();
}
function takeOverSnap(el) {
  if (snapTaken !== null && snapTaken.el === el) return;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || typeof desc.get !== "function" || typeof desc.set !== "function") return;
  if (snapTaken !== null) { try { delete snapTaken.el.scrollTop; } catch { /* ignore */ } }
  const taken = { el };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get() { return desc.get.call(el); },
    set(value) {
      if (!ownWrite && (followOn || glide !== null) && state.autoFollow !== false && performance.now() - writeAt <= 800
        && value >= el.scrollHeight - 1) { snapBlocked += 1; return; }
      desc.set.call(el, value);
    },
  });
  snapTaken = taken;
}
function guardSnap() {
  const el = followScroller;
  if (!el || (!followOn && glide === null) || followWrote === null) return;
  const floor = Math.max(0, el.scrollHeight - el.clientHeight);
  const back = floor - followWrote;
  if (back <= 1 || back > SNAP_UNDO_MAX) return;
  if (el.scrollTop < floor - 1) return;       // 没被推到贴底：不是吸底
  writeTop(el, followWrote);                  // 撤销，仍在 paint 之前
  guardCount += 1;
}
function guardObserve(flow) {
  if (!flow) return;
  // 缓存：这个函数每帧都会被 mainScroller() 调到，querySelector 在长会话里要走完整棵子树，不能每帧查
  if (flow === guardFlow && guardComposer !== undefined && (guardComposer === null || guardComposer.isConnected)) return;
  const composer = followScroller === null ? null : followScroller.querySelector("[data-composer-seat]");
  if (flow === guardFlow && composer === guardComposer) return;
  if (guardRO === null) { try { guardRO = new ResizeObserver(guardSnap); } catch { guardRO = false; return; } }
  if (guardRO === false) return;
  guardRO.disconnect();
  guardFlow = flow;
  guardComposer = composer;
  guardRO.observe(flow);
  if (composer !== null) guardRO.observe(composer);   // 官方那条 RO 也 observe 它：composer 一变它就会吸底
}

/* -------------------------------------------------------------- 小窗打标 -- */
/** 某一轮里最后一个匹配元素（运行中"最新那一个"就是它）。 */
function newestInTurn(flow, selector, turn) {
  const all = Array.from(flow.querySelectorAll(selector));
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const row = all[i].closest(ROW);
    if (row && row.getAttribute("data-chat-turn") === turn) return all[i];
  }
  return null;
}

function syncWindows(flow, running, collected, bodies, heights) {
  const now = Date.now();
  // ① 只有"正文已挂载"的块才需要小窗打标 / 揭示动画 / 收起拦截（收起只可能发生在展开着的块上）。
  //    扫描开始时一次遍历就拿到这些块，而不是对每个卡片各查一次子树——会话越长，这笔账越贵。
  const wiredTools = new Set();
  const windowQueue = [];   // 先只读、后集中写：量一个写一个会让下一次量强制重排（布局抖动）
  for (const body of bodies || flow.querySelectorAll(BODY_ANY)) {
    if (body.matches(THINK_BODY)) {
      const root = body.closest(THINK);
      if (root && !root.closest("[data-dshsf-folded]")) {
        wireDisclosure(root, thinkOpen, THINK_BODY, (el) => { el.dataset.dshsfKeepOpen = "1"; });
        if (heights && heights.has(body)) windowQueue.push([body, heights.get(body)]);
      }
      continue;
    }
    if (body.hasAttribute("data-context-injection-body")) continue;   // 上下文注入行交给 syncContextRows
    const prev = body.previousElementSibling;
    const root = body.closest(TOOL_CARD) || (prev && prev.matches && prev.matches(TOOL_CARD) ? prev : null);   // bash 卡：正文是根的下一个兄弟
    if (!root || wiredTools.has(root)) continue;
    wiredTools.add(root);
    if (root.closest("[data-dshsf-folded]")) continue;
    if (heights && heights.has(body)) revealBody(body, heights.get(body));   // 官方自己展开 / 键盘展开：扫描到就补播（高度已在只读阶段量好）
    wireDisclosure(root, toolOpen, TOOL_BODY, (el) => { el.dataset.dshsfKeepClosed = "1"; delete el.dataset.dshsfToolAuto; });
  }
  for (const [body, height] of windowQueue) tagThinkWindow(body, height);   // 集中写：这一轮里不再夹读取
  // 已卸载的登记先清掉（与运行态无关）：否则空闲期这些强引用会跨会话一直累积
  for (const root of autoThinks) if (!root.isConnected) autoThinks.delete(root);
  for (const root of autoTools) if (!root.isConnected) autoTools.delete(root);
  if (!running) { sparks.focus(null); return; }   // 跑完就不再磨金属：火星自然熄灭后画布一并摘掉
  // ② 运行中只处理"本轮"：自动展开最新那一个、被取代的我方窗口延迟折回。
  //    原来是扫整个会话的思考/工具根，会话一长就是几百次 closest + 子树查询。
  const lastTurn = collected ? collected.lastTurn : collectTurns().lastTurn;
  const rows = (collected && lastTurn !== null ? collected.turns.get(lastTurn) : null) || [];
  // 只找"最新的那一个"：从最后一行往前查，找到就停（原来是每行各查两次、再把整轮所有根攒成数组）
  let newestThink = null;
  let newestTool = null;
  for (let i = rows.length - 1; i >= 0 && (newestThink === null || newestTool === null); i -= 1) {
    if (newestThink === null) {
      const hit = rows[i].querySelectorAll(THINK);
      if (hit.length) newestThink = hit[hit.length - 1];
    }
    if (newestTool === null) {
      const hit = rows[i].querySelectorAll(TOOL_CARD);
      if (hit.length) newestTool = hit[hit.length - 1];
    }
  }
  let budget = 3;                 // 每次扫描最多展开 3 个，避免加载时重渲染风暴
  if (newestThink !== null && !newestThink.closest("[data-dshsf-folded]") && state.autoExpandReasoning !== false
    && !thinkOpen(newestThink) && budget > 0 && inViewport(newestThink)) {
    if (openThink(newestThink)) budget -= 1;
    else busyWork = true;
  }
  if (newestTool !== null && !newestTool.closest("[data-dshsf-folded]") && state.autoExpandTools !== false
    && !toolOpen(newestTool) && budget > 0 && inViewport(newestTool)) {
    if (openTool(newestTool)) budget -= 1;
    else busyWork = true;
  }
  // 火星只跟着"正在被磨的那一个窗"：本轮最新的思考小窗（没展开就没有火星）
  sparks.focus(newestThink ? newestThink.querySelector(THINK_BODY) : null);
  // 被取代的我方窗口：只遍历"我们自己开过的那几个"（通常 1~3 个），不再遍历本轮所有思考/工具根
  for (const root of autoThinks) {
    if (!root.isConnected) { autoThinks.delete(root); continue; }
    if (root === newestThink) continue;
    if (!thinkOpen(root) || root.dataset.dshsfKeepOpen === "1") { autoThinks.delete(root); continue; }
    if (Number(root.dataset.dshsfSupersededAt || "0")) continue;         // 已经起了宽限定时器
    root.dataset.dshsfSupersededAt = String(now);   // 刚被取代：起定时器，到点再折
    scheduleSupersedeClose(root, supersedeDelay() * 1000);
  }
  for (const root of autoTools) {
    if (!root.isConnected) { autoTools.delete(root); continue; }
    if (root === newestTool) continue;
    if (!toolOpen(root)) { autoTools.delete(root); continue; }
    if (closeBudget <= 0) { busyWork = true; continue; }
    if (closeTool(root)) closeBudget -= 1;
  }
}

/* -------------------------------------------------------- 上下文注入行 -- */
/** 上下文注入行（回忆/上下文注入）也是官方 DisclosureRow：正文在 = 展开。挂同一套揭示 + 收起动效。 */
function syncContextRows(flow, bodies, heights) {
  for (const body of (bodies ? Array.from(bodies).filter((el) => el.hasAttribute("data-context-injection-body")) : flow.querySelectorAll(CTX_BODY))) {
    if (!heights || heights.has(body)) revealBody(body, heights ? heights.get(body) : undefined);
    const root = body.parentElement;                          // DisclosureRow 的 {open && children} → 正文是根的直接子节点
    if (root) wireDisclosure(root, (el) => el.querySelector(CTX_BODY) !== null, CTX_BODY, null);
  }
}

/* -------------------------------------------------------- 穿插正文小窗 -- */
function clearTextWindows(row) {
  if (!row.hasAttribute("data-dshsf-tw")) return;   // 绝大多数行没有穿插正文小窗：省掉一次子树查询
  row.removeAttribute("data-dshsf-tw");
  for (const el of row.querySelectorAll("[data-dshsf-textwindow]")) {
    el.removeAttribute("data-dshsf-textwindow");
    el.style.maxHeight = "";
    el.style.overflow = "";
    liveWindows.delete(el);
  }
}
/** 折叠后仍保留的穿插正文行进限高小窗（答案行正文不套窗，只用一条线跟它分开）。 */
function syncTextWindows(flow, collected) {
  const keepText = state.keepInterleavedText !== false;
  for (const turnRows of (collected ? collected.turns : collectTurns().turns).values()) {
    const assistantRows = turnRows.filter((row) => rowKind(row) === "assistant-step");
    const answerRow = answerRowOf(turnRows);
    let keptText = false;
    for (const row of assistantRows) {
      if (!keepText || row === answerRow || row.hasAttribute("data-dshsf-folded") || !hasText(row)) {
        clearTextWindows(row);
        continue;
      }
      const body = assistantBody(row);
      if (!body) continue;
      keptText = true;
      for (const child of Array.from(body.children)) {
        if (child.querySelector && child.querySelector(THINK)) continue;   // 思考有自己的小窗
        if ((child.textContent || "").trim() === "") continue;
        if (child.dataset.dshsfTextwindow !== "1") { child.dataset.dshsfTextwindow = "1"; row.setAttribute("data-dshsf-tw", ""); }
        wireWindow(child);
      }
    }
    if (answerRow) answerRow.toggleAttribute("data-dshsf-answer-sep", keptText);   // 有穿插正文才画线
  }
}

/* ---------------------------------------------------- 官方「对话显示」行 -- */
function syncNativeRow() {
  const ours = document.querySelector(".dshsf-select");
  if (ours === null && document.querySelector("[data-dshsf-native-row]") === null) return;
  for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (ours !== null && ours.contains(button)) continue;   // 别把自己的下拉当成官方那一行
    const text = (button.textContent || "").trim();
    if (!/^(简洁|标准|详细|完全展开|紧凑|Normal|Compact|Standard|Detailed|Verbose)(\s*[▾⌄v])?$/.test(text)) continue;
    const row = button.closest('[class*="_row"]');
    if (!row) continue;
    if (ours !== null) row.setAttribute("data-dshsf-native-row", "");
    else row.removeAttribute("data-dshsf-native-row");
  }
}

/* ------------------------------------------------------ 火星特效（独立） -- */
/**
 * 思考小窗底部的火星：小窗自己在滚动时才溅（像滚筒碾过金属），贴着小窗底边整条往上飞，additive 混合出冷蓝的光。
 * 火星只往上去（单边），底边一道热光带跟着流量抖动、迸发时整条闪。
 * 独立模块：只认「一个元素 + 一份配置」——不读插件 state、不碰折叠/滚动/扫描，整块删掉不影响其余功能。
 * 主帧循环每帧喂一次 tick(dt)：熄灭且不发光时返回 false，主循环自然停手（空闲零成本）。
 */
const SPARK_BAND = 64;       // 火星"band"高度（px）：肉眼看的那一段（渐隐也发生在这里）
const SPARK_DRIFT = 96;      // 画布在 band 之上多留的余量：画布随写头下移时粒子会被反向平移顶到上方，不留就被裁掉上沿
const SPARK_DROP = 44;       // 画布在地面线之下多留的余量（给"朝下飘"的火星；不留就只剩半个扇面）
const SPARK_H = SPARK_BAND + SPARK_DRIFT;
const SPARK_FORGE_RATE = 30;  // 锻打火星的发射速率（颗/秒，满强度；密度滑条再乘上去）
const SPARK_END_RATE = 0.45;  // 两端端点额外的火星量（相对主流量的比例）：端点更密、且朝窗口内迸
const SPARK_END_W = 12;       // 端点的横向范围（px）：这个宽度内算"端点"
// 找"正文"时要跳过的子树：思考块、工具卡（bash 卡）、以及我们自己挂的火星层 —— 锻打只属于答案正文
const SPARK_SKIP = "[data-variant='think'], [data-tool], [data-sample='bash']";   // 找正文时跳过：思考块 / 工具卡（bash 卡）
const SPARK_MAX = 96;        // 单个小窗的粒子上限（预算；满了就不再生成）
const SPARK_RATE = 42;       // 满强度下每秒生成几颗
/* 摩擦亮度 ↔ 滚动速度的映射（形状是常数，旋钮在设置里只有颜色/密度/速度）： */
const SPARK_LIT_MAX = 2.4;      // 亮度曲线满值（画的时候映射到描边的 1.35 上限）
const SPARK_LIT_LO = 0.35;      // 曲线起点：u（速度/基准）低于它基本不发光
const SPARK_LIT_HI = 5;         // 曲线顶端：u 到这里算拉满
const SPARK_LIT_CURVE = 0.6;    // 曲线形状：<1 = 低段抬起来（压缩），1 = 线性
const SPARK_EMIT_MAX = 1.8;     // 满强度发射率倍率（与旧版那个恒定值一致，密度观感不变）
const SPARK_EMIT_BASE = 0.55;   // 最慢时的发射率占比：速度只做温和的疏密变化，慢输出也不至于没火星
const SPARK_REF_MIN = 0.35;     // 基准速度下限（px/16ms）：输出很慢时也保留灵敏度
const SPARK_REF_MAX = 2.5;      // 基准速度上限：到顶后不再按输出速度归一化 → 亮度继续随绝对速度涨
const SPARK_TAU_FLOW = 200;     // 输出速度 EMA 时间常数（ms）
const SPARK_TAU_LIT = 90;       // 亮度 EMA 时间常数（ms）
const SPARK_COOL_AFTER = 80;    // 停手多久开始退温（ms）
const SPARK_TAU_COOL = 140;     // 余温衰减时间常数（ms）
const SPARK_TRAIL = 0.04;    // 拖尾时长（秒）：金属火星是短划线，不是点
const SPARK_GLOW_H = 26;     // 底边热光带的高度（px，向上渐隐；渐变只在宽度变化时重建，一帧一次 fillRect）
/** "#rgb" / "#rrggbb" / "rgb(...)" -> [r,g,b]；认不出就用兜底色。 */
function sparkRgb(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const s = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  const rgb = fn ? fn[1].split(",").slice(0, 3).map((x) => Math.round(Number(x))) : null;
  return rgb && rgb.every((n) => Number.isFinite(n) && n >= 0 && n <= 255) ? rgb : fallback;
}
function createSparkFx() {
  const fields = new Map();     // el -> field（只给"当前聚焦的那个窗"挂画布）
  const opt = { on: true, color: "#4fa8ff", density: 1, forge: true, forgeSpeed: 1, forgeLife: 1.3 };
  const cost = { frames: 0, ms: 0, lastMs: 0, maxMs: 0, strikes: 0, draws: 0, resizes: 0, places: 0 };
  let rgb = sparkRgb(opt.color, [79, 168, 255]);
  let core = "";
  let focusEl = null;      // 磨（思考小窗）：连续，带地面倒影
  let forgeEl = null;      // 锻（正文写头）：每前移一次砸一锤，火星从落点扇形溅出
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const tone = () => { core = rgb.map((c) => Math.round(c + (255 - c) * 0.75)).join(","); };
  tone();
  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  const enabled = () => opt.on && !reduced();
  const enabledForge = () => enabled() && opt.forge;

  function fieldFor(el, mode) {
    let known = fields.get(el);
    if (known) { known.mode = mode; return known; }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return null;                       // 拿不到 2d 上下文（无头/降级）：整块特效当它不存在
    canvas.dataset.dshsfSpark = "";
    // 画布挂在 body 的固定层上，不插进正文（插进去会被 React 重排、被滚动带走，还要"必须挂在最后"的自愈），
    // 改成挂在 body 上的固定层：每帧按视口坐标摆位，正文怎么动都与它无关。
    (document.body || document.documentElement).appendChild(canvas);
    known = { el, canvas, ctx, w: 0, px: null, py: null, dpr: 0, parts: [], emit: 0, glow: 0, idle: 0, painted: false,
      mode, ground: mode === "forge" ? SPARK_H - SPARK_DROP : SPARK_H,
      burst: 0, nextBurst: 0.25 + Math.random() * 0.5, flash: 0, jitter: 0.5, level: 0, lastLevel: 0, flow: 0, lit: 0, emitEnd: 0,
      grad: null, gradW: 0,
      caretNode: null, caretTextLen: -1,
      strikeX: 0, strikeY: 0, forgeWarm: 0, wasFresh: false, lastWrite: 0, emitForge: 0, range: null,
      top: el.scrollTop, height: el.scrollHeight };
    fields.set(el, known);
    return known;
  }
  function drop(el) {
    const f = fields.get(el);
    if (!f) return;
    fields.delete(el);
    if (f.canvas.parentNode) f.canvas.remove();
  }
  function focus(el) {
    const next = el && el.isConnected ? el : null;
    if (next === focusEl) return;
    focusEl = next;
    if (next && enabled()) fieldFor(next, "floor");
  }
  /** 正文写头：attach 到这个元素，效果自己盯着它的最后一行末尾砸。 */
  function forge(el) {
    const next = el && el.isConnected ? el : null;
    if (next === forgeEl) return;
    // 撒手（跑完/换行）：不立刻摘画布，让还在飞的火星烧完；烧完后 tick 会自己把画布摘掉。
    forgeEl = next;
    if (next && enabledForge()) fieldFor(next, "forge");
  }
  function setOptions(next) {
    if (!next) return;
    if ("on" in next) opt.on = next.on !== false;
    if ("color" in next) { rgb = sparkRgb(next.color, rgb); tone(); }
    if ("density" in next) { const n = Number(next.density); opt.density = clamp(Number.isFinite(n) ? n : 1, 0.2, 3); }
    if ("forge" in next) opt.forge = next.forge !== false;
    if ("forgeSpeed" in next) { const n = Number(next.forgeSpeed); opt.forgeSpeed = Number.isFinite(n) ? clamp(n, 0.2, 4) : 1; }
    if ("forgeLife" in next) { const n = Number(next.forgeLife); opt.forgeLife = Number.isFinite(n) ? clamp(n, 0.2, 5) : 1.3; }
    if (enabled() && focusEl) fieldFor(focusEl, "floor");
    if (enabledForge() && forgeEl) fieldFor(forgeEl, "forge");
  }
  function reset() { for (const el of Array.from(fields.keys())) drop(el); focusEl = null; forgeEl = null; }
  function resetCost() { cost.frames = 0; cost.ms = 0; cost.lastMs = 0; cost.maxMs = 0; cost.strikes = 0; cost.draws = 0; cost.resizes = 0; cost.places = 0; }
function stats() {
    let parts = 0;
    let one = null;
    for (const f of fields.values()) { parts += f.parts.length; if (!one) one = f; }
    const box = one ? one.canvas.getBoundingClientRect() : null;
    return { on: enabled(), focus: focusEl !== null, forge: forgeEl !== null && enabledForge(), fields: fields.size, parts,
      w: one ? one.w : 0, elW: one ? one.el.clientWidth : 0, cssW: box ? Math.round(box.width) : 0, dpr: one ? one.dpr : 0,
      heating: one ? !!one.parts.length || one.forgeWarm > 0.01 : false,
      lit: one ? +(one.lit || 0).toFixed(2) : 0, level: one ? +(one.level || 0).toFixed(2) : 0,   // 摩擦当前亮度 / 发射率（随速度实时变）
      caretLen: one ? one.caretTextLen : -1, el: one ? (one.el.tagName + "." + String(one.el.className || "").split(" ")[0]).slice(0, 44) : "",
      color: opt.color, density: opt.density,
      frames: cost.frames, strikes: cost.strikes, lastMs: cost.lastMs, maxMs: cost.maxMs, avgMs: cost.frames ? +(cost.ms / cost.frames).toFixed(3) : 0,
      draws: cost.draws, resizes: cost.resizes, places: cost.places };
  }

  /** 火星的"燃料"是小窗自己在滚：滚得越快越亮越密，不滚就没有（没有基础量）。
   *
   *  亮度 ↔ 速度的映射（两段自适应 + 一条压缩曲线）：
   *    speed = |ΔscrollTop| / dt16            实际滚动速度（px / 16ms，dt 归一）
   *    flow  = EMA(|ΔscrollHeight| / dt16)    当前输出速度（内容长得多快，τ=200ms）
   *    ref   = clamp(flow*0.6, 0.35, 2.5)     **基准速度只在小速度侧跟着输出速度走**：
   *        输出慢 → 基准小，一点点滚动就看得出；输出快到 ref 封顶后就不再归一化，
   *        亮度继续随绝对速度上涨（快输出更烫）。旧版 ref 与输出速度等比（上限 6），等于把速度
   *        信息除掉了 —— 快慢都稳稳顶在天花板上，这才是"看不出随速度变化"的原因。
   *    u     = speed / ref                    1 ≈ 恰好跟上输出
   *    k     = clamp((u-0.35)/(5-0.35),0,1)^0.6   压缩曲线：低段抬起来、高段放缓，单调、无台阶、无硬顶
   *    lit   = EMA(2.4 * k)                   亮度（τ=90ms）→ 画的时候乘 0.56 映射到描边的 1.35 上限
   *    emit  = 1.8 * (0.55 + 0.45*k)          发射率：跟着速度走，但只做温和的疏密变化（不跟亮度一起暴走）
   *  停手（>80ms 不滚）后按 τ=140ms 指数退温、低于 0.02 归零 —— 平滑熄灭，同时保证帧循环能停（空闲零成本）。
   *  所有 EMA 一律按 dt 归一（τ 恒定），换刷新率、换输出速度手感一致。 */
  function readLevel(f, dt, top, height) {
    const per = Math.max(1, dt / 16);
    const moved = top - f.top;
    const speed = Math.abs(moved) / per;                                   // 实际滚动速度（px / 16ms）
    const flow = Math.max(0, height - f.height) / per;                     // 当前输出速度（内容长得多快）
    const dir = clamp(moved / per / 8, -1, 1);
    f.top = top;
    f.height = height;
    f.flow += (flow - f.flow) * (1 - Math.exp(-dt / SPARK_TAU_FLOW));       // 输出速度慢速 EMA（不跟单帧抖）
    const ref = clamp(f.flow * 0.6, SPARK_REF_MIN, SPARK_REF_MAX);
    const u = speed / ref;                                                // 归一化：1 ≈ 正好跟上输出
    const v = clamp((u - SPARK_LIT_LO) / (SPARK_LIT_HI - SPARK_LIT_LO), 0, 1);
    const k = Math.pow(v, SPARK_LIT_CURVE);
    f.idle = speed > 0.05 ? 0 : f.idle + dt;
    const cool = f.idle <= SPARK_COOL_AFTER ? 1 : Math.exp(-(f.idle - SPARK_COOL_AFTER) / SPARK_TAU_COOL);
    f.lit += (SPARK_LIT_MAX * k * cool - f.lit) * (1 - Math.exp(-dt / SPARK_TAU_LIT));
    const raw = SPARK_EMIT_MAX * (SPARK_EMIT_BASE + (1 - SPARK_EMIT_BASE) * k) * cool;
    const level = raw < 0.02 ? 0 : raw;          // 归零阈值：低于它就彻底撒手，帧循环才停得下来
    const resume = level > 0.05 && f.lastLevel <= 0.05;       // 停过又滚起来：滚筒重新咬上金属
    f.lastLevel = level;
    return { level, dir, resume };
  }
  /** 正文写头：最后一个"有字"的文本节点末尾，用 Range 取最后一个字的矩形（一帧一次读，复用同一个 Range）。 */
  /** 子树里最后一个"有字"的文本节点（从后往前走，碰到就收工；跳过我们自己的火星层）。 */
  function lastTextIn(root) {
    const walk = (el, depth) => {
      if (depth > 24) return null;
      for (let kid = el.lastChild; kid; kid = kid.previousSibling) {
        if (kid.nodeType === 3) { if (kid.nodeValue && kid.nodeValue.trim()) return kid; continue; }
        if (kid.nodeType !== 1) continue;
        if (kid.matches && kid.matches(SPARK_SKIP)) continue;   // 思考/工具/自家层：不是正文，跳过整棵子树
        const hit = walk(kid, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root, 0);
  }
  function caretPoint(f) {
    const node = lastTextIn(f.el);
    if (!node) return null;
    f.caretNode = node;
    f.caretTextLen = node.nodeValue.length;
    try {
      const range = f.range || (f.range = document.createRange());
      const len = node.nodeValue.length;
      range.setStart(node, Math.max(0, len - 1));
      range.setEnd(node, len);
      const rect = range.getBoundingClientRect();
      return rect && (rect.width || rect.height) ? rect : null;
    } catch { return null; }
  }
  /** 一颗锻打火星：从"写头那一小片"（spot = 画布局部坐标）向四周缓慢扩散。 */
  function one(f, spot, power) {
    const count = f.parts.length >= SPARK_MAX ? 0 : 1;
    for (let i = 0; i < count; i += 1) {
      // 锻打：从落点**向四周**缓慢扩散（不是朝上一个扇面），像溅出来的一小团火星
      const angle = Math.random() * Math.PI * 2;
      const speed = (20 + Math.random() * 60) * power * opt.forgeSpeed;   // 慢：飘出去而不是溅出去（速度可配）
      const ttl = opt.forgeLife * (0.7 + Math.random() * 0.6);   // 寿命可配（默认 1.3s → 0.9~1.7s）
      // 落点只在"写头那一行"上抖：不要用"最近写过的一片字"的并集包围盒 —— 换行时它横跨两行，
      // 火星会跑到新行还没写字的地方去。
      const x = spot ? spot.x + (Math.random() - 0.5) * 56 : Math.random() * f.w;
      const y = spot ? spot.y : f.ground - 1;
      f.parts.push({
        x: clamp(x, 1, f.w - 1), y: clamp(y - 1 - Math.random() * 3, 2, f.ground - 1),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        g: 0.22,                       // 锻造的火星是飘的：几乎不吃重力，慢慢散开再淡掉
        ttl, life: ttl,
        r: 0.6 + Math.random() * 1.1,
        heat: 0.7 + Math.random() * 0.3,
      });
    }
    f.flash = 1;
    cost.strikes += 1;
    return count > 0;
  }
  /** 锻打：写头（只当"字在出现"的传感器用，火星不是从它那一个点出来的）前移够多、且离上一锤够久 → 砸一锤。 */
  function forgeTick(f, caret, spot, dtms) {
    const now = performance.now();
    f.jitter = f.jitter * 0.72 + Math.random() * 0.28;
    if (!caret) { f.forgeWarm = 0; return f.forgeWarm > 0.01; }
    // 火星：**连续细流**（不要攒成"一批一批"）—— 团状发射会让整团火星以 ~7Hz 明暗脉动，
    //    在 160Hz 屏上就是肉眼可见的"闪"，而它只在写字时出现（不写字就没有团），正好对上"写完就不闪"。
    const moved = Math.abs(caret.right - f.strikeX) + Math.abs(caret.bottom - f.strikeY);
    if (moved > 0.6) { f.strikeX = caret.right; f.strikeY = caret.bottom; f.lastWrite = now; }
    const fresh = now - (f.lastWrite || 0) < 350;                 // 最近 350ms 还在写字
    f.forgeWarm = clamp((f.forgeWarm || 0) + (fresh ? dtms : -dtms * 1.4) / 200, 0, 1);   // 起手 ~0.2s 爬到满速，停手 ~0.14s 退完
    if (fresh && !f.wasFresh && spot) for (let i = 0; i < 4; i += 1) one(f, spot, 0.7);   // 重新开写：补一小撮
    f.wasFresh = fresh;
    if (!spot) return f.forgeWarm > 0.01;
    const rate = SPARK_FORGE_RATE * opt.density * (0.65 + 0.7 * f.jitter) * f.forgeWarm;
    f.emitForge = (f.emitForge || 0) + rate * (dtms / 1000);
    let n = Math.floor(f.emitForge);
    f.emitForge -= n;
    const power = clamp(0.7 + moved / 60, 0.7, 1.6);
    while (n > 0) { n -= 1; if (!one(f, spot, power)) break; }
    return f.forgeWarm > 0.01;   // 还在发射才续帧（否则帧循环会被这里永远吊住）
  }
  /** 把画布摆到视口坐标（x = 左边缘，y = 底边）。画布一挪，粒子要反向平移 ——
   *  否则整团火星会跟着布局一起跳（换行、滚动、抽屉开合都会）。 */
  function place(f, x0, y0) {
    const x = Math.round(x0);
    const top = Math.round(y0 - SPARK_H);
    if (f.px === x && f.py === top) return;
    cost.places += 1;
    if (f.px !== null) {
      const dx = x - f.px;
      const dy = top - f.py;
      if (dx || dy) for (const p of f.parts) { p.x -= dx; p.y -= dy; }
    }
    f.px = x;
    f.py = top;
    f.canvas.style.transform = "translate(" + x + "px," + top + "px)";
  }
  function resize(f, w) {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (Math.abs(f.w - w) < 2 && f.dpr === dpr) return;   // ±1px 抖动不重设位图：重设会清空画布 = 火星闪一下
    if (f.parts.length && f.w > 0 && f.dpr === dpr && Math.abs(f.w - w) < 12) return;   // 有火星在飞就先别重设（位图重建会清屏）
    f.w = w;
    f.dpr = dpr;
    cost.resizes += 1;
    f.canvas.style.width = w + "px";
    f.canvas.style.height = SPARK_H + "px";
    f.canvas.width = Math.max(1, Math.round(w * dpr));
    f.canvas.height = Math.max(1, Math.round(SPARK_H * dpr));
    f.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** 一颗火星：从底边上随机一点溅起（整条边都在磨）；摩擦流是浅角度、贴地擦行的碎火，迸发是陡而快的直冲。 */
  function emitSpark(f, dir, boom) {
    if (f.parts.length >= SPARK_MAX) { f.emit = 0; f.burst = 0; return; }
    const skid = !boom && Math.random() < 0.45;
    const ttl = (boom ? 0.36 : 0.3) + Math.random() * 0.5;
    f.parts.push({
      x: clamp(Math.random() * f.w, 1, f.w - 1),
      y: f.ground - 1 - Math.random() * 3,
      vx: (Math.random() - 0.5) * (boom ? 170 : skid ? 230 : 70) - dir * (boom ? 60 : 26),
      vy: boom ? -(130 + Math.random() * 190) : skid ? -(8 + Math.random() * 46) : -(90 + Math.random() * 210),
      ttl, life: ttl,
      r: (boom ? 0.8 : 0.6) + Math.random() * 1.2,
      heat: (boom ? 0.85 : 0.6) + Math.random() * 0.4,
    });
  }
  /** 底边摩擦：连续细流（一半是贴地擦行的碎火）+ 随机的一阵急火（流量越大越频繁）。 */
  /** 两端端点：比别处更密，而且朝窗口内飞（左端往右、右端往左）。 */
  function emitSparkEnd(f, side, boom) {
    if (f.parts.length >= SPARK_MAX) { f.emit = 0; f.emitEnd = 0; f.burst = 0; return; }
    const inward = side < 0 ? 1 : -1;
    const boost = boom ? 1.4 : 1;
    const ttl = (boom ? 0.36 : 0.3) + Math.random() * 0.5;
    f.parts.push({
      x: side < 0 ? Math.random() * SPARK_END_W : f.w - Math.random() * SPARK_END_W,
      y: f.ground - 1 - Math.random() * 3,
      vx: inward * (70 + Math.random() * 170) * boost,
      vy: -(70 + Math.random() * 190) * boost,
      ttl, life: ttl,
      r: (boom ? 0.8 : 0.6) + Math.random() * 1.1,
      heat: (boom ? 0.85 : 0.65) + Math.random() * 0.35,
    });
  }
  function emit(f, s, level, dir, resume) {
    if (level <= 0 || f.w < 8) return;
    f.level = level;
    f.jitter = f.jitter * 0.72 + Math.random() * 0.28;   // 整条边的亮度抖动：摩擦的"沙沙"感
    f.emit += SPARK_RATE * opt.density * level * s;
    f.nextBurst -= s;
    if (resume) { f.burst = Math.max(f.burst, Math.round((5 + Math.random() * 7) * opt.density)); f.nextBurst = 0.6; f.flash = 1; }
    if (f.nextBurst <= 0) {
      f.burst = Math.max(4, Math.round((6 + Math.random() * 12) * opt.density));
      f.nextBurst = 0.65 + Math.random() * 0.85 - 0.3 * Math.min(1, level);   // 一阵之后先安静下来，下一阵才有"迸"的感觉
      f.flash = 1;
    }
    let count = Math.floor(f.emit);
    f.emit -= count;
    let boom = 0;
    if (f.burst > 0) { boom = Math.min(f.burst, Math.max(2, Math.round(9 * Math.min(2, opt.density)))); f.burst -= boom; }   // 一阵急火：一两帧内放完，才有"迸"的对比
    for (let i = 0; i < count; i += 1) emitSpark(f, dir, false);
    for (let i = 0; i < boom; i += 1) emitSpark(f, dir, true);
    f.emitEnd += SPARK_RATE * opt.density * level * s * SPARK_END_RATE;   // 两端再加一股，朝内
    let ends = Math.floor(f.emitEnd);
    f.emitEnd -= ends;
    if (boom > 0) ends += Math.min(4, boom);                              // 迸发时两端跟着炸
    for (let i = 0; i < ends; i += 1) emitSparkEnd(f, i % 2 === 0 ? -1 : 1, boom > 0);
  }
  function step(f, s) {
    const parts = f.parts;
    const drag = Math.pow(0.25, s);
    f.flash = Math.max(0, f.flash - s * 3);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.life -= s;
      if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      p.vy += 620 * (p.g === undefined ? 1 : p.g) * s;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * s;
      p.y += p.vy * s;
      if (f.mode === "forge") {
        if (p.y > SPARK_H) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }   // 落出画布下沿才回收：地面线以下那段留白里，朝下的火星照样看得见
      } else if (p.y > f.ground - 2 && p.vy > 0) {   // 擦到地面线：跳一下然后很快熄灭（只有"磨"有地面；锻打的火星是飘的，不弹）
        p.y = f.ground - 2;
        p.vy *= -0.28;
        p.vx *= 0.7;
        p.life = Math.min(p.life, 0.1 + Math.random() * 0.12);
      }
    }
  }
  function draw(f) {
    const ctx = f.ctx;
    const parts = f.parts;
    cost.draws += 1;
    ctx.clearRect(0, 0, f.w, SPARK_H);
    f.painted = parts.length > 0;
    if (!parts.length) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    // 摩擦接触点：贴着小窗底边的一道热（连续滚时轻微抖，迸发时整条闪）
    // 整条底边在发热：一条向上渐隐的热光带 + 贴边芯线（只有"磨"有；正文的锻打不画这个）
    // 亮度取自速度曲线（f.lit，0~2.4）× 摩擦抖动；flash 是"迸发/重新咬上"额外的一闪
    const lit = Math.min(1.35, f.flash * 1.1 + (f.lit || 0) * 0.56 * (0.75 + 0.25 * f.jitter));
    if (f.mode !== "forge" && lit > 0.02 && f.w > 4) {
      if (!f.grad || f.gradW !== f.w) {                          // 渐变只在宽度变了才重建（每帧建渐变是最贵的画法之一）
        const g = ctx.createLinearGradient(0, f.ground + 7, 0, f.ground - SPARK_GLOW_H);
        g.addColorStop(0, "rgba(" + core + ",0.40)");
        g.addColorStop(0.42, "rgba(" + rgb.join(",") + ",0.13)");
        g.addColorStop(1, "rgba(" + rgb.join(",") + ",0)");
        f.grad = g;
        f.gradW = f.w;
      }
      ctx.globalAlpha = Math.min(1, lit);
      ctx.fillStyle = f.grad;
      ctx.fillRect(0, f.ground - SPARK_GLOW_H, f.w, SPARK_GLOW_H + 8);
      ctx.strokeStyle = "rgb(" + core + ")";
      ctx.globalAlpha = Math.min(1, lit * 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, f.ground - 0.75);
      ctx.lineTo(f.w, f.ground - 0.75);
      ctx.stroke();
      ctx.fillStyle = "#000";
    }
    for (let pass = 0; pass < 2; pass += 1) {
      ctx.strokeStyle = pass === 0 ? "rgb(" + rgb.join(",") + ")" : "rgb(" + core + ")";
      for (const p of parts) {
        const a = p.life / p.ttl;
        const below = p.y - f.ground;   // >0 = 在地面线**以下**（只有锻打的火星会到这里：写头那行下面留了一段）
        const edge = below > 0
          ? Math.max(0, (SPARK_H - p.y) / 20)                                        // 画布下沿 20px 内渐隐：飘出画布的瞬间不能"啪"地断掉
          : Math.min(1, Math.max(0, (SPARK_BAND - (f.ground - p.y)) / 24));           // 往上越远越淡（与画布高度无关）
        ctx.globalAlpha = Math.max(0, (pass === 0 ? a * a * 0.5 : a * 0.9) * edge * p.heat);
        ctx.lineWidth = pass === 0 ? p.r * 2.6 : p.r;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * SPARK_TRAIL, p.y - p.vy * SPARK_TRAIL);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  /** 先只读收集、后集中写（与主循环同一条规矩）；返回"还有火星或还在发光"。 */
  function tick(dt) {
    // 需要发光却没有画布（关掉又打开、切了窗、被摘过）：自动重挂
    if (enabled() && focusEl && focusEl.isConnected && focusEl.clientHeight > 0 && !fields.has(focusEl)) fieldFor(focusEl, "floor");
    if (enabledForge() && forgeEl && forgeEl.isConnected && !fields.has(forgeEl)) fieldFor(forgeEl, "forge");
    if (fields.size === 0) return false;
    const dtms = dt || 16;
    const s = clamp(dtms / 1000, 0.002, 0.064);
    const t0 = performance.now();
    const plan = [];
    for (const [el, f] of Array.from(fields)) {
      if (!el.isConnected) { drop(el); continue; }
      // 宽度取火星层自己的（= 窗口内容宽度，已扣掉滚动条槽与左右内边距），画布位图才不会左右被挤
      const rect = el.getBoundingClientRect();          // 画布要贴到哪儿：视口坐标（这一帧只读一次）
      if (el === f.el && f.mode === "forge") {
        // 已经没有新字、但火星还在飞：继续跑帧把它烧完（跑完底下会把画布摘掉）
        const cooling = f.parts.length > 0;
        const caret = el === forgeEl && enabledForge() ? caretPoint(f) : null;
        if (caret || (el === forgeEl && enabledForge())) plan.push({ f, hot: true, w: el.clientWidth, x: rect.left, y: (caret ? caret.bottom : rect.bottom) + SPARK_DROP, caret });
        else if (cooling) plan.push({ f, hot: true, cooling: true });    // 已经撒手但还有火星在飞：继续跑帧把它们烧完
        else { f.level = 0; f.lit = 0; plan.push({ f, hot: false }); }
      } else if (el === focusEl && enabled() && el.clientHeight > 0) {
        plan.push({ f, hot: true, w: el.clientWidth, x: rect.left, y: rect.bottom, top: el.scrollTop, height: el.scrollHeight });
      } else { f.level = 0; f.lit = 0; plan.push({ f, hot: false }); }
    }
    let busy = false;
    for (const item of plan) {
      const f = item.f;
      if (item.hot && f.mode === "forge") {
        if (!item.cooling) {
          resize(f, item.w);
          place(f, item.x, item.y);                    // 地面线（= 画布底边往上 SPARK_DROP）= 写头那一行的底边
        }
        const caret = item.caret;
        const spot = caret ? {                         // 写头 → 画布局部坐标（不额外读布局）
          x: caret.left - f.px + (caret.right - caret.left) * 0.5,
          y: clamp(caret.bottom - f.py, 4, f.ground - 1),
        } : null;
        if (forgeTick(f, caret, spot, dtms)) busy = true;
      } else if (item.hot) {
        const { level, dir, resume } = readLevel(f, dtms, item.top, item.height);
        resize(f, item.w);
        place(f, item.x, item.y);                      // 画布底边 = 窗口底边（贴边）
        emit(f, s, level, dir, resume);
        if (level > 0) busy = true;
      }
      step(f, s);
      if (f.parts.length) busy = true;
      if (f.parts.length) draw(f);
      else if (item.hot) { if (f.painted) draw(f); }   // 刚烧完：清一次屏，别把上一帧的火星冻在画布上
      else drop(f.el);                                 // 不再发光（关掉/失焦/跑完）：画布摘掉，DOM 不留东西
      // 火星烧完、而且**已经不是当前锚点**：这一帧就撤干净（否则帧循环一停手它会一直留在表里）。
      // ⚠ 当前锚点不能在这里摘：字段一重建，"写头移动量"就从头算，会把一次大位移当成刚写了字（停写后凭空砸火星）。
      if (!f.parts.length && f.el !== focusEl && f.el !== forgeEl) drop(f.el);
    }
    cost.frames += 1;
    const ms = performance.now() - t0;
    cost.lastMs = +ms.toFixed(3);
    cost.ms += ms;
    if (ms > cost.maxMs) cost.maxMs = +ms.toFixed(3);
    return busy;
  }
  return { focus, forge, setOptions, tick, reset, resetCost, stats };
}
/* 逐行现场：折叠与小窗的判定都建立在这些事实上，出问题时先看它。
   必须在 sparks 工厂**之外**声明 —— startController 里的 __dshStreamfold.rows 要引用它。
   （曾经被写在 createSparkFx 内部，导致 startController 抛 ReferenceError、整个插件起不来。） */
const sparks = createSparkFx();

/* ----------------------------------------------------------- 控制器 -- */
let scheduled = false;
let scanTimer = 0;          // schedule 里那个补扫定时器
let lastScan = 0;
let allowAnim = false;                       // 首屏不做动效（几十个过渡是加载卡顿主因）
let observer = null;
const SCAN_INTERVAL = 300;

function scanStructure() {
  if (disposed) return;
  try { scanStructureInner(); }
  catch (error) { cost.lastError = String((error && error.message) || error); throw error; }   // 扫描里抛错要看得见，而不是静默少记一次
}
function scanStructureInner() {
  const t0 = performance.now();
  cost.scans += 1;                       // 和 phases 一起记，避免"有阶段数据却没有计数"
  animBudget = ANIM_BUDGET;              // 每次扫描重置动画配额
  cost.counts = { hasText: 0, cards: 0, layouts: 0, opens: 0 };
  cost.phases.openThink = 0;
  cost.phases.openTool = 0;
  layoutReads = 0;
  cost.phases.hasText = 0;
  cost.phases.cards = 0;
  answerRowCache = new Map();            // 每次扫描重算：行还在变（流式），不能跨扫描复用
  // eslint-disable-next-line no-use-before-define
  rootVars();
  syncSession();                     // 换会话先把串号状态清掉（轮号复用会让运行中的轮次被折）
  const flow = chatScope();
  if (state.mode !== "fold") {
    if (flow) { unfoldAll(flow); clearChips(flow); }
    for (const el of document.querySelectorAll("[data-dshsf-window]")) el.removeAttribute("data-dshsf-window");
    for (const el of document.querySelectorAll("[data-dshsf-textwindow]")) el.removeAttribute("data-dshsf-textwindow");
    for (const el of document.querySelectorAll("[data-dshsf-answer-sep]")) el.removeAttribute("data-dshsf-answer-sep");
    sparks.focus(null);
    sparks.forge(null);
    pinRows = userRows();   // 置顶条在两种显示模式下都要跟着滚（native 不折叠，但一样要钉）
    if (pinPick >= pinRows.length) pinPick = -1;
    // 官方档位下不能把这两个状态留成"上一轮还在跑"：busyWork 留着会让 schedule 每 300ms 自续
    // （native 分支不再重置它 → 永久空转扫描）；wasRunning 留着会在切回折叠时误触发"跑完回到提问处"。
    busyWork = false;
    wasRunning = false;
    return;
  }
  if (!flow) return;
  // 运行态带粘性：标记一消失就当成跑完，会在步骤/工具交接的空档里折一次（用户看到"运行中全折起来"）。
  // 只有连续 RUN_GRACE_MS 看不到任何运行标记，才算这一轮结束 —— 收尾的折叠只做这一次。
  const stamp = performance.now();
  const collected = collectTurns();                     // 提前取一次：运行判定要用最后一轮
  // 契约自检：官方每一轮都会渲染一个 [data-turn-tail]（收尾标记就挂在它上面）。已经有 2 轮以上却一个都没有，
  // 说明是内核换了 DOM（而不是"首轮还没跑完"）——此时 openLastTurn 恒真、最后一轮永不折叠，只报警不猜。
  if (!contractWarned && collected.turns.size >= 2 && flow.querySelector("[data-turn-tail]") === null) {
    contractWarned = true;
    console.warn("[streamfold] 找不到官方的 [data-turn-tail] 收尾标记：运行态判定可能与内核不符，请跑 __dshStreamfold.rows() 核对");
  }
  const markRunning = flow.querySelector(RUNNING) !== null;
  if (markRunning) lastRunningAt = stamp;
  else if (runningSticky) {
    // 标记已经没了、粘性还在：跑完那一刻之后没有 DOM 变化就不会再有扫描，
    // 所以这里自己排一次 —— 到点做收尾（折叠 + 回到提问处），只做一次。
    clearTimeout(runGraceTimer);
    runGraceTimer = setTimeout(schedule, Math.max(32, lastRunningAt + RUN_GRACE_MS - stamp + 32));
  }
  runningSticky = lastRunningAt !== 0 && stamp - lastRunningAt < RUN_GRACE_MS;
  // 最后一轮还没结束（官方没给它加 tail actions）→ 一定还在跑，哪怕此刻没有任何流式标记
  // （模型在两步之间、工具在跑、刚提交还没出字，这些空档都不该被当成"跑完"）
  const openLastTurn = collected.lastTurn !== null && !turnClosed(collected.lastTurn);
  const running = markRunning || runningSticky || openLastTurn;
  if (wasRunning && !running) settleToPrompt(flow);   // 刚跑完这一轮（「移到提问处」在这里排一次）
  wasRunning = running;

  busyWork = false;
  closeBudget = 2;
  const tC = performance.now();
  const bodies = flow.querySelectorAll(BODY_ANY);   // 一次遍历供三处共用
  // 只读一遍：所有"要动高度"的正文在这里量完（读一个写一个是重排放大器，一次扫描只该有一遍布局）
  const heights = new Map();
  const wantReveal = state.animations !== false && allowAnim;
  for (const body of bodies) {
    if (body.getAttribute("hidden") === SKIP) continue;                      // 为搜索藏起的正文不渲染，量了也是 0
    if (body.matches(THINK_BODY)) {
      if (body.dataset.dshsfWindow !== "reasoning") heights.set(body, body.getBoundingClientRect().height);
    } else if (wantReveal && body.dataset.dshsfReveal !== "1" && body.dataset.dshsfNoReveal !== "1" && body.dataset.dshsfClosing !== "1") {
      heights.set(body, body.getBoundingClientRect().height);
    }
  }
  pinRows = collected.rows.filter((el) => el.getAttribute("data-chat-flow-kind") === "user");   // 置顶条数据源：复用这份行快照，不再自己遍历一遍
  if (pinPick >= pinRows.length) pinPick = -1;
  cost.phases.collect = +(performance.now() - tC).toFixed(2);
  const turnKeys = Array.from(collected.turns.keys());
  hotRows = new WeakSet();
  for (const key of turnKeys.slice(-2)) for (const row of collected.turns.get(key)) hotRows.add(row);
  let t1 = performance.now();
  syncWindows(flow, running, collected, bodies, heights);
  cost.phases.windows = +(performance.now() - t1).toFixed(2);
  t1 = performance.now();
  syncTurns(flow, running, collected);
  cost.phases.turns = +(performance.now() - t1).toFixed(2);
  t1 = performance.now();
  syncTextWindows(flow, collected);
  cost.phases.text = +(performance.now() - t1).toFixed(2);
  t1 = performance.now();
  syncContextRows(flow, bodies, heights);
  cost.phases.ctx = +(performance.now() - t1).toFixed(2);
  const ms = performance.now() - t0;
  cost.lastMs = +ms.toFixed(2);
  cost.scanMs += ms;
  scanSamples.push(ms);
  if (scanSamples.length > SCAN_SAMPLES) scanSamples.shift();
  if (ms > cost.maxMs) {
    cost.maxMs = +ms.toFixed(2);
    // 记住最贵那一次：分阶段 + 调用次数 + 当时的 DOM 规模（判断"是不是那一刻 DOM 特别大"）
    cost.worst = {
      ms: cost.lastMs,
      phases: { ...cost.phases },
      top: topPhases(cost.phases),
      counts: { ...cost.counts, layouts: layoutReads },
      dom: { rows: collected.rows.length, bodies: bodies.length, nodes: flow.getElementsByTagName("*").length },
    };
  }
  syncNativeRow();
}
function scan() {
  lastScan = performance.now();
  scanStructure();
  anchorSync();          // 扫描刚改过布局：同一个任务里把被点行补回去，别等到绘制之后
  ensureTickLoop();
}
function schedule() {
  if (disposed || scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const now = performance.now();
    const wait = SCAN_INTERVAL - (now - lastScan);
    if (disposed) return;
    if (wait <= 0) { lastScan = now; scanStructure(); }
    else scanTimer = setTimeout(schedule, wait);         // 被节流挡下的这次变化，到点补扫一遍（别丢）
    if (busyWork) scanTimer = setTimeout(schedule, SCAN_INTERVAL);   // 还有没做完的展开/收起，继续排队
    ensureTickLoop();                                    // 跟随统一走帧循环，一帧只推进一次
  });
}
function rowsReport() {
  const flow = chatScope();
  const { turns, lastTurn, runningTurn } = collectTurns();
  const mark = flow.querySelector(RUNNING);
  return {
    mode: state.mode,
    runningMark: mark === null ? null : (mark.getAttribute("data-state") || "streaming"),
    runningTurn,
    lastTurn,
    lastTurnClosed: turnClosed(lastTurn),
    tailNodes: flow.querySelectorAll("[data-turn-tail]").length,   // 官方收尾标记节点数（本会话，≥2 轮时不该是 0）
    turns: [...turns.entries()].slice(-6).map(([turn, list]) => ({
      turn,
      rows: list.length,
      kinds: list.map((r) => rowKind(r)).join(","),
      folded: list.filter((r) => r.hasAttribute("data-dshsf-folded")).length,
    })),
    rows: chatRows().slice(-14).map((r) => ({
      kind: rowKind(r),
      turn: r.getAttribute("data-chat-turn"),
      part: r.getAttribute("data-chat-group-part"),
      row: r.hasAttribute("data-dshsf-row") ? 1 : 0,
      folded: r.hasAttribute("data-dshsf-folded") ? 1 : 0,
      think: r.querySelectorAll(THINK).length,
      tool: r.querySelectorAll(TOOL_CARD).length,
      body: r.querySelectorAll(BODY_ANY).length,
      h: Math.round(r.getBoundingClientRect().height),
    })),
  };
}
function stats() {
  const flow = chatScope();
  const { turns, lastTurn } = collectTurns();
  const lastRows = turns.get(lastTurn) || [];
  return {
    mode: state.mode,
    running: flow.querySelector(RUNNING) !== null,
    lastTurn,
    windows: document.querySelectorAll('[data-dshsf-window="reasoning"]').length,
    folded: document.querySelectorAll("[data-dshsf-folded]").length,
    foldedLastTurn: lastRows.filter((row) => row.hasAttribute("data-dshsf-folded")).length,
    openThink: document.querySelectorAll(THINK + " " + THINK_BODY).length,
    chips: document.querySelectorAll("[data-dshsf-chip]").length,
    anim: document.documentElement.hasAttribute("data-dshsf-anim") ? 1 : 0,
  };
}
/** 被祖先裁掉后真正露出的高度（视口外也为 0）：折叠行/官方 hidden 里的思考行不算"看得见"。 */
function visibleHeight(el) {
  const rect = el.getBoundingClientRect();
  let top = rect.top, bottom = rect.bottom;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || node.hasAttribute("hidden")) return 0;
    if (style.overflowY !== "visible" || style.overflowX !== "visible") {
      const box = node.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  return Math.max(0, bottom - top);
}
function probe() {
  const flow = chatScope();
  const { rows, turns, lastTurn } = collectTurns();
  if (rows.length === 0) return { error: "no chat rows found" };
  const answerRows = new Set();
  for (const turnRows of turns.values()) {
    const asst = turnRows.filter((row) => rowKind(row) === "assistant-step");
    if (asst.length) answerRows.add(asst[asst.length - 1]);
  }
  const style = document.querySelector("style[data-plugin-css='" + STYLE_ID + "']");
  const wrap = document.querySelector("[data-dshsf-reveal]") || document.querySelector("[class*='_bodyWrap']");
  const css = wrap ? getComputedStyle(wrap) : null;
  return {
    rows: rows.length,
    lastTurn,
    runningMark: flow.querySelector(RUNNING) ? "yes" : "no",
    officialView: nativeValue,          // 折叠模式下应为官方「不折叠」档（旧内核 normal，0.1.7 起 verbose），不能是 compact
    // 回底按钮自检：n=我方注入的按钮数、vis=当前可见数，detail=每个小窗的状态
    jumps: {
      n: document.querySelectorAll("[data-dshsf-jump]").length,
      vis: document.querySelectorAll("[data-dshsf-jump][data-dshsf-visible]").length,
      detail: Array.from(liveWindows).slice(0, 5).map((el) => ({
        kind: el.dataset.dshsfWindow || el.dataset.dshsfTextwindow || "?",
        has: el.querySelector(":scope > [data-dshsf-jump]") ? 1 : 0,
        sub: el.querySelectorAll("[data-dshsf-jump]").length,
        gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
        follow: el.dataset.dshsfFollow === "1" ? 1 : 0,
        vis: el.querySelector(":scope > [data-dshsf-jump][data-dshsf-visible]") ? 1 : 0,
      })),
    },
    perf: { ticks: tickCount, announces: announceCount },   // 帧循环次数 / 补发 scroll 次数
    // 我们自己的 JS 成本：帧循环平均每帧多少毫秒、结构扫描平均每次多少毫秒（不含浏览器布局/绘制）
    cost: {
      frames: cost.frames,
      tickAvgMs: +(cost.tickMs / Math.max(1, cost.frames)).toFixed(3),
      scans: cost.scans,
      scanAvgMs: +(cost.scanMs / Math.max(1, cost.scans)).toFixed(2),   // 含加载时那一次全量折叠，会被它拉高
      scanLastMs: cost.lastMs,                                          // 最近一次扫描
      scanMaxMs: cost.maxMs,                                            // 最差的一次（样本少/远程桌面下不可信：线程被挂起也算进来）
      pinAvgMs: +(cost.pinMs / Math.max(1, cost.pinFrames)).toFixed(4),   // 置顶条每帧成本（常态应≈几微秒）
      scanP50: percentile(scanSamples, 0.5),                            // ← 看这个：我们自己的典型成本
      scanP90: percentile(scanSamples, 0.9),
      samples: scanSamples.length,
      phases: cost.phases,                                              // 最近一次扫描的分阶段耗时
      top: topPhases(cost.phases),                                      // 同上，但按耗时排序取前 5（一眼看贵在哪）
      counts: cost.counts,                                              // 最近一次扫描里的真实调用次数
      worst: cost.worst,                                                // 最差那一次：分阶段 + 调用次数 + 当时 DOM 规模
      lastError: cost.lastError,                                        // 扫描里抛过什么错（没抛是 null）
    },
    skipped: document.querySelectorAll('[hidden="until-found"]').length,   // 已跳过渲染的折叠行（应能 Ctrl+F 搜到）
    searchBodies: document.querySelectorAll("[data-dshsf-search]").length, // 为搜索而挂载并藏起的思考正文数
    heapMb: (() => { const m = performance.memory; return m ? Math.round(m.usedJSHeapSize / 1048576) : null; })(),
    // 主窗口贴底自检：on=是否跟随、gap=离底像素、intentAgo=最近一次读者输入距今毫秒
    mainFollow: (() => {
      const el = mainScroller();
      if (!el) return null;
      return { on: followOn, gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), intentAgo: Math.round(performance.now() - scrollIntentAt), height: followHeight, wrote: followWrote === null ? null : Math.round(followWrote), steals: stealCount, undo: undoCount, undoRO: guardCount, moves: moveCount, stealMax, stealTail, blocked: snapBlocked, flips: followFlips.slice(-6),
        officialJump: document.querySelector("[class*='_toBottomSlot']") === null ? 0 : 1,   // 官方那颗在不在 DOM（由官方 state 决定）
        jumpGate: document.documentElement.hasAttribute("data-dshsf-jumpgate") ? 1 : 0,            // 我们的放行开关（= 我们判定该显示）
        pin: pinBar !== null && pinBar.hasAttribute("data-dshsf-visible") ? 1 : 0,
        pinTurn: pinRow === null ? null : pinRow.getAttribute("data-chat-turn"),
        settle: glide === null ? null : { top: Math.round(viewTop(el, glide.el) - SETTLE_PAD), left: Math.round(Math.max(0, viewTop(el, glide.el) - SETTLE_PAD) - el.scrollTop) } };
    })(),
    keepText: state.keepInterleavedText !== false ? 1 : 0,
    textWindows: document.querySelectorAll("[data-dshsf-textwindow]").length,
    ctxBodies: document.querySelectorAll(CTX_BODY).length,
    // 各轮所有"带正文"的行：answer=1 是答案行（设计上不套窗）；wins 是套上的正文窗数
    textRows: rows.filter((row) => rowKind(row) === "assistant-step" && hasText(row)).slice(-12).map((row) => ({
      turn: row.getAttribute("data-chat-turn"),
      answer: answerRows.has(row) ? 1 : 0,
      folded: row.hasAttribute("data-dshsf-folded") ? 1 : 0,
      wins: row.querySelectorAll("[data-dshsf-textwindow]").length,
      len: rowText(assistantBody(row) || row).length,
    })),
    // 非 assistant-step 却带文字的行（若穿插正文挂在这类行上，这里会露出来）
    otherTextKinds: rows.reduce((acc, row) => {
      if (rowKind(row) === "assistant-step") return acc;
      const text = rowText(row);
      if (text === "") return acc;
      const key = rowKind(row) || "?";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    // 结构快照：正文到底挂在哪一层（最后 6 行）
    shapes: rows.slice(-6).map((row) => {
      const body = assistantBody(row);
      return {
        kind: rowKind(row),
        body: body ? (body.className || body.tagName) : null,
        kids: body ? Array.from(body.children).map((el) => (el.className || el.tagName) + "|" + (el.textContent || "").trim().length + (el.querySelector && el.querySelector(THINK) ? "*t" : "")) : [],
      };
    }),
    // 「还看得见一个思考」时看这里：每一行都是一个已挂载的思考正文，附上没被收掉的原因
    openThinks: Array.from(flow.querySelectorAll(THINK + " " + THINK_BODY)).map((body) => {
      const root = body.closest(THINK);
      const row = body.closest(ROW);
      return {
        turn: row && row.getAttribute("data-chat-turn"),
        kind: row && rowKind(row),
        rowFolded: row && row.hasAttribute("data-dshsf-folded") ? 1 : 0,
        thinkFolded: root && root.hasAttribute("data-dshsf-folded") ? 1 : 0,
        keepOpen: root && root.dataset.dshsfKeepOpen === "1" ? 1 : 0,
        officialHidden: root && root.closest("[hidden]") ? 1 : 0,
        h: Math.round(body.getBoundingClientRect().height),
      };
    }),
    // 「还看得见一行思考」看这里：折叠后应该是 []（摘要行与展开正文都算，被折叠行裁掉的不算）
    visibleThinks: Array.from(flow.querySelectorAll(THINK)).map((root) => {
      const row = root.closest(ROW);
      return {
        vis: Math.round(visibleHeight(root)),
        h: Math.round(root.getBoundingClientRect().height),
        turn: row && row.getAttribute("data-chat-turn"),
        kind: row && rowKind(row),
        expanded: root.hasAttribute("data-expanded") ? 1 : 0,
        rowFolded: row && row.hasAttribute("data-dshsf-folded") ? 1 : 0,
        thinkFolded: root.hasAttribute("data-dshsf-folded") ? 1 : 0,
        keepOpen: root.dataset.dshsfKeepOpen === "1" ? 1 : 0,
        officialHidden: root.closest("[hidden]") ? 1 : 0,
        officialInline: root.closest("[data-turn-process-inline]") ? 1 : 0,
      };
    }).filter((item) => item.vis > 1),
    anim: {
      attr: document.documentElement.hasAttribute("data-dshsf-anim"),   // = 动效开关 && (交互或 4 秒后)
      lastReveal,
      lastWindow,          // 最近一次思考小窗：h=实测高度 cap=动画目标 now=40ms 时高度 anim=计算动画名
      setting: state.animations !== false,
      allowAnim,
      styleTag: style !== null,
      currentCss: style !== null && style.textContent.indexOf("dshsf-body-in") >= 0,
      reveals: document.querySelectorAll("[data-dshsf-reveal]").length,
      bodyWraps: document.querySelectorAll("[class*='_bodyWrap']").length,
      wrapClass: wrap ? wrap.className : null,
      wrapAnim: css ? css.animationName + " / " + css.animationDuration : null,
    },
    sparks: sparks.stats(),
    sample: rows.slice(-10).map((row) => ({
      kind: rowKind(row),
      turn: row.getAttribute("data-chat-turn"),
      think: row.querySelectorAll(THINK).length,
      thinkBody: row.querySelectorAll(THINK_BODY).length,
      text: hasText(row) ? 1 : 0,
      textWin: row.querySelectorAll("[data-dshsf-textwindow]").length,
      folded: row.hasAttribute("data-dshsf-folded") ? 1 : 0,
      hidden: row.hasAttribute("hidden") ? 1 : 0,
    })),
  };
}
function startController() {
  // 热重载/重复注入时，上一个实例可能还活着（disposer 没被调到）——那样按钮、帧循环、画布都会翻倍。
  // 先把上一个实例收掉，保证同一时刻只有一个控制器在前台。
  try { const prev = window.__dshStreamfold; if (prev && typeof prev.dispose === "function") prev.dispose(); } catch { /* ignore */ }
  // disposed 是模块级的：同一个模块被二次 apply（重复注入/双 fiber）时，上面那句 prev.dispose()
  // 会把新实例一起判死（scan/schedule/帧循环全部早退）——这里必须复位。
  disposed = false;
  ticking = false;
  for (const old of document.querySelectorAll("[data-dshsf-pin]")) { try { old.remove(); } catch { /* ignore */ } }        // 同上：置顶条只留本实例那一个
  sparks.setOptions({ on: state.sparks !== false, color: state.sparkColor, density: state.sparkDensity, forge: state.forgeSparks !== false, forgeSpeed: state.forgeSpeed, forgeLife: state.forgeLife });   // localStorage 里的设置先落地（不等宿主）
  scan();
  // 开动效 = 标志位 + 立刻把 html[data-dshsf-anim] 置位（只改标志位要等下一次扫描，首次点开卡片常常赶不上）
  const wakeAnim = () => { if (!allowAnim) { allowAnim = true; rootVars(); } };
  const timer = setTimeout(wakeAnim, 4000);
  window.addEventListener("pointerdown", wakeAnim, { capture: true, passive: true });
  window.addEventListener("keydown", wakeAnim, true);
  // 读者滚动的输入信号（滚轮/触摸/翻页键）：贴底跟随只认这些，布局变化不取消跟随
  for (const type of ["wheel", "touchstart", "touchmove"]) window.addEventListener(type, noteScrollIntent, { capture: true, passive: true });
  window.addEventListener("keydown", noteScrollIntent, true);
  window.addEventListener("resize", ensureTickLoop, { passive: true });   // 视口一变：回底按钮该不该出现、置顶条摆哪儿都得重算
  // 用户自己点开工具卡时，React 提交后给"新出现的正文"补播揭示动画。
  // 不能按 [data-tool] 找：bash 卡由官方 BashRow 渲染，根上没有 data-tool，只能按正文类名认。
  const onUserActivate = (event) => {
    if (synthetic || !(event.target instanceof Element)) return;
    const flow = chatScope();
    if (!flow.contains(event.target)) return;                // 点的不在对话流里（侧栏/设置）→ 不扫
    if (event.target.closest(TOOL_BODY)) return;            // 点的是正文内部（复制/选字/开文件），不是展开动作
    // 展开/收起 = 我准备读这一处：先撒手（这一步必须赶在 React 提交之前，否则跟随先把它拖到底部），
    // 再把被点的行钉在原来的屏幕位置，覆盖整段动画。
    const toggle = event.target.closest(TOGGLE);
    if (toggle) {
      const anchorEl = toggle.closest(ROW) || toggle;
      const thinkRoot = toggle.closest(THINK);
      const prepped = thinkRoot !== null && thinkRoot.querySelector("[data-dshsf-search]") !== null;
      clearSearchHidden(thinkRoot || anchorEl);
      if (prepped) { event.preventDefault(); event.stopPropagation(); }   // 放行 = 官方收起 = 正文被卸载，搜索又白做
      followOn = false;
      anchorDuring(anchorEl, anchorEl.getBoundingClientRect().top, 500);
      queueMicrotask(anchorSync);      // React 在同一个 click 里提交，微任务阶段补一次（仍在绘制之前）
    }
    const before = new Set(flow.querySelectorAll("[class*='_bodyWrap']"));
    const beforeCtx = new Set(flow.querySelectorAll(CTX_BODY));
    requestAnimationFrame(() => {                       // rAF 在 paint 之前，避免先闪一帧原始样子
      for (const body of flow.querySelectorAll("[class*='_bodyWrap']")) if (!before.has(body)) revealBody(body);
      for (const body of flow.querySelectorAll(CTX_BODY)) if (!beforeCtx.has(body)) revealBody(body);
      for (const body of flow.querySelectorAll(THINK_BODY)) tagThinkWindow(body);
    });
  };
  const onUserKey = (event) => { if (event.key === "Enter" || event.key === " ") onUserActivate(event); };
  // Ctrl+F 搜到被折起来（content-visibility 跳过渲染）的内容时，浏览器在"即将滚到那一处"前派发 beforematch：
  // 在这里把那一轮瞬时展开——搜索照样能命中，折叠省下的布局也不用还回去。
  const onBeforeMatch = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const skipped = target && (target.closest('[hidden="until-found"]') || target.closest("[data-dshsf-folded]"));
    if (!skipped) return;
    const row = skipped.closest(ROW) || skipped;
    clearSearchHidden(row);                 // 命中：把"为搜索而藏"的正文亮出来
    const turn = row.getAttribute("data-chat-turn");
    if (turn) manualState.set(turn, "open");
    followOn = false;                       // 搜到哪就看哪，别被贴底拖回底部
    const prev = allowAnim;
    allowAnim = false;                      // 瞬时展开：高度动画会把"滚到匹配处"带偏
    try { scan(); } finally { allowAnim = prev; }
  };
  const onFindKey = (event) => { if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) searchPrep(); };
  document.addEventListener("click", onUserActivate, true);
  document.addEventListener("click", onToBottomClick, true);
  document.addEventListener("keydown", onUserKey, true);
  document.addEventListener("keydown", onFindKey, true);
  document.addEventListener("beforematch", onBeforeMatch, true);
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const unsubscribe = subscribe(schedule);
  const dispose = () => {
    disposed = true;
    ticking = false;
    if (rafId) { try { cancelAnimationFrame(rafId); } catch { /* ignore */ } rafId = 0; }
    clearTimeout(scanTimer);
    clearTimeout(runGraceTimer);
    liveWindows.clear();
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", wakeAnim, true);
    window.removeEventListener("keydown", wakeAnim, true);
    for (const type of ["wheel", "touchstart", "touchmove"]) window.removeEventListener(type, noteScrollIntent, true);
    window.removeEventListener("keydown", noteScrollIntent, true);
    window.removeEventListener("resize", ensureTickLoop);
    document.removeEventListener("click", onUserActivate, true);
    document.removeEventListener("click", onToBottomClick, true);
    document.removeEventListener("keydown", onUserKey, true);
    document.removeEventListener("keydown", onFindKey, true);
    document.removeEventListener("beforematch", onBeforeMatch, true);
    if (followScroller) { followScroller.removeEventListener("scroll", onMainScroll); followScroller = null; }
    try { if (guardRO && guardRO !== false) guardRO.disconnect(); } catch { /* ignore */ }
    guardRO = null; guardFlow = null; guardComposer = undefined;
    if (snapTaken !== null) { try { delete snapTaken.el.scrollTop; } catch { /* ignore */ } snapTaken = null; }
    document.documentElement.removeAttribute("data-dshsf-jumpgate");
    for (const old of document.querySelectorAll("[data-dshsf-mainjump]")) { try { old.remove(); } catch { /* ignore */ } }   // 旧版本自绘的容器：清掉
    if (pinBar !== null) { try { pinBar.remove(); } catch { /* ignore */ } pinBar = null; }
    pinRows = []; pinRow = null;
    if (observer) observer.disconnect();
    observer = null;
    // 把自己改过的 DOM 还原：样式表已随 styles effect 移除，折叠行会停在 hidden="until-found"
    // （不渲染）、折叠条成了没样式的死按钮 —— 关插件/卸载后只能刷新页面才恢复。
    try {
      unfoldAll(document);
      clearChips(document);
      for (const el of document.querySelectorAll("[data-dshsf-search]")) { el.removeAttribute("data-dshsf-search"); if (el.getAttribute("hidden") === SKIP) el.removeAttribute("hidden"); }
      for (const el of document.querySelectorAll("[data-dshsf-window], [data-dshsf-textwindow], [data-dshsf-answer-sep]")) {
        el.removeAttribute("data-dshsf-window"); el.removeAttribute("data-dshsf-textwindow"); el.removeAttribute("data-dshsf-answer-sep");
        el.style.maxHeight = ""; el.style.overflow = "";
      }
      for (const el of document.querySelectorAll("[data-dshsf-jump]")) { try { el.remove(); } catch { /* ignore */ } }
    } catch { /* ignore */ }
    sparks.reset();
    if (window.__dshStreamfold && window.__dshStreamfold.dispose === dispose) delete window.__dshStreamfold;
  };
  window.__dshStreamfold = { stats, rows: rowsReport, probe, scan, set: setSettings, get: snapshot, chooseDisplay, resetCost, state: () => ({ ...state, nativeValue }),
    fx: sparks, dispose };   // 调参/排障入口：__dshStreamfold.fx 可实时调火花参数
  setTimeout(() => { try { console.info("[streamfold] ready", JSON.stringify(stats())); } catch { /* ignore */ } }, 2500);
  return dispose;
}

/* ------------------------------------------------------------ 设置 UI -- */
function Toggle(props) {
  return h("button", { type: "button", className: "dshsf-switch", role: "switch", "aria-checked": props.value ? "true" : "false", onClick: () => props.onChange(!props.value) });
}
function Row(props) {
  return h("div", { className: "dshsf-row" },
    h("div", { className: "dshsf-rowMain" },
      h("div", { className: "dshsf-rowTitle" }, props.title),
      props.desc ? h("div", { className: "dshsf-rowDesc" }, props.desc) : null),
    props.children);
}
function NumberInput(props) {
  return h("input", {
    className: "dshsf-num", type: "number", min: props.min, max: props.max, step: props.step || 1, value: props.value,
    onChange: (event) => { const next = Number(event.target.value); if (Number.isFinite(next)) props.onChange(next); },
  });
}
function Range(props) {
  const label = Number.isFinite(Number(props.value)) ? Number(props.value).toFixed(props.digits === undefined ? 1 : props.digits).replace(/\.0$/, "") : "";
  return h("div", { className: "dshsf-rangeWrap" },
    h("input", {
      className: "dshsf-range", type: "range", min: props.min, max: props.max, step: props.step || 0.1, value: props.value,
      onChange: (event) => { const next = Number(event.target.value); if (Number.isFinite(next)) props.onChange(next); },
    }),
    h("span", { className: "dshsf-rangeVal" }, label + (props.unit || "")));
}
/** 官方「工作步骤展示」那一行的下拉：官方四档 + 本插件的「折叠」，选中项与官方当前取值一致。 */
function Select(props) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return h("div", { className: "dshsf-select", ref: wrapRef },
    h("button", {
      type: "button", className: "dshsf-selectBtn", "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false",
      onClick: () => setOpen((was) => !was),
    }, h("span", null, props.options.find((o) => o.value === props.value)?.label ?? ""), h("span", { className: "dshsf-caret" }, "▾")),
    open ? h("div", { className: "dshsf-menu", role: "menu" }, props.options.map((option) =>
      h("button", {
        key: option.value, type: "button", role: "menuitemradio", "aria-checked": props.value === option.value ? "true" : "false",
        className: "dshsf-menuItem", "data-active": props.value === option.value ? "" : undefined,
        onClick: () => { setOpen(false); props.onChange(option.value); },
      }, option.label))) : null);
}
function DisplayRow() {
  const [choice, setChoice] = React.useState(displayChoice);
  React.useEffect(() => subscribe(() => setChoice(displayChoice())), []);
  React.useEffect(() => {
    if (!nativeScope) return undefined;
    try { return nativeScope.subscribe(() => setChoice(displayChoice())); } catch { return undefined; }
  }, []);
  const options = NATIVE_MODES.map((mode) => ({ value: mode, label: modeLabel(mode) })).concat([{ value: "fold", label: modeLabel("fold") }]);
  return h(Row, { title: "工作步骤展示", desc: "选择希望看到多少工具调用细节；「折叠」是「流式折叠」提供的模式（运行中的一轮看小窗，其余全折，折叠时官方停在完全展开）" },
    h(Select, { value: choice, options, onChange: (value) => { chooseDisplay(value); setChoice(displayChoice()); } }));
}
function SettingsPage() {
  const s = useSettings();
  return h("div", { className: "dshsf-page" },
    h("div", { className: "dshsf-intro" }, "折叠模式：正在跑的一轮里思考与工具进限高小窗，其余轮次全量折叠；展开某轮时思考保持一行摘要。" ),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "折叠历史轮次", desc: "关闭后：加载页面不再自动折叠历史轮次（只在跑动时折前面的）" },
        h(Toggle, { value: s.foldHistory !== false, onChange: (v) => setSettings({ foldHistory: v }) })),
      h(Row, { title: "保留穿插正文", desc: "折叠时保留带正文的行，并给它套一个限高小窗（正式回答本身不套窗）" },
        h(Toggle, { value: s.keepInterleavedText !== false, onChange: (v) => setSettings({ keepInterleavedText: v }) }))),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "窗口高度", desc: "单个思考/穿插正文小窗的最大高度（px）" },
        h(NumberInput, { value: s.windowHeight, min: 80, max: 1200, onChange: (v) => setSettings({ windowHeight: v }) })),
      h(Row, { title: "运行中自动展开思考", desc: "只自动展开本轮最新的那一个；被取代的旧窗按下面的宽限折回一行摘要" },
        h(Toggle, { value: s.autoExpandReasoning !== false, onChange: (v) => setSettings({ autoExpandReasoning: v }) })),
      h(Row, { title: "旧窗折叠宽限", desc: "运行中新的思考窗出现后，旧窗再等多久才自动折回（秒）" },
        h(NumberInput, { value: s.supersedeDelay, min: 0, max: 60, step: 0.5, onChange: (v) => setSettings({ supersedeDelay: v }) })),
      h(Row, { title: "运行中自动展开工具", desc: "开：运行中最新的工具卡自动展开（用官方卡片自己的折叠/内滚，不套我们的限高窗）" },
        h(Toggle, { value: s.autoExpandTools !== false, onChange: (v) => setSettings({ autoExpandTools: v }) }))),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "触底自动跟随", desc: "内容增长时自动贴底；你上滚即停跟" },
        h(Toggle, { value: s.autoFollow !== false, onChange: (v) => setSettings({ autoFollow: v }) })),
      h(Row, { title: "平滑系数", desc: "跟随底部时每帧吃掉多少差距，越小越柔（默认 0.15）" },
        h(NumberInput, { value: s.smoothGrow, min: 0.05, max: 0.9, step: 0.05, onChange: (v) => setSettings({ smoothGrow: v }) })),
      h(Row, { title: "平滑最小步长", desc: "每 16ms 至少推进多少像素（与屏幕刷新率无关）" },
        h(NumberInput, { value: s.smoothMin, min: 0, max: 12, step: 1, onChange: (v) => setSettings({ smoothMin: v }) })),
      h(Row, { title: "离底显示「回到底部」" }, h(Toggle, { value: s.showJumpButton !== false, onChange: (v) => setSettings({ showJumpButton: v }) })),
      h(Row, { title: "跑完回到提问处", desc: "一轮结束后平滑移到本轮你那句话的位置；你已经自己上滚过就不动你。动效过渡关掉时直接到位" },
        h(Toggle, { value: s.settleToPrompt !== false, onChange: (v) => setSettings({ settleToPrompt: v }) })),
      h(Row, { title: "置顶显示提问", desc: "把「你正在看的那一轮」的提问钉在会话顶端，往上滚动会跟着换成那一轮（超过一行只显示一行）；它自己在视口里时自动让位，点它滑回那句话" },
        h(Toggle, { value: s.pinPrompt !== false, onChange: (v) => setSettings({ pinPrompt: v }) })),
      h(Row, { title: "动效过渡" }, h(Toggle, { value: s.animations !== false, onChange: (v) => setSettings({ animations: v }) }))),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "小窗火花", desc: "运行中思考小窗底部溅起火星（像滚筒碾过金属）；关闭即完全不运行" },
        h(Toggle, { value: s.sparks !== false, onChange: (v) => setSettings({ sparks: v }) })),
      h(Row, { title: "火花颜色", desc: "默认冷蓝；火星核心自动提亮成白热" },
        h("input", { type: "color", className: "dshsf-color", value: s.sparkColor || "#4fa8ff", onChange: (e) => setSettings({ sparkColor: e.target.value }) })),
      h(Row, { title: "正文锻打火花", desc: "流式正文每写一段，就从写头（最后一行末尾）砸出一扇火星；停顿不写就不砸" },
        h(Toggle, { value: s.forgeSparks !== false, onChange: (v) => setSettings({ forgeSparks: v }) })),
      h(Row, { title: "锻打火花速度", desc: "火星飘出去的速度倍率（0.2~4，默认 1）" },
        h(Range, { value: s.forgeSpeed === undefined ? 1 : s.forgeSpeed, min: 0.2, max: 4, step: 0.1, unit: "×", onChange: (v) => setSettings({ forgeSpeed: v }) })),
      h(Row, { title: "锻打火花寿命", desc: "单颗火星活多久（0.2~5 秒，默认 1.3；实际在 ±30% 内随机）" },
        h(Range, { value: s.forgeLife === undefined ? 1.3 : s.forgeLife, min: 0.2, max: 5, step: 0.1, unit: "s", onChange: (v) => setSettings({ forgeLife: v }) })),
      h(Row, { title: "火花密度", desc: "火星数量倍率（0.2~3）：越高越密，绘制开销也越大" },
        h(Range, { value: s.sparkDensity, min: 0.2, max: 3, step: 0.1, unit: "×", onChange: (v) => setSettings({ sparkDensity: v }) }))),
    h("div", { className: "dshsf-actions" },
      h("button", { type: "button", className: "dshsf-btn", onClick: () => setSettings({ ...DEFAULTS }) }, "恢复默认")));
}

/* ------------------------------------------------------------- apply -- */
/** 客户端 fiber 一旦 failed，GUI 只显示一行 `dsh-streamfold: failed`，原始错误既不进页面也不进控制台
 *  （2026-09-25 就因为这个多花了一整轮才定位到 rowsReport 引用错误）——所以这里自己把错误打出来。 */
function guardStart(label, start) {
  try { return start(); }
  catch (error) { console.error("[streamfold] client half failed: " + label, error); throw error; }
}
function apply(ctx) {
  ctx.effect(() => guardStart("styles", injectStyles), "dsh-streamfold: styles");
  ctx.effect(() => guardStart("controller", startController), "dsh-streamfold: controller");
  // 档位名沿用官方 chat 词典，下拉文案与官方设置页一致（取不到就退回内置中文）
  ctx.inject(["locale"], (cctx) => {
    try { tChat = cctx.locale.bind("chat"); } catch { /* ignore */ }
  });
  // 官方的对话显示档位由设置服务托管：0.1.7 起是 configForms（按 profile 条目 id 取 section），
  // 旧内核的 settingsScope 已不存在 —— 这里用可选注入，服务到位才接，插件本身不因它缺席而卡住。
  ctx.inject(["configForms"], (cctx) => {
    try {
      nativeScope = cctx.configForms.get(NATIVE_NS);
      const adopt = () => {
        const section = nativeScope.getSnapshot();
        const raw = section && section.value ? section.value[NATIVE_FIELD] : undefined;
        const mode = NATIVE_ALIAS[raw] || raw;
        if (NATIVE_MODES.includes(mode)) nativeValue = mode;
      };
      adopt();
      enforceNativeBaseline().then(schedule, () => {});
      nativeScope.subscribe(() => { adopt(); enforceNativeBaseline(); schedule(); });
    } catch (error) { console.warn("[streamfold] native settings scope unavailable", error); }
  });
  if (ctx.slots) {
    ctx.slots.inject("settings.general.item", () => ctx.slots.register({ name: "settings.general.item", id: "streamfold", order: 12 }, DisplayRow));
    ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "streamfold", order: 42, label: () => "流式折叠" }, SettingsPage));
  }
}
exports.apply = apply;
exports.inject = ["slots"];
exports.defaults = DEFAULTS;
return module.exports; } });
