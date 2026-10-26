import { defineConfig } from "vite";
import { readFileSync, existsSync } from "node:fs";

// 0.9.0 레인A — 설정(애플식)·이야기 이름표 CSS 는 따로 된 파일에 쓰고(다른 레인과 index.html 충돌을 줄이려고),
// 빌드·개발 때 index.html 의 <style id="rv-lane-css"> 로 넣는다. Tauri 가 <style> 에 nonce 를 붙이므로 CSP 와 맞는다.
// 🔴 왜 main.ts 에서 import 하지 않나: 메모리 예산(scripts/memory-budget.json)의 cssTotalKB 80 이 이미 꽉 차 있다(80.3KB).
//    이 글자들은 설정·이야기를 그리는 데 늘 필요하므로 지연 로딩으로 줄지 않는다 — 한도를 올리지 않고 index.html 예산(480KB) 안에 둔다.
const LANE_CSS = ["src/settings-apple.css", "src/talk-identity.css"];
const inlineLaneCss = {
  name: "rv-inline-lane-css",
  transformIndexHtml(html: string, ctx: { filename: string }) {
    if (!/(^|[\\/])index\.html$/.test(ctx.filename)) return html;
    const css = LANE_CSS.map((f) => new URL(f, import.meta.url)).filter((u) => existsSync(u)).map((u) => readFileSync(u, "utf8")).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "").replace(/\s{2,}/g, " ");
    return html.replace("</head>", `<style id="rv-lane-css">${css}</style>\n</head>`);
  },
};

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  plugins: [inlineLaneCss],
  build: { rollupOptions: { input: { main: "index.html", companion: "companion.html", mini: "mini.html", standby: "standby.html" } } },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
