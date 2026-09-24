/**
 * 客户端半区冒烟：在最小 DOM 下把 apply() 跑一遍，必须不抛错、并且挂出调试出口。
 *
 * 防的是「引用了一个不存在的函数」这类只在浏览器里才炸的错：客户端 fiber 一旦 failed，
 * GUI 上只显示一行 `dsh-streamfold: failed`，原始错误既不进页面也不进控制台
 * （2026-09-25 就是这么被藏了一整轮：rowsReport 被写进了 createSparkFx 工厂内部）。
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const sourcePath = process.env.CLIENT_SRC || new URL('../lib/client.js', import.meta.url)
const source = readFileSync(sourcePath, 'utf8')

function makeStyle() {
  const props = new Map()
  return {
    getPropertyValue: (k) => props.get(k) || '',
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  }
}
function makeElement(tag = 'div') {
  const attrs = new Map()
  return {
    tagName: String(tag).toUpperCase(), style: makeStyle(), dataset: {}, children: [], isConnected: true,
    className: '', textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
    appendChild(child) { this.children.push(child); return child },
    removeChild() {}, remove() {}, focus() {}, click() {},
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    toggleAttribute(k, on) { if (on) attrs.set(k, ''); else attrs.delete(k); return attrs.has(k) },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
    querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  }
}

const head = makeElement('head')
const body = makeElement('body')
const documentElement = makeElement('html')
const documentStub = {
  head, body, documentElement, baseURI: 'http://127.0.0.1:3080/',
  createElement: (tag) => makeElement(tag),
  createTextNode: () => ({ textContent: '' }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, contains: () => true,
}

let captured = null
const windowStub = {
  __ModuleLoader__: { load: (definition) => { captured = definition.factory } },
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ overflowY: 'visible', overflowX: 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
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
  Element: class {}, HTMLElement: class {}, Node: class {}, Event: class {}, CustomEvent: class {},
  navigator: { userAgent: 'node' },
}
sandbox.window.document = documentStub
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
assert.ok(captured, '客户端 bundle 没有通过 window.__ModuleLoader__.load 注册 factory')

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(), useCallback: (fn) => fn, memo: (component) => component,
  Fragment: Symbol('Fragment'), createContext: () => ({ Provider: null, Consumer: null }),
}
const exportsObject = captured((name) => (name === 'react' ? reactStub : {}))
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
for (const key of ['stats', 'rows', 'probe', 'scan', 'set', 'get', 'chooseDisplay', 'state', 'dispose']) {
  assert.equal(typeof api[key], 'function', `调试出口缺函数：${key}`)
}
assert.doesNotThrow(() => api.rows(), 'rows() 在空 DOM 下抛错')
assert.doesNotThrow(() => api.stats(), 'stats() 在空 DOM 下抛错')
const probe = api.probe()
assert.equal(typeof probe, 'object', 'probe() 应返回对象')
assert.equal(probe.error, 'no chat rows found', '空 DOM 下 probe() 应报找不到聊天行')

console.log('client-apply: ok')
