import { plain } from '../creator/bytes';
import { MAX_BUNDLE_BYTES, applyBundle, parseState, type ApplyResult, type ListKey, type ListsState, type PartVerifiers, type RejectReason } from './envelope';

/*
 * 서명된 최신 목록을 **어디서** 받나 — 바꿔 끼울 수 있는 어댑터. 전달 경로는 믿지 않는다(서명이 전부다).
 *   ① httpSource   : 지갑 사이트 정적 파일(예: https://ravenvault.ex.erci.se/lists/signed-lists.json, 같은 출처라 CSP 변경 없음)
 *   ② ipfsSource   : IPFS 포인터 파일 {format:'rv-signed-lists-pointer', cid} → 게이트웨이에서 그 CID 를 받는다(선택).
 *                    포인터는 서명이 없다 — 틀린 포인터는 「옛 묶음(되돌림 거절)」이나 「못 받음」이 될 뿐 목록을 바꾸지 못한다.
 * 서버·DB 없음. 크기 상한·시간 제한을 둔다. 실패하면 다음 경로를 시도하고, 다 실패하면 **상태를 바꾸지 않는다**.
 */

export type FetchLike = (url: string, init?: { signal?: AbortSignal; cache?: string; credentials?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export interface ListSource { readonly id: string; get(): Promise<string> }

export const POINTER_FORMAT = 'rv-signed-lists-pointer';
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

async function getText(fetchImpl: FetchLike, url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs + 50));
    const res = await Promise.race([fetchImpl(url, { signal: ctl?.signal, cache: 'no-store', credentials: 'omit' }), timeout]);
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await Promise.race([res.text(), timeout]);
    if (text.length > maxBytes) throw new Error('too-large');
    return text;
  } finally { clearTimeout(timer); }
}

export function httpSource(url: string, fetchImpl: FetchLike, opts: { timeoutMs?: number; maxBytes?: number } = {}): ListSource {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('https only');
  return { id: 'http:' + u.origin + u.pathname, get: () => getText(fetchImpl, url, opts.timeoutMs ?? 15_000, opts.maxBytes ?? MAX_BUNDLE_BYTES) };
}

/** pointerUrl 의 {cid} 를 읽고 gateway(cid) 에서 묶음을 받는다. 게이트웨이는 https 만. */
export function ipfsSource(pointerUrl: string, gateway: (cid: string) => string, fetchImpl: FetchLike, opts: { timeoutMs?: number } = {}): ListSource {
  const pointer = httpSource(pointerUrl, fetchImpl, { timeoutMs: opts.timeoutMs, maxBytes: 4096 });
  return {
    id: 'ipfs:' + pointerUrl,
    async get() {
      const p = JSON.parse(await pointer.get());
      if (!plain(p) || p.format !== POINTER_FORMAT || typeof p.cid !== 'string' || !CID.test(p.cid)) throw new Error('pointer');
      return httpSource(gateway(p.cid), fetchImpl, { timeoutMs: opts.timeoutMs ?? 30_000 }).get();
    },
  };
}

export interface StateStore { load(): string | null; save(text: string): void }
/** localStorage 같은 저장소. 읽기·쓰기 실패는 조용히 넘긴다(그러면 내장 기본값·이번 실행 동안의 상태만 쓴다). */
export function storageStore(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null, key = 'rv-signed-lists-v1'): StateStore {
  return {
    load() { try { return storage?.getItem(key) ?? null; } catch { return null; } },
    save(text) { try { storage?.setItem(key, text); } catch { /* 저장 못 해도 이번 실행은 계속 */ } },
  };
}

export type RefreshOutcome = { applied: boolean; changed: boolean; source: string | null; tried: Array<{ source: string; reason: RejectReason | 'ok'; detail?: string }>; state: ListsState };

/**
 * 갱신 한 번: 경로를 차례로 시도해 처음으로 **적용 가능한** 묶음을 쓴다. 못 받거나(network)·거절되면 다음 경로.
 * 전부 실패하면 상태는 그대로(마지막으로 검증된 목록 유지). 바뀌었으면 저장한다.
 */
export async function refreshLists(p: { state: ListsState; sources: readonly ListSource[]; now: () => number; listKeys: readonly ListKey[]; verifiers: PartVerifiers; store?: StateStore | null }): Promise<RefreshOutcome> {
  const tried: RefreshOutcome['tried'] = [];
  for (const src of p.sources) {
    let text: string;
    try { text = await src.get(); } catch (e) { tried.push({ source: src.id, reason: 'network', detail: String((e as Error)?.message ?? e).slice(0, 80) }); continue; }
    const r: ApplyResult = applyBundle(p.state, text, p.now(), p.listKeys, p.verifiers);
    if (r.applied) {
      tried.push({ source: src.id, reason: 'ok' });
      if (r.changed) p.store?.save(JSON.stringify(r.state));
      return { applied: true, changed: r.changed, source: src.id, tried, state: r.state };
    }
    tried.push({ source: src.id, reason: r.reason, detail: r.detail });
  }
  return { applied: false, changed: false, source: null, tried, state: p.state };
}

export const loadState = (store: StateStore | null | undefined): ListsState => parseState(store?.load() ?? null);
