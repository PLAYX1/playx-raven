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
function clamp(value, height, limit) {
  const match = /^clamp\((\d+)px,(\d+)vh,(\d+)px\)$/.exec(value);
  assert.ok(match, `Unmodelled clamp: ${value}`);
  return limit === 'min' ? +match[1] : limit === 'max' ? +match[3] : Math.max(+match[1], Math.min(+match[3], height * +match[2] / 100));
}
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
  const legacy = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  assert.equal(grid['grid-template-columns'],'repeat(2,minmax(0,1fr))','Equal column widths');
  assert.equal(grid['grid-template-rows'],'var(--home-row-top) var(--home-row-middle) var(--home-row-bottom)');
  assert.equal(card.width,'100%'); assert.equal(card['box-sizing'],'border-box');
  assert.equal(card['align-self'],'stretch'); assert.equal(card.padding,'var(--home-pad)');
  assert.equal(declarations(source,'#page-home .rv-home-grid',true)['grid-template-columns'],'minmax(0,1fr)');
  assert.match(source,/@media\(max-width:1050px\)/);
  assert.ok(px(button['min-height'])>=44); assert.ok(px(button['font-size'])>=15);
  assert.equal(root.padding,'0'); assert.equal(root.overflow,undefined); assert.equal(card.overflow,undefined);
  const gap=px(root['--home-gap']), pad=px(root['--home-pad']);
  const title=declarations(source,'#page-home > h1');
  const pagePad=declarations(source,'main:has(> #page-home.on)').padding.split(' ').map(px);
  const chrome=px(declarations(legacy,'body')['padding-top']);
  const nav=px(declarations(legacy,'body > nav').width);
  const banner=declarations(source,'#page-home > .seed-recovery');
  const fixed=chrome + 2*pagePad[0] + px(title['line-height']) + px(title.margin.split(' ')[2]) + px(banner['min-height']) + px(banner.margin.split(' ')[0]);
  const checks=[];
  for (const [width,height] of [[1120,780],[1440,900],[1920,1080]]) {
    const rows=[clamp(root['--home-row-top'],height),clamp(root['--home-row-middle'],height),px(root['--home-row-bottom'])];
    const minRows=[clamp(root['--home-row-top'],height,'min'),clamp(root['--home-row-middle'],height,'min'),rows[2]];
    const maxRows=[clamp(root['--home-row-top'],height,'max'),clamp(root['--home-row-middle'],height,'max'),rows[2]];
    const total=fixed+rows.reduce((a,b)=>a+b,0)+2*gap;
    assert.ok(total<=height,`${width}×${height}: ${total}px > ${height}px`);
    // Content minima: 24px title + 40px balance + 6px gap + 44px actions;
    // 44px heading + 6px gap + 3 × 48px activity rows. Borders included.
    assert.ok(rows[0]>=2*pad+2+24+40+6+44,'Balance fits its row');
    assert.ok(rows[1]>=2*pad+2+24+24+44+12,'Ravi fits its row');
    assert.ok(rows[2]>=2*pad+2+44+6+3*48,'All three activity rows fit');
    const cardWidth=(width-nav-2*pagePad[1]-gap)/2;
    assert.ok(cardWidth>=450,'Minimum supported card width');
    checks.push({width,height,rows,minRows,maxRows,cardWidths:[cardWidth,cardWidth],includingLockedBanner:total,spare:height-total});
  }
  const pairs=[['--home-ink','--home-paper'],['--home-muted','--home-paper'],['--home-good','--home-paper'],['--home-warn','--home-paper'],['--home-bad','--home-paper']];
  const contrasts=pairs.map(([fg,bg])=>({foreground:root[fg],background:root[bg],ratio:contrast(root[fg],root[bg])}));
  for(const foreground of [root['--home-ink'],root['--home-muted'],root['--home-good'],root['--home-warn'],root['--home-bad']]) contrasts.push({foreground,background:'#f3f5fa',ratio:contrast(foreground,'#f3f5fa')});
  contrasts.push({foreground:'#ffffff',background:'#1f224e',ratio:contrast('#ffffff','#1f224e')},{foreground:'#1f224e',background:'#fff5e3',ratio:contrast('#1f224e','#fff5e3')});
  for(const pair of contrasts)assert.ok(pair.ratio>=4.5,`Contrast below 4.5: ${JSON.stringify(pair)}`);
  return {checks,contrasts};
}
const layout=checkLayout(css);
// Sensitivity checks: the fallback must fail if budgets, widths or colors regress.
assert.throws(()=>checkLayout(css.replace('--home-row-bottom:220px','--home-row-bottom:320px')));
assert.throws(()=>checkLayout(css.replace('repeat(2,minmax(0,1fr))','minmax(0,2fr) minmax(0,1fr)')));
assert.throws(()=>checkLayout(css.replace('--home-muted:#59637d','--home-muted:#cccccc')));
const homeHTML=html.slice(html.indexOf('<section class="page on" id="page-home">'),html.indexOf('<section class="page" id="page-ravi">'));
const order=['rv-home-balance','rv-home-safety','ravi-home-slot','rv-home-today','rv-home-activity','rv-home-chats'].map(id=>homeHTML.indexOf(id));
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
const context=vm.createContext({$:el,document:{getElementById:el,querySelector:()=>null},homeTodaySeq:0,lastReceivedHomeTx:null,lang:'ko',안본주문:2,
  t:s=>s,copyHtml:escape,escapeHtml:escape,refreshOverview(){},paintHomeSafety(){},todayYmd:()=>'',tzMin:()=>0,
  invoke:async command=>{
    if(command==='shop_load'){if(fail)throw Error('fixture');return shop;}
    if(command==='ledger_range')return {total:12000,currency:'KRW',sales:4};
    if(command==='ledger_pending')return {count:2};
    if(command==='recent_transactions')return Array.from({length:7},(_,i)=>({time:100+i,amount:10,category:'receive',confirmations:6,asset_name:'<fixture>'}));
    if(command==='talk_rooms')return Array.from({length:5},()=>({name:'<fixture>',about:'summary'}));
    throw Error(`Forbidden or unmodelled command: ${command}`);
  }});
vm.runInContext(compile(fn('paintHomeToday')+'\n'+fn('paintHome')),context);
await context.paintHome(); await context.paintHomeToday();
assert.equal((el('rv-home-txs').innerHTML.match(/class="rv-home-entry"/g)||[]).length,3);
assert.equal((el('rv-home-rooms').innerHTML.match(/class="rv-home-entry"/g)||[]).length,2);
assert.ok(el('rv-home-txs').innerHTML.includes('&lt;fixture&gt;'));
assert.equal((el('rv-home-today-body').innerHTML.match(/class="rv-home-entry"/g)||[]).length,4);
shop=null;await context.paintHomeToday();assert.ok(el('rv-home-today-body').innerHTML.includes('아직 가게'));
fail=true;await context.paintHomeToday();assert.ok(el('rv-home-today-body').innerHTML.includes('확인하지 못했습니다'));assert.equal(el('rv-home-today').hidden,false);
writeFileSync(`${out}/arithmetic.json`,JSON.stringify({kind:'CSS arithmetic; not browser measurement',...layout,renderFixtures:'passed',mutationSensitivity:'passed',unverified:['Actual font shaping/wrapping','Browser cascade, screenshots, focus traversal','Tauri WebView, display scaling, translated copy']},null,2)+'\n');
console.log('PASS home arithmetic: 3 viewports, equal widths, row content minima, banner budget, 4.5:1 contrast, mutation sensitivity; production summary/safety fixtures. Browser geometry NOT verified.');
