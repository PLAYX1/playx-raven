import { t } from "./i18n";
import { mountRaviRig } from "./ravi-rig";
import { farewellFrame, restingFrame, neutralFrame } from "./ravi-choreography";
import { createFrameLoop, frameRate } from "./ravi-physics";
import "./ravi-lifecycle.css";

type State={lock:'locked'|'open'|'unencrypted'|'unknown';active:number;tray:boolean};
type Invoke=<T=any>(name:string,args?:Record<string,unknown>)=>Promise<T>;
export const IDLE_MS=90_000;
export const lockCopy=(lock:State['lock'])=>lock==='locked'?"지갑이 잠겨 있어요.":lock==='open'?"종료하면 지갑을 잠가요.":lock==='unencrypted'?"이 지갑에는 암호 잠금이 설정되지 않았어요.":"지갑 잠금을 확인하지 못했어요.";
export function mountRaviLifecycle(api:{invoke:Invoke;pending():boolean; idleMs?:number}) {
  const dialog=document.createElement('dialog');dialog.className='ravi-lifecycle';
  dialog.setAttribute('aria-labelledby','ravi-lifecycle-title');dialog.setAttribute('aria-describedby','ravi-lifecycle-note');
  dialog.innerHTML='<div class="ravi-lifecycle-card"><div class="ravi-lifecycle-rig" aria-hidden="true"></div><p class="ravi-lifecycle-eyebrow">RAVENVAULT</p><h2 id="ravi-lifecycle-title"></h2><p id="ravi-lifecycle-note" role="status" aria-live="polite"></p><p class="ravi-lifecycle-detail"></p><div class="ravi-lifecycle-actions"></div></div>';
  document.body.append(dialog);
  const title=dialog.querySelector('h2')!,note=dialog.querySelector<HTMLElement>('#ravi-lifecycle-note')!,detail=dialog.querySelector<HTMLElement>('.ravi-lifecycle-detail')!;
  const actions=dialog.querySelector<HTMLElement>('.ravi-lifecycle-actions')!;
  const rig=mountRaviRig(dialog.querySelector<HTMLElement>('.ravi-lifecycle-rig')!);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let mode:'closed'|'idle'|'wake'|'quit'|'farewell'='closed',since=0,battery=false,saver=false,working=false,epoch=0;
  let lastInput=Date.now(),wakeTimer=0,suppressUntil=0,previous:HTMLElement|null=null;
  let checking=false, retryAfter=0;
  let state:State={lock:'unknown',active:0,tray:false};
  const loop=createFrameLoop({now:()=>performance.now(),raf:requestAnimationFrame,cancelRaf:cancelAnimationFrame,
    delay:(f,ms)=>window.setTimeout(f,ms),cancelDelay:clearTimeout},()=>{
    const elapsed=performance.now()-since;
    const frame=mode==='idle'?restingFrame(elapsed,reduced.matches):mode==='farewell'?farewellFrame(elapsed,reduced.matches):neutralFrame();
    if(mode==='wake'&&!reduced.matches){frame.head=-5;frame.wave=24*Math.sin(Math.min(1,elapsed/500)*Math.PI);}
    if(mode==='quit'&&!reduced.matches){frame.head=-4;frame.wave=18*Math.max(0,1-elapsed/900)*Math.sin(elapsed/80)**2;}
    rig.renderFrame(frame);
  },()=>frameRate(mode!=='idle',battery||saver,document.hidden||mode==='closed'));
  function start(){since=performance.now();loop.stop();if(!document.hidden)loop.start();}
  function open(){if(!dialog.open){previous=document.activeElement as HTMLElement;dialog.showModal();}document.dispatchEvent(new Event('ravi-lifecycle-change'));start();}
  function close(){epoch++;mode='closed';working=false;clearTimeout(wakeTimer);loop.stop();dialog.close();document.dispatchEvent(new Event('ravi-lifecycle-change'));document.body.classList.remove('ravi-private');lastInput=Date.now();!document.hidden&&previous?.isConnected&&previous.focus();}
  function button(label:string,run:()=>void){const b=document.createElement('button');b.type='button';b.textContent=t(label);b.onclick=run;actions.append(b);return b;}
  function paintQuit(){
    title.textContent=t('잘 가요, 또 만나요');
    note.textContent=t(state.active>0||api.pending()?'진행 중인 전송이 있어요. 끝난 뒤 종료해 주세요.':lockCopy(state.lock));
    detail.textContent=t('종료하면 주문 접수와 입금 확인도 멈춰요. 열쇠는 이 컴퓨터에 남아요.');
    quit.disabled=working||state.active>0||api.pending();tray.hidden=!state.tray;
  }
  let quit:HTMLButtonElement,keep:HTMLButtonElement,tray:HTMLButtonElement;
  async function refresh(){if(checking||Date.now()<retryAfter)return;checking=true;const id=epoch;try{const next=await api.invoke<State>('ravi_lifecycle_status');if(id!==epoch||mode!=='quit'||working)return;state=next;paintQuit();}catch{if(id===epoch&&mode==='quit'&&!working){note.textContent=t('상태를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.');quit.disabled=true;}}finally{checking=false;}}
  async function finish(){
    if(working||api.pending()||state.active>0)return;
    working=true;quit.disabled=keep.disabled=tray.disabled=true;note.textContent=t('지갑 잠금을 확인하고 있어요…');
    try{
      const prepared=await api.invoke<{lock:State['lock']}>('ravi_prepare_quit');
      mode='farewell';note.textContent=t(lockCopy(prepared.lock));start();
      await new Promise(resolve=>window.setTimeout(resolve,reduced.matches?220:820));
      await api.invoke('ravi_finish_quit');
    }catch{
      await api.invoke('ravi_cancel_quit').catch(()=>{});
      mode='quit';working=false;retryAfter=Date.now()+5000;keep.disabled=tray.disabled=false;
      note.textContent=t('종료하지 못했어요. 전송과 지갑 잠금을 확인한 뒤 다시 시도해 주세요.');quit.disabled=false;start();
    }
  }
  async function requestClose(){
    if(mode==='quit'||mode==='farewell')return;
    clearTimeout(wakeTimer);epoch++;retryAfter=0;mode='quit';document.body.classList.remove('ravi-private');actions.replaceChildren();
    keep=button('계속 쓰기',close);tray=button('트레이에 두기',()=>{void api.invoke('ravi_hide_main').then(()=>{close();rest();}).catch(()=>{note.textContent=t('트레이를 사용할 수 없어요.');});});
    quit=button('종료',()=>{void finish();});quit.className='ravi-quit';quit.disabled=true;tray.hidden=true;
    title.textContent=t('잘 가요, 또 만나요');note.textContent=t('상태를 확인하고 있어요…');detail.textContent='';
    open();keep.focus();await refresh();
  }
  function rest(){
    if(mode!=='closed')return;
    epoch++;mode='idle';title.textContent=t('잠시 쉬고 있어요');note.textContent=t('화면의 정보는 가려 두었어요.');
    detail.textContent=t('마우스를 움직이거나 키를 누르면 돌아와요. 지갑 잠금은 그대로 유지돼요.');
    actions.replaceChildren();button('돌아가기',wake);document.body.classList.add('ravi-private');open();
  }
  function wake(){
    if(mode!=='idle')return;
    mode='wake';title.textContent=t('다시 만나 반가워요');note.textContent=t('이제 함께할게요.');detail.textContent='';
    start();suppressUntil=performance.now()+650;
    wakeTimer=window.setTimeout(close,reduced.matches?180:550);
  }
  function activity(e:Event){
    lastInput=Date.now();
    if(mode==='idle'||mode==='wake'){
      if(e.type!=='pointermove'){e.preventDefault();e.stopImmediatePropagation();}
      wake();
    }else if(e.type==='click'&&performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}
  }
  const events=['pointermove','pointerdown','click','keydown','wheel','touchstart'];
  events.forEach(name=>document.addEventListener(name,activity,{capture:true,passive:false}));
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(mode==='idle')wake();else if(!working)close();});
  const visibility=()=>{loop.stop();if(document.hidden){if(mode==='closed')rest();}else if(mode!=='closed')loop.start();};
  document.addEventListener('visibilitychange',visibility);
  const timer=window.setInterval(()=>{
    if(mode==='closed'&&Date.now()-lastInput>=(api.idleMs??IDLE_MS))rest();
    if(mode==='quit'&&!working)void refresh();
  },1000);
  type Battery={charging:boolean;addEventListener(name:string,fn:()=>void):void;removeEventListener(name:string,fn:()=>void):void};
  let pack:Battery|undefined,disposed=false;
  void api.invoke('companion_settings').then(value=>{if(!disposed)saver=value?.settings?.battery===true;}).catch(()=>{});
  const charge=()=>{battery=pack?.charging===false;};
  void (navigator as Navigator & {getBattery?():Promise<Battery>}).getBattery?.().then(b=>{if(disposed)return;pack=b;charge();b.addEventListener('chargingchange',charge);}).catch(()=>{});
  return {requestClose,rest,destroy(){disposed=true;close();clearInterval(timer);events.forEach(name=>document.removeEventListener(name,activity,true));document.removeEventListener('visibilitychange',visibility);pack?.removeEventListener('chargingchange',charge);rig.destroy();dialog.remove();}};
}
