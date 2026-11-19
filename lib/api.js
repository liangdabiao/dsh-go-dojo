// 插件的 HTTP 半边：给「围棋道场」页面用（/go-dojo/ 下）。
//   GET  /                     闯关 SPA（app/dist 静态资源）
//   GET  /api/ping             存活检查
//   POST /api/duel/new         建一局 BOSS 对弈 {levelId,title,width,height,targetCaptures,maxMoves,playerColor}
//   GET  /api/duel?id=         取一局现状（面板轮询 AI 落子）
//   GET  /api/duels            对局列表
//   POST /api/duel/move        玩家落子上报 {id, move}（服务端合法性对账）
//   POST /api/duel/turn-prompt {id} → 组装给 agent 的自包含对局指令（面板拿去 startSession）
//   POST /api/duel/resign      认输 {id}
//   GET  /api/duel/review?id=  取复盘报告 Markdown
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDuel,
  getDuel,
  saveDuel,
  listDuels,
  recordPlayerMove,
  resignDuel,
  buildTurnPrompt,
  duelStateView,
  getReview,
  setMaxDuels,
} from './duel.js'
import { TOOLS, configRef } from './tools.js'

const BASE = '/go-dojo'
const DIST = fileURLToPath(new URL('../app/dist/', import.meta.url))

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
function readJson(req, max = 2 * 1024 * 1024) {
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

function duelBrief(duel) {
  return {
    id: duel.id,
    levelId: duel.levelId,
    title: duel.title,
    width: duel.width,
    height: duel.height,
    targetCaptures: duel.targetCaptures,
    maxMoves: duel.maxMoves,
    history: duel.history,
    playerCaptures: duel.playerCaptures,
    aiCaptures: duel.aiCaptures,
    turn: duel.turn,
    status: duel.status,
    lastAiMove: duel.lastAiMove,
    lastComment: duel.lastComment,
    lastError: duel.lastError,
    updatedAt: duel.updatedAt,
  }
}

export function registerApi(ctx) {
  setMaxDuels(configRef.config?.maxDuels)
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping') return json(res, 200, { ok: true, version: version() })

        // ------------------------------------------------ 对局
        if (rest === '/api/duel/new' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          if (!body.width || !body.height) return json(res, 400, { ok: false, error: '需要 width/height' })
          try {
            const duel = createDuel(body)
            return json(res, 200, { ok: true, duel: duelBrief(duel) })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/duel' && req.method === 'GET') {
          const duel = getDuel(url.searchParams.get('id') || '')
          return duel ? json(res, 200, { ok: true, duel: duelBrief(duel) }) : json(res, 404, { ok: false, error: '没有这局棋' })
        }

        if (rest === '/api/duels' && req.method === 'GET') {
          return json(res, 200, { ok: true, duels: listDuels(30) })
        }

        if (rest === '/api/duel/move' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const r = recordPlayerMove(String(body.id || ''), String(body.move || ''))
          return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, duel: duelBrief(r.duel) } : { ok: false, error: r.error })
        }

        // 面板要发起 AI 回合：服务端按权威棋盘组装指令，面板拿去 startSession
        if (rest === '/api/duel/turn-prompt' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const duel = getDuel(String(body.id || ''))
          if (!duel) return json(res, 404, { ok: false, error: '没有这局棋' })
          if (duel.status !== 'playing') return json(res, 400, { ok: false, error: `对局已结束（${duel.status}）` })
          return json(res, 200, { ok: true, prompt: buildTurnPrompt(duel), duel: duelBrief(duel) })
        }

        if (rest === '/api/duel/resign' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const duel = resignDuel(String(body.id || ''))
          return duel ? json(res, 200, { ok: true, duel: duelBrief(duel) }) : json(res, 404, { ok: false, error: '没有这局棋' })
        }

        if (rest === '/api/duel/review' && req.method === 'GET') {
          const review = getReview(url.searchParams.get('id') || '')
          return review ? json(res, 200, { ok: true, ...review }) : json(res, 404, { ok: false, error: '还没有复盘报告' })
        }

        // agent 存完复盘后落盘时间戳可能晚于 duel.updatedAt —— 轮询方靠 GET review 拿
        if (rest === '/api/duel/review/save' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const duel = getDuel(String(body.id || ''))
          if (duel) saveDuel(duel) // touch，面板轮询 duel 能感知有新档
          return json(res, 200, { ok: true })
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
