// 0.9.60 복구 단어 안전 — 유출 경고 판별(오탐 포함) · 보내는 길마다 경고가 먼저 · 「만든 곳」 한 줄.
//   node --test scripts/seed-safety.test.mjs
// 규칙은 폰·웹(~/wt-rv-060-site)과 같다: 번호·쉼표·줄바꿈 제거 후 BIP39 영어 단어장 낱말 연속 12개 이상.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const rawTxt = { name: 'raw-txt', setup(b) {
  b.onResolve({ filter: /\.txt\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.slice(0, -4)), namespace: 'raw-txt' }));
  b.onLoad({ filter: /.*/, namespace: 'raw-txt' }, (a) => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
} };
async function moduleAt(path) {
  const built = await build({ entryPoints: [resolve(root, path)], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' }, plugins: [rawTxt] });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}

// i18n.ts 가 켤 때 말 설정을 읽는다 — 한국어로 고정한다(DOM 없음).
globalThis.localStorage ??= { getItem: (k) => (k === 'playx-raven-lang' ? 'ko' : null), setItem() {}, removeItem() {} };
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { language: 'ko-KR' }, configurable: true });

const WORDS = read('src/bip39-english.txt').trim().split('\n');
const LIST = new Set(WORDS);
const rule = await moduleAt('src/seed-leak-rule.ts');
const leak = await moduleAt('src/seed-leak.ts');
// 🔴 실제 지갑 단어가 아니다 — BIP39 표준 시험 벡터(누구나 아는 단어)와 단어장 앞뒤 낱말로만 만든다.
const S12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const S24 = WORDS.slice(100, 124).join(' ');
const yes = (s) => leak.looksLikeSeedWords(s);

test('단어장은 러스트 words.rs 와 같은 파일 2048개', () => {
  assert.equal(WORDS.length, 2048);
  assert.ok(read('src-tauri/src/words.rs').includes('include_str!("../../src/bip39-english.txt")'));
  assert.equal(rule.SEED_RUN_MIN, 12, '폰·웹과 같은 기준');
});

test('복구 단어 모양은 잡는다', () => {
  assert.ok(yes(S12), '띄어쓰기 12개');
  assert.ok(yes(S24), '24개');
  assert.ok(yes(S12.toUpperCase()), '대문자');
  assert.ok(yes(S12.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')), '번호 + 줄바꿈');
  assert.ok(yes(S12.split(' ').map((w, i) => `${i + 1}) ${w}`).join('  ')), '1) 번호');
  assert.ok(yes(S12.split(' ').join(', ')), '쉼표');
  assert.ok(yes(S12.split(' ').join(',')), '쉼표만(띄어쓰기 없음)');
  assert.ok(yes(S12.split(' ').map((w, i) => `${String.fromCharCode(0xff11 + (i % 9))}.${w}`).join(' ')), '전각 숫자');
  assert.ok(yes(S12.split(' ').map((w, i) => `${String.fromCharCode(0x2460 + i)} ${w}`).join(' ')), '동그라미 숫자');
  assert.ok(yes(`제 지갑 단어예요 ${S12} 확인 부탁드려요`), '한국어 글 사이에 끼어 있어도');
  assert.ok(yes(`Hi support, my phrase is: ${S12}. Thanks!`), '영어 글 사이');
  assert.ok(yes(`"${S12}"`), '따옴표');
  assert.equal(rule.seedRunLength(S24, LIST), 24);
});

test('오탐 — 평범한 글은 묻지 않는다', () => {
  const eleven = S12.split(' ').slice(0, 11).join(' ');
  assert.ok(!yes(eleven), '11개는 아니다');
  assert.ok(!yes(`${eleven} 그리고 ${eleven}`), '한글이 끼면 줄이 끊긴다(11+11)');
  assert.ok(!yes(S12.split(' ').slice(0, 6).join(' ') + ' 오늘 ' + S12.split(' ').slice(6).join(' ')), '6 + 한글 + 6');
  assert.ok(!yes('관장님, 내일 수업 몇 시예요? 도복 챙겨 갈게요. 주말 모임 장소 정했어요.'), '한국어 대화');
  assert.ok(!yes('The quick brown fox jumps over the lazy dog and then it runs away into the forest to find some food.'), '영어 문장(the·and·to 가 끊는다)');
  assert.ok(!yes('I think we should meet at the coffee shop near the office around noon tomorrow if that works for you.'), '영어 약속');
  assert.ok(!yes('Please review the attached document and let me know if you have any questions about the project timeline or budget.'), '영어 업무 글');
  assert.ok(!yes('RVN 주소 RQD1x8zZ3c5Vg7mFtW9qkJ6pYbNs2HhLuE 로 보내 주세요'), 'RVN 주소');
  assert.ok(!yes('거래 번호 ' + 'a1b2c3d4'.repeat(8)), '거래 번호(16진수)');
  assert.ok(!yes('https://ravenvault.ex.erci.se/n/abc?x=1 여기 보세요'), '링크');
  assert.ok(!yes('ㅋㅋㅋㅋ 좋아요 :ravi_ok: :ravi_cheer:'), '이모티콘 글');
  assert.ok(!yes(''), '빈 글');
  // 단어장 낱말만 11개씩 반복해도 사이에 단어장 밖 낱말이 있으면 끊긴다.
  assert.ok(!yes(Array.from({ length: 5 }, () => eleven).join(' the ')), '단어장 밖 the 가 끊는다');
});

test('문서가 없으면(창을 못 띄우면) 단어 모양은 보내지 않는 쪽 · 평범한 글은 그대로', async () => {
  assert.equal(await leak.confirmSeedLeak('안녕하세요'), true);
  assert.equal(await leak.confirmSeedLeak(S12), false);
  assert.equal(await leak.confirmSeedLeak(S12, 'ravi'), false);
  assert.ok(leak.RAVI_SEND_DELAY_MS >= 3000, '라비 쪽은 3초 뒤에야 「그래도 보내기」');
});

test('보내는 길마다 경고가 먼저 — 톡·이야기·쪽지·장터·가게·서버 대화·라비', () => {
  const main = read('src/main.ts');
  const cut = (s, from, to) => { const i = s.indexOf(from); assert.ok(i >= 0, from); const j = s.indexOf(to, i); assert.ok(j > i, to); return s.slice(i, j); };
  // 톡·방·이야기(소식)·나만/친구만·사진 글은 모두 talkSend 를 지난다 — 그 셋보다 먼저 묻는다.
  const send = cut(main, 'async function talkSend()', 'invoke<any>("talk_post"');
  assert.match(send, /confirmSeedLeak\(text\)/);
  assert.ok(send.indexOf('confirmSeedLeak(text)') < send.indexOf('talkSendPrivate(text)'), '나만·친구만 글보다 먼저');
  assert.ok(send.indexOf('confirmSeedLeak(text)') < send.indexOf('talkSendPhoto(text)'), '사진 글보다 먼저');
  assert.match(cut(main, 'async function sendDirect()', 'invoke("pubsub_send"'), /confirmSeedLeak\(text\)/);
  assert.match(cut(main, 'async function registerShop()', 'invoke<any>("build_shop_profile"'), /confirmSeedLeak\(/);
  assert.match(main, /seedGuard: \(text: string\) => confirmSeedLeak\(text\)/);
  // 라비: 단어만 있는 줄은 원래대로 막고(containsRaviSecret), 글 속 단어는 더 세게 묻는다 — AI 로 가기 전.
  const ravi = cut(main, 'async function chatSendExisting()', 'await chatAgent(q);\n\n}');
  assert.match(ravi, /confirmSeedLeak\(q, "ravi"\)/);
  assert.ok(ravi.indexOf('containsRaviSecret(q)') < ravi.indexOf('confirmSeedLeak(q, "ravi")'));
  assert.ok(ravi.indexOf('confirmSeedLeak(q, "ravi")') < ravi.indexOf('chatAsk(q)'), 'AI 로 가기 전');
  const dm = read('src/talk-dm.ts');
  const dmSend = cut(dm, 'async function send(): Promise<void>', 'invoke<any>("talk_dm_send"');
  assert.match(dmSend, /d\.seedGuard && !\(await d\.seedGuard\(text\)\)\) return;/);
  assert.ok(dmSend.indexOf('seedGuard') < dmSend.indexOf('box.value = ""'), '글을 지우기 전에 묻는다(안 보내면 칸에 그대로)');
  const lm = read('src/listing-market.ts');
  assert.match(cut(lm, 'go.onclick = async () => {', '"market_publish_listing"'), /deps\.seedGuard/);
  // 🔴 실제 지갑 단어에는 손대지 않는다 — 경고 쪽 코드는 노드·단어 명령을 부르지 않는다.
  for (const f of ['src/seed-leak.ts', 'src/seed-leak-rule.ts']) {
    const src = read(f);
    assert.ok(!/invoke|reveal_seed|getmywords|words_from_node/.test(src), `${f} 는 지갑 단어를 읽지 않는다`);
  }
});

test('확인 창 기본은 「보내지 않기」 — 처음 초점·Enter·Esc·바깥 누르기', () => {
  const src = read('src/seed-leak.ts');
  assert.match(src, /setTimeout\(\(\) => keep\.focus\(\), 0\)/, '처음 초점은 보내지 않기');
  assert.match(src, /e\.key === "Escape"[^\n]*done\(false\)/);
  assert.match(src, /e\.key === "Enter"[^\n]*done\(document\.activeElement === anyway && !anyway\.disabled\)/);
  assert.match(src, /e\.target === wrap\) done\(false\)/);
});

test('받는 쪽 한 줄 — 상대가 보낸 첫 쪽지 위에 한 번', () => {
  const dm = read('src/talk-dm.ts');
  assert.match(dm, /const firstIn = list\.findIndex\(\(m\) => m\.from !== me\)/);
  assert.match(dm, /i === firstIn \? `<div class="tkc-safety" role="note">\$\{copyHtml\(NEVER_ASKS\)\}<\/div>`/);
  assert.equal(rule.NEVER_ASKS, '레이븐볼트는 복구 단어나 비밀번호를 절대 묻지 않습니다');
});

test('「만든 곳」 한 줄 + 번역(영·일·중)', async () => {
  const { walletOriginLine } = await moduleAt('src/wallet-origin.ts');
  const at = Date.UTC(2026, 10, 28, 3);
  assert.equal(walletOriginLine(null), '');
  assert.equal(walletOriginLine({}), '');
  assert.match(walletOriginLine({ origin: 'created', platform: 'desktop-node', nodeVersion: '4.8.0', appVersion: '0.9.60', createdAt: at }), /^만든 곳: 이 컴퓨터 노드 v4\.8\.0 · 앱 0\.9\.60 · .+/);
  assert.match(walletOriginLine({ origin: 'created', appVersion: '0.9.60', createdAt: at }), /^만든 곳: 이 컴퓨터 노드 · 앱 0\.9\.60 · /);
  assert.match(walletOriginLine({ origin: 'imported', nodeVersion: '4.8.0', appVersion: '0.9.60', createdAt: at }), /^만든 곳: 복구 단어로 되살림 · 앱 0\.9\.60 · /);
  assert.equal(walletOriginLine({ origin: 'unknown', createdAt: at }), '만든 곳: 기록 없음 · 이 기능 전부터 있던 지갑');
  const { SEED_SAFETY_COPY } = await moduleAt('src/seed-safety-copy.ts');
  const used = [...read('src/seed-leak.ts').matchAll(/\bt[f]?\("([^"]+)"/g), ...read('src/wallet-origin.ts').matchAll(/\bt[f]?\("([^"]+)"/g)].map((m) => m[1]);
  used.push(rule.NEVER_ASKS);
  for (const k of used) {
    assert.ok(SEED_SAFETY_COPY[k], `번역 없음: ${k}`);
    for (const v of SEED_SAFETY_COPY[k]) assert.ok(v && !/[가-힣]/.test(v), `${k} → ${v}`);
    for (const v of SEED_SAFETY_COPY[k]) assert.deepEqual(v.match(/\{\d\}/g) || [], k.match(/\{\d\}/g) || [], `자리표시자 ${k}`);
  }
  assert.match(read('src/dict.ts'), /Object\.entries\(SEED_SAFETY_COPY\)/);
});
