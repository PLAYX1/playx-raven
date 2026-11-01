/**
 * 데스크탑 지갑 연결의 운반 — 이야기 1:1 쪽지와 같은 NIP-17 겉봉(kind 1059)으로 공개 릴레이에 올린다. 릴레이는 내용을 못 본다.
 * 겉봉·봉인 열쇠 = 연결 키(지갑 열쇠·이야기 신원 키와 다른 난수 키). 봉인 서명자가 기대한 상대 연결 키일 때만 연다.
 * 안의 글은 link.ts 의 서명된 묶음(Signed<…>) — 운반 암호와 따로 한 번 더 서명돼 있다(검토 반영: NIP-44 만으로 믿지 않는다).
 * 순수 함수: 릴레이 연결·저장은 호출자(core/talk/relay createTalkRelay)가 한다.
 */
import { KIND_WRAP, unwrap, wrapFor } from '../talk/nip17';
import type { NostrEvent } from '../talk/event';
import type { TalkFilter } from '../talk/relay';
import type { LinkAccept, LinkRequest, LinkResult, LinkRevoke, Signed } from './link';

export type LinkMessage =
  | { t: 'accept'; s: Signed<LinkAccept> }
  | { t: 'request'; s: Signed<LinkRequest> }
  | { t: 'result'; s: Signed<LinkResult> }
  | { t: 'revoke'; s: Signed<LinkRevoke> };
const TYPES = new Set(['accept', 'request', 'result', 'revoke']);
const MARK = 'rvwl1';
/** 겉봉 시각은 NIP-17 규칙대로 최대 이틀 앞당겨진다 — 구독·조회는 이만큼 앞에서부터. */
export const LINK_WRAP_SKEW_SEC = 2 * 86_400;

/** 상대(연결 키) 한 명에게만 가는 겉봉. 내 사본은 만들지 않는다(요청·결과는 각자 기록한다). */
export function packLinkMessage(mySecret: Uint8Array, toLinkKey: string, msg: LinkMessage): NostrEvent {
  if (!TYPES.has(msg.t)) throw new Error('link-message');
  return wrapFor(mySecret, toLinkKey, toLinkKey, JSON.stringify({ [MARK]: msg.t, s: msg.s }));
}
/** 겉봉 → 연결 글. 남의 것·모양이 틀린 것·기대한 상대가 아닌 것은 null(오류 아님). 서명 검사는 link.ts verify… 로 따로 한다. */
export function openLinkMessage(mySecret: Uint8Array, gift: NostrEvent, expectFrom?: string): { from: string; id: string; msg: LinkMessage } | null {
  const dm = unwrap(mySecret, gift);
  if (!dm || (expectFrom !== undefined && dm.from !== expectFrom)) return null;
  try {
    const v = JSON.parse(dm.text) as Record<string, unknown>;
    const t = v?.[MARK];
    if (typeof t !== 'string' || !TYPES.has(t) || !v.s || typeof v.s !== 'object') return null;
    return { from: dm.from, id: dm.id, msg: { t, s: v.s } as LinkMessage };
  } catch { return null; }
}
/** 나(연결 키)에게 온 겉봉만. sinceSec 는 보통 「마지막으로 본 시각 − 이틀」. */
export function linkInboxFilter(myLinkKey: string, sinceSec: number): TalkFilter {
  return { kinds: [KIND_WRAP], '#p': [myLinkKey], since: Math.max(0, Math.floor(sinceSec) - LINK_WRAP_SKEW_SEC), limit: 200 };
}
