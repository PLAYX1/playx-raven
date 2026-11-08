// 11-08 기여 표시 — 이름표에 **서명으로 걸린** 레이븐코인 주소의 체인 사실 + 노드·릴레이 지킴이(kind 8, docs/KEEPER-THANKS.md).
// 폰 core/talk/badges.ts 와 같은 이름·같은 규칙. 계산·검증은 러스트(src-tauri/src/badges.rs)가 한다 — 여기는 그리기만.
//
// 🔴 지키는 것
//  - 주소는 `talk_profiles` 가 준 `rvn_address`(서명 확인된 것)만 러스트에 넘긴다.
//  - 「있다」는 `ok === true` 일 때만. 모르거나 읽는 중이면 아무것도 안 붙이고, 접지도 않는다.
//  - 모양은 src/talk-badges.css — style="" 은 CSP 가 막는다.
import { t, tf } from "./i18n";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Badge = "miner" | "creator" | "node" | "relay";
export const BADGES: readonly Badge[] = ["miner", "creator", "node", "relay"];

type Part = { ok?: boolean; unknown?: boolean; blocks?: number; lastAt?: number | null; assets?: string[]; days?: number };
type Info = { address?: string; miner?: Part; creator?: Part; node?: Part; relay?: Part };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TTL = 6 * 60 * 60 * 1000;
const FAIL_TTL = 5 * 60 * 1000;

const known = new Map<string, { at: number; addr: string; info: Info }>();
const inflight = new Set<string>();

export const BADGE_LABEL: Record<Badge, string> = { miner: "채굴 기여", creator: "창작자", node: "노드 지킴이", relay: "릴레이 지킴이" };
const GATE_CHOICE: Record<Badge | "", string> = { "": "누구나", miner: "채굴 기여 표시 있는 분", creator: "창작자 표시 있는 분", node: "노드 지킴이", relay: "릴레이 지킴이" };
const GATE_LOCKED: Record<Badge, string> = {
  miner: "채굴 기여 표시가 있는 분이 글을 써요. 읽기는 누구나 돼요.",
  creator: "창작자 표시가 있는 분이 글을 써요. 읽기는 누구나 돼요.",
  node: "노드 지킴이 표시가 있는 분이 글을 써요. 읽기는 누구나 돼요.",
  relay: "릴레이 지킴이 표시가 있는 분이 글을 써요. 읽기는 누구나 돼요.",
};
const NO_ADDRESS = "이름표에 레이븐코인 주소를 걸면 표시를 확인할 수 있어요.";
const NOTE = "기여 표시는 신원 확인이 아니에요. 체인 기록으로 누구나 확인할 수 있는 사실만 보여 줘요.";
const POOL_NOTE = "풀 채굴 보상은 아직 표시하지 않아요.";

export function cleanGate(g: unknown): Badge | "" {
  return g === "miner" || g === "creator" || g === "node" || g === "relay" ? g : "";
}

/* ── 아이콘: 라비 결 B(보라 두 톤 + 주황 한 점). 파란 체크가 아니다. ── */
const ICON: Record<Badge, string> = {
  // 블록 하나 + 위로 오르는 점
  miner: `<rect class="b1" x="4" y="9" width="11" height="11" rx="2"/><path class="b2" d="M7 12h5M7 15.5h5"/><circle class="dot" cx="18.5" cy="6" r="2.4"/>`,
  // 붓 끝 별
  creator: `<path class="b1" d="M11 3.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L3.8 8.8l5-.7z"/><circle class="dot" cx="19" cy="18.5" r="2.4"/>`,
  // 이어진 마디(노드)
  node: `<circle class="b1" cx="6" cy="7" r="2.6"/><circle class="b1" cx="6" cy="17" r="2.6"/><path class="b2" d="M8.4 8.2l6.4 3.2M8.4 15.8l6.4-3.2"/><circle class="dot" cx="17.5" cy="12" r="2.8"/>`,
  // 가운데 탑 하나가 양쪽으로 글을 나른다(릴레이)
  relay: `<circle class="b1" cx="11" cy="13" r="2.8"/><path class="b2" d="M6.6 8.6a6.2 6.2 0 0 0 0 8.8M15.4 8.6a6.2 6.2 0 0 1 0 8.8M3.9 5.9a10 10 0 0 0 0 14.2"/><circle class="dot" cx="19" cy="5.5" r="2.4"/>`,
};
function icon(b: Badge): string {
  return `<svg class="tk-badge-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[b]}</svg>`;
}

