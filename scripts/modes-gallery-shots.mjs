// artifacts/modes-gallery/index.html 시안을 PNG 로(테마·가림·판매자·말 조합). 정적 파일 — 네트워크 없음.
import puppeteer from 'puppeteer-core';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = resolve(import.meta.dirname, '../artifacts/modes-gallery');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const combos = [['light', 1, 0, 'ko'], ['dark', 1, 1, 'ko'], ['light', 0, 1, 'ko'], ['dark', 0, 0, 'ko'], ['light', 1, 1, 'de'], ['dark', 1, 1, 'ru']];
for (const [theme, mask, seller, lang] of combos) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  await page.goto(`${pathToFileURL(join(dir, 'index.html'))}?theme=${theme}&mask=${mask}&seller=${seller}&lang=${lang}`);
  await page.screenshot({ path: join(dir, `gallery-${theme}-${mask ? 'masked' : 'open'}-${seller ? 'seller' : 'plain'}-${lang}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log('ok', combos.length);
