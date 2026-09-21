import { readFileSync } from "node:fs";

/* 从真实 client.js 抽出「火星特效」整节（不是复制粘贴：测的就是要发布的那段源码） */
const bundle = readFileSync(process.env.SF_SRC || new URL("../lib/client.js", import.meta.url), "utf8");
const head = "/* ------------------------------------------------------ 火星特效（独立） -- */";
const endMark = "const sparks = createSparkFx();";
const start = bundle.indexOf(head);
const end = bundle.indexOf(endMark, start) + endMark.length;
if (start < 0 || end < start) throw new Error("找不到火星特效节");
const section = bundle.slice(start, end);

/* ---- 迷你 DOM + canvas2d：只实现这段源码用到的面，同时记录绘图调用 ---- */
let ops = { clear: 0, stroke: 0, beginPath: 0, setTransform: 0, resize: 0 };
let minY = Infinity, maxY = -Infinity, maxStrokes = 0, strokesThisFrame = 0, mirrorPts = 0, groundPts = 0;
let lastX = 0, endInward = 0, endOutward = 0;
let observers = [];                                   // 迷你 MutationObserver（结构一变就通知，模块靠它同步补色）
const notifyMut = (el, added, removed) => {
  for (const o of observers) {
    for (let n = el; n; n = n.parentNode) if (o.els.indexOf(n) >= 0) { o.cb([{ type: "childList", addedNodes: added || [], removedNodes: removed || [] }]); break; }
  }
};
const notifyData = (node, oldValue) => {                    // 文本被改写：真 DOM 会带 oldValue 报给 observer
  for (const o of observers) {
    for (let n = node.parentNode; n; n = n.parentNode) if (o.els.indexOf(n) >= 0) { o.cb([{ type: "characterData", target: node, oldValue }]); break; }
  }
};
globalThis.MutationObserver = class MutationObserver {
  constructor(cb) { this.cb = cb; this.els = []; }
  observe(el) { this.els.push(el); observers.push(this); }
  disconnect() { observers = observers.filter((o) => o !== this); }
};
function fakeCtx() {
  return {
    globalAlpha: 1, globalCompositeOperation: "source-over", lineCap: "", lineWidth: 1, strokeStyle: "",
    setTransform() { ops.setTransform += 1; },
    createLinearGradient() { return { addColorStop() {} }; }, createRadialGradient() { return { addColorStop() {} }; }, drawImage() { ops.sprite = (ops.sprite || 0) + 1; },
    fillRect() { ops.fillRect = (ops.fillRect || 0) + 1; },
    clearRect() { ops.clear += 1; },
    beginPath() { ops.beginPath += 1; },
    moveTo(x, y) {
      lastX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y > SPARK_GROUND + 0.5) mirrorPts += 1;      // 地面线以下的描边 = 倒影
      else groundPts += 1;
    },
    lineTo(x2) {
      // 端点喷流：头在端点上、尾在更外侧，且拖尾够长（|dx|>3.5px ≈ |vx|>88px/s，中段的均匀火星够不到）
      const dx = x2 - lastX;
      if (Math.abs(dx) <= 3.5) return;
      if (lastX < 12) { if (dx < 0) endInward += 1; else endOutward += 1; }
      else if (lastX > 720 - 12) { if (dx > 0) endInward += 1; else endOutward += 1; }
    },
    stroke() { ops.stroke += 1; },
  };
}
function fakeEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, dataset: {}, style: {}, children: [], parentNode: null, isConnected: false,
    clientWidth: 720, clientHeight: 0, scrollTop: 0, scrollHeight: 0,
    appendChild(child) {
      const prev = child.parentNode;
      if (prev) prev.children = prev.children.filter((c) => c !== child);   // 真实 DOM：appendChild 是"移动"，不是复制
      child.parentNode = el;
      el.children.push(child);
      child.isConnected = true;
      notifyMut(el, [child], []);
      return child;
    },
    get lastChild() { return el.children[el.children.length - 1] || null; },
    get previousSibling() { const p = el.parentNode; if (!p) return null; const i = p.children.indexOf(el); return i > 0 ? p.children[i - 1] : null; },
    get parentElement() { return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null; },   // 文本节点也要有（真实 DOM 就有）
    matches(sel) {
      return String(sel).split(",").some((raw) => {
        const m = /^\[([a-zA-Z-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]$/.exec(raw.trim());
        if (!m || !m[1].startsWith("data-")) return false;
        const key = m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!Object.prototype.hasOwnProperty.call(el.dataset, key)) return false;
        const want = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        return want === undefined ? true : String(el.dataset[key]) === want;
      });
    },
    hasAttribute(name) { const key = name.startsWith("data-") ? name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()) : null; return key ? Object.prototype.hasOwnProperty.call(el.dataset, key) : false; },
    getBoundingClientRect() { return el._rect || (el._rect = { left: 0, top: 0, right: 720, bottom: 72, width: 720, height: 72 }); },
    remove() { const p = el.parentNode; if (p) p.children = p.children.filter((c) => c !== el); el.parentNode = null; el.isConnected = false; if (p) notifyMut(p, [], [el]); },
    getContext() { return el._ctx || (el._ctx = fakeCtx()); },
    set width(v) { el._w = v; ops.resize += 1; }, get width() { return el._w || 0; },
    set height(v) { el._h = v; ops.resize += 1; }, get height() { return el._h || 0; },
  };
  return el;
}
let reducedMotion = false;
let caretRect = { left: 12, right: 20, top: 44, bottom: 60, width: 8, height: 16 };
globalThis.getComputedStyle = () => ({ color: "rgb(200, 200, 200)", paddingLeft: "22px", paddingBottom: "4px" });
let hotSeen = 0, hotEndOffsets = [];
const fakeText = (value) => {
  const t = { nodeType: 3, _v: value, parentNode: null, isConnected: false,
    get nodeValue() { return t._v; },
    set nodeValue(v) { const old = t._v; t._v = v; notifyData(t, old); },   // 模块现在靠 characterData 的 oldValue 算"又写了几个字"
    get previousSibling() { const p = t.parentNode; if (!p) return null; const i = p.children.indexOf(t); return i > 0 ? p.children[i - 1] : null; },
    get parentElement() { return t.parentNode && t.parentNode.nodeType === 1 ? t.parentNode : null; },
    remove() { const p = t.parentNode; if (p) p.children = p.children.filter((c) => c !== t); t.parentNode = null; t.isConnected = false; if (p) notifyMut(p, [], [t]); } };
  return t;
};
const doc = {
  body: fakeEl("div"),
  createElement: (tag) => fakeEl(tag),
  createTextNode: (value) => fakeText(value),
  documentElement: { style: { setProperty() {} } },
  head: { children: [], appendChild(node) { node.parentNode = this; this.children.push(node); return node; } },
  createRange: () => {
    const r = { start: null, end: null,
      setStart(node, offset) { r.start = { node, offset }; },
      setEnd(node, offset) { r.end = { node, offset }; },
      getBoundingClientRect: () => caretRect };
    return r;
  },
};
const win = { devicePixelRatio: 1.5, matchMedia: () => ({ matches: reducedMotion }) };
let vnow = 0;                                                            // 虚拟时钟（ms，跟着模拟帧推进）
const perf = { now: () => vnow };
const real = () => Number(process.hrtime.bigint()) / 1e6;                // harness 自己量耗时用（真实）
const factory = new Function("document", "window", "performance", section + "\nreturn { sparks, createSparkFx, SPARK_H, SPARK_MAX, SPARK_RATE, sparkRgb };");
const mod = factory(doc, win, perf);
const { sparks, SPARK_H, SPARK_MAX, sparkRgb } = mod;
const SPARK_GROUND = SPARK_H;   // "磨"的地面线 = 画布底边（校验描边有没有跑到画布外）

