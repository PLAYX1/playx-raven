// 11-13 이야기 글 속 웹 주소 — 폰 core/talk/url-links.test.ts 와 같은 사례(src/chat-links.ts 는 폰 파일과 같은 파일).
//   node --test scripts/chat-links.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

async function moduleAt(path, extra = {}) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' }, ...extra });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const { firstUrl, linkRisk, shortUrl, urlSegments } = await moduleAt('src/chat-links.ts');

test('폰 core/talk/url-links.ts 와 같은 사례', () => {

  const urls = (t) => urlSegments(t).filter(s => s.kind === 'url').map(s => s.href);
  const shown = (t) => urlSegments(t).filter(s => s.kind === 'url').map(s => s.text);

  // ── 찾기 ──
  assert.deepEqual(urls('이거 봐 https://x.com/JackdawCrypto/status/2120535735769944465?a=1 진짜'), ['https://x.com/JackdawCrypto/status/2120535735769944465?a=1']);
  assert.deepEqual(urls('끝에 점 https://example.com/a.'), ['https://example.com/a'], 'trailing period');
  assert.deepEqual(urls('물음표? https://example.com/a?, 그리고'), ['https://example.com/a'], 'trailing ?,');
  assert.deepEqual(urls('"https://example.com/q"'), ['https://example.com/q'], 'quotes');
  assert.deepEqual(urls('https://x.com/a에서 봤어'), ['https://x.com/a'], 'Korean adjacent ends url');
  assert.deepEqual(urls('여기(https://example.com/a) 봐'), ['https://example.com/a'], 'wrapping parens dropped');
  assert.deepEqual(urls('https://en.wikipedia.org/wiki/Bit_(money)'), ['https://en.wikipedia.org/wiki/Bit_(money)'], 'balanced paren kept');
  assert.deepEqual(urls('(see https://en.wikipedia.org/wiki/Bit_(money))'), ['https://en.wikipedia.org/wiki/Bit_(money)'], 'nested paren');
  assert.deepEqual(urls('두 개 https://a.com/1 https://b.org/2!'), ['https://a.com/1', 'https://b.org/2']);
  assert.deepEqual(urls('HTTP://EXAMPLE.COM/x'), ['HTTP://EXAMPLE.COM/x'], 'scheme case');
  assert.deepEqual(urls('http://localhost/x'), [], 'no dotless host');
  // 맨 도메인
  assert.deepEqual(urls('example.com 가 봐'), ['https://example.com'], 'bare domain');
  assert.deepEqual(urls('www.naver.co.kr/path?q=1 ㅎㅎ'), ['https://www.naver.co.kr/path?q=1'], 'bare with path');
  assert.deepEqual(urls('네이버naver.com'), ['https://naver.com'], 'Korean before bare domain');
  assert.deepEqual(urls('mail me a@b.com'), [], 'email is not a link');
  assert.deepEqual(urls('node.js 좋아 file.txt'), [], 'non-tld words');
  assert.deepEqual(urls('버전 1.2.3 이에요'), [], 'version number');
  assert.deepEqual(urls('x.com.'), ['https://x.com'], 'bare trailing dot');
  assert.deepEqual(shown('example.com'), ['example.com'], 'bare shown text without scheme');
  // 조각이 원래 글을 그대로 잇는다
  for (const t of ['안녕 https://a.com/x, 그리고 b.org.', 'no links at all', '', 'https://a.com']) assert.equal(urlSegments(t).map(s => s.text).join(''), t, 'segments rejoin: ' + t);
  assert.equal(firstUrl('a https://one.com/1 b https://two.com'), 'https://one.com/1');
  assert.equal(firstUrl('없음'), '');

  // ── 짧은 모양 ──
  assert.equal(shortUrl('https://x.com/JackdawCrypto/status/2120535735769944465?a=1'), 'x.com/JackdawCrypto/status/2120535735…');
  assert.equal(shortUrl('https://www.example.com/'), 'example.com');
  assert.equal(shortUrl('https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8'), 'ko.wikipedia.org/wiki/서울');
  assert(shortUrl('https://a.com/' + 'x'.repeat(200)).length <= 38);

  // ── 위험 ──
  const r = (u) => linkRisk(u).reasons;
  assert.deepEqual(r('https://x.com/JackdawCrypto/status/1'), [], 'normal');
  assert.deepEqual(r('https://ravenvault.ex.erci.se/r/abc'), [], 'our domain');
  assert.deepEqual(r('https://blog.naver.com/a'), [], 'official subdomain');
  assert(r('https://ravenvau1t.com/login').includes('lookalike'), 'ravenvau1t');
  assert(r('https://ravenvault-support.app').includes('lookalike'), 'brand + word');
  assert(r('https://ravenvault.ex.erci.se.evil.com').includes('lookalike'), 'official as subdomain of other');
  assert(r('https://rnetamask.io').includes('lookalike'), 'rn → m');
  assert(r('https://xn--ravenvult-w2a.com').includes('punycode'), 'punycode');
  assert(r('https://ravenvаult.com').includes('punycode'), 'cyrillic а becomes punycode');
  assert(r('http://example.com').includes('not-https'));
  assert(r('https://192.168.0.1/x').includes('ip-host'));
  assert(r('https://[::1]/x').includes('ip-host'));
  assert(r('https://ravenvault.ex.erci.se@evil.com/').includes('credentials'));
  assert(r('https://example.com:8443/').includes('port'));
  assert(r('https://example.com/enter-your-seed-phrase').includes('phishing-words'));
  assert(r('https://wallet-connect.example.org').includes('phishing-words'), 'wallet-connect');
  assert(r('https://example.com/?step=recovery').includes('phishing-words'));
  assert(!r('https://example.com/seedling-garden').includes('phishing-words'), 'seedling is fine');
  assert(!r('https://proceed.com/').includes('phishing-words'), 'proceed is fine');
  assert.equal(linkRisk('https://ravenvau1t.com').host, 'ravenvau1t.com', 'real domain shown');
  assert(linkRisk('not a url').risky);

});

