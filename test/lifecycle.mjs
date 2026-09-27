/**
 * 生命周期护栏（C1/C2/C3）：
 *   C1 configForms 订阅必须能退订，卸载后旧回调不再写官方档位；
 *   C2 接线标记按实例随机（WIRE_TOKEN），热重载后新实例仍能挂上收起动画拦截；
 *   C3 锚定接管（overflowAnchor + anchorRO）在 dispose 时必须当场回收，之后不再写 scrollTop。
 * 桩 DOM 是本仓库自带的迷你实现（makeElement / build / makeDom / frame），无外部依赖。
 * CLIENT_SRC 指到临时还原过的 client.js 即可做负向对照（默认 ../lib/client.js）。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.env.CLIENT_SRC || new URL('../lib/client.js', import.meta.url)
const source = readFileSync(CLIENT, 'utf8')

function makeStyle() {
  const p = new Map()
  return { getPropertyValue: (k) => p.get(k) || '', setProperty: (k, v) => p.set(k, v), removeProperty: (k) => p.delete(k) }
}
function makeElement(tag) {
  const attrs = new Map()
  return {
    tagName: String(tag).toUpperCase(), nodeType: 1, style: makeStyle(), dataset: {}, children: [], childNodes: [], isConnected: true,
    className: '', id: '', textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, firstElementChild: undefined, parentElement: null,
    appendChild(c) { this.children.push(c); return c },
    insertBefore(n, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n },
    removeChild() {}, remove() {}, focus() {}, click() {},
    setAttribute(k, v) { attrs.set(k, String(v)) },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null },
    removeAttribute(k) { attrs.delete(k) },
    hasAttribute(k) { return attrs.has(k) },
    toggleAttribute(k, on) { if (on) attrs.set(k, ''); else attrs.delete(k); return attrs.has(k) },
    addEventListener(type, fn) { (this._lis = this._lis || {})[type] = (this._lis[type] || []).concat(fn) },
    removeEventListener(type, fn) { if (this._lis && this._lis[type]) this._lis[type] = this._lis[type].filter((f) => f !== fn) },
    dispatchEvent() { return true },
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
/** 假 ctx：effect 记录 disposer（真实 cordis 也是 apply 期注册、dispose 期调用）；configForms 订阅是可计数的 spy。 */
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
  const fakeConsole = { ...console, warn: () => {}, info: () => {} }; const observers = []; let moCb = null
  const sandbox = {
    window: windowStub, document: documentStub, console: fakeConsole, navigator: { userAgent: 'node' },
    performance: { now: () => vnow }, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    getComputedStyle: windowStub.getComputedStyle, localStorage: windowStub.localStorage,
    requestAnimationFrame: windowStub.requestAnimationFrame, cancelAnimationFrame: windowStub.cancelAnimationFrame,
    MutationObserver: class { constructor(cb) { this.cb = cb; moCb = cb; observers.push(this) } observe() {} disconnect() {} takeRecords() { return [] } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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
  const exportsObject = captured((name) => (name === 'react' ? reactStub : {}))
  const scopeSpy = { subs: 0, unsubs: 0, setCalls: 0, listeners: [] }
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { transcriptView: 'standard' }, writable: true }),
    subscribe: (fn) => {
      scopeSpy.subs += 1; scopeSpy.listeners = scopeSpy.listeners.concat(fn)
      return () => { scopeSpy.unsubs += 1; scopeSpy.listeners = scopeSpy.listeners.filter((f) => f !== fn) }
    },
    set: async () => { scopeSpy.setCalls += 1; return false },
  }
  const disposers = []
  exportsObject.apply({
    effect: (fn) => { const d = fn(); const dd = typeof d === 'function' ? d : () => {}; disposers.push(dd); return dd },
    inject: (deps, cb) => cb({ locale: { bind: () => (k) => k }, configForms: { get: () => scope } }),
    slots: { inject: () => {}, register: () => {} }, on: () => {}, get: () => undefined, provide: () => {},
  })
  const frame = (dt = 16) => { vnow += dt; for (const cb of rafQ.splice(0)) { try { cb(vnow) } catch { /* ignore */ } } }
  const fireWindow = (type, ev) => { for (const fn of winListeners[type] || []) { try { fn(ev || { type }) } catch { /* ignore */ } } }
  return {
    api: () => windowStub.__dshStreamfold, documentElement, window: windowStub, observers, frame, fireWindow,
    scopeSpy, disposers, emitScope: () => { for (const f of scopeSpy.listeners.slice()) f() },
    fireMutations: (recs) => { if (moCb) moCb(recs) },
  }
}
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
/** 一个可跨两代实例复用的 DOM：含主滚动链、一轮行、官方的收尾 tail、以及一个上下文注入行（带正文）。 */
function makeDom() {
  const state = { running: false }
  const flow = makeElement('div'); const scroller = makeElement('div'); const created = []
  const mainHolder = makeElement('div'); mainHolder.setAttribute('data-conversation-session', 'A')
  scroller.scrollHeight = 2000; scroller.clientHeight = 800        // floor = 1200
  flow.parentElement = scroller; flow.isConnected = true
  const mkRow = (kind, turn, top) => {
    const el = makeElement('div')
    el.setAttribute('data-chat-flow-kind', kind); el.setAttribute('data-chat-turn', turn); el.parentElement = flow
    el.getBoundingClientRect = () => ({ top: top - scroller.scrollTop, height: 30, bottom: 0, left: 0, right: 0, width: 0 })
    return el
  }
  const userRow = mkRow('user', '1', 1150)
  const toolRow = mkRow('tool-call', '1', 1160)
  const toolRows = [toolRow, mkRow('tool-call', '1', 1165), mkRow('tool-call', '1', 1170), mkRow('tool-call', '1', 1175), mkRow('tool-call', '1', 1180)]
  const rows = [userRow, ...toolRows, mkRow('assistant-step', '1', 1190)]
  const tail = makeElement('div'); tail.setAttribute('data-actions-reveal', 'always')
  const marker = makeElement('div')
  // 上下文注入行（官方 DisclosureRow）：正文的父节点就是接线根
  const ctxRoot = makeElement('div'); const ctxBody = makeElement('div')
  ctxBody.setAttribute('data-context-injection-body', '')
  ctxBody.parentElement = ctxRoot
  ctxRoot.appendChild(ctxBody)
  ctxRoot.querySelector = (sel) => (String(sel).includes('data-context-injection-body') ? ctxBody : null)
  ctxRoot.closest = () => null
  const pick = (sel) => {
    const t = String(sel)
    if (t.includes('data-turn-tail')) return tail
    if (t.includes('data-state') || t.includes('data-streaming')) return state.running ? marker : null
    return null
  }
  const qsa = (sel) => {
    const s = String(sel)
    if (s.includes('data-context-injection-body')) return [ctxBody]
    if (s.includes('data-chat-flow-kind')) return rows
    if (s.includes('data-chat-flow')) return [flow]
    if (s.includes('data-turn-tail')) return [tail]
    return []
  }
  scroller.querySelector = pick; scroller.querySelectorAll = qsa
  scroller.contains = () => true
  scroller.closest = (sel) => (String(sel).includes('data-conversation-session') ? mainHolder : null)
  scroller.getBoundingClientRect = () => ({ top: 0, height: 800, bottom: 800, left: 0, right: 0, width: 0 })
  flow.querySelector = pick; flow.querySelectorAll = qsa
  flow.contains = () => true; flow.closest = () => null
  let writes = 0
  const patch = (doc, sandbox) => {
    doc.querySelector = (sel) => {
      const s = String(sel)
      if (s.includes('data-conversation-session')) return mainHolder
      if (s.includes('data-chat-flow')) return flow
      return null
    }
    doc.querySelectorAll = (sel) => qsa(sel)
    const origCreate = doc.createElement
    doc.createElement = (t) => { const el = origCreate(t); created.push(el); return el }
    stubScroll(sandbox, scroller, () => { writes += 1 }, true)
  }
  return { patch, rows, flow, scroller, created, ctxRoot, ctxBody, mainHolder, toolRow, writes: () => writes, state }
}

