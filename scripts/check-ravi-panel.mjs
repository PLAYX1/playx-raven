// Actual production panel/controller code with a deterministic DOM/layout adapter.
// Browser geometry is tested separately by check-ravi-panel-browser.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync('src/ravi-panel.ts','utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const storage=new Map();
function fixture({brokenStorage=false, saved}={}) {
  if(saved!==undefined)storage.set('ravenvault-ravi-panel',saved);
  const nodes=new Map(),docListeners=new Map(),mutations=[],resizes=[];
  const doc={activeElement:null,getElementById:id=>el(id),addEventListener:(name,fn)=>docListeners.set(name,fn)};
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    let top=0; const classes=new Set(),listeners=new Map();
    const node={id,hidden:false,value:'',textContent:'',attributes:{},parent:null,scrollHeight:1000,clientHeight:240,
      classList:{toggle(k,on){if(on)classes.add(k);else classes.delete(k);},contains:k=>classes.has(k)},
      append(child){child.parent=this;},contains(child){for(let n=child;n;n=n.parent)if(n===this)return true;return false;},
      focus(){doc.activeElement=this;},setAttribute(k,v){this.attributes[k]=v;},
      addEventListener(name,fn){listeners.set(name,fn);},emit(name,event={}){listeners.get(name)?.(event);},
      get scrollTop(){return top;},set scrollTop(value){top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));},
    };nodes.set(id,node);return node;
  }
  el('chat-q').parent=el('ravi-chatwrap');el('chat-log').parent=el('ravi-chatwrap');
  let sent=0,changes=0;const exports={};
  vm.runInNewContext(compiled,{exports,document:doc,t:s=>s,
    localStorage:{getItem:key=>{if(brokenStorage)throw Error('disabled');return storage.get(key);},setItem:(key,value)=>{if(brokenStorage)throw Error('disabled');storage.set(key,value);}},
    MutationObserver:class {constructor(fn){mutations.push(fn);}observe(){}},ResizeObserver:class {constructor(fn){resizes.push(fn);}observe(){}},
  });
  const panel=exports.createRaviPanel(()=>sent++,()=>changes++);
  return {el,doc,panel,mutations,resizes,docListeners,get sent(){return sent;},get changes(){return changes;}};
}
let f=fixture({saved:'{}'});
assert.equal(f.panel.visible(),false);assert.equal(f.el('ravi-launcher').hidden,false);
assert.equal(f.el('ravi-chatwrap').parent.id,'ravi-panel');
f.el('ravi-open').onclick();assert.equal(f.panel.visible(),true);assert.equal(f.doc.activeElement.id,'chat-q');
assert.equal(f.el('chat-log').scrollTop,760);assert.equal(f.el('ravi-new').hidden,true);
const log=f.el('chat-log');log.scrollHeight+=180;f.panel.message(true);assert.equal(log.scrollTop,940);
log.scrollHeight+=45;f.mutations[0]();assert.equal(log.scrollTop,985,'dynamic reply content follows bottom');
log.scrollTop=200;log.emit('scroll');log.scrollHeight+=320;f.panel.message(true);f.mutations[0]();
assert.equal(log.scrollTop,200,'reader position is retained');assert.equal(f.el('ravi-new').hidden,false);
assert.equal(f.el('ravi-announcement').textContent,'새 답이 왔어요');
f.el('ravi-expand').onclick();f.resizes[0]();assert.equal(log.scrollTop,200,'expanding never jumps a reader');
f.el('ravi-new').onclick();assert.equal(log.scrollTop,1305);assert.equal(f.el('ravi-new').hidden,true);
log.clientHeight=400;f.resizes[0]();assert.equal(log.scrollTop,1145,'resize retains following mode');
// Enter sends, while Shift+Enter and IME composition retain browser editing behavior.
let prevented=0;
const key=overrides=>({key:'Enter',shiftKey:false,isComposing:false,preventDefault(){prevented++;},...overrides});
f.el('chat-q').emit('keydown',key({}));assert.equal(f.sent,1);assert.equal(prevented,1);
f.el('chat-q').emit('keydown',key({shiftKey:true}));f.el('chat-q').emit('keydown',key({isComposing:true}));
assert.equal(f.sent,1);assert.equal(prevented,1);
f.doc.activeElement=f.el('chat-go');f.panel.sent();assert.equal(f.doc.activeElement.id,'chat-q');
f.doc.activeElement=f.el('desktop-preferences');log.scrollHeight+=80;f.panel.message(true);
assert.equal(f.doc.activeElement.id,'desktop-preferences','late reply never steals page focus');
f.docListeners.get('keydown')(key({key:'Tab'}));assert.equal(prevented,1,'no Tab/focus trap');
f.docListeners.get('keydown')(key({key:'Escape'}));assert.equal(f.panel.visible(),false);
assert.equal(f.doc.activeElement.id,'desktop-preferences','Escape preserves page focus');
f=fixture();assert.equal(f.panel.visible(),false);assert.equal(f.el('ravi-panel').classList.contains('large'),true);
f.panel.open();f=fixture();assert.equal(f.panel.visible(),false,'conversation never reopens on restart');
f.panel.open();
assert.equal(f.el('ravi-panel').classList.contains('large'),true);
f.el('chat-q').focus();f.el('ravi-collapse').onclick();assert.equal(f.doc.activeElement.id,'ravi-launcher');
f.panel.open();f.panel.suspend(true);assert.equal(f.panel.visible(),false);assert.equal(f.el('ravi-launcher').hidden,true);
const persisted=storage.get('ravenvault-ravi-panel');f.panel.suspend(false);assert.equal(f.panel.visible(),true);
assert.equal(storage.get('ravenvault-ravi-panel'),persisted,'temporary approval pause never changes saved preference');
f.el('ravi-panel').classList.toggle('reviewing',true);const before=f.sent;f.el('chat-q').emit('keydown',key({}));assert.equal(f.sent,before,'inline review blocks Enter sending');f.docListeners.get('keydown')(key({key:'Escape'}));assert.equal(f.panel.visible(),false,'Escape can collapse an inline card without approving it');
f=fixture({brokenStorage:true});f.panel.open();f.el('ravi-expand').onclick();assert.equal(f.panel.visible(),true);
f=fixture({saved:'{corrupted'});assert.equal(f.panel.visible(),false);
console.log('PASS production panel: shared DOM, bottom follow, dynamic content/resize, reader position/new-reply chip, Enter/Shift+Enter/IME, send focus/late focus, nonmodal Escape, stored open/size, approval pause, unavailable/corrupt storage');
// Execute production chatSend with a delayed reply. Sending twice must not duplicate a request.
const main=ts.createSourceFile('main.ts',readFileSync('src/main.ts','utf8'),ts.ScriptTarget.Latest,true);
const send=main.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='chatSend').getText(main);
f.panel.open();f.el('chat-q').value='synthetic question';let release,requests=0;
const barrier=new Promise(r=>release=r);
const ctx=vm.createContext({raviRequestPending:false,$:f.el,raviHome:{sent:f.panel.sent,thinking(){},finish(){}},
  async chatSendExisting(){requests++;f.el('chat-q').value='';await barrier;f.panel.message(true);},
});
vm.runInContext(ts.transpileModule(send,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
const sending=ctx.chatSend();assert.equal(f.doc.activeElement.id,'chat-q');assert.equal(f.el('chat-q').value,'');
f.el('chat-q').value='next question';await ctx.chatSend();assert.equal(requests,1);
f.doc.activeElement=f.el('desktop-preferences');release();await sending;
assert.equal(ctx.raviRequestPending,false);assert.equal(f.doc.activeElement.id,'desktop-preferences');
assert.equal(f.el('chat-q').value,'next question','typing during a response survives');
console.log('PASS production chatSend: duplicate-request guard, immediate retained input focus, next draft survives, delayed completion never steals focus');
