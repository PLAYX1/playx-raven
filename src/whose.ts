/* 「이 주소가 내 것인가」 — 지갑 화면의 「주소 확인」 칸과 라비의 규칙 답이 같이 쓴다.
 *
 * ## 🔴 왜 생겼나 (0.4.6)
 *
 * 대표님이 자기 PLAYX!(주인 표)가 있는 주소를 앱에서 찾지 못했다. 노드에 직접
 * 물으니 **거스름 주소 33번**이었다. 주소록은 받기 주소만 보여 주고, 주인 표는
 * 자산 목록에서 일부러 숨긴다 — 그래서 「내 지갑 주소인지 확실히 볼 수 있게」.
 *
 * 판정은 러스트(`whose.rs` · 노드의 `validateaddress`)가 한다. 여기는 **그린다**.
 *
 * ⚠️ 라비가 이 답을 줄 때도 AI 를 부르지 않는다. 규칙 계산을 AI 라고 속이지 않는다 —
 *    답 아래에 「이 컴퓨터의 노드에 바로 물어봤어요」라고 적는다.
 */
import { copyHtml, tf } from "./i18n";

export type WhoseState = "mine" | "watch" | "not_mine" | "invalid";
export type WhoseHolding = { name: string; amount: number; unconfirmed: boolean; owner: boolean };
export type WhoseResult = {
  address: string;
  state: WhoseState;
  kind: "receive" | "change" | "imported" | "hd" | null;
  index: number | null;
  holdings: null | {
    rvn: { confirmed: number; unconfirmed: number };
    assets: WhoseHolding[];
    partial: boolean;
    checked: number;
    total: number;
    error: string | null;
  };
};
export type OwnerRow = { name: string; amount: number; addresses: string[]; unconfirmed: boolean; unknown: number };

/** 발행 명령의 답 — 0.4.6 부터 `{ txid, owner_pinned, … }`. 옛 모양(글자 하나)도 받는다. */
export type Issued = { txid: string; ownerPinned: boolean | null; ownerToken: string };
export function issuedOf(r: unknown): Issued {
  if (typeof r === "string") return { txid: r, ownerPinned: null, ownerToken: "" };
  const o = (r ?? {}) as Record<string, unknown>;
  const txid = typeof o.txid === "string" ? o.txid : Array.isArray(r) ? String((r as unknown[])[0] ?? "") : "";
  return {
    txid,
    ownerPinned: typeof o.owner_pinned === "boolean" ? o.owner_pinned : null,
    ownerToken: typeof o.owner_token === "string" ? o.owner_token : "",
  };
}

/** 발행 뒤 주인 표를 제자리에 못 뒀을 때 한 줄. */
export const OWNER_NOT_PINNED =
  "주인 표가 있는 주소를 확인하지 못해, 노드가 새 거스름 주소로 옮겼을 수 있어요. 지갑 화면 「내 주인 표」에서 지금 주소를 확인해 주세요.";

const B58 = "1-9A-HJ-NP-Za-km-z";
/** 문장 속 레이븐 주소 하나(본망 R… 34자 안팎). `raven:` 앞머리가 붙어 있어도 찾는다. */
export function findRavenAddress(text: string): string | null {
  const m = String(text ?? "").match(new RegExp(`(?:^|[^${B58}])([Rr][${B58}]{25,34})(?![${B58}])`));
  return m ? m[1] : null;
}

/** 칸에 든 것이 통째로 주소 하나(+ `raven:`·물음표 뒤·공백)인가 — 친 즉시 확인할지 가른다. */
export function looksLikeAddress(text: string): boolean {
  const s = String(text ?? "").trim().replace(/^raven:(\/\/)?/i, "").replace(/\?.*$/, "");
  return new RegExp(`^[Rr][${B58}]{25,34}$`).test(s);
}

/** 「내 거야?」「누구 거」 — 이런 말과 함께 주소가 오면 라비가 규칙으로 답한다. */
const WHOSE_WORDS =
  /내\s*(거|꺼|것|주소|지갑)|누구\s*(거|꺼|것|주소)|누구의|주인|whose|\bmine\b|my\s+(address|wallet)|私の|誰の|我的|谁的/i;

