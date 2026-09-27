/**
 * 收尾护栏：把收尾/切会话/落底过滤/dispose 这批关键断言固化成回归测试，跟 npm test 一起跑。
 * 桩 DOM 是本仓库自带的迷你实现（makeElement / build / settleFixture / fireMutations），无外部依赖。
 * 覆盖 I 官方落底过滤 · N 跑完回到提问处 · O 折叠条 · P 切会话 · Q 目标离底≤25px · C5 dispose 无污染 · R 行复用重算。
 * CLIENT_SRC 指到临时还原过的 client.js 即可做负向对照（默认 ../lib/client.js）。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.env.CLIENT_SRC || new URL('../lib/client.js', import.meta.url)
const source = readFileSync(CLIENT, 'utf8')
const dispatched = []        // 所有 dispatchEvent：C5 用它守「dispose 后不再派发合成 click」

function makeStyle() { const p = new Map(); return { getPropertyValue: (k) => p.get(k) || '', setProperty: (k, v) => p.set(k, v), removeProperty: (k) => p.delete(k) } }
function makeElement(tag = 'div') {
  const attrs = new Map()
  return {
    tagName: String(tag).toUpperCase(), nodeType: 1, style: makeStyle(), dataset: {}, children: [], childNodes: [], isConnected: true,
    className: '', id: '', textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, firstElementChild: undefined, parentElement: null,
    appendChild(c) { this.children.push(c); return c }, insertBefore(n, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n },
    removeChild() {}, remove() {}, focus() {}, click() {},
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k),
    toggleAttribute(k, on) { if (on) attrs.set(k, ''); else attrs.delete(k); return attrs.has(k) },
    addEventListener(type, fn) { (this._lis = this._lis || {})[type] = (this._lis[type] || []).concat(fn) },
    removeEventListener(type, fn) { if (this._lis && this._lis[type]) this._lis[type] = this._lis[type].filter((f) => f !== fn) },
    dispatchEvent(ev) { dispatched.push({ type: (ev && ev.type) || String(ev), el: this }); return true },
    fire(type, ev) { for (const fn of ((this._lis || {})[type] || [])) { try { fn(ev || { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }) } catch { /* ignore */ } } },
    querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false, getElementsByTagName: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  }
}
function makeRow(turn) {
  const row = makeElement('div')
  row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', turn)
  return row
}
function build({ rows = [makeRow('1')], patch = null } = {}) {
  const head = makeElement('head'); const body = makeElement('body'); const documentElement = makeElement('html')
  const documentStub = {
    head, body, documentElement, baseURI: 'http://127.0.0.1:3080/', getElementById: () => null, querySelector: () => null, getElementsByTagName: () => [],
    createElement: (t) => makeElement(t), createTextNode: () => ({ textContent: '' }), addEventListener() {}, removeEventListener() {}, contains: () => true,
    createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    querySelectorAll: (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : []),
  }
  let vnow = 0; const rafQ = []; let captured = null; const winListeners = {}
  const windowStub = {
    __ModuleLoader__: { load: (d) => { captured = d.factory } },
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn) },
    removeEventListener(type, fn) { if (winListeners[type]) winListeners[type] = winListeners[type].filter((f) => f !== fn) },
    requestAnimationFrame: (cb) => { rafQ.push(cb); return rafQ.length }, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ overflowY: 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { href: 'http://127.0.0.1:3080/' },
  }
  const fakeConsole = { ...console, warn: () => {} }; const observers = []; let moCb = null
  const sandbox = {
    window: windowStub, document: documentStub, console: fakeConsole, navigator: { userAgent: 'node' },
    performance: { now: () => vnow }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    getComputedStyle: windowStub.getComputedStyle, localStorage: windowStub.localStorage,
    requestAnimationFrame: windowStub.requestAnimationFrame, cancelAnimationFrame: windowStub.cancelAnimationFrame,
    MutationObserver: class { constructor(cb) { this.cb = cb; moCb = cb; observers.push(this) } observe() {} disconnect() {} takeRecords() { return [] } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    // 桩元素是普通对象：让 instanceof Element 为真，插件的「事件目标必须是元素」判定才走得到
    Element: class { static [Symbol.hasInstance](v) { return v !== null && typeof v === 'object' } },
    HTMLElement: class {}, Node: class {}, Event: class {}, CustomEvent: class {},
    PointerEvent: class { constructor(t, o) { Object.assign(this, o, { type: t }) } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o, { type: t }) } },
  }
  sandbox.window.document = documentStub; sandbox.globalThis = sandbox
  if (patch) patch(documentStub, sandbox)
  vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }), useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useMemo: (fn) => fn(), useCallback: (fn) => fn, memo: (c) => c,
    Fragment: Symbol('Fragment'), createContext: () => ({ Provider: null, Consumer: null }),
  }
  const exportsObject = captured((name) => (name === 'react' ? reactStub : {})); let listener = null
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { transcriptView: 'standard' }, writable: true }),
    subscribe: (fn) => { listener = fn; return () => {} }, set: async () => false,
  }
  exportsObject.apply({
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (deps, cb) => cb({ locale: { bind: () => (k) => k }, configForms: { get: () => scope } }),
    slots: { inject: () => {}, register: () => {} }, on: () => {}, get: () => undefined, provide: () => {},
  })
  const frame = (dt = 16) => { vnow += dt; for (const cb of rafQ.splice(0)) { try { cb(vnow) } catch { /* ignore */ } } }
  const fireWindow = (type, ev) => { for (const fn of winListeners[type] || []) { try { fn(ev || { type }) } catch { /* ignore */ } } }
  return { api: () => windowStub.__dshStreamfold, documentElement, window: windowStub, observers, frame, fireWindow, fireMutations: (recs) => { if (moCb) moCb(recs) } }
}

