// 0.4.9 — 「12단어로 지갑 되살리기」 같은 단어 → 같은 주소 증명.
//
// 세 겹으로 본다. 앞의 것은 언제나 돌고, 뒤의 둘은 재료가 있을 때만 돈다(없으면 SKIP 이라고 적는다).
//   A. 표(scripts/fixtures/restore-vectors.json)와 단어 목록이 공식 값과 맞는가 — 늘.
//      러스트(src-tauri/src/words.rs `addresses_match_phone_fixture`)가 같은 표로 한 글자까지 대조한다.
//   B. 폰·웹 코드(ravenvault/core/wallet-keys)가 지금도 같은 주소를 만드는가 — 코드가 있을 때.
//   C. 레이븐 코어 4.8 이 `-mnemonic` 으로 만든 지갑이 같은 주소를 「내 것」이라 하는가 — ravend 가 있을 때.
//      + regtest 에서 A안(새 지갑 + rescanblockchain)이 옛 거래를 찾고, 시작 옵션 -rescan 은 못 찾는다(생일 함정).
//      + 틀린 단어를 코어에 직접 주면 debug.log 에 적힌다(그래서 앱이 먼저 거른다).
//
// 🔴 공개 시험 벡터 단어만 쓴다. 진짜 RVN·네트워크 없음. 대표님 노드(8766/8767, 기존 datadir)는 건드리지 않는다:
//    새 임시 datadir(/tmp/claude-501/…) · 새 포트 둘 · -listen=0 -connect=0 -dnsseed=0 -maxconnections=0.
//    끝나면 **우리가 띄운 PID 만** 끄고(pkill 없음) 임시 폴더를 지운다.
// 🔴 단어는 화면에 찍지 않는다(이 스크립트 출력에도 주소·경로·개수만 나온다).
//
// 쓰는 법: node scripts/check-restore-vectors.mjs [--write] [--no-core]
//   RAVENVAULT_DIR=<ravenvault 저장소> (기본 ~/ravenvault) · RV_RAVEND=<ravend> (기본 ~/RavencoinBuilds-4.8.0/macos-arm64/ravend)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, renameSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = resolve(root, 'scripts/fixtures/restore-vectors.json');
const WRITE = process.argv.includes('--write');
const NO_CORE = process.argv.includes('--no-core');
const N = 25; // 받기·거스름 각각 — 지시서 「첫 20개 이상」

