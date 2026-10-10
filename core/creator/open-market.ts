import { DRAFT_PLATFORM_FEE_BPS, splitPrice } from '../game-registry/platform-fee';
import { atomsToRvn, sha256Hex, utf8 } from './bytes';
import { checkCreatorAssetName, BURN_RVN, CREATOR_ASSET_PREFIX } from './asset-name';
import { CONTENT_TYPES, checkFiles, type FileInput } from './limits';
import { checkFileBytes, type CreatorManifest, type TicketSection } from './manifest';

/*
 * 열린 장터(누구나 판매) — 신뢰 3층의 규칙·상수 한 곳.
 *
 *   (a) 미검증   : 체인에서 찾았고 매니페스트 서명·형식이 맞음. 보기·외부 링크만. 지갑 결제·신원 없음.
 *   (b) 보증     : (a) + 루트 자산(체인 규칙상 등록 때 500 RVN 소각) + 자동 점검 통과 + 수수료 선언 = 지갑 요율 + 가격 상한 이하
 *                  + 실행 코드가 아닌 종류(게임 제외) → **결제 허용 + 경고 배지**. 수수료 출력은 지갑이 강제. 신원·세이브 연결 없음.
 *   (c) 검증됨   : 대표가 서명한 허용 목록과 정확히 일치 → 신원·세이브 연결 허용, 게임은 지갑 안(샌드박스 iframe)에서 열림.
 *   차단         : 대표가 서명한 차단 목록(deny)에 자산 또는 제작자 주소가 있으면 어느 층이든 목록에서 숨김.
 *
 * 🔴 소각 500 RVN 은 **수익이 아니라 보증(스팸·사칭 비용)**이다. 아무도 받지 않는다. 사기를 「막는」 장치도 아니다(아래 위험 참고).
 * 🔴 판매 스위치 OPEN_MARKET_SALES_ENABLED 는 꺼져 있다. 꺼진 동안 (b)·(c) 어느 쪽도 구매 거래를 만들지 않는다(purchase.ts).
 */

/** 판매 수수료율 — 수수료 규약 v4 의 초안 상수(platform-fee.ts DRAFT_PLATFORM_FEE_BPS) 한 곳에서 온다. 여기서 숫자를 다시 적지 않는다. */
export const OPEN_MARKET_FEE_BPS = DRAFT_PLATFORM_FEE_BPS;
/** 🔴 판매 스위치(대표 결정). false 인 동안 제작자 상품 구매 거래는 만들지 않는다. 시험만 salesEnabled 로 연다. */
export const OPEN_MARKET_SALES_ENABLED = false;
/** (b)층 구매 메모의 gameIndex. 허용 목록(0..0xfffd)·게임 등록부와 겹치지 않는 영구 예약 번호. 0xffff 는 시험 데모 게임. */
export const OPEN_MARKET_GAME_INDEX = 0xfffe;
/** (b)층 한 건 가격 상한(초안, 대표 결정). 보증 500 RVN 보다 큰 돈을 미검증 제작자에게 한 번에 보내지 않게 한다. */
export const BONDED_MAX_PRICE_ATOMS = 1000n * 100_000_000n;
/** 자동 점검이 한 상품에서 내려받는 최대 바이트(이보다 크면 점검하지 않고 결제도 열지 않는다). */
export const AUTO_CHECK_MAX_BYTES = 400 * 1024 * 1024;

export const BOND_SAY = `보증 ${BURN_RVN.root} RVN 은 수수료가 아니에요. 등록할 때 소각되어 아무도(레이븐볼트도) 받지 않아요. 아무나 마구 올리거나 남의 이름을 흉내 내기 어렵게 만드는 보증이에요. 판매자가 정직하다는 보장은 아니에요.`;
export const BONDED_BADGE = '보증 · 미검증';
export const BONDED_WARNING = '레이븐볼트가 내용을 검토하지 않은 판매자예요. 자동 점검과 보증만 통과했어요. 환불·배송·입장 책임은 판매자에게 있고, 레이븐볼트는 돈을 맡지 않아 대신 돌려줄 수 없어요.';

