import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(name,globals={}){const exports={};const source=readFileSync(`src/${name}.ts`,'utf8').replace(/^import .*;\n/gm,'');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,...globals});return exports;}
const c=load('ravi-choreography');
test('Bezier interpolation clamps and preserves endpoints',()=>{assert.equal(c.cubic(1,4,9,12,0),1);assert.equal(c.cubic(1,4,9,12,1),12);assert.equal(c.cubic(1,4,9,12,.5),6.5);assert.equal(c.cubic(1,4,9,12,3),12);});
test('2.4s opening is finite, brakes, flaps and grounds two hops before greeting',()=>{
  assert.ok(c.OPENING_MS>=1800&&c.OPENING_MS<=2600);
  for(let ms=0;ms<=2600;ms+=5)for(const n of Object.values(c.openingFrame(ms)))assert.ok(Number.isFinite(n));
  const speed=t=>Math.hypot(c.openingFrame(t+1).x-c.openingFrame(t).x,c.openingFrame(t+1).y-c.openingFrame(t).y);
  assert.ok(speed(1120)<speed(500));assert.ok(c.openingFrame(1100).wing>70);
  assert.ok(Math.abs(c.openingFrame(100).wing-c.openingFrame(200).wing)>20);
  assert.ok(c.openingFrame(1000).feet>0);assert.ok(c.openingFrame(1300).y<c.openingFrame(1500).y);
  assert.equal(Math.abs(c.openingFrame(1610).y),0);assert.ok(c.openingFrame(1910).eye<.5);assert.ok(c.openingFrame(2120).wave>0);
  const final=c.openingFrame(c.OPENING_MS);for(const k of ['x','y','roll','wing','wave','tail','feet','body'])assert.equal(Math.abs(final[k]),0);
});
test('reduced motion has no flight, bounce or wing motion',()=>{for(let ms=0;ms<300;ms+=10){const f=c.openingFrame(ms,true);for(const key of ['x','y','roll','wing','wave','feet'])assert.equal(f[key],0);}assert.equal(c.openingFrame(220,true).opacity,1);});
test('idle sequence looks around, stretches and yawns without sensitive values',()=>{assert.equal(c.restingFrame(0).eye,0);assert.ok(c.restingFrame(9500).eye>.8);assert.ok(c.restingFrame(17500).wing>30);assert.ok(c.restingFrame(19000).beak>.7);assert.equal(c.farewellFrame(760).eye,0);});
test('opening completion and skip paint before exactly-once barrier release; hidden fallback works',()=>{
  for(const skip of [false,true]){
    const calls=[],timers=new Map();let serial=0,now=0;
    const opening=load('ravi-opening',{...c,performance:{now:()=>now},matchMedia:()=>({matches:false}),navigator:{},document:{hidden:true,addEventListener(){},removeEventListener(){}},
      requestAnimationFrame(){return 1;},cancelAnimationFrame(){},clearTimeout:id=>timers.delete(id),window:{setTimeout(f,ms){const id=++serial;timers.set(id,{f,ms});return id;}},
      frameRate:()=>0,createFrameLoop:()=>({start(){},stop(){}}),mountRaviRig:()=>({renderFrame(f){calls.push(['paint',f]);},destroy(){}})});
    const player=opening.mountRaviOpening({},()=>calls.push(['land']));assert.equal(calls.length,1);
    if(skip)player.finish();else {const timer=[...timers.values()][0];assert.equal(timer.ms,2400);now=timer.ms;timer.f();}
    player.finish();assert.equal(calls.filter(x=>x[0]==='land').length,1);assert.equal(Math.abs(calls.at(-2)[1].y),0);assert.equal(calls.at(-1)[0],'land');player.destroy();
  }
});
test('landing barrier drains queued input once, after state changes',async()=>{
  let arriving=false;const calls=[];
  const gate=load('firstrun',{queueMicrotask,document:{documentElement:{setAttribute(){arriving=true;},removeAttribute(){arriving=false;}},addEventListener(){}}});
  gate.installFirstRunBarrier();gate.afterRaviLanding(()=>calls.push(arriving));assert.deepEqual(calls,[]);
  gate.finishRaviLanding();gate.finishRaviLanding();await Promise.resolve();assert.deepEqual(calls,[false]);
  assert.equal(gate.deferUntilRaviLanding(()=>{}),false);
});
test('hidden and battery frame budgets match existing physics rules',()=>{const {frameRate}=load('ravi-physics');assert.equal(frameRate(true,false,false),60);assert.equal(frameRate(true,true,false),24);assert.equal(frameRate(false,true,false),15);assert.equal(frameRate(true,false,true),0);});