const results = []
async function check(name, fn) {
  try { results.push(['PASS', name, (await fn()) || '']) }
  catch (e) { results.push(['FAIL', name, (e && e.message) || String(e)]) }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || '') + ' 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)) }

/** 滚动容器桩：scrollTop 夹到 [0, floor]（复刻浏览器），可统计写入次数；keepProto=交还/卸载后仍走这条访问器。 */
function stubScroll(sandbox, scroller, onWrite, keepProto) {
  const store = new WeakMap()
  Object.defineProperty(sandbox.Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return store.get(this) || 0 },
    set(v) { if (onWrite) onWrite(); const floor = Math.max(0, (this.scrollHeight || 0) - (this.clientHeight || 0)); store.set(this, Math.max(0, Math.min(Number(v) || 0, floor))) },
  })
  delete scroller.scrollTop
  sandbox.getComputedStyle = (el) => ({ overflowY: el === scroller ? 'auto' : 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' })
  sandbox.window.getComputedStyle = sandbox.getComputedStyle
  if (keepProto) Object.setPrototypeOf(scroller, sandbox.Element.prototype)
}

/* ------------------------------------------------- 官方落底写入过滤（②） -- */
await check('I 跟随/滑行中官方落到 floor 的写入被丢，交还接管后放行（含 >600px 远处）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  scroller.scrollHeight = 2000; scroller.clientHeight = 800
  flow.parentElement = scroller; flow.isConnected = true
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const b = build({
    rows: [row],
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      stubScroll(sandbox, scroller, null, false)
      scroller.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? [row] : [])
      scroller.contains = (el) => el === flow || el === row
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' }); api.scan()
  for (let i = 0; i < 4; i += 1) b.frame(16)
  const mf = () => api.probe().mainFollow
  if (!mf()) throw new Error('没找到主滚动容器（桩 DOM 的 chat-flow 链没搭对）')
  const floor = scroller.scrollHeight - scroller.clientHeight
  scroller.scrollTop = floor - 2
  const blocked0 = mf().blocked
  scroller.scrollTop = scroller.scrollHeight
  eq(mf().blocked, blocked0 + 1, '内容长高那一下的官方瞬跳该被丢掉；')
  eq(scroller.scrollTop, floor - 2, '被丢掉就不该改位置；')
  scroller.scrollTop = floor - 120
  const blocked1 = mf().blocked
  scroller.scrollTop = floor
  eq(mf().blocked, blocked1 + 1, '0.1.7 官方直接写 floor 也要被丢掉；')
  eq(scroller.scrollTop, floor - 120, '被丢掉就不该改位置；')
  scroller.scrollTop = 0
  const blocked2 = mf().blocked
  scroller.scrollTop = scroller.scrollHeight
  eq(mf().blocked, blocked2 + 1, '跟随中来一记远处落底也要被丢掉；')
  eq(scroller.scrollTop, 0, '被丢掉就不该改位置；')
  api.set({ mode: 'native' }); api.scan()
  scroller.scrollTop = 0
  scroller.scrollTop = scroller.scrollHeight
  eq(scroller.scrollTop, scroller.scrollHeight, '交还接管后官方落底应放行；')
  return '短跳/floor/远处都丢，交还后放行'
})

/* ------------------------------------------------- 跑完回到提问处：夹具（① ② ③ ④ ⑤ ⑥） -- */
function settleFixture({ userTop = 1150 } = {}) {
  const state = { running: false }
  const flow = makeElement('div'); const scroller = makeElement('div')
  const mainHolder = makeElement('div'); const sideHolder = makeElement('div'); const created = []
  mainHolder.setAttribute('data-conversation-session', 'A')     // 官方把它挂在滚动容器的**父层**
  sideHolder.setAttribute('data-conversation-session', 'A')     // document 序靠前的另一个会话（右栏子代理）
  scroller.scrollHeight = 2000; scroller.clientHeight = 800     // floor = 1200
  flow.parentElement = scroller; flow.isConnected = true
  const mkRow = (kind, turn, top) => {
    const el = makeElement('div')
    el.setAttribute('data-chat-flow-kind', kind); el.setAttribute('data-chat-turn', turn); el.parentElement = flow
    el.getBoundingClientRect = () => ({ top: top - scroller.scrollTop, height: 30, bottom: 0, left: 0, right: 0, width: 0 })
    return el
  }
  const userRow = mkRow('user', '1', userTop)                   // 提问行位置可调：验「滑完不许被再武装」时贴近底部
  const toolRow = mkRow('tool-call', '1', 1160)
  const toolRows = [toolRow, mkRow('tool-call', '1', 1165), mkRow('tool-call', '1', 1170), mkRow('tool-call', '1', 1175), mkRow('tool-call', '1', 1180)]
  const rows = [userRow, ...toolRows, mkRow('assistant-step', '1', 1190)]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')
  const marker = makeElement('div')
  // 一个"展开着的工具卡"：给 dispose 场景走「用户收起 → 先播动画 → 200ms 后补发合成 click」那条路
  const toolRoot = makeElement('button'); toolRoot.setAttribute('data-tool', 'x')
  toolRoot.matches = (sel) => /data-expandable|data-disclosure-row/.test(String(sel))
  const toolBody = makeElement('div'); toolBody.className = '_bodyWrap'
  toolBody.matches = (sel) => /_bodyWrap|_bodyScroll/.test(String(sel))
  toolBody.closest = (sel) => (String(sel).includes('data-tool') ? toolRoot : null)
  toolRoot.nextElementSibling = toolBody
  const pick = (sel) => {
    const t = String(sel)
    if (t.includes('data-dshsf-folded')) return rows.find((r) => r.hasAttribute('data-dshsf-folded')) || null   // 真 DOM 里问"有没有已折的行"就该命中
    if (t.includes('data-turn-tail')) return tail
    if (t.includes('data-state') || t.includes('data-streaming')) return state.running ? marker : null
    return null
  }
  scroller.querySelector = pick
  scroller.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-turn-tail') ? [tail] : []))
  scroller.contains = () => true
  scroller.closest = (sel) => (String(sel).includes('data-conversation-session') ? mainHolder : null)
  scroller.getBoundingClientRect = () => ({ top: 0, height: 800, bottom: 800, left: 0, right: 0, width: 0 })
  flow.querySelector = pick
  flow.querySelectorAll = (sel) => { const s = String(sel); if (s.includes('_bodyWrap')) return [toolBody]; return s.includes('data-chat-flow-kind') ? rows : [] }
  flow.contains = () => true
  flow.closest = () => null
  let writes = 0
  let sandboxRef = null
  const b = build({
    rows,
    patch(doc, sandbox) {
      sandboxRef = sandbox
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : (String(sel).includes('data-conversation-session') ? sideHolder : null))
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      const origCreate = doc.createElement
      doc.createElement = (t) => { const el = origCreate(t); created.push(el); return el }
      stubScroll(sandbox, scroller, () => { writes += 1 }, true)
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' })
  b.fireWindow('pointerdown', { type: 'pointerdown' })          // 用户第一次交互：打开动效开关（allowAnim）
  const finishTurn = () => {
    state.running = true; api.scan(); b.frame(20)
    state.running = false; api.scan(); b.frame(800)
    api.scan()
  }
  return { b, api, scroller, rows, toolRows, toolRow, userRow, mainHolder, sideHolder, created, toolRoot, toolBody, sandbox: () => sandboxRef, writes: () => writes, finishTurn, state }
}

await check('N 跑完回到提问处：贴底就起滑，滑行结束前不折，滑完才折，且不被吸回底部', () => {
  const f = settleFixture()
  f.scroller.scrollTop = 1200
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  if (f.api.probe().mainFollow.on !== true) throw new Error('桩环境没把跟随带起来')
  f.scroller.scrollTop = 1000; f.api.scan()
  for (let i = 0; i < 5; i += 1) f.b.frame(16)   // 让跟随真的写几帧 → 位置所有权在我们手里
  f.scroller.scrollTop = 300
  const blockedFar = f.api.probe().mainFollow.blocked
  f.scroller.scrollTop = 1200
  eq(f.api.probe().mainFollow.blocked, blockedFar + 1, '跟随中官方的落底写入必须被丢（不受 600px 限制）；')
  eq(f.scroller.scrollTop, 300, '被丢掉就不该改位置；')
  f.finishTurn()
  eq(f.api.probe().settleLog.slice(-1)[0].why, 'glide', '贴底时结束就该起滑：' + JSON.stringify(f.api.probe().settleLog.slice(-1)))
  eq(f.toolRow.hasAttribute('data-dshsf-folded'), false, '滑行没结束前不许折这一轮；')
  f.scroller.scrollTop = 300
  const blockedBefore = f.api.probe().mainFollow.blocked
  f.scroller.scrollTop = 1200
  eq(f.api.probe().mainFollow.blocked, blockedBefore + 1, '滑行期间官方的贴底写入必须被丢掉（不受 600px 限制）；')
  eq(f.scroller.scrollTop, 300, '被丢掉就不该改位置；')
  for (let i = 0; i < 160; i += 1) f.b.frame(16)
  if (!f.api.probe().settleLog.some((e) => e.why === 'glide-done')) throw new Error('滑行没收敛：' + JSON.stringify(f.api.probe().settleLog.slice(-3)))
  f.api.scan()
  eq(f.toolRow.hasAttribute('data-dshsf-folded'), true, '回到提问处之后该把这一轮折起来；')
  const lastFold = f.api.probe().foldLog.slice(-1)[0]
  if (lastFold.rows <= 3) throw new Error('桩环境没造出「一次折 >3 个」的场景：' + JSON.stringify(lastFold))
  eq(lastFold.flat, false, '收尾折叠（用户正看着）即使超过预算也要播动画：' + JSON.stringify(lastFold))
  const trace = []
  for (let i = 0; i < 90; i += 1) { f.b.frame(16); if (i % 10 === 0) trace.push([i, Math.round(f.scroller.scrollTop), f.api.probe().mainFollow.on]) }
  if (f.scroller.scrollTop > 1170) throw new Error('回到提问处后又被吸回底部：scrollTop=' + f.scroller.scrollTop + ' trace=' + JSON.stringify(trace))
  eq(f.api.probe().mainFollow.on, false, '滑行结束后不该自动把跟随再打开；')
  return '贴底起滑 / 滑完再折 / 不被吸回底部'
})

await check('O 点折叠条立刻折，不被 settle hold 吞', () => {
  const f = settleFixture()
  f.scroller.scrollTop = 1200
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  f.finishTurn()
  if (f.api.probe().settleHold === null) throw new Error('桩环境没造出 hold：' + JSON.stringify(f.api.probe().settleLog.slice(-3)))
  const chip = f.created.find((el) => String(el.id || '').startsWith('dshsf-chip'))
  if (!chip) throw new Error('没找到折叠条：' + JSON.stringify(f.created.map((e) => e.id)))
  chip.fire('click')
  eq(f.toolRow.hasAttribute('data-dshsf-folded'), true, '用户点折叠条就该立刻折（不能被「刚跑完那轮先别折」吞掉）；')
  return '点击不被 hold 吞'
})

await check('P 切会话：会话归属认对（父层）+ hold 复位 + 新会话同号历史轮不被展开', () => {
  const f = settleFixture()
  f.scroller.scrollTop = 1200
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  f.finishTurn()
  if (f.api.probe().settleHold === null) throw new Error('桩环境没造出 hold：' + JSON.stringify(f.api.probe().settleLog.slice(-3)))
  for (const r of f.toolRows) r.setAttribute('data-dshsf-folded', '')      // 新会话里同号轮的历史行：已折
  f.mainHolder.setAttribute('data-conversation-session', 'B')              // 主会话 A→B（document 序第一个是右栏的）
  f.api.scan()
  eq(f.api.probe().settleHold, null, '切会话必须复位 hold；')
  eq(f.toolRows.every((r) => r.hasAttribute('data-dshsf-folded')), true, '切会话后同号历史轮必须保持已折（不能被当成"刚跑完那轮"展开）；')
  return '归属认对 + hold 复位 + 历史行不被展开'
})

await check('Q 滑行目标离底 ≤25px：滑完不被重新武装跟随', () => {
  const f = settleFixture({ userTop: 1200 })            // 目标 want=1188，离底只差 12px
  f.scroller.scrollTop = 1200
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  f.finishTurn()
  eq(f.api.probe().settleLog.slice(-1)[0].why, 'glide', '该起滑；')
  for (let i = 0; i < 160; i += 1) f.b.frame(16)
  f.api.scan()
  for (let i = 0; i < 60; i += 1) f.b.frame(16)
  if (f.scroller.scrollTop > 1195) throw new Error('滑完又被吸附回底部：scrollTop=' + f.scroller.scrollTop)
  eq(f.api.probe().mainFollow.on, false, '滑完不该自动重开跟随；')
  return '目标贴近底部也不会被再武装'
})

await check('C5 apply→dispose 后无污染：属性/全局/scrollTop 写入/合成 click', async () => {
  const f = settleFixture()
  f.api.scan()
  f.scroller.scrollTop = 1200                            // 真贴底 → 跟随开
  for (let i = 0; i < 4; i += 1) f.b.frame(16)
  f.scroller.scrollHeight = 2200                         // 内容长高 → 跟随真的开始写 scrollTop
  for (let i = 0; i < 8; i += 1) f.b.frame(16)
  if (f.writes() <= 0) throw new Error('dispose 前跟随没写过 scrollTop，桩环境没搭对')
  f.b.fireWindow('wheel', { type: 'wheel' })             // 读者上滚接管 → 回底按钮放行开关点亮
  f.scroller.scrollTop = 400
  f.scroller.fire('scroll', { type: 'scroll', currentTarget: f.scroller })
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  eq(f.b.documentElement.getAttribute('data-dshsf-mode'), 'fold', 'dispose 前该是折叠档（否则这轮断言没有对象）；')
  eq(f.b.documentElement.hasAttribute('data-dshsf-jumpgate'), true, 'dispose 前该有回底按钮放行开关；')
  f.toolRoot.fire('click')                               // 用户收起 → 排一个 200ms 后的合成 click
  const writesAt = f.writes(); const clicked = () => dispatched.filter((d) => d.el === f.toolRoot).length
  const clicksAt = clicked()
  f.api.dispose()
  eq(f.b.window.__dshStreamfold, undefined, 'dispose 后 window.__dshStreamfold 必须被删；')
  eq(f.b.documentElement.getAttribute('data-dshsf-mode'), null, 'dispose 后 documentElement 不该留 data-dshsf-mode；')
  eq(f.b.documentElement.hasAttribute('data-dshsf-jumpgate'), false, 'dispose 后 documentElement 不该留 data-dshsf-jumpgate；')
  const topAt = f.scroller.scrollTop
  for (const o of f.b.observers) { try { o.cb() } catch { /* ignore */ } }     // 旧实例的补扫回调
  for (let i = 0; i < 60; i += 1) { if (i === 30) f.scroller.scrollHeight = 2600; f.b.frame(16) }
  await new Promise((r) => setTimeout(r, 260))                                // 等过 animateClose 的 200ms 时限
  eq(f.writes(), writesAt, 'dispose 后不该再写 scrollTop；')
  eq(clicked(), clicksAt, 'dispose 后不该再派发合成 click；')
  eq(f.scroller.scrollTop, topAt, 'dispose 后位置不该被改；')
  return 'mode/jumpgate 清掉 · 全局删除 · 帧+RO+补扫不再写 scrollTop · 无合成 click'
})

/* ------------------------------------------------- 行节点复用后 hasText 重算（B3） -- */
await check('R React 复用行节点后 hasText 必须重算（否则承载正文的行会被折掉）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  const mk = (kind, turn, text) => {
    const el = makeElement('div')
    el.setAttribute('data-chat-flow-kind', kind); el.setAttribute('data-chat-turn', turn)
    el.closest = (sel) => (String(sel).includes('data-chat-flow-kind') ? el : null)   // 观察器据此把变更归到行上
    el.parentElement = flow
    el.childNodes = text ? [{ nodeType: 3, nodeValue: '正文' }] : []
    return el
  }
  const e1 = mk('assistant-step', '1', true)      // turn1 里"有正文"的那行
  const e2 = mk('assistant-step', '1', false)
  const rows = [mk('user', '1'), e1, e2,
    mk('user', '2'), mk('assistant-step', '2', true),
    mk('user', '3'), mk('assistant-step', '3', true)]   // 让 turn1 落成冷行（hotRows＝最近两轮）
  scroller.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : [])
  scroller.contains = () => true; scroller.closest = () => null
  flow.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : [])
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, false)
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' }); api.scan()
  eq(e1.hasAttribute('data-dshsf-folded'), false, '第一次：有正文的 e1 是回答行，不该被折；')
  eq(e2.hasAttribute('data-dshsf-folded'), true, '第一次：没正文的 e2 才是过程行；')
  e1.childNodes = []; e2.childNodes = [{ nodeType: 3, nodeValue: '正文' }]     // 模拟 React 复用：正文搬到 e2、e1 空掉
  b.fireMutations([{ target: e2 }, { target: e1 }])
  api.scan()
  eq(e2.hasAttribute('data-dshsf-folded'), false, '复用后必须重算：现在有正文的是 e2，它绝不能被折掉；')
  eq(e1.hasAttribute('data-dshsf-folded'), true, '复用后：空掉的 e1 才该被折；')
  return 'hasText 随变更行作废缓存'
})

