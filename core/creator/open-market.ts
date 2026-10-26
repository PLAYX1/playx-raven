import { splitPrice } from '../game-registry/platform-fee';
import { OPEN_MARKET_SALES_ENABLED } from './mainnet-switches';
import {
  BLOCKS_PER_DAY, MARKET_SCHEDULE_ID, activeFeeSchedule, bpsPercent, estimateHeight, heightDateKo, manifestFeeRef, marketRate, policySchedule, ruleFor,
  type FeeSchedule, type MarketRate, type RateReason, type SellerRef,
} from './fee-schedule';
import type { ContentType } from './limits';
import { atomsToRvn, sha256Hex, utf8 } from './bytes';
import { checkCreatorAssetName, BURN_RVN, CREATOR_ASSET_PREFIX } from './asset-name';
import { CONTENT_TYPES, checkFiles, type FileInput } from './limits';
import { checkFileBytes, type CreatorManifest, type TicketSection } from './manifest';

/*
 * 열린 장터(누구나 판매) — 신뢰 3층의 규칙·상수 한 곳.
 *
 *   (a) 미검증   : 체인에서 찾았고 매니페스트 서명·형식이 맞음. 보기·외부 링크만. 지갑 결제·신원 없음.
 *   (b) 보증     : (a) + 루트 자산(체인 규칙상 등록 때 500 RVN 소각) + 자동 점검 통과 + 수수료 칸 = 서명된 일정 참조(옛 선언은 호환 규칙) + 가격 상한 이하
 *                  + 실행 코드가 아닌 종류(게임 제외) → **결제 허용 + 경고 배지**. 수수료 출력은 지갑이 강제. 신원·세이브 연결 없음.
 *   (c) 검증됨   : 대표가 서명한 허용 목록과 정확히 일치 → 신원·세이브 연결 허용, 게임은 지갑 안(샌드박스 iframe)에서 열림.
 *   차단         : 대표가 서명한 차단 목록(deny)에 자산 또는 제작자 주소가 있으면 어느 층이든 목록에서 숨김.
 *
 * 🔴 소각 500 RVN 은 **수익이 아니라 보증(스팸·사칭 비용)**이다. 아무도 받지 않는다. 사기를 「막는」 장치도 아니다(아래 위험 참고).
 * 🔴 판매 스위치 OPEN_MARKET_SALES_ENABLED 는 꺼져 있다. 꺼진 동안 (b)·(c) 어느 쪽도 구매 거래를 만들지 않는다(purchase.ts).
 */

/* 판매 수수료율은 상수가 아니다 — 서명된 수수료 일정(fee-schedule.ts)에서 구매 시점(체인 높이)마다 계산한다. 15% 초안 상수는 없앴다(2026-10-11). */
/** 🔴 판매 스위치(대표 결정). false 인 동안 제작자 상품 구매 거래는 만들지 않는다. 시험만 salesEnabled 로 연다. 상수는 mainnet-switches.ts 한 곳. */
export { OPEN_MARKET_SALES_ENABLED };
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

/* ── 수수료 안내(마법사 안내·③⑤⑦·구매 확인 화면이 같은 문구를 쓴다) — 숫자는 전부 일정에서 ─────── */

const REASON_SAY: Record<RateReason, string> = { free: '(무료 기간)', founder: '(창립 판매자)', volume: '(한 해 판매 100만 RVN 초과 판매자)', base: '', 'listed-ceiling': '(이 상품에 정한 요율)' };
const months = (blocks: number) => Math.round(blocks / BLOCKS_PER_DAY / 30.4);
const splitRvn = (priceAtoms: bigint | string, bps: number) => { const x = splitPrice(priceAtoms, bps); return { sellerRvn: atomsToRvn(x.sellerAtoms), feeRvn: atomsToRvn(x.feeAtoms) }; };

/** 일정의 규칙 한 줄(종류별). 일정이 바뀌면 문구가 따라 바뀐다. */
export function scheduleRulesLine(s: FeeSchedule, kind: ContentType | null): string {
  const r = kind ? ruleFor(s, kind) : s.rules['*'];
  const first = r.freeBlocks > 0 ? `시작 뒤 약 ${months(r.freeBlocks)}개월 수수료 0%, 그 뒤 ${bpsPercent(r.bps)}%` : `${kind === 'ticket' ? '티켓은 ' : ''}무료 기간 없이 처음부터 ${bpsPercent(r.bps)}%`;
  const parts = [first];
  if (r.volume) parts.push(`한 해 판매가 ${Number(atomsToRvn(s.volume.thresholdAtoms)).toLocaleString('en-US')} RVN 을 넘은 판매자는 ${bpsPercent(s.volume.bps)}%(서명된 목록에 오른 뒤부터, 1월 1일마다 새로)`);
  if (r.founders && s.founders.blocks > 0) parts.push(`창립 판매자는 무료 기간 뒤 ${months(s.founders.blocks)}개월 ${bpsPercent(s.founders.bps)}%`);
  parts.push(`한 상품 수수료는 최대 ${atomsToRvn(r.capAtoms)} RVN`);
  return '규칙: ' + parts.join(' · ') + '.';
}

