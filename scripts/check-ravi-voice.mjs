// Synthetic clocks, devices and AI RPC only: no microphone, credential or AI network access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/ravi-dictation.ts','utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Blob, Uint8Array });
const { createRaviDictation, VoiceSilence, voiceError } = exports;
const flush = async () => { for (let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };
function fixture(options={}) {
  let now=0, interval, stopped=0, active, permissionCalls=0, consentCalls=0, sends=0, transcriptionCalls=0, pending, amplitude=145, provider='openai', allowed=true;
  let consent=options.consent??true, text='', saved=0, audioRef, state='idle', error;
  class Recorder {
    static isTypeSupported(mime) { return mime.startsWith('audio/webm'); }
    constructor(_stream, args) { active=this;this.mimeType=args.mimeType;this.state='inactive'; }
    start() { this.state='recording'; }
    stop() { this.state='inactive'; this.ondataavailable?.({data:new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3])],{type:this.mimeType})}); this.onstop?.(); }
  }
  class Audio {
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createAnalyser() { return {fftSize:256,getByteTimeDomainData:b=>b.fill(amplitude)}; }
    createMediaStreamSource() { return { connect(){} }; }
  }
  const api={
    provider:()=>provider,language:()=> 'ko',allowed:()=>allowed,
    consent:async()=>{consentCalls++;return consent;}, saveConsent:async(_p,on)=>{consent=on;saved++;},cancelRequest:()=>{sends++;},
    transcribe:async(p,a,m,ms,l)=>{ assert.equal(p,provider);assert.equal(l,'ko'); assert.ok(ms<=30000);assert.ok(m.startsWith('audio/webm'));audioRef=a;transcriptionCalls++; if(options.pending)return new Promise(r=>pending=r);if(options.network)throw 'network'; return '돈 보내기 승인 삭제'; },
    transcript:t=>text=t,state:(s,e)=>{state=s;error=e;},level(){},quiet(){},
    getUserMedia:async()=>{permissionCalls++;if(options.permission)throw {name:options.permission};const s={getTracks:()=>[{stop(){stopped++;}}]};if(options.latePermission)return new Promise(r=>pending=()=>r(s));return s;},
    Recorder,Audio,now:()=>now,every:fn=>{interval=fn;return 1;},clear:()=>{interval=undefined;},
  };
  const controller=createRaviDictation({...api,...options.api});
  return {controller, api, get state(){return state;},get error(){return error;},get text(){return text;},get stopped(){return stopped;},get calls(){return transcriptionCalls;},get permissions(){return permissionCalls;},get saved(){return saved;},get consentCalls(){return consentCalls;},get payload(){return audioRef;},get cancels(){return sends;},tick(ms,sound=true){now=ms;amplitude=sound?145:128;interval?.();},finish:()=>active.stop(),resolve:t=>pending(t),provider:p=>provider=p,block:()=>allowed=false};
}
for(const [name,code] of [['NotAllowedError','denied'],['SecurityError','permission'],['NotFoundError','device'],['OverconstrainedError','device'],['NotReadableError','busy']]) {
  assert.equal(voiceError({name}),code); const f=fixture({permission:name});await f.controller.begin();assert.equal(f.error,code);assert.equal(f.calls,0);
}
{
  const f=fixture({consent:false});const start=f.controller.begin();assert.equal(f.state,'requesting');await start;
  assert.equal(f.state,'consent');assert.equal(f.permissions,0);await f.controller.agree();assert.equal(f.saved,1);assert.equal(f.state,'listening');
  f.tick(100);f.finish();await flush();assert.equal(f.text,'돈 보내기 승인 삭제');assert.equal(f.calls,1);assert.equal(f.state,'done');assert.ok(f.stopped>0);assert.equal(f.payload.length,0);
  await f.controller.begin();assert.equal(f.state,'listening');assert.equal(f.saved,1,'consent only once');f.controller.stop();await f.controller.revoke();await f.controller.begin();assert.equal(f.state,'consent');
}
{
  const f=fixture();await f.controller.begin();f.tick(100);f.tick(2300,false);await flush();assert.equal(f.calls,1,'silence ends recording');
  const g=fixture();await g.controller.begin();g.tick(30000);await flush();assert.equal(g.calls,1,'hard 30 second stop');
  const h=fixture();await h.controller.begin();h.tick(5000,false);await flush();assert.equal(h.error,'silence');assert.equal(h.calls,0,'silent audio never dispatched');
}
{
  const f=fixture({pending:true});await f.controller.begin();f.tick(100);f.finish();await flush();assert.equal(f.state,'transcribing');await f.controller.revoke();f.resolve('late');await flush();assert.equal(f.text,'');assert.equal(f.cancels,1);assert.equal(f.payload.length,0);
  const g=fixture({latePermission:true});const p=g.controller.begin();await flush();g.controller.stop();g.resolve();await p;assert.ok(g.stopped>0);assert.equal(g.calls,0);
  const h=fixture();await h.controller.begin();h.block();h.tick(100);assert.equal(h.state,'idle');assert.ok(h.stopped>0);assert.equal(h.calls,0);
  const i=fixture();await i.controller.begin();i.provider('groq');i.tick(100);assert.equal(i.state,'idle');assert.equal(i.calls,0);
}
for(const provider of ['anthropic','xai','custom']) {const f=fixture();f.provider(provider);await f.controller.begin();assert.equal(f.error,'unsupported_provider');assert.equal(f.permissions,0);}
{
  const f=fixture({network:true});await f.controller.begin();f.tick(100);f.finish();await flush();assert.equal(f.error,'network');assert.equal(f.text,'');
  const g=fixture({api:{Recorder:undefined}});await g.controller.begin();assert.equal(g.error,'unsupported');
}
{
  let recognition;
  class Local {processLocally=false;constructor(){recognition=this;}start(){}abort(){}}
  const f=fixture({api:{Recognition:Local}});await f.controller.begin();assert.equal(recognition.processLocally,true);recognition.onerror();await flush();assert.equal(f.permissions,1,'local Web Speech failure falls back to MediaRecorder');f.controller.stop();
  const g=fixture({api:{Recognition:Local}});await g.controller.begin();recognition.onresult({results:[{isFinal:true,0:{transcript:'local text'}}]});assert.equal(g.text,'local text');assert.equal(g.calls,0);
  class Remote {start(){throw Error('remote speech must not start');}abort(){}}
  const h=fixture({api:{Recognition:Remote}});await h.controller.begin();assert.equal(h.permissions,1);h.controller.stop();
}
const silence=new VoiceSilence();assert.equal(silence.sample(4999,0),false);assert.equal(silence.sample(5000,0),true);
const source=readFileSync('src/ravi-dictation.ts','utf8')+readFileSync('src/ravi-microphone.ts','utf8');
assert.ok(!/chatSend\(|send_rvn|send_asset|\.click\(|localStorage|console\.|createObjectURL|FileReader/.test(source),'voice has no send, approval, persistence or logging path');
const native=readFileSync('src-tauri/src/ravi_voice.rs','utf8');
assert.ok(!/println!|eprintln!|dbg!|log::|tracing::|\.file\(/.test(native));
assert.ok(native.indexOf('permit.charge()') < native.indexOf('result = dispatch'));
const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));assert.equal(config.bundle.macOS.entitlements,'entitlements.plist');assert.equal(config.bundle.macOS.infoPlist,'Info.plist');
const entitlements=readFileSync('src-tauri/entitlements.plist','utf8');assert.ok(entitlements.includes('com.apple.security.device.audio-input'));assert.equal((entitlements.match(/<key>/g)||[]).length,1);
const ui=readFileSync('src/ravi-home.ts','utf8');assert.ok(ui.includes('mountRaviMicrophone'));assert.ok(ui.includes('input.value = text'));assert.ok(readFileSync('src/ravi-panel.ts','utf8').includes('panel.append(el("ravi-chatwrap"))'));
console.log('PASS voice: consent/revoke, permission states, 30s/silence, waveform samples, cleanup/stale callbacks, provider changes, local fallback, text-only manual send, no voice approval, mac entitlements; synthetic only');

// Every user-facing state/error exists in all four languages, including revoke and macOS help.
const copySource=readFileSync('src/ravi-voice-copy.ts','utf8').replace(/^import .*;\n/gm,'');
for(const lang of ['ko','en','ja','zh']) {
  const out={};vm.runInNewContext(ts.transpileModule(copySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:out,lang});
  for(const key of ['consent','agree','cancel','revoke','revoked','requesting','listening','transcribing','done','denied','permission','device','busy','network','unsupported','unsupported_provider','key','budget','silence','storage','response','settings']) {
    assert.ok(out.voiceCopy(key).length>1);if(lang!=='ko')assert.ok(!/[가-힣]/.test(out.voiceCopy(key)));
  }
}
assert.ok(readFileSync('src/ravi-companion.ts','utf8').includes('mountRaviMicrophone'));
console.log('PASS shared resident/main microphone and complete ko/en/ja/zh voice messages');

// Mount the actual UI adapter with a synthetic DOM/recorder/RPC; verify the visible flow.
{
  const f=fixture(), nodes=new Map(), commands=[], listeners=new Map();let approved=false;
  class Element {
    closest(){return this;}
    get isConnected(){return true;}
    click(){this.onclick?.();}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,Object.assign(new Element(),{hidden:false,textContent:'',value:'',attributes:{},handlers:{},width:240,height:36,setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.handlers[k]=v;},getContext(){return {clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}}));return nodes.get(id);};
  const attrs=new Map();
  const doc={getElementById:node,documentElement:{setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)},addEventListener:(k,f)=>listeners.set(k,f)};
  const landing={};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/firstrun.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:landing,document:doc,Element,HTMLElement:Element,queueMicrotask});
  landing.installFirstRunBarrier();
  const invoke=async(command,args)=>{
    commands.push(command);
    if(command==='voice_consent')return approved;
    if(command==='voice_set_consent'){approved=args.allowed;return;}
    if(command==='voice_transcribe'){assert.equal(args.provider,'openai');assert.ok(Array.isArray(args.audio));return '모의 입력';}
    if(command==='voice_open_microphone_settings'||command==='voice_cancel')return;
    throw Error('Unexpected mock command');
  };
  const out={}, mountedSource=readFileSync('src/ravi-microphone.ts','utf8').replace(/^import .*;\n/gm,'');
  vm.runInNewContext(ts.transpileModule(mountedSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:out,invoke,lang:'ko',createRaviDictation,voiceCopy:k=>k,document:doc,
    navigator:{platform:'MacIntel',mediaDevices:{getUserMedia:f.api.getUserMedia}},window:{MediaRecorder:f.api.Recorder,AudioContext:f.api.Audio,addEventListener(){}},
    performance:{now:f.api.now},setInterval:f.api.every,clearInterval:f.api.clear,MutationObserver:class{observe(){}},
  });
  const mounted=out.mountRaviMicrophone({provider:()=> 'openai',allowed:()=>true,transcript:t=>{node('chat-q').value=t;},quiet(){},listening(){}});
  assert.equal(node('rv-voice').hidden,false);
  let prevented=false;
  listeners.get('click')({target:node('rv-voice'),preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert.equal(prevented,true);await flush();assert.equal(commands.length,0,'landing barrier defers consent RPC and microphone permission');assert.equal(f.permissions,0);
  landing.finishRaviLanding();await Promise.resolve();
  assert.equal(node('ravi-voice-note').textContent,'requesting','replayed click gives immediate status');await flush();
  assert.equal(attrs.has('data-ravi-arriving'),false);assert.equal(node('ravi-voice-consent').hidden,false,'queued microphone click opens consent only after landing');
  assert.equal(f.permissions,0,'landing never bypasses explicit voice consent');
  node('ravi-voice-agree').onclick();await flush();assert.equal(node('rv-voice').attributes['aria-pressed'],'true');assert.equal(node('ravi-voice-wave').hidden,false);
  f.tick(100);node('rv-voice').onclick();await flush();assert.equal(node('chat-q').value,'모의 입력');assert.equal(node('ravi-voice-note').textContent,'done');
  assert.ok(!commands.some(c=>/send|ravi_agent|ai_chat/.test(c)));
  node('rv-voice').onclick();await flush();assert.equal(mounted.state,'listening');node('chat-q').handlers.input({isTrusted:true});assert.equal(mounted.state,'idle');
  await node('ravi-voice-revoke').onclick();assert.equal(approved,false);assert.equal(node('ravi-voice-revoked').textContent,'revoked');
}
console.log('PASS actual microphone UI: first-run deferred click, consent before permission, waveform, transcript-only fill, manual-edit cancellation and settings revoke');
