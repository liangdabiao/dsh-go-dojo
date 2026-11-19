// 本地开发服务器：lib/api.js 的真实前缀路由 + 内置 mock LLM 上游。
// 用法：node scripts/devserver.mjs [端口]（默认 5190）
//   http://localhost:5190/go-dojo/      面板 SPA + API（AI 走子走 mock 上游，无需真 key）
// 真上游调试：设 GO_DOJO_BASE_URL / GO_DOJO_API_KEY / GO_DOJO_MODEL 环境变量。
import { createServer } from 'node:http'
import { registerApi, configRef } from '../lib/api.js'

const PORT = Number(process.argv[2]) || 5190

// ---------------------------------------------------------------- mock 上游
// 挑最靠中心的空点落子（本地验收用，零外网）。
//
// v0.2.1 起面板走多模态：user content 是 [{type:'image_url'}, {type:'text'}]
// 数组，棋盘只存在于图片里，**文字棋盘 boardText 只在旧版/无图回退时才有**。
// 所以这里先从文字棋盘读（有就用，最准），没有就退回请求体里的
// moveHistory + width/height 推空点——旧实现直接对 content 调 split，
// 图片模式下会 TypeError 打挂整个 mock 进程（面板随即降级本地陪练）。
const COL_SEQ = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

/** content 既可能是字符串，也可能是 OpenAI 多模态数组 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** "Board (B=black, W=white, .=empty):" 之后的字符画棋盘 → 占用表 / null */
function gridFromText(text) {
  const boardText = text.split('Board (B=black, W=white, .=empty):')[1]?.split('Your move:')[0] ?? ''
  const lines = boardText.split('\n').filter((l) => /^\s*\d+(\s+[BW.])+\s*$/.test(l))
  const grid = lines.map((l) => l.trim().split(/\s+/).slice(1))
  return grid.length > 0 && grid[0].length > 0 ? grid : null
}

/** 坐标（列字母行号，"D4"/"pass"）→ [x, y]；非法或 pass 返回 null */
function pointToXY(move, width, height) {
  if (typeof move !== 'string' || !move) return null
  const x = COL_SEQ.indexOf(move[0].toUpperCase())
  const row = Number.parseInt(move.slice(1), 10)
  if (x < 0 || x >= width || Number.isNaN(row)) return null
  const y = height - row
  return y >= 0 && y < height ? [x, y] : null
}

/** 最靠中心的空点；全满则 pass */
function pickMove(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const systemText = textOf(messages.find((m) => m.role === 'system')?.content)
  const userText = textOf(messages.find((m) => m.role === 'user')?.content)
  const allText = `${systemText}\n${userText}`

  // 代理只把棋子局缩进提示词里：「... on a 7x7 board」「Moves so far: D4, E5」
  const size = /(\d+)\s*x\s*(\d+)\s*board/i.exec(allText)
  const width = Number(size?.[1]) || Number(body?.width) || 7
  const height = Number(size?.[2]) || Number(body?.height) || 7

  const grid = gridFromText(userText)
  const taken = new Set()
  if (grid) {
    grid.forEach((row, y) => row.forEach((cell, x) => { if (cell !== '.') taken.add(`${x},${y}`) }))
  } else {
    const historyText = /Moves so far:\s*([^\n]*)/i.exec(userText)?.[1] ?? ''
    const history = historyText ? historyText.split(/[,\s]+/).filter(Boolean) : []
    for (const move of history) {
      const p = pointToXY(move, width, height)
      if (p) taken.add(`${p[0]},${p[1]}`)
    }
  }

  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  let best = null
  let bestD = Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (taken.has(`${x},${y}`)) continue
      const d = Math.abs(x - cx) + Math.abs(y - cy)
      if (d < bestD) { bestD = d; best = [x, y] }
    }
  }
  return best ? COL_SEQ[best[0]] + (height - best[1]) : 'pass'
}

const mockUpstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('error', () => { /* 客户端断开，忽略 */ })
  req.on('end', () => {
    // 解析失败也不能打挂进程：回 pass，面板照常继续（一次性 mock 而已）
    let move = 'pass'
    try {
      move = pickMove(JSON.parse(raw || '{}'))
    } catch (err) {
      console.warn(`[go-dojo dev] mock 上游解析失败，回 pass：${String(err?.message || err)}`)
    }
    if (res.writableEnded) return
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
