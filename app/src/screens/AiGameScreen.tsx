import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createGoban, type GobanRenderer, type GobanRendererConfig } from "goban";
import { TopBar } from "../components/TopBar";
import { Fireworks } from "../components/Fireworks";
import { getNextLevel } from "../game/levels";
import { applyResult, loadSave, totalPoints, totalStars } from "../game/progress";
import { audio } from "../game/audio";
import { parseCoord, xyToCoord } from "../game/ai/boardCodec";
import { renderBoardImage } from "../game/ai/boardImage";
import { findFallbackMove, isLegal } from "../game/ai/goAI";
import { requestAiMove } from "../game/ai/deepseekClient";
import type { AiSettings } from "../game/ai/settingsClient";
import type { GameSave, Level, LevelResult, Locale } from "../game/types";
import "../vendor/goban/Goban.css";

interface AiGameScreenProps {
    level: Level;
    locale?: Locale;
    onBack?: () => void;
    onAdvance?: (nextLevelId: string) => void;
    /** 宿主 AI 配置状态（null = 还在读 / 读不到） */
    aiStatus?: AiSettings | null;
    /** 打开面板设置（未配置时横幅里的「去设置」） */
    onOpenSettings?: () => void;
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

function countColor(board: ReadonlyArray<ReadonlyArray<number>>, color: number): number {
    let n = 0;
    for (const row of board) for (const cell of row) if (cell === color) n++;
    return n;
}

export function AiGameScreen({
    level,
    locale = "zh",
    onBack,
    onAdvance,
    aiStatus = null,
    onOpenSettings,
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
    const [keyHint, setKeyHint] = useState("");

    const containerRef = useRef<HTMLDivElement>(null);
    const gobanRef = useRef<GobanRenderer | null>(null);
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

    const resetGame = useCallback(() => {
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
        setResult(null);
        setThinking(false);
        setCaptures({ player: 0, ai: 0 });
        setKeyHint("");
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
        },
        [level.id],
    );

    const doAiTurn = useCallback(async () => {
        const goban = gobanRef.current;
        const st = stRef.current;
        if (!goban || st.over) return;
        st.turn++;

        const board = goban.engine.board;
        const w = goban.engine.width;
        const h = goban.engine.height;
        const prevBlack = countColor(board, 1);

        // Choose the AI's move: LLM API first, local greedy fallback, then any legal point.
        const candidates: Array<{ x: number; y: number }> = [];

        const req = await requestAiMove({
            imageBase64: renderBoardImage(board, w, h, st.moveHistory[st.moveHistory.length - 1]),
            lastMove: st.moveHistory[st.moveHistory.length - 1],
            width: w,
            height: h,
            aiColor,
            playerColor,
            targetCaptures: target,
            moveHistory: st.moveHistory.slice(-12),
            aiCaptures: st.aiCaptures,
            playerCaptures: st.playerCaptures,
        });
        if (req && "notConfigured" in req && req.notConfigured) {
            setKeyHint(
                locale === "zh"
                    ? "还没配 API Key — 这一手用本地陪练兜底。点上面的「去设置」填好 Key，下一手就会走真实大模型。"
                    : "No API key yet — this move used the local AI. Fill one in “Open settings” and the next move goes to the real model.",
            );
        }
        if (req && "move" in req && req.move !== "pass") {
            const pt = parseCoord(req.move, w, h);
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
        goban.enableStonePlacement();
    }, [aiColor, playerColor, target, maxMoves, endGame, locale]);

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
            st.moveHistory.push(xyToCoord(payload.x, payload.y, h));
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
            setThinking(true);
            void doAiTurn();
        },
        [target, maxMoves, result, endGame, doAiTurn],
    );

    const onHumanPass = useCallback(() => {
        const goban = gobanRef.current;
        const st = stRef.current;
        if (!goban || st.over || result || thinking) return;
        st.turn++;
        st.moveHistory.push("pass");
        st.consecutivePasses++;
        goban.disableStonePlacement();
        setThinking(true);
        void doAiTurn();
    }, [result, thinking, doAiTurn]);

    const onResign = useCallback(() => {
        if (result) return;
        stRef.current.resigned = true;
        endGame(false);
    }, [result, endGame]);

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
                        ? `大模型 AI 对战 · ${ai.width}×${ai.height}`
                        : `LLM AI Duel · ${ai.width}×${ai.height}`
                }
                totalStars={stars}
                totalPoints={points}
                locale={locale}
                onBack={onBack}
            />

            <p className="instruction">{instruction}</p>

            <div className="ai-scoreboard">
                <span className="ai-score">
                    {locale === "zh" ? "你" : "You"} 🎯 {captures.player}/{target}
                </span>
                <span className="ai-vs">VS</span>
                <span className="ai-score">
                    AI 🎯 {captures.ai}/{target}
                </span>
            </div>

            {/* AI 配置状态：未配置 = 明确告诉玩家「现在是本地陪练」并可一键去设置 */}
            {aiStatus && !aiStatus.hasKey && (
                <div className="ai-status is-warn" role="status">
                    <span className="ai-status-dot" aria-hidden="true" />
                    <span className="ai-status-text">
                        {locale === "zh"
                            ? "AI 未配置 · 这局由本地陪练执子（不是大模型）"
                            : "AI not configured · the local AI plays this game, not the LLM"}
                    </span>
                    {onOpenSettings && (
                        <button className="ghost-btn ai-status-btn" onClick={onOpenSettings}>
                            {locale === "zh" ? "去设置" : "Open settings"}
                        </button>
                    )}
                </div>
            )}
            {aiStatus?.hasKey && (
                <div className="ai-status is-ok" role="status">
                    <span className="ai-status-dot" aria-hidden="true" />
                    <span className="ai-status-text">
                        {locale === "zh"
                            ? `AI 已就绪 · ${aiStatus.model}`
                            : `AI ready · ${aiStatus.model}`}
                    </span>
                    {onOpenSettings && (
                        <button className="ghost-btn ai-status-btn" onClick={onOpenSettings}>
                            {locale === "zh" ? "调整" : "Change"}
                        </button>
                    )}
                </div>
            )}

            <div ref={containerRef} className="go-game-board" />

            {thinking && (
                <div className="ai-thinking">
                    <span className="ai-thinking-dot" />
                    {locale === "zh" ? "AI 思考中…" : "AI is thinking…"}
                </div>
            )}

            {keyHint && !result && (
                <div className="ai-key-hint">{keyHint}</div>
            )}

            <div className="actions">
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
