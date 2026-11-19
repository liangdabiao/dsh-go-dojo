import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { requestAiMove } from '../lib/ai-move.js'

const W = 7, H = 7
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const baseBody = () => ({
  imageBase64: PNG_DATA_URL,
  lastMove: 'D4',
  width: W, height: H, aiColor: 2, playerColor: 1, targetCaptures: 3,
  moveHistory: ['D4'], aiCaptures: 0, playerCaptures: 0,
})

/** 起一个 OpenAI 兼容 mock：replyFactory(req) 返回 content 字符串 */
async function withMockUpstream(replyFactory, fn) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const auth = req.headers.authorization || ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: replyFactory(body, auth) } }],
      }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('未配 key → not_configured（503）', async () => {
  const r = await requestAiMove(baseBody(), { aiBaseUrl: 'http://127.0.0.1:1', aiApiKey: '', aiModel: 'm' })
  assert.equal(r.move, null)
  assert.equal(r.error, 'not_configured')
  assert.equal(r.status, 503)
})

test('图片缺失且无 boardText → 明确报错', async () => {
  const b = baseBody()
  delete b.imageBase64
  const r = await requestAiMove(b, { aiBaseUrl: 'http://127.0.0.1:1', aiApiKey: 'k', aiModel: 'm' })
  assert.equal(r.move, null)
  assert.match(r.error, /no board image/)
})

test('多模态：content 数组含 image_url，dataURL 原样透传，text 不含棋盘字符画', async () => {
  await withMockUpstream((req) => {
    const user = req.messages.find((m) => m.role === 'user')
    assert.ok(Array.isArray(user.content), '有图时 content 应为数组')
    const imgPart = user.content.find((p) => p.type === 'image_url')
    assert.equal(imgPart.image_url.url, PNG_DATA_URL)
    const textPart = user.content.find((p) => p.type === 'text')
    assert.ok(!textPart.text.includes('A B C D'), '文字棋盘字符画应已去掉')
    assert.ok(textPart.text.includes('Moves so far: D4'))
    assert.ok(req.messages[0].content.includes('image'), 'system 应说明附图')
    return '{"move":"C4"}'
  }, async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'sk-test', aiModel: 'deepseek-flash' })
    assert.equal(r.move, 'C4')
  })
})

test('boardText 兼容回退：无图时走纯文字', async () => {
  const b = baseBody()
  delete b.imageBase64
  b.boardText = '  A B C D E F G\n 7 . . . . . . .'
  await withMockUpstream((req) => {
    const user = req.messages.find((m) => m.role === 'user')
    assert.equal(typeof user.content, 'string')
    assert.ok(user.content.includes('A B C D'))
    return '{"move":"E5"}'
  }, async (base) => {
    const r = await requestAiMove(b, { aiBaseUrl: base, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, 'E5')
  })
})

test('回复带 markdown 代码块也能抠出 JSON', async () => {
  await withMockUpstream(() => '好的！```json\n{"move":"E5"}\n```', async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, 'E5')
  })
})

test('越界坐标被拒 → move:null + error', async () => {
  await withMockUpstream(() => '{"move":"Z99"}', async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, null)
    assert.match(r.error, /not a valid point/)
  })
})

test('pass 回复原样放行（不被大写化）', async () => {
  await withMockUpstream(() => '{"move":"pass"}', async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, 'pass')
  })
})

test('key 透传 Bearer；lastError 进提示词', async () => {
  await withMockUpstream((req, auth) => {
    assert.equal(auth, 'Bearer k-secret')
    return JSON.stringify({ move: 'D4' })
  }, async (base) => {
    const body = { ...baseBody(), lastError: 'move "Q9" is not a valid point' }
    const r = await requestAiMove(body, { aiBaseUrl: base, aiApiKey: 'k-secret', aiModel: 'm' })
    assert.equal(r.move, 'D4')
  })
})

test('上游 500 → move:null + error', async () => {
  const server = createServer((req, res) => { res.writeHead(500); res.end('boom') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: `http://127.0.0.1:${port}`, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, null)
    assert.match(r.error, /LLM API error: 500/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
