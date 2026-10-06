// Production key handlers/state + in-process mock HTTP. Synthetic keys only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
const main = readFileSync('src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
async function exportsOf(path) {
  const result = await build({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false});
  const context = {module:{exports:{}},exports:{}};
  vm.runInNewContext(result.outputFiles[0].text,context);
  return context.module.exports;
}
const helpers = await exportsOf('src/ravi-key.ts');
const { providerOfKey } = await exportsOf('src/ravi-guide.ts');
const { DICT } = await exportsOf('src/dict.ts');
const key = ['AIza', '-synthetic-fixture-only'].join('');
const replacement = ['AIza', '-synthetic-replacement-AB12'].join('');
for (const wrapper of [key, ` \r\n"${key}"\n `, `Bearer ${key}`, `key='${key}'`, `'Bearer key="${key}"'`, key.slice(0,8)+'\n'+key.slice(8)]) {
  assert.ok(helpers.normalizeApiKey(wrapper) === key, 'paste wrappers removed');
  assert.equal(providerOfKey(helpers.normalizeApiKey(wrapper)), 'google');
}
let inputHandler, autoPick;
const wiring=main.slice(main.indexOf('  $("ravi-key").addEventListener("input"'),main.indexOf('  $("ravi-key").addEventListener("keydown"'));
vm.runInNewContext(compile(wiring),{...helpers,providerOfKey,keyPick:'openai',$:()=>({addEventListener(event,fn){inputHandler=fn;}}),pickKeyProvider:(p,clear)=>autoPick={p,clear}});
inputHandler({target:{id:'ravi-key-input',value:`"Bearer key='${key}'"`}});
assert.equal(autoPick.p,'google');assert.equal(autoPick.clear,false,'auto-selection preserves pasted key');
for (const secretError of [key, `HTTP body ${key}`, new Error(key), {message:key}, {kind:key,status:key}]) {
  assert.ok(!helpers.keyStorageError(secretError).includes(key));
  assert.ok(!helpers.keyConnectionFailure(secretError).phrase.includes(key));
  assert.ok(!JSON.stringify(helpers.safeConnectionError(secretError)).includes(key));
}
for (const kind of ['__proto__','constructor','toString',{}]) assert.equal(typeof helpers.keyConnectionFailure({kind}).phrase,'string');
assert.equal(helpers.keyConnectionFailure({kind:'network',status:401}).rejected,true);
assert.equal(helpers.keyConnectionFailure({kind:'rejected'}).rejected,false,'only numeric 400/401/403 may block');
assert.equal(helpers.keyConnectionFailure({kind:'server',status:'503'}).status,undefined);
const translate = language => phrase => language === 'ko' ? phrase : DICT[language][phrase] || phrase;
function storage(initial={}) {
  const values=new Map(Object.entries(initial));
  return {values,getItem:n=>values.get(n)??null,removeItem:n=>values.delete(n),setItem(n,v){
    assert.ok(!v.includes(key)&&!v.includes(replacement)&&!v.includes('private-body'),'no key/body persistence');values.set(n,v);
  }};
}
function fixture({language='ko', saveError, available={}, outcome=200, provider='google', saved=storage(), suffixes={}, custom=false} = {}) {
  const slots = new Map(), messages = [], calls = [], checks = new helpers.SavedKeyChecks(saved);
  let mood='sleep', gate, saveGate, renders=0;
  const slot = id => {
    if (!slots.has(id)) slots.set(id,{value:'',textContent:'',disabled:false,hidden:true,dataset:{},
      remove(){},setAttribute(k,v){this[k]=v;},querySelector(){return slot('retry');},querySelectorAll(){return [];}});
    return slots.get(id);
  };
  let options=[], selected='';
  slots.set('ai-pick',{get value(){return selected;},set value(v){selected=options.includes(v)?v:'';},set innerHTML(html){options=[...html.matchAll(/value="([^"]+)"/g)].map(m=>m[1]);selected=options[0]||'';}});
  const t = translate(language);
  const ctx = vm.createContext({ ...helpers,providerOfKey,$:slot,document:{getElementById:slot},
    PROVIDERS:{google:['Google (Gemini)','AIza…','https://aistudio.google.com/apikey'],openai:['OpenAI','sk-…','https://platform.openai.com/api-keys']},
    keyStoragePlatform:'macos', showKeyStorageHelp(){}, keyPick:provider, aiProvider:null,aiKeyed:{},lastKeyState:null,keyChecks:checks,raviHome:null,
    async invoke(command,args){
      calls.push(command); // Never record key arguments in logs/evidence.
      if(command==='save_api_key') {
        assert.ok(args.key===key || args.key===replacement || args.key==='synthetic-fixture-only','normalized key only');
        if(saveGate) await saveGate;
        if(saveError)throw saveError; available[args.provider]=true;
        const chars=Array.from(args.key);
        suffixes[args.provider]=chars.length < 4 ? '' : chars.slice(-4).join(''); return {};
      }
      if(command==='api_key_status')return {available,has_key:available,last4:suffixes,custom,custom_label:'Fixture custom'};
      if(command==='model_settings')return {};
      assert.equal(command,'ai_check_connection');
      const result=typeof outcome==='object'?outcome[args.provider]:outcome;
      if(gate)await gate;
      if(typeof result==='string')throw {kind:result,message:key,body:`private-body ${key}`};
      const request=new Request('http://mock-server.invalid/models');
      assert.equal(request.method,'GET');assert.equal(new URL(request.url).pathname,'/models');
      // In-process mock HTTP. Its body is deliberately never read by the handler.
      const response=new Response(`private-body ${key}`,{status:result});
      if(!response.ok)throw {status:response.status,kind:'http',body:key};
    },
    renderOrder(){},refreshOverview(){},sure(){throw Error('unexpected dialog');},
    setAllRaviMood:m=>mood=m,animateRavi:on=>mood=on?'awake':'sleep',
    closeKeyCard(){slot('ravi-key').hidden=true;slot('ravi-key-input').value='';},
    chatHtml(role,html){messages.push(html);},copyHtml:t,escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),t,tf:s=>s,
    setCopyText:(el,draw)=>el.textContent=draw(),showPage(){},openKeyCard(){slot('ravi-key').hidden=false;},
    console:{log(){throw Error('handler must not log');},error(){throw Error('handler must not log');}},
  });
  slot('ravi-key-save').hidden=false;slot('ravi-key').hidden=false;
  slot('ravi-key-input').value=`\n"Bearer key='${key}'"\r\n`;
  vm.runInContext(compile(['keyStorageSourceHtml','renderKeyRows','refreshKeys','keyStatusMessage','checkSavedKey','keyConnectionMessage','saveKeyCard','wakeRavi','keyCardHtml','paintRaviBadge'].map(fn).join('\n')),ctx);
  const renderRows=ctx.renderKeyRows;ctx.renderKeyRows=(...args)=>{renders++;return renderRows(...args);};
  return {ctx,slot,checks,calls,messages,saved,available,suffixes,get closed(){return slot('ravi-key').hidden;},get mood(){return mood;},get renders(){return renders;},
    block(){let release;gate=new Promise(r=>release=r);return release;},setOutcome(value){outcome=value;},
    blockSave(){let release;saveGate=new Promise(r=>release=r);return release;},
    async settle(){for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));if(!checks.pending.size)return;}throw Error('mock checks did not settle');},
  };
}
for(const language of ['ko','en','ja','zh']) {
  for(const outcome of [200,400,401,403,429,500,503,'network','timeout','storage','setup','format',404]) {
    const f=fixture({language,outcome});const release=f.block();
    await f.ctx.saveKeyCard();
    assert.equal(f.ctx.aiProvider,'google','save wakes Ravi before connection completes');
    assert.equal(f.closed,true);assert.ok(f.mood==='awake'||f.mood==='normal');
    assert.equal(f.slot('ravi-key-input').value,'');assert.equal(f.slot('ravi-key-save').disabled,false);
    assert.equal(f.checks.pending.has('google'),true);
    // Repeated refreshes and clicks do not repeat the background check.
    await f.ctx.refreshKeys();await f.ctx.refreshKeys();await f.ctx.saveKeyCard(true);
    assert.equal(f.calls.filter(c=>c==='ai_check_connection').length,1);
    assert.equal(f.ctx.aiProvider,'google','refresh during a slow check keeps a saved key awake');
    const rendersBeforeResult=f.renders;
    release();await f.settle();
    assert.equal(f.renders,rendersBeforeResult,'background result never rebuilds settings inputs');
    const rejected=[400,401,403].includes(outcome);
    assert.equal(f.ctx.aiProvider,rejected?null:'google');
    assert.equal(f.checks.pending.size,0);
    const note=f.slot('key-note').textContent;
    assert.ok(note.length>5);assert.ok(!note.includes(key)&&!note.includes('private-body'));
    if(language!=='ko')assert.ok(!/[가-힣]/.test(note),'four-language copy');
    if(typeof outcome==='number'&&outcome!==200)assert.ok(note.includes(`(${outcome})`));
    if(rejected)assert.ok(note.includes('Google AI Studio')&&note.includes('Generative Language API'));
    if(outcome!==200)assert.equal(f.slot('rv-home-ai-pill').dataset.ai,rejected?'off':'on');
    for(const message of f.messages)assert.ok(!message.includes(key)&&!message.includes('private-body'));
    // Simulate a fresh app, retaining only the secure-store availability + localStorage.
    const restarted=fixture({language,outcome,available:f.available,saved:f.saved,suffixes:f.suffixes});
    const resume=restarted.block();await restarted.ctx.refreshKeys();
    assert.equal(restarted.ctx.aiProvider,rejected?null:'google','transient failure never persists a sleep gate');
    resume();await restarted.settle();assert.equal(restarted.ctx.aiProvider,rejected?null:'google');
    assert.ok(!f.saved.values.has('rv-ai-pending-checks'));
  }
}
console.log('PASS 4 languages: save wakes during check; 200/400/401/403/429/500/503/404, network/timeout/storage/setup/format and restart');
for(const legacy of ['["google"]','["google","openai"]','{broken','null']) {
  const saved=storage({'rv-ai-pending-checks':legacy});
  const f=fixture({available:{google:true},saved,outcome:'timeout'});const release=f.block();
  assert.equal(saved.values.has('rv-ai-pending-checks'),false,'startup migration removes old pending state');
  await f.ctx.refreshKeys();assert.equal(f.ctx.aiProvider,'google');release();await f.settle();
  await f.ctx.refreshKeys();assert.equal(f.calls.filter(c=>c==='ai_check_connection').length,1,'check once on startup');
}
// Denied or corrupt localStorage never prevents saved-key wake/checks.
const denied={getItem(){throw Error('disabled');},setItem(){throw Error('disabled');},removeItem(){throw Error('disabled');}};
const privateMode=fixture({saved:denied,available:{google:true},outcome:503});
await privateMode.ctx.refreshKeys();await privateMode.settle();assert.equal(privateMode.ctx.aiProvider,'google');
for(const saveError of ['API 키를 보안 저장소에 저장하지 못했습니다.',key,new Error(key)]) {
  for(const language of ['ko','en','ja','zh']) {
    const f=fixture({language,saveError});await f.ctx.saveKeyCard();
    assert.ok(!f.calls.includes('ai_check_connection'));assert.equal(f.ctx.aiProvider,null);
    assert.equal(f.closed,false);assert.equal(f.slot('ravi-key-input').value,'');
    const note=f.slot('kc-note').textContent;assert.ok(note.length>10&&!note.includes(key));
    if(language==='ko')assert.ok(note.includes('키 저장에 실패'));
    else assert.ok(!/[가-힣]/.test(note));
  }
}
const old=fixture({saveError:key,available:{google:true},outcome:503});
await old.ctx.refreshKeys();await old.settle();old.slot('ravi-key').hidden=false;await old.ctx.saveKeyCard();
assert.equal(old.ctx.aiProvider,'google','failed replacement does not disable existing key');assert.equal(old.closed,false);
const lateStorage=fixture({saveError:key,available:{google:true},outcome:200});const unblock=lateStorage.block();
await lateStorage.ctx.refreshKeys('',true);await lateStorage.ctx.saveKeyCard();
unblock();await lateStorage.settle();
assert.ok(lateStorage.slot('kc-note').textContent.includes('키 저장에 실패'),'late advisory result cannot hide a storage failure');
assert.equal(lateStorage.ctx.aiProvider,'google');
const fallback=fixture({available:{google:true,openai:true},outcome:{google:401,openai:200}});
await fallback.ctx.refreshKeys('google');await fallback.settle();assert.equal(fallback.ctx.aiProvider,'openai','other saved provider remains usable');
assert.ok(fallback.slot('key-note').textContent.includes('Google AI Studio'));
const wrongCompany=fixture({provider:'openai'});await wrongCompany.ctx.saveKeyCard();
assert.equal(wrongCompany.calls.length,0);assert.equal(wrongCompany.slot('ravi-key-input').value,'');
const openai=fixture({provider:'openai',outcome:403});openai.slot('ravi-key-input').value='Bearer synthetic-fixture-only';
await openai.ctx.saveKeyCard();await openai.settle();
assert.ok(openai.slot('key-note').textContent.includes('OpenAI')&&!openai.slot('key-note').textContent.includes('Google AI Studio'));
const duplicate=fixture();
await Promise.all([duplicate.ctx.saveKeyCard(),duplicate.ctx.saveKeyCard()]);await duplicate.settle();
assert.equal(duplicate.calls.filter(c=>c==='save_api_key').length,1);
// Rejected key can be corrected; no explicit “try anyway” action is needed.
fallback.ctx.keyPick='google';fallback.slot('ravi-key-input').value=key;fallback.setOutcome({google:200,openai:200});
await fallback.ctx.saveKeyCard();await fallback.settle();assert.equal(fallback.ctx.aiProvider,'google');
assert.equal(fallback.checks.rejected.has('google'),false);
const retry=fixture({outcome:503});await retry.ctx.saveKeyCard();await retry.settle();
retry.setOutcome(401);await retry.ctx.saveKeyCard(true);await retry.settle();
assert.equal(retry.ctx.aiProvider,null,'manual check can discover an explicit rejection');
retry.setOutcome('timeout');await retry.ctx.saveKeyCard(true);await retry.settle();
assert.equal(retry.ctx.aiProvider,null,'timeout does not erase a prior explicit rejection');
retry.setOutcome(200);await retry.ctx.saveKeyCard(true);await retry.settle();
assert.equal(retry.ctx.aiProvider,'google','successful retry clears rejection');
assert.equal(retry.calls.filter(c=>c==='save_api_key').length,1,'check-only never re-saves');
const checks=new helpers.SavedKeyChecks(storage());
const stale=checks.begin('google');checks.forget('google');const fresh=checks.begin('google');
assert.equal(checks.finish('google',stale,{status:401}),false,'old result cannot reject a replacement');
assert.equal(checks.pending.has('google'),true);checks.finish('google',fresh,{kind:'timeout'});
assert.equal(checks.rejected.has('google'),false);
const deleted=checks.begin('openai');checks.forget('openai');
assert.equal(checks.finish('openai',deleted,{status:403}),false,'deleted key ignores late checks');
// Unknown/body-bearing categories are stripped from both UI and persisted records.
const malformed=checks.begin('xai');checks.finish('xai',malformed,{kind:key,status:401,body:key});
assert.ok(!JSON.stringify(checks.results.get('xai')).includes(key));
console.log('PASS stuck-pending migration, private storage, other-provider fallback, Google paste, failed replacement, duplicate guard, stale results and no key/body/log leakage');

