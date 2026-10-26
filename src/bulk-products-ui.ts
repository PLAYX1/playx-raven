/*
 * 「상품 대량 등록」 — CSV 한 파일로 여러 상품 초안을 만들어 보고, 하나씩 확인한 뒤에만 올리는 화면. (판매자 기능)
 *
 * 규칙은 지갑 core/creator/bulk-products.ts(parseBulkProducts)를 그대로 쓴다 — 검사·초안 만들기는 거기서 한다. 이 파일은 화면과 연결 자리만 가진다.
 * 🔴 CSV 를 읽는다고 아무것도 올라가지 않는다(검토 전용). 항목마다 사장이 「확인했어요」를 켠 뒤에만 「서명해서 올리기」가 열린다.
 * 🔴 올리기: BulkPublishPort 한 자리. 기본은 막힘 — 「내 상품 올리기」 임시 잠금(src/creator-pause.ts CREATOR_PUBLISH_PAUSED)이 true 이면 단추는
 *    잠겨 있고 「지금은 올리기를 잠가 두었어요」라고 말한다. 이 파일은 잠금을 풀지 않는다. 잠금이 풀려도 실제 발행은 기존 발행 경로가 이 포트에 붙은 뒤에만 된다.
 * 🔴 판매자 정보(공개키·받는 주소·수수료 칸): BulkContextPort. 연결 전에는 형식 검사용 임시 값(공개된 고정 키)으로 검사만 하고, 화면에 「임시」라고 적는다.
 *    임시 값으로 만든 초안은 올릴 수 없다.
 * 🔴 엑셀 수식: 칸이 =, +, -, @ 로 시작하면 core 가 경고를 낸다. 값은 바꾸지 않는다 — 화면 예시 아래에 항상 안내를 보인다.
 * style="…" 속성은 쓰지 않는다(CSP) — 모양은 bulk-products-ui.css.
 */
import { BULK_LIMITS, parseBulkProducts, type BulkContext, type BulkDraft, type BulkIssue, type BulkResult } from "../core/creator/bulk-products";
import { feeTrackHash, sellerAddressOf, signProductDoc, zeroFeeTrack, type ProductDoc } from "../core/creator/product-doc";
import type { StoreKeyPort } from "./device-connect";
import { CREATOR_PUBLISH_PAUSED } from "./creator-pause";
import { DICT } from "./dict";
import { BULK_COPY } from "./bulk-copy";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./bulk-products-ui.css";

