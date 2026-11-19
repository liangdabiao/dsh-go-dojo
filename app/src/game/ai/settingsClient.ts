/**
 * 面板「AI 对弈」设置：读/存 API 地址、模型、Key，以及连通性自检。
 *
 * key 由宿主保存到 $DSH_HOME/go-dojo/settings.json（0600），接口只回
 * hasKey + 掩码尾号，浏览器拿不到明文；next 一遍走子时宿主自动读新配置。
 */
import { api, postJson } from "./apiBase";

export interface AiSettings {
    baseUrl: string;
    model: string;
    hasKey: boolean;
    /** 形如 "sk-…a1b2"，仅用于人眼确认，不是可用凭据 */
    keyHint: string;
    keySource: "panel" | "plugin" | "none";
    baseUrlSource: "panel" | "plugin" | "default";
    modelSource: "panel" | "plugin" | "default";
}

export interface AiSettingsPatch {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    clearKey?: boolean;
}

export interface AiTestResult {
    ok: boolean;
    model?: string;
    ms?: number;
    reply?: string;
    error?: string;
}

type SettingsReply = AiSettings & { ok?: boolean; error?: string };

function normalize(data: SettingsReply | null): AiSettings | null {
    if (!data || typeof data.baseUrl !== "string") return null;
    return {
        baseUrl: data.baseUrl,
        model: data.model,
        hasKey: Boolean(data.hasKey),
        keyHint: typeof data.keyHint === "string" ? data.keyHint : "",
        keySource: data.keySource ?? "none",
        baseUrlSource: data.baseUrlSource ?? "default",
        modelSource: data.modelSource ?? "default",
    };
}

/** 读当前生效配置；接口不可用时返回 null（面板照旧按「未配置」处理）。 */
export async function loadAiSettings(): Promise<AiSettings | null> {
    try {
        const res = await api("/settings");
        if (!res.ok) return null;
        return normalize((await res.json()) as SettingsReply);
    } catch {
        return null;
    }
}

/** 保存补丁。返回 { settings } 或 { error }（校验失败/网络失败）。 */
export async function saveAiSettings(
    patch: AiSettingsPatch,
): Promise<{ settings?: AiSettings; error?: string }> {
    try {
        const res = await postJson("/settings", patch);
        const data = (await res.json().catch(() => null)) as SettingsReply | null;
        if (!res.ok || !data || data.error) {
            return { error: data?.error ?? `保存失败（HTTP ${res.status}）` };
        }
        return { settings: normalize(data) ?? undefined };
    } catch (err) {
        return { error: `保存失败：${String(err)}` };
    }
}

/** 用当前生效配置打一次真实请求。 */
export async function testAiConnection(): Promise<AiTestResult> {
    try {
        const res = await postJson("/ai-test", {});
        const data = (await res.json().catch(() => null)) as AiTestResult | null;
        if (!data) return { ok: false, error: `测试失败（HTTP ${res.status}）` };
        return data;
    } catch (err) {
        return { ok: false, error: `测试失败：${String(err)}` };
    }
}
