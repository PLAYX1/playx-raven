/*
 * 곡 파일 형식과 「다시 받기 기간」(대표 결정 2026-10-14). 순수 함수 — 시계는 부르는 쪽이 넘긴다.
 *
 * ① 형식(format): 상품 문서 lock.files[].format(선택, 서명 범위 안). 소문자 열거만 받는다. 기본 권장은 m4a(AAC)·mp3,
 *    wav·flac 은 고음질 선택(용량이 커서 올리는 사람·받는 사람 모두 느릴 수 있다 — 화면이 그렇게 말한다).
 * ② 다시 받기 기간(downloadDays): 상품 문서 lock.downloadDays(선택, 서명 범위 안) = 「구매 후 N일까지 다시 받기 가능」.
 *    새로 올리는 곡은 판매자가 반드시 적는다(phone 올리기 흐름이 강제). 칸이 없는 옛 문서는 그대로 통과하고 화면에 「기간 미표시」.
 *    lock 칸은 상품 ID 계산에서 빠지므로(product-doc.ts productIdOf) 이 칸을 넣어도 상품 ID 는 같다.
 * ③ 기준 시각은 영수증의 paidAt(ms) — 6확인 블록 시각이 아니다. 끝 = paidAt + N×24시간(이 시각부터 닫힘).
 *
 * 순환 import 를 피하려고 shop-order/signed.ts 의 isNowMs 하한·상한을 여기에 옮겨 적었다(download-terms.test.ts 가 같은 값인지 대조).
 */

/** 받을 수 있는 형식(소문자). other = 그 밖의 소리 파일. */
export const SONG_FORMATS = Object.freeze(['m4a', 'mp3', 'wav', 'flac', 'other'] as const);
export type SongFormat = (typeof SONG_FORMATS)[number];
/** 기본 권장(작고 어디서나 열림). */
export const RECOMMENDED_SONG_FORMATS: readonly SongFormat[] = Object.freeze(['m4a', 'mp3']);
/** 고음질 선택(용량이 큼). */
export const HIGH_QUALITY_SONG_FORMATS: readonly SongFormat[] = Object.freeze(['wav', 'flac']);
export const isSongFormat = (x: unknown): x is SongFormat => typeof x === 'string' && (SONG_FORMATS as readonly string[]).includes(x);

/** 파일 이름·MIME → 형식. 모르면 other(지어내지 않는다). */
export function songFormatOf(name: string, mime = ''): SongFormat {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? ''))?.[1]?.toLowerCase() ?? '';
  if (ext === 'm4a' || ext === 'mp4') return 'm4a';
  if (ext === 'mp3' || ext === 'wav' || ext === 'flac') return ext;
  const m = String(mime ?? '').toLowerCase();
  if (m === 'audio/mp4' || m === 'audio/x-m4a' || m === 'audio/m4a') return 'm4a';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave' || m === 'audio/vnd.wave') return 'wav';
  if (m === 'audio/flac' || m === 'audio/x-flac') return 'flac';
  return 'other';
}

/**
 * 🔶 최소 보장 기간(일). 대표 결정 전 임시값. 서명 문서 검사에도 쓰인다 —
 *   ⚠ 나중에 이 값을 **올리면** 이미 서명된 더 짧은 기간 문서가 검증에 실패한다(내리는 것은 안전). 올릴 때는 올리기 화면 검사만 바꿀 것.
 */
export const DOWNLOAD_MIN_DAYS = 30;
/** 최대(10년). */
export const DOWNLOAD_MAX_DAYS = 3650;
/**
 * 🔶 올리기 화면 기본값 = 권장 90일. 근거: 30일은 휴대폰 교체·분실·여행 같은 흔한 일로 놓치기 쉽고, 1년 이상은 판매자가 파일을 그만큼
 *   계속 올려 둬야 한다(플랫폼이 보관하지 않음, §38). 90일이면 한 계절 안에 두 번째 기기로 옮길 여유가 있고 판매자 부담이 작다. 대표 결정 대기.
 */
export const DOWNLOAD_DEFAULT_DAYS = 90;
/** 올리기 화면 칩(30일·90일·1년·3년). 직접 입력도 받는다. */
export const DOWNLOAD_DAY_CHOICES: readonly number[] = Object.freeze([30, 90, 365, 1095]);
export const DAY_MS = 86_400_000;
/** 시각(ms) 하한·상한 = shop-order/signed.ts MIN_NOW_MS·MAX_TIME_MS(같은 값, 시험이 대조). 초 단위(≈1.7e9)는 하한에서 걸린다. */
export const DOWNLOAD_TIME_MIN_MS = 1_000_000_000_000;
export const DOWNLOAD_TIME_MAX_MS = 253_402_300_799_000;
const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= DOWNLOAD_TIME_MIN_MS && n <= DOWNLOAD_TIME_MAX_MS;

/** 서명 칸으로 받을 수 있는 기간인가(정수, 최소~최대). 0·음수·소수·NaN·문자열은 거절. */
export const isDownloadDays = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= DOWNLOAD_MIN_DAYS && n <= DOWNLOAD_MAX_DAYS;

export type DownloadWindow =
  | { status: 'open' | 'closed'; until: number; daysLeft: number }
  /** no-days = 문서에 기간 칸이 없음(옛 문서 → 화면 「기간 미표시」). bad-* = 값이 ms 가 아니거나 범위 밖(닫힌 판정을 내리지 않는다). */
  | { status: 'unknown'; until: null; daysLeft: null; reason: 'no-days' | 'bad-days' | 'bad-paid-at' | 'bad-clock' };

/**
 * 다시 받기 기간 판정. paidAt = 영수증 paidAt(ms), now = 지금(ms). until = paidAt + N일, now < until 이면 open, now ≥ until 이면 closed.
 * daysLeft = 남은 날(올림, open 일 때만 1 이상). 값이 이상하면(초 단위·NaN·소수) unknown — 시계 단위 혼동으로 기간을 닫지 않는다.
 */
export function downloadWindow(paidAt: unknown, downloadDays: unknown, now: unknown): DownloadWindow {
  const unknown = (reason: 'no-days' | 'bad-days' | 'bad-paid-at' | 'bad-clock'): DownloadWindow => ({ status: 'unknown', until: null, daysLeft: null, reason });
  if (downloadDays === undefined || downloadDays === null) return unknown('no-days');
  if (!isDownloadDays(downloadDays)) return unknown('bad-days');
  if (!isMs(paidAt)) return unknown('bad-paid-at');
  if (!isMs(now)) return unknown('bad-clock');
  const until = paidAt + downloadDays * DAY_MS;
  return now < until ? { status: 'open', until, daysLeft: Math.ceil((until - now) / DAY_MS) } : { status: 'closed', until, daysLeft: 0 };
}

/** 칸 모양 문제(없으면 null) — product-lock-shape 가 부른다. 칸이 없을 때는 부르지 않는다. */
export const downloadDaysProblem = (x: unknown): string | null => (isDownloadDays(x) ? null : 'download-days');
export const songFormatProblem = (x: unknown): string | null => (isSongFormat(x) ? null : 'format');
