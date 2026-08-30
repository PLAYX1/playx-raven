/**
 * 화면 순회 검사 — **여덟 화면을 하나씩 열어 본다.**
 *
 * ## 왜 생겼나
 *
 * `preflight.mjs` 는 글자를 본다. 이름이 맞는지, 길이 있는지. 그런데 이
 * 저장소가 제일 자주 앓는 병은 그걸로 안 잡힌다:
 *
 *   · 화면을 열 때 **그리는 함수를 안 부른다** → 빈 칸
 *   · 명령이 빈 답을 주면 **그 줄에서 죽는다** → 「…중」에서 안 끝남
 *   · `catch {}` 로 삼킨다 → 오류도 없고 화면도 안 바뀜
 *
 * 셋 다 **오류를 안 낸다.** 그래서 눈으로 못 찾고, tsc 도 cargo 도 못 잡는다.
 * 2026-08-31 이 검사를 처음 돌려 **한 번에 넷**을 찾았다(「돕는 중」 빈 화면,
 * 「지금 주문 받을 수 있나」 카드가 영영 확인 중, `talk_rooms`·
 * `shop_key_move_plan` 빈 답 사망).
 *
 * ## 어떻게 재나
 *
 * 노드 대신 대답해 주는 가짜를 앉히고 화면을 연다. 가짜는 **모르는 명령에
 * `null` 을 준다** — 노드가 막 켜졌거나 답이 이상할 때를 흉내 내는 것이다.
 * 진짜 노드는 그런 답을 잘 안 주지만, 줄 때 화면이 죽으면 그건 우리 잘못이다.
 *
 * ## ⚠️ 이 검사가 「고장」이라 할 때는 **검사부터 의심하라**
 *
 * 오늘 셋을 헛짚었다:
 *   · `file://` 로 열면 Vite 의 `/assets/…` 가 404 라 **앱이 아예 안 돈다**
 *     → 그래서 여기서 작은 서버를 직접 띄운다.
 *   · `--virtual-time-budget` 은 `createImageBitmap` 을 안 깨운다 → 진짜 시간으로 돈다.
 *   · `page.click()` 은 좌표를 계산해서 **메뉴를 놓친다** → `$eval` 로 앱처럼 누른다.
 * 접힌 `<details>` 안은 **열 때 읽는 것이 맞다.** 그건 안 나무란다.
 *
 * 도는 법:  npm run build && node screensweep.mjs
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

// 🔴 크롬이 없으면 **조용히 넘어가지 않는다.** 넘어가면 「검사 통과」인데
//    아무것도 안 본 것이 된다 — 이 저장소가 제일 자주 걸리는 병이다.
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const chrome = process.env.CHROME_PATH || CHROMES.find((p) => existsSync(p));
if (!chrome) {
  console.log("🔴 크롬을 못 찾았습니다. CHROME_PATH 를 주거나 크롬을 깔아 주세요.");
  process.exit(1);
}
if (!existsSync(join(DIST, "index.html"))) {
  console.log("🔴 dist/index.html 이 없습니다. 먼저 `npm run build` 를 돌려 주세요.");
  process.exit(1);
}

let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.log("🔴 puppeteer-core 가 없습니다. `npm i` 를 돌려 주세요.");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
                ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
const server = createServer((req, res) => {
  const p = join(DIST, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(p)] || "text/plain" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: "new" });
const page = await browser.newPage();
// 🔴 맥 헤드리스는 `--window-size` 를 무시한다. 뷰포트를 직접 준다.
await page.setViewport({ width: 1280, height: 1400 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));

await page.evaluateOnNewDocument(() => {
  window.__REJ = [];
  addEventListener("unhandledrejection", (e) =>
    window.__REJ.push(String((e.reason && e.reason.stack) || e.reason).slice(0, 180)));
  const A = [{ name: "PLAYX", amount: 1, units: 0, reissuable: 1, has_ipfs: 1 },
             { name: "SHOP.PLAYX", amount: 21000000000, units: 8, reissuable: 1, has_ipfs: 0 }];
  window.__TAURI_INTERNALS__ = {
    invoke: async (c) => {
      if (c === "list_assets") return A;
      if (c === "pin_list" || c === "my_channels") return [];
      if (c === "artist_profile_get") return { name: "", about: "", picture: "", website: "" };
      if (c === "artist_check") return { ok: false, why: "아직 안 올렸습니다" };
      return null; // 모르는 것은 빈 답 — 여기서 죽으면 우리 잘못이다
    },
    transformCallback: (f) => f,
    metadata: {},
  };
});
await page.goto(BASE, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 2000));

const pages = await page.evaluate(() =>
  [...document.querySelectorAll("nav a[data-page]")].map((a) => a.dataset.page));
if (!pages.length) {
  console.log("🔴 화면을 하나도 못 찾았습니다 — 이 검사가 헛돕니다.");
  process.exit(1);
}

let bad = 0;
for (const id of pages) {
  // 🔴 앱이 누르는 방식 그대로. `page.click()` 은 좌표를 계산해 메뉴를 놓친다.
  await page.evaluate((x) => document.querySelector(`nav a[data-page="${x}"]`).click(), id);
  await new Promise((r) => setTimeout(r, 1500));
  const r = await page.evaluate((x) => {
    const pg = document.getElementById("page-" + x);
    if (!pg) return { gone: true };
    const stuck = [];
    for (const e of pg.querySelectorAll("*")) {
      if (!e.getClientRects().length) continue;
      if (e.closest("details:not([open])")) continue; // 열 때 읽는 것이 맞다
      for (const n of e.childNodes) {
        if (n.nodeType !== 3) continue;
        const s = n.textContent.trim();
        if (/(확인|불러오는|읽는|올리는|여는|세는|찾는)\s*중…?$/.test(s)) {
          stuck.push((e.id ? "#" + e.id : (e.className || e.tagName).toString().split(" ")[0]) +
                     " → " + s.slice(0, 24));
        }
      }
    }
    return { open: pg.classList.contains("on"), len: (pg.innerText || "").trim().length,
             stuck: [...new Set(stuck)] };
  }, id);

  const why = [];
  if (r.gone) why.push("화면이 없다");
  else {
    if (!r.open) why.push("안 열림");
    if (r.len < 40) why.push(`거의 빈 화면 (${r.len}자) — 그리는 함수를 안 부르는 것 아닌가`);
    if (r.stuck.length) why.push("「…중」에서 안 끝남: " + r.stuck.join(" | "));
  }
  if (why.length) bad++;
  console.log((why.length ? "🔴 " : "✅ ") + id.padEnd(10) + (why.join(" · ") || "정상"));
}

const rej = await page.evaluate(() => window.__REJ);
if (rej.length) {
  bad++;
  console.log(`\n🔴 조용히 삼킨 오류 ${rej.length}개 — 그 줄부터 아무 일도 안 일어난다`);
  for (const r of rej) console.log("   " + r);
}
if (errs.length) {
  bad++;
  console.log(`\n🔴 화면 오류 ${errs.length}개`);
  for (const e of errs) console.log("   " + e);
}

await browser.close();
server.close();
console.log("");
if (bad) {
  console.log(`화면 검사 실패 — ${bad}가지.`);
  console.log("전부 **오류를 안 내고 조용히 안 도는** 종류입니다.");
  process.exit(1);
}
console.log("화면 검사 통과 — 여덟 화면 다 그려지고, 삼킨 오류 없음.");
