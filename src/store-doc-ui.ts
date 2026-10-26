/*
 * 「가게 번호」 — 가게 문서(rv-store v1, rev 0)를 이 컴퓨터에서 만들어 가게 번호(storeId = rev 0 본문 해시)를 얻는 카드. (판매자 기능)
 *
 * 규칙은 지갑 core/store/store-doc.ts 를 그대로 쓴다(만들기·검사·번호). 이 파일은 입력 → 본문 → 서명(StoreKeyPort) → 확인 → 저장과 화면만 가진다.
 * 🔴 게시·공개·업로드는 하지 않는다. 문서는 이 기기 안(localStorage)에 두고, 사장이 「파일로 내보내기」를 눌러 한 번 더 확인한 뒤에만 파일로 내보낸다.
 *    (공개하는 순간 공개키가 곧 가게 신원이 된다 — 되돌릴 수 없는 시점이라 이 화면에는 그 길이 없다.)
 * 🔴 키: 가게 키는 이 파일에 없다. 서명은 StoreKeyPort.signDigest 콜백(Rust store_sign_digest — 앱 잠금 중 거절 · 사장 확인창에 사유 표시)뿐이다.
 * 🔴 한 번 만든 문서는 지우거나 덮어쓰는 길이 없다(번호를 잃으면 이미 발급한 기기 증서가 주인을 잃는다). 고치는 판(rev 1~)은 아직 없다.
 * style="…" 속성은 쓰지 않는다(CSP) — 모양은 device-connect.css.
 */
import {
  StoreError, encodeStoreDoc, signStoreDoc, storeDocHash, storeIdOf, storeKeyFingerprint, validateStoreDoc, verifyStoreDoc,
  type StoreBody, type StoreDoc,
} from "../core/store/store-doc";
import { STORE_CATEGORIES, STORE_CATEGORY_LABELS, STORE_DEFAULT_LIFETIME_SECONDS, STORE_INTRO_MAX, STORE_NAME_MAX, STORE_NOTICE_DEFAULT, STORE_REGION_MAX, type StoreCategory } from "../core/store/limits";
import { DICT } from "./dict";
import { STORE_DOC_COPY } from "./store-doc-copy";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import type { StoreKeyPort } from "./device-connect";

