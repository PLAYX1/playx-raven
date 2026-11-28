/* 0.9.60 복구 단어 판별 규칙 — 글자만 본다(단어장은 부르는 쪽이 준다). 화면·DOM·파일 읽기 없음.
 * 폰·웹(~/wt-rv-060-site)과 같은 규칙: 번호·쉼표·줄바꿈을 지우고, BIP39 영어 단어장 낱말이 연속 12개 이상.
 * 설명은 seed-leak.ts 맨 위. */

/** 이 수 이상 이어지면 경고한다. 폰·웹과 같은 값. */
export const SEED_RUN_MIN = 12;
/** 받는 쪽 한 줄(쪽지). */
export const NEVER_ASKS = "레이븐볼트는 복구 단어나 비밀번호를 절대 묻지 않습니다";

/** 번호·쉼표·줄바꿈을 지운 낱말들. 소문자로 바꾼다(다른 글자가 섞인 낱말은 그대로 남아 줄을 끊는다). */
export function seedTokens(text: string): string[] {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    // 번호(1. 2) ③…), 쉼표·마침표·쌍점·괄호·따옴표·하이픈·밑줄·빗금·가운뎃점 → 띄어쓰기
    .replace(/[0-9\u2460-\u24ff.,;:!?()[\]{}<>"'`~\-_/\\|·•*#=+@&%$^]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** 단어장 낱말이 가장 길게 이어진 수. */
export function seedRunLength(text: string, list: ReadonlySet<string>): number {
  let best = 0, run = 0;
  for (const w of seedTokens(text)) {
    if (list.has(w)) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}
