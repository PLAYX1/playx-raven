import {test} from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=ts.createSourceFile('main.ts',readFileSync('src/main.ts','utf8'),ts.ScriptTarget.Latest,true);
const body=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='gateSend').getText(source);
test('F01 gate cannot re-enable a button during in-flight send',()=>{
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{style:{display:'none'},value:'',disabled:true});return elements.get(id);};
 const ctx=vm.createContext({$,sendingNow:true,sendPreview:{address:'synthetic',amount:1,enough:true},fmtQty:String,tf:s=>s,setAllRaviMood:()=>{}});
 vm.runInContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);ctx.gateSend();assert.equal($('s-go').disabled,true);
});
