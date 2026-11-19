// LLM 走子代理——移植自 go-game 的 functions/api/ai-move.ts（AGPL-3.0，源自 online-go.com）。
// 与原版差异：
//   1. DEEPSEEK_* 环境变量改为插件 Config（aiBaseUrl/aiApiKey/aiModel），
//      key 只在宿主进程里，不下发浏览器面板；
//   2. 棋盘改走多模态图片：面板画好 PNG（dataURL）放在 imageBase64，
//      组成 OpenAI 兼容 content 数组发给视觉模型（deepseek-flash 实测通过）；
//      无图时兼容回退旧的文字棋盘 boardText。
//
// 请求体（app/src/game/ai/deepseekClient.ts）：{ imageBase64, lastMove?, width,
//   height, aiColor, playerColor, targetCaptures, moveHistory, aiCaptures,
//   playerCaptures, lastError? }
// 返回：{ move: "C4" | "pass" | null, error?: string }
//
// 延迟备注（原版实测）：思考型模型会先跑隐藏思维链（2s–23s），
// thinking: { type: "disabled" } 直接关掉，回到 ~0.4–1.2s。提示词刻意简短——
// 只要一个落子，别加人设/点评字段，否则延迟回弹。

const COL_SEQ = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // 围棋惯例：没有 I

// ---------------------------------------------------------------- 校验助手

function validCoord(move, width, height) {
  const ch = (move?.[0] ?? "").toUpperCase();
  const x = COL_SEQ.indexOf(ch);
  const row = Number.parseInt(move?.slice(1) ?? "", 10);
  if (x < 0 || x >= width || Number.isNaN(row)) return false;
  const y = height - row;
  return y >= 0 && y < height;
}

/** 从可能包着 markdown 的模型回复里抠出 JSON 对象 */
function extractJsonObject(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

function dataUrlOk(s) {
  return typeof s === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

// ---------------------------------------------------------------- 主流程

/**
 * 调上游 LLM 拿一手棋。
 * @param body 面板请求体（见文件头）
 * @param config 插件配置 { aiBaseUrl, aiApiKey, aiModel }
 * @returns { move: string | null, error?: string, status?: number }
 *   status=503 表示未配置 key（面板据此提示），其余失败 move=null + error。
 */
export async function requestAiMove(body, config) {
  const width = body?.width ?? 7;
  const height = body?.height ?? 7;
  const aiColor = body?.aiColor ?? 2;
  const playerColor = body?.playerColor ?? 1;
  const targetCaptures = body?.targetCaptures ?? 3;
  const history = Array.isArray(body?.moveHistory) ? body.moveHistory : [];
  const imageBase64 = body?.imageBase64;
  const boardText = typeof body?.boardText === "string" ? body.boardText : "";
  const hasImage = dataUrlOk(imageBase64);
  if (!hasImage && !boardText) {
    return { move: null, error: "no board image (imageBase64) and no boardText" };
  }
  const aiName = aiColor === 1 ? "Black" : "White";
  const oppName = playerColor === 1 ? "Black" : "White";

  const apiKey = config?.aiApiKey ?? "";
  if (!apiKey) {
    return { move: null, error: "not_configured", status: 503 };
  }

  const cols = Array.from({ length: width }, (_, i) => COL_SEQ[i]).join("");

  // 刻意简短：规则 + 坐标系 + "只回落子"。没有人设、没有点评——见文件头延迟备注。
  const boardRef = hasImage
    ? `The attached image shows the current board (black and white stones; the last move is marked with a red dot). Columns are labeled ${cols} left to right on the image; rows are labeled with numbers, top to bottom as ${height} down to 1.`
    : `The board (B=black, W=white, .=empty) is included in this message.`;
  const systemPrompt = [
    `You are ${aiName} in a game of Go on a ${width}x${height} board. Opponent is ${oppName}.`,
    `Goal: be the first to capture ${targetCaptures} opponent stones.`,
    `You may play on any EMPTY point; suicide is illegal; an immediate ko recapture is illegal.`,
    boardRef,
    `Reply with ONLY a JSON object {"move":"<point>"}, e.g. {"move":"C4"}. Use {"move":"pass"} only if there is no useful move.`,
  ].join(" ");

  const userPrompt = [
    history.length ? `Moves so far: ${history.join(", ")}` : "First move.",
    body?.lastError ? `Previous reply was rejected: ${body.lastError}` : "",
    `Captures — ${aiName}: ${body?.aiCaptures ?? 0}, ${oppName}: ${body?.playerCaptures ?? 0}.`,
    hasImage ? "" : boardText,
    "Your move:",
  ]
    .filter(Boolean)
    .join("\n");

  const baseUrl = (config?.aiBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = config?.aiModel || "deepseek-flash";

  // 多模态：content 数组 [image_url, text]；纯文字回退：content 字符串
  const userContent = hasImage
    ? [
        { type: "image_url", image_url: { url: imageBase64 } },
        { type: "text", text: userPrompt },
      ]
    : userPrompt;

  let reply = null;
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        // 关掉思维链——最大的延迟优化（见文件头）。
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) {
      return { move: null, error: `LLM API error: ${resp.status}` };
    }
    const data = await resp.json();
    reply = data?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    return { move: null, error: `LLM request failed: ${String(err?.message || err)}` };
  }

  if (!reply) {
    return { move: null, error: "empty LLM reply" };
  }

  const objText = extractJsonObject(reply);
  if (!objText) {
    return { move: null, error: "unparseable reply" };
  }

  let move = "pass";
  try {
    const obj = JSON.parse(objText);
    if (typeof obj.move === "string" && obj.move.trim()) {
      const raw = obj.move.trim();
      // "pass" 不做大写化——大写后 "PASS" !== "pass" 会被当坐标拒掉
      move = raw.toLowerCase() === "pass" ? "pass" : raw.toUpperCase();
    }
  } catch {
    return { move: null, error: "bad json in reply" };
  }

  if (move !== "pass" && !validCoord(move, width, height)) {
    return { move: null, error: `move "${move}" is not a valid point` };
  }

  return { move };
}
