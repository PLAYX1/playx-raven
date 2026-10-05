// Production UI with synthetic RPC/speech only. No wallet data or external requests.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const out = resolve(root, 'artifacts/ravi-understand/browser'); mkdirSync(out, { recursive:true });
const profile = mkdtempSync(resolve(tmpdir(), 'rv-chat-profile-'));
const origin = 'http://rv-chat-fixture.test';
let browser;
const visible = (page,selector) => page.$eval(selector, el => !!el.getClientRects().length);
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
try {
  browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, userDataDir:profile });
  for (const [width,height] of [[1440,900]]) {
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
    await settle(page);
    assert.equal(await page.$('#ravi-face'),null,'old hidden webp hero has been removed');
    assert.equal(await page.$eval('#ravi-home-slot',el=>!!el.querySelector('#chat-log')),false);
    await page.click('#ravi-open'); await settle(page);
    assert.equal(await visible(page,'#ravi-panel'),true);
    assert.equal(await page.$eval('#ravi-panel-rig',el=>!!el.querySelector('svg')),true);
    assert.equal(await page.$eval('#ravi-panel',el=>el.parentElement.tagName),'BODY');
    const cases = JSON.parse(readFileSync(resolve(root,'scripts/fixtures/ravi-understanding-60.json'),'utf8'));
    for (const test of cases) {
      await page.$eval('#chat-q',(el,q)=>el.value=q,test.utterance);
      await page.click('#chat-go'); await settle(page);
      const id = await page.$eval('#chat-log .msg.ai:last-child [data-guide]',el=>el.dataset.guide);
      assert.equal(id,test.expected.intent,test.id + ': ' + test.utterance);
    }
    const caps = JSON.parse(readFileSync(resolve(root,'src/ravi-capabilities.json'),'utf8'));
    const translated = (s,lang) => lang==='ko'?s:caps.copy[s][['en','ja','zh'].indexOf(lang)];
    for (const lang of ['ko','en','ja','zh']) {
      // Switch through the actual language selector; dynamic chips repaint from capabilities.
      await page.$eval(`[data-language="${lang}"]`,el=>el.click()); await settle(page);
      assert.equal(await page.$$eval('[data-ravi-starter]',els=>els.length),4);
      for (const topic of caps.guides.filter(g=>g.starter)) {
        await page.click(`.rv-quick [data-ravi-input="${topic.id}"]`);
        assert.equal(await page.$eval('#chat-q',el=>el.value),translated(topic.say,lang));
        await page.click('#chat-go'); await settle(page);
        assert.equal(await page.$eval('#chat-log .msg.ai:last-child [data-guide]',el=>el.dataset.guide),topic.id);
      }
      await page.click('[data-ravi-help]'); await settle(page);
      const help = await page.$eval('#chat-log .msg.ai:last-child',el=>el.innerText);
      if(lang!=='ko')assert.ok(!/[가-힣]/.test(help));
      await page.click('#chat-log .msg.ai:last-child [data-ravi-input="phone"]');
      assert.equal(await page.$eval('#chat-q',el=>el.value),translated('폰 연결 안내',lang));
    }
    await page.$eval('[data-language="ko"]',el=>el.click());
    await page.$eval('#chat-q',el=>el.value='주문 환불은 어떻게 하나요?'); await page.click('#chat-go'); await settle(page);
    await page.click('#chat-log .msg.ai:last-child [data-guide-go="orders"]'); await settle(page);
    assert.ok(await visible(page,'#shoptab-orders'),'order navigation actually opens the screen');
    await page.$eval('#chat-q',el=>el.value='내일 비 와?'); await page.click('#chat-go'); await settle(page);
    assert.equal(await page.$$eval('#chat-log .msg.ai:last-child [data-ravi-input]',els=>els.length),3);
    await page.$eval('#chat-q',el=>el.value='sk-abcdefghijklmnop'); await page.click('#chat-go'); await settle(page);
    assert.ok(!(await page.$eval('#chat-log',el=>el.textContent)).includes('sk-abcdefghijklmnop'));
    assert.equal(await page.evaluate(()=>window.__CALLS.some(c=>/^(ai_chat|ai_ask|ai_image|send_rvn|send_asset|theme_save|shop_save)$/.test(c))),false);
    await page.screenshot({path:resolve(out,'understanding-ko.png')});
    assert.deepEqual(errors,[]);
    await context.close();
    console.log('PASS production UI: 60 utterances, 4-language chips/help/input, order navigation, 3 refusal suggestions, secret redaction, no AI/send/save');
  }
} finally { await browser?.close(); rmSync(profile,{recursive:true,force:true}); }