export type FeeNotice = {
  /** 서명된 일정을 받았나. false 면 정책 출발값으로 규칙만 알리고 판매는 닫혀 있다. */
  scheduled: boolean;
  feeBps: number | null; percent: string | null; reason: RateReason | 'before-launch' | null;
  /** 지금 높이를 체인에서 받았나(chain) 시각으로 어림했나(estimate). */
  heightBasis: 'chain' | 'estimate' | null;
  next: { height: number; bps: number; percent: string; date: string } | null;
  lines: string[];
  example: { priceRvn: string; sellerRvn: string; feeRvn: string; later: { sellerRvn: string; feeRvn: string } | null };
  mine: { sellerRvn: string; feeRvn: string; later: { sellerRvn: string; feeRvn: string } | null } | null;
};
export type FeeNoticeOptions = { schedule?: FeeSchedule | null; kind?: ContentType | null; seller?: SellerRef | null; height?: number | null; now?: number };

/**
 * 「지금 N% · 몇 월 며칠 무렵부터 M%」 + 예시 300 RVN + (가격이 있으면) 내 가격 계산 + 규칙 한 줄 + 보증과 다른 돈.
 * schedule 기본 = 지금 쓰는 일정(activeFeeSchedule). height 가 없으면 일정의 시작 시각으로 어림하고 「예상」이라 적는다.
 */
export function feeNotice(priceAtoms: string | null, o: FeeNoticeOptions = {}): FeeNotice {
  const schedule = o.schedule === undefined ? activeFeeSchedule() : o.schedule;
  const kind = o.kind ?? null, seller = o.seller ?? null;
  const ex = 300n * 100_000_000n;
  const priceOk = (() => { try { return priceAtoms !== null && BigInt(priceAtoms) > 0n; } catch { return false; } })();
  const tail = `수수료는 판매 대금에서만 나뉘어요. 등록 때 내는 보증 ${BURN_RVN.root} RVN 과는 다른 돈이에요.`;
  const SPLIT = '판매될 때마다 수수료가 자동으로 나뉘고, 나머지는 내 받는 주소로 바로 들어와요. 레이븐볼트가 돈을 맡아 두지 않아요.';
  if (!schedule) {
    const t = policySchedule({ launchHeight: 1, launchTimeNote: '2026-01-01T00:00:00Z' });
    const r = kind ? ruleFor(t, kind) : t.rules['*'];
    const later = splitRvn(ex, r.bps);
    const free = r.freeBlocks > 0;
    let mine: FeeNotice['mine'] = null;
    if (priceOk) { try { const l = splitRvn(priceAtoms!, r.bps); mine = { ...(free ? { sellerRvn: atomsToRvn(priceAtoms!), feeRvn: '0' } : l), later: free ? l : null }; } catch { mine = null; } }
    const ex0 = free ? `무료 기간에는 나 300 RVN · 수수료 0 RVN, 그 뒤 나 ${later.sellerRvn} RVN · 수수료 ${later.feeRvn} RVN` : `나 ${later.sellerRvn} RVN · 수수료 ${later.feeRvn} RVN`;
    return { scheduled: false, feeBps: null, percent: null, reason: null, heightBasis: null, next: null,
      lines: ['수수료 일정을 아직 받지 못했어요 → 판매는 서명된 수수료 일정을 받은 뒤 열려요(시작일도 그 일정이 알려요).', SPLIT,
        `예: 300 RVN 에 팔리면 → ${ex0}`,
        ...(mine ? [`내 가격 ${atomsToRvn(priceAtoms!)} RVN 이면 → ${free ? `무료 기간에는 나 ${mine.sellerRvn} RVN · 수수료 0 RVN, 그 뒤 나 ${mine.later!.sellerRvn} RVN · 수수료 ${mine.later!.feeRvn} RVN` : `나 ${mine.sellerRvn} RVN · 수수료 ${mine.feeRvn} RVN`}`] : []),
        scheduleRulesLine(t, kind), tail],
      example: { priceRvn: '300', sellerRvn: free ? '300' : later.sellerRvn, feeRvn: free ? '0' : later.feeRvn, later: free ? later : null }, mine };
  }
  const basis: 'chain' | 'estimate' = o.height !== null && o.height !== undefined ? 'chain' : 'estimate';
  const height = basis === 'chain' ? o.height! : estimateHeight(schedule, o.now ?? Date.now());
  // 종류를 모르면(안내 첫 화면) 공통 규칙 '*' 을 쓴다 — 'digital' 은 따로 규칙이 없으면 '*' 와 같다.
  const rateAt = (h: number, price: bigint | string): MarketRate => marketRate({ schedule, kind: kind ?? 'digital', seller, height: h, priceAtoms: price });
  const beforeLaunch = height < schedule.launch.height;
  const h0 = beforeLaunch ? schedule.launch.height : height;
  const nowRate = rateAt(h0, ex);
  const next = nowRate.nextChange ? { ...nowRate.nextChange, percent: bpsPercent(nowRate.nextChange.bps), date: heightDateKo(schedule, nowRate.nextChange.height) } : null;
  const exNow = splitRvn(ex, nowRate.bps), exLater = next ? splitRvn(ex, rateAt(next.height, ex).bps) : null;
  let mine: FeeNotice['mine'] = null;
  if (priceOk) {
    try {
      const m = rateAt(h0, priceAtoms!);
      mine = { ...splitRvn(priceAtoms!, m.bps), later: m.nextChange ? splitRvn(priceAtoms!, m.nextChange.bps) : null };
    } catch { mine = null; }
  }
  const est = basis === 'estimate' ? ' 무렵(예상)' : ' 무렵';
  const head = beforeLaunch
    ? `장터 시작 전이에요 → ${heightDateKo(schedule, schedule.launch.height)}${est}(블록 ${schedule.launch.height})부터 수수료 ${bpsPercent(nowRate.bps)}%${REASON_SAY[nowRate.reason] ? ' ' + REASON_SAY[nowRate.reason] : ''}`
    : `지금 수수료 ${bpsPercent(nowRate.bps)}%${REASON_SAY[nowRate.reason] ? ' ' + REASON_SAY[nowRate.reason] : ''}`;
  const lines = [
    head + (next ? ` → ${next.date}${est}(블록 ${next.height})부터 ${next.percent}%` : '') + '.',
    SPLIT,
    `예: 300 RVN 에 팔리면 → ${beforeLaunch ? '시작하면' : '지금'} 나 ${exNow.sellerRvn} RVN · 수수료 ${exNow.feeRvn} RVN` + (exLater && next ? ` / ${next.date}부터 나 ${exLater.sellerRvn} RVN · 수수료 ${exLater.feeRvn} RVN` : ''),
    ...(mine ? [`내 가격 ${atomsToRvn(priceAtoms!)} RVN 이면 → 나 ${mine.sellerRvn} RVN · 수수료 ${mine.feeRvn} RVN` + (mine.later && next ? ` / ${next.date}부터 나 ${mine.later.sellerRvn} RVN · 수수료 ${mine.later.feeRvn} RVN` : '')] : []),
    scheduleRulesLine(schedule, kind),
    `기간은 체인 블록 높이로 정해요(기기 시계를 쓰지 않아요). 날짜는 1분 = 1블록으로 어림한 ${basis === 'estimate' ? '예상' : '안내'}이에요.`,
    tail,
  ];
  return { scheduled: true, feeBps: nowRate.bps, percent: bpsPercent(nowRate.bps), reason: beforeLaunch ? 'before-launch' : nowRate.reason, heightBasis: basis, next, lines,
    example: { priceRvn: '300', ...exNow, later: exLater }, mine };
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
  'fee-mismatch': '이 상품의 수수료 칸이 레이븐볼트 수수료 일정과 맞지 않아요(모르는 일정이거나 옛 선언 요율이 너무 낮아요).',
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
  const ref = manifestFeeRef(m.fee);
  if (!ref.ok || ref.scheduleId !== MARKET_SCHEDULE_ID) out.push('fee-mismatch');
  if (m.price !== null && BigInt(m.price.atoms) > BONDED_MAX_PRICE_ATOMS) out.push('price-cap');
  if (m.type === 'ticket' && now >= Date.parse((m.details as TicketSection).startsAt)) out.push('event-started');
  if (check === null) out.push('auto-check-pending');
  else if (check.status === 'fail') out.push('auto-check-failed');
  return out;
}

