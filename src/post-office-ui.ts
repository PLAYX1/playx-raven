/* 설정 › 「우체국」 카드 + 기존 설치에 한 번 알리기. 뒤쪽 동작: src-tauri/src/post_office.rs
 *
 * 우체국 = 이 컴퓨터가 다른 사람의 잠긴 글(쪽지 겉봉·「나만·친구만」 글·열쇠 꾸러미)을 잠깐 맡았다가 전해 준다.
 * 새 설치는 켠 채 시작한다. 이미 쓰던 컴퓨터는 처음 한 번 알린 뒤에 켠다(말없이 켜지 않는다).
 * main.ts 는 `wirePostOffice()` 한 줄만 안다. 카드는 #page-settings 에 붙고 settings-nav.ts 가 「일반」 끝으로 옮긴다.
 * style="…" 속성은 쓰지 않는다(CSP nonce) — 모양은 post-office.css.
 */
import { invoke } from "@tauri-apps/api/core";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./post-office.css";

type State = { on: boolean; notice: boolean; count: number; bytes: number; outside?: boolean; announced?: boolean };
type Choose = (title: string, message: string, yes: string, alt: string) => Promise<"yes" | "alt" | null>;

export const POST_OFFICE_CARD = "post-office-card";
export const POST_OFFICE_TEXT = "우체국 — 이 컴퓨터가 다른 사람의 잠긴 글을 잠깐 맡았다가 전해 줘요. 내용은 이 컴퓨터도 못 읽어요. 사진·파일은 맡지 않아요. 끄면 맡은 글을 지우고, 내 글만 지켜요.";

const el = (id: string) => document.getElementById(id);
let state: State | null = null;

/** 「지금 맡은 글 12개 · 0.3MB」 */
export function heldLine(s: State): string {
  if (!s.on) return t("꺼져 있어요");
  const mb = s.bytes / (1024 * 1024);
  return tf("지금 맡은 글 {0}개 · {1}MB", s.count, mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10);
}

/** 다른 분들이 이 우체국을 찾을 수 있나. */
export function findLine(s: State): string {
  if (!s.outside) return t("바깥 주소가 없어 이 컴퓨터 안에서만 우체국이에요. 바깥 연결을 받으면 다른 분들이 찾을 수 있어요.");
  if (s.announced) return t("다른 분들이 찾을 수 있게 이 우체국을 알렸어요.");
  return t("이 우체국을 알리는 중이에요…");
}

function ensureCard(): HTMLElement | null {
  const page = el("page-settings");
  if (!page) return null;
  let card = el(POST_OFFICE_CARD);
  if (card) return card;
  card = document.createElement("div");
  card.id = POST_OFFICE_CARD;
  card.className = "card po-card";
  card.innerHTML = `
    <h3>${copyHtml("우체국")}</h3>
    <p class="po-what">${copyHtml(POST_OFFICE_TEXT)}</p>
    <label class="check po-switch"><span class="sx-txt"><b>${copyHtml("우체국 켜기")}</b></span><input type="checkbox" id="po-on" role="switch" /></label>
    <div class="po-status" id="po-status" role="status"></div>
    <p class="meta" id="po-find"></p>
    <div class="row po-acts" id="po-outside" hidden><button class="ghost" type="button" id="po-outside-go">${copyHtml("바깥 연결 받기")}</button></div>`;
  const share = el("relay-share-card");
  if (share && share.parentElement === page) share.before(card); else page.append(card);
  (el("po-on") as HTMLInputElement).addEventListener("change", (e) => void setOn((e.target as HTMLInputElement).checked));
  // 바깥 연결 화면(왼쪽 「바깥 연결」 표시등과 같은 곳)으로 데려간다 — 여기서 내려받거나 켜지 않는다.
  el("po-outside-go")?.addEventListener("click", () => (document.getElementById("d-out-row") as HTMLButtonElement | null)?.click());
  return card;
}

function paint(s: State) {
  state = s;
  if (!ensureCard()) return;
  const box = el("po-on") as HTMLInputElement | null;
  if (box) box.checked = s.on;
  const status = el("po-status");
  if (status) {
    setCopyText(status, () => heldLine(s));
    status.classList.toggle("ok", s.on);
  }
  const find = el("po-find");
  if (find) {
    find.hidden = !s.on;
    setCopyText(find, () => findLine(s));
  }
  const out = el("po-outside");
  if (out) out.hidden = !(s.on && !s.outside);
}

async function refresh() {
  try { paint(await invoke<State>("post_office_get")); } catch { /* 명령이 없는 판 */ }
}

async function setOn(on: boolean) {
  try { paint(await invoke<State>("post_office_set", { on })); } catch { void refresh(); }
}

/** 이미 쓰던 컴퓨터: 처음 한 번 알린다. 「알겠어요」 → 켬 · 「끄기」 → 꺼 둠 · 닫으면 다음에 다시 알린다. */
async function noticeOnce(choose: Choose) {
  if (!state?.notice) return;
  const pick = await choose(t("우체국"), t(POST_OFFICE_TEXT), t("알겠어요"), t("끄기"));
  if (pick === "yes") await setOn(true);
  else if (pick === "alt") await setOn(false);
}

/** 설정 화면에 카드를 붙이고, 설정을 열 때마다 다시 읽는다. 기존 설치면 한 번 알린다. */
export function wirePostOffice(choose: Choose) {
  if (!ensureCard()) return;
  void refresh().then(() => noticeOnce(choose));
  window.addEventListener("desktop-language-change", () => { if (state) paint(state); });
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.('nav a[data-page="settings"]');
    if (a) void refresh();
  });
}
