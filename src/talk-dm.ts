/* 이야기 — 카톡 PC 처럼: 왼쪽 「친구 · 채팅 · 광장」, 가운데 대화.
 *
 * 11-12 대표: 「레이븐볼트 켜 놓고 메신저로도 쓰게 — 메신저·피드 둘 다」.
 * - 채팅 = 1:1 쪽지 · 단톡 · 글이 있는 방을 마지막 글 시각순으로 한 줄씩(폰 core/talk/chat-list.ts 와 같은 규칙).
 * - 친구 = 팔로우한 사람 + 쪽지를 주고받은 사람, 줄마다 「쪽지」.
 * - 광장 = 예전 그대로(가운데 X 식 피드 · 왼쪽 방 목록).
 *
 * 🔴 쪽지 열쇠는 러스트(talk_dm.rs)에만 있다. 이 파일은 **내 대화의 글자**만 받는다 — 봉하기·풀기·서명은 저쪽.
 * 🔴 글자는 전부 escape 해서 넣는다(쪽지는 남이 쓴 글이다). 본문은 main 의 noteBodyHtml(이모티콘·링크)을 쓴다.
 * 🔴 먼저 그리기: 이 컴퓨터 저장분(local)으로 곧바로 → 바깥 답으로 다시.
 */
import "./talk-dm.css";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import { applyFilter, talkIdle, unreadPill } from "./talk-desk";

export type DmMsg = { id: string; from: string; to: string; at: number; text: string; wrap: string; members?: string[]; subject?: string; photo?: boolean };
export type DmThread = { key: string; kind: "dm" | "group"; with?: string; members?: string[]; subject?: string; last: DmMsg; count: number; unread: number };
type Room = { id: string; name: string };
type Side = "friends" | "chats" | "square";
type Open = { key: string; with: string; members: string[]; subject: string };

export type DmDeps = {
  invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  me: () => string;
  nameOf: (pk: string) => string;
  loadNames: (pks: string[]) => Promise<void>;
  hue: (pk: string) => number;
  bodyHtml: (text: string) => string;
  stickerOnly: (text: string) => boolean;
  rooms: () => Room[];
  roomOpen: () => string;
  openRoom: (id: string) => void;
  openSquare: () => void;
  showPerson: (pk: string) => void;
  follows: () => Promise<Set<string> | null>;
  muted: () => string[];
  notify: (from: string, count: number) => void;
  legacyOpen: (pk?: string) => Promise<void>;
  errText: (e: unknown) => string;
  escapeHtml: (s: unknown) => string;
  /** 쪽지를 닫고 방·광장으로 돌아갈 때 — main 이 머리줄·오른쪽 칸을 그 방에 맞춘다. */
  repaint: () => void;
};

const READ_KEY = "rv.talk.dmread";
const SIDE_KEY = "rv.talk.side";
const HEX64 = /^[0-9a-f]{64}$/;
const roomKey = (id: string) => `room:${id}`;
const 이음 = 5 * 60;

function load<T>(k: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? fallback; } catch { return fallback; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 못 해도 이번 판은 된다 */ } }

/** 화면 숫자 배지: 1~99, 그 위는 「99+」(폰 unreadBadge). */
export function unreadBadge(n: number): string { return n <= 0 ? "" : n > 99 ? "99+" : String(n); }

/** 「오후 3:05 · 어제 · 11월 9일」 — 목록 오른쪽 시각. */
export function listTime(at: number, now = Date.now() / 1000): string {
  const d = new Date(at * 1000), n = new Date(now * 1000);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("어제");
  return d.toLocaleDateString([], { month: "long", day: "numeric" });
}

export type ChatRow =
  | { kind: "dm" | "group"; key: string; thread: DmThread; at: number; unread: number }
  | { kind: "room"; key: string; room: Room; at: number; from: string; text: string; unread: number };

