/**
 * dsh-streamfold — 流式折叠（host 半区）
 *
 * 全部展示行为在浏览器侧（lib/client.js）。host 侧只提供配置的第二来源：
 * <DSH_HOME>/streamfold.json + 同源读写路由 /streamfold/api/settings
 * （客户端仍以 localStorage 为快速路径，两者取并集、以最近写入为准）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-streamfold'
export const inject = []

export const DEFAULTS = {
  mode: 'native',
  keepInterleavedText: false,
  foldHistory: true,
  windowHeight: 260,
  autoFollow: true,
  showJumpButton: true,
  animations: true,
  autoExpandReasoning: true,
  autoExpandTools: false,
  settleToPrompt: true,
  pinPrompt: true,
  smoothGrow: 0.15,
  smoothMin: 1,
  supersedeDelay: 2,
  sparks: true,
  sparkColor: '#4fa8ff',
  sparkDensity: 1,
  forgeSparks: true,
  forgeSpeed: 1,
  forgeLife: 1.3,
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const settingsFile = () => join(dshHome(), 'streamfold.json')

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) }
  const next = {}
  for (const key of Object.keys(DEFAULTS)) if (merged[key] !== undefined) next[key] = merged[key]
  const file = settingsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
  return next
}

export const config = { read: readSettings, write: writeSettings, file: settingsFile }

export function apply(ctx) {
  if (!ctx.inject) return
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => wctx.webServer.register({
      kind: 'prefix',
      path: '/streamfold',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(obj))
        }
        const host = req.headers.host || '127.0.0.1:3080'
        // 只服务本机：Host 头必须是回环地址。不带 Origin 的本地脚本会绕过下面那道同源校验，这道挡住"被暴露到局域网"的情况。
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(403, { ok: false, message: '只允许本机访问' })
        const origin = String(req.headers.origin || '')
        try {
          if (origin && new URL(origin).host !== host) return send(403, { ok: false, message: '跨站请求已拒绝' })
        } catch { return send(403, { ok: false, message: 'bad origin' }) }
        const url = new URL(req.url || '/', 'http://' + host)
        const path = url.pathname.replace(/^\/streamfold/, '') || '/api/settings'
        const readBody = () => new Promise((resolve) => {
          let body = ''
          let over = false
          req.on('data', (chunk) => {
            if (over) return
            body += chunk
            if (body.length > 64 * 1024) { over = true; body = ''; req.destroy(); resolve({}) }   // 上限 64KB：超了直接掐，别把 body 全读进内存
          })
          req.on('end', () => { if (!over) { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } } })
        })
        if (path === '/api/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
          return send(200, { ok: true, settings: readSettings(), defaults: DEFAULTS, file: settingsFile() })
        }
        if (path === '/api/settings' && req.method === 'POST') {
          if (!String(req.headers['content-type'] || '').includes('application/json')) return send(415, { ok: false, message: '只接受 application/json' })
          const patch = await readBody()
          return send(200, { ok: true, settings: writeSettings(patch) })
        }
        return send(404, { ok: false, message: 'not found' })
      },
    }), 'dsh-streamfold: settings route')
  })
}