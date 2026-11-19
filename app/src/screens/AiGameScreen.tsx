import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createGoban, type GobanRenderer, type GobanRendererConfig } from "goban";
import { TopBar } from "../components/TopBar";
import { Fireworks } from "../components/Fireworks";
import { getNextLevel } from "../game/levels";
import { applyResult, loadSave, totalPoints, totalStars } from "../game/progress";
import { audio } from "../game/audio";
import { parseCoord, xyToCoord } from "../game/ai/boardCodec";
import { findFallbackMove, isLegal } from "../game/ai/goAI";
import {
    createDuel,
    fetchDuel,
    postPlayerMove,
    requestTurnPrompt,
    resignOnServer,
    sendToAgent,
    type DuelState,
} from "../game/ai/agentClient";
import type { GameSave, Level, LevelResult, Locale } from "../game/types";
import "../vendor/goban/Goban.css";

interface AiGameScreenProps {
    level: Level;
    locale?: Locale;
    onBack?: () => void;
    onAdvance?: (nextLevelId: string) => void;
}

interface GameRef {
    playerCaptures: number;
    aiCaptures: number;
    blackCount: number;
    whiteCount: number;
    moveHistory: string[]; // pretty coords ("C4") and "pass", newest last
    consecutivePasses: number;
    turn: number; // total moves made (placements + passes), both players
    over: boolean;
    resigned: boolean;
}

type DuelMode = "agent" | "local";

const MODE_KEY = "go-game:duel-mode";
const POLL_INTERVAL_MS = 1200;
const POLL_TIMEOUT_MS = 180_000;

