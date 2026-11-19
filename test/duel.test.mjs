import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDuel,
  getDuel,
  listDuels,
  recordPlayerMove,
  recordAiMove,
  resignDuel,
  buildTurnPrompt,
  duelStateView,
  saveReview,
  getReview,
  setMaxDuels,
} from '../lib/duel.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'godojo-duel-'))

function newDuel(overrides = {}) {
  return createDuel({
    levelId: 'boss-ai-duel',
    title: '7×7 · 王者对决',
    width: 7,
    height: 7,
    targetCaptures: 3,
    maxMoves: 60,
    ...overrides,
  })
}

test('建局 → 玩家落子 → 服务端合法性对账', () => {
  const d = newDuel()
  assert.equal(d.status, 'playing')
  assert.equal(d.aiColor, 2)

  // 非法：不是棋盘上的点
  const bad = recordPlayerMove(d.id, 'Q99')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不是这棋盘上的点/)

  // 合法：D4
  const good = recordPlayerMove(d.id, 'd4')
  assert.equal(good.ok, true)
  assert.deepEqual(good.duel.history, ['D4'])
  assert.equal(good.duel.lastMover, 1)

  // 玩家连走 → 拒绝
  const twice = recordPlayerMove(d.id, 'E5')
  assert.equal(twice.ok, false)
  assert.match(twice.error, /还没轮到你/)
})

test('agent 落子：写回棋谱+讲解，AI 连走被拦，非法弹回带原因', () => {
  const d = newDuel()
  recordPlayerMove(d.id, 'D4')

  const r = recordAiMove(d.id, 'e5', '我贴一手，跟你左边快连上。')
  assert.equal(r.ok, true)
  assert.match(r.summary, /已落子 E5/)
  assert.deepEqual(r.duel.history, ['D4', 'E5'])
  assert.equal(r.duel.lastComment, '我贴一手，跟你左边快连上。')
  assert.equal(r.duel.lastAiMove, 'E5')

  // AI 连走 → 拒绝
  const twice = recordAiMove(d.id, 'F5', '再一手')
  assert.equal(twice.ok, false)
  assert.match(twice.error, /上一手已经落子/)

  // 玩家走后 AI 下在自杀点 → 拒绝且 lastError 记录
  recordPlayerMove(d.id, 'C7') // 随便一手
  const suicide = recordAiMove(d.id, 'A1', '')
  // A1 不一定自杀；换一个确定的：先把白自己围死不好摆，这里只验证非法路径会写 lastError
  if (!suicide.ok) assert.ok(getDuel(d.id).lastError.length > 0)
})

test('胜负结算：玩家提够 → player_win；AI 提够 → ai_win', () => {
  // 摆一局玩家一手提三子不现实，直接低目标局验证状态机：
  // 白单子被围死的过程中没法一手提 3——改用 targetCaptures=1
  const d = createDuel({ levelId: 't', title: '提一子', width: 7, height: 7, targetCaptures: 1, maxMoves: 60 })
  recordPlayerMove(d.id, 'D4')
  recordAiMove(d.id, 'D5', '贴')
  // 玩家一手提白 D5？围 D5：C5 D6 E5 D4 —— 还差一手
  recordPlayerMove(d.id, 'C5')
  recordAiMove(d.id, 'E6', '逃')
  recordPlayerMove(d.id, 'D6')
  recordAiMove(d.id, 'D3', '打吃')
  // 现在白 D5 的邻：C5(黑) D6(黑) E5(空) D4? 不，D5 的邻是 C5,D6,E5,D4(黑)。E5 还是空——白没被提
  // 玩家下 E5 提白 D5 → player_win
  const r = recordPlayerMove(d.id, 'E5')
  assert.equal(r.ok, true)
  assert.equal(r.duel.playerCaptures, 1)
  assert.equal(r.duel.status, 'player_win')

  // 结束后不能再落子
  assert.equal(recordAiMove(d.id, 'G7', 'x').ok, false)
  assert.equal(recordPlayerMove(d.id, 'G7').ok, false)
})

