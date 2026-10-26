import { hex } from './bytes';
import { decodeBase58Check } from '../wallet-offline/base58check';
import { splitPrice } from '../game-registry/platform-fee';
import { MARKET_FEE_BPS_CEILING } from './fee-schedule';
import { OPEN_MARKET_GAME_INDEX, bondedItemId } from './open-market';
import type { CreatorManifest } from './manifest';
import type { PaymentVerifier } from './lock';

/*
 * 판매자 쪽 「이 거래가 내 상품의 결제인가」 — 열람 요청 처리(lock.ts processLockRequest)에 넣는 검사기.
 *
 * 지갑 저장소에서는 시험이 purchase.ts verifyCreatorPayment(수수료 일정까지 다시 계산)를 같은 자리에 넣어 이 검사기와 나란히 돌린다.
 * 이 파일은 purchase.ts·직접 결제 부품(game-pay)에 기대지 않아 데스크탑 저장소가 그대로 복사해 쓴다.
 *
 * 판매자 보호 기준만 본다 — 구매자가 낸 돈이 **판매자 몫의 최저선**(가격 − 코드 천장 요율 수수료) 이상이고, 이 상품의 메모가 정확히 하나.
 *   · 수수료 주소 출력이 제대로 갔는지는 플랫폼의 몫이라 보지 않는다(판매자는 자기 몫만 받았으면 된다).
 *   · 받는 곳: 매니페스트 creator.receivingAddress 의 P2PKH 출력이 정확히 1개.
 *   · 메모: RVDP v3 메모 정확히 1개, gameIndex 가 허용 목록에 있고 상품 번호(itemId)가 이 상품과 같다
 *     (보증층 = bondedItemId(asset), 검증됨 = CREATOR_ITEM_ID 'C1'  — purchase.ts CREATOR_ITEM_ID 와 같은 값, 시험이 대조).
 */
export const LOCK_VERIFIED_ITEM_ID = 'C1';
export const p2pkhScriptHex = (address: string): string => '76a914' + hex(decodeBase58Check(address).hash160) + '88ac';

/** RVDP 메모(OP_RETURN) 스크립트에서 gameIndex·itemId 를 읽는다. 이 모양이 아니면 null. */
export function parseMemo(scriptHex: string): { gameIndex: number; itemId: string } | null {
  try {
    if (!/^6a[0-9a-f]+$/.test(scriptHex) || scriptHex.length % 2) return null;
    const len = parseInt(scriptHex.slice(2, 4), 16);
    if (len > 75 || scriptHex.length !== 4 + len * 2) return null;
    const b = Uint8Array.from(scriptHex.slice(4).match(/../g) ?? [], h => parseInt(h, 16));
    if (b.length < 11 || b[0] !== 0x52 || b[1] !== 0x56 || b[2] !== 0x44 || b[3] !== 0x50 || b[4] !== 3) return null;
    const gameIndex = (b[5] << 8) | b[6];
    const idLen = b[8];
    if (9 + idLen > b.length) return null;
    return { gameIndex, itemId: String.fromCharCode(...b.subarray(9, 9 + idLen)) };
  } catch { return null; }
}

export function sellerSharePayment(p: { manifest: CreatorManifest; gameIndexes: readonly number[] }): PaymentVerifier {
  return tx => {
    const price = p.manifest.price;
    if (!price) return { ok: false, reason: 'no-price' };
    const memos = tx.outputs.filter(o => o.scriptHex.startsWith('6a'));
    if (memos.length !== 1) return { ok: false, reason: 'memo-missing' };
    const memo = parseMemo(memos[0].scriptHex);
    if (!memo || !p.gameIndexes.includes(memo.gameIndex)) return { ok: false, reason: 'memo-other-product' };
    const want = memo.gameIndex === OPEN_MARKET_GAME_INDEX ? bondedItemId(p.manifest.asset) : LOCK_VERIFIED_ITEM_ID;
    if (memo.itemId !== want) return { ok: false, reason: 'memo-other-product' };
    let sellerScript: string;
    try { sellerScript = p2pkhScriptHex(p.manifest.creator.receivingAddress); } catch { return { ok: false, reason: 'seller-address' }; }
    const pays = tx.outputs.filter(o => o.scriptHex === sellerScript);
    if (pays.length === 0) return { ok: false, reason: 'no-seller-output' };
    if (pays.length > 1) return { ok: false, reason: 'ambiguous-seller' };
    let floor: bigint;
    try { floor = splitPrice(price.atoms, MARKET_FEE_BPS_CEILING).sellerAtoms; } catch { return { ok: false, reason: 'price' }; }
    if (BigInt(pays[0].atoms) < floor) return { ok: false, reason: 'underpaid' };
    return { ok: true };
  };
}
