import { SIGNED_LISTS_PUBLIC_KEYS, type ListKey, type ListsState } from '../core/signed-lists/envelope';
import { creatorListsFrom, creatorVerifiers, type CreatorLists } from '../core/signed-lists/creator-parts';
import { loadState, refreshLists, storageStore, type ListSource, type RefreshOutcome, type StateStore } from '../core/signed-lists/sources';

/*
 * 데스크탑 장터가 쓰는 제작자 허용·차단 목록 — 서명된 최신 목록(core/signed-lists, 지갑 저장소에서 바이트 그대로 복사).
 * 장터를 다시 그릴 때마다 current() 로 지금 목록을 읽고, 「목록 새로 받기」가 refresh() 를 부른다.
 *
 * 🔴 출하 데스크탑은 아직 묶음을 받아 오는 길이 없다: 웹뷰 CSP 가 connect-src 'self' 라 밖으로 못 나가고, 노드가 대신 받아 오는
 *    Rust 명령은 만들지 않았다(다음 단계). 그리고 믿는 키(SIGNED_LISTS_PUBLIC_KEYS)가 비어 있다. 그래서 출하 화면은 늘 「기본 목록」.
 *    시험은 모의 경로(sources)와 시험 키를 넣어 끝까지 돈다.
 */
export type MarketLists = { current(): CreatorLists; refresh?: () => Promise<RefreshOutcome> };

export function marketLists(o: { storage?: Storage | null; sources?: readonly ListSource[]; listKeys?: readonly ListKey[]; creatorKeys?: readonly ListKey[]; now?: () => number } = {}): MarketLists {
  const store: StateStore = storageStore(o.storage === undefined ? (() => { try { return window.localStorage; } catch { return null; } })() : o.storage);
  const keys = o.listKeys ?? SIGNED_LISTS_PUBLIC_KEYS, now = o.now ?? Date.now;
  let state: ListsState = loadState(store);
  const current = () => { try { return creatorListsFrom(state, now(), keys, undefined, o.creatorKeys); } catch { return { allowlist: null, denylist: null, source: 'builtin' as const, sequence: 0, expiresAt: null, say: '기본 목록을 쓰고 있어요.' }; } };
  if (!o.sources?.length || keys.length === 0) return { current };
  return {
    current,
    async refresh() {
      const out = await refreshLists({ state, sources: o.sources!, now, listKeys: keys, verifiers: creatorVerifiers(o.creatorKeys), store });
      state = out.state;
      return out;
    },
  };
}
