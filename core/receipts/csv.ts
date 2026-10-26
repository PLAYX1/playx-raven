/** S1 CSV 내보내기 — 설정 0, 세액 칸 없음. 안내 문구가 첫 줄. */
import type { Receipt } from './model';
import { RECEIPT_PARAMS, CSV_NOTICE, CSV_ADDRESS_NOTICE, CSV_TOTALS_NOTICE } from './params';
import { FEE_CANDIDATES } from '../creator/fee-policy';

/** 끝 세 열(25라운드 §36) = 판 3 영수증의 적용 요율·수수료 종류·요율표 버전. 옛 판 영수증은 모름 → 빈칸. 앞 열 순서는 그대로. */
export const CSV_HEADER = ['일시', '상품', '결제수단', 'RVN', '판매자몫RVN', '플랫폼수수료RVN', '공유몫RVN', '원화환산', '시세출처', '시세시각', '환산구분', '상대주소', '거래ID', '자진표기',
  '적용요율', '수수료종류', '요율표버전'] as const;
/** 서명 확인된 일정이 없어 요율표 버전이 없음(feeTrackId = null). */
export const CSV_NO_FEE_TRACK = '서명된 일정 없음';
const feeCells = (r: Receipt): string[] => r.version !== 3 || r.appliedFeeBps === undefined ? ['', '', ''] : [
  `${r.appliedFeeBps / 100}%`, r.feeKind ? FEE_CANDIDATES[r.feeKind].label : '', r.feeTrackId ?? CSV_NO_FEE_TRACK,
];

/** sats 정수 문자열 → RVN 표기. 음수·소수·부호·빈 값은 거절(던진다) — 출금·환불은 영수증 열에 음수로 섞지 않는다. */
export function satsToRvn(sats: string): string {
  if (typeof sats !== 'string' || !/^(0|[1-9]\d*)$/.test(sats)) throw new Error('sats 는 0 이상의 정수 문자열');
  const n = BigInt(sats), u = RECEIPT_PARAMS.satsPerRvn;
  const frac = (n % u).toString().padStart(8, '0').replace(/0+$/, '');
  return (n / u).toString() + (frac ? '.' + frac : '');
}

/** 앞에 붙어 수식 시작을 가릴 수 있는 글자: 공백류·제어 문자·제로폭·BOM·방향 표시. */
const LEADING_NOISE = /^[\s\u0000-\u001f\u007f\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]+/;
/**
 * CSV 인젝션 방어. 앞의 공백·제로폭·제어 문자를 걷어낸 뒤 첫 글자가 = + - @ (전각 ＝＋－＠ 포함) 또는 탭·CR·LF 로 시작했으면 앞에 ' 를 붙인다.
 * 쉼표·따옴표·줄바꿈뿐 아니라 ; 와 탭도 따옴표로 감싼다(; 를 구분자로 읽는 지역 설정에서 「a;=1+1」이 두 칸으로 갈려 수식이 되는 것을 막는다).
 */
