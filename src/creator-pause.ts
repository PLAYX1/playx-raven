/*
 * 「내 상품 올리기」(옛 `RV.<종류>.<이름>` 체인 자산 발행) 임시 잠금 — 대표 결정 2026-10-14.
 * 새 발행 방식(지갑 core publish-route · 새 이름 규칙)으로 옮기는 동안 데스크탑에서 새로 올리기·등록을 막는다.
 * 막는 것: 파일 올리기·서명(준비)·체인 등록(마법사 ⑥⑦, 끌어놓기 「발행」). 그대로 두는 것: 이미 올린 상품 보기·장터 읽기·검증·구매·열람 처리.
 * 되돌리기: 아래 상수 하나를 false 로. (core 쪽 옛 이름 차단 legacyIssueGuard 는 이 상수와 별개로 늘 켜져 있다.)
 */
export const CREATOR_PUBLISH_PAUSED: boolean = true;

/** 사람에게 보이는 안내(어르신도 읽을 수 있게 — 기술 용어 없음). */
export const CREATOR_PAUSE_SAY = '새 발행 방식으로 옮기는 중이라 지금은 상품 올리기를 잠시 사용할 수 없어요. 이미 올린 상품을 보거나 사는 것은 그대로 할 수 있어요.';
export const CREATOR_PAUSE_NEXT = '준비가 끝나면 다시 열려요.';

/** 잠금 안내 한 줄(마법사·끌어놓기 화면 공용). 잠금이 꺼져 있으면 null. */
export function pauseNotice(doc: Document, id: string, paused: boolean = CREATOR_PUBLISH_PAUSED): HTMLElement | null {
  if (!paused) return null;
  const p = doc.createElement('p');
  p.id = id; p.className = 'creator-bad cw-paused'; p.setAttribute('role', 'status');
  p.textContent = `${CREATOR_PAUSE_SAY} ${CREATOR_PAUSE_NEXT}`;
  return p;
}
