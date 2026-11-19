/**
 * dsh agent 对弈客户端——替代原 deepseekClient.ts。
 *
 * dsh 插件不能直接调 LLM API：AI 的每手棋由 dsh 会话里的 agent 决定。
 * 流程：
 *   1. 建局：POST api/duel/new（服务端建 duels/<id>.json，返回 duelId）
 *   2. 玩家落子后上报：POST api/duel/move（服务端重放棋谱做合法性对账）
 *   3. AI 回合：POST api/duel/turn-prompt 拿自包含对局指令 → postMessage 给宿主
 *      startSession 填草稿（用户 Enter 发送）→ agent 调 go_dojo 工具落子
 *   4. 面板轮询 GET api/duel 等新棋谱 → goban 应用
 *
 * 相对路径前缀：页面挂在 /go-dojo/ 下，接口同前缀（不能用根绝对 /api/...）。
 */

const BASE = (() => {
  const p = location.pathname
  return p.endsWith("/") ? p : p + "/"
})()

const api = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}api${path}`, init)
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || body.ok === false) {
    throw new Error(String(body.error ?? `请求失败（${res.status}）`))
  }
  return body
}

export interface DuelOptions {
  levelId: string;
  title: string;
  width: number;
  height: number;
  targetCaptures: number;
  maxMoves: number;
}

export interface DuelState {
  id: string;
  levelId: string;
  title: string;
  width: number;
  height: number;
  targetCaptures: number;
  maxMoves: number;
  history: string[];
  playerCaptures: number;
  aiCaptures: number;
  turn: number;
  status: string; // playing | player_win | ai_win | ended | resigned
  lastAiMove: string;
  lastComment: string;
  lastError: string;
}

/** 建一局对弈（agent 模式进 BOSS 关时调一次）。失败返回 null（面板降级陪练模式）。 */
export async function createDuel(opts: DuelOptions): Promise<string | null> {
  try {
    const body = await api("/duel/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    const duel = body.duel as { id?: string } | undefined;
    return String(duel?.id ?? "") || null;
  } catch (err) {
    console.warn("[go-dojo] 建局失败 — 降级为离线陪练", err);
    return null;
  }
}

/** 玩家一手上报（服务端合法性对账）。失败不阻塞本地进行。 */
export async function postPlayerMove(duelId: string, move: string): Promise<DuelState | null> {
  try {
    const body = await api("/duel/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: duelId, move }),
    });
    return (body.duel as DuelState) ?? null;
  } catch (err) {
    console.warn("[go-dojo] 落子上报失败", err);
    return null;
  }
}

export async function fetchDuel(duelId: string): Promise<DuelState | null> {
  try {
    const body = await api(`/duel?id=${encodeURIComponent(duelId)}`);
    return (body.duel as DuelState) ?? null;
  } catch {
    return null;
  }
}

/** 拿 AI 回合的自包含指令（服务端按权威棋盘组装）。 */
export async function requestTurnPrompt(duelId: string): Promise<{ prompt: string; duel: DuelState } | null> {
  try {
    const body = await api("/duel/turn-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: duelId }),
    });
    if (typeof body.prompt !== "string" || !body.prompt) return null;
    return { prompt: body.prompt, duel: body.duel as DuelState };
  } catch (err) {
    console.warn("[go-dojo] 取对局指令失败", err);
    return null;
  }
}

export async function resignOnServer(duelId: string): Promise<void> {
  try {
    await api("/duel/resign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: duelId }),
    });
  } catch {
    // 存档失败不影响本地认输
  }
}

const EMBEDDED = (() => {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
})();

/** 把对局指令递给宿主开新对话草稿（用户按 Enter 发送）。 */
export function sendToAgent(prompt: string): "posted" | "copied" | "failed" {
  if (EMBEDDED) {
    try {
      parent.postMessage({ type: "go-dojo:ask", prompt }, location.origin);
      return "posted";
    } catch {
      // fallthrough 到剪贴板
    }
  }
  try {
    void navigator.clipboard.writeText(prompt);
    return "copied";
  } catch {
    return "failed";
  }
}