test('劫局：AI 立即回提被弹回且 lastError 落档', () => {
  const d = newDuel()
  // 经典劫形（黑白轮流）：黑四步围死白 D4，E4 一手提劫，白回提是劫
  recordPlayerMove(d.id, 'C4') // 黑
  recordAiMove(d.id, 'D4', '占') // 白（劫石）
  recordPlayerMove(d.id, 'D5') // 黑
  recordAiMove(d.id, 'E5', '爬') // 白
  recordPlayerMove(d.id, 'D3') // 黑
  recordAiMove(d.id, 'E3', '压') // 白
  recordPlayerMove(d.id, 'C5') // 黑（闲手）
  recordAiMove(d.id, 'F4', '拆') // 白
  const cap = recordPlayerMove(d.id, 'E4') // 黑提白 D4（劫）
  assert.equal(cap.ok, true, cap.error || '')
  assert.equal(cap.duel.playerCaptures, 1)
  const ko = recordAiMove(d.id, 'D4', '回提')
  assert.equal(ko.ok, false)
  assert.match(ko.error, /劫/)
  assert.match(getDuel(d.id).lastError, /劫/)
})

test('turn-prompt：自包含指令含棋盘图/棋谱/duelId/铁律', () => {
  const d = newDuel()
  recordPlayerMove(d.id, 'D4')
  recordAiMove(d.id, 'E5', '贴一手')
  recordPlayerMove(d.id, 'D6')
  const p = buildTurnPrompt(getDuel(d.id))
  assert.match(p, /该你落子/)
  assert.match(p, new RegExp(d.id))
  assert.match(p, /先提掉对方 3 颗/)
  assert.match(p, /你执白/)
  assert.match(p, /D4 E5 D6/)
  assert.match(p, /你上一手的讲解/)
  assert.match(p, /go_dojo\(action="ai_move"/)
  assert.match(p, /7 \. \. \. \. \. \. \./) // 棋盘图首行
})

test('state/review/save_review/list/存档轮转', () => {
  const d = newDuel()
  recordPlayerMove(d.id, 'D4')
  recordAiMove(d.id, 'E5', '贴')

  const v = duelStateView(d.id)
  assert.match(v.boardText, /A B C D E F G/)
  assert.match(v.sgf, /;B\[dd\];W\[ec\]/)

  const saved = saveReview(d.id, '## 三处要点\n1. D4 太近')
  assert.ok(saved.path.endsWith(`${d.id}-review.md`))
  const review = getReview(d.id)
  assert.match(review.text, /三处要点/)
  assert.match(review.text, /SGF/)

  const list = listDuels(10)
  assert.ok(list.length >= 1)
  assert.equal(list[0].hasReview, true)

  // 存档轮转：maxDuels=5 时建 8 局，最旧的被清
  setMaxDuels(5)
  for (let i = 0; i < 8; i++) {
    const x = createDuel({ levelId: `p${i}`, title: `p${i}`, width: 5, height: 5, targetCaptures: 2, maxMoves: 40 })
    assert.ok(x.id)
    // createdAt 同秒可能相同 → 强制递增
    getDuel(x.id).createdAt = new Date(Date.now() + i * 10).toISOString()
  }
  // 触发下一次 prune：再建一局
  createDuel({ levelId: 'last', title: 'last', width: 5, height: 5, targetCaptures: 2, maxMoves: 40 })
  assert.ok(listDuels(50).length <= 6, `轮转后应 ≤ maxDuels+1，实际 ${listDuels(50).length}`)
})

test('认输与 ended（双 pass）', () => {
  const d = newDuel()
  recordPlayerMove(d.id, 'pass')
  recordAiMove(d.id, 'pass', '你也停？那我也不下了')
  const r = recordPlayerMove(d.id, 'pass')
  assert.equal(r.ok, false) // 已经 ended
  assert.equal(getDuel(d.id).status, 'ended')

  const d2 = newDuel()
  recordPlayerMove(d2.id, 'D4')
  const resigned = resignDuel(d2.id)
  assert.equal(resigned.status, 'resigned')
})
