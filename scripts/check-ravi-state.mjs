// Actual TypeScript state/speech adapters with synthetic clocks and speech. No network/RPC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
function load(path, replace = s => s) {
  const source = replace(readFileSync(path, 'utf8'));
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  return exports;
}
const { RaviPose, RaviSpring } = load('src/ravi-rig.ts', s => s.replace(/^import scene.*$/m, 'const scene = "";'));
const pose = new RaviPose(() => .5);
const advance = (seconds, reduced = false) => { for (let t = 0; t < seconds; t += 1 / 60) pose.step(1 / 60, reduced, false); };
advance(1); assert.equal(pose.springs.eye.value, 0);
pose.wake(); advance(.3); assert.ok(pose.springs.wing.value > 20); assert.ok(pose.springs.eye.value > .8);
advance(2); assert.ok(Math.abs(pose.springs.wing.value) < 1);
pose.setMode('listening'); advance(1); assert.ok(pose.springs.head.value < -6); assert.ok(pose.springs.lean.value > .9);
pose.setMode('thinking'); advance(1); assert.ok(pose.springs.up.value < -4);
pose.level = .8; pose.setMode('speaking'); advance(.5); assert.ok(pose.springs.beak.value > .1);
pose.setMode('joy'); advance(.2); assert.ok(pose.springs.jump.value < -4);
const frozen = JSON.stringify(pose); pose.step(2, false, true); assert.equal(JSON.stringify(pose), frozen);
pose.setMode('idle'); pose.step(0, true, false); assert.equal(pose.springs.eye.value, 1); assert.equal(pose.springs.head.value, 0);
let blinked = false; for (let i = 0; i < 400; i++) { pose.step(1 / 60, true, false); blinked ||= pose.blink > .5; }
assert.ok(blinked, 'reduced motion retains blinking');
pose.setMode('sleep'); advance(.2, true); assert.equal(pose.springs.eye.value, 0);
const spring = new RaviSpring(0); spring.target = 1; spring.step(.02); const velocity = spring.velocity;
spring.target = -1; assert.equal(spring.velocity, velocity, 'changing target preserves momentum');
console.log('PASS rig sleep/wake/idle/listening/thinking/speaking/joy, pause, reduced motion and spring continuity');

const { createRaviVoice, naturalKoreanVoice } = load('src/ravi-voice.ts');
const voices = [{name:'Albert',lang:'ko-KR'}, {name:'Eddy',lang:'ko-KR'}, {name:'Yuna',lang:'ko-KR'}, {name:'English',lang:'en-US'}];
assert.equal(naturalKoreanVoice(voices).name, 'Yuna');
for (const name of ['Albert','Eddy','Bad News','Bells','Boing','Bubbles','Jester','Whisper','Zarvox']) assert.equal(naturalKoreanVoice([{name,lang:'ko-KR'}]), undefined);
assert.equal(naturalKoreanVoice([{name:'English',lang:'en-US'}]), undefined);
let allowed = true, text = '', listening = false, boundaries = 0, ended = 0, unavailable = 0, recognition, spoken, cancellations = 0;
class Recognition {
  constructor() { recognition = this; }
  start() { this.started = true; }
  abort() { this.aborted = true; }
}
class Utterance { constructor(text) { this.text = text; } }
const speech = createRaviVoice({ Recognition, synthesis: { getVoices: () => voices, speak: u => spoken = u, cancel: () => cancellations++ }, utterance: Utterance,
  allowed: () => allowed, transcript: t => text = t, listening: on => listening = on,
  boundary: () => boundaries++, ended: () => ended++, unavailable: () => unavailable++ });
assert.equal(speech.supported, true); assert.equal(speech.speak('fixture'), false, 'TTS starts off');
speech.listen(); assert.equal(recognition.lang, 'ko-KR'); assert.equal(recognition.interimResults, true); assert.equal(listening, true);
recognition.onresult({results:[{0:{transcript:'시험'},isFinal:false}]}); assert.equal(text,'시험');
const late = recognition.onresult; speech.stop(); assert.equal(recognition.aborted, true); assert.equal(listening,false);
late({results:[{0:{transcript:'late'},isFinal:true}]}); assert.equal(text,'시험','stale result cannot overwrite input');
speech.setEnabled(true); assert.equal(speech.speak('가짜 답변'),true); assert.equal(spoken.lang,'ko-KR'); assert.equal(spoken.voice.name,'Yuna');
spoken.onboundary(); assert.equal(boundaries,1);
const lateBoundary = spoken.onboundary, lateEnd = spoken.onend;
allowed = false; speech.stop(); lateBoundary(); lateEnd(); assert.equal(boundaries,1); assert.equal(ended,0);
assert.equal(speech.speak('blocked'),false); speech.listen(); assert.equal(listening,false);
allowed = true; speech.listen(); recognition.onerror(); assert.equal(unavailable,1); assert.equal(listening,false);
speech.setEnabled(false); assert.equal(speech.speak('off'),false); assert.ok(cancellations>0);
const missing = createRaviVoice({allowed:()=>true,transcript(){},listening(){},boundary(){},ended(){},unavailable(){}});
assert.equal(missing.supported,false); missing.listen(); assert.equal(missing.speak('no API'),false);
let noVoice = 0;
const empty = createRaviVoice({allowed:()=>true, synthesis:{getVoices:()=>[],cancel(){}},utterance:Utterance,
  transcript(){},listening(){},boundary(){},ended(){},unavailable(){noVoice++;}});