function whyOf(b: Badge, info: Info): string {
  if (b === "miner") return t("이 이름표에 걸린 주소가 최근 90일 안에 직접 블록 보상을 받았어요.");
  if (b === "creator") return tf("이 이름표에 걸린 주소가 자산({0})의 주인 토큰을 가지고 있어요.", (info.creator?.assets || []).slice(0, 5).join(", "));
  if (b === "relay") return tf("이 분이 모두를 위해 컴퓨터를 내어 주고 계세요. 이야기 글을 나르는 릴레이를 최근 30일 중 {0}일 열어 두셨어요. 우리 확인 서버가 직접 접속해 확인했어요.", info.relay?.days ?? 0);
  return tf("이 분의 컴퓨터가 레이븐코인 노드를 최근 30일 중 {0}일 돌렸어요. 우리 확인 서버가 직접 접속해 블록을 받아 확인했어요.", info.node?.days ?? 0);
}

const isOk = (p?: Part) => p?.ok === true && p.unknown !== true;
const isNo = (p?: Part) => p?.ok === false && p.unknown !== true;

/** 이 사람의 확인된 표시들. 아직 모르면 null. */
export function badgesOf(pk: string): Badge[] | null {
  const k = known.get(pk);
  if (!k) return null;
  return BADGES.filter((b) => isOk(k.info[b]));
}

/** 이 사람이 그 표시를 「확실히」 못 가졌나(모르면 false — 접지 않는다). */
export function surelyLacks(pk: string, b: Badge): boolean {
  const k = known.get(pk);
  return !!k && isNo(k.info[b]);
}

/** 아직 모르거나 오래된 사람의 표시를 러스트에 묻는다. 새로 안 것이 있으면 true. */
export async function loadBadges(invoke: Invoke, people: { pubkey: string; address: string }[]): Promise<boolean> {
  const now = Date.now();
  const want = people.filter((p) => {
    if (!/^[0-9a-f]{64}$/.test(p.pubkey) || inflight.has(p.pubkey)) return false;
    const k = known.get(p.pubkey);
    if (!k || k.addr !== p.address) return true;
    const unknown = BADGES.some((b) => k.info[b]?.unknown === true);
    return now - k.at > (unknown ? FAIL_TTL : TTL);
  }).slice(0, 60);
  if (!want.length) return false;
  want.forEach((p) => inflight.add(p.pubkey));
  try {
    const got = await invoke<Record<string, Info>>("talk_badges", { people: want });
    let changed = false;
    for (const p of want) {
      const info = got && typeof got === "object" ? got[p.pubkey] : undefined;
      if (!info || typeof info !== "object") continue;
      const before = JSON.stringify(badgesOf(p.pubkey));
      known.set(p.pubkey, { at: now, addr: p.address, info });
      if (before !== JSON.stringify(badgesOf(p.pubkey))) changed = true;
    }
    return changed;
  } catch {
    return false; // 못 읽었으면 표시 없이 둔다(지어내지 않는다).
  } finally {
    want.forEach((p) => inflight.delete(p.pubkey));
  }
}

/** 이름 옆 작은 표시들. */
export function badgeChipsHtml(pk: string): string {
  const k = known.get(pk);
  const list = badgesOf(pk) || [];
  return list
    .map((b) => `<span class="tk-badge" data-badge="${b}" title="${esc(whyOf(b, k!.info))}">${icon(b)}<span>${esc(t(BADGE_LABEL[b]))}</span></span>`)
    .join("");
}

/** 이름표 보기의 「기여 표시」 칸. */
export function badgeSectionHtml(pk: string, hasAddress: boolean): string {
  const k = known.get(pk);
  const list = badgesOf(pk);
  const rows = list === null
    ? `<p class="tk-badge-muted">${esc(t("기여 표시를 확인하는 중…"))}</p>`
    : list.length
    ? list.map((b) => `<div class="tk-badge-row"><span class="tk-badge" data-badge="${b}">${icon(b)}<span>${esc(t(BADGE_LABEL[b]))}</span></span><p>${esc(whyOf(b, k!.info))}</p></div>`).join("")
    : `<p class="tk-badge-muted">${esc(t("아직 확인된 기여 표시가 없어요."))}</p>`;
  return `<h4>${esc(t("기여 표시"))}</h4>${rows}` +
    (hasAddress ? "" : `<p class="tk-badge-muted">${esc(t(NO_ADDRESS))}</p>`) +
    `<p class="tk-badge-note">${esc(t(NOTE))}</p><p class="tk-badge-note">${esc(t(POOL_NOTE))}</p>`;
}

