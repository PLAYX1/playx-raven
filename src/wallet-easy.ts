/* 지갑 화면을 「처음 쓰는 사람」 순서로 — 받기 · 보내기(0.4.8-B · RV3 🔴5·🔴6).
 *
 * 여기는 **그리기와 이 컴퓨터에만 남기는 받을 사람 이름**만 한다. 노드에 묻는 일(주소·수수료)과
 * 보내는 일은 main.ts 가 러스트(`receive.rs`·`sendfee.rs`·`send.rs`)를 불러서 한다.
 *
 * ## 받을 사람 이름은 왜 여기(localStorage)에
 *
 * 받을 주소록(`addrbook.rs`)은 레이븐 코어의 주소록을 그대로 쓰는데, 코어는 **내 주소에만** 이름을
 * 붙이게 한다(`setaccount` — 남의 주소는 거절). 그리고 그 명령이 내 주소가 아니면 일부러 막는다
 * (「화면에는 있는데 돈은 못 받는 줄」이 생기지 않게). 그래서 **남에게 보낼 주소의 이름**은 코어에
 * 넣을 자리가 없다. 이 프로그램은 「이 컴퓨터에서 내가 정한 것」을 localStorage 에 둔다
 * (main.ts 이야기 화면 주석) — 이름은 돈도 열쇠도 아니고, 없어져도 주소와 보낸 기록은 남는다.
 *
 * 🔴 저장한 이름은 **보여 주기만** 한다. 「처음 보내는 주소」 판정(끝 네 글자 확인)은 여전히 노드의
 *    보낸 기록(`address_history`)으로만 한다 — 이름을 저장했다고 확인을 건너뛰지 않는다.
 */
import { looksLikeAddress } from "./whose";

type Copy = (source: string) => string;
type Esc = (value: unknown) => string;

export type Payee = { address: string; name: string; at: number };
export type RecentPayee = { address: string; name: string; time: number };

const PAYEES_KEY = "playx-raven-payees";
const MAX_PAYEES = 60;
export const MAX_RECENT = 5;
export const MAX_NAME = 40;