// 공개 BIP39 시험 벡터(bitcoin/bips · Trezor python-mnemonic vectors.json).
const VECTORS = [
  { name: 'abandon×11 about', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', passphrase: '' },
  { name: 'legal winner … yellow', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', passphrase: '' },
  { name: 'letter advice … above', mnemonic: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', passphrase: '' },
  { name: 'zoo×23 vote (24단어)', mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote', passphrase: '' },
  { name: 'abandon×11 about + 추가 암호 TREZOR', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', passphrase: 'TREZOR' },
];

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; };

// ── A. 단어 목록 · 체크섬(독립 구현) · 표 ─────────────────────────────
const wordsTxt = readFileSync(resolve(root, 'src/bip39-english.txt'), 'utf8');
ok(createHash('sha256').update(wordsTxt).digest('hex') === '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda', '단어 목록이 공식 english.txt 와 같다');
const LIST = wordsTxt.trim().split('\n');
function checksumOk(m) {
  const w = m.split(' ');
  if (![12, 18, 24].includes(w.length)) return false;
  let bits = '';
  for (const x of w) { const i = LIST.indexOf(x); if (i < 0) return false; bits += i.toString(2).padStart(11, '0'); }
  const cs = w.length / 3, ent = bits.slice(0, bits.length - cs);
  const bytes = Buffer.from(ent.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const h = createHash('sha256').update(bytes).digest()[0].toString(2).padStart(8, '0');
  return h.slice(0, cs) === bits.slice(-cs);
}
for (const v of VECTORS) ok(checksumOk(v.mnemonic), `체크섬 통과: ${v.name}`);
ok(!checksumOk('abandon '.repeat(12).trim()), '체크섬 틀린 공개 문장은 거절');

// ── B. 폰·웹 코드로 다시 만들기 ─────────────────────────────────────
const rvDir = process.env.RAVENVAULT_DIR || join(homedir(), 'ravenvault');
const keysDir = join(rvDir, 'core/wallet-keys');
let phone = null;
if (existsSync(join(keysDir, 'derive.ts')) && existsSync(join(rvDir, 'node_modules/@scure/bip32'))) {
  const { build } = await import('esbuild');
  const entry = `import { mnemonicToSeed } from './mnemonic';
import { deriveAddress } from './derive';
export async function run(vectors, n) {
  const out = [];
  for (const v of vectors) {
    const seed = await mnemonicToSeed(v.mnemonic, v.passphrase);
    const receive = [], change = [];
    for (let i = 0; i < n; i++) { receive.push(deriveAddress(seed, { change: 0, index: i }).address); change.push(deriveAddress(seed, { change: 1, index: i }).address); }
    seed.fill(0);
    out.push({ name: v.name, mnemonic: v.mnemonic, passphrase: v.passphrase, receive, change });
  }
  return out;
}`;
  // cjs 로 묶어 임시 파일에서 읽는다(폰 코드가 node:crypto 를 require 로 부른다 — data: ESM 에서는 못 부른다).
  const tmp = `/tmp/claude-501/rv049-phone-${process.pid}.cjs`;
  mkdirSync('/tmp/claude-501', { recursive: true });
  await build({ stdin: { contents: entry, resolveDir: keysDir, loader: 'ts', sourcefile: 'restore-vectors-entry.ts' }, bundle: true, outfile: tmp, platform: 'node', format: 'cjs', logLevel: 'silent' });
  try { phone = await createRequire(import.meta.url)(tmp).run(VECTORS, N); } finally { rmSync(tmp, { force: true }); }
}
if (WRITE) {
  assert.ok(phone, '--write 는 폰·웹 코드가 있어야 한다(RAVENVAULT_DIR)');
  mkdirSync(resolve(root, 'scripts/fixtures'), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify({
    note: '공개 BIP39 시험 벡터만. 주소는 ravenvault/core/wallet-keys(derive.ts · mnemonic.ts)가 만든 값이다. 경로 받기 m/44\'/175\'/0\'/0/i · 거스름 m/44\'/175\'/0\'/1/i. 진짜 지갑 자료 없음.',
    count: N, vectors: phone,
  }, null, 1) + '\n');
  console.log(`WROTE ${FIXTURE}`);
}
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
ok(fixture.vectors.length === VECTORS.length, '표의 벡터 수');
for (const [i, v] of fixture.vectors.entries()) {
  ok(v.mnemonic === VECTORS[i].mnemonic && v.passphrase === VECTORS[i].passphrase, `표의 벡터가 공개 벡터 그대로: ${v.name}`);
  ok(v.receive.length >= 20 && v.change.length >= 20, `받기·거스름 20개 이상: ${v.name}`);
  ok([...v.receive, ...v.change].every((a) => /^R[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)), `메인넷 R 주소: ${v.name}`);
  ok(new Set([...v.receive, ...v.change]).size === v.receive.length + v.change.length, `주소가 서로 다름: ${v.name}`);
}
ok(fixture.vectors[0].receive[0] !== fixture.vectors[4].receive[0], '추가 암호가 있으면 다른 지갑');
if (phone) {
  assert.deepEqual(phone.map(({ receive, change }) => ({ receive, change })), fixture.vectors.map(({ receive, change }) => ({ receive, change })), '폰·웹 코드가 표와 다른 주소를 만든다');
  pass++;
  console.log(`PASS B 폰·웹 코드(${keysDir}) = 표 — 벡터 ${phone.length}개 × 받기 ${N} · 거스름 ${N}`);
} else console.log(`SKIP B 폰·웹 코드 없음(${keysDir}) — 표와 러스트 대조만 유효`);

// ── C. 레이븐 코어 4.8 (격리) ─────────────────────────────────────────
const ravend = process.env.RV_RAVEND || join(homedir(), 'RavencoinBuilds-4.8.0/macos-arm64/ravend');
const table = [];
if (NO_CORE || !existsSync(ravend) || process.platform === 'win32') {
  console.log(`SKIP C 레이븐 코어 없음 또는 --no-core (${ravend})`);
} else {
  const base = '/tmp/claude-501';
  mkdirSync(base, { recursive: true });
  const DONT = new Set([8766, 8767, 18766, 18767, 18443, 18444]);
  async function freePort() {
    for (let k = 0; k < 200; k++) {
      const p = 39000 + Math.floor(Math.random() * 900);
      if (DONT.has(p)) continue;
      const free = await new Promise((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
      if (free) return p;
    }
    throw new Error('빈 포트를 못 찾았다');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 격리 노드 하나. 단어는 FIFO 로만 건넨다(명령줄에 안 들어간다) — 앱과 같은 통로. */
  async function startNode({ dir, words, pass: pp, extra = [], regtest = false }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const port = await freePort(), rpcport = await freePort();
    const args = [`-datadir=${dir}`, '-server=1', '-listen=0', '-connect=0', '-dnsseed=0', '-upnp=0', '-discover=0', '-maxconnections=0',
      `-port=${port}`, `-rpcport=${rpcport}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-printtoconsole=0', ...(regtest ? ['-regtest'] : []), ...extra];
    let fifo = null, pipeDir = null;
    if (words !== undefined) {
      pipeDir = `${dir}-pipe`;
      mkdirSync(pipeDir, { recursive: true, mode: 0o700 });
      fifo = join(pipeDir, 'c.conf');
      execFileSync('mkfifo', ['-m', '600', fifo]);
      args.push(`-conf=${fifo}`);
    }
    const child = spawn(ravend, args, { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    if (fifo) {
      const fh = await openFile(fifo, 'w'); // 노드가 읽으러 열 때까지 기다린다
      await fh.writeFile(`mnemonic=${words}\n${pp ? `mnemonicpassphrase=${pp}\n` : ''}bip44=1\n`);
      await fh.close();
      rmSync(pipeDir, { recursive: true, force: true });
    }
    return { dir, child, exited, rpcport, pid: child.pid, argv: args, net: regtest ? 'regtest' : 'main' };
  }
  async function rpc(node, method, params = [], timeoutMs = 20000) {
    const cookieFile = join(node.dir, node.net === 'regtest' ? 'regtest/.cookie' : '.cookie');
    const cookie = readFileSync(cookieFile, 'utf8').trim();
    const ctl = AbortSignal.timeout(timeoutMs);
    const r = await fetch(`http://127.0.0.1:${node.rpcport}/`, { method: 'POST', signal: ctl, headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'vec', method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
    return j.result;
  }
  async function ready(node, ms = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (node.child.exitCode !== null) throw new Error(`노드가 먼저 끝났다(코드 ${node.child.exitCode})`);
      try { await rpc(node, 'getwalletinfo'); return; } catch { await sleep(700); }
    }
    throw new Error('노드가 180초 안에 답하지 않았다');
  }
  async function stopNode(node) {
    try { await rpc(node, 'stop'); } catch { /* 이미 꺼짐 */ }
    const done = await Promise.race([node.exited, sleep(90000).then(() => 'timeout')]);
    if (done === 'timeout') { process.kill(node.pid, 'SIGTERM'); await Promise.race([node.exited, sleep(20000)]); }
  }
  /** 폴더 안 모든 파일에서 문장을 찾는다(wallet.dat 은 따로 센다 — 코어가 평문으로 담는다, 설계서 F9). */
  function traces(dir, needles) {
    const hits = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (s.size < 256 * 1024 * 1024) { const b = readFileSync(p); for (const x of needles) if (b.includes(Buffer.from(x))) hits.push(p.slice(dir.length + 1)); } } };
    walk(dir);
    return [...new Set(hits)];
  }
  function processLines(needles) {
    const ps = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return ps.split('\n').filter((l) => needles.some((x) => l.includes(x)) && !l.includes('check-restore-vectors'));
  }

  const made = [];
  try {
    // C1 — 벡터마다 메인넷 격리 노드에 단어로 지갑을 만들고 같은 주소인지 묻는다.
    for (const [i, v] of fixture.vectors.entries()) {
      const dir = `${base}/rv049-vec-${process.pid}-${i}`;
      made.push(dir);
      const node = await startNode({ dir, words: v.mnemonic, pass: v.passphrase });
      await ready(node);
      const psHits = processLines([v.mnemonic, v.mnemonic.split(' ').slice(0, 3).join(' '), 'mnemonic']);
      ok(node.argv.every((a) => !a.includes(v.mnemonic.split(' ')[1]) || a.startsWith('-datadir')), `명령줄에 단어 없음: ${v.name}`);
      ok(psHits.length === 0, `프로세스 목록에 단어 없음: ${v.name}`);
      const info = await rpc(node, 'getwalletinfo');
      ok(!!info.hdseedid, `HD 지갑: ${v.name}`);
      let recvOk = 0, chgOk = 0;
      for (const [c, list] of [[0, v.receive], [1, v.change]]) {
        for (const [k, addr] of list.entries()) {
          const va = await rpc(node, 'validateaddress', [addr]);
          const want = `m/44'/175'/0'/${c}/${k}`;
          assert.ok(va.ismine === true, `코어가 폰 주소를 내 것이라 하지 않는다: ${v.name} ${want}`);
          assert.equal(va.hdkeypath, want, `경로가 다르다: ${v.name}`);
          c === 0 ? recvOk++ : chgOk++;
        }
      }
      pass += recvOk + chgOk;
      // 코어가 주는 새 주소 순서도 표 안에 있어야 한다(받기·거스름).
      const newRecv = [], newChg = [];
      for (let k = 0; k < 21; k++) newRecv.push(await rpc(node, 'getnewaddress'));
      for (let k = 0; k < 21; k++) newChg.push(await rpc(node, 'getrawchangeaddress'));
      ok(newRecv.every((a) => v.receive.includes(a)), `getnewaddress 가 표의 받기 주소를 준다: ${v.name}`);
      ok(newChg.every((a) => v.change.includes(a)), `getrawchangeaddress 가 표의 거스름 주소를 준다: ${v.name}`);
      const words = await rpc(node, 'getmywords');
      ok(words.word_list === v.mnemonic && (words.passphrase || '') === v.passphrase, `「복구 단어 보기」가 같은 단어: ${v.name}`);
      await stopNode(node);
      const found = traces(dir, [v.mnemonic, `mnemonic=`]);
      ok(found.every((f) => f === 'wallet.dat'), `wallet.dat 밖에 단어 흔적 없음(${found.join(',') || '없음'}): ${v.name}`);
      ok(!existsSync(`${dir}-pipe`), `통로(FIFO)가 남지 않음: ${v.name}`);
      table.push({ vector: v.name, receive: `${recvOk}/${v.receive.length}`, change: `${chgOk}/${v.change.length}`, getnewaddress: `${newRecv.map((a) => v.receive.indexOf(a)).join(',')}`, first: v.receive[0] });
    }

    // C2 — regtest: A안(새 지갑 + rescanblockchain)이 옛 거래를 찾는다 · 시작 -rescan 은 못 찾는다(F11).
    //   regtest 는 코인 번호 1(주소 m/n 접두)이라 주소 비교가 아니라 「돈이 다시 보이나」만 본다.
    {
      const v = fixture.vectors[1];
      const dir = `${base}/rv049-regtest-${process.pid}`;
      made.push(dir);
      const t0 = Math.floor(Date.now() / 1000) - 40 * 86400;
      let a = await startNode({ dir, words: v.mnemonic, pass: '', regtest: true, extra: [`-mocktime=${t0}`] });
      await ready(a);
      const to = await rpc(a, 'getnewaddress');
      await rpc(a, 'generatetoaddress', [110, to], 120000).catch(async () => rpc(a, 'generate', [110], 120000));
      const before = await rpc(a, 'getwalletinfo');
      ok(before.txcount >= 110, `regtest 지갑 W 에 거래 ${before.txcount}건`);
      await stopNode(a);
      // 옆에 두기(이름만 바꾼다 — 앱과 같다).
      renameSync(join(dir, 'regtest/wallet.dat'), join(dir, 'regtest/wallet.dat.before-words-test'));
      // R2: 30일 뒤 같은 단어 + 시작 옵션 -rescan → 생일 함정.
      const later = t0 + 30 * 86400;
      let b = await startNode({ dir, words: v.mnemonic, pass: '', regtest: true, extra: [`-mocktime=${later}`, '-rescan'] });
      await ready(b);
      const trap = await rpc(b, 'getwalletinfo');
      ok(trap.txcount === 0, `생일 함정 재현: 시작 -rescan 은 옛 거래 ${trap.txcount}건만 찾는다(F11)`);
      // R1: rescanblockchain 은 생일을 안 본다.
      const r = await rpc(b, 'rescanblockchain', [], 300000);
      const after = await rpc(b, 'getwalletinfo');
      ok(after.txcount === before.txcount, `rescanblockchain 뒤 거래 ${after.txcount}/${before.txcount}건 (높이 ${r.start_height}→${r.stop_height})`);
      ok(Math.abs((after.balance + after.immature_balance) - (before.balance + before.immature_balance)) < 1e-8, '잔액(성숙+미성숙)이 되살아남');
      await stopNode(b);
      table.push({ vector: `${v.name} · regtest`, rescan: `-rescan ${trap.txcount}건 → rescanblockchain ${after.txcount}건 = W ${before.txcount}건` });
    }

    // C3 — 틀린 단어를 코어에 **직접** 주면 debug.log 에 단어 전체가 적힌다(F7). 그래서 앱이 먼저 거른다.
    {
      const dir = `${base}/rv049-bad-${process.pid}`;
      made.push(dir);
      const bad = 'abandon '.repeat(12).trim();
      const n = await startNode({ dir, words: bad, pass: '' });
      const code = await Promise.race([n.exited, sleep(120000).then(() => 'timeout')]);
      if (code === 'timeout') await stopNode(n);
      const log = existsSync(join(dir, 'debug.log')) ? readFileSync(join(dir, 'debug.log'), 'utf8') : '';
      ok(/invalid mnemonic/.test(log) && log.includes(bad), 'F7 재현: 체크섬 틀린 단어를 받은 코어는 debug.log 에 단어 전체를 적는다');
      table.push({ vector: 'abandon×12 (체크섬 틀림, 공개)', f7: `노드 종료 코드 ${code} · debug.log 에 단어 기록됨 → 앱은 노드에 넘기기 전에 거른다` });
    }
  } finally {
    for (const d of made) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}-pipe`, { recursive: true, force: true }); }
  }
  console.log('PASS C 레이븐 코어 4.8 격리 노드(네트워크 끔 · 새 포트 · 임시 datadir 지움)');
  for (const row of table) console.log('  ' + JSON.stringify(row));
}
console.log(`PASS restore vectors — ${pass} checks`);
