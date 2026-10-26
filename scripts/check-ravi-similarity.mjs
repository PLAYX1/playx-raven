// Fit thresholds using only out-of-fold example retrieval. No exam inputs enter calibration.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
const code=await build({entryPoints:['src/ravi-similarity.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const ctx={module:{exports:{}},exports:{}};vm.runInNewContext(code.outputFiles[0].text,ctx);
const {createRaviSimilarity,decideRaviSimilarity,similarityText}=ctx.module.exports;
const table=JSON.parse(readFileSync('src/ravi-intent-examples.json'));
const exam=JSON.parse(readFileSync('scripts/fixtures/ravi-understanding-120.json'));
const canonical=q=>q.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const training=new Set(table.flatMap(g=>g.examples.map(canonical)));
for(const c of exam)assert.ok(!training.has(canonical(c.utterance)),`exam overlap ${c.id}`);
const stems=new Set(table.flatMap(g=>g.examples.map(similarityText)));
for(const c of exam)assert.ok(!stems.has(similarityText(c.utterance)),`stem-normalized overlap ${c.id}`);
for(const g of table)assert.ok(g.examples.length>=15,g.intent);
assert.equal(training.size,table.reduce((n,g)=>n+g.examples.length,0),'unique training text');
const rows=[];
// Stable stratification, each intent contributes to all five folds. DF/IDF and
// exemplar vectors are rebuilt on four folds; held-out vectors are never fitted.
for(let fold=0;fold<5;fold++) {
 const fit=table.map(g=>({intent:g.intent,examples:g.examples.filter((_,i)=>i%5!==fold)}));
 const rank=createRaviSimilarity(fit);
 for(const g of table)for(const [i,q] of g.examples.entries())if(i%5===fold)rows.push({fold,intent:g.intent,q,ranked:rank(q)});
}
function evaluate(limits) {
 let direct=0,correct=0,wrong=0,candidates=0,candidateCorrect=0,refused=0,refusalCorrect=0;
 for(const row of rows) {
  const d=decideRaviSimilarity(row.ranked,limits);
  if(d.kind==='direct'){direct++;if(d.ids[0]===row.intent)correct++;else wrong++;}
  else if(d.kind==='clarify'){candidates++;if(d.ids.includes(row.intent))candidateCorrect++;}
  else {refused++;if(row.intent==='miss')refusalCorrect++;}
 }
 return {total:rows.length,direct,correct,wrong,candidates,candidateCorrect,refused,refusalCorrect,
  rawTop1Accuracy:rows.filter(r=>r.ranked[0].intent===r.intent).length/rows.length,
  directAccuracy:direct?correct/direct:1,wrongMatchRate:direct?wrong/direct:0,
  passRate:(correct+candidateCorrect+refusalCorrect)/rows.length};
}
let chosen;
for(let h=50;h<=95;h+=1)for(let m=4;m<=30;m+=2)for(let l=15;l<=40;l+=5) {
 const limits={high:h/100,low:l/100,margin:m/100},metrics=evaluate(limits);
 if(metrics.wrongMatchRate>0.02)continue;
 // Maximize correct direct decisions and correct candidate coverage; prefer
 // fewer mistakes and higher refusal threshold when coverage is tied.
 const utility=metrics.correct+metrics.candidateCorrect+metrics.refusalCorrect-5*metrics.wrong;
 if(!chosen || utility>chosen.utility || utility===chosen.utility && (metrics.wrong<chosen.metrics.wrong || metrics.wrong===chosen.metrics.wrong && metrics.correct>chosen.metrics.correct))chosen={limits,metrics,utility};
}
assert.ok(chosen,'calibration feasible');
if(process.argv.includes('--calibrate'))writeFileSync('src/ravi-similarity-thresholds.json',JSON.stringify(chosen.limits,null,2)+'\n');
const limits=JSON.parse(readFileSync('src/ravi-similarity-thresholds.json'));
const metrics=evaluate(limits);
assert.ok(metrics.wrongMatchRate<=0.02);
const compiledIntents=await build({entryPoints:['src/ravi-intents.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const intentCtx={module:{exports:{}},exports:{}};vm.runInNewContext(compiledIntents.outputFiles[0].text,intentCtx);
const pipeline=rows.map(r=>({expected:r.intent,decision:intentCtx.module.exports.raviResolve(r.q,()=>decideRaviSimilarity(r.ranked,limits))}));
const production={total:rows.length,direct:pipeline.filter(r=>r.decision.kind==='direct').length,
 correct:pipeline.filter(r=>r.decision.kind==='direct' && r.decision.ids[0]===r.expected).length,
 wrong:pipeline.filter(r=>r.decision.kind==='direct' && r.decision.ids[0]!==r.expected).length,
 candidates:pipeline.filter(r=>r.decision.kind==='clarify').length,
 candidateCorrect:pipeline.filter(r=>r.decision.kind==='clarify' && r.decision.ids.includes(r.expected)).length,
 refusalCorrect:pipeline.filter(r=>r.decision.kind==='miss' && r.expected==='miss').length};
production.passRate=(production.correct+production.candidateCorrect+production.refusalCorrect)/production.total;
production.wrongMatchRate=production.wrong/production.direct;
if(process.argv.includes('--inspect'))for(const [i,r] of pipeline.entries())if(r.decision.kind==='direct'&&r.decision.ids[0]!==r.expected)console.log(rows[i].q,r.expected,r.decision.ids[0],r.decision.ranked.slice(0,2));
assert.ok(production.wrongMatchRate<=0.02,'whole pipeline false-match bound');
const historic={name:'baseline-guide',setup(b){b.onLoad({filter:/ravi-(?:guide\.ts|intents\.ts|capabilities\.json)$/},args=>({contents:execFileSync('git',['show','a4d5fd5:'+relative(process.cwd(),args.path)],{encoding:'utf8'}),loader:args.path.endsWith('.json')?'json':'ts'}));}};
const measure=async plugins=>Buffer.byteLength((await build({entryPoints:['src/ravi-guide.ts'],bundle:true,minify:true,charset:'utf8',platform:'browser',format:'esm',write:false,plugins})).outputFiles[0].text);
const baselineBytes=await measure([historic]),currentBytes=await measure([]);
const bundleBudget={baseline:'a4d5fd5',baselineBytes,currentBytes,addedBytes:currentBytes-baselineBytes,limitBytes:30000};
assert.ok(bundleBudget.addedBytes<=bundleBudget.limitBytes,'production bundle grows by at most 30KB');
const report={bundleBudget,production,method:'stratified 5-fold; example-only calibration; held-out IDF; cosine of character and NFD jamo 2/3-grams plus Latin-token anchors',examples:rows.length,intents:table.length,limits,metrics,
 folds:[0,1,2,3,4].map(fold=>({fold,total:rows.filter(r=>r.fold===fold).length})),recommended:chosen.limits};
mkdirSync('artifacts/ravi-understand3',{recursive:true});writeFileSync('artifacts/ravi-understand3/cross-validation.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
