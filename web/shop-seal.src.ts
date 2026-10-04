import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const message = {
  ko: '안전한 연결이 필요합니다. 폰의 RavenVault 앱에서 새 연결 QR을 찍거나 HTTPS로 열어 주세요. 복구 단어와 지갑 암호를 HTTP 화면에 넣지 마세요.',
  en: 'Use the RavenVault phone app to scan a new connection QR, or open this screen over HTTPS. Never enter recovery words or wallet passwords on an HTTP page.',
  ja: 'RavenVault のスマホアプリで新しい接続 QR を読み取るか、HTTPS で開いてください。HTTP 画面に復元単語やウォレットのパスワードを入力しないでください。',
  zh: '请用 RavenVault 手机应用扫描新的连接二维码，或通过 HTTPS 打开。请勿在 HTTP 页面输入恢复词或钱包密码。',
};
function sizeGuidance() {
  const text={ko:'서명된 이벤트는 32 KB까지 올릴 수 있습니다. 내용을 줄여 다시 올려 주세요.',en:'Signed events may be at most 32 KB. Shorten the content and publish again.',ja:'署名済みイベントは 32 KB までです。内容を短くして再投稿してください。',zh:'签名事件最大为 32 KB。请缩短内容后重新发布。'};
  return text[(document.documentElement.lang || navigator.language).slice(0,2) as keyof typeof text] || text.en;
}
function guidance() { return message[(document.documentElement.lang || navigator.language).slice(0, 2) as keyof typeof message] || message.en; }
export function connection() {
  if (!window.isSecureContext) throw new Error(guidance());
  const query = new URLSearchParams(location.search);
  if (query.has('t')) throw new Error(guidance());
  const fragment = new URLSearchParams(location.hash.slice(1));
  const key = 'rv-seal:' + location.pathname;
  let saved: { token: string; desk: string } | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(key) || (location.pathname === '/wallet' ? sessionStorage.getItem('rv-seal:/admin') : null) || 'null'); } catch {}
  const token = fragment.get('t') || saved?.token || '';
  const desk = fragment.get('k') || saved?.desk || '';
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(desk)) throw new Error(guidance());
  if (fragment.has('t')) {
    sessionStorage.setItem(key, JSON.stringify({ token, desk }));
    history.replaceState(null, '', location.pathname);
  }
  return { token, desk };
}
export async function sealedFetch(path: string, options: RequestInit = {}, credentials = connection(), send: typeof fetch = nativeFetch): Promise<Response> {
  if (!window.isSecureContext) throw new Error(guidance());
  if (!path.startsWith('/api/') || path.includes('#') || /[?&]t=/.test(path)) throw new Error(guidance());
  const method = options.method || 'GET';
  if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported sealed method');
  const body = method === 'GET' ? null : JSON.parse(String(options.body || '{}'));
  const plain = utf8ToBytes(JSON.stringify({ v: 1, m: method, path, ts: Math.floor(Date.now() / 1000), nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), body }));
  if (plain.length > 65536) throw new Error('Request too large');
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const eph = x25519.getPublicKey(secret), desk = hexToBytes(credentials.desk);
  const shared = x25519.getSharedSecret(secret, desk);
  if (shared.every(b => b === 0)) throw new Error(guidance());
  const key = hkdf(sha256, shared, sha256(utf8ToBytes(credentials.token)), utf8ToBytes('rv-shop-seal-v1'), 32);
  secret.fill(0); shared.fill(0);
  const n = crypto.getRandomValues(new Uint8Array(24));
  try {
    const ct = xchacha20poly1305(key, n, concatBytes(utf8ToBytes('rv-shop-seal-v1/req'), eph, desk)).encrypt(plain);
    const response = await send('/api/scan/sealed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, eph: bytesToHex(eph), n: bytesToHex(n), ct: bytesToHex(ct) }), cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    const envelope = await response.json();
    if (envelope.v !== 1 || typeof envelope.n !== 'string' || !/^[a-f0-9]{48}$/.test(envelope.n) || typeof envelope.ct !== 'string' || envelope.ct.length > 2_000_100) throw new Error(guidance());
    const text = xchacha20poly1305(key, hexToBytes(envelope.n), concatBytes(utf8ToBytes('rv-shop-seal-v1/res'), eph, n)).decrypt(hexToBytes(envelope.ct));
    const opened = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text));
    text.fill(0);
    if (opened.v !== 1 || !Number.isInteger(opened.status) || opened.status < 100 || opened.status > 599) throw new Error(guidance());
    return new Response(JSON.stringify(opened.body ?? { error: guidance() }), { status: opened.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } finally { key.fill(0); plain.fill(0); }
}
function localWalletContext() {
  return window.isSecureContext && ['/wallet','/legacy-wallet'].includes(location.pathname)
    && location.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname)
    && location.host === location.hostname + ':8790' && !new URLSearchParams(location.search).has('t');
}
const nativeFetch = window.fetch.bind(window);
// Legacy screen code supplies an auth header only to this in-process adapter;
// no bearer header can leave the browser, and no plaintext fallback exists.
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (String(input) === '/api/nostr/publish' && !headers.has('x-playx-token') && localWalletContext()) {
    if (init?.method !== 'POST' || headers.get('content-type') !== 'application/json'
        || typeof init.body !== 'string' || new TextEncoder().encode(init.body).length > 32768) return Promise.reject(new Error(sizeGuidance()));
    return nativeFetch('/api/nostr/publish', { method:'POST', headers:{'content-type':'application/json'}, body:init.body, cache:'no-store', redirect:'error', referrerPolicy:'no-referrer', credentials:'same-origin' });
  }
  if (headers.has('x-playx-token') || ['/api/nostr/publish', '/api/keepphoto'].includes(String(input))) return sealedFetch(String(input), init);
  return nativeFetch(input, init);
}) as typeof fetch;
try { if (!localWalletContext()) connection(); } catch (e) {
  const note = document.createElement('p');
  note.textContent = String((e as Error).message);
  note.setAttribute('role', 'alert');
  note.style.cssText = 'font-size:16px;line-height:1.6;padding:16px;';
  document.body.prepend(note);
}
(window as any).RVShopSeal = { connection, sealedFetch };
