/**
 * 11-12 첫 실행 — 라비가 **한 번만** 묻는다: 「글씨 잘 보이세요?」 (대표 승인)
 *
 *  - 세 단추(한눈에 많이 · 보통 · 크게) 안에 작은 맛보기 글이 그 크기로 보인다. 누르면 바로 바뀐다(되돌리기는 「언어 · 화면」·라비).
 *  - 「나중에」로 건너뛸 수 있다. 어느 쪽이든 **다시는 묻지 않는다**(카드를 띄운 순간 기억한다).
 *  - 이미 글자 크기를 고른 사람·라비 첫 인사를 끈 사람(rv-ravi-start-off)에게는 묻지 않는다.
 *  - 라비가 내려앉은 뒤(afterRaviLanding)에만. 다른 라비 카드·「짜잔!」 시작 인사가 떠 있으면 사라질 때까지 기다린다(카드는 한 장뿐 — 덮어쓰지 않는다).
 *  - 팝업(창)이 아니라 라비 카드다 — 첫 실행 비행 막(check-firstrun)의 「창 없음」 약속을 지킨다.
 */
import { raviCardKey, showRaviCard } from "./ravi-card";
import { setTextSize, textSizeChosen, TEXT_SIZE_NAME, TEXT_SIZES } from "./text-size";

export const TEXT_ASK_KEY = "ravenvault-text-size-asked";
const GREETING_OFF = "rv-ravi-start-off";
const PREVIEW = "가나다 12.5"; // 세 단추 같은 글 — 크기만 다르다(CSS data-look).

export type AskStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
/** 물어야 하나 — 아직 안 물었고, 고른 적도 없고, 라비 첫 인사가 켜져 있을 때만. */
export function shouldAskTextSize(store: AskStore, chosen: boolean): boolean {
  try {
    if (store.getItem(TEXT_ASK_KEY) === "1") return false;
    if (chosen) { store.setItem(TEXT_ASK_KEY, "1"); return false; }
    if (store.getItem(GREETING_OFF) === "1") return false;
    return true;
  } catch { return false; }
}

/** 라비가 내려앉은 뒤 부른다. delay 뒤 한 번, 다른 카드가 있으면 15초마다 다시 본다(최대 10분). */
export function askTextSizeOnce(t: (s: string) => string, delay = 3500): void {
  let store: AskStore;
  try { store = localStorage; } catch { return; }
  if (!shouldAskTextSize(store, textSizeChosen())) return;
  let tries = 0;
  const attempt = () => {
    if (!shouldAskTextSize(store, textSizeChosen())) return;
    // 다른 라비 카드나 「짜잔!」 시작 인사(.ravi-arrival)가 떠 있으면 겹치지 않게 기다린다.
    const busy = !!raviCardKey() || !!document.querySelector(".ravi-arrival");
    if (busy) { if (++tries < 80) window.setTimeout(attempt, raviCardKey() ? 15000 : 2000); return; }
    try { store.setItem(TEXT_ASK_KEY, "1"); } catch { /* 이번 실행만 */ }
    showRaviCard({
      key: "ask:text",
      title: t("글씨 잘 보이세요?"),
      body: t("눌러 보시면 바로 바뀌어요. 나중에 「언어 · 화면」이나 라비에게 「글자 크게」라고 해도 돼요."),
      buttons: [
        ...TEXT_SIZES.map((v) => ({ label: TEXT_SIZE_NAME[v], preview: t(PREVIEW), look: v, primary: v === "normal", run: () => { void setTextSize(v); } })),
        { label: "나중에", run: () => {} },
      ],
    });
  };
  window.setTimeout(attempt, delay);
}