/**
 * 라비에게 온 말이 「이 주소 누구 거?」인가. 그렇다면 그 주소, 아니면 null.
 *
 * 주소만 있거나, 주소와 「내 거야/내꺼/내 주소/누구 거」 같은 말만 있을 때.
 * 「R… 로 10 RVN 보내 줘」처럼 다른 일을 시키는 말은 가로채지 않는다.
 */
export function whoseQuestion(text: string): string | null {
  const addr = findRavenAddress(text);
  if (!addr) return null;
  const rest = String(text).replace(new RegExp(`(?:raven:(?:\\/\\/)?)?${addr}(?:\\?\\S*)?`, "i"), " ");
  const leftover = rest.replace(/[\s?？!！.。,，~…"'`「」『』<>()[\]]+/g, "");
  return !leftover || WHOSE_WORDS.test(rest) ? addr : null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : String(parseFloat(n.toFixed(8))));
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const ICON = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M7.8 12.4l2.8 2.8 5.6-5.8"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.4v.1"/></svg>',
  no: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H21M17.5 12v3.2M20.5 12v2.4"/></svg>',
};

/** 받기 n번 · 거스름 n번 · 가져온 열쇠 — 값이 끼는 말은 그릴 때 옮긴다(언어가 바뀌면 다시 그린다). */
function kindLine(r: WhoseResult): string {
  if (r.kind === "receive" && r.index != null) return esc(tf("받기 주소 {0}번", r.index));
  if (r.kind === "change" && r.index != null)
    return esc(tf("거스름 주소 {0}번", r.index)) + ` <span class="whose-why">${copyHtml("거래할 때 노드가 자동으로 만든 주소예요")}</span>`;
  if (r.kind === "imported") return copyHtml("가져온 열쇠의 주소예요 — 12단어에서 나온 주소가 아니에요");
  return "";
}

function holdingsHtml(h: NonNullable<WhoseResult["holdings"]>): string {
  const rows: string[] = [];
  const rvn = h.rvn || { confirmed: 0, unconfirmed: 0 };
  if (rvn.confirmed > 0 || rvn.unconfirmed > 0) {
    rows.push(
      `<li class="whose-item"><span class="whose-asset" translate="no">RVN</span>` +
        `<span class="whose-qty" translate="no">${esc(num(rvn.confirmed))}</span>` +
        (rvn.unconfirmed > 0 ? `<span class="whose-tag wait">${esc(tf("확인 전 {0}", num(rvn.unconfirmed)))}</span>` : "") +
        `</li>`,
    );
  }
  for (const a of h.assets || []) {
    rows.push(
      `<li class="whose-item${a.owner ? " owner" : ""}"><span class="whose-asset" translate="no">${esc(a.name)}</span>` +
        `<span class="whose-qty" translate="no">${esc(num(a.amount))}</span>` +
        (a.owner ? `<span class="whose-tag own">${ICON.key}${copyHtml("주인 표 · 발행 권한 열쇠")}</span>` : "") +
        (a.unconfirmed ? `<span class="whose-tag wait">${copyHtml("확인 전")}</span>` : "") +
        `</li>`,
    );
  }
  let out = `<div class="whose-have"><div class="whose-havehead">${copyHtml("이 주소에 있는 것")}</div>`;
  out += rows.length ? `<ul class="whose-list">${rows.join("")}</ul>` : `<p class="meta">${copyHtml("지금 이 주소에는 아무것도 없어요.")}</p>`;
  if (h.partial) out += `<p class="meta">${esc(tf("자산 조각이 많아 {0}개 중 {1}개만 확인했어요.", h.total, h.checked))}</p>`;
  if (h.error) out += `<p class="meta whose-err">${copyHtml("가진 것을 다 읽지 못했어요. 노드가 따라잡은 뒤 다시 확인해 주세요.")}</p>`;
  return out + `</div>`;
}

/**
 * 판정 한 장. 크고 분명하게 — 첫 줄 하나로 답이 끝나야 한다.
 * `from` 이 "ravi" 면 라비 말풍선 안에 들어가는 모양(규칙 답이라는 말을 붙인다).
 */
export function whoseHtml(r: WhoseResult, from: "wallet" | "ravi" = "wallet"): string {
  const head = (tone: "ok" | "warn" | "no", source: string) =>
    `<div class="whose-head ${tone}">${ICON[tone]}<b>${copyHtml(source)}</b></div>`;
  let body = "";
  let tone: "ok" | "warn" | "no" = "no";
  if (r.state === "mine") {
    tone = "ok";
    body = head("ok", "내 지갑 주소예요");
    const k = kindLine(r);
    if (k) body += `<div class="whose-kind">${k}</div>`;
  } else if (r.state === "watch") {
    tone = "warn";
    body = head("warn", "감시만 하는 주소예요(이 지갑 돈 아님)");
    body += `<p class="meta">${copyHtml("이 컴퓨터는 들어오는 것만 봐요. 이 주소의 돈은 여기서 보낼 수 없어요.")}</p>`;
  } else if (r.state === "not_mine") {
    body = head("no", "이 지갑 주소가 아니에요");
    body += `<p class="meta">${copyHtml("이 지갑의 열쇠로는 이 주소의 돈을 쓸 수 없어요.")}</p>`;
  } else {
    body = head("no", "레이븐 주소가 아니에요");
    body += `<p class="meta">${copyHtml("글자가 빠졌거나 다른 코인의 주소일 수 있어요. 다시 붙여 넣어 주세요.")}</p>`;
  }
  if (r.address && r.state !== "invalid") body += `<code class="addr whose-addr" translate="no">${esc(r.address)}</code>`;
  if (r.state === "mine" && r.holdings) body += holdingsHtml(r.holdings);
  if (from === "ravi") body += `<p class="meta whose-rule">${copyHtml("이 컴퓨터의 노드에 바로 물어봤어요.")}</p>`;
  return `<div class="whose-res ${tone}" data-state="${esc(r.state)}">${body}</div>`;
}

/** 「내 주인 표」 줄들. 보내기 단추는 **일부러 없다** — 보내면 발행 권한이 넘어간다. */
export function ownerRowsHtml(rows: OwnerRow[]): string {
  return rows
    .map((r) => {
      const brand = r.name.replace(/!$/, "");
      const where = r.addresses.length
        ? r.addresses
            .map(
              (a) =>
                `<span class="own-at"><code class="addr" translate="no" title="${esc(a)}">${esc(short(a))}</code>` +
                `<button class="ghost own-copy" type="button" data-owncopy="${esc(a)}">${copyHtml("복사")}</button>` +
                `<button class="ghost own-check" type="button" data-owncheck="${esc(a)}">${copyHtml("주소 확인")}</button></span>`,
            )
            .join("")
        : `<span class="meta">${copyHtml("보관 주소를 확인하지 못했어요")}</span>`;
      const notes: string[] = [];
      if (r.addresses.length > 1) notes.push(copyHtml("여러 주소에 나뉘어 있어요."));
      if (r.unconfirmed) notes.push(copyHtml("방금 움직여서 아직 기록 전이에요(확인 0)."));
      if (r.unknown > 0 && r.addresses.length) notes.push(copyHtml("일부는 움직이는 중이라 따라가지 못했어요."));
      return `<div class="own-row">
          <div class="own-line">${ICON.key}<b class="own-name" translate="no">${esc(r.name)}</b>
            <span class="own-what">${copyHtml("발행 권한 열쇠")}</span></div>
          <div class="own-where"><span class="own-label">${copyHtml("보관 주소")}</span>${where}</div>
          ${notes.length ? `<p class="meta">${notes.join(" ")}</p>` : ""}
          <p class="meta own-say">${esc(tf("이 표가 있어야 {0} 아래에 곡·증명서를 만들 수 있어요. 보내면 발행 권한이 넘어가요.", brand))}</p>
        </div>`;
    })
    .join("");
}
