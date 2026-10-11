/**
 * 客户端半区冒烟：在最小 DOM 下把 apply() 跑一遍，必须不抛错、并且挂出调试出口。
 *
 * 防的是「引用了一个不存在的函数」这类只在浏览器里才炸的错：客户端 fiber 一旦 failed，
 * GUI 上只显示一行 "dsh-streamfold: failed"，原始错误既不进页面也不进控制台
 * （2026-09-25 就是这么被藏了一整轮：rowsReport 被写进了 createSparkFx 工厂内部）。
 *
 * M-29（2026-10-10 正确性批次）：加 dispose → 再 dispose（幂等）→ 摘净逐元素监听/标记 → 再 apply
 * 重新接线的用例。为了真实触发 wireDisclosure，这里带一个可查询的迷你 DOM（选择器子集）。
 * 基线 sha 40193536 上本用例应红（dispose 不清 data-dshsf-wired 也不摘逐元素 click 监听）。
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const sourcePath = process.env.CLIENT_SRC || new URL('../lib/client.js', import.meta.url)
const source = readFileSync(sourcePath, 'utf8')

/* --------------------------------------------------- 迷你 DOM（选择器子集） -- */
function makeStyle() {
  const props = new Map()
  return {
    getPropertyValue: (k) => props.get(k) || '',
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  }
}
function kebab(key) { return String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) }
function descendants(el) {
  const out = []
  const walk = (node) => { for (const child of node.children) { out.push(child); walk(child) } }
  walk(el)
  return out
}
/** 一个 compound：tag? ( [attr] | [attr=v] | [attr*=v] | .class )* */
function matchCompound(el, compound) {
  const m = compound.match(/^([a-zA-Z][\w-]*|\*)?((?:\[[^\]]*\]|\.[\w-]+)*)$/)
  if (!m) return false
  const tag = m[1]
  if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false
  const tokenRe = /\[([^\]]*)\]|\.[\w-]+/g
  let t
  while ((t = tokenRe.exec(m[2] || '')) !== null) {
    const raw = t[0]
    if (raw[0] === '.') { if (!String(el.className).split(/\s+/).includes(raw.slice(1))) return false; continue }
    const body = t[1]
    let am = body.match(/^([\w-]+)\s*(\*?=)\s*(['"]?)(.*?)\3$/)
    if (!am) { am = body.match(/^([\w-]+)$/); if (!am) return false; if (!el.hasAttribute(am[1])) return false; continue }
    const have = el.getAttribute(am[1])
    if (have === null) return false
    if (am[2] === '*=') { if (!String(have).includes(am[4])) return false } else if (String(have) !== am[4]) return false
  }
  return true
}
function matchesSel(el, selector) {
  for (const group of String(selector).split(',')) {
    let g = group.trim()
    if (!g) continue
    if (g.startsWith(':scope > ')) g = g.slice(9).trim()
    const parts = g.split(/\s+/)
    if (!matchCompound(el, parts[parts.length - 1])) continue
    let idx = parts.length - 2
    for (let n = el.parentElement; n && idx >= 0; n = n.parentElement) if (matchCompound(n, parts[idx])) idx -= 1
    if (idx < 0) return true
  }
  return false
}
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.style = makeStyle()
    this.children = []
    this.parentElement = null
    this.parentNode = null
    this.isConnected = true
    this._text = ''
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.offsetHeight = 0
    this._attrs = new Map()
    this._listeners = new Map()
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' && this._attrs.has('data-' + kebab(k)) ? this._attrs.get('data-' + kebab(k)) : undefined),
      set: (_t, k, v) => { const a = 'data-' + kebab(k); if (v === undefined || v === null || v === false) this._attrs.delete(a); else this._attrs.set(a, String(v)); return true },
      deleteProperty: (_t, k) => { this._attrs.delete('data-' + kebab(k)); return true },
      has: (_t, k) => this._attrs.has('data-' + kebab(k)),
    })
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }
  set textContent(v) { this._text = String(v); this.children = [] }
  get className() { return this.getAttribute('class') || '' }
  set className(v) { this.setAttribute('class', String(v)) }
  get childNodes() { return this.children }
  get firstElementChild() { return this.children.length ? this.children[0] : null }
  get previousElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1] : null }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.parentNode = this; child.isConnected = true; return child }
  insertBefore(child, ref) {
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child)
    child.parentElement = this; child.parentNode = this; child.isConnected = true
    return child
  }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentElement = null; child.parentNode = null; child.isConnected = false; return child }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); else this.isConnected = false }
  focus() {} blur() {} click() {}
  setAttribute(k, v) { this._attrs.set(String(k), String(v)) }
  getAttribute(k) { return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null }
  removeAttribute(k) { this._attrs.delete(String(k)) }
  hasAttribute(k) { return this._attrs.has(String(k)) }
  toggleAttribute(k, on) { const key = String(k); const want = on === undefined ? !this._attrs.has(key) : !!on; if (want) this._attrs.set(key, ''); else this._attrs.delete(key); return this._attrs.has(key) }
  addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn) }
  removeEventListener(type, fn) { const a = this._listeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } }
  dispatchEvent(evt) { const a = this._listeners.get(evt && evt.type); if (a) for (const fn of a.slice()) fn(evt); return true }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } }
  matches(sel) { return matchesSel(this, sel) }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.nodeType === 1 && matchesSel(n, sel)) return n; return null }
  contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false }
  querySelectorAll(sel) {
    const s = String(sel).trim()
    if (s.startsWith(':scope > ')) return this.children.filter((c) => matchesSel(c, s.slice(9).trim()))
    return descendants(this).filter((el) => matchesSel(el, s))
  }
  querySelector(sel) { const all = this.querySelectorAll(sel); return all.length ? all[0] : null }
  getElementsByTagName(name) { const t = String(name).toUpperCase(); return descendants(this).filter((el) => name === '*' || el.tagName === t) }
}
function makeElement(tag = 'div') { return new FakeElement(tag) }

const head = makeElement('head')
const body = makeElement('body')
const documentElement = makeElement('html')
documentElement.appendChild(head)
documentElement.appendChild(body)
const docQuery = (sel) => [documentElement, ...descendants(documentElement)].filter((el) => matchesSel(el, sel))
const documentStub = {
  head, body, documentElement, baseURI: 'http://127.0.0.1:3080/',
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text) }),
  getElementById: (id) => descendants(documentElement).find((el) => el.getAttribute('id') === id) || null,
  querySelector: (sel) => docQuery(sel)[0] || null,
  querySelectorAll: (sel) => docQuery(sel),
  getElementsByTagName: (name) => descendants(documentElement).filter((el) => name === '*' || el.tagName === String(name).toUpperCase()),
  addEventListener() {}, removeEventListener() {}, contains: () => true,
}

