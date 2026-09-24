// 증명서 미리보기·인쇄 검사 — 앱과 같은 CSP(Tauri 가 style-src·script-src 에 nonce 를 덧붙인 모양)에서.
//
// 🔴 0.4.5 미리보기는 srcdoc 이 부모 CSP 를 물려받아 증서 <style> 이 막혔다(대표 09-24 캡처).
//    그래서 이 검사는 먼저 **대조군이 깨지는지**(도우미 없이 srcdoc 만) 확인한다 — 깨지지 않으면
//    이 하네스는 실패 지점을 덮지 못한 것이다. 그다음 도우미(src/srcdoc-style.ts)로 고쳐지는지,
//    인쇄 파일이 PDF 로 한 사람 = A4 한 쪽인지 본다.
//
// 증서 HTML 은 Rust render() 가 만든 그대로를 쓴다(cargo 견본 시험이 파일로 떨어뜨린다).
// CARGO_TARGET_DIR 를 넘기면 그 빌드 폴더를 쓴다.
//
// RV2(09-24): 글꼴을 앱에 넣었다(cert-fonts/). 미리보기는 글꼴 CSS 를 따로 한 번 받아 같이 붙이고,
// 인쇄 파일은 글꼴이 data: 로 들어 있다 — 둘 다 「RV Cert Serif」로 그려지는지, 이름이 가운데 축에
// 있는지, PDF 에 그 글꼴이 박히는지까지 본다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = new URL('..', import.meta.url).pathname;
const samples = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cert-'));
const cargo = spawnSync('cargo', ['test', '--lib', 'certificate::tests::견본_쓰기', '--', '--exact'], {
  cwd: path.join(root, 'src-tauri'), env: { ...process.env, RV_CERT_SAMPLE_DIR: samples }, encoding: 'utf8',
});
assert.equal(cargo.status, 0, cargo.stderr.slice(-2000));

// 앱 CSP 에 Tauri 처럼 nonce 를 덧붙인다.
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const NONCE = 'rvcheck' + Date.now();
const csp = Object.entries(conf.app.security.csp)
  .map(([k, v]) => (k === 'style-src' || k === 'script-src') ? `${k} ${v} 'nonce-${NONCE}'` : `${k} ${v}`).join('; ');

const helper = (await build({
  entryPoints: [path.join(root, 'src/srcdoc-style.ts')], bundle: true, write: false, format: 'iife', globalName: 'RV',
})).outputFiles[0].text;
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const paperCss = indexHtml.match(/\.cr-paper \{[^}]*\}[\s\S]*?\.cr-paper iframe \{[^}]*\}/)?.[0];
assert.ok(paperCss, 'index.html 의 .cr-paper 규칙을 찾지 못했다');
const page = `<!doctype html><html><head><meta charset="utf-8"><style nonce="${NONCE}">${paperCss}</style></head>
<body><div class="cr-paper"><iframe id="cr-preview" sandbox="allow-same-origin" tabindex="-1"></iframe></div>
<script nonce="${NONCE}" src="/helper.js"></script></body></html>`;
const server = http.createServer((q, r) => {
  if (q.url === '/helper.js') { r.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return r.end(helper); }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }); r.end(page);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cert-chrome-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
let failed = 0;
const ok = (name, fn) => fn().then(() => console.log(`PASS ${name}`), e => { failed++; console.log(`FAIL ${name}\n${e.stack || e}`); });
try {
  const tab = await browser.newPage();
  async function show(html, styled) {
    await tab.goto(origin, { waitUntil: 'load' });
    await tab.evaluate((h, s, fonts) => new Promise(done => {
      const f = document.getElementById('cr-preview');
      f.addEventListener('load', () => setTimeout(done, 50), { once: true });
      if (s) RV.setStyledSrcdoc(f, h, fonts); else f.srcdoc = h;
    }), html, styled, FONTS);
    const frame = tab.frames().find(f => f !== tab.mainFrame());
    return frame.evaluate(async () => {
      await document.fonts.ready;
      const sheet = document.querySelector('.sheet'), b = getComputedStyle(document.body);
      const s = sheet.getBoundingClientRect(), n = document.querySelector('.name')?.getBoundingClientRect();
      return {
        font: b.fontFamily, sheetH: Math.round(s.height),
        loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
        offCenter: n ? Math.abs((n.left + n.right) / 2 - (s.left + s.right) / 2) : 999,
      };
    });
  }
  const FONTS = fs.readFileSync(path.join(samples, 'fonts.css'), 'utf8');
  for (const t of ['course', 'proof', 'thanks']) {
    const html = fs.readFileSync(path.join(samples, `preview-${t}-short.txt`), 'utf8');
    await ok(`${t}: 대조군(srcdoc 만)은 CSP 에 막힌다 — 하네스가 0.4.5 고장을 재현`, async () => {
      const m = await show(html, false);
      assert.ok(m.sheetH < 1000, `막히지 않았다: ${JSON.stringify(m)}`);
    });
    await ok(`${t}: 도우미를 쓰면 A4 한 장(794×1123), 앱에 넣은 글꼴, 이름이 가운데 축`, async () => {
      const m = await show(html, true);
      assert.ok(m.sheetH >= 1110 && m.sheetH <= 1124, JSON.stringify(m));
      assert.doesNotMatch(m.font, /^(Times|-webkit-standard|serif)\b/, `브라우저 기본 글꼴이다: ${m.font}`);
      assert.ok(m.loaded.some(f => /RV Cert Serif/.test(f)), `앱 글꼴이 안 불렸다: ${m.loaded}`);
      assert.ok(m.offCenter <= 2, `이름이 가운데에서 ${m.offCenter}px 벗어났다`);
    });
  }
  // 인쇄 = 같은 render() 결과. CSP 없는 파일로 열리므로 그대로 PDF 로 뽑아 쪽 수를 센다.
  const PRINTS = [['course-3.html', 3], ['proof-3.html', 3], ['thanks-3.html', 3], ['course-en.html', 1], ['work-1.html', 1]];
  for (const t of ['course', 'proof', 'thanks']) for (const v of ['short', 'long', 'latin']) PRINTS.push([`${t}-${v}.html`, 1]);
  for (const [file, pages] of PRINTS) {
    await ok(`인쇄 ${file}: PDF ${pages}쪽(한 사람 = A4 한 쪽), 글꼴이 PDF 에 박힌다`, async () => {
      const p = await browser.newPage();
      await p.goto('file://' + path.join(samples, file), { waitUntil: 'load' });
      const pdf = Buffer.from(await p.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
      await p.close();
      const n = (pdf.match(/\/Type\s*\/Page(?!s)/g) || []).length;
      assert.equal(n, pages, `${file}: ${n}쪽`);
      assert.match(pdf, /RVCertSerif/, '앱 글꼴이 PDF 에 안 박혔다(컴퓨터 글꼴로 그렸다)');
      const box = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
      assert.ok(box && Math.abs(+box[1] - 595.28) < 2 && Math.abs(+box[2] - 841.89) < 2, `A4 세로가 아니다: ${box?.[0]}`);
    });
  }
} finally {
  await browser.close(); server.close();
  fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(samples, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'certificate preview/print: all passed');
process.exitCode = failed ? 1 : 0;