const host = fakeEl("div");
host.isConnected = true;
host.clientWidth = 720;
host.clientHeight = 260;

/* ---- 场景：720px 宽、内容 260px 封顶的思考小窗；每 47ms 来 16px 内容，scrollTop 用插件同一公式追赶 ---- */
const W = 720, CAP = 260, GROW = 0.15, MINSTEP = 1, DT = 8;
function run(seconds, opt = {}) {
  const chunkEvery = opt.chunkEvery === undefined ? 47 : opt.chunkEvery;
  const chunkPx = opt.chunkPx === undefined ? 16 : opt.chunkPx;
  let content = opt.from === undefined ? 200 : opt.from, top = 0;
  host.scrollHeight = content;
  host.scrollTop = 0;
  const ms = [], pops = [];
  let bursts = 0, maxJump = 0;
  const y0 = minY;
  let nextChunk = 0, busyFrames = 0, frames = 0;
  for (let t = 0; t < seconds * 1000; t += DT) {
    if (chunkEvery > 0 && t >= nextChunk) { content += chunkPx; nextChunk += chunkEvery; }
    const max = Math.max(0, content - CAP);        // 小窗封顶后：内容长高多少，就需要往下滚多少（摩擦的燃料）
    const gap = max - top;
    if (gap > 0.5) top += Math.min(gap, Math.max(MINSTEP * (DT / 16), gap * GROW * (DT / 16)));
    host.scrollHeight = content;
    host.scrollTop = top;
    vnow += DT;
    const s0 = ops.stroke;
    const t0 = real();
    const busy = sparks.tick(DT);
    const strokes = ops.stroke - s0;                    // 本次 tick 的描边数（增量，才是一个帧的量）
    if (strokes > maxStrokes) maxStrokes = strokes;
    ms.push(real() - t0);
    if (busy) busyFrames += 1;
    frames += 1;
    const now = sparks.stats().parts;
    if (pops.length) { const jump = now - pops[pops.length - 1]; if (jump > maxJump) maxJump = jump; if (jump >= 6) bursts += 1; }
    pops.push(now);
  }
  const sorted = ms.slice().sort((a, b) => a - b);
  const q = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4);
  return {
    frames, busyFrames,
    tick: { p50: q(0.5), p95: q(0.95), max: +sorted[sorted.length - 1].toFixed(3), total: +ms.reduce((a, b) => a + b, 0).toFixed(1) },
    parts: { avg: +(pops.reduce((a, b) => a + b, 0) / pops.length).toFixed(1), max: Math.max(...pops) },
    bursts, maxJump,
    maxStrokes, strokesPerSecond: +(maxStrokes * (1000 / DT)).toFixed(0),
    mirrorShare: +(mirrorPts / Math.max(1, mirrorPts + groundPts)).toFixed(3),
    peakThisRun: +(minY === y0 ? 0 : minY).toFixed(1),   // 本场景里火星到过的最高点（没画就是 0）
  };
}

