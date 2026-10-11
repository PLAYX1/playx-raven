// 화면 언어 → 금액 지역: 새 유럽어 6개에서 amount-ui 가 쉼표 소수 지역(strict)을 쓰는지. DOM 없이 가짜 전역으로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = resolve(import.meta.dirname, '..');
async function load(lang, navLang) {
  const built = await build({ entryPoints: [resolve(root, 'src/amount-ui.ts'), resolve(root, 'src/amount-locale.ts')], bundle: true, write: false, platform: 'node', format: 'esm', outdir: 'out', logLevel: 'silent' });
  const code = Object.fromEntries(built.outputFiles.map(f => [f.path.split('/').pop(), f.text]));
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('navigator', { language: navLang }); def('localStorage', { getItem: () => lang, setItem() {} });
  // 켤 때 동기 읽기(XMLHttpRequest)를 public/i18n 파일로 흉내 낸다.
  def('XMLHttpRequest', class { open(_m, u) { this.u = u; } send() { try { this.responseText = readFileSync(resolve(root, 'public' + this.u), 'utf8'); this.status = 200; } catch { this.status = 404; } } });
  def('window', new EventTarget()); def('document', { documentElement: {}, querySelectorAll: () => [] });
  const url = c => 'data:text/javascript;base64,' + Buffer.from(c + `\n//${lang}${navLang}${Math.random()}`).toString('base64');
  // amount-ui 번들 안에 amount-locale 이 들어 있다 — 같은 번들에서 파싱 함수도 꺼낸다.
  return import(url(code['amount-ui.js']));
}
const COMMA = ['it', 'es', 'fr', 'pt-BR', 'de', 'ru'];
for (const lang of COMMA) {
  test(`${lang}: 쉼표 소수 지역 — 「1,5」는 1.5 · 「1.234」는 모호(추측 안 함) · 표시는 쉼표`, async () => {
    const m = await load(lang, 'en-US');
    const loc = m.numLocale();
    assert.ok(loc === lang || loc.startsWith(lang.split('-')[0]), `지역 ${loc}`);
    const shown = m.fmtRvn(12345.5);
    assert.match(shown, /^12[.\s\u00a0\u202f]345,5/, shown.replace(/ | /g, '␣'));
    assert.ok(/ RVN$/.test(shown.replace(/ /g, ' ')), 'RVN 은 숫자 뒤');
    const el = { value: '1,5', addEventListener() {}, dispatchEvent() {}, setAttribute() {}, getAttribute() {} };
    const bound = m.bindAmountInput(el);
    const r = m.readAmount(bound);
    assert.equal(r.ok, true, String(r.problem)); assert.equal(String(r.sats), '150000000');
    bound.value = '1.234';
    const amb = m.readAmount(bound);
    assert.equal(amb.ok, false, '모호한 입력은 값을 정하지 않는다'); assert.equal(amb.problem, 'ambiguous');
  });
}
test('컴퓨터 지역이 es-MX 면 스페인어 화면도 점 소수(멕시코)로', async () => {
  const m = await load('es', 'es-MX');
  assert.equal(m.numLocale(), 'es-MX');
});