/* ------------------------------------------- A2：帧内回补不许按 600px 放弃 -- */
await check('A2 跟随中「单帧长高 >600px」的抢跑也要回补（回补不再受 600px 限制）', () => {
  const f = settleFixture()
  const api = f.api
  api.set({ mode: 'fold' }); api.scan()
  f.scroller.scrollTop = 200                      // 离开底部一段，让帧循环写出跟随点
  api.scan()
  for (let i = 0; i < 2; i += 1) f.b.frame(16)    // 只追两帧 → 离底仍 >600px（才是要验的场景）
  const mf = () => api.probe().mainFollow
  const wrote = mf().wrote
  if (wrote === null) throw new Error('桩环境没建立跟随写入点（followWrote 为空）')
  const floor = f.scroller.scrollHeight - f.scroller.clientHeight
  if (floor - wrote <= 600) throw new Error('桩环境没造出 >600px 的回补场景：wrote=' + wrote)
  // 绕过我们自己的 scrollTop 访问器，像浏览器/官方那样直接改位置 = 一帧长高 >600px 把位置甩到底
  const desc = Object.getOwnPropertyDescriptor(f.sandbox().Element.prototype, 'scrollTop')
  desc.set.call(f.scroller, floor)
  const undo0 = mf().undo
  f.b.frame(16)
  eq(mf().undo, undo0 + 1, '跟随中一记远处抢跑也要回补（原先 floor−followWrote>600 就直接放弃）；')
  // 回补后同一帧还会按追赶公式再推进一小步，所以只要求「明显没被甩到底」（原先会停在 floor）
  if (f.scroller.scrollTop >= floor - 400) throw new Error('抢跑没被回补，位置仍贴在底部：' + f.scroller.scrollTop + '（floor=' + floor + '，跟随点=' + wrote + '）')
  return '远处抢跑也回补到跟随点（wrote=' + wrote + '）'
})

