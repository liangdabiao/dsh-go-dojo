// 面板「AI 对弈」设置：宿主侧持久化，key 只留在本机磁盘，绝不下发浏览器。
//
// 存在 $DSH_HOME/go-dojo/settings.json（无 DSH_HOME 时退回 ~/.dsh），文件权限 0600。
// 优先级：面板里保存的值 > 插件 Config（dsh 设置里填的）> 内置默认。
// 面板只能读回 baseUrl / model / 是否已配置 / 掩码后的 key 尾号，读不到明文 key。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-flash'

const EMPTY = { baseUrl: '', model: '', apiKey: '' }

export function settingsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'go-dojo', 'settings.json')
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 读磁盘上的面板设置（缺失/损坏都当作空，不让坏文件打挂面板）。 */
export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    return {
      baseUrl: clean(raw.baseUrl, 500),
      model: clean(raw.model, 120),
      apiKey: clean(raw.apiKey, 500),
    }
  } catch {
    return { ...EMPTY }
  }
}

/** 原子写（写临时文件再 rename），并收紧权限。 */
export function writeSettings(next) {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
  return next
}

/** 校验并保存面板提交的补丁；返回 { settings } 或 { error }。 */
export function applySettingsPatch(patch) {
  const body = patch && typeof patch === 'object' ? patch : {}
  const current = readSettings()
  const next = { ...current }

  if ('baseUrl' in body) {
    const raw = clean(body.baseUrl, 500)
    if (raw === '') {
      next.baseUrl = ''
    } else {
      let parsed
      try {
        parsed = new URL(raw)
      } catch {
        return { error: 'API 地址不是合法 URL' }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'API 地址只支持 http/https' }
      }
      next.baseUrl = raw.replace(/\/+$/, '')
    }
  }

  if ('model' in body) {
    const raw = clean(body.model, 120)
    if (raw === '') return { error: '模型名不能为空' }
    next.model = raw
  }

  if (body.clearKey === true) next.apiKey = ''
  else if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
    const raw = clean(body.apiKey, 500)
    if (/\s/.test(raw)) return { error: 'API Key 不能包含空格' }
    next.apiKey = raw
  }

  writeSettings(next)
  return { settings: next }
}

/** 掩码：只留前 3 位和后 4 位，够认人、不够冒用。 */
export function maskKey(key) {
  const value = typeof key === 'string' ? key : ''
  if (value.length <= 8) return value ? `${value.slice(0, 2)}****` : ''
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

/** 面板设置 + 插件 Config 合成的实际生效配置。 */
export function effectiveConfig(pluginConfig) {
  const saved = readSettings()
  const cfg = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}
  const pluginKey = typeof cfg.aiApiKey === 'string' ? cfg.aiApiKey : ''
  const pluginBase = typeof cfg.aiBaseUrl === 'string' ? cfg.aiBaseUrl : ''
  const pluginModel = typeof cfg.aiModel === 'string' ? cfg.aiModel : ''

  return {
    aiBaseUrl: saved.baseUrl || pluginBase || DEFAULT_BASE_URL,
    aiModel: saved.model || pluginModel || DEFAULT_MODEL,
    aiApiKey: saved.apiKey || pluginKey,
    baseUrlSource: saved.baseUrl ? 'panel' : pluginBase ? 'plugin' : 'default',
    modelSource: saved.model ? 'panel' : pluginModel ? 'plugin' : 'default',
    keySource: saved.apiKey ? 'panel' : pluginKey ? 'plugin' : 'none',
  }
}

/** 给浏览器的安全视图：没有明文 key。 */
export function publicSettings(pluginConfig) {
  const eff = effectiveConfig(pluginConfig)
  return {
    baseUrl: eff.aiBaseUrl,
    model: eff.aiModel,
    hasKey: eff.aiApiKey !== '',
    keyHint: maskKey(eff.aiApiKey),
    baseUrlSource: eff.baseUrlSource,
    modelSource: eff.modelSource,
    keySource: eff.keySource,
    settingsFile: settingsPath(),
  }
}

/** 测试/调试用：清空面板设置。 */
export function clearSettings() {
  try {
    rmSync(settingsPath(), { force: true })
  } catch {
    // ignore
  }
}

export function settingsFileExists() {
  return existsSync(settingsPath())
}
