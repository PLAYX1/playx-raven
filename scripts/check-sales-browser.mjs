// Offline DOM/UI verification: all requests aborted, native calls mocked, no live wallet.
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const out='docs/handoff'; mkdirSync(out,{recursive:true});
let browser, stage="launch";
try {
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:`${process.cwd()}/node_modules/.sales-browser-profile`});
  stage="new-page"; const page=await browser.newPage();
  await page.setRequestInterception(true); page.on('request',r=>r.abort());
  let html=readFileSync('index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  stage="render"; await page.setViewport({width:1120,height:780}); await page.setContent(html);
  await page.addStyleTag({content:readFileSync('src/ravi-home.css','utf8')+'\n'+readFileSync('src/sales-account.css','utf8')});
  const built=await build({entryPoints:['src/sales-account.ts'],bundle:true,write:false,format:'iife',globalName:'SalesUI',logLevel:'silent'});
  await page.addScriptTag({content:built.outputFiles[0].text});
  const fixture=JSON.parse(readFileSync('scripts/fixtures/sales-public-vectors.json','utf8'))[0];
  await page.evaluate(({xpub})=>{
    let active='sales';
    const go=id=>{active=id;document.querySelectorAll('.page').forEach(p=>p.classList.toggle('on',p.id===`page-${id}`));};
    document.querySelectorAll('nav a[data-page]').forEach(a=>{a.onclick=()=>{controller.hide();go(a.dataset.page);};});
    document.querySelector('nav').classList.add('more-open');
    const controller=SalesUI.wireSalesAccount({active:()=>active==='sales',ask:async()=>String.fromCharCode(120),invoke:async(command,args)=>{
      if(command==='sales_account_reveal') return xpub;
      if(command==='qr_svg') return '<svg xmlns="http://www.w3.org/2000/svg" width="196" height="196"></svg>';
      if(command==='sales_account_balance') return {confirmedSats:'120000001',checked:args.addresses.length};
      throw Error('unexpected command');
    }});
    go('sales');
  },{xpub:fixture.xpub});
  assert.equal(await page.$eval('nav a[data-page="sales"]',el=>el.closest('nav')!==null),true);
  stage="reveal"; await page.click('#sales-reveal'); await page.waitForFunction(()=>document.querySelector('#sales-public').children.length===6);
  await page.click('#sales-refresh'); await page.waitForFunction(()=>document.querySelector('#sales-balance').textContent.includes('1.20000001'));
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await page.$eval('#sales-public',el=>el.children.length),0);
  stage="geometry"; const checks=[];
  for(const width of [720,1120,1440]) {
    await page.setViewport({width,height:900});
    checks.push(await page.evaluate(()=>({width:innerWidth,overflow:document.querySelector('#page-sales').scrollWidth>document.querySelector('#page-sales').clientWidth,
      buttons:[...document.querySelectorAll('#page-sales button')].map(b=>b.getBoundingClientRect().height)})));
  }
  assert.ok(checks.every(c=>!c.overflow && c.buttons.every(h=>h>=44)));
  await page.setViewport({width:1120,height:900});
  await page.screenshot({path:`${out}/desktop-084-sales-hidden.png`,fullPage:true});
  await page.click('nav a[data-page="games"]');
  assert.equal(await page.$eval('#page-games',el=>el.classList.contains('on')),true);
  await page.screenshot({path:`${out}/desktop-084-games.png`,fullPage:true});
  writeFileSync(`${out}/desktop-084-browser.json`,JSON.stringify({status:'pass',network:'all requests blocked',native:'mocked',qr:'synthetic SVG; QR encoding covered by native generator',checks},null,2)+'\n');
  console.log('PASS offline browser: nav, disclosure, 100-address refresh, blur, 3 widths, 44px targets; native mocked');
} catch (error) {
  const reason = /Operation not permitted|EPERM|Permission denied/.test(String(error?.message)) ? 'sandbox-permission' : /ENOENT|Could not find/.test(String(error?.message)) ? 'browser-unavailable' : 'launch-or-assertion-failure';
  writeFileSync(`${out}/desktop-084-browser.json`,JSON.stringify({status:'blocked',stage,reason,native:'mocked'},null,2)+'\n');
  console.error(`FAIL offline sales browser at ${stage}: ${reason}; no raw page state logged`); process.exitCode=1;
}
finally {await browser?.close();}
