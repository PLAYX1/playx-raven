import { plain } from './bytes';
import { fileLocationProblem, type CipherLocation } from './media-ref';
import { PRODUCT_LOCK_KINDS } from './product-lock-shape';

/* 상품 문서의 선택 미리듣기 칸. 파일 위치 규칙은 media-ref.ts 와 공유한다. */
export const PREVIEW_MIN_SECONDS = 1;
export const PREVIEW_MAX_SECONDS = 120;
/** 120초 44.1kHz 16bit 스테레오 WAV ≈ 21.2MB 를 덮는 값. 대표 결정 전 임시값 🔶 */
export const PREVIEW_MAX_FILE_BYTES = 32 * 1024 * 1024;

export type ProductPreview = { seconds: number; cipher?: CipherLocation };

/** 모양 문제를 영문 코드로 돌려준다(없으면 null). */
export function productPreviewProblem(x: unknown, kind?: string): string | null {
  if (kind !== undefined && !PRODUCT_LOCK_KINDS.includes(kind)) return 'kind';
  if (!plain(x)) return 'keys';
  const keys = Object.keys(x).sort().join();
  if (keys !== 'seconds' && keys !== 'cipher,seconds') return 'keys';
  if (typeof x.seconds !== 'number' || !Number.isSafeInteger(x.seconds) || x.seconds < PREVIEW_MIN_SECONDS || x.seconds > PREVIEW_MAX_SECONDS) return 'seconds';
  return 'cipher' in x ? fileLocationProblem(x.cipher, n => n >= 1 && n <= PREVIEW_MAX_FILE_BYTES) : null;
}
