// Production functions with synthetic DOM/RPC adapters; no browser, capture,
// wallet keys, transaction broadcast, or persistent draft storage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function functions(file, names) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source).replace(/^export\s+/, '')).join('\n');
}
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', style: {}, disabled: false, replaceChildren() { this.innerHTML = ''; } });
  return elements.get(id);
};
const calls = [];
let known = false, rate = 3.5;
const address = 'R' + 'A'.repeat(33);
const context = vm.createContext({ $, Number, String, Math, Promise,
  sendMode: 'rvn', sendPreview: null, 라비가채운보내기: false, TAIL_CHECK_RVN: 30000, lang: 'ko', FEE_UNKNOWN: '수수료는 서버가 정해요(보통 0.01 RVN 안팎).',
  t: source => source, tf: (source, ...values) => source.replace(/\{(\d+)\}/g, (_, i) => String(values[i])),
  copyHtml: source => source, setCopyText: (element, draw) => { element.textContent = draw(); },
  fmtQty: String, payeeName: () => '', escapeHtml: String, ago: () => '', setAllRaviMood() {},
  invoke: async (command, args) => {
    calls.push(command);
    if (command === 'preview_send') return { valid: true, ...args, enough: true, held: 100, history: { known } };
    if (command === 'wallet_lock_state') return { encrypted: true, unlocked: false };
    if (command === 'send_fee') return { fee: 0.01, total: args.amount + 0.01 };
    if (command === 'rvn_rate') { if (rate === null) throw Error('Synthetic unavailable rate'); return { rate }; }
    throw Error('Unexpected command');
  },
});
vm.runInContext(compile(functions('src/main.ts', ['reviewSend', 'paintSendFee', 'gateSend'])), context);
$('s-addr').value = address; $('s-qty').value = '10';
await context.reviewSend();
assert.equal($('r-krw').textContent, '지금 시세로 약 35원');
assert.equal($('r-addr').textContent.replaceAll(' ', ''), address);
assert.ok($('r-addr').textContent.split(' ').every(part => part.length <= 4));
assert.ok($('r-who').innerHTML.includes('처음 보내는 주소예요. 주소 앞뒤 글자를 한 번 더 확인하세요'));
assert.equal($('s-addr').value, address);
assert.equal($('s-qty').value, '10');
assert.equal($('r-passbox').style.display, '');
assert.equal($('s-go').disabled, true);
rate = null; known = true;
await context.reviewSend();
assert.equal($('r-krw').textContent, '원화 환산 정보 없음');
assert.ok(!$('r-who').innerHTML.includes('처음 보내는 주소예요'), 'Known recipient is not labelled new');
for (const invalid of [0, -1, NaN, Infinity]) {
  rate = invalid; await context.reviewSend();
  assert.equal($('r-krw').textContent, '원화 환산 정보 없음');
}
context.sendMode = 'asset'; $('s-asset').value = 'SYNTHETIC';
const rateCalls = calls.filter(c => c === 'rvn_rate').length;
await context.reviewSend();
assert.equal($('r-krw').textContent, '원화 환산 정보 없음');
assert.equal(calls.filter(c => c === 'rvn_rate').length, rateCalls);
assert.ok(!calls.some(c => c === 'send_rvn' || c === 'send_asset'));

// Execute the actual copy listener, checking that visual grouping never enters
// the clipboard value.
const source = ts.createSourceFile('main.ts', read('src/main.ts'), ts.ScriptTarget.Latest, true);
let copyListener;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === '$("r-addr").addEventListener' && node.arguments[0]?.text === 'copy') copyListener = node.getText(source);
  ts.forEachChild(node, walk);
}
walk(source); assert.ok(copyListener);
$('r-addr').addEventListener = (_, callback) => { copyListener = callback; };
vm.runInContext(compile(copyListener), context);
let copied = '';
copyListener({ preventDefault() {}, clipboardData: { setData(type, value) { assert.equal(type, 'text/plain'); copied = value; } } });
assert.equal(copied, address);
const reviewed = context.sendPreview;
context.sendPreview = null;
copied = '';
copyListener({ preventDefault() {}, clipboardData: { setData(_type, value) { copied = value; } } });
assert.equal(copied, address, 'Copy remains original after the review result is cleared');
context.sendPreview = reviewed;
console.log('PASS desktop send: KRW known/unavailable/invalid/assets, grouped address, original clipboard, new/known recipient, locked gate; no broadcast');

