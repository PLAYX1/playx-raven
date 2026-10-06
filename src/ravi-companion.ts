import { mountRaviMicrophone } from "./ravi-microphone";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import scene from "./assets/ravi-scene.svg?raw";
import { containsRaviSecret, raviAnswerHtml, guideById } from "./ravi-guide";
import { RaviPhysics, createFrameLoop, frameRate, type Bounds, type Emotion } from "./ravi-physics";
import "./ravi-companion.css";

type Settings = { size: number; greeting: boolean; sound: boolean; reduced: boolean; battery: boolean; resident_start: boolean; simple_window: boolean; shortcut: string; x: number|null; y: number|null };
type Setup = { bubble: boolean; saved: boolean; settings: Settings; platform: { transparent: boolean; movable: boolean; notice: string }; shortcut_notice: string };
type Sample = { x:number; y:number; scale:number; cursor:{x:number;y:number}|null; bounds:Bounds|null };
const $ = (id:string) => document.getElementById(id)!;
const bird=$("bird"), character=$("character"), question=$("question") as HTMLInputElement;
character.innerHTML=scene;
character.querySelector('#lake')?.remove();
const physics=new RaviPhysics();physics.resting="sleep";
let config:Setup, visible=true, ready=false, sample:Sample|null=null, sampling=false, sampledAt=-10;
let bounds:Bounds={left:0,top:0,right:0,bottom:0}, bubble=false, moving=false, desired:{x:number;y:number}|null=null;
let savePosition=false, wasMoving=false, battery=false, audio:AudioContext|null=null;
let clickTimer=0;
let drag:{x:number;y:number;px:number;py:number;at:number;distance:number}|null=null;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const labels:Record<Emotion,string>={idle:'곁에 있어요.',joy:'좋은 소식이 왔어요!',sleepy:'조금 졸려요…',surprised:'앗, 깜짝이야!',focused:'듣고 있어요.',thinking:'생각 중이에요…',working:'도구로 확인 중이에요…',sleep:'잠든 라비 · 눌러서 안내를 받아요.'};
const transform=(id:string,v:string)=>character.querySelector(`#${id}`)?.setAttribute('transform',v);
const opacity=(id:string,v:number)=>character.querySelector(`#${id}`)?.setAttribute('opacity',String(v));
const microphone = mountRaviMicrophone({
  provider() { try { return localStorage.getItem('rv-voice-provider') || ''; } catch { return ''; } },
  allowed: () => visible && bubble && !document.hidden,
  transcript(text) { question.value = text; },
  quiet() { if (audio) void audio.suspend().catch(() => {}); },
  listening(on) { mood(on ? 'focused' : physics.resting); },
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
  character.style.opacity=config?.settings.greeting&&t<.45?String(.3+t/.45*.7):'1';
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
  if(!bubble||document.activeElement!==question)$('status').textContent=labels[p.emotion];
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
  catch{physics.vx=physics.vy=0;$('status').textContent='창틀로 라비를 옮겨 주세요.';}
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
  if(!on)microphone.stop();
  visible=on&&!document.hidden;document.body.classList.toggle('paused',!visible);
  if(visible&&ready){sampledAt=-10;loop.start();}
  else{loop.stop();clearTimeout(clickTimer);clickTimer=0;desired=null;physics.vx=physics.vy=0;drag=null;physics.release();question.value='';void audio?.suspend();}
}
function apply(value:Settings){
  config.settings=value;physics.reduced=value.reduced||reduced.matches;
  document.documentElement.style.setProperty('--bird-size',`${value.size}px`);
  for(const key of ['greeting','sound','reduced','battery','resident_start','simple_window'] as const)($(key) as HTMLInputElement).checked=value[key];
  ($('size') as HTMLSelectElement).value=String(value.size);($('shortcut') as HTMLSelectElement).value=value.shortcut;
  if(config.saved)try{localStorage.setItem('rv-ravi-start-off',value.greeting?'0':'1');}catch{/* optional */}
  paint();
}
async function setBubble(on:boolean){
  if(!on)microphone.stop();
  try{await invoke('companion_bubble',{open:on});bubble=on;$('bubble').hidden=!on;if(on){visibility(true);question.focus();}await sampleNative();}
  catch{$('status').textContent='말풍선을 열지 못했어요. 트레이에서 큰 화면을 열어 주세요.';}
}
function ask(text:string){
  const safe=text.trim();question.value='';
  if(containsRaviSecret(safe)){$('answer').textContent='비밀 정보는 대화창에 넣지 마세요. 설정의 전용 입력칸을 사용해 주세요.';return;}
  if(!safe)return;
  $('answer').innerHTML=raviAnswerHtml(safe,'ko');mood('focused');
}
$('ask').onsubmit=e=>{e.preventDefault();ask(question.value);};
$('answer').onclick=e=>{const target=(e.target as Element).closest<HTMLButtonElement>('button');if(!target)return;
  const id=target.dataset.raviInput||target.dataset.guideTopic;const guide=id?guideById(id):null;
  if(guide)ask(guide.say);else void invoke('companion_open_main').catch(()=>{$('status').textContent='큰 화면을 열지 못했어요.';});};
question.onfocus=()=>{physics.touch();mood('focused');};question.onblur=()=>mood(physics.resting);question.oninput=()=>physics.touch();
$('collapse').onclick=()=>{void setBubble(false);mood(physics.resting);};
$('open-main').onclick=()=>{question.value='';void invoke('companion_open_main').catch(()=>{$('status').textContent='큰 화면을 열지 못했어요.';});};
$('settings-toggle').onclick=()=>{const p=$('preferences') as HTMLDetailsElement;p.open=!p.open;};
$('save').onclick=async()=>{
  const next={...config.settings,size:Number(($('size') as HTMLSelectElement).value),shortcut:($('shortcut') as HTMLSelectElement).value};
  for(const key of ['greeting','sound','reduced','battery','resident_start','simple_window'] as const)next[key]=($(key) as HTMLInputElement).checked;
  if(next.sound&&!audio)audio=new AudioContext();
  try{await invoke('companion_save',{value:next});apply(next);await setBubble(true);$('status').textContent='저장했어요.';}
  catch{$('status').textContent='설정을 저장하지 못했어요.';}
};
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
  if(distance<5){physics.vx=physics.vy=0;clearTimeout(clickTimer);clickTimer=window.setTimeout(()=>{clickTimer=0;if(visible)void setBubble(true);},260);}
  else{await sampleNative();if(sample){physics.x=sample.x;physics.y=sample.y;}savePosition=true;desired={x:physics.x,y:physics.y};void flushMove();}
};
bird.onpointercancel=()=>{drag=null;physics.release();physics.vx=physics.vy=0;};
bird.ondblclick=()=>{clearTimeout(clickTimer);clickTimer=0;void invoke('companion_open_main').catch(()=>{});};
bird.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void setBubble(true);}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){question.value='';void setBubble(false);}});
document.addEventListener('visibilitychange',()=>visibility(!document.hidden));
window.addEventListener('blur',()=>{if(microphone.state!=='requesting')visibility(false);});window.addEventListener('focus',()=>visibility(true));
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
    $('platform-notice').textContent=config.platform.notice;$('shortcut-notice').textContent=config.shortcut_notice;
    await Promise.all([
      listen<boolean>('companion-visible',e=>visibility(e.payload)),
      listen<boolean>('companion-bubble',e=>{bubble=e.payload;$('bubble').hidden=!bubble;if(bubble)question.focus();}),
      listen<Settings>('companion-settings',e=>apply(e.payload)),
      listen<Emotion>('companion-state',e=>mood(e.payload)),
      listen<string>('companion-error',e=>{$('status').textContent=e.payload;}),
    ]);
    await sampleNative();if(sample){physics.x=sample.x;physics.y=sample.y;}
    if(config.settings.greeting&&config.settings.resident_start){physics.arrive();$('status').textContent='안녕하세요. 오늘도 곁에 있을게요.';}
    bubble=config.bubble;$('bubble').hidden=!bubble;
    ready=true;visibility(document.hasFocus());if(bubble){question.focus();visibility(true);}
  }catch{$('bubble').hidden=false;$('status').textContent='라비 창을 준비하지 못했어요. 트레이에서 큰 화면을 열어 주세요.';}
}
void init();
