import { sha256 } from '@noble/hashes/sha256';
import { OPEN_MARKET_GAME_INDEX, bondedItemId } from '../core/creator/open-market';
import { httpSource, type FetchLike, type ListSource } from '../core/signed-lists/sources';
import type { ChainAsset } from '../core/creator/listing';
import { MARKET_FEE_ADDRESS } from '../core/creator/fee-schedule';
import type { MarketSource, BuyRequest, Prepared, MarketPurchaseDeps } from './open-market';

/*
 * 데스크탑 장터의 노드·IPFS·목록 연결(0.9.2). 화면(open-market.ts)은 이 어댑터를 통해서만 밖을 본다.
 *   · 목록 = 노드 listassets(market_list_assets) + 이 컴퓨터 IPFS 읽기(creator_cid_read) — 서버 없음.
 *   · 서명된 목록 받기(C3) = 지갑 core 의 httpSource(그대로) + 러스트 중계(market_http_get)를 FetchLike 로 감싼 어댑터. 서버 코드는 새로 만들지 않았다.
 *     믿는 키(SIGNED_LISTS_PUBLIC_KEYS)가 비어 있는 동안 marketLists() 는 이 소스를 아예 쓰지 않는다(네트워크에 묻지 않음).
 *   · 구매 = 준비(거래만 만듦) → 사람이 승인 → 전송, 두 단계(market_purchase_prepare / market_purchase_send).
 */
type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 지갑 core 와 같은 주소(core/signed-lists/boot.ts SIGNED_LISTS_URL). 러스트 중계는 이 주소 하나만 받는다(market.rs 시험이 같은 값을 지킨다). */
export const SIGNED_LISTS_URL = 'https://ravenvault.ex.erci.se/lists/signed-lists.json';

const b64 = (s: string): Uint8Array => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

export function nodeMarketSource(invoke: Invoke): MarketSource {
  return {
    async assets(pattern) { return (await invoke<ChainAsset[]>('market_list_assets', { pattern })) ?? []; },
    async fetch(cid) {
      try { const r = await invoke<{ data?: string }>('creator_cid_read', { cid, maxBytes: 25 * 1024 * 1024 }); return typeof r?.data === 'string' ? b64(r.data) : null; } catch { return null; }
    },
  };
}

/** 러스트 중계를 FetchLike 로: 웹뷰 CSP 때문에 직접 fetch 를 못 하는 데스크탑용. */
export function tauriFetch(invoke: Invoke): FetchLike {
  return async url => {
    const r = await invoke<{ ok: boolean; status: number; text: string }>('market_http_get', { url });
    return { ok: !!r?.ok, status: Number(r?.status ?? 0), text: async () => String(r?.text ?? '') };
  };
}
export const marketListSources = (invoke: Invoke): ListSource[] => [httpSource(SIGNED_LISTS_URL, tauriFetch(invoke))];

export async function nodeChainTip(invoke: Invoke): Promise<number | null> {
  try { const r = await invoke<{ height?: number | null }>('market_chain_tip'); return typeof r?.height === 'number' ? r.height : null; } catch { return null; }
}

/* ── RVDP v3 메모(계정형) — 지갑 core/game-pay/direct-pay.ts encodeMemoScript 와 같은 바이트(시험이 지갑 구현에서 뽑은 값과 대조) ─── */
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ITEM = /^[A-Za-z0-9_-]{1,16}$/, OWNER = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function memoScriptAccount(p: { gameIndex: number; itemId: string; ownerId: string; priceVersion?: number; nonce: number }): string {
  const priceVersion = p.priceVersion ?? 1;
  if (!Number.isInteger(p.gameIndex) || p.gameIndex < 0 || p.gameIndex > 0xffff || !ITEM.test(p.itemId) || !OWNER.test(p.ownerId)
    || !Number.isInteger(priceVersion) || priceVersion < 1 || priceVersion > 0xffff || !Number.isInteger(p.nonce) || p.nonce < 0 || p.nonce > 0xffffffff) throw new Error('memo-invalid');
  const body = Uint8Array.from([0x52, 0x56, 0x44, 0x50, 3, ...u16(p.gameIndex), 1, p.itemId.length, ...Array.from(p.itemId, c => c.charCodeAt(0)), ...unhex(p.ownerId.replace(/-/g, '')), ...u16(priceVersion), ...u32(p.nonce)]);
  const data = Uint8Array.from([...body, ...sha256(body).slice(0, 4)]);
  return '6a' + data.length.toString(16).padStart(2, '0') + hex(data);
}

