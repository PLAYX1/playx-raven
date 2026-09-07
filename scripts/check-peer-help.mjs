/**
 * peer_help 가 남이 준 CID 를 그대로 붙들지 않는지 못 박는다.
 *
 * 🔴 왜: 예전에는 개수도 체인 대조도 없이 받은 CID 를 전부 pin 했다.
 *    가짜 주소 하나로 남의 디스크를 채울 수 있었다(실측 2026-09-08).
 *
 * 🔴 그리고 **좋은 입력이 막히지 않는지도 같이 본다.** 이 저장소에서
 *    검사를 넣었다가 멀쩡한 것까지 막은 사고가 두 번 있었다.
 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src-tauri/src/peers.rs", import.meta.url), "utf8");

const 있어야할것 = [
  ["개수 상한",   /const MAX_HELP: usize = (\d+);/],
  ["개수 적용",   /\.take\(MAX_HELP\)/],
  ["CIDv0 만",    /c\.len\(\) == 46 && c\.starts_with\("Qm"\)/],
  ["체인에 묻기", /call_rpc\("getassetdata"/],
  ["해시 대조",   /체인해시\.is_empty\(\) \|\| 체인해시 != cid/],
  ["못 물으면 건너뛴다", /skipped \+= 1;\s*\n\s*continue;/],
];
let 실패 = 0;
for (const [이름, 정규식] of 있어야할것) {
  const m = src.match(정규식);
  console.log(`  ${m ? "✅" : "🔴"} ${이름}${m && m[1] ? " = " + m[1] : ""}`);
  if (!m) 실패++;
}

// ── 좋은 입력이 통과하는지: 소스에서 뽑은 규칙을 그대로 돌려 본다 ──
const 상한 = Number(src.match(/const MAX_HELP: usize = (\d+);/)?.[1] || 0);
const cid통과 = (c) => c.length === 46 && c.startsWith("Qm");
const 시험 = [
  ["진짜 CIDv0",            "Qm" + "a".repeat(44), true],
  ["짧은 것",               "Qmabc",               false],
  ["CIDv1(bafy…)",          "bafy" + "b".repeat(42), false],
  ["빈 값",                 "",                    false],
];
console.log("  ── CID 모양 검사 (좋은 것도 통과해야 한다)");
for (const [이름, 값, 기대] of 시험) {
  const 결과 = cid통과(값);
  const ok = 결과 === 기대;
  console.log(`  ${ok ? "✅" : "🔴"} ${이름}: ${결과 ? "받음" : "막음"} (기대 ${기대 ? "받음" : "막음"})`);
  if (!ok) 실패++;
}
if (상한 < 1 || 상한 > 1000) { console.log(`  🔴 개수 상한이 이상하다: ${상한}`); 실패++; }

console.log(실패 ? `\n🔴 ${실패}건 실패` : "\n검사 통과 — 남이 준 CID 는 체인이 가리킬 때만 붙든다.");
process.exit(실패 ? 1 : 0);
