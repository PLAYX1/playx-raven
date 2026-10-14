import { plain, type Loose } from '../creator/bytes';
import { hasClaimOrForbidden } from '../store/claim-words';
import { bodyHash, fail, isNowMs, isPublicKey, keysAre, readDoc, SHA, signedBy, time, int, encodeDoc } from './signed';

/*
 * 직원 위임 증서 v1(RAVENVAULT-STAFF-V1)와 서명된 철회 목록(RAVENVAULT-STAFF-REVOKE-V1) — 결정문 §21 B1.
 *
 * 가게 키가 직원 키에 「언제까지·무엇을」 서명한다. 직원 기기는 이 증서로 주문 상태 메시지에 서명하고, 손님 앱은 증서를 같이 확인한다.
 *   증서 { v:1, store, staff, title?, scopes:[…], notBefore, notAfter, sig }   certId = 본문(sig 제외) 해시
 *   철회 { v:1, store, seq, revoked:[certId…(정렬·중복 없음)], issuedAt, prunedBefore, sig }  — seq 가 큰 목록이 최신, 덧붙이기만(줄어든 목록 거절).
 *     prunedBefore(ms, 0 = 가지치기 없음, ≤ issuedAt): notAfter ≤ prunedBefore 인 증서는 목록에 없어도 철회로 본다. 그래서 가게 앱은 그런 증서 ID 를
 *     목록에서 빼도 된다(상한 MAX_REVOKED 를 넘지 않게). 증서 최대 기간이 14일이라 prunedBefore = issuedAt − 14일 이면 그 전에 시작한 증서는 전부 끝났다.
 *     prunedBefore 를 앞으로 옮기지 않고 ID 를 빼면 'shrunk'(되살리기), prunedBefore 가 뒤로 가면 'prune-rollback' 으로 거절.
 *     🔶 한계: 받는 쪽은 뺀 ID 의 증서 만료 시각을 모른다 — 가게 앱이 notAfter ≤ prunedBefore 인 ID 만 빼야 한다(가게 키 서명이 그 약속이다).
 *   목록 나이: issuedAt 이 REVOCATION_LIST_MAX_AGE_MS(24시간)보다 오래되면 'stale-revocation-list'. 가게 앱은 바뀐 게 없어도 하루 안에 seq+1 로 다시 서명해 올린다.
 * 직원 키는 견적을 낼 수 없다(견적은 가게 키만, quote.ts). 위임은 한 단계뿐(직원이 다른 직원에게 다시 위임 불가).
 * 철회 목록을 못 받은 기기는 철회를 모른다 — 그래서 증서 유효기간 상한(STAFF_CERT_MAX_MS)을 짧게 둔다.
 */

export const STAFF_SIGN_DOMAIN = 'RAVENVAULT-STAFF-V1';
export const STAFF_REVOKE_DOMAIN = 'RAVENVAULT-STAFF-REVOKE-V1';
export const MAX_STAFF_DOC_BYTES = 4 * 1024;
export const MAX_REVOKE_BYTES = 64 * 1024;
/** 철회 ID 수 상한 — 바이트 상한(64 KiB)보다 먼저 걸리도록 900(ID 하나 ≈ 67바이트, 900개 ≈ 60 KiB). 넘치면 prunedBefore 로 가지친다. */
export const MAX_REVOKED = 900;
/** 🔶 철회 목록 최대 나이 24시간(리뷰 M2) — 이보다 오래된 목록으로는 직원 증서를 받지 않는다. 대표 결정 전 잠정값(상수 한 곳). */
export const REVOCATION_LIST_MAX_AGE_MS = 24 * 3600_000;
/** 증서 유효기간: 기본 7일·상한 14일(§29) — 철회 목록 전파가 늦어도 피해 기간을 묶는다. */
export const STAFF_CERT_DEFAULT_MS = 7 * 24 * 3600_000;
export const STAFF_CERT_MAX_MS = 14 * 24 * 3600_000;
/** 위임 직함(선택 입력, §31): 있으면 1~20자, 「인증·공식·보증·검증」 계열 단어 금지(store/claim-words.ts). 표시용일 뿐 권한이 아니다. */
export const STAFF_TITLE_MAX = 20;
/** 시계 어긋남 허용(notBefore). */
export const STAFF_CLOCK_SKEW_MS = 30_000;

