#!/usr/bin/env node
// 우체국(릴레이) 부하 시험 — 11-28 「PLAY X 챗이 1만~2만 명에서도 빨라야 한다」.
//
// 연결 N 개를 열고, 각 연결이 자기 받는 사람 열쇠(#p)로 겉봉(kind 1059)을 듣는다.
// 그중 일부(--senders)가 초당 --rate 통의 겉봉(--size 바이트, 실제 NIP-17 겉봉 크기)을 남에게 보낸다.
// 재는 것: 붙기·구독(EOSE)·받았음(OK)·배달(받는 연결에 EVENT 가 닿기까지) 지연 p50/p95/p99, 오류.
//
// 🔴 이 컴퓨터의 시험 릴레이(localhost)에만 쏜다. 바깥 주소는 --allow-remote 없이는 거절한다
//    (남의 릴레이·운영 우체국을 부하로 두드리지 않게).
//
// 시험 릴레이 켜기(같은 컴퓨터, 다른 창):
//   cd src-tauri && RV_BENCH_PORT=18790 RV_BENCH_SECS=300 cargo test --release --lib relay_bench_server -- --ignored --nocapture
// 쏘기:
//   node scripts/relay-loadtest.mjs --url ws://127.0.0.1:18790/r --clients 2000 --senders 200 --rate 200 --duration 30
// 두 핵심 우체국(맞추기) 사이 배달: --deliver-url 에 둘째 릴레이 — 보내기는 --url, 듣기는 --deliver-url.
//
// 필요한 것: Node 22+(내장 WebSocket) 또는 `ws` 꾸러미 · `@noble/curves`(저장소 의존성).
//   꾸러미를 다른 곳에 깔았으면 RV_LT_MODULES=<그 node_modules 경로>.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = all[i + 1];
      acc.push([k, next && !next.startsWith("--") ? next : "true"]);
    }
    return acc;
  }, []),
);
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
const URL_SEND = args.url || "ws://127.0.0.1:18790/r";
const URL_DELIVER = args["deliver-url"] || URL_SEND;
const CLIENTS = num("clients", 500);
const SENDERS = Math.min(num("senders", Math.max(1, Math.ceil(CLIENTS / 10))), CLIENTS);
const RATE = num("rate", 50); // 초당 겉봉
const DURATION = num("duration", 20); // 초
const SIZE = num("size", 1500); // 겉봉 content 바이트(NIP-17 짧은 쪽지 겉봉 ≈ 1.2~2KB)
const CONNECT_PER_SEC = num("connect-rate", 1000);
const SETTLE = num("settle", 5); // 보내기가 끝난 뒤 배달을 기다리는 초

function isLocal(u) {
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}
for (const u of [URL_SEND, URL_DELIVER]) {
  if (!isLocal(u) && args["allow-remote"] !== "true") {
    console.error(`거절: ${u} 는 이 컴퓨터가 아닙니다. 남의 릴레이를 두드리지 않습니다(정말이면 --allow-remote).`);
    process.exit(2);
  }
}

const req = createRequire(process.env.RV_LT_MODULES ? path.join(process.env.RV_LT_MODULES, "x.js") : import.meta.url);
let WS = globalThis.WebSocket;
try {
  WS = req("ws");
} catch {
  /* 내장 WebSocket */
}
if (!WS) {
  console.error("WebSocket 이 없습니다: Node 22+ 를 쓰거나 `npm i ws` 하세요.");
  process.exit(2);
}
const { schnorr } = req("@noble/curves/secp256k1");
const { sha256 } = req("@noble/hashes/sha256");
const hex = (b) => Buffer.from(b).toString("hex");

function signWrap(to, content, at) {
  const sk = randomBytes(32);
  const pk = hex(schnorr.getPublicKey(sk));
  const tags = [["p", to]];
  const pre = JSON.stringify([0, pk, at, 1059, tags, content]);
  const id = sha256(new TextEncoder().encode(pre));
  return { id: hex(id), pubkey: pk, created_at: at, kind: 1059, tags, content, sig: hex(schnorr.sign(id, sk)) };
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};
const sum = (name, arr) => `${name}: n=${arr.length} p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms p99=${pct(arr, 99)}ms max=${pct(arr, 100)}ms`;
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { connectErr: 0, closed: 0, okFalse: {}, notices: {}, connect: [], eose: [], ok: [], deliver: [] };
const sentAt = new Map(); // id → 보낸 시각
const delivered = new Set();

function open(url) {
  return new Promise((resolve) => {
    const t0 = now();
    let done = false;
    const ws = new WS(url);
    const fail = () => {
      if (!done) {
        done = true;
        stats.connectErr++;
        resolve(null);
      }
    };
    const timer = setTimeout(fail, 15000);
    ws.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stats.connect.push(now() - t0);
      resolve(ws);
    };
    ws.onerror = fail;
    ws.onclose = () => {
      stats.closed++;
      fail();
    };
  });
}