const out = {};
/* ① 稳态流式（默认密度） */
sparks.setOptions({ on: true, color: "#4fa8ff", density: 1 });
sparks.focus(host);
minY = Infinity; maxStrokes = 0;
out.steady = run(6);
out.steady.peakY = +minY.toFixed(1);            // 火星到过的最高点（canvas 坐标：0=层顶, 64=底边）
out.steady.clipped = minY < 4;                  // 是否顶到画布上沿（顶到就会被裁/渐隐）
out.steady.stats = sparks.stats();
out.steady.edge = (() => {                              // 画布是 body 上的固定层，位置由 transform 摆
  const cv = doc.body.children.filter((c) => c.dataset && c.dataset.dshsfSpark !== undefined)[0];
  return cv ? { transform: cv.style.transform, width: cv.style.width, height: cv.style.height } : null;
})();
out.steady.endJets = { inward: endInward, outward: endOutward };

/* ② 高密度（用户可拉到的最大值） */
sparks.setOptions({ density: 3 });
maxStrokes = 0;
out.dense = run(6);
out.dense.stats = sparks.stats();

/* ③ 快输出（内容猛涨） */
sparks.setOptions({ density: 1 });
maxStrokes = 0;
out.burst = run(4, { chunkEvery: 16, chunkPx: 60 });
out.burst.stats = sparks.stats();

