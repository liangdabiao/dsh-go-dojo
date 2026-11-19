import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * 围棋道场面板 SPA（dsh 插件 app/ 子项目）。
 * 与原 go-game 的差异：
 *  - base 相对路径（'./'）：产物由 dsh 插件 webServer 在 /go-dojo/ 前缀下伺服，
 *    资源引用必须跟着前缀走；
 *  - 去掉 aiMoveDevPlugin（DeepSeek dev 代理）——AI 走子由 dsh agent 完成，
 *    开发时面板直接打插件 API（scripts/devserver.mjs 提供同款前缀路由）；
 *  - 不出 sourcemap（产物提交进插件仓库）。
 */
export default defineConfig({
    plugins: [react()],
    base: "./",
    resolve: {
        alias: [
            { find: "@", replacement: path.resolve(__dirname, "./src") },
            {
                find: "goban",
                replacement: path.resolve(__dirname, "./src/vendor/goban/index.ts"),
            },
            {
                find: /^goban\/(.*)$/,
                replacement: path.resolve(__dirname, "./src/vendor/goban/$1"),
            },
            {
                find: "goscorer",
                replacement: path.resolve(
                    __dirname,
                    "./src/vendor/goban/third_party/goscorer/goscorer.mjs",
                ),
            },
        ],
    },
    server: {
        port: 5173,
    },
    build: {
        outDir: "dist",
        sourcemap: false,
    },
});