/** (b)층 구매의 아이템 번호 = 자산 이름에 묶인 짧은 해시. 메모가 어느 상품의 구매인지 체인에 남긴다(같은 판매자의 다른 상품과 섞이지 않는다). */
export const bondedItemId = (asset: string) => 'A' + sha256Hex(utf8('rv-open-item-v1:' + asset)).slice(0, 12);

/* ── 수수료 안내(마법사 ③⑤·구매 확인 화면이 같은 문구를 쓴다) ─────────────── */

export type FeeNotice = { feeBps: number; percent: string; lines: string[]; example: { priceRvn: string; sellerRvn: string; feeRvn: string }; mine: { sellerRvn: string; feeRvn: string } | null };
/** 「판매될 때마다 N% 가 자동 분리되고 나머지가 내 주소로 직접」 + 예시 300 → 255/45 + (가격이 있으면) 내 가격의 계산. */
export function feeNotice(priceAtoms: string | null, feeBps: number = OPEN_MARKET_FEE_BPS): FeeNotice {
  const percent = (feeBps / 100).toString();
  const ex = splitPrice(300n * 100_000_000n, feeBps);
  let mine: FeeNotice['mine'] = null;
  if (priceAtoms) { try { const s = splitPrice(priceAtoms, feeBps); mine = { sellerRvn: atomsToRvn(s.sellerAtoms), feeRvn: atomsToRvn(s.feeAtoms) }; } catch { mine = null; } }
  const lines = [
    `판매될 때마다 ${percent}%(초안)가 레이븐볼트 수수료로 자동으로 나뉘고, 나머지는 내 받는 주소로 바로 들어와요. 레이븐볼트가 돈을 맡아 두지 않아요.`,
    `예: 300 RVN 에 팔리면 → 나 ${atomsToRvn(ex.sellerAtoms)} RVN · 수수료 ${atomsToRvn(ex.feeAtoms)} RVN`,
    ...(mine ? [`내 가격 ${atomsToRvn(BigInt(priceAtoms!))} RVN 이면 → 나 ${mine.sellerRvn} RVN · 수수료 ${mine.feeRvn} RVN`] : []),
    `수수료는 판매 대금에서만 나뉘어요. 등록 때 내는 보증 ${BURN_RVN.root} RVN 과는 다른 돈이에요.`,
  ];
  return { feeBps, percent, lines, example: { priceRvn: '300', sellerRvn: atomsToRvn(ex.sellerAtoms), feeRvn: atomsToRvn(ex.feeAtoms) }, mine };
}

/* ── 자동 점검(구매자 지갑이 상세 화면에서 한다) ─────────────────────────── */

export type AutoCheck = { status: 'pass' | 'warn' | 'fail'; problems: string[]; warnings: string[]; bytes: number };
/**
 * 매니페스트가 가리키는 모든 파일을 받아 (1) 크기·SHA-256 이 매니페스트와 같은지, (2) 올리기 때와 같은 파일 검사(확장자·MIME·머리·위험 무늬)를
 * 다시 한다. 받지 못하거나 다르면 fail(결제 없음). 위험 무늬는 warn(결제는 되지만 경고를 보인다).
 * 🔴 자동 점검은 「모양」을 확인할 뿐 「정직」을 확인하지 못한다(가짜 미리듣기·없는 행사는 못 잡는다).
 */
export async function autoCheck(manifest: CreatorManifest, fetchFile: (cid: string) => Promise<Uint8Array | null>): Promise<AutoCheck> {
  const all = [...manifest.files.map(f => ({ f, role: 'content' as const })), ...(manifest.cover ? [{ f: manifest.cover, role: 'cover' as const }] : [])];
  const total = all.reduce((n, x) => n + x.f.size, 0);
  if (total > AUTO_CHECK_MAX_BYTES) return { status: 'fail', problems: ['파일이 너무 커서 자동 점검을 하지 않았어요.'], warnings: [], bytes: 0 };
  const inputs: FileInput[] = [], problems: string[] = [];
  let bytes = 0;
  for (const { f, role } of all) {
    let b: Uint8Array | null = null;
    try { b = await fetchFile(f.cid); } catch { b = null; }
    if (!b) { problems.push(`${f.path}: 지금 받을 수 없어요.`); continue; }
    try { checkFileBytes(f, b); } catch { problems.push(`${f.path}: 받은 내용이 매니페스트와 달라요.`); continue; }
    bytes += b.length;
    inputs.push({ path: f.path, bytes: b, mime: f.mime, role });
  }
  if (!problems.length) {
    const c = checkFiles(manifest.type, inputs);
    problems.push(...c.problems.map(p => (p.path ? `${p.path}: ` : '') + p.say));
    const warnings = c.warnings.map(w => (w.path ? `${w.path}: ` : '') + w.say);
    if (!problems.length) return { status: warnings.length ? 'warn' : 'pass', problems, warnings, bytes };
  }
  return { status: 'fail', problems, warnings: [], bytes };
}

