/* 설정 › 「우체국」 카드 + 기존 설치에 한 번 알리기. 뒤쪽 동작: src-tauri/src/post_office.rs
 *
 * 우체국 = 이 컴퓨터가 다른 사람의 잠긴 글(쪽지 겉봉·「나만·친구만」 글·열쇠 꾸러미)을 잠깐 맡았다가 전해 준다.
 * 11-28 대표: 「우체국은 기본으로 작동해야 한다」 — 새 설치·업데이트 모두 켠 채 시작하고, 처음 한 번 한 줄로 알린다(끌 수 있다).
 * 도우미(보통 컴퓨터)는 배터리·종량제·디스크 부족·바깥 주소 없음이면 알리기를 쉰다(뒤쪽 post_core.rs advertise_pause).
 * 「핵심 우체국(운영자)」은 고급 칸에서만 — 고정 주소가 있어야 알리고, 다른 핵심 우체국과 겉봉을 맞춘다.
 * main.ts 는 `wirePostOffice()` 한 줄만 안다. 카드는 #page-settings 에 붙고 settings-nav.ts 가 「일반」 끝으로 옮긴다.
 * style="…" 속성은 쓰지 않는다(CSP nonce) — 모양은 post-office.css.
 */
import { invoke } from "@tauri-apps/api/core";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./post-office.css";

type Peer = { url: string; pubkey: string };
type Sync = { url: string; connected: boolean; last_sync: number; sent: number; got: number; dropped: number; problem: string | null };
type State = {
  on: boolean; notice: boolean; count: number; bytes: number; outside?: boolean; announced?: boolean;
  role?: "helper" | "core"; region?: string; peers?: Peer[]; pause?: string | null; fixed?: boolean; core_sync?: Sync[] | null;
};
type Choose = (title: string, message: string, yes: string, alt: string) => Promise<"yes" | "alt" | null>;

export const POST_OFFICE_CARD = "post-office-card";
export const POST_OFFICE_TEXT = "우체국 — 이 컴퓨터가 다른 사람의 잠긴 글을 잠깐 맡았다가 전해 줘요. 내용은 이 컴퓨터도 못 읽어요. 사진·파일은 맡지 않아요. 끄면 맡은 글을 지우고, 내 글만 지켜요.";

/** 처음 한 번 알리는 한 줄(11-28 대표 문구). */
export const POST_OFFICE_NOTICE = "내 컴퓨터가 레이븐볼트 우체국이 되어 친구들의 암호 쪽지를 잠시 맡아 줘요(내용은 못 봐요) · 설정에서 끌 수 있어요";

const el = (id: string) => document.getElementById(id);
let state: State | null = null;

/** 「지금 맡은 글 12개 · 0.3MB」 */
export function heldLine(s: State): string {
  if (!s.on) return t("꺼져 있어요");
  const mb = s.bytes / (1024 * 1024);
  return tf("지금 맡은 글 {0}개 · {1}MB", s.count, mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10);
}

/** 알리기를 쉬는 까닭 → 한 줄. */
export function pauseLine(reason: string | null | undefined): string | null {
  switch (reason) {
    case "battery": return t("배터리로 도는 동안은 다른 분들께 알리지 않고 쉬어요. 전원을 꽂으면 다시 알려요.");
    case "metered": return t("데이터 요금이 드는 네트워크라 다른 분들께 알리지 않고 쉬어요.");
    case "disk": return t("디스크 여유가 적어 맡는 양을 줄이고 알리기를 쉬어요.");
    case "core-needs-fixed": return t("핵심 우체국은 바뀌지 않는 주소가 있어야 알려요. 바깥 연결에서 테일스케일 고정 주소를 받아 주세요.");
    case "unhealthy": return t("이 컴퓨터 릴레이가 아직 안 떠 있어요. 잠시 뒤 다시 알려요.");
    default: return null;
  }
}

/** 다른 분들이 이 우체국을 찾을 수 있나. */
export function findLine(s: State): string {
  if (!s.outside) return t("바깥 주소가 없어 이 컴퓨터 안에서만 우체국이에요. 바깥 연결을 받으면 다른 분들이 찾을 수 있어요.");
  const p = pauseLine(s.pause);
  if (p) return p;
  if (s.announced) return t("다른 분들이 찾을 수 있게 이 우체국을 알렸어요.");
  return t("이 우체국을 알리는 중이에요…");
}

/** 「wss://… 공개키」 한 줄에 하나. 틀린 줄은 버린다(뒤쪽이 다시 검사한다). */
export function parsePeers(text: string): Peer[] {
  return text.split(/\n+/).map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 2 && /^wss:\/\//i.test(x[0]) && /^[0-9a-f]{64}$/i.test(x[1]))
    .map(([url, pubkey]) => ({ url, pubkey: pubkey.toLowerCase() }));
}

