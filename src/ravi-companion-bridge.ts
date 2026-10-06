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
    const button=document.createElement('button');button.textContent='라비 상주 설정';button.type='button';
    button.onclick=()=>{void invoke('companion_show',{visible:true}).catch(()=>{});};
    document.getElementById('page-settings')?.append(button);
  }catch{/* Browser fixtures do not create native windows. */}
}
