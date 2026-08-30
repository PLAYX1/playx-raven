/**
 * 가게 화면 일곱을 **폰 크기(390px)로 직접 열어 본다.**
 *
 * `screensweep.mjs` 는 사장이 쓰는 데스크톱 앱을 본다. 이 파일은 그 앱이
 * **손님·직원 폰에 내주는 화면**을 본다 — 계산대에 줄이 서 있을 때 실제로
 * 손이 닿는 것들이다.
 *
 * 기준 (PLAY X 손님 화면 바닥):
 *   읽는 본문 **13px** · 입력칸 **16px** · 누를 곳 **44px** · 가로 스크롤 없음
 *
 * 예외는 코드에 적어 뒀다 — 주소·해시가 든 상자(키우면 줄이 깨진다),
 * 큰 제목, 본문 안 링크(단추가 아니다).
 *
 * 2026-08-31 처음 돌려 `admin.html` 의 12.5px 넷을 잡았다.
 * 「손님 폰에 같은 주문번호가 뜹니다」처럼 **주문을 맞춰 보는 설명**이
 * 그 크기였다.
 *
 * ⚠️ 맥 헤드리스는 `--window-size` 를 무시한다. 뷰포트를 직접 준다.
 *
 * 도는 법:  node countercheck.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');
const T = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
            '.png':'image/png', '.webp':'image/webp', '.json':'application/json' };
const s = createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  const p = join(DIR, u === '/' ? '/customer.html' : u);
  if (!existsSync(p)) return r.writeHead(404).end();
  r.writeHead(200, { 'content-type': T[extname(p)] || 'text/plain' });
  r.end(readFileSync(p));
});
await new Promise(r => s.listen(8793, '127.0.0.1', r));
// 🔴 크롬이 없으면 **조용히 넘어가지 않는다.** 넘어가면 「통과」인데
//    아무것도 안 본 것이 된다.
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const chrome = process.env.CHROME_PATH || CHROMES.find((p) => existsSync(p));
if (!chrome) { console.log('🔴 크롬을 못 찾았습니다. CHROME_PATH 를 주세요.'); process.exit(1); }
let bad = 0;
const b = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
for (const [이름, f] of [['손님 주문','/customer.html'], ['직원','/staff.html'],
                          ['사장 관리','/admin.html'], ['가게 목록','/shops.html'],
                          ['지갑','/wallet.html'], ['찍기','/scan.html'], ['사기','/buy.html']]) {
  if (!existsSync(join(DIR, f))) { console.log('   (없음 ' + f + ')'); continue; }
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto('http://127.0.0.1:8793' + f, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));
  const r2 = await p.evaluate(() => {
    const 작음 = [], 좁음 = [];
    for (const e of document.querySelectorAll('body *')) {
      if (!e.getClientRects().length || e.closest('details:not([open])')) continue;
      const cs = getComputedStyle(e), rect = e.getBoundingClientRect();
      const 직접 = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      const 글 = (e.textContent || '').trim().slice(0, 18);
      if (직접 && !e.closest('code,pre,.addr,.hex,h1,h2,h3')) {
        const px = parseFloat(cs.fontSize);
        const 바닥 = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? 16 : 13;
        if (px < 바닥) 작음.push(px + 'px ' + e.tagName + ' "' + 글 + '"');
      }
      const 누를것 = /^(BUTTON|SELECT|INPUT)$/.test(e.tagName) ||
        (e.tagName === 'A' && cs.display !== 'inline');
      if (누를것 && rect.height > 0 && rect.height < 44) 좁음.push(Math.round(rect.height) + 'px ' + e.tagName + ' "' + 글 + '"');
    }
    return { 가로: document.documentElement.scrollWidth, 작음: [...new Set(작음)], 좁음: [...new Set(좁음)] };
  });
  const 문제 = [];
  if (r2.가로 > 391) 문제.push('가로 ' + r2.가로 + 'px');
  if (r2.작음.length) 문제.push('13px 미만 ' + r2.작음.length + ': ' + r2.작음.slice(0,3).join(', '));
  if (r2.좁음.length) 문제.push('44px 미만 ' + r2.좁음.length + ': ' + r2.좁음.slice(0,3).join(', '));
  if (문제.length) bad++;
  console.log((문제.length ? '🔴 ' : '✅ ') + 이름.padEnd(9) + (문제.join('\n     · ') || '정상'));
  await p.close();
}
await b.close();
s.close();
console.log('');
if (bad) {
  console.log(`가게 화면 검사 실패 — ${bad}곳.`);
  console.log('작은 글씨도 좁은 단추도 **오류를 안 냅니다.** 여기서만 보입니다.');
  process.exit(1);
}
console.log('가게 화면 검사 통과 — 일곱 화면 다 정상.');