/**
 * 위임 범위 = 직원이 할 수 있는 일. 옛 3개(주문 상태 단계)는 그대로, 현장 조회·스캔 2개를 더했다(29라운드 §40-Q1).
 *   order-view = 주문 보기(읽기만) · ticket-scan = 입구에서 티켓 확인(스캔).
 * 직원 증서에는 돈을 움직이는 범위가 없다 — 가격 변경·환불 확정·위임 변경·견적 만들기는 가게 키만(STAFF_NEVER 에 이름을 적어 두고 증서 검사가 거절한다).
 * 서명 형식은 그대로(본문 { v:1, store, staff, title?, scopes, notBefore, notAfter } 의 scopes 배열만 길어질 수 있다): 옛 증서는 그대로 유효하고,
 * 새 범위를 담은 증서를 옛 앱이 받으면 모르는 범위라 'shape' 로 닫힌 실패(권한이 조용히 넓어지지 않는다).
 */
export const STAFF_SCOPES = ['order-accept', 'order-progress', 'order-ready', 'order-view', 'ticket-scan'] as const;
export type StaffScope = (typeof STAFF_SCOPES)[number];
/** 직원에게 절대 맡기지 않는 일(이름만 — 증서에 이 이름이 있으면 모양 오류). 돈·가격·권한은 가게 키만. */
export const STAFF_NEVER = ['price-change', 'refund-confirm', 'delegation-change', 'quote', 'payment', 'send', 'refund'] as const;
/** 범위 이름 → 사장님에게 보이는 쉬운 한국어. */
export const STAFF_SCOPE_LABEL: Record<StaffScope, string> = {
  'order-accept': '주문 접수 알림', 'order-progress': '처리 중 알림', 'order-ready': '나왔어요 알림', 'order-view': '주문 보기', 'ticket-scan': '티켓 확인(스캔)',
};
/** 자주 쓰는 묶음(화면 단추용 — 증서에는 묶음 이름이 아니라 scopes 만 들어간다). */
export const STAFF_ROLES: readonly { id: string; label: string; scopes: readonly StaffScope[] }[] = [
  { id: 'hall', label: '홀 직원', scopes: ['order-view', 'order-accept', 'order-progress', 'order-ready'] },
  { id: 'kitchen', label: '주방 직원', scopes: ['order-view', 'order-progress', 'order-ready'] },
  { id: 'door', label: '입구 확인', scopes: ['ticket-scan', 'order-view'] },
];

export type StaffCertBody = { v: 1; store: string; staff: string; title?: string; scopes: StaffScope[]; notBefore: number; notAfter: number };
export type StaffCert = StaffCertBody & { sig: string };
export type RevocationBody = { v: 1; store: string; seq: number; revoked: string[]; issuedAt: number; prunedBefore: number };
export type RevocationList = RevocationBody & { sig: string };