/* ------------------------------------- B2：scanAnimateAll 不许跨扫描存活 -- */
await check('B2 scanAnimateAll 不跨扫描存活（官方档那次早退也要复位）', () => {
  const f = settleFixture()
  const api = f.api
  api.set({ mode: 'fold' }); api.scan()                       // 折上 5 行 + 造出折叠条
  const first = api.probe().foldLog.slice(-1)[0]
  if (!first || first.rows <= 3) throw new Error('桩环境没造出「一次折 >3 行」：' + JSON.stringify(first))
  eq(first.flat, true, '没人看着的整批折叠该走瞬时：' + JSON.stringify(first))
  const chip = f.created.find((el) => String(el.id || '').startsWith('dshsf-chip'))
  if (!chip) throw new Error('没找到折叠条')
  api.set({ mode: 'native' })                                 // 下一次扫描会走官方档早退分支
  chip.fire('click')                                           // 点折叠条会置 scanAnimateAll → 紧跟的 scan() 早退
  eq(api.probe().animAll, false, '官方档那次早退也必须复位 scanAnimateAll（否则下一次整批折叠会白播动画）；')
  return '跨扫描不残留（animAll 已复位，rows=' + first.rows + '）'
})

/* ----------------------------------- A3：交还档位时作废 settle hold -- */
await check('A3 切官方档交还时作废 settle hold', () => {
  const f = settleFixture()
  const api = f.api
  f.scroller.scrollTop = 1200
  for (let i = 0; i < 3; i += 1) f.b.frame(16)
  f.finishTurn()
  if (api.probe().settleHold === null) throw new Error('桩环境没造出 hold')
  api.set({ mode: 'native' }); api.scan()
  eq(api.probe().settleHold, null, '交还档位（releaseTakeover）必须把上一轮的 settle hold 一起作废；')
  return '交还时清 hold'
})

