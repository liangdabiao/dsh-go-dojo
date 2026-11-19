// 冒烟（离线零网络）：假 ctx 驱动全部面板 API 路由 + go_dojo 工具全 action 直调 + 静态伺服/穿越拦截。
// 用真 Writable 流接响应（家族惯例）。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { registerApi } from '../lib/api.js'
import { TOOLS } from '../lib/tools.js'

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

// ---------------------------------------------------------------- 假 ctx
const routes = {}
registerApi(
  {
    get: () => undefined,
    webServer: { register: (r) => { routes[r.path] = r.handler } },
  },
  {},
)

// app/dist 得有东西才能测静态伺服：塞一个假 index.html
const distIndex = join(PLUGIN_ROOT, 'app', 'dist', 'index.html')
mkdirSync(dirname(distIndex), { recursive: true })
if (!existsSync(distIndex)) writeFileSync(distIndex, '<!doctype html><title>go-dojo</title><div id="root"></div>', 'utf8')

const handler = routes['/go-dojo']

const req = async (method, path, body, headers = {}) => {
  const chunks = []
  const res = new Writable({
    write(c, _e, cb) { chunks.push(c); cb() },
  })
  res.statusCode = 500
  res.writeHead = (status, hdrs) => { res.statusCode = status; Object.assign(res.headers_ = {}, hdrs) }
  const r = Object.assign(new EventEmitter(), {
    method,
    url: path,
    headers: { host: 'localhost', 'content-type': body ? 'application/json' : '', ...headers },
  })
  const done = new Promise((resolve) => res.on('finish', resolve))
  handler(r, res)
  if (body) r.emit('data', Buffer.from(JSON.stringify(body)))
  r.emit('end')
  await done
  const text = Buffer.concat(chunks).toString('utf8')
  let jsonBody = null
  try { jsonBody = JSON.parse(text) } catch { /* 非 JSON（静态文件） */ }
  return { status: res.statusCode, headers: res.headers_ || {}, text, json: jsonBody }
}

// ---------------------------------------------------------------- 工具直调
const tool = TOOLS[0]
const call = async (args) => {
  const v = await tool.execute(args)
  return { ...v, data: v.data ? JSON.parse(v.data) : null }
}

console.log('\n== 面板 API ==')
{
  const ping = await req('GET', '/go-dojo/api/ping')
  check('GET /api/ping', ping.status === 200 && ping.json.ok === true)

  const noW = await req('POST', '/go-dojo/api/duel/new', { levelId: 'x' })
  check('建局缺 width → 400', noW.status === 400)

  const d = await req('POST', '/go-dojo/api/duel/new', {
    levelId: 'boss-ai-duel', title: '7×7 · 王者对决', width: 7, height: 7, targetCaptures: 3, maxMoves: 60,
  })
  check('POST /api/duel/new', d.status === 200 && d.json.duel?.id?.startsWith('d-'), JSON.stringify(d.json))
  const id = d.json.duel.id

  const mv1 = await req('POST', '/go-dojo/api/duel/move', { id, move: 'D4' })
  check('玩家落子上报', mv1.status === 200 && mv1.json.duel.history[0] === 'D4')

  const mvBad = await req('POST', '/go-dojo/api/duel/move', { id, move: 'E5' })
  check('玩家连走 → 400 + 原因', mvBad.status === 400 && /还没轮到你/.test(mvBad.json.error))

  const tp = await req('POST', '/go-dojo/api/duel/turn-prompt', { id })
  check('turn-prompt 含 duelId 与棋盘图', tp.status === 200 && tp.json.prompt.includes(id) && /7 \. \. \. \. \. \. \./.test(tp.json.prompt))

  const poll = await req('GET', `/go-dojo/api/duel?id=${id}`)
  check('GET /api/duel 轮询', poll.status === 200 && poll.json.duel.status === 'playing')

  const bad = await req('GET', '/go-dojo/api/duel?id=d-nope')
  check('未知对局 → 404', bad.status === 404)

  const esc = await req('GET', '/go-dojo/api/%2e%2e/package.json')
  check('路径穿越拦截', esc.status === 404 || esc.status === 403, `status=${esc.status}`)

  const idx = await req('GET', '/go-dojo/')
  check('静态首页伺服', idx.status === 200 && /<div id="root">/.test(idx.text) && !idx.json)

  const missing = await req('GET', '/go-dojo/no-such-file.js')
  check('静态缺失 → 404', missing.status === 404)
}

