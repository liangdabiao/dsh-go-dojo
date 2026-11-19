/**
 * Client for the LLM-backed AI move. POSTs the current board (serialized by
 * boardCodec) to the same-origin plugin route `api/ai-move` — the dsh plugin
 * host proxies the configured OpenAI-compatible API and keeps the key
 * server-side. Any failure (no key configured, network, bad reply) returns
 * null so the caller can fall back to the local greedy AI.
 *
 * 相对路径前缀：面板挂在 /go-dojo/ 下，接口同前缀（不能用根绝对 /api/...）。
 */

const BASE = (() => {
    const p = location.pathname;
    return p.endsWith("/") ? p : p + "/";
})();

export interface AiMoveRequest {
    boardText: string;
    width: number;
    height: number;
    aiColor: number; // 1 = black, 2 = white
    playerColor: number;
    targetCaptures: number;
    moveHistory: string[];
    aiCaptures: number;
    playerCaptures: number;
    /** If set, sent to the LLM as a hint after an illegal reply (one retry). */
    lastError?: string;
}

export interface AiMoveResult {
    /** A point like "C4", or "pass". */
    move: string;
}

/** 503 = 宿主没配 API Key（面板据此给一次性提示），其余错误走兜底。 */
export interface AiMoveFailure {
    notConfigured?: boolean;
    message?: string;
}

export async function requestAiMove(
    req: AiMoveRequest,
): Promise<AiMoveResult | AiMoveFailure | null> {
    try {
        const res = await fetch(`${BASE}api/ai-move`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
        });
        const data = (await res.json().catch(() => ({}))) as {
            move?: unknown;
            error?: unknown;
        };
        if (!res.ok) {
            if (res.status === 503 || data.error === "not_configured") {
                return { notConfigured: true };
            }
            console.warn(`[ai-move] HTTP ${res.status} — AI 不可用，降级为本地陪练`);
            return { message: typeof data.error === "string" ? data.error : undefined };
        }
        if (typeof data.move !== "string" || data.move.length === 0) {
            console.warn("[ai-move] AI 返回了空走子 — 降级为本地陪练");
            return { message: typeof data.error === "string" ? data.error : undefined };
        }
        return { move: data.move };
    } catch (err) {
        // Network offline / no route → caller falls back to local greedy AI.
        console.warn(`[ai-move] 请求失败 — 降级为本地陪练（${String(err)}）`);
        return null;
    }
}