/** 핵심 우체국 맞추기 상태 한 줄. */
export function syncLine(list: Sync[] | null | undefined): string {
  if (!list || !list.length) return t("맞출 핵심 우체국이 아직 없어요.");
  const up = list.filter((x) => x.connected).length;
  return tf("핵심 우체국 {0}곳 중 {1}곳과 이어져 있어요.", list.length, up);
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
    <div class="row po-acts" id="po-outside" hidden><button class="ghost" type="button" id="po-outside-go">${copyHtml("바깥 연결 받기")}</button></div>
    <details class="po-core" id="po-core">
      <summary>${copyHtml("핵심 우체국(운영자)")}</summary>
      <p class="meta">${copyHtml("늘 켜 두는 운영자 컴퓨터만 켜세요. 바뀌지 않는 주소가 있어야 알리고, 다른 핵심 우체국과 쪽지 겉봉을 맞춰 한 곳에 닿은 쪽지가 모든 핵심에 닿게 해요.")}</p>
      <label class="check po-switch"><span class="sx-txt"><b>${copyHtml("핵심 우체국으로 쓰기")}</b></span><input type="checkbox" id="po-core-on" role="switch" /></label>
      <label class="po-field"><span>${copyHtml("지역")}</span><input type="text" id="po-region" maxlength="32" placeholder="kr-seoul" autocomplete="off" spellcheck="false" /></label>
      <label class="po-field"><span>${copyHtml("다른 핵심 우체국(한 줄에 하나: 주소 공개키)")}</span><textarea id="po-peers" rows="3" spellcheck="false" placeholder="wss://n100.example.ts.net/api/relay 64자공개키"></textarea></label>
      <div class="row po-acts"><button class="ghost" type="button" id="po-core-save">${copyHtml("저장")}</button></div>
      <p class="meta" id="po-core-status" role="status"></p>
    </details>`;
  const share = el("relay-share-card");
  if (share && share.parentElement === page) share.before(card); else page.append(card);
  (el("po-on") as HTMLInputElement).addEventListener("change", (e) => void setOn((e.target as HTMLInputElement).checked));
  // 바깥 연결 화면(왼쪽 「바깥 연결」 표시등과 같은 곳)으로 데려간다 — 여기서 내려받거나 켜지 않는다.
  el("po-outside-go")?.addEventListener("click", () => (document.getElementById("d-out-row") as HTMLButtonElement | null)?.click());
  el("po-core-save")?.addEventListener("click", () => void saveCore());
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
  if (out) out.hidden = !(s.on && (!s.outside || s.pause === "core-needs-fixed"));
  const core = s.role === "core";
  const coreBox = el("po-core-on") as HTMLInputElement | null;
  if (coreBox) coreBox.checked = core;
  const region = el("po-region") as HTMLInputElement | null;
  if (region && document.activeElement !== region) region.value = s.region || "";
  const peers = el("po-peers") as HTMLTextAreaElement | null;
  if (peers && document.activeElement !== peers) peers.value = (s.peers || []).map((p) => `${p.url} ${p.pubkey}`).join("\n");
  const det = el("po-core") as HTMLDetailsElement | null;
  if (det && core) det.open = true;
  const cs = el("po-core-status");
  if (cs) {
    cs.hidden = !core;
    setCopyText(cs, () => (s.fixed ? "" : t("고정 주소가 아직 없어요.") + " ") + syncLine(s.core_sync));
  }
}

async function saveCore() {
  const role = (el("po-core-on") as HTMLInputElement | null)?.checked ? "core" : "helper";
  const region = (el("po-region") as HTMLInputElement | null)?.value || "";
  const peers = parsePeers((el("po-peers") as HTMLTextAreaElement | null)?.value || "");
  try {
    paint(await invoke<State>("post_office_set_role", { role, region, peers }));
  } catch (e) {
    const cs = el("po-core-status");
    if (cs) { cs.hidden = false; cs.textContent = t(String(e)); }
  }
}

async function refresh() {
  try { paint(await invoke<State>("post_office_get")); } catch { /* 명령이 없는 판 */ }
}

async function setOn(on: boolean) {
  try { paint(await invoke<State>("post_office_set", { on })); } catch { void refresh(); }
}

/** 처음 한 번 한 줄로 알린다(이미 켜져 있다). 「알겠어요」 → 그대로 켬 · 「끄기」 → 끔 · 닫으면 다음에 다시 알린다. */
async function noticeOnce(choose: Choose) {
  if (!state?.notice) return;
  const pick = await choose(t("우체국"), t(POST_OFFICE_NOTICE), t("알겠어요"), t("끄기"));
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
