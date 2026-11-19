// 围棋道场 · Host 半边
// /go-dojo 面板：闯关 SPA（app/dist）+ LLM 走子代理（lib/api.js，key 只在宿主侧）。
// AI 对弈走配置的 OpenAI 兼容 API（默认 DeepSeek）；未配 key 时面板降级本地贪心陪练。
import Schema from '@deepseek-ai/schemastery'
import { registerApi, configRef } from '../lib/api.js'

export const name = 'go-dojo'
export const inject = ['webServer']

export const Config = Schema.object({
  aiBaseUrl: Schema.string().default('https://api.deepseek.com').description('LLM API 地址（OpenAI 兼容 chat/completions，需支持视觉多模态）'),
  aiApiKey: Schema.string().default('').role('secret').description('LLM API Key（留空时 BOSS 关 AI 走子降级为本地贪心陪练）'),
  aiModel: Schema.string().default('deepseek-flash').description('模型名（视觉模型，如 deepseek-flash；走棋盘图片多模态）'),
})

export function apply(ctx, config) {
  configRef.config = config ?? {}
  ctx.effect(() => registerApi(ctx))
}
