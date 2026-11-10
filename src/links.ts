/** 사람이 열거나 공유하는 링크는 여기서만 만든다. 정본 주소는 ravenvault.ex.erci.se 한 곳.
 * (rvn.ex.erci.se 는 옛 웹 지갑이다 — 업데이트·API 용으로만 남아 있고 사람에게 주지 않는다.) */
export const RAVENVAULT_ORIGIN = "https://ravenvault.ex.erci.se";

/** 이야기 방 초대 링크. 담는 것은 방 번호뿐 — 대화 내용·열쇠는 절대 담지 않는다.
 * 11-10: 방 번호(64자리)면 폰과 같은 `/t/<번호>` — 카톡·텔레그램에 붙이면 방 이름 미리보기 카드가 뜬다(release-site/og/t-page.mjs).
 * 옛 `/wallet/?room=` 링크는 웹앱이 계속 연다(이미 퍼진 링크). */
export function inviteLink(room: string | number | null | undefined): string {
  const id = room === null || room === undefined ? "" : String(room).trim();
  if (/^[0-9a-fA-F]{64}$/.test(id)) return `${RAVENVAULT_ORIGIN}/t/${id.toLowerCase()}`;
  return id ? `${RAVENVAULT_ORIGIN}/wallet/?room=${encodeURIComponent(id)}` : `${RAVENVAULT_ORIGIN}/wallet/`;
}
