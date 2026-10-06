import { copy, type CopyKey } from "./companion-copy";
import { mountRaviMicrophone } from "./ravi-microphone";
import { installFirstRunBarrier, afterRaviLanding, finishRaviLanding } from "./firstrun";
installFirstRunBarrier();
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import scene from "./assets/ravi-scene.svg?raw";
import { containsRaviSecret, raviAnswerHtml, guideById } from "./ravi-guide";
import { RaviPhysics, createFrameLoop, frameRate, type Bounds, type Emotion } from "./ravi-physics";
import "./ravi-companion.css";

type Settings = { locale: string; always_visible: boolean; size: number; greeting: boolean; sound: boolean; reduced: boolean; battery: boolean; resident_start: boolean; simple_window: boolean; shortcut: string; x: number|null; y: number|null };
type Layout = { width:number; height:number; bird:number; bird_left:number; bird_top:number; bubble_width:number; bubble_height:number; below:boolean };
type Setup = { visible:boolean; layout:Layout; message:string; bubble: boolean; saved: boolean; settings: Settings; platform: { transparent: boolean; movable: boolean; notice: string }; shortcut_notice: string };
type Sample = { x:number; y:number; scale:number; cursor:{x:number;y:number}|null; bounds:Bounds|null };
const $ = (id:string) => document.getElementById(id)!;
const bird=$("bird"), character=$("character"), question=$("question") as HTMLInputElement;
character.innerHTML=scene;
character.querySelector('#lake')?.remove();
character.querySelector('svg')?.setAttribute('aria-hidden','true');
const physics=new RaviPhysics();physics.resting="sleep";
let config:Setup, visible=false, ready=false, sample:Sample|null=null, sampling=false, sampledAt=-10;
let bounds:Bounds={left:0,top:0,right:0,bottom:0}, bubble=false, moving=false, desired:{x:number;y:number}|null=null;
let savePosition=false, wasMoving=false, battery=false, audio:AudioContext|null=null;
let clickTimer=0;
let drag:{x:number;y:number;px:number;py:number;at:number;distance:number}|null=null;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const say=(key:CopyKey)=>copy(key,config?.settings.locale);
let notice:CopyKey|null=null;
let currentLayout:Layout|null=null;
function applyLayout(v:Layout){
  if(!v.bird)return;
  currentLayout=v;
  for(const [key,value] of Object.entries(v))if(typeof value==='number')document.documentElement.style.setProperty(`--${key.replace(/_/g,'-')}`,`${value}px`);
  document.body.classList.toggle('below',v.below);
  const tail=Math.min(v.bubble_width-24,Math.max(24,v.bird_left+v.bird/2-8));
  document.documentElement.style.setProperty('--tail',`${tail}px`);
  queueMicrotask(resizeBubble);
}
function showNotice(kind:string){
  if(!physics.reduced)physics.arrive();
  notice=(['deposit','order','backup','hello','call'].includes(kind)?kind:'call') as CopyKey;
  $('ask').hidden=notice!=='call';$('ravi-voice-surface').hidden=true;
  $('status').textContent=say(notice);mood(notice==='call'?'idle':'joy');
}
const transform=(id:string,v:string)=>character.querySelector(`#${id}`)?.setAttribute('transform',v);
const opacity=(id:string,v:number)=>character.querySelector(`#${id}`)?.setAttribute('opacity',String(v));
const microphone = mountRaviMicrophone({
  provider() { try { return localStorage.getItem('rv-voice-provider') || ''; } catch { return ''; } },
  allowed: () => visible && bubble && !document.hidden,
  transcript(text) { question.value = text; },
  quiet() { if (audio) void audio.suspend().catch(() => {}); },
  listening(on) { mood(on ? 'focused' : physics.resting); void invoke('companion_hold',{hold:on}).catch(()=>{}); },
});
function sound() {
  if(!config?.settings.sound||!visible||!audio||["requesting","listening","transcribing"].includes(microphone.state))return;
  void audio.resume().then(()=>{
    if(!visible)return;
    const oscillator=audio!.createOscillator(),gain=audio!.createGain(),now=audio!.currentTime;
    oscillator.type='sine';oscillator.frequency.setValueAtTime(650,now);oscillator.frequency.exponentialRampToValueAtTime(900,now+.08);
    gain.gain.setValueAtTime(.025,now);gain.gain.exponentialRampToValueAtTime(.0001,now+.12);
    oscillator.connect(gain);gain.connect(audio!.destination);oscillator.start(now);oscillator.stop(now+.13);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
  }).catch(()=>{});
}
function mood(mode:Emotion){if(mode==='sleep'||mode==='idle')physics.resting=mode;physics.setEmotion(mode);if(mode==='joy')sound();}
function paint(){
  const p=physics,t=p.time,quiet=p.reduced;
  character.style.transform=`translate(${p.offsetX.value}px,${p.bounce.value}px) rotate(${p.tilt.value}deg) scale(${1+(1-p.scale.value)*.65+p.breath},${p.scale.value+p.breath})`;
  character.style.opacity='1';
  for(const side of ['left','right']){
    const cx=side==='left'?148:238,cy=side==='left'?204:197;
    transform(`eye-open-${side}`,`translate(${cx} ${cy}) scale(1 ${Math.max(.02,p.eye)}) translate(${-cx} ${-cy})`);
    transform(`rig-pupil-${side}`,`translate(${p.gazeX} ${p.gazeY})`);
    opacity(`rig-lid-${side}`,1-p.eye);
  }
  transform('rig-head',`rotate(${quiet?0:p.gazeX*.65} 180 254)`);
  transform('rig-feathers',`rotate(${quiet?0:Math.sin(t*2)*(p.emotion==='surprised'?7:2)} 139 102)`);
  transform('rig-wing-left',`rotate(${p.emotion==='joy'&&!quiet?-22:0} 122 266)`);
  transform('rig-wing-right',`rotate(${p.emotion==='joy'&&!quiet?22:0} 237 264)`);
  transform('rig-beak-lower',`translate(0 ${p.emotion==='surprised'?4:p.emotion==='joy'?2:0})`);
  opacity('thought-particles',['thinking','working'].includes(p.emotion)?1:0);
  transform('thought-particles',`rotate(${quiet?0:t*45} 228 64)`);
  opacity('sleep-particles',p.emotion==='sleep'||p.emotion==='sleepy'?1:0);opacity('joy-particles',0);
  const particles=$('sparkles');
  while(particles.children.length<p.particles){const star=document.createElement('i');star.textContent='✦';particles.append(star);}
  while(particles.children.length>p.particles)particles.lastChild?.remove();
  Array.from(particles.children).forEach((el,i)=>{const angle=i*Math.PI/6+t*.4;const e=el as HTMLElement;e.style.left=`${48+40*Math.cos(angle)}%`;e.style.top=`${45+35*Math.sin(angle)}%`;e.style.opacity=String(.45+.4*Math.sin(i+t)**2);});
  if(!bubble||document.activeElement!==question)$('status').textContent=say(notice||p.emotion);
}
async function sampleNative(){
  if(sampling||!visible)return;sampling=true;
  try{
    const v=await invoke<Sample>('companion_sample'); if(!visible)return;sample=v;
    if(v.bounds)bounds=v.bounds;
    if(!moving&&!drag&&!physics.active){physics.x=v.x;physics.y=v.y;}
    if(v.cursor){const size=config.settings.size*v.scale;physics.look((v.cursor.x-v.x-size/2)/90,(v.cursor.y-v.y-size*.45)/100);}
  }catch{/* Cursor APIs may be unavailable on Wayland; local pointer remains usable. */}finally{sampling=false;}
}
async function flushMove(){
  if(moving||!visible||!desired)return;moving=true;
  const point=desired;desired=null;const save=savePosition;savePosition=false;
  try{await invoke('companion_move',{x:Math.round(point.x),y:Math.round(point.y),save});}
  catch{physics.vx=physics.vy=0;$('status').textContent=say('failed');}
  finally{moving=false;if(desired&&visible)void flushMove();}
}
const loop=createFrameLoop({now:()=>performance.now(),raf:requestAnimationFrame,cancelRaf:cancelAnimationFrame,
  delay:(cb,ms)=>window.setTimeout(cb,ms),cancelDelay:clearTimeout},dt=>{
  physics.step(dt,bounds);
  const inMotion=!!drag||Math.hypot(physics.vx,physics.vy)>0;
  if(config.platform.movable&&(inMotion||wasMoving)){
    desired={x:physics.x,y:physics.y};if(wasMoving&&!inMotion)savePosition=true;void flushMove();
  }
  wasMoving=inMotion;
  if(physics.time-sampledAt>.5){sampledAt=physics.time;void sampleNative();}
  paint();
},()=>frameRate(physics.active,battery||config?.settings.battery,!visible||!ready));
function visibility(on:boolean){
  if(!on){microphone.stop();$('answer').replaceChildren();notice=null;}
  visible=on&&!document.hidden;document.body.classList.toggle('paused',!visible);
  if(visible&&ready){sampledAt=-10;loop.start();}
  else{loop.stop();clearTimeout(clickTimer);clickTimer=0;desired=null;physics.vx=physics.vy=0;drag=null;physics.release();question.value='';void audio?.suspend();}
}
function apply(value:Settings){
  config.settings=value;physics.reduced=value.reduced||reduced.matches;
  document.documentElement.lang=value.locale;
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(el=>{el.textContent=say(el.dataset.copy as CopyKey);});
  for(const [id,key] of [['bird','bird'],['bubble','bubble'],['collapse','close'],['settings-toggle','settings'],['rv-voice','mic']] as const)$(id).setAttribute('aria-label',say(key));
  bird.title=say('bird');question.placeholder=say('call');
  paint();
}
async function setBubble(on:boolean){
  if(!on)microphone.stop();
  if (on) await new Promise<void>(resolve => afterRaviLanding(resolve));
  try{await invoke('companion_bubble',{open:on});bubble=on;$('bubble').hidden=!on;if(on){visibility(true);question.focus();}await sampleNative();}
  catch{$('status').textContent=say('failed');}
}
function ask(text:string){
  const safe=text.trim();question.value='';
  if(containsRaviSecret(safe)){$('answer').textContent=say('secret');return;}
  if(!safe)return;
  $('answer').innerHTML=raviAnswerHtml(safe,config.settings.locale as 'ko'|'en'|'ja'|'zh');mood('focused');
}
$('ask').onsubmit=e=>{e.preventDefault();ask(question.value);};
$('answer').onclick=e=>{const target=(e.target as Element).closest<HTMLButtonElement>('button');if(!target)return;
  const id=target.dataset.raviInput||target.dataset.guideTopic;const guide=id?guideById(id):null;
  if(guide)ask(guide.say);else void invoke('companion_open_main').catch(()=>{$('status').textContent=say('failed');});};
