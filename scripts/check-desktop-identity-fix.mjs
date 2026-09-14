// Local, synthetic UI only: no installed app, RPC, signing, or port 8790.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import puppeteer from 'puppeteer-core';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'artifacts/claude-desktop-identity-fix');
const baseline=process.argv.includes('--baseline');
const dist=resolve(root,baseline?'artifacts/claude-desktop-identity-fix/baseline-app':'dist');
const profile=resolve(out,baseline?'baseline-layout-profile':'layout-profile');
mkdirSync(out,{recursive:true});assert.ok(!existsSync(profile));
const qr=readFileSync(resolve(root,'artifacts/claude-desktop-ux/phone-url-qr.svg'),'utf8');
const evidence={screens:[],startup:[],idle:null};
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(path==='/api/chain/shops'?{shops:[{asset:'SHOP.FIXTURE',title:'동네 가게',description:'합성 화면 검증용 가게',location:'서울',menu_count:3}]}:{}));return;}
 const base=path==='/'?dist:existsSync(resolve(dist,'.'+path))?dist:resolve(root,'web');
 const file=resolve(base,'.'+(path==='/'?'/index.html':path));
 if(!file.startsWith(base+'/')||!existsSync(file)){res.writeHead(404).end();return;}
 res.writeHead(200,{'content-type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[extname(file)]||'application/octet-stream','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:"});res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
async function open(language,width,height,dark=false,customer=false){
 const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width,height});if(dark)await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'dark'}]);
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin+'/')||r.url().startsWith('data:')?r.continue():r.abort());
 await page.evaluateOnNewDocument(({language,qr})=>{
  localStorage.setItem('playx-raven-lang',language);localStorage.setItem('playx-lang',language);window.__CALLS={};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.__CALLS[command]=(window.__CALLS[command]||0)+1;
   if(command==='node_status')return {blocks:1000,headers:1000,progress:1,peers:3};
   if(command==='wallet_balance')return {confirmed:12.5,unconfirmed:9999};
   if(command==='money_status')throw 'Synthetic status unavailable';
   if(command==='qr_svg')return qr;
   if(command==='plugin:app|version')return '0.4.2';
   if(command==='backup_auto')return {error:'Synthetic backup failure'};
   if(command==='backup_survey')return {items:[],automatic:null};
   if(['list_assets','pin_list','my_channels'].includes(command))return [];
   if(command==='artist_profile_get')return {name:'',about:'',picture:'',website:''};
   if(command==='artist_check')return {ok:false,why:'이 자산에는 아직 프로필이 안 붙어 있습니다.'};
   if(command==='api_key_status')return {openai:true};
   if(command==='model_settings')return {openai:{model:'synthetic-model',default:'synthetic-model'}};
   return null;
  },transformCallback:f=>f,metadata:{}};
 },{language,qr});
 await page.goto(origin+(customer?'/shops.html':'/'),{waitUntil:'networkidle0'});
 if(!customer)await page.addStyleTag({content:'#onboard,#hello{display:none!important}'});
 await new Promise(r=>setTimeout(r,400));return{context,page,errors};
}
try{
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile});
 for(const [width,height]of(baseline?[[1120,780]]:[[1120,780],[1440,900]]))for(const language of(baseline?['ko']:['ko','en'])){
  const{context,page,errors}=await open(language,width,height);
  const calls=await page.evaluate(()=>({...window.__CALLS}));evidence.startup.push({language,width,wallet_balance:calls.wallet_balance,node_status:calls.node_status});
  if(!baseline){
   assert.ok(calls.wallet_balance<=2&&calls.node_status<=2,'Startup reads are shared');
   const geometry=await page.evaluate(()=>{
    const nav=document.querySelector('nav'),main=document.querySelector('main'),rec=document.querySelector('#overview-receive'),phone=document.querySelector('#overview-phone');
    return{overflow:Math.max(document.documentElement.scrollWidth-innerWidth,main.scrollWidth-main.clientWidth,nav.scrollWidth-nav.clientWidth),navWidth:nav.getBoundingClientRect().width,duplicateBrand:!!nav.querySelector('h1,.brandravi'),receiveBg:getComputedStyle(rec).backgroundColor,phoneBg:getComputedStyle(phone).backgroundColor,firstLead:document.querySelector('#ravi-tiles > button').classList.contains('leadtile'),phoneTiles:[...document.querySelectorAll('#ravi-tiles button')].filter(e=>e.textContent.includes(document.querySelector('#overview-phone span').textContent)).length};
   });
   assert.equal(geometry.overflow,0);assert.equal(geometry.navWidth,172);assert.equal(geometry.duplicateBrand,false);assert.equal(geometry.receiveBg,'rgb(255, 255, 255)');assert.equal(geometry.phoneBg,geometry.receiveBg);assert.equal(geometry.firstLead,true);assert.equal(geometry.phoneTiles,0);
   evidence.screens.push({language,width,height,...geometry});
   await page.screenshot({path:resolve(out,`ravi-${language}-${width}x${height}.png`)});
   await page.$eval('#desktop-preferences',e=>e.click());await page.screenshot({path:resolve(out,`settings-menu-${language}-${width}x${height}.png`)});
  }
  if(width===1120&&language==='ko'){
   const before=await page.evaluate(()=>({...window.__CALLS}));
   await new Promise(r=>setTimeout(r,65000));
   const after=await page.evaluate(()=>({...window.__CALLS}));
   evidence.idle=Object.fromEntries(['wallet_balance','node_status','money_status'].map(k=>[k,(after[k]||0)-(before[k]||0)]));
   assert.deepEqual(evidence.idle,{wallet_balance:3,node_status:6,money_status:1},'Existing idle intervals remain unchanged');
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 if(!baseline){
  const{context,page,errors}=await open('ko',1120,780,true);
  const tokens=await page.evaluate(()=>{const c=getComputedStyle(document.documentElement);return{bg:c.getPropertyValue('--bg'),faint:c.getPropertyValue('--faint'),tint:c.getPropertyValue('--ravi-tint')};});
  assert.deepEqual(tokens,{bg:'#fff',faint:'#626262',tint:'#fdf1e7'});evidence.dark=tokens;
  await page.screenshot({path:resolve(out,'ravi-ko-dark-1120x780.png')});assert.deepEqual(errors,[]);await context.close();
  const phone=await open('ko',390,844,false,true);
  evidence.customer=await phone.page.evaluate(()=>({title:document.title,band:!!document.querySelector('.desktop-local-brand'),overflow:document.documentElement.scrollWidth-innerWidth}));
  assert.deepEqual(evidence.customer,{title:'RavenVault',band:false,overflow:0});
  await phone.page.screenshot({path:resolve(out,'shops-ko-390x844.png')});assert.deepEqual(phone.errors,[]);await phone.context.close();
 }
 writeFileSync(resolve(out,baseline?'layout-startup-red.json':'layout-startup-green.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});}

// All assertions, browser shutdown, evidence writes and profile removal have
// completed. Explicitly end the standalone gate (browser tooling may retain IPC).
process.exit(0);