/* ③.5 停顿后重新开始：应有一次"咬上"的迸发（单帧跳增） */
{
  sparks.setOptions({ density: 1 });
  const before2 = run(2);                        // 先正常磨
  let content = host.scrollHeight, top = host.scrollTop;
  for (let i = 0; i < 260; i += 1) { vnow += DT; host.scrollTop = top; host.scrollHeight = content; sparks.tick(DT); }   // 停 2s：火星烧完、接触点熄
  const partsAfterStall = sparks.stats().parts;
  const back = run(1.2, { from: content });       // 重新开始出内容
  out.resume = { partsAtStart: back.parts.max, partsAfterStall, bursts: back.bursts, maxJump: back.maxJump, coolBefore: before2.bursts };
}

/* ④ 熄火 → 空转：停止输入后多少帧停手，之后是否真的零成本 */
const before = sparks.stats();
let drainFrames = 0, drainMs = 0, idleFrames = 0, idleMs = 0, idleCalls = 0;
{
  let content = host.scrollHeight, top = host.scrollTop;
  for (let i = 0; i < 400; i += 1) {           // 内容不再变：火星烧完（熄火阈值 + 最长寿命）
    vnow += DT;
    host.scrollTop = top; host.scrollHeight = content;
    const t0 = real(); const busy = sparks.tick(DT); drainMs += real() - t0;
    drainFrames += 1;
    if (!busy) break;
  }
  for (let i = 0; i < 500; i += 1) {           // 之后：应永远 false 且 0 粒子 0 画布
    vnow += DT;
    const t0 = real(); const busy = sparks.tick(DT); idleMs += real() - t0;
    idleFrames += 1; idleCalls += busy ? 1 : 0;
  }
}
out.drain = { frames: drainFrames, ms: +drainMs.toFixed(2), partsBefore: before.parts };
out.idle = { frames: idleFrames, ms: +idleMs.toFixed(3), busyCalls: idleCalls, after: sparks.stats() };

/* ⑤ 开关 / reduced-motion / 颜色解析 */
sparks.focus(null);
sparks.setOptions({ on: false });
sparks.focus(host);
run(1);
out.off = { ...sparks.stats(), nodes: host.children.length };
sparks.focus(null);
sparks.setOptions({ on: true });
reducedMotion = true;
sparks.focus(host);
run(1);
out.reduced = sparks.stats();
reducedMotion = false;
sparks.focus(null);

/* ⑥ DOM 卫生：reset 之后宿主里不留画布 */
sparks.focus(host);
run(1);
const nodesBefore = doc.body.children.length;          // 画布挂在 body 上；宿主里不该有任何我们插的节点
sparks.reset();
out.dom = { before: nodesBefore, after: doc.body.children.length, host: host.children.length };