/* --------------------------- B4：用户手点的整批展开不受动画配额限制 -- */
await check('B4 点折叠条展开：整批 5 行都播动画（不受 animBudget=3 截断）', () => {
  const f = settleFixture()
  const api = f.api
  api.set({ mode: 'fold' }); api.scan()                       // 折上 5 行
  eq(f.toolRows.filter((r) => r.hasAttribute('data-dshsf-folded')).length, 5, '前置：5 行都该已折；')
  const chip = f.created.find((el) => String(el.id || '').startsWith('dshsf-chip'))
  if (!chip) throw new Error('没找到折叠条')
  chip.fire('click')                                           // manual=open → 展开（同步扫一次，不跑帧）
  const animated = f.toolRows.filter((r) => r.style.maxHeight === '0px').length   // 动画起点是 0px；瞬时路径是 ''
  eq(animated, 5, '用户手点的整批展开都该走动画（原先 animBudget=3 只放行前 3 行）：animated=' + animated)
  return '整批 5 行都播动画'
})

/* ------------------------- S：最新一轮的收尾折叠，视野外也要有动效 -- */
await check('S 最新一轮收尾折叠：读者滚到别处（settle 不触发）也要播动画', () => {
  const f = settleFixture()
  const api = f.api
  f.b.frame(16); f.b.frame(16)                                  // 先让帧循环把 scroll 监听挂到容器上
  f.scroller.scrollTop = 200                                   // 读者滚到别处
  f.scroller.fire('scroll')                                    // 真实滚动事件 → 读者接管（followOn=false）
  eq(api.probe().mainFollow.on, false, '前置：跟随应已被读者接管；')
  f.finishTurn()
  const settle = api.probe().settleLog.slice(-1)[0]
  eq(settle.why, 'not-at-bottom', '前置：这次不该滑回提问处（读者在别处）：' + JSON.stringify(settle))
  const last = api.probe().foldLog.slice(-1)[0]
  if (!last || last.rows <= 3) throw new Error('桩环境没造出「一次折 >3 行」：' + JSON.stringify(last))
  eq(last.force, true, '刚跑完那一轮该走强制动画批次：' + JSON.stringify(last))
  eq(last.flat, false, '最新一轮的收尾折叠哪怕在视野外也要播动画：' + JSON.stringify(last))
  return '视野外收尾折叠也播动画（rows=' + last.rows + '）'
})