empty.setEnabled(true); assert.equal(empty.speak('no Korean voice'),false); assert.equal(noVoice,1);
console.log('PASS speech default-off, Korean natural voice allowlist, interim input, unsupported/error fallback, approval/background stop and stale callbacks');

const html = readFileSync('index.html','utf8'), rig = readFileSync('src/assets/ravi-scene.svg','utf8');
for (const part of ['rig-body','rig-head','rig-feathers','rig-tail','rig-wing-left','rig-wing-right','rig-beak-upper','rig-beak-lower','lake-mesh','sleep-z']) assert.ok(rig.includes(`id="${part}"`));
assert.ok(rig.includes('href="#ravi-character"'));
for (const id of ['page-home','page-ravi','page-wallet','page-assets','page-shop','page-talk','rp-open','phone-tx-panel','ravi-tiles']) assert.ok(html.includes(`id="${id}"`));
const voiceSource = readFileSync('src/ravi-voice.ts','utf8');
assert.ok(!/invoke\(|\.click\(|chatSend\(|send_rvn|send_asset|s-go/.test(voiceSource));
const dictSource = readFileSync('src/dict.ts','utf8');
assert.ok(dictSource.includes('Object.entries(RAVI_HOME_COPY)'));
console.log('PASS asset references, retained pages/tools and speech adapter has no spending or approval route');

// Controller integration with synthetic DOM visibility and time. These are lifecycle
// checks, not browser geometry measurements.
let active = 'page-home', blockedNodes = [], observer, hidden = false, framePaused = true, currentMode = 'sleep';
const nodes = new Map(), listeners = new Map(), timers = new Map(); let timerId = 0, woke = 0, reports = 0;
function element(id) {
  if (!nodes.has(id)) nodes.set(id, { id, value:'', textContent:'', dataset:{}, attributes:{}, hidden:["ravi-key","rv-send-card"].includes(id), open:false, classList:{toggle(){}},
    append(child) { child.parent = this; }, getClientRects: () => [1],
    setAttribute(k,v) { this.attributes[k]=v; }, addEventListener(name,fn) { this[name]=fn; }, scrollIntoView() {} });
  return nodes.get(id);
}
const fakeRig = {pose:{level:0},mode:m=>currentMode=m,wake:()=>woke++,pause:p=>framePaused=p};
const fakeDoc = {
  get hidden() { return hidden; }, getElementById:element,
  querySelector:()=>({id:active}), querySelectorAll:selector=>selector.includes('.sheet:not')?blockedNodes:[],
  addEventListener:(name,fn)=>listeners.set(name,fn), body:{classList:{toggle(){}}},
};
const fakeWindow = {addEventListener:(name,fn)=>listeners.set(name,fn),
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;}, SpeechRecognition:Recognition};
const controllerSource = readFileSync('src/ravi-home.ts','utf8').replace(/^import .*;\n/gm,'');
const controllerExports = {};
let panelOpen = true, panelSuspended = false, rigIndex = 0;
const rigPauses = [];
const panelAdapter = { open(){panelOpen=true;}, visible:()=>panelOpen&&!panelSuspended, suspend:on=>panelSuspended=on, message(){}, sent(){} };
vm.runInNewContext(ts.transpileModule(controllerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:controllerExports, mountRaviRig:()=> { const index=rigIndex++; return {...fakeRig,pause(on){rigPauses[index]=on;if(index===1)framePaused=on;}}; }, createRaviPanel:()=>panelAdapter, queueMicrotask(){}, createRaviVoice, t:s=>s, document:fakeDoc, window:fakeWindow,
    MutationObserver:class {constructor(fn){observer=fn;}observe(){}}, clearTimeout:id=>timers.delete(id)});
const controller=controllerExports.createRaviHome({wake:()=>woke++,wallet:()=>active='page-wallet',report:()=>reports++,send(){},tools(){} });
assert.equal(currentMode,'sleep'); assert.equal(framePaused,false);
assert.equal(element('ravi-conversation').parent.id,'ravi-home-slot');
controller.reply('synthetic basic guide');assert.equal(currentMode,'sleep','basic guide does not bypass checked-key wake');
controller.connected(true); assert.equal(currentMode,'idle'); assert.ok(woke>0);
controller.thinking(); assert.equal(currentMode,'thinking');
controller.reply('synthetic reply'); assert.equal(currentMode,'speaking'); assert.equal(element('ravi-caption').textContent,'깨어났어요. 무엇을 도와드릴까요?','home greeting stays concise');
blockedNodes=[element('send-review')]; observer(); assert.deepEqual(rigPauses,[true,true,true],'all live rigs pause on approval');assert.equal(element('rv-voice').disabled,true);assert.equal(element('ravi-read').disabled,true); assert.equal(framePaused,true); assert.equal(currentMode,'idle'); assert.equal(timers.size,0);
controller.reply('late reply'); assert.equal(currentMode,'idle');
blockedNodes=[]; observer(); assert.equal(framePaused,false);
element('rv-voice').onclick(); assert.equal(currentMode,'listening');
recognition.onresult({results:[{0:{transcript:'가짜 입력'},isFinal:false}]});assert.equal(element('chat-q').value,'가짜 입력');
const lateControllerResult=recognition.onresult;
controller.background(true); assert.equal(framePaused,true); assert.equal(recognition.aborted,true);
lateControllerResult({results:[{0:{transcript:'late'},isFinal:true}]});assert.equal(element('chat-q').value,'가짜 입력');
controller.background(false);assert.equal(framePaused,false);assert.equal(currentMode,'idle');
hidden=true;listeners.get('visibilitychange')();assert.equal(framePaused,true);
hidden=false;listeners.get('visibilitychange')();assert.equal(framePaused,false);
controller.joy();assert.equal(currentMode,'joy');
active='page-wallet';controller.page('wallet');observer();assert.equal(framePaused,false,'panel stays active on other pages');
active='page-ravi';controller.page('ravi');observer();assert.equal(framePaused,false);assert.equal(element('ravi-conversation').parent.id,'ravi-home-slot');
active='page-home';controller.page('home');assert.equal(element('ravi-conversation').parent.id,'ravi-home-slot');
listeners.get('touchstart')({touches:Array(5)});assert.equal(reports,1);
listeners.get('touchstart')({touches:Array(5)});assert.equal(reports,1);
listeners.get('touchend')({touches:[]});listeners.get('touchstart')({touches:Array(5)});assert.equal(reports,2);
element('ravi-plus').onclick();assert.equal(element('ravi-tools').open,true);
for(const id of ['ravi-key','askwrap','rpwrap','sdw','phone-tx-send']){blockedNodes=[element(id)];observer();assert.equal(framePaused,true);}
blockedNodes=[];element('ravi-key').hidden=false;observer();assert.deepEqual(rigPauses,[true,true,true]);element('ravi-key').hidden=true;observer();assert.equal(framePaused,false);
panelOpen=false;observer();assert.equal(framePaused,true);assert.equal(rigPauses[0],false,'home rig keeps breathing when panel is folded');panelOpen=true;observer();
console.log('PASS shared home/menu DOM, real controller modes, approval/key/backup/report stop, hidden/background stop, stale transcript rejection and five-finger report gesture');

const main = readFileSync('src/main.ts','utf8');
const ast = ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
const watch = ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='지갑감시').getText(ast);
const watched = new Set();let depositJoys=0;
const fixture={txid:'synthetic-deposit',vout:0,category:'receive',amount:3.2};
const watcherContext = vm.createContext({감시_첫바퀴:true,감시_마지막블록:null,알린입금:watched,
  invoke:async()=>({lastblock:'synthetic-block',transactions:[fixture]}),
  입금열쇠:t=>t.txid,알린걸_기억:rows=>rows.forEach(t=>watched.add(t.txid)),
  raviHome:{joy:()=>depositJoys++},loadWallet(){},loadAssets(){},refreshOverview(){},알림켜짐:()=>false,
  알림소리(){},살짝알림(){},tf:s=>s});
vm.runInContext(ts.transpileModule(watch,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,watcherContext);
await watcherContext.지갑감시();assert.equal(depositJoys,0,'startup history never jumps');
fixture.txid='synthetic-new-deposit';await watcherContext.지갑감시();assert.equal(depositJoys,1);
await watcherContext.지갑감시();assert.equal(depositJoys,1,'same deposit cannot jump twice');
console.log('PASS actual wallet watcher triggers joy only for a new incoming transaction');

const dictionary = await build({entryPoints:['src/dict.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const dictionaryContext={module:{exports:{}},exports:{}};vm.runInNewContext(dictionary.outputFiles[0].text,dictionaryContext);
const dictionarySource=readFileSync('src/dict.ts','utf8');
const phrases=[...dictionarySource.slice(dictionarySource.indexOf('const RAVI_HOME_COPY'),dictionarySource.indexOf('export const DICT')).matchAll(/^  "([^"]+)":/gm)].map(m=>m[1]);
for(const language of ['en','ja','zh'])for(const phrase of phrases)assert.ok(dictionaryContext.module.exports.DICT[language][phrase]&&!/[가-힣]/.test(dictionaryContext.module.exports.DICT[language][phrase]));
console.log(`PASS all ${phrases.length} new Ravi phrases translated in en/ja/zh`);
