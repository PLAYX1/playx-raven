// 네트워크·키 저장·실제 서명 없음. 실패 출력도 사례 이름만 기록한다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, format: 'cjs', platform: 'node', write: false });
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return context.module.exports;
}
const core = await load('core/wallet-vault.ts');
const { createWalletVault } = await load('src/wallet-vault.ts');
const { createRaviWalletTools, RAVI_WALLET_TOOLS } = await load('src/ravi-wallet.ts');
const payment = (amount = 20n, fee = 1n, to = 'mock:merchant') => ({ amount, fee, to });
const policy = { perPayment: 100n, daily: 150n, utcOffsetMinutes: 540 };
const start = Date.UTC(2026, 9, 6, 14, 59, 59); // 서울 자정 1초 전
function fixture(overrides = {}) {
  let time = start, hotCalls = 0, vaultCalls = 0, authCalls = 0;
  const receipt = t => ({ kind: 'mock-signature', requestId: t.id });
  const options = {
    network: 'mock', policy: { ...policy }, hotAddress: 'mock:hot', vaultAddress: 'mock:vault',
    hotBalance: 1000n, vaultBalance: 1000n, now: () => time,
    hotSigner: { mode: 'mock', async sign(t) { hotCalls++; return receipt(t); } },
    vaultSigner: { mode: 'mock', async sign(t) { vaultCalls++; return receipt(t); } },
    async authenticate() { authCalls++; return true; }, ...overrides,
  };
  const wallet = createWalletVault(options);
  return { ...wallet, options, tools: createRaviWalletTools(wallet.hot), receipt,
    time(value) { time = value; }, counts: () => ({ hotCalls, vaultCalls, authCalls }) };
}
const cases = [];
const test = (name, run) => cases.push([name, run]);
const deny = async fn => assert.rejects(fn);
test('한도 안 즉시 결제·수수료 포함·금고 인증 없음', async () => {
  const f = fixture(); assert.equal((await f.hot.pay(payment(99n))).status, 'signed');
  assert.equal(f.hot.snapshot().spentToday, 100n); assert.equal(f.counts().hotCalls, 1);
  assert.equal(f.counts().vaultCalls + f.counts().authCalls, 0);
});
test('1회 한도 초과는 금고 승인 필요·자동 호출 없음', async () => {
  const f = fixture(); const r = await f.hot.pay(payment(100n));
  assert.equal(r.status, 'needs_vault_approval'); assert.equal(r.reason, 'per_payment');
  assert.equal(f.hot.snapshot().spentToday, 0n); assert.equal(f.counts().vaultCalls + f.counts().hotCalls, 0);
});
test('일일 합계 경계와 수수료 합산', async () => {
  const f = fixture(); await f.hot.pay(payment(79n)); await f.hot.pay(payment(69n));
  assert.equal(f.hot.snapshot().spentToday, 150n);
  assert.equal((await f.hot.pay(payment(1n, 0n))).reason, 'daily');
});
test('서울 자정 초기화·UTC 자정과 구분', async () => {
  const f = fixture(); await f.hot.pay(payment(99n));
  f.time(start + 999); assert.equal(f.hot.snapshot().spentToday, 100n);
  f.time(start + 1000); assert.equal(f.hot.snapshot().spentToday, 0n);
  assert.equal((await f.hot.pay(payment(99n))).status, 'signed');
  assert.equal(f.hot.snapshot().spentToday, 100n); assert.equal(f.hot.snapshot().available, 800n);
});
test('시계 되돌리기 거부·합계 복구 불가', async () => {
  const f = fixture(); await f.hot.pay(payment()); f.time(start - 1);
  await deny(() => f.hot.pay(payment())); assert.throws(() => f.hot.snapshot(), /CLOCK_ROLLBACK/);
  assert.equal(f.counts().hotCalls, 1);
});
test('잔액 부족은 보충 질문 상태만 반환·자동 이체 없음', async () => {
  const f = fixture({ hotBalance: 0n }); assert.equal((await f.hot.pay(payment())).status, 'needs_topup');
  assert.equal(f.counts().vaultCalls + f.counts().authCalls + f.counts().hotCalls, 0);
});
test('동시 결제 예약으로 일일 한도 우회 거부', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = fixture({ hotSigner: { mode: 'mock', async sign(t) { await gate; return { kind: 'mock-signature', requestId: t.id }; } } });
  const first = f.hot.pay(payment(99n));
  assert.equal((await f.hot.pay(payment(99n))).reason, 'daily');
  release(); assert.equal((await first).status, 'signed'); assert.equal(f.hot.snapshot().spentToday, 100n);
});
test('동시 결제 예약으로 잔액 초과 거부', async () => {
  const f = fixture({ hotBalance: 30n });
  const results = await Promise.all([f.hot.pay(payment()), f.hot.pay(payment())]);
  assert.equal(results.filter(r => r.status === 'signed').length, 1);
  assert.equal(f.hot.snapshot().available, 9n);
});
test('실패한 서명은 보수적 예약 유지·오류 원문 미노출', async () => {
  const f = fixture({ hotSigner: { mode: 'mock', async sign() { throw new Error('private-error-body'); } } });
  const r = await f.hot.pay(payment()); assert.equal(r.status, 'failed');
  assert.ok(!JSON.stringify(r).includes('private-error-body')); assert.equal(f.hot.snapshot().spentToday, 21n);
});
test('에이전트 금고 명령·프로토타입 이름·범용 invoke 거부', async () => {
  const f = fixture();
  for (const name of ['vault_sign', 'vault_topup', 'prepare', 'approveAndSign', 'watch', 'send_rvn', 'walletpassphrase', 'constructor', '__proto__', 'toString'])
    await assert.rejects(() => f.tools.call(name, {}), /TOOL_DENIED/);
  assert.equal(f.counts().vaultCalls + f.counts().authCalls, 0);
  assert.equal(Object.keys(f.hot).sort().join(','), 'pay,snapshot');
  assert.equal(Object.keys(f.tools).join(','), 'call'); assert.equal(RAVI_WALLET_TOOLS.join(','), 'hot_status,hot_pay');
});
test('AI 입력 source·approved·actor·수신처 혼입 거부', async () => {
  const f = fixture();
  for (const extra of [{ source: 'vault' }, { approved: true }, { actor: 'owner' }, { purpose: 'topup' }])
    await deny(() => f.tools.call('hot_pay', { to: 'mock:merchant', amount: '1', fee: '0', ...extra }));
  await deny(() => f.hot.pay({ ...payment(), source: 'vault' }));
  assert.equal(f.counts().vaultCalls + f.counts().hotCalls, 0);
});
test('AI 정수 문자열 결제·상태는 핫만', async () => {
  const f = fixture(); assert.equal((await f.tools.call('hot_pay', { to: 'mock:merchant', amount: '20', fee: '1' })).status, 'signed');
  const status = await f.tools.call('hot_status'); assert.equal(status.available, 979n);
  assert.equal('vault' in status || 'address' in status, false);
  for (const amount of ['1.1', '-1', '1e2', '0', '01', 1, '1'.repeat(31)])
    await deny(() => f.tools.call('hot_pay', { to: 'mock:merchant', amount, fee: '0' }));
  await deny(() => f.tools.call('hot_status', { source: 'vault' }));
});
test('승인 없는 금고→핫 이체·인증 거부 시 서명 없음', async () => {
  const f = fixture({ authenticate: async () => false });
  const t = f.owner.prepare('topup', payment(50n, 1n, 'mock:hot'));
  assert.equal(f.owner.stage(t.id), 'review'); assert.equal(f.counts().vaultCalls, 0);
  assert.equal(await f.owner.approveAndSign(t.id), 'failed'); assert.equal(f.counts().vaultCalls, 0);
  assert.throws(() => core.transition('review', 'authorize'), /INVALID_TRANSITION/);
});
test('소유자 인증한 정확한 거래만 1회 모의 서명·핫 입금 추정 금지', async () => {
  let reviewed, signed;
  const f = fixture({ authenticate: async t => { reviewed = t; return true; },
    vaultSigner: { mode: 'mock', async sign(t) { signed = t; return { kind: 'mock-signature', requestId: t.id }; } } });
  const t = f.owner.prepare('topup', payment(50n, 1n, 'mock:hot'));
  assert.equal(await f.owner.approveAndSign(t.id), 'signed'); assert.equal(reviewed, signed);
  assert.equal(Object.isFrozen(t), true); assert.equal(t.to, 'mock:hot');
  assert.equal(f.owner.watch().available, 949n); assert.equal(f.hot.snapshot().available, 1000n);
  await deny(() => f.owner.approveAndSign(t.id));
});
test('잘못된 보충 목적지·없는 승인 ID 거부', async () => {
  const f = fixture(); assert.throws(() => f.owner.prepare('topup', payment()), /TOPUP_DESTINATION/);
  await deny(() => f.owner.approveAndSign('unknown')); assert.equal(f.counts().vaultCalls, 0);
});
test('큰 송금은 금고 인증 경로·핫 한도 우회 승인 없음', async () => {
  const f = fixture(); const t = f.owner.prepare('payment', payment(500n));
  assert.equal(await f.owner.approveAndSign(t.id), 'signed'); assert.equal(f.counts().authCalls, 1);
  assert.equal((await f.hot.pay(payment(101n))).status, 'needs_vault_approval');
});
test('인증 대기 중 취소·중복 클릭 거부', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = fixture({ authenticate: async () => { await gate; return true; } });
  const t = f.owner.prepare('topup', payment(10n, 0n, 'mock:hot'));
  const pending = f.owner.approveAndSign(t.id); await deny(() => f.owner.approveAndSign(t.id));
  assert.equal(f.owner.cancel(t.id), 'cancelled'); release();
  assert.equal(await pending, 'cancelled'); assert.equal(f.counts().vaultCalls, 0);
});
test('승인 만료·인증 대기 중 만료·경계시각 거부', async () => {
  const f = fixture(); const t = f.owner.prepare('payment', payment()); f.time(t.expiresAt);
  await deny(() => f.owner.approveAndSign(t.id)); assert.equal(f.owner.stage(t.id), 'expired');
  assert.equal(f.counts().authCalls, 0);
  let release; const gate = new Promise(r => { release = r; });
  const g = fixture({ authenticate: async () => { await gate; return true; } });
  const u = g.owner.prepare('payment', payment()); const pending = g.owner.approveAndSign(u.id);
  g.time(u.expiresAt); release(); assert.equal(await pending, 'expired'); assert.equal(g.counts().vaultCalls, 0);
});
test('인증 예외·truthy 위조 승인·시간 역행 거부', async () => {
  for (const authenticate of [async () => { throw Error('private-error-body'); }, async () => 'true', async () => ({ approved: true })]) {
    const f = fixture({ authenticate }); const t = f.owner.prepare('payment', payment());
    assert.equal(await f.owner.approveAndSign(t.id), 'failed'); assert.equal(f.counts().vaultCalls, 0);
  }
  const f = fixture({ authenticate: async () => { f.time(start - 1); return true; } });
  const t = f.owner.prepare('payment', payment()); assert.equal(await f.owner.approveAndSign(t.id), 'failed');
  assert.equal(f.counts().vaultCalls, 0);
});
test('동시 금고 승인도 잔액 예약 적용', async () => {
  const f = fixture({ vaultBalance: 30n });
  const a = f.owner.prepare('payment', payment()), b = f.owner.prepare('payment', payment());
  const results = await Promise.all([f.owner.approveAndSign(a.id), f.owner.approveAndSign(b.id)]);
  assert.equal(results.filter(s => s === 'signed').length, 1); assert.equal(f.counts().vaultCalls, 1);
});
test('금고 서명 실패·영수증 위조는 실패 상태 및 예약 유지', async () => {
  for (const sign of [async () => { throw Error('private-error-body'); }, async () => ({ kind: 'mock-signature', requestId: 'different' })]) {
    const f = fixture({ vaultSigner: { mode: 'mock', sign } }); const t = f.owner.prepare('payment', payment());
    assert.equal(await f.owner.approveAndSign(t.id), 'failed'); assert.equal(f.owner.watch().available, 979n);
    await deny(() => f.owner.approveAndSign(t.id));
  }
});
test('금액 타입·음수·0·주소·정책 검증', async () => {
  const f = fixture();
  for (const p of [payment(0n), payment(-1n), payment(1n, -1n), payment(1), payment(1n, 0n, '<script>'), null]) await deny(() => f.hot.pay(p));
  for (const p of [{ ...policy, daily: -1n }, { ...policy, perPayment: 151n }, { ...policy, utcOffsetMinutes: 841 }])
    assert.throws(() => fixture({ policy: p }));
  assert.throws(() => fixture({ hotBalance: -1n }));
  assert.throws(() => fixture({ hotAddress: 'mock:vault' }));
});
test('BigInt 정밀도·0 한도·자정 예약 이월', async () => {
  const huge = 10n ** 25n;
  const f = fixture({ policy: { ...policy, perPayment: huge, daily: huge }, hotBalance: huge });
  assert.equal((await f.hot.pay(payment(huge - 1n))).status, 'signed'); assert.equal(f.hot.snapshot().remainingToday, 0n);
  assert.equal((await fixture({ policy: { ...policy, perPayment: 0n } }).hot.pay(payment())).reason, 'per_payment');
  const g = fixture(); await g.hot.pay(payment()); g.time(start + 1000);
  assert.equal(g.hot.snapshot().available, 979n); assert.equal(g.hot.snapshot().spentToday, 0n);
});
test('설정·요청·capability 변조 방어', async () => {
  const f = fixture(); f.options.policy.perPayment = 9999n; f.options.network = 'mainnet';
  assert.equal((await f.hot.pay(payment(101n))).reason, 'per_payment');
  const p = payment(); const t = f.owner.prepare('payment', p); p.amount = 999n;
  assert.equal(t.amount, 20n); assert.throws(() => { t.to = 'mock:other'; });
  assert.throws(() => { f.hot.approveAndSign = () => {}; });
});
test('메인넷·실서명기 런타임 차단·테스트넷도 모의만', async () => {
  assert.throws(() => fixture({ network: 'mainnet' }), /SANDBOX_ONLY/);
  assert.throws(() => fixture({ vaultSigner: { mode: 'hardware', sign() {} } }), /MOCK_SIGNER_ONLY/);
  assert.equal((await fixture({ network: 'testnet' }).hot.pay(payment())).status, 'signed');
});
test('상태 기계 불법 전이·종료 상태 재사용 거부', () => {
  for (const stage of ['signed', 'failed', 'cancelled', 'expired'])
    for (const event of ['authenticate', 'authorize', 'complete', 'fail', 'cancel', 'expire'])
      assert.throws(() => core.transition(stage, event));
  assert.equal(core.transition('review', 'authenticate'), 'authenticating');
  for (const invalid of ['__proto__', 'constructor', 'toString', 'unknown']) {
    assert.throws(() => core.transition(invalid, 'authenticate'));
    assert.throws(() => core.transition('review', invalid));
  }
});
test('순수 코어 결정적 누계 불변식 400회', () => {
  let ledger = core.newLedger(start, policy), available = 1000n, expected = 0n;
  for (let i = 1; i <= 400; i++) {
    const p = payment(BigInt(i % 101 + 1)); const result = core.reserveHot(policy, ledger, available, p, start);
    if (result.decision === 'allow') expected += p.amount + p.fee;
    ledger = result.ledger; available = result.available;
    assert.equal(ledger.spent, expected); assert.ok(expected <= policy.daily); assert.equal(available + expected, 1000n);
  }
});
// TypeScript의 실제 import 해석을 따라 재수출·중간 helper를 통한 금고 유입까지 검사한다.
function dependencies(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), '동적 경로 import 금지'); specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specs.map(s => ts.resolveModuleName(s, path, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule?.resolvedFileName)
    .filter(p => p && p.startsWith(root) && !p.includes('/node_modules/') && /\.[cm]?tsx?$/.test(p));
}
function checkBoundary(entries, deps = dependencies) {
  const seen = new Set();
  function walk(path) {
    if (seen.has(path)) return; seen.add(path);
    assert.ok(!['src/wallet-vault.ts', 'core/wallet-vault.ts'].includes(relative(root, path)), '금고 의존성 금지');
    for (const dep of deps(path)) walk(dep);
  }
  entries.forEach(walk);
}
test('src/ravi-* 전이적 import·재수출 금고 접근 차단', () => {
  const files = readdirSync(resolve(root, 'src')).filter(f => /^ravi-.*\.ts$/.test(f)).map(f => resolve(root, 'src', f));
  checkBoundary(files);
  // 검사기 자체를 우회 경로로 변이 시험: 직접 및 helper를 통한 import 모두 잡아야 한다.
  const entry = resolve(root, 'src/ravi-wallet.ts'), helper = resolve(root, 'src/fictional-helper.ts'), vault = resolve(root, 'src/wallet-vault.ts');
  assert.throws(() => checkBoundary([entry], p => p === entry ? [vault] : []));
  assert.throws(() => checkBoundary([entry], p => p === entry ? [helper] : p === helper ? [vault] : []));
  for (const p of ['core/wallet-hot.ts', 'core/wallet-vault.ts', 'src/wallet-vault.ts', 'src/ravi-wallet.ts'])
    assert.doesNotMatch(readFileSync(p, 'utf8'), /\b(?:fetch|invoke|localStorage|sessionStorage|console|eval)\s*[.(]/);
});
test('타입 경계: AI·게임 포트에 금고·시드·범용 호출 없음', () => {
  const path = resolve(root, 'scripts/__wallet_vault_typecheck__.ts');
  const source = `import type { HotWalletPort } from '../core/wallet-hot';
import type { VaultSigner } from '../src/wallet-vault';
import { createRaviWalletTools } from '../src/ravi-wallet';
declare const hot: HotWalletPort; declare const signer: VaultSigner;
// @ts-expect-error 금고 승인 권한 없음
hot.approveAndSign('id');
// @ts-expect-error 금고 조회 권한 없음
hot.watch();
// @ts-expect-error 금고 source 선택 불가
hot.pay({ to: 'mock:x', amount: 1n, fee: 0n, source: 'vault' });
// @ts-expect-error 시드 API 없음
signer.seed();
// @ts-expect-error AI 명령 허용목록
createRaviWalletTools(hot).call('vault_sign');
// @ts-expect-error 핫 타입만 받음
createRaviWalletTools(signer);
`;
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true };
  const host = ts.createCompilerHost(options), getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, ...rest) => file === path ? ts.createSourceFile(file, source, language, true) : getSource(file, language, ...rest);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([path], options, host));
  assert.equal(diagnostics.length, 0, '타입 또는 @ts-expect-error 경계 실패');
});
test('4개 언어의 동일 문구 키·자리표시자', () => {
  const copy = JSON.parse(readFileSync('docs/cold-hot-wallet-copy.json', 'utf8'));
  assert.equal(Object.keys(copy).sort().join(','), 'en,ja,ko,zh');
  for (const lang of ['en', 'ja', 'zh']) {
    assert.deepEqual(Object.keys(copy[lang]).sort(), Object.keys(copy.ko).sort());
    for (const key of Object.keys(copy.ko)) {
      assert.ok(typeof copy[lang][key] === 'string' && copy[lang][key].length > 0);
      assert.deepEqual(copy[lang][key].match(/\{\w+\}/g) ?? [], copy.ko[key].match(/\{\w+\}/g) ?? []);
    }
  }
});
let failed = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch { failed++; console.error(`FAIL ${name}`); }
}
console.log(`wallet-vault: ${cases.length - failed}/${cases.length} 통과 (모의 서명만, 네트워크 없음)`);
if (failed) process.exitCode = 1;
