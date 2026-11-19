// 围棋规则引擎（纯函数，零依赖）——服务端权威校验用。
// 移植自 go-game 的 src/game/ai/goAI.ts + boardCodec.ts（AGPL-3.0，源自 online-go.com）。
// 在其基础上补了「简单劫」判定（原版靠 goban 引擎抛异常兜底，服务端没有引擎）。
//
// 棋盘：普通二维数组，0=空 1=黑 2=白。
// 坐标：内部 (x, y)，x 从左到右 0..w-1，y=0 在最上；展示坐标 "C7"（列字母无 I，行号从上往下递减）。

const COL_SEQ = 'ABCDEFGHJKLMNOPQRSTUVWXYZ' // 围棋惯例：没有 I
const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]

// ---------------------------------------------------------------- 坐标编解码

/** 内部 (x, y) → "C7"（y=0 是第 height 行） */
export function xyToCoord(x, y, height) {
  return COL_SEQ[x] + (height - y)
}

/** "C7" → {x, y}；越界/畸形返回 null */
export function parseCoord(coord, width, height) {
  if (!coord || typeof coord !== 'string' || coord.length < 2) return null
  const x = COL_SEQ.indexOf(coord[0].toUpperCase())
  const row = Number.parseInt(coord.slice(1), 10)
  if (x < 0 || x >= width || Number.isNaN(row)) return null
  const y = height - row
  if (y < 0 || y >= height) return null
  return { x, y }
}

/** 棋盘 → 文本棋盘图（发给 agent / 存档用）：列头 + 行号，B/W/. */
export function serializeBoard(board, width, height) {
  const header = '  ' + Array.from({ length: width }, (_, i) => COL_SEQ[i]).join(' ')
  const lines = [header]
  for (let y = 0; y < height; y++) {
    const rowNum = height - y
    let line = `${rowNum < 10 ? ' ' : ''}${rowNum} `
    for (let x = 0; x < width; x++) {
      const v = board[y][x]
      line += (v === 1 ? 'B' : v === 2 ? 'W' : '.') + (x < width - 1 ? ' ' : '')
    }
    lines.push(line)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- 棋群与模拟

function cloneBoard(board) {
  return board.map((row) => row.slice())
}

function boardKey(board) {
  return board.map((row) => row.join('')).join('|')
}

export function getGroups(board, width, height) {
  const seen = Array.from({ length: height }, () => Array(width).fill(false))
  const groups = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = board[y][x]
      if (color === 0 || seen[y][x]) continue
      const stones = []
      const libertySet = new Set()
      const queue = [[x, y]]
      seen[y][x] = true
      while (queue.length) {
        const [cx, cy] = queue.pop()
        stones.push([cx, cy])
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const nc = board[ny][nx]
          if (nc === 0) libertySet.add(`${nx},${ny}`)
          else if (nc === color && !seen[ny][nx]) {
            seen[ny][nx] = true
            queue.push([nx, ny])
          }
        }
      }
      const liberties = [...libertySet].map((key) => {
        const [lx, ly] = key.split(',').map(Number)
        return [lx, ly]
      })
      groups.push({ color, stones, liberties })
    }
  }
  return groups
}

export function getGroupAt(board, x, y, width, height) {
  const color = board[y][x]
  if (color === 0) return null
  for (const g of getGroups(board, width, height)) {
    for (const [sx, sy] of g.stones) if (sx === x && sy === y) return g
  }
  return null
}

/**
 * 试下 color@(x,y)：合法返回落子后的新棋盘，非法（占位/自杀且无提子）返回 null。
 * 不含劫判定——劫归 GameState 管（需要历史局面）。
 */
export function simulateMove(board, x, y, color, width, height) {
  if (x < 0 || x >= width || y < 0 || y >= height || board[y][x] !== 0) return null
  const b = cloneBoard(board)
  b[y][x] = color
  const opp = color === 1 ? 2 : 1
  for (const [dx, dy] of DIRS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
    if (b[ny][nx] !== opp) continue
    const g = getGroupAt(b, nx, ny, width, height)
    if (g && g.liberties.length === 0) {
      for (const [sx, sy] of g.stones) b[sy][sx] = 0
    }
  }
  const mine = getGroupAt(b, x, y, width, height)
  if (!mine || mine.liberties.length === 0) return null
  return b
}

export function isLegal(board, x, y, color, width, height) {
  return simulateMove(board, x, y, color, width, height) !== null
}

/** before → after 之间被提掉的 color 色子数 */
export function countRemoved(before, after, color) {
  let n = 0
  for (let y = 0; y < before.length; y++) {
    for (let x = 0; x < before[y].length; x++) {
      if (before[y][x] === color && after[y][x] === 0) n++
    }
  }
  return n
}

