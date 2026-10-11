// 0.9.0 백업과 복구(레인 B) — 끌어다 놓기 구분 · 코어용 wallet.dat · 문구 · 소스 규칙.
// 진짜 판단은 Rust: `cargo test --lib -- walletfile restore_drop recover app_lock`. 여기서는 화면·배선 쪽 규칙만.
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
const route = await load('backup-drop-route.ts');
const extra = await load('backup-extra.ts');
const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const leaves = (o) => Object.values(o).flatMap((v) => (typeof v === 'object' ? leaves(v) : [v]));
const DROP = ['restore_drop_inspect', 'restore_drop_open', 'restore_drop_apply', 'restore_drop_cancel'];

test('끌어다 놓기 구분: .pxlock·.잠김 → 전체 백업, .rvwallet → 지갑만, 그 밖(사진·zip·wallet.dat)은 자산 드롭', () => {
  const k = route.backupDropKind;
  assert.equal(k('/Users/x/RavenVault-Backup/RavenVault.zip.pxlock'), 'full');
  assert.equal(k('C:\\Users\\x\\PLAYXRaven.zip.잠김'), 'full');
  assert.equal(k('/Volumes/USB/RavenVault-wallet-20261012-120000.rvwallet'), 'wallet');
  assert.equal(k('/Volumes/USB/RAVENVAULT-WALLET.RVWALLET'), 'wallet', '대소문자 무시');
  for (const p of ['/x/photo.png', '/x/IMG_0001.HEIC', '/x/RavenVault.zip', '/x/wallet.dat', '/x/doc.pdf', '/x/a.pxlock.png', '/x/rvwallet', '/x/folder', '']) {
    assert.equal(k(p), null, p);
  }
  assert.deepEqual(route.backupDropPaths(['/a.png', '/b.rvwallet', '/c.pxlock']), ['/b.rvwallet', '/c.pxlock']);
  // 백업이 없으면 기존 흐름(false), 하나라도 있으면 여기서 끝(true) — 섞여 있어도 자산 흐름으로 넘기지 않는다.
  assert.equal(route.routeBackupDrop(['/a.png', '/b.jpg']), false);
  assert.equal(route.routeBackupDrop([]), false);
  assert.equal(route.routeBackupDrop(['/a.png', '/b.rvwallet']), true);
  // Rust 와 같은 확장자 셋.
  const rs = read('src-tauri/src/restore_drop.rs');
  for (const ext of ['.rvwallet', '.pxlock', '.잠김']) assert.ok(rs.includes(`"${ext}"`), ext);
});

test('main.ts: onDropped 맨 앞(자산 원본 대조·끌어놓기 발행·dropJob 보다 먼저)에서 한 줄로 가른다 — 기존 드롭 코드는 그대로', () => {
  const main = read('src/main.ts');
  const f = main.slice(main.indexOf('async function onDropped('));
  const body = f.slice(0, f.indexOf('\n}\n'));
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('routeBackupDrop(paths)') < at('dropJob()'));
  assert.ok(at('routeBackupDrop(paths)') < at('keep.acceptsDrop()'));
  assert.ok(at('routeBackupDrop(paths)') < at('dropPublish.dropPaths'));
  assert.equal((main.match(/routeBackupDrop/g) || []).length, 2, 'import 한 줄 + 부르는 한 줄');
  // 0.9.0 병합: 지갑 파일 화면은 지연 로딩(메인 묶음 예산), 「지갑 암호 없음」 안내 조각만 시작 묶음에.
  assert.ok(main.includes('void import("./wallet-file");') && main.includes('import "./wallet-lock-refusal";'));
  assert.ok(main.includes('void listen<any>("drop-files"'), 'drop-files 이벤트 배선은 그대로');
  // 확인 창은 지연 로딩(메인 묶음 예산).
  assert.match(read('src/backup-drop-route.ts'), /import\("\.\/backup-extra"\)/);
  assert.match(read('src/wallet-file.ts'), /import\("\.\/backup-extra"\)/);
  assert.ok(!/^import .*backup-extra/m.test(main) && !/^import .*backup-extra/m.test(read('src/wallet-file.ts')), '정적 import 금지');
});

test('화면 문구: 한·영·일·중 같은 칸 · 빈 칸 없음 · 유럽어는 영어 · 확인 안 된 호환 주장 없음', () => {
  const [ko, en, ja, zh] = ['ko', 'en', 'ja', 'zh'].map((l) => extra.backupExtraCopy(l));
  const keys = (o) => Object.keys(o).sort().join(',');
  for (const c of [en, ja, zh]) assert.equal(keys(c), keys(ko));
  for (const c of [ko, en, ja, zh]) for (const v of leaves(c)) assert.ok(typeof v === 'string' && v.trim().length > 0);
  for (const l of ['de', 'fr', 'it', 'es', 'pt-BR', 'ru']) assert.equal(extra.backupExtraCopy(l).coreTitle, en.coreTitle, l);
  for (const k of ['coreTitle', 'dlgAsk', 'scopeFull', 'scopeWallet', 'notLocked']) { assert.notEqual(ja[k], en[k]); assert.notEqual(zh[k], en[k]); assert.notEqual(ko[k], en[k]); }
  // 용어(확정).
  assert.equal(ko.dropTitle.startsWith('wallet.dat 백업 파일 가져오기'), true);
  assert.equal(ko.coreFile, '코어용 wallet.dat');
  assert.match(ko.rvLock, /52글자 열쇠로 한 번 더 잠금/);
  // 호환은 「코어 버전에 따라 다를 수 있어요」로만 — 「몇 버전에서 열립니다」 같은 말이 없다.
  assert.match(ko.t1, /코어 버전에 따라 다를 수 있어요/);
  assert.match(ko.coreOpens, /버전에 따라 다를 수 있어요/);
  for (const c of [ko, en, ja, zh]) for (const v of leaves(c)) {
    assert.doesNotMatch(v, /v?\d+\.\d+(\.\d+)?\s*(이상|버전에서|에서 열립니다|or later|and later|以降|及以上)/, v);
    assert.doesNotMatch(v, /(반드시|확실히|항상) 열(려요|립니다)|always opens|guaranteed/i, v);
  }
  // 확인 창이 두 범위를 분명히 다르게 말한다.
  assert.match(ko.scopeFull, /가게 기록/); assert.match(ko.scopeWallet, /하나만/); assert.match(ko.scopeWallet, /가게 기록과 설정은 그대로/);
  // 약한 지갑 암호·잠기지 않은 파일 경고.
  assert.match(ko.weak, /10글자/); assert.match(ko.notLocked, /52글자 열쇠로 잠기지 않아요/);
});