/**
 * 구매 확인 화면에 그릴 금액(수수료 분리). feeBps = 구매 시점(체인 높이)에 일정에서 계산한 요율(purchase.ts purchaseRate / 화면은 marketRate).
 * 판매자 몫은 판매자 받는 주소로, 수수료는 레이븐볼트 수수료 주소(코드 고정)로 — 한 거래 안에서. 0% 면 수수료 출력이 없다.
 */
export function purchaseSummary(m: CreatorManifest, feeBps: number) {
  if (!m.price) return null;
  const s = splitPrice(m.price.atoms, feeBps);
  return { priceRvn: atomsToRvn(s.priceAtoms), sellerRvn: atomsToRvn(s.sellerAtoms), feeRvn: atomsToRvn(s.feeAtoms), feeBps, sellerAddress: m.creator.receivingAddress,
    lines: [`판매자에게 ${atomsToRvn(s.sellerAtoms)} RVN (받는 주소 ${m.creator.receivingAddress})`,
      feeBps === 0 ? '레이븐볼트 수수료 0 RVN (0% — 수수료 출력 없음, 메모에 구매 기록은 남아요)' : `레이븐볼트 수수료 ${atomsToRvn(s.feeAtoms)} RVN (${bpsPercent(feeBps)}%)`,
      `합계 ${atomsToRvn(s.priceAtoms)} RVN + 네트워크 수수료`] };
}

/** 가격 칸 표시: 가격 없는 상품은 「무료」(일정의 freePrice 가 false 인 종류는 목록에서 숨긴다 — listing.ts). */
export const priceLabel = (m: CreatorManifest) => (m.price ? `${atomsToRvn(m.price.atoms)} RVN` : '무료');