/** 贪心兜底：提子 > 救叫吃 > 贴自己长 > 中腹 */
export function findFallbackMove(board, width, height, color) {
  const opp = color === 1 ? 2 : 1
  const empty = []
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (board[y][x] === 0) empty.push([x, y])

  let best = null
  let bestCapture = 0
  for (const [x, y] of empty) {
    const sim = simulateMove(board, x, y, color, width, height)
    if (!sim) continue
    const captured = countRemoved(board, sim, opp)
    if (captured > bestCapture) {
      bestCapture = captured
      best = { x, y }
    }
  }
  if (best) return best

  const groups = getGroups(board, width, height)
  const mine = groups
    .filter((g) => g.color === color && g.liberties.length === 1)
    .sort((a, b) => b.stones.length - a.stones.length)
  for (const g of mine) {
    for (const [lx, ly] of g.liberties) {
      if (simulateMove(board, lx, ly, color, width, height)) return { x: lx, y: ly }
    }
  }

  const adjacency = new Map()
  for (const g of groups) {
    if (g.color !== color) continue
    for (const [sx, sy] of g.stones) {
      for (const [dx, dy] of DIRS) {
        const nx = sx + dx
        const ny = sy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        if (board[ny][nx] !== 0) continue
        adjacency.set(`${nx},${ny}`, (adjacency.get(`${nx},${ny}`) ?? 0) + 1)
      }
    }
  }
  let extendBest = null
  let extendScore = 0
  for (const [x, y] of empty) {
    if (!isLegal(board, x, y, color, width, height)) continue
    const adj = adjacency.get(`${x},${y}`) ?? 0
    if (adj > extendScore) {
      extendScore = adj
      extendBest = { x, y }
    }
  }
  if (extendBest) return extendBest

  const cx = Math.floor(width / 2)
  const cy = Math.floor(height / 2)
  empty.sort(
    (a, b) =>
      Math.abs(a[0] - cx) + Math.abs(a[1] - cy) - (Math.abs(b[0] - cx) + Math.abs(b[1] - cy)),
  )
  for (const [x, y] of empty) {
    if (isLegal(board, x, y, color, width, height)) return { x, y }
  }
  return null
}

// ---------------------------------------------------------------- 对局状态机

/**
 * 一局棋的可变状态：棋盘 + 双方提子 + 劫判定所需的上一局面。
 * history 由调用方持有（duel.json），这里只管「当前局面推演」。
 */
export function createGameState(width, height, playerColor, aiColor) {
  return {
    width,
    height,
    playerColor,
    aiColor,
    board: Array.from({ length: height }, () => Array(width).fill(0)),
    playerCaptures: 0,
    aiCaptures: 0,
    moveCount: 0,
    consecutivePasses: 0,
    lastMover: 0, // 上一手谁下的（0=还没下；1/2）——防 AI 连走
    // 简单劫：P(n) 不得回到 P(n-2)。boardTwoAgo 存的就是 P(n-2)。
    boardTwoAgo: null,
    boardKeyTwoAgo: null,
  }
}

/**
 * 在状态上落一子（或 pass）。成功会推进状态并返回 {ok, captured, coord}；
 * 失败返回 {ok:false, error}（占位/自杀/劫/越界/不该你走）。
 */
export function applyMove(state, coord, color) {
  const { width, height, board } = state

  if (state.lastMover === color) {
    const who = color === state.playerColor ? '对手（用户）' : '你'
    return { ok: false, error: `还没轮到你——${who}还没落子` }
  }

  if (coord === 'pass') {
    state.consecutivePasses++
    state.moveCount++
    state.lastMover = color
    // pass 不改棋盘，劫局面关系保持不变
    return { ok: true, captured: 0, coord: 'pass' }
  }

  const pt = parseCoord(coord, width, height)
  if (!pt) return { ok: false, error: `坐标 "${coord}" 不是这棋盘上的点` }
  if (board[pt.y][pt.x] !== 0) return { ok: false, error: `点 ${coord.toUpperCase()} 上已有棋子` }

  const next = simulateMove(board, pt.x, pt.y, color, width, height)
  if (!next) {
    // 区分自杀和占位占位已排除，剩下就是自杀（无提子的填自己的眼）
    return { ok: false, error: `点 ${coord.toUpperCase()} 落子会自杀（落下后这块棋没有气）` }
  }
  if (state.boardKeyTwoAgo && boardKey(next) === state.boardKeyTwoAgo) {
    return { ok: false, error: `点 ${coord.toUpperCase()} 是劫——立即回提要还原上一局面，换个地方找劫材` }
  }

  const opp = color === 1 ? 2 : 1
  const captured = countRemoved(board, next, opp)
  state.boardTwoAgo = board
  state.boardKeyTwoAgo = boardKey(board)
  state.board = next
  if (color === state.playerColor) state.playerCaptures += captured
  else state.aiCaptures += captured
  state.consecutivePasses = 0
  state.moveCount++
  state.lastMover = color
  return { ok: true, captured, coord: coord.toUpperCase() }
}

/** 当前局面文本棋盘（serializeBoard 的快捷方式） */
export function stateBoardText(state) {
  return serializeBoard(state.board, state.width, state.height)
}

// ---------------------------------------------------------------- SGF 导出

const SGF_AXIS = 'abcdefghijklmnopqrstuvwxyz' // SGF 轴与列字母同样跳 I（a..h,j..s）
const sgfX = (x) => SGF_AXIS[x]
const sgfY = (y) => SGF_AXIS[y]

/** 把展示坐标棋谱转成 SGF（存档/复盘用）。moves: ["D4","pass",…] */
export function toSgf(moves, width, height, playerColor, aiColor) {
  const coordOf = (mv) => {
    if (mv === 'pass') return ''
    const pt = parseCoord(mv, width, height)
    if (!pt) return ''
    return sgfX(pt.x) + sgfY(pt.y)
  }
  const playerSgf = playerColor === 1 ? 'B' : 'W'
  const aiSgf = playerColor === 1 ? 'W' : 'B'
  const body = moves.map((mv, i) => `;${i % 2 === 0 ? playerSgf : aiSgf}[${coordOf(mv)}]`).join('')
  return `(;GM[1]FF[4]CA[UTF-8]SZ[${width}:${height}]PB[你]PW[道场 AI]KM[0]${body})`
}