// Both production display paths must follow secure-store status through lifecycle changes.
for (const language of ['ko','en','ja','zh']) {
  const first=fixture({language});
  const finishFirstCheck=first.block();
  assert.equal(first.slot('ravi-key-last4').textContent,'');
  await first.ctx.saveKeyCard();
  const assertSuffix=(f,suffix)=>{
    assert.equal(f.slot('ravi-key-last4').textContent,`····${suffix}`);
    assert.ok(f.slot('keyrows').innerHTML.includes(`Google (Gemini) · ····${suffix}</span>`));
    for(const full of [key,replacement]) {
      assert.ok(!f.slot('keyrows').innerHTML.includes(full),'list never exposes full key');
      assert.ok(!f.slot('ravi-key-last4').textContent.includes(full),'badge never exposes full key');
    }
  };
  assertSuffix(first,'only'); // immediately after save, before advisory result
  assert.equal(first.checks.pending.has('google'),true);
  finishFirstCheck();
  await first.settle();assertSuffix(first,'only');
  const restarted=fixture({language,available:{...first.available},saved:first.saved,suffixes:{...first.suffixes}});
  await restarted.ctx.refreshKeys();assertSuffix(restarted,'only');await restarted.settle();
  restarted.slot('ravi-key').hidden=false;
  restarted.slot('ravi-key-input').value=replacement;
  const finishReplacementCheck=restarted.block();
  await restarted.ctx.saveKeyCard();assertSuffix(restarted,'AB12');
  assert.equal(restarted.checks.pending.has('google'),true);
  assert.ok(!restarted.slot('keyrows').innerHTML.includes('····only'),'replacement removes old suffix');
  finishReplacementCheck();
  await restarted.settle();assertSuffix(restarted,'AB12');
  const replacedRestart=fixture({language,available:{...restarted.available},saved:restarted.saved,suffixes:{...restarted.suffixes}});
  await replacedRestart.ctx.refreshKeys();await replacedRestart.settle();assertSuffix(replacedRestart,'AB12');
  const failedReplacement=fixture({language,available:{google:true},suffixes:{google:'AB12'},saveError:replacement});
  await failedReplacement.ctx.refreshKeys();await failedReplacement.settle();
  failedReplacement.slot('ravi-key-input').value=key;
  await failedReplacement.ctx.saveKeyCard();assertSuffix(failedReplacement,'AB12');
  assert.ok(!failedReplacement.slot('kc-note').textContent.includes(replacement),'replacement errors never expose key');
}
// Reject malformed IPC suffixes rather than taking fragments from longer values.
for (const suffix of ['', 'a', 'ab', 'abc', 'abcde', key, replacement, null, 1234, {}, ['a','b','c','d']]) {
  assert.equal(helpers.keyLast4(suffix),'');
  const f=fixture({available:{google:true,custom:true},suffixes:{google:suffix,custom:suffix},custom:true});
  await f.ctx.refreshKeys();await f.settle();
  assert.equal(f.slot('ravi-key-last4').textContent,'');
  assert.ok(!f.slot('keyrows').innerHTML.includes('····'),'invalid suffix has no mask or fragment');
}
for (const suffix of ['AB12','😀한글末','<>&"']) {
  assert.equal(helpers.keyLast4(suffix),suffix,'four Unicode characters, not four bytes');
  const f=fixture({available:{google:true,openai:true,custom:true},suffixes:{google:suffix,openai:'5678',custom:suffix},custom:true});
  await f.ctx.refreshKeys();await f.settle();
  assert.equal(f.slot('ravi-key-last4').textContent,`····${suffix}`);
  const escaped=f.ctx.escapeHtml(suffix);
  assert.ok(f.slot('keyrows').innerHTML.includes(`····${escaped}</span>`),'suffix in HTML is escaped');
  assert.ok(f.slot('keyrows').innerHTML.includes(`<span class="saved">····${escaped}</span>`),'custom row restores suffix');
  await f.ctx.refreshKeys('openai');await f.settle();
  assert.equal(f.slot('ravi-key-last4').textContent,'····5678','provider switch follows selected key');
  f.available.google=false;f.available.openai=false;f.available.custom=false;
  await f.ctx.refreshKeys();
  assert.equal(f.slot('ravi-key-last4').textContent,'','no available key clears old suffix');
  assert.ok(!f.slot('keyrows').innerHTML.includes('····'),'no saved key clears rows');
}
console.log('PASS last-four-only badge/list: immediate save, restart, replacement during pending check, replaced restart, failed replacement, malformed/short IPC, Unicode, HTML escaping, custom provider, switch and removal');

