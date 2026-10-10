// 서명된 허용·차단 목록 실행 중 갱신 — 실제 Chrome(puppeteer-core)에서 장터 화면 배지가 목록 갱신으로 바뀌는지.
// 화면 = index.html 의 #page-market 부분(실제 마크업) + src/open-market.ts·src/market-lists.ts(실제 코드, esbuild 묶음).
// 목록은 같은 출처의 모의 서버 /lists/signed-lists.json 이 준다(네트워크 밖으로 나가지 않음). 키는 전부 이 시험에서 만든 일회용.
// 확인: 처음(목록 없음) 미검증 → 서명 목록 받기 → 검증됨 → 변조 묶음 거절(그대로 검증됨) → 서버 오류에도 유지 →
//       새로 열어도(저장된 마지막 유효 목록) 검증됨 → 차단 목록 → 숨김. 390·1440 스크린샷 + 가로 넘침 없음.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const nodeBuilt = await build({
  stdin: { contents: `
    export * from './scripts/fixtures/creator-core-entry.ts';
    export { signCreatorAllowlist, signCreatorDenylist } from './core/creator/listing.ts';
    export { signBundle, publicListKey } from './core/signed-lists/envelope.ts';
    import { ed25519 } from '@noble/curves/ed25519';
    export const randomListKey = () => ed25519.utils.randomPrivateKey();`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const core = { exports: {} };
new Function('require', 'exports', 'module', nodeBuilt.outputFiles[0].text)(createRequire(import.meta.url), core.exports, core);
const C = core.exports;
const pageBundle = (await build({ stdin: { contents: `
    import { wireOpenMarket } from './src/open-market.ts';
    import { marketLists } from './src/market-lists.ts';
    import { httpSource } from './core/signed-lists/sources.ts';
    window.__wireOpenMarket = wireOpenMarket; window.__marketLists = marketLists; window.__httpSource = httpSource;`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
const html = readFileSync(join(root, 'index.html'), 'utf8');
const section = html.slice(html.indexOf('<section class="page" id="page-market"'), html.indexOf('</section>', html.indexOf('id="page-market"')) + 10)
  .replace(' hidden inert', '');

/* 고정 자료: 음악 상품 하나(실제 서명 매니페스트, 모의 IPFS) */
const KEY = C.randomKey(), ADDRESS = C.addressOf(KEY), RECEIVING = 'RCJPGkCQi5NpBgtj8qkjGcSugfWRa3iQiS';
const pin = new C.MockPinAdapter();
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const song = await C.publishContent({ type: 'music', asset: 'RV.M.MORNING_SONG', title: '아침 노래', description: '짧은 노래', files: [{ path: 'm.mp3', bytes: MP3, mime: 'audio/mpeg' }],
  creatorAddress: ADDRESS, receivingAddress: RECEIVING, priceAtoms: '2000000000', declaredFeeBps: 1500, details: { previewFile: 'm.mp3', previewStartMs: 0, previewEndMs: 30000 },
  now: new Date('2026-10-10T09:00:00.000Z') }, pin, async (_a, m) => C.signMessageForTest(m, KEY));
const store = Object.fromEntries([...pin.stored.entries()].map(([k, v]) => [k, Array.from(v)]));
const assets = [{ name: song.manifest.asset, ipfs_hash: song.manifestCid }];

const LIST_KEY = C.randomListKey(), PUB = C.publicListKey(LIST_KEY);
const NOW = Date.parse('2026-10-11T00:00:00.000Z');
const entry = { asset: song.manifest.asset, type: 'music', manifestCid: song.manifestCid, manifestSha256: song.manifestSha256, creatorAddress: ADDRESS, receivingAddress: RECEIVING,
  gameIndex: 7, feeBps: 1500, origins: ['https://music.example'], status: 'verified', verifiedAt: '2026-10-10T10:00:00.000Z' };
const part = (kind, entries, v = 1) => {
  const doc = { format: kind === 'allow' ? 'rv-creator-allowlist' : 'rv-creator-denylist', version: 1, entries };
  return { doc, signature: (kind === 'allow' ? C.signCreatorAllowlist : C.signCreatorDenylist)(doc, v, '2026-10-10T10:00:00.000Z', LIST_KEY) };
};
const bundle = (seq, parts) => JSON.stringify(C.signBundle({ sequence: seq, issuedAt: '2026-10-10T12:00:00.000Z', expiresAt: '2026-11-10T12:00:00.000Z',
  parts: { gameRegistry: null, creatorAllowlist: null, creatorDenylist: null, ...parts } }, LIST_KEY));
const V1 = bundle(1, { creatorAllowlist: part('allow', [entry]) });
const tampered = (() => { const b = JSON.parse(bundle(2, { creatorAllowlist: part('allow', [entry]) })); b.parts.creatorAllowlist.doc.entries[0].receivingAddress = ADDRESS; return JSON.stringify(b); })();
const V3 = bundle(3, { creatorAllowlist: part('allow', [entry], 2), creatorDenylist: part('deny', [{ kind: 'asset', value: entry.asset, reason: 'scam', addedAt: '2026-10-10T13:00:00.000Z' }]) });

let work, browser, server, origin, served = { status: 404, body: '' }, hits = 0;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-signed-lists-ui-')); mkdirSync(join(work, 'shots'));
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/lists/signed-lists.json') { hits++; res.writeHead(served.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(served.body); return; }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>장터 목록 시험</title>
        <style>body{margin:16px;font:15px system-ui;background:#fff;color:#111}.mk-badge{padding:2px 6px;border:1px solid #888;border-radius:6px}ul{padding-left:0;list-style:none}button{min-height:44px}</style></head><body>${section}</body></html>`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

async function open(page, width) {
  await page.setViewport({ width, height: 900 });
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.addScriptTag({ content: pageBundle });
  await page.evaluate((assets, store, pub, now) => {
    const lists = window.__marketLists({ storage: window.localStorage, sources: [window.__httpSource(location.origin + '/lists/signed-lists.json', (u, i) => fetch(u, i))],
      listKeys: [pub], creatorKeys: [], now: () => now });
    window.__market = window.__wireOpenMarket({ back: () => {}, now: () => now, lists,
      source: { assets: async () => assets, fetch: async cid => store[cid] ? Uint8Array.from(store[cid]) : null } });
    return window.__market.load();
  }, assets, store, PUB, NOW);
  await page.waitForFunction(() => /1개|없어요/.test(document.querySelector('#mk-list-say').textContent));
}
const badges = page => page.$$eval('#mk-list .mk-item', b => b.map(x => x.dataset.asset + ':' + x.querySelector('.mk-badge').textContent));
const say = page => page.$eval('#mk-lists-say', e => e.textContent);
async function refresh(page) {
  await page.click('#mk-lists-refresh');
  await page.waitForFunction(() => !document.querySelector('#mk-lists-refresh').disabled && !/받는 중/.test(document.querySelector('#mk-lists-say').textContent));
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('market badge follows the signed list: unverified → verified → tampered refused → server error kept → reload keeps last good → deny hides', { timeout: 120_000 }, async () => {
  const page = await browser.newPage();
  await open(page, 1440);
  assert.deepEqual(await badges(page), ['RV.M.MORNING_SONG:미검증'], 'no list yet');
  assert.match(await say(page), /기본 목록/);
  assert.equal(await page.$eval('#mk-lists-refresh', b => b.hidden), false, 'refresh offered when a source exists');

  served = { status: 200, body: V1 };
  await refresh(page);
  assert.deepEqual(await badges(page), ['RV.M.MORNING_SONG:검증됨'], 'signed list applied without a rebuild');
  assert.match(await say(page), /최신 목록 1번.*새 목록을 적용했어요/);
  await page.screenshot({ path: join(work, 'shots', 'verified-1440.png') });
  assert(await noOverflow(page));

  served = { status: 200, body: tampered };
  await refresh(page);
  assert.deepEqual(await badges(page), ['RV.M.MORNING_SONG:검증됨'], 'tampered bundle not applied, last good list kept');
  assert.match(await say(page), /적용하지 않았어요\(part-hash\)/);

  served = { status: 500, body: 'oops' };
  await refresh(page);
  assert.deepEqual(await badges(page), ['RV.M.MORNING_SONG:검증됨'], 'server error keeps the last good list');
  assert.match(await say(page), /network/);

  // 새로 열기(같은 프로필): 서버가 없어도 저장된 마지막 유효 목록으로 바로 검증됨.
  served = { status: 404, body: '' };
  const again = await browser.newPage();
  await open(again, 390);
  assert.deepEqual(await badges(again), ['RV.M.MORNING_SONG:검증됨'], 'persisted last verified list');
  await again.screenshot({ path: join(work, 'shots', 'verified-390.png') });
  assert(await noOverflow(again));

  served = { status: 200, body: V3 };
  await refresh(again);
  assert.deepEqual(await badges(again), [], 'deny list hides it immediately (deny beats allow)');
  assert.match(await again.$eval('#mk-list-say', e => e.textContent), /아직 올라온 상품이 없어요/);
  assert.match(await say(again), /최신 목록 3번/);
  // 옛 묶음(1번)을 다시 주어도 되돌아가지 않는다.
  served = { status: 200, body: V1 };
  await refresh(again);
  assert.deepEqual(await badges(again), []);
  assert.match(await say(again), /rollback/);
  assert.equal(hits, 5, "one request per refresh, none on open");
  await page.close(); await again.close();
});

test('shipped desktop wiring: no trusted list key and no fetch path → built-in list, no refresh button', { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.addScriptTag({ content: pageBundle });
  const before = hits;
  await page.evaluate((assets, store) => window.__wireOpenMarket({ back: () => {}, lists: window.__marketLists({ storage: null }),
    source: { assets: async () => assets, fetch: async cid => store[cid] ? Uint8Array.from(store[cid]) : null } }).load(), assets, store);
  assert.deepEqual(await badges(page), ['RV.M.MORNING_SONG:미검증']);
  assert.equal(await page.$eval('#mk-lists-refresh', b => b.hidden), true);
  assert.match(await say(page), /기본 목록/);
  assert.equal(hits, before, 'no request');
  await page.close();
});