/* ------------- T1：入场动画目标要夹到下边界余量（composer 上沿，用户实测） -- */
await check('T1 思考小窗入场目标夹到下边界余量（而不是内容高度）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  scroller.scrollHeight = 2000; scroller.clientHeight = 800
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const body = makeElement('div'); body.className = '_thinkBody'
  think.appendChild(body); row.appendChild(think); body.parentElement = think
  think.closest = () => null
  body.closest = (sel) => (String(sel).includes('data-variant') ? think : null)
  body.matches = (sel) => /_thinkBody/.test(String(sel))
  body.getBoundingClientRect = () => ({ top: 700, height: 260, bottom: 960, left: 0, right: 0, width: 0 })   // 窗顶 700、内容高 260 → 底边本该到 960
  body.scrollHeight = 900; body.clientHeight = 40
  const seat = makeElement('div')
  seat.getBoundingClientRect = () => ({ top: 740, height: 60, bottom: 800, left: 0, right: 0, width: 0 })   // composer 上沿 = 740
  const rows = [row]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')   // 这一轮"跑完了" → 不触发收尾滑行（它会带走滚动位置）
  scroller.querySelector = (sel) => { const s = String(sel); return s.includes('data-composer-seat') ? seat : (s.includes('data-turn-tail') ? tail : null) }
  flow.querySelector = () => null
  // chatScope() 给的是滚动容器：正文/行都要从它身上查得到
  const qa = (sel) => { const s = String(sel); return s.includes('_thinkBody') ? [body] : (s.includes('data-chat-flow-kind') ? rows : []) }
  scroller.querySelectorAll = qa; flow.querySelectorAll = qa
  scroller.contains = () => true; scroller.closest = () => null
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, true)   // 让 scrollTop 走"容器访问器"（store 支持）：takeOverSnap 换上的实例访问器读的就是它
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' }); api.scan()
  eq(body.dataset.dshsfWindow, 'reasoning', '前置：思考正文该被打成小窗；')
  eq(body.style.getPropertyValue('--dshsf-hw'), '40px', '入场目标要夹到下边界余量（740−700），不是内容高 260px；')
  eq(body.dataset.dshsfH, '40', '窗口目标高度同样夹住；')
  return '入场目标 40px（内容 260px）'
})

