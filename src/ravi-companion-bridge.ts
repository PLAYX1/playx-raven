import { copy } from './companion-copy';
import { afterRaviLanding } from './firstrun';
/** Only UI location and fixed state names cross the resident boundary. Never chat/form contents. */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
const PAGE_KEY='rv-companion-page';
const PAGES=['home','ravi','wallet','shop','settings','talk','assets','parts','profile'];
export function rememberCompanionPage(id:string){try{if(PAGES.includes(id))localStorage.setItem(PAGE_KEY,id);}catch{/* optional */}}
export function restoreCompanionPage(){try{const id=localStorage.getItem(PAGE_KEY);return id&&PAGES.includes(id)?id:'home';}catch{return 'home';}}
export async function mountCompanionBridge(){
  const signal=(kind:string)=>{void invoke('companion_signal',{kind}).catch(()=>{});};
  try{
    const initial=await invoke<{saved:boolean;settings:{greeting:boolean}}>('companion_settings');
    if(!initial?.settings)return;
    if(!initial.saved && localStorage.getItem('rv-ravi-start-off')==='1'){
      await invoke('companion_save',{value:{...initial.settings,greeting:false}});
    }else if(initial.saved)localStorage.setItem('rv-ravi-start-off',initial.settings.greeting?'0':'1');
    await listen<{greeting:boolean}>('companion-settings',e=>{
      localStorage.setItem('rv-ravi-start-off',e.payload.greeting?'0':'1');
      const checkbox=document.querySelector<HTMLInputElement>('#ravi-agent-settings > label input');if(checkbox)checkbox.checked=!e.payload.greeting;
    });
    document.getElementById('ravi-agent-settings')?.addEventListener('change',async e=>{
      const checkbox=e.target as HTMLInputElement;if(checkbox.type!=='checkbox'||checkbox.parentElement?.parentElement?.id!=='ravi-agent-settings')return;
      try{const v=await invoke<{settings:Record<string,unknown>}>('companion_settings');await invoke('companion_save',{value:{...v.settings,greeting:!checkbox.checked}});}catch{/* existing UI keeps its local preference */}
    });
    const tools=document.getElementById('chat-log');
    if(tools)new MutationObserver(()=>{if(tools.querySelector('[data-ravi-tool="working"]'))signal('working');}).observe(tools,{childList:true,subtree:true,attributes:true,attributeFilter:['data-ravi-tool']});
    await listen('companion-chat',()=>{afterRaviLanding(()=>document.getElementById('ravi-open')?.click());});
    const panel=document.createElement('section');panel.id='companion-preferences';panel.setAttribute('translate','no');
    document.getElementById('page-settings')?.append(panel);
    const locale=()=>localStorage.getItem('playx-raven-lang')||navigator.language.slice(0,2);
    const render=async()=>{
      const {settings:s}=await invoke<{settings:Record<string,unknown>}>('companion_settings');
      const language=['ko','en','ja','zh'].includes(locale())?locale():'en';
      const c=(key:Parameters<typeof copy>[0])=>copy(key,language);
      panel.replaceChildren();const title=document.createElement('h3');title.textContent=c('title');panel.append(title);
      const intro=document.createElement('p');intro.textContent=c('intro');panel.append(intro);
      const form=document.createElement('form');panel.append(form);
      const controls=new Map<string,HTMLInputElement|HTMLSelectElement>();
      for(const [key,label] of [['always_visible','always'],['resident_start','start'],['reduced','reduced'],['greeting','greeting'],['sound','sound'],['battery','battery']] as const){
        const row=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=!!s[key];
        row.append(input,document.createTextNode(c(label)));row.style.display='block';form.append(row);controls.set(key,input);
      }
      for(const [key,label,min,max] of [['quiet_start','quietStart',0,23],['quiet_end','quietEnd',0,23],['daily_limit','limit',0,20]] as const){
        const row=document.createElement('label'),input=document.createElement('input');input.type='number';input.min=String(min);input.max=String(max);input.required=true;input.value=String(s[key]);
        row.append(document.createTextNode(c(label)+' '),input);row.style.display='block';form.append(row);controls.set(key,input);
      }
      const row=document.createElement('label'),size=document.createElement('select');
      for(const [n,key] of [[120,'small'],[160,'normal'],[200,'large']] as const){const option=document.createElement('option');option.value=String(n);option.textContent=c(key);size.append(option);}
      size.value=String(s.size);row.append(document.createTextNode(c('size')+' '),size);form.append(row);controls.set('size',size);
      const hint=document.createElement('p');hint.textContent=c('shortcut');form.append(hint);
      const save=document.createElement('button');save.type='submit';save.textContent=c('save');form.append(save);
      const status=document.createElement('p');status.setAttribute('role','status');form.append(status);
      form.onsubmit=async e=>{e.preventDefault();
        const next:Record<string,unknown>={...s,locale:language,timezone:new Date().getTimezoneOffset()};
        for(const [key,input] of controls)next[key]=input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:Number(input.value);
        try{await invoke('companion_save',{value:next});status.textContent=c('saved');}catch{status.textContent=c('failed');}
      };
      if(s.locale!==language || s.timezone!==new Date().getTimezoneOffset()){
        await invoke('companion_save',{value:{...s,locale:language,timezone:new Date().getTimezoneOffset()}});
      }
      if(!s.notice_seen)afterRaviLanding(()=>{
        const note=document.createElement('aside');note.id='companion-first-notice';note.setAttribute('role','status');note.setAttribute('translate','no');note.textContent=c('intro');
        const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label',c('close'));close.onclick=()=>note.remove();note.append(close);
        const home=document.getElementById('page-home');
        if(home){home.prepend(note);void invoke<{settings:Record<string,unknown>}>('companion_settings').then(v=>invoke('companion_save',{value:{...v.settings,notice_seen:true}})).catch(()=>{});}
      });
    };
    await render();
    window.addEventListener('desktop-language-change',()=>{void render().catch(()=>{});});
  }catch{/* Browser fixtures do not create native windows. */}
}