/* ── (b)층 판정 ───────────────────────────────────────────────────────── */

export type BondBlocker = 'not-root' | 'runs-code' | 'free' | 'fee-mismatch' | 'price-cap' | 'event-started' | 'auto-check-pending' | 'auto-check-failed';
export const BOND_BLOCKER_SAY: Readonly<Record<BondBlocker, string>> = Object.freeze({
  'not-root': '보증(루트 등록)이 없는 이름이에요.',
  'runs-code': '게임처럼 코드를 실행하는 상품은 검증된 뒤에만 결제할 수 있어요.',
  free: '무료 상품이에요.',
  'fee-mismatch': '판매자가 선언한 수수료율이 지갑 수수료율과 달라요.',
  'price-cap': '검증 전 판매자의 한 건 가격 상한을 넘어요.',
  'event-started': '행사가 이미 시작했어요.',
  'auto-check-pending': '자동 점검 전이에요. 상세 화면에서 점검해요.',
  'auto-check-failed': '자동 점검을 통과하지 못했어요.',
});
/** (b)층으로 결제를 열면 안 되는 이유 목록. 빈 배열이면 (b) 결제 가능. 구매 직전에 purchase.ts 가 한 번 더 부른다(상태 값을 믿지 않는다). */
export function bondBlockers(m: CreatorManifest, asset: string, check: AutoCheck | null, now: number, prefix: string = CREATOR_ASSET_PREFIX): BondBlocker[] {
  const out: BondBlocker[] = [];
  const name = checkCreatorAssetName(asset, prefix, { type: m.type });
  if (!name.valid || name.kind !== 'root') out.push('not-root');
  if (!CONTENT_TYPES[m.type].bondedPayment) out.push('runs-code');
  if (m.price === null) out.push('free');
  if (m.fee.declaredBps !== OPEN_MARKET_FEE_BPS) out.push('fee-mismatch');
  if (m.price !== null && BigInt(m.price.atoms) > BONDED_MAX_PRICE_ATOMS) out.push('price-cap');
  if (m.type === 'ticket' && now >= Date.parse((m.details as TicketSection).startsAt)) out.push('event-started');
  if (check === null) out.push('auto-check-pending');
  else if (check.status === 'fail') out.push('auto-check-failed');
  return out;
}

/** 구매 확인 화면에 그릴 금액(수수료 분리). 판매자 몫은 판매자 받는 주소로, 수수료는 서명된 등록부의 수수료 주소로 — 한 거래 안에서. */
export function purchaseSummary(m: CreatorManifest, feeBps: number = OPEN_MARKET_FEE_BPS) {
  if (!m.price) return null;
  const s = splitPrice(m.price.atoms, feeBps);
  return { priceRvn: atomsToRvn(s.priceAtoms), sellerRvn: atomsToRvn(s.sellerAtoms), feeRvn: atomsToRvn(s.feeAtoms), feeBps, sellerAddress: m.creator.receivingAddress,
    lines: [`판매자에게 ${atomsToRvn(s.sellerAtoms)} RVN (받는 주소 ${m.creator.receivingAddress})`, `레이븐볼트 수수료 ${atomsToRvn(s.feeAtoms)} RVN (${feeBps / 100}%)`, `합계 ${atomsToRvn(s.priceAtoms)} RVN + 네트워크 수수료`] };
}