let captured = null
const rafQueue = []
const pumpRaf = () => { const q = rafQueue.splice(0, rafQueue.length); for (const fn of q) fn(Date.now()) }
const windowListeners = new Map()
const windowStub = {
  __ModuleLoader__: { load: (definition) => { captured = definition.factory } },
  innerHeight: 800,
  addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(fn) },
  removeEventListener(type, fn) { const a = windowListeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
  dispatchEvent(evt) { const a = windowListeners.get(evt && evt.type); if (a) for (const fn of a.slice()) fn(evt); return true },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
  cancelAnimationFrame() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: (el) => ({ overflowY: (el && el.__overflowY) || 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1:3080/' },
}

const sandbox = {
  window: windowStub, document: documentStub, console,
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  getComputedStyle: windowStub.getComputedStyle,
  localStorage: windowStub.localStorage,
  requestAnimationFrame: windowStub.requestAnimationFrame, cancelAnimationFrame: windowStub.cancelAnimationFrame,
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  Element: FakeElement, HTMLElement: FakeElement, Node: class {}, Event: class {}, CustomEvent: class {},
  navigator: { userAgent: 'node' },
}
sandbox.window.document = documentStub
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const TEST_HOOK = 'window.__sfTest = { anchorDuring, anchorCtl: () => anchorCtl, unfoldRowAnimated, syncTurns, collectTurns, chatScope, hold, setSettleTurn: (t) => { settleTurn = t; settleUntil = performance.now() + 1000; }, getSettleTurn: () => settleTurn, setSettleArm: (a) => { settleArm = a; } };'
const hooked = source.replace('exports.apply = apply;', TEST_HOOK + '\nexports.apply = apply;')
assert.notEqual(hooked, source, '测试注入锚点丢失（client.js 结构已变）')
vm.runInContext(hooked, sandbox, { filename: 'lib/client.js' })
assert.ok(captured, '客户端 bundle 没有通过 window.__ModuleLoader__.load 注册 factory')

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(), useCallback: (fn) => fn, memo: (component) => component,
  Fragment: Symbol('Fragment'), createContext: () => ({ Provider: null, Consumer: null }),
}
const requireStub = (name) => (name === 'react' ? reactStub : {})
const exportsObject = captured(requireStub)
assert.equal(typeof exportsObject.apply, 'function', '客户端 bundle 没有导出 apply')

const nativeScopeStub = {
  getSnapshot: () => ({ status: 'loading', value: undefined, writable: false }),
  subscribe: () => () => {},
  set: async () => false,
}
const context = {
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  inject: (deps, callback) => callback({
    locale: { bind: () => (key) => key },
    configForms: { get: () => nativeScopeStub },
  }),
  slots: { inject: () => {}, register: () => {} },
  on: () => {}, get: () => undefined, provide: () => {},
}

exportsObject.apply(context)

const api = windowStub.__dshStreamfold
assert.ok(api, 'apply() 跑完没有挂出 window.__dshStreamfold')
/* 键表 = 长期公开面（迁移阶段 1 收窄）：probe/rows/stats 是聚合报表，将随诊断聚合搬去 dev 插件
 * （迁移计划 §4 阶段 1/3，维护者文档）⇒ 不再强求存在；
 * 若仍在，必须仍是函数、空 DOM 下不抛（兼容档；阶段 3 转严格版 = 必须不存在）。 */
for (const key of ['scan', 'set', 'get', 'chooseDisplay', 'state', 'dispose']) {
  assert.equal(typeof api[key], 'function', '调试出口缺函数：' + key)
}
assert.ok(api.fx, '调试出口缺 fx（火花调参入口）')
assert.doesNotThrow(() => api.scan(), 'scan() 在空 DOM 下抛错')
assert.doesNotThrow(() => api.get(), 'get() 在空 DOM 下抛错')
for (const key of ['probe', 'rows', 'stats']) {
  if (api[key] === undefined) continue
  assert.equal(typeof api[key], 'function', '调试出口存在但非函数：' + key)
  assert.doesNotThrow(() => api[key](), key + '() 在空 DOM 下抛错')
}

/* ---------------- M-29：apply → dispose → 再 dispose → 再 apply（负向对照见报告） ---------------- */
const listenerCount = (el, type) => { const a = el._listeners.get(type); return a ? a.length : 0 }
const clickEvent = (target) => ({
  type: 'click', target, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true }, stopPropagation() {},
})
function buildChatTree() {
  const scroller = makeElement('div'); scroller.__overflowY = 'auto'
  const flow = makeElement('div'); flow.setAttribute('data-chat-flow', '')
  scroller.appendChild(flow)
  const row = makeElement('div')
  row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
  const think = makeElement('div'); think.setAttribute('data-variant', 'think')
  const toggle = makeElement('button'); toggle.setAttribute('data-disclosure-row', ''); toggle.setAttribute('aria-expanded', 'false')
  const thinkBody = makeElement('div'); thinkBody.className = 'x_thinkBody y'; thinkBody.dataset.dshsfWindow = 'reasoning'
  think.appendChild(toggle); think.appendChild(thinkBody); row.appendChild(think); flow.appendChild(row)
  const tail = makeElement('div'); tail.setAttribute('data-turn-tail', '1'); tail.setAttribute('data-actions-reveal', 'always'); scroller.appendChild(tail)
  documentStub.body.appendChild(scroller)
  return { think, thinkBody }
}
const tree = buildChatTree()
api.set({ foldHistory: false })          // 隔离折叠批次：只测接线/摘线
api.scan()
assert.equal(tree.think.getAttribute('data-dshsf-wired'), '1', 'M-29 前提：scan 应给思考根接线')
assert.equal(listenerCount(tree.think, 'click'), 1, 'M-29 前提：应挂一个逐元素 click 监听')
windowStub.dispatchEvent({ type: 'pointerdown' })   // 唤醒动效开关（wireDisclosure 前置）
const ev1 = clickEvent(tree.think)
tree.think.dispatchEvent(ev1)
assert.equal(ev1.defaultPrevented, true, 'M-29 前提：接线后点击收起应被拦下（对照组）')
delete tree.thinkBody.dataset.dshsfClosing

api.dispose()
assert.equal(tree.think.getAttribute('data-dshsf-wired'), null, 'M-29 dispose 后不得残留 data-dshsf-wired')
assert.equal(listenerCount(tree.think, 'click'), 0, 'M-29 dispose 后不得残留逐元素 click 监听')
assert.doesNotThrow(() => api.dispose(), 'M-29 dispose 应幂等（第二次不抛）')
const ev2 = clickEvent(tree.think)
tree.think.dispatchEvent(ev2)
assert.equal(ev2.defaultPrevented, false, 'M-29 dispose 后监听不得再拦截收起')