/* 이 화면의 문구는 화면을 처음 열 때 사전에 합친다(시작 묶음을 키우지 않으려고 dict.ts 에 넣지 않는다). 이미 있는 번역은 덮지 않는다. */
for (const [source, values] of Object.entries(BULK_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

/* ── 연결 자리(포트) ───────────────────────────────────────── */

export type BulkContextInfo = { ctx: BulkContext; /** 내 가게 정보로 만든 값인가(아니면 형식 검사용 임시 값). */ real: boolean };
export type BulkContextPort = { get(): Promise<BulkContextInfo> };

/** 공개된 고정 키(secp256k1 생성점 G 의 압축형) — 비밀키가 아니다. 형식 검사 전용이며 이 값으로는 아무것도 올리지 않는다. */
export const REVIEW_PLACEHOLDER_SELLER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export function placeholderContext(): BulkContext {
  return { seller: REVIEW_PLACEHOLDER_SELLER, payTo: sellerAddressOf(REVIEW_PLACEHOLDER_SELLER), feeBps: 0, feeSchedule: feeTrackHash(zeroFeeTrack(4_000_000)) };
}
export const placeholderContextPort: BulkContextPort = { get: async () => ({ ctx: placeholderContext(), real: false }) };

export type PublishOutcome = { ok: true; id?: string } | { ok: false; say: string };
export type BulkPublishPort = {
  /** 서명해서 올리기를 시도할 수 있나(연결됐고 잠금이 풀렸나). */
  readonly ready: boolean;
  /** 가게 키 서명 길이 열려 있나(화면에 「서명 준비됨」을 보이는 데만 쓴다 — 올릴 수 있다는 뜻이 아니다). */
  readonly signReady?: boolean;
  publish(draft: BulkDraft): Promise<PublishOutcome>;
};
/** 아무것도 올리지 않는 자리. 기존 발행 경로가 붙기 전까지의 기본값. */
export const nullBulkPublisher: BulkPublishPort = { ready: false, publish: async () => ({ ok: false, say: "올리기 길이 아직 연결되지 않았어요." }) };

/**
 * 가게 키 서명이 이어진 올리기 자리. 🔴 잠금(paused)이 true 이면 서명도 하지 않고 아무것도 보내지 않는다.
 * 잠금이 풀려도 여기서는 서명만 하고(signProductDoc — 서명자가 draft.body.seller 와 다르면 거절) 올리기/전파는 부르지 않는다 —
 * 실제 발행 경로가 붙기 전까지 결과는 늘 「올리기 길 연결 전」이다.
 */
export function storeKeyBulkPublisher(key: StoreKeyPort, paused: boolean = CREATOR_PUBLISH_PAUSED, connected: boolean = false): BulkPublishPort & { signed: ProductDoc[] } {
  const signed: ProductDoc[] = [];
  return {
    signed,
    ready: !paused && connected,
    signReady: connected,
    publish: async draft => {
      if (paused) return { ok: false, say: "지금은 올리기를 잠가 두었어요" };
      try { signed.push(await signProductDoc(key.signDigest, draft.body)); } catch { return { ok: false, say: "서명하지 못했어요. 다시 해 주세요." }; }
      return { ok: false, say: "서명은 준비됐지만 올리기 길이 아직 연결되지 않았어요." };
    },
  };
}

/* ── 순수 규칙 ─────────────────────────────────────────────── */

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
/** 예시 한 줄(화면 표시용). 열 순서는 자유라는 안내와 함께 보인다. */
export const CSV_EXAMPLE_HEADER = "제목,종류,가격,설명,파일 URL,파일 SHA256,파일 크기,미리보기 URL,다운로드 기간 일수,재고";
export const CSV_EXAMPLE_ROW = "여름 사진집,digital,1.5,고화질 사진 30장,https://files.example.com/photos.zip,<64자리 해시>,52428800,,30,100";

const COLUMN_LABEL: Record<string, string> = {
  title: "제목", kind: "종류", price: "가격", description: "설명", file_urls: "파일 URL", sha256: "파일 SHA256", size: "파일 크기",
  preview_url: "미리보기 URL", download_days: "다운로드 기간 일수", stock: "재고",
};
/** core 가 주는 칸 이름(title · col3 …)을 쉬운 말로. 모르는 것은 그대로(지어내지 않는다). */
export function columnLabel(col: string | undefined): string {
  if (!col) return "";
  if (COLUMN_LABEL[col]) return t(COLUMN_LABEL[col]);
  const m = /^col(\d+)$/.exec(col);
  return m ? tf("{0}번째 칸", Number(m[1]) + 1) : col;
}

export type DraftRow = { draft: BulkDraft; priceText: string; kindText: string };
export function atomsToRvnText(atoms: string): string {
  const n = BigInt(atoms), whole = n / 100_000_000n, frac = (n % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
export function draftRows(r: BulkResult): DraftRow[] {
  return r.drafts.map(draft => ({ draft, priceText: atomsToRvnText(draft.body.price), kindText: draft.body.kind }));
}
/** 줄 번호로 합쳐 오류·경고를 한 줄씩(같은 줄의 여러 문제는 따로 보인다). */
export function issueRows(issues: readonly BulkIssue[]): BulkIssue[] {
  return [...issues].sort((a, b) => a.line - b.line || (a.column ?? "").localeCompare(b.column ?? ""));
}

/** 올리기 단추 상태: 'paused' 잠금 · 'placeholder' 임시 정보 · 'unconfirmed' 확인 전 · 'unplugged' 길 없음 · 'ready'. */
export type PublishGate = "paused" | "placeholder" | "unconfirmed" | "unplugged" | "ready";
export function publishGate(opts: { paused: boolean; real: boolean; confirmed: boolean; ready: boolean }): PublishGate {
  if (opts.paused) return "paused";
  if (!opts.real) return "placeholder";
  if (!opts.confirmed) return "unconfirmed";
  if (!opts.ready) return "unplugged";
  return "ready";
}

/* ── 화면 ──────────────────────────────────────────────────── */

export type BulkScreenDeps = {
  context?: BulkContextPort; publisher?: BulkPublishPort;
  /** 잠금 상태. 기본은 creator-pause.ts 의 값 그대로. */
  paused?: boolean;
  /** 파일을 읽는 자리. 기본은 File.text(). */
  readFile?: (file: File) => Promise<string>;
};

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const el = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string) => root.querySelector<T>(`#${id}`)!;

const MARKUP = `
  <h1>${copyHtml("상품 대량 등록")}</h1>
  <p class="meta">${copyHtml("CSV 파일 하나로 여러 상품의 초안을 만들어 봐요. 파일을 고른다고 올라가지는 않아요. 하나씩 확인한 뒤에만 올려요.")}</p>
  <p class="warnbox bk-lock" id="bk-lock" role="status" hidden></p>
  <p class="warnbox bk-lock" id="bk-placeholder" role="status" hidden>${copyHtml("판매자 정보가 아직 연결되지 않아 임시 값으로 형식만 검사해요. 이 초안은 올릴 수 없어요.")}</p>
  <div class="card bk-card">
    <h2>${copyHtml("1. CSV 파일 고르기")}</h2>
    <div class="bk-row"><label class="bk-file"><span class="bk-filebtn">${copyHtml("CSV 파일 고르기")}</span><input type="file" id="bk-file" accept=".csv,text/csv" /></label><span class="meta" id="bk-filename"></span></div>
    <p class="meta">${copyHtml("한 번에 최대 500줄, 파일은 2MB 까지예요. 열 순서는 자유예요. 첫 줄은 열 이름이어야 해요.")}</p>
    <p class="meta"><b>${copyHtml("예시 (첫 줄은 열 이름, 둘째 줄부터 상품 한 개)")}</b></p>
    <pre class="bk-example" translate="no">${esc(CSV_EXAMPLE_HEADER)}\n${esc(CSV_EXAMPLE_ROW)}</pre>
    <p class="warnbox">${copyHtml("엑셀에서 열 때 주의: 칸이 =, +, -, @ 로 시작하면 엑셀이 수식으로 실행할 수 있어요. 모르는 사람이 보낸 파일은 엑셀로 열지 말고, 이 화면에서 바로 고르세요. 수식처럼 보이는 칸은 아래 표에 경고로 알려 드려요.")}</p>
  </div>
  <p class="meta" id="bk-say" role="status" aria-live="polite"></p>
  <div class="card bk-card" id="bk-errors" hidden>
    <h2>${copyHtml("고쳐야 할 곳")}</h2>
    <div class="bk-tablewrap"><table class="bk-table"><thead><tr><th>${copyHtml("줄")}</th><th>${copyHtml("칸")}</th><th>${copyHtml("이유")}</th></tr></thead><tbody id="bk-errrows"></tbody></table></div>
    <p class="meta">${copyHtml("오류가 있는 줄은 초안에서 빠져요. 파일을 고쳐서 다시 고르세요.")}</p>
  </div>
  <div class="card bk-card" id="bk-warns" hidden>
    <h2>${copyHtml("알려 드릴 것")}</h2>
    <div class="bk-tablewrap"><table class="bk-table"><thead><tr><th>${copyHtml("줄")}</th><th>${copyHtml("칸")}</th><th>${copyHtml("내용")}</th></tr></thead><tbody id="bk-warnrows"></tbody></table></div>
  </div>
  <div class="card bk-card" id="bk-drafts" hidden>
    <h2>${copyHtml("2. 초안 검토")}</h2>
    <p class="meta" id="bk-draftsum"></p>
    <div class="bk-tablewrap"><table class="bk-table"><thead><tr>
      <th>${copyHtml("줄")}</th><th>${copyHtml("제목")}</th><th>${copyHtml("종류")}</th><th>${copyHtml("가격")}</th><th>${copyHtml("파일")}</th><th>${copyHtml("기간·재고")}</th><th>${copyHtml("확인")}</th><th><span class="bk-sr">${copyHtml("올리기")}</span></th>
    </tr></thead><tbody id="bk-draftrows"></tbody></table></div>
    <p class="meta">${copyHtml("서명은 상품마다 따로 해요. 한 번에 모두 올리는 단추는 없어요.")}</p>
  </div>
`;

export function mountBulkScreen(root: HTMLElement, deps: BulkScreenDeps = {}) {
  const ctxPort = deps.context ?? placeholderContextPort, pub = deps.publisher ?? nullBulkPublisher;
  const paused = deps.paused ?? CREATOR_PUBLISH_PAUSED;
  const readFile = deps.readFile ?? (async (f: File) => f.text());
  root.innerHTML = MARKUP;
  let result: BulkResult | null = null, real = false;
  const confirmed = new Set<number>(), done = new Map<number, string>();
  let busy = false;

  const say = (render: () => string) => setCopyText(el(root, "bk-say"), render);
  if (paused) { const p = el(root, "bk-lock"); p.hidden = false; setCopyText(p, () => t("지금은 올리기를 잠가 두었어요. 초안을 만들고 검토하는 것까지만 할 수 있어요.")); }

  function issueTable(tbody: HTMLElement, issues: readonly BulkIssue[]) {
    tbody.innerHTML = issueRows(issues).map(i => `<tr><td>${i.line}</td><td class="bk-col"></td><td class="bk-why"></td></tr>`).join("");
    const rows = tbody.querySelectorAll("tr"), sorted = issueRows(issues);
    rows.forEach((tr, k) => {
      setCopyText(tr.querySelector(".bk-col")!, () => columnLabel(sorted[k].column));
      setCopyText(tr.querySelector(".bk-why")!, () => t(sorted[k].say));
    });
  }
  const gateOf = (d: BulkDraft) => publishGate({ paused, real, confirmed: confirmed.has(d.line), ready: pub.ready });
  const gateNote = (g: PublishGate) => g === "paused" ? (pub.signReady ? t("서명 준비됨 · 올리기는 잠겨 있어요") : t("지금은 올리기를 잠가 두었어요")) : g === "placeholder" ? t("판매자 정보 연결 전") : g === "unplugged" ? t("올리기 길 연결 전") : g === "unconfirmed" ? t("먼저 확인해 주세요") : "";

  function paintDrafts() {
    const box = el(root, "bk-drafts");
    if (!result || result.drafts.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    const rows = draftRows(result);
    setCopyText(el(root, "bk-draftsum"), () => tf("초안 {0}개 · 확인 {1}개 · 올림 {2}개", rows.length, confirmed.size, done.size));
    el(root, "bk-draftrows").innerHTML = rows.map(({ draft: d, priceText, kindText }) => {
      const g = gateOf(d), finished = done.has(d.line);
      return `<tr data-line="${d.line}" data-done="${finished}">
        <td>${d.line}</td>
        <td class="bk-title" translate="no">${esc(d.body.title)}${d.warnings.length ? ` <span class="bk-flag" data-flag>!</span>` : ""}</td>
        <td translate="no">${esc(kindText)}</td>
        <td translate="no">${esc(priceText)} RVN</td>
        <td class="bk-files"></td>
        <td class="bk-extra"></td>
        <td><label class="bk-confirm"><input type="checkbox" data-confirm="${d.line}" ${confirmed.has(d.line) ? "checked" : ""} ${finished ? "disabled" : ""}/> <span>${copyHtml("확인했어요")}</span></label></td>
        <td class="bk-act"><button type="button" data-sign="${d.line}" ${g !== "ready" || finished || busy ? "disabled" : ""}>${copyHtml("서명해서 올리기")}</button><p class="meta bk-gate"></p></td></tr>`;
    }).join("");
    el(root, "bk-draftrows").querySelectorAll<HTMLElement>("tr").forEach((tr, k) => {
      const d = rows[k].draft, g = gateOf(d);
      setCopyText(tr.querySelector(".bk-files")!, () => d.fileUrls.length ? tf("{0}개", d.fileUrls.length) : t("없음"));
      setCopyText(tr.querySelector(".bk-extra")!, () => `${tf("{0}일", d.downloadDays)} · ${d.stock === null ? t("재고 제한 없음") : tf("재고 {0}", d.stock)}`);
      setCopyText(tr.querySelector(".bk-gate")!, () => done.has(d.line) ? t("올렸어요") : gateNote(g));
    });
  }

  async function load(file: File) {
    if (busy) return; busy = true;
    try {
      el(root, "bk-filename").textContent = file.name;
      confirmed.clear(); done.clear(); result = null;
      if (file.size > MAX_CSV_BYTES) { say(() => t("파일이 너무 커요(2MB 까지).")); paint(); return; }
      const text = await readFile(file);
      const info = await ctxPort.get(); real = info.real;
      result = parseBulkProducts(text, info.ctx);
      const bad = (text.match(/�/g) ?? []).length;
      say(() => bad > 0 ? t("글자가 깨진 곳이 있어요. CSV 를 UTF-8 로 저장해서 다시 골라 주세요.")
        : result!.fileErrors.length ? t("파일을 읽지 못했어요.")
        : result!.ok ? tf("{0}줄을 읽었어요. 문제 없는 초안 {1}개예요. 하나씩 확인해 주세요.", result!.rowCount, result!.drafts.length)
        : tf("{0}줄 중 {1}개만 초안이 됐어요. 아래 오류를 고쳐서 다시 골라 주세요.", result!.rowCount, result!.drafts.length));
    } catch { result = null; say(() => t("파일을 읽지 못했어요.")); } finally { busy = false; paint(); }
  }

  function paint() {
    el(root, "bk-placeholder").hidden = !(result && !real);
    const errs = result ? [...result.fileErrors, ...result.rowErrors] : [];
    el(root, "bk-errors").hidden = errs.length === 0;
    if (errs.length) issueTable(el(root, "bk-errrows"), errs);
    const warns = result ? result.warnings : [];
    el(root, "bk-warns").hidden = warns.length === 0;
    if (warns.length) issueTable(el(root, "bk-warnrows"), warns);
    paintDrafts();
  }

  el<HTMLInputElement>(root, "bk-file").addEventListener("change", ev => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void load(f);
    (ev.target as HTMLInputElement).value = "";
  });
  root.addEventListener("change", ev => {
    const c = (ev.target as HTMLElement).closest<HTMLInputElement>("[data-confirm]");
    if (!c) return;
    const line = Number(c.dataset.confirm);
    if (c.checked) confirmed.add(line); else confirmed.delete(line);
    paintDrafts();
  });
  root.addEventListener("click", ev => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-sign]");
    if (!b || b.disabled || busy || !result) return;
    const draft = result.drafts.find(d => d.line === Number(b.dataset.sign));
    // 올리기 직전에 한 번 더 문을 확인한다 — 화면 상태가 아니라 규칙이 막는다.
    if (!draft || gateOf(draft) !== "ready" || done.has(draft.line)) return;
    busy = true; paintDrafts();
    void pub.publish(draft).then(r => {
      if (r.ok) { done.set(draft.line, r.id ?? ""); say(() => tf("{0}줄 상품을 올렸어요.", draft.line)); }
      else say(() => t(r.say));
    }).catch(() => say(() => t("올리지 못했어요. 다시 해 주세요."))).finally(() => { busy = false; paintDrafts(); });
  });
  paint();
  return { enter() { paint(); }, result: () => result, BULK_LIMITS };
}
