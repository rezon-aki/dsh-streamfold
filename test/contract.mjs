/**
 * 上架契约回归：DSH STORE 的自动准入按源码正则判能力信号，命中任意一个都不会被自动收录。
 * 这里复刻它的六条判定 + manifest 门槛，扫的也是同一批「运行时文件」
 * （STORE 侧实现：src/automation-source-policy.mjs 与 scripts/automate-catalog.mjs）。
 *
 * 改 lib/ 之后跑一遍；测试自己带正向样本自检，正则被改坏会立刻报错。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

/* ---- 与 STORE 逐字对应的判定 ---- */
const moduleImport = (names) => new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["'](?:node:)?(?:${names})["']`, 'i')
const RULES = {
  files: [
    moduleImport('fs|fs/promises'),
    /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i,
    /\$DSH_HOME|\.dsh\/profiles/i,
  ],
  network: [
    moduleImport('http|https|net|tls|dgram|axios|got|undici'),
    /\b(?:fetch|WebSocket|EventSource)\s*\(/i,
    /\b(?:axios|got|undici)\s*(?:\.|\()/i,
  ],
  commands: [
    moduleImport('child_process'),
    /(?:^|[^\w$.'"`])(?:exec|execFile|spawn|fork)\s*\(/im,
    /shell\s*:\s*true|Bun\.spawn|new\s+Deno\.Command/i,
  ],
  credentials: [
    /process\.env/i,
    /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i,
    /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i,
  ],
  protectedDsh: [
    /(?:\b__ModuleLoader__\s*\.\s*(?:unload|remove)\s*\(|\b(?:ctx\s*\.\s*)?(?:loader|fiber|Loader|Fiber)\s*\.\s*(?:insert|remove|patch|enable|disable|write|mutate|replace)\s*\(|@deepseek-ai\/[^\n]{0,160}disabled\s*:\s*true|tool\.call\.toolview)/i,
  ],
}
const signalsOf = (source) => Object.fromEntries(
  Object.entries(RULES).map(([name, list]) => [name, list.some((re) => re.test(source))]))

/* 正向样本自检：这些都必须被判为信号，否则说明正则被改坏了（曾经漏掉六类中的四类） */
const MUST_FLAG = [
  ['files', "import fs from 'node:fs'"],
  ['files', "readFile('/etc/passwd')"],
  ['files', 'const home = "$DSH_HOME/streamfold.json"'],
  ['files', "const p = join(home, '.dsh/profiles/web')"],
  ['network', "await fetch('/api')"],
  ['network', "import got from 'got'"],
  ['commands', "const r = spawn('ls', [])"],
  ['commands', "execSync('ls', { shell: true })"],
  ['credentials', 'const t = process.env.TOKEN'],
  ['credentials', 'const k = opts.apiKey'],
  ['credentials', 'await oauth.getToken()'],
  ['protectedDsh', "loader.remove('x')"],
  ['protectedDsh', '// bash 卡走 tool.call.toolview 的 BashRow'],
]
for (const [name, sample] of MUST_FLAG) {
  assert.equal(signalsOf(sample)[name], true, `信号正则失效：${name} 没认出样本 → ${sample}`)
}

/* ---- 运行时文件集合：与 STORE 同一套过滤 ---- */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|rb|go|rs)$/i
const EXCLUDED_DIRECTORY = /(?:^|\/)(?:node_modules|vendor|test|tests|docs?|examples?|fixtures?|benchmarks?|coverage|\.github)(?:\/|$)/i
const EXCLUDED_METADATA_FILE = /(?:^|\/)(?:brief\.json|catalog-entry(?:\.draft)?\.json)$/i
const TEST_FILE = /^(?:test|spec)[-_.].*\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|rb|go|rs)$/i
const SUFFIX_TEST = /^.+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i
const NATIVE_FILE = /\.(?:node|wasm|dll|dylib|so|exe|bin)$/i

const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim()
/* 快照口径统一为**索引**（= 下一次 commit 会写进去的东西），内容从工作树读：
   商城扫的是你推上去的那个 commit，所以要能看到"改完还没提交"的状态，同时文件集/文件模式都取自同一份清单
   （此前用的是 ls-files 取清单 + 磁盘读内容 + ls-tree HEAD 取模式，三个快照混着用）。 */
const indexEntries = git('ls-files -s').split('\n').filter(Boolean).map((line) => {
  const [meta, path] = line.split('\t')
  return { mode: meta.split(/\s+/)[0], path }
})
const runtimeEntries = indexEntries.filter(({ path }) => {
  if (EXCLUDED_DIRECTORY.test(path) || EXCLUDED_METADATA_FILE.test(path)) return false
  const name = path.split('/').at(-1)
  if (TEST_FILE.test(name) || SUFFIX_TEST.test(name)) return false
  return SOURCE_FILE.test(path)
})
const runtime = runtimeEntries.map((entry) => entry.path)
/* 索引里有、磁盘上没有 = 两个快照已经分叉，别再假装扫过（商城读的是 commit，不是你的磁盘） */
const missing = runtime.filter((path) => !existsSync(new URL(path, root)))
assert.deepEqual(missing, [], '索引里的运行时文件在磁盘上不存在，先 git add/restore 对齐再跑：' + missing.join(', '))
const dirtyRuntime = git('status --porcelain').split('\n').filter((line) => line.trim() && SOURCE_FILE.test(line.slice(3).trim()))
if (dirtyRuntime.length) console.log(`contract: 注意 ${dirtyRuntime.length} 个文件与索引不一致（本次按工作树内容扫描；商城扫的是你推上去的那个 commit）`)
assert.ok(runtime.length > 0, '没扫到任何运行时文件，过滤规则可能改坏了')
assert.ok(runtime.length <= 240, `运行时文件数超出商城自动审查上限：${runtime.length}`)

const modes = new Map(runtimeEntries.map((entry) => [entry.path, entry.mode]))
const symlinks = indexEntries.filter((entry) => entry.mode === '120000').map((entry) => entry.path)
const submodules = indexEntries.filter((entry) => entry.mode === '160000').map((entry) => entry.path)
assert.deepEqual(symlinks, [], '仓库含符号链接（商城硬拦）：' + symlinks.join(', '))
assert.deepEqual(submodules, [], '仓库含子模块（商城硬拦）：' + submodules.join(', '))

let totalBytes = 0
for (const path of runtime) {
  const source = read(path)
  const size = statSync(new URL(path, root)).size
  totalBytes += size
  assert.ok(size <= 262144, `单文件超出商城上限：${path} = ${size} B`)
  const hit = Object.entries(signalsOf(source)).filter(([, v]) => v).map(([k]) => k)
  assert.deepEqual(hit, [], `${path} 命中能力信号：${hit.join(', ')}`)
  assert.equal(modes.get(path), '100644', `${path} 的文件模式不是普通文件（可执行/软链都会被商城拦）`)
  assert.equal(NATIVE_FILE.test(path), false, `${path} 是原生/可执行制品`)
}
assert.ok(totalBytes <= 2097152, `运行时源码总量超出商城上限：${totalBytes} B`)

/* ---- manifest 门槛 ---- */
const manifest = JSON.parse(read('package.json'))
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, '必须声明显式 files 白名单')
assert.equal(typeof manifest.dsh.compatibility.dsh, 'string', '必须声明 DSH 范围（商城读 dsh.compatibility.dsh，不是 dsh.engines.dsh）')
assert.ok(Object.keys(manifest.dsh.compatibility.dshReleases).length > 0, '必须声明逐版本 dshReleases 矩阵')
assert.ok(Object.values(manifest.dsh.compatibility.dshReleases).includes('compatible'), 'dshReleases 里至少要有一个 compatible')
assert.equal(typeof manifest.dsh.bundle.patch, 'string', '必须声明 dsh.bundle.patch')
assert.equal(manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''), 'https://github.com/rezon-aki/dsh-streamfold', 'manifest 仓库地址必须与 canonical 仓库一致')
assert.equal(typeof manifest.engines?.node, 'string', '必须声明 engines.node（商城 requireNodeCompatibility）')
assert.equal(manifest.license, 'MIT', 'license 字段必须是 MIT（商城要求仓库 license 与之一致）')
assert.ok(/\bMIT\b/i.test(read('LICENSE')), 'LICENSE 文件内容必须与 manifest.license 对上（商城 requireRepositoryLicenseMatch）')
assert.deepEqual(manifest.bundledDependencies ?? [], [], 'bundledDependencies 必须为空（商城硬拦）')
/* 入口文件必须真实存在（商城 missingRuntimeEntryReasons） */
const entryTargets = [manifest.main, ...Object.values(manifest.exports ?? {}).flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value ?? {})))]
for (const target of entryTargets.filter((value) => typeof value === 'string' && value.startsWith('./'))) {
  assert.ok(existsSync(new URL(target, root)), `manifest 声明的入口文件不存在：${target}`)
}
assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], '不允许运行依赖')
assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), [], '不允许可选依赖')
for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.equal(manifest.scripts?.[lifecycle], undefined, `不允许生命周期脚本：${lifecycle}`)
}

console.log(`contract: ok — ${runtime.length} 个运行时文件 / ${totalBytes} B，六类信号零命中`)