export function csvCell(value: string): string {
  let v = String(value);
  const head = v.replace(LEADING_NOISE, '');
  if (/^[=+\-@\uff1d\uff0b\uff0d\uff20]/.test(head) || /^[\t\r\n]/.test(v)) v = "'" + v;
  return /[",;\t\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function formatKst(ms: number): string {
  const d = new Date(ms + RECEIPT_PARAMS.csvUtcOffsetMinutes * 60_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const METHOD_KO = { rvn: 'RVN', card: '카드', cash: '현금', transfer: '계좌이체' } as const;

/** 합계 행 한 줄 = 요약 구분 + 건수 + 4개 금액 합(sats). 금액 열은 RVN 영수증만 더한다. */
type Bucket = { n: number; sats: [bigint, bigint, bigint, bigint] };
const newBucket = (): Bucket => ({ n: 0, sats: [0n, 0n, 0n, 0n] });
export type CsvTotals = { paid: Bucket; exempt: Bucket; refunded: Bucket; selfReported: number; excluded: number };
/** 수수료 면제 = 판 3 영수증에서 요율은 0 보다 큰데 수수료가 0(면제선 미만). 판 1·2 는 근거가 없어 면제로 가르지 않는다. */
const isFeeExempt = (r: Receipt): boolean => r.version === 3 && (r.appliedFeeBps ?? 0) > 0 && r.platformFeeSats === '0';
/**
 * 영수증 합계(내보내기용 요약 — 세액 계산 아님). 결제 완료·수수료 면제·환불을 따로 더하고, 취소·금액을 모르는 뼈대 영수증은 합계에서 뺀다(excluded 로 건수만).
 * 금액은 RVN 영수증의 sats 만 더한다(카드·현금·계좌이체 표기는 sats 가 없다). 자진표기는 건수만 센다(체인 확인 없음).
 */
export function receiptTotals(receipts: readonly Receipt[]): CsvTotals {
  const t: CsvTotals = { paid: newBucket(), exempt: newBucket(), refunded: newBucket(), selfReported: 0, excluded: 0 };
  for (const r of receipts) {
    if (r.selfReported) t.selfReported++;
    const unknown = r.method === 'rvn' && r.amountSats === '';
    if (r.status === 'cancelled' || r.status === 'pending' || unknown) { t.excluded++; continue; }
    const b = r.status === 'refunded' ? t.refunded : isFeeExempt(r) ? t.exempt : t.paid;
    b.n++;
    if (r.method === 'rvn') [r.amountSats, r.merchantSats, r.platformFeeSats, r.shareSats].forEach((v, i) => { b.sats[i] += BigInt(v === '' ? '0' : v); });
  }
  return t;
}
const totalsRow = (label: string, b: Bucket | null, count: number): string => {
  const cells = new Array<string>(CSV_HEADER.length).fill('');
  cells[0] = '합계'; cells[1] = `${label} ${count}건`;
  if (b) b.sats.forEach((v, i) => { cells[3 + i] = satsToRvn(v.toString()); });
  return cells.map(csvCell).join(',');
};
export function totalsLines(receipts: readonly Receipt[]): string[] {
  const t = receiptTotals(receipts);
  return [
    totalsRow('결제 완료', t.paid, t.paid.n), totalsRow('수수료 면제', t.exempt, t.exempt.n), totalsRow('환불됨', t.refunded, t.refunded.n),
    totalsRow('자진표기(체인 확인 없음)', null, t.selfReported), totalsRow('합계에서 뺀 영수증(취소·확인 대기·금액 모름)', null, t.excluded),
    csvCell(CSV_TOTALS_NOTICE),
  ];
}

/** totals: true 면 끝에 합계 행(결제 완료·면제·환불 분리, 자진표기·제외 건수)과 안내 한 줄. 기본은 끔(옛 모양 그대로). */
export function receiptsToCsv(receipts: readonly Receipt[], opts: { bom?: boolean; totals?: boolean } = {}): string {
  const rows = [...receipts].sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id)).map(r => {
    const c = r.conversion;
    const isRvn = r.method === 'rvn';
    return [
      formatKst(r.paidAt), r.productName, METHOD_KO[r.method],
      // 뼈대 영수증(skeletonOnly)의 총액·수수료·공유 몫은 모름(빈 문자열) → 빈칸. 금액을 지어내지 않는다.
      ...[r.amountSats, r.merchantSats, r.platformFeeSats, r.shareSats].map(v => (isRvn && v !== '' ? satsToRvn(v) : '')),
      c.status === 'ok' ? c.krw : '환산 없음',
      c.status === 'ok' ? c.source : '', c.status === 'ok' ? formatKst(c.quotedAt) : '',
      c.status === 'ok' ? (c.late ? '사후 환산' : '결제 시점') : c.reason,
      r.counterparty, r.txid, r.selfReported ? '예' : '아니오', ...feeCells(r),
    ].map(csvCell).join(',');
  });
  const lines = [csvCell(CSV_NOTICE), csvCell(CSV_ADDRESS_NOTICE), CSV_HEADER.join(','), ...rows, ...(opts.totals ? totalsLines(receipts) : [])];
  return (opts.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
}

export type PeriodPreset = 'thisMonth' | 'lastMonth' | 'thisYear';
/** KST 기준 [from, to) ms */
export function periodRange(preset: PeriodPreset, now: number): { from: number; to: number } {
  const off = RECEIPT_PARAMS.csvUtcOffsetMinutes * 60_000, d = new Date(now + off);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const at = (yy: number, mm: number) => Date.UTC(yy, mm, 1) - off;
  if (preset === 'thisMonth') return { from: at(y, m), to: at(y, m + 1) };
  if (preset === 'lastMonth') return { from: at(y, m - 1), to: at(y, m) };
  return { from: at(y, 0), to: at(y + 1, 0) };
}
export const inRange = (rs: readonly Receipt[], r: { from: number; to: number }): Receipt[] => rs.filter(x => x.paidAt >= r.from && x.paidAt < r.to);
