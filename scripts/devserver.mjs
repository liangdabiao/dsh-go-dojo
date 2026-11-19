// 本地开发服务器：lib/api.js 的真实前缀路由 + 内置 mock LLM 上游。
// 用法：node scripts/devserver.mjs [端口]（默认 5190）
//   http://localhost:5190/go-dojo/      面板 SPA + API（AI 走子走 mock 上游，无需真 key）
// 真上游调试：设 GO_DOJO_BASE_URL / GO_DOJO_API_KEY / GO_DOJO_MODEL 环境变量。
import { createServer } from 'node:http'
import { registerApi, configRef } from '../lib/api.js'

const PORT = Number(process.argv[2]) || 5190

// ---------------------------------------------------------------- mock 上游
// 从 user 消息里抠棋盘，挑最靠中心的空点落子（本地验收用，零外网）。
const mockUpstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? ''
    const boardText = user.split('Board (B=black, W=white, .=empty):')[1]?.split('Your move:')[0] ?? ''
    const lines = boardText.split('\n').filter((l) => /\d/.test(l))
    const grid = lines.map((l) => l.trim().split(/\s+/).slice(1))
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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: `{"move":"${move}"}` } }] }))
  })
})
await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r))

configRef.config = process.env.GO_DOJO_API_KEY
  ? {
      aiBaseUrl: process.env.GO_DOJO_BASE_URL || 'https://api.deepseek.com',
      aiApiKey: process.env.GO_DOJO_API_KEY,
      aiModel: process.env.GO_DOJO_MODEL || 'deepseek-chat',
    }
  : { aiBaseUrl: `http://127.0.0.1:${mockUpstream.address().port}`, aiApiKey: 'mock', aiModel: 'mock-model' }

// ---------------------------------------------------------------- 面板路由
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }, {})
const handler = routes['/go-dojo']

createServer((req, res) => {
  const url = req.url || '/'
  if (url === '/' || url === '/go-dojo') {
    res.writeHead(302, { location: '/go-dojo/' })
    return res.end()
  }
  if (url.startsWith('/go-dojo')) return handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
}).listen(PORT, () => {
  const src = process.env.GO_DOJO_API_KEY ? `真上游 ${configRef.config.aiBaseUrl}（${configRef.config.aiModel}）` : '内置 mock 上游（最中心空点）'
  console.log(`[go-dojo dev] http://localhost:${PORT}/go-dojo/  上游：${src}`)
})
