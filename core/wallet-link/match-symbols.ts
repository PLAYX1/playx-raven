/**
 * 연결 확인 그림(11-08) — 6자리 확인 숫자를 「모양 8 × 색 4 = 32가지」 그림 4개로 옮긴다.
 * 32^4 = 1,048,576 ≥ 1,000,000 이라 숫자와 그림은 1:1 — 숫자 대신 그림을 맞춰도 안전이 같다.
 * 폰(wt-rv-0918-phone)과 데스크탑(wt-rv-0918)의 core/wallet-link/match-symbols.ts 는 글자 하나까지 같아야 한다.
 * 색만으로 가르지 않는다(색맹 8%): 모양이 다르고, 이름(「주황 별」)을 같이 적는다.
 */
export const MATCH_SHAPES = ['star', 'moon', 'flower', 'leaf', 'heart', 'drop', 'sun', 'triangle'] as const;
export const MATCH_COLORS = ['orange', 'violet', 'green', 'blue'] as const;
export type MatchShape = (typeof MATCH_SHAPES)[number];
export type MatchColor = (typeof MATCH_COLORS)[number];
export type MatchSymbol = Readonly<{ shape: MatchShape; color: MatchColor; name: string }>;

export const MATCH_SHAPE_NAME: Readonly<Record<MatchShape, string>> = { star: '별', moon: '달', flower: '꽃', leaf: '잎', heart: '하트', drop: '물방울', sun: '해', triangle: '세모' };
export const MATCH_COLOR_NAME: Readonly<Record<MatchColor, string>> = { orange: '주황', violet: '보라', green: '초록', blue: '파랑' };
/** 밝은·어두운 바탕 모두에서 3:1 이상 보이는 색. */
export const MATCH_COLOR_HEX: Readonly<Record<MatchColor, string>> = { orange: '#E8742A', violet: '#8B6FD6', green: '#2FA36B', blue: '#3B82D6' };
/** 24×24 그림 길(한 색으로 채움). */
export const MATCH_SHAPE_PATH: Readonly<Record<MatchShape, string>> = {
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z',
  moon: 'M15.5 3a8.5 8.5 0 1 0 5.5 14.7A7 7 0 0 1 15.5 3z',
  flower: 'M12 2.5a3.6 3.6 0 1 1 0 7.2a3.6 3.6 0 1 1 0-7.2zM12 14.3a3.6 3.6 0 1 1 0 7.2a3.6 3.6 0 1 1 0-7.2zM6.1 8.4a3.6 3.6 0 1 1 0 7.2a3.6 3.6 0 1 1 0-7.2zM17.9 8.4a3.6 3.6 0 1 1 0 7.2a3.6 3.6 0 1 1 0-7.2z',
  leaf: 'M20 4C10 4 4 9 4 16c0 1.4.3 2.6.8 3.5C7 13 11 10 16 8c-4 3-7 6.5-9 11.6.9.3 1.9.4 3 .4 7 0 10-6 10-16z',
  heart: 'M12 21s-7.5-4.6-9.6-9.2C.9 8.2 3 4.5 6.6 4.5c2.1 0 3.6 1.2 5.4 3.2 1.8-2 3.3-3.2 5.4-3.2 3.6 0 5.7 3.7 4.2 7.3C19.5 16.4 12 21 12 21z',
  drop: 'M12 2.5s-6.5 7.4-6.5 12a6.5 6.5 0 0 0 13 0c0-4.6-6.5-12-6.5-12z',
  sun: 'M12 6.8a5.2 5.2 0 1 1 0 10.4a5.2 5.2 0 1 1 0-10.4zM21.3 10.3a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM18.6 16.9a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM12.0 19.6a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM5.4 16.9a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM2.7 10.3a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM5.4 3.7a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM12.0 1.0a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM18.6 3.7a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4z',
  triangle: 'M12 3l9.5 17h-19z',
};
/** 두 화면이 같은 박자로 깜빡이게 하는 주기(ms). 각 기기 시계로 맞춘다. */
export const MATCH_BEAT_MS = 1200;

/** 6자리 확인 숫자 → 그림 4개. 숫자 꼴이 아니면 null(그때는 숫자만 보인다). */
export function matchSymbols(code: string): MatchSymbol[] | null {
  if (!/^\d{6}$/.test(code)) return null;
  let n = Number(code);
  const out: MatchSymbol[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = n % 32; n = Math.floor(n / 32);
    const shape = MATCH_SHAPES[idx % 8], color = MATCH_COLORS[Math.floor(idx / 8)];
    out.unshift({ shape, color, name: `${MATCH_COLOR_NAME[color]} ${MATCH_SHAPE_NAME[shape]}` });
  }
  return out;
}
