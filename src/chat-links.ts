/**
 * 대화 글 속 웹 주소(11-13 대표 「링크가 눌리지 않고, 미리보기도 없고, 긴 주소가 10자씩 끊긴다」 → 카톡·텔레그램처럼).
 *
 * - urlSegments: 글 → 글/주소 조각. http(s):// 주소와, 헷갈리지 않는 맨 도메인(example.com · www.foo.co.kr/path)만 주소로 본다.
 *   주소 글자는 ASCII 만 — 한글이 붙으면 거기서 끝난다(「https://x.com/a에서」 → 주소는 https://x.com/a).
 *   끝의 문장부호(. , ! ? ; : ' ")는 떼고, 닫는 괄호는 주소 안에 여는 괄호가 있을 때만 남긴다(위키 주소).
 * - shortUrl: 화면에 보일 짧은 모양(도메인 + 경로…). 누르기·복사는 언제나 원래 주소 전체.
 * - linkRisk: 여기는 지갑 대화라 피싱 표적이다. 위험해 보이면 열기 전에 「이 링크 조심하세요」 시트(진짜 도메인을 크게)를 띄운다.
 *   위험 = http(암호화 없음) · IP 주소 · 퓨니코드/외국 글자 도메인 · 이름난 지갑·거래소 이름을 흉내 낸 도메인(ravenvau1t)
 *   · 주소 속 아이디/비밀번호(https://ravenvault.com@evil.com) · 이상한 포트 · 복구 단어/지갑 연결을 낚는 낱말(seed·recovery·wallet-connect…).
 * 순수 로직이다(브라우저·Node·RN 공통). 🔴 폰 core/talk/url-links.ts 와 **같은 파일**이다(이 줄만 다르다) — 고칠 때 둘을 같이 고친다.
 */

export type UrlSegment = { kind: 'text'; text: string } | { kind: 'url'; text: string; href: string };

/** 주소에 쓰는 글자(ASCII 인쇄 글자 중 공백·<>"'`·{}|\^ 빼고). */
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&()*+,;=%]";
/** 맨 도메인으로 받아 주는 끝(최상위) 이름 — 「node.js」「file.txt」 같은 낱말은 주소가 아니다. */
const BARE_TLDS = ['com', 'net', 'org', 'io', 'kr', 'me', 'app', 'dev', 'xyz', 'gg', 'tv', 'ly', 'ai', 'jp', 'co', 'info', 'site', 'shop', 'link', 'page', 'so', 'to', 'cc', 'us', 'uk', 'de', 'fr', 'cn', 'tw', 'ws', 'fm', 'be', 'im', 'se', 'eu', 'biz', 'live', 'news', 'blog', 'store', 'online', 'tech', 'world', 'top'];
const SCHEME = new RegExp(`\\bhttps?://${URL_CHARS}+`, 'gi');
// 맨 도메인: 앞이 글자·숫자·@·.·/·-·_ 가 아니어야(이메일·주소 조각 안 잡기), 이름 칸 1~63자 + 끝 이름, 뒤에 경로는 선택.
const BARE = new RegExp(`(?<![A-Za-z0-9@./\\-_:])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_TLDS.join('|')}))(?![A-Za-z0-9\\-_])((?:[/?#]${URL_CHARS}*)?)`, 'gi');

