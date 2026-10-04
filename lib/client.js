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
  mode: "fold",               // fold = 本插件（用户裁决：默认折叠）；native = 官方标准/紧凑
  foldHistory: true,
  keepInterleavedText: true,  // 折叠时保留"穿插正文"行（只有正文，不含思考）—— 默认值按用户当前设置固化（2026-10-04）
  keepUserQuestions: true,    // LLM 提问工具卡(ask_user_question)及其回复节点(question-reply)不折；关掉则随其余内容一起折叠
  windowHeight: 360,          // 默认值按用户当前设置固化（2026-10-04）
  followMaxSpeed: 240,        // 跟随"追赶"速度上限（px/s）；默认值按用户当前设置固化（2026-10-04）
  followMaxAccel: 10000,      // 跟随加速度上限（px/s²）；默认值按用户当前设置固化（2026-10-04）
  returnToTail: true,         // 停在中途（我方无目标）时：出现你新发的一条消息 ⇒ 滑回尾部；关掉则一律停在原地
  showJumpButton: true,
  animations: true,
  autoExpandReasoning: true,   // 运行中的那一轮自动展开思考
  autoExpandTools: false,      // 运行中的那一轮自动展开工具（默认不展开：工具卡自己点）
  settleToPrompt: true,        // 一轮跑完后平滑移到本轮提问处（读者已接管滚动时不动）
  pinPrompt: true,             // 置顶显示提问：跟着"正在看的那一轮"换，超过一行只显示一行
  smoothGrow: 0.15,            // 跟随底部时每帧吃掉多少差距（越小越柔）
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
/** 折叠模式必须让官方「别自己折」：0.1.7 的四档里只有 verbose 是 foldCompletedTurns=false + stepGrouping=none
 *  （= 完全展开），其余三档官方自己就会折叠或分组，会和我们的折叠双重生效。
 *  镜像没就绪时不写、也不落定 —— 订阅回调会再来一次。 */
