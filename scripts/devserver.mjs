// 本地开发服务器：把 lib/api.js 的真实前缀路由挂到裸 http server 上。
// 用法：node scripts/devserver.mjs [端口]（默认 5190）
//   http://localhost:5190/go-dojo/      面板 SPA + 对局 API
// 静态产物来自 app/dist（先 npm run app:build）。DSH_HOME 可注入隔离存档目录。
import { createServer } from 'node:http'
import { registerApi } from '../lib/api.js'

const PORT = Number(process.argv[2]) || 5190
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }, {})
const handler = routes['/go-dojo']

createServer((req, res) => {
  const url = req.url || '/'
  if (url === '/' || url === '/go-dojo') {
    res.writeHead(302, { location: '/go-dojo/' })
    return res.end()
  }
  if (url.startsWith('/go-dojo')) return handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
}).listen(PORT, () => {
  console.log(`[go-dojo dev] http://localhost:${PORT}/go-dojo/  (DSH_HOME=${process.env.DSH_HOME || '~/.dsh'})`)
})