/** 이 상품의 메모 번호·아이템 번호: 검증됨 = 허용 목록 값, 보증 = 지갑 예약값(지갑 purchaseTerms 와 같다). */
export function memoTerms(r: Pick<BuyRequest, 'asset' | 'tier' | 'gameIndex'>): { gameIndex: number; itemId: string } {
  return r.tier === 'verified' ? { gameIndex: r.gameIndex ?? 0, itemId: 'C1' } : { gameIndex: OPEN_MARKET_GAME_INDEX, itemId: bondedItemId(r.asset) };
}

const OWNER_KEY = 'rv-market-owner-v1';
/** 이 컴퓨터가 쓰는 결제 기록용 임의 번호(UUIDv4 모양). 🔴 지갑 core 가 게임 신원 키에서 만드는 주인 번호와 같지 않다 → 웹·폰 구매 이력에는 아직 합쳐지지 않는다(지갑 레인 과제). */
export function marketOwnerId(storage: Storage | null = (() => { try { return window.localStorage; } catch { return null; } })(), rand: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): string {
  try { const saved = storage?.getItem(OWNER_KEY); if (saved && OWNER.test(saved)) return saved; } catch { /* 없으면 새로 */ }
  const b = rand(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b); const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  try { storage?.setItem(OWNER_KEY, id); } catch { /* 저장 못 해도 이번 결제는 된다 */ }
  return id;
}

/** 사람이 승인한 뒤에만 send 를 부른다. 지갑이 잠겨 있으면 askPassword 로 한 번 묻고 같은 준비 번호로 다시 보낸다(러스트가 서명 전 오류에는 준비를 되살려 둔다). */
export function nodePurchase(invoke: Invoke, askPassword: () => Promise<string | null>, o: { feeAddress?: string; storage?: Storage | null; nonce?: () => number } = {}): MarketPurchaseDeps {
  return {
    async prepare(r) {
      const t = memoTerms(r);
      const ownerId = marketOwnerId(o.storage);
      const memoScript = memoScriptAccount({ ...t, ownerId, nonce: (o.nonce ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]))() });
      const p = await invoke<Omit<Prepared, 'memoScript' | 'ownerId' | 'networkFeeAtoms' | 'totalAtoms'> & { network_fee_atoms: string; total_atoms: string; seller_atoms: string; fee_atoms: string }>('market_purchase_prepare',
        { asset: r.asset, sellerAddress: r.sellerAddress, sellerAtoms: r.sellerAtoms, feeAddress: r.feeAtoms === '0' ? null : (o.feeAddress ?? MARKET_FEE_ADDRESS), feeAtoms: r.feeAtoms, memoScript });
      return { id: p.id, asset: p.asset, outputs: p.outputs, chain: p.chain, networkFeeAtoms: p.network_fee_atoms, totalAtoms: p.total_atoms, sellerAtoms: p.seller_atoms, feeAtoms: p.fee_atoms, memoScript, ownerId };
    },
    async send(p) {
      try { return await invoke<{ txid: string }>('market_purchase_send', { id: p.id }); }
      catch (e) {
        if (!/잠겨 있습니다|지갑 비밀번호|암호가 필요/.test(String((e as Error)?.message ?? e))) throw e;
        const passphrase = await askPassword();
        if (!passphrase) throw new Error('지갑 비밀번호가 필요해요. 돈은 나가지 않았어요.');
        return await invoke<{ txid: string }>('market_purchase_send', { id: p.id, passphrase });
      }
    },
    cancel() { void invoke('market_purchase_cancel').catch(() => {}); },
  };
}