const exports2 = captured(requireStub)   // 重跑 factory = 热重载重新求值 bundle（模块级 disposed 复位）
exports2.apply(context)
const api2 = windowStub.__dshStreamfold
assert.ok(api2, 'M-29 再 apply 后应重新挂出 window.__dshStreamfold')
api2.scan()
assert.equal(tree.think.getAttribute('data-dshsf-wired'), '1', 'M-29 再 apply 应重新接线')
console.log('client-apply: dispose/re-apply (M-29) ok')

/* ---------------- 回归批次（测试侧，不占包体） ---------------- */
const sfTest = windowStub.__sfTest
assert.ok(sfTest, '测试 hook 未注入（client.js 锚点变了）')
const regressFails = []
const regress = (name, fn) => {
  try { fn(); console.log('client-apply: ' + name + ' ok') }
  catch (err) { regressFails.push(name + ': ' + String((err && err.message) || err)) }
}

// ：armSettle 等待起滑窗口内该轮不得先折（settleArm.turn 命中 ⇒ 排除出可折集）
regress('', () => {
  const row = tree.think.parentElement
  const flow0 = row.parentElement
  if (!flow0.querySelector('[data-answer-marker]')) {   // 本轮补一个"答行"，使 think 所在行成为可折的过程行
    const ans = makeElement('div'); ans.setAttribute('data-answer-marker', ''); ans.setAttribute('data-chat-flow-kind', 'assistant-step'); ans.setAttribute('data-chat-turn', '1'); flow0.appendChild(ans)
  }
  row.removeAttribute('data-dshsf-folded')
  row.removeAttribute('data-dshsf-row')
  sfTest.setSettleArm({ turn: '1' })
  try { sfTest.syncTurns(sfTest.chatScope(), false, sfTest.collectTurns()) }
  finally { sfTest.setSettleArm(null) }
  assert.equal(row.hasAttribute('data-dshsf-folded'), false, '等待起滑期不得折叠该轮')
})

// ：hold() 手动接管后协调必须作废（settleTurn 清），否则该轮永不折叠
regress('', () => {
  const row = tree.think.parentElement
  row.removeAttribute('data-dshsf-folded')
  sfTest.setSettleTurn('1')                              // 构造 settle 协调态
  sfTest.hold()                                          // 手动接管
  assert.equal(sfTest.getSettleTurn(), null, 'hold 后 settleTurn 应被清（协调作废）')
  sfTest.syncTurns(sfTest.chatScope(), false, sfTest.collectTurns())   // 协调已清 ⇒ 该轮不再被 settling 抑制（本夹具不产出折叠，只验证不抛且闩锁已清）
  assert.equal(sfTest.getSettleTurn(), null, '协调清掉后不得被 syncTurns 重新闩上')
})

// ：同 scope 再 apply 后，迟到的旧 disposer 不得把新代拆死（按代幂等）
regress('', () => {
  const apiOld = windowStub.__dshStreamfold
  delete windowStub.__dshStreamfold                 // 强制：下一次 apply 不 auto-dispose 旧实例
  exports2.apply(context)
  const api3 = windowStub.__dshStreamfold
  assert.ok(api3 && api3 !== apiOld, '前提：强制再 apply 出新实例')
  apiOld.dispose()                                  // 迟到的旧 disposer
  const flow = tree.think.parentElement.parentElement
  const row2 = makeElement('div'); row2.setAttribute('data-chat-flow-kind', 'assistant-step'); row2.setAttribute('data-chat-turn', '2')
  const think2 = makeElement('div'); think2.setAttribute('data-variant', 'think')
  const btn2 = makeElement('button'); btn2.setAttribute('data-disclosure-row', ''); think2.appendChild(btn2)
  const body2 = makeElement('div'); body2.className = 'x_thinkBody y'; body2.dataset.dshsfWindow = 'reasoning'; think2.appendChild(body2)
  row2.appendChild(think2); flow.appendChild(row2)
  api3.scan()
  assert.equal(think2.getAttribute('data-dshsf-wired'), '1', '迟到旧 dispose 不得使本代 scan 失效')
})

// ：unfoldRowAnimated 的 rAF/340ms 必须按代守卫（旧代不得再写 maxHeight）
await (async () => {
  let name = ''
  try {
    const row = makeElement('div')
    sfTest.unfoldRowAnimated(row)
    delete windowStub.__dshStreamfold
    exports2.apply(context)                         // genCount++（旧代回调作废）
    row.style.maxHeight = 'sentinel'
    pumpRaf()
    assert.equal(row.style.maxHeight, 'sentinel', '旧代 rAF 不得写 maxHeight')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(row.style.maxHeight, 'sentinel', '旧代 340ms 不得清 maxHeight')
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { regressFails.push(name + ': ' + String((err && err.message) || err)) }
})()

// ：anchorDuring 的逐帧 step 在 anchorSync 自停后不得空引用（旧代码读 null.until 抛 TypeError）
regress('', () => {
  sfTest.anchorDuring(tree.think, 0, 1000)          // 起一个锚定窗口并排队 step
  tree.think.remove()                               // 断连 ⇒ step 内的 anchorSync 会自停 anchorCtl
  let threw = null
  try { pumpRaf() } catch (err) { threw = err }
  assert.equal(threw, null, '锚定窗口到期/断连不得抛 TypeError：' + (threw && threw.message))
  assert.equal(sfTest.anchorCtl(), null, '自停后 anchorCtl 应清空')
})
assert.equal(regressFails.length, 0, 'R2 回归用例失败 —— ' + regressFails.join(' | '))

console.log('client-apply: ok')

/* ---------------- 2026-10-11 回归批次（B1/B2/B3；测试侧，不占客户包字节） ----------------
 * 三条都对 b46f4bfc（修前冻结快照，CLIENT_SRC 指向当时的 client.js 副本）转红：
 *  B1 release(reader) 交权后 anchorSync 仍把滚轮位置写回（writeCount 0→1）；
 *  B2 Ctrl+F 命中后 clearSearchHidden 交还自动收起，scan→closeThink 把刚揭开的命中正文卸载；
 *  B3 错峰收起中途反向展开，未打 folded 的 staged 行永久残留 maxHeight/overflow。
 * 夹具沿用本文件的选择器子集 DOM；每条独立 vm 上下文（模块级状态互不串）。 */
function makeR1Env(hook) {
  let capturedR1 = null
  const docListeners = new Map()
  const headR1 = makeElement('head'), bodyR1 = makeElement('body'), htmlR1 = makeElement('html')
  htmlR1.appendChild(headR1); htmlR1.appendChild(bodyR1)
  const allR1 = (sel) => [htmlR1, ...descendants(htmlR1)].filter((el) => matchesSel(el, sel))
  const docR1 = {
    head: headR1, body: bodyR1, documentElement: htmlR1, baseURI: 'http://127.0.0.1:3080/',
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text) }),
    getElementById: (id) => descendants(htmlR1).find((el) => el.getAttribute('id') === id) || null,
    querySelector: (sel) => allR1(sel)[0] || null,
    querySelectorAll: (sel) => allR1(sel),
    getElementsByTagName: (name) => descendants(htmlR1).filter((el) => name === '*' || el.tagName === String(name).toUpperCase()),
    addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn) },
    removeEventListener(type, fn) { const a = docListeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
    contains: () => true,
  }
  const winR1 = {
    __ModuleLoader__: { load: (definition) => { capturedR1 = definition.factory } },
    innerHeight: 800, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => { rafR1.push(fn); return rafR1.length },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: (el) => ({ overflowY: (el && el.__overflowY) || 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'http://127.0.0.1:3080/' },
  }
  const rafR1 = []
  const roList = []
  class ROStub {
    constructor() { this.targets = new Set(); roList.push(this) }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.targets.clear() }
  }
  const sb = {
    window: winR1, document: docR1, console,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    getComputedStyle: winR1.getComputedStyle, localStorage: winR1.localStorage,
    requestAnimationFrame: winR1.requestAnimationFrame, cancelAnimationFrame: winR1.cancelAnimationFrame,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    ResizeObserver: ROStub,
    Element: FakeElement, HTMLElement: FakeElement, Node: FakeElement,
    Event: class { constructor(type) { this.type = type } }, CustomEvent: class { constructor(type) { this.type = type } },
    navigator: { userAgent: 'node' },
    PointerEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
    MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
  }
  sb.window.document = docR1
  sb.globalThis = sb
  vm.createContext(sb)
  const hookedR1 = source.replace('exports.apply = apply;', hook + '\nexports.apply = apply;')
  assert.notEqual(hookedR1, source, 'R1 夹具：注入锚点丢失（client.js 结构已变）')
  vm.runInContext(hookedR1, sb, { filename: 'lib/client.js' })
  assert.ok(capturedR1, 'R1 夹具：factory 未注册')
  return { doc: docR1, body: bodyR1, win: winR1, listeners: docListeners, exports: capturedR1(requireStub), ros: roList }
}
function r1Chat(env) {
  const scroller = makeElement('div'); scroller.__overflowY = 'auto'; scroller.scrollHeight = 5000; scroller.clientHeight = 600
  const flow = makeElement('div'); flow.setAttribute('data-chat-flow', '')
  scroller.appendChild(flow); env.body.appendChild(scroller)
  return { scroller, flow }
}
const r1Fails = []
const r1 = (name, fn) => { try { fn(); console.log('client-apply: ' + name + ' ok') } catch (err) { r1Fails.push(name + ': ' + String((err && err.message) || err)) } }