async function main() {
  const start = Math.floor(Date.now() / 1000);
  console.log(`[lt] 보내기 ${URL_SEND} · 듣기 ${URL_DELIVER} · 연결 ${CLIENTS} · 보내는 연결 ${SENDERS} · 초당 ${RATE}통 · ${DURATION}초 · ${SIZE}B`);
  // 미리 서명(시험 중에 CPU 를 서명에 쓰지 않게).
  const total = Math.ceil(RATE * DURATION);
  const keys = Array.from({ length: CLIENTS }, () => hex(randomBytes(32)));
  const body = randomBytes(Math.ceil((SIZE * 3) / 4)).toString("base64").slice(0, SIZE);
  const t0 = now();
  const events = [];
  for (let i = 0; i < total; i++) {
    const to = keys[(i * 7919) % CLIENTS];
    events.push(signWrap(to, body.slice(0, SIZE - 12) + String(i).padStart(12, "0"), start));
  }
  console.log(`[lt] 겉봉 ${total}통 서명 ${Math.round(now() - t0)}ms`);

  // 듣는 연결: 받는 사람마다 하나.
  const listeners = [];
  const batch = Math.max(1, Math.floor(CONNECT_PER_SEC / 10));
  for (let i = 0; i < CLIENTS; i += batch) {
    const part = await Promise.all(keys.slice(i, i + batch).map(() => open(URL_DELIVER)));
    listeners.push(...part);
    await sleep(100);
  }
  const live = listeners.filter(Boolean).length;
  console.log(`[lt] 붙은 연결 ${live}/${CLIENTS} · 실패 ${stats.connectErr}`);
  await Promise.all(
    listeners.map(
      (ws, i) =>
        new Promise((resolve) => {
          if (!ws) return resolve();
          const t = now();
          const sub = "s" + i;
          let eosed = false;
          const timer = setTimeout(resolve, 20000);
          ws.onmessage = (m) => {
            let v;
            try {
              v = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
            } catch {
              return;
            }
            if (v[0] === "EOSE" && v[1] === sub && !eosed) {
              eosed = true;
              stats.eose.push(now() - t);
              clearTimeout(timer);
              resolve();
            } else if (v[0] === "EVENT" && v[2] && sentAt.has(v[2].id) && !delivered.has(v[2].id)) {
              delivered.add(v[2].id);
              stats.deliver.push(now() - sentAt.get(v[2].id));
            } else if (v[0] === "NOTICE") {
              stats.notices[v[1]] = (stats.notices[v[1]] || 0) + 1;
            }
          };
          ws.send(JSON.stringify(["REQ", sub, { kinds: [1059], "#p": [keys[i]], since: start }]));
        }),
    ),
  );
  console.log(`[lt] ${sum("구독 EOSE", stats.eose)}`);

  // 보내는 연결: 듣는 연결과 따로(다른 컴퓨터의 폰처럼). 보낸 연결에 OK 가 오기까지도 잰다.
  const senders = (await Promise.all(Array.from({ length: SENDERS }, () => open(URL_SEND)))).filter(Boolean);
  const okWait = new Map();
  for (const ws of senders) {
    ws.onmessage = (m) => {
      let v;
      try {
        v = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      } catch {
        return;
      }
      if (v[0] === "OK") {
        const t = okWait.get(v[1]);
        if (t !== undefined) {
          okWait.delete(v[1]);
          if (v[2] === true) stats.ok.push(now() - t);
          else stats.okFalse[String(v[3]).split(":")[0]] = (stats.okFalse[String(v[3]).split(":")[0]] || 0) + 1;
        }
      }
    };
  }
  const per = 1000 / RATE;
  const tStart = now();
  for (let i = 0; i < events.length; i++) {
    const due = tStart + i * per;
    const wait = due - now();
    if (wait > 1) await sleep(wait);
    const e = events[i];
    const ws = senders[i % senders.length];
    if (!ws || ws.readyState !== 1) continue;
    const t = now();
    sentAt.set(e.id, t);
    okWait.set(e.id, t);
    ws.send(JSON.stringify(["EVENT", e]));
  }
  const sendSecs = (now() - tStart) / 1000;
  await sleep(SETTLE * 1000);
  const okN = stats.ok.length;
  console.log(`[lt] 보냄 ${sentAt.size}통 / ${sendSecs.toFixed(1)}초 (실제 초당 ${(sentAt.size / sendSecs).toFixed(0)})`);
  console.log(`[lt] ${sum("받았음 OK", stats.ok)}`);
  console.log(`[lt] ${sum("배달", stats.deliver)}`);
  console.log(`[lt] 배달률 ${((delivered.size / Math.max(1, okN)) * 100).toFixed(2)}% (${delivered.size}/${okN} OK) · OK 거절 ${JSON.stringify(stats.okFalse)} · 답 없음 ${okWait.size} · 끊김 ${stats.closed} · 알림 ${JSON.stringify(stats.notices)}`);
  const out = {
    url: URL_SEND, deliver_url: URL_DELIVER, clients: CLIENTS, connected: live, senders: senders.length, rate: RATE, duration: DURATION, size: SIZE,
    sent: sentAt.size, ok: okN, delivered: delivered.size, ok_false: stats.okFalse, no_answer: okWait.size,
    connect_ms: { p50: pct(stats.connect, 50), p95: pct(stats.connect, 95) },
    eose_ms: { p50: pct(stats.eose, 50), p95: pct(stats.eose, 95), p99: pct(stats.eose, 99) },
    ok_ms: { p50: pct(stats.ok, 50), p95: pct(stats.ok, 95), p99: pct(stats.ok, 99) },
    deliver_ms: { p50: pct(stats.deliver, 50), p95: pct(stats.deliver, 95), p99: pct(stats.deliver, 99) },
  };
  console.log("[lt] JSON " + JSON.stringify(out));
  for (const ws of [...listeners, ...senders]) {
    try {
      ws && ws.close();
    } catch {
      /* 끝 */
    }
  }
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
