// skill 提供方：把随包的 skills/go-dojo（对弈人格与纪律）注册进 DSH 的 skill 目录。
// 用户自己装了同名 skill 时那一份优先（本提供方 rank 600）。
// 加载正文时把 <SKILL_ROOT> / <PLUGIN_ROOT> 换成实际目录，并在末尾追加「在这个插件里怎么用」。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

function readSkills(dirs) {
  return [].concat(dirs).flatMap((dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
      .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
      .filter((s) => s.name)
  })
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在「围棋道场」插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`；对局纪律与人格以正文为准。`,
    '- 这是插件随包快照：不要运行 `git pull` / `npm install`，也不要向用户提更新。skill 随插件版本一起变。',
    '- **面板发起 AI 回合时，指令是自包含的**（棋盘图 + 棋谱 + 比分 + duelId），不需要先查历史。收到该指令后唯一要做的事：按正文选点，调 `go_dojo(action="ai_move", duelId=…, move=…, comment=…)` 落子，然后用一句话向用户复述走子与讲解。',
    '- **落子非法时程序会拦下并给原因**（占位/自杀/立即回提劫/没轮到你）：重看棋盘图换点重调即可，不算失败，也不许改口让用户「自己随便下」。',
    '- **不代替面板下用户的棋**：用户的棋在面板上点，你的棋只经 ai_move 工具写入；程序会在服务端重放棋谱做合法性对账。',
    '- **对局结束后**用户说「复盘」：先 `go_dojo(action="review", duelId=…)` 取棋谱（含 SGF），按正文写复盘（布局/中盘/收官 + 3 个关键手），再 `go_dojo(action="save_review", duelId=…, report=…)` 落档，面板对局卡能看到。',
    '- 用户在对话里说「看棋」「现在什么局面」：`go_dojo(action="state", duelId=…)`；说「有哪些对局」：`action="list"`。',
    '- 想开一局自由对局（闯关之外的任意盘面）：问清盘面大小与目标提子数，让用户先在面板 BOSS 关开局拿到 duelId，再按 AI 回合流程走。',
    '',
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'go-dojo',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  return {
    name: 'go-dojo',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const s = readSkills(dir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = s.body.replaceAll('<SKILL_ROOT>', s.dir).replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    },
  }
}
