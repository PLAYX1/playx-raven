/*
 * 금지 문구 점검 — 사용자에게 보이는 문구에 안전·보증·검증을 약속하는 말을 쓰지 않는다(COMMON.md).
 * 허용 예: 「서명 확인됨 · 키 지문」「서명 이후 바뀌지 않음」.
 * 공백·가운뎃점·구두점을 지우고 비교하므로 「안전한  거래」「안전한·거래」도 잡는다. 영어/일본어/중국어 대응어는 흔한 번역만 담았다(완전하지 않음).
 */
export const FORBIDDEN_PHRASES: readonly string[] = Object.freeze([
  '검증된 판매자', '정품 보증', '안전한 거래', '사기 방지', '최고의 암호화폐', '비트코인만큼 안전',
  // §25 Q2(7/7): 체인·서명이 증명하지 못하는 것(상품 진위·판매자 실명·거래 안전)을 약속하는 말
  '진품 보증', '사기 불가', '실명 확인', '안전 거래 보장',
]);
/** 번역 문구용 대응어(소문자 비교). */
export const FORBIDDEN_PHRASES_OTHER: readonly string[] = Object.freeze([
  'verified seller', 'authenticity guarantee', 'guaranteed authentic', 'safe transaction', 'safe trade', 'fraud prevention', 'scam prevention', 'best cryptocurrency', 'as safe as bitcoin',
  '認証済み販売者', '安全な取引', '詐欺防止', '正規品保証', '经过验证的卖家', '已验证卖家', '安全交易', '防诈骗', '正品保证',
]);

/** NFKC → 소문자 → 글자·숫자만 남김(공백·구두점·가운뎃점·소프트하이픈·결합 문자 등 전부 제거). 한글 채움 문자도 지운다. */
export const squashForPhraseCheck = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]|[\u115f\u1160\u3164\uffa0]/gu, '');
const squash = squashForPhraseCheck;
const ALL: readonly { phrase: string; key: string }[] = [...FORBIDDEN_PHRASES, ...FORBIDDEN_PHRASES_OTHER].map(phrase => ({ phrase, key: squash(phrase) }));

/** 문구 안에서 발견된 금지 문구 목록(중복 제거, 없으면 빈 배열). */
export function findForbiddenPhrases(text: string): string[] {
  const k = squash(text);
  return ALL.filter(p => k.includes(p.key)).map(p => p.phrase);
}
export const hasForbiddenPhrase = (text: string): boolean => findForbiddenPhrases(text).length > 0;