/* ------------- T2：跟随中「窗往上长、底边钉住」；读者接管后只夹高度 -- */
await check('T2 跟随中小窗往上长、底边钉在下边界（且不会因此长不大）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  scroller.clientHeight = 800
  const TOP = 1900                                   // 窗顶在内容坐标：视口 y = TOP − scrollTop
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const body = makeElement('div'); body.className = '_thinkBody'
  think.appendChild(body); row.appendChild(think); body.parentElement = think
  think.closest = () => null
  body.closest = (sel) => (String(sel).includes('data-variant') ? think : null)
  body.matches = (sel) => /_thinkBody/.test(String(sel))
  const rendered = () => parseFloat(body.style.maxHeight) || 0            // 桩里渲染高度＝我们写的 max-height
  const bodyTop = () => TOP - scroller.scrollTop
  body.getBoundingClientRect = () => ({ top: bodyTop(), height: rendered(), bottom: bodyTop() + rendered(), left: 0, right: 0, width: 0 })
  body.scrollHeight = 900; body.clientHeight = 40
  const seat = makeElement('div')                    // composer：sticky 盖在滚动口底部 → 上沿在视口里固定
  seat.getBoundingClientRect = () => ({ top: 740, height: 60, bottom: 800, left: 0, right: 0, width: 0 })
  const rows = [row]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')   // 这一轮"跑完了" → 不触发收尾滑行（它会带走滚动位置）
  scroller.querySelector = (sel) => { const s = String(sel); return s.includes('data-composer-seat') ? seat : (s.includes('data-turn-tail') ? tail : null) }
  flow.querySelector = () => null
  const qa = (sel) => { const s = String(sel); return s.includes('_thinkBody') ? [body] : (s.includes('data-chat-flow-kind') ? rows : []) }
  scroller.querySelectorAll = qa; flow.querySelectorAll = qa
  scroller.contains = () => true; scroller.closest = () => null
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, true)   // scrollTop 走容器访问器（store 支持）：takeOverSnap 换上的实例访问器读的就是它
      // 真 DOM 里窗口长高＝内容长高：scrollHeight 跟着渲染高度走（否则底边补偿写不进去）
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 + rendered() })
      scroller.scrollTop = 1160                      // floor = 1200 + 窗高：起点离底 40px（跟随会先写一笔 → followWrote 非空）
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' }); api.scan()
  eq(body.dataset.dshsfWindow, 'reasoning', '前置：思考正文该被打成小窗；')
  let peak = 0
  for (let i = 0; i < 120; i += 1) { b.frame(16); peak = Math.max(peak, bodyTop() + rendered()) }
  const h = rendered()
  if (!(h > 259)) throw new Error('跟随中被夹住长不大（底边补偿没生效）：maxHeight=' + body.style.maxHeight)
  if (peak > 740.6) throw new Error('长高的过程中底边越过了 composer 上沿：峰值 bottom=' + peak.toFixed(1))
  if (scroller.scrollTop < 1418) throw new Error('视图没跟着窗往上走：scrollTop=' + scroller.scrollTop)
  // 读者接管后位置不是我们的：只夹高度、不动人家的位置
  api.set({ autoFollow: false }); scroller.scrollTop = 1160; api.scan()
  for (let i = 0; i < 400; i += 1) b.frame(16)
  eq(scroller.scrollTop, 1160, '不跟随时不许动滚动位置；')
  eq(body.style.maxHeight, '16px', '不跟随时把窗夹到下边界余量（此刻余量 0 → 最小高度 16px）；')
  return '跟随中长到 ' + h.toFixed(0) + 'px、底边峰值 ' + peak.toFixed(1) + ' 钉在 740 · 接管后只夹高度'
})

/* -------- T3：窗就是最下面那块内容、且已经贴底（没有滞后余量）时，仍要能长到上限 -- */
await check('T3 贴底且没有滞后余量时，小窗仍要长到上限（不许被"余量"夹死）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  scroller.clientHeight = 800
  const TOP = 1900
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const body = makeElement('div'); body.className = '_thinkBody'
  think.appendChild(body); row.appendChild(think); body.parentElement = think
  think.closest = () => null
  body.closest = (sel) => (String(sel).includes('data-variant') ? think : null)
  body.matches = (sel) => /_thinkBody/.test(String(sel))
  const rendered = () => parseFloat(body.style.maxHeight) || 0
  const bodyTop = () => TOP - scroller.scrollTop
  body.getBoundingClientRect = () => ({ top: bodyTop(), height: rendered(), bottom: bodyTop() + rendered(), left: 0, right: 0, width: 0 })
  body.scrollHeight = 900; body.clientHeight = 40
  const seat = makeElement('div')
  seat.getBoundingClientRect = () => ({ top: 740, height: 60, bottom: 800, left: 0, right: 0, width: 0 })
  const rows = [row]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')
  scroller.querySelector = (sel) => { const s = String(sel); return s.includes('data-composer-seat') ? seat : (s.includes('data-turn-tail') ? tail : null) }
  flow.querySelector = () => null
  const qa = (sel) => { const s = String(sel); return s.includes('_thinkBody') ? [body] : (s.includes('data-chat-flow-kind') ? rows : []) }
  scroller.querySelectorAll = qa; flow.querySelectorAll = qa
  scroller.contains = () => true; scroller.closest = () => null
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, true)
      // base 1960 = 贴底时窗底边正好压在下边界上（余量 ≡ 窗高）：这正是"只夹高度会把窗夹死"的临界摆放
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1960 + rendered() })
      scroller.scrollTop = 1160
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' }); api.scan()
  eq(body.dataset.dshsfWindow, 'reasoning', '前置：思考正文该被打成小窗；')
  let peak = 0
  for (let i = 0; i < 120; i += 1) { b.frame(16); peak = Math.max(peak, bodyTop() + rendered()) }
  const h = rendered()
  if (!(h > 259)) throw new Error('贴底无余量时被夹住长不大（这是"只夹高度"那条错路）：maxHeight=' + body.style.maxHeight)
  if (peak > 740.6) throw new Error('长高的过程中底边越过了 composer 上沿：峰值 bottom=' + peak.toFixed(1))
  return '长到 ' + h.toFixed(0) + 'px、底边峰值 ' + peak.toFixed(1) + ' 钉在 740'
})