let locked = false;
const invokeReview = context.invoke;
context.invoke = async (command, args) => {
  if (command === 'wallet_balance') return { confirmed: 100, unconfirmed: 0 };
  if (command === 'wallet_lock_state') return { encrypted: true, unlocked: !locked };
  return invokeReview(command, args);
};
context.paintOwners = () => {};
context.최근거래_모아읽기 = async () => [];
context.walletWasLocked = null;
context.document = { querySelectorAll: () => [$('s-pass')] };
context.errText = String;
vm.runInContext(compile(functions('src/main.ts', ['loadWallet'])), context);
await context.loadWallet();
$('s-pass').value = 'synthetic input';
locked = true;
await context.loadWallet();
assert.equal($('s-pass').value, '');
assert.equal($('r-passbox').style.display, '');
assert.equal($('s-go').disabled, true);
locked = false;
await context.loadWallet();
assert.equal($('r-passbox').style.display, 'none');
assert.equal($('s-addr').value, address); assert.equal($('s-qty').value, '10');
assert.equal($('s-pass').value, '');
console.log('PASS desktop lock transition: send inputs retained, password cleared, lock gate refreshed');


for (const screen of ['send', 'confirm']) {
  const nodes = new Map();
  const web$ = id => { if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, textContent: '', innerHTML: '', replaceChildren() { this.innerHTML = ''; } }); return nodes.get(id); };
  const passwordFields = [web$('unlock-pass'), web$('pw1'), web$('pw2')];
  passwordFields.forEach(input => { input.value = 'synthetic input'; });
  web$('send-to').value = address; web$('send-amount').value = '10';
  web$('restore-input').value = 'synthetic input'; web$('words-grid').innerHTML = 'synthetic input'; web$('quiz-opts').innerHTML = 'synthetic input';
  const body = { dataset: { screen } };
  const web = vm.createContext({ $: web$, document: { body, querySelectorAll: () => passwordFields },
    mnemonic: null, hdKey: null, scan: {}, pending: {}, draftMnemonic: null, quizPlan: [], idleTimer: undefined, resumeSend: false,
    window: { clearTimeout() {} }, say() {}, readVault: () => ({}), showLockedOrOpen: async () => { body.dataset.screen = 'unlock'; },
    show: screen => { body.dataset.screen = screen; }, RavencoinKey: { getHDKey: () => null }, NET_NAME: 'synthetic', touchIdle() {},
    openBuyFromHash: () => { throw Error('Resume must not reset a purchase'); }, sayWhereThisWalletLives() {}, loadTalks: async () => {},
    refresh: async () => {}, location: { hash: '' }, buying: { to: address, rvn: 10, what: 'Synthetic item' },
  });
  // getElementById is only needed by the normal unlocked-wallet notice.
  web.document.getElementById = () => null;
  vm.runInContext(compile(functions('web/wallet.src.ts', ['lock', 'unlocked'])), web);
  web.lock();
  assert.equal(web.pending, null); assert.equal(web.scan, null); assert.equal(web.resumeSend, true);
  assert.ok(passwordFields.every(input => input.value === ''));
  assert.equal(web$('restore-input').value, ''); assert.equal(web$('words-grid').innerHTML, ''); assert.equal(web$('quiz-opts').innerHTML, '');
  web.unlocked('');
  assert.equal(body.dataset.screen, 'send'); assert.equal(web.resumeSend, false);
  assert.equal(web$('send-to').value, address); assert.equal(web$('send-amount').value, '10');
  assert.equal(web.buying.to, address);
}
console.log('PASS web lock/unlock from compose and review: inputs and purchase retained in memory, review discarded, sensitive fields cleared');

const compiled = await build({ entryPoints: [new URL('../src/dict.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { DICT } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
for (const key of ['원화 환산 정보 없음', '처음 보내는 주소예요. 주소 앞뒤 글자를 한 번 더 확인하세요', '지금 시세로 약 {0}원', '사진 보관함', '완료 잔액', '내 서버']) {
  for (const language of ['en', 'ja', 'zh']) assert.ok(DICT[language][key] && !/[가-힣]/.test(DICT[language][key]), `${language}: missing translated copy`);
}
console.log('PASS new and renamed confirmation copy translated in en/ja/zh');

const seedSource = read('src/seed-check.ts');
const seed = vm.createContext({ Set, Math });
vm.runInContext(compile(seedSource.match(/const ASK_AT = \[.*?\];/)[0] + '\n' + functions('src/seed-check.ts', ['askPositions'])), seed);
assert.deepEqual(Array.from(seed.askPositions(12)), [2, 6, 10]);
assert.equal((seedSource.match(/markChecked\(\);/g) || []).length, 1);
assert.match(seedSource, /if \(wrong\.length\) \{[\s\S]*?return;[\s\S]*?markChecked\(\);/);
assert.match(read('src/content-guard.ts'), /setContentProtected\(on\)/);
console.log('PASS existing backup quiz: positions 2/6/10, completion after all answers, content protection retained; no words or screenshots');