test('wallet-file 용어: 「wallet.dat 백업 파일 내보내기(잠금)」·「wallet.dat 백업 파일 가져오기」, 잠금 파일은 언제나 52글자', async () => {
  const wf = await load('wallet-file.ts');
  const ko = wf.walletFileCopy('ko');
  assert.equal(ko.exportBtn, 'wallet.dat 백업 파일 내보내기(잠금)…');
  assert.equal(ko.importBtn, 'wallet.dat 백업 파일 가져오기…');
  assert.match(ko.lede, /52글자 열쇠로 잠가/);
  assert.match(ko.lede, /레이븐볼트에서만 열 수 있어요/);
  assert.match(ko.lede, /코어용 wallet\.dat/);
});

test('소스 규칙: innerHTML·로그 없음 · 비밀 칸은 쓰고 비운다 · 저장소에 비밀 없음', () => {
  for (const f of ['src/backup-extra.ts', 'src/backup-drop-route.ts']) {
    const s = code(f);
    assert.doesNotMatch(s, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|console\./, f);
    assert.doesNotMatch(s, /localStorage|sessionStorage|indexedDB/, `${f}: 비밀을 브라우저 저장소에 둘 수 있다`);
  }
  const s = read('src/backup-extra.ts');
  assert.ok(s.includes('walletPass: pass.value') && s.includes('pass.value = ""'), '코어용: 지갑 암호를 보내고 비운다');
  assert.ok(s.includes('walletPass: wpass.value') && s.includes('wpass.value = ""'), '복원: 지갑 암호를 보내고 비운다');
  assert.ok(s.includes('secret.value = ""'), '복원: 열쇠를 비운다');
  assert.ok(s.includes('querySelectorAll<HTMLInputElement>("input[type=password]").forEach((i) => { i.value = ""; })'), '창을 닫을 때 비밀 칸을 비운다');
  // 확인 체크 전에는 되살리기 단추가 꺼져 있고, 되살리기는 restore_drop_apply 하나뿐.
  assert.ok(s.includes('id: "rd-apply", disabled: true'));
  assert.equal((s.match(/invoke<Applied>\("restore_drop_apply"/g) || []).length, 1);
  assert.ok(!/invoke[^(]*\("(restore_apply|wallet_import_apply)"/.test(s), '화면이 기존 복원 명령을 직접 부르지 않는다(Rust 가 확인 뒤에 부른다)');
});

test('새 IPC 5개: 잠긴 동안 허용 목록에 없고, lib.rs 문지기 뒤에 등록, 폰·직원 HTTP 에 없음, MUST_DENY 에 있음', () => {
  const lockSrc = read('src-tauri/src/app_lock.rs');
  const list = lockSrc.slice(lockSrc.indexOf('pub const LOCKED_ALLOWED'), lockSrc.indexOf('];', lockSrc.indexOf('pub const LOCKED_ALLOWED')));
  const allowed = [...list.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
  const deny = lockSrc.slice(lockSrc.indexOf('pub const MUST_DENY'));
  const lib = read('src-tauri/src/lib.rs');
  for (const [mod, c] of [['walletfile', 'wallet_core_export'], ...DROP.map((c) => ['restore_drop', c])]) {
    assert.ok(!allowed.includes(c), `${c} 가 잠긴 동안 허용 목록에 있다`);
    assert.ok(lib.includes(`${mod}::${c},`), `${c} 등록`);
    assert.ok(deny.includes(`"${c}"`), `${c} 가 MUST_DENY 에 없다`);
  }
  assert.ok(lib.indexOf('app_lock::command_allowed') < lib.indexOf('generate_handler!'));
  const server = read('src-tauri/src/server.rs');
  assert.ok(!server.includes('restore_drop') && !server.includes('wallet_core_export'));
});

test('Rust 규칙 주석: walletfile.rs 의 「평문 내보내기 없음」은 코어용 한 명령만 좁게 예외', () => {
  const s = read('src-tauri/src/walletfile.rs');
  const head = s.slice(0, s.indexOf('use serde_json'));
  assert.match(head, /\*\*평문 내보내기는 없다\.\*\*/, '기존 규칙 문장은 그대로');
  assert.match(head, /단 하나의 좁은 예외/);
  assert.match(head, /`wallet_core_export` 한 명령만/);
  assert.match(head, /backupwallet/);
  assert.match(head, /\.rvwallet` 이름·`seal_into` 경로로 나가는 일은 없다/);
});