// B1：release(reader) 交权后锚定补偿不得再写回滚轮位置
r1('R1-B1', () => {
  const env = makeR1Env('window.__sfR1 = { hold, anchorDuring, anchorSync, noteScrollIntent, ctl: () => anchorCtl, writes: () => writeCount };')
  const { scroller, flow } = r1Chat(env)
  const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
  row.getBoundingClientRect = () => ({ top: 1000 - scroller.scrollTop, bottom: 1040 - scroller.scrollTop, left: 0, right: 800, width: 800, height: 40, x: 0, y: 0 })
  flow.appendChild(row)
  const T = env.win.__sfR1
  T.hold()
  T.anchorDuring(row, row.getBoundingClientRect().top, 500)
  assert.notEqual(T.ctl(), null, 'B1 前提：anchorDuring 应建立锚定窗口')
  T.noteScrollIntent({ type: 'wheel', deltaY: -100, deltaX: 0, target: row })   // 真实输入 ⇒ release('reader')
  scroller.scrollTop = 300                                                      // 浏览器把读者落到 300
  const writes0 = T.writes()
  T.anchorSync()                                                                // 修前：RO/rAF 补偿把位置写回被点行
  assert.equal(scroller.scrollTop, 300, 'B1：reader 接管后 anchorSync 不得写回滚轮位置')
  assert.equal(T.writes(), writes0, 'B1：reader 接管后不得新增锚定补偿写')
  assert.equal(T.ctl(), null, 'B1：release(reader) 应立即停锚（恢复 overflowAnchor / 断开 RO）')
  assert.equal(scroller.style.overflowAnchor, '', 'B1：release(reader) 必须还原 overflow-anchor（M1 变异体：只清 anchorCtl ⇒ 转红）')
  assert.ok(env.ros.length > 0 && env.ros.every((ro) => ro.targets.size === 0), 'B1：release(reader) 必须断开 anchorRO（M1 变异体：只清 anchorCtl ⇒ 转红）')
})

// B1 对照：未交权（writer=us）时锚定补偿照常把被点行钉回原屏幕位置（防"停锚"误伤正常路径）
r1('R1-B1-live', () => {
  const env = makeR1Env('window.__sfR1b = { hold, anchorDuring, anchorSync, ctl: () => anchorCtl, writes: () => writeCount };')
  const { scroller, flow } = r1Chat(env)
  const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
  let docTop = 1000
  row.getBoundingClientRect = () => ({ top: docTop - scroller.scrollTop, bottom: docTop - scroller.scrollTop + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: 0 })
  flow.appendChild(row)
  const T = env.win.__sfR1b
  scroller.scrollTop = 200
  T.hold()
  T.anchorDuring(row, row.getBoundingClientRect().top, 500)   // 钉在屏幕 800
  docTop = 1100                                               // 上方内容长高 100px：行的屏幕位置下移
  const writes0 = T.writes()
  T.anchorSync()
  assert.equal(scroller.scrollTop, 300, 'B1 对照：writer=us 时锚定补偿应把被点行钉回原屏幕位置')
  assert.equal(T.writes(), writes0 + 1, 'B1 对照：锚定补偿是一笔我方写')
  assert.notEqual(T.ctl(), null, 'B1 对照：窗口未到期/未交权时不得停锚')
})

