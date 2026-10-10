// Builds artifacts/drop-gallery/index.html from the screenshots the drop-publish browser harness saved
// (RV_DROP_SHOTS=artifacts/drop-gallery/shots node --test scripts/drop-publish-browser.test.mjs). Static page, no scripts.
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../artifacts/drop-gallery');
const shots = readdirSync(join(dir, 'shots')).filter(f => f.endsWith('.png')).sort();
const STATES = [['idle', '빈 화면'], ['overlay', '드롭 오버레이'], ['preview', '미리보기(고급 펼침)'], ['blocked', '막힘'], ['confirm', '확인 창'], ['done', '완료']];
const LANG = { ko: '한국어', de: 'Deutsch', ru: 'Русский', ps60: '의사 현지화 +60%', ps100: '의사 현지화 +100%(en)' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fig = (f, cap) => `<figure><a href="shots/${esc(f)}"><img loading="lazy" src="shots/${esc(f)}" alt="${esc(cap)}"></a><figcaption>${esc(cap)}</figcaption></figure>`;
const has = f => shots.includes(f);

let body = '';
for (const [w, t] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
  const items = STATES.map(([s, label]) => [`${w}-${t}-ko-${s}.png`, `${label} · ${w}px · ${t === 'light' ? '라이트' : '다크'}`]).filter(([f]) => has(f));
  if (items.length) body += `<section><h2>${w}px · ${t === 'light' ? '라이트' : '다크'} · 한국어</h2><div class="grid ${w === 390 ? 'narrow' : ''}">${items.map(([f, c]) => fig(f, c)).join('')}</div></section>`;
}
const longs = Object.keys(LANG).filter(l => l !== 'ko').flatMap(l => STATES.map(([s, label]) => [`390-light-${l}-${s}.png`, `${LANG[l]} · ${label}`])).filter(([f]) => has(f));
if (longs.length) body += `<section><h2>긴 문구(독일어·러시아어·의사 현지화) · 390px</h2><div class="grid narrow">${longs.map(([f, c]) => fig(f, c)).join('')}</div></section>`;
if (has('templates-1024-light.png')) body += `<section><h2>템플릿 7종 × 색 7종(위에서부터 앨범·싱글·책·갤러리·행사·가게·기본, 각 7색)</h2><p>사용자 글에 &lt;script&gt;·onerror·javascript: 를 넣은 시험 데이터 — 전부 글자로만 보이고 그림 주소는 버려진다. 맨 위 신뢰 띠는 모든 조합에서 같다.</p><div class="grid one">${fig('templates-1024-light.png', '템플릿 × 색 49조합')}</div></section>`;

writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>끌어놓기 발행 갤러리</title>
<style>
:root { --bg:#f7f6f3; --panel:#fff; --text:#15161d; --muted:#5b5e6b; --line:#e6e3dc; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0f1016; --panel:#15161d; --text:#ecedf3; --muted:#a3a7b7; --line:#2a2d3a; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#0f1016; --panel:#15161d; --text:#ecedf3; --muted:#a3a7b7; --line:#2a2d3a; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: clamp(1.5rem, 1.1rem + 1.5vw, 2.25rem); letter-spacing: -0.02em; margin: 0 0 8px; }
h2 { font-size: 1.125rem; margin: 40px 0 12px; }
p { color: var(--muted); max-width: 70ch; overflow-wrap: anywhere; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); }
.grid.narrow { grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); }
.grid.one { grid-template-columns: minmax(0, 1fr); }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; max-height: 720px; object-fit: cover; object-position: top; }
.grid.one figure img { max-height: none; }
figcaption { padding: 8px 12px; font-size: 0.875rem; color: var(--muted); }
a { color: inherit; }
</style></head><body><main>
<h1>끌어놓기 발행 — 화면 갤러리</h1>
<p>실제 Chrome(puppeteer-core)으로 운영 빌드를 열고 모의 체인·모의 IPFS 로 찍은 화면입니다. 각 화면은 같은 시험에서 가로 넘침·글자 잘림·겹침·누를 곳 44px·대비 4.5:1 을 자동으로 쟀습니다(폭 320·390·768·1024·1440 × 라이트·다크 × ko·de·ru·+60%·+100%). 설계: docs/design/drop-publish.md</p>
${body}
</main></body></html>
`);
console.log(`gallery: ${shots.length} shots`);
