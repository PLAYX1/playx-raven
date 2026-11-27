// 「폰 연결」 한 QR — 폰 저장소(ravenvault core/desktop-link/one-qr.ts)와 같은 겉봉을 내는지 고정 값으로 묶는다.
//   node --test scripts/one-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const one = await moduleAt('src/one-link.ts');
const core = await moduleAt('core/desktop-link/one-qr.ts');

const wl = 'RVWL1.eyJ2IjoxfQ';
const shop = `ravenvault-shop://192.168.0.10:8790/staff#t=aa&k=${'cd'.repeat(32)}`;

test('폰과 같은 고정 값(ravenvault core/desktop-link/one-qr.test.ts)', () => {
  assert.equal(one.oneLinkText(wl, shop), 'RVPC1.eyJzaG9wIjoicmF2ZW52YXVsdC1zaG9wOi8vMTkyLjE2OC4wLjEwOjg3OTAvc3RhZmYjdD1hYSZrPWNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2RjZGNkY2QiLCJ2IjoxLCJ3bCI6IlJWV0wxLmV5SjJJam94ZlEifQ');
  assert.deepEqual(core.decodeOneLinkQr(one.oneLinkText(wl, shop)), { wl, shop });
});

test('직원 주소가 없거나 틀리면 옛 지갑 QR 그대로(옛 폰도 읽는다)', () => {
  assert.equal(one.oneLinkText(wl, null), wl);
  assert.equal(one.oneLinkText(wl, undefined), wl);
  assert.equal(one.oneLinkText(wl, ''), wl);
  // 평문 http 직원 주소는 겉봉에 못 들어간다 → 지갑 QR 만.
  assert.equal(one.oneLinkText(wl, 'http://192.168.0.10:8790/staff#t=aa'), wl);
});

test('겉봉에는 정해진 칸만 — 모르는 칸(복구 단어 등)이 있으면 폰이 통째로 버린다', () => {
  const raw = o => core.ONE_LINK_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(core.decodeOneLinkQr(raw({ v: 1, wl, words: 'abandon' })), null);
  // 만드는 쪽도 정해진 칸 밖의 것은 싣지 않는다.
  assert.deepEqual(core.decodeOneLinkQr(core.encodeOneLinkQr({ wl, words: 'abandon' })), { wl });
});

test('core/desktop-link/one-qr.ts 는 폰 저장소 원본과 바이트가 같다(원본이 있으면)', t => {
  const origin = process.env.RAVENVAULT_REPO || `${homedir()}/ravenvault`;
  const src = `${origin}/core/desktop-link/one-qr.ts`;
  if (!existsSync(src)) { t.skip(`원본 없음: ${src}`); return; }
  assert.equal(sha('core/desktop-link/one-qr.ts'), sha(src));
});
