// 지갑 파일 내보내기·가져오기 / 종이 단계 / 메인넷 발행 가드 / 버전 — 화면·소스 쪽 규칙(실제 판단은 `cargo test --lib -- walletfile app_lock issue`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
async function load(file) {
  const built = await build({ stdin: { contents: `export * from './src/${file}';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@tauri-apps/*'], loader: { '.css': 'empty', '.txt': 'text' } });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { language: 'ko' };
const wf = await load('wallet-file.ts');
const NEW = ['wallet_export', 'wallet_import_prepare', 'wallet_import_apply', 'wallet_import_cancel', 'wallet_file_status', 'key_sheet_print'];

const leaves = (o) => Object.values(o).flatMap((v) => (typeof v === 'object' ? leaves(v) : [v]));

test('새 IPC 6개: 허용 목록(잠긴 동안)에 없고, lib.rs 문지기 뒤에 등록돼 있고, 폰·직원 HTTP 에 없다', () => {
  const lockSrc = read('src-tauri/src/app_lock.rs');
  const list = lockSrc.slice(lockSrc.indexOf('pub const LOCKED_ALLOWED'), lockSrc.indexOf('];', lockSrc.indexOf('pub const LOCKED_ALLOWED')));
  const allowed = [...list.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.ok(allowed.length > 50 && allowed.includes('app_unlock'));
  const lib = read('src-tauri/src/lib.rs');
  assert.ok(lib.indexOf('app_lock::command_allowed') < lib.indexOf('generate_handler!'));
  for (const c of NEW) {
    assert.ok(!allowed.includes(c), `${c} 가 잠긴 동안 허용 목록에 있다`);
    assert.ok(lib.includes(`walletfile::${c},`), `${c} 등록`);
  }
  assert.ok(!read('src-tauri/src/server.rs').includes('walletfile::'));
  // 잠금 해제 직전 단계 이름들이 목록에 섞이지 않았는지(이름에 export/import/key 가 든 것은 없다)
  for (const c of allowed) assert.doesNotMatch(c, /wallet_export|wallet_import|key_sheet|cloud_key/);
});

test('화면 문구: 한·영·일·중 네 벌, 같은 칸, 빈 칸 없음, 핵심 문장', () => {
  const [ko, en, ja, zh] = ['ko', 'en', 'ja', 'zh'].map((l) => wf.walletFileCopy(l));
  const keys = (o) => Object.keys(o).sort().join(',');
  for (const c of [en, ja, zh]) assert.equal(keys(c), keys(ko));
  for (const c of [ko, en, ja, zh]) for (const v of leaves(c)) assert.ok(typeof v === 'string' && v.trim().length > 0);
  assert.match(ko.paperLead, /컴퓨터가 죽으면, 이 52글자가 없으면 못 엽니다/);
  for (const c of [en, ja, zh]) assert.ok(c.paperLead.includes('52'));
  for (const k of ['paperLead', 'blockedTitle', 'doExport', 'endAsk']) { assert.notEqual(ja[k], en[k]); assert.notEqual(zh[k], en[k]); assert.notEqual(ko[k], en[k]); }
  assert.match(ko.endAsk, /52글자를 종이에 적어/);
  assert.equal(wf.walletFileCopy('fr').doExport, en.doExport, '사전에 없는 말은 영어(i18n 규칙과 같다)');
});

test('화면 소스: innerHTML 없음 · 로그 없음 · 열쇠는 눌러야 · 암호는 쓰고 비운다 · 지갑 암호 없음 접두어', () => {
  const src = read('src/wallet-file.ts');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|console\./);
  assert.match(src, /NEEDS_WALLET_PASS/);
  assert.equal((src.match(/walletPass: passIn\.value[\s\S]{0,400}passIn\.value = ""/g) || []).length, 1, '인쇄 칸을 비운다');
  assert.ok(src.includes('pass.value = ""') && src.includes('secret.value = ""'));
  assert.ok(src.includes('window.setTimeout(hide, 90_000)'), '열쇠는 90초 뒤 가린다');
  assert.ok(src.includes('}, 30_000)'), '복사한 열쇠는 30초 뒤 클립보드에서 지운다');
  // 열쇠를 localStorage 등에 저장하지 않는다(종이 확인 깃발만).
  assert.equal((src.match(/localStorage\.setItem\(([^)]*)\)/g) || []).length, 1);
  assert.ok(src.includes('localStorage.setItem(PAPER_FLAG, "1")'));
  // main.ts 는 import 한 줄 + 옛 ck-need 덮어쓰기 제거
  const main = read('src/main.ts');
  assert.ok(main.includes('import "./wallet-file";'));
  assert.ok(!main.includes('ck-need'));
});

test('정보 화면 MIT 고지: 저작권 문구 원문 · 번역 제외 · 안내문 3언어 사전', async () => {
  const html = read('index.html');
  const pre = html.slice(html.indexOf('id="about-ravencoin-license"'));
  const body = pre.slice(pre.indexOf('>') + 1, pre.indexOf('</pre>'));
  for (const line of ['The MIT License (MIT)', 'Copyright (c) 2009-2018 The Bitcoin Core developers', 'Copyright (c) 2018 The Raven Core developers',
    'Copyright (c) 2009-2018 Raven Developers', 'Permission is hereby granted, free of charge', 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND']) assert.ok(body.includes(line), line);
  assert.match(pre.slice(0, 80), /translate="no"/);
  assert.match(html, /Ravencoin Core v4\.8\.0/);
  const { DICT } = await load('dict.ts');
  for (const k of ['정보 · 오픈소스 고지']) for (const l of ['en', 'ja', 'zh']) assert.ok(DICT[l][k], `${l}: ${k}`);
});

test('메인넷 발행 스위치: 상수는 꺼짐, 모든 발행 명령 앞에 가드, 런타임으로 켜는 길 없음', () => {
  const issue = read('src-tauri/src/issue.rs');
  assert.ok(issue.includes('pub const REAL_MAINNET_ISSUE_ENABLED: bool = false;'));
  for (const [file, fn] of [['issue2.rs', 'pub async fn reissue'], ['issue2.rs', 'pub async fn issue_many_unique'], ['issue2.rs', 'pub async fn issue_qualifier'],
    ['issue2.rs', 'pub async fn issue_restricted'], ['create.rs', 'pub async fn create_issue'], ['issue.rs', 'pub async fn issue_asset']]) {
    const s = read('src-tauri/src/' + file);
    const body = s.slice(s.indexOf(fn));
    assert.ok(body.slice(0, body.indexOf('\n}\n')).includes('ensure_issue_allowed().await?'), `${file} ${fn}`);
  }
  for (const f of ['lib.rs', 'server.rs', 'ravi_agent.rs']) assert.ok(!read('src-tauri/src/' + f).includes('REAL_MAINNET_ISSUE_ENABLED'), `${f} 가 스위치를 만진다`);
});

test('버전 0.8.7 이 여섯 곳에서 같고, 업데이트 안내문·변경 기록이 0.8.7 이다', () => {
  const v = '0.8.7';
  assert.equal(JSON.parse(read('package.json')).version, v);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, v); assert.equal(lock.packages[''].version, v);
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, v);
  assert.match(read('src-tauri/Cargo.toml'), /^version = "0\.8\.7"$/m);
  assert.match(read('src-tauri/Cargo.lock'), /name = "playx-raven"\nversion = "0\.8\.7"/);
  assert.match(read('CHANGELOG.md'), /^# 변경 기록\n\n## 0\.8\.7\n/);
  const manifest = read('scripts/release-manifest.mjs');
  assert.match(manifest, /지갑 파일 내보내기·가져오기/); assert.match(manifest, /52글자/); assert.doesNotMatch(manifest, /게임 탭의 라비 스토리 카드 글자가 보이도록/);
  // 서명 목록 만료·일련번호 메모(서명은 하지 않았다)
  const notes = read('docs/integration-notes.md');
  assert.match(notes, /2026-11-09/); assert.match(notes, /2026101002/);
});
