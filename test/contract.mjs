/**
 * 上架契约回归：DSH STORE 的自动准入按源码正则判能力信号（其 src/automation-source-policy.mjs），
 * 六个信号命中任意一个就不会自动收录。改 lib/ 之后跑一遍，别把信号又写回来。
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const source = read('lib/index.js') + read('lib/client.js')
const manifest = JSON.parse(read('package.json'))

const importOf = (names) => new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["'](?:node:)?(?:${names})["']`, 'i')

assert.equal(importOf('fs|fs/promises|http|https|net|tls|dgram|child_process').test(source), false, '不得引入文件/网络/子进程模块')
assert.equal(/\b(?:fetch|WebSocket|EventSource)\s*\(/.test(source), false, '不得直接发网络请求')
assert.equal(/\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/.test(source), false, '不得直接读写文件')
assert.equal(/process\.env/.test(source), false, '不得读环境变量')
assert.equal(/(?:^|[^\w$.'"`])(?:exec|execFile|spawn|fork)\s*\(/m.test(source), false, '不得调用子进程')
assert.equal(/tool\.call\.toolview/i.test(source), false, 'protectedDsh 信号词不得出现在源码里')

assert.equal(typeof manifest.dsh.compatibility.dsh, 'string', '必须声明 DSH 范围（商城读 dsh.compatibility.dsh，不是 dsh.engines.dsh）')
assert.ok(Object.keys(manifest.dsh.compatibility.dshReleases).length > 0, '必须声明逐版本 dshReleases 矩阵')

console.log('contract: all checks passed')
