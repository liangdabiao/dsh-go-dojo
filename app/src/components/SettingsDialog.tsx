import { useCallback, useEffect, useState } from "react";
import { resetSave } from "../game/progress";
import {
    loadLocale,
    saveLocale,
    loadSoundEnabled,
    saveSoundEnabled,
    loadBgmEnabled,
    saveBgmEnabled,
} from "../game/preferences";
import {
    loadAiSettings,
    saveAiSettings,
    testAiConnection,
    type AiSettings,
} from "../game/ai/settingsClient";
import type { Locale } from "../game/types";

interface SettingsDialogProps {
    locale: Locale;
    onLocaleChange: (locale: Locale) => void;
    onClose: () => void;
    onReset: () => void;
    /** AI 设置保存成功后通知外层（AI 对弈界面据此刷新状态） */
    onAiSaved?: (settings: AiSettings) => void;
}

type Busy = "idle" | "saving" | "testing";

export function SettingsDialog({
    locale,
    onLocaleChange,
    onClose,
    onReset,
    onAiSaved,
}: SettingsDialogProps): React.ReactElement {
    const [currentLocale, setCurrentLocale] = useState<Locale>(locale);
    const [sound, setSound] = useState<boolean>(loadSoundEnabled());
    const [bgmOn, setBgmOn] = useState<boolean>(loadBgmEnabled());
    const [confirmReset, setConfirmReset] = useState(false);

    // ---- AI 对弈配置
    const [ai, setAi] = useState<AiSettings | null>(null);
    const [aiLoaded, setAiLoaded] = useState(false);
    const [baseUrl, setBaseUrl] = useState("");
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState<Busy>("idle");
    const [aiMsg, setAiMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

    const zh = currentLocale === "zh";

    useEffect(() => {
        let alive = true;
        void loadAiSettings().then((s) => {
            if (!alive) return;
            setAiLoaded(true);
            if (!s) {
                setAiMsg({ tone: "err", text: zh ? "读取插件设置失败（宿主接口不可用）" : "Could not read plugin settings" });
                return;
            }
            setAi(s);
            setBaseUrl(s.baseUrl);
            setModel(s.model);
        });
        return () => {
            alive = false;
        };
        // 只在打开对话框时读一次；切换语言不需要重读
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const pickLocale = (l: Locale) => {
        setCurrentLocale(l);
        saveLocale(l);
        onLocaleChange(l);
    };

    const toggleSound = () => {
        const next = !sound;
        setSound(next);
        saveSoundEnabled(next);
    };

    const toggleBgm = () => {
        const next = !bgmOn;
        setBgmOn(next);
        saveBgmEnabled(next);
    };

    const doReset = () => {
        resetSave();
        onReset();
    };

    const acceptSettings = useCallback(
        (next: AiSettings) => {
            setAi(next);
            setBaseUrl(next.baseUrl);
            setModel(next.model);
            setApiKey("");
            onAiSaved?.(next);
        },
        [onAiSaved],
    );

    const doSaveAi = useCallback(async () => {
        setBusy("saving");
        setAiMsg(null);
        const patch: { baseUrl?: string; model?: string; apiKey?: string } = {
            baseUrl,
            model,
        };
        if (apiKey.trim() !== "") patch.apiKey = apiKey.trim();
        const res = await saveAiSettings(patch);
        setBusy("idle");
        if (res.error || !res.settings) {
            setAiMsg({ tone: "err", text: res.error ?? (zh ? "保存失败" : "Save failed") });
            return;
        }
        acceptSettings(res.settings);
        setAiMsg({
            tone: "ok",
            text: res.settings.hasKey
                ? zh
                    ? `已保存，BOSS 关将走真实大模型（${res.settings.model}）`
                    : `Saved — the boss duel will use ${res.settings.model}`
                : zh
                  ? "已保存，但还没填 API Key：BOSS 关仍是本地陪练"
                  : "Saved, but no API key yet: the boss duel stays on the local AI",
        });
    }, [acceptSettings, apiKey, baseUrl, model, zh]);

    const doTestAi = useCallback(async () => {
        setBusy("testing");
        setAiMsg(null);
        const res = await testAiConnection();
        setBusy("idle");
        if (res.ok) {
            setAiMsg({
                tone: "ok",
                text: zh
                    ? `连接正常 · ${res.model ?? ""} · ${res.ms ?? "?"}ms`
                    : `Connected · ${res.model ?? ""} · ${res.ms ?? "?"}ms`,
            });
            return;
        }
        const reason =
            res.error === "not_configured"
                ? zh
                    ? "还没填 API Key"
                    : "No API key yet"
                : res.error ?? (zh ? "连接失败" : "Connection failed");
        setAiMsg({ tone: "err", text: zh ? `测试失败：${reason}` : `Test failed: ${reason}` });
    }, [zh]);

    const doClearKey = useCallback(async () => {
        setBusy("saving");
        setAiMsg(null);
        const res = await saveAiSettings({ clearKey: true });
        setBusy("idle");
        if (res.error || !res.settings) {
            setAiMsg({ tone: "err", text: res.error ?? (zh ? "清除失败" : "Clear failed") });
            return;
        }
        acceptSettings(res.settings);
        if (res.settings.hasKey) {
            // 面板 Key 清了，但插件 Config 里还有一把：仍然会走大模型，如实说明
            setAiMsg({
                tone: "warn",
                text: zh
                    ? `已清除面板里的 Key，改用插件设置里的 Key（${res.settings.keyHint}）`
                    : `Panel key cleared — now using the key from plugin settings (${res.settings.keyHint})`,
            });
        } else {
            setAiMsg({
                tone: "warn",
                text: zh
                    ? "已清除 API Key，BOSS 关回到本地陪练"
                    : "API key cleared — boss duel falls back to the local AI",
            });
        }
    }, [acceptSettings, zh]);

    const keyStatus = !ai
        ? zh
            ? "读取中…"
            : "Loading…"
        : ai.hasKey
          ? zh
              ? `已配置（${ai.keySource === "panel" ? "面板" : "插件设置"}）· ${ai.keyHint}`
              : `Configured (${ai.keySource === "panel" ? "panel" : "plugin settings"}) · ${ai.keyHint}`
          : zh
            ? "未配置 · BOSS 关使用本地陪练"
            : "Not configured · boss duel uses the local AI";

    return (
        <div className="result-overlay settings-overlay" role="dialog" aria-modal="true" onClick={onClose}>
            <div className="result-card settings-card" onClick={(e) => e.stopPropagation()}>
                <div className="result-title">{zh ? "设置" : "Settings"}</div>

                <div className="settings-row">
                    <span>{zh ? "语言" : "Language"}</span>
                    <div className="settings-segment">
                        <button
                            className={currentLocale === "zh" ? "primary-btn" : "ghost-btn"}
                            onClick={() => pickLocale("zh")}
                        >
                            中文
                        </button>
                        <button
                            className={currentLocale === "en" ? "primary-btn" : "ghost-btn"}
                            onClick={() => pickLocale("en")}
                        >
                            English
                        </button>
                    </div>
                </div>

                <div className="settings-row">
                    <span>{zh ? "音效" : "Sound FX"}</span>
                    <button className={sound ? "primary-btn" : "ghost-btn"} onClick={toggleSound}>
                        {sound ? (zh ? "🔊 开" : "🔊 On") : zh ? "🔇 关" : "🔇 Off"}
                    </button>
                </div>

                <div className="settings-row">
                    <span>{zh ? "背景音乐" : "Music"}</span>
                    <button className={bgmOn ? "primary-btn" : "ghost-btn"} onClick={toggleBgm}>
                        {bgmOn ? (zh ? "🎵 开" : "🎵 On") : zh ? "🎵 关" : "🎵 Off"}
                    </button>
                </div>

                {/* ------------------------------------------------ AI 对弈 */}
                <div className="settings-section">
                    <div className="settings-section-title">
                        {zh ? "AI 对弈（BOSS 关）" : "AI duel (boss levels)"}
                    </div>

                    <div
                        className={`settings-status ${ai?.hasKey ? "is-ok" : "is-warn"}`}
                        role="status"
                    >
                        <span className="settings-dot" aria-hidden="true" />
                        <span>{keyStatus}</span>
                    </div>

                    <label className="settings-field">
                        <span>{zh ? "API 地址" : "API base URL"}</span>
                        <input
                            className="settings-input"
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="https://api.deepseek.com"
                            value={baseUrl}
                            disabled={!aiLoaded || busy !== "idle"}
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                    </label>

                    <label className="settings-field">
                        <span>{zh ? "模型" : "Model"}</span>
                        <input
                            className="settings-input"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="deepseek-flash"
                            value={model}
                            disabled={!aiLoaded || busy !== "idle"}
                            onChange={(e) => setModel(e.target.value)}
                        />
                    </label>

                    <label className="settings-field">
                        <span>{zh ? "API Key" : "API key"}</span>
                        <input
                            className="settings-input"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={
                                ai?.hasKey
                                    ? zh
                                        ? `已保存 ${ai.keyHint}，留空则不变`
                                        : `Saved ${ai.keyHint} — leave blank to keep`
                                    : zh
                                      ? "粘贴你的 API Key（只存在本机）"
                                      : "Paste your API key (stored locally only)"
                            }
                            value={apiKey}
                            disabled={!aiLoaded || busy !== "idle"}
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </label>

                    <div className="settings-ai-actions">
                        <button
                            className="primary-btn"
                            onClick={() => void doSaveAi()}
                            disabled={!aiLoaded || busy !== "idle"}
                        >
                            {busy === "saving" ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
                        </button>
                        <button
                            className="ghost-btn"
                            onClick={() => void doTestAi()}
                            disabled={!aiLoaded || busy !== "idle"}
                        >
                            {busy === "testing" ? (zh ? "测试中…" : "Testing…") : zh ? "测试连接" : "Test"}
                        </button>
                        {ai?.hasKey && (
                            <button
                                className="ghost-btn settings-danger"
                                onClick={() => void doClearKey()}
                                disabled={!aiLoaded || busy !== "idle"}
                            >
                                {zh ? "清除 Key" : "Clear key"}
                            </button>
                        )}
                    </div>

                    {aiMsg && <div className={`settings-ai-msg tone-${aiMsg.tone}`}>{aiMsg.text}</div>}

                    <div className="settings-hint">
                        {zh
                            ? "Key 只在宿主进程里使用，保存到本机 $DSH_HOME/go-dojo/settings.json（0600），不会下发到浏览器。不填也能玩，BOSS 关自动用本地陪练。"
                            : "The key stays in the host process, saved to $DSH_HOME/go-dojo/settings.json (0600); it is never sent to the browser. Without a key the boss duel uses the local AI."}
                    </div>
                </div>

                <div className="settings-row settings-reset-row">
                    {!confirmReset ? (
                        <button className="ghost-btn settings-reset-btn" onClick={() => setConfirmReset(true)}>
                            {zh ? "重置进度" : "Reset progress"}
                        </button>
                    ) : (
                        <div className="settings-confirm">
                            <span className="settings-warn">
                                {zh ? "确定清空所有进度？" : "Clear all progress?"}
                            </span>
                            <div className="settings-segment">
                                <button className="ghost-btn" onClick={() => setConfirmReset(false)}>
                                    {zh ? "取消" : "Cancel"}
                                </button>
                                <button className="primary-btn settings-danger" onClick={doReset}>
                                    {zh ? "清空" : "Reset"}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="result-actions">
                    <button className="primary-btn" onClick={onClose}>
                        {zh ? "完成" : "Done"}
                    </button>
                </div>
            </div>
        </div>
    );
}