const results = []
async function check(name, fn) {
  try { results.push(['PASS', name, (await fn()) || '']) }
  catch (e) { results.push(['FAIL', name, (e && e.message) || String(e)]) }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || '') + ' 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)) }
const flush = () => new Promise((r) => setTimeout(r, 0))
const start = (dom, b) => {
  const api = b.api()
  if (!api) throw new Error('apply 没起来（window.__dshStreamfold 缺失）')
  api.set({ mode: 'fold' })
  b.fireWindow('pointerdown', { type: 'pointerdown' })   // 用户首次交互 → allowAnim
  api.scan()
  return api
}

/* ------------------------------------------------------- C1 订阅可退订 -- */
await check('C1 configForms 订阅可退订：dispose 后旧回调不再写官方档位', async () => {
  const dom = makeDom()
  const b = build({ rows: dom.rows, patch: dom.patch })
  const api = start(dom, b)
  eq(b.scopeSpy.subs, 1, 'configForms 应订阅一次；')
  const before = b.scopeSpy.setCalls
  b.emitScope()
  await flush()
  if (b.scopeSpy.setCalls <= before) throw new Error('订阅回调没被接到（本该触发一次官方档位写入），桩环境没搭对')
  api.dispose()
  for (const d of b.disposers) { try { d() } catch { /* ignore */ } }
  eq(b.scopeSpy.unsubs, 1, 'dispose 后必须退订（否则每次重载都留一个持有整个模块实例的常驻回调）；')
  eq(b.scopeSpy.listeners.length, 0, '订阅表里不该还挂着旧实例的回调；')
  const afterDispose = b.scopeSpy.setCalls
  b.emitScope()
  await flush()
  eq(b.scopeSpy.setCalls, afterDispose, '卸载后再触发旧回调，不能继续往官方档位写；')
  return 'subs=1 unsubs=1 setCalls ' + before + '→' + afterDispose + '（触发后 +' + (afterDispose - before) + '）'
})

