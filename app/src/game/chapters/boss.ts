/*
 * Chapter 8: 王者荣耀 — 与 dsh agent 对弈的终极 BOSS 关。
 * 手写章节（非脚本生成）：棋盘在本地，AI 走子由 dsh 会话里的 agent 决定
 * （面板把自包含对局指令填进对话草稿，agent 调 go_dojo 工具落子，服务端做合法性对账）。
 * 本地仅做合法性与兜底校验（见 src/game/ai/）；「离线陪练」模式走本地贪心。
 *
 * 目标提子 3/5/8/12：agent 对弈每回合一次按键（草稿→Enter），对局要短平快；
 * 步数上限按 60/120/240/400 放宽但不至于拖沓。
 */
import type { Chapter, Level } from "../types";

export const CHAPTER_ID = "boss";

export const CHAPTER: Chapter = {
    id: "boss",
    title: { zh: "王者荣耀", en: "King of Glory" },
    description: {
        zh: "终极挑战：与 dsh 对话里的 AI 棋手对弈，先提子者为胜（7×7 → 9×9 → 13×13 → 19×19）",
        en: "Final challenge: duel the dsh in-chat AI. First to capture wins (7×7 → 9×9 → 13×13 → 19×19)",
    },
};

interface AiLevelOpts {
    id: string;
    order: number;
    title: { zh: string; en: string };
    instruction: { zh: string; en: string };
    width: number;
    height: number;
    targetCaptures: number;
    maxMoves: number;
}

function aiLevel(opts: AiLevelOpts): Level {
    return {
        id: opts.id,
        chapterId: CHAPTER_ID,
        order: opts.order,
        title: opts.title,
        instruction: opts.instruction,
        kind: "aiGame",
        aiGame: {
            width: opts.width,
            height: opts.height,
            playerColor: "black",
            aiColor: "white",
            targetCaptures: opts.targetCaptures,
            maxMoves: opts.maxMoves,
            komi: 0,
        },
    };
}

const LEVELS: Level[] = [
    aiLevel({
        id: "boss-ai-duel",
        order: 1080,
        title: { zh: "7×7 · 王者对决", en: "7×7 · King's Duel" },
        instruction: {
            zh: "这是最后的荣耀之战。执黑先行，与 dsh 对话里的 AI 棋手在 7×7 棋盘上对弈：先提掉对方 3 颗棋子者获胜。你落子后，把弹出的对局指令发送到对话，AI 会亲自落子并讲解。也可以切换「离线陪练」或使用“停一手”“认输”。",
            en: "The battle for glory. You are Black and play the dsh in-chat AI on a 7×7 board: capture 3 enemy stones first to win. After your move, send the drafted duel prompt in the chat and the AI will reply with commentary. You may also switch to offline sparring, Pass or Resign.",
        },
        width: 7,
        height: 7,
        targetCaptures: 3,
        maxMoves: 60,
    }),
    aiLevel({
        id: "boss-ai-duel-9",
        order: 1081,
        title: { zh: "9×9 · 王座争锋", en: "9×9 · Throne Bout" },
        instruction: {
            zh: "升级到 9×9 的战场。执黑先行，与 dsh AI 对弈：先提掉对方 5 颗棋子者获胜。",
            en: "The battlefield grows to 9×9. You are Black vs the dsh AI: capture 5 enemy stones first to win.",
        },
        width: 9,
        height: 9,
        targetCaptures: 5,
        maxMoves: 120,
    }),
    aiLevel({
        id: "boss-ai-duel-13",
        order: 1082,
        title: { zh: "13×13 · 宗师之战", en: "13×13 · Grandmaster Clash" },
        instruction: {
            zh: "中盘决战。13×13 棋盘上执黑先行，与 dsh AI 对弈：先提掉对方 8 颗棋子者获胜。",
            en: "Mid-board duel on 13×13. You are Black vs the dsh AI: capture 8 enemy stones first to win.",
        },
        width: 13,
        height: 13,
        targetCaptures: 8,
        maxMoves: 240,
    }),
    aiLevel({
        id: "boss-ai-duel-19",
        order: 1083,
        title: { zh: "19×19 · 传奇终局", en: "19×19 · Legendary Finale" },
        instruction: {
            zh: "终极满盘对决。19×19 标准棋盘上执黑先行，与 dsh AI 对弈：先提掉对方 12 颗棋子者获胜。这是王者的加冕。",
            en: "The full-board finale on 19×19. You are Black vs the dsh AI: capture 12 enemy stones first to win. Claim your crown.",
        },
        width: 19,
        height: 19,
        targetCaptures: 12,
        maxMoves: 400,
    }),
];

export { LEVELS };