test('사진 주소 규칙 · 링크 HTML 은 escape · 미리보기 자리', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.navigator ??= { language: 'ko', languages: ['ko'] };
  globalThis.window ??= globalThis;
  globalThis.document ??= { documentElement: { lang: 'ko' }, addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] };
  const M = await moduleAt('src/talk-media.ts');
  const H = 'ab'.repeat(32);
  assert.equal(M.personPictureSrc(`https://blossom.nostr.build/${H}.jpg`), `https://blossom.nostr.build/${H}.jpg`);
  assert.equal(M.personPictureSrc('https://ravenvault.ex.erci.se/emoji/ravi_love.webp'), '/ravi-stickers/ravi_love.webp', '라비 이모티콘은 앱에 든 그림');
  assert.equal(M.personPictureSrc('https://example.com/me.jpg'), '', '바깥 주소는 안 그린다');
  assert.equal(M.personPictureSrc('https://ravenvault.ex.erci.se/emoji/nope.webp'), '');
  assert.equal(M.roomPictureSrc('https://ravenvault.ex.erci.se/emoji/ravi_love.webp'), '', '방 사진은 진짜 사진만');
  M.hidePicture(`https://blossom.nostr.build/${H}.jpg`);
  assert.equal(M.personPictureSrc(`https://blossom.nostr.build/${H}.jpg`), '', '신고한 사진은 숨긴다');
  const html = M.linkifyHtml('<b>봐</b> https://x.com/a/status/1?q=1&y=2<img src=x> 끝');
  assert.ok(!html.includes('<b>') && !html.includes('<img'), 'escape');
  assert.ok(html.includes('&lt;img src=x&gt;'), '주소는 < 앞에서 끝나고 나머지는 글자');
  assert.ok(html.includes('data-tk-url="https://x.com/a/status/1?q=1&amp;y=2"'));
  assert.ok(html.includes('>x.com/a/status/1?q=1&amp;y=2</a>'));
  assert.equal(M.previewUrlOf('상품 https://ravenvault.ex.erci.se/r/abc'), '', '우리 사이트는 미리보기 없음');
  assert.equal(M.previewUrlOf('http://plain.example.com'), '', 'http 는 미리보기 없음');
  assert.equal(M.previewUrlOf('a https://one.com/1 b https://two.com'), 'https://one.com/1', '첫 주소만');
  assert.ok(M.previewSlotHtml('https://one.com/a?b=1&c=2').includes('data-tk-lp="https://one.com/a?b=1&amp;c=2"'));
  assert.equal(M.stickerCodeOf(M.stickerUrl('ravi_ok')), 'ravi_ok');
});

test('폰 파일과 같은 내용(머리말 한 줄만 다르다)', () => {
  const phone = '/Users/gimmusong/wt-rv-buy-phone/core/talk/url-links.ts';
  let a; try { a = readFileSync(phone, 'utf8'); } catch { return; } // 폰 작업 폴더가 없으면 건너뛴다(CI)
  const b = readFileSync('src/chat-links.ts', 'utf8');
  const strip = (s) => s.split('\n').filter((l) => !l.includes('순수 로직이다')).join('\n');
  assert.equal(strip(b), strip(a));
});
