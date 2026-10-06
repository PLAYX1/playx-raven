// Production UI with synthetic RPC/speech only. No wallet data or external requests.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const out = resolve(root, 'artifacts/desktop-ravi-chat'); mkdirSync(out, { recursive:true });
const profile = mkdtempSync(resolve(tmpdir(), 'rv-chat-profile-'));
const origin = 'http://rv-chat-fixture.test';
let browser; const evidence = [];
const main = ts.createSourceFile('main.ts',readFileSync(resolve(root,'src/main.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const bubble = main.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='raviBubble').getText(main);
const bubbleJS = ts.transpileModule(bubble,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const visible = (page,selector) => page.$eval(selector, el => !!el.getClientRects().length);
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
try {
  browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, userDataDir:profile });
  for (const [width,height] of [[1280,720],[1440,900],[1920,1080]]) {
    const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [];
    page.on('pageerror',e=>errors.push(e.message)); await page.setViewport({width,height});
    await page.setRequestInterception(true);
    page.on('request',request=> {
      const url=request.url();
      if(url.startsWith('data:')) { void request.continue(); return; }
      if(!url.startsWith(origin+'/')) { void request.abort(); return; }
      const path=new URL(url).pathname;
      if(path.startsWith('/api/')) { void request.respond({status:200,contentType:'application/json',body:'{}'}); return; }
      const file=resolve(dist,'.'+(path==='/'?'/index.html':path));
      if(!file.startsWith(dist+'/')||!existsSync(file)){void request.respond({status:404,body:''});return;}
      void request.respond({status:200,contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp'})[extname(file)]||'application/octet-stream',body:readFileSync(file)});
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('playx-raven-lang','ko'); window.__CALLS=[]; window.__ABORTS=0; window.__CANCELS=0;
      class Recognition { start(){window.__RECOGNITION=this;} abort(){window.__ABORTS++;} }
      window.SpeechRecognition=Recognition;
      Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{name:'Yuna',lang:'ko-KR'}],cancel(){window.__CANCELS++;},speak(u){window.__SPOKEN=u;}}});
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        window.__CALLS.push(command);
        if(command==='node_status')return {blocks:1000,headers:1000,progress:1,peers:3};
        if(command==='wallet_balance')return {confirmed:12.5,unconfirmed:0};
        if(command==='money_status')throw 'Synthetic unavailable status';
        if(command==='api_key_status')return {};
        if(command==='model_settings')return {};
        if(command==='plugin:app|version')return '0.6.4';
        if(command==='backup_auto')return {error:'Synthetic unavailable backup'};
        if(command==='backup_survey')return {items:[],automatic:null};
        if(['list_assets','pin_list','my_channels'].includes(command))return [];
        if(command==='artist_profile_get')return {name:'',about:'',picture:'',website:''};
        if(command==='artist_check')return {ok:false,why:'Synthetic unavailable profile'};
        return null;
      },transformCallback:f=>f,metadata:{}};
    });
    await page.goto(origin,{waitUntil:'networkidle0'});
    await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
    await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-ravi-arriving'));
    await settle(page);
    assert.equal(await page.$('#ravi-face'),null,'old hidden webp hero has been removed');
    assert.equal(await page.$eval('#ravi-home-slot',el=>!!el.querySelector('#chat-log')),false);
    await page.click('#ravi-open'); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),true);
    assert.equal(await page.$eval('#ravi-panel-rig',el=>!!el.querySelector('svg')),true);
    assert.equal(await page.$eval('#ravi-panel',el=>el.parentElement.tagName),'BODY');
    await page.type('#chat-q','이체도 가능한가?'); await page.keyboard.press('Enter'); await settle(page);
    await page.waitForFunction(()=>document.querySelectorAll('#chat-log .msg.me').length===1);
    assert.equal(await page.$eval('#chat-q',el=>el.value),'');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-q');
    assert.equal(await page.$eval('#chat-log',el=>el.scrollHeight-el.scrollTop-el.clientHeight<3),true);
    await page.type('#chat-q','첫 줄'); await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); await page.type('#chat-q','둘째 줄');
    assert.equal(await page.$eval('#chat-q',el=>el.value),'첫 줄\n둘째 줄');
    assert.equal(await page.$$eval('#chat-log .msg.me',els=>els.length),1);
    await page.$eval('#chat-q',el=>el.value='');
    for(let i=0;i<12;i++){ await page.type('#chat-q','백업은 어떻게 하나요?'); await page.keyboard.press('Enter'); }
    await settle(page);
    assert.equal(await page.$eval('#chat-log',el=>el.scrollHeight-el.scrollTop-el.clientHeight<3),true,'new replies follow the bottom');
    await page.$eval('#chat-log',el=>el.scrollTop=0); await settle(page);
    // A delayed answer arrives while the reader has deliberately scrolled up.
    await page.$eval('#chat-log [data-guide-topic]',el=>el.click()).catch(async()=>{
      await page.evaluate(()=>{ const b=document.createElement('button'); b.dataset.guideTopic='send'; document.querySelector('#chat-log').append(b); b.click(); b.remove(); });
    });
    await settle(page);
    assert.equal(await page.$eval('#chat-log',el=>el.scrollTop),0,'reading position retained');
    assert.equal(await visible(page,'#ravi-new'),true);
    await page.click('#ravi-new'); await settle(page);
    assert.equal(await page.$eval('#chat-log',el=>el.scrollHeight-el.scrollTop-el.clientHeight<3),true);
    assert.equal(await visible(page,'#ravi-new'),false);
    await page.click('nav a[data-page="wallet"]'); await settle(page);
    // Draw the real production navigation toast with synthetic copy and face dependencies.
    await page.evaluate(code=>{
      const PAGE_NAMES={wallet:'지갑'},copyHtml=s=>s,t=s=>s,escapeHtml=s=>s,raviState='sleep';
      const raviFace=()=>{const face=document.createElement('span');face.className='ravi-face';face.style.width='40px';face.style.height='40px';return face;};
      eval(code+';raviBubble("wallet","받은 돈과 보낼 곳입니다");');
    },bubbleJS); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),true,'panel survives navigation');
    await page.click('#ravi-expand'); await settle(page);
    const geometry = await page.evaluate(()=>{
      const rect = id => {const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      return {panel:rect('ravi-panel'),input:rect('chat-q'),toast:rect('ravibub'),history:rect('chat-log'),header:document.querySelector('.desktop-header').getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.equal(geometry.overflow,0); assert.ok(geometry.panel.top>=geometry.header);
    assert.ok(geometry.input.top>geometry.history.bottom); assert.ok(geometry.input.bottom<=geometry.panel.bottom);
    assert.ok(geometry.toast.right<geometry.panel.left,'toast never covers panel');
    await page.screenshot({path:resolve(out,`panel-${width}x${height}.png`)}); evidence.push({width,height,...geometry});
    // Native approval remains the sole route to payment; speech cannot click/send.
    await page.click('#rv-voice');
    const cancels = await page.evaluate(()=>window.__CANCELS);
    await page.evaluate(()=>{const s=document.querySelector('#send-review');s.style.display='block';s.style.position='fixed';s.style.inset='120px 100px 40px';}); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),false); assert.equal(await page.evaluate(()=>window.__ABORTS>0),true);
    assert.equal(await page.evaluate(()=>window.__CANCELS>0),true); assert.ok(await page.evaluate(()=>window.__CANCELS)>=cancels);
    await page.evaluate(()=>document.querySelector('#send-review').style.display='none'); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),true);
    assert.equal(await page.evaluate(()=>window.__CALLS.some(c=>c==='send_rvn'||c==='send_asset')),false);
    // Keyboard remains nonmodal and a late response never steals focus from the page.
    await page.focus('#desktop-preferences'); await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),false); assert.equal(await page.evaluate(()=>document.activeElement.id),'desktop-preferences');
    await page.reload({waitUntil:'networkidle0'}); await page.addStyleTag({content:'#onboard,#hello{display:none!important}'}); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),false,'collapsed state persists');
    await page.click('#rv-header-ravi'); await settle(page);
    assert.equal(await page.$eval('#ravi-panel',el=>el.classList.contains('large')),true,'size persists');
    await page.reload({waitUntil:'networkidle0'}); await page.addStyleTag({content:'#onboard,#hello{display:none!important}'}); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),false,'restart never restores an open conversation');
    assert.equal(await page.$eval('#ravi-panel',el=>el.classList.contains('large')),true);
    assert.deepEqual(errors,[]);
    await context.close(); console.log(`PASS ${width}×${height}: shared panel, Enter/Shift+Enter, focus, scroll/new reply, toast, approval speech stop, Escape and persisted size/open state`);
  }
  writeFileSync(resolve(out,'geometry.json'),JSON.stringify(evidence,null,2)+'\n');
} finally { await browser?.close(); rmSync(profile,{recursive:true,force:true}); }
