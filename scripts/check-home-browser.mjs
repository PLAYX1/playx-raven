// REAL browser geometry: serve npm run build's dist unchanged, run its entrypoint.
// No render-function fixture, HTML replacement, addStyleTag or source bundling.
// Usage: npm run build && node scripts/check-home-browser.mjs
// Baseline: node scripts/check-home-browser.mjs --baseline --dist /path/to/old/dist
// Separate evidence: node scripts/check-home-browser.mjs --out docs/handoff/homefit2-captures
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, join, extname, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), baseline = args.includes('--baseline');
const dist = resolve(root, args.includes('--dist') ? args[args.indexOf('--dist') + 1] : 'dist');
const phase = baseline ? 'before' : 'after';
const out = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/handoff/home-captures');
mkdirSync(out, {recursive:true});
const evidence = {status:'running', phase, kind:'production dist / real Chrome geometry',
  fixture:'synthetic unlocked wallet; 42.125 RVN; 8 transactions; 3 assets; one AI provider available (no key material)',
  sales:'shop/ledger absent or present; gated sales-account disclosure is never requested',
  network:'only this run’s 127.0.0.1 static origin allowed; all other requests aborted; WebSocket/WebTransport disabled',
  checks:[], errors:[]};
const profile = mkdtempSync(join(tmpdir(), 'rv-homefit-'));
let browser, server, stage = 'build-check';

export { installFixture } from './desktop-fixture.mjs';
import { installFixture } from './desktop-fixture.mjs';

