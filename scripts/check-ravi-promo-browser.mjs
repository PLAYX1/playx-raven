// Production build, intercepted synthetic RPC only. No installed app, wallet or AI access.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=resolve(import.meta.dirname,'..'), dist=resolve(root,'dist'), out=resolve(root,'artifacts/ravi-promo');
mkdirSync(out,{recursive:true});
const profile=mkdtempSync(resolve(tmpdir(),'rv-promo-browser-'));
const url='https://example.test/order?table=1';
// Test-only QR from public synthetic data, with a white background and quiet zone.
execFileSync('python3',['-c',"import qrcode,qrcode.image.svg,sys; qrcode.make(sys.argv[1],image_factory=qrcode.image.svg.SvgPathFillImage,box_size=1).save(sys.argv[2])",url,resolve(profile,'qr.svg')]);
const qr=readFileSync(resolve(profile,'qr.svg'),'utf8');
const appUrl='https://ravenvault.ex.erci.se';
const qrMap={[url]:qr};
for(const link of [appUrl,appUrl+'/en/']) {
  execFileSync('python3',['-c',"import qrcode,qrcode.image.svg,sys; qrcode.make(sys.argv[1],image_factory=qrcode.image.svg.SvgPathFillImage,box_size=1).save(sys.argv[2])",link,resolve(profile,'app-qr.svg')]);
  qrMap[link]=readFileSync(resolve(profile,'app-qr.svg'),'utf8');
}
const saved={name_ko:'시험 카페',name_en:'Fixture Cafe',description:'원두를 직접 볶습니다',currency:'KRW',menu:[{name:'커피',price:3000},{name:'차',price:4000}],hours:{1:{open:'09:00',close:'18:00'}},order_url:url};
const origin='http://rv-promo-fixture.test';
let browser;
try {
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile});
  for(const [width,height] of [[1120,780],[1440,900]]) {
    const context=await browser.createBrowserContext(), page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message)); await page.setViewport({width,height});
    await page.setRequestInterception(true);
    page.on('request',request=>{
      if(request.url().startsWith('data:')){void request.continue();return;}
      if(!request.url().startsWith(origin+'/')){void request.abort();return;}
      const path=new URL(request.url()).pathname;
      if(path.startsWith('/api/')){void request.respond({status:200,contentType:'application/json',body:'{}'});return;}
      const file=resolve(dist,'.'+(path==='/'?'/index.html':path));
      if(!file.startsWith(dist+'/')||!existsSync(file)){void request.respond({status:404,body:''});return;}
      void request.respond({status:200,contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream',body:readFileSync(file)});
    });
    await page.evaluateOnNewDocument((saved,qr,qrMap)=>{
      localStorage.setItem('playx-raven-lang','ko'); window.__CALLS=[]; window.__SHOP=saved; window.__KEYED=false; window.__BAD_AI=false; window.__CLIP='';
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__CLIP=text;}}});
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        window.__CALLS.push({command,args:command==='image_save'?{path:args.path}:args});
        if(command==='shop_load')return window.__SHOP;
        if(command==='qr_svg')return qrMap[args.text]||qr;
        if(command==='api_key_status')return window.__KEYED?{available:{openai:true}}:{};
        if(command==='model_settings')return {};
        if(command==='node_status')return {blocks:1000,headers:1000,progress:1,peers:3};
        if(command==='wallet_balance')return {confirmed:0,unconfirmed:0};
        if(command==='money_status')throw 'Synthetic unavailable';
        if(command==='plugin:app|version')return '0.6.5';
        if(command==='backup_auto')return {error:'Synthetic unavailable'};
        if(command==='backup_survey')return {items:[],automatic:null};
        if(['list_assets','pin_list','my_channels'].includes(command))return [];
        if(command==='artist_profile_get')return {name:'',about:'',picture:'',website:''};
        if(command==='artist_check')return {ok:false};
        if(command==='ai_promo'){
          if(window.__BAD_AI)throw 'Synthetic unavailable';
          return {x:'커피 2,500원',instagram:'차 4,000원 #a #b #c #d #e #f',kakao:'시험 카페\n커피 3,000원\n주문',local:'커피 3,000원'};
        }
        if(command==='plugin:dialog|save')return '/tmp/rv-promo-fixture.png';
        if(command==='image_save'){window.__SAVED=!!args.b64;return {path:args.path};}
        return null;
      },transformCallback:f=>f,metadata:{}};
    },saved,qr,qrMap);
    await page.goto(origin,{waitUntil:'networkidle0'});
    await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
    await page.click('#ravi-open');
    await page.type('#chat-q','오늘 특가 알려 줘'); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.ravi-promo-card textarea')?.value.includes('example.test'));
    assert.equal(await page.evaluate(()=>window.__CALLS.filter(c=>c.command==='ai_promo').length),0);
    assert.ok(await page.$eval('.ravi-promo-card',el=>el.textContent.includes('AI 없이 만든 기본 글')));
    const editor='.ravi-promo-card [role=tabpanel]:not([hidden]) textarea';
    await page.$eval(editor,el=>{el.value='커피 2,500원';el.dispatchEvent(new Event('input'));});
    assert.ok(await page.$eval('.ravi-promo-card [role=tabpanel]:not([hidden]) .promo-warning',el=>el.textContent.includes('메뉴 가격')));
    await page.$eval('.ravi-promo-card [role=tabpanel]:not([hidden]) button',el=>el.click());
    assert.ok((await page.evaluate(()=>window.__CLIP)).startsWith('커피 2,500원\n#'));
    await page.$eval('.ravi-promo-card [role=tabpanel]:not([hidden])',el=>[...el.querySelectorAll('button')].find(b=>b.textContent==='태그만 복사').click());
    assert.ok((await page.evaluate(()=>window.__CLIP)).startsWith('#'));
    await page.$eval('.ravi-promo-card [role=tab]',el=>el.focus()); await page.keyboard.press('ArrowRight');
    assert.equal(await page.$eval('.ravi-promo-card [aria-selected=true]',el=>el.textContent),'인스타그램');
    await page.select('.ravi-promo-card select','en');
    await page.waitForFunction(()=>document.querySelector('.ravi-promo-card textarea')?.value.includes('Fixture Cafe'));
    await page.$eval('.ravi-promo-card',el=>[...el.querySelectorAll('button')].find(b=>b.textContent==='공유 이미지 만들기').click());
    await page.waitForFunction(()=>document.querySelector('.ravi-promo-card img')?.getAttribute('src'));
    await page.addScriptTag({path:resolve(root,'node_modules/jsqr/dist/jsQR.js')});
    const decoded=await page.$eval('.ravi-promo-card img',async img=>{
      await img.decode(); const canvas=document.createElement('canvas'); canvas.width=canvas.height=1080;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,1080,1080);
      return {width:img.naturalWidth,height:img.naturalHeight,url:window.jsQR(pixels.data,1080,1080)?.data};
    });
    assert.deepEqual(decoded,{width:1080,height:1080,url});
    const image=await page.$eval('.ravi-promo-card img',el=>el.src.split(',')[1]);
    writeFileSync(resolve(out,'share-fixture.png'),Buffer.from(image,'base64'));
    await page.$eval('.ravi-promo-card',el=>[...el.querySelectorAll('button')].find(b=>b.textContent==='PNG 저장').click());
    await page.waitForFunction(()=>window.__SAVED===true);
    assert.equal(await page.$eval('#chat-log',el=>el.scrollWidth<=el.clientWidth+1),true,'no horizontal overflow');
    const geometry=await page.$eval('#ravi-panel',el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});
    assert.ok(geometry.left>=88&&geometry.top>=80&&geometry.right<=width&&geometry.bottom<=height);
    await page.screenshot({path:resolve(out,`card-${width}x${height}.png`)});
    // Existing plus menu opens the tools containing another entry.
    await page.click('#ravi-plus'); assert.equal(await page.$eval('#ravi-tools',el=>el.open),true);
    assert.ok(await page.$eval('#ravi-tools',el=>!!el.querySelector('#ravi-tools-promo')));
    // The owner's regression: app request + sample-only shop + no saved order link/key.
    await page.evaluate(()=>{window.__SHOP={name:'플레이엑스',menu:[{name:'샘플 아메리카노',price:.01},{name:'샘플 카페라떼',price:10},{name:'샘플 치즈케이크',price:1}]};});
    await page.type('#chat-q','레이븐볼트 홍보글 써 줘'); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.ravi-promo-card').length===2 && [...document.querySelectorAll('.ravi-promo-card')].at(-1).querySelector('textarea').value.includes('RavenVault'));
    assert.equal(await page.evaluate(()=>window.__CALLS.filter(c=>c.command==='ai_promo').length),0);
    assert.equal(await page.$$eval('.ravi-promo-card',els=>els.at(-1).querySelector('[aria-pressed=true]').textContent),'레이븐볼트 앱');
    assert.equal(await page.$$eval('.ravi-promo-card',els=>els.at(-1).querySelector('label:last-of-type input').value),'레이븐코인으로 장사하는 지갑');
    assert.equal(await page.$$eval('.ravi-promo-card',els=>[...els.at(-1).querySelectorAll('button')].find(b=>b.textContent==='공유 이미지 만들기').disabled),false);
    assert.equal(await page.$$eval('.ravi-promo-card',els=>els.at(-1).querySelector('textarea').value.includes('샘플')),false);
    await page.$$eval('.ravi-promo-card',els=>[...els.at(-1).querySelectorAll('button')].find(b=>b.textContent==='공유 이미지 만들기').click());
    await page.waitForFunction(()=>[...document.querySelectorAll('.ravi-promo-card')].at(-1).querySelector('img').getAttribute('src'));
    const appDecoded=await page.$$eval('.ravi-promo-card',async els=>{
      const img=els.at(-1).querySelector('img');await img.decode(); const c=document.createElement('canvas');c.width=c.height=1080;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return window.jsQR(ctx.getImageData(0,0,1080,1080).data,1080,1080)?.data;
    });
    assert.equal(appDecoded,appUrl);
    const appImage=await page.$$eval('.ravi-promo-card',els=>els.at(-1).querySelector('img').src.split(',')[1]);
    writeFileSync(resolve(out,'app-share-fixture.png'),Buffer.from(appImage,'base64'));
    await page.screenshot({path:resolve(out,`app-card-${width}x${height}.png`)});
    await page.$$eval('.ravi-promo-card',els=>[...els.at(-1).querySelectorAll('button')].find(b=>b.textContent==='내 가게').click());
    await page.waitForFunction(()=>[...document.querySelectorAll('.ravi-promo-card')].at(-1).textContent.includes('메뉴를 먼저 등록하세요'));
    await page.evaluate(saved=>{window.__SHOP=saved;window.__KEYED=true;},saved);
    // Provider refresh is the existing model/key UI flow; invoke its change handler.
    await page.$eval('#ai-pick',el=>{el.value='openai';el.dispatchEvent(new Event('change'));});
    await page.click('#ravi-promo-open');
    await page.waitForFunction(()=>window.__CALLS.some(c=>c.command==='ai_promo'));
    await page.waitForFunction(()=>[...document.querySelectorAll('.ravi-promo-card')].at(-1).textContent.includes('AI로 만든 초안'));
    assert.ok(await page.$$eval('.ravi-promo-card',els=>els.at(-1).textContent.includes('메뉴 가격')));
    await page.evaluate(()=>{window.__BAD_AI=true;});
    await page.$$eval('.ravi-promo-card',els=>[...els.at(-1).querySelectorAll('button')].find(b=>b.textContent==='다시 쓰기').click());
    await page.waitForFunction(()=>[...document.querySelectorAll('.ravi-promo-card')].at(-1).textContent.includes('AI 초안을 받지 못해'));
    assert.ok(await page.$$eval('.ravi-promo-card',els=>els.at(-1).textContent.includes('AI 없이 만든 기본 글')));
    assert.equal(errors.length,0,errors.join('\n'));
    assert.equal(await page.evaluate(()=>window.__CALLS.some(c=>/send_from|pay_order|broadcast_message|ai_image/.test(c.command))),false);
    await context.close();
  }
  console.log('PASS production browser: natural request/no-key template, tabs/edit/copy, language, AI fixture/warnings/fallback, 1080 PNG and decoded QR, save dialog, plus menu, contained layout (1120/1440), no payments or paid AI');
} finally { await browser?.close(); rmSync(profile,{recursive:true,force:true}); }
