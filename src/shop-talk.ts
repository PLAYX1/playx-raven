/* 가게 대화방 + 가게 공지 방 — 데스크탑 「가게」 화면의 「가게 대화방」 탭(11-28 · 정본 ravenvault docs/SHOP-ROOMS.md).
 *
 * - 가게 공지 방: 가게 간판 열쇠로 공지 방(NIP-28 kind 40)을 만들고, 공지(kind 42)를 올린다. 방 링크(/t/<번호>)·QR 로 단골을 모은다.
 *   단골은 폰에서 **직접 끌어와 읽는다**(pull). 한꺼번에 보내는 쪽지는 없다. 손님 화면은 24시간에 5개까지 펼친다 — 데스크탑도 5개에서 멈춘다.
 * - 가게 쪽지: 손님이 가게 간판 공개키로 보낸 NIP-17 쪽지. **내 개인 쪽지(이야기 탭)와 섞지 않는다.** 먼저 말 건 손님에게만 가게 이름으로 답한다.
 *
 * 🔴 열쇠는 러스트(shop_room.rs · talk_dm.rs)에만 있다. 이 파일은 글자만 받는다.
 * 🔴 손님 글은 남이 쓴 글이다 — 전부 escape 해서 넣고 링크로 만들지 않는다.
 * 🔴 손님 이름표를 묻지 않는다(가게 칸에서 손님 이름을 물으면 「이 가게 = 이 손님들」이 바깥에 남는다) — 지문만 보인다.
 * 🔴 글 칸 셋(공지·답장·방 설명)은 보내기 전에 복구 단어 검사(seed-leak.ts confirmSeedLeak).
 */
import "./shop-talk.css";
import { DICT } from "./dict";
import { t, tf } from "./i18n";
import { NEVER_ASKS } from "./seed-leak-rule";
import { SHOP_TALK_COPY } from "./shop-talk-copy";