// Reports scroll containers AND visual clipping/occlusion. A hidden-overflow fix
// cannot pass by merely removing a scrollbar. No measured DOM/CSS is modified.
export function measureHome() {
  const describe = el => el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const shown = el => !!el?.getClientRects().length && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).display !== 'none';
  const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom}; };
  const visible = el => {
    if (!shown(el)) return false;
    const r=el.getBoundingClientRect();
    if(r.width<=0 || r.height<=0 || r.x<0 || r.y<0 || r.right>innerWidth+.5 || r.bottom>innerHeight+.5) return false;
    for(let p=el.parentElement;p;p=p.parentElement){
      const s=getComputedStyle(p), b=p.getBoundingClientRect();
      if(Number(s.opacity)===0 || s.visibility!=='visible')return false;
      if(/auto|scroll|hidden|clip/.test(s.overflowY) && (r.top<b.top-.5 || r.bottom>b.bottom+.5)) return false;
      if(/auto|scroll|hidden|clip/.test(s.overflowX) && (r.left<b.left-.5 || r.right>b.right+.5)) return false;
    }
    return [[r.x+2,r.y+2],[r.right-2,r.bottom-2],[r.x+r.width/2,r.y+r.height/2]].every(([x,y])=>{
      const top=document.elementFromPoint(x,y); return top && (el.contains(top)||top.contains(el));
    });
  };
  const containers=[document.documentElement,document.body,...document.querySelectorAll('body *')].filter(el=>shown(el) &&
    (el===document.documentElement||el===document.body||el.matches('main,#page-home,.rv-home-grid')||/auto|scroll/.test(getComputedStyle(el).overflowY+' '+getComputedStyle(el).overflowX)));
  const scroll=containers.map(el=>({selector:describe(el), scrollHeight:el.scrollHeight, clientHeight:el.clientHeight,
    vertical:Math.max(0,el.scrollHeight-el.clientHeight), scrollWidth:el.scrollWidth, clientWidth:el.clientWidth,
    horizontal:Math.max(0,el.scrollWidth-el.clientWidth), scrollTop:el.scrollTop}));
  const core={balance:'#overview-balance', send:'#rv-home-send', receive:'#overview-receive', transactions:'#rv-home-txs',
    ravi:'#ravi-stage', raviState:'#ravi-state', raviCaption:'#ravi-caption', raviOpen:'#ravi-open', notifications:'.rv-home-safety', lock:'#rv-home-lock-state', sales:'#rv-home-today'};
  const elements=Object.fromEntries(Object.entries(core).map(([name,selector])=>{const el=document.querySelector(selector);return [name,{selector,visible:visible(el),rect:el?rect(el):null}];}));
  const cards=[...document.querySelectorAll('#page-home .rv-home-grid > div')].map(el=>({selector:describe(el),visible:visible(el),rect:rect(el),
    // Find children painted beyond the card, including overflow:visible.
    escaped:[...el.querySelectorAll('button,p,.rv-home-entry,.rv-home-signals,h2,summary')].filter(shown).filter(c=>{
      const a=el.getBoundingClientRect(), b=c.getBoundingClientRect();return b.bottom>a.bottom+.5||b.right>a.right+.5||b.left<a.left-.5||b.top<a.top-.5;
    }).map(describe)}));
  const controls=[...document.querySelectorAll('#page-home button,#page-home summary')].filter(shown).map(el=>{
    const r=rect(el), clippingAncestors=[];
    for(let p=el.parentElement;p;p=p.parentElement){
      const s=getComputedStyle(p),b=p.getBoundingClientRect();
      if((/auto|scroll|hidden|clip/.test(s.overflowY)&&(r.y<b.top-.5||r.bottom>b.bottom+.5))||
         (/auto|scroll|hidden|clip/.test(s.overflowX)&&(r.x<b.left-.5||r.right>b.right+.5)))clippingAncestors.push(describe(p));
    }
    const hitTests=[[r.x+2,r.y+2],[r.right-2,r.bottom-2],[r.x+r.width/2,r.y+r.height/2]].map(([x,y])=>{
      const top=document.elementFromPoint(x,y);
      return {x,y,top:top?describe(top):null,owned:!!top&&(el.contains(top)||top.contains(el))};
    });
    return {selector:describe(el),name:el.getAttribute('aria-label')||el.textContent.trim(),...r,visible:visible(el),clippingAncestors,hitTests};
  });
  const rgb = color => {const v=color.match(/[\d.]+/g)?.map(Number); return v?.length>=3 ? [v[0]/255,v[1]/255,v[2]/255,v[3]??1] : [0,0,0,0];};
  const over=(a,b)=>[...a.slice(0,3).map((x,i)=>x*a[3]+b[i]*(1-a[3])),1];
  const bg=el=>{const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);return chain.reduce((c,p)=>over(rgb(getComputedStyle(p).backgroundColor),c),[1,1,1,1]);};
  const lum=c=>c.slice(0,3).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
  const contrast=[];const walker=document.createTreeWalker(document.querySelector('#page-home'),NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    const node=walker.currentNode, el=node.parentElement;
    if(!node.textContent.trim()||!shown(el))continue;
    const range=document.createRange();range.selectNodeContents(node);if(!range.getBoundingClientRect().height)continue;
    const background=bg(el), foreground=over(rgb(getComputedStyle(el).color),background), a=lum(foreground), b=lum(background);
    contrast.push({selector:describe(el),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
  }
  const details=document.querySelector('#rv-home-extras');
  return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,scroll,
    vertical:Math.max(...scroll.map(s=>s.vertical)),horizontal:Math.max(...scroll.map(s=>s.horizontal)), elements,cards,controls,contrast,
    extras:details?{open:details.open,visible:visible(details.querySelector('summary'))}:null,
    transactionRows:document.querySelectorAll('#rv-home-txs .rv-home-entry').length,
    fixture:{calls:[...new Set(window.__homeFixture.calls)],unavailable:[...new Set(window.__homeFixture.unavailable)],forbidden:window.__homeFixture.forbidden}};
}