function countColor(board: ReadonlyArray<ReadonlyArray<number>>, color: number): number {
    let n = 0;
    for (const row of board) for (const cell of row) if (cell === color) n++;
    return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadMode(): DuelMode {
    try {
        return localStorage.getItem(MODE_KEY) === "local" ? "local" : "agent";
    } catch {
        return "agent";
    }
}

export function AiGameScreen({
    level,
    locale = "zh",
    onBack,
    onAdvance,
}: AiGameScreenProps): React.ReactElement {
    const ai = level.aiGame!;
    const t = useMemo(() => level.title[locale] ?? level.title.zh, [level, locale]);
    const instruction = useMemo(
        () => level.instruction[locale] ?? level.instruction.zh,
        [level, locale],
    );
    const playerColor = ai.playerColor === "black" ? 1 : 2;
    const aiColor = ai.aiColor === "black" ? 1 : 2;
    const target = ai.targetCaptures;
    const maxMoves = ai.maxMoves;

    const [save, setSave] = useState<GameSave>(() => loadSave());
    const [result, setResult] = useState<LevelResult | null>(null);
    const [thinking, setThinking] = useState(false);
    const [displayWidth, setDisplayWidth] = useState(0);
    const [resetKey, setResetKey] = useState(0);
    const [captures, setCaptures] = useState({ player: 0, ai: 0 });
    const [mode, setMode] = useState<DuelMode>(() => loadMode());
    const [aiComment, setAiComment] = useState("");
    const [hint, setHint] = useState("");

    const containerRef = useRef<HTMLDivElement>(null);
    const gobanRef = useRef<GobanRenderer | null>(null);
    const duelIdRef = useRef<string | null>(null);
    const turnGenRef = useRef(0); // 轮询代次：重试/重置/卸载时 +1，旧轮询自动作废
    const stRef = useRef<GameRef>({
        playerCaptures: 0,
        aiCaptures: 0,
        blackCount: 0,
        whiteCount: 0,
        moveHistory: [],
        consecutivePasses: 0,
        turn: 0,
        over: false,
        resigned: false,
    });

    // agent 模式进关即建局（服务端对局存档）；失败静默降级为本地兜底
    useEffect(() => {
        if (mode !== "agent") {
            duelIdRef.current = null;
            return;
        }
        let alive = true;
        void createDuel({
            levelId: level.id,
            title: level.title.zh ?? "对弈",
            width: ai.width,
            height: ai.height,
            targetCaptures: ai.targetCaptures,
            maxMoves: ai.maxMoves,
        }).then((id) => {
            if (alive) duelIdRef.current = id;
        });
        return () => {
            alive = false;
        };
    }, [level.id, ai.width, ai.height, ai.targetCaptures, ai.maxMoves, mode, resetKey]);

    useEffect(() => {
        return () => {
            turnGenRef.current++; // 卸载：作废在途轮询
        };
    }, []);

    const resetGame = useCallback(() => {
        turnGenRef.current++;
        stRef.current = {
            playerCaptures: 0,
            aiCaptures: 0,
            blackCount: 0,
            whiteCount: 0,
            moveHistory: [],
            consecutivePasses: 0,
            turn: 0,
            over: false,
            resigned: false,
        };
        duelIdRef.current = null; // 建局 effect 会随 resetKey 重建
        setResult(null);
        setThinking(false);
        setCaptures({ player: 0, ai: 0 });
        setAiComment("");
        setHint("");
        setResetKey((k) => k + 1);
    }, []);

    useEffect(() => {
        resetGame();
    }, [level.id, resetGame]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setDisplayWidth(el.clientWidth);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const progress = save.progress[level.id];
    const stars = totalStars(save);
    const points = totalPoints(save);
    const nextLevel = getNextLevel(level.id);

    const endGame = useCallback(
        (passed: boolean) => {
            const st = stRef.current;
            st.over = true;
            turnGenRef.current++;
            const r: LevelResult = {
                levelId: level.id,
                passed,
                stars: passed ? 3 : 0,
                wrongAttempts: 0,
                points: passed ? 300 : 0,
            };
            setResult(r);
            setSave((s) => applyResult(s, r));
            audio.play(passed ? "complete" : "wrong");
            gobanRef.current?.disableStonePlacement();
            setThinking(false);
            setHint("");
        },
        [level.id],
    );

    // ---------------------------------------------------------------- AI 落子（agent 与本地陪练共用 goban 应用逻辑）
    // moveStr：agent 给的坐标（"C4"/"pass"），null = 本地贪心兜底/陪练
    const applyAiMove = useCallback(
        (moveStr: string | null) => {
            const goban = gobanRef.current;
            const st = stRef.current;
            if (!goban || st.over) return;

            const board = goban.engine.board;
            const w = goban.engine.width;
            const h = goban.engine.height;
            const prevBlack = countColor(board, 1);

            const candidates: Array<{ x: number; y: number }> = [];
            if (moveStr && moveStr !== "pass") {
                const pt = parseCoord(moveStr, w, h);
                if (pt && isLegal(board, pt.x, pt.y, aiColor, w, h)) {
                    candidates.push(pt);
                }
            }
            const fb = findFallbackMove(board, w, h, aiColor);
            if (fb) candidates.push(fb);

            // The goban engine only advances turns via engine.place(); a screen-level
            // Pass leaves it on the player's color, so force the AI color before placing.
            const engine = goban.engine;
            engine.player = aiColor;
            let placed: { x: number; y: number } | null = null;
            for (const c of candidates) {
                try {
                    engine.place(c.x, c.y, true, false, true, false, false);
                    placed = c;
                    break;
                } catch {
                    // ko / self-capture edge the pure rules missed — try next
                }
            }
            if (!placed) {
                // Last resort: any empty point the engine accepts.
                outer: for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (engine.board[y][x] !== 0) continue;
                        try {
                            engine.place(x, y, true, false, true, false, false);
                            placed = { x, y };
                            break outer;
                        } catch {
                            // keep scanning
                        }
                    }
                }
            }
            if (!placed) {
                // AI passes this turn; restore the player's turn for the next move.
                engine.player = playerColor;
            }

            if (placed) {
                goban.emit("update");
                const curBlack = countColor(goban.engine.board, 1);
                st.aiCaptures += Math.max(0, prevBlack - curBlack);
                st.moveHistory.push(xyToCoord(placed.x, placed.y, h));
                st.consecutivePasses = 0;
                setCaptures({ player: st.playerCaptures, ai: st.aiCaptures });
                audio.play(curBlack < prevBlack ? "capture" : "place");
            } else {
                st.moveHistory.push("pass");
                st.consecutivePasses++;
            }

            st.blackCount = countColor(goban.engine.board, 1);
            st.whiteCount = countColor(goban.engine.board, 2);

            if (st.aiCaptures >= target || st.turn >= maxMoves || st.consecutivePasses >= 2) {
                endGame(false);
                return;
            }

            setThinking(false);
            setHint("");
            goban.enableStonePlacement();
        },
        [aiColor, playerColor, target, maxMoves, endGame],
    );

    // agent 模式：把指令填进对话草稿，轮询等服务端写回新棋谱
    const doAgentTurn = useCallback(async () => {
        const st = stRef.current;
        if (st.over) return;
        st.turn++;
        const gen = ++turnGenRef.current;
        setThinking(true);
        setHint(
            locale === "zh"
                ? "正在把对局指令填进对话…"
                : "Filling the duel prompt into the chat…",
        );

        const duelId = duelIdRef.current;
        if (!duelId) {
            // 建局失败 → 本地兜底
            applyAiMove(null);
            return;
        }

        const tp = await requestTurnPrompt(duelId);
        if (gen !== turnGenRef.current || st.over) return;
        if (!tp) {
            applyAiMove(null);
            return;
        }

        const channel = sendToAgent(tp.prompt);
        setHint(
            channel === "posted"
                ? locale === "zh"
                    ? "指令已填进新对话草稿——切到对话按 Enter 发送，AI 下完这里会自动更新"
                    : "Prompt drafted in a new chat — press Enter there; the board updates once the AI moves"
                : channel === "copied"
                    ? locale === "zh"
                        ? "指令已复制到剪贴板——粘贴到对话发送即可"
                        : "Prompt copied — paste it into the chat"
                    : locale === "zh"
                        ? "无法送达对话——请手动复制指令"
                        : "Could not reach the chat — copy the prompt manually",
        );

        // 轮询：history 变长（AI 已落子）或对局状态变化
        const lastLen = tp.duel.history.length;
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let duel: DuelState | null = null;
        while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            if (gen !== turnGenRef.current || st.over) return;
            duel = await fetchDuel(duelId);
            if (duel && (duel.history.length > lastLen || duel.status !== "playing")) break;
            duel = null;
        }

        if (gen !== turnGenRef.current || st.over) return;
        if (duel && duel.lastAiMove) {
            if (duel.lastComment) setAiComment(duel.lastComment);
            applyAiMove(duel.lastAiMove);
        } else {
            setHint(
                locale === "zh"
                    ? "等 AI 有点久了——确认草稿已发送，或重试 / 让陪练接管一手"
                    : "The AI is slow — check the draft was sent, retry, or let the sparring AI move",
            );
            setThinking(false);
            gobanRef.current?.enableStonePlacement();
        }
    }, [locale, applyAiMove]);

    // 陪练模式：本地贪心，瞬时落子
    const doLocalAiTurn = useCallback(() => {
        const st = stRef.current;
        if (st.over) return;
        st.turn++;
        setThinking(true);
        setTimeout(() => applyAiMove(null), 180);
    }, [applyAiMove]);

    const onHumanMove = useCallback(
        (payload: { x: number; y: number; width: number; height: number }) => {
            const goban = gobanRef.current;
            const st = stRef.current;
            if (!goban || st.over || result) return;
            st.turn++;

            const h = payload.height;
            const prevWhite = st.whiteCount;
            const curWhite = countColor(goban.engine.board, 2);
            st.playerCaptures += Math.max(0, prevWhite - curWhite);
            st.blackCount = countColor(goban.engine.board, 1);
            st.whiteCount = curWhite;
            st.consecutivePasses = 0;
            const coord = xyToCoord(payload.x, payload.y, h);
            st.moveHistory.push(coord);
            setCaptures({ player: st.playerCaptures, ai: st.aiCaptures });
            audio.play(curWhite < prevWhite ? "capture" : "place");

            if (st.playerCaptures >= target) {
                endGame(true);
                return;
            }
            if (st.turn >= maxMoves) {
                endGame(false);
                return;
            }

            goban.disableStonePlacement();
            if (mode === "agent") {
                setThinking(true);
                void (async () => {
                    // 先上报玩家这手（服务端对账），再发起 AI 回合
                    if (duelIdRef.current) await postPlayerMove(duelIdRef.current, coord);
                    await doAgentTurn();
                })();
            } else {
                doLocalAiTurn();
            }
        },
        [target, maxMoves, result, endGame, mode, doAgentTurn, doLocalAiTurn],
    );

    const onHumanPass = useCallback(() => {
        const goban = gobanRef.current;
        const st = stRef.current;
        if (!goban || st.over || result || thinking) return;
        st.turn++;
        st.moveHistory.push("pass");
        st.consecutivePasses++;
        goban.disableStonePlacement();
        if (st.turn >= maxMoves || st.consecutivePasses >= 2) {
            endGame(false);
            return;
        }
        if (mode === "agent") {
            setThinking(true);
            void (async () => {
                if (duelIdRef.current) await postPlayerMove(duelIdRef.current, "pass");
                await doAgentTurn();
            })();
        } else {
            doLocalAiTurn();
        }
    }, [result, thinking, mode, maxMoves, endGame, doAgentTurn, doLocalAiTurn]);

    const onResign = useCallback(() => {
        if (result) return;
        stRef.current.resigned = true;
        if (mode === "agent" && duelIdRef.current) void resignOnServer(duelIdRef.current);
        endGame(false);
    }, [result, mode, endGame]);

    const switchMode = useCallback(
        (next: DuelMode) => {
            if (next === mode || thinking) return;
            try {
                localStorage.setItem(MODE_KEY, next);
            } catch {
                // ignore
            }
            setMode(next);
            resetGame();
        },
        [mode, thinking, resetGame],
    );

    const retryAsk = useCallback(() => {
        const st = stRef.current;
        if (st.over) return;
        setThinking(true);
        void doAgentTurn();
    }, [doAgentTurn]);

    const sparringMove = useCallback(() => {
        const st = stRef.current;
        if (st.over) return;
        setThinking(true);
        setTimeout(() => applyAiMove(null), 180);
    }, [applyAiMove]);

    // Rebuild the goban on reset / resize; replay placed moves to preserve state.
    useEffect(() => {
        if (!containerRef.current || displayWidth === 0) return;
        const w = ai.width;
        const h = ai.height;

        const config: GobanRendererConfig = {
            board_div: containerRef.current,
            width: w,
            height: h,
            interactive: true,
            mode: "puzzle",
            initial_player: "black",
            initial_state: { black: "", white: "" },
            move_tree: { x: -1, y: -1, branches: [] },
            display_width: displayWidth,
            square_size: "auto",
            puzzle_player_move_mode: "free",
            puzzle_opponent_move_mode: "manual",
            getPuzzlePlacementSetting: () => ({ mode: "place" as const, color: 0 as const }),
            player_id: 0,
        } as GobanRendererConfig;

        const goban = createGoban(config);
        gobanRef.current = goban;

        const st = stRef.current;
        for (const mv of st.moveHistory) {
            if (mv === "pass") continue;
            const pt = parseCoord(mv, w, h);
            if (!pt) continue;
            try {
                goban.engine.place(pt.x, pt.y, true, false, true, false, false);
            } catch {
                // ignore replay edge cases
            }
        }
        st.blackCount = countColor(goban.engine.board, 1);
        st.whiteCount = countColor(goban.engine.board, 2);

        goban.on("puzzle-place", onHumanMove);
        if (st.over || result) goban.disableStonePlacement();
        else goban.enableStonePlacement();

        return () => {
            goban.off("puzzle-place", onHumanMove);
            goban.destroy();
            if (gobanRef.current === goban) gobanRef.current = null;
        };
    }, [ai, displayWidth, resetKey, onHumanMove, result]);

    const handleReset = useCallback(() => {
        resetGame();
    }, [resetGame]);

    const advanceAfterFireworks = useCallback(() => {
        if (nextLevel) onAdvance?.(nextLevel.id);
        else onBack?.();
    }, [nextLevel, onAdvance, onBack]);

    return (
        <div className="level-screen">
            <TopBar
                title={t}
                subtitle={
                    locale === "zh"
                        ? `dsh AI 对战 · ${ai.width}×${ai.height}`
                        : `dsh AI Duel · ${ai.width}×${ai.height}`
                }
                totalStars={stars}
                totalPoints={points}
                locale={locale}
                onBack={onBack}
            />

            <p className="instruction">{instruction}</p>

            <div className="ai-mode-switch">
                <button
                    className={`mode-btn ${mode === "agent" ? "active" : ""}`}
                    onClick={() => switchMode("agent")}
                    disabled={thinking}
                    title={locale === "zh" ? "dsh 对话里的 AI 亲自执子，逐手讲解" : "The in-chat dsh AI plays with per-move commentary"}
                >
                    {locale === "zh" ? "🤖 dsh AI 对弈" : "🤖 dsh AI"}
                </button>
                <button
                    className={`mode-btn ${mode === "local" ? "active" : ""}`}
                    onClick={() => switchMode("local")}
                    disabled={thinking}
                    title={locale === "zh" ? "离线陪练（本地算法），无需对话" : "Offline sparring (local AI), no chat needed"}
                >
                    {locale === "zh" ? "🧩 离线陪练" : "🧩 Offline"}
                </button>
            </div>

            <div className="ai-scoreboard">
                <span className="ai-score">
                    {locale === "zh" ? "你" : "You"} 🎯 {captures.player}/{target}
                </span>
                <span className="ai-vs">VS</span>
                <span className="ai-score">
                    AI 🎯 {captures.ai}/{target}
                </span>
            </div>

            <div ref={containerRef} className="go-game-board" />

            {aiComment && mode === "agent" && (
                <div className="ai-comment">
                    <span className="ai-comment-label">AI</span>
                    {aiComment}
                </div>
            )}

            {(thinking || hint) && mode === "agent" && (
                <div className="ai-thinking">
                    {thinking && <span className="ai-thinking-dot" />}
                    <span className="ai-hint-text">{hint || (locale === "zh" ? "AI 思考中…" : "AI is thinking…")}</span>
                </div>
            )}

            <div className="actions">
                {!result && mode === "agent" && !thinking && hint && (
                    <>
                        <button className="ghost-btn" onClick={retryAsk}>
                            {locale === "zh" ? "↻ 再填一次指令" : "↻ Re-draft prompt"}
                        </button>
                        <button className="ghost-btn" onClick={sparringMove}>
                            {locale === "zh" ? "🧩 陪练代下一手" : "🧩 Sparring move"}
                        </button>
                    </>
                )}
                {!result && (
                    <>
                        <button className="ghost-btn" onClick={onHumanPass} disabled={thinking}>
                            {locale === "zh" ? "停一手 (Pass)" : "Pass"}
                        </button>
                        <button className="ghost-btn" onClick={onResign} disabled={thinking}>
                            {locale === "zh" ? "认输" : "Resign"}
                        </button>
                    </>
                )}
                {progress?.status === "completed" && !result && (
                    <span className="best-record">
                        {locale === "zh"
                            ? `已通关 · 最佳 ${progress.bestStars}⭐`
                            : `Done · Best ${progress.bestStars}⭐`}
                    </span>
                )}
            </div>

            {result && result.passed && (
                <Fireworks points={result.points} onDone={advanceAfterFireworks} />
            )}
            {result && !result.passed && (
                <div className="result-overlay">
                    <div className="result-card">
                        <div className="result-title">{locale === "zh" ? "挑战失败" : "Defeat"}</div>
                        <div className="result-points">
                            {stRef.current.resigned
                                ? locale === "zh"
                                    ? "你认输了"
                                    : "You resigned"
                                : stRef.current.aiCaptures >= target
                                    ? locale === "zh"
                                        ? "AI 先提够了棋子"
                                        : "The AI captured first"
                                    : locale === "zh"
                                        ? "步数用尽 / 双方停手"
                                        : "Moves exhausted / both passed"}
                        </div>
                        <div className="result-actions">
                            <button className="ghost-btn" onClick={handleReset}>
                                {locale === "zh" ? "↻ 重试" : "↻ Retry"}
                            </button>
                            <button className="primary-btn" onClick={onBack}>
                                {locale === "zh" ? "返回" : "Back"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
