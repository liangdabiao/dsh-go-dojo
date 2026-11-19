// go_dojo 工具：agent 下棋的唯一入口。
// 一个工具 + action 枚举（家族惯例）：ai_move / state / review / save_review / list。
// execute 永不 throw，一律 {ok, summary, data?}。
import {
  listDuels,
  duelStateView,
  recordAiMove,
  saveReview,
} from './duel.js'

export const configRef = { config: {} }

// ---------------------------------------------------------------- 输出契约
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的简短回执' },
      data: { type: 'string', description: '结构化结果的 JSON 字符串（面板/调试用）' },
    },
  },
  render: (_args, value) => [
    { type: 'text', text: value.data ? `${value.summary}\n\n${value.data}` : value.summary },
  ],
}

const result = (ok, summary, data) => (data === undefined ? { ok, summary } : { ok, summary, data })
const fail = (err) => result(false, `❌ ${String((err && err.message) || err)}`)
const toData = (v) => JSON.stringify(v)

function needString(args, key, label) {
  const v = args?.[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少参数 ${key}（${label}）`)
  return v.trim()
}

export const goDojoTool = {
  name: 'go_dojo',
  description:
    '围棋道场：BOSS 对弈的落子与查局工具。面板发起 AI 回合时会给你一条自包含对局指令（棋盘图+棋谱+比分+duelId）——' +
    '**必须调用本工具落子**：action="ai_move"（move=棋盘上合法的空点坐标如 "C4"，或 "pass"；comment=一句话讲解）' +
    '。落子非法（占位/自杀/立即回提劫/没轮到你）会返回原因，**必须看棋盘图换点重调，不许放弃**。' +
    '其它 action：state=看某局现场（棋盘图+SGF）；review=取棋谱（SGF+清单）写复盘前先调；' +
    'save_review=把复盘报告落档（面板对局卡可看）；list=查最近对局。用户在对话里说「看棋/复盘/下棋」时也用它。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['ai_move', 'state', 'review', 'save_review', 'list'],
        description: 'ai_move=落子；state=看现场；review=取棋谱；save_review=存复盘；list=对局列表',
      },
      duelId: { type: 'string', description: '对局 ID（对局指令里有；state/review/save_review 必填）' },
      move: { type: 'string', description: 'ai_move 必填：坐标 "C4"（列字母无 I，行号从下往上）或 "pass"' },
      comment: { type: 'string', description: 'ai_move 必填：一句话讲解这手棋的意图' },
      report: { type: 'string', description: 'save_review 必填：复盘报告正文（Markdown）' },
      limit: { type: 'number', description: 'list 可选：条数（默认 10）' },
    },
  },
  timeoutMs: 15_000,
  output: OUTPUT,
  async execute(args) {
    try {
      switch (args?.action) {
        case 'ai_move': {
          const duelId = needString(args, 'duelId', '对局 ID，见对局指令')
          const move = needString(args, 'move', '"C4" 或 "pass"')
          const comment = needString(args, 'comment', '一句话讲解')
          const r = recordAiMove(duelId, move, comment)
          if (!r.ok) return result(false, `❌ ${r.error}（重调 go_dojo ai_move 换点即可）`)
          const v = duelStateView(duelId)
          return result(
            true,
            r.summary,
            toData({ duelId, move: v.duel.lastAiMove, status: v.duel.status, boardText: v.boardText, sgf: v.sgf }),
          )
        }
        case 'state': {
          const duelId = needString(args, 'duelId', '对局 ID')
          const v = duelStateView(duelId)
          if (!v) return result(false, '❌ 没有这局棋，可用 action=list 查')
          return result(true, `📋 ${v.duel.title}：${v.duel.status}，你 ${v.duel.aiCaptures}/${v.duel.targetCaptures}，对手 ${v.duel.playerCaptures}/${v.duel.targetCaptures}`, toData(v))
        }
        case 'review': {
          const duelId = needString(args, 'duelId', '对局 ID')
          const v = duelStateView(duelId)
          if (!v) return result(false, '❌ 没有这局棋，可用 action=list 查')
          return result(
            true,
            `📜 ${v.duel.title} 共 ${v.duel.history.length} 手，结果 ${v.duel.status}。基于这份棋谱写复盘，然后调 go_dojo save_review 落档。`,
            toData(v),
          )
        }
        case 'save_review': {
          const duelId = needString(args, 'duelId', '对局 ID')
          const report = needString(args, 'report', '复盘报告 Markdown 正文')
          const saved = saveReview(duelId, report)
          return result(true, `💾 复盘已落档：${saved.path}（面板对局卡可看）`, toData(saved))
        }
        case 'list': {
          const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
          return result(true, `🗂 最近 ${listDuels(limit).length} 局`, toData(listDuels(limit)))
        }
        default:
          return result(false, `❌ 未知 action：${args?.action}`)
      }
    } catch (err) {
      return fail(err)
    }
  },
}

export const TOOLS = [goDojoTool]