/** 쪽지 대화 + 글이 있는 방 → 한 목록, 마지막 글 시각 최근순(폰 chatRows). 방은 읽음 기록이 있을 때만 안 읽은 표시. */
export function chatRows(threads: DmThread[], rooms: Room[], roomsLast: Record<string, { at: number; from: string; text: string }>, read: Record<string, number>, me: string, muted: string[]): ChatRow[] {
  const rows: ChatRow[] = threads.map((th) => ({ kind: th.kind, key: th.key, thread: th, at: th.last.at, unread: th.unread }));
  for (const r of rooms) {
    const last = roomsLast[r.id];
    if (!last || muted.includes(last.from)) continue;
    const seen = read[roomKey(r.id)];
    rows.push({ kind: "room", key: roomKey(r.id), room: r, at: last.at, from: last.from, text: last.text, unread: seen !== undefined && last.from !== me && last.at > seen ? 1 : 0 });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export function wireTalkDm(d: DmDeps) {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const esc = d.escapeHtml;
  let side: Side = (() => { const s = load<string>(SIDE_KEY, "chats"); return s === "friends" || s === "square" ? s : "chats"; })();
  let open: Open | null = null;
  let threads: DmThread[] = [];
  let roomsLast: Record<string, { at: number; from: string; text: string }> = {};
  let read: Record<string, number> = load(READ_KEY, {});
  let msgs = new Map<string, DmMsg[]>();
  let samePerson: boolean | null = null;
  let reached = true;
  let known = new Map<string, number>(); // 대화 → 마지막으로 알린(본) 남의 글 시각 — 새 쪽지 알림
  let primed = false;
  let busy = false;
  let tick: number | undefined;

  const groupTitle = (members: string[], subject: string) => subject || members.filter((m) => m !== d.me()).map((m) => d.nameOf(m)).slice(0, 3).join(", ") + (members.length > 4 ? ` ${tf("외 {0}명", members.length - 4)}` : "");
  const titleOf = (o: { with?: string; members?: string[]; subject?: string }) => o.members && o.members.length > 2 ? groupTitle(o.members, o.subject || "") : d.nameOf(o.with || "");
  const avatar = (seed: string, label: string, group = false) =>
    `<span class="tkc-av${group ? " grp" : ""}" style="--h:${d.hue(seed)}" aria-hidden="true">${esc(Array.from(label || "레")[0] || "레")}</span>`;
  const snip = (s: string, n = 40) => { const one = String(s || "").replace(/\s+/g, " ").trim(); const a = Array.from(one); return a.slice(0, n).join("") + (a.length > n ? "…" : ""); };
  const lastLine = (m: DmMsg) => (m.from === d.me() ? `${t("나")}: ` : "") + (m.photo ? t("사진") : snip(m.text.replace(/:ravi_[a-z]+:/g, t("이모티콘"))));

  function markRead(key: string, at: number) {
    if (!key || !(at > 0)) return;
    if ((read[key] ?? 0) >= at) return;
    read[key] = at;
    // 오래 쓴 기록이 쌓이지 않게 최근 500개만.
    const keys = Object.keys(read);
    if (keys.length > 500) { keys.sort((a, b) => read[a] - read[b]).slice(0, keys.length - 500).forEach((k) => delete read[k]); }
    save(READ_KEY, read);
  }

  // ── 왼쪽 칸 ───────────────────────────────────────────────────────
  function paintSide() {
    for (const s of ["friends", "chats", "square"] as Side[]) {
      const b = document.getElementById(`tk-side-${s}`);
      b?.setAttribute("aria-selected", String(side === s));
    }
    $("tk-chats").hidden = side !== "chats";
    $("tk-friends").hidden = side !== "friends";
    $("tk-squarebox").hidden = side !== "square";
    setCopyText($("tk-listtitle"), () => t(side === "friends" ? "친구" : side === "square" ? "광장" : "채팅"));
    $("tk-newdm").hidden = side === "square";
    const total = threads.reduce((n, th) => n + (th.unread > 0 ? 1 : 0), 0);
    const badge = $("tk-side-chats-n");
    badge.textContent = unreadBadge(total);
    badge.hidden = !total;
    if (side === "chats") paintChats();
    if (side === "friends") void paintFriends();
    applyFilter();
  }

  function rowHtml(r: ChatRow): string {
    const on = open ? r.key === open.key : r.kind === "room" && d.roomOpen() === r.room.id;
    const n = unreadBadge(r.unread);
    if (r.kind === "room") {
      return `<button type="button" class="tkc-row${on ? " on" : ""}" data-chat-room="${esc(r.room.id)}">` +
        avatar(r.room.id, r.room.name, true) +
        `<span class="tkc-mid"><span class="tkc-top"><b class="tkc-name" translate="no">${esc(r.room.name)}</b></span>` +
        `<span class="tkc-last" translate="no">${esc((r.from === d.me() ? `${t("나")}: ` : `${d.nameOf(r.from)}: `) + snip(r.text))}</span></span>` +
        `<span class="tkc-side"><time>${esc(listTime(r.at))}</time>${r.unread ? `<span class="tkc-dot" aria-label="${esc(t("새 글"))}"></span>` : ""}</span></button>`;
    }
    const th = r.thread;
    const group = th.kind === "group";
    const name = titleOf(th);
    return `<button type="button" class="tkc-row${on ? " on" : ""}" data-chat-key="${esc(th.key)}">` +
      avatar(group ? th.key : th.with || "", name, group) +
      `<span class="tkc-mid"><span class="tkc-top"><b class="tkc-name" translate="no">${esc(name)}</b>${group ? `<span class="tkc-kind">${esc(String((th.members || []).length))}</span>` : ""}</span>` +
      `<span class="tkc-last" translate="no">${esc(lastLine(th.last))}</span></span>` +
      `<span class="tkc-side"><time>${esc(listTime(th.last.at))}</time>${n ? `<span class="tkc-n">${esc(n)}</span>` : ""}</span></button>`;
  }

  function paintChats() {
    const box = $("tk-chats");
    const rows = chatRows(threads, d.rooms(), roomsLast, read, d.me(), d.muted());
    // 알릴 것이 있을 때만 한 줄(넘치면 「…」 · 얹으면 전체).
    const noteKey = samePerson === false
      ? "이 컴퓨터의 이야기 이름이 폰과 다릅니다(옛 방식 열쇠). 폰에서 보낸 쪽지는 여기 안 보일 수 있어요 — 「내 이름」에서 같은 이름으로 바꿀 수 있어요."
      : !reached ? "바깥 릴레이에 닿지 못해 이 컴퓨터에 둔 쪽지만 보입니다." : "";
    const note = noteKey ? `<p class="tkc-note" title="${esc(t(noteKey))}">${copyHtml(noteKey)}</p>` : "";
    box.innerHTML = note +
      (rows.length ? rows.map(rowHtml).join("") : `<p class="tkc-empty">${copyHtml("아직 대화가 없어요.")}</p>`);
    box.querySelectorAll<HTMLElement>("[data-chat-key]").forEach((b) => {
      b.onclick = () => { const th = threads.find((x) => x.key === b.dataset.chatKey); if (th) void openThread({ key: th.key, with: th.with || "", members: th.members || [], subject: th.subject || "" }); };
    });
    box.querySelectorAll<HTMLElement>("[data-chat-room]").forEach((b) => {
      b.onclick = () => { const id = String(b.dataset.chatRoom || ""); close(false); talkIdle(false); markRead(roomKey(id), roomsLast[id]?.at || 0); d.openRoom(id); paintChats(); };
    });
    applyFilter();
  }

  async function paintFriends() {
    const box = $("tk-friends");
    const people = new Set<string>();
    const fol = await d.follows().catch(() => null);
    fol?.forEach((p) => people.add(p));
    for (const th of threads) if (th.kind === "dm" && th.with && th.with !== d.me()) people.add(th.with);
    const list = [...people].filter((p) => HEX64.test(p) && !d.muted().includes(p));
    await d.loadNames(list).catch(() => {});
    if (side !== "friends") return;
    list.sort((a, b) => d.nameOf(a).localeCompare(d.nameOf(b), "ko"));
    box.innerHTML =
      (list.length
        ? list.map((p) => `<div class="tkc-row tkc-friend">` + avatar(p, d.nameOf(p)) +
            `<button type="button" class="tkc-mid tkc-who" data-friend="${esc(p)}"><span class="tkc-top"><b class="tkc-name" translate="no">${esc(d.nameOf(p))}</b></span>` +
            `</button>` +
            `<button type="button" class="tkc-dm" data-friend-dm="${esc(p)}">${copyHtml("쪽지")}</button></div>`).join("")
        : `<p class="tkc-empty">${copyHtml("아직 친구가 없어요.")}</p>`);
    box.querySelectorAll<HTMLElement>("[data-friend-dm]").forEach((b) => { b.onclick = () => { setSide("chats"); void openThread({ key: String(b.dataset.friendDm), with: String(b.dataset.friendDm), members: [], subject: "" }); }; });
    box.querySelectorAll<HTMLElement>("[data-friend]").forEach((b) => { b.onclick = () => d.showPerson(String(b.dataset.friend)); });
    applyFilter();
  }

  function setSide(s: Side) {
    side = s;
    save(SIDE_KEY, s);
    if (s === "square" && (open || $("page-talk").classList.contains("idle"))) d.openSquare(); // main openFeed 가 쪽지를 닫고 머리줄을 광장으로 되돌린다
    paintSide();
  }

  // ── 「+ 새 쪽지」: 아이디(npub)로 1:1 · 여러 사람이면 단톡 ─────────────
  function openNewBox() {
    talkIdle(false);
    const b = $("tk-dmbox");
    b.hidden = false;
    $("tk-dmsay").textContent = "";
    paintDmBox();
    ($("tk-dmto") as HTMLInputElement).focus();
  }
  function paintDmBox() {
    $("tk-dmsame").textContent = samePerson === false
      ? t("⚠️ 이 컴퓨터의 이야기 이름은 옛 방식이라 폰·웹 지갑과 다른 이름입니다. 상대에게는 처음 보는 이름으로 보일 수 있어요.")
      : t("같은 12단어를 쓰면 폰·웹 지갑과 같은 이름으로 오가고, 폰에서 주고받은 쪽지도 여기 보입니다.");
  }
  async function startFromBox() {
    const raw = ($("tk-dmto") as HTMLInputElement).value;
    const subject = ($("tk-dmsubject") as HTMLInputElement).value.trim();
    const ids = raw.split(/[\s,]+/).map((s) => s.trim().replace(/^nostr:/, "")).filter(Boolean);
    if (!ids.length) { $("tk-dmsay").textContent = t("받는 사람의 이야기 아이디(npub1…)를 붙여 넣어 주세요."); return; }
    try {
      const pubs: string[] = await d.invoke("talk_dm_peers", { ids });
      const others = [...new Set(pubs)].filter((p) => p !== d.me());
      if (!others.length) { $("tk-dmsay").textContent = t("나에게 쓰는 쪽지는 「나」 대화에 남습니다."); }
      $("tk-dmbox").hidden = true;
      ($("tk-dmto") as HTMLInputElement).value = "";
      ($("tk-dmsubject") as HTMLInputElement).value = "";
      if (others.length <= 1) return void openThread({ key: others[0] || d.me(), with: others[0] || d.me(), members: [], subject: "" });
      const members = [...new Set([d.me(), ...others])].sort();
      if (members.length > 30) { $("tk-dmbox").hidden = false; $("tk-dmsay").textContent = t("단톡은 30명까지예요."); return; }
      const key: string = await d.invoke("talk_dm_group_key", { members });
      void openThread({ key, with: "", members, subject });
    } catch (e) {
      $("tk-dmsay").textContent = d.errText(e);
    }
  }

  // ── 가운데: 한 대화 ────────────────────────────────────────────────
  function headFor(o: Open) {
    const group = o.members.length > 2;
    const name = titleOf(o);
    setCopyText($("tk-title"), () => name || t("쪽지"));
    setCopyText($("tk-dmchip"), () => group ? tf("암호 단톡 · {0}명만 읽어요", o.members.length) : t("암호 쪽지 · 두 사람만 읽어요"));
    $("rv-person-name").textContent = name;
    setCopyText($("rv-person-sub"), () => group ? tf("암호 단톡 · {0}명", o.members.length) : t("암호 쪽지 · 두 사람만 읽어요"));
    const initial = Array.from(name || "쪽")[0] || "쪽";
    for (const av of [$("rv-person-avatar"), $("tk-headav")]) {
      av.dataset.initial = initial;
      av.style.setProperty("--h", String(d.hue(group ? o.key : o.with)));
    }
    $("rv-person-key").textContent = group ? o.members.join("\n") : o.with;
    if (!group && HEX64.test(o.with) && o.with !== d.me()) d.showPerson(o.with);
    else $("rv-person-badges").hidden = true;
  }

  async function openThread(o: Open) {
    open = o;
    talkIdle(false);
    const page = $("page-talk");
    page.classList.add("dmon");
    page.classList.remove("feedon");
    $("tk-feedtabs").hidden = true;
    const list = $("tk-list");
    list.classList.remove("feedmode", "feedcards");
    list.dataset.loaded = `dm:${o.key}`;
    $("tk-new-messages").hidden = true;
    const ta = $("tk-text") as HTMLTextAreaElement;
    ta.placeholder = t("쪽지");
    setCopyText($("tk-send"), () => t("보내기"));
    const names = o.members.length ? o.members : [o.with];
    await d.loadNames(names).catch(() => {});
    if (open !== o) return;
    headFor(o);
    paintSide();
    if (msgs.has(o.key)) paintThread();
    else list.innerHTML = `<div class="meta" style="margin:auto">${copyHtml("쪽지를 여는 중…")}</div>`;
    await readThread(true);
    await readThread(false);
    ta.focus();
  }

  async function readThread(local: boolean) {
    const o = open;
    if (!o) return;
    try {
      const r = await d.invoke<any>("talk_dm_read", { key: o.key, local });
      if (open !== o) return;
      if (typeof r?.same_as_wallet === "boolean") samePerson = r.same_as_wallet;
      const got: DmMsg[] = Array.isArray(r?.messages) ? r.messages : [];
      // 방금 보낸(아직 답이 없는) 것은 남긴다.
      const pending = (msgs.get(o.key) || []).filter((m) => m.id.startsWith("pending:"));
      msgs.set(o.key, [...got, ...pending]);
      if (!local) reached = r?.reached !== false;
      const lastSubject = [...got].reverse().find((m) => m.subject)?.subject;
      if (lastSubject && lastSubject !== o.subject) { o.subject = lastSubject; headFor(o); }
      const memb = [...got].reverse().find((m) => (m.members || []).length > 2)?.members;
      if (memb && !o.members.length) o.members = memb;
      await d.loadNames([...new Set(got.map((m) => m.from))]).catch(() => {});
      if (open !== o) return;
      paintThread();
      const lastIn = got.filter((m) => m.from !== d.me()).reduce((a, m) => Math.max(a, m.at), 0);
      if (lastIn) { markRead(o.key, lastIn); known.set(o.key, Math.max(known.get(o.key) || 0, lastIn)); }
      const th = threads.find((x) => x.key === o.key);
      if (th) { th.unread = 0; paintSide(); }
    } catch (e) {
      if (open === o && !msgs.has(o.key)) $("tk-list").innerHTML = `<p class="meta danger">${esc(d.errText(e))}</p>`;
    }
  }

  function paintThread() {
    const o = open;
    if (!o) return;
    const box = $("tk-list");
    const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || box.dataset.dmPainted !== o.key;
    const list = [...(msgs.get(o.key) || [])].sort((a, b) => a.at - b.at);
    const me = d.me();
    if (!list.length) {
      box.innerHTML = `<div class="tkc-start">${copyHtml("아직 주고받은 쪽지가 없어요.")}</div>`;
      box.dataset.dmPainted = o.key;
      $("tk-new-messages").hidden = true;
      return;
    }
    const day = (at: number) => new Date(at * 1000).toDateString();
    box.innerHTML = list.map((m, i) => {
      const mine = m.from === me;
      const prev = list[i - 1], next = list[i + 1];
      const sep = !prev || day(prev.at) !== day(m.at) ? `<div class="daysep">${esc(new Date(m.at * 1000).toLocaleDateString([], { month: "long", day: "numeric", weekday: "short" }))}</div>` : "";
      const joined = !sep && prev && prev.from === m.from && m.at - prev.at < 이음;
      // 남의 말 무리마다 얼굴·이름 한 번(카톡 PC 처럼 1:1 도). 이어 쓴 말에는 안 단다.
      const head = mine || joined ? ""
        : `<div class="who" style="--h:${d.hue(m.from)}" data-person="${esc(m.from)}"><span class="rv-avatar" aria-hidden="true">${esc(Array.from(d.nameOf(m.from))[0] || "레")}</span> <span translate="no">${esc(d.nameOf(m.from))}</span></div>`;
      const showClock = !(next && next.from === m.from && day(next.at) === day(m.at) && next.at - m.at < 이음);
      const pending = m.id.startsWith("pending:");
      const failed = m.id.startsWith("pending:x:");
      const clock = failed
        ? `<button type="button" class="tstamp rv-send-status tkc-retry" data-retry="${esc(m.id)}">${copyHtml("못 보냈어요 · 다시 보내기")}</button>`
        : pending ? `<time class="tstamp rv-send-status">${copyHtml("보내는 중…")}</time>`
        : showClock ? `<time class="tstamp" title="${esc(new Date(m.at * 1000).toLocaleString())}">${esc(new Date(m.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</time>` : "";
      const body = m.photo ? `<span class="tkc-photo">${copyHtml("사진 쪽지 — 지금은 폰에서 볼 수 있어요")}</span>` : d.bodyHtml(m.text);
      return sep + head +
        `<div class="line${mine ? " me" : ""}${joined ? " cont" : ""}${pending && !failed ? " pending" : ""}"><div class="bub${mine ? " me" : ""}${!m.photo && d.stickerOnly(m.text) ? " stk" : ""}" data-dm="${esc(m.id)}">${body}</div>${clock}</div>`;
    }).join("");
    box.dataset.dmPainted = o.key;
    if (wasBottom) box.scrollTop = box.scrollHeight;
    unreadPill(box, list.map((m) => m.id), wasBottom, `dm:${o.key}`);
    box.querySelectorAll<HTMLElement>("[data-retry]").forEach((b) => {
      b.onclick = () => {
        const id = String(b.dataset.retry);
        const arr = msgs.get(o.key) || [];
        const m = arr.find((x) => x.id === id);
        msgs.set(o.key, arr.filter((x) => x.id !== id));
        if (m) { ($("tk-text") as HTMLTextAreaElement).value = m.text; void send(); }
      };
    });
  }

  async function send(): Promise<void> {
    const o = open;
    if (!o) return;
    const box = $("tk-text") as HTMLTextAreaElement;
    const text = box.value.trim();
    if (!text) return;
    const to = o.members.length > 2 ? o.members.filter((m) => m !== d.me()) : [o.with];
    const temp: DmMsg = { id: `pending:${Date.now()}:${Math.random()}`, from: d.me(), to: to[0] || "", at: Math.floor(Date.now() / 1000), text, wrap: "" };
    msgs.set(o.key, [...(msgs.get(o.key) || []), temp]);
    box.value = "";
    box.style.height = "auto";
    $("tk-note").textContent = "";
    const list = $("tk-list");
    paintThread();
    list.scrollTop = list.scrollHeight;
    try {
      const r = await d.invoke<any>("talk_dm_send", { to, text, subject: o.members.length > 2 ? o.subject || null : null });
      const arr = (msgs.get(o.key) || []).filter((m) => m.id !== temp.id);
      if (r?.message?.id && !arr.some((m) => m.id === r.message.id)) arr.push(r.message);
      msgs.set(o.key, arr);
      if (Array.isArray(r?.failed) && r.failed.length) $("tk-note").textContent = tf("{0}명에게는 아직 못 갔어요. 잠시 뒤 다시 보내 주세요.", r.failed.length);
      if (open === o) paintThread();
      void refresh(true);
    } catch (e) {
      const arr = (msgs.get(o.key) || []).map((m) => m.id === temp.id ? { ...m, id: `pending:x:${temp.id}` } : m);
      msgs.set(o.key, arr);
      if (open === o) paintThread();
      $("tk-note").innerHTML = `<span class="danger">${esc(d.errText(e))}</span>`;
    }
  }

  /** 쪽지 보기를 닫는다(방·광장으로). repaint=false 면 main 이 곧 다른 방을 그린다. */
  function close(repaint = true) {
    if (!open) return;
    open = null;
    const page = $("page-talk");
    page.classList.remove("dmon");
    setCopyText($("rv-person-sub"), () => t("공개 방 · 누구나 읽을 수 있어요"));
    const list = $("tk-list");
    delete list.dataset.loaded;
    delete list.dataset.dmPainted;
    list.innerHTML = "";
    if (repaint) d.repaint();
  }

  // ── 목록 새로 읽기 · 새 쪽지 알림 ──────────────────────────────────
  async function refresh(local: boolean, quiet = false) {
    if (busy && !local) return;
    if (!local) busy = true;
    try {
      const rooms = d.rooms().map((r) => r.id);
      const r = await d.invoke<any>("talk_dm_threads", { local, read, muted: d.muted(), rooms, quiet });
      if (r?.none) return;
      if (typeof r?.same_as_wallet === "boolean") samePerson = r.same_as_wallet;
      if (!local) reached = r?.reached !== false;
      threads = Array.isArray(r?.threads) ? r.threads : [];
      roomsLast = r?.rooms_last && typeof r.rooms_last === "object" ? r.rooms_last : {};
      if (open) { const th = threads.find((x) => x.key === open!.key); if (th) th.unread = 0; }
      // 새 쪽지 알림: 처음 한 바퀴는 적기만 한다. 지금 열어 둔 대화는 알리지 않는다(눈으로 본다).
      let fresh = 0, who = "";
      for (const th of threads) {
        if (th.last.from === d.me()) { known.set(th.key, Math.max(known.get(th.key) || 0, th.last.at)); continue; }
        const was = known.get(th.key) || 0;
        if (primed && th.last.at > was && th.unread > 0 && !(open && open.key === th.key && document.hasFocus())) { fresh++; who = th.kind === "group" ? titleOf(th) : d.nameOf(th.with || ""); }
        known.set(th.key, Math.max(was, th.last.at));
      }
      if (!local) primed = true;
      // 🔴 화면이 안 보일 때(뒤에서 살피기)는 그리지 않는다 — 알릴 것이 있을 때만 그 사람 이름표를 묻는다(memory-budget: 숨은 창은 그리기 IPC 0).
      if (quiet) {
        const th = fresh ? threads.find((x) => x.last.from !== d.me() && x.unread > 0) : undefined;
        if (th) { await d.loadNames(th.kind === "group" ? th.members || [] : [th.with || ""]).catch(() => {}); d.notify(th.kind === "group" ? titleOf(th) : d.nameOf(th.with || ""), fresh); }
        return;
      }
      if (fresh) d.notify(who, fresh);
      await d.loadNames(threads.flatMap((th) => th.kind === "group" ? th.members || [] : [th.with || ""]).concat(threads.map((th) => th.last.from))).catch(() => {});
      paintSide();
      if (open && !local) await readThread(true);
    } catch { /* 목록을 못 읽어도 화면은 그대로 둔다 */ }
    finally { if (!local) busy = false; }
  }

  function schedule() {
    clearInterval(tick);
    // 이야기 화면이 보이면 15초, 아니면 60초 — 바깥은 늘 이틀 창만 다시 묻는다(NIP-59 시각 흐림).
    const onTalk = () => document.getElementById("page-talk")?.classList.contains("on") === true;
    let n = 0;
    tick = window.setInterval(() => { n++; if (onTalk() || n % 4 === 0) void refresh(false, !onTalk()); }, 15_000);
  }

  // ── 묶기 ──────────────────────────────────────────────────────────
  for (const s of ["friends", "chats", "square"] as Side[]) {
    document.getElementById(`tk-side-${s}`)?.addEventListener("click", () => setSide(s));
  }
  $("tk-newdm").addEventListener("click", () => openNewBox());
  $("tk-dmstart").addEventListener("click", () => void startFromBox());
  $("tk-dmto").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); void startFromBox(); } });
  $("tk-dmgo").addEventListener("click", () => void d.legacyOpen().catch((e) => { $("tk-dmsay").textContent = d.errText(e); }));
  $("tk-list").addEventListener("click", (ev) => {
    if (!open) return;
    const w = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".who[data-person]");
    if (w?.dataset.person) { d.showPerson(w.dataset.person); $("page-talk").classList.add("infoon"); }
  });

  return {
    active: () => !!open,
    current: () => open?.key || "",
    send,
    paint: () => { if (open) paintThread(); },
    /** 사람 한 명과 1:1 쪽지를 이 창에서 연다(오른쪽 칸 「쪽지」·「+ 새 쪽지」). */
    openWith: (pk: string) => { setSide("chats"); return openThread({ key: pk, with: pk, members: [], subject: "" }); },
    close,
    /** 「더 보기 › 쪽지」·「+ 새 쪽지」 — 아이디로 시작하는 칸. */
    newBox: () => openNewBox(),
    /** 방 목록이 바뀌었을 때(main talkPaintRooms) — 채팅 목록의 방 줄을 다시 맞춘다. */
    roomsChanged: () => { if (side === "chats") paintChats(); applyFilter(); },
    /** 말풍선 메뉴 「복사」 — 그린 글이 아니라 받은 글자 그대로. */
    textOf: (id: string) => (open ? (msgs.get(open.key) || []).find((m) => m.id === id)?.text : undefined),
    roomOpened: (id: string) => { if (id) markRead(roomKey(id), roomsLast[id]?.at || Math.floor(Date.now() / 1000)); if (side === "chats") paintChats(); },
    /** 이야기 화면을 열 때. 먼저 이 컴퓨터 저장분으로 그리고 바깥을 읽는다. */
    start: async () => { paintSide(); await refresh(true); void refresh(false); },
    /** 앱이 켜져 있는 동안 새 쪽지를 살핀다(열쇠가 없으면 아무것도 안 한다). */
    watch: () => { schedule(); window.setTimeout(() => void refresh(false, true), 8_000); },
    side: () => side,
    setSide: (s: Side) => setSide(s),
  };
}