export function validateStaffCert(raw: unknown, withSig = true): StaffCert {
  const hasTitle = plain(raw) && Object.prototype.hasOwnProperty.call(raw, 'title');
  if (!plain(raw) || !keysAre(raw, 'v,store,staff,scopes,notBefore,notAfter' + (hasTitle ? ',title' : '') + (withSig ? ',sig' : ''))) return fail('cert', 'keys');
  const c = raw as Loose;
  if (c.v !== 1 || !isPublicKey(c.store) || !isPublicKey(c.staff)) fail('cert', 'key');
  if (c.staff === c.store) fail('cert', 'self');
  if (hasTitle && (typeof c.title !== 'string' || c.title !== c.title.normalize('NFC') || c.title.trim() !== c.title || Array.from(c.title).length < 1 || Array.from(c.title).length > STAFF_TITLE_MAX ||
      /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(c.title) || /[\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/u.test(c.title) || hasClaimOrForbidden(c.title))) fail('cert', 'title');
  if (!Array.isArray(c.scopes) || c.scopes.length < 1 || c.scopes.some((s: unknown) => !(STAFF_SCOPES as readonly unknown[]).includes(s)) ||
      new Set(c.scopes).size !== c.scopes.length) fail('scope', 'list');
  if (!time(c.notBefore) || !time(c.notAfter) || c.notAfter <= c.notBefore) fail('cert', 'time');
  if (c.notAfter - c.notBefore > STAFF_CERT_MAX_MS) fail('cert', 'too-long');
  return c as StaffCert;
}
/** 기본 위임 기간(7일)으로 notBefore/notAfter 를 만든다. ttlMs 는 상한(14일)을 넘을 수 없다. */
export function staffCertWindow(notBefore: number, ttlMs: number = STAFF_CERT_DEFAULT_MS): { notBefore: number; notAfter: number } {
  if (!int(ttlMs, 1, STAFF_CERT_MAX_MS)) return fail('cert', 'too-long');
  return { notBefore, notAfter: notBefore + ttlMs };
}
/** 직함 표시 문구: 직함이 있으면 항상 「판매자 부여」 꼬리표를 붙인다. 없으면 null. 직함은 권한이 아니다 — 권한은 scopes·기간·철회로만 정해진다. */
export const STAFF_TITLE_TAG = '판매자 부여';
export const staffTitleLabel = (c: { title?: string }): string | null => (typeof c.title === 'string' ? `${c.title} · ${STAFF_TITLE_TAG}` : null);
export const staffCertId = (c: StaffCert | StaffCertBody): string => bodyHash(c);
export const encodeStaffCert = (c: StaffCert): Uint8Array => encodeDoc(c);

export function validateRevocationList(raw: unknown, withSig = true): RevocationList {
  if (!plain(raw) || !keysAre(raw, 'v,store,seq,revoked,issuedAt,prunedBefore' + (withSig ? ',sig' : ''))) return fail('revocation', 'keys');
  const r = raw as Loose;
  if (r.v !== 1 || !isPublicKey(r.store) || !int(r.seq, 1, Number.MAX_SAFE_INTEGER) || !time(r.issuedAt) || !int(r.prunedBefore, 0, r.issuedAt)) fail('revocation', 'shape');
  if (!Array.isArray(r.revoked) || r.revoked.length > MAX_REVOKED || r.revoked.some((id: unknown) => typeof id !== 'string' || !SHA.test(id))) fail('revocation', 'ids');
  for (let i = 1; i < r.revoked.length; i++) if (!(r.revoked[i - 1] < r.revoked[i])) fail('revocation', 'order');
  return r as RevocationList;
}

/** 철회 목록 확인: 모양 + 가게 키 서명. */
export function verifyRevocationList(input: Uint8Array | unknown, store: string): RevocationList {
  const r = validateRevocationList(readDoc(input, MAX_REVOKE_BYTES));
  if (r.store !== store) fail('revocation', 'other-store');
  if (!signedBy(STAFF_REVOKE_DOMAIN, r, r.store)) fail('signature', 'revocation');
  return r;
}

/**
 * 새로 받은 철회 목록을 들고 있는 것과 합친다. 서명·가게가 맞고 seq 가 더 커야 하며, 앞 목록의 철회 id 를 빼려면 prunedBefore 가 앞으로 가야 한다
 * (빠진 ID 는 prunedBefore 규칙으로 계속 거절된다). prunedBefore 가 뒤로 가면 거절. seq 가 같거나 작으면 들고 있는 것을 그대로 돌려준다(재전송·역행 무시).
 * 🔶 호출자 책임: 결과를 가게별로 영속 저장한다. 저장하지 않으면 다음 비교에서 옛 목록 재전송을 구분하지 못한다.
 */
export function acceptRevocationList(current: RevocationList | null, incoming: unknown, store: string): RevocationList {
  const next = verifyRevocationList(incoming, store);
  if (!current) return next;
  if (next.seq <= current.seq) return current;
  if (next.prunedBefore < current.prunedBefore) fail('revocation', 'prune-rollback');
  const have = new Set(next.revoked);
  if (current.revoked.some(id => !have.has(id)) && next.prunedBefore === current.prunedBefore) fail('revocation', 'shrunk');
  return next;
}

export type DelegationReason = 'shape' | 'signature' | 'other-store' | 'not-yet' | 'expired' | 'scope' | 'revoked' | 'no-revocation-list' | 'stale-revocation-list' | 'bad-clock';
export type DelegationResult = { ok: true; cert: StaffCert; certId: string } | { ok: false; reason: DelegationReason };

/**
 * 직원 증서가 지금 이 범위로 유효한가. 순서: 시계(now) → 모양 → 가게 일치 → 가게 서명 → 기간(notAfter 그 자체는 만료) → 범위 → 철회 목록 나이 → 철회.
 * now = ms(isNowMs). 아니면 'bad-clock'(닫힌 실패).
 * revocations 는 이 가게의 최신 철회 목록(verifyRevocationList/acceptRevocationList 를 거친 것 — 이 함수는 목록 서명을 다시 보지 않는다).
 * requireRevocationList 기본 true(리뷰 M2): null 이면 'no-revocation-list'. 철회를 모르는 채 열어 주는 것은 호출자가 false 를 명시할 때만.
 * 목록이 REVOCATION_LIST_MAX_AGE_MS 보다 오래되면 'stale-revocation-list'.
 */
export function verifyStaffCert(raw: unknown, ctx: { store: string; now: number; scope: StaffScope; revocations: RevocationList | null; requireRevocationList?: boolean }): DelegationResult {
  if (!isNowMs(ctx?.now)) return { ok: false, reason: 'bad-clock' };
  let c: StaffCert;
  try { c = validateStaffCert(readDoc(raw, MAX_STAFF_DOC_BYTES)); } catch { return { ok: false, reason: 'shape' }; }
  if (c.store !== ctx.store) return { ok: false, reason: 'other-store' };
  if (!signedBy(STAFF_SIGN_DOMAIN, c, c.store)) return { ok: false, reason: 'signature' };
  if (ctx.now + STAFF_CLOCK_SKEW_MS < c.notBefore) return { ok: false, reason: 'not-yet' };
  if (ctx.now >= c.notAfter) return { ok: false, reason: 'expired' };
  if (!(c.scopes as string[]).includes(ctx.scope)) return { ok: false, reason: 'scope' };
  if (ctx.revocations) {
    if (ctx.revocations.store !== c.store) return { ok: false, reason: 'other-store' };
    if (!time(ctx.revocations.issuedAt) || ctx.now - ctx.revocations.issuedAt > REVOCATION_LIST_MAX_AGE_MS) return { ok: false, reason: 'stale-revocation-list' };
    const id = staffCertId(c);
    if (c.notAfter <= ctx.revocations.prunedBefore || ctx.revocations.revoked.includes(id)) return { ok: false, reason: 'revoked' };
    return { ok: true, cert: c, certId: id };
  }
  if (ctx.requireRevocationList !== false) return { ok: false, reason: 'no-revocation-list' };
  return { ok: true, cert: c, certId: staffCertId(c) };
}

export function 위임안내(reason: DelegationReason): string {
  switch (reason) {
    case 'shape': return '직원 위임장을 알아보지 못했어요.';
    case 'signature': return '가게 키 서명이 맞지 않는 위임장이에요.';
    case 'other-store': return '다른 가게의 위임장이에요.';
    case 'not-yet': return '아직 시작되지 않은 위임장이에요.';
    case 'expired': return '기간이 지난 위임장이에요. 사장님께 새로 받아 주세요.';
    case 'scope': return '이 직원에게 맡기지 않은 일이에요.';
    case 'revoked': return '사장님이 거둬들인 위임장이에요.';
    case 'no-revocation-list': return '가게의 철회 목록을 아직 받지 못했어요.';
    case 'stale-revocation-list': return '가게의 철회 목록이 오래됐어요. 새 목록을 받은 뒤 다시 확인해 주세요.';
    case 'bad-clock': return '기기 시계를 확인해 주세요.';
  }
}
