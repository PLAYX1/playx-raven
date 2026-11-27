/**
 * 「폰 연결」 한 QR — 데스크탑 하나와 폰 하나를 잇는 길이 셋(지갑 연결 RVWL1 · 가게 업무 ravenvault-shop · 판매 리모컨 RVDV1)으로
 * 갈라져 있던 것을(11-25 디자인 검토 「부품 묶음」) **QR 하나**로 모은다. 순수 함수: 시계·저장소·네트워크 없음.
 *
 *  · 겉봉만 새로 만든다: `RVPC1.` + base64url(정본JSON{v:1, wl?, shop?, dv?}). 안의 글은 각 길의 **원래 QR 글 그대로**다.
 *    → 새 암호·새 열쇠·새 신뢰 규칙 없음. 폰은 칸마다 원래 읽는 함수(parseLinkOffer · 연결QR · readPairOffer)로 따로 검사한다.
 *  · 🔴 겉봉에 복구 단어·개인키·지갑 암호를 넣지 않는다 — 칸 이름이 정해져 있고(그 밖의 칸이 있으면 버린다), 칸마다 원래 머리글을 확인한다.
 *  · 가게 업무 칸(shop)에는 원래 직원 QR 처럼 연결 열쇠(#t)가 들어 있다. 겉봉은 지갑 QR 과 같이 1분 뒤 화면에서 숨긴다(데스크탑).
 *    앱 전용 글이라 브라우저 주소가 아니다(원래 ravenvault-shop:// 규칙 그대로).
 *  · 옛 QR(한 길짜리)도 같은 함수가 읽는다(splitDesktopQr) — 옛 데스크탑·옛 화면을 깨지 않는다.
 * 데스크탑(playx-raven)에 바이트 그대로 복사해 쓴다 — 다른 모듈은 core/creator/bytes 만 쓴다.
 */
import { b64urlDecode, b64urlEncode, canonicalJson, plain, utf8 } from '../creator/bytes';

export const ONE_LINK_PREFIX = 'RVPC1.';
/** 칸 하나·겉봉 전체의 최대 길이(폰 CodeReader 가 받는 길이보다 훨씬 작게 — QR 이 너무 빽빽해지지 않게). */
export const ONE_LINK_PART_MAX = 1200;
export const ONE_LINK_MAX = 2600;
/** 칸 이름 → 그 칸 글이 꼭 시작해야 하는 머리글. 원래 QR 의 머리글과 같다. */
const HEAD: Readonly<Record<OneLinkKind, readonly string[]>> = {
  wl: ['RVWL1.'],
  shop: ['ravenvault-shop://', 'https://'],
  dv: ['RVDV1.'],
};
export type OneLinkKind = 'wl' | 'shop' | 'dv';
export const ONE_LINK_KINDS: readonly OneLinkKind[] = ['wl', 'shop', 'dv'];
export type OneLinkParts = Partial<Record<OneLinkKind, string>>;

const okPart = (kind: OneLinkKind, v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= ONE_LINK_PART_MAX && v === v.trim() && !/[\u0000-\u001f\u007f\s]/.test(v)
  && HEAD[kind].some(h => v.startsWith(h));

/** 데스크탑: 칸을 하나 이상 담은 겉봉 글. 칸이 틀리면 던진다(틀린 QR 을 띄우지 않는다). */
export function encodeOneLinkQr(parts: OneLinkParts): string {
  const body: Record<string, unknown> = { v: 1 };
  for (const k of ONE_LINK_KINDS) {
    const v = parts[k];
    if (v === undefined) continue;
    if (!okPart(k, v)) throw new Error('one-link-part');
    body[k] = v;
  }
  if (Object.keys(body).length < 2) throw new Error('one-link-empty');
  const text = ONE_LINK_PREFIX + b64urlEncode(utf8(canonicalJson(body)));
  if (text.length > ONE_LINK_MAX) throw new Error('one-link-size');
  return text;
}

/** 폰: 겉봉을 열어 칸들을 돌려준다(칸 안 검사는 하지 않는다 — 부르는 쪽이 원래 함수로). 겉봉이 아니거나 틀리면 null. */
export function decodeOneLinkQr(text: unknown): OneLinkParts | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith(ONE_LINK_PREFIX) || t.length > ONE_LINK_MAX) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(t.slice(ONE_LINK_PREFIX.length)))); } catch { return null; }
  if (!plain(v) || v.v !== 1) return null;
  const keys = Object.keys(v);
  // 모르는 칸이 하나라도 있으면 통째로 버린다(무엇이 실려 왔는지 모르는 글은 쓰지 않는다).
  if (keys.some(k => k !== 'v' && !(ONE_LINK_KINDS as readonly string[]).includes(k))) return null;
  const out: OneLinkParts = {};
  for (const k of ONE_LINK_KINDS) {
    if (!(k in v)) continue;
    if (!okPart(k, v[k])) return null;
    out[k] = v[k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 폰: 데스크탑에서 읽은 아무 QR 글 → 어느 길의 글인지 나눈다. 새 겉봉이면 칸들, 옛 한 길짜리면 그 칸 하나.
 * 무엇도 아니면 null. 칸 안이 맞는지는 여기서 보지 않는다.
 */
export function splitDesktopQr(text: unknown): OneLinkParts | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t.startsWith(ONE_LINK_PREFIX)) return decodeOneLinkQr(t);
  if (t.startsWith('RVWL1.')) return okPart('wl', t) ? { wl: t } : null;
  if (t.startsWith('RVDV1.')) return okPart('dv', t) ? { dv: t } : null;
  if (/^(ravenvault-shop|https?):\/\//.test(t)) return t.length <= ONE_LINK_PART_MAX ? { shop: t } : null;
  return null;
}
