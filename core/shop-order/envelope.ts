import { plain, sha256Hex, utf8, type Loose } from '../creator/bytes';
import { fail, keysAre, SHA, time } from './signed';

/*
 * 우편함 봉투·FCM 깨움 — 타입과 규칙만(결정문 §21 B1). 🔴 전달(서버 우편함)은 구현하지 않는다: 우편함 SQL 은 대표 승인 전이라 미적용.
 *
 * 봉투 { v:1, box, kind, body, sentAt }
 *   · box = 받는 쪽 우편함 id = sha256(MAILBOX_ID_DOMAIN \n 받는 키 공개키 hex). 공개키 자체는 서버에 적지 않는다.
 *   · body = 서명된 문서(견적·상태 메시지·철회 목록)의 정본 JSON 문자열. 우편함은 내용을 믿게 해 주지 않는다 —
 *     받는 쪽은 꺼낸 body 를 verifyQuote / applyStatus / acceptRevocationList 로 다시 확인한다. 봉투의 kind·sentAt 은 분류·정리용일 뿐.
 * FCM 깨움 = 고정된 { t:'rv-wake', v:1 } 하나. 주문 id·상태·테이블·금액·우편함 id 어느 것도 싣지 않는다(푸시 서버가 내용을 보지 않게).
 *   깨어난 기기가 스스로 우편함을 읽는다. 데스크톱이 꺼져 있으면 손님 앱은 체인으로 입금을 확인하고 「매장 확인 대기」를 표시(폴링 폴백).
 */

export const MAILBOX_ID_DOMAIN = 'RAVENVAULT-MAILBOX-V1';
export const MAILBOX_KINDS = ['quote', 'order-status', 'staff-revocation'] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];
/** 우편함 사용 상한(§21 B1 「우편함 사용 상한」). 🔶 서버 SQL 승인 때 함께 정할 잠정값 — 지금은 봉투 크기 검사에만 쓴다. */
export const MAILBOX_LIMITS = {
  maxEnvelopeBytes: 72 * 1024,
  maxPerBox: 200,
  ttlMs: 24 * 3600_000,
} as const;

export type MailboxEnvelope = Readonly<{ v: 1; box: string; kind: MailboxKind; body: string; sentAt: number }>;

export const mailboxIdOf = (recipientPubHex: string): string => sha256Hex(utf8(`${MAILBOX_ID_DOMAIN}\n${recipientPubHex}`));

export function makeEnvelope(recipientPubHex: string, kind: MailboxKind, signedDoc: Uint8Array, sentAt: number): MailboxEnvelope {
  return readEnvelope({ v: 1, box: mailboxIdOf(recipientPubHex), kind, body: new TextDecoder('utf-8', { fatal: true }).decode(signedDoc), sentAt });
}

/** 봉투 모양만 확인한다(내용 서명은 호출 측이 kind 에 맞는 검증 함수로). */
export function readEnvelope(raw: unknown): MailboxEnvelope {
  if (!plain(raw) || !keysAre(raw, 'v,box,kind,body,sentAt')) return fail('shape', 'envelope-keys');
  const e = raw as Loose;
  if (e.v !== 1 || typeof e.box !== 'string' || !SHA.test(e.box) || !(MAILBOX_KINDS as readonly unknown[]).includes(e.kind) || !time(e.sentAt)) fail('shape', 'envelope');
  if (typeof e.body !== 'string' || e.body.length < 2 || utf8(e.body).length > MAILBOX_LIMITS.maxEnvelopeBytes) fail('too-large', 'envelope-body');
  return Object.freeze({ v: 1, box: e.box, kind: e.kind, body: e.body, sentAt: e.sentAt });
}
/** 봉투 body → 검증 함수에 넘길 바이트(정본 JSON 그대로여야 검증 함수가 받아 준다). */
export const envelopeBodyBytes = (e: MailboxEnvelope): Uint8Array => utf8(e.body);

/* ── FCM 깨움 ─────────────────────────────────────────────────────── */

export type FcmWake = Readonly<{ t: 'rv-wake'; v: 1 }>;
export const FCM_WAKE: FcmWake = Object.freeze({ t: 'rv-wake', v: 1 });

/** 깨움은 봉투가 무엇이든 같은 상수다 — 인자는 일부러 쓰지 않는다. */
export function wakeFor(_envelope: MailboxEnvelope): FcmWake { return FCM_WAKE; }

/** 받은(또는 보내려는) FCM data 가 내용 없는 깨움인가. 다른 칸이 하나라도 있으면 false. */
export function isContentFreeWake(raw: unknown): raw is FcmWake {
  return plain(raw) && keysAre(raw, 't,v') && raw.t === 'rv-wake' && raw.v === 1;
}

/** 타입 규칙: 깨움 타입은 봉투·주문 내용의 어떤 칸 이름도 갖지 않는다(칸이 늘면 여기서 컴파일 실패). */
type ContentKeys = keyof MailboxEnvelope | 'orderId' | 'status' | 'table' | 'quoteHash' | 'amountAtoms' | 'totalKrw' | 'payTo' | 'store' | 'staff';
type NoContentInWake = [Extract<keyof FcmWake, Exclude<ContentKeys, 'v'>>] extends [never] ? true : false;
export const WAKE_HAS_NO_CONTENT: NoContentInWake = true;
