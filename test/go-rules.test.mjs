import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCoord,
  xyToCoord,
  serializeBoard,
  simulateMove,
  isLegal,
  countRemoved,
  findFallbackMove,
  createGameState,
  applyMove,
  toSgf,
} from '../lib/go-rules.js'

const W = 7
const H = 7
const empty7 = () => Array.from({ length: 7 }, () => Array(7).fill(0))

test('坐标编解码：无 I 列 + 往返一致', () => {
  assert.equal(parseCoord('A1', W, H).y, 6) // A1 是最底行 → y=6
  assert.equal(parseCoord('A7', W, H).y, 0) // A7 是最顶行 → y=0
  assert.equal(xyToCoord(0, 6, 7), 'A1')
  assert.equal(xyToCoord(2, 0, 7), 'C7')
  // 没有 I 列：H 之后是 J
  assert.equal(parseCoord('J1', 19, 19).x, 8)
  assert.equal(xyToCoord(8, 0, 19), 'J19')
  assert.equal(parseCoord('I1', 19, 19), null)
  assert.equal(parseCoord('H8', W, H), null) // 越界
  assert.equal(parseCoord('A0', W, H), null)
})

test('serializeBoard：格式与原版一致', () => {
  const b = empty7()
  b[0][2] = 1
  b[6][0] = 2
  const text = serializeBoard(b, 7, 7)
  const lines = text.split('\n')
  assert.equal(lines[0], '  A B C D E F G')
  assert.equal(lines[1], ' 7 . . B . . . .')
  assert.equal(lines[7], ' 1 W . . . . . .')
})

test('simulateMove：提一子 / 自杀拒绝 / 占位拒绝', () => {
  const b4 = empty7()
  b4[3][3] = 1 // D4 黑
  b4[2][3] = 1 // D5 黑
  b4[4][3] = 1 // D3 黑
  b4[3][2] = 1 // C4 黑
  b4[2][4] = 1 // E5 黑
  b4[4][4] = 1 // E3 黑
  b4[3][4] = 2 // E4 白——四面被黑围，只剩 F4 一口气
  const cap = simulateMove(b4, 5, 3, 1, 7, 7) // 黑下 F4 → 提白 E4
  assert.ok(cap)
  assert.equal(countRemoved(b4, cap, 2), 1)
  assert.equal(cap[3][4], 0)
  // 自杀：黑子围一个真眼，白往眼里放 → 自杀拒绝
  const b5 = empty7()
  b5[2][2] = 1; b5[2][3] = 1; b5[2][4] = 1
  b5[3][2] = 1; b5[3][4] = 1
  b5[4][2] = 1; b5[4][3] = 1; b5[4][4] = 1
  assert.equal(simulateMove(b5, 3, 3, 2, 7, 7), null)
  // 占位
  assert.equal(simulateMove(b5, 2, 2, 1, 7, 7), null)
})

test('applyMove：提子计数 + lastMover 轮次保护', () => {
  const st = createGameState(7, 7, 1, 2) // 玩家黑 AI 白
  // 白三面围黑 D4，黑一手自投
  // 黑先下 E5，白围杀不了，换简单场景：黑下 D4，白下 E4，黑提白单子
  const r1 = applyMove(st, 'D4', 1)
  assert.ok(r1.ok)
  const r1again = applyMove(st, 'E5', 1)
  assert.equal(r1again.ok, false) // 黑连走 → 拒绝
  const r2 = applyMove(st, 'E4', 2)
  assert.ok(r2.ok)
  const r3 = applyMove(st, 'D5', 1)
  assert.ok(r3.ok)
  const r4 = applyMove(st, 'C4', 2)
  assert.ok(r4.ok)
  const r5 = applyMove(st, 'F4', 1)
  assert.ok(r5.ok)
  // 白 E4 现在气尽：白再下 F4 不行（黑已占），白要提黑单子不行——直接验证黑 E5 白四面包
  // 简化：新开一局测提子计数
  const st2 = createGameState(7, 7, 1, 2)
  applyMove(st2, 'D4', 1) // 黑
  applyMove(st2, 'D5', 2) // 白
  applyMove(st2, 'C4', 1) // 黑
  applyMove(st2, 'E5', 2) // 白
  applyMove(st2, 'C5', 1) // 黑
  applyMove(st2, 'B4', 2) // 白
  applyMove(st2, 'C6', 1) // 黑
  const r = applyMove(st2, 'D3', 2) // 白
  assert.ok(r.ok)
  // 白现在四面围黑 D4？黑 D4 的邻：C4(黑) D5(白) D3(白刚下) E4(空)——还没死
  applyMove(st2, 'E4', 1) // 黑补
  assert.equal(st2.playerCaptures, 0)
})