try {
  assert.ok(existsSync(join(dist,'index.html')), 'Missing dist/index.html; run npm run build first');
  const html=await readFile(join(dist,'index.html'));
  assert.ok(!html.includes('/src/main.ts'), 'Serve a production build, not source HTML');
  evidence.buildHTMLHash=createHash('sha256').update(html).digest('hex');
  evidence.buildAssets = {};
  for(const match of html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)){
    evidence.buildAssets[match[1]]=createHash('sha256').update(await readFile(join(dist,match[1].slice(1)))).digest('hex');
  }
  stage='launch';
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:true, userDataDir:profile, args:['--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync']});
  stage='listen';
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
  server=createServer(async(req,res)=>{
    try{
      const path=resolve(dist,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
      if(path!==dist&&!path.startsWith(dist+sep))throw Error('path');
      const file=path===dist?join(dist,'index.html'):path;
      if(!['GET','HEAD'].includes(req.method)||!(await stat(file)).isFile())throw Error('file');
      res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:await readFile(file));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const [width,height] of [[1024,640],[1280,720],[1440,900],[1728,1117]])for(const theme of ['light','dark'])for(const sales of [false,true]){
    stage=`render-${width}x${height}-${theme}-${sales?'sales':'no-sales'}`;
    const page=await browser.newPage();const errors=[];let blockedRequests=0;
    page.on('pageerror',e=>errors.push(e.message));
    await page.setViewport({width,height,deviceScaleFactor:1});
    await page.setBypassServiceWorker(true);
    await page.emulateTimezone('Asia/Seoul');
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.setRequestInterception(true);
    page.on('request',req=>{
      // Permit assets only; even local XHR/fetch is blocked. No backend exists.
      const allowed=new URL(req.url()).origin===origin&&['document','script','stylesheet','image','font','media','other'].includes(req.resourceType())&&req.method()==='GET';
      if(allowed)void req.continue();else{blockedRequests++;void req.abort();}
    });
    // Shop owners in the fixture also run seller mode; the other half are ordinary users.
    await page.evaluateOnNewDocument(installFixture,{theme,sales,seller:sales});
    await page.goto(origin+'/',{waitUntil:'networkidle0'});
    try {
      await page.waitForFunction(()=>document.querySelector('#page-home.on')&&
        document.querySelector('#overview-balance')?.textContent.includes('42.125')&&
        document.querySelectorAll('#rv-home-txs .rv-home-entry').length===3&&
        document.querySelector('#ravi-caption')?.textContent.includes('깨어났어요')&&
        document.querySelector('#rv-home-lock-state')?.textContent.includes('열려')&&
        !document.documentElement.hasAttribute('data-ravi-arriving')&&
        !document.querySelector('#rv-home-today-body')?.textContent.includes('확인하는 중'),{timeout:20000});
      await page.evaluate(()=>document.fonts.ready);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const result=await page.evaluate(measureHome);
      const filename=`${phase}-${width}x${height}-${theme}-${sales?'sales':'no-sales'}.png`;
      await page.screenshot({path:join(out,filename),fullPage:false});
      const failures=[];
      const check=(on,message)=>{if(!on)failures.push(message);};
      check(errors.length===0,'uncaught browser errors');check(result.fixture.forbidden.length===0,'forbidden native command requested');
      check(result.vertical===0,`vertical overflow ${result.vertical}px`);
      check(result.horizontal===0,`horizontal overflow ${result.horizontal}px`);
      check(result.scroll.every(s=>s.scrollTop===0),'initial scroll position is not zero');
      check(Object.values(result.elements).every(e=>e.visible),'core element clipped/occluded/outside first screen');
      check(result.cards.every(c=>c.visible&&c.escaped.length===0),'card content clipped/escaped');
      check(result.controls.every(c=>c.height>=36&&c.width>=36&&c.visible),'control below 36px or outside viewport');
      const controlFailures=result.controls.filter(c=>c.height<36||c.width<36||!c.visible);
      check(result.contrast.every(c=>c.ratio>=4.5),'text contrast below 4.5:1');
      const salesText=await page.$eval('#rv-home-today-body',el=>el.textContent);
      check(sales?salesText.includes('32,500')&&salesText.includes('KRW'):salesText.includes('아직 가게가 없습니다'),'wrong sales fixture rendered');
      check(['wallet_balance','wallet_lock_state','recent_transactions','list_assets','api_key_status','shop_load'].every(c=>result.fixture.calls.includes(c)),'production app did not consume required fixtures');
      check(await page.$$eval('input[type="password"]',els=>els.every(el=>!el.value)),'unexpected credential field value');
      check(await page.$eval('#sales-public',el=>el.children.length===0),'sales disclosure must remain concealed');
      check(await page.evaluate(seller=>{const els=['#rv-home-sales','nav a[data-page="sales"]','#game-sales-open'].map(q=>document.querySelector(q));
        return els.every(el=>el&&(seller?(!el.hidden&&!el.inert):(el.hidden&&el.inert&&!el.getClientRects().length)));},sales),'seller-only entrances must follow seller mode (hidden+inert when off)');
      const keyboard={};
      if(!baseline){
        const readingCards=[...result.cards].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x).map(c=>c.selector);
        check(JSON.stringify(readingCards)===JSON.stringify(result.cards.map(c=>c.selector)),'card DOM order differs from visual reading order');
        check(result.extras?.visible,'missing more disclosure');
        check(result.extras?.open===(width>1100&&height>680),'incorrect responsive disclosure state');
        if(width===1024){
          await page.focus('#rv-home-extras summary');await page.keyboard.press('Enter');
          check(await page.$eval('#rv-home-extras',el=>el.open),'Enter does not expand more');
          await page.keyboard.press('Tab');
          check(await page.evaluate(()=>document.activeElement.id==='rv-home-nearby'),'keyboard order after disclosure');
          await page.focus('#rv-home-extras summary');await page.keyboard.press('Enter');
        }
        // Check DOM focus order by real keyboard events, no clicks on send/receive.
        const expected=await page.$$eval('#page-home button,#page-home summary',els=>els.filter(el=>el.getClientRects().length&&!el.disabled).map(el=>el.id||el.tagName));
        await page.focus('#rv-home-send');const actual=[];
        for(let i=0;i<expected.length;i++){actual.push(await page.evaluate(()=>document.activeElement.id||document.activeElement.tagName));await page.keyboard.press('Tab');}
        Object.assign(keyboard,{expected,actual});
        check(JSON.stringify(actual)===JSON.stringify(expected),'keyboard order differs from reading order');
        await page.focus('#ravi-open');await page.keyboard.press('Enter');
        await page.waitForFunction(()=>!document.querySelector('#ravi-panel').hidden);
        await page.keyboard.press('Escape');
        keyboard.focusAfterEscape=await page.evaluate(()=>document.activeElement.id||document.activeElement.tagName);
        check(await page.evaluate(()=>document.querySelector('#ravi-panel').hidden&&document.activeElement.id==='ravi-open'),'conversation close must return focus to the visible home control');
        check(errors.length===0,'browser error during keyboard checks');
      }
      evidence.checks.push({...result,sales,screenshot:filename,blockedRequests,browserErrors:errors,failures,controlFailures,keyboard});
      console.log(`${baseline?'BASELINE':failures.length?'FAIL':'PASS'} ${width}x${height} ${theme} ${sales?'sales':'no-sales'}: y=${result.vertical}px x=${result.horizontal}px`);
      if(failures.length)console.log(JSON.stringify({failures,controlFailures,keyboard},null,2));
    }catch(error){
      const filename=`${phase}-${width}x${height}-${theme}-${sales?'sales':'no-sales'}-error.png`;
      await page.screenshot({path:join(out,filename)});
      evidence.errors.push({stage,reason:String(error),browserErrors:errors,screenshot:filename,
        fixture:await page.evaluate(()=>({calls:[...new Set(window.__homeFixture?.calls)],unavailable:[...new Set(window.__homeFixture?.unavailable)]}))});
    }finally{await page.close();}
  }
  const failed=evidence.errors.length||(!baseline&&evidence.checks.some(c=>c.failures.length));
  evidence.status=failed?'failed':baseline?'measured':'passed';
  if(failed)process.exitCode=1;
}catch(error){
  evidence.status=['launch','listen'].includes(stage)?'blocked':'failed';
  evidence.errors.push({stage,reason:String(error)});process.exitCode=1;
  console.error(`HOME BROWSER ${evidence.status}: ${stage}: ${String(error)}`);
}finally{
  writeFileSync(join(out,`${phase}.json`),JSON.stringify(evidence,null,2)+'\n');
  // Machine-generated table is separate so a rerun never overwrites the handoff.
  const rows=evidence.checks.map(c=>`| ${c.width}×${c.height} | ${c.theme} | ${c.sales?'있음':'없음'} | ${c.vertical} | ${c.horizontal} | ${Object.values(c.elements).every(e=>e.visible)?'모두 표시':'가림/화면 밖'} |`);
  writeFileSync(join(out,`${phase}.md`),`실제 브라우저 ${phase}: **${evidence.status}**\n\n| 창 | 테마 | 판매 가게 | 세로 넘침 px | 가로 넘침 px | 핵심 요소 |\n|---|---|---|---:|---:|---|\n${rows.join('\n')}\n${rows.length?'':'측정값 없음. 0px가 아닙니다. JSON의 실패 단계를 확인하세요.\n'}`);
  await browser?.close();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  rmSync(profile,{recursive:true,force:true});
}
