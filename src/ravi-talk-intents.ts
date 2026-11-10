/**
 * 11-10 라비(라비+ 없이)가 알아듣는 이야기 말 — 페이블 순서 ③ 「알림·공유를 라비 말로 묶기」.
 *
 *  - 「연락 왔어?」「알림 있어?」 → 새 답글·부름을 확인해 「연락이 왔어요」 카드
 *  - 「○○ 방 열어 줘」「광장 보여 줘」 → 그 방을 연다
 *  - 「시끄러워」「이 방 알림 꺼」 → 지금 방 알림 끄기(바로 + 되돌리기)
 *  - 「이 방 공유」「친구 초대」 → 초대하기(링크 복사·QR) 상자
 * 라비는 **열고 준비만** 한다. 글·쪽지를 대신 보내는 말은 없다(영구 금지 — 보내기는 사람).
 */
export type RaviTalkIntent =
  | { kind: "notices" }
  | { kind: "open"; room: string } // room = "" 이면 광장
  | { kind: "mute"; off: boolean }
  | { kind: "share" };

const norm = (q: string) => q.replace(/\s+/g, " ").trim();
const NOTICES = /연락\s?(왔|온\s?거|있)|알림\s?(있|왔|확인|봐)|새\s?(글|소식)\s?(있|왔)|답글\s?(왔|있|달렸)|누가\s?(나|날|저)를?\s?불렀|any (new )?(messages|notifications)|did anyone (reply|write)/i;
const MUTE_OFF = /시끄러|시끄럽|조용히\s?해|(이\s?)?방\s?알림\s?(꺼|끄|없애)|mute (this )?room/i;
const MUTE_ON = /(이\s?)?방\s?알림\s?(켜|다시)|unmute (this )?room/i;
const SHARE = /(이\s?)?방\s?(공유|초대|링크)|초대\s?(링크|해|하기)|친구\s?(데려|불러|초대)|share (this )?room|invite/i;
const SQUARE = /^(광장|피드|모두의\s?글|레이븐\s?이야기)\s?(열어|보여|가|들어)/;
const OPEN = /^(.{1,24}?)\s?(방|대화방|채팅방)(으로|에)?\s?(열어|보여|가|들어가|들어|가자|이동)/;

export function raviTalkIntent(q: string): RaviTalkIntent | null {
  const s = norm(q);
  if (!s || s.length > 60) return null;
  if (MUTE_ON.test(s)) return { kind: "mute", off: false };
  if (MUTE_OFF.test(s)) return { kind: "mute", off: true };
  if (SHARE.test(s)) return { kind: "share" };
  if (NOTICES.test(s)) return { kind: "notices" };
  if (SQUARE.test(s)) return { kind: "open", room: "" };
  const m = OPEN.exec(s);
  if (m) {
    const name = m[1].replace(/^(이|그|저)\s/, "").trim();
    if (name && !/^(이|그|저|무슨|어느|새|내)$/.test(name)) return { kind: "open", room: name };
  }
  return null;
}

/** 방 이름 찾기: 같으면 그것, 아니면 들어 있는 것 하나. 여럿·없음이면 null 과 후보. */
export function findRoom(names: Map<string, string>, want: string): { id: string | null; candidates: string[] } {
  const w = want.replace(/\s+/g, "").toLowerCase();
  const all = [...names.entries()];
  const exact = all.filter(([, n]) => n.replace(/\s+/g, "").toLowerCase() === w);
  if (exact.length === 1) return { id: exact[0][0], candidates: [] };
  const part = all.filter(([, n]) => n.replace(/\s+/g, "").toLowerCase().includes(w));
  if (part.length === 1) return { id: part[0][0], candidates: [] };
  return { id: null, candidates: part.slice(0, 4).map(([, n]) => n) };
}