// B2：Ctrl+F 命中后 scan 不得把刚揭开的命中正文卸载；未命中节点仍保留 until-found
r1('R1-B2', () => {
  const env = makeR1Env('window.__sfR2 = { scan };')
  env.exports.apply(context)
  const api = env.win.__dshStreamfold
  assert.ok(api, 'B2 前提：apply 应挂出 __dshStreamfold')
  api.set({ autoExpandReasoning: false, foldHistory: false })
  const { flow } = r1Chat(env)
  const mkThinkIn = (row) => {
    const think = makeElement('div'); think.setAttribute('data-variant', 'think'); row.appendChild(think)
    const btn = makeElement('button'); btn.setAttribute('data-disclosure-row', ''); btn.setAttribute('aria-expanded', 'false'); think.appendChild(btn)
    const body = makeElement('div'); body.className = 'x_thinkBody y'
    btn.addEventListener('click', () => {   // 官方条件挂载：点开挂正文、再点卸载（React 语义）
      if (think.querySelector('[class*="_thinkBody"]') !== null) { body.remove(); btn.setAttribute('aria-expanded', 'false') }
      else { think.appendChild(body); btn.setAttribute('aria-expanded', 'true') }
    })
    return { think, body }
  }
  const mkThinkRow = (turn) => {
    const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', turn)
    const t = mkThinkIn(row)
    const tail = makeElement('div'); tail.setAttribute('data-turn-tail', turn); tail.setAttribute('data-actions-reveal', 'always'); flow.appendChild(tail)
    flow.appendChild(row)
    return { row, think: t.think, body: t.body }
  }
  const hit = mkThinkRow('1')
  const sib = mkThinkIn(hit.row)   // R3-A1：同一行里第二个被预挂载的根（浏览器不会命中它）
  const miss = mkThinkRow('2')
  for (const fn of env.listeners.get('keydown') || []) fn({ type: 'keydown', ctrlKey: true, key: 'f', target: env.body, preventDefault() {}, stopPropagation() {} })
  assert.equal(hit.body.getAttribute('hidden'), 'until-found', 'B2 前提：搜索预挂载应把正文藏成 until-found')
  assert.equal(hit.think.dataset.dshsfSearchOpen, '1', 'B2 前提：预挂载根应带 SearchOpen 归属')
  for (const fn of env.listeners.get('beforematch') || []) fn({ type: 'beforematch', target: hit.body })
  assert.equal(hit.body.getAttribute('hidden'), null, 'B2：命中正文必须当场可见')
  assert.equal(hit.body.isConnected, true, 'B2：命中正文节点必须仍 connected')
  assert.equal(hit.think.querySelector('[class*="_thinkBody"]') !== null, true, 'B2：scan 之后命中正文必须仍在 DOM（不得被 closeThink 卸载）')
  assert.equal(hit.think.dataset.dshsfKeepOpen, '1', 'B2：命中根必须留给读者 keep-open')
  assert.equal(sib.body.getAttribute('hidden'), 'until-found', 'R3-A1：同行未命中的根必须保持 until-found（M2 变异体：keep 撒到全行 ⇒ 转红）')
  assert.equal(sib.body.isConnected, true, 'R3-A1：同行未命中的正文不得被卸载')
  assert.equal(sib.think.dataset.dshsfKeepOpen, undefined, 'R3-A1：同行未命中的根不得 keep-open（M2 变异体：keep 撒到全行 ⇒ 转红）')
  assert.equal(hit.think.hasAttribute('data-dshsf-folded'), false, 'R3-A1：命中根在扫描后不得被折上')
  assert.equal(hit.row.hasAttribute('data-dshsf-folded'), false, 'R3-A1：命中行不得带 folded')
  assert.equal(hit.row.getAttribute('hidden'), null, 'R3-A1：命中行不得带 hidden=until-found')
  assert.equal(miss.think.dataset.dshsfKeepOpen, undefined, 'B2 对照：未命中的预挂载节点不得被永久 keep-open')
  assert.equal(miss.body.getAttribute('hidden'), 'until-found', 'B2 对照：未命中节点仍保留 until-found 隐藏语义')
  api.dispose()
})

