// REAL browser geometry: serve npm run build's dist unchanged, run its entrypoint.
// No render-function fixture, HTML replacement, addStyleTag or source bundling.
// Usage: npm run build && node scripts/check-home-browser.mjs
// Baseline: node scripts/check-home-browser.mjs --baseline --dist /path/to/old/dist
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
const out = join(root, 'docs/handoff/home-captures');
mkdirSync(out, {recursive:true});
const evidence = {status:'running', phase, kind:'production dist / real Chrome geometry',
  fixture:'synthetic unlocked wallet; 42.125 RVN; 8 transactions; 3 assets; one AI provider available (no key material)',
  sales:'shop/ledger absent or present; gated sales-account disclosure is never requested',
  network:'only this run’s 127.0.0.1 static origin allowed; all other requests aborted; WebSocket/WebTransport disabled',
  checks:[], errors:[]};
const profile = mkdtempSync(join(tmpdir(), 'rv-homefit-'));
let browser, server, stage = 'build-check';

// Serialized into the page before ANY production code runs. Only public synthetic
// metadata, never mnemonic/private-key/password/account-public-key material.
export function installFixture({theme, sales}) {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('ravenvault-theme', theme);
  localStorage.setItem('playx-raven-lang', 'ko');
  localStorage.setItem('rv-ravi-start-off', '1');
  localStorage.setItem('rv-companion-page', 'home');
  const calls = [], unavailable = [], forbidden = [], callbacks = new Map(); let callbackId = 1;
  window.__homeFixture = {calls, unavailable, forbidden};
  const txs = Array.from({length:8}, (_, i) => ({
    txid: `public-home-fixture-${i}`, time:1791500400 - i * 3600,
    category:i % 3 === 1 ? 'send' : 'receive', amount:i % 3 === 1 ? -1.25 : 3.5 + i,
    confirmations:i ? 18 + i : 2, asset_name:i === 2 ? 'HOMEFIT/COFFEE' : '',
  }));
  const shop = sales ? {name:'동네 가게', chain_asset:'HOMEFIT/SHOP', currency:'KRW', hours:[], items:[]} : {};
  const data = {
    node_status:{progress:1, blocks:4000000, headers:4000000, connections:8, chain:'regtest'},
    wallet_balance:{confirmed:42.125, unconfirmed:3.5, immature:0, total:45.625},
    wallet_lock_state:{encrypted:true, unlocked:true},
    backup_survey:{automatic:{local_complete:true}, items:[]}, backup_auto:{skipped:true},
    recent_transactions:txs, wallet_since:{transactions:txs, lastblock:'public-fixture-block'},
    list_assets:['COFFEE','TICKET','ART'].map((name,i) => ({name:`HOMEFIT/${name}`, root:'HOMEFIT', amount:i + 2, mine:false, units:0, reissuable:false, ipfs_hash:null})),
    api_key_status:{platform:'macos', available:{openai:true}, has_key:{openai:true}, storage:{openai:'keychain'}},
    model_settings:{}, ai_order_read:{customer:{order:['openai']}, owner:{order:['openai']}},
    ravi_consent:{reviewed:true, balance:false, transactions:false, shop:false},
    ravi_lifecycle_status:{lock:'open', active:0, tray:true}, ravi_take_close_request:false,
    companion_settings:{saved:true, settings:{greeting:false, notice_seen:true, enabled:true, size:160, locale:'ko', timezone:-540, battery:false}},
    shop_load:shop, ledger_range:{total:32500, currency:'KRW', sales:4, mixed_currency:false, unreadable_rows:0},
    ledger_pending:{count:2}, mode_get:{chosen:true, mode:'shop'},
    talk_rooms:[{name:'동네 소식', about:'오늘의 이야기'}], talk_read:[], talk_me:{pubkey:'public-home-fixture'}, talk_profiles:{},
    pin_list:[], owner_tokens:[], create_fingerprints:[], create_history_list:[], my_channels:{channels:[]},
    words_restore_status:null, reindex_progress:null, fee_owed:{owed:0},
    sweep_run:{swept:false, why:'disabled'}, sweep_read:{enabled:false},
    ipfs_status:{online:true, peers:3}, relay_status:{running:true}, tunnel_status:{running:false},
    map_status:{published:false}, map_load:{}, map_check:{ok:false, errors:[]},
    service_health:{state:'ok', node:true, ipfs:true, phone:true},
    services_status:{node:true, ipfs:true}, autostart_status:{enabled:false},
    miner_running:{running:false}, mac_miners:[], mining_status:{enabled:false},
    report_queue:[], report_pending:[], report_count:0, report_flush:null,
    ai_models_refresh:null, companion_signal:null, companion_save:null, voice_cancel:null,
    rvn_rate:{krw:25, price:25}, fee_read:{percent:1},
    member_groups:[], member_groups_list:[], member_privacy_get:{}, shop_seal_block_get:false,
    addr_book:[], backup_places:[], conf_read:{}, ipfs_config:{},
    datadir_status:{path:'/public-fixture', exists:true},
    node_identity:{name:'홈 배치 확인', id:'public-home-fixture'},
    money_status:{}, backup_pass_state:{configured:true},
    start_phone_server:{ip:'127.0.0.1', admin_url:'http://127.0.0.1:8790/admin', staff_url:'http://127.0.0.1:8790/staff', scan_url:'http://127.0.0.1:8790/scan', customer_url:'http://127.0.0.1:8790/'},
    // Existing startup may request shop publication. These are inert IPC stubs;
    // no native code, key derivation, HTTP or chain RPC is ever invoked.
    publish_shop:null, shop_announce:null, qr_svg:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>',
  };
  const invoke = async (command) => {
    calls.push(command); // Deliberately never retain arguments.
    if (/reveal|unlock|passphrase|send_rvn|send_asset|broadcast|sign_transaction|^sales_account_/.test(command)) {
      forbidden.push(command); throw Error('home fixture: forbidden command');
    }
    if (command === 'plugin:event|listen') return callbackId++;
    if (['plugin:event|unlisten','plugin:event|emit','plugin:event|emit_to'].includes(command)) return null;
    if (command === 'plugin:window|is_focused') return true;
    if (command === 'plugin:app|version') return '0.8.4';
    if (command === 'plugin:app|name') return 'RavenVault Desktop';
    if (command === 'plugin:updater|check') return null;
    if (Object.hasOwn(data, command)) return structuredClone(data[command]);
    unavailable.push(command);
    throw Error(`home fixture: unavailable ${command}`); // Unknown data never becomes a false success.
  };
  window.__TAURI_INTERNALS__ = {
    invoke, metadata:{currentWindow:{label:'main'}, currentWebview:{label:'main'}},
    transformCallback(fn, once = false) { const id=callbackId++; callbacks.set(id, value => {fn?.(value); if(once)callbacks.delete(id);}); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, value) { callbacks.get(id)?.(value); },
    convertFileSrc() { return 'data:,'; },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
  window.__TAURI__ = {core:{invoke}, event:{listen:async()=>()=>{}}};
  window.isTauri = true;
  window.WebSocket = class {constructor(){throw Error('home fixture: external socket blocked');}};
  window.WebTransport = class {constructor(){throw Error('home fixture: external transport blocked');}};
}

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
  const controls=[...document.querySelectorAll('#page-home button,#page-home summary')].filter(shown).map(el=>({selector:describe(el),...rect(el), visible:visible(el)}));
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
    await page.evaluateOnNewDocument(installFixture,{theme,sales});
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
      check(result.contrast.every(c=>c.ratio>=4.5),'text contrast below 4.5:1');
      const salesText=await page.$eval('#rv-home-today-body',el=>el.textContent);
      check(sales?salesText.includes('32,500')&&salesText.includes('KRW'):salesText.includes('아직 가게가 없습니다'),'wrong sales fixture rendered');
      check(['wallet_balance','wallet_lock_state','recent_transactions','list_assets','api_key_status','shop_load'].every(c=>result.fixture.calls.includes(c)),'production app did not consume required fixtures');
      check(await page.$$eval('input[type="password"]',els=>els.every(el=>!el.value)),'unexpected credential field value');
      check(await page.$eval('#sales-public',el=>el.children.length===0),'sales disclosure must remain concealed');
      if(!baseline){
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
        check(JSON.stringify(actual)===JSON.stringify(expected),'keyboard order differs from reading order');
        await page.focus('#ravi-open');await page.keyboard.press('Enter');
        await page.waitForFunction(()=>!document.querySelector('#ravi-panel').hidden);
        await page.keyboard.press('Escape');
        check(await page.evaluate(()=>document.querySelector('#ravi-panel').hidden&&document.activeElement.id==='ravi-open'),'conversation close must return focus to the visible home control');
        check(errors.length===0,'browser error during keyboard checks');
      }
      evidence.checks.push({...result,sales,screenshot:filename,blockedRequests,browserErrors:errors,failures});
      console.log(`${baseline?'BASELINE':failures.length?'FAIL':'PASS'} ${width}x${height} ${theme} ${sales?'sales':'no-sales'}: y=${result.vertical}px x=${result.horizontal}px`);
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