for (const [source, values] of Object.entries(SHOP_TALK_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
export type ShopTalkDeps = {
  invoke: Invoke;
  errText: (e: unknown) => string;
  escapeHtml: (s: unknown) => string;
  /** 보내기 전 복구 단어 경고. false 면 보내지 않는다. */
  seedGuard: (text: string) => Promise<boolean>;
  /** 가게 이름(공지 방 이름 기본값). */
  shopName: () => Promise<string>;
};

type Room = { id: string; name: string; about: string; created_at: number };
type Notice = { id: string; at: number; text: string };
type RoomView = { none?: boolean; shop?: string; npub?: string; fingerprint?: string; room?: Room | null; link?: string; notices?: Notice[]; recent?: number; per_day?: number; reached?: boolean; existed?: boolean };
type Msg = { id: string; from: string; to: string; at: number; text: string; photo?: boolean };
type Thread = { key: string; with: string; with_fp?: string; last: Msg; count: number; unread: number };
type ThreadsView = { none?: boolean; shop?: string; fingerprint?: string; threads: Thread[]; reached?: boolean; why?: string };

const READ_KEY = "rv.shop.dmread";
const NOTICE_MAX = 8000;

function loadRead(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(READ_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function saveRead(v: Record<string, number>) {
  try { localStorage.setItem(READ_KEY, JSON.stringify(v)); } catch { /* 못 적어도 이번 판은 된다 */ }
}
const when = (at: number) => new Date(at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const snip = (s: string, n = 48) => { const a = Array.from(String(s || "").replace(/\s+/g, " ").trim()); return a.slice(0, n).join("") + (a.length > n ? "…" : ""); };

/** 오늘(24시간) 공지 몇 개 더 올릴 수 있나 — 화면 안내용(러스트가 진짜로 막는다). */
export function noticesLeft(recent: number, perDay: number): number {
  return Math.max(0, perDay - Math.max(0, recent));
}

/** 안 읽은 가게 쪽지 수(탭 배지). */
export function shopUnread(threads: readonly Pick<Thread, "unread">[]): number {
  return threads.reduce((n, th) => n + Math.max(0, th.unread || 0), 0);
}

/** 상품 링크를 글 끝에 새 줄로 붙인다(이미 있으면 그대로). */
export function appendLink(text: string, link: string): string {
  const body = text.replace(/\s+$/, "");
  if (!link || body.includes(link)) return text;
  return body ? `${body}\n${link}` : link;
}

export function mountShopTalk(host: HTMLElement, d: ShopTalkDeps) {
  const esc = d.escapeHtml;
  let read = loadRead();
  let room: RoomView = {};
  let threads: Thread[] = [];
  let openKey = "";
  let busy = false;

  host.innerHTML = `
    <div class="card st-card" id="st-room">
      <h3>가게 공지 방</h3>
      <p class="meta">단골이 폰에서 이 방을 찾아 읽어요(끌어오기). 올리는 데 돈이 들지 않고, 한꺼번에 보내는 쪽지는 없어요.</p>
      <div id="st-room-body"><p class="meta">읽는 중…</p></div>
    </div>
    <div class="card st-card" id="st-inbox">
      <h3>가게 쪽지 <span class="st-badge" id="st-inbox-n" hidden></span></h3>
      <p class="meta">손님이 가게 이름(간판 열쇠)으로 보낸 쪽지예요. 내 개인 쪽지와 섞이지 않아요. 먼저 말을 건 손님에게만 가게 이름으로 답할 수 있어요.</p>
      <p class="st-safe">${esc(t(NEVER_ASKS))}</p>
      <div class="st-inbox-grid">
        <ul class="st-threads" id="st-threads" aria-label="가게 쪽지"><li class="meta">읽는 중…</li></ul>
        <div class="st-chat" id="st-chat"><p class="meta">왼쪽에서 손님을 고르세요.</p></div>
      </div>
    </div>`;
  const $ = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;

  function badge() {
    const n = shopUnread(threads);
    const label = n > 99 ? "99+" : String(n);
    for (const b of [$("st-inbox-n"), document.getElementById("st-tab-n")]) {
      if (!b) continue;
      b.textContent = label;
      b.hidden = n <= 0;
    }
  }

  // ── 공지 방 ─────────────────────────────────────────────────────
  function paintRoom() {
    const box = $("st-room-body");
    if (room.none) {
      box.innerHTML = `<p class="meta">가게 간판 열쇠가 아직 없어요. 「가게 정보」에서 가게를 먼저 열어 주세요.</p>`;
      return;
    }
    const fp = room.fingerprint ? `<span class="st-fp" translate="no">${esc(room.fingerprint)}</span>` : "";
    if (!room.room) {
      box.innerHTML = `
        <p class="meta">아직 공지 방이 없어요. 한 번 만들면 링크가 바뀌지 않아요.</p>
        <label class="st-lbl" for="st-name">방 이름</label>
        <input id="st-name" maxlength="60" autocomplete="off" />
        <label class="st-lbl" for="st-about">한 줄 설명</label>
        <input id="st-about" maxlength="300" autocomplete="off" placeholder="예: 매주 새 빵 소식" />
        <div class="row st-row"><button type="button" id="st-make">공지 방 만들기</button><span class="meta">가게 열쇠 ${fp}</span></div>
        <p class="meta st-say" id="st-room-say" role="status"></p>`;
      void d.shopName().then((n) => { const i = host.querySelector<HTMLInputElement>("#st-name"); if (i && !i.value) i.value = n; });
      $("st-make").onclick = () => void makeRoom();
      return;
    }
    const r = room.room;
    const left = noticesLeft(room.recent ?? 0, room.per_day ?? 5);
    const list = (room.notices || []).slice(0, 10).map((n) => `<li><span class="st-when">${esc(when(n.at))}</span><div class="st-text" translate="no">${esc(n.text)}</div></li>`).join("");
    box.innerHTML = `
      <div class="st-roomhead"><b translate="no">${esc(r.name)}</b> ${fp}${r.about ? `<div class="meta" translate="no">${esc(r.about)}</div>` : ""}</div>
      <div class="st-share">
        <div class="st-qr" id="st-qr" aria-label="방 링크 QR"></div>
        <div class="st-sharetext">
          <div class="meta">단골 모으기 — 이 링크나 QR 을 가게에 붙여 두세요. 손님이 폰으로 열고 「단골 맺기」를 누르면 공지가 그 폰에 들어가요.</div>
          <code class="st-link" translate="no">${esc(room.link || "")}</code>
          <div class="row st-row"><button type="button" class="ghost" id="st-copy">링크 복사</button><span class="meta" id="st-copy-say" role="status"></span></div>
        </div>
      </div>
      <label class="st-lbl" for="st-notice">공지 쓰기</label>
      <textarea id="st-notice" rows="4" maxlength="${NOTICE_MAX}" placeholder="예: 오늘 소금빵 30개 구웠어요. 5시까지!"></textarea>
      <div class="st-attach">
        <select id="st-prod" aria-label="내 상품"><option value="">내 상품 고르기…</option></select>
        <button type="button" class="ghost" id="st-prod-add">상품 붙이기</button>
        <input id="st-paste" autocomplete="off" placeholder="상품 공유 링크 붙여 넣기 (ravenvault.ex.erci.se/r/… · /g/…)" />
        <button type="button" class="ghost" id="st-paste-add">링크 붙이기</button>
      </div>
      <p class="meta">상품 링크를 붙이면 손님 폰에 상품 카드로 보여요(서명을 확인한 것만).</p>
      <div class="row st-row">
        <button type="button" id="st-post"${left <= 0 ? " disabled" : ""}>공지 올리기</button>
        <span class="meta" id="st-left">${esc(tf("오늘 올린 공지 {0}/{1}", room.recent ?? 0, room.per_day ?? 5))}</span>
      </div>
      <p class="meta">손님 화면에는 24시간에 공지 5개까지 펼쳐 보여요. 더 올리면 접혀 보이므로 데스크탑도 5개에서 멈춰요.</p>
      <p class="meta st-say" id="st-room-say" role="status"></p>
      ${list ? `<h4>최근 공지</h4><ul class="st-notices">${list}</ul>` : `<p class="meta">아직 올린 공지가 없어요.</p>`}`;
    $("st-copy").onclick = () => {
      void navigator.clipboard?.writeText(room.link || "").then(() => { $("st-copy-say").textContent = t("링크를 복사했어요."); }, () => { $("st-copy-say").textContent = t("복사하지 못했어요."); });
    };
    $("st-prod-add").onclick = () => {
      const v = ($("st-prod") as HTMLSelectElement).value;
      if (v) { const ta = $("st-notice") as HTMLTextAreaElement; ta.value = appendLink(ta.value, v); }
    };
    $("st-paste-add").onclick = () => void pasteLink();
    $("st-post").onclick = () => void postNotice();
    if (room.link) {
      void d.invoke<string>("qr_svg", { text: room.link }).then((svg) => { const q = host.querySelector("#st-qr"); if (q && typeof svg === "string" && svg.includes("<svg")) q.innerHTML = svg; }).catch(() => {});
    }
    void d.invoke<{ items: { label: string; link: string }[] }>("shop_notice_products").then((r0) => {
      const r = r0 || { items: [] };
      const sel = host.querySelector<HTMLSelectElement>("#st-prod");
      if (!sel) return;
      for (const it of r.items || []) {
        const o = document.createElement("option");
        o.value = it.link;
        o.textContent = it.label;
        o.setAttribute("translate", "no");
        sel.append(o);
      }
      sel.hidden = !(r.items || []).length;
      const add = host.querySelector<HTMLElement>("#st-prod-add");
      if (add) add.hidden = sel.hidden;
    }).catch(() => {});
  }

  const say = (s: string) => { const e = host.querySelector("#st-room-say"); if (e) e.textContent = s; };

  async function makeRoom() {
    if (busy) return;
    const name = ($("st-name") as HTMLInputElement).value.trim();
    const about = ($("st-about") as HTMLInputElement).value.trim();
    if (!name) { say(t("방 이름이 필요합니다.")); return; }
    if (!(await d.seedGuard(`${name} ${about}`))) return;
    busy = true;
    say(t("올리는 중…"));
    try {
      room = (await d.invoke<RoomView>("shop_room_create", { name, about })) || {};
      paintRoom();
      say(room.existed ? t("이미 만든 공지 방이 있어 그 방을 그대로 써요.") : t("공지 방을 만들었어요."));
    } catch (e) { say(d.errText(e)); } finally { busy = false; }
  }

  async function pasteLink() {
    const box = $("st-paste") as HTMLInputElement;
    if (!box.value.trim()) return;
    try {
      const link = await d.invoke<string>("shop_notice_check_link", { link: box.value });
      const ta = $("st-notice") as HTMLTextAreaElement;
      ta.value = appendLink(ta.value, link);
      box.value = "";
      say("");
    } catch (e) { say(d.errText(e)); }
  }

  async function postNotice() {
    if (busy) return;
    const ta = $("st-notice") as HTMLTextAreaElement;
    const text = ta.value.trim();
    if (!text) { say(t("공지에 쓸 말을 적어 주세요.")); return; }
    if (!(await d.seedGuard(text))) return;
    busy = true;
    say(t("올리는 중…"));
    try {
      room = (await d.invoke<RoomView>("shop_notice_post", { text })) || {};
      paintRoom();
      say(t("공지를 올렸어요. 단골 폰이 다음에 열 때 받아 가요."));
    } catch (e) { say(d.errText(e)); } finally { busy = false; }
  }

  // ── 가게 쪽지 ───────────────────────────────────────────────────
  function paintThreads(why = "") {
    const ul = $("st-threads");
    if (!threads.length) {
      ul.innerHTML = `<li class="meta">${esc(why || t("아직 손님 쪽지가 없어요."))}</li>`;
      return;
    }
    ul.innerHTML = threads.map((th) => `
      <li><button type="button" class="st-th${th.key === openKey ? " on" : ""}" data-key="${esc(th.key)}">
        <span class="st-who" translate="no">${esc(th.with_fp || th.with.slice(0, 12))}</span>
        <span class="st-last" translate="no">${esc((th.last.from !== th.with ? t("가게") + ": " : "") + (th.last.photo ? t("사진") : snip(th.last.text)))}</span>
        <span class="st-time">${esc(when(th.last.at))}</span>
        ${th.unread > 0 ? `<span class="st-badge">${th.unread > 99 ? "99+" : th.unread}</span>` : ""}
      </button></li>`).join("");
    ul.querySelectorAll<HTMLElement>("[data-key]").forEach((b) => { b.onclick = () => void openThread(b.dataset.key!); });
  }

  async function loadThreads(local: boolean) {
    try {
      const v = (await d.invoke<ThreadsView>("shop_dm_threads", { local, read })) || { threads: [] };
      if (v.none) { threads = []; paintThreads(t("가게 간판 열쇠가 아직 없어요. 「가게 정보」에서 가게를 먼저 열어 주세요.")); badge(); return; }
      threads = v.threads || [];
      paintThreads(v.reached === false ? t("바깥 릴레이에 닿지 못했어요. 이 컴퓨터에 있는 것만 보여요.") : "");
      badge();
    } catch (e) { paintThreads(d.errText(e)); }
  }

  async function openThread(key: string, local = true) {
    openKey = key;
    paintThreads();
    const chat = $("st-chat");
    try {
      const v = (await d.invoke<{ messages: Msg[]; can_reply: boolean; with_fp?: string; shop: string }>("shop_dm_read", { key, local })) || { messages: [], can_reply: false, shop: "" };
      if (openKey !== key) return;
      v.messages ||= [];
      const last = v.messages[v.messages.length - 1];
      if (last) { read[key] = Math.max(read[key] ?? 0, last.at); saveRead(read); }
      const th = threads.find((x) => x.key === key);
      if (th) th.unread = 0;
      badge();
      paintThreads();
      const bubbles = v.messages.map((m) => `
        <div class="st-msg${m.from === v.shop ? " mine" : ""}">
          <div class="st-bubble" translate="no">${m.photo ? esc(t("사진")) : esc(m.text)}</div>
          <div class="st-when">${esc(when(m.at))}</div>
        </div>`).join("");
      chat.innerHTML = `
        <div class="st-chathead"><b translate="no">${esc(v.with_fp || key.slice(0, 12))}</b> <span class="meta">손님 지문</span></div>
        <div class="st-msgs" id="st-msgs">${bubbles || `<p class="meta">쪽지가 없어요.</p>`}</div>
        ${v.can_reply ? `
          <textarea id="st-reply" rows="3" maxlength="4000" placeholder="가게 이름으로 답하기"></textarea>
          <div class="row st-row"><button type="button" id="st-send">답장 보내기</button><span class="meta" id="st-send-say" role="status"></span></div>
          <p class="meta">이 손님 한 분에게만 가요. 여러 손님에게 한꺼번에 보내기는 없어요.</p>`
        : `<p class="meta">먼저 말을 건 손님에게만 가게 이름으로 답할 수 있어요.</p>`}`;
      const msgs = host.querySelector<HTMLElement>("#st-msgs");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      const send = host.querySelector<HTMLElement>("#st-send");
      if (send) send.onclick = () => void reply(key);
      if (local) void openThread(key, false);
    } catch (e) {
      if (openKey === key) chat.innerHTML = `<p class="meta">${esc(d.errText(e))}</p>`;
    }
  }

  async function reply(key: string) {
    const ta = host.querySelector<HTMLTextAreaElement>("#st-reply");
    const sayEl = host.querySelector<HTMLElement>("#st-send-say");
    if (!ta || busy) return;
    const text = ta.value.trim();
    if (!text) { if (sayEl) sayEl.textContent = t("보낼 말을 적어 주세요."); return; }
    if (!(await d.seedGuard(text))) return;
    busy = true;
    if (sayEl) sayEl.textContent = t("보내는 중…");
    try {
      await d.invoke("shop_dm_send", { to: key, text });
      ta.value = "";
      busy = false;
      await openThread(key, true);
      await loadThreads(true);
    } catch (e) {
      if (sayEl) sayEl.textContent = d.errText(e);
    } finally { busy = false; }
  }

  async function refresh() {
    try { room = (await d.invoke<RoomView>("shop_room_get", { local: true })) || { none: true }; paintRoom(); } catch (e) { say(d.errText(e)); }
    await loadThreads(true);
    try { const r = await d.invoke<RoomView>("shop_room_get", { local: false }); if (r) { room = r; if (!busy) paintRoom(); } } catch { /* 이 컴퓨터 것은 이미 그렸다 */ }
    await loadThreads(false);
  }

  return {
    /** 탭을 열 때마다 — 이 컴퓨터 것 먼저, 바깥 것으로 다시. */
    refresh,
    /** 뒤에서 가볍게(탭 배지만). 이 컴퓨터 저장분만 본다. */
    quiet: () => loadThreads(true),
  };
}