question.onfocus=()=>{physics.touch();mood('focused');};question.onblur=()=>mood(physics.resting);question.oninput=()=>physics.touch();
$('collapse').onclick=()=>{void setBubble(false);mood(physics.resting);};
$('open-main').onclick=()=>{question.value='';void invoke('companion_open_main').catch(()=>{$('status').textContent=say('failed');});};
$('settings-toggle').onclick=()=>{void invoke('companion_open_main').catch(()=>{});};
$('today').onclick=()=>{void invoke('companion_dismiss',{today:true}).catch(()=>{$('status').textContent=say('failed');});};
async function call(){showNotice('call');await invoke('companion_click').catch(()=>{$('status').textContent=say('failed');});}
// Measure the actual bubble contents, with a fixed readable width, before native resizing.
let resizePending=false,lastMeasure='';
function resizeBubble(){
  if(!bubble||!currentLayout||resizePending)return;
  const height=Math.ceil($('bubble').scrollHeight)+2;
  const signature=`${height}:${currentLayout.bubble_height}`;
  if(signature===lastMeasure)return;
  lastMeasure=signature;
  if(Math.abs(height-currentLayout.bubble_height)<2)return;
  resizePending=true;
  void invoke('companion_bubble',{open:true,height}).catch(()=>{$('status').textContent=say('failed');}).finally(()=>{resizePending=false;queueMicrotask(resizeBubble);});
}
new ResizeObserver(resizeBubble).observe($('bubble'));
$('bubble').addEventListener('input',()=>{void invoke('companion_hold',{hold:true});});
$('bubble').addEventListener('focusout',()=>{queueMicrotask(()=>{if(!$('bubble').contains(document.activeElement))void invoke('companion_hold',{hold:false});});});
$('ask').addEventListener('submit',()=>{void invoke('companion_hold',{hold:false});});
bird.onpointerdown=e=>{
  if(e.button!==0||!sample)return;if(config.settings.sound&&!audio)audio=new AudioContext();physics.touch();bird.setPointerCapture(e.pointerId);
  drag={x:e.screenX,y:e.screenY,px:sample.x,py:sample.y,at:performance.now(),distance:0};
  physics.x=sample.x;physics.y=sample.y;physics.beginDrag();
};
bird.onpointermove=e=>{
  if(!drag||!sample||!config.platform.movable)return;
  const dx=(e.screenX-drag.x)*sample.scale,dy=(e.screenY-drag.y)*sample.scale,now=performance.now();
  drag.distance=Math.max(drag.distance,Math.hypot(dx,dy));
  physics.drag(drag.px+dx,drag.py+dy,Math.max(.001,(now-drag.at)/1000),{left:-100000,top:-100000,right:100000,bottom:100000});drag.at=now;
};
bird.onpointerup=async e=>{
  if(!drag)return;const distance=drag.distance;drag=null;physics.release();bird.releasePointerCapture(e.pointerId);
  if(distance<5){physics.vx=physics.vy=0;clearTimeout(clickTimer);clickTimer=window.setTimeout(()=>{clickTimer=0;if(visible)void call();},260);}
  else{await sampleNative();if(sample){physics.x=sample.x;physics.y=sample.y;}savePosition=true;desired={x:physics.x,y:physics.y};void flushMove();}
};
bird.onpointercancel=()=>{drag=null;physics.release();physics.vx=physics.vy=0;};
bird.ondblclick=()=>{clearTimeout(clickTimer);clickTimer=0;afterRaviLanding(()=>{void invoke('companion_open_main').catch(()=>{});});};
bird.onclick=e=>{if(e.detail===0)void call();};
bird.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void call();}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){question.value='';void setBubble(false);}});
document.addEventListener('visibilitychange',()=>visibility(!document.hidden));
window.addEventListener('blur',()=>{if(microphone.state!=='requesting')microphone.stop();});window.addEventListener('focus',()=>visibility(true));
window.addEventListener('pagehide',()=>{visibility(false);void audio?.close();});
reduced.addEventListener('change',()=>{if(config)apply(config.settings);});
// Battery API is optional in native webviews; the explicit power-saving switch always works.
type Battery=EventTarget&{charging:boolean};
const batteryNavigator=navigator as Navigator&{getBattery?:()=>Promise<Battery>};
void batteryNavigator.getBattery?.().then(b=>{const update=()=>{battery=!b.charging;};update();b.addEventListener('chargingchange',update);}).catch(()=>{});
async function init(){
  try{
    config=await invoke<Setup>('companion_settings');apply(config.settings);
    document.body.classList.toggle('opaque',!config.platform.transparent);
    applyLayout(config.layout);if(config.message)showNotice(config.message);
    await Promise.all([
      listen<boolean>('companion-visible',e=>visibility(e.payload)),
      listen<Layout>('companion-layout',e=>applyLayout(e.payload)),
      listen<string>('companion-notice',e=>showNotice(e.payload)),
      listen<boolean>('companion-bubble',e=>{afterRaviLanding(()=>{bubble=e.payload;$('bubble').hidden=!bubble;queueMicrotask(resizeBubble);if(bubble&&notice==='call'&&document.hasFocus())question.focus();});}),
      listen<Settings>('companion-settings',e=>apply(e.payload)),
      listen<Emotion>('companion-state',e=>mood(e.payload)),
      listen<string>('companion-error',()=>{$('status').textContent=say('failed');}),
    ]);
    config=await invoke<Setup>('companion_settings');apply(config.settings);applyLayout(config.layout);if(config.message)showNotice(config.message);
    await sampleNative();if(sample){physics.x=sample.x;physics.y=sample.y;}
    if(config.settings.greeting&&config.settings.resident_start)physics.arrive();
    bubble=config.bubble;$('bubble').hidden=!bubble;
    window.setTimeout(finishRaviLanding, config.settings.greeting&&config.settings.resident_start ? 2100 : 0);
    ready=true;visibility(config.visible);if(bubble&&config.visible&&notice==='call')question.focus();
  }catch{finishRaviLanding();$('bubble').hidden=true;bird.title=say('failed');}
}
void init();
