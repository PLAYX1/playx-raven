// 미니 창 입금 감지 — **regtest(가짜 사슬)** 노드로 실제 지연과 커서 의미를 잰다. 메인넷·실제 지갑 없음.
//
// 쓰는 법: node scripts/mini-regtest-latency.mjs [ravend 가 있는 폴더]
//   기본 폴더는 /Applications/Raven-Qt.app/Contents/MacOS (ravend·raven-cli).
//   임시 datadir(운영체제 임시 폴더) · 포트 임의 · -listen=0 -connect=0(밖과 연결 안 함) · 끝나면 그 노드만 stop.
//
// 재는 것(mini_watch.rs 와 같은 질문·같은 주기):
//   ① 0확인 입금이 listsinceblock(cursor, need, true) 에 나타나기까지 걸린 시간 (주기 15초)
//   ② 같은 줄이 need 확인에 닿을 때까지 **다시 보고되는가**(lastblock 의미) — 「입금 확인됨」의 근거
//   ③ 🔴 지갑을 **암호화·잠근 상태**에서도 입금이 감지되는가
// 결과: artifacts/claude-mini/regtest-latency.json
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const BIN = process.argv[2] || '/Applications/Raven-Qt.app/Contents/MacOS';
const dir = mkdtempSync(join(tmpdir(), 'rv-mini-regtest-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = ['-regtest', `-datadir=${dir}`, `-rpcport=${port}`];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PERIOD = Number(process.env.MINI_PERIOD_MS || 15000);
const NEED = 3;

const cli = (wallet, ...args) => {
  const out = execFileSync(join(BIN, 'raven-cli'), [...base, ...(wallet ? [`-rpcwallet=${wallet}`] : []), ...args.map(String)], { encoding: 'utf8' }).trim();
  try { return JSON.parse(out); } catch { return out; }
};
let node;
async function start() {
  node = spawn(join(BIN, 'ravend'), [...base, '-server', '-listen=0', '-connect=0', '-dnsseed=0', '-wallet=payer', '-wallet=shop', '-fallbackfee=0.01', '-printtoconsole=0'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { execFileSync(join(BIN, 'raven-cli'), [...base, 'getblockcount'], { stdio: 'ignore' }); return; } catch { await sleep(500); } }
  throw new Error('ravend 가 뜨지 않음');
}
async function stop() {
  try { execFileSync(join(BIN, 'raven-cli'), [...base, 'stop'], { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 60 && node.exitCode === null; i++) await sleep(500);
}

const rowsOf = (v) => [...(v.transactions || []), ...(v.asset_transactions || [])].filter((t) => t.category === 'receive');
const result = { period_ms: PERIOD, need: NEED, trials: [], reconfirm: null, locked: null, node: null };
try {
  await start();
  result.node = cli(null, 'getnetworkinfo').subversion;
  const payerAddr = cli('payer', 'getnewaddress');
  cli('payer', 'generatetoaddress', 110, payerAddr);

  // ③ 먼저 잠근다: shop 지갑 암호화(노드가 내려감) → 다시 켬 → 잠긴 상태 확인.
  try { execFileSync(join(BIN, 'raven-cli'), [...base, '-rpcwallet=shop', 'encryptwallet', 'synthetic-regtest-only'], { stdio: 'ignore' }); } catch {}
  await sleep(1500); await stop(); await start();
  const info = cli('shop', 'getwalletinfo');
  assert.equal(info.unlocked_until, 0, 'shop 지갑이 잠겨 있어야 한다');

  // 기준선(mini_watch 와 같다)
  const h = cli(null, 'getblockcount');
  let cursor = cli(null, 'getblockhash', Math.max(0, h - 1600));
  const seen = new Set();
  const poll = () => { const v = cli('shop', 'listsinceblock', cursor, NEED, true); cursor = v.lastblock; return rowsOf(v); };
  for (const r of poll()) seen.add(`${r.txid}:${r.vout}`);

  // ① 0확인 감지 지연 — 주기 위상을 흩어 세 번
  for (let i = 0; i < 3; i++) {
    const shopAddr = cli('shop', 'getnewaddress'); // 잠겨 있어도 키풀에서 주소는 나온다
    const offset = Math.floor(Math.random() * PERIOD);
    await sleep(offset);
    const t0 = Date.now();
    const txid = cli('payer', 'sendtoaddress', shopAddr, 1.25 + i);
    let detected = null, polls = 0;
    // 다음 주기 경계에 맞춰 돈다(실제 watcher 는 고정 15초)
    while (detected === null && polls < 10) {
      await sleep(PERIOD - ((Date.now() - t0 + (PERIOD - offset)) % PERIOD));
      polls++;
      const hit = poll().find((r) => r.txid === txid && !seen.has(`${r.txid}:${r.vout}`));
      if (hit) { detected = Date.now() - t0; seen.add(`${hit.txid}:${hit.vout}`); assert.equal(hit.confirmations, 0); }
    }
    result.trials.push({ detected_ms: detected, polls, wait_to_next_poll_ms: offset });
  }

  // ② need=3 까지 같은 줄이 다시 나오는가
  const shopAddr = cli('shop', 'getnewaddress');
  const txid = cli('payer', 'sendtoaddress', shopAddr, 9);
  const confs = [];
  confs.push(poll().find((r) => r.txid === txid)?.confirmations ?? null);
  for (let b = 0; b < 4; b++) {
    cli('payer', 'generatetoaddress', 1, payerAddr);
    confs.push(poll().find((r) => r.txid === txid)?.confirmations ?? null);
  }
  result.reconfirm = { confirmations_seen_each_poll: confs };
  assert.deepEqual(confs.slice(0, 4), [0, 1, 2, 3], '확인 수가 need 에 닿을 때까지 매번 다시 보고돼야 한다');
  assert.equal(confs[4], null, 'need 를 넘으면 더 안 나온다(부담 없음)');

  result.locked = { wallet_locked: cli('shop', 'getwalletinfo').unlocked_until === 0, detected_while_locked: result.trials.every((t) => t.detected_ms !== null),
    balance_readable_while_locked: typeof cli('shop', 'getbalance') === 'number' };
} finally {
  if (node) await stop();
  rmSync(dir, { recursive: true, force: true });
}
const out = resolve(import.meta.dirname, '../artifacts/claude-mini');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'regtest-latency.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