/* ⑥.5 锻打（正文写头）：每写一段砸一扇火星；停写就不砸、火星烧完就收手 */
{
  const answer = fakeEl("div");
  answer.isConnected = true;
  answer.clientWidth = 720;
  let text = doc.createTextNode("流式正文");
  answer.appendChild(text);
  sparks.focus(null);
  sparks.forge(answer);
  const ms = [], pops = [];
  let right = 20, strokes = 0, maxStrokesForge = 0, busyFrames = 0, jumped = 0, prev = 0, nextChunk = 0;
  for (let t = 0; t < 6000; t += DT) {
    if (t >= nextChunk) {                                // 每 ~47ms 写 8px 字（t 是毫秒，别用 t % 47：8 与 47 互素，会变成 376ms 一次）
      nextChunk += 47;
      right += 8;
      if (right > 700) right = 20;                       // 换行：写头跳回行首
      caretRect = { left: right - 8, right, top: 44, bottom: 60, width: 8, height: 16 };
      text.nodeValue += "字";
    }
    vnow += DT;
    const s0 = ops.stroke; const t0 = real();
    const busy = sparks.tick(DT);
    const st = ops.stroke - s0;
    ms.push(real() - t0);
    if (st > maxStrokesForge) maxStrokesForge = st;
    strokes += st;
    if (busy) busyFrames += 1;
    const st2 = sparks.stats();
    if (st2.parts - prev >= 3) jumped += 1;   // 净增跳变（粗略；锤数以后面 stats().strikes 为准）
    prev = st2.parts;
    pops.push(st2.parts);
  }
  const sorted = ms.slice().sort((a, b) => a - b);
  const strikeCount = sparks.stats().strikes;
  // 停写：不再改文字 → 不该再有新火星；已有的烧完就收手
  let tail = 0;
  for (let i = 0; i < 900; i += 1) { vnow += DT; tail += 1; if (!sparks.tick(DT)) break; }   // 冷却 5.2s + 火星寿命
  let idleParts = 0, idleBusy = 0;
  for (let i = 0; i < 200; i += 1) { vnow += DT; if (sparks.tick(DT)) idleBusy += 1; idleParts = Math.max(idleParts, sparks.stats().parts); }
  out.forge = {
    parts: { avg: +(pops.reduce((a, b) => a + b, 0) / pops.length).toFixed(1), max: Math.max(...pops) },
    strikes: strikeCount, jumps: jumped, busyFrames, maxStrokes: maxStrokesForge, tail,
    tick: { p50: +sorted[Math.floor(0.5 * sorted.length)].toFixed(4), p95: +sorted[Math.floor(0.95 * sorted.length)].toFixed(4) },
    strokesPerSecond: +(strokes / 6).toFixed(0),
    idleParts, idleBusy,
  };
  // 换文本节点（React 重渲染就会这样）：高亮不该被清掉、也不该指错位置 —— 这是"字在闪"的回归测试
  let churnMiss = 0, churnFrames = 0;
  for (let i = 0; i < 80; i += 1) {
    if (i % 4 === 0) {                                    // 每 ~32ms 换一次节点（比真实 React 狠得多，用来压这条通路
      const next = doc.createTextNode(text.nodeValue + "字");
      text.remove();
      answer.appendChild(next);
      text = next;
    }
    caretRect = { ...caretRect, left: caretRect.right, right: caretRect.right + 8 };
    vnow += DT;
    sparks.tick(DT);
    churnFrames += 1;
    if (sparks.stats().heating && sparks.stats().parts === 0) churnMiss += 1;
  }
  out.forge.churn = { frames: churnFrames, miss: churnMiss, parts: sparks.stats().parts };

  // 回合结束就撒手：已经在热的字不该当场跳回原色，而是继续冷完（5.2s 尾巴）
  sparks.forge(answer);
  for (let i = 0; i < 60; i += 1) {
    if (i % 6 === 0) { caretRect = { ...caretRect, left: caretRect.right, right: caretRect.right + 8 }; text.nodeValue += "字"; }
    vnow += DT;
    sparks.tick(DT);
  }
  const hotAtRelease = sparks.stats().parts;
  sparks.forge(null);
  let relFrames = 0, clearedAt = -1;
  for (let i = 0; i < 900; i += 1) {
    vnow += DT;
    relFrames += 1;
    const busy = sparks.tick(DT);
    if (clearedAt < 0 && sparks.stats().parts === 0) clearedAt = relFrames;
    if (!busy) break;
  }
  out.forge.release = { hotAtRelease, frames: relFrames, clearedAt, parts: sparks.stats().parts, fields: sparks.stats().fields };
  sparks.reset();
  answer.remove();
  bool_reset: { /* 让下一段从干净状态开始 */ }
}

