#!/usr/bin/env node
// No argv/environment dumps. ps comm excludes potentially sensitive process arguments.
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function parsePs(text){return text.trim().split('\n').map(line=>{
  const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  return match?{pid:+match[1],ppid:+match[2],rss:+match[3],name:match[4]}:null;
}).filter(Boolean);}
export function sumTree(rows,root,extra=[]){
  const ids=new Set([root,...extra]);let change=true;
  while(change){change=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);change=true;}}
  const processes=rows.filter(row=>ids.has(row.pid));
  const services=new Set(processes.filter(p=>/(?:^|\/)(?:ravend|ipfs|xmrig|cloudflared|t-rex)(?:\.exe)?$/i.test(p.name)).map(p=>p.pid));
  let added=true;while(added){added=false;for(const p of processes)if(services.has(p.ppid)&&!services.has(p.pid)){services.add(p.pid);added=true;}}
  return {rssMiB:processes.filter(p=>!services.has(p.pid)).reduce((total,p)=>total+p.rss,0)/1024,serviceMiB:processes.filter(p=>services.has(p.pid)).reduce((total,p)=>total+p.rss,0)/1024,pids:processes.map(p=>p.pid),engines:processes.filter(p=>/WebKit|WebView|msedgewebview|webkit.*process/i.test(p.name)).length};
}
async function main(){
  const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
  if(args.includes('--help')||(!args.includes('--pid')&&!args.includes('--launch'))){
    console.log('사용법: node scripts/measure-companion.mjs --pid PID [--engine-pids 1,2] [--seconds 40]\n또는 --launch /절대경로/실행파일. 정상 앱이 실행되므로 모의 프로필에서만 실행하세요.\n측정 중 큰 화면을 닫고 라비만 남기세요. 출력은 PID와 RSS 합계뿐입니다.\nmacOS 재부모화된 WebKit은 --engine-pids로 지정해야 완전한 합계입니다. Windows는 WSL ps로 네이티브 앱 RSS를 측정할 수 없습니다.');return;
  }
  let pid=Number(arg('--pid','0'));const executable=arg('--launch','');
  if(executable){const child=spawn(executable,[],{stdio:'ignore',detached:true});pid=child.pid;child.on('error',()=>{console.error('앱 실행 실패');process.exitCode=1;});child.unref();}
  if(!Number.isInteger(pid)||pid<1)throw new Error('유효한 PID가 필요합니다.');
  const seconds=Math.min(600,Math.max(1,Number(arg('--seconds','40'))||40));
  const extra=arg('--engine-pids','').split(',').map(Number).filter(n=>Number.isInteger(n)&&n>0);
  console.log('목표: 대기 앱+웹엔진 RSS 70 MB (약 66.8 MiB) 이하, 큰 화면 종료 후 추가 감소. 노드 서비스는 별도로 기록하세요.');
  for(let n=0;n<seconds;n+=2){
    await new Promise(r=>setTimeout(r,2000));
    let rows;try{rows=parsePs(execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8'}));}catch{throw new Error('이 환경에서는 ps 측정이 허용되지 않습니다.');}
    const result=sumTree(rows,pid,extra);
    if(!result.pids.includes(pid))throw new Error('앱 프로세스를 찾지 못했습니다.');
    console.log(JSON.stringify({seconds:n+2,...result,coverage:result.engines?'선택한 트리+지정 웹엔진 (공유·재부모화 누락 확인 필요)':'불완전: 웹엔진 PID 확인 필요',targetMB:70,targetMiB:70_000_000/1048576}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('측정을 완료하지 못했습니다. PID·권한·실행 경로를 확인하세요.');process.exitCode=1;});
