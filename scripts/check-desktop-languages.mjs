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
const out = resolve(root, 'artifacts/claude-desktop-identity');
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
    const context=await browser.createBrowserContext();
    const page=await context.newPage();
    const pageErrors=[];page.on("pageerror",e=>pageErrors.push(e.message));
    await page.setViewport({width,height});
    await page.setRequestInterception(true);
    page.on('request',r=>r.url().startsWith(origin+'/')||r.url().startsWith('data:')?r.continue():r.abort());
    await page.evaluateOnNewDocument(({language,fixture,qr}) => {
      if(!localStorage.getItem('language-fixture-initialized')) {localStorage.setItem('playx-raven-lang', language);localStorage.setItem('language-fixture-initialized','1');}
      window.__RV_OPENED = []; window.__RV_BAD = false; window.__BACKUP_MODE = 'missing'; window.__RESTORE_MODE = 'partial';
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          window.__PHONE_CALLS ??= []; window.__REVIEW_MODE ??= 'good';
          if (command === 'qr_svg') { if(args.text !== 'https://ravenvault.ex.erci.se/wallet/') throw 'Unexpected QR'; return qr; }
          if (command === 'node_status') return {blocks:1000,headers:1000,progress:window.__NODE_PROGRESS??1,peers:3};
          if (command === 'wallet_balance') return window.__BALANCE_MODE==='known'?{confirmed:12.5,unconfirmed:9999}:null;
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
          if (command === 'plugin:app|version') return '0.4.2';
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
          if (command === 'artist_check') return {ok:false,why:'이 자산에는 아직 프로필이 안 붙어 있습니다.'};
          return null;
        }, transformCallback: f => f, metadata:{}
      };
    }, {language,fixture,qr});

    await page.goto(origin+'/',{waitUntil:'networkidle0'});
    await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
    for(const screen of ['ravi','talk','wallet','assets','artist','shop','settings','preferences','phone','backup']) {
      const target=screen==='phone'?'ravi':['backup','preferences'].includes(screen)?'settings':screen;
      await page.$eval(`nav [data-page="${target}"]`,e=>e.click());
      if(screen==='phone')await page.$eval('#phone-tx-panel',e=>e.open=true);
      if(screen==='backup')await page.$eval('#bk-go',e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;e.scrollIntoView()});
      await page.$eval('main',e=>e.scrollTop=0);
      if(screen==='preferences'&&!process.argv.includes('--baseline'))await page.$eval('#desktop-preferences',e=>e.click());
      await new Promise(r=>setTimeout(r,250));
      const result=await page.evaluate(()=>{
        const found=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
        while(w.nextNode()) {const n=w.currentNode,e=n.parentElement;if(!e||e.closest('script,style,[translate="no"],.langsw')||!/[가-힣]/.test(n.textContent))continue;
          const range=document.createRange();range.selectNode(n);const rect=range.getBoundingClientRect();
          if(rect.width&&rect.height&&e.checkVisibility())found.push({text:n.textContent.trim().replace(/\s+/g,' '),element:e.id||e.tagName});
        }
        for(const e of document.querySelectorAll('[placeholder]')) {
          if(e.checkVisibility() && e.getBoundingClientRect().width && /[가-힣]/.test(e.getAttribute('placeholder')||''))found.push({text:e.getAttribute('placeholder'),element:e.id,attribute:'placeholder'});
        }
        return {hangul:found,overflow:Math.max(document.documentElement.scrollWidth-innerWidth,document.querySelector('main').scrollWidth-document.querySelector('main').clientWidth)};
      });
      evidence.push({language,width,height,screen,...result});
      if(screen==='artist'&&language!=='ko'&&!process.argv.includes('--baseline'))assert.ok(!/[가-힣]/.test(await page.$eval('#ar-nameview',e=>e.textContent)),'Empty profile fallback is translated');
      if(['ravi','artist','preferences'].includes(screen))await page.screenshot({path:resolve(out,`${screen}-${language}-${width}x${height}.png`)});
    }
    if(!process.argv.includes('--baseline')&&!process.argv.includes('--no-live')) {
      // Switching every primary screen must not reload or lose a pending transaction.
      await page.evaluate(()=>{window.__LANG_SENTINEL='alive';document.querySelector('#phone-tx-code').value='synthetic pending draft';});
      for(const target of ['ravi','talk','wallet','assets','artist','shop','settings']) {
        await page.$eval(`nav [data-page="${target}"]`,e=>e.click());
        for(const next of ['en','ja','zh','ko']) {
          await page.$eval(`#desktop-language-menu [data-language="${next}"]`,e=>e.click());
          await new Promise(r=>setTimeout(r,100));
          const state=await page.evaluate(()=>({alive:window.__LANG_SENTINEL,locale:document.documentElement.lang,draft:document.querySelector('#phone-tx-code').value,selected:document.querySelector('.page.on').id,saved:localStorage.getItem('playx-raven-lang'),label:document.querySelector('#desktop-preferences').innerText}));
          assert.equal(state.alive,'alive');assert.equal(state.locale,next);assert.equal(state.saved,next);assert.equal(state.selected,'page-'+target);assert.equal(state.draft,'synthetic pending draft');
          assert.ok(state.label.includes({en:'Settings',ja:'設定',zh:'设置',ko:'설정'}[next]));
          if(next!=='ko') {
            const leaked=await page.evaluate(()=>{
              const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),out=[];
              while(w.nextNode()){const n=w.currentNode,e=n.parentElement;if(!e||e.closest('script,style,[translate="no"]')||!e.checkVisibility())continue;const r=document.createRange();r.selectNode(n);if(r.getBoundingClientRect().width&&/[가-힣]/.test(n.textContent))out.push(n.textContent.trim());}
              return out;
            });
            assert.deepEqual(leaked,[],`${target} switching to ${next}`);
          }
        }
      }
      // A user profile that happens to match a dictionary key is still user text.
      await page.$eval('#ar-name',(e)=>{e.value='이야기';e.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.$eval('#ar-about',(e)=>{e.value='사용자가 쓴 소개';e.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.$eval('#desktop-language-menu [data-language="en"]',e=>e.click());
      assert.equal(await page.$eval('#ar-name',e=>e.value),'이야기');
      assert.equal(await page.$eval('#ar-nameview',e=>e.textContent),'이야기');
      assert.equal(await page.$eval('#ar-aboutview',e=>e.textContent),'사용자가 쓴 소개');
      await page.$eval('nav [data-page="ravi"]',e=>e.click());
      await page.evaluate(()=>{window.__NODE_PROGRESS=0.5;window.__BALANCE_MODE='known';});
      await page.$eval('nav [data-page="ravi"]',e=>e.click());
      await page.waitForFunction(()=>document.querySelector('#overview-balance').textContent==='12.5 RVN');
      assert.match(await page.$eval('#overview-node',e=>e.textContent),/50.0%/);
      assert.ok(!(await page.$eval('.overview',e=>e.textContent)).includes('9999'),'Unconfirmed funds excluded');
      await page.evaluate(()=>window.__BALANCE_MODE='unknown');
      await page.$eval('nav [data-page="ravi"]',e=>e.click());
      await page.waitForFunction(()=>document.querySelector('#overview-balance').textContent==='Unable to verify');
      await page.$eval('#overview-receive',e=>e.click());
      assert.equal(await page.$eval('.page.on',e=>e.id),'page-wallet');
      await page.$eval('nav [data-page="ravi"]',e=>e.click());
      await page.$eval('#overview-phone',e=>e.click());
      assert.ok(await page.$eval('#phone-tx-panel',e=>e.open));
      // Reload does not overwrite the stored preference: remove the fixture's initialization first.
      await page.evaluate(()=>localStorage.setItem('playx-raven-lang','zh'));
      await page.reload({waitUntil:'networkidle0'});
      assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh');
    }
    assert.deepEqual(pageErrors,[],"No browser runtime errors");
    await context.close();
  }
  const baseline=process.argv.includes('--baseline');
  writeFileSync(resolve(out,baseline?'languages-red.json':'languages-green.json'),JSON.stringify(evidence,null,2)+'\n');
  const failures=evidence.filter(x=>x.language!=='ko'&&x.hangul.length);
  console.log(JSON.stringify({screens:evidence.length,liveTransitions:process.argv.includes('--no-live')?0:224,remaining:failures.reduce((a,x)=>a+x.hangul.length,0),unique:[...new Set(failures.flatMap(x=>x.hangul.map(t=>t.text)))]},null,2));
  assert.equal(failures.length,0,'Non-Korean screens contain Korean text');
  assert.ok(evidence.every(x=>x.overflow===0),'No horizontal overflow');
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});}
