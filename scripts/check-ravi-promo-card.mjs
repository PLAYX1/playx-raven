// Real card/controller with a deterministic DOM/canvas adapter; never call providers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { intents, dict } from './ravi-chat-fixture.mjs';
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const core={}; vm.runInNewContext(compile(readFileSync('src/ravi-promo.ts','utf8')),{exports:core,URL,require:path=>path.includes("ravi-intents")?intents:({default:JSON.parse(readFileSync("src/ravi-promo-facts.json", "utf8"))})});
const elements=[], canvases=[], paints=[];
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.tabIndex=0;this._text='';elements.push(this);}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(key,value){this.attributes[key]=value;}
  get textContent(){return this._text+this.children.map(e=>e.textContent).join(' ');}
  set textContent(value){this._text=value;this.children=[];}
  focus(){this.focused=true;}
  select(){this.selected=true;}
  getContext(){return {fillStyle:'',font:'',imageSmoothingEnabled:true,measureText:s=>({width:s.length*18}),fillRect(...v){paints.push(['rect',...v]);},fillText(...v){paints.push(['text',...v]);},drawImage(...v){paints.push(['image',...v.slice(1)]);}};}
  toDataURL(){assert.equal(this.width,1080);assert.equal(this.height,1080);return 'data:image/png;base64,ZmFrZQ==';}
}
const document={createElement(tag){const e=new Element(tag);if(tag==='canvas')canvases.push(e);return e;}};
class Image {constructor(){this.naturalWidth=41;}set src(value){this._src=value;queueMicrotask(()=>this.onload());}}
const exports={},clip=[];
vm.runInNewContext(compile(readFileSync('src/ravi-promo-card.ts','utf8').replace(/^import .*;\n/gm,'')),{
  exports,...core,DICT:dict,raviQuestionLanguage:intents.raviQuestionLanguage,currentLang:"ko",document,Image,URL,crypto:{randomUUID:()=>String(elements.length)},t:s=>s,
  LANG_NAMES:{ko:'한국어',en:'English',ja:'日本語',zh:'简体中文'},scene:readFileSync('src/assets/ravi-scene.svg','utf8'),
  navigator:{clipboard:{async writeText(text){clip.push(text);}}},
});
let data={name_ko:'시험 가게',name_en:'Fixture shop',description:'소개',currency:'KRW',menu:[{name:'커피',price:3000}],order_url:'https://example.test/order'}, keyed=false, aiFail=false, loads=0, generations=0, saves=0, qrs=[], requests=[];
const api={async load(){loads++;return data;},keyed:()=>keyed,async generate(language,request,target){requests.push({language,request,target});generations++;if(aiFail)throw Error('fixture');return {x:'커피 2500원',instagram:'커피 3000원 #a #b #c #d #e #f',kakao:'이름\n커피 3000원\n주문',local:'안녕하세요 커피 3000원'};},async qr(url){qrs.push(url);return '<svg viewBox="0 0 41 41"></svg>';},async save(b64){assert.equal(b64,'ZmFrZQ==');saves++;return true;}};
const host=new Element('div');await exports.createPromoCard(host,api,'오늘 특가 알려 줘');
const card=host.children[0], all=()=>elements.filter(e=>e.tagName==='button'), btn=text=>all().find(e=>e._text===text);
const editors=elements.filter(e=>e.tagName==='textarea'), panels=elements.filter(e=>e.attributes.role==='tabpanel'), tabs=elements.filter(e=>e.attributes.role==='tab');
assert.equal(generations,0);assert.ok(card.textContent.includes('AI 없이 만든 기본 글'));
assert.ok(editors.every(e=>e.value.includes(data.order_url)));
assert.equal(panels.filter(e=>!e.hidden).length,1);
tabs[0].onkeydown({key:'ArrowRight',preventDefault(){}});assert.equal(tabs[1].attributes['aria-selected'],'true');assert.equal(tabs[1].focused,true);
editors[0].value='커피 2500원';editors[0].oninput();assert.ok(card.textContent.includes('메뉴 가격'));
await panels[0].children.find(e=>e.tagName==='button').onclick();assert.equal(clip.at(-1),core.combinePromo('커피 2500원',panels[0].children.find(e=>e.tagName==='label').children[0].value));
await btn('태그만 복사').onclick(); assert.ok(clip.at(-1).startsWith('#'));
keyed=true;await btn('다시 쓰기').onclick();
// Button callback starts asynchronous generation; flush completion through the next task.
await new Promise(r=>setImmediate(r));
assert.equal(generations,1);assert.ok(card.textContent.includes('AI로 만든 초안'));
assert.ok(card.textContent.includes('메뉴 가격'));
assert.equal((editors[1].value.match(/#[^\s#]+/g)||[]).length,0);
aiFail=true;btn('다시 쓰기').onclick();await new Promise(r=>setImmediate(r));
assert.ok(card.textContent.includes('AI 없이 만든 기본 글'));assert.ok(card.textContent.includes('AI 초안을 받지 못해'));
await btn('공유 이미지 만들기').onclick();
assert.equal(canvases.at(-1).width,1080);assert.equal(canvases.at(-1).height,1080);
assert.equal(qrs.at(-1),data.order_url);assert.equal(btn('PNG 저장').disabled,false);
assert.ok(paints.some(p=>p[0]==='text'&&p[1]===data.name_ko));
assert.equal(paints.filter(p=>p[0]==='image').length,2,'Ravi SVG and QR both drawn');
await btn('PNG 저장').onclick();assert.equal(saves,1);assert.ok(card.textContent.includes('PNG를 저장했습니다'));
elements.find(e=>e.tagName==='input').oninput();assert.equal(btn('PNG 저장').disabled,true,'edited tagline invalidates stale image');
data={name_ko:'링크 없는 가게'};btn('다시 쓰기').onclick();await new Promise(r=>setImmediate(r));
assert.equal(btn('공유 이미지 만들기').disabled,true);assert.ok(card.textContent.includes('QR 주소가 없습니다'));
data={};btn('다시 쓰기').onclick();await new Promise(r=>setImmediate(r));
assert.ok(card.textContent.includes('메뉴를 먼저 등록하세요'));assert.ok(editors.every(e=>e.value.includes('메뉴를 먼저 등록하세요')),'no real menus never promotes samples');
assert.equal(btn('공유 이미지 만들기').disabled,true);assert.ok(loads>=5);
console.log('PASS production card: no-key template, edit/copy/tabs, AI fixture/fallback, menu price warnings, 1080 canvas/Ravi/QR, manual save, stale image invalidation, missing shop/link');

keyed=false;
btn('레이븐볼트 앱').onclick(); await new Promise(r=>setImmediate(r));
assert.equal(btn('공유 이미지 만들기').disabled,false);
assert.ok(editors[0].value.includes('RavenVault'));
assert.equal(elements.find(e=>e.tagName==='input').value,'레이븐코인으로 장사하는 지갑');
await btn('공유 이미지 만들기').onclick();
assert.equal(qrs.at(-1),'https://ravenvault.ex.erci.se');
assert.ok(paints.some(p=>p[0]==='text'&&p[1]==='RavenVault'));
editors[0].value='개발비 2%'; editors[0].oninput(); assert.ok(card.textContent.includes('앱 사실표 밖 숫자'));
elements.find(e=>e.tagName==='select').value='ja'; elements.find(e=>e.tagName==='select').onchange(); await new Promise(r=>setImmediate(r));
await btn('공유 이미지 만들기').onclick();assert.equal(qrs.at(-1),'https://ravenvault.ex.erci.se/ja/');
btn('직접 주제').onclick(); await new Promise(r=>setImmediate(r));
assert.ok(editors[0].value.includes('오늘 특가 알려 줘'));
console.log('PASS target switching/regeneration, sample-only guidance, app without a shop, app title/tagline, app QR languages, separate tags/combined copy/tag copy and app numeric warning');

btn('레이븐볼트 앱').onclick(); await new Promise(r=>setImmediate(r));
keyed=true; aiFail=false; btn('다시 쓰기').onclick(); await new Promise(r=>setImmediate(r));
assert.deepEqual(requests.at(-1),{language:'ja',request:'오늘 특가 알려 줘',target:'app'},'changing target preserves original request exactly');
assert.ok(card.textContent.includes('AI 초안을 받지 못해'),'unsupported app numbers reject the fake draft and use fact template');
assert.ok(editors[0].value.includes('RavenVault') && !editors[0].value.includes('2500'));
console.log('PASS original request/selected target RPC and rejection of invented app numbers');
