import {execFileSync} from 'node:child_process';import {mkdirSync,writeFileSync,symlinkSync,existsSync,copyFileSync,readdirSync}from'node:fs';import{resolve}from'node:path';import{build}from'esbuild';
const dir=resolve('artifacts/claude-desktop-identity-fix/baseline-app');mkdirSync(dir+'/src',{recursive:true});
const names=execFileSync('git',['ls-tree','-r','--name-only','daa80d6','src'],{encoding:'utf8'}).trim().split('\n').filter(n=>/\.(ts|json)$/.test(n));
for(const n of names){mkdirSync(resolve(dir,n,'..'),{recursive:true});writeFileSync(resolve(dir,n),execFileSync('git',['show',`daa80d6:${n}`]));}
if(!existsSync(dir+'/node_modules'))symlinkSync(resolve('node_modules'),dir+'/node_modules');
let html=execFileSync('git',['show','daa80d6:index.html'],{encoding:'utf8'}).replace('/src/main.ts','/baseline.js');writeFileSync(dir+'/index.html',html);
await build({entryPoints:[dir+'/src/main.ts'],outfile:dir+'/baseline.js',bundle:true,format:'esm',platform:'browser'});
for(const n of readdirSync('dist'))if(/\.(webp|svg|png)$/.test(n))copyFileSync('dist/'+n,dir+'/'+n);
