export function concatBytes(...parts: Uint8Array[]): Uint8Array {
 const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0;
 for(const p of parts){out.set(p,at);at+=p.length;} return out;
}
export function bytesToHex(bytes: Uint8Array): string { return Array.from(bytes, b=>b.toString(16).padStart(2,"0")).join(""); }
