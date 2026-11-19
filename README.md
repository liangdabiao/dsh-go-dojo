# dsh-go-dojo · 围棋道场

> 第 40 个 dsh 插件。3564 关围棋闯关 + BOSS 大模型对弈——**dsh 对话里的 AI 棋手亲自执子**，逐手讲解，局后复盘落档。
> 全量移植自 [go-game](https://github.com/liangdabiao)（源自 [online-go.com](https://online-go.com) LearningHub 的闯关教程），AGPL-3.0。

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-go-dojo
```

## 是什么

侧栏「围棋道场」面板，一个完整的单机围棋闯关游戏 + 一个由 dsh agent 执子的 BOSS 对弈：

- **3564 关 · 8 章节**：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 星耀 → 王者 → **王者荣耀（BOSS）**
- **四种题型**：棋盘操作题、选择题、终局流程题（停一手/数子/完成）、AI 对战
- **三星评分** + 世界地图/章节/关卡三级导航，进度存 localStorage
- **中文优先**（内置英文切换）、Web Audio 合成音效、背景音乐
- **纯本地**：SPA 与对局存档都在本机，断网可玩（除 BOSS agent 对弈）

## BOSS 关：agent 替代 API

原版 go-game 的 BOSS 关走 DeepSeek HTTP API（edge function 代理）。本插件没有 API key、没有 edge function——**AI 的每手棋由 dsh 会话里的 agent 决定**：

```
你点棋盘落子 → 面板把「自包含对局指令」（棋盘图+棋谱+比分+duelId）
             填进新对话草稿 → 你按 Enter 发送
→ agent（go-dojo skill）读棋盘、选点
→ 调 go_dojo(action="ai_move", move="E5", comment="小飞挂角，限制你向右边发展。")
→ 服务端重放棋谱校验合法性（占位/自杀/劫/轮次，非法弹回让 agent 改着）
→ 面板轮询 1.2s 拾取新棋谱 → 白子落盘 + 讲解气泡
```

比原 API 强的地方：**有棋手人格**（陪练心态、说人话的讲解）、**非法自纠**（工具拦下后 agent 同会话换着重下）、**局后复盘**（`go_dojo review/save_review` 取 SGF 棋谱写三段复盘落档，面板可查）、**零配置**（无 key 无额度）。

对弈节奏是一次回合一次按键（dsh 面板只填草稿不自动发送，宿主机制如此），所以 BOSS 目标提子从原版 10/20/30/40 调成 **3/5/8/12**，对局短平快。

**离线陪练**：不想开对话可一键切本地贪心算法陪练（原版兜底 AI），瞬时落子。

## 工具（agent 侧）

`go_dojo` 单工具五动作：

| action | 用途 |
|---|---|
| `ai_move` | 落子（move + comment 必填；非法弹回带原因，agent 改着重调） |
| `state` | 看某局现场（棋盘图 + SGF） |
| `review` | 取棋谱（SGF + 逐手清单），写复盘前调 |
| `save_review` | 复盘报告落档（`$DSH_HOME/go-dojo/duels/<id>-review.md`） |
| `list` | 最近对局列表 |

随包 skill `go-dojo`：围棋人格 + 对弈纪律（必走工具、非法必改、一句讲解、复盘格式）。

## 面板 API（/go-dojo 前缀）

```
POST /api/duel/new          建局          GET  /api/duel?id=    轮询对局
POST /api/duel/move         玩家手上报     GET  /api/duels       对局列表
POST /api/duel/turn-prompt  组装 AI 回合指令
POST /api/duel/resign       认输          GET  /api/duel/review?id=   取复盘
```

玩家手与 agent 手都在服务端重放棋谱做合法性对账，面板与服务端漂移会被拦下。

## 开发

```bash
npm install && npm test && npm run smoke   # 单测 16 + 冒烟 23（离线）
npm run app:install                        # 装面板 SPA 依赖（react/vite）
npm run app:build                          # 构建 app/dist（提交进仓库）
npm run dev                                # 本地起 http://localhost:5190/go-dojo/（真 API + 产物）
```

改了 `app/src` 之后重新 `npm run app:build` 再验收；`app/dist` 是面板的运行产物，随插件发布。

## 结构

```
src/host.js        宿主半边：注册 skill + go_dojo 工具 + /go-dojo 前缀路由
client.js          浏览器半边：侧栏入口 + iframe 面板 + startSession 草稿协议
lib/go-rules.js    围棋规则引擎（移植 goAI/boardCodec + 简单劫 + SGF 导出）
lib/duel.js        对局状态机与存档（$DSH_HOME/go-dojo/duels/）
lib/tools.js       go_dojo 工具（ai_move/state/review/save_review/list）
lib/api.js         面板 HTTP：静态 SPA + 对局 API（宿主 token 鉴权）
lib/skills.js      skill 提供方（rank 600，随包快照 + 插件用法附录）
skills/go-dojo/    AI 棋手人格与对弈纪律
app/               面板 SPA（go-game 移植 + agent 对弈补丁，vite 构建）
```

## 致谢与许可

关卡数据与 goban 棋盘引擎源自 [online-go.com](https://online-go.com)（AGPL-3.0 / Apache-2.0），闯关化改编来自 go-game。本项目延续 **AGPL-3.0**。
