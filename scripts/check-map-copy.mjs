// 「지도에 올리기」 네 나라 말 누락 검사 — 브라우저 없이 돈다(node scripts/check-map-copy.mjs).
//
// 화면(index.html 의 지도 카드·상태등 줄)·코드(map-card.ts · main.ts 의 지도 줄 · map_format.rs 의
// 검사 문구)에 나오는 한국어가 사전(dict.ts → DICT.en/ja/zh)에 다 있는지 본다.
// 없으면 그 자리만 한국어로 남는다(i18n.ts 원칙) — 그래서 여기서 막는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const bundle = async (entry) => {
  const out = await build({ entryPoints: [resolve(root, entry)], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
};
const { DICT } = await bundle('src/dict.ts');
const { MAP_COPY } = await bundle('src/map-copy.ts');
const HANGUL = /[가-힣]/;
const norm = (s) => s.trim().replace(/\s+/g, ' ');
const want = new Set();

// 1) index.html — 지도 카드와 상태등 줄의 글자·placeholder·aria-label·title
const html = read('index.html');
const cardStart = html.indexOf('<div class="card mpcard" id="mp-card">');
const cardEnd = html.indexOf('<!-- 아래는 **처음 한 번**', cardStart);
assert.ok(cardStart > 0 && cardEnd > cardStart, '지도 카드를 index.html 에서 못 찾았다');
const rowStart = html.indexOf('id="d-map-row"');
assert.ok(rowStart > 0, '상태등 「지도」 줄이 없다');
for (const part of [html.slice(cardStart, cardEnd), html.slice(rowStart, html.indexOf('</button>', rowStart))]) {
  const noComments = part.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of noComments.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) if (HANGUL.test(m[1])) want.add(norm(m[1]));
  for (const text of noComments.replace(/<[^>]*>/g, '\n').split('\n')) if (HANGUL.test(text)) want.add(norm(text));
}

// 2) map-card.ts — 한국어 문자열 전부(주석 제외). 묶음 이름(group)은 화면에 안 나와 뺀다.
const SKIP = new Set(['동네는']); // startsWith 비교용 조각
const ts = read('src/map-card.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const groups = new Set([...ts.matchAll(/group: "([^"]+)"/g)].map((m) => m[1]));
for (const m of ts.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
  const s = m[1];
  if (HANGUL.test(s) && !groups.has(s) && !SKIP.has(s)) want.add(norm(s));
}

// 3) main.ts 의 지도 줄 · 4) map_format.rs 검사 문구(화면에 그대로 뜬다)
const main = read('src/main.ts');
for (const s of ['지도: 올림', '지도: 안 올림']) { assert.ok(main.includes(`"${s}"`), `main.ts 에 ${s} 가 없다`); want.add(s); }
const rs = read('src-tauri/src/map_format.rs');
const fnStart = rs.indexOf('pub fn card_problems'), fnEnd = rs.indexOf('\n}\n', fnStart);
for (const m of rs.slice(fnStart, fnEnd).matchAll(/out\.push\("([^"]+)"\)/g)) want.add(m[1]);

// 사전 확인
const missing = [];
for (const key of want) for (const lang of ['en', 'ja', 'zh']) if (!DICT[lang][key]) missing.push(`${lang}: ${key}`);

// MAP_COPY 자체 — 세 말 모두 있고, 값 자리({0})를 잃지 않았는가
const broken = [];
for (const [k, v] of Object.entries(MAP_COPY)) {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'string' || !x.trim())) broken.push(`빈 번역: ${k}`);
  for (const slot of k.match(/\{\d+\}/g) ?? []) if (v.some((x) => !x.includes(slot))) broken.push(`${slot} 빠짐: ${k}`);
  if (HANGUL.test(v.join(''))) broken.push(`번역에 한국어가 남음: ${k}`);
}

console.log(`검사한 한국어 ${want.size}개 · MAP_COPY ${Object.keys(MAP_COPY).length}개`);
if (missing.length || broken.length) {
  for (const m of [...missing, ...broken]) console.log('  ✗ ' + m);
  process.exit(1);
}
console.log('PASS 지도 카드 문구 4개 언어(ko/en/ja/zh) 누락 없음');
