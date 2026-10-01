// 가게 지도 이벤트 형식 왕복 검사 — 서명 생성 → **폰과 같은 규칙**으로 검증.
//
//   node scripts/check-merchant-map.mjs [러스트가_만든_이벤트.json]
//
// ① 폰 문서(MERCHANT-EVENT-FORMAT.md §4)의 시험 벡터를 데스크톱과 같은 규칙(map_format.rs 와 같은
//    서명 대상 배열·content 키 순서)으로 다시 만들어, 안쪽 서명·이벤트 id 가 한 글자까지 같은지 본다.
// ② 폰 검증 규칙(겉 schnorr 서명·id, 안쪽 레이븐코인 서명, pubkey→주소 == issuer, d/t/g 태그,
//    5자리 동네, 필드 규칙, 10분 미래 거절)으로 ①과 러스트 이벤트를 검사한다.
//    러스트 이벤트: `MAP_CROSSCHECK_OUT=/tmp/map-events.json cargo test map_format` 이 쓴다.
// ③ RV_PHONE_DIR=폰 저장소 경로 를 주면 **폰의 실제 코드**(core/market/merchants/relay.ts)로도 검사한다.
// 네트워크·노드·지갑 없음.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

const root = fileURLToPath(new URL('../', import.meta.url));
const V = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/merchant-map-vectors.json'), 'utf8'));
const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// ── 레이븐코인 메시지 서명(폰 crypto.ts 와 같은 정의) ──
function varint(n) { return n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]; }
function rvnHash(msg) {
  const magic = enc.encode('Raven Signed Message:\n'), m = enc.encode(msg);
  return sha256(sha256(Uint8Array.from([...varint(magic.length), ...magic, ...varint(m.length), ...m])));
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58check(version, payload) {
  const data = Uint8Array.from([version, ...payload]);
  const full = Uint8Array.from([...data, ...sha256(sha256(data)).slice(0, 4)]);
  let n = BigInt('0x' + hex(full)), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of full) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const pubkeyAddress = (pub) => base58check(0x3c, ripemd160(sha256(unhex(pub))));
const rvnSign = (msg, sk) => Buffer.from(secp256k1.sign(rvnHash(msg), sk).toCompactRawBytes()).toString('base64');
const rvnVerify = (msg, sigB64, pub) => {
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return false;
  try { return secp256k1.verify(sig, rvnHash(msg), unhex(pub)); } catch { return false; }
};

// ── 서명 대상·content — map_format.rs 와 같은 배열·같은 키 순서 ──
const merchantMessage = (c, issuer) => JSON.stringify(['rv.merchant/1', issuer, c.slug, c.name, c.category, c.area, c.contact ?? '', c.shopUrl ?? '', c.createdAt]);
const presenceMessage = (issuer, slug, at, openItems) => JSON.stringify(['rv.shop-presence/1', issuer, slug, at, openItems ?? null]);
const nostrId = (e) => hex(sha256(enc.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
function wrap(kind, tags, content, createdAt, nsk) {
  const e = { pubkey: hex(schnorr.getPublicKey(nsk)), created_at: createdAt, kind, tags, content };
  const id = nostrId(e);
  return { id, ...e, sig: hex(schnorr.sign(unhex(id), nsk)) };
}
function buildCard(c, rsk, nsk) {
  const pub = hex(secp256k1.getPublicKey(rsk, true)), issuer = pubkeyAddress(pub);
  const signature = rvnSign(merchantMessage(c, issuer), rsk);
  const body = { kind: 'rv.merchant/1', slug: c.slug, name: c.name, category: c.category, area: c.area, createdAt: c.createdAt };
  if (c.contact !== undefined) body.contact = c.contact;
  if (c.shopUrl !== undefined) body.shopUrl = c.shopUrl;
  Object.assign(body, { issuer, signature, pubkey: pub });
  return wrap(31402, [['d', `${issuer}/${c.slug}`], ['t', 'ravenvault-merchant'], ['g', c.area]], JSON.stringify(body), c.createdAt, nsk);
}
function buildBeat(b, rsk, nsk) {
  const pub = hex(secp256k1.getPublicKey(rsk, true)), issuer = pubkeyAddress(pub);
  const signature = rvnSign(presenceMessage(issuer, b.slug, b.at, b.openItems), rsk);
  const body = { kind: 'rv.shop-presence/1', issuer, slug: b.slug, at: b.at };
  if (b.openItems !== undefined) body.openItems = b.openItems;
  Object.assign(body, { signature, pubkey: pub });
  return wrap(31403, [['d', `${issuer}/${b.slug}`], ['t', 'ravenvault-presence'], ['g', b.area]], JSON.stringify(body), b.at, nsk);
}

// ── 폰 규칙으로 검증(merchant.ts · presence.ts · relay.ts 와 같은 규칙) ──
const HIDDEN = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/, ISSUER = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/, SIG = /^[A-Za-z0-9+/=_-]{16,200}$/, AREA = /^[0-9b-hjkmnp-z]{5}$/, PUB = /^0[23][a-f0-9]{64}$/;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !HIDDEN.test(v);
const CATS = ['food', 'grocery', 'cafe', 'fitness', 'living', 'repair', 'education', 'other'];
function phoneCheck(e, now) {
  if (nostrId(e) !== e.id) return 'id';
  if (!schnorr.verify(unhex(e.sig), unhex(e.id), unhex(e.pubkey))) return '겉서명';
  const tag = (n) => e.tags.find((t) => t[0] === n)?.[1];
  const has = (n, v) => e.tags.some((t) => t[0] === n && t[1] === v);
  let c; try { c = JSON.parse(e.content); } catch { return 'content'; }
  const { pubkey, ...x } = c;
  if (typeof pubkey !== 'string' || !PUB.test(pubkey) || pubkeyAddress(pubkey) !== x.issuer) return '주소';
  if (!ISSUER.test(x.issuer) || !SIG.test(x.signature) || !SLUG.test(x.slug)) return '모양';
  if (e.kind === 31402) {
    if (!has('t', 'ravenvault-merchant') || x.kind !== 'rv.merchant/1') return '종류';
    if (!text(x.name, 40) || !CATS.includes(x.category) || !AREA.test(x.area)) return '필드';
    if (x.contact !== undefined && !text(x.contact, 80)) return 'contact';
    if (x.shopUrl !== undefined && !(x.shopUrl.length <= 200 && /^https:\/\/[^\s/]+\.[^\s]+$/i.test(x.shopUrl) && !HIDDEN.test(x.shopUrl))) return 'shopUrl';
    if (!Number.isSafeInteger(x.createdAt) || x.createdAt <= 0 || x.createdAt > now + 600) return '시각';
    if (!rvnVerify(merchantMessage(x, x.issuer), x.signature, pubkey)) return '안쪽서명';
    if (tag('d') !== `${x.issuer}/${x.slug}` || !has('g', x.area)) return '태그';
    return null;
  }
  if (e.kind === 31403) {
    if (!has('t', 'ravenvault-presence') || x.kind !== 'rv.shop-presence/1') return '종류';
    if (!Number.isSafeInteger(x.at) || x.at <= 0 || x.at > now + 600) return '시각';
    if (x.openItems !== undefined && !(Number.isSafeInteger(x.openItems) && x.openItems >= 0 && x.openItems <= 100000)) return 'openItems';
    if (!rvnVerify(presenceMessage(x.issuer, x.slug, x.at, x.openItems), x.signature, pubkey)) return '안쪽서명';
    if (tag('d') !== `${x.issuer}/${x.slug}` || !AREA.test(tag('g') ?? '')) return '태그';
    return null;
  }
  return 'kind';
}

const now = 1_790_000_400;
const rsk = new Uint8Array(32).fill(0x15), nsk = new Uint8Array(32).fill(0x17);

// ① 벡터
assert.equal(pubkeyAddress(hex(secp256k1.getPublicKey(rsk, true))), V.issuer);
assert.equal(hex(schnorr.getPublicKey(nsk)), V.nostrPubkey);
assert.equal(merchantMessage(V.card, V.issuer), V.merchantMessage);
assert.equal(presenceMessage(V.issuer, V.beat.slug, V.beat.at, V.beat.openItems), V.presenceMessage);
const card = buildCard(V.card, rsk, nsk), beat = buildBeat(V.beat, rsk, nsk);
assert.equal(JSON.parse(card.content).signature, V.merchantSignature, '안쪽 서명(RFC6979)이 폰 벡터와 다르다');
assert.equal(JSON.parse(beat.content).signature, V.presenceSignature);
assert.equal(card.id, V.merchantEventId, 'content 키 순서가 달라 id 가 다르다');
assert.equal(beat.id, V.presenceEventId);

// ② 폰 규칙 검증 + 위조 거절
const events = [card, beat];
assert.equal(phoneCheck(card, now), null); assert.equal(phoneCheck(beat, now), null);
const tamper = (e, f) => { const c = JSON.parse(e.content); f(c); return wrap(e.kind, e.tags, JSON.stringify(c), e.created_at, nsk); };
assert.equal(phoneCheck(tamper(card, (c) => { c.name = 'PLAY X 짝퉁'; }), now), '안쪽서명', '이름을 바꾸면 안쪽 서명이 깨져야 한다');
assert.equal(phoneCheck(tamper(card, (c) => { c.pubkey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true)); }), now), '주소');
assert.equal(phoneCheck(wrap(31402, [['d', `${V.issuer}/playx-gym`], ['t', 'ravenvault-merchant'], ['g', 'wydk3']], card.content.replace('"wydk3"', '"wydk3b"'), card.created_at, nsk), now), '필드', '6자리(정확 위치)는 거절');
assert.equal(phoneCheck(buildBeat({ ...V.beat, at: now + 601 }, rsk, nsk), now), '시각');

// 러스트 이벤트
const rustFile = process.argv[2];
let rust = [];
if (rustFile) {
  assert.ok(existsSync(rustFile), `${rustFile} 가 없다 — MAP_CROSSCHECK_OUT=${rustFile} cargo test map_format 먼저`);
  rust = JSON.parse(readFileSync(rustFile, 'utf8')).events;
  assert.ok(rust.length >= 2);
  for (const e of rust) assert.equal(phoneCheck(e, now), null, `러스트 이벤트 ${e.kind} 를 폰 규칙이 거절: ${phoneCheck(e, now)}`);
  events.push(...rust);
}

// ③ 폰 실제 코드
const phone = process.env.RV_PHONE_DIR;
if (phone) {
  const { build } = await import('esbuild');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  // CJS 파일로 묶어 require 한다(폰 코드가 node:crypto 를 require 로 부른다 — data: ESM 에서는 안 된다).
  const outfile = resolve(tmpdir(), `rv-phone-merchant-relay-${process.pid}.cjs`);
  await build({ entryPoints: [resolve(phone, 'core/market/merchants/relay.ts')], bundle: true, outfile, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const R = createRequire(import.meta.url)(outfile);
  for (const e of events) {
    const got = e.kind === 31402 ? await R.parseMerchantNostrEvent(e, now) : await R.parsePresenceNostrEvent(e, now);
    assert.ok(got, `폰 코드가 ${e.kind} 이벤트(${e.id.slice(0, 8)})를 버렸다`);
  }
  console.log(`폰 실제 코드(${phone})로 ${events.length}개 통과`);
}
console.log(`PASS 가게 지도 형식 — 벡터 일치(안쪽 서명·id), 폰 규칙 검증 ${events.length}개${rustFile ? `(러스트 ${rust.length}개 포함)` : ''}, 위조·정확위치·미래시각 거절`);
