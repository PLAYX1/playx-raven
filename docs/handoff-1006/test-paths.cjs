// Test harness only. Redirect generated artifacts; baseline fixture reads stay readable.
const fs = require('node:fs'), path = require('node:path');
const original = Object.fromEntries(['existsSync','readFileSync','writeFileSync','mkdirSync','mkdtempSync','rmSync','renameSync','copyFileSync','readdirSync','statSync'].map(k=>[k,fs[k]]));
const root=process.cwd(),out=path.join(root,'docs/handoff-1006');
const redirect=p=>{
 if(typeof p!=='string')return p;
 const full=path.resolve(p);
 if(full.startsWith(path.join(root,'artifacts')+path.sep))return path.join(out,'legacy-artifacts',path.relative(path.join(root,'artifacts'),full));
 if(full.startsWith(path.join(root,'src-tauri/installer/.render-')))return path.join(out,'tmp',path.basename(full));
 if(full.startsWith('/Users/gimmusong/rv-test-fixture'))return full.replace('/Users/gimmusong/rv-test-fixture',path.join(out,'fixtures'));
 return p;
};
for(const k of ['writeFileSync','mkdirSync','mkdtempSync','rmSync'])fs[k]=(p,...args)=>original[k](redirect(p),...args);
for(const k of ['readFileSync','existsSync','readdirSync','statSync'])fs[k]=(p,...args)=>{const next=redirect(p);return original[k](next!==p&&original.existsSync(next)?next:p,...args);};
for(const k of ['renameSync','copyFileSync'])fs[k]=(a,b,...args)=>original[k](redirect(a),redirect(b),...args);
require('node:module').syncBuiltinESMExports();
