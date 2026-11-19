import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个测试一个独立的 DSH_HOME：settings.js 在调用时才读环境变量
const HOME = mkdtempSync(join(tmpdir(), 'godojo-settings-'))
process.env.DSH_HOME = HOME

const {
  settingsPath,
  readSettings,
  writeSettings,
  applySettingsPatch,
  maskKey,
  effectiveConfig,
  publicSettings,
  clearSettings,
} = await import('../lib/settings.js')

test('默认路径落在 $DSH_HOME/go-dojo/settings.json', () => {
  assert.equal(settingsPath(), join(HOME, 'go-dojo', 'settings.json'))
})

test('没有文件时读回空值，不抛错', () => {
  clearSettings()
  assert.deepEqual(readSettings(), { baseUrl: '', model: '', apiKey: '' })
})

test('保存 → 回读（含 trim 与末尾斜杠清理）', () => {
  clearSettings()
  const r = applySettingsPatch({ baseUrl: '  https://api.example.com//  ', model: ' deepseek-flash ', apiKey: 'sk-abc123' })
  assert.ok(r.settings)
  const back = readSettings()
  assert.equal(back.baseUrl, 'https://api.example.com')
  assert.equal(back.model, 'deepseek-flash')
  assert.equal(back.apiKey, 'sk-abc123')
})

test('落盘文件权限收紧到 0600（POSIX）', { skip: process.platform === 'win32' }, () => {
  applySettingsPatch({ model: 'm', apiKey: 'sk-perm' })
  const mode = statSync(settingsPath()).mode & 0o777
  assert.equal(mode, 0o600)
})

test('拒绝非 http(s) 地址；空地址表示回退到插件 Config', () => {
  assert.match(applySettingsPatch({ baseUrl: 'ftp://example.com' }).error, /http/)
  assert.match(applySettingsPatch({ baseUrl: 'not a url' }).error, /URL/)
  const cleared = applySettingsPatch({ baseUrl: '' })
  assert.equal(cleared.settings.baseUrl, '')
})

test('模型名不能为空；key 不能带空格', () => {
  assert.match(applySettingsPatch({ model: '   ' }).error, /模型/)
  assert.match(applySettingsPatch({ apiKey: 'sk a b' }).error, /空格/)
})

test('clearKey 只清 key，保留地址和模型', () => {
  clearSettings()
  applySettingsPatch({ baseUrl: 'https://api.example.com', model: 'mm', apiKey: 'sk-1' })
  const r = applySettingsPatch({ clearKey: true })
  assert.equal(r.settings.apiKey, '')
  assert.equal(r.settings.baseUrl, 'https://api.example.com')
  assert.equal(r.settings.model, 'mm')
})

test('掩码只露头尾，不泄露原文', () => {
  assert.equal(maskKey('sk-1234567890ab'), 'sk-…90ab')
  assert.equal(maskKey('short'), 'sh****')
  assert.equal(maskKey(''), '')
})

test('优先级：面板 > 插件 Config > 默认', () => {
  clearSettings()
  const plugin = { aiBaseUrl: 'https://plugin.example', aiModel: 'plugin-model', aiApiKey: 'sk-plugin' }

  let eff = effectiveConfig(plugin)
  assert.equal(eff.aiBaseUrl, 'https://plugin.example')
  assert.equal(eff.aiApiKey, 'sk-plugin')
  assert.equal(eff.keySource, 'plugin')

  applySettingsPatch({ baseUrl: 'https://panel.example', model: 'panel-model', apiKey: 'sk-panel' })
  eff = effectiveConfig(plugin)
  assert.equal(eff.aiBaseUrl, 'https://panel.example')
  assert.equal(eff.aiModel, 'panel-model')
  assert.equal(eff.aiApiKey, 'sk-panel')
  assert.equal(eff.keySource, 'panel')
  assert.equal(eff.baseUrlSource, 'panel')

  clearSettings()
  eff = effectiveConfig({})
  assert.equal(eff.aiBaseUrl, 'https://api.deepseek.com')
  assert.equal(eff.aiModel, 'deepseek-flash')
  assert.equal(eff.aiApiKey, '')
  assert.equal(eff.keySource, 'none')
})

test('publicSettings 不含明文 key', () => {
  clearSettings()
  applySettingsPatch({ apiKey: 'sk-supersecret-9999' })
  const pub = publicSettings({})
  assert.equal(pub.hasKey, true)
  assert.ok(!JSON.stringify(pub).includes('sk-supersecret-9999'))
  assert.equal(pub.keySource, 'panel')
})

test('文件损坏时当作空配置，不抛错', () => {
  writeSettings({ baseUrl: '', model: '', apiKey: '' })
  writeFileSync(settingsPath(), '{ not json', 'utf8')
  assert.deepEqual(readSettings(), { baseUrl: '', model: '', apiKey: '' })
})

test('写入是原子替换，内容合法 JSON', () => {
  clearSettings()
  writeSettings({ baseUrl: 'https://x.example', model: 'm2', apiKey: 'sk-2' })
  const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  assert.equal(parsed.model, 'm2')
  clearSettings()
})
