/**
 * 面板 API 的公共基址：面板挂在 /go-dojo/ 下，接口同前缀
 * （不能用根绝对 /api/...，否则在 dsh 的 iframe 里会打到别处）。
 */

export const BASE: string = (() => {
    const p = typeof location === "undefined" ? "/go-dojo/" : location.pathname;
    return p.endsWith("/") ? p : p + "/";
})();

/** POST/GET 一个面板接口；调用方自己处理错误与超时。 */
export function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${BASE}api${path}`, init);
}

/** 统一发 JSON POST。 */
export function postJson(path: string, body: unknown): Promise<Response> {
    return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}