for (const language of ['ko','en','ja','zh']) {
  const t=translate(language);
  assert.ok(language==='ko'||t(helpers.KEYCHAIN_SAVING)!==helpers.KEYCHAIN_SAVING,'saving popup guidance translated');
  assert.ok(language==='ko'||t(helpers.KEYCHAIN_LEGACY_HELP)!==helpers.KEYCHAIN_LEGACY_HELP,'manual recovery translated');
  const pending=fixture({language}), release=pending.blockSave();
  const save=pending.ctx.saveKeyCard();
  assert.equal(pending.slot('kc-note').textContent,t(helpers.KEYCHAIN_SAVING),'guidance appears before keychain RPC completes');
  assert.equal(pending.slot('ravi-key-save').disabled,true);
  await pending.ctx.saveKeyCard();
  assert.equal(pending.calls.filter(c=>c==='save_api_key').length,1,'no duplicate writes while permission prompt waits');
  release();await save;await pending.settle();
  assert.equal(pending.slot('ravi-key-save').disabled,false);
  for (const [stage,kind,code] of [['set','access-denied',-25293],['recovery-delete','cancelled',-128],['set','locked',-25308],['retry-set','duplicate',-25299],['generation-set','other',-25244],['generation-metadata','unavailable',null]]) {
    const error='key-store:'+JSON.stringify({stage,kind,code,previous:{stage:'recovery-delete',kind:'access-denied',code:-25244},message:key,body:replacement});
    const f=fixture({language,saveError:error});await f.ctx.saveKeyCard();
    const text=f.slot('kc-note').textContent;
    assert.equal(text,`${t('키 저장에 실패했어요.')} ${helpers.keyStorageError(error,t)}`);
    assert.ok(!text.includes(key)&&!text.includes(replacement)&&!text.includes(String(code)), 'screen exposes no raw key, body or OS code');
    assert.ok(!text.includes('key-store:'),'raw IPC diagnostic is not rendered');
    if(language!=='ko')assert.ok(!/[가-힣]/.test(text),'all step/classification phrases translated');
    assert.equal(f.calls.includes('ai_check_connection'),false,'storage failure never launches a connection check');
    assert.equal(f.mood,'sleep');
  }
}
for (const error of ['key-store:'+JSON.stringify({stage:key,kind:'access-denied'}), 'key-store:'+JSON.stringify({stage:'set',kind:key}), 'key-store:{', 'key-store:null', 'key-store:'+JSON.stringify({stage:'__proto__',kind:'constructor'})]) {
  assert.ok(!helpers.keyStorageError(error).includes(key),'malformed diagnostic never leaks IPC content');
}
console.log('PASS 4-language keychain permission waiting, recovery step/classification copy, manual recovery, no key/body/code leakage and no connection check on failed storage');

