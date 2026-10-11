// 0.9.0 「이야기」 이름표 — 시안 ~/rv-design-089/mockups/talk.html, 설계안 ~/Desktop/레이븐볼트-방·초대·공유-설계안.md §3-3·3-4.
// main.ts 에는 연결 줄만 둔다(레인 충돌 최소화). 모양은 src/talk-identity.css.
//
// ① 첫 진입 「이름을 정해 주세요」 카드 — 내 이름표가 아직 없을 때 한 번. 「나중에 할게요」를 누르면 다시 안 뜬다.
// ② 🔴 저장 결과를 정직하게: talk_profile_set 은 서명한 이름표(kind 0 이벤트)를 돌려준다. 릴레이 네 곳이 모두
//    받지 않으면 오류다(nostrpub.rs). 이벤트 id 가 돌아온 경우만 「저장했어요」, 아니면 실패로 적는다.
// ③ 내 글에도 내 이름과 아이콘(라비 캐릭터)을 단다 — 대표 결정 2026-10-12(이전 「카톡식, 내 글엔 이름 없음」을 뒤집음).
// ④ 「내 색」은 없앴다(내 표시는 이름 + 라비 캐릭터로 충분, 색은 대비를 깨뜨릴 수 있음). 옛 저장값은 지운다.
// ⑤ 「내 소개」의 이름 칸·이야기의 「내 이름」·설정 「이야기에서 쓰는 이름」은 같은 이름표 하나다.
import { t, tf } from "./i18n";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type NameSaveResult = { ok: true; name: string } | { ok: false; error: string };

const LATER_KEY = "rv-talk-name-later";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const errOf = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message ? String((e as Error).message) : t("알 수 없는 오류"));

function character(): string {
  try { return localStorage.getItem("rv-ravi-character") || "basic"; } catch { return "basic"; }
}

/** 내 이름표 얼굴(라비 캐릭터). 캐릭터별 바탕·색은 CSS(data-ravi-char)가 칠한다 — style 속성은 CSP 가 막는다. */
export function myFaceHtml(): string {
  return `<span class="rv-myface" data-ravi-char="${esc(character())}" aria-hidden="true"><img src="/ravi/face.webp" alt="" /></span>`;
}

/** 내 글 머리 — 「김무송 · 나」 + 아이콘. 이름이 없으면 「나」만. */
export function myHeadHtml(name: string): string {
  const shown = name.trim();
  return `<div class="who me">` + (shown ? `<span translate="no">${esc(shown)}</span><span class="tk-me-tag">· ${esc(t("나"))}</span>` : `<span>${esc(t("나"))}</span>`) + myFaceHtml() + `</div>`;
}

/** 지금 알고 있는 내 이름을 이름이 보이는 자리에 적는다(설정 「이야기에서 쓰는 이름」·첫 진입 카드 칸). */
export function setMyTalkName(name: string): void {
  const v = document.getElementById("sx-talkname-v");
  if (v) v.textContent = name || t("아직 없음");
  const input = document.getElementById("tk-nc-name") as HTMLInputElement | null;
  if (input && !input.value) input.value = name;
}

/** 이름표 저장. 결과를 확인한 것만 성공이다. */
export async function saveTalkName(invoke: Invoke, name: string, about = "", picture = ""): Promise<NameSaveResult> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: t("이름을 적어 주세요") };
  try {
    const ev = await invoke<unknown>("talk_profile_set", { name: clean, about, picture });
    const id = ev && typeof ev === "object" ? (ev as { id?: unknown }).id : null;
    if (typeof id !== "string" || !id) return { ok: false, error: t("이름이 저장됐는지 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.") };
    setMyTalkName(clean);
    return { ok: true, name: clean };
  } catch (e) {
    return { ok: false, error: errOf(e) };
  }
}

function later(): boolean {
  try { return localStorage.getItem(LATER_KEY) === "1"; } catch { return false; }
}

/** 이야기 화면에서 내 이름표를 읽은 뒤 부른다. known=false(릴레이에서 못 읽음)면 카드를 띄우지 않는다 — 있는 이름을 또 묻지 않는다. */
export function nameCardAfterMe(known: boolean, name: string): void {
  setMyTalkName(name);
  const card = document.getElementById("tk-namecard");
  if (!card) return;
  const show = known && !name.trim() && !later();
  if (card.dataset.state === "saved") return;
  card.hidden = !show;
  // 카드에 같은 규칙 세 줄이 있다 — 아래 띠까지 겹쳐 띄우지 않는다.
  if (show) { const first = document.getElementById("tk-first"); if (first) first.hidden = true; }
  const face = document.getElementById("tk-nc-face");
  if (face) face.dataset.raviChar = character();
}

function say(kind: "ok" | "bad" | "", text: string): void {
  const msg = document.getElementById("tk-nc-msg");
  if (!msg) return;
  msg.textContent = text;
  msg.className = "tk-nc-msg" + (kind ? " " + kind : "");
  msg.setAttribute("role", kind === "bad" ? "alert" : "status");
}

/** 첫 진입 카드 단추를 잇는다. onSaved 는 저장이 확인된 뒤에만 불린다(머리줄·글 목록 다시 그리기). */
export function wireTalkIdentity(deps: { invoke: Invoke; current: () => { about?: string; picture?: string } | null; onSaved: (name: string) => void }): void {
  try { localStorage.removeItem("rv-profile-color"); } catch { /* 지울 수 없어도 쓰는 곳이 없다 */ }
  const card = document.getElementById("tk-namecard");
  const input = document.getElementById("tk-nc-name") as HTMLInputElement | null;
  const save = document.getElementById("tk-nc-save") as HTMLButtonElement | null;
  if (!card || !input || !save) return;
  const go = async () => {
    save.disabled = true;
    say("", t("올리는 중…"));
    const now = deps.current();
    const r = await saveTalkName(deps.invoke, input.value, String(now?.about || ""), String(now?.picture || ""));
    save.disabled = false;
    if (!r.ok) { say("bad", tf("이름을 저장하지 못했어요: {0}", r.error)); input.focus(); return; }
    card.dataset.state = "saved";
    say("ok", tf("이름을 저장했어요. 이제 글에 「{0}」(으)로 보여요.", r.name));
    save.hidden = true;
    const skip = document.getElementById("tk-nc-later");
    if (skip) skip.textContent = t("닫기");
    deps.onSaved(r.name);
  };
  save.addEventListener("click", () => void go());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void go(); } });
  document.getElementById("tk-nc-later")?.addEventListener("click", () => {
    if (card.dataset.state !== "saved") { try { localStorage.setItem(LATER_KEY, "1"); } catch { /* 이번 판만 닫힌다 */ } }
    card.hidden = true;
    document.getElementById("tk-text")?.focus();
  });
}