/* ⑥.9 锻打只认答案正文：行尾是"更新的思考文本"时，锚点仍必须是答案段落 */
{
  const row = fakeEl("div");
  row.isConnected = true;                      // 真实 DOM 里行是挂在对话流里的
  const answer = fakeEl("div");
  const p = fakeEl("p");
  p.appendChild(doc.createTextNode("答案正文"));
  answer.appendChild(p);
  const think = fakeEl("div");
  think.dataset.variant = "think";
  const tb = fakeEl("div");
  tb.appendChild(doc.createTextNode("更新的思考内容"));
  think.appendChild(tb);
  row.appendChild(answer);
  row.appendChild(think);                       // 思考在最后且文本更新（真实 DOM 就是这个顺序）
  // 锚点现在是"整行"，写头由模块内部找：必须落在答案段落上（4 个字），而不是更新的思考文本（6 个字）
  sparks.forge(null);
  sparks.reset();
  sparks.setOptions({ on: true, forge: true, density: 1 });
  sparks.forge(row);
  vnow += DT;
  sparks.tick(DT);
  const st = sparks.stats();
  out.forgeScope = { caretLen: st.caretLen, answerLen: 4, thinkLen: 6,
    thinkMatches: !!think.matches("[data-variant='think'], [data-tool], [data-sample='bash'], [data-dshsf-forgewrap], [data-dshsf-sparkwrap]") };
  sparks.forge(null);
  sparks.reset();
  row.remove();
}

/* ⑦ React 往末尾追加内容：我们**不该往宿主里插任何节点**了（画布在 body 上） */
sparks.focus(host);
run(1);
const late = fakeEl("p");
host.appendChild(late);
vnow += DT;
sparks.tick(DT);
const midHost = host.children.length - 1;                    // 减去我们自己加的演示节点：应为 0（我们不往宿主里插东西）
sparks.reset();
out.selfHeal = { midHost, hostNodes: host.children.length - 1, bodyCanvases: doc.body.children.length };
late.remove();

/* ⑧ 颜色解析 */
out.color = {
  hex: sparkRgb("#5ab0ff", null),
  short: sparkRgb("#4af", null),
  rgb: sparkRgb("rgb(10, 20, 30)", null),
  junk: sparkRgb("不是颜色", [1, 2, 3]),
};

const fmt = (o) => JSON.stringify(o, null, 1);
console.log(fmt(out));

/* ---- 断言 ---- */
const fail = [];
let checked = 0;
const ok = (cond, msg) => { checked += 1; if (!cond) fail.push(msg); };
ok(out.steady.parts.max <= SPARK_MAX, "粒子上限被突破：" + out.steady.parts.max);
// 假 DOM 里所有元素 rect 都是 (0,0)-(720,72)：窗口底边 72；画布高 160（band 64 + 漂移余量 96）→ top = 72-160 = -88
ok(out.steady.edge && out.steady.edge.transform === "translate(0px,-88px)" && out.steady.edge.width === "720px" && out.steady.edge.height === "160px",
  "画布没摆到窗口底边上：" + fmt(out.steady.edge));
// 端点喷流：朝内必须明显多于朝外（朝外的是中段快火星飘到端点附近，洗不掉，只能比比值）
ok(out.steady.endJets.inward > 300 && out.steady.endJets.inward > out.steady.endJets.outward * 1.5,
  "两端没有朝内的火星：" + fmt(out.steady.endJets));