/** 이름 한 칸 — 앞뒤 공백·제어문자 빼고 40자까지. */
export function cleanName(raw: string): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export function loadPayees(): Payee[] {
  try {
    const v = JSON.parse(localStorage.getItem(PAYEES_KEY) || "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((p) => p && typeof p.address === "string" && looksLikeAddress(p.address) && typeof p.name === "string")
      .map((p) => ({ address: p.address, name: cleanName(p.name), at: Number(p.at) || 0 }))
      .filter((p) => p.name);
  } catch {
    return []; // localStorage 가 막혀도 보내기는 된다 — 고르는 줄만 빈다
  }
}

/** 보낸 뒤에만 부른다(주소는 노드가 이미 확인한 것). 같은 주소면 이름을 바꾼다. */
export function savePayee(address: string, rawName: string): Payee[] {
  const name = cleanName(rawName);
  if (!name || !looksLikeAddress(address)) throw new Error("이름과 주소를 확인해 주세요.");
  const list = loadPayees().filter((p) => p.address !== address);
  list.unshift({ address, name, at: Math.floor(Date.now() / 1000) });
  localStorage.setItem(PAYEES_KEY, JSON.stringify(list.slice(0, MAX_PAYEES)));
  return list;
}

export function payeeName(address: string): string {
  return loadPayees().find((p) => p.address === address)?.name || "";
}

/** 지갑 기록(`listtransactions`)에서 최근에 **보낸** 곳 — 주소마다 한 번, 최근 순으로. */
export function recentPayees(txs: unknown[], saved: Payee[], max = MAX_RECENT): RecentPayee[] {
  const seen = new Map<string, RecentPayee>();
  for (const t of Array.isArray(txs) ? txs : []) {
    const x = (t ?? {}) as Record<string, unknown>;
    if (x.category !== "send") continue;
    const address = typeof x.address === "string" ? x.address.trim() : "";
    if (!address || !looksLikeAddress(address)) continue;
    const time = Number(x.time) || 0;
    const had = seen.get(address);
    if (had && had.time >= time) continue;
    const label = typeof x.label === "string" ? cleanName(x.label) : "";
    seen.set(address, { address, name: label, time });
  }
  const names = new Map(saved.map((p) => [p.address, p.name]));
  return [...seen.values()]
    .sort((a, b) => b.time - a.time)
    .slice(0, max)
    .map((r) => ({ ...r, name: names.get(r.address) || r.name }));
}

/** 주소 앞뒤만 — 「R3xk…9QzP」. 사람이 원본과 대 보는 자리. */
export function shortAddr(a: string): string {
  const s = String(a ?? "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** 보내기 입력 화면의 「받을 사람 고르기」. 저장한 사람 먼저, 그다음 최근 보낸 곳. */
export function pickerHtml(saved: Payee[], recent: RecentPayee[], copyHtml: Copy, esc: Esc): string {
  const chip = (address: string, name: string) =>
    `<button type="button" class="ghost payee" data-payee="${esc(address)}">` +
    (name ? `<b translate="no">${esc(name)}</b>` : "") +
    `<code translate="no">${esc(shortAddr(address))}</code></button>`;
  const savedSet = new Set(saved.map((p) => p.address));
  const recentOnly = recent.filter((r) => !savedSet.has(r.address));
  const parts: string[] = [`<div class="pickhead">${copyHtml("받을 사람 고르기")}</div>`];
  if (saved.length) {
    parts.push(`<div class="picksub">${copyHtml("저장한 사람")}</div>`,
      `<div class="payees">${saved.slice(0, 12).map((p) => chip(p.address, p.name)).join("")}</div>`);
  }
  if (recentOnly.length) {
    parts.push(`<div class="picksub">${copyHtml("최근 보낸 곳")}</div>`,
      `<div class="payees">${recentOnly.map((r) => chip(r.address, r.name)).join("")}</div>`);
  }
  if (!saved.length && !recentOnly.length) {
    parts.push(`<p class="meta">${copyHtml("아직 보낸 곳이 없어요. 보낸 뒤 결과 화면에서 이름을 붙여 저장하면 여기서 고를 수 있어요.")}</p>`);
  }
  return parts.join("");
}

/** 받기 칸. 주소는 노드가 「이 지갑 것」이라고 확인한 것만 들어온다(main.ts). */
export function receiveHtml(address: string, reused: boolean, copyHtml: Copy, esc: Esc): string {
  return `<section class="card wrecv" id="w-recv" aria-labelledby="w-recv-title">` +
    `<div class="wrecv-head"><h3 id="w-recv-title">${copyHtml("받을 주소")}</h3>` +
    `<button type="button" class="ghost" id="w-recv-close">${copyHtml("닫기")}</button></div>` +
    `<div class="wrecv-body">` +
    `<div class="shareqr wrecv-qr" id="w-qr" role="img" aria-label="받을 주소 QR">${copyHtml("QR 만드는 중…")}</div>` +
    `<div class="wrecv-side">` +
    `<code class="addr wrecv-addr" id="w-addr-text" translate="no">${esc(address)}</code>` +
    `<p class="meta">${copyHtml("이 컴퓨터의 노드가 확인한 내 지갑 주소예요. 레이븐코인(RVN)과 레이븐 자산만 받을 수 있어요.")}</p>` +
    `<div class="wrecv-btns">` +
    `<button type="button" id="w-copy">${copyHtml("주소 복사")}</button>` +
    `<button type="button" class="ghost" id="w-copymsg">${copyHtml("메시지로 복사")}</button>` +
    `<button type="button" class="ghost" id="w-qrsave">${copyHtml("QR 그림 저장")}</button>` +
    `</div>` +
    `<p class="meta" id="w-recv-note" aria-live="polite"></p>` +
    `<p class="meta">${copyHtml(reused
      ? "아직 받은 적 없는 주소라 다시 보여 드려요. 돈이 들어오면 다음에는 새 주소가 나와요."
      : "새로 만든 주소예요. 돈이 들어올 때까지 「받기」를 누르면 이 주소가 다시 나와요.")}</p>` +
    `<button type="button" class="ghost" id="w-newaddr">${copyHtml("새 주소 만들기")}</button>` +
    `</div></div></section>`;
}

/** 카톡 등에 붙여 넣을 한 줄. `tf` 로 사람이 고른 말로 만든다. */
export const RECEIVE_MESSAGE = "제 레이븐코인(RVN) 받는 주소예요: {0}";

/** 보낸 뒤 결과. 거래 번호는 「자세히」 안으로 — 처음 쓰는 사람에게 64자 글자는 뜻이 없다. */
export function sentHtml(
  o: { amount: string; what: string; address: string; name: string; txid: string; canSave: boolean },
  copyHtml: Copy, esc: Esc,
): string {
  const who = o.name
    ? `<b translate="no">${esc(o.name)}</b> <code translate="no">${esc(shortAddr(o.address))}</code>`
    : `<code translate="no">${esc(shortAddr(o.address))}</code>`;
  return `<div class="card wdone">` +
    `<h3>${copyHtml("보냈어요")}</h3>` +
    `<div class="wdone-amt" translate="no">${esc(o.amount)} ${esc(o.what)}</div>` +
    `<div class="kv"><b>${copyHtml("받는 사람")}</b><span>${who}</span></div>` +
    `<p class="meta">${copyHtml("네트워크에 기록되면(보통 1~2분) 확정돼요. 보낸 것은 되돌릴 수 없어요.")}</p>` +
    `<details class="wdone-more"><summary>${copyHtml("자세히")}</summary>` +
    `<div class="kv"><b>${copyHtml("받는 주소")}</b><code class="addr" translate="no">${esc(o.address)}</code></div>` +
    `<div class="kv"><b>${copyHtml("거래 번호")}</b><code class="addr" translate="no">${esc(o.txid)}</code></div>` +
    `</details>` +
    (o.canSave
      ? `<div class="wsave"><label for="s-savename">${copyHtml("이 주소를 받을 사람으로 저장")}</label>` +
        `<div class="wsave-row"><input id="s-savename" maxlength="${MAX_NAME}" autocomplete="off" placeholder="예: 민수" />` +
        `<button type="button" class="ghost" id="s-saveok">${copyHtml("저장")}</button></div>` +
        `<p class="meta" id="s-savenote" aria-live="polite"></p></div>`
      : "") +
    `</div>`;
}