// B3：错峰收起中途反向展开 ⇒ 未打 folded 的 staged 行必须回收限高/裁剪
await (async () => {
  let name = 'R1-B3'
  try {
    const env = makeR1Env('window.__sfR3 = { syncTurns, collectTurns, chatScope, setManual: (t, v) => setManual(t, v), setAllowAnim: (v) => { allowAnim = v } };')
    const { flow } = r1Chat(env)
    const rows = []
    for (let i = 0; i < 7; i += 1) {
      const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
      row.getBoundingClientRect = () => ({ top: 0, bottom: 120, left: 0, right: 800, width: 800, height: 120, x: 0, y: 0 })
      flow.appendChild(row); rows.push(row)
    }
    const T = env.win.__sfR3
    T.setAllowAnim(true)
    T.setManual('1', 'fold')
    T.syncTurns(T.chatScope(), false, T.collectTurns())
    assert.equal(rows[0].style.maxHeight, '120px', 'B3 前提：延迟组应已写下动画起点限高')
    assert.equal(rows[4].hasAttribute('data-dshsf-folded'), true, 'B3 前提：首组应已折上')
    T.setManual('1', 'open')
    T.syncTurns(T.chatScope(), false, T.collectTurns())
    await new Promise((resolve) => setTimeout(resolve, 400))
    for (let i = 0; i < 6; i += 1) {
      assert.equal(rows[i].hasAttribute('data-dshsf-folded'), false, 'B3：反向展开后第 ' + (i + 1) + ' 行不得残留 folded')
      assert.equal(rows[i].style.maxHeight, '', 'B3：反向展开后第 ' + (i + 1) + ' 行不得残留错峰限高')
      assert.equal(rows[i].style.overflow, '', 'B3：反向展开后第 ' + (i + 1) + ' 行不得残留裁剪')
    }
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { r1Fails.push(name + ': ' + String((err && err.message) || err)) }
})()

// B3 对照：正常错峰照旧全部折上（防"取消即回收"误伤未取消的批次）
await (async () => {
  let name = 'R1-B3-normal'
  try {
    const env = makeR1Env('window.__sfR3b = { syncTurns, collectTurns, chatScope, setManual: (t, v) => setManual(t, v), setAllowAnim: (v) => { allowAnim = v } };')
    const { flow } = r1Chat(env)
    const rows = []
    for (let i = 0; i < 7; i += 1) {
      const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
      row.getBoundingClientRect = () => ({ top: 0, bottom: 120, left: 0, right: 800, width: 800, height: 120, x: 0, y: 0 })
      flow.appendChild(row); rows.push(row)
    }
    const T = env.win.__sfR3b
    T.setAllowAnim(true)
    T.setManual('1', 'fold')
    T.syncTurns(T.chatScope(), false, T.collectTurns())
    await new Promise((resolve) => setTimeout(resolve, 400))
    for (let i = 0; i < 6; i += 1) assert.equal(rows[i].hasAttribute('data-dshsf-folded'), true, 'B3 对照：正常错峰应收起第 ' + (i + 1) + ' 行')
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { r1Fails.push(name + ': ' + String((err && err.message) || err)) }
})()

assert.equal(r1Fails.length, 0, 'R1 回归用例失败 —— ' + r1Fails.join(' | '))
console.log('client-apply: R1 (B1/B2/B3) ok')

/* ---------------- 2026-10-11 R2 加固（B3 守卫；追加，上面的 552 行零改动） ----------------
 * 守的是 clearFoldTimers 的回收循环：已被自己定时器正常折上的 staged 行不得再被清掉内联限高
 * （否则折叠只剩 CSS [data-dshsf-folded] 兜底，偏离 unfoldRowAnimated 340ms 清理处先判 hasAttribute 的惯例）。
 * 负向对照：去掉守卫的临时副本（CLIENT_SRC=进程替换）上本用例转红，其余 R1 用例仍绿。 */
await (async () => {
  let name = 'R2-B3-guard'
  try {
    const env = makeR1Env('window.__sfR3c = { syncTurns, collectTurns, chatScope, setManual: (t, v) => setManual(t, v), setAllowAnim: (v) => { allowAnim = v }, clearFoldTimers };')
    const { flow } = r1Chat(env)
    const rows = []
    for (let i = 0; i < 7; i += 1) {
      const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
      row.getBoundingClientRect = () => ({ top: 0, bottom: 120, left: 0, right: 800, width: 800, height: 120, x: 0, y: 0 })
      flow.appendChild(row); rows.push(row)
    }
    const T = env.win.__sfR3c
    T.setAllowAnim(true)
    T.setManual('1', 'fold')
    T.syncTurns(T.chatScope(), false, T.collectTurns())
    await new Promise((resolve) => setTimeout(resolve, 400))   // 两个延迟组的定时器都已跑过（仍留在 foldStaged 里）
    assert.equal(rows[0].hasAttribute('data-dshsf-folded'), true, 'R2 前提：延迟组应已被自己的定时器折上')
    assert.equal(rows[0].style.maxHeight, '0px', 'R2 前提：折上后内联限高应为 0px')
    T.clearFoldTimers()                                        // 作废批次：只许回收未折上的行
    for (let i = 0; i < 6; i += 1) {
      assert.equal(rows[i].style.maxHeight, '0px', 'R2：已折上的第 ' + (i + 1) + ' 行内联限高不得被回收清掉（守卫有牙齿）')
      assert.equal(rows[i].style.overflow, 'hidden', 'R2：已折上的第 ' + (i + 1) + ' 行裁剪不得被回收清掉')
    }
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { r1Fails.push(name + ': ' + String((err && err.message) || err)) }
})()
assert.equal(r1Fails.length, 0, 'R1/R2 回归用例失败 —— ' + r1Fails.join(' | '))
console.log('client-apply: R2 (B3 守卫) ok')

/* ---------------- 2026-10-11 R3（A-2 keep-open 窗的释放路径；追加，既有用例零删改） ----------------
 * A-2：Ctrl+F 命中后 keep-open 的静态窗到点必须退出 liveWindows（否则每帧为它多付 2 次强制布局读）；
 * keep-open 语义（不折回、正文仍在）不变。负向对照：修前快照（sha 10bdf3b8）上本用例转红。 */
await (async () => {
  let name = 'R3-A2'
  try {
    const env = makeR1Env('window.__sfA2 = { live: (el) => liveWindows.has(el) };')
    env.exports.apply(context)
    const api = env.win.__dshStreamfold
    assert.ok(api, 'A2 前提：apply 应挂出 __dshStreamfold')
    api.set({ autoExpandReasoning: false, foldHistory: false })
    const { flow } = r1Chat(env)
    const mkRow = (turn) => {
      const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', turn)
      const think = makeElement('div'); think.setAttribute('data-variant', 'think'); row.appendChild(think)
      const btn = makeElement('button'); btn.setAttribute('data-disclosure-row', ''); btn.setAttribute('aria-expanded', 'false'); think.appendChild(btn)
      const body = makeElement('div'); body.className = 'x_thinkBody y'
      btn.addEventListener('click', () => {
        if (think.querySelector('[class*="_thinkBody"]') !== null) { body.remove(); btn.setAttribute('aria-expanded', 'false') }
        else { think.appendChild(body); btn.setAttribute('aria-expanded', 'true') }
      })
      const tail = makeElement('div'); tail.setAttribute('data-turn-tail', turn); tail.setAttribute('data-actions-reveal', 'always'); flow.appendChild(tail)
      flow.appendChild(row)
      return { row, think, body }
    }
    const hit = mkRow('1')
    mkRow('2')   // 第 2 轮更"新"：命中根不是 activeWindow，释放不被续期挡下
    for (const fn of env.listeners.get('keydown') || []) fn({ type: 'keydown', ctrlKey: true, key: 'f', target: env.body, preventDefault() {}, stopPropagation() {} })
    for (const fn of env.listeners.get('beforematch') || []) fn({ type: 'beforematch', target: hit.body })
    const T = env.win.__sfA2
    assert.equal(hit.body.isConnected, true, 'A2 前提：命中正文仍 connected')
    assert.equal(T.live(hit.body), true, 'A2 前提：keep-open 窗应登记进 liveWindows')
    await new Promise((resolve) => setTimeout(resolve, 1300))   // 释放延时 1000ms + 余量
    assert.equal(T.live(hit.body), false, 'A2：keep-open 静态窗到点必须退出 liveWindows（修前永久驻留 ⇒ 转红）')
    assert.equal(hit.think.dataset.dshsfKeepOpen, '1', 'A2：释放只退出每帧清单，keep-open 语义不变')
    assert.equal(hit.body.isConnected, true, 'A2：释放后正文不得被卸载')
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { r1Fails.push(name + ': ' + String((err && err.message) || err)) }
})()
assert.equal(r1Fails.length, 0, 'R1/R2/R3 回归用例失败 —— ' + r1Fails.join(' | '))
console.log('client-apply: R3 (A-1/A-2) ok')

/* ---------------- 2026-10-11 R4（B4 换容器 scrollIntoView / A-1 尾巴 / A-2 尾巴；追加，既有用例零删改） ----------------
 * 三条都对 R4 修前快照转红（CLIENT_SRC=<修前 lib/client.js> 时本段失败）：
 *  B4  换容器后 Element.prototype.scrollIntoView 包装仍派发第一次容器的闭包 ⇒ 不回滚、不建目标；
 *  A-1 行级 beforematch（skipped 是行/折叠元素）时旧式 skipped.closest('[data-dshsf-search]') 取不到 ⇒ 整行撤 hidden + 整行 keep；
 *  A-2 keep-open 窗到点退出 liveWindows 时回底按钮/离底阴影停在上一帧（无同步）。
 * B4 用带原型 scrollTop/scrollIntoView 的 ScrollElement（takeOverSnap 需要原型描述符），原生写入绕过 JS 写层。 */
function makeR4Env(hook) {
  function markR4(el, on) { el.isConnected = on; for (const c of el.children) markR4(c, on) }
  class ScrollElement extends FakeElement {
    get scrollTop() { const max = Math.max(0, (this.scrollHeight || 0) - (this.clientHeight || 0)); return Math.min(Math.max(Number.isFinite(this.__top) ? this.__top : 0, 0), max) }
    set scrollTop(v) { const max = Math.max(0, (this.scrollHeight || 0) - (this.clientHeight || 0)); const n = Number(v); this.__top = Math.min(Math.max(Number.isFinite(n) ? n : 0, 0), max) }
    scrollTo(arg) { this.scrollTop = arg && typeof arg === 'object' ? Number(arg.top) || 0 : Number(arg) }
    scrollBy(arg) { this.scrollTop += arg && typeof arg === 'object' ? Number(arg.top) || 0 : Number(arg) || 0 }
    scrollIntoView(arg) {   // 原生：按最近可滚祖先对齐；写入走原型 setter（真实浏览器里原生滚动不经 JS 写层）
      const block = arg && typeof arg === 'object' ? arg.block || 'start' : 'start'
      let sc = this.parentElement
      while (sc && sc.__overflowY !== 'auto' && sc.__overflowY !== 'scroll') sc = sc.parentElement
      if (!sc) return
      const scRect = sc.getBoundingClientRect(), r = this.getBoundingClientRect()
      const height = r.height || r.bottom - r.top
      const top = sc.scrollTop + r.top - scRect.top, view = sc.clientHeight
      let want
      if (block === 'center') want = top - (view - height) / 2
      else if (block === 'end') want = top - (view - height)
      else if (block === 'nearest') { const cur = sc.scrollTop; want = top < cur ? top : (top + height > cur + view ? top + height - view : cur) }
      else want = top
      Object.getOwnPropertyDescriptor(ScrollElement.prototype, 'scrollTop').set.call(sc, Math.max(0, Math.min(Math.max(0, sc.scrollHeight - sc.clientHeight), want)))
    }
    appendChild(child) { const r = super.appendChild(child); markR4(child, true); return r }
    removeChild(child) { const r = super.removeChild(child); markR4(child, false); return r }
  }
  const makeR4 = (tag) => new ScrollElement(tag)
  let capturedR4 = null
  const docListeners = new Map()
  const rafR4 = []
  const headR4 = makeR4('head'), bodyR4 = makeR4('body'), htmlR4 = makeR4('html')
  htmlR4.appendChild(headR4); htmlR4.appendChild(bodyR4)
  const allR4 = (sel) => [htmlR4, ...descendants(htmlR4)].filter((el) => matchesSel(el, sel))
  const docR4 = {
    head: headR4, body: bodyR4, documentElement: htmlR4, baseURI: 'http://127.0.0.1:3080/',
    createElement: (tag) => makeR4(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text) }),
    getElementById: (id) => descendants(htmlR4).find((el) => el.getAttribute('id') === id) || null,
    querySelector: (sel) => allR4(sel)[0] || null,
    querySelectorAll: (sel) => allR4(sel),
    getElementsByTagName: (name) => descendants(htmlR4).filter((el) => name === '*' || el.tagName === String(name).toUpperCase()),
    addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn) },
    removeEventListener(type, fn) { const a = docListeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
    contains: () => true,
  }
  const winR4 = {
    __ModuleLoader__: { load: (definition) => { capturedR4 = definition.factory } },
    innerHeight: 800, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => { rafR4.push(fn); return rafR4.length },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: (el) => ({ overflowY: (el && el.__overflowY) || 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'http://127.0.0.1:3080/' },
  }
  const sb = {
    window: winR4, document: docR4, console,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    getComputedStyle: winR4.getComputedStyle, localStorage: winR4.localStorage,
    requestAnimationFrame: winR4.requestAnimationFrame, cancelAnimationFrame: winR4.cancelAnimationFrame,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    Element: ScrollElement, HTMLElement: ScrollElement, Node: FakeElement,
    Event: class { constructor(type) { this.type = type } }, CustomEvent: class { constructor(type) { this.type = type } },
    navigator: { userAgent: 'node' },
  }
  sb.window.document = docR4
  sb.globalThis = sb
  vm.createContext(sb)
  const hookedR4 = source.replace('exports.apply = apply;', hook + '\nexports.apply = apply;')
  assert.notEqual(hookedR4, source, 'R4 夹具：注入锚点丢失（client.js 结构已变）')
  vm.runInContext(hookedR4, sb, { filename: 'lib/client.js' })
  assert.ok(capturedR4, 'R4 夹具：factory 未注册')
  return { doc: docR4, body: bodyR4, win: winR4, listeners: docListeners, exports: capturedR4(requireStub), make: makeR4 }
}
const r4Fails = []
const r4 = (name, fn) => { try { fn(); console.log('client-apply: ' + name + ' ok') } catch (err) { r4Fails.push(name + ': ' + String((err && err.message) || err)) } }

// A-1 尾巴：行级 beforematch（事件目标所在正文已不是 until-found、最近的折叠/隐藏标记在行上）⇒ 只释放命中的那个根
r4('R4-A1-tail', () => {
  const env = makeR1Env('window.__sfR4a = {};')
  env.exports.apply(context)
  const api = env.win.__dshStreamfold
  api.set({ autoExpandReasoning: false, foldHistory: false })
  const { flow } = r1Chat(env)
  const mkRoot = (row) => {
    const think = makeElement('div'); think.setAttribute('data-variant', 'think'); row.appendChild(think)
    const btn = makeElement('button'); btn.setAttribute('data-disclosure-row', ''); btn.setAttribute('aria-expanded', 'false'); think.appendChild(btn)
    const body = makeElement('div'); body.className = 'x_thinkBody y'; body.setAttribute('data-dshsf-search', '1'); body.setAttribute('hidden', 'until-found'); think.appendChild(body)
    think.setAttribute('data-dshsf-search-open', '1')   // searchPrep 的预挂载归属
    return { think, body }
  }
  const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1'); row.setAttribute('data-dshsf-folded', '')
  const A = mkRoot(row), B = mkRoot(row)
  flow.appendChild(row)
  A.body.removeAttribute('hidden')   // 命中正文已亮过一次（浏览器摘 hidden）、标记仍在：旧式从 skipped（行）向上找不到正文
  for (const fn of env.listeners.get('beforematch') || []) fn({ type: 'beforematch', target: A.body })
  assert.equal(A.body.getAttribute('hidden'), null, 'R4-A1：命中正文必须当场可见')
  assert.equal(A.think.dataset.dshsfKeepOpen, '1', 'R4-A1：命中根必须 keep-open')
  assert.equal(B.body.getAttribute('hidden'), 'until-found', 'R4-A1：hit=null 路径下同行兄弟根必须仍是 until-found（修前整行撤 hidden ⇒ 转红）')
  assert.equal(B.body.hasAttribute('data-dshsf-search'), true, 'R4-A1：兄弟根的搜索标记不得被摘')
  assert.equal(B.think.dataset.dshsfKeepOpen, undefined, 'R4-A1：同行兄弟根不得 keep-open（修前整行 keep ⇒ 转红）')
  api.dispose()
})

// A-2 尾巴：keep-open 窗到点退出 liveWindows 时必须同步一次回底按钮/离底阴影
await (async () => {
  let name = 'R4-A2'
  try {
    const env = makeR1Env('window.__sfR4c = { live: (el) => liveWindows.has(el) };')
    env.exports.apply(context)
    const api = env.win.__dshStreamfold
    assert.ok(api, 'A2 前提：apply 应挂出 __dshStreamfold')
    api.set({ autoExpandReasoning: false, foldHistory: false })
    const { flow } = r1Chat(env)
    const mkRow = (turn) => {
      const row = makeElement('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', turn)
      const think = makeElement('div'); think.setAttribute('data-variant', 'think'); row.appendChild(think)
      const btn = makeElement('button'); btn.setAttribute('data-disclosure-row', ''); btn.setAttribute('aria-expanded', 'false'); think.appendChild(btn)
      const body = makeElement('div'); body.className = 'x_thinkBody y'
      btn.addEventListener('click', () => {
        if (think.querySelector('[class*="_thinkBody"]') !== null) { body.remove(); btn.setAttribute('aria-expanded', 'false') }
        else { think.appendChild(body); btn.setAttribute('aria-expanded', 'true') }
      })
      const tail = makeElement('div'); tail.setAttribute('data-turn-tail', turn); tail.setAttribute('data-actions-reveal', 'always'); flow.appendChild(tail)
      flow.appendChild(row)
      return { row, think, body }
    }
    const hit = mkRow('1')
    mkRow('2')
    for (const fn of env.listeners.get('keydown') || []) fn({ type: 'keydown', ctrlKey: true, key: 'f', target: env.body, preventDefault() {}, stopPropagation() {} })
    for (const fn of env.listeners.get('beforematch') || []) fn({ type: 'beforematch', target: hit.body })
    assert.equal(env.win.__sfR4c.live(hit.body), true, 'A2 前提：命中窗应登记进 liveWindows')
    const jump = hit.body.querySelector(':scope > [data-dshsf-jump]')
    assert.ok(jump, 'A2 前提：命中窗应有回底按钮')
    hit.body.scrollHeight = 5000; hit.body.clientHeight = 260; hit.body.scrollTop = 0   // 释放前离底：状态该在释放时刻同步
    assert.equal(hit.body.hasAttribute('data-dshsf-offbottom'), false, 'A2 前提：同步前无离底阴影')
    assert.equal(jump.hasAttribute('data-dshsf-visible'), false, 'A2 前提：同步前回底按钮不显示')
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assert.equal(env.win.__sfR4c.live(hit.body), false, 'A2 前提：静态窗到点应退出 liveWindows')
    assert.equal(hit.body.hasAttribute('data-dshsf-offbottom'), true, 'R4-A2：释放时必须同步离底阴影（修前停在释放那一刻的旧状态 ⇒ 转红）')
    assert.equal(jump.hasAttribute('data-dshsf-visible'), true, 'R4-A2：释放时必须同步回底按钮显隐（修前停在释放那一刻的旧状态 ⇒ 转红）')
    console.log('client-apply: ' + name + ' ok')
  } catch (err) { r4Fails.push(name + ': ' + String((err && err.message) || err)) }
})()

// B4：换容器后 scrollIntoView 必须回滚到调用前位置并建立 position 目标（同容器/换容器两情形逐字段一致）
await (async () => {
  let name = 'R4-B4'
  try {
    const env = makeR4Env('window.__sfR4 = { mainFollowTick, get: () => ({ writer, goal: goalKind, navActive: navActive ? 1 : 0, goalPos, followScroller, blocked: snapBlocked, ext: extWrites }) };')
    env.exports.apply(context)
    const T = env.win.__sfR4
    const mkScene = (sh) => {
      const scroller = env.make('div'); scroller.__overflowY = 'auto'; scroller.scrollHeight = sh; scroller.clientHeight = 600
      const flow = env.make('div'); flow.setAttribute('data-chat-flow', '')
      scroller.appendChild(flow); env.body.appendChild(scroller)
      const row = env.make('div'); row.setAttribute('data-chat-flow-kind', 'assistant-step'); row.setAttribute('data-chat-turn', '1')
      row.__docTop = 1000
      row.getBoundingClientRect = () => { const top = row.__docTop - scroller.scrollTop; return { top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top } }
      flow.appendChild(row)
      return { scroller, flow, row }
    }
    const A = mkScene(5000)
    A.scroller.scrollTop = 4400            // 已在末端 ⇒ 接管当帧 rearm()（writer=us）
    T.mainFollowTick(16.7)
    assert.equal(T.get().writer, 'us', 'R4 前提：容器 A 接管后 writer=us')
    A.row.scrollIntoView({ block: 'start' })   // 原生落在 1000
    await Promise.resolve()                    // claim 微任务（paint 前倒回）
    const same = { top: A.scroller.scrollTop, ...T.get() }
    assert.equal(same.top, 4400, 'R4 对照：同容器 scrollIntoView 必须回滚到调用前位置')
    assert.equal(same.goal, 'position', 'R4 对照：同容器必须建立 position 目标')
    assert.equal(same.goalPos, 1000, 'R4 对照：position 目标 = 原生落点')
    A.scroller.remove()                        // 换容器 A→B（同一几何）
    const B = mkScene(5000)
    B.scroller.scrollTop = 4400
    T.mainFollowTick(16.7)
    assert.equal(T.get().followScroller, B.scroller, 'R4 前提：主容器应换成 B')
    assert.equal(T.get().writer, 'us', 'R4 前提：B 已在末端 ⇒ 接管后 writer=us')
    const blocked0 = T.get().blocked
    B.row.scrollIntoView({ block: 'start' })
    await Promise.resolve()
    const moved = { top: B.scroller.scrollTop, ...T.get() }
    assert.equal(moved.top, 4400, 'R4-B4：换容器后必须回滚到调用前位置（修前把原生落点留在 B 上 ⇒ 转红）')
    assert.equal(moved.goal, 'position', 'R4-B4：换容器后必须建立 position 目标（修前目标仍是 tail ⇒ 转红）')
    assert.equal(moved.goalPos, 1000, 'R4-B4：position 目标应与同容器一致')
    for (const k of ['writer', 'goal', 'navActive', 'goalPos']) assert.equal(moved[k], same[k], 'R4-B4：换容器后行为必须与同容器逐字段一致（' + k + '）')
    B.row.__docTop = 9000                      // 贴底写：目标超过 floor ⇒ 仍走吸收分支（位置不动、blocked+1）
    B.row.scrollIntoView({ block: 'start' })
    await Promise.resolve()
    const bottom = T.get()
    assert.equal(B.scroller.scrollTop, 4400, 'R4-B4：贴底写不得移动容器')
    assert.equal(bottom.blocked, blocked0 + 1, 'R4-B4：贴底写仍走吸收分支（blocked+1）')
    assert.equal(bottom.goal, 'position', 'R4-B4：贴底写不改变既有目标')
    console.log('client-apply: ' + name + ' ok')
    env.win.__dshStreamfold.dispose()
  } catch (err) { r4Fails.push(name + ': ' + String((err && err.message) || err)) }
})()

assert.equal(r4Fails.length, 0, 'R4 回归用例失败 —— ' + r4Fails.join(' | '))
console.log('client-apply: R4 (B4/A-1/A-2) ok')
