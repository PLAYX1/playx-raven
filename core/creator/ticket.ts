import { b64urlDecode, b64urlEncode, canonicalJson, plain, utf8, type Loose } from './bytes';
import { recoverMessageAddress, type CreatorManifest, type TicketSection } from './manifest';

/*
 * 티켓 사용(입장) 확인 — 서버 없이 할 수 있는 범위만.
 *
 * 흐름: 구매자가 지갑으로 산다(구매 거래 = 판매자 몫 + 수수료 + 메모) → 판매자(또는 매니페스트에 적은 확인 담당 주소)가 그 거래를
 *       체인에서 보고 **입장 코드**에 서명해 구매자에게 준다(노드 signmessage) → 행사장 기기가 코드(QR 글자)를 **오프라인**으로 검사한다:
 *       서명 주소 = 매니페스트의 checkerAddress, 자산·좌석 번호 범위·행사 시간, 이 기기에서 이미 쓴 코드인지.
 *
 * 🔴 한계(문서 docs/open-seller-platform.md §5): 서버가 없으니 (1) 문이 여러 개면 「이미 사용」이 기기끼리 공유되지 않는다 — 한 기기로 받거나
 *    목록을 손으로 합쳐야 한다. (2) 문 앞 검사는 「판매자가 이 코드를 내줬다」만 증명한다. 코드를 내주기 전에 결제를 확인하는 것은 판매자 몫이다.
 *    (3) 코드를 캡처해 남에게 주면 먼저 온 사람이 쓴다(재판매·양도 통제 없음). (4) 수량(quantity) 초과 판매를 체인이 막지 않는다 —
 *    지갑은 읽을 수 있는 판매 이력으로 매진을 「알려」 줄 뿐이다. 재판매·환불·행사 취소 책임은 판매자에게 있다(법률 확인 필요).
 */

export const TICKET_CODE_FORMAT = 'rv-ticket-code';
export const TICKET_CODE_DOMAIN = 'RAVENVAULT-TICKET-V1';
const PREFIX = 'RVT1.';
/** 행사 끝 시각을 적지 않았으면 시작 뒤 이만큼까지 받는다. */
export const TICKET_GRACE_MS = 24 * 3600_000;

export type TicketCode = { format: typeof TICKET_CODE_FORMAT; version: 1; asset: string; txid: string; ownerId: string; serial: number; signature: string };

/** 판매자가 노드 signmessage(checkerAddress)로 서명하는 글. */
export const ticketCodeMessage = (c: Pick<TicketCode, 'asset' | 'txid' | 'ownerId' | 'serial'>) =>
  `${TICKET_CODE_DOMAIN}\n${c.asset}\n${c.txid}\n${c.ownerId}\n${c.serial}`;

/** QR 에 넣을 글자. */
export const encodeTicketCode = (c: TicketCode) => PREFIX + b64urlEncode(utf8(canonicalJson(c)));

export function decodeTicketCode(text: string): TicketCode | null {
  try {
    if (typeof text !== 'string' || !text.startsWith(PREFIX) || text.length > 2000) return null;
    const d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(text.slice(PREFIX.length)))) as Loose;
    if (!plain(d) || Object.keys(d).sort().join() !== 'asset,format,ownerId,serial,signature,txid,version' || d.format !== TICKET_CODE_FORMAT || d.version !== 1) return null;
    if (typeof d.asset !== 'string' || !/^[a-f0-9]{64}$/.test(d.txid) || typeof d.ownerId !== 'string' || !/^[a-f0-9-]{36}$/.test(d.ownerId) ||
        !Number.isSafeInteger(d.serial) || typeof d.signature !== 'string' || d.signature.length > 200) return null;
    return d as TicketCode;
  } catch { return null; }
}

export type TicketVerdict = { ok: boolean; reason: 'ok' | 'format' | 'not-ticket' | 'other-event' | 'signature' | 'serial' | 'too-early' | 'ended' | 'used'; say: string; key: string | null };
/**
 * 문 앞 기기의 검사(오프라인). used 는 이 기기가 지금까지 받은 코드의 key 집합 — ok 이면 호출한 쪽이 key 를 넣는다(markUsed).
 * 「too-early」는 시작 6시간 전부터 받는다(입장 준비).
 */
export function verifyTicketCode(text: string, manifest: CreatorManifest, opts: { now: number; used: ReadonlySet<string> }): TicketVerdict {
  const bad = (reason: TicketVerdict['reason'], say: string): TicketVerdict => ({ ok: false, reason, say, key: null });
  const c = decodeTicketCode(text);
  if (!c) return bad('format', '입장 코드 모양이 아니에요.');
  if (manifest.type !== 'ticket') return bad('not-ticket', '티켓 상품이 아니에요.');
  if (c.asset !== manifest.asset) return bad('other-event', '다른 행사의 코드예요.');
  const t = manifest.details as TicketSection;
  if (recoverMessageAddress(ticketCodeMessage(c), c.signature) !== t.redemption.checkerAddress) return bad('signature', '판매자가 서명한 코드가 아니에요(위조이거나 다른 판매자).');
  if (c.serial < 1 || c.serial > t.quantity) return bad('serial', '좌석 번호가 판매 수량 밖이에요.');
  const start = Date.parse(t.startsAt), end = t.endsAt ? Date.parse(t.endsAt) : start + TICKET_GRACE_MS;
  if (opts.now < start - 6 * 3600_000) return bad('too-early', '아직 입장 시간이 아니에요.');
  if (opts.now > end) return bad('ended', '행사가 끝났어요.');
  // 좌석 번호 하나는 한 번만 들어간다(같은 번호를 두 거래에 내줘도 두 번째는 막힌다).
  const key = `${c.asset}:${c.serial}`;
  if (opts.used.has(key)) return bad('used', '이 기기에서 이미 사용한 번호예요.');
  return { ok: true, reason: 'ok', say: `입장 확인 · ${t.eventName} · ${c.serial}번`, key };
}
