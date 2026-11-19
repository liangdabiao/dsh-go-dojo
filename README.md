# dsh-go-dojo · 围棋道场

> 第 40 个 dsh 插件。3564 关围棋闯关 + BOSS 大模型对弈——AI 走子走 **LLM API**（URL/Key/模型可配，key 只在插件宿主侧），未配 key 自动降级本地陪练。
> 全量移植自 [go-game](https://github.com/liangdabiao)（源自 [online-go.com](https://online-go.com) LearningHub 的闯关教程），AGPL-3.0。

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-go-dojo
```

## 是什么

侧栏「围棋道场」面板，一个完整的单机围棋闯关游戏：

- **3564 关 · 8 章节**：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 星耀 → 王者 → **王者荣耀（BOSS）**
- **四种题型**：棋盘操作题、选择题、终局流程题（停一手/数子/完成）、AI 对战
- **三星评分** + 世界地图/章节/关卡三级导航，进度存 localStorage
- **中文优先**（内置英文切换）、Web Audio 合成音效、背景音乐
- **纯本地**：SPA 断网可玩（BOSS 关 AI 走子除外）

## BOSS 关：LLM API 走子

原版 go-game 的架构原样回归——面板把棋盘（ASCII 图 + 棋谱 + 提子数）POST 到插件宿主的 `/go-dojo/api/ai-move`，宿主代理调用你配置的 OpenAI 兼容 API（默认 DeepSeek），**key 只在宿主进程里，不下发浏览器**：

- 落子合法性（越界坐标）在代理层校验；非法回复返回错误，面板降级本地贪心算法
- 未配 Key：AI 走子自动降级为本地陪练算法，面板给一次性提示（仍可正常通关）
- 提示词刻意简短 + `thinking: {type:"disabled"}` 关思维链（原版实测 2s–23s → 0.4–0.8s）

**插件设置**（Config）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `aiBaseUrl` | `https://api.deepseek.com` | OpenAI 兼容 chat/completions 地址 |
| `aiApiKey` | 空（secret） | 留空 = 本地陪练 |
| `aiModel` | `deepseek-chat` | 任意 OpenAI 兼容模型 |

## 面板 API（/go-dojo 前缀）

```
GET  /api/ping           存活检查
POST /api/ai-move        LLM 走子代理（未配 key → 503 not_configured）
GET  /                   闯关 SPA（app/dist 静态资源）
```

## 开发

```bash
npm install && npm test && npm run smoke   # 单测 7 + 冒烟 8（mock 上游，离线）
npm run app:install                        # 装面板 SPA 依赖（react/vite）
npm run app:build                          # 构建 app/dist（提交进仓库）
npm run dev                                # 本地起 http://localhost:5190/go-dojo/（内置 mock 上游）
GO_DOJO_API_KEY=sk-xxx GO_DOJO_MODEL=deepseek-chat npm run dev   # 接真上游调试
```

## 结构

```
src/host.js        宿主半边：Config（API 地址/Key/模型）+ /go-dojo 前缀路由
client.js          浏览器半边：侧栏入口 + iframe 面板 + 主题跟随
lib/ai-move.js     LLM 走子代理（移植原 ai-move.ts；简短提示词 + 关思维链 + 坐标校验）
lib/api.js         面板 HTTP：静态 SPA + ping + ai-move 代理（宿主 token 鉴权）
app/               面板 SPA（go-game 移植，vite 构建，dist 随包）
```

## 致谢与许可

关卡数据与 goban 棋盘引擎源自 [online-go.com](https://online-go.com)（AGPL-3.0 / Apache-2.0），闯关化改编来自 go-game。本项目延续 **AGPL-3.0**。
