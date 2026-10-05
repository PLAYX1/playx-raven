// Execute the production top-level send, preprocessing and promo card in an isolated
// synthetic DOM. Only public shop-load is allowed. Every spending/AI/RPC call throws.
import { build } from 'esbuild';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export async function bundle(entry, options={}) {
 const result=await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,...options});
 return result.outputFiles[0].text;
}
function exportsOf(code, globals={}) {
 const ctx=vm.createContext({module:{exports:{}},exports:{},URL,navigator:{language:"en"},...globals});vm.runInContext(code,ctx);return ctx.module.exports;
}
export const guides=exportsOf(await bundle('src/ravi-guide.ts'));
export const intents=exportsOf(await bundle('src/ravi-intents.ts'));
const whose=exportsOf(await bundle("src/whose.ts"));
export const dict=exportsOf(await bundle('src/dict.ts')).DICT;
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.hidden=false;this.disabled=false;this.value='';this._text='';}
 append(...nodes){this.children.push(...nodes);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 get textContent(){return this._text+this.children.map(e=>e.textContent).join(' ');}
 set textContent(value){this._text=value;this.children=[];}
 focus(){} select(){}
}
export async function chatFixture(before=false) {
 const main=before ? execFileSync('git',['show','efcc880:src/main.ts'],{encoding:'utf8'}) : readFileSync('src/main.ts','utf8');
 const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
 const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(ast) || '';
 const historicCaps={name:'historic-capabilities',setup(b){b.onLoad({filter:/ravi-capabilities\.json$/},()=>({contents:execFileSync('git',['show','efcc880:src/ravi-capabilities.json'],{encoding:'utf8'}),loader:'json'}));}};
 const modules=before ? exportsOf((await build({stdin:{contents:execFileSync('git',['show','efcc880:src/ravi-guide.ts'],{encoding:'utf8'}),resolveDir:process.cwd()+'/src',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[historicCaps]})).outputFiles[0].text) : guides;
 const promo=before ? exportsOf((await build({stdin:{contents:execFileSync('git',['show','efcc880:src/ravi-promo.ts'],{encoding:'utf8'}),resolveDir:process.cwd()+'/src',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false})).outputFiles[0].text) : exportsOf(await bundle('src/ravi-promo.ts'));
 const nodes=new Map(),messages=[],calls=[],cards=[];
 const el=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id);};
 const document={createElement:tag=>new Element(tag),getElementById:()=>null};
 const i18n={name:'isolated-i18n',setup(b){b.onResolve({filter:/\.\/i18n$/},()=>({path:'i18n',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const lang="${before?'ko':'en'}";export const LANG_NAMES={ko:"한국어",en:"English",ja:"日本語",zh:"简体中文"};export const t=s=>s;`,loader:'js'}));}};
 const historicPromo={name:'historic-promo',setup(b){b.onLoad({filter:/ravi-promo\.ts$/},()=>({contents:execFileSync('git',['show','efcc880:src/ravi-promo.ts'],{encoding:'utf8'}),loader:'ts'}));}};
 const cardCode=before ? (await build({stdin:{contents:execFileSync('git',['show','efcc880:src/ravi-promo-card.ts'],{encoding:'utf8'}),resolveDir:process.cwd()+'/src',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.svg':'text'},plugins:[i18n,historicPromo]})).outputFiles[0].text : await bundle('src/ravi-promo-card.ts',{loader:{'.svg':'text'},plugins:[i18n]});
 const card=exportsOf(cardCode,{document,crypto:{randomUUID:()=>String(cards.length)},navigator:{clipboard:{writeText(){throw Error('No automatic clipboard write');}}}});
 const ctx=vm.createContext({...modules, ...promo,lang:'ko',aiProvider:null,raviRequestPending:false,promoOpening:false,serverIp:null,
  $:el,document,copyHtml:s=>s,t:s=>s,raviHome:{sent(){},thinking(){},finish(){},open(){}},
  whoseQuestion:whose.whoseQuestion,
  chatSay:(who,text)=>messages.push({who,text}),
  chatHtml:(who,html)=>{messages.push({who,html}); if(html.includes('data-promo-host')) {
   const host=new Element('div');cards.push(host);el('chat-log').lastElementChild={querySelector:()=>host};
  }},
  createPromoCard:card.createPromoCard,
  invoke:async(command)=>{calls.push(command);if(command==='shop_load')return {order_url:'https://example.test/order',menu:[]};throw Error(`Forbidden fixture RPC: ${command}`);},
  showPage:p=>calls.push(['page',p]),shopTab:t=>calls.push(['tab',t]),jumpToEl:i=>calls.push(['jump',i]),
  openQrSheet:()=>calls.push(['qr']),openReceive:()=>calls.push(['receive']),openSend:()=>calls.push(['send-form']),
  toggleDot:i=>calls.push(['dot',i]),openKeyCard:()=>calls.push(['key']),openReport:()=>calls.push(['report']),
 });
 const source=['chatSend','chatSendExisting','raviGuide','openRaviPromo','raviOpenScreen','raviGo'].map(fn).join('\n');
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 return {
  ctx,calls,cards,messages,
  async send(q,uiLanguage='ko') {
   messages.length=0;cards.length=0;calls.length=0;ctx.lang=uiLanguage;el('chat-q').value=q;await ctx.chatSend();
   const html=messages.filter(m=>m.who==='ai').at(-1)?.html||'';
   const root=cards.at(-1)?.children[0];
   const intent=root?.attributes['data-guide'] || /data-guide="([^"]+)"/.exec(html)?.[1] || (root?'promo':'secret');
   const language=root?.attributes['data-ravi-language'] || /data-ravi-language="([^"]+)"/.exec(html)?.[1];
   const buttons=root ? flatten(root).filter(n=>n.tagName==='button').map(n=>n._text) : [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m=>m[1]);
   const text=root ? flatten(root).flatMap(n=>[n._text,...(['textarea','input'].includes(n.tagName)?[n.value]:[])]).join(' ') : html.replace(/<[^>]+>/g,' ');
   const kind=root?"promo":/data-answer-kind="([^"]+)"/.exec(html)?.[1] || (intent==='help'?'help':'secret');
   return {intent,kind,language,html,buttons,text,root,routes:[...html.matchAll(/data-guide-go="([^"]+)"/g)].map(m=>m[1]),candidates:[...html.matchAll(/data-ravi-input="([^"]+)"/g)].map(m=>m[1]),calls:[...calls]};
  }
 };
}
export function flatten(node) {return [node,...node.children.flatMap(flatten)];}