for (const [source, values] of Object.entries(STORE_DOC_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

/** 서명할 때 사장 확인창에 그대로 보이는 사유(80자 이하 한 줄). */
export const STORE_DOC_REASON = "가게 문서 서명 - 가게 번호를 만듭니다(올리지 않음)";
export const STORE_DOC_STORAGE_KEY = "rv-store-doc-v1";

export type StoreInput = { name: string; intro: string; category: string; region: string };
export type StoreDocRecord = { doc: StoreDoc; storeId: string; createdAt: number };

/** 입력 → rev 0 본문. 연락처·사진은 비워 둔다(공개 문서가 아니라 번호를 만드는 첫 판). 검사는 core validateStoreDoc 이 한다. */
export function buildRev0Body(input: StoreInput, storeKey: string, nowMs: number): StoreBody {
  const issuedAt = Math.floor(nowMs / 1000);
  return {
    v: 1, kind: "store", seller: storeKey, name: input.name.trim(), intro: input.intro.trim(), category: input.category as StoreCategory, area: { region: input.region.trim() },
    contacts: [], notice: STORE_NOTICE_DEFAULT, photos: [], rev: 0, id: null, prev: null, issuedAt, expiresAt: issuedAt + STORE_DEFAULT_LIFETIME_SECONDS,
  };
}
/** 서명하기 전에 본문을 core 규칙으로 먼저 검사한다(서명 확인창을 띄우기 전에 입력 오류를 알려 주려고). 던지면 StoreError. */
export function precheck(body: StoreBody): void { validateStoreDoc({ ...body, sig: "" }); }

/**
 * 가게 문서 만들기. 순서: 가게 키 확인 → 본문 검사 → 서명(사장 확인창) → core 로 다시 확인 → 번호.
 * 서명한 사람이 body.seller(= 가게 키)가 아니면 core(signMessageWith)가 거절한다. 저장은 호출자.
 */
export async function createStoreDoc(key: StoreKeyPort, input: StoreInput, nowMs: number): Promise<StoreDocRecord> {
  const info = await key.info();
  if (!info) throw new Error("store-key-not-connected");
  const body = buildRev0Body(input, info.storeKey, nowMs);
  precheck(body);
  const signer = (key.withReason?.(STORE_DOC_REASON) ?? key).signDigest;
  const doc = await signStoreDoc(signer, body);
  const v = verifyStoreDoc(encodeStoreDoc(doc), { now: Math.floor(nowMs / 1000) });
  if (v.doc.rev !== 0 || v.storeId !== storeDocHash(doc) || v.doc.seller !== info.storeKey) throw new Error("store-verify");
  return { doc, storeId: v.storeId, createdAt: nowMs };
}

/* ── 저장(이 기기 안) ─────────────────────────────────────── */

export type StoreDocStorage = { load(): StoreDocRecord | null; save(r: StoreDocRecord): void };
/** 읽을 때마다 core 규칙으로 다시 거른다: 모양 · rev 0 · 서명자 = seller(core verifyStoreDoc). (만료는 보지 않는다 — 번호는 만료돼도 그대로다.) */
export function recordFrom(raw: unknown): StoreDocRecord | null {
  try {
    const r = raw as { doc?: unknown; createdAt?: unknown };
    if (!r || typeof r !== "object") return null;
    const doc = validateStoreDoc(r.doc);
    if (doc.rev !== 0) return null;
    // 서명 확인은 core verifyStoreDoc 으로, 시각은 발행 시각에 맞춘다 — 지금 만료됐어도 번호(본문 해시)는 그대로이므로 거르지 않는다.
    verifyStoreDoc(encodeStoreDoc(doc), { now: doc.issuedAt });
    return { doc, storeId: storeIdOf(doc), createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0 };
  } catch { return null; }
}
export function localStoreDocStorage(storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()): StoreDocStorage {
  return {
    load() { try { return recordFrom(JSON.parse(storage?.getItem(STORE_DOC_STORAGE_KEY) ?? "null")); } catch { return null; } },
    save(r) { try { storage?.setItem(STORE_DOC_STORAGE_KEY, JSON.stringify({ doc: r.doc, createdAt: r.createdAt })); } catch { /* 저장 못 하면 번호도 없다 — 화면이 알린다 */ } },
  };
}
export function memoryStoreDocStorage(initial: StoreDocRecord | null = null): StoreDocStorage {
  let s = initial;
  return { load: () => (s ? structuredClone(s) : null), save: next => { s = structuredClone(next); } };
}

/**
 * 가게 번호(기기 증서·철회 목록의 storeId). 저장된 문서의 seller 가 지금 가게 키와 같을 때만 돌려준다 —
 * 지갑을 다른 12단어로 바꿨다면 옛 번호로 새 키가 서명하는 일이 없게 null(= 발급 닫힘).
 */
export function matchedStoreId(rec: StoreDocRecord | null, storeKey: string | null): string | null {
  return rec && storeKey && rec.doc.seller === storeKey ? rec.storeId : null;
}
export async function savedStoreId(invoke: <T>(c: string, a?: Record<string, unknown>) => Promise<T>, docs: StoreDocStorage = localStoreDocStorage()): Promise<string | null> {
  const rec = docs.load();
  if (!rec) return null;
  const r = await invoke<{ store_key?: string }>("store_key_info");
  return matchedStoreId(rec, typeof r?.store_key === "string" ? r.store_key : null);
}

/** 내보내기 파일 이름·내용(정본 JSON 그대로 — 받는 쪽이 바이트로 다시 검사한다). */
export const exportName = (rec: StoreDocRecord) => `rv-store-${rec.storeId.slice(0, 12)}.json`;
export const exportBytes = (rec: StoreDocRecord): Uint8Array => encodeStoreDoc(rec.doc);

/* ── 화면 ─────────────────────────────────────────────────── */

export type StoreCardDeps = {
  key: StoreKeyPort; docs: StoreDocStorage; now: () => number;
  confirm: (title: string, message: string, okLabel?: string) => Promise<boolean>;
  exportFile: (name: string, bytes: Uint8Array) => Promise<void>;
  /** 문서를 만들었거나 상태가 바뀌었을 때(기기 화면이 키 상태를 다시 읽는다). */
  onChange: () => void;
};
export function downloadExport(name: string, bytes: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return Promise.resolve();
}

const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function storeErrorSay(e: unknown): string {
  const code = e instanceof StoreError ? e.code : e instanceof Error ? e.message : "";
  if (code === "store-text") return t("가게 이름이나 소개 글을 다시 확인해 주세요. 이름은 비울 수 없고, 「인증·공식·보증」 같은 말은 쓸 수 없어요.");
  if (code === "store-area") return t("지역은 대략적인 동네 이름만 적어 주세요. 숫자(번지·좌표)는 쓸 수 없어요.");
  if (code === "store-category") return t("분류를 골라 주세요.");
  if (code === "store-key-not-connected") return t("가게 키 서명이 아직 연결되지 않았어요. 연결 전에는 만들 수 없어요.");
  if (code === "store-verify") return t("만든 문서가 검사를 통과하지 못했어요. 저장하지 않았어요.");
  return t("만들지 못했어요. 앱이 잠겨 있거나 서명을 허락하지 않으면 만들어지지 않아요.");
}

const MARKUP = `
  <h2>${copyHtml("가게 번호")}</h2>
  <p class="meta" id="sd-state" role="status"></p>
  <div id="sd-form" class="dv-form">
    <p class="meta">${copyHtml("가게 문서를 만들면 가게 번호가 정해지고, 기기 증서 발급과 끊기가 열려요. 문서는 이 컴퓨터에만 두고 어디에도 올리지 않아요.")}</p>
    <label>${copyHtml("가게 이름")} <input id="sd-name" maxlength="${STORE_NAME_MAX}" autocomplete="off" /></label>
    <label>${copyHtml("지역 (대략)")} <input id="sd-region" maxlength="${STORE_REGION_MAX}" autocomplete="off" /></label>
    <label>${copyHtml("분류")} <select id="sd-category"></select></label>
    <label>${copyHtml("소개 (선택)")} <textarea id="sd-intro" rows="3" maxlength="${STORE_INTRO_MAX}"></textarea></label>
    <div class="dv-row"><button type="button" id="sd-create">${copyHtml("가게 문서 만들기")}</button></div>
  </div>
  <div id="sd-done" hidden>
    <p class="meta">${copyHtml("가게 번호")}</p>
    <p><code id="sd-id" translate="no"></code></p>
    <p class="meta" id="sd-sig"></p>
    <p class="meta" id="sd-dates"></p>
    <p class="meta">${copyHtml("이 문서는 아직 어디에도 올리지 않았어요. 이 컴퓨터에만 있어요.")}</p>
    <div class="dv-row"><button type="button" id="sd-export" class="ghost">${copyHtml("파일로 내보내기")}</button></div>
  </div>
  <p class="meta" id="sd-say" role="status" aria-live="polite"></p>
`;

export function mountStoreDocCard(root: HTMLElement, deps: StoreCardDeps) {
  root.innerHTML = MARKUP;
  const q = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const catSel = q<HTMLSelectElement>("sd-category");
  catSel.add(new Option(t("고르세요"), ""));
  for (const c of STORE_CATEGORIES) catSel.add(new Option(t(STORE_CATEGORY_LABELS[c]), c));
  let rec: StoreDocRecord | null = null;
  let busy = false;
  const say = (render: () => string) => setCopyText(q("sd-say"), render);

  function paint() {
    rec = deps.docs.load();
    q("sd-form").hidden = !!rec; q("sd-done").hidden = !rec;
    (q("sd-create") as HTMLButtonElement).disabled = busy;
    setCopyText(q("sd-state"), () => rec ? t("가게 문서가 있어요. 번호가 정해졌어요.") : t("가게 문서가 아직 없어요. 만들기 전에는 기기 증서 발급과 끊기가 닫혀 있어요."));
    if (rec) {
      const r = rec;
      q("sd-id").textContent = r.storeId;
      setCopyText(q("sd-sig"), () => tf("서명 확인됨 · 키 지문 {0}", `${storeKeyFingerprint(r.doc.seller).slice(0, 8)}…${storeKeyFingerprint(r.doc.seller).slice(-8)}`));
      setCopyText(q("sd-dates"), () => tf("{0} 만듦 · {1} 까지 유효", day(r.createdAt || r.doc.issuedAt * 1000), day(r.doc.expiresAt * 1000)));
    }
  }
  async function create() {
    if (busy || deps.docs.load()) return;
    const input: StoreInput = { name: q<HTMLInputElement>("sd-name").value, region: q<HTMLInputElement>("sd-region").value, category: catSel.value, intro: q<HTMLTextAreaElement>("sd-intro").value };
    busy = true; paint();
    try {
      const info = await deps.key.info();
      if (!info) throw new Error("store-key-not-connected");
      precheck(buildRev0Body(input, info.storeKey, deps.now()));
      const ok = await deps.confirm(
        t("가게 문서를 만들까요?"),
        `${t("이 내용으로 가게 번호가 정해져요. 같은 내용을 다시 만들면 번호가 달라져요.")}\n${tf("가게 이름: {0}", input.name.trim())}\n${tf("지역: {0}", input.region.trim())}\n${t("이어서 가게 키 서명 확인창이 떠요. 어디에도 올리지 않아요.")}`,
        t("만들기"),
      );
      if (!ok) { say(() => t("만들지 않았어요.")); return; }
      const made = await createStoreDoc(deps.key, input, deps.now());
      deps.docs.save(made);
      if (deps.docs.load()?.storeId !== made.storeId) throw new Error("store-verify");
      say(() => t("가게 번호를 만들었어요. 올리지는 않았어요."));
      deps.onChange();
    } catch (e) { const m = storeErrorSay(e); say(() => m); } finally { busy = false; paint(); }
  }
  async function doExport() {
    if (!rec) return;
    const r = rec;
    const ok = await deps.confirm(
      t("내보내기 전에 한 번 더 확인해요"),
      `${t("이 파일에는 가게 이름·소개·지역과 가게 공개키가 들어 있어요.")}\n${t("다른 곳에 올리거나 보내면 받은 사람은 누구나 볼 수 있고, 되돌릴 수 없어요.")}\n${t("레이븐볼트는 이 파일을 어디에도 올리지 않아요.")}`,
      t("내보내기"),
    );
    if (!ok) { say(() => t("내보내지 않았어요.")); return; }
    try { await deps.exportFile(exportName(r), exportBytes(r)); say(() => t("파일로 내보냈어요. 올리지는 않았어요.")); }
    catch { say(() => t("내보내지 못했어요.")); }
  }
  root.addEventListener("click", ev => {
    const b = (ev.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.id === "sd-create") void create();
    else if (b.id === "sd-export") void doExport();
  });
  paint();
  return { paint, record: () => rec };
}