console.log('\n== go_dojo 工具 ==')
{
  const d = await req('POST', '/go-dojo/api/duel/new', { levelId: 't2', title: '工具局', width: 7, height: 7, targetCaptures: 3, maxMoves: 60 })
  const id = d.json.duel.id
  await req('POST', '/go-dojo/api/duel/move', { id, move: 'D4' })

  const st = await call({ action: 'state', duelId: id })
  check('action=state', st.ok && st.data.boardText.includes('A B C D E F G'))

  const list = await call({ action: 'list' })
  check('action=list', list.ok && Array.isArray(list.data) && list.data.length >= 1)

  const noId = await call({ action: 'ai_move', move: 'C4', comment: 'x' })
  check('缺 duelId → 失败回执', noId.ok === false && /duelId/.test(noId.summary))

  const good = await call({ action: 'ai_move', duelId: id, move: 'E5', comment: '贴一手' })
  check('ai_move 合法落子', good.ok && /已落子 E5/.test(good.summary), good.summary)

  const twice = await call({ action: 'ai_move', duelId: id, move: 'F5', comment: '连走' })
  check('AI 连走被拦', twice.ok === false && /上一手已经落子/.test(twice.summary))

  await req('POST', '/go-dojo/api/duel/move', { id, move: 'C7' })

  const badMove = await call({ action: 'ai_move', duelId: id, move: 'ZZ9', comment: '乱写' })
  check('非法坐标弹回', badMove.ok === false && /非法/.test(badMove.summary))

  // 提子到胜利：targetCaptures=3 的局摆不出来，另开 target=1 的一局走完
  const d1 = await req('POST', '/go-dojo/api/duel/new', { levelId: 't3', title: '提一子', width: 7, height: 7, targetCaptures: 1, maxMoves: 60 })
  const id1 = d1.json.duel.id
  const seq = [
    ['player', 'D4'], ['ai', 'D5'], ['player', 'C5'], ['ai', 'E6'],
    ['player', 'D6'], ['ai', 'D3'], ['player', 'E5'],
  ]
  let aiWon = false
  for (const [who, mv] of seq) {
    if (who === 'player') await req('POST', '/go-dojo/api/duel/move', { id: id1, move: mv })
    else await call({ action: 'ai_move', duelId: id1, move: mv, comment: '应一手' })
    const cur = await req('GET', `/go-dojo/api/duel?id=${id1}`)
    if (cur.json.duel.status !== 'playing') { if (cur.json.duel.status === 'player_win') aiWon = true; break }
  }
  check('提子胜利结算 player_win', aiWon)

  // 复盘链路：review → save_review → GET /api/duel/review
  const rv = await call({ action: 'review', duelId: id1 })
  check('action=review 返回 SGF', rv.ok && rv.data.sgf.includes('SZ[7:7]'))
  const sv = await call({ action: 'save_review', duelId: id1, report: '# 复盘\n要点三条' })
  check('save_review 落档', sv.ok && existsSync(sv.data.path))
  const gr = await req('GET', `/go-dojo/api/duel/review?id=${id1}`)
  check('GET /api/duel/review', gr.status === 200 && /复盘/.test(gr.json.text))

  // 认输
  const d2 = await req('POST', '/go-dojo/api/duel/new', { levelId: 't4', title: '认输局', width: 5, height: 5, targetCaptures: 2, maxMoves: 40 })
  await req('POST', '/go-dojo/api/duel/resign', { id: d2.json.duel.id })
  const d2s = await req('GET', `/go-dojo/api/duel?id=${d2.json.duel.id}`)
  check('resign → resigned', d2s.json.duel.status === 'resigned')

  // pass 流：双 pass 终局
  const d3 = await req('POST', '/go-dojo/api/duel/new', { levelId: 't5', title: '停手局', width: 5, height: 5, targetCaptures: 2, maxMoves: 40 })
  const id3 = d3.json.duel.id
  await req('POST', '/go-dojo/api/duel/move', { id: id3, move: 'pass' })
  await call({ action: 'ai_move', duelId: id3, move: 'pass', comment: '你也停' })
  const d3s = await req('GET', `/go-dojo/api/duel?id=${id3}`)
  check('双 pass → ended', d3s.json.duel.status === 'ended', `status=${d3s.json.duel.status}`)
}

console.log(`\n冒烟结果：${pass} 过 / ${failN} 挂`)
process.exitCode = failN === 0 ? 0 : 1