async function enforceNativeBaseline() {
  if (nativePinned || nativeProbing || state.mode !== "fold" || !nativeScope) return;
  const section = nativeScope.getSnapshot();
  if (!section || section.status !== "ready") return;
  nativeProbing = true;
  try {
    const value = section.value ? section.value[NATIVE_FIELD] : undefined;
    if (value !== "verbose") { try { await nativeScope.set(NATIVE_FIELD, "verbose"); } catch { /* ignore */ } }
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
  /* T9：官方「工作步骤展示」行只在我们的行渲染成功时隐藏（可逆；只改可见性，不改其文字/属性/菜单） */
  "[data-dshsf-hide-official]{display:none!important}",
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
  /* 层级契约（2026-10-01 真机取证）：画布挂在 body 的 fixed 层，与官方界面同处根堆叠上下文，只看 z-index。
     官方 composer 座位 z-index:7、设置弹窗遮罩 z-index:1000 —— 旧值 9999 把两者都盖住。火星只是正文的装饰，
     必须待在「正文之上、界面之下」：取 6，正好压 composer 座位（7）下面一档。别再往上抬。 */
  "[data-dshsf-spark]{position:fixed;left:0;top:0;display:block;pointer-events:none;z-index:6;will-change:transform}",   // 固定层：位置由 JS 每帧摆；层级见上
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
/** task-30：官方档位 = **完全放手**：清我方全部内联视觉痕迹（小窗正文限高/变量/数据集、根变量、残余标记、按钮），
 *  可逆 —— 切回「折叠」时 rootVars()/tagThinkWindow()/syncWindows() 会重新施加。不隐藏任何官方节点（含官方行）。 */
function releaseOurVisuals() {
  const targets = document.querySelectorAll("[data-dshsf-window], [data-dshsf-textwindow]");
  for (const el of targets) {
    try {
      el.style.maxHeight = "";
      el.style.removeProperty("--dshsf-hw");
      el.style.overflow = "";
    } catch { /* ignore */ }
    try { delete el.dataset.dshsfH; delete el.dataset.dshsfClosing; } catch { /* ignore */ }
    winH.delete(el);
    for (const attr of ["data-dshsf-window", "data-dshsf-textwindow", "data-dshsf-offbottom"]) el.removeAttribute(attr);
    const jump = el.querySelector(":scope > [data-dshsf-jump]");
    if (jump !== null) jump.removeAttribute("data-dshsf-visible");
  }
  // Ctrl+F 期间被我们藏起来的正文：只摘标记会把 hidden="until-found" 留在原地（内容永远看不见，且丢了归属标记）
  // —— 必须走和"搜索命中"同一条收回路径（摘标记 + 摘 hidden + 回到每帧清单）。
  clearSearchHidden(document);
  for (const el of document.querySelectorAll("[data-dshsf-answer-sep], [data-dshsf-row], [data-dshsf-chip]")) {
    for (const attr of ["data-dshsf-answer-sep", "data-dshsf-row", "data-dshsf-chip"]) el.removeAttribute(attr);
  }
  // 行级跳过标记（hidden="until-found"，认 data-dshsf-hidden 归属）与动画/收尾标记：切回折叠时不许留残余过渡。
  for (const el of document.querySelectorAll("[data-dshsf-hidden], [data-dshsf-reveal], [data-dshsf-closing]")) {
    clearSkipHidden(el);
    el.removeAttribute("data-dshsf-reveal");
    el.removeAttribute("data-dshsf-closing");
  }
  const root = document.getElementById("root") || document.documentElement;
  try { root.style.removeProperty("--dshsf-h"); } catch { /* ignore */ }
  document.documentElement.removeAttribute("data-dshsf-jumpgate");
  document.documentElement.removeAttribute("data-dshsf-anim");
  for (const el of document.querySelectorAll("[data-dshsf-jump]")) el.removeAttribute("data-dshsf-visible");
  hidePinBar();                      // 置顶条是固定层、不在 flow 里，之前只由 tick 的官方档门收——这里一并收干净
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
/** A1：主容器**内部**的嵌套滚动体（思考小窗 / 工具正文 / 上下文注入正文）—— 在它们上面的滚轮不是"主容器读者接管"的意图。 */
const NESTED_SCROLL = "[data-dshsf-window], [data-dshsf-textwindow], " + TOOL_BODY + ", " + CTX_BODY;
// 运行中的标记：思考行 data-state=running、正文 data-streaming、工具卡 data-state=running|preparing
// （工具执行期间没有流式文本，只靠前两个会误判成"跑完了" → 运行中来一次全量折叠）
const RUNNING = '[data-state="running"], [data-state="preparing"], [data-streaming]';
const RUN_GRACE_MS = 700;   // 运行标记消失多久才算真跑完（步骤/工具交接的空档不算）
let runningSticky = false;
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
let textCache = new WeakMap();   // 行 → 有没有正文：跨扫描保留；定向失效由 MutationObserver 负责（A8，见 startController）
let hotRows = new WeakSet();     // 运行中的轮 + 最近 3 轮：正文可能还在变 → 每次扫描重算
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
      const s = winOf(el);
      s.writer = "us";      // 我方导航：取回写权，绝不交出
      s.nav = true;         // 一次性回底：不设 cap，滑到窗尾后转为常规跟随
      ensureTickLoop();
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
/** 唯一允许"跟尾（触底吸附）"的小窗 = 本轮 running 的最新思考正文；null = 谁都不跟。
 *  来源与 sparks 焦点同源（syncWindows 的 newestThink），与 state.sparks 开关无关：
 *  被取代的旧窗 / 上一轮的窗 / 跑完的窗一律不跟、也不 win-snap——静态窗不为任何外部滚动回写。 */
let activeWindow = null;
const winH = new WeakMap();   // 上一帧实测窗高：want=null 的 CSS 过渡收缩没有 JS 写入，只能靠实测差补负 dh
/** 小窗的写权 + 速度状态（与主容器同一模型、同一个滑行律）：{ writer, nav, vFeed, vChase, prev }。
 *  小窗只有一个目标 = 窗尾，所以没有独立的 goal 量；点回底按钮那一次 nav=true（不设追赶上限）。 */
const winState = new WeakMap();
/** Ctrl+F 搜索期间小窗一律撒手（writer=reader、不贴底、不跟尾）；新登记/重挂载的窗也按读者态起步。
 *  浏览器不给"搜索关闭"事件 ⇒ 解除放在输入层：下一笔真实页面输入（滚轮/触摸/按键/点击）即视为回到页面。 */
let searchHold = false;
const winOf = (el) => { let s = winState.get(el); if (s === undefined) { s = { writer: searchHold ? "reader" : "us", nav: false, ...newVel() }; winState.set(el, s); } return s; };
const winAtFloor = (el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 0.5;
/** Ctrl+F：主容器与小窗一起撒手（搜索期间小窗零程序化写）。取回写权仍走既有入口：
 *  读者真实滚回窗尾 / 点该窗回底按钮 / 会话边界——不新造机制。 */
function releaseWindows() {
  searchHold = true;
  for (const el of liveWindows) { const s = winOf(el); s.writer = "reader"; s.nav = false; resetVel(s); }
}

function wireWindow(el) {
  ensureWindowJump(el);
  liveWindows.add(el);
  const fresh = !winState.has(el);   // 首次登记：只贴底一次（已展开/已登记的窗不二次重贴）
  const ws = winOf(el);              // 空闲值显式：新窗 = 我方跟尾（搜索期间 = 读者态）
  if (searchHold) { ws.writer = "reader"; ws.nav = false; resetVel(ws); }   // 搜索期间接线/重挂载：读者态起步，不贴底
  if (fresh && el.scrollHeight > el.clientHeight) {
    if (!searchHold && el === activeWindow) {   // 只给活动窗贴底：搜索闩置位、或不是本轮在跑的那个窗，都不 win-snap
      const floor = el.scrollHeight - el.clientHeight;
      writeTop(el, floor, undefined, "win-snap");   // 首帧直接贴底（不走滑行：5000px 正文不该从顶部爬 10s；仍走唯一写点）
      ws.prev = floor;                 // 前馈别把这“跳”当成目标速度
      ws.wantS = floor;                // 小窗跟随低通状态也从窗尾起算
    }
  }
  if (wired.has(el)) return;
  wired.add(el);
  const toReader = () => { const s = winOf(el); s.writer = "reader"; s.nav = false; searchHold = false; };   // 真实输入 ⇒ 交出这个窗的写权（无时间窗）+ 解除搜索闩（用户回到页面）
  for (const type of ["wheel", "touchstart", "touchmove"]) el.addEventListener(type, toReader, { passive: true });
  el.addEventListener("pointerdown", (event) => { if (event.target === el) toReader(); }, { passive: true });
  el.addEventListener("scroll", () => {
    ensureTickLoop();   // 收敛后帧循环是停的：读者一滚就得排一帧，否则按钮要等下一次 DOM 变化才冒出来
    // 位置落到窗尾 ⇒ 取回写权、目标=尾（与主容器规则 4 同一条）
    if (!searchHold && winOf(el).writer !== "us" && winAtFloor(el)) winOf(el).writer = "us";   // 搜索闩置位时几何不算读者意图（浏览器 find 落在窗尾也是几何；取回只认真实输入）
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
const WIN_TAU_MS = 150;  // 小窗跟随目标的一阶低通常量：与主容器 TAIL_TAU_MS 同值（用户要求小窗与主窗口手感一致；小窗只有 ~260px 高，滞后会比主窗口更显眼）
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const smoothGrow = () => Math.min(0.9, Math.max(0.05, num(state.smoothGrow, 0.25)));   // 每帧吃掉的差距比例
/** 时间常数（τ_smooth）：校准到「60Hz 单帧推进 = 旧线性式在 60Hz 的推进」。K = state.smoothGrow（DEFAULTS 0.15，函数里的 0.25 只是缺值兜底）
 *  ⇒ 默认 tau = -16.667 / ln(1 - 0.15·16.667/16) ≈ **98.0973ms**（实测每帧 alpha 0.1562、稳态 gap = v·tau）。 */
const smoothTau = () => -16.667 / Math.log(1 - Math.min(0.9, smoothGrow() * 16.667 / 16));
/** 指数律的精确单帧位移：dy·(1−e^(−dt/τ))——任意 dt 序列下 gap(T)=gap0·e^(−T/τ)，与刷新率/帧数无关（不再有 minStep 下限）。 */
const expStep = (dy, dt) => dy * (1 - Math.exp(-dt / smoothTau()));
const FEED_TAU = 150;   // 前馈 EMA 时间常数（ms）："目标自身速度"的慢估计
/** 每写者一份速度状态：vFeed=前馈（目标自己在长的速度，不夹上限）；vChase=追赶速度（受加速度与速度上限约束）。
 *  唯一状态量；换目标/重开帧循环必须 resetVel()。 */
const newVel = () => ({ vFeed: 0, vChase: 0, prev: null });
const resetVel = (st) => { st.vFeed = 0; st.vChase = 0; st.prev = null; };
/**
 * **唯一滑行律**（主容器跟随 / 一次性导航 / 小窗跟随·回底共用）。每帧重算目标 want。
 *   ① 前馈 vFeed = 目标自身速度的慢 EMA（clamp ≥0，不吃 vMax：内容是自己在长，我们的义务是跟上）
 *   ② 追赶 vWant = 指数律精确复合 /(dt/1000)；③ 加速度受限；④ vMax 只夹追赶那一段；v = vFeed + vChase
 *   ⑤ |dy|≤0.5 精确落点并清零 vChase。vMax<=0 = 不设追赶上限（一次性导航）。
 *  退化性：a→∞ 且 vFeed=0 ⇒ step = min(vMax·dt/1000, 指数律)（旧律）。
 *  返回是否还在动。写点唯一：writeTop。
 */
function slide(el, want, dt, vMax, st, curHint, tag, maxHint) {
  const t = tag || "slide";
  const cur = curHint === undefined ? el.scrollTop : curHint;   // task-22：调用方已知（计划里读过）就别再读一次
  const curPx = snapPx(cur), wantPx = snapPx(want);
  if (curPx === wantPx) {                          // ⑤ 到位（物理像素意义）：不留亚像素残差，也不继续排帧
    st.vChase = 0; st.prev = want;
    return false;
  }
  const dtS = dt / 1000;
  if (Math.abs(wantPx - curPx) <= 1 / pxDpr() + 1e-9) {   // 目标像素最多差一格：直接落到目标像素（否则速度永远凑不出一步 ⇒ 180 帧卡死）
    st.vChase = 0; st.prev = want;
    writeTop(el, wantPx, cur, t);
    return false;
  }
  const dy = want - cur;
  if (Math.abs(dy) <= 0.5) {                       // ⑤ 精确落点：不留残差
    if (dy !== 0) writeTop(el, want, cur, t);
    st.vChase = 0;
    st.prev = want;
    return false;
  }
  if (st.prev === null) st.vFeed = 0;              // 目标刚换人：前馈从 0 起（不携带陈旧速度）
  else st.vFeed += (Math.max(0, (want - st.prev) / dtS) - st.vFeed) * (1 - Math.exp(-dt / FEED_TAU));
  st.prev = want;
  const vWant = expStep(dy, dt) / dtS;             // ② 指数律的精确复合（不是线性式）
  const dv = accelValue() * dtS;                   // ③ 加速度受限（dt 归一）
  st.vChase += Math.max(-dv, Math.min(dv, vWant - st.vChase));
  if (vMax > 0) st.vChase = Math.max(-vMax, Math.min(vMax, st.vChase));   // ④ 上限只作用于追赶
  let step = (st.vFeed + st.vChase) * dtS;
  if (Math.abs(step) > Math.abs(dy)) step = dy;
  if (!(Math.abs(step) > 1e-6)) { st.vChase = 0; return false; }
  const wrote = writeTop(el, cur + step, cur, t);
  if (!wrote) {                                    // task-25：不写成功时用解析预测判"是否已到位"，**不回读 scrollTop**（那是写后同帧读 ⇒ 强制布局）
    const predicted = maxHint === undefined ? el.scrollTop : Math.min(maxHint, Math.max(0, snapPx(cur + step)));
    if (snapPx(predicted) === wantPx) { st.vChase = 0; st.prev = want; return false; }
  }
  return true;
}
// 自身耗时统计：只统计"我们的 JS"，不含浏览器的布局/绘制（那部分不在我们手里）
const cost = { frames: 0, tickMs: 0, scans: 0, scanMs: 0, lastMs: 0, maxMs: 0, phases: {}, counts: {}, worst: null, lastError: null, pinMs: 0, pinFrames: 0 };
/* task-19 ②：tick 内分阶段计时（plan=读尺寸+低通 / main=主容器推进 / win=小窗写）。尖峰归谁看这里。 */
const tickPhase = {};        // 各相位累计（probe 里除以 n）
const phaseMs = { plan: 0, main: 0, win: 0, winStyle: 0, winSlide: 0, winJump: 0, sparks: 0, pin: 0, announce: 0, absorb: 0, mainPlan: 0, mainSlide: 0, mainGate: 0 };
let pinRects = 0;   // task-25：pinTick 里的 getBoundingClientRect 调用次数（diagnostic）
const phaseAcc = (k, t0) => { phaseMs[k] += performance.now() - t0; };
const tickSamples = [];      // 最近 200 帧的 tickMs（p50/p95/max）
let phPlanMs = 0, phMainMs = 0, phWinMs = 0;   // tickFollowInner 写、tickFollow 取（分阶段计时）
let readCount = 0;           // 诊断：本帧的强制布局读次数（scrollHeight/clientHeight）
let frameTop = 0, frameSh = 0, frameCh = 0;   // task-19 ②：本帧主容器几何的一次读结果（全帧复用；frameTop 为写后值）
let frameToken = 0, vtStamp = -1, vtRect = null;   // task-19 ②：viewTop 的帧内容器 rect 缓存（仅 tick 帧内有效，帧外走原式）
/** task-20：显式 scrollTop 读的统一入口（口径（S2-2）计数的一部分）；调用方已知值请传 curHint，不要多读。 */
const readTop = (el) => { readCount += 1; return el.scrollTop; };
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
let ticking = false;
let rafId = 0;              // 帧循环句柄（dispose 要能停掉它）
let disposed = false;       // 实例已收摊：所有异步入口早退（热重载后旧实例不许再动 DOM）
/** 未收敛就自己接着排帧：只靠 MutationObserver 的话，两次输出之间的那段就冻住不动了。 */
let lastTickTs = 0;
let gutterSet = false;    // H16：稳定滚动条槽（bootOver 之后才设；三因子隔离证明静态版单独无判据影响，但仍推迟以避开初始化大步）
const TICK_MIN_MS = 5;    // H16：推进循环最小间隔（320Hz 隔帧 ~160Hz；必要参数：每次 scrollHeight 都是强制重排）
function tickLoop(timestamp) {
  if (disposed) { ticking = false; return; }
  const ts = timestamp || performance.now();   // rAF 回调时间戳 = 上一帧渲染结束时刻（不用 performance.now()）
  const prevTs = lastTickTs;
  if (prevTs !== 0 && ts - prevTs < TICK_MIN_MS) { rafId = requestAnimationFrame(tickLoop); return; }
  const dt = prevTs === 0 ? 16.667 : Math.min(500, Math.max(1, ts - prevTs));   // A14：首帧按一个 60Hz 帧记（内层本就以 16.667 兜底；trace 不再记 ts-ts=0）；解析式对任意 dt 精确 → 只夹极端值防巨跳
  lastTickTs = ts;
  if (!tickFollow(dt)) {
    ticking = false;
    if (tickRetry && !disposed) { tickRetry = false; ensureTickLoop(); }   // 异常后立即重排：外围不能因一行异常整条停摆
    return;
  }
  rafId = requestAnimationFrame(tickLoop);
}
function ensureTickLoop() {
  if (ticking || disposed) return;
  ticking = true;
  lastTickTs = 0;               // 帧循环重启：首帧 dt 从 0 起算（不把停摆期间的时间差当一帧）
  resetVel(mainVel);            // 重启时速度复位（不携带陈旧前馈/追赶速度）
  for (const el of liveWindows) { const s = winState.get(el); if (s !== undefined) resetVel(s); }
  rafId = requestAnimationFrame(tickLoop);
}
let tickErrors = 0;          // 帧循环体内异常次数（诊断）：一行异常不得再打死整条循环
let lastTickError = null;    // 最近一次帧循环异常 {message, stack, at}
let tickRetry = false;       // 本轮循环体抛过异常 ⇒ 不认"已收敛"，由 tickLoop 收尾处立即重排重试
function tickFollow(dt) {
  const t0 = performance.now();
  const w0 = writeCount, a0 = announceCount, r0 = readCount, g0 = followScroller === null ? null : frameTop;   // task-19：g0 = 上一帧写后位置（不再回读）
  const ph0 = { ...phaseMs };
  for (const k in writeTally) delete writeTally[k];   // task-22：本帧写来源从零开始记
  let moving = false;
  try {
    moving = tickFollowInner(dt);
    const tickMs = performance.now() - t0;
    if (moving || writeCount !== w0 || announceCount !== a0) {   // 空闲不记：这一帧什么都没发生就不进轨迹
      const sc = followScroller;
      const fl = sc === null ? 0 : Math.max(0, frameSh - frameCh);   // task-19：复用本帧几何
      if (tickSamples.length >= 200) tickSamples.shift();
      tickSamples.push(+tickMs.toFixed(2));
      const tickEnd = t0 + tickMs;                       // 分阶段：plan=建计划(读尺寸+低通) / main=主容器推进 / win=小窗写
      const phPlan = phMainMs - phPlanMs, phMain = phWinMs - phMainMs, phWin = tickEnd - phWinMs;
      const phD = { plan: +phPlan.toFixed(2), main: +phMain.toFixed(2), win: +phWin.toFixed(2) };
      for (const k in phaseMs) if (k !== "plan" && k !== "main" && k !== "win") phD[k] = +(phaseMs[k] - ph0[k]).toFixed(2);
      phD.other = +Math.max(0, tickMs - (phPlan + phMain + phWin + (phaseMs.sparks - ph0.sparks))).toFixed(2);
      for (const k in phD) tickPhase[k] = (tickPhase[k] || 0) + phD[k];
      tickPhase.n = (tickPhase.n || 0) + 1;
      traceFrame({
        dt: +dt.toFixed(2), writes: writeCount - w0, announces: announceCount - a0,
        tickMs: +tickMs.toFixed(2), reads: readCount - r0,
        ph: phD,
        wsrc: Object.keys(writeTally).length ? { ...writeTally } : undefined,
        step: sc === null || g0 === null ? 0 : +(frameTop - g0).toFixed(2),
        gap: sc === null ? 0 : +(fl - frameTop).toFixed(2), writer, goal: goalKind,   // task-19：复用本帧写后位置
        scanMs: +scanMsSinceFrame.toFixed(2), scans: scanCountSinceFrame,   // 归因 dt 尖峰：这一帧我们自己扫了多久
      });
    }
  } catch (err) {
    tickErrors += 1;
    lastTickError = { message: String((err && err.message) || err), stack: String((err && err.stack) || "").split("\n")[1] || "", at: Math.round(performance.now()) };
    ticking = false;          // 解死锁：异常路径曾把 ticking 永久留在 true ⇒ ensureTickLoop() 永久早退
    tickRetry = true;         // 重排交给 tickLoop 收尾处（避免与它重复排帧 ⇒ 双链）
  } finally {
    cost.frames += 1;
    cost.tickMs += performance.now() - t0;
    scanMsSinceFrame = 0; scanCountSinceFrame = 0;   // 每帧都清零：这帧没记进轨迹也不许把账留给下一帧
  }
  return moving;
}
function tickFollowInner(dt) {
  tickCount += 1;
  if (!(dt > 0)) dt = 16.667;   // 同 mainFollowTick：首帧 dt=0 的兜底（小窗跟随/回底也不能白跑一帧）
  if (gateOfficialMode()) return false;   // 官方档位：小窗也不写、按钮收起（整个运动层退出）
  // 小窗计划先只读建好、只算不写（A-noA4：不再把窗的剩余目标折进主吸附）
  phPlanMs = performance.now();
  const plan = [];
  for (const el of liveWindows) {
    if (!el.isConnected) { liveWindows.delete(el); continue; }   // React 卸载：只退登记
    const ch = el.clientHeight;
    if (ch === 0) continue;
    const sh = el.scrollHeight;                     // 每帧只读一次：读尺寸在 DOM 脏的时候会强制重排
    const max = sh - ch;
    const st = winOf(el);
    if (st.snapped !== true) {                      // 小窗首次跟随：直接贴底（5000px 正文不该从顶部爬 10s；只做一次）
      st.snapped = true;
      if (st.writer === "us" && el === activeWindow && max > 0.5 && el.scrollTop < max - 0.5) { writeTop(el, max, undefined, "win-snap"); resetVel(st); st.wantS = max; }   // 只有活动窗首帧贴底
    }
    const top0 = el.scrollTop;                      // task-22：本帧该窗只读这一次 scrollTop（原 gap/plan 各读一次）
    const gap = max - top0;
    const bottom = gap <= 24;
    if (!searchHold && st.writer !== "us" && gap <= 0.5) { st.writer = "us"; st.nav = false; resetVel(st); st.wantS = undefined; }   // 规则 4：读者落到窗尾 ⇒ 取回写权（速度状态复位 + 低通重新对齐）；搜索闩置位时不认几何
    // 小窗跟随目标独立低通（task-18 ④）：一次性回底（nav）不走低通，首次/收缩直接对齐
    if (st.nav || st.wantS === undefined || st.wantS > max + 1) st.wantS = max;
    else st.wantS += (max - st.wantS) * (1 - Math.exp(-dt / WIN_TAU_MS));
    const winWant = st.nav ? max : st.wantS;
    // 跟尾 = 写权在我方 ∧ 这还是本轮在跑的那个活动窗；st.nav 是用户点回底的一次性请求（不算吸附）。
    const follow = st.writer === "us" && (el === activeWindow || st.nav);
    // 流式输出是一行一行来的：max-height 跟住内容高度（长出来而不是跳一格）
    const want = el.dataset.dshsfClosing === "1" ? null : Math.min(sh, windowCap());
    const known = el.dataset.dshsfH;
    const cur = known === undefined ? want : Number(known);
    const h0 = winH.get(el); winH.set(el, ch);            // 只读计划里记下实测高：收窗帧的缩量由它给出
    const dh = want === null ? (h0 === undefined ? 0 : ch - h0)   // CSS 过渡收窗：没有 JS 写入，缩量 = 实测高差
      : (Math.abs(want - cur) <= 0.5 ? 0 : expStep(want - cur, dt));
    let jump = jumpOf.get(el);   // task-20 A10：帧路径优先信自己的登记（DOM 挪动/多实例都不会认错），缺失才查询并登记
    if (jump === undefined) {
      jump = el.querySelector(":scope > [data-dshsf-jump]");
      if (jump !== null && jump !== undefined) jumpOf.set(el, jump);
    }
    plan.push({ el, jump, bottom, gap, follow, cur, want, dh, known, top: top0, max, sh, nav: st.nav, st, winWant });
  }
  phMainMs = performance.now();
  let moving = mainFollowTick(dt);
  // task-19 例外：这一句被 static-check 逐字钉住（"每帧必须同步几何基线"），且几何基线语义上就是"此刻真实几何"；
  // 保留这 2 次读。滑行帧其余重复读已复用 frameTop/frameSh/frameCh 同一份。
  vtStamp = -1;   // task-19 ②：帧结束 ⇒ viewTop 缓存失效（帧外调用回原式）
  if (followScroller !== null) { baseSt = followScroller.scrollTop; baseSh = followScroller.scrollHeight; }   // 帧基线：下一笔外来写的"同期布局变化"基准
  { const tS = performance.now(); if (sparks.tick(dt)) moving = true; phaseAcc("sparks", tS); }   // 火星：模块自带"该不该跑"，熄灭且不发光时返回 false（空闲零成本）
  phWinMs = performance.now();
  if (plan.length === 0) { if (moving) ensureTickLoop(); return moving; }
  for (const item of plan) {
    readCount += 2;   // 每窗：clientHeight + scrollHeight 两次强制布局读
    item.topAfter = item.top;                      // task-25：写 maxHeight 之后的预测位置（默认不变）
    item.maxAfter = item.max;                      // 写 maxHeight 之后的可滚动上限（= sh - newHeight）
    let nextH = null;                              // task-27：本轮要写的高度（先算出来，但**样式最后写**）
    if (item.want !== null) {
      if (item.known === undefined) item.el.dataset.dshsfH = String(item.want);
      if (item.dh !== 0) {               // dh 带符号，来自只读计划里的同一个指数律：与主吸附本帧推进同速
        nextH = (item.cur + item.dh).toFixed(1);
        item.maxAfter = Math.max(0, item.sh - Number(nextH));   // 目标必须按**变更后的 extent** 算（否则长高那几帧会被旧 max 截断）
        item.topAfter = Math.min(item.top, item.maxAfter);
        moving = true;
      }
    }
    // 跟随中：朝底部"追"过去，而不是直接跳到 max —— 内容才有顺流而下的感觉
    if (item.follow) {
      // 与主容器同一个滑行律（slide）：跟随 step=min(cap, rate)；回底按钮发起的那一次不设 cap。
      // 不给 gap 设门槛：|dy|≤0.5 的精确落点在 slide 内部完成（门槛会让窗永远差 <0.5px 停住）。
      const vMaxW = (() => { const v = Number(state.followMaxSpeed); return Number.isFinite(v) && v > 0 ? v : DEFAULTS.followMaxSpeed; })();   // 单一真源（px/s）
      const tSli = performance.now();
      if (slide(item.el, item.winWant, dt, item.nav ? 0 : vMaxW, item.st, item.topAfter, "win", item.maxAfter)) moving = true;   // task-27：**先写 scrollTop**（cur/max 用预测的变更后 extent）
      phaseAcc("winSlide", tSli);
    }
    if (nextH !== null) {                            // task-27：样式写放到最后（帧内不再出现"写完布局→再写滚动"的栅栏）
      const tSty = performance.now();
      item.el.dataset.dshsfH = nextH;
      item.el.style.setProperty("--dshsf-hw", nextH + "px");   // 入场动画还在跑时，动画目标也跟着长（避免交接跳一下）
      item.el.style.maxHeight = nextH + "px";
      phaseAcc("winStyle", tSty);
    }
    if (item.nav && item.topAfter >= item.max - 0.5) winOf(item.el).nav = false;   // task-25：用预测值判到位（不读 scrollTop）
    item.el.toggleAttribute("data-dshsf-offbottom", item.gap > 24);
    if (!item.jump) item.jump = ensureWindowJump(item.el);   // 自愈：登记过的窗任何时候都必须有按钮
    if (item.jump) {
      // 显隐带滞回：点亮要"读者接管或落后很多"，熄灭只在真正回到贴底（gap<12）——
      // 跟随状态/差距在阈值附近抖动时按钮不该跟着闪。
      const tJm = performance.now();
      if (state.showJumpButton === false) item.jump.removeAttribute("data-dshsf-visible");
      else if (item.jump.hasAttribute("data-dshsf-visible")) { if (item.gap < 12) item.jump.removeAttribute("data-dshsf-visible"); }
      else if (item.gap > 24 && (!item.follow || item.gap > 120)) item.jump.setAttribute("data-dshsf-visible", "");
      phaseAcc("winJump", tJm);
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
  const holder = document.querySelector("[data-conversation-session]");
  const key = holder ? holder.getAttribute("data-conversation-session") : null;
  if (key === null || key === "") return;      // 当前视图没有会话信息（设置页/嵌入态）：状态不动
  if (sessionKey === null) { sessionKey = key; return; }
  if (key === sessionKey) return;
  sessionKey = key;
  clearSettle("session");                      // 会话边界：协调作废（跨会话不许留任何进行中的状态）
  lastUserKey = null;                          // 会话边界：回尾判据重新开始记录（换会话不许误判成"你刚发了消息"）
  // 会话边界：复位运动模型自己的状态量（陈旧坐标不许跨会话参与写回；公式与机制一行不动）
  if (followScroller) { followScroller.removeEventListener("scroll", onMainScroll); followScroller.removeEventListener("pointerdown", onScrollerPointerDown); }
  followScroller = null;       // 强制重挂监听 + takeOverSnap
  followWrote = null;          // 陈旧坐标不许参与吸收时的恢复
  followHeight = -1;
  announcedTop = -1; announcedHeight = -1; lastAnnounceAt = 0;   // 切换期停发合成 scroll 事件
  lastStep = null;
  // 会话边界 = 交出写权的两个入口之一（另一个是读者真实输入）。只钉不跟：接回跟尾由
  // 「换容器语义判定」与 tick 的「落末端」规则负责（不依赖任何标志，与 tick 的先后顺序无关）。
  release("reset");                                  // 已是 reader 时只记原因（release 里已清 navIntent）
  goalKind = "none"; goalEl = null; navActive = false;
  resetVel(mainVel);                                 // 会话边界：速度复位
  for (const el of liveWindows) { const s = winOf(el); s.writer = "us"; s.nav = false; }   // 小窗写权同样归零
  activeWindow = null;                               // 会话边界：跟尾对象作废（新会话由扫描重新认领）
  manualState.clear();
  qCardTurns.clear();                                // A4：提问卡"已展开"按轮号记 —— 跨会话必须先清，否则新会话同轮号不再自动展开
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
    else clearSkipHidden(row);
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
  unfoldRowAnimated(row);
}
/** task-22：单行动画展开（**不消耗 animBudget**）—— 供"从上往下每 3 行"的错峰路径调用。
 *  与 applyFold 的展开分支同一语义：摘 skip → 去 folded → 量高 → 起始 0 → rAF 到高度 → 340ms 清。 */
function unfoldRowAnimated(row) {
  if (!row.hasAttribute("data-dshsf-row")) row.setAttribute("data-dshsf-row", "");
  clearSkipHidden(row);   // 先摘掉（只摘我们挂的那份），否则量到的高度是 0（内容根本没渲染）
  row.removeAttribute("data-dshsf-folded");
  row.style.maxHeight = "";
  row.style.overflow = "hidden";
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
function clearFoldTimers() { for (const id of foldTimers) clearTimeout(id); foldTimers.length = 0; }
/** 批量收起：先全部量一次高、写起始 max-height、一次 flush；然后**从最下面往上一组 3 行**错峰收
 *  （用户指定节奏）。错峰靠定时器推进；新一轮决策（有行要折/要展开）由调用方 clearFoldTimers() 作废。
 *  注意：行不是共同外框（按 data-chat-turn 属性分组的兄弟节点），所以"整块"只能靠这种节奏表达。 */
function foldBatch(rows, animate) {
  const targets = rows.filter((row) => !row.hasAttribute("data-dshsf-folded"));
  if (targets.length === 0) return;
  if (!animate || foldIsInstant(targets)) { for (const row of targets) applyFold(row, true, false); return; }
  layoutReads += 1;
  const heights = targets.map((row) => row.getBoundingClientRect().height);   // ① 只读
  for (let i = 0; i < targets.length; i += 1) {                                // ② 写起始值
    if (!targets[i].hasAttribute("data-dshsf-row")) targets[i].setAttribute("data-dshsf-row", "");
    targets[i].style.overflow = "hidden";
    targets[i].style.maxHeight = heights[i] + "px";
  }
  layoutReads += 1;
  void targets[0].offsetHeight;                                               // ③ 一次 flush，让过渡有起点
  for (let end = targets.length; end > 0; end -= FOLD_CHUNK) {                 // ④ 从最下面一组，往上一组组收
    const chunk = targets.slice(Math.max(0, end - FOLD_CHUNK), end);
    const delay = Math.floor((targets.length - end) / FOLD_CHUNK) * FOLD_CHUNK_MS;
    const run = () => {
      for (const row of chunk) {
        row.setAttribute("data-dshsf-folded", "");
        row.style.maxHeight = "0px";
        skipSoon(row);
      }
    };
    if (delay === 0) run();
    else foldTimers.push(setTimeout(run, delay));
  }
}
const cardCountCache = new WeakMap();   // task-19 A9：row → { kids, thinks, tools }；子节点数变化或 observer 定向失效即重算
/** 数一段子树里的匹配元素：嵌在同类里的（工具卡套工具卡）只算最外层那一个。
 *  task-19 A9：同一行的 THINK/TOOL_CARD 计数跨扫描复用（只在该行子树结构变化时重算）。 */
function countCards(row, selector) {
  const key = selector === THINK ? "thinks" : "tools";
  let e = cardCountCache.get(row);
  if (e === undefined || e.kids !== row.children.length) { e = { kids: row.children.length }; cardCountCache.set(row, e); }
  if (e[key] !== undefined) return e[key];
  cost.counts.cards = (cost.counts.cards || 0) + 1;
  const t = performance.now();
  let n = 0;
  for (const el of row.querySelectorAll(selector)) {
    const outer = el.parentElement && el.parentElement.closest(selector);
    if (outer && row.contains(outer)) continue;
    n += 1;
  }
  cost.phases.cards = +((cost.phases.cards || 0) + (performance.now() - t)).toFixed(2);
  e[key] = n;
  return n;
}
function unfoldAll(container) {
  for (const row of container.querySelectorAll("[data-dshsf-row]")) {
    clearSkipHidden(row);
    row.removeAttribute("data-dshsf-folded");
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
  if (!body || body.getAttribute("hidden") === SKIP) return;
  body.setAttribute("hidden", SKIP);
  body.dataset.dshsfSearch = "1";
  liveWindows.delete(body);          // 不渲染的窗不必每帧跟进（与折叠行同一套处理）
}
/** 搜索用的隐藏标记要撤掉（被搜到 / 用户自己点开 / 手动展开这一轮）。 */
function clearSearchHidden(scope) {
  if (!scope || !scope.querySelectorAll) return;
  for (const body of scope.querySelectorAll("[data-dshsf-search]")) {
    body.removeAttribute("data-dshsf-search");
    if (body.getAttribute("hidden") === SKIP) body.removeAttribute("hidden");
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
let scanRows = null;             // task-19 A9：一次扫描内共用的行列表（null = 扫描外，语义不变）
let scanRunningMark = null;      // task-19 A9：扫描开头取一次 RUNNING 标记
let scanRunningKnown = false;
function chatRows() {
  if (scanRows !== null) return scanRows;   // task-19 A9：扫描内复用同一次全树查询
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
  const tail = document.querySelector('[data-turn-tail="' + turn + '"]');
  return tail !== null && tail.hasAttribute("data-actions-reveal");
}
/** 本轮正式回答行 = 最后一个「有正文」的 assistant-step 行（没有正文行才退回最后一个 assistant-step）。
 *  0.1.7 会把一个 step 拆成 reasoning / response 两个行，只看"最后一个"未必落在正文上。
 *  按轮次 memo：一次扫描里 syncTurns 与 syncTextWindows 都要用，避免双倍整树遍历。 */
let answerRowCache = new Map();
const assistantRowsCache = new WeakMap();   // task-20 A11：turnRows 数组（每扫描一份）→ assistant-step 行；syncTurns 与 syncTextWindows 共用，避免重复整轮 filter
function assistantRowsOf(turnRows) {
  let v = assistantRowsCache.get(turnRows);
  if (v === undefined) { v = turnRows.filter((row) => rowKind(row) === "assistant-step"); assistantRowsCache.set(turnRows, v); }
  return v;
}
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
  const mark = scanRunningKnown ? scanRunningMark : chatScope().querySelector(RUNNING);   // task-19 A9：扫描内复用开头那次 RUNNING 查询
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
    const assistantRows = assistantRowsOf(turnRows);   // task-20 A11：同一轮的 assistant 行本扫描只 filter 一次
    const answerRow = answerRowOf(turnRows);
    // 锻打锚点用**整行**（flowItem 在一轮里是稳定的），不用会随 React 重渲染被换掉的段落：
    // 段落一换，火星就得等下一次扫描才回得来（看着像闪）；行稳定则挂上去的画布一直有效。
    if (isRunningTurn && answerRow) forgeBody = answerRow;
    // 可折叠候选：过程行（答案行 / 独立行除外；按设置保留穿插正文行）
    const foldableSet = new Set();
    const foldable = turnRows.filter((row) => {
      const qKind = rowKind(row);   // 提问开关覆盖两个节点：提问工具卡(tool-call + data-tool) 与 回复节点(kind question-reply / user-question-reply)
      if (row === answerRow || INDEPENDENT.has(qKind) || (state.keepUserQuestions === true && (qKind === "question-reply" || qKind === "user-question-reply" || row.querySelector('[data-tool="ask_user_question"],[data-tool="request_user_input"]')))) return false;
      if (state.keepInterleavedText !== false && rowKind(row) === "assistant-step" && hasText(row)) return false;
      foldableSet.add(row);
      return true;
    });
    const settling = settleTurn !== null && String(turn) === String(settleTurn);   // 正在协调的那一轮：折叠压到滑完
    const shouldFold = !settling && (manual === "fold"
      || (manual !== "open" && !isRunningTurn && (state.foldHistory !== false || running)));
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
        thinks += countCards(row, THINK);
        tools += countCards(row, TOOL_CARD);
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
        setManual(turn, anyFolded ? "open" : "fold");
        allowAnim = true;
        hold();                                            // 我方定位：取回写权（官方贴底写不再拖我们），位置交给 anchorDuring
        const before = chip.getBoundingClientRect().top;
        try { scan(); } catch (err) { scanErrors += 1; lastScanError = String((err && err.message) || err).slice(0, 200); }   // F4：调用点兜底
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
  if (toFoldAll.length > 0 || thinkFoldsAll.length > 0 || toUnfoldAll.length > 0) clearFoldTimers();   // 新一轮决策 ⇒ 作废未播完的批次
  foldBatch(toFoldAll, animate);                         // 行：读一遍 + 一次 flush，然后从下往上每 3 行错峰收
  foldBatch(thinkFoldsAll, animate);                     // 行内思考摘要：同一套节奏（单独一组）
  unfoldBatch(toUnfoldAll, animate);                     // 行：从上往下每 3 行错峰展（跨 ≥2 轮或超护栏才瞬时）
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
  try {
    if (!anchorCtl) return false;
    const { el, scroller } = anchorCtl;
    if (performance.now() > anchorCtl.until || !el.isConnected) { anchorStop(); return false; }
    if (navActive) return false;   // 我方一次性导航期间位置由滑行律独占：锚定补偿不插写
    const delta = el.getBoundingClientRect().top - anchorCtl.top;
    if (delta === 0) return false;
    writeTop(scroller, scroller.scrollTop + delta, undefined, "anchor");   // 锚定补偿是我方写入（ownWrite）⇒ 吸收器放行
    anchorCtl.top = el.getBoundingClientRect().top;
    if (!anchorCtl.announced) {
      anchorCtl.announced = true;
      try { scroller.dispatchEvent(new Event("scroll", { bubbles: true })); } catch { /* ignore */ }
    }
    return true;
  } catch (err) { ioErrors.anchor += 1; ioErrors.last = "anchor: " + String((err && err.message) || err); return false; }
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
const FOLD_CHUNK = 3;         // 节奏：一组 3 行（收起从最下往上一组；展开从最上往下一组，用户指定对称）
const FOLD_CHUNK_MS = 70;     // 每组之间的错峰间隔：让"滚着收/滚着展"看得出来
const FOLD_STAGGER_BUDGET_MS = 2000;   // **护栏**（只对单轮）：ceil(rows/3)*FOLD_CHUNK_MS 超过它就瞬时 —— 防极端大单轮拖太久，不是主判据
/** task-22：批量收/展的"瞬时"判据从行数改为**场景** —— 统计本批覆盖的不同轮次（data-chat-turn 去重）：
 *  跨 ≥2 轮 ⇒ 加载/切会话/批量场景（错峰看不清）⇒ 瞬时；单轮 ⇒ 正常收起/展开 ⇒ 一律错峰（哪怕 40+ 行）。
 *  单轮只在超过时长护栏时瞬时。think 摘要批用 closest(ROW) 归属到所属轮次，同一规则。 */
function foldIsInstant(targets) {
  const turns = new Set();
  for (const el of targets) {
    const owner = el.closest && el.closest(ROW) ? el.closest(ROW) : el;
    const t = owner.getAttribute ? owner.getAttribute("data-chat-turn") : null;
    turns.add(t === null || t === undefined ? "0" : t);
    if (turns.size >= 2) return true;
  }
  return Math.ceil(targets.length / FOLD_CHUNK) * FOLD_CHUNK_MS > FOLD_STAGGER_BUDGET_MS;
}
/** task-22：批量展开 —— 与 foldBatch 对称，但**从上往下一组 3 行**（用户指定方向，与收起相反）。
 *  错峰路径每行走 unfoldRowAnimated（自写起始/终值），**不消耗 animBudget**：否则一波展开会被
 *  "一次扫描最多 3 个动画"的配额截断（foldBatch 的错峰路径同样不消耗）。新一轮决策由调用方 clearFoldTimers() 作废。 */
function unfoldBatch(rows, animate) {
  const targets = rows.filter((row) => row.hasAttribute("data-dshsf-folded"));
  if (targets.length === 0) return;
  if (!animate || foldIsInstant(targets)) { for (const row of targets) applyFold(row, false, animate); return; }
  for (let start = 0; start < targets.length; start += FOLD_CHUNK) {   // 从上往下一组组展
    const chunk = targets.slice(start, start + FOLD_CHUNK);
    const delay = Math.floor(start / FOLD_CHUNK) * FOLD_CHUNK_MS;
    const run = () => { for (const row of chunk) unfoldRowAnimated(row); };
    if (delay === 0) run();
    else foldTimers.push(setTimeout(run, delay));
  }
}
let foldTimers = [];          // 未播完的错峰收起定时器（新一轮决策时作废）
let scanMsSinceFrame = 0;     // 自上一帧以来扫描累计耗时：dt 尖峰归因（是我们在扫，还是官方在渲染）
let scanCountSinceFrame = 0;
const scanSamples = [];   // 最近 N 次扫描的墙钟耗时（算分位数用；max 会被外部卡顿污染）
const SCAN_SAMPLES = 40;
let animBudget = ANIM_BUDGET;
const autoThinks = new Set();   // 我方自动展开过的思考根（只有它们需要"被取代后折回"）
const autoTools = new Set();    // 同上，工具卡
let lastAnnounceAt = 0;   // 上次补发 scroll 事件的时刻（压官方吸底用）
let announcedHeight = -1; // 上次补发时的内容高度：长高那一帧必须补，等不了 400ms
let announcedTop = -1;    // 上次补发时的位置：位移太小时补发会踩到官方"读者没动过"那条分支
let moveCount = 0;        // 诊断：帧循环真正推进过多少帧（流式期间应持续增长）
const followFlips = [];   // 诊断：写权最近几次翻转（按钮闪 = 跟随在抖 → 看这里）
let lastFollowSeen = true;
/** 记一次跟随翻转。why=谁翻的、top/wrote=翻转瞬间的位置与我方最后写入值（不相等 = 有别人动过）。 */
function noteFlip(on, gap, info) {
  lastFollowSeen = on;
  followFlips.push({ t: Math.round(performance.now()), on, gap: Math.round(gap), ...info });
  if (followFlips.length > 10) followFlips.shift();
}
let layoutReads = 0;      // 扫描里"读布局"的次数：DOM 脏的时候每读一次就强制一遍重排
let tickCount = 0;        // 帧循环跑过多少次（诊断：看优化前后量级）
let announceCount = 0;    // 已废弃：合成 scroll 已删除（task-22），恒 0（保留字段给 probe/审计 hook 兼容）
const ANNOUNCE_MS = 400;   // 已废弃（合成 scroll 已删除）：保留常量仅为审计 hook/probe 字段兼容
/* ---- 写权 / 目标：两个独立状态量（本次重建的核心）--------------------------------------
 * writer = 谁写 scrollTop：us = 我方（官方贴底写被当"意图"吸收）；reader = 读者接管（官方写原样放行，我方零程序化写）。
 * goal   = 我方目标：tail = 每帧重算为 floor（跟内容增长）| element | position | none。
 * 我方导航（置顶条 / 回底 / 跑完回提问 / 展开收起 / Ctrl+F / 折叠条）只换目标、**绝不交出写权**；
 * 交出写权只有两个入口：读者真实输入、别的程序导航（非贴底写）；再武装（取回写权、目标=尾）只有三个入口：
 * 读者落到末端 / 点回底 / 会话边界。空闲值全部显式：writer=us、goal=tail。 */
const WRITER_US = "us";
const WRITER_READER = "reader";
let writer = WRITER_US;
let goalKind = "tail";       // "tail" | "element" | "position" | "none"
let goalEl = null;           // element 目标（节点）
let goalPos = 0;             // position 目标（px）
const mainVel = newVel();    // 主容器的速度状态（vFeed/vChase/prev 各一份，唯一状态量）
let navActive = false;       // 一次性导航进行中：不设追赶速度上限，SETTLE_MAX_MS 兜底
let navUntil = 0;
let navT0 = 0;
let navWatchdog = 0;         // task-12：一次性导航的有界终止看门狗（帧循环已停时也能收口；不新增 rAF 空转）
let navProgressAt = 0;       // 最近一次"导航确实推进"的时刻（performance.now）
let navArmedAt = 0;          // 诊断：最近一次导航武装看门狗的时刻 / 预算（区分"卡住终止"与"settle 超时"）
let navBudgetMs = 0;
let navAbortCount = 0;       // 诊断：看门狗有界终止次数
let lastNavAbort = null;     // 诊断：{why, armedAt, at, budgetMs, top}
let navRecheck = null;       // S1-4：element 到位后的有界观察窗口 { el, until, left, lastAt }
const NAV_STALL_MS = 1200;   // 看门狗判定"期间零进展"的宽限（有推进就续期；取 1.2s 以免慢帧/GC 误杀正常滑行）
// S1-4/task-17：element 到位后的有界观察窗口。取 2s 的理由：覆盖到位后常见的"迟到落版"（图片/代码块、上一轮摘要行、
// 官方补行、折叠收尾）；窗口内以帧驱动观察（≈120 帧 @60Hz），到点立即退出 ⇒ 之后零 rAF/timer。
// 上限 4 次 + 最小间隔 100ms 同时挡住"每帧都在变"的持续漂移；纠正复用既有 navigate({kind:"element"})，不新增 mover。
const NAV_WATCH_MS = 2000;
const NAV_WATCH_MAX = 4;
const NAV_WATCH_MIN_GAP_MS = 100;
// task-19：观察降频 —— 窗口期不是每帧都要读一次目标 rect；每 2 帧复算一次（检测延迟 ≤1 帧，min-gap 仍 100ms），
// 窗口期 rect 读减半、窗口保活/到期零残留语义不变。
const NAV_OBSERVE_EVERY = 2;
let followWrote = null;      // 我方最后一次写下的位置：吸收时恢复它，也用来分辨 scroll 是不是我造成的
let followScroller = null;
let releaseReason = null;
let lastReleaseAt = 0;       // 诊断：最近一次交出写权的时刻
let followHeight = -1;       // 上一次 tick 时的内容高度（补发判据用）
let lastStep = null;         // 探针：上一帧 {writer, goal, gap, base, rate, cap, dt, moving, nav}
let lastNav = null;          // 探针：最近一次一次性导航 {kind, why, to, ms}
/* ---- 帧轨迹（task-18 ⑥）：最近 240 帧；只在这一帧真的动过/写过/补发过时记一条，空闲零开销 ---- */
const TRACE_MAX = 240;
const trace = [];
const traceFrame = (rec) => { if (trace.length >= TRACE_MAX) trace.shift(); trace.push(rec); };
let passedOfficial = 0;      // 诊断：reader 态被原样放行的官方贴底写
/* ---- navIntent：真实输入给"下一笔外来写"的单笔分类位（task-13）-----------------------
 * 置位：捕获阶段收到真实输入（click / keydown，我方合成分发、输入控件里的不算）。
 * 消费：被**下一笔外来写**消费即清除（贴底写也算一笔）。
 * 过期：未被消费则在**其后两帧内**过期（用帧计数 tickCount + 2，避免久置；设位时叫醒帧循环让它真的走两帧）。
 * 只用于"给单笔外来写分类"（导航 vs 保位），**不参与"是否跟随"的门控**。 */
let navIntentUntil = -1;
/* ---- 几何信号（task-14）：这笔写是否只是在补偿"同期布局变化"--------------------------------
 * 一次滚动赋值不可能同步改变 scrollHeight，所以在写点"落地前"现读 sh0 必然是 0 变化（信号退化）。
 * 因此基线取**上一帧观察到的 (st, sh)**（本任务开始前、布局变化之前的世界）：
 *   st0/sh0 = 上一帧基线（没有基线时退化为写点前的值）
 *   st1/sh1 = 落地后
 *   compensated = |(st1-st0) - (sh1-sh0)| <= 2   // 位置变化完全由内容高度变化解释 ⇒ 视口内容没动
 * 与输入位取或：nav = hasNavIntent() || !compensated。 */
let baseSt = -1;
let baseSh = -1;
const hasNavIntent = () => tickCount <= navIntentUntil;
const clearNavIntent = () => { navIntentUntil = -1; };
function noteNavIntent() { navIntentUntil = tickCount + 2; ensureTickLoop(); }
function onNavIntentInput(event) {
  try {
    if (synthetic || !(event && (event.type === "click" || event.type === "keydown"))) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
    // 真实点击/按键 ⇒ 搜索闩解除：放在"输入分类"之后，且排除 Ctrl+F 自身（与监听器注册顺序无关）
    if (!((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F"))) searchHold = false;
    noteNavIntent();
  } catch (err) { ioErrors.input += 1; ioErrors.last = "navIntent: " + String((err && err.message) || err); }
}
const ioErrors = { input: 0, absorb: 0, anchor: 0, last: null };   // 输入/写层/锚定里被吞掉的异常（不许空 catch，要能被 probe 看见）
const prefersReduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/** 唯一交出写权出口（读者真实输入 / 会话边界各一个调用点）。 */
function release(reason) {
  navRecheck = null;                                 // S1-4：读者接管 ⇒ 未决复算作废
  clearSettle("reader");                             // 读者接管：协调作废（不许把折叠压在别人的滚动上）
  clearNavIntent();                                  // 交权：这笔输入由读者接手，不再算导航意图
  tailWant = -1;                                     // 跟随目标低通作废（下次从当前 floor 重新对齐）
  if (releaseBy[reason] === undefined) releaseBy[reason] = 0;
  releaseBy[reason] += 1;                                            // 计数按"调用"记（已经是读者时也要留痕）
  if (writer === WRITER_READER) { releaseReason = reason; return; }   // 已经是读者的位置，不重复翻
  writer = WRITER_READER;
  goalKind = "none"; goalEl = null; navActive = false;
  releaseReason = reason; lastReleaseAt = performance.now();
  const sc = mainScroller();
  noteFlip(false, sc === null ? 0 : Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop), { why: reason });
}
/** 唯一取回写权出口（读者落到末端 / 点回底 / 会话边界）：目标回到尾。 */
function rearm() {
  if (writer === WRITER_US && goalKind === "tail") return;
  clearNavIntent();
  tailWant = -1;
  const sc = mainScroller();
  writer = WRITER_US; goalKind = "tail"; goalEl = null; navActive = false; releaseReason = null;
  navRecheck = null;                                 // S1-4：接回跟尾 ⇒ 未决复算作废
  followWrote = sc === null ? null : sc.scrollTop;   // 基准 = 当前位置：陈旧坐标不许参与吸收时的恢复（B2）
  resetVel(mainVel);                                 // 目标换人：前馈/追赶速度复位
  rearmCount += 1;
  noteFlip(true, sc === null ? 0 : Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop), { why: "rearm" });
}
/** 我方导航：取回写权 + 只换目标，绝不交出写权。spec = { kind: "tail"|"element"|"position", el?, px?, instant? }。
 *  instant=true 只给"用户发起"的一次性导航（置顶条/回底）：命中 prefers-reduced-motion 时真瞬跳（写点仍是 writeTop）。 */
function navigate(spec) {
  navRecheck = null;                                 // S1-4：显式新导航作废未决复算（不抢用户/新导航）
  writer = WRITER_US;
  { const sc = mainScroller(); followWrote = sc === null ? null : sc.scrollTop; }   // 基准 = 当前位置（与 rearm 同一条不变式：陈旧坐标不许参与吸收恢复）
  clearNavIntent();                                  // 我方已自己完成这次导航：输入意图用掉了
  if (settleTurn !== null) clearSettle("nav");        // task-32：滑行途中被新导航取代 ⇒ 当帧作废协调（该轮立刻折）
  tailWant = -1;                                     // 一次性导航：目标静止，不走低通
  resetVel(mainVel);                                 // 目标换人：前馈/追赶速度复位
  goalKind = spec && spec.kind ? spec.kind : "tail";
  goalEl = spec && spec.el ? spec.el : null;
  goalPos = spec && Number.isFinite(spec.px) ? spec.px : 0;
  navActive = true;
  navT0 = performance.now();
  navUntil = 0;                                      // 0 = 还没武装：第一帧按真实剩余距离算预算（见 mainFollowTick）
  releaseReason = null;
  if (goalKind === "tail") { try { document.documentElement.removeAttribute("data-dshsf-jumpgate"); } catch { /* ignore */ } }
  if (spec && spec.instant && prefersReduced()) {
    const sc = mainScroller();
    const floor = sc === null ? 0 : Math.max(0, sc.scrollHeight - sc.clientHeight);
    let want = null;
    if (goalKind === "tail") want = floor;
    else if (goalKind === "position") want = Math.max(0, Math.min(floor, goalPos));
    else if (goalKind === "element" && goalEl !== null && goalEl.isConnected) want = Math.max(0, Math.min(floor, viewTop(sc, goalEl) - SETTLE_PAD));
    if (sc !== null && want !== null) {          // 无障碍：不做多帧运动，直接到位
      writeTop(sc, want, undefined, "nav-instant");
      navActive = false;
      lastNav = { kind: goalKind, why: "reduced-motion", to: Math.round(sc.scrollTop), ms: 0 };
      if (goalKind === "element" || goalKind === "position") { goalEl = null; goalKind = "none"; }
    else tailWant = -1;                              // 一次性回底到位 ⇒ 跟随目标从当前 floor 重新对齐
    }
  }
  if (navActive) {                                   // task-12：给一次性导航装有界看门狗（零步停机时由它收口）
    navProgressAt = performance.now();
    const sc = mainScroller();
    const floor = sc === null ? 0 : Math.max(0, sc.scrollHeight - sc.clientHeight);
    let dist = 0;
    if (sc !== null) {
      if (goalKind === "tail") dist = Math.abs(floor - sc.scrollTop);
      else if (goalKind === "position") dist = Math.abs(Math.max(0, Math.min(floor, goalPos)) - sc.scrollTop);
      else if (goalKind === "element" && goalEl !== null && goalEl.isConnected) dist = Math.abs(Math.max(0, Math.min(floor, viewTop(sc, goalEl) - SETTLE_PAD)) - sc.scrollTop);
    }
    navArmedAt = performance.now(); navBudgetMs = navBudget(dist) + NAV_STALL_MS;
    armNavWatchdog(navBudgetMs);
  } else { clearTimeout(navWatchdog); navWatchdog = 0; }
  ensureTickLoop();
}
/** 我方定位、但位置由锚定补偿自己写（展开/收起 / Ctrl+F）：取回写权、不设我方目标。 */
function hold() {
  writer = WRITER_US; goalKind = "none"; goalEl = null; navActive = false; releaseReason = null;
  navRecheck = null;                                 // S1-4：锚定期间未决复算作废
  { const sc = mainScroller(); followWrote = sc === null ? null : sc.scrollTop; }   // 基准 = 当前位置（与 rearm 同一条不变式）
  clearNavIntent();
  tailWant = -1;
  resetVel(mainVel);                                 // 目标换人：速度复位
  ensureTickLoop();
}
/** reader 释放的唯一入口：真实输入那一刻（滚轮/触摸/翻页键/滚动条）。没有意图窗、没有超时。
 *  翻页键不要求事件目标在容器内（焦点常在 body）——只按"焦点不在输入控件 + 键命中"判（M2）。 */
function noteScrollIntent(event) {
  try {
    if (event && event.type === "keydown") {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
      if (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key)) return;
    } else if (event && event.target instanceof Node) {
      const target = event.target;
      // delta 全 0 的 wheel 不是滚动（真实 WheelEvent 恒带数值 deltaX/deltaY）；字段缺失的合成事件无法判定，沿用旧行为
      const dy = Number(event.deltaY), dx = Number(event.deltaX);
      const hasDelta = Number.isFinite(dy) && Number.isFinite(dx);
      if (event.type === "wheel" && hasDelta && !(dy || dx)) return;
      // A1（task-12 边界感知）：主容器**内部**的嵌套滚动体（小窗/工具正文/上下文注入正文）在滚轮方向上**还能滚** ⇒ 不是主容器意图；
      // 已到该方向边界 ⇒ 不早退，落到下面的输入层 reader 释放 —— 浏览器会把链式滚动交给父容器，用户得以借此上/下滚主对话。
      // touch / 无数值 delta / 纯横向 wheel：方向不可知，维持 A1 一律早退。
      const nested = target instanceof Element ? target.closest(NESTED_SCROLL) : null;
      if (nested !== null) {
        const box = nestedScrollBox(target, nested);   // task-14：命中的是不可滚滚的包装层 ⇒ 不是主容器意图（维持早退）
        if (box === null) return;
        const canScroll = event.type === "wheel" && hasDelta && dy !== 0
          && (dy < 0 ? box.scrollTop > 0.5 : box.scrollHeight - box.clientHeight - box.scrollTop > 0.5);
        if (canScroll || event.type !== "wheel" || !hasDelta || dy === 0) return;
      }
      const sc = mainScroller();
      if (sc !== null && target !== sc && !sc.contains(target)) return;   // 主容器之外的（侧栏等）不是它
    }
    searchHold = false;    // 通过了输入分类 ⇒ 真实页面输入（滚轮/触摸/翻页键）：搜索闩解除；非翻页键/输入控件/别处滚动都不解
    if (mainScroller() === null) return;
    release("reader");
    ensureTickLoop();
  } catch (err) { ioErrors.input += 1; ioErrors.last = "input: " + String((err && err.message) || err); }
}
/** 点在滚动条上时事件目标就是滚动容器自身（点内容不会）。 */
function onScrollerPointerDown(event) { if (event.target === event.currentTarget) noteScrollIntent(event); }
/** A1/task-14：从 el 到嵌套区域根 root（含）之间，最近的"真能滚动"的元素（computed overflowY ∈ auto|scroll）；
 *  没有这样的元素 ⇒ 命中的只是不可滚的包装层，不按"已到边界"处理。 */
function nestedScrollBox(el, root) {
  for (let node = el; node !== null; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    if (node === root) break;
  }
  return null;
}
/** 追赶速度上限（px/s）：设置非法就回落默认值（单一真源）。 */
function speedValue() {
  const v = Number(state.followMaxSpeed);
  if (!Number.isFinite(v) || v <= 0) { capRejected = { raw: String(state.followMaxSpeed), at: Math.round(performance.now()) }; return DEFAULTS.followMaxSpeed; }
  return v;
}
/** 加速度上限（px/s²）：设置非法就回落默认值（单一真源）。 */
function accelValue() {
  const v = Number(state.followMaxAccel);
  if (!Number.isFinite(v) || v <= 0) { accelRejected = { raw: String(state.followMaxAccel), at: Math.round(performance.now()) }; return DEFAULTS.followMaxAccel; }
  return v;
}
/** task-22：合成 scroll 已停用 —— 原实现用 dispatchEvent 同步重入官方 onScroll（真机 11.9~17.5ms/次，
 *  160Hz 一帧 6.25ms ⇒ 直接掉 2 帧）。官方贴底写现在由 absorbTop / afterForeignWrite 显式吸收或放行，
 *  不再依赖官方 atBottom 判定 ⇒ 这笔派发没有理由。保留**空实现**仅为审计 hook / 诊断字段兼容。 */
function announce() { /* 无操作（task-22 停用） */ }
/* task-22：合成 scroll（announce）已删除 ----------------------------------------------------------
 * 它当年是为了"压官方吸底"（让官方认为我们在底部）。现在官方贴底写由 absorbTop / afterForeignWrite
 * 显式吸收或放行，写权交接也不依赖官方的 atBottom 判定 ⇒ 这笔同步 dispatchEvent 只会让我们在自己的
 * tick 里重入官方 onScroll 处理器（真机实测 11.9~17.5ms/次，160Hz 一帧 6.25ms ⇒ 直接掉 2 帧）。
 * ANNOUNCE_MS / announceCount / announcedTop 等字段保留为诊断（恒 0），不参与任何行为。 */
/** 每帧一次的主窗口推进：唯一的写点在这条路上（吸收器只吸收/放行官方写，不推进）。目标每帧重算。 */
function mainFollowTick(dt) {
  const tGate = performance.now();
  if (!(dt > 0)) dt = 16.667;   // 帧循环首帧 dt=0（prevTs 从 0 起算）：律在 dt=0 时不推进 ⇒ 一次性导航会被当场判成"到位"。按一个 60Hz 帧算。
  if (gateOfficialMode()) { phaseAcc("mainGate", tGate); return false; }   // 选官方档位：零写、置顶/回底收起、速度复位 —— 滚动完全交给官方
  const scroller = mainScroller();
  if (!scroller) { hidePinBar(); phaseAcc("mainGate", tGate); return false; }
  phaseAcc("mainGate", tGate);   // 不在会话视图（设置页/别的面板）：body 上的固定层不能留着
  if (scroller !== followScroller) {
    if (followScroller) {
      followScroller.removeEventListener("scroll", onMainScroll);
      followScroller.removeEventListener("pointerdown", onScrollerPointerDown);
    }
    if (followScroller !== null) gutterSet = false;   // G1：换容器（切会话）后重新加 stable（gutterSet 是"本容器"的一次性闩）
    followScroller = scroller;
    bootAt = performance.now();
    takeOverSnap(scroller);
    followScroller.addEventListener("scroll", onMainScroll, { passive: true });
    followScroller.addEventListener("pointerdown", onScrollerPointerDown, { passive: true });
    followWrote = null;
    baseSt = -1; baseSh = -1;   // 换容器：几何基线作废（下一帧重新同步）
    tailWant = -1;              // 换容器：跟随目标低通作废
    resetVel(mainVel);   // 换容器：速度复位
    // 换容器 = 会话边界。**无条件语义判定**（不依赖标志、与 syncSession 的先后顺序无关）：
    //   新容器已经在末端 ⇒ rearm()（接回跟尾，本来就在底、不会滑）；
    //   否则 ⇒ 交出写权、只钉不跟（别把新会话从顶部一路滑到底）；
    //   等官方/读者真把它放到末端，再由 onMainScroll 与 tick 的「落末端」规则接回。
    if (scroller.scrollHeight > scroller.clientHeight && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 0.5) rearm();
    else { release("reset"); goalKind = "none"; goalEl = null; navActive = false; }
  }

  // task-19 ②：主容器几何每帧只读一次（sh/ch/top），此后全帧复用；写后位置用唯一一次回读 top1 兜住浏览器 floor 钳位。
  const sh0 = scroller.scrollHeight;
  const ch0 = scroller.clientHeight;
  const top0 = readTop(scroller);
  frameSh = sh0; frameCh = ch0; frameTop = top0;
  followHeight = sh0;
  { const tPin = performance.now(); pinTick(scroller); phaseAcc("pin", tPin); }   // 置顶条：读一遍行/容器位置并摆好（固定层，不改会话布局）
  const tPlan = performance.now();
  readCount += 2;   // 本帧主容器的两次强制布局读（scrollHeight/clientHeight）
  // 口径（S2-2）：readCount = 插件主动发起的强制布局读。尺寸读 = 上面这行 + 每窗那行；scrollTop 读统一走 readTop 自增
  // （含写后回读）。getBoundingClientRect 与事件侧 onMainScroll/pinTick 不计（量纲不同），勿据此判断"读很少"。
  const floor = Math.max(0, sh0 - ch0);
  frameToken += 1; vtStamp = frameToken; vtRect = null;   // task-19 ②：viewTop 帧内 rect 缓存只在本次 tick 内有效
  const mark = (goal, gap, rateV, capV, moving, baseTop) => {
    lastStep = { writer, goal, gap: +gap.toFixed(2), base: +(baseTop === undefined ? scroller.scrollTop : baseTop).toFixed(2), rate: +rateV.toFixed(3), vMax: capV,
      vFeed: +mainVel.vFeed.toFixed(2), vChase: +mainVel.vChase.toFixed(2), a: accelValue(),
      dt: +dt.toFixed(2), moving, nav: navActive ? 1 : 0, floor: +floor.toFixed(1), releaseReason, rearmCount };
  };
  if (writer === WRITER_READER) {     // 读者接管 / 会话恢复期：零程序化写
    // 接回跟尾的唯一语义信号：文档可滚动、且视图确实在末端（官方恢复到位 / 读者滚到底 / 换容器时已在底）
    if (scroller.scrollHeight > scroller.clientHeight && floor - scroller.scrollTop <= 0.5) rearm();   // 契约：reader 态"落末端"接回（static-check 字面量；仅读者分支，不影响滑行帧）
    else if (floor === 0 && releaseReason !== "reset") rearm();   // A6：内容不足一屏 ⇒ floor=0 本身就是贴底（短会话滚一次不再永久停跟）；刚换容器（reset）仍交给官方恢复
    navRecheck = null;                              // 读者接管：未决复算作废（不抢输入）
    updateJumpGate(floor - top0, false);
    mark("none", floor - top0, 0, 0, false, top0);
    return false;
  }
  // S1-4/task-17：element 到位后的**有界观察窗口**。窗口内只观察，|offset|>2px 才纠正；
  // 纠正走既有 navigate({kind:"element"})（唯一移动律）；两次纠正间隔 ≥ NAV_WATCH_MIN_GAP_MS，上限 NAV_WATCH_MAX。
  // 退出：窗口到期 / 次数用完 / 目标断开 / writer!==us / 新导航（navigate 清）/ 读者(release)/rearm/hold/换会话/官方档/dispose。
  if (navRecheck !== null && !navActive) {
    const rc = navRecheck;
    if (writer !== WRITER_US || !rc.el.isConnected || disposed) navRecheck = null;
    else if (performance.now() > rc.until || rc.left <= 0) navRecheck = null;   // 窗口结束：不再写、不再排帧（尾部自然停）
    else {
      rc.tick = (rc.tick === undefined ? 0 : rc.tick) + 1;
      if (rc.tick % NAV_OBSERVE_EVERY === 0) {      // task-19：观察降频（窗口期 rect 读减到 1/NAV_OBSERVE_EVERY）
        const wantRe = Math.max(0, Math.min(floor, viewTop(scroller, rc.el) - SETTLE_PAD));
        const off = Math.abs(wantRe - top0);
        if (off > 2 && performance.now() - rc.lastAt >= NAV_WATCH_MIN_GAP_MS) {
          rc.left -= 1; rc.lastAt = performance.now();
          navigate({ kind: "element", el: rc.el });   // navigate 内部会清 navRecheck —— 放回同一窗口/剩余次数
          navRecheck = rc;
        }
      }
    }
  }
  let want = null;   // 每帧重算：tail 跟着 floor 长
  if (goalKind === "element") {
    if (goalEl === null || !goalEl.isConnected) {      // task-32：目标丢了 ⇒ 协调作废（立刻折）
      const retry = settleTurn !== null ? lastUserRow() : null;   // S1-2：本轮提问行被重挂载 ⇒ 不放弃导航，按 lastUserRow 重试一次
      goalEl = null; goalKind = "none"; navActive = false;
      if (settleTurn !== null) clearSettle("lost");
      if (retry !== null && retry.isConnected) navigate({ kind: "element", el: retry });
    }
    else want = Math.max(0, Math.min(floor, viewTop(scroller, goalEl) - SETTLE_PAD));
  } else if (goalKind === "position") want = Math.max(0, Math.min(floor, goalPos));
  else if (goalKind === "tail") want = navActive ? floor : smoothTail(floor, dt);   // 一次性回底导航不走低通（目标静止）；跟随才低通
  if (want === null) {   // goal=none：我方停在一个位置（导航到位/锚定中），不写
    updateJumpGate(floor - top0, false);
    mark("none", floor - top0, 0, 0, false, top0);
    // S1-4/task-17：观察窗口开启时 goal 已是 none，但必须继续排帧（否则窗口只能被动等外部唤醒）
    return navRecheck !== null;
  }
  const gap = want - top0;
  // 一次性导航的安全网：首帧按真实距离武装；只有真到点才续期（旧版的固定 1400ms 会把远跳当超时 → 中途停/掉回限速）
  if (navActive) {
    if (navUntil === 0) navUntil = performance.now() + navBudget(Math.abs(gap));
    else if (performance.now() > navUntil) {
      navUntil = performance.now() + navBudget(Math.abs(gap));
      lastNav = { kind: goalKind, why: "renew", to: Math.round(top0), ms: +(performance.now() - navT0).toFixed(1) };
    }
  }
  const vMax = navActive ? 0 : (goalKind === "tail" ? speedValue() : 0);   // 一次性导航不设追赶上限；跟随用 followMaxSpeed(px/s)

  const bootOver = moveCount > 20 || performance.now() - bootAt >= 300;
  if (bootOver && !gutterSet) { gutterSet = true; try { scroller.style.scrollbarGutter = "stable"; } catch { /* ignore */ } }
  const tSlide = performance.now();
  const moving = slide(scroller, want, dt, vMax, mainVel, top0, "main", floor);   // task-19：cur 用本帧已读值；maxHint=floor 让"未写成"的预测不再回读
  if (navActive && moving) navProgressAt = performance.now();   // task-12：有推进就给看门狗续期
  phaseAcc("mainSlide", tSlide);
  phaseAcc("mainPlan", tPlan);
  if (performance.now() > settleUntil) settleTimeout();   // 兜底：超时即清（滑行没到位也不许把折叠永久压住）
  const top1 = readTop(scroller);   // task-19：全帧唯一一次写后回读（浏览器按 floor 钳位，预测值不足以还原真实落点）
  frameTop = top1;
  if (navActive && Math.abs(want - top1) <= 0.5) {   // 一次性导航到位（按落点判，不看 moving：dt=0 那帧不推进）：tail 保留目标（转为跟随），element/position 撤目标
    const arrivedEl = goalKind === "element" ? goalEl : null;
    navActive = false;
    lastNav = { kind: goalKind, why: "done", to: Math.round(top1), ms: +(performance.now() - navT0).toFixed(1) };
    if (goalKind === "element" || goalKind === "position") { goalEl = null; goalKind = "none"; }
    clearTimeout(navWatchdog); navWatchdog = 0;      // task-12：到位 ⇒ 看门狗撤掉
    // S1-4/task-17：element 到位 ⇒ 开启/延续有界观察窗口（同一目标延续 until/left/lastAt，不被自己的纠正重置）
    navRecheck = arrivedEl !== null && arrivedEl.isConnected
      ? (navRecheck !== null && navRecheck.el === arrivedEl
          ? { el: arrivedEl, until: navRecheck.until, left: navRecheck.left, lastAt: navRecheck.lastAt, tick: navRecheck.tick }
          : { el: arrivedEl, until: performance.now() + NAV_WATCH_MS, left: NAV_WATCH_MAX, lastAt: 0, tick: 0 })
      : null;
    if (settleTurn !== null) clearSettle("done");    // 滑到提问处 ⇒ 收工：该轮折叠交给下一次扫描（task-21）
  }
  mark(goalKind, gap, expStep(gap, dt), vMax, moving, top1);
  updateJumpGate(floor - top1, goalKind === "tail");
  if (moving) ensureTickLoop();   // task-22：不再派发合成 scroll（原 announce 每帧重入官方 handler 11~17ms）
  // task-12：不得在这里用 if (moving || navActive) 续帧 —— 此刻 ticking 仍为 true，ensureTickLoop 会早退（空操作）；
  // 真正续帧会变成不可达目标下的永久 rAF 空转。卡住的一次性导航改由上面的看门狗有界终止（清 navActive/goal + clearSettle）。
  // S1-4/task-17：窗口开启期间由帧驱动观察（有界 2s）；窗口到期或退出条件命中后 navRecheck=null，循环自然停、零残留。
  return moving || navRecheck !== null;
}
/** scroll 事件只做两件事：reader 态下"位置真的落到末端"（事实 ⇒ 取回写权），以及叫醒帧循环维护按钮显隐。
 *  释放判定不在这里：在输入层（真实输入）与写层（非贴底写 = 别的程序在导航）。 */
function onMainScroll(event) {
  const el = event.currentTarget;
  const floor = Math.max(0, el.scrollHeight - el.clientHeight);
  if (writer === WRITER_READER && floor - el.scrollTop <= 0.5) rearm();   // 规则 4：读者落到末端 ⇒ 取回写权、目标=尾
  ensureTickLoop();
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
const TAIL_TAU_MS = 150;     // 跟随目标（floor）的一阶低通时间常数：floor 是 React 按块提交的阶梯，低通后再喂唯一律
let tailWant = -1;            // 低通状态（仅 goalKind==="tail" 用；换目标/交权/换容器时作废）
/** 跟随目标的低通：消掉"块间 gap→0 停住、块到跳一下"的目标锯齿。收缩/首次/换目标时直接对齐，不慢慢爬。 */
function smoothTail(floor, dt) {
  if (tailWant < 0 || tailWant > floor + 1) { tailWant = floor; return floor; }
  tailWant += (floor - tailWant) * (1 - Math.exp(-dt / TAIL_TAU_MS));
  return tailWant;
}
const SETTLE_PAD = 12;       // 提问行停在视口顶端往下多少像素
const SETTLE_MAX_MS = 1400;  // 一次性导航预算的下限（安全网，不是正常终止条件）
/** 一次性导航的"安全网"预算（ms）：新律受加速度上限约束，位移近似三角形 ⇒ 覆盖 x 约需 2·sqrt(2x/a)。
 *  取 2× 三角形时间 + 600ms 余量，且不小于 SETTLE_MAX_MS。到点只**按剩余距离续期**，绝不把它当终止条件
 *  （正常终止只有两个：到位 |dy|≤0.5、目标节点消失）。 */
function navBudget(dist) {
  const a = accelValue();
  const x = Math.max(0, Number(dist) || 0);
  return Math.max(SETTLE_MAX_MS, Math.ceil(2 * Math.sqrt(2 * x / a) * 1000) + 600);
}
/** task-12：有界终止卡住的一次性导航。目标不可达时 slide 零步 ⇒ 帧循环自行停（无 rAF），
 *  所以不能靠"每帧零进展计数"；用一次性看门狗：预算到期且期间零进展 ⇒ 清 navActive/目标并走既有 timeout 清理。
 *  复用 "timeout" 而不新增 reason：static-check 钉死 clearSettle 恰好 9 个清理点（多一个即视为新闩锁）。 */
function abortStuckNav() {
  navActive = false; navUntil = 0; goalEl = null; goalKind = "none"; navProgressAt = 0;
  clearTimeout(navWatchdog); navWatchdog = 0;
  const sc = mainScroller();
  navAbortCount += 1;
  lastNavAbort = { why: "stuck", armedAt: Math.round(navArmedAt), at: Math.round(performance.now()), budgetMs: Math.round(navBudgetMs), top: sc === null ? 0 : Math.round(sc.scrollTop) };
  settleTimeout();                                   // 复用既有 timeout 清理（不新增 clearSettle 字面量）
  updateJumpGate(sc === null ? 0 : Math.max(0, sc.scrollHeight - sc.clientHeight) - sc.scrollTop, false);
}
/** 超时/卡住兜底清理的共享出口：timeout 清理只保留这一处调用点（static-check 钉死恰好 9 个清理点）。 */
function settleTimeout() { if (settleTurn !== null) clearSettle("timeout"); }
function armNavWatchdog(delay) {
  clearTimeout(navWatchdog);
  navWatchdog = setTimeout(() => {
    navWatchdog = 0;
    if (disposed || !navActive) return;
    if (performance.now() - navProgressAt < NAV_STALL_MS) { armNavWatchdog(NAV_STALL_MS); return; }   // 仍在推进：续期，不终止
    abortStuckNav();
  }, Math.max(NAV_STALL_MS, delay));
}
let wasRunning = false;      // 上一次扫描时这一轮是否在跑（true→false = 刚跑完）
let lastUserKey = null;      // 最近一次见到的"你最新那条消息"的行 key（回尾判据：key 变了 = 你刚发了新消息）
/* ---- 一轮跑完的「先滑后折」协调（task-21）：一次性标记，不是历史闩锁 ----------------
 * 起效时记下这一轮的轮号 ⇒ syncTurns 只压住**该轮**的折叠；滑行到位/超时/交权/会话边界/官方档位/dispose 即清。 */
let settleTurn = null;       // 正在为哪一轮协调（null = 没在协调）
let settleUntil = 0;         // 兜底超时（performance.now() 时刻）
let lastSettle = null;       // 诊断：最近一次协调 {turn, why, at}
/** 元素顶端在滚动容器里的位置（绝对 scrollTop 坐标）。
 *  task-19 ②：tick 帧内对主容器复用 frameTop + 一次容器 rect（vtRect），同一帧多次 viewTop 不再重复强制布局读；
 *  帧外（scan/navigate 等）走原式，语义与缓存无关。 */
function viewTop(scroller, el) {
  if (scroller === followScroller && vtStamp === frameToken) {
    if (vtRect === null) vtRect = scroller.getBoundingClientRect();
    return frameTop + el.getBoundingClientRect().top - vtRect.top;
  }
  return scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}
/** 复刻 Element.scrollIntoView 的**纵向**目标（主容器坐标）：block = start(默认)|center|end|nearest。
 *  只做主容器一个滚动上下文的对齐（祖先链由调用处保证：node 已在容器内）；返回未 clamp 的目标，由调用方按 floor 收口。 */
function scrollIntoViewTarget(sc, node, block) {
  const scRect = sc.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const height = rect.height || (rect.bottom - rect.top);
  const top = sc.scrollTop + rect.top - scRect.top;
  const view = sc.clientHeight;
  const mode = block === "center" || block === "end" || block === "nearest" ? block : "start";
  if (mode === "center") return top - (view - height) / 2;
  if (mode === "end") return top - (view - height);
  if (mode === "nearest") {
    const cur = sc.scrollTop;
    if (top < cur) return top;
    if (top + height > cur + view) return top + height - view;
    return cur;
  }
  return top;
}
/** 会话里所有用户发言行（文档顺序）：置顶条与「跑完回到提问处」共用。 */
function userRows() {
  return chatRows().filter((el) => el.getAttribute("data-chat-flow-kind") === "user");
}
const Q_TOOL_SEL = '[data-tool="ask_user_question"], [data-tool="request_user_input"]';   // 提问工具卡（当场回答渲染在卡里）
const Q_ANSWER_SEL = "[data-answer], [data-question-answer], [data-tool-result], [class*='_answer'], [class*='_result']";
const isQuestionCard = (el) => el.matches(Q_TOOL_SEL) || el.querySelector(Q_TOOL_SEL) !== null;
/** 提问卡文案：卡里能取到**用户的回答** ⇒ "答: …"；取不到 ⇒ 问题本身 "问: …"；两条都取不到 ⇒ null（不进候选）。 */
function questionCardText(row) {
  let answer = row.getAttribute("data-answer") || "";
  if (!answer) { const el = row.querySelector(Q_ANSWER_SEL); if (el !== null) answer = rowText(el, undefined, 200); }
  answer = String(answer).replace(/\s+/g, " ").trim();
  if (answer) return ("答: " + answer).slice(0, 200);
  const q = String(rowText(row, (n) => n.matches("[class*='_time'],[class*='_actions']"), 400)).replace(/\s+/g, " ").trim();
  return q ? ("问: " + q).slice(0, 200) : null;
}
/** H19f：置顶条数据源唯一定义（fold 与 native 共用） —— 提问行 ∪ 迟到回答行 ∪ **带提问工具卡的行**（当场回答）。 */
function pinSource(rows) {
  return rows.filter((el) => {
    const k = el.getAttribute("data-chat-flow-kind");
    if (k === "user") return true;
    if (state.keepUserQuestions !== true) return false;
    if (k === "question-reply" || k === "user-question-reply" || el.querySelector("[data-question-reply]") !== null) return true;
    return isQuestionCard(el) && questionCardText(el) !== null;   // 当场回答永远没有 question-reply 行，只能从工具卡取
  });
}
function lastUserRow() {
  const rows = userRows();
  return rows.length === 0 ? null : rows[rows.length - 1];
}
/** 结束「先滑后折」协调（一次性）：清掉标记后立刻排一次扫描，让该轮按正常规则折叠（不留历史闩锁）。 */
/** 记录"用户当场操作过的轮次"（manualState 的**唯一**写入口）：值真的变了就立刻取消 settle 协调。
 *  task-23：滑行途中用户手动折叠/展开该轮 ⇒ 当场按用户操作折，不再等滑行到位。 */
function setManual(turn, value) {
  if (turn === null || turn === undefined) return;
  if (manualState.get(turn) === value) return;
  manualState.set(turn, value);
  clearSettle("manual");
}
/** 结束「先滑后折」协调（一次性）：清掉标记后立刻排一次扫描，让该轮按正常规则折叠（不留历史闩锁）。 */
function clearSettle(reason) {
  if (settleTurn === null) return;
  lastSettle = { turn: String(settleTurn), why: reason, at: Math.round(performance.now()) };
  settleTurn = null; settleUntil = 0;
  if (reason !== "dispose") { try { schedule(); } catch { /* ignore */ } }   // 折叠由扫描执行：清完立刻排一次
}
/** 本轮跑完：滑到本轮提问处（我方导航）。**只在触底吸附**（writer=us ∧ goal=tail ∧ 非一次性导航）时起效；
 *  读者接管 / 停在中途（goal=none|element）/ 官方档位 / 开关关闭 ⇒ 一律不动。 */
function settleToPrompt(flow) {
  if (state.settleToPrompt === false) return false;
  if (state.mode !== "fold") return false;                                      // 官方档位：完全不接管
  if (writer !== WRITER_US || goalKind !== "tail" || navActive) return false;   // 只在"视图钉在末端"时起效
  const row = lastUserRow();
  if (row === null) return false;
  navigate({ kind: "element", el: row });
  return true;
}

/* ----------------------------------------------------- 置顶显示提问 -- */
let pinRows = [];              // 所有用户发言行（扫描时更新，文档顺序）
/* H19b 提问卡自动展开：登记与点击分离 —— 点击挪出扫描帧（不再把 React 同步提交的 ~30ms 压在我们的扫描上）。
   去重键 = 轮次（data-chat-turn）；没有轮号的卡片退回按元素去重。 */
const qCardTurns = new Set();       // 已自动展开过的提问卡所在轮次
const qCardEls = new WeakSet();     // 没有轮号时的兜底
const qCardQueued = new WeakSet();  // 已登记待点击（跨扫描不重复入队）
let qCardQueue = [];
let qCardRaf = 0;
function qCardKey(card) {
  const row = card && typeof card.closest === "function" ? card.closest(ROW) : null;
  const turn = row === null ? null : row.getAttribute("data-chat-turn");
  return turn === null || turn === "" ? null : turn;
}
function qCardHandled(card) {
  const turn = qCardKey(card);
  return turn === null ? qCardEls.has(card) : qCardTurns.has(turn);
}
function markQCard(card) {
  const turn = qCardKey(card);
  if (turn === null) qCardEls.add(card); else qCardTurns.add(turn);
  try { card.dataset.dshsfKeepOpen = "1"; } catch { /* ignore */ }
}
/** 下一帧再点：扫描帧里不再背 React 提交的成本。 */
function runQCardQueue() {
  qCardRaf = 0;
  const batch = qCardQueue; qCardQueue = [];
  for (const card of batch) {
    if (!card.isConnected || qCardHandled(card)) continue;
    const target = disclosureTarget(card);
    if (!target || target.getAttribute("aria-expanded") === "true") { markQCard(card); continue; }
    if (clickOnce(target)) markQCard(card);
  }
}
/* 思考/工具自动展开：与提问卡同一手法 —— 扫描只登记，合成点击挪到下一帧。
   它们的合成点击同样会触发 React 同步提交（真机 cost 里 openThink 单次最高 18ms），不该算进扫描成本；
   打标（tagThinkWindow）仍在点击后同一个 rAF 里做，避免"先闪一下没有小窗的样子"。 */
const autoOpenQueued = new WeakSet();
let autoOpenQueue = [];
let autoOpenRaf = 0;
function queueAutoOpen(kind, root) {
  if (autoOpenQueued.has(root)) return;
  autoOpenQueued.add(root);
  autoOpenQueue.push({ kind, root });
  if (autoOpenRaf === 0 && typeof requestAnimationFrame === "function") autoOpenRaf = requestAnimationFrame(runAutoOpenQueue);
}
function runAutoOpenQueue() {
  autoOpenRaf = 0;
  const batch = autoOpenQueue; autoOpenQueue = [];
  for (const item of batch) {
    const root = item.root;
    autoOpenQueued.delete(root);
    if (!root.isConnected || root.closest("[data-dshsf-folded]") !== null) continue;
    if (item.kind === "think") {
      if (state.autoExpandReasoning === false || thinkOpen(root)) continue;
      if (openThink(root)) sparks.focus(root.querySelector(THINK_BODY));   // 展开成功：火星马上挂到新窗
    } else {
      if (state.autoExpandTools === false || toolOpen(root)) continue;
      openTool(root);
    }
  }
}
let capRejected = null;
let accelRejected = null;    // 跟随加速度上限非法时的 {raw, at}
let foreignLanded = 0;
const releaseBy = { reader: 0, external: 0, reset: 0 };   // 仪器：按 reason 分组的释放计数；external 为死字段（该释放入口已在 task-12 取消），仅兼容保留
let rearmCount = 0;                                      // 仪器：取回写权次数
let lastForeign = null;         // 仪器：最近一笔放行的官方非贴底写（别的程序在导航）
let scanErrors = 0;             // F4：扫描期异常计数（诊断）
let lastScanError = null;        // H19b：已经由我们展开过的提问卡（WeakSet；用户之后手动折回不再抢开）
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
    if (pinRow === null || !pinRow.isConnected) return;
    navigate({ kind: "element", el: pinRow, instant: true });   // 我方导航：取回写权、只换目标（用户发起 ⇒ reduce 下瞬跳）；触底时点它也不会被官方贴底写拉回底部
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
/** 选官方档位（mode != fold）：整个运动层退出滚动 —— 置顶条与回底按钮收起、零写、速度态复位。返回"是否已交出"。 */
function gateOfficialMode() {
  if (state.mode === "fold") return false;
  clearSettle("official");                           // 官方档位：协调作废（这一档我们完全不接管）
  clearNavIntent();
  tailWant = -1;
  hidePinBar();                                                              // 置顶条收起
  try { document.documentElement.removeAttribute("data-dshsf-jumpgate"); } catch { /* ignore */ }
  navActive = false;                                                         // 一次性导航作废
  navRecheck = null;                                                         // S1-4：官方档位 ⇒ 观察窗口立即退出
  if (goalKind === "element" || goalKind === "position") { goalEl = null; goalKind = "none"; }
  resetVel(mainVel);                                                         // 速度态复位
  for (const el of liveWindows) {                                            // 小窗回底按钮也收起
    const jump = el.querySelector(":scope > [data-dshsf-jump]");
    if (jump !== null) jump.removeAttribute("data-dshsf-visible");
  }
  lastStep = { writer, goal: "off", gap: 0, base: 0, rate: 0, vMax: 0, vFeed: 0, vChase: 0, a: 0, dt: 0, moving: false, nav: 0, floor: 0, releaseReason: "mode", rearmCount };
  return true;
}
function pinTickInner(scroller) {
  pinRects += 2;   // 该函数每帧固定两次 getBoundingClientRect 级别测量（行 + 容器）
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
  const cachedPin = pinTextOf.get(row);              // A13/task-20：observer 定向失效为主（按 record 回溯到行删除）；
  const rawPin = String(row.textContent || "");      // 原始文本变化做兜底（不是长度）⇒ 等长改写同样刷新，不再依赖 len
  let text;
  if (cachedPin !== undefined && cachedPin.raw === rawPin) text = cachedPin.text;
  else {
    if (isQuestionCard(row)) text = questionCardText(row) || "";   // task-23：提问卡 ⇒ "答: …"（取不到回答则 "问: …"）
    else {
      text = promptText(row);
      // H19：回答行加「答:」前缀，与用户提问行区分（只描述作用）
      const rk = row.getAttribute("data-chat-flow-kind");
      if (rk === "question-reply" || rk === "user-question-reply" || row.querySelector("[data-question-reply]") !== null) text = "答: " + text;
    }
    pinTextOf.set(row, { text, raw: rawPin });
  }
  if (bar.textContent !== text) bar.textContent = text;
  if (show !== bar.hasAttribute("data-dshsf-visible")) {
    if (show) bar.setAttribute("data-dshsf-visible", "");
    else bar.removeAttribute("data-dshsf-visible");
  }
}

/** 官方那颗回底按钮的**点击**：不阻止官方那笔贴底写（会被吸收器吞掉），只发我方导航意图。 */
function onToBottomClick(event) {
  if (synthetic || !(event.target instanceof Element)) return;
  const btn = event.target.closest("button[class*='_toBottom']");   // 图标在按钮里，取最近的那个按钮
  if (btn === null || btn.closest("[data-dshsf-window], [data-dshsf-textwindow]") !== null) return;   // 小窗里的按钮不是它
  // 不阻止官方那笔贴底写（会被吸收器吞掉）：取回写权 + 目标=尾，一次性滑行不设 cap。
  // 不能按 animations 早退：writer=us / goal=none（停在中途）时官方那笔写会被吸收，点了会"没反应"。
  navigate({ kind: "tail", instant: true });   // 用户发起 ⇒ reduce 下瞬跳（跟随不看 reduced-motion）
}

/**
 * 主窗口的回底按钮**不自绘**：外观、位置、点击行为都用官方那颗（[class*='_toBottomSlot'] 里的按钮），
 * 我们只接管"它什么时候出现"——CSS 默认把它藏起来，判定要显示时才给 html 挂 data-dshsf-jumpgate。
 * 点亮 = 我方目标不是尾（读者接管 / 停在中途）且确实离底（gap>24）；熄灭 = 回到贴底（gap<12）或关掉开关。
 */
function updateJumpGate(gap, follow) {
  const root = document.documentElement;
  if (state.showJumpButton === false) { root.removeAttribute("data-dshsf-jumpgate"); return; }
  if (root.hasAttribute("data-dshsf-jumpgate")) { if (gap < 12) root.removeAttribute("data-dshsf-jumpgate"); }
  else if (gap > 24 && !follow) root.setAttribute("data-dshsf-jumpgate", "");
}

/**
 * 写层：官方/第三方对 scrollTop 的写入只有两种意图（不再有旧的"距离门槛"、不再有 800ms 让路窗）——
 *   目标 == floor ⇒ 贴底写：writer=us 时吸收（恢复我方位置，由我们的节奏落屏）；writer=reader 时原样放行。
 *   目标 ≠ floor ⇒ 原样放行 + 重设基准（followWrote = 落地值；导航中同步重设兜底窗）：**不交权、不改 goal**。
 *  （Lead 裁决的规则 2 改写：release 只剩"读者真实输入"与"会话边界"两个入口，release("external") 取消。）
 */
let ownWrite = false;        // 我方写入：setter 直接放行
let snapTaken = null;        // 已接管的容器：{ el }
let snapBlocked = 0;         // 诊断：被吸收（丢掉）的官方贴底写入次数
let extWrites = 0;           // 诊断：观测到的 scrollBy/scrollIntoView 写入次数
let lastExtWrite = null;     // 诊断：最近一笔外部写 {which, from, landed, floor, stack}
let protoIntoView = null;    // Element.prototype.scrollIntoView 的原始实现（装一次；dispose 还原）
let bootAt = 0;              // 启动豁免起点（接管时置为 performance.now()）
const backfillLanded = (sc, from) => { requestAnimationFrame(() => { if (lastExtWrite !== null && lastExtWrite.from === from) lastExtWrite.landed = Math.round(sc.scrollTop); }); };
/** 物理像素对齐（Windows 150% 缩放 dpr=1.5：1 物理像素 = 1/dpr 布局像素；浏览器把 scrollTop 吸附到物理像素）。 */
const pxDpr = () => { const v = Number(window.devicePixelRatio); return Number.isFinite(v) && v > 0 ? v : 1; };
const snapPx = (v) => { const d = pxDpr(); return d === 1 ? v : Math.round(v * d) / d; };
let writeCount = 0;      // 诊断：真实落地的 scrollTop 写次数（trace 的 writes 用它，不再用"推进帧数"）
/** 唯一写点：只有它改 scrollTop；followWrote 只在写主容器时更新。
 *  task-19：写入值先按物理像素对齐；对齐后与当前物理像素相同 ⇒ **不写**（余量留在 want-cur 上，下一帧自然累积）。 */
const writeTally = {};   // task-22 诊断：本帧每笔写是谁发的（trace/probe 用）
function writeTop(el, value, curHint, src) {
  const cur = curHint === undefined ? readTop(el) : curHint;    // task-22：调用方已知当前值就别再读（每次读都会强制布局）
  const snapped = snapPx(value);
  if (src !== undefined) writeTally[src] = (writeTally[src] || 0) + 1;
  if (snapped === snapPx(cur)) return false;                     // 物理像素没变：空帧零成本（读回值可能未对齐，不能直接比数值）
  ownWrite = true;
  try { el.scrollTop = snapped; } finally { ownWrite = false; }
  writeCount += 1;
  moveCount += 1;                                              // 只统计真的落地过的写（bootOver 判据同源）
  if (el === followScroller) followWrote = readTop(el);       // 浏览器可能钳位：以落地值为准
  return true;
}
function takeOverSnap(el) {
  if (snapTaken !== null && snapTaken.el === el) return;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || typeof desc.get !== "function" || typeof desc.set !== "function") return;
  if (snapTaken !== null) { try { delete snapTaken.el.scrollTop; delete snapTaken.el.scrollTo; delete snapTaken.el.scrollBy; } catch { /* ignore */ } }
  const taken = { el };
  /** 贴底写（目标 == floor）的唯一判据：writer=us ⇒ 吸收（恢复我方位置）；writer=reader ⇒ 放行。
   *  非贴底 JS 写统一交给 afterForeignWrite()（task-12：先落地 → 微任务倒回 → 设为幂等目标）。 */
  const absorbTop = (next) => {
    const tAbs = performance.now();
    try {
      if (ownWrite) return false;
      if (state.mode !== "fold") return false;               // 官方档位：吸收器停手，官方吸附原样生效（task-15 追加）
      const fl = Math.max(0, el.scrollHeight - el.clientHeight);
      if (fl - next > 1) return false;                       // 非贴底：交给 afterForeignWrite（它负责消费 navIntent）
      clearNavIntent();                                      // 贴底写也是一笔外来写：消费掉这个位
      // 除官方档外一律接管：读者态**吞掉不落地**（读者在哪就停在哪；写压根没落地 ⇒ 不需要回写 ⇒ 不破坏"读者态零程序化写"）。
      // 例外：会话切换/容器变更（releaseReason === "reset"）那一次是官方在"恢复位置"，必须放行。
      if (writer === WRITER_READER && releaseReason !== "reset") { snapBlocked += 1; ensureTickLoop(); return true; }
      if (writer === WRITER_READER) return false;
      // goal=none（停在中途）：官方吸附也不落地 —— "回尾"改由我们自己的判据（出现新 user 消息）负责。
      snapBlocked += 1;
      const keep = followWrote === null ? desc.get.call(el) : followWrote;
      if (desc.get.call(el) !== keep) { ownWrite = true; try { desc.set.call(el, keep); } finally { ownWrite = false; } }
      ensureTickLoop();
      return true;                                           // 吸收：恢复我方位置，不让它落地
    } catch (err) { ioErrors.absorb += 1; ioErrors.last = "absorb: " + String((err && err.message) || err); return false; }
    finally { phaseAcc("absorb", tAbs); }
  };
  /** 落地后的统一处置（task-12：接管主容器**全部** JS 写）。规则：
   *   ① 落点 == floor ⇒ 贴底写，维持现状（us 吸收 / reader 放行）；
   *   ② 落点 ≠ floor 且 writer===us ⇒ 这笔写算**我方目标**：先让它落地（官方写完立刻读回，必须读到真值），
   *      再在 queueMicrotask（paint 之前）把位置倒回旧值 + 设 goal={position, px}，由唯一律平滑滑过去；
   *   ③ writer===reader ⇒ 一律原样放行（已知限制：读者态下不接管外来定位，写进报告）。 */
  let claimSeq = 0;                                    // 最近一次接管的序号：被更新的接管取代时不回倒
  const afterForeignWrite = (from, claimPx) => {
    const tAbs = performance.now();
    try {
      if (ownWrite) return;
      if (state.mode !== "fold") return;                     // 官方档位：不接管、不重设基准，全部原样放行（task-15 追加）
      const intent = hasNavIntent();                         // 输入位：真实输入 ⇒ 导航
      clearNavIntent();
      const fl = Math.max(0, el.scrollHeight - el.clientHeight);
      const landed = desc.get.call(el);
      const sh1 = el.scrollHeight;
      const st0 = baseSt < 0 ? from : baseSt;                // 帧基线（没有则退化为写点前的值）
      const sh0 = baseSh < 0 ? sh1 : baseSh;
      const compensated = Math.abs((landed - st0) - (sh1 - sh0)) <= 2;   // 几何位：位移能否被同期内容高度变化解释
      const nav = intent || !compensated;                    // 两者取或
      const px = Number.isFinite(claimPx) ? claimPx : landed;
      baseSt = landed; baseSh = sh1;                         // 收尾：这笔写之后的观察基线
      if (fl - px <= 1) {                              // ① 贴底写：只有 scrollTo/scrollBy 落到 floor 的路径会走到这里
        //    （赋值型贴底写在 absorbTop 就被吞了）。全接管后这里也不再"采纳为回尾"——
        //    回尾只认一条：**出现你新发的一条消息**（见 scanStructureInner 的边沿判据）。
        if (writer === WRITER_READER && releaseReason !== "reset") {
          snapBlocked += 1;
          if (from !== landed) { ownWrite = true; try { desc.set.call(el, from); } finally { ownWrite = false; } }   // 落到 floor 也吞：恢复到读者位置
          return;
        }
        if (writer === WRITER_READER) { passedOfficial += 1; return; }   // reset：让官方恢复到位（计数照旧记"放行"）
        snapBlocked += 1;
        const keep = followWrote === null ? landed : followWrote;
        if (landed !== keep) { ownWrite = true; try { desc.set.call(el, keep); } finally { ownWrite = false; } }
        ensureTickLoop();
        return;
      }
      foreignLanded += 1;
      lastForeign = { which: "write", from: followWrote === null ? null : Math.round(followWrote), to: Math.round(px), floor: Math.round(fl), at: Math.round(performance.now()) };
      if (writer === WRITER_READER) {                  // ③ 读者：原样放行
        if (el === followScroller) followWrote = landed;
        return;
      }
      if (!nav) {                                      // ④ 保位/对齐（无输入且位移可由布局解释）：task-6 裁决 —— 放行 + 重设基准，不接管、不改 goal
        if (el === followScroller) followWrote = landed;
        if (navActive && goalKind === "position") goalPos += (landed - from);   // 远跳期间官方分页 align：目标随视口一起平移，避免拉锯
        return;
      }
      if (Math.abs(px - from) <= 0.5) return;          // 有导航意图但没动（如 scrollBy(0,0)）：无可接管
      if (navActive && goalKind === "element") {        // S1-1：元素滑行（回到提问处/置顶条）期间，外来写不得改目标
        if (el === followScroller) followWrote = landed;   // 放行 + 上面已重设基线：目标不动，滑行继续
        resetVel(mainVel); tailWant = -1;               // task-11：落点是外来跳变 ⇒ 作废旧方向的 approach 速度态（否则方向翻转后会零步停机）
        return;
      }
      const seq = ++claimSeq;                          // ② writer=us：已落地 ⇒ 微任务倒回 + 设我方目标
      queueMicrotask(() => {
        try {
          if (disposed || snapTaken === null || snapTaken.el !== el) return;   // 收摊/换容器：不接管
          if (seq !== claimSeq) return;                                        // 被更新的一笔接管取代
          if (writer !== WRITER_US) return;                                    // 期间读者接管 / 官方档位：不接管
          ownWrite = true;
          try { desc.set.call(el, from); } finally { ownWrite = false; }       // 同帧（paint 前）倒回旧值
          if (el === followScroller) followWrote = from;
          navigate({ kind: "position", px });                                  // 取回写权 + 一次性导航到落点
        } catch (err) { ioErrors.absorb += 1; ioErrors.last = "claim: " + String((err && err.message) || err); }
      });
    } catch (err) { ioErrors.absorb += 1; ioErrors.last = "settle: " + String((err && err.message) || err); }
    finally { phaseAcc("absorb", tAbs); }
  };
  const nativeScrollTo = el.scrollTo;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get() { return desc.get.call(el); },
    set(value) {
      if (ownWrite) { desc.set.call(el, value); return; }     // 我方写入：直接落地（writeTop 随后回读基准）
      const from = desc.get.call(el);
      if (absorbTop(value)) return;                           // 贴底写 + us：吸收，不落地
      desc.set.call(el, value);                               // 先落地：官方写完立刻读回，必须读到真值（不许吞写）
      afterForeignWrite(from);
    },
  });
  try {
    // 关键：**不要**用固定形参 (a,b) —— 那会把 1 参的 scrollTo(options) 变成 2 参调用，
    // WebIDL 会因此选中 scrollTo(x,y) 重载、把 options 对象转成数字 0（Y 的「滑到 0」回归根因）。
    el.scrollTo = function () {
      if (arguments.length) {
        const a = arguments[0];
        const next = (a && typeof a === "object") ? Number(a.top) : Number(arguments[1]);   // (x,y) 形态里纵向是 y
        if (Number.isFinite(next)) {
          const from = desc.get.call(el);
          if (absorbTop(next)) return;
          const r = Reflect.apply(nativeScrollTo, el, arguments);
          if (!ownWrite) afterForeignWrite(from, next);
          return r;
        }
      }
      const from = desc.get.call(el);
      const r = Reflect.apply(nativeScrollTo, el, arguments);
      if (!ownWrite) afterForeignWrite(from);
      return r;
    };
    const noteExternal = (which, before, claimPx) => {
      if (ownWrite) return;
      extWrites += 1;
      lastExtWrite = { which: which, from: before === null ? null : Math.round(before), landed: null, floor: Math.round(Math.max(0, el.scrollHeight - el.clientHeight)), stack: (() => { try { return String(new Error().stack || "").split("\n")[2] || ""; } catch { return ""; } })() };
      afterForeignWrite(before, claimPx);
    };
    const nativeScrollBy = el.scrollBy;
    try {
      el.scrollBy = function () {
        const before = desc.get.call(el);
        const r = Reflect.apply(nativeScrollBy, el, arguments);
        noteExternal("scrollBy", before);
        backfillLanded(el, before === null ? null : Math.round(before));
        return r;
      };
    } catch { /* ignore */ }
    if (protoIntoView === null) {                 // 只装一次：重复接管不叠加
      protoIntoView = Element.prototype.scrollIntoView;
      try {
        Element.prototype.scrollIntoView = function () {
          const sc = mainScroller();
          if (sc === null || !sc.contains(this) || ownWrite) return Reflect.apply(protoIntoView, this, arguments);   // 非主容器内的调用：原样转发、不干预
          const arg = arguments.length ? arguments[0] : undefined;
          const block = arg && typeof arg === "object" ? arg.block : "start";       // boolean/缺省 = start（与浏览器一致）
          const target = scrollIntoViewTarget(sc, this, block);                     // 先自己算目标（要害 2），再走"落地→接管"
          const before = sc.scrollTop;
          const r = Reflect.apply(protoIntoView, this, arguments);
          noteExternal("scrollIntoView", before, target);
          backfillLanded(sc, Math.round(before));
          return r;
        };
      } catch { protoIntoView = null; }
    }
  } catch { /* ignore */ }
  snapTaken = taken;
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
  // H19b：提问卡（LLM 提问）小窗强制展开 —— 仅"我们第一次看到它"时点一次；尊重用户之后的手动折叠。
  // 成本契约：合成点击会触发 React 同步提交（真机实测一次扫描 +30.4ms）⇒ **扫描只登记，点击挪到下一帧**；
  // 去重按「轮次」而不是卡片元素（React 重建卡片时元素变了，按元素记会重复点）。
  try {
  for (const card of flow.querySelectorAll('[data-tool="ask_user_question"],[data-tool="request_user_input"]')) {
    if (qCardHandled(card) || card.dataset.dshsfKeepOpen === "1" || qCardQueued.has(card)) continue;
    qCardQueued.add(card);
    qCardQueue.push(card);
  }
  if (qCardQueue.length > 0 && qCardRaf === 0 && typeof requestAnimationFrame === "function") qCardRaf = requestAnimationFrame(runQCardQueue);
  } catch (err) { scanErrors += 1; lastScanError = String((err && err.message) || err).slice(0, 120); }   // F4：异常计数进诊断（不空吞）
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
  if (!running) { activeWindow = null; sparks.focus(null); return; }   // 跑完就不再磨金属：火星熄灭 + 跟尾对象清空（旧窗不再吸附）
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
  // 合成点击挪到下一帧（与提问卡同一手法）：React 的同步提交不再算进扫描成本。
  if (newestThink !== null && !newestThink.closest("[data-dshsf-folded]") && state.autoExpandReasoning !== false
    && !thinkOpen(newestThink) && inViewport(newestThink)) {
    queueAutoOpen("think", newestThink);
    busyWork = true;   // 还没真的打开：让扫描继续推进（重试节流由 openThink 自己的 260ms 管）
  }
  if (newestTool !== null && !newestTool.closest("[data-dshsf-folded]") && state.autoExpandTools !== false
    && !toolOpen(newestTool) && inViewport(newestTool)) {
    queueAutoOpen("tool", newestTool);
    busyWork = true;
  }
  // 火星与跟尾同源：本轮最新的思考正文（没展开就是 null）。activeWindow 由这里维护，与 sparks 开关无关。
  const newestBody = newestThink ? newestThink.querySelector(THINK_BODY) : null;
  if (activeWindow !== newestBody) { activeWindow = newestBody; if (newestBody !== null) ensureTickLoop(); }   // 活动窗刚出现：排一帧做首屏贴底
  sparks.focus(newestBody);
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

/* ------------------------------------------------ 穿插正文（保留 + 分隔线） -- */
/** 升级/热重载残留：容器级一次清扫旧的「穿插正文限高小窗」（已不再套窗）。 */
function clearTextWindows(scope) {
  for (const el of scope.querySelectorAll("[data-dshsf-textwindow]")) {
    el.removeAttribute("data-dshsf-textwindow");
    el.style.maxHeight = "";
    el.style.overflow = "";
    liveWindows.delete(el);
  }
  for (const row of scope.querySelectorAll("[data-dshsf-tw]")) row.removeAttribute("data-dshsf-tw");
}
/** 折叠后仍保留的穿插正文行：不套窗，只用答案行上的一条横线跟正式回答分开。 */
function syncTextWindows(flow, collected) {
  clearTextWindows(flow || document);   // 一次容器级清扫：旧的每行早退依赖 data-dshsf-tw，而它已无写入点 ⇒ 已失效
  const keepText = state.keepInterleavedText !== false;
  for (const turnRows of (collected ? collected.turns : collectTurns().turns).values()) {
    const answerRow = answerRowOf(turnRows);   // task-20 A11：复用 syncTurns 已算好的按轮 memo（answerRowCache）
    if (!keepText || answerRow === null) {     // 原语义保持：不保留穿插正文 ⇒ 该轮 answer-sep 一律清掉
      if (answerRow) answerRow.removeAttribute("data-dshsf-answer-sep");
      continue;
    }
    let keptText = false;
    for (const row of assistantRowsOf(turnRows)) {   // task-20 A11：复用同一份 assistant 行列表；只判断"有没有"
      if (row === answerRow || row.hasAttribute("data-dshsf-folded") || !hasText(row)) continue;
      if (assistantBody(row)) { keptText = true; break; }   // 穿插正文不再套限高小窗：只靠 answer-sep 横线与正式回答分开
    }
    answerRow.toggleAttribute("data-dshsf-answer-sep", keptText);   // 有穿插正文才画线
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
const SPARK_EMIT_MAX = 1.8;     // 满强度发射率倍率（恒定发射率：密度观感不随输出速度变化）
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
   *        亮度继续随绝对速度上涨（快输出更烫）。若 ref 与输出速度等比（上限 6），等于把速度
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
  finally { scanRows = null; scanRunningMark = null; scanRunningKnown = false; }   // task-19 A9：扫描作用域结束（含抛错）
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
  // task-19 A9：扫描开头把行列表与 RUNNING 标记各查一次；之后 collectTurns/userRows/pinSource 全复用这一份
  scanRows = null; scanRunningKnown = true; scanRunningMark = null;
  scanRows = chatRows();
  scanRunningMark = (chatScope() || document).querySelector(RUNNING);
  // eslint-disable-next-line no-use-before-define
  rootVars();
  syncSession();                     // 换会话先把串号状态清掉（轮号复用会让运行中的轮次被折）
  const flow = chatScope();
  if (state.mode !== "fold") {
    // 顺序契约：先展开/删条，再放手。unfoldAll / clearChips 是按 data-dshsf-row / data-dshsf-chip 找目标的，
    // 先 releaseOurVisuals 会把这两个标记先摘掉 ⇒ 折叠行展不开、折叠条删不掉，只有刷新页面（React 重渲染）才恢复。
    if (flow) { unfoldAll(flow); clearChips(flow); }
    releaseOurVisuals();               // task-30：完全放手 —— 连小窗正文的内联限高/变量/数据集与残余标记一起清
    activeWindow = null;               // 官方档：跟尾对象同样清空
    sparks.focus(null);
    sparks.forge(null);
    pinRows = pinSource(chatRows());   // H19f：native 分支此前只收 user 行（缺回答）
    if (pinPick >= pinRows.length) pinPick = -1;
    return;
  }
  if (!flow) return;
  // 运行态带粘性：标记一消失就当成跑完，会在步骤/工具交接的空档里折一次（用户看到"运行中全折起来"）。
  // 只有连续 RUN_GRACE_MS 看不到任何运行标记，才算这一轮结束 —— 收尾的折叠只做这一次。
  const stamp = performance.now();
  const collected = collectTurns();                     // 提前取一次：运行判定要用最后一轮
  // 回尾：**出现你新发的一条消息** ⇒ 滑回尾部（内容侧边沿判据，不是时间窗）。
  // 官方自己就是这么干的（ui-chat:4961 ownInput ⇒ followTail），我们接管吸附后这一条必须自己认。
  {
    let newestUser = null;
    for (let i = collected.rows.length - 1; i >= 0; i -= 1) { if (rowKind(collected.rows[i]) === "user") { newestUser = collected.rows[i]; break; } }
    const uKey = newestUser === null ? null : (newestUser.getAttribute("data-chat-flow-key") || (newestUser.getAttribute("data-chat-turn") || "") + ":" + String(newestUser.textContent || "").length);
    if (uKey !== null && lastUserKey !== null && uKey !== lastUserKey && state.returnToTail !== false
      && !(writer === WRITER_US && goalKind === "tail")) navigate({ kind: "tail" });
    if (uKey !== null) lastUserKey = uKey;
  }
  const markRunning = scanRunningMark !== null;   // task-19 A9：复用扫描开头那次 RUNNING 查询（flow === chatScope()）
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
  if (wasRunning && !running) {                       // 刚跑完这一轮：先起滑，本轮折叠压到滑完（settleTurn）
    const turn = collected.runningTurn === null || collected.runningTurn === undefined ? collected.lastTurn : collected.runningTurn;
    if (settleToPrompt(flow)) { settleTurn = turn; settleUntil = performance.now() + SETTLE_MAX_MS; }
    if (settleTurn !== null && settleTurn === turn) {   // S2-1：刚起滑 ⇒ 把兜底预算换成与 navBudget 同源（长滑行不得被 1400ms 切断）
      const sc = mainScroller();
      let dist = 0;
      if (sc !== null && goalEl !== null && goalEl.isConnected) {
        const floor = Math.max(0, sc.scrollHeight - sc.clientHeight);
        dist = Math.abs(Math.max(0, Math.min(floor, viewTop(sc, goalEl) - SETTLE_PAD)) - sc.scrollTop);
      }
      settleUntil = performance.now() + Math.max(SETTLE_MAX_MS, navBudget(dist));
    }
  }
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
  // H19c：置顶条 = 用户提问行（照旧，不替换）∪ ——仅当「提问不入折叠」开启时—— 提问的**用户回答**
  // 按**真实 flow kind** 匹配：reply 行的行级标志是 data-chat-flow-kind="question-reply"（本文件 976 行既有判定用的就是它）；
  // [data-question-reply] 只是提问卡**内部**的气泡，卡本身不是 collected.rows 里的行 ⇒ 之前用它匹配必然为空。
  pinRows = pinSource(collected.rows);   // H19f：与 native 分支共用同一个 pinSource()
  if (pinPick >= pinRows.length) pinPick = -1;
  cost.phases.collect = +(performance.now() - tC).toFixed(2);
  const turnKeys = Array.from(collected.turns.keys());
  hotRows = new WeakSet();
  // A8：热集 = 最近 3 轮 ∪ 运行中的轮（更老的轮次靠 observer 定向失效，不靠热集）
  for (const key of new Set([...turnKeys.slice(-3), collected.runningTurn].filter((k) => k !== null && k !== undefined))) {
    for (const row of collected.turns.get(key) || []) hotRows.add(row);
  }
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
  scanMsSinceFrame += ms; scanCountSinceFrame += 1;
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
        follow: winState.get(el) !== undefined && winState.get(el).writer === "us" ? 1 : 0,
        active: el === activeWindow ? 1 : 0,
        vis: el.querySelector(":scope > [data-dshsf-jump][data-dshsf-visible]") ? 1 : 0,
      })),
    },
    perf: { ticks: tickCount, announces: announceCount, tickErrors, lastTickError },   // 帧循环次数 / 补发 scroll 次数 / 循环内异常
    trace: trace.slice(),   // 最近 240 帧的帧轨迹 {dt,writes,announces,tickMs,scans,step,gap,writer,goal}（直接 JSON.stringify 粘回来；空闲不记）
    // 我们自己的 JS 成本：帧循环平均每帧多少毫秒、结构扫描平均每次多少毫秒（不含浏览器布局/绘制）
    cost: {
      frames: cost.frames,
      tickAvgMs: +(cost.tickMs / Math.max(1, cost.frames)).toFixed(3),
      tickP50: percentile(tickSamples, 0.5), tickP95: percentile(tickSamples, 0.95),
      tickMax: tickSamples.length ? Math.max.apply(null, tickSamples) : 0,
      pinRects,
      tickPhases: (() => { const n = Math.max(1, tickPhase.n); return { plan: +(tickPhase.plan / n).toFixed(2), main: +(tickPhase.main / n).toFixed(2), mainPlan: +(tickPhase.mainPlan / n).toFixed(2), mainSlide: +(tickPhase.mainSlide / n).toFixed(2), mainGate: +(tickPhase.mainGate / n).toFixed(2), pin: +(tickPhase.pin / n).toFixed(2), win: +(tickPhase.win / n).toFixed(2), winStyle: +(tickPhase.winStyle / n).toFixed(2), winSlide: +(tickPhase.winSlide / n).toFixed(2), winJump: +(tickPhase.winJump / n).toFixed(2), sparks: +(tickPhase.sparks / n).toFixed(2), announce: +(tickPhase.announce / n).toFixed(2), absorb: +(tickPhase.absorb / n).toFixed(2), other: +(tickPhase.other / n).toFixed(2) }; })(),
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
    // 主窗口运动自检：writer=谁写、goal=我方目标、nav=一次性导航中、gap=离底像素
    mainFollow: (() => {
      const el = mainScroller();
      if (!el) return null;
      const f = Math.max(0, el.scrollHeight - el.clientHeight);
      let goalWant = null;
      if (goalKind === "tail") goalWant = f;
      else if (goalKind === "position") goalWant = Math.max(0, Math.min(f, goalPos));
      else if (goalKind === "element" && goalEl !== null && goalEl.isConnected) goalWant = Math.max(0, Math.min(f, viewTop(el, goalEl) - SETTLE_PAD));
      return { writer, goal: goalKind, navActive: navActive ? 1 : 0, gap: Math.round(f - el.scrollTop), height: followHeight, wrote: followWrote === null ? null : Math.round(followWrote), moves: moveCount, blocked: snapBlocked, passed: passedOfficial, foreign: foreignLanded, extWrites: extWrites, lastExtWrite: lastExtWrite, lastForeign: lastForeign, flips: followFlips.slice(-6),
        step: lastStep,   // 上一帧 {writer, goal, gap, base, rate(px/帧), vMax(px/s), vFeed, vChase, a, dt, moving, nav}
        settle: { turn: settleTurn === null ? null : String(settleTurn), until: Math.round(settleUntil), last: lastSettle },   // A14：真机才能看到 lastSettle.why
        abort: { count: navAbortCount, last: lastNavAbort },   // task-14：区分"卡住终止"（why=stuck）与"settle 超时"（lastSettle.why=timeout）
        nav: lastNav,     // 最近一次一次性导航：kind / why=done|timeout|reduced-motion / to / ms
        releaseReason, rearmCount, releaseBy: { ...releaseBy }, ioErrors: { ...ioErrors }, capRejected, accelRejected,
        want: goalWant === null ? null : Math.round(goalWant), left: goalWant === null ? null : Math.round(goalWant - el.scrollTop),
        officialJump: document.querySelector("[class*='_toBottomSlot']") === null ? 0 : 1,   // 官方那颗在不在 DOM（由官方 state 决定）
        jumpGate: document.documentElement.hasAttribute("data-dshsf-jumpgate") ? 1 : 0,            // 我们的放行开关（= 我们判定该显示）
        pin: pinBar !== null && pinBar.hasAttribute("data-dshsf-visible") ? 1 : 0,
        pinTurn: pinRow === null ? null : pinRow.getAttribute("data-chat-turn") };
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
  for (const old of document.querySelectorAll("[data-dshsf-pin]")) { try { old.remove(); } catch { /* ignore */ } }        // 同上：置顶条只留本实例那一个
  sparks.setOptions({ on: state.sparks !== false, color: state.sparkColor, density: state.sparkDensity, forge: state.forgeSparks !== false, forgeSpeed: state.forgeSpeed, forgeLife: state.forgeLife });   // localStorage 里的设置先落地（不等宿主）
  try { scan(); } catch (err) { scanErrors += 1; lastScanError = String((err && err.message) || err).slice(0, 200); }   // F4：首次 scan 不得让插件半死
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
      hold();   // 用户点击展开/收起 = 我方定位：取回写权，官方贴底写不再拖我们，位置交给 anchorDuring
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
    if (turn) setManual(turn, "open");
    if (writer !== WRITER_READER) hold();        // Ctrl+F 已交权给读者 ⇒ 不抢回来；其它 beforematch（如锚点）维持旧行为
    const prev = allowAnim;
    allowAnim = false;                      // 瞬时展开：高度动画会把"滚到匹配处"带偏
    try { scan(); } catch (err) { scanErrors += 1; lastScanError = String((err && err.message) || err).slice(0, 200); } finally { allowAnim = prev; }   // F4：调用点兜底
  };
  const onFindKey = (event) => {
    if (!((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F"))) return;
    release("reader");     // 用户要求：Ctrl+F 一按就彻底撒手 —— 浏览匹配期间零程序化写，绝不会被拽回底部
    releaseWindows();      // 小窗同一语义：所有 liveWindows 撒手；搜索期间新登记/重挂载的窗也不贴底
    searchPrep();
  };
  document.addEventListener("click", onUserActivate, true);
  document.addEventListener("click", onToBottomClick, true);
  document.addEventListener("click", onNavIntentInput, true);      // 真实输入 ⇒ 给下一笔外来写打"导航"位（task-13）
  window.addEventListener("keydown", onNavIntentInput, true);
  document.addEventListener("keydown", onUserKey, true);
  document.addEventListener("keydown", onFindKey, true);
  document.addEventListener("beforematch", onBeforeMatch, true);
  // 会话 id 就地更新不触发 childList：侦听该属性，微任务里立刻复位（不再等 SCAN_INTERVAL=300ms 的扫描）
  observer = new MutationObserver((records) => {
    // A8：定向失效 —— 任意行（含很老的轮次）的正文在 DOM 里变了，清掉该行及其祖先行的 hasText 缓存；
    // 新增子树里若带着行（React 换节点）也同样失效。避免"已定轮正文不再变"的假设失效后拿到陈旧 hasText。
    for (const r of records) {
      const t = r.target;
      const node = t === null || t === undefined ? null : (t.nodeType === 1 ? t : (t.parentElement || null));
      for (let n = node; n !== null; n = n.parentElement) {
        if (n.nodeType === 1 && n.matches && n.matches(ROW)) { textCache.delete(n); cardCountCache.delete(n); pinTextOf.delete(n); }
      }
      if (r.type === "childList") {
        for (const add of r.addedNodes || []) {
          const el = add && add.nodeType === 1 ? add : null;
          if (el !== null && el.closest) { const row = el.closest(ROW); if (row !== null) { textCache.delete(row); cardCountCache.delete(row); pinTextOf.delete(row); } }
        }
      }
    }
    if (records.some((r) => r.type === "attribute")) syncSession();
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-conversation-session"] });
  const unsubscribe = subscribe(schedule);
  const dispose = () => {
    if (disposed) return;                        // A3：幂等门 —— 旧 fiber 的 effect 清理可能在新实例装配之后再跑一次
    disposed = true;
    const ownsGlobals = window.__dshStreamfold !== undefined && window.__dshStreamfold.dispose === dispose;   // A3：全局副作用所有权
    clearSettle("dispose");                      // 收摊：协调作废（不再排扫描）
    ticking = false;
    if (rafId) { try { cancelAnimationFrame(rafId); } catch { /* ignore */ } rafId = 0; }
    clearTimeout(scanTimer);
    clearTimeout(runGraceTimer);
    clearTimeout(navWatchdog); navWatchdog = 0;
    navRecheck = null;                           // S1-4：收摊 ⇒ 观察窗口立即退出（无 rAF/timer 残留）
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", wakeAnim, true);
    window.removeEventListener("keydown", wakeAnim, true);
    for (const type of ["wheel", "touchstart", "touchmove"]) window.removeEventListener(type, noteScrollIntent, true);
    window.removeEventListener("keydown", noteScrollIntent, true);
    window.removeEventListener("resize", ensureTickLoop);
    document.removeEventListener("click", onUserActivate, true);
    document.removeEventListener("click", onToBottomClick, true);
    document.removeEventListener("click", onNavIntentInput, true);
    window.removeEventListener("keydown", onNavIntentInput, true);
    document.removeEventListener("keydown", onUserKey, true);
    document.removeEventListener("keydown", onFindKey, true);
    document.removeEventListener("beforematch", onBeforeMatch, true);
    if (followScroller) { followScroller.removeEventListener("scroll", onMainScroll); followScroller.removeEventListener("pointerdown", onScrollerPointerDown); followScroller = null; }
    anchorStop();                                // A2：收锚定补偿（还原 overflow-anchor / 断开 RO，否则卸载后还在补写）
    clearFoldTimers();                           // A2：清错峰折叠定时器（否则卸载后还会被折叠）
    for (const el of document.querySelectorAll("[data-dshsf-chip]")) { try { el.remove(); } catch { /* ignore */ } }   // chip 先摘：releaseOurVisuals 只摘属性、之后认不出它
    unfoldAll(document);                         // A2：摘行级折叠标记 + 行内 max-height/overflow（必须在 releaseOurVisuals 摘 data-dshsf-row 之前，否则查不到）
    releaseOurVisuals();                         // A2：摘掉我方全部内联视觉痕迹（行/正文/小窗/折叠条/置顶条/动画标记）
    for (const el of document.querySelectorAll("[data-dshsf-jump]")) { try { el.remove(); } catch { /* ignore */ } }   // 回底按钮：releaseOurVisuals 只收显隐
    liveWindows.clear();                         // 放在 releaseOurVisuals 之后：它会经 clearSearchHidden→wireWindow 重新登记
    activeWindow = null;
    if (snapTaken !== null) {                    // A3：实例属性/原型补丁是全局副作用 —— 不属本实例就不还原（否则拆掉新实例的吸收器）
      if (ownsGlobals) { try { delete snapTaken.el.scrollTop; delete snapTaken.el.scrollTo; delete snapTaken.el.scrollBy; } catch { /* ignore */ } }
      snapTaken = null;
    }
    if (protoIntoView !== null && ownsGlobals) {   // H4：原型补丁还原（幂等）。不属本实例：原型已被新实例接管，
      try { Element.prototype.scrollIntoView = protoIntoView; } catch { /* ignore */ }   // 保留 protoIntoView 让本实例的包装层
      protoIntoView = null;                        // 仍可调用（否则新包装链 apply 到 null）
    }
    document.documentElement.removeAttribute("data-dshsf-jumpgate");
    if (pinBar !== null) { try { pinBar.remove(); } catch { /* ignore */ } pinBar = null; }
    pinRows = []; pinRow = null;
    if (observer) observer.disconnect();
    observer = null;
    sparks.reset();
    if (ownsGlobals) delete window.__dshStreamfold;
  };
  // task-57 H10：v11 契约的固定出口名（按优先级第一个）+ 兼容别名
  const diagFn = () => ({ lastStep: lastStep, writer, goal: goalKind, navActive: navActive ? 1 : 0, nav: lastNav, navAbort: navAbortCount, lastNavAbort, blocked: snapBlocked, passed: passedOfficial, foreign: foreignLanded, extWrites: extWrites, lastExtWrite: lastExtWrite, releaseBy: { ...releaseBy }, rearmCount, ioErrors: { ...ioErrors }, capRejected, accelRejected });
  try { window.__streamfoldDiag = diagFn; window.__dshStreamfoldDiag = diagFn; window.__sfDiag = diagFn; window.__dshsfProbe = diagFn; } catch { /* ignore */ }
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
/* -------------------------------------------- 设置页：只留我们这一行 -- */
/** T9：官方 slot item（id transcript-view）DOM 里没有 id ⇒ 按结构识别；我们自己的行加标记用于排除。 */
const OWN_ROW_ATTR = "data-dshsf-own-row";              // 只打在我们自己的行上（排除用，避免误伤别的设置行）
const HIDE_OFFICIAL_ATTR = "data-dshsf-hide-official";  // 只打在官方「工作步骤展示」行上（唯一痕迹：隐藏）
let hideObserver = null;
/** 官方标题文案（tChat 取不到就退回中文），只用于确认这一行的身份。 */
const transcriptTitle = () => {
  if (!tChat) return "工作步骤展示";
  try { const t = tChat("settings.transcript.title"); return typeof t === "string" && t !== "settings.transcript.title" ? t : "工作步骤展示"; } catch { return "工作步骤展示"; }
};
/** 我们自己的行：`.dshsf-select` 所在的那条设置行。 */
function ownRowEl() {
  const sel = document.querySelector(".dshsf-select");
  if (sel === null) return null;
  return sel.closest(".dshsf-row") ?? sel.closest('[class*="_row"]');   // 我方行类名是 dshsf-row（不含 _row）；不能只靠官方那套 CSS-module 命名猜
}
/** 官方「工作步骤展示」行：触发按钮（aria-haspopup=menu）+ 四个官方档位标签之一 + 标题文本，并排除我方下拉/我方行。 */
function findOfficialRow(own) {
  const title = transcriptTitle();
  for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (button.closest(".dshsf-select") !== null) continue;                 // 我方下拉：永不隐藏
    const row = button.closest('[class*="_row"]');
    if (row === null) continue;
    if (own !== null && (row === own || own.contains(button))) continue;    // 我方行：排除
    const text = String(button.textContent || "").trim();
    if (!NATIVE_MODES.some((m) => modeLabel(m) === text)) continue;         // 必须是四个官方档位之一
    if (String(row.textContent || "").indexOf(title) < 0) continue;         // 必须带官方标题
    return row;
  }
  return null;
}
/** 幂等：我方行渲染成功 ⇒ 隐藏官方行；我方行缺席/卸载 ⇒ 立即恢复。绝不允许两行都没了。 */
function syncOfficialRowHidden() {
  const own = ownRowEl();
  if (own !== null && !own.hasAttribute(OWN_ROW_ATTR)) own.setAttribute(OWN_ROW_ATTR, "");
  const official = findOfficialRow(own);
  if (own !== null && official !== null) {
    if (!official.hasAttribute(HIDE_OFFICIAL_ATTR)) official.setAttribute(HIDE_OFFICIAL_ATTR, "");
    return;
  }
  for (const el of document.querySelectorAll("[" + HIDE_OFFICIAL_ATTR + "]")) el.removeAttribute(HIDE_OFFICIAL_ATTR);
}
/** 观察设置页 DOM（childList）：我方行出现/消失、官方行被 React 重建 ⇒ 重贴。不进帧路径。 */
function startOfficialRowHide() {
  if (hideObserver === null && typeof MutationObserver === "function" && document.body !== null) {
    hideObserver = new MutationObserver(() => {
      if (document.querySelector(".dshsf-select") === null && document.querySelector("[" + HIDE_OFFICIAL_ATTR + "]") === null) return;
      syncOfficialRowHidden();
    });
    hideObserver.observe(document.body, { childList: true, subtree: true });
  }
  syncOfficialRowHidden();
}
/** 收摊：断开观察并摘掉两个标记 ⇒ 官方行恢复。 */
function stopOfficialRowHide() {
  if (hideObserver !== null) { try { hideObserver.disconnect(); } catch { /* ignore */ } hideObserver = null; }
  for (const el of document.querySelectorAll("[" + OWN_ROW_ATTR + "], [" + HIDE_OFFICIAL_ATTR + "]")) {
    el.removeAttribute(OWN_ROW_ATTR);
    el.removeAttribute(HIDE_OFFICIAL_ATTR);
  }
}
function DisplayRow() {
  const [choice, setChoice] = React.useState(displayChoice);
  React.useEffect(() => subscribe(() => setChoice(displayChoice())), []);
  React.useEffect(() => {
    if (!nativeScope) return undefined;
    try { return nativeScope.subscribe(() => setChoice(displayChoice())); } catch { return undefined; }
  }, []);
  const options = NATIVE_MODES.map((mode) => ({ value: mode, label: modeLabel(mode) })).concat([{ value: "fold", label: modeLabel("fold") }]);
  return h(Row, { title: "工作步骤展示", desc: "选择希望看到多少工具调用细节；「折叠」＝由流式折叠插件提供的模式" },
    h(Select, { value: choice, options, onChange: (value) => { chooseDisplay(value); setChoice(displayChoice()); } }));
}
function SettingsPage() {
  const s = useSettings();
  return h("div", { className: "dshsf-page" },
    h("div", { className: "dshsf-intro" }, "折叠模式：正在跑的一轮里思考与工具进限高小窗，其余轮次全量折叠；展开某轮时思考保持一行摘要。" ),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "折叠历史轮次", desc: "关闭后：加载页面不再自动折叠历史轮次（只在跑动时折前面的）" },
        h(Toggle, { value: s.foldHistory !== false, onChange: (v) => setSettings({ foldHistory: v }) })),
      h(Row, { title: "保留穿插正文", desc: "折叠时保留带正文的行，用横线与正式回答分开（正文不再套限高小窗）" },
        h(Toggle, { value: s.keepInterleavedText !== false, onChange: (v) => setSettings({ keepInterleavedText: v }) })),
      h(Row, { title: "提问不入折叠", desc: "LLM 的提问工具与其回复（ask_user_question / question-reply）：开启则两者都始终保留、不折进「已折叠 N 行」；关闭则随其余内容一起折叠" },
        h(Toggle, { value: s.keepUserQuestions === true, onChange: (v) => setSettings({ keepUserQuestions: v }) }))),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "跟随速度上限（px/s）", desc: "我们主动追赶时的速度上限（px/s，默认 " + DEFAULTS.followMaxSpeed + " = 旧 8px/帧@60Hz 的手感）。越小越柔、高速输出时落后越多；前馈（内容自己的增长速度）不受它限制" },
        h(NumberInput, { value: s.followMaxSpeed, min: 60, max: 2000, step: 10, onChange: (v) => setSettings({ followMaxSpeed: v }) })),
      h(Row, { title: "跟随加速度上限（px/s²）", desc: "速度变化的上限（px/s²，默认 " + DEFAULTS.followMaxAccel + "）。人对加速度突变更敏感：调小起步/刹车更柔，调大更跟手；2000–120000 为实用区间" },
        h(NumberInput, { value: s.followMaxAccel, min: 2000, max: 120000, step: 1000, onChange: (v) => setSettings({ followMaxAccel: v }) })),
      h(Row, { title: "窗口高度", desc: "单个思考小窗的最大高度（px）" },
        h(NumberInput, { value: s.windowHeight, min: 80, max: 1200, onChange: (v) => setSettings({ windowHeight: v }) })),
      h(Row, { title: "运行中自动展开思考", desc: "只自动展开本轮最新的那一个；被取代的旧窗按下面的宽限折回一行摘要" },
        h(Toggle, { value: s.autoExpandReasoning !== false, onChange: (v) => setSettings({ autoExpandReasoning: v }) })),
      h(Row, { title: "旧窗折叠宽限", desc: "运行中新的思考窗出现后，旧窗再等多久才自动折回（秒）" },
        h(NumberInput, { value: s.supersedeDelay, min: 0, max: 60, step: 0.5, onChange: (v) => setSettings({ supersedeDelay: v }) })),
      h(Row, { title: "运行中自动展开工具", desc: "开：运行中最新的工具卡自动展开（用官方卡片自己的折叠/内滚，不套我们的限高窗）" },
        h(Toggle, { value: s.autoExpandTools !== false, onChange: (v) => setSettings({ autoExpandTools: v }) }))),
    h("div", { className: "dshsf-group" },
      h(Row, { title: "发消息回到尾部", desc: "你停在中途（看过置顶、跳转过轮次）时，自己再发一条消息 ⇒ 视图滑回尾部；关掉后一律停在原地，只有滚到底或点「回到底部」才恢复跟随" },
        h(Toggle, { value: s.returnToTail !== false, onChange: (v) => setSettings({ returnToTail: v }) })),
      h(Row, { title: "平滑系数", desc: "跟随底部时每帧吃掉多少差距，越小越柔（默认 0.15）" },
        h(NumberInput, { value: s.smoothGrow, min: 0.05, max: 0.9, step: 0.05, onChange: (v) => setSettings({ smoothGrow: v }) })),
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
      h("button", { type: "button", className: "dshsf-btn", onClick: () => { setSettings({ ...DEFAULTS }); chooseDisplay("fold"); } }, "恢复默认")));   // A5：恢复默认也要强制官方档（否则官方仍自折 ⇒ 双重折叠）
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
  if (ctx.slots) ctx.effect(() => applyPageSlots(ctx), "dsh-streamfold: page slots");
}
/** 页面级 slot 注册做成**幂等**：disposer 挂在 window 上；apply 时先把上一次的逐个 dispose 再注册。
 *  热重载时旧模块实例的 effect disposer 不会被调到（那就是"工作步骤展示"重复两行的根因），
 *  所以清理由 window 上的列表负责；正常卸载时由 ctx.effect 返回的 disposer 清理。 */
function applyPageSlots(ctx) {
  const prev = window.__dshsfPageSlots;
  if (Array.isArray(prev)) { for (const d of prev) { try { d(); } catch { /* ignore */ } } }
  const list = [];
  window.__dshsfPageSlots = list;
  const keep = (d) => { if (typeof d === "function") list.push(d); return d; };
  // 方案A：折叠回到我们自己的设置行（唯一入口）。
  keep(ctx.slots.inject("settings.general.item", () => keep(ctx.slots.register({ name: "settings.general.item", id: "streamfold", order: 13 }, DisplayRow))));
  // T9：我方行渲染成功时隐藏官方「工作步骤展示」行（只改可见性；我方行不在 ⇒ 立即恢复）。
  if (ctx.effect) keep(ctx.effect(() => { startOfficialRowHide(); return () => stopOfficialRowHide(); }, "dsh-streamfold: hide official row"));
  keep(ctx.slots.inject("settings.section", () => keep(ctx.slots.register({ name: "settings.section", id: "streamfold", order: 42, label: () => "流式折叠" }, SettingsPage))));
  return () => {
    for (const d of list) { try { d(); } catch { /* ignore */ } }
    if (window.__dshsfPageSlots === list) { try { delete window.__dshsfPageSlots; } catch { /* ignore */ } }
  };
}
exports.apply = apply;
exports.inject = ["slots"];
exports.defaults = DEFAULTS;
return module.exports; } });