ok(maxY <= SPARK_H, "有东西画出了画布底边：" + maxY + " > " + SPARK_H);
ok(mirrorPts === 0, "倒影还在画（应该是单边向上的）：" + mirrorPts);   // 单边向上：不许往地面线以下画
ok(out.steady.maxStrokes <= out.steady.parts.max * 2 + 8, "默认密度每帧描边超出预算（2/粒子 + 辉光3 + 倒影3）：" + out.steady.maxStrokes + " vs parts " + out.steady.parts.max);
ok(out.dense.maxStrokes <= out.dense.parts.max * 2 + 8, "密度 3 每帧描边超出预算：" + out.dense.maxStrokes);
ok(out.dense.peakThisRun > -45, "密度拉满时火星飞得太远：" + out.dense.peakThisRun);
ok(out.steady.bursts >= 3, "6 秒里没有迸发：" + out.steady.bursts);
ok(out.resume.bursts >= 1 && out.resume.maxJump >= 5, "停顿后重新开始没有迸发：" + fmt(out.resume));
ok(out.resume.partsAfterStall === 0, "停顿期还有火星没烧完：" + out.resume.partsAfterStall);
ok(out.steady.tick.p95 < 0.6, "默认密度 p95 每帧 > 0.6ms：" + out.steady.tick.p95);
ok(out.steady.peakThisRun > -20, "磨的火星冲得太高（渐隐带也留不住）：" + out.steady.peakThisRun);   // 地面线抬高后，极少数迸发火星会进顶部渐隐带，属预期
ok(out.drain.frames < 300, "熄火后空转帧数过多：" + out.drain.frames);
ok(out.idle.ms < 20 && out.idle.busyCalls === 0 && out.idle.after.parts === 0, "空转没做到零成本：" + fmt(out.idle));
ok(out.off.parts === 0 && out.off.fields === 0 && out.off.nodes === 0, "关掉开关后还在跑：" + fmt(out.off));
ok(out.reduced.parts === 0 && out.reduced.fields === 0, "reduced-motion 下还在跑：" + fmt(out.reduced));
ok(out.dom.after === 0 && out.dom.host === 0, "reset 后 DOM 里还留着画布 / 宿主里插了节点：" + fmt(out.dom));
ok(out.selfHeal.midHost === 0 && out.selfHeal.hostNodes === 0 && out.selfHeal.bodyCanvases === 0,
  "往宿主里插了节点 / 画布没撤干净：" + fmt(out.selfHeal));
ok(out.forgeScope.caretLen === out.forgeScope.answerLen, "写头跑到思考里去了（应该认答案段落 4 个字）：" + fmt(out.forgeScope));
ok(out.forge.parts.max > 0 && out.forge.strikes >= 25, "锻打没砸出来/锤数太少：" + fmt(out.forge));
ok(out.forge.parts.avg >= 3 && out.forge.parts.avg <= 75, "锻打火星量不在预期区间：" + out.forge.parts.avg);   // 飘得久（0.5~1s）所以同屏更多
ok(out.forge.tail > 100 && out.forge.tail <= 400, "收手时机不对（期望：最后一批火星飞完就收手，约 1~2 秒）：" + out.forge.tail);
ok(out.forge.release.parts === 0 && out.forge.release.fields === 0, "火星烧完后没撤干净：" + fmt(out.forge.release));
ok(out.forge.idleParts === 0 && out.forge.idleBusy === 0, "正文停写后还在砸：" + fmt(out.forge));
ok(out.forge.maxStrokes <= out.forge.parts.max * 2 + 8, "锻打每帧描边超预算：" + out.forge.maxStrokes + " vs parts " + out.forge.parts.max);
ok(out.color.hex.join() === "90,176,255" && out.color.short.join() === "68,170,255" && out.color.rgb.join() === "10,20,30" && out.color.junk.join() === "1,2,3", "颜色解析不对：" + fmt(out.color));
console.log(fail.length ? "\nFAIL\n- " + fail.join("\n- ") : "\nALL PASS (" + checked + " assertions)");
process.exit(fail.length ? 1 : 0);
