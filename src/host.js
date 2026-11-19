// 围棋道场 · Host 半边
// 1. 把随包的 skill（skills/go-dojo）注册进 ctx.skills：围棋人格 + go_dojo 用法
// 2. 注册一个工具 go_dojo（lib/tools.js）：ai_move 落子 / state / review / save_review / list
// 3. /go-dojo 面板：闯关 SPA（app/dist）+ 对局 API（lib/api.js）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { registerApi } from '../lib/api.js'
import { createSkillProvider } from '../lib/skills.js'
import { TOOLS, configRef } from '../lib/tools.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL_DIRS = [join(ROOT, 'skills')]

export const name = 'go-dojo'
export const inject = ['webServer', 'skills', 'tools']

export const Config = Schema.object({
  maxDuels: Schema.number().default(100).description('保留最近多少局对弈存档（超出自动清理最旧的）'),
})

export function apply(ctx, config) {
  configRef.config = config ?? {}
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIRS, ROOT)))
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => registerApi(ctx))
}
