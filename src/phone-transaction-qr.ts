/** Phone mesh QR transport. One transaction at a time, <=255 parts, <=200100 decoded bytes. */
const BAD='거래 코드의 형식·버전·길이를 확인하세요. 폰에서 서명한 거래 코드를 다시 복사하세요.';
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export async function transactionCode(input:string):Promise<string> {
  try { return await assemble(input); }
  catch(error) {
    if(error instanceof Error && error.message==='거래 조각이 부족합니다. 모든 조각을 한 줄에 하나씩 붙여넣으세요.')throw error;
    throw Error(BAD);
  }
}
async function assemble(input:string):Promise<string> {
  if(input.length>600000)throw Error(BAD);
  const lines=input.trim().split(/\s+/);
  if(lines.length===1 && lines[0].startsWith('ravenvault:'))return lines[0];
  if(!lines.length || lines.length>255)throw Error(BAD);
  const parts=new Map<number,Uint8Array>();let fid='',total=0,size=0;
  for(const line of lines) {
    const u=new URL(line), p=u.searchParams;
    if(line.length>200000 || u.protocol!=='playx:' || u.hostname!=='mesh' || u.pathname || u.username || u.password || u.port || u.hash || p.get('v')!=='1')throw Error(BAD);
    for(const key of p.keys())if(!['v','d','fid','i','t'].includes(key)||p.getAll(key).length!==1)throw Error(BAD);
    const encoded=p.get('d')??'';
    if(!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error(BAD);
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    if(!p.has('fid')&&!p.has('i')&&!p.has('t')) {
      if(lines.length!==1||bytes.length>200100)throw Error(BAD);
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }
    const id=p.get('fid')??'',i=Number(p.get('i')),n=Number(p.get('t'));
    if(!p.has('i')||!p.has('t')||!Number.isInteger(i)||!Number.isInteger(n)||n<1||n>255||i<0||i>=n||!/^[a-f\d]{16}$/i.test(id)||bytes.length<10||hex(bytes.slice(0,8))!==id.toLowerCase()||bytes[8]!==i||bytes[9]!==n)throw Error(BAD);
    if(fid && (fid!==id.toLowerCase()||total!==n))throw Error(BAD);
    fid=id.toLowerCase();total=n;
    const data=bytes.slice(10),prior=parts.get(i);
    if(prior) {if(hex(prior)!==hex(data))throw Error(BAD);continue;}
    size+=data.length;if(size>200100)throw Error(BAD);parts.set(i,data);
  }
  if(parts.size!==total)throw Error('거래 조각이 부족합니다. 모든 조각을 한 줄에 하나씩 붙여넣으세요.');
  const joined=new Uint8Array(size);let offset=0;
  for(let i=0;i<total;i++){const part=parts.get(i)!;joined.set(part,offset);offset+=part.length;}
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));
  if(hex(digest.slice(0,8))!==fid)throw Error(BAD);
  return new TextDecoder('utf-8',{fatal:true}).decode(joined);
}
