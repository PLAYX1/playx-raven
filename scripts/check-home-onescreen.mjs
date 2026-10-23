// CSS arithmetic + production render-function fixtures. This is NOT browser geometry.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import postcss from 'postcss';
const css = readFileSync('src/ravi-home.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
const main = readFileSync('src/main.ts', 'utf8');
const out = 'artifacts/home-onescreen'; mkdirSync(out, { recursive:true });
function declarations(source, selector, media = false) {
  const result = {};
  postcss.parse(source).walkRules(rule => {
    if (!rule.selectors.includes(selector) || (rule.parent.type === 'atrule') !== media) return;
    rule.walkDecls(d => { result[d.prop] = d.value; });
  });
  return result;
}
const px = value => { assert.match(value, /^\d+(?:\.\d+)?px$/); return parseFloat(value); };
function luminance(hex) {
  assert.match(hex,/^#[a-f\d]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4);
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
const contrast = (a,b) => { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
function checkLayout(source) {
  const root = declarations(source, '#page-home');
  const grid = declarations(source, '#page-home .rv-home-grid');
  const card = declarations(source, '#page-home .rv-home-grid > div');
  const button = declarations(source, '#page-home button');
  assert.equal(grid['grid-template-columns'],'repeat(2,minmax(0,1fr))');
  // 0.9.4 홈 단순화: 큰 잔액이 윗줄 전체, 받기·보내기와 대화가 한 줄, 안전 띠는 필요할 때만, 행 높이는 내용이 정한다.
  assert.equal(grid['grid-template-areas'],'"bal bal" "conversation act" "safe safe" "today extras"');
  assert.equal(grid['grid-template-rows'],'none');
  assert.equal(card.width,'100%'); assert.equal(card['box-sizing'],'border-box');
  assert.equal(card['align-self'],'stretch'); assert.equal(card.padding,'var(--home-pad)');
  assert.equal(declarations(source,'#page-home .rv-home-grid',true)['grid-template-columns'],'minmax(0,1fr)');
  assert.match(source,/@media\(max-width:760px\)/);
  assert.ok(px(button['min-height'])>=36); assert.ok(px(button['font-size'])>=15);
  assert.equal(root.padding,'0'); assert.equal(root.overflow,undefined); assert.equal(card.overflow,undefined);
  const compact=declarations(source,'#page-home',true);
  const checks=[];
  for (const [width,height] of [[1024,640],[1280,720],[1440,900],[1728,1117]]) {
    const small=width<=1100||height<=680;
    const vars=small?{...root,...compact}:root;
    const pad=px(vars['--home-pad']),gap=px(vars['--home-gap']);
    const rows=['--home-row-top','--home-row-middle','--home-row-bottom'].map(k=>px(vars[k]));
    const pagePadding=declarations(source,'main:has(> #page-home.on)',small).padding.split(' ').map(px);
    const total=110+pagePadding[0]*2+28+8+rows.reduce((a,b)=>a+b,0)+2*gap;
    assert.ok(total<=height,`${width}×${height}: estimated ${total}px > ${height}px`);
    assert.ok(rows[0]>=2*pad+2+24+40+6+44,'Balance content budget');
    assert.ok(rows[1]>=2*pad+2+36+6+3*46,'Three transaction row budget');
    assert.ok(rows[2]>=2*pad+2+36+6+42,'Sales summary budget');
    if(!small)assert.ok(total+64<=height,'Recovery banner remains reachable');
    checks.push({width,height,rows,estimatedHeight:total,estimatedSpare:height-total,disclosure:small?'collapsed':'expanded'});
  }
  const dark=declarations(source,':root[data-theme="dark"] #page-home');
  const contrasts=[];
  for(const [theme,vars] of [['light',root],['dark',{...root,...dark}]]){
    for(const fg of ['--home-ink','--home-muted','--home-good','--home-warn','--home-bad'])for(const bg of ['--home-paper','--home-tint'])
      contrasts.push({theme,foreground:vars[fg],background:vars[bg],ratio:contrast(vars[fg],vars[bg])});
    contrasts.push({theme,foreground:vars['--home-on-action'],background:vars['--home-action'],ratio:contrast(vars['--home-on-action'],vars['--home-action'])});
  }
  for(const pair of contrasts)assert.ok(pair.ratio>=4.5,`Contrast below 4.5: ${JSON.stringify(pair)}`);
  return {checks,contrasts};
}
const layout=checkLayout(css);
assert.throws(()=>checkLayout(css.replace('--home-row-bottom:112px','--home-row-bottom:320px')));
assert.throws(()=>checkLayout(css.replace('repeat(2,minmax(0,1fr))','minmax(0,2fr) minmax(0,1fr)')));
assert.throws(()=>checkLayout(css.replace('--home-muted:#59637d','--home-muted:#cccccc')));
// 홈 섹션만 — 다음 `<section class="page"` 앞까지(0.8.8 병합: 예전 끝 표시 page-ravi 사이에 만들기·판매 화면이 끼어 cw-drop 의 tabindex 를 홈 것으로 잘못 읽었다).
const homeStart=html.indexOf('<section class="page on" id="page-home">');
const homeHTML=html.slice(homeStart,html.indexOf('<section class="page"',homeStart+10));
const order=['rv-home-balance','rv-home-safety','rv-home-activity','ravi-home-slot','rv-home-today','rv-home-extras'].map(id=>homeHTML.indexOf(id));
assert.ok(order.every((x,i)=>x>=0 && (!i||x>order[i-1])),'DOM reading and keyboard order follows the grid');
assert.ok(!homeHTML.includes('tabindex='),'No artificial tab order');
assert.ok(main.includes('$("rv-home-activity-all").onclick = () => { showPage("wallet"); jumpToEl("w-txs"); };'));
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const mod={exports:{}}; vm.runInNewContext(compile(readFileSync('src/home-summary.ts','utf8')),{exports:mod.exports});
const {homeSafety}=mod.exports;
assert.equal(homeSafety(null,null).lock.tone,'warn');
assert.equal(homeSafety({},{}).lock.tone,'warn');
assert.equal(homeSafety({encrypted:true},{}).lock.tone,'warn');
assert.equal(homeSafety({encrypted:false},{}).lock.tone,'bad');
assert.equal(homeSafety({encrypted:true,unlocked:true},{}).lock.tone,'warn');
assert.equal(homeSafety({encrypted:true,unlocked:false},{}).lock.tone,'good');
assert.equal(homeSafety(null,{automatic:{local_complete:true}}).backup.label,'백업 로컬 확인');
assert.equal(homeSafety(null,{automatic:{local_complete:true,error:'fixture'}}).backup.tone,'bad');
assert.equal(homeSafety(null,{automatic:{local_complete:true}},'fixture').backup.tone,'bad');
assert.equal(homeSafety(null,{items:[{exists:true}]}).backup.tone,'warn');
// Run the production painters with only read-only synthetic RPCs.
const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false});return nodes.get(id);};
let shop={name:'fixture'}, fail=false;
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const context=vm.createContext({$:el,document:{getElementById:el,querySelector:()=>null},homeTodaySeq:0,homePendingOrders:[],lastReceivedHomeTx:null,chainInfo:{paintHome(){context.chainPainted=(context.chainPainted||0)+1;}},lang:'ko',안본주문:2,
  t:s=>s,tf:(s,...a)=>String(s).replace(/\{(\d)\}/g,(_,i)=>String(a[i])),fmtRvn:n=>String(n),copyHtml:escape,escapeHtml:escape,refreshOverview(){},paintHomeSafety(){},todayYmd:()=>'',tzMin:()=>0,
  invoke:async command=>{
    if(command==='shop_load'){if(fail)throw Error('fixture');return shop;}
    if(command==='ledger_range')return {total:12000,currency:'KRW',sales:4};
    if(command==='ledger_pending')return {count:2,orders:[{},{}]};
    if(command==='recent_transactions')return Array.from({length:7},(_,i)=>({time:100+i,amount:10,category:'receive',confirmations:6,asset_name:'<fixture>'}));
    if(command==='talk_rooms')return Array.from({length:5},()=>({name:'<fixture>',about:'summary'}));
    throw Error(`Forbidden or unmodelled command: ${command}`);
  }});
vm.runInContext(compile(fn('pendingRow')+'\n'+fn('paintHomeToday')+'\n'+fn('paintHome')),context);
await context.paintHome(); await context.paintHomeToday();
assert.equal(context.chainPainted,1,'0.8.8: 홈을 그리면 체인 요약 줄도 한 번 갱신한다');
assert.equal((el('rv-home-txs').innerHTML.match(/class="rv-home-entry"/g)||[]).length,3);
assert.ok(el('rv-home-txs').innerHTML.includes('&lt;fixture&gt;'));
assert.equal((el('rv-home-today-body').innerHTML.match(/class="rv-home-entry[ "]/g)||[]).length,4);
assert.ok(el('rv-home-today-body').innerHTML.includes('data-pend="list"'),'0.9.5: 입금 대기 줄은 목록 시트를 여는 단추');
shop=null;await context.paintHomeToday();assert.ok(el('rv-home-today-body').innerHTML.includes('아직 가게'));
fail=true;await context.paintHomeToday();assert.ok(el('rv-home-today-body').innerHTML.includes('확인하지 못했습니다'));assert.equal(el('rv-home-today').hidden,false);
writeFileSync(`${out}/arithmetic.json`,JSON.stringify({kind:'CSS arithmetic; not browser measurement',...layout,renderFixtures:'passed',mutationSensitivity:'passed',unverified:['Actual font shaping/wrapping','Browser cascade, screenshots, focus traversal','Tauri WebView, display scaling, translated copy']},null,2)+'\n');
console.log('PASS home arithmetic: 4 viewports (estimates only), 2 columns, row content minima, desktop banner budget, 4.5:1 contrast, mutation sensitivity; production summary/safety fixtures. Browser geometry NOT verified.');
