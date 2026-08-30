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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 🔴 `new URL(...).pathname` 은 윈도우에서 `/D:/a/...` 가 된다.
//    path.join 이 그걸 `D:\D:\a\...` 로 붙여, 맥·리눅스는 되고 윈도우만
//    「index.html 이 없다」로 설치 파일이 안 만들어졌다(0.1.1 실측).
const ROOT = dirname(fileURLToPath(import.meta.url));
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

// ── ⑦ 정의 없이 쓰는 색 ───────────────────────────────────────────────
//
// 🔴 2026-08-30 실측으로 **다섯 곳**이 걸렸다. 전부 오류 없이 조용히 죽어
//    있었다:
//
//      index.html  `.syncbar i { background: var(--accent) }`
//        → 이 파일에 `--accent` 는 없다(`--brand` 다). 노드가 장부를 훑는
//          **진행 막대가 늘 비어 있었다.** 사장은 얼마나 남았는지 볼 길이
//          없었고, 화면은 아무 오류도 안 냈다.
//      index.html  `.invbox { background: var(--card) }` · `color: var(--fg)`
//      shops.html  `color: var(--dim)` · wallet.html `background: var(--card)`
//
// CSS 는 없는 변수를 만나면 **그냥 넘어간다.** 그래서 이 종류는 화면을 직접
// 봐야만 드러나고, 어두운 판에서만 드러나는 것도 있다. 여기서 잡는다.
//
// ⚠️ 폴백이 있는 것(`var(--x, #fff)`)은 없어도 화면이 안 깨지므로 안 잡는다.
//    좋은 입력을 막으면 검사가 쓸모없어진다.
{
  const 파일들 = [
    ["index.html", html],
    ...readdirSync(join(ROOT, "web"))
      .filter((f) => f.endsWith(".html"))
      .map((f) => [`web/${f}`, read(`web/${f}`)]),
  ];
  const 나쁜것 = [];
  for (const [이름, 글] of 파일들) {
    const 쓴것 = new Set([...글.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
    const 정의 = new Set([...글.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const 폴백 = new Set([...글.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)].map((m) => m[1]));
    for (const v of 쓴것) if (!정의.has(v) && !폴백.has(v)) 나쁜것.push(`${이름}: ${v}`);
  }
  if (나쁜것.length) {
    fail(`정의 없이 쓰는 색 ${나쁜것.length}개`, [
      ...나쁜것,
      "CSS 는 없는 변수를 조용히 넘어갑니다 — 그 줄은 아무 일도 안 합니다.",
    ]);
  } else ok("색 이름 전부 정의돼 있음");
}

// ⑩ 판 번호가 세 곳에서 어긋나지 않는가.
//
// 🔴 `Cargo.toml` 이 처음 만든 뒤로 **`0.1.0` 그대로**였다. `report.rs` 는
//    그 값을 읽어 문제 신고에 「PLAY X Raven 0.1.0」을 적는다 — 사장님이
//    신고를 보내도 **어느 판에서 난 일인지 알 수가 없었다.** 판을 올릴 때
//    한 곳만 고치기 쉬우니, 어긋나면 여기서 멈춘다.
{
  const 읽기 = (f) => read(f);
  const tauri = (읽기("src-tauri/tauri.conf.json").match(/"version":\s*"([^"]+)"/) || [])[1];
  const cargo = (읽기("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
  const pkg = (읽기("package.json").match(/"version":\s*"([^"]+)"/) || [])[1];
  const 같나 = tauri && tauri === cargo && tauri === pkg;
  if (!같나) {
    fail("판 번호가 어긋납니다", [
      `tauri.conf.json  ${tauri ?? "(못 읽음)"}`,
      `Cargo.toml       ${cargo ?? "(못 읽음)"}`,
      `package.json     ${pkg ?? "(못 읽음)"}`,
      "Cargo.toml 값은 문제 신고에 실립니다. 어긋나면 어느 판인지 못 압니다.",
    ]);
  } else ok(`판 번호 세 곳 모두 ${tauri}`);
}

// ⑧ 없는 칸을 가리키는 라벨.
//
// 🔴 위 ① 은 **`index.html`(가게 컴퓨터 화면)만** 본다. 손님 폰 화면
//    (`web/*.html`)은 아무도 안 봤다 — 방금 거기에 `for="me-pic"` 이라고
//    적었는데 그런 id 가 없었고, **검사 여덟 개가 전부 초록불이었다.**
//
//    `<label for="없는id">` 는 브라우저가 조용히 넘어간다. 라벨을 눌러도
//    아무 일이 안 나고, 어르신은 그걸 「고장」으로 읽는다. 화면을 직접
//    눌러 보기 전에는 안 드러난다.
{
  const 파일들 = readdirSync(join(ROOT, "web"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => [`web/${f}`, read(`web/${f}`)]);
  const 나쁜것 = [];
  for (const [이름, 글] of 파일들) {
    const 있는id = new Set([...글.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of 글.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) {
      if (!있는id.has(m[1])) 나쁜것.push(`${이름}: for="${m[1]}"`);
    }
  }
  if (나쁜것.length) {
    fail(`가리키는 칸이 없는 라벨 ${나쁜것.length}개`, [
      ...나쁜것,
      "그 라벨은 눌러도 아무 일도 안 합니다. id 를 만들거나 for 를 고치세요.",
    ]);
  } else ok("라벨이 가리키는 칸 전부 존재");
}

// ⑨ 태그가 일찍 닫혀 속성이 글자로 새어 나온 것.
//
// 🔴 실제로 냈다. 설명을 붙이는 스크립트가 `<button id="near"` 뒤에 `>` 를
//    하나 끼워 넣었고, 태그가 거기서 닫히는 바람에 원래 있던
//    `style="flex:1;…"` 이 **화면에 글자로 그대로 나왔다.**
//
//        <button id="near"> style="flex:1;padding:12px;…">   ← 깨진 것
//
//    브라우저는 오류를 안 낸다. 그냥 글자로 그린다. 그리고 그 단추는
//    생김새를 잃는다. **배포된 실화면을 찍고 나서야** 봤다 — 그 전 스크린샷
//    에서는 매번 접힌 아래에 있었다.
{
  const 파일들 = [
    ["index.html", html],
    ...readdirSync(join(ROOT, "web"))
      .filter((f) => f.endsWith(".html"))
      .map((f) => [`web/${f}`, read(`web/${f}`)]),
  ];
  const 나쁜것 = [];
  for (const [이름, 글] of 파일들) {
    for (const m of 글.matchAll(/<[a-zA-Z]+[^<>]*>\s*[a-zA-Z-]+="/g)) {
      const 줄 = 글.slice(0, m.index).split("\n").length;
      나쁜것.push(`${이름}:${줄}  ${m[0].slice(0, 60)}`);
    }
  }
  if (나쁜것.length) {
    fail(`태그가 일찍 닫힌 곳 ${나쁜것.length}개`, [
      ...나쁜것,
      "닫는 > 뒤에 속성이 또 있습니다. 브라우저는 그것을 글자로 그립니다.",
    ]);
  } else ok("태그가 일찍 닫힌 곳 없음");
}

console.log("");
if (bad) {
  console.log(`검사 실패 — ${bad}가지를 고쳐야 합니다.`);
  console.log("이것들은 전부 **오류를 안 내고 조용히 안 도는** 종류입니다.");
  process.exit(1);
}
console.log("검사 통과 — 조용히 안 도는 곳 없음.");
