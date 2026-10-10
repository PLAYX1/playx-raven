// 창 크기로 표시 방식 고르기(설계 + 순수 판단 — 아직 창에 배선하지 않음, docs/design/window-modes.md §자동 전환).
// 대표: 「창을 작게 줄이면 자동으로 작은 모드가 반영되게 하면 되지 않나?」
//
// 규칙
//   1. 폭·높이(논리 px) 문턱으로 큰 → 중간 → 작은(S/M/L) → 칩. 들어갈 때와 나올 때 문턱을 다르게(히스테리시스 24px) — 문턱 근처에서 깜박이지 않게.
//   2. 사람이 핀(고정)한 모드가 있으면 자동은 손대지 않는다.
//   3. 돈·보안 화면(보내기 검토·확인, 복구 단어, 비밀번호, 서명 대기) 진행 중이면 **모드를 바꾸지 않는다** — 큰 창 안에서 「안전 축소」(같은 화면을 세로 한 줄로)만.
//      입력·확인을 잃지 않기 위해서다. 그 화면을 벗어나면 다음 크기 변화 때 다시 판단.
//   4. 전환 자체는 짧은 크로스페이드(160ms ease-out), 움직임 줄이기면 즉시.
export type Tier = "large" | "medium" | "mini-l" | "mini-m" | "mini-s" | "chip";

// 아래로 내려갈 때의 문턱(이 값보다 작아지면 한 칸 아래로). 위로 올라갈 때는 + HYST.
export const DOWN: Record<Exclude<Tier, "chip">, { w: number; h: number }> = {
  large: { w: 960, h: 560 },   // 큰 창: 사이드바 + 두 칸
  medium: { w: 600, h: 420 },  // 중간: 사이드바를 아이콘 줄로, 한 칸
  "mini-l": { w: 340, h: 240 },
  "mini-m": { w: 280, h: 120 },
  "mini-s": { w: 200, h: 52 },
};
export const HYST = 24;
const ORDER: Tier[] = ["large", "medium", "mini-l", "mini-m", "mini-s", "chip"];

function fits(t: Tier, w: number, h: number, pad: number): boolean {
  if (t === "chip") return true;
  const d = DOWN[t];
  return w >= d.w + pad && h >= d.h + pad;
}

/** 지금 크기에 맞는 단계. prev 가 있으면 히스테리시스: 내려갈 때는 문턱 그대로, 올라갈 때는 문턱 + HYST. */
export function tierFor(w: number, h: number, prev?: Tier): Tier {
  const pi = prev ? ORDER.indexOf(prev) : -1;
  for (const [i, t] of ORDER.entries()) {
    const pad = pi >= 0 && i < pi ? HYST : 0; // 지금보다 큰 단계로 가려면 여유가 더 있어야
    if (fits(t, w, h, pad)) return t;
  }
  return "chip";
}

export type AutoInput = { w: number; h: number; prev: Tier; pinned: Tier | null; sensitive: boolean };
export type AutoOut = { tier: Tier; safeShrink: boolean; reason: "pinned" | "sensitive" | "auto" | "same" };

export function decide(i: AutoInput): AutoOut {
  if (i.pinned) return { tier: i.pinned, safeShrink: false, reason: "pinned" };
  const next = tierFor(i.w, i.h, i.prev);
  if (i.sensitive && next !== i.prev) {
    // 돈·보안 화면: 모드는 그대로, 큰/중간 창 안에서 한 줄 배치로만 줄인다.
    return { tier: i.prev, safeShrink: ORDER.indexOf(next) > ORDER.indexOf(i.prev), reason: "sensitive" };
  }
  return { tier: next, safeShrink: false, reason: next === i.prev ? "same" : "auto" };
}

/** 단계별로 보이는 정보(우선순위 순). 문서·갤러리와 같은 표. */
export const PRIORITY: Record<Tier, string[]> = {
  large: ["잔액", "알림·할 일", "최근 거래", "라비", "가게 매출", "더 보기"],
  medium: ["잔액", "알림·할 일", "최근 거래 3", "라비(작게)"],
  "mini-l": ["잔액", "들어오는 중", "최근 변화 4", "노드", "잠금·깨움", "오늘 판매(판매자)"],
  "mini-m": ["잔액", "최근 변화 3", "노드"],
  "mini-s": ["상태 점", "잔액 또는 새 소식 N"],
  chip: ["상태 점", "잔액(가림이면 ••••)"],
};