/* --------------------------------------------------- C2 接线令牌认亲 -- */
await check('C2 接线令牌每实例独立：热重载后新实例仍挂上收起动画拦截', () => {
  const dom = makeDom()
  const bA = build({ rows: dom.rows, patch: dom.patch })
  const apiA = start(dom, bA)
  const tokenA = dom.ctxRoot.dataset.dshsfWired
  if (!tokenA) throw new Error('第一代没写接线标记，桩环境没搭对')
  apiA.dispose()                                        // 热重载：旧实例收摊，标记留在 root 上
  const bB = build({ rows: dom.rows, patch: dom.patch })  // 新 vm 上下文 = 新一代实例（新 token）
  const apiB = start(dom, bB)
  const tokenB = dom.ctxRoot.dataset.dshsfWired
  dom.ctxRoot.fire('click')                             // target 落在正文之外 = 收起动作
  eq(dom.ctxBody.dataset.dshsfClosing, '1', '新实例的收起动画拦截必须生效（旧实现被上一代的标记挡在门外）；')
  const listeners = (dom.ctxRoot._lis && dom.ctxRoot._lis.click) || []
  eq(listeners.length, 2, '新实例必须自己再挂一条 click 拦截（旧那条已被 disposed 挡住）；')
  if (tokenA === tokenB) throw new Error('新实例没有重新接线：标记仍是上一代的 ' + JSON.stringify(tokenB))
  apiB.dispose()
  return 'tokenA=' + tokenA + ' tokenB=' + tokenB + ' listeners=2 closing=1'
})

/* ----------------------------------------------------- C3 锚定接管回收 -- */
await check('C3 dispose 当场回收锚定接管（overflowAnchor + 不再写 scrollTop）', () => {
  const dom = makeDom()
  const b = build({ rows: dom.rows, patch: dom.patch })
  const api = start(dom, b)
  const chip = dom.created.find((el) => String(el.id || '').startsWith('dshsf-chip'))
  if (!chip) throw new Error('没找到折叠条：' + JSON.stringify(dom.created.map((e) => e.id)))
  const writes0 = dom.writes()
  let chipTop = 0
  chip.getBoundingClientRect = () => ({ top: chipTop, height: 30, bottom: chipTop + 30, left: 0, right: 0, width: 0 })
  chip.fire('click')                                    // → anchorDuring：关掉浏览器滚动锚定 + 挂 anchorRO
  eq(dom.scroller.style.overflowAnchor, 'none', '点击折叠条应起锚定接管（scroller.style.overflowAnchor=none）；')
  chipTop = 40
  for (let i = 0; i < 3; i += 1) b.frame(16)
  if (dom.writes() <= writes0) throw new Error('锚定接管期间没补写 scrollTop，桩环境没搭对')
  api.dispose()
  eq(dom.scroller.style.overflowAnchor, '', 'dispose 必须当场把 overflowAnchor 还原；')
  const writesAt = dom.writes()
  chipTop = 120
  for (let i = 0; i < 10; i += 1) b.frame(16)           // 旧实例残留的 rAF/RO 回调都不许再写位置
  eq(dom.writes(), writesAt, 'dispose 后帧循环不该再写 scrollTop；')
  return 'overflowAnchor none→"" · dispose 前补写 ' + (writesAt - writes0) + ' 次，之后 0 次'
})

let bad = 0
for (const [st, name, note] of results) { if (st === 'FAIL') bad += 1; console.log(st.padEnd(4), name, note ? '| ' + note : '') }
if (bad) { console.log('lifecycle: ' + bad + ' FAIL'); process.exit(1) }
console.log('lifecycle: ok')
process.exit(0)
