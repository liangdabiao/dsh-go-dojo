import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { requestAiMove } from '../lib/ai-move.js'

const W = 7, H = 7
const emptyBoard = () => Array.from({ length: H }, () => Array(W).fill(0))
const baseBody = () => ({
  boardText: '  A B C D E F G\n 7 . . . . . . .\n 6 . . . . . . .\n 5 . . . . . . .\n 4 . . . . . . .\n 3 . . . . . . .\n 2 . . . . . . .\n 1 . . . . . . .',
  width: W, height: H, aiColor: 2, playerColor: 1, targetCaptures: 3,
  moveHistory: [], aiCaptures: 0, playerCaptures: 0,
})

/** 起一个 OpenAI 兼容 mock：按 replyFactory(body) 返回 content */
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

test('mock 上游：正常回落子坐标', async () => {
  await withMockUpstream(() => '{"move":"C4"}', async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'sk-test', aiModel: 'mock-model' })
    assert.equal(r.move, 'C4')
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

test('pass 回复原样放行', async () => {
  await withMockUpstream(() => '{"move":"pass"}', async (base) => {
    const r = await requestAiMove(baseBody(), { aiBaseUrl: base, aiApiKey: 'k', aiModel: 'm' })
    assert.equal(r.move, 'pass')
  })
})

test('请求体带 lastError 会进提示词；key 透传 Bearer', async () => {
  await withMockUpstream((body, auth) => {
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