// Execute the production recovery buttons with a synthetic DOM and RPC only.
for (const language of ['ko','en','ja','zh']) {
  for (const platform of ['macos','windows','linux']) {
    const t = translate(language), nodes = new Map(), commands = [];
    const make = (tag='div') => ({tag,id:'',textContent:'',innerHTML:'',disabled:false,children:[],
      append(child){this.children.push(child);},after(child){nodes.set(child.id,child);},
      remove(){nodes.delete(this.id);},querySelectorAll(){return this.children.filter(c=>c.tag==='button');}});
    const note=make();note.id='recovery-note';nodes.set(note.id,note);
    let stored=false, refreshed=false, failNative=true;
    const c=vm.createContext({...helpers,t,copyHtml:t,keyStoragePlatform:platform,
      document:{getElementById:id=>nodes.get(id),createElement:make},
      keyChecks:{forget(){}},refreshKeys:async()=>{refreshed=true;},
      invoke:async(command,args)=>{
        commands.push(command);
        if(command==='open_external') {assert.equal(args.url,'/System/Applications/Utilities/Keychain Access.app');return;}
        assert.equal(args.provider,'google');
        assert.ok(args.key===key,'retry/consent keeps the original key only in memory');
        if(command==='save_api_key'&&failNative)throw 'key-store:{"stage":"set","kind":"keychain-locked"}';
        if(command==='save_device_api_key')assert.equal(args.consent,true);
        stored=true;
      },
      console:{log(){throw Error('secret logging forbidden');},error(){throw Error('secret logging forbidden');}}
    });
    vm.runInContext(compile(fn('showKeyStorageHelp')),c);
    c.showKeyStorageHelp(note,'key-store:{"stage":"set","kind":"keychain-locked"}','google',key);
    const box=nodes.get('recovery-note-storage-help');
    assert.equal(commands.length,0,'rendering guidance never writes a key');
    assert.ok(!box.innerHTML.includes(key));
    if(language!=='ko')assert.ok(!/[가-힣]/.test(box.innerHTML),'all platform instructions translated');
    const find=label=>box.children.find(b=>b.textContent===t(label));
    if(platform==='macos') {
      await find('키체인 접근 열기').onclick();
      assert.equal(commands[0],'open_external');
      assert.ok(box.innerHTML.includes(t(helpers.keyStorageGuide('macos')[4])),'destructive reset warning is present');
    } else assert.ok(!find('키체인 접근 열기'),'no Mac application launch on another OS');
    if(platform==='linux') {assert.ok(!find(helpers.DEVICE_STORAGE_BUTTON));continue;}
    await find('다시 시도').onclick();assert.equal(stored,false);
    assert.ok(!commands.includes('save_device_api_key'),'failed retry cannot silently opt in');
    await find(helpers.DEVICE_STORAGE_BUTTON).onclick();
    assert.equal(stored,true);assert.equal(refreshed,true);
    assert.equal(note.textContent,t(helpers.DEVICE_STORAGE_LABEL));
    assert.equal(nodes.has('recovery-note-storage-help'),false);
    const restart=fixture({language,available:{google:true}});
    await restart.ctx.refreshKeys();await restart.settle();
    assert.equal(restart.ctx.aiProvider,'google','saved availability wakes Ravi after restart');
    const source=restart.ctx.keyStorageSourceHtml({storage_sources:{google:'device-encrypted'}},'google');
    assert.ok(source.includes(t(helpers.DEVICE_STORAGE_LABEL))&&source.includes('data-move-key'));
    assert.ok(!source.includes(key));
  }
}
console.log('PASS recovery flow in 4 languages / 3 platforms: exact launcher, retry, single-click consent, source status, restart wake and no secret rendering/logging');

{
  let refreshed=false,forgotten=false;
  const note={textContent:''};
  const c=vm.createContext({...helpers,t:s=>s,keyStoragePlatform:'macos',
    invoke:async()=>{throw 'key-store:{"stage":"delete","kind":"keychain-locked"}';},
    keyChecks:{forget(){forgotten=true;}},document:{getElementById(){return null;}},
    refreshKeys:async()=>{refreshed=true;},$:()=>note,setCopyText:(el,draw)=>el.textContent=draw()});
  vm.runInContext(compile(fn('deleteSavedKey')),c);
  await c.deleteSavedKey('google');
  assert.ok(refreshed&&forgotten,'partial native delete still refreshes tombstone state');
  assert.ok(!note.textContent.includes('key-store:'));
}
console.log('PASS partial native deletion updates availability without rendering raw IPC');
