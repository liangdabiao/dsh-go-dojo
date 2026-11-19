// 插件的 HTTP 半边：给「围棋道场」页面用（/go-dojo/ 下）。
//   GET  /                     闯关 SPA（app/dist 静态资源）
//   GET  /api/ping             存活检查
//   POST /api/ai-move          LLM 走子代理（key 在宿主侧，不下发浏览器）
//   GET  /api/settings         面板「AI 对弈」当前配置（掩码，无明文 key）
//   POST /api/settings         在面板里保存 API 地址 / 模型 / Key（落 $DSH_HOME/go-dojo/settings.json）
//   POST /api/ai-test          用当前配置打一次真实请求，验证 key 是否可用
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestAiMove, testConnection } from './ai-move.js'
import { applySettingsPatch, effectiveConfig, publicSettings } from './settings.js'

const BASE = '/go-dojo'
const DIST = fileURLToPath(new URL('../app/dist/', import.meta.url))

export const configRef = { config: {} }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return null
  }
}

// 只放行 app/dist 里的文件：拒绝 ..、点开头的路径和指到目录外的符号链接
function safeDistFile(rel) {
  if (!rel || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try {
    base = realpathSync(DIST)
  } catch {
    return null
  }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serve(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      return reject(Object.assign(new Error('需要 JSON'), { status: 415 }))
    }
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) {
      return reject(Object.assign(new Error('origin'), { status: 403 }))
    }
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(Object.assign(e, { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// dsh 0.2.x 宿主自带 token 鉴权；connection 服务缺席时放行。
function requestRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping' && req.method === 'GET') {
          return json(res, 200, { ok: true, version: version() })
        }

        // ------------------------------------------------ AI 设置（面板内配置）
        if (rest === '/api/settings' && req.method === 'GET') {
          return json(res, 200, { ok: true, ...publicSettings(configRef.config) })
        }

        if (rest === '/api/settings' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const result = applySettingsPatch(body)
          if (result.error) return json(res, 400, { ok: false, error: result.error })
          return json(res, 200, { ok: true, ...publicSettings(configRef.config) })
        }

        if (rest === '/api/ai-test' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const r = await testConnection(effectiveConfig(configRef.config))
          return json(res, 200, r)
        }

        if (rest === '/api/ai-move' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const r = await requestAiMove(body, effectiveConfig(configRef.config))
          return json(res, r.status ?? 200, { move: r.move, error: r.error })
        }

        // ------------------------------------------------ 静态 SPA
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只读接口' })
        if (rest.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })

        const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
        const file = safeDistFile(rel)
        return file ? serve(req, res, file) : json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  })
}
