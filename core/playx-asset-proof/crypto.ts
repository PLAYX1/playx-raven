export function concatBytes(...parts: Uint8Array[]): Uint8Array {
 const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0;
 for(const p of parts){out.set(p,at);at+=p.length;} return out;
}
export function bytesToHex(bytes: Uint8Array): string { return Array.from(bytes, b=>b.toString(16).padStart(2,"0")).join(""); }
// 아래 둘은 지갑 core/playx-asset-proof/crypto.ts 와 같은 본문(기기 증서·영수증 core 가 쓴다).
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('hex 형식 오류');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