/* -------- T4：正文一挂上来就当场打小窗（不等 300ms 节流扫描） -- */
await check('T4 新挂载的思考正文在 MutationObserver 里当场打小窗', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  scroller.scrollHeight = 2000; scroller.clientHeight = 800
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const body = makeElement('div'); body.className = '_thinkBody'
  think.appendChild(body); row.appendChild(think); body.parentElement = think
  think.closest = () => null
  body.closest = (sel) => (String(sel).includes('data-variant') ? think : null)
  body.matches = (sel) => /_thinkBody/.test(String(sel))
  body.getBoundingClientRect = () => ({ top: 700, height: 260, bottom: 960, left: 0, right: 0, width: 0 })
  body.scrollHeight = 900; body.clientHeight = 40
  const seat = makeElement('div')
  seat.getBoundingClientRect = () => ({ top: 740, height: 60, bottom: 800, left: 0, right: 0, width: 0 })
  const rows = [row]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')
  scroller.querySelector = (sel) => { const s = String(sel); return s.includes('data-composer-seat') ? seat : (s.includes('data-turn-tail') ? tail : null) }
  flow.querySelector = () => null
  const qa = (sel) => { const s = String(sel); return s.includes('_thinkBody') ? [body] : (s.includes('data-chat-flow-kind') ? rows : []) }
  scroller.querySelectorAll = qa; flow.querySelectorAll = qa
  scroller.contains = () => true; scroller.closest = () => null
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, true)
    },
  })
  const api = b.api()
  api.set({ mode: 'fold' })
  eq(body.dataset.dshsfWindow, undefined, '前置：还没打标；')
  b.fireMutations([{ type: 'childList', target: flow, addedNodes: [body] }])   // 只给观察器，不调 api.scan()
  eq(body.dataset.dshsfWindow, 'reasoning', '新挂上来的正文必须当场打小窗（等扫描它会先按原始高度铺开 = 掉一下）；')
  eq(body.style.getPropertyValue('--dshsf-hw'), '40px', '当场打标也要按余量夹住入场目标；')
  return '观察器当场打标（40px）'
})

/* -------- T5：入场动画期间不许把目标高度推过动画落点 -- */
await check('T5 入场动画期间目标高度不越过动画落点（动画一结束不再跳一下）', () => {
  const flow = makeElement('div'); const scroller = makeElement('div')
  flow.parentElement = scroller; flow.isConnected = true
  scroller.scrollHeight = 2000; scroller.clientHeight = 800
  const row = makeRow('1'); row.parentElement = flow; flow.children.push(row)
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const body = makeElement('div'); body.className = '_thinkBody'
  think.appendChild(body); row.appendChild(think); body.parentElement = think
  think.closest = () => null
  body.closest = (sel) => (String(sel).includes('data-variant') ? think : null)
  body.matches = (sel) => /_thinkBody/.test(String(sel))
  body.getBoundingClientRect = () => ({ top: 700, height: 260, bottom: 960, left: 0, right: 0, width: 0 })
  body.scrollHeight = 900; body.clientHeight = 40
  const seat = makeElement('div')
  seat.getBoundingClientRect = () => ({ top: 740, height: 60, bottom: 800, left: 0, right: 0, width: 0 })
  const rows = [row]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')
  scroller.querySelector = (sel) => { const s = String(sel); return s.includes('data-composer-seat') ? seat : (s.includes('data-turn-tail') ? tail : null) }
  flow.querySelector = () => null
  const qa = (sel) => { const s = String(sel); return s.includes('_thinkBody') ? [body] : (s.includes('data-chat-flow-kind') ? rows : []) }
  scroller.querySelectorAll = qa; flow.querySelectorAll = qa
  scroller.contains = () => true; scroller.closest = () => null
  flow.contains = () => true; flow.closest = () => null
  const b = build({
    rows,
    patch(doc, sandbox) {
      doc.querySelector = (sel) => (String(sel).includes('data-chat-flow') ? flow : null)
      doc.querySelectorAll = (sel) => (String(sel).includes('data-chat-flow-kind') ? rows : (String(sel).includes('data-chat-flow') ? [flow] : []))
      stubScroll(sandbox, scroller, null, true)
    },
  })
  const api = b.api()
  b.fireWindow('pointerdown', { type: 'pointerdown' })          // 开动效：allowAnim → rootVars 会给 html 挂 data-dshsf-anim
  api.set({ mode: 'fold' }); api.scan()
  eq(b.documentElement.hasAttribute('data-dshsf-anim'), true, '前置：动效该开着（没有入场动画这条就没意义）；')
  eq(body.dataset.dshsfEntering, '1', '前置：入场动画期间该有 entering 标记；')
  eq(body.dataset.dshsfEnterH, '40', '前置：动画落点 = 余量 40px；')
  for (let i = 0; i < 20; i += 1) b.frame(16)
  eq(body.style.maxHeight, '40px', '动画没跑完之前不许把目标推过去（否则动画一结束整块落地 = 掉一下）；')
  delete body.dataset.dshsfEntering                              // 真机是 320ms 的定时器清的
  for (let i = 0; i < 20; i += 1) b.frame(16)
  if (!(parseFloat(body.style.maxHeight) > 100)) throw new Error('动画结束后必须接着长（别把窗冻住）：' + body.style.maxHeight)
  return '动画期间钉在 40px，结束后接着长到 ' + body.style.maxHeight
})

let bad = 0
for (const [st, name, note] of results) { if (st === 'FAIL') bad += 1; console.log(st.padEnd(4), name, note ? '| ' + note : '') }
if (bad) { console.log('settle: ' + bad + ' FAIL'); process.exit(1) }
console.log('settle: ok')
process.exit(0)
