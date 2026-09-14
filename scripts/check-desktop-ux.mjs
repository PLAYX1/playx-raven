// Synthetic browser rendering only. Does not launch Tauri, a node, a wallet,
// miner, IPFS, or a tunnel. All native commands are replaced before page load.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import jsQR from 'jsqr';
const root = fileURLToPath(new URL('../', import.meta.url)), dist = resolve(root, 'dist');
const out = resolve(root, process.env.RV_UI_ARTIFACTS || 'artifacts/claude-desktop-ux');
const fixture=JSON.parse(readFileSync(resolve(root,'scripts/phone-transaction-fixture.json'),'utf8'));
const qr=readFileSync(resolve(root,'artifacts/claude-desktop-ux/phone-url-qr.svg'),'utf8');
const profile = resolve(out, 'ux-browser-profile');
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
  for (const [width,height] of [[1120,780],[1440,900]]) for (const language of ['ko','en','ja','zh']) {
    const page = await browser.newPage();
    const pageErrors=[];page.on("pageerror",e=>pageErrors.push(e.message));
    await page.setViewport({width,height});
    await page.setRequestInterception(true);
    page.on('request', request => { if (request.url().startsWith(origin + '/') || request.url().startsWith('data:')) request.continue(); else request.abort(); });
    await page.evaluateOnNewDocument(({language,fixture,qr}) => {
      localStorage.setItem('playx-raven-lang', language);
      window.__RV_OPENED = []; window.__RV_BAD = false; window.__BACKUP_MODE = 'missing'; window.__RESTORE_MODE = 'partial';
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          window.__PHONE_CALLS ??= []; window.__REVIEW_MODE ??= 'good';
          if (command === 'qr_svg') { if(args.text !== 'https://ravenvault.ex.erci.se/wallet/') throw 'Unexpected QR'; return qr; }
          if (command === 'node_status') return {blocks:1000,headers:1000,progress:1,peers:3};
          if (command === 'money_status') throw 'Synthetic status unavailable';
          if (command === 'phone_transaction_review') {
            window.__PHONE_CALLS.push({command,args});
            if(window.__REVIEW_MODE==='error')throw '거래 코드의 형식·버전·길이를 확인하세요. 폰에서 서명한 거래 코드를 다시 복사하세요.';
            if(window.__REVIEW_MODE==='slow')await new Promise(resolve=>window.__REVIEW_RESOLVE=resolve);
            return {hex:fixture.raw,txid:fixture.txid,fee:'0.00010000',outputs:[
              {index:0,addresses:[fixture.recipient],rvn:'0.00500000',assetKnown:true,asset:null},
              {index:1,addresses:[fixture.own],rvn:'0.00490000',assetKnown:false,asset:null}
            ]};
          }
          if (command === 'phone_transaction_send') {window.__PHONE_CALLS.push({command,args});return {txid:fixture.txid};}
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
    }, {language,fixture,qr});
    await page.goto(origin + '/', {waitUntil:'networkidle0'});
    await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
    await page.$eval('nav [data-page="ravi"]', e => e.click());
    await page.waitForFunction(()=>document.querySelector('#ravi-tiles').children.length>0);
    const measures=await page.evaluate(()=>{
      const nav=document.querySelector('nav').getBoundingClientRect(),side=document.querySelector('nav .brand').getBoundingClientRect(),hero=document.querySelector('#ravi-face').getBoundingClientRect();
      return {nav:nav.width,sidebarWidth:side.width,heroWidth:hero.width,sidebarFits:side.left>=nav.left&&side.right<=nav.right,overflow:document.documentElement.scrollWidth-innerWidth,duplicateBrand:!!document.querySelector('nav .brandravi,nav h1'),heroSrc:document.querySelector('#ravi-face').getAttribute('src')};
    });
    assert.equal(measures.nav,172);assert.equal(measures.overflow,0);assert.ok(measures.sidebarFits);assert.ok(measures.heroWidth>=180);assert.equal(measures.duplicateBrand,false);assert.equal(measures.heroSrc,'/raven-hello.webp');
    assert.equal(await page.$('#rv-webwallet'),null);
    if(language!=='ko')await page.waitForFunction(()=>!/가게 만들기/.test(document.querySelector('#ravi-tiles').innerText));
    await page.screenshot({path:resolve(out,`ravi-${language}-${width}x${height}.png`)});
    await page.$eval('#rv-phone-info', e=>{e.open=true;e.scrollIntoView();});
    await page.waitForSelector('#rv-phone-qr svg');
    const pixels=await page.$eval('#rv-phone-qr svg',async svg=>{
      const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg.outerHTML);await img.decode();
      const canvas=document.createElement('canvas');canvas.width=440;canvas.height=440;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,440,440);return Array.from(ctx.getImageData(0,0,440,440).data);
    });
    assert.equal(jsQR(new Uint8ClampedArray(pixels),440,440)?.data,'https://ravenvault.ex.erci.se/wallet/');
    await page.$eval('#rv-phone-open',e=>e.click());
    assert.deepEqual(await page.evaluate(()=>window.__RV_OPENED),['https://ravenvault.ex.erci.se/wallet/']);
    await page.screenshot({path:resolve(out,`phone-entry-${language}-${width}x${height}.png`)});
    await page.$eval('#rv-phone-info',e=>e.open=false);
    // 가게가 없으면 첫 칸은 「가게 만들기」(대표님 결정), 폰 거래는 한눈에 띠에서 연다.
    assert.match(await page.$eval('#ravi-tiles button:first-child',e=>e.innerText),language==='ko'?/가게 만들기/:/./);
    await page.$eval('#overview-phone',e=>e.click());
    await page.waitForFunction(()=>document.querySelector('#phone-tx-panel').open);
    await page.screenshot({path:resolve(out,`transaction-input-${language}-${width}x${height}.png`)});
    const put=async value=>page.$eval('#phone-tx-code',(e,value)=>{e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));},value);
    const sends=()=>page.evaluate(()=>window.__PHONE_CALLS.filter(c=>c.command==='phone_transaction_send').length);
    await page.$eval('#phone-tx-send',e=>e.click());assert.equal(await sends(),0);
    await put(fixture.parts.slice(1).join('\n'));await page.$eval('#phone-tx-check',e=>e.click());
    await page.waitForFunction(()=>document.querySelector('#phone-tx-status').textContent.length>0&&!document.querySelector('#phone-tx-check').disabled);
    assert.equal(await page.evaluate(()=>window.__PHONE_CALLS.length),0);
    await put([...fixture.parts].reverse().join('\n'));await page.$eval('#phone-tx-check',e=>e.click());
    await page.waitForFunction(()=>!document.querySelector('#phone-tx-send').hidden);
    assert.equal(await sends(),0);
    assert.ok(await page.$eval('#phone-tx-preview',e=>e.textContent.includes('0.00500000 RVN')&&e.textContent.includes('0.00490000 RVN')));
    if(language!=='ko')assert.ok(!/[가-힣]/.test(await page.$eval('#phone-tx-panel',e=>e.innerText)),'All new transaction copy translated: '+await page.$eval('#phone-tx-panel',e=>e.innerText));
    await page.$eval('#phone-tx-preview',e=>e.scrollIntoView());
    await page.screenshot({path:resolve(out,`transaction-review-${language}-${width}x${height}.png`)});
    // Editing invalidates review, including a response that finishes after editing.
    await put('ravenvault://transaction?v=1&hex=00');await page.$eval('#phone-tx-send',e=>e.click());assert.equal(await sends(),0);
    await page.evaluate(()=>window.__REVIEW_MODE='slow');
    await put('ravenvault://transaction?v=1&hex='+fixture.raw);await page.$eval('#phone-tx-check',e=>e.click());
    await page.waitForFunction(()=>typeof window.__REVIEW_RESOLVE==='function');
    await put('changed');await page.evaluate(()=>window.__REVIEW_RESOLVE());
    await page.waitForFunction(()=>!document.querySelector('#phone-tx-check').disabled);
    assert.equal(await page.$eval('#phone-tx-send',e=>e.hidden),true);assert.equal(await sends(),0);
    await page.evaluate(()=>window.__REVIEW_MODE='good');
    await put('ravenvault://transaction?v=1&hex='+fixture.raw);await page.$eval('#phone-tx-check',e=>e.click());
    await page.waitForFunction(()=>!document.querySelector('#phone-tx-send').hidden);
    await page.$eval('#phone-tx-send',e=>{e.click();e.click();});
    await page.waitForFunction(()=>window.__PHONE_CALLS.some(c=>c.command==='phone_transaction_send'));
    assert.equal(await sends(),1);
    assert.equal(await page.evaluate(()=>window.__PHONE_CALLS.find(c=>c.command==='phone_transaction_send').args.expectedTxid),fixture.txid);
    assert.equal(await page.evaluate(()=>window.__PHONE_CALLS.find(c=>c.command==='phone_transaction_send').args.confirmed),true);
    // Error copy follows locale and leaves send unavailable.
    await page.evaluate(()=>window.__REVIEW_MODE='error');await put('ravenvault://transaction?v=1&hex=g0');await page.$eval('#phone-tx-check',e=>e.click());
    await page.waitForFunction(()=>!document.querySelector('#phone-tx-check').disabled);
    assert.equal(await page.$eval('#phone-tx-send',e=>e.hidden),true);assert.equal(await sends(),1);
    if(language!=='ko')assert.ok(!/[가-힣]/.test(await page.$eval('#phone-tx-status',e=>e.innerText)));
    assert.deepEqual(pageErrors,[],"No browser runtime errors");
    evidence.push({language,width,height,...measures,pageErrors,confirmationGate:true,staleReviewRejected:true,duplicatesBlocked:true,native:'All calls mocked; external requests blocked'});
    await page.close();
  }
  writeFileSync(resolve(out,'ux-measurements.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});}
