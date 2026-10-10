import { CREATOR_ALLOWLIST_PUBLIC_KEYS, verifyCreatorAllowlist, verifyCreatorDenylist, type CreatorAllowlist, type CreatorDenylist } from '../creator/listing';
import { currentLists, type CurrentLists, type ListKey, type ListsState, type PartVerifiers } from './envelope';

/*
 * 제작자 장터 허용·차단 목록을 서명된 최신 묶음에서 꺼낸다(지갑·데스크탑 공용, 데스크탑은 바이트 그대로 복사).
 * 안쪽 서명은 원래 도메인(RAVENVAULT-CREATOR-ALLOWLIST-V1 / -DENYLIST-V1)과 원래 검사기(listing.ts)를 그대로 쓴다.
 *
 * 차단 우선: listing.ts judgeListing 이 차단을 허용보다 먼저 본다. 같은 묶음의 허용·차단을 함께 넘기므로
 * 「허용 목록에 있는데 차단 목록에도 있는」 상품은 숨는다(시험).
 * 만료: 허용 목록은 기본값(내장 = 없음)으로 돌아가고, **차단 목록은 마지막으로 검증된 것을 유지**한다 —
 * 만료가 「차단 풀림」이 되면 공격자가 새 목록 전달만 막아 차단을 풀 수 있기 때문이다.
 */

export const creatorVerifiers = (builtinKeys: readonly ListKey[] = CREATOR_ALLOWLIST_PUBLIC_KEYS): PartVerifiers => ({
  creatorAllowlist: { builtinKeys, verify: (doc, sig, keys) => verifyCreatorAllowlist(doc, sig, keys) },
  creatorDenylist: { builtinKeys, verify: (doc, sig, keys) => verifyCreatorDenylist(doc, sig, keys) },
});

export type CreatorLists = {
  allowlist: CreatorAllowlist | null; denylist: CreatorDenylist | null;
  source: CurrentLists['source']; sequence: number; expiresAt: string | null;
  /** 화면 한 줄(원인 → 지금 무엇을 쓰나). */
  say: string;
};

/** 지금 장터 판정에 쓸 허용·차단 목록. builtin 은 내장 기본값(지금은 둘 다 없음). */
export function creatorListsFrom(state: ListsState, now: number, listKeys: readonly ListKey[],
  builtin: { allowlist: CreatorAllowlist | null; denylist: CreatorDenylist | null } = { allowlist: null, denylist: null },
  builtinPartKeys: readonly ListKey[] = CREATOR_ALLOWLIST_PUBLIC_KEYS): CreatorLists {
  const c = currentLists(state, now, listKeys, creatorVerifiers(builtinPartKeys));
  if (c.source === 'builtin') return { ...builtin, source: 'builtin', sequence: c.sequence, expiresAt: null, say: '기본 목록을 쓰고 있어요(받은 최신 목록 없음).' };
  const allow = (c.values.creatorAllowlist ?? null) as CreatorAllowlist | null;
  const deny = (c.values.creatorDenylist ?? null) as CreatorDenylist | null;
  if (c.source === 'expired') return { allowlist: builtin.allowlist, denylist: deny ?? builtin.denylist, source: 'expired', sequence: c.sequence, expiresAt: c.expiresAt,
    say: `최신 목록(${c.sequence}번)의 기한이 지났어요. 「검증됨」은 기본 목록으로 돌아가고, 차단은 그대로 지켜요. 새 목록을 받으면 다시 적용해요.` };
  return { allowlist: allow, denylist: deny, source: 'update', sequence: c.sequence, expiresAt: c.expiresAt, say: `최신 목록 ${c.sequence}번을 쓰고 있어요.` };
}