/* ── 방 문(gate) ── */
const roomGates = new Map<string, Badge>();
export function setRoomGates(rooms: any[]): void {
  roomGates.clear();
  for (const r of rooms) { const g = cleanGate(r?.gate); if (g) roomGates.set(String(r.id), g); }
}
export function gateOfRoom(room: string): Badge | "" {
  return (room && roomGates.get(room)) || "";
}
/** 방 목록·방 머리의 문 표시. */
export function gateChipHtml(g: Badge | ""): string {
  return g ? `<span class="tk-gate-chip" data-badge="${g}" title="${esc(t(GATE_LOCKED[g]))}">${icon(g)}<span>${esc(t(BADGE_LABEL[g]))}</span></span>` : "";
}
/** 방 만들기 「누가 글을 쓸 수 있나요?」 고르기 칸. */
export function gateOptionsHtml(): string {
  return (["", ...BADGES] as (Badge | "")[]).map((g) => `<option value="${g}" data-desktop-copy="${esc(GATE_CHOICE[g])}">${esc(t(GATE_CHOICE[g]))}</option>`).join("");
}

/* ── 내 글쓰기 칸 ── */
let myAddr: { at: number; address: string } | null = null;
async function myAddress(invoke: Invoke): Promise<string | null> {
  if (myAddr && Date.now() - myAddr.at < 10 * 60 * 1000) return myAddr.address;
  try {
    const r = await invoke<any>("talk_my_rvn");
    myAddr = { at: Date.now(), address: String(r?.address || "") };
    return myAddr.address;
  } catch {
    return null; // 모름
  }
}
/** 이름표에 주소를 바꿨을 때 다시 읽게 한다. */
export function forgetMyAddress(): void { myAddr = null; }

/**
 * 문 있는 방이면 내 표시를 보고 글쓰기 칸을 열거나 닫는다.
 * 확실히 없을 때·주소가 없을 때만 닫는다. 모르면 열어 두고(러스트도 막지 않는다) 그렇다고 적는다.
 */
export async function paintComposerGate(invoke: Invoke, room: string, me: string, stillHere: () => boolean): Promise<void> {
  const note = document.getElementById("tk-gate-note");
  const parts = ["tk-text", "tk-send", "tk-photo"].map((id) => document.getElementById(id) as HTMLButtonElement | HTMLTextAreaElement | null);
  const set = (locked: boolean, msg: string) => {
    parts.forEach((el) => { if (el) el.disabled = locked; });
    document.querySelector("#page-talk .composer")?.classList.toggle("tk-gated", locked);
    if (note) { note.textContent = msg; note.hidden = !msg; }
  };
  const g = gateOfRoom(room);
  if (!g) { set(false, ""); return; }
  set(false, t("내 기여 표시를 확인하는 중이에요."));
  const needAddr = g !== "node" && g !== "relay"; // 지킴이 표시는 주소가 아니라 이야기 열쇠에 붙는다
  const addr = needAddr ? await myAddress(invoke) : "";
  if (!stillHere()) return;
  if (needAddr && addr === "") { set(true, `${t(GATE_LOCKED[g])} ${t(NO_ADDRESS)}`); return; }
  if (needAddr && addr === null) { set(false, t("지금은 기여 표시를 확인하지 못했어요. 글은 써 볼 수 있어요.")); return; }
  await loadBadges(invoke, [{ pubkey: me, address: addr || "" }]);
  if (!stillHere()) return;
  if (badgesOf(me)?.includes(g)) set(false, "");
  else if (surelyLacks(me, g)) set(true, t(GATE_LOCKED[g]));
  else set(false, t("지금은 기여 표시를 확인하지 못했어요. 글은 써 볼 수 있어요."));
}

/**
 * 그려진 목록에 표시를 붙이고, 문 있는 방이면 표시 없는 분의 글을 접는다.
 * 🔴 읽는 중(모름)에는 접지 않는다. 펼친 글은 다시 그려도 펼친 채로 둔다.
 */
const unfolded = new Set<string>();
export function applyBadges(box: HTMLElement, room: string, me: string): void {
  box.querySelectorAll<HTMLElement>("[data-badges-for]").forEach((el) => {
    el.innerHTML = badgeChipsHtml(String(el.dataset.badgesFor || ""));
  });
  const g = gateOfRoom(room);
  box.querySelectorAll<HTMLElement>(".bub[data-author]").forEach((bub) => {
    const who = String(bub.dataset.author || "");
    const id = String(bub.dataset.say || "");
    const fold = !!g && who !== me && surelyLacks(who, g) && !unfolded.has(id);
    bub.classList.toggle("tk-folded", fold);
    let btn = bub.querySelector<HTMLButtonElement>(":scope > .tk-fold");
    if (fold && !btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tk-fold";
      btn.textContent = t("표시 없는 분의 글이에요 · 펼치기");
      btn.onclick = (ev) => { ev.stopPropagation(); unfolded.add(id); bub.classList.remove("tk-folded"); btn?.remove(); };
      bub.prepend(btn);
    } else if (!fold && btn) btn.remove();
  });
}