/** 끝 문장부호 떼기. 닫는 괄호는 짝이 안 맞을 때만 뗀다. */
function trimTail(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.slice(-1);
    if (/[.,!?;:'"*]/.test(last)) { s = s.slice(0, -1); continue; }
    const pair = last === ')' ? '(' : last === ']' ? '[' : '';
    if (pair) {
      const open = s.split(pair).length - 1, close = s.split(last).length - 1;
      if (close > open) { s = s.slice(0, -1); continue; }
    }
    return s;
  }
}

const okUrl = (href: string): boolean => {
  try {
    const u = new URL(href);
    return (u.protocol === 'https:' || u.protocol === 'http:') && (u.hostname.includes('.') || u.hostname.startsWith('['));
  } catch { return false; }
};

/** 글 → 조각. 주소가 없으면 글 한 조각. 한 글에 주소는 많아야 20개까지만 주소로 본다(나머지는 글자). */
export function urlSegments(text: string): UrlSegment[] {
  const marks: { at: number; end: number; text: string; href: string }[] = [];
  for (const m of text.matchAll(SCHEME)) {
    const raw = trimTail(m[0]);
    if (raw.length < 10 || !okUrl(raw)) continue;
    marks.push({ at: m.index!, end: m.index! + raw.length, text: raw, href: raw });
  }
  for (const m of text.matchAll(BARE)) {
    const at = m.index!;
    if (marks.some(x => at < x.end && at + m[0].length > x.at)) continue;
    const raw = trimTail(m[0]);
    const href = 'https://' + raw;
    if (!okUrl(href)) continue;
    marks.push({ at, end: at + raw.length, text: raw, href });
  }
  marks.sort((a, b) => a.at - b.at);
  const out: UrlSegment[] = [];
  let pos = 0;
  for (const m of marks.slice(0, 20)) {
    if (m.at < pos) continue;
    if (m.at > pos) out.push({ kind: 'text', text: text.slice(pos, m.at) });
    out.push({ kind: 'url', text: m.text, href: m.href });
    pos = m.end;
  }
  if (pos < text.length) out.push({ kind: 'text', text: text.slice(pos) });
  return out.length ? out : [{ kind: 'text', text }];
}

/** 글 속 첫 주소(미리보기는 첫 주소 하나만). */
export function firstUrl(text: string): string {
  const seg = urlSegments(text).find(s => s.kind === 'url');
  return seg && seg.kind === 'url' ? seg.href : '';
}

/** 화면에 보일 짧은 모양: 「x.com/JackdawCrypto/status/2120…」. 규약·www.·끝 / 는 빼고, max 자에서 자른다. */
export function shortUrl(href: string, max = 38): string {
  let u: URL; try { u = new URL(href); } catch { return href.length > max ? href.slice(0, max - 1) + '…' : href; }
  const host = u.hostname.replace(/^www\./, '');
  let rest = u.pathname === '/' ? '' : u.pathname;
  if (u.search) rest += u.search;
  if (u.hash) rest += u.hash;
  let shown = host + (u.port ? ':' + u.port : '') + rest;
  try { shown = host + (u.port ? ':' + u.port : '') + decodeURI(rest); } catch { /* 깨진 % 는 그대로 */ }
  shown = shown.replace(/\/$/, '');
  return shown.length > max ? shown.slice(0, Math.max(host.length + 2, max - 1)) + '…' : shown;
}

// ── 위험 살피기 ─────────────────────────────────────────────
export type LinkRiskReason = 'not-https' | 'ip-host' | 'punycode' | 'lookalike' | 'credentials' | 'port' | 'phishing-words' | 'bad-url';
export type LinkRisk = { risky: boolean; host: string; reasons: LinkRiskReason[] };

/** 흉내 내기 쉬운 이름과 그 진짜 도메인. 진짜 도메인과 그 하위 이름만 안전으로 본다. */
export const BRANDS: readonly { name: string; official: readonly string[] }[] = [
  { name: 'ravenvault', official: ['ravenvault.ex.erci.se', 'ex.erci.se'] },
  { name: 'ravencoin', official: ['ravencoin.org', 'ravencoin.foundation', 'ravencoin.network'] },
  { name: 'metamask', official: ['metamask.io'] },
  { name: 'trustwallet', official: ['trustwallet.com'] },
  { name: 'binance', official: ['binance.com'] },
  { name: 'coinbase', official: ['coinbase.com'] },
  { name: 'upbit', official: ['upbit.com'] },
  { name: 'bithumb', official: ['bithumb.com'] },
  { name: 'kakao', official: ['kakao.com', 'kakaocorp.com', 'daum.net'] },
  { name: 'naver', official: ['naver.com', 'naver.me'] },
  { name: 'ledger', official: ['ledger.com'] },
  { name: 'trezor', official: ['trezor.io'] },
  { name: 'phantom', official: ['phantom.app', 'phantom.com'] },
  { name: 'playx', official: ['ex.erci.se'] },
];
/** 비슷한 글자 접기: 1·l·i → l, 0 → o, rn → m, vv → w, 5 → s, 3 → e, 4 → a. 하이픈·점·숫자 사이 끼움은 뺀다. */
function fold(s: string): string {
  return s.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[1i|!]/g, 'l').replace(/0/g, 'o').replace(/5/g, 's').replace(/3/g, 'e').replace(/4/g, 'a').replace(/[^a-z]/g, '');
}
const fit = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);
/** 지갑·복구 단어를 낚는 낱말(낱말 단위, 이웃 둘을 붙인 것도 본다). */
const PHISH_WORDS = new Set(['seed', 'seeds', 'seedphrase', 'mnemonic', 'recovery', 'recoveryphrase', 'recover', 'walletconnect', 'privatekey', 'secretphrase', 'airdrop', 'validatewallet', 'walletsync', 'restorewallet', 'syncwallet', 'rectify', 'dappconnect']);

export function linkRisk(href: string): LinkRisk {
  let u: URL; try { u = new URL(href); } catch { return { risky: true, host: '', reasons: ['bad-url'] }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const reasons: LinkRiskReason[] = [];
  if (u.protocol !== 'https:') reasons.push('not-https');
  if (/^\[.*\]$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^(0x[0-9a-f]+|\d+)$/i.test(host)) reasons.push('ip-host');
  if (host.split('.').some(l => l.startsWith('xn--'))) reasons.push('punycode');
  if (u.username || u.password) reasons.push('credentials');
  if (u.port && u.port !== '443' && u.port !== '80') reasons.push('port');
  if (!reasons.includes('ip-host')) {
    const official = BRANDS.some(b => b.official.some(d => fit(host, d)));
    if (!official) {
      const folded = fold(host.replace(/\.[a-z]+$/, ''));
      if (BRANDS.some(b => folded.includes(fold(b.name)))) reasons.push('lookalike');
    }
  }
  const tokens = `${host} ${decodeSafe(u.pathname)} ${decodeSafe(u.search)} ${decodeSafe(u.hash)}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t, i) => PHISH_WORDS.has(t) || (i > 0 && PHISH_WORDS.has(tokens[i - 1] + t)))) reasons.push('phishing-words');
  return { risky: reasons.length > 0, host, reasons };
}
function decodeSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

/** 위험 까닭 → 한국어 한 줄(화면이 번역표로 옮긴다). */
export const RISK_TEXT: Record<LinkRiskReason, string> = {
  'not-https': '암호화되지 않은 주소(http)예요.',
  'ip-host': '이름 대신 숫자(IP) 주소예요.',
  punycode: '외국 글자로 진짜처럼 꾸민 도메인일 수 있어요.',
  lookalike: '이름난 지갑·거래소 이름을 흉내 낸 도메인 같아요.',
  credentials: '주소 안에 다른 이름이 숨어 있어요.',
  port: '흔하지 않은 포트를 써요.',
  'phishing-words': '복구 단어·지갑 연결을 묻는 낚시 주소 같아요.',
  'bad-url': '주소 모양이 이상해요.',
};