function lifecycleFixture({pending=false,fail=false,reduced=false}={}) {
  let now=0,serial=0;const timers=new Map(),listeners=new Map(),calls=[];
  class Node {
    constructor(tag='div'){this.tagName=tag;this.open=false;this.disabled=false;this.hidden=false;this.children=[];this.isConnected=true;this.style={};const classes=new Set();this.classList={add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n)};}
    set innerHTML(_html){this.nodes=Object.fromEntries(['h2','#ravi-lifecycle-note','.ravi-lifecycle-detail','.ravi-lifecycle-actions','.ravi-lifecycle-rig'].map(k=>[k,new Node()]));}
    querySelector(key){return this.nodes[key];} setAttribute(){} append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}
    addEventListener(name,fn){this[name]=fn;} showModal(){this.open=true;}close(){this.open=false;}focus(){document.activeElement=this;}remove(){this.isConnected=false;}
  }
  const document={body:new Node('body'),hidden:false,activeElement:new Node('button'),createElement:t=>new Node(t),addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n),dispatchEvent(){}};
  const schedule=(f,ms,interval=false)=>{const id=++serial;timers.set(id,{f,at:now+ms,ms,interval});return id;};
  const module=load('ravi-lifecycle',{...c,t:x=>x,document,navigator:{},Event,Date:{now:()=>now},performance:{now:()=>now},matchMedia:()=>({matches:reduced}),requestAnimationFrame:()=>0,cancelAnimationFrame(){},clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),window:{setTimeout:(f,ms)=>schedule(f,ms),setInterval:(f,ms)=>schedule(f,ms,true)},frameRate:()=>15,createFrameLoop:()=>({start(){},stop(){}}),mountRaviRig:()=>({renderFrame(){},destroy(){}})});
  const state={lock:'open',active:pending?1:0,tray:true};
  const api=module.mountRaviLifecycle({idleMs:2000,pending:()=>false,invoke:async name=>{calls.push(name);if(name==='ravi_lifecycle_status')return {...state};if(name==='ravi_prepare_quit'){if(fail)throw Error('synthetic');return {lock:'locked'};}}});
  const dialog=document.body.children[0],actions=dialog.querySelector('.ravi-lifecycle-actions');
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  const advance=async ms=>{const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [id,timer]=next;timers.delete(id);now=timer.at;if(timer.interval)timers.set(id,{...timer,at:now+timer.ms});timer.f();await flush();}now=end;await flush();};
  return {api,state,calls,dialog,actions,document,listeners,advance,flush};
}
test('idle timer masks content, consumes wake input and never unlocks a wallet',async()=>{
  const f=lifecycleFixture();await f.advance(1999);assert.equal(f.dialog.open,false);await f.advance(1);assert.equal(f.dialog.open,true);assert.equal(f.document.body.classList.contains('ravi-private'),true);
  let consumed=0;f.listeners.get('keydown')({type:'keydown',preventDefault(){consumed++;},stopImmediatePropagation(){consumed++;}});assert.equal(consumed,2);
  await f.advance(549);assert.equal(f.document.body.classList.contains('ravi-private'),true);await f.advance(1);assert.equal(f.dialog.open,false);assert.equal(f.document.body.classList.contains('ravi-private'),false);assert.deepEqual(f.calls,['companion_settings']);f.api.destroy();
});
test('quit blocks active transfers, defaults focus to continue, and prepares before exit',async()=>{
  const f=lifecycleFixture({pending:true});await f.api.requestClose();assert.equal(f.actions.children[2].disabled,true);assert.equal(f.document.activeElement,f.actions.children[0]);
  f.state.active=0;await f.advance(1000);assert.equal(f.actions.children[2].disabled,false);f.actions.children[2].onclick();await f.flush();assert.ok(f.calls.includes('ravi_prepare_quit'));assert.ok(!f.calls.includes('ravi_finish_quit'));
  await f.advance(820);assert.ok(f.calls.includes('ravi_finish_quit'));assert.equal(f.dialog.querySelector('#ravi-lifecycle-note').textContent,'지갑이 잠겨 있어요.');f.api.destroy();
});
test('failed quit preparation keeps the dialog and never calls exit',async()=>{
  const f=lifecycleFixture({fail:true});await f.api.requestClose();f.actions.children[2].onclick();await f.flush();await f.advance(900);assert.ok(f.calls.includes('ravi_cancel_quit'));assert.ok(!f.calls.includes('ravi_finish_quit'));assert.equal(f.dialog.open,true);assert.equal(f.actions.children[0].disabled,false);f.api.destroy();
});
test('unencrypted and unknown wallets are never described as safely locked',async()=>{
  const f=lifecycleFixture();for(const lock of ['unencrypted','unknown']){f.state.lock=lock;await f.api.requestClose();assert.notEqual(f.dialog.querySelector('#ravi-lifecycle-note').textContent,'지갑이 잠겨 있어요.');f.actions.children[0].onclick();}f.api.destroy();
});
test('every new lifecycle source phrase has all three translations',()=>{
  const dict=load('ravi-lifecycle-copy').RAVI_LIFECYCLE_COPY;
  for(const [source,translations] of Object.entries(dict)){assert.equal(translations.length,3,source);for(const translation of translations){assert.ok(translation.trim().length>0,source);assert.notEqual(translation,source);}}
  const source=readFileSync('src/ravi-lifecycle.ts','utf8');
  for(const match of source.matchAll(/t\('([^']*?[가-힣][^']*)'\)/g))assert.ok(dict[match[1]],match[1]);
});