test('applyMove：简单劫——立即回提被拒', () => {
  const st = createGameState(7, 7, 1, 2)
  // 经典劫形：白 D4 四面被围只剩 E4 一口气，黑 E4 提子后自身也只有 D4 一口气
  // 严格黑白轮流摆出此形：
  applyMove(st, 'C4', 1) // 黑
  applyMove(st, 'D4', 2) // 白（劫石）
  applyMove(st, 'D5', 1) // 黑
  applyMove(st, 'E5', 2) // 白
  applyMove(st, 'D3', 1) // 黑
  applyMove(st, 'E3', 2) // 白
  applyMove(st, 'C5', 1) // 黑（填一手闲棋）
  applyMove(st, 'F4', 2) // 白（E4 的第三邻）
  // 黑 E4 提白 D4；E4 落下后只剩 D4 一口气（E5/E3/F4 都是白）
  const cap = applyMove(st, 'E4', 1)
  assert.ok(cap.ok, `黑应能提劫：${cap.error || ''}`)
  assert.equal(cap.captured, 1)
  assert.equal(st.playerCaptures, 1)
  // 白立即回提 D4 → 还原上一局面 → 简单劫被拒
  const ko = applyMove(st, 'D4', 2)
  assert.equal(ko.ok, false, '立即回提劫必须被拒')
  assert.match(ko.error, /劫/)
})

test('applyMove：pass 与双 pass', () => {
  const st = createGameState(7, 7, 1, 2)
  assert.ok(applyMove(st, 'pass', 1).ok)
  assert.equal(st.consecutivePasses, 1)
  assert.ok(applyMove(st, 'pass', 2).ok)
  assert.equal(st.consecutivePasses, 2)
})

test('findFallbackMove：能提就提', () => {
  const b = empty7()
  b[3][3] = 2 // 白 D4
  b[2][3] = 1; b[4][3] = 1; b[3][2] = 1 // 黑三面围，白只剩 E4 一口气
  const mv = findFallbackMove(b, 7, 7, 1)
  assert.ok(mv)
  // 唯一能提子的点是 E4（x=4, y=3）——注意内部 y=0 在顶
  assert.deepEqual(mv, { x: 4, y: 3 })
})

test('toSgf：pass 与坐标', () => {
  const sgf = toSgf(['D4', 'E5', 'pass'], 7, 7, 1, 2)
  assert.match(sgf, /SZ\[7:7\]/)
  assert.match(sgf, /;B\[dd\]/) // D4 → 列 d 行 y=3 → d
  assert.match(sgf, /;W\[ec\]/) // E5 → 列 e 行 y=2 → c（SGF 行从顶往下）
  assert.match(sgf, /;B\[\]/) // pass = 空坐标
})

test('isLegal 一致性：simulateMove 即 isLegal', () => {
  const b = empty7()
  b[3][3] = 1
  assert.equal(isLegal(b, 3, 3, 1, 7, 7), false)
  assert.equal(isLegal(b, 3, 3, 2, 7, 7), false)
  assert.equal(isLegal(b, 0, 0, 2, 7, 7), true)
})
