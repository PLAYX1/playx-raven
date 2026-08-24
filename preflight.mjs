#!/usr/bin/env node
/**
 * 배포 전 검사 — **조용히 안 도는 코드**를 잡는다.
 *
 * ## 왜 있나
 *
 * 2026-08-23 하루에 같은 병을 열일곱 번 밟았다. 하나를 고치면 다음 것이
 * 나왔고, 대표님이 화면에서 하나씩 발견하셨다. 전부 이 넷 중 하나였다:
 *
 *   ① 화면이 **없는 칸**을 부른다      — `sw-node` · `tbl-print` · `fee-say`
 *   ② 화면이 **없는 값**을 읽는다      — `node_status().running` · `solo_days_per_block`
 *   ③ 코드는 있는데 **부르는 곳이 0곳** — `booking_slots` · `table_qr_sheet`
 *   ④ 길이 없어 **조용한 404**         — `/s/:asset` · 경로 안의 점
 *
 * 🔴 넷 다 **오류를 안 낸다.** `$()` 는 가짜 칸을 돌려주고, 없는 값은
 * `undefined` 이고, 안 불리는 함수는 그냥 안 돌고, 404 는 빈 화면이 된다.
 * 컴파일도 통과하고 시험도 통과한다. 사람이 화면을 열어 봐야만 안다.
 *
 * 그래서 사람 대신 여기서 본다. 빌드 전에 돌리고, 걸리면 배포를 멈춘다.
 *
 * ## 무엇을 안 하나
 *
 * 논리를 검사하지 않는다. 「이 값이 맞나」는 시험이 할 일이다. 여기는
 * **이어져 있나**만 본다 — 부르는 쪽과 받는 쪽이 같은 이름을 쓰는지.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const fail = (title, lines) => {
  bad++;
  console.log(`\n🔴 ${title}`);
  for (const l of lines) console.log(`   ${l}`);
};
const ok = (t) => console.log(`✅ ${t}`);

const html = read("index.html");
const ts = read("src/main.ts");

// ── ① 화면이 부르는 칸이 실제로 있나 ────────────────────────────────
//
// `$("...")` 는 없는 칸을 만나면 **가짜 칸을 돌려준다.** 오류를 안 내는
// 대신 그 단추가 영원히 아무 일도 안 한다. 실제로 「테이블 QR」이 그렇게
// 한 달을 조용히 죽어 있었다.
{
  const haveHtml = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
  // 화면을 코드가 만들어 넣는 것도 있다(`innerHTML` 안의 id). 그것도 센다.
  const madeByCode = new Set([...ts.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  // 🔴 그중에는 **번호를 붙여 만드는 것**이 있다 — `id="hr-o-${d}"` 처럼.
  //    이걸 못 보면 멀쩡한 코드를 「없는 칸을 부른다」고 잡는다. 거짓 경보를
  //    한 번 내면 다음부터 아무도 이 검사를 안 본다.
  const madePrefix = [...ts.matchAll(/id="([\w-]+?)-?\$\{/g)].map((m) => m[1]);
  const asked = new Set(
    [...ts.matchAll(/\$\$?\(\s*[`"]([\w-]+)[`"]\s*\)/g)].map((m) => m[1])
  );
  const madeDynamic = (id) => madePrefix.some((p) => id.startsWith(p));
  const missing = [...asked].filter(
    (id) => !haveHtml.has(id) && !madeByCode.has(id) && !madeDynamic(id)
  );
  if (missing.length) {
    fail(`화면에 없는 칸을 ${missing.length}개 부르고 있습니다`, [
      ...missing.map((m) => `$("${m}") — 이 단추·칸은 눌러도 아무 일이 없습니다`),
      "",
      "고치는 법: index.html 에 그 id 를 만들거나, 부르는 줄을 지우세요.",
    ]);
  } else ok(`화면이 부르는 칸 ${asked.size}개 전부 존재`);
}

// ── ② 화면이 부르는 명령이 등록돼 있나 ──────────────────────────────
//
// `invoke("없는명령")` 은 실행 중에만 실패하고, 대개 `.catch()` 에 먹혀
// 조용히 사라진다. 실제로 내가 없는 명령(`items_of`)을 지어내 부른 적이 있다.
{
  const lib = read("src-tauri/src/lib.rs");
  const registered = new Set(
    [...lib.matchAll(/^\s+(?:\w+::)?(\w+),\s*$/gm)].map((m) => m[1])
  );
  const called = new Set([...ts.matchAll(/invoke<[^>]*>\("(\w+)"|invoke\("(\w+)"/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean));
  const missing = [...called].filter((c) => !registered.has(c));
  if (missing.length) {
    fail(`등록 안 된 명령을 ${missing.length}개 부르고 있습니다`, [
      ...missing.map((m) => `invoke("${m}") — 이 기능은 실행하면 실패합니다`),
      "",
      "고치는 법: src-tauri/src/lib.rs 의 명령 목록에 추가하세요.",
    ]);
  } else ok(`화면이 부르는 명령 ${called.size}개 전부 등록됨`);
}

// ── ③ 등록만 하고 아무도 안 부르는 명령 ──────────────────────────────
//
// 「적혀는 있는데 안 도는 코드」의 원형이다. `booking_slots` 는 규칙이
// 완성돼 있고 시험도 있는데 **부르는 곳이 한 곳도 없었다** — 예약 기능이
// 통째로 껍데기였다는 뜻이다.
{
  const lib = read("src-tauri/src/lib.rs");
  const registered = [...lib.matchAll(/^\s+\w+::(\w+),\s*$/gm)].map((m) => m[1]);
  const webFiles = readdirSync(join(ROOT, "web"))
    .filter((f) => f.endsWith(".html") || f.endsWith(".ts"))
    .map((f) => read(`web/${f}`))
    .join("\n");
  // 🔴 러스트 안에서만 불리는 것도 많다 — 손님 화면이 `/api/...` 로 부르고
  //    그 핸들러가 함수를 직접 부르는 경우다(`ticket_use` 가 그렇다).
  //    그걸 못 보면 멀쩡히 도는 기능을 「아무도 안 부른다」고 잡는다.
  const rsDir = join(ROOT, "src-tauri/src");
  const rust = readdirSync(rsDir)
    .filter((f) => f.endsWith(".rs") && f !== "lib.rs")
    .map((f) => read(`src-tauri/src/${f}`))
    .join("\n");
  const all = ts + webFiles;
  const orphans = registered.filter(
    (c) => !all.includes(`"${c}"`) && !rust.includes(`${c}(`)
  );
  if (orphans.length) {
    console.log(`\n⚠️  아무도 안 부르는 명령 ${orphans.length}개`);
    console.log(`   ${orphans.join(", ")}`);
    console.log("   화면이 없거나, 만들다 만 기능입니다. (배포는 막지 않습니다)");
  } else ok("등록된 명령이 전부 어디선가 불림");
}

// ── ④ 손님 화면이 부르는 길이 서버에 있나 ────────────────────────────
//
// `/api/chain/shops` 가 없어서 장터가 「가게가 없습니다」만 그렸다.
// 404 는 화면에 아무 표시도 안 남긴다.
{
  const server = read("src-tauri/src/server.rs");
  const routes = new Set(
    [...server.matchAll(/\.route\("([^"]+)"/g)].map((m) => m[1])
  );
  const pages = ["customer.html", "shops.html", "scan.html", "staff.html", "admin.html", "buy.html"]
    .filter((f) => {
      try { statSync(join(ROOT, "web", f)); return true; } catch { return false; }
    })
    .map((f) => read(`web/${f}`))
    .join("\n");
  const asked = new Set(
    [...pages.matchAll(/fetch\(\s*[`"']([/][\w/-]+)/g)].map((m) => m[1])
  );
  const missing = [...asked].filter((p) => !routes.has(p));
  if (missing.length) {
    fail(`서버에 없는 길을 ${missing.length}개 부르고 있습니다`, [
      ...missing.map((m) => `fetch("${m}") — 손님 화면이 조용히 빈 채로 남습니다`),
      "",
      "고치는 법: src-tauri/src/server.rs 에 .route() 를 추가하세요.",
    ]);
  } else ok(`손님 화면이 부르는 길 ${asked.size}개 전부 존재`);
}

// ── ④-2 손님·사장 화면이 부르는 **그림**이 서버에 있나 ──────────────────
//
// 🔴 사장·직원 화면만 `/faces/raven-head.webp` 를 불렀고, 서버에는 그런 길이
// 없었다. 404 는 그냥 **빈 자리**로 보인다 — 아무도 오류를 안 보고, 사장은
// 「라비 그림이 안 나온다」만 겪는다. 다른 화면들은 `/raven-head.webp` 였다.
{
  const server = read("src-tauri/src/server.rs");
  const routes = [...server.matchAll(/\.route\("([^"]+)"/g)].map((m) => m[1]);
  const wild = routes.some((r) => /^\/\{[^}]+\}$/.test(r)); // `/{name}` 가 있으면 한 칸짜리는 다 받는다
  const pages = readdirSync(join(ROOT, "web"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => read(`web/${f}`))
    .join("\n");
  const imgs = new Set(
    [...pages.matchAll(/src="(\/[\w/-]+\.(?:webp|png|jpg|svg))"/g)].map((m) => m[1])
  );
  const missing = [...imgs].filter((p) => {
    if (routes.includes(p)) return false;
    // `/{name}` 는 **칸이 하나뿐인** 길만 받는다. `/faces/x.webp` 는 못 받는다.
    return !(wild && p.split("/").length === 2);
  });
  if (missing.length) {
    fail(`서버에 없는 그림을 ${missing.length}개 부르고 있습니다`, [
      ...missing.map((m) => `src="${m}" — 그 자리가 조용히 빈 채로 남습니다`),
      "",
      "고치는 법: 다른 화면과 같은 경로를 쓰거나, server.rs 에 길을 내세요.",
    ]);
  } else ok(`화면이 부르는 그림 ${imgs.size}개 전부 존재`);
}

// ── ⑤ axum 이 거부하는 경로 모양 ─────────────────────────────────────
//
// `/{name}.webp` 한 줄이 **서버 전체를 못 켜게** 했다. axum 은 이것을
// 컴파일이 아니라 실행할 때 거부하고, 패닉이 다른 실타래에서 나서
// 화면에는 시간초과만 뜬다. 찾는 데 하루가 걸렸다.
{
  const server = read("src-tauri/src/server.rs");
  const bad = [...server.matchAll(/\.route\("([^"]*\{[^}]*\}[^"/]+)"/g)].map((m) => m[1]);
  if (bad.length) {
    fail("axum 이 거부하는 경로가 있습니다 — 서버가 아예 안 켜집니다", [
      ...bad.map((b) => `"${b}" — 한 칸에 변수와 글자를 섞을 수 없습니다`),
      "",
      '고치는 법: "/{name}" 처럼 칸 하나로 받고 안에서 가르세요.',
    ]);
  } else ok("경로 모양 정상 (axum 이 받아들이는 형태)");
}

// ── ⑥ id 가 두 번 쓰이나 ─────────────────────────────────────────────
//
// 같은 id 가 둘이면 `$()` 는 **먼저 나온 것**을 잡는다. 뒤엣것은 영원히
// 안 걸린다. 실제로 `sh-asset` 을 하나 더 만들어 이 사고를 낼 뻔했다.
{
  const ids = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  const dup = [];
  for (const id of ids) {
    seen.set(id, (seen.get(id) || 0) + 1);
    if (seen.get(id) === 2) dup.push(id);
  }
  if (dup.length) {
    fail(`같은 id 가 두 번 쓰였습니다 (${dup.length}개)`, [
      ...dup.map((d) => `id="${d}" — 뒤엣것은 영원히 안 잡힙니다`),
    ]);
  } else ok(`id ${seen.size}개 전부 하나뿐`);
}

console.log("");
if (bad) {
  console.log(`검사 실패 — ${bad}가지를 고쳐야 합니다.`);
  console.log("이것들은 전부 **오류를 안 내고 조용히 안 도는** 종류입니다.");
  process.exit(1);
}
console.log("검사 통과 — 조용히 안 도는 곳 없음.");
