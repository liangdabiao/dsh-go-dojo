// 对局存档层：每局棋一个 JSON（$DSH_HOME/go-dojo/duels/<id>.json），
// 复盘报告是 <id>-review.md。面板走 HTTP 读写，agent 走工具读写，两边同一层。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGameState, applyMove, toSgf, serializeBoard } from './go-rules.js'

// 惰性取目录：DSH_HOME 在测试/冒烟里是运行前注入的，不能在 import 时固化
export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'go-dojo')
}
export function duelsDir() {
  return join(dataDir(), 'duels')
}

let maxDuels = 100
export function setMaxDuels(n) {
  maxDuels = Math.max(5, Math.min(500, Number(n) || 100))
}

function ensureDir() {
  mkdirSync(duelsDir(), { recursive: true })
}

function fileOf(id) {
  if (!/^d-[a-z0-9-]+$/.test(id) || id.includes('..')) throw new Error('对局 ID 不合法')
  return join(duelsDir(), `${id}.json`)
}

export function newId() {
  const rand = Math.random().toString(36).slice(2, 8)
  return `d-${Date.now().toString(36)}-${rand}`
}

// ---------------------------------------------------------------- 建/读/删

/** 建一局。opts: levelId,title,width,height,playerColor,aiColor,targetCaptures,maxMoves */
export function createDuel(opts) {
  const width = Math.min(19, Math.max(2, Number(opts.width) || 7))
  const height = Math.min(19, Math.max(2, Number(opts.height) || 7))
  const targetCaptures = Math.min(100, Math.max(1, Number(opts.targetCaptures) || 3))
  const maxMoves = Math.min(2000, Math.max(4, Number(opts.maxMoves) || 200))
  const playerColor = Number(opts.playerColor) === 2 ? 2 : 1
  const duel = {
    id: newId(),
    levelId: String(opts.levelId || 'custom'),
    title: String(opts.title || `${width}×${height} 对弈`),
    width,
    height,
    playerColor,
    aiColor: playerColor === 1 ? 2 : 1,
    targetCaptures,
    maxMoves,
    history: [],
    playerCaptures: 0,
    aiCaptures: 0,
    turn: 0,
    consecutivePasses: 0,
    lastMover: 0,
    lastComment: '',
    lastError: '',
    lastAiMove: '',
    status: 'playing', // playing | player_win | ai_win | ended | resigned
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  ensureDir()
  pruneOld()
  writeFileSync(fileOf(duel.id), JSON.stringify(duel, null, 2), 'utf8')
  return duel
}

function pruneOld() {
  let names
  try {
    names = readdirSync(duelsDir()).filter((n) => /^d-[a-z0-9-]+\.json$/.test(n))
  } catch {
    return
  }
  if (names.length <= maxDuels) return
  const withTime = names
    .map((n) => {
      try {
        const d = JSON.parse(readFileSync(join(duelsDir(), n), 'utf8'))
        return { n, t: d.createdAt || '' }
      } catch {
        return { n, t: '' }
      }
    })
    .sort((a, b) => (a.t < b.t ? -1 : 1))
  for (const { n } of withTime.slice(0, names.length - maxDuels)) {
    try {
      rmSync(join(duelsDir(), n))
    } catch { /* ignore */ }
  }
}

export function getDuel(id) {
  try {
    const duel = JSON.parse(readFileSync(fileOf(id), 'utf8'))
    if (duel && duel.id === id) return duel
    return null
  } catch {
    return null
  }
}

export function saveDuel(duel) {
  duel.updatedAt = new Date().toISOString()
  ensureDir()
  writeFileSync(fileOf(duel.id), JSON.stringify(duel, null, 2), 'utf8')
  return duel
}

export function listDuels(limit = 30) {
  ensureDir()
  const names = readdirSync(duelsDir())
    .filter((n) => /^d-[a-z0-9-]+\.json$/.test(n))
    .sort((a, b) => (a < b ? 1 : -1)) // id 含时间戳，倒序即最新在前
  const out = []
  for (const n of names.slice(0, limit)) {
    try {
      const d = JSON.parse(readFileSync(join(duelsDir(), n), 'utf8'))
      out.push({
        id: d.id,
        title: d.title,
        levelId: d.levelId,
        width: d.width,
        height: d.height,
        targetCaptures: d.targetCaptures,
        playerCaptures: d.playerCaptures,
        aiCaptures: d.aiCaptures,
        status: d.status,
        moves: d.history.length,
        hasReview: existsSync(join(duelsDir(), `${d.id}-review.md`)),
        createdAt: d.createdAt,
      })
    } catch { /* 跳过坏档 */ }
  }
  return out
}

// ---------------------------------------------------------------- 走子

function replay(duel) {
  const st = createGameState(duel.width, duel.height, duel.playerColor, duel.aiColor)
  st.consecutivePasses = 0
  st.lastMover = 0
  let playerCaptures = 0
  let aiCaptures = 0
  for (const mv of duel.history) {
    const color = st.lastMover === 0 || st.lastMover === duel.aiColor ? duel.playerColor : duel.aiColor
    const r = applyMove(st, mv, color)
    if (!r.ok) throw new Error(`存档棋谱在第 ${st.moveCount + 1} 手无法重放：${r.error}`)
    if (color === duel.playerColor) playerCaptures = st.playerCaptures
    else aiCaptures = st.aiCaptures
  }
  return st
}

/**
 * 面板上报玩家一手：合法性服务端校验（对账防漂移），通过则追加棋谱并结算。
 * 返回 {ok, duel} 或 {ok:false, error}。
 */
export function recordPlayerMove(id, move) {
  const duel = getDuel(id)
  if (!duel) return { ok: false, error: '没有这局棋' }
  if (duel.status !== 'playing') return { ok: false, error: `对局已结束（${duel.status}）` }
  if (duel.lastMover === duel.playerColor && duel.history.length > 0) {
    return { ok: false, error: '还没轮到你——AI 还没回子' }
  }
  const st = replay(duel)
  const r = applyMove(st, String(move || '').trim(), duel.playerColor)
  if (!r.ok) return { ok: false, error: r.error }

  duel.history.push(r.coord === 'pass' ? 'pass' : r.coord)
  duel.playerCaptures = st.playerCaptures
  duel.aiCaptures = st.aiCaptures
  duel.turn = st.moveCount
  duel.consecutivePasses = st.consecutivePasses
  duel.lastMover = duel.playerColor
  duel.lastError = ''
  // 胜负判定（与面板同规则）
  if (duel.playerCaptures >= duel.targetCaptures) duel.status = 'player_win'
  else if (duel.turn >= duel.maxMoves || duel.consecutivePasses >= 2) duel.status = 'ended'
  saveDuel(duel)
  return { ok: true, duel }
}

/**
 * agent 落子：同样的服务端校验（占位/自杀/劫/轮次），通过则写回 + 记录讲解 + 结算。
 * 返回 {ok, duel, summary} 或 {ok:false, error}。
 */
export function recordAiMove(id, move, comment) {
  const duel = getDuel(id)
  if (!duel) return { ok: false, error: '没有这局棋（duelId 是否来自对局指令？可用 go_dojo action=list 查）' }
  if (duel.status !== 'playing') return { ok: false, error: `对局已结束（${duel.status}），不能再落子` }
  if (duel.lastMover === duel.aiColor) {
    return { ok: false, error: '你上一手已经落子，等对手（用户）走完再下' }
  }
  const st = replay(duel)
  const raw = String(move || '').trim()
  const r = applyMove(st, raw.toLowerCase() === 'pass' ? 'pass' : raw.toUpperCase(), duel.aiColor)
  if (!r.ok) {
    duel.lastError = r.error
    saveDuel(duel)
    return { ok: false, error: `落子非法：${r.error}。看下面的棋盘图重新选点，再调一次 go_dojo ai_move。` }
  }

  duel.history.push(r.coord === 'pass' ? 'pass' : r.coord)
  duel.playerCaptures = st.playerCaptures
  duel.aiCaptures = st.aiCaptures
  duel.turn = st.moveCount
  duel.consecutivePasses = st.consecutivePasses
  duel.lastMover = duel.aiColor
  duel.lastComment = String(comment || '').trim().slice(0, 200)
  duel.lastAiMove = r.coord === 'pass' ? 'pass' : r.coord
  duel.lastError = ''
  if (duel.aiCaptures >= duel.targetCaptures) duel.status = 'ai_win'
  else if (duel.turn >= duel.maxMoves || duel.consecutivePasses >= 2) duel.status = 'ended'

  saveDuel(duel)
  const capturedNote = r.captured > 0 ? `，提掉 ${r.captured} 子` : ''
  const summary =
    `✅ 已落子 ${r.coord}${capturedNote}。比分：你 ${duel.aiCaptures}/${duel.targetCaptures}，对手 ${duel.playerCaptures}/${duel.targetCaptures}（第 ${duel.turn} 手）` +
    (duel.status !== 'playing' ? `。对局结束：${endNote(duel)}` : '。等对手落子。')
  return { ok: true, duel, summary }
}

export function resignDuel(id) {
  const duel = getDuel(id)
  if (!duel) return null
  if (duel.status === 'playing') {
    duel.status = 'resigned'
    saveDuel(duel)
  }
  return duel
}

function endNote(duel) {
  switch (duel.status) {
    case 'player_win': return '对手先提够了子，你输了'
    case 'ai_win': return '你先提够了子，你赢了'
    case 'resigned': return '对手认输'
    default: return '步数用尽 / 双方停手'
  }
}

// ---------------------------------------------------------------- 给 agent 的现场（棋盘图 + 纪律）

const colorName = (c) => (c === 1 ? '黑' : '白')

export function buildTurnPrompt(duel) {
  const st = replay(duel)
  const mine = colorName(duel.aiColor)
  const theirs = colorName(duel.playerColor)
  const lines = [
    `【围棋道场 · 该你落子】`,
    `对局「${duel.title}」（${duel.width}×${duel.height}）。规则：先提掉对方 ${duel.targetCaptures} 颗棋子者获胜，最多 ${duel.maxMoves} 手，双停一手即终局。`,
    `你执${mine}，对手（用户）执${theirs}。`,
    `当前提子：你 ${duel.aiCaptures}/${duel.targetCaptures}，对手 ${duel.playerCaptures}/${duel.targetCaptures}（第 ${duel.turn} 手）。`,
    ``,
    `棋盘（B=黑，W=白，.=空；列字母 A 起、无 I；行号从上往下递减，C7 即 C 列第 7 行）：`,
    serializeBoard(st.board, duel.width, duel.height),
    ``,
    duel.history.length
      ? `棋谱（奇数手=对手，偶数手=你）：${duel.history.join(' ')}`
      : `开局，你还没下过。`,
  ]
  if (duel.lastComment) lines.push(`你上一手的讲解：「${duel.lastComment}」`)
  if (duel.lastError) lines.push(`⚠ 你上一次的落子被判定非法：${duel.lastError}。换一个点重下。`)
  lines.push(
    ``,
    `请按围棋思路选点，然后调用工具 go_dojo（一次）：`,
    `go_dojo(action="ai_move", duelId="${duel.id}", move="<坐标或pass>", comment="<一句话讲解这手棋的意图>")`,
    `铁律：move 只能是棋盘图上的合法空点（占位/自杀/立即回提劫都非法）；确实无好棋才允许 move="pass"；comment 必填。落子成功后，用一句话向用户复述你的走子与讲解即可，不要长篇分析。`,
  )
  return lines.join('\n')
}

/** 给 agent 看的现场快照（action=state） */
export function duelStateView(id) {
  const duel = getDuel(id)
  if (!duel) return null
  const st = replay(duel)
  return {
    duel: { ...duel },
    boardText: serializeBoard(st.board, duel.width, duel.height),
    sgf: toSgf(duel.history, duel.width, duel.height, duel.playerColor, duel.aiColor),
  }
}

// ---------------------------------------------------------------- 复盘报告

export function saveReview(id, report) {
  const duel = getDuel(id)
  if (!duel) throw new Error('没有这局棋')
  ensureDir()
  const file = join(duelsDir(), `${id}-review.md`)
  const header = `# 复盘 · ${duel.title}（${duel.id}）\n\n- 结果：${endNote(duel)}；比分 你 ${duel.aiCaptures} vs 对手 ${duel.playerCaptures}（目标 ${duel.targetCaptures}）\n- 棋谱：${duel.history.join(' ')}\n- SGF：\`${toSgf(duel.history, duel.width, duel.height, duel.playerColor, duel.aiColor)}\`\n\n`
  writeFileSync(file, header + String(report || ''), 'utf8')
  return { id, path: file, bytes: (header + String(report || '')).length }
}

export function getReview(id) {
  const duel = getDuel(id)
  if (!duel) return null
  const file = join(duelsDir(), `${id}-review.md`)
  if (!existsSync(file)) return null
  return { id, path: file, text: readFileSync(file, 'utf8') }
}
