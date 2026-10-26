import { hasForbiddenPhrase, squashForPhraseCheck } from '../brand/forbidden-phrases';

/*
 * 「인증·공식·보증·검증」 계열 주장 단어 거부(결정문 §29, 5/7). 가게 이름·상품 제목·위임 직함에 적용한다. 소개글·상품 설명 본문은 허용한다(§31 으로 소개글 적용 철회)
 * — 화면에서 「판매자 입력 · 미검증」 라벨과 함께 보인다. 공통 대응어: ko 인증/공식/보증/검증, en verified/official/certified,
 * ja 認証/公式/保証/検証, zh 认证/認證/官方/保证/保證/验证/驗證.
 * 비교 전 정규화(리뷰 2026-10-14): NFKC → 소문자 → 키릴·그리스 동형 문자를 라틴으로 접기 → 글자·숫자 외 전부 제거
 * (공백·소프트하이픈 U+00AD·U+2060·결합 문자 U+034F·가운뎃점·한글 채움 문자). 「공 식」「검·증」「оfficial」(키릴 о)도 잡힌다.
 * 대가: 낱말 경계가 사라져 「카페인 증정」(→카페인증정) 같은 이름도 걸린다 — 이름은 판매자가 바꿀 수 있어 닫힌 쪽을 택했다.
 */
const CLAIM_WORDS = /인증|공식|보증|검증|verif(?:y|ied|ication)|official|certif(?:y|ied|icate|ication)|guarantee|authentic|認証|認證|公式|保証|検証|认证|官方|保证|保證|验证|驗證/;
/** 흔한 키릴·그리스 동형 문자 → 라틴(소문자 기준). */
const HOMOGLYPHS: Readonly<Record<string, string>> = Object.freeze({
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v', 'һ': 'h', 'ɡ': 'g',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y', 'ϲ': 'c', 'ϳ': 'j',
});
const foldHomoglyphs = (s: string): string => Array.from(s, c => HOMOGLYPHS[c] ?? c).join('');
/** 주장 단어 비교용 정규화(테스트·다른 모듈에서 같은 규칙을 쓰도록 공개). */
export const claimKey = (s: string): string => squashForPhraseCheck(foldHomoglyphs(s.normalize('NFKC').toLowerCase()));
export const hasClaimWord = (s: string): boolean => CLAIM_WORDS.test(claimKey(s));
/** 이름·직함용: 주장 단어 또는 금지 문구(core/brand, §25)가 있으면 true. */
export const hasClaimOrForbidden = (s: string): boolean => hasClaimWord(s) || hasForbiddenPhrase(foldHomoglyphs(s.normalize('NFKC').toLowerCase()));
