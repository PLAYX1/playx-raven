// Real production controllers and SVG, synthetic state only. All network intercepted.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
const root=resolve(import.meta.dirname,'..'),out=join(root,'docs/handoff/opening-captures');mkdirSync(out,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'rv-opening-'));
const executablePath=process.env.CHROME_PATH||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const entry=`
import {mountRaviRig} from './src/ravi-rig';
import {openingFrame} from './src/ravi-choreography';
import {mountRaviOpening} from './src/ravi-opening';
import {mountRaviLifecycle} from './src/ravi-lifecycle';
import {installFirstRunBarrier,afterRaviLanding,finishRaviLanding} from './src/firstrun';
import {setLang} from './src/i18n';
import './src/ravi-home.css';
const host=document.querySelector('#bird'),rig=mountRaviRig(host);
window.state={lock:'open',active:0,tray:true};window.calls=[];
window.pending=false;window.failPrepare=false;
const lifecycle=mountRaviLifecycle({idleMs:60_000,pending:()=>window.pending,invoke:async name=>{
 window.calls.push(name);
 if(name==='ravi_lifecycle_status')return {...window.state};
 if(name==='ravi_prepare_quit'){if(window.failPrepare)throw Error('fixture');return {lock:'locked'};}
 return null;
}});
window.test={...lifecycle,setLang,autoIdle(){lifecycle.destroy();mountRaviLifecycle({idleMs:0,pending:()=>false,invoke:async()=>window.state});},frame:ms=>rig.renderFrame(openingFrame(ms)),
 opening(){installFirstRunBarrier();window.released=0;window.actions=0;document.querySelector('#fixture-action').onclick=()=>window.actions++;
 const player=mountRaviOpening(host,()=>{window.grounded=host.querySelector('[id$="ravi-character"]').getAttribute('transform');finishRaviLanding();});
 afterRaviLanding(()=>window.released++);host.onclick=player.finish;return true;}
};
`;
const built=await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,format:'iife',write:false,outdir:join(profile,'build'),plugins:[{name:'raw-svg',setup(b){b.onResolve({filter:/\.svg\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-svg'}));b.onLoad({filter:/.*/,namespace:'raw-svg'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));}}]});
const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
const tokens=readFileSync(join(root,'index.html'),'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
const html=`<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${css}\nbody{display:block}#fixture-data{padding:40px}.capture-stage{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none}.capture-stage #bird{width:260px;height:289px;background:transparent;border:0;pointer-events:auto}.capture-stage svg{width:100%;height:100%;overflow:visible}</style></head><body><main id="fixture-data"><h1>RavenVault</h1><p id="private-fixture">PRIVATE FIXTURE · concealed in idle</p><button id="fixture-action">Fixture action</button></main><div class="capture-stage"><button id="bird" data-ravi-skip aria-label="Skip greeting"></button></div><script src="/bundle.js"></script></body></html>`;
const evidence={status:'running',screenshots:[],checks:[]};let browser;
try{
 if(!executablePath)throw Error('Chrome executable not found; set CHROME_PATH');
 browser=await puppeteer.launch({executablePath,headless:true,userDataDir:profile,args:['--no-first-run']});
 const page=await browser.newPage();await page.setViewport({width:1280,height:800});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
 page.on('request',req=>{if(req.url()==='http://opening.test/')void req.respond({status:200,contentType:'text/html',body:html});else if(req.url()==='http://opening.test/bundle.js')void req.respond({status:200,contentType:'application/javascript',body:js});else void req.abort();});
 const reset=async()=>{await page.goto('http://opening.test/',{waitUntil:'load'});await page.waitForFunction(()=>!!window.test);};
 const snap=async name=>{await page.screenshot({path:join(out,name+'.png')});evidence.screenshots.push(name+'.png');};
 await reset();
 // Fixed-time samples use the exact production interpolator and rig renderer.
 for(const percent of [0,25,50,75,100]){await page.evaluate(p=>window.test.frame(2400*p/100),percent);await snap(`opening-${percent}`);}
 await page.evaluate(()=>window.test.opening());await page.click('#fixture-action');
 assert.equal(await page.evaluate(()=>window.actions),0);assert.equal(await page.evaluate(()=>window.released),0);
 await page.click('#bird');await page.waitForFunction(()=>window.released===1);
 assert.equal(await page.evaluate(()=>window.actions),1);assert.match(await page.evaluate(()=>window.grounded),/translate\(0 0\)/);
 evidence.checks.push('capture input deferred; skip paints grounded pose before one barrier release');
 for(const theme of ['light','dark'])for(const lang of ['ko','en','ja','zh']){
   await reset();await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
   await page.evaluate(lang=>{window.test.setLang(lang);return window.test.requestClose();},lang);
   assert.equal(await page.$eval('.ravi-lifecycle-actions button',b=>document.activeElement===b),true);
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('dialog')),true);
   await snap(`quit-${lang}-${theme}`);await page.keyboard.press('Escape');
   assert.equal(await page.$eval('dialog',d=>d.open),false);
   await page.evaluate(()=>window.test.rest());assert.equal(await page.$eval('#private-fixture',e=>getComputedStyle(e).visibility),'hidden');
   assert.equal(await page.$eval('dialog',e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)'),false);
   await snap(`idle-${lang}-${theme}`);await page.keyboard.press('x');await page.waitForFunction(()=>!document.querySelector('dialog').open);
   assert.equal(await page.evaluate(()=>window.calls.includes('lock_wallet')||window.calls.includes('unlock_wallet')),false);
 }
 evidence.checks.push('4 languages × 2 themes; modal keyboard focus/Escape; opaque idle privacy; wake never unlocks');
 await reset();await page.evaluate(()=>{window.state.active=1;return window.test.requestClose();});
 assert.equal(await page.$eval('.ravi-quit',b=>b.disabled),true);await snap('quit-transfer');
 await page.keyboard.press('Escape');
 for(const lock of ['locked','unencrypted','unknown']){await page.evaluate(lock=>{window.state.active=0;window.state.lock=lock;return window.test.requestClose();},lock);await snap(`quit-${lock}`);await page.keyboard.press('Escape');}
 await page.evaluate(()=>{window.failPrepare=true;return window.test.requestClose();});await page.click('.ravi-quit');
 await page.waitForFunction(()=>window.calls.includes('ravi_cancel_quit'));assert.equal(await page.evaluate(()=>window.calls.includes('ravi_finish_quit')),false);
 await page.keyboard.press('Escape');await page.evaluate(()=>{window.failPrepare=false;return window.test.requestClose();});await page.click('.ravi-quit');
 await snap('farewell');await page.waitForFunction(()=>window.calls.includes('ravi_finish_quit'));
 evidence.checks.push('pending transfer blocks quit; lock states; failed prepare never exits; successful farewell exits');
 await reset();await page.evaluate(()=>window.test.autoIdle());await page.waitForFunction(()=>document.querySelector('dialog').open,{timeout:4000});assert.equal(await page.$eval('#private-fixture',e=>getComputedStyle(e).visibility),'hidden');
 await reset();await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.evaluate(()=>window.test.opening());await page.waitForFunction(()=>window.released===1,{timeout:1500});await snap('opening-reduced');
 assert.deepEqual(errors,[]);evidence.checks.push('automatic idle timer; reduced-motion completion; no browser errors');evidence.status='passed';
 console.log('PASS opening browser:',evidence.checks.join('; '));
}catch(error){evidence.status='failed';evidence.error=String(error);console.error('FAIL opening browser:',String(error));process.exitCode=1;}
finally{writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2)+'\n');await browser?.close();rmSync(profile,{recursive:true,force:true});}
