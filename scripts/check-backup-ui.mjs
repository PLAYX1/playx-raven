// Synthetic browser rendering only. Does not launch Tauri, a node, a wallet,
// miner, IPFS, or a tunnel. All native commands are replaced before page load.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const root = fileURLToPath(new URL('../', import.meta.url)), dist = resolve(root, 'dist');
const out = resolve(root, 'artifacts/backup-ui');
const profile = resolve(out, 'synthetic-browser-profile');
mkdirSync(out, {recursive:true});
assert.ok(!existsSync(profile), 'A new isolated browser profile is required');
mkdirSync(profile);
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.webp':'image/webp', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const path = resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!path.startsWith(dist + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
  response.writeHead(200, {'content-type':mime[extname(path)] || 'application/octet-stream'}); response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const evidence = [];
try {
  browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, userDataDir:profile });
  for (const language of ['ko','en','ja','zh']) {
    const page = await browser.newPage();
    await page.setViewport({width:1120,height:780});
    await page.setRequestInterception(true);
    page.on('request', request => { if (request.url().startsWith(origin + '/') || request.url().startsWith('data:')) request.continue(); else request.abort(); });
    await page.evaluateOnNewDocument(language => {
      localStorage.setItem('playx-raven-lang', language);
      window.__RV_OPENED = []; window.__RV_BAD = false; window.__BACKUP_MODE = 'missing'; window.__RESTORE_MODE = 'partial';
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command === 'plugin:opener|open_url') { window.__RV_OPENED.push(args.url); return; }
          if (command === 'plugin:app|version') return '0.4.1';
          if (command === 'backup_auto') return {error:'Synthetic automatic backup failure',warning:'Synthetic status file unavailable'};
          if (command === 'backup_survey') return {items:[],automatic:null};
          if (command === 'plugin:dialog|open') { window.__LAST_DIALOG = args.options; return '/synthetic-backup.zip.pxlock'; }
          if (command === 'restore_survey') return {day:'Synthetic <img src=x>',items:[{key:'wallet',what:'Synthetic wallet',detail:'fixture',why:'fixture'}],empty:false,note:'fixture'};
          if (command === 'restore_apply') return window.__RESTORE_MODE === 'complete'
            ? {ok:true,status:'complete',done:[{what:'Synthetic wallet',previous:'/synthetic-previous-wallet'}],failed:[],note:'fixture'}
            : {ok:false,status:'partial',done:[{what:'Synthetic shop'}],failed:[{what:'Synthetic wallet',why:'Synthetic verification <img src=x>',changed:true,previous:'/synthetic-previous-wallet'}],note:'fixture',cleanup_warning:'Synthetic cleanup failed'};

          if (command === 'backup_zip') {
            if (window.__BACKUP_MODE === 'error') throw 'Synthetic <img src=x onerror="window.__RV_BAD=true">';
            return {verified:true,locked:true,wallet_included:window.__BACKUP_MODE !== 'missing',
              name:'Synthetic <img src=x onerror="window.__RV_BAD=true">.zip.pxlock',size_text:'1 MB',pretty:'Synthetic destination',
              inside:window.__BACKUP_MODE === 'missing' ? [] : [{name:'wallet.dat',what:'Synthetic wallet fixture',size:42}]};
          }
          if (command === 'api_key_status') return {openai:true,custom:true,custom_label:'<img src=x onerror="window.__RV_BAD=true">'};
          if (command === 'model_settings') return {openai:{model:'synthetic" onfocus="window.__RV_BAD=true',default:'synthetic-model'}};
          if (command === 'list_assets' || command === 'pin_list' || command === 'my_channels') return [];
          if (command === 'artist_profile_get') return {name:'',about:'',picture:'',website:''};
          if (command === 'artist_check') return {ok:false,why:'Synthetic profile not published'};
          return null;
        }, transformCallback: f => f, metadata:{}
      };
    }, language);
    await page.goto(origin + '/', {waitUntil:'networkidle0'});
    await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
    await page.waitForFunction(() => !!document.querySelector('#rv-webwallet'));
    await page.$eval('#rv-webwallet', e => e.click());
    await page.waitForFunction(() => window.__RV_OPENED.length > 0);
    assert.deepEqual(await page.evaluate(() => window.__RV_OPENED), ['https://ravenvault.ex.erci.se/wallet/']);
    const measures = await page.evaluate(() => {
      const button = document.querySelector('#rv-webwallet'), box=button.getBoundingClientRect();
      return { label:button.textContent, width:box.width, height:box.height, font:parseFloat(getComputedStyle(button).fontSize), overflow:document.documentElement.scrollWidth-innerWidth, title:document.title };
    });
    assert.equal(measures.title,'RavenVault Desktop'); assert.ok(measures.height>=64);assert.ok(measures.width>=64);assert.ok(measures.font>=16);assert.equal(measures.overflow,0);
    await page.screenshot({path:resolve(out,`home-${language}-1120x780.png`)});
    await page.$eval('nav [data-page="settings"]', e => e.click());
    await page.waitForFunction(() => !!document.querySelector('#model-openai'));
    assert.equal(await page.$eval('#model-openai', e => e.getAttribute('onfocus')), null);
    assert.equal(await page.$eval('#model-openai', e => e.value), 'synthetic" onfocus="window.__RV_BAD=true');
    assert.equal(await page.$eval('#keyrows', e => e.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => window.__RV_BAD), false);
    await page.waitForFunction(() => document.querySelector('#bk-list').textContent.includes('Synthetic automatic backup failure'));
    await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; document.querySelector('#bk-go').scrollIntoView(); });
    await page.$eval('#bk-go', e => e.click());
    await page.waitForFunction(() => document.querySelector('#bk-result .warnbox'));
    assert.equal(await page.$eval('#bk-result', e => e.querySelectorAll('.card').length), 0);
    await page.screenshot({path:resolve(out,`backup-missing-${language}.png`)});
    await page.evaluate(() => { window.__BACKUP_MODE = 'valid'; });
    await page.$eval('#bk-go', e => e.click());
    await page.waitForFunction(() => document.querySelector('#bk-result .card'));
    assert.equal(await page.$eval('#bk-result', e => e.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => window.__RV_BAD), false);
    assert.equal(await page.$eval('#mv-all', e => e.disabled), true);
    const heading = await page.$eval('#bk-result h3', e => e.textContent);
    if (language !== 'ko') assert.ok(!/[가-힣]/.test(heading), 'New backup title follows the saved language');
    await page.$eval('#bk-result', e => e.scrollIntoView());
    await page.screenshot({path:resolve(out,`backup-complete-${language}.png`)});
    await page.evaluate(() => { window.__BACKUP_MODE = 'error'; });
    await page.$eval('#bk-go', e => e.click());
    await page.waitForFunction(() => document.querySelector('#bk-result .warnbox'));
    assert.equal(await page.$eval('#bk-result', e => e.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => window.__RV_BAD), false);
    await page.$eval('#rs-pick', e => e.click());
    await page.waitForSelector('#rs-go');
    await page.$eval('#rs-go', e => e.click());
    await page.waitForSelector('#askwrap.on');
    await page.$eval('#ask-yes', e => e.click());
    await page.waitForFunction(() => document.querySelector('#rs-result').textContent.includes('Synthetic cleanup failed'));
    assert.equal(await page.$eval('#rs-result code', e => e.textContent), '/synthetic-previous-wallet');
    assert.equal(await page.$eval('#rs-result', e => e.querySelectorAll('img').length), 0);
    const partialTitle = await page.$eval('#rs-result h3', e => e.textContent);
    await page.$eval('#rs-result', e => e.scrollIntoView());
    await page.screenshot({path:resolve(out,`restore-partial-${language}.png`)});
    await page.evaluate(() => { window.__RESTORE_MODE = 'complete'; });
    await page.$eval('#rs-pick', e => e.click());
    await page.waitForSelector('#rs-go');
    await page.$eval('#rs-go', e => e.click());
    await page.waitForSelector('#askwrap.on');
    await page.$eval('#ask-yes', e => e.click());
    await page.waitForFunction(() => !!document.querySelector('#rs-result code'));
    assert.notEqual(await page.$eval('#rs-result h3', e => e.textContent), partialTitle);
    await page.$eval('#rs-folder', e => e.click());
    await page.waitForSelector('#rs-go');
    assert.equal(await page.evaluate(() => window.__LAST_DIALOG.directory), true);
    evidence.push({language,...measures,folderRestoreAvailable:true,partialRestoreIsNotComplete:true,actualPreviousPathShown:true,omissionRefused:true,failureEscaped:true,successEscaped:true,automaticFailureShownWhenStatusWriteFails:true,heading,native:'mocked; no private data'});
    await page.close();
  }
  writeFileSync(resolve(out,'ui-measurements.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally { if (browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); rmSync(profile,{recursive:true,force:true}); }
