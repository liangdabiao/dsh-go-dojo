// 冒烟（离线零外网）：假 ctx 驱动面板 API 全路由 + 本地 mock 上游验证走子代理 + 静态伺服/穿越拦截。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { createServer } from 'node:http'
import { registerApi, configRef } from '../lib/api.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'godojo-smoke-'))

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let failN = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    failN++
    console.log(`  ❌ ${name} ${detail}`)
  }
}

// ---------------------------------------------------------------- mock 上游
// OpenAI 兼容 mock：从 user 消息文本里抠棋盘行（形如 "7 . . . . . . ."，
// boardText 兼容回退模式），挑最靠中心的空点落子——验证代理真的把棋盘传上去了。
const mockBody = (req) => {
  const user = req.messages?.find((m) => m.role === 'user')?.content ?? ''
  const boardLines = typeof user === 'string'
    ? user.split('\n').filter((l) => /^\s*\d+(\s+[BW.])+\s*$/.test(l))
    : []
  const grid = boardLines.map((l) => l.trim().split(/\s+/).slice(1))
  const h = grid.length
  const w = grid[0]?.length ?? 0
  const cx = (w - 1) / 2, cy = (h - 1) / 2
  let best = null, bestD = Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] !== '.') continue
      const d = Math.abs(x - cx) + Math.abs(y - cy)
      if (d < bestD) { bestD = d; best = [x, y] }
    }
  }
  const COL = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  const move = best ? COL[best[0]] + (h - best[1]) : 'pass'
  return { choices: [{ message: { content: `{"move":"${move}"}` } }] }
}

// 多模态请求（content 数组带 image_url）：回固定一手，验证图片通路
const MULTIMODAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const upstreamHandler = (req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const auth = req.headers.authorization || ''
    if (auth !== 'Bearer sk-mock') { res.writeHead(401); return res.end() }
    const body = JSON.parse(raw || '{}')
    const user = body.messages?.find((m) => m.role === 'user')?.content
    const multimodal = Array.isArray(user) && user.some((p) => p.type === 'image_url')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (multimodal) {
      const imgPart = user.find((p) => p.type === 'image_url')
      if (imgPart.image_url.url !== MULTIMODAL_PNG) { res.writeHead(400); return res.end('bad image') }
      return res.end(JSON.stringify({ choices: [{ message: { content: '{"move":"E5"}' } }] }))
    }
    res.end(JSON.stringify(mockBody(body)))
  })
}

const upstream = createServer(upstreamHandler)
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const UP = `http://127.0.0.1:${upstream.address().port}`

// ---------------------------------------------------------------- 假 ctx
const routes = {}
registerApi(
  {
    get: () => undefined,
    webServer: { register: (r) => { routes[r.path] = r.handler } },
  },
  {},
)
configRef.config = { aiBaseUrl: UP, aiApiKey: '', aiModel: 'mock-model' }

// app/dist 静态首页（真构建产物或占位均可）
const distIndex = join(PLUGIN_ROOT, 'app', 'dist', 'index.html')
mkdirSync(dirname(distIndex), { recursive: true })
if (!existsSync(distIndex)) writeFileSync(distIndex, '<!doctype html><title>go-dojo</title><div id="root"></div>', 'utf8')

const handler = routes['/go-dojo']

const req = async (method, path, body) => {
  const chunks = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  res.statusCode = 500
  res.writeHead = (status, hdrs) => { res.statusCode = status; Object.assign(res.headers_ = {}, hdrs) }
  const r = Object.assign(new EventEmitter(), {
    method,
    url: path,
    headers: { host: 'localhost', 'content-type': body ? 'application/json' : '' },
  })
  const done = new Promise((resolve) => res.on('finish', resolve))
  handler(r, res)
  if (body) r.emit('data', Buffer.from(JSON.stringify(body)))
  r.emit('end')
  await done
  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（静态文件） */ }
  return { status: res.statusCode, text, json }
}

const board7 = '  A B C D E F G\n 7 . . . . . . .\n 6 . . . . . . .\n 5 . . . . . . .\n 4 . . . B . . .\n 3 . . . . . . .\n 2 . . . . . . .\n 1 . . . . . . .'
const moveBody = { boardText: board7, width: 7, height: 7, aiColor: 2, playerColor: 1, targetCaptures: 3, moveHistory: ['D4'], aiCaptures: 0, playerCaptures: 0 }

console.log('\n== 面板 API ==')
{
  const ping = await req('GET', '/go-dojo/api/ping')
  check('GET /api/ping', ping.status === 200 && ping.json.ok === true)

  const noKey = await req('POST', '/go-dojo/api/ai-move', moveBody)
  check('未配 key → 503 not_configured', noKey.status === 503 && noKey.json.error === 'not_configured')

  configRef.config = { aiBaseUrl: UP, aiApiKey: 'sk-mock', aiModel: 'mock-model' }
  const mv = await req('POST', '/go-dojo/api/ai-move', moveBody)
  check('ai-move 代理（boardText 兼容）→ mock 上游落子', mv.status === 200 && typeof mv.json.move === 'string' && mv.json.move !== 'pass', JSON.stringify(mv.json))

  const mmReq = await req('POST', '/go-dojo/api/ai-move', { ...moveBody, imageBase64: MULTIMODAL_PNG })
  check('ai-move 多模态（image_url 透传）→ mock 回 E5', mmReq.status === 200 && mmReq.json.move === 'E5', JSON.stringify(mmReq.json))

  const bad = await req('POST', '/go-dojo/api/ai-move', {})
  check('空棋盘体 → 不炸（上游仍回一子）', bad.status === 200 && bad.json.move !== undefined)

  const esc = await req('GET', '/go-dojo/api/%2e%2e/package.json')
  check('路径穿越拦截', esc.status === 404 || esc.status === 403, `status=${esc.status}`)

  const idx = await req('GET', '/go-dojo/')
  check('静态首页伺服', idx.status === 200 && /<div id="root">/.test(idx.text) && !idx.json)

  const missing = await req('GET', '/go-dojo/no-such-file.js')
  check('静态缺失 → 404', missing.status === 404)

  const post405 = await req('POST', '/go-dojo/api/ping', {})
  check('GET-only 接口 POST → 405/404', post405.status === 405 || post405.status === 404)
}

await new Promise((r) => upstream.close(r))
console.log(`\n冒烟结果：${pass} 过 / ${failN} 挂`)
process.exitCode = failN === 0 ? 0 : 1
