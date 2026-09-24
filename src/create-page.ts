/* 「만들기」 화면 — 증명서·티켓·작품.
 *
 * 폰(RavenVault)의 만들기와 같은 흐름이다: 고르기 → 제목·장수 → 확인(비용 한 숫자)
 * → 처음이면 이름 등록 → 기록되면 마저 만들기 → 확인 링크·QR.
 * 발행은 이 컴퓨터의 노드 지갑이 한다(create.rs). 파일은 올리지 않고 지문만 새긴다.
 *
 * 0.4.5 — 증명서는 **진짜 문서**가 된다(Pages 처럼 양식을 고르고, 채우면서 바로 본다):
 *   · 받는 사람(한 줄에 한 명)·발급일·발급자·설명·서명 → A4 한 장에 한 사람, 인쇄·PDF.
 *     🔴 이 칸들은 체인에도 파일창고에도 안 간다. 러스트의 만든 기록(0600)과 종이에만.
 *   · 만든 것은 기록에 남아, 나중에 다시 열어 QR·링크를 보고 다시 인쇄한다.
 *   · 이름 등록(500 RVN)은 이름을 다시 쳐야 하고, 8초 동안 그만둘 수 있다.
 *   · 원하는 이름이 이미 있으면 「혹시 폰이나 다른 컴퓨터에서 만든 내 이름인가요?」를
 *     먼저 묻고, 새 이름으로 가는 것은 손으로 고른 뒤에만 열린다.
 *   · 티켓은 끝나면 「팔기」로 이어진다.
 */
import { setStyledSrcdoc } from "./srcdoc-style";
import { lang, setCopyText, tf } from "./i18n";
import { issuedOf, OWNER_NOT_PINNED } from "./whose";
import {
  MAX_COPIES, MAX_TICKETS, brandCandidates, brandFrom, fileFingerprint, findFreeRun, itemNames,
  parseDraft, parseRecipients, recipientSlots, runOf, todayYmd, totalRvn, validBrand, verifyLink,
  type CertTemplate, type CreateDraft, type CreateKind,
} from "./easy-create";
import { wireBulk, type Line } from "./cert-bulk";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Status = { brands: string[]; pending: string[]; spendable: number; locked: boolean };
/** 표로 올린 줄의 칸(받는 사람 말고) — 러스트 create_history 의 `rows`. */
type RowCells = { course: string; grade: string; number: string; date: string };
type Details = {
  template?: CertTemplate; recipients: string[]; issued_on: string; issuer: string; signer: string;
  description: string; file_name: string; lang: string; display_title?: string;
  photo_slot?: boolean; rows?: RowCells[];
};
/** 한 번에 여러 장 — 50장씩 나눠 한 조각에 기록 하나·발행 한 번. */
type Chunk = { idx: number[]; state: "todo" | "done" | "bad" | "unknown"; historyId?: string; names?: string[]; txid?: string; why?: string };
type Batch = {
  title: string; brand: string; fingerprint: string; base: Details; photoSlot: boolean;
  /** 확인할 때 굳힌 줄(표를 더 고쳐도 보내는 중인 묶음은 안 바뀐다). */
  lines: { row: Line["row"]; photo: string | null }[];
  chunks: Chunk[]; usedRuns: Set<number>; date: Date; started?: number; finished?: number;
};
type Review = {
  kind: CreateKind; title: string; count: number; brand: string; wanted: string; needsBrand: boolean;
  names: string[]; total: number; fingerprint: string; fileName: string; details: Details;
  /** 첫 조각의 사진(이름 등록과 함께 가는 경우). */
  photos?: (string | null)[];
  batch?: Batch;
};
/** 러스트의 만든 기록 한 줄(create_history.rs). 받는 사람 이름이 들어 있다 — 화면에만 그린다. */
export type CreateEntry = {
  id: string | null; status?: string; kind: CreateKind; title: string; display_title?: string; brand: string;
  count: number; names: string[]; fingerprint?: string | null; file_name?: string; template?: CertTemplate;
  recipients?: string[]; issued_on?: string; issuer?: string; signer?: string; description?: string;
  txid?: string; done_at?: number; at?: number; lang?: string; photo_slot?: boolean;
};
export type CreateDeps = {
  invoke: Invoke;
  t: (s: string) => string;
  go: (page: string) => void;
  openLink: (url: string) => void;
  /** 되돌릴 수 없는 일 앞의 8초 취소 창(main.ts 의 holdBeforeDoing). */
  hold: (what: string, cost: string) => Promise<boolean>;
  /** 예/아니오 창. */
  sure: (title: string, message: string, ok: string) => Promise<boolean>;
  /** 그 자산의 팔기 창을 연다. 아직 목록에 없으면 거짓. */
  sell: (asset: string) => Promise<boolean>;
  /** 설정에서 고른 AI(라비). 열쇠가 없으면 null. */
  aiProvider: () => string | null;
};
export type CreateApi = {
  enter: () => void;
  /** 창에 떨어뜨린 문서로 증명서 만들기를 연다. 파일은 올리지 않고 지문만. */
  startWithDocument: (doc: { fingerprint: string; name: string }) => void;
  /** 증명서 폼이 열려 있을 때 떨어뜨린 명단 표·사진. 받았으면 참. */
  dropFiles: (paths: string[]) => Promise<boolean>;
  /** 지금 명단 표·사진을 받을 수 있나(증명서 폼이 열려 있다). */
  acceptsRoster: () => boolean;
  /** 확인 표로 만드는 중인가 — 사진 한 장을 놓으면 그 줄 사진으로 본다. */
  rosterActive: () => boolean;
};

const DRAFT_KEY = "playx-raven-create-draft";
/** 확인 표 한 번에 — cert-types 의 MAX_ROSTER_ROWS 와 같다. */
const MAX_BATCH_ROWS = 500;
const ISSUER_KEY = "playx-raven-create-issuer";
const POLL_MS = 20_000;
/** 지문은 공개된다 — 짧거나 양식이 정해진 문서는 지문만으로 내용을 맞춰 볼 수 있다. */
export const FINGERPRINT_GUESS = "짧거나 양식이 정해진 문서는 지문만으로도 내용을 짐작당할 수 있어요 — 알려지면 안 되는 문서는 붙이지 마세요.";
const KIND_NAME: Record<CreateKind, string> = { certificate: "증명서", ticket: "티켓", work: "작품" };
const FORM_TITLE: Record<CreateKind, string> = { certificate: "증명서 만들기", ticket: "티켓 만들기", work: "작품 만들기" };
const TEMPLATE_NAME: Record<CertTemplate, string> = { course: "수료증", proof: "증명서", thanks: "감사장" };
const TEMPLATE_BODY: Record<CertTemplate, string> = {
  course: "위 사람은 위 과정을 성실히 마쳤기에 이 증서를 드립니다.",
  proof: "위 사람이 위 내용을 갖추었음을 증명합니다.",
  thanks: "보내 주신 마음과 수고에 깊이 감사드리며 이 글을 드립니다.",
};

export function wireCreate(deps: CreateDeps): CreateApi {
  const { invoke, t, go, openLink } = deps;
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = el("page-create");
  const kinds = el("cr-kinds"), form = el("cr-form"), reviewBox = el("cr-review"), waitBox = el("cr-wait");
  const doneBox = el("cr-done"), historyBox = el("cr-history");
  const titleIn = el<HTMLInputElement>("cr-title"), countIn = el<HTMLInputElement>("cr-count"), makerIn = el<HTMLInputElement>("cr-maker");
  const brandSel = el<HTMLSelectElement>("cr-brand"), fileIn = el<HTMLInputElement>("cr-file"), say = el("cr-say");
  const recipientsIn = el<HTMLTextAreaElement>("cr-recipients"), dateIn = el<HTMLInputElement>("cr-date");
  const issuerIn = el<HTMLInputElement>("cr-issuer"), signerIn = el<HTMLInputElement>("cr-signer");
  const descIn = el<HTMLTextAreaElement>("cr-desc"), preview = el<HTMLIFrameElement>("cr-preview");
  let kind: CreateKind = "certificate", status: Status | null = null, review: Review | null = null;
  let template: CertTemplate = "course";
  let fingerprint = "", fileName = "", busy = false, timer: number | undefined, epoch = 0;
  /** 고치는 중인 기록 — 있으면 폼은 「인쇄할 내용 고치기」다(체인은 안 건드린다). */
  let editing: CreateEntry | null = null;
  /** 한 번에 여러 장 — 확인한 뒤 보내는 중이거나 멈춘 묶음(메모리에만. 이름이 들어 있다). */
  let batch: Batch | null = null;
  /** 묶음을 보내는 중 — 화면을 떠났다 돌아와도 「보내는 중」 기록을 「모름」으로 보지 않는다. */
  let batchRunning = false;
  const bulk = wireBulk({
    invoke, t, sure: deps.sure, aiProvider: deps.aiProvider,
    title: () => titleIn.value, issuedOn: () => dateIn.value || todayYmd(), template: () => template, issuer: () => issuerIn.value,
    setBody: (text) => { descIn.value = text; },
    onChange: () => schedulePreview(),
    onModeChange: () => paintRecipientsSay(),
  });

  const loadDraft = (): CreateDraft | null => { try { return parseDraft(localStorage.getItem(DRAFT_KEY)); } catch { return null; } };
  const saveDraft = (d: CreateDraft | null) => { try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY); } catch { /* 이어하기만 못 할 뿐 */ } };
  const tell = (render: () => string) => setCopyText(say, render);
  const quiet = () => say.replaceChildren();
  const rawText = (e: unknown) => String(e instanceof Error ? e.message : e ?? "");
  // 러스트가 돌려준 말도 값이 안 섞인 것은 사전에 있다 — 없으면 한국어 그대로.
  // 앞의 표지(`SENT_UNKNOWN: ` 같은 것)는 화면이 알아보는 데만 쓰고 보여 주지 않는다.
  const errText = (e: unknown) => t(rawText(e).replace(/^[A-Z_]+: /, ""));
  /** 🔴 보냈는지 모름 — 노드가 **보내는 부름에서** 제때 답하지 않았다. 이미 보냈을 수 있다.
   *  러스트가 보내는 부름에만 붙이는 표지로만 가린다. 보내기 **전** 읽기(listmyassets)가
   *  늦은 것(「…20초 안에 답하지 않았습니다」)은 아무것도 안 나갔다 — 그걸 「모름」으로
   *  보면 화면이 영영 기다리거나, 만들지도 않은 증서를 「만들었어요」로 보였다(검수 S6·S7). */
  const sentUnknown = (e: unknown) => /^SENT_UNKNOWN: /.test(rawText(e));
  const SENDING_NOTE = "보내는 중 — 창을 닫지 마세요 (최대 3분)";
  /** 만든 기록 파일이 망가졌다 — 「기록을 새로 시작」 단추를 같이 낸다. */
  function tellError(e: unknown) {
    if (!/^CREATE_HISTORY_CORRUPT: /.test(rawText(e))) { tell(() => errText(e)); return; }
    const text = document.createElement("span");
    setCopyText(text, () => errText(e));
    const restart = button("기록을 새로 시작", () => void (async () => {
      if (!(await deps.sure(t("기록을 새로 시작할까요?"), t("망가진 기록 파일은 지우지 않고 옆에 남겨 둬요. 원본 지문은 건질 수 있는 만큼 건져요. 받는 사람 이름 같은 지난 기록은 새 기록에 없어요 — 필요하면 백업에서 되살려 주세요."), t("새로 시작")))) return;
      try {
        const r = await invoke<{ kept: string; fingerprints: number }>("create_history_restart");
        tell(() => tf("새로 시작했어요. 망가진 파일은 {0}(으)로 남겨 뒀어요.", r.kept));
        void paintHistoryCount();
      } catch (err) { tell(() => errText(err)); }
    })(), true);
    say.replaceChildren(text, document.createTextNode(" "), restart);
  }

  function show(part: "kinds" | "form" | "review" | "wait" | "done" | "history") {
    kinds.hidden = part !== "kinds"; form.hidden = part !== "form";
    reviewBox.hidden = part !== "review"; waitBox.hidden = part !== "wait"; doneBox.hidden = part !== "done";
    historyBox.hidden = part !== "history";
    el("cr-history-open-wrap").hidden = part !== "kinds";
    // 증명서 폼·완료 화면은 미리보기·목록 칸이 옆에 붙어 넓게 쓴다.
    page.classList.toggle("cr-wide", (part === "form" && (kind === "certificate" || !!editing)) || part === "done" || part === "history");
    if (part !== "wait" && timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (part === "kinds") void paintHistoryCount();
  }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, copy?: string | (() => string), cls?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (copy !== undefined) setCopyText(e, typeof copy === "string" ? () => t(copy) : copy);
    return e;
  }
  function data(tag: "p" | "div" | "b" | "span" | "code", value: string, cls?: string) {
    const e = document.createElement(tag);
    e.textContent = value; e.setAttribute("translate", "no");
    if (cls) e.className = cls;
    return e;
  }
  function button(copy: string, onClick: () => void, ghost = false) {
    const b = node("button", copy);
    b.type = "button"; if (ghost) b.className = "ghost";
    b.addEventListener("click", onClick);
    return b;
  }
  function actionsRow(...children: HTMLElement[]) {
    const actions = document.createElement("div");
    actions.className = "cr-actions";
    actions.append(...children);
    return actions;
  }
  async function loadStatus(): Promise<Status> {
    status = await invoke<Status>("create_status");
    return status;
  }

  /* ── 1. 고르기 · 2. 적기 ─────────────────────────────────────────── */
  function resetForm() {
    editing = null;
    titleIn.value = ""; recipientsIn.value = ""; descIn.value = ""; signerIn.value = "";
    dateIn.value = todayYmd();
    try { issuerIn.value = localStorage.getItem(ISSUER_KEY) || ""; } catch { issuerIn.value = ""; }
    fileIn.value = ""; fingerprint = ""; fileName = "";
    paintFileSay();
    bulk.reset();
  }
  function paintKindFields() {
    const cert = kind === "certificate", editMode = !!editing;
    setCopyText(el("cr-form-title"), () => t(editMode ? "인쇄할 내용 고치기" : FORM_TITLE[kind]));
    for (const id of ["cr-tpls", "cr-recipients-wrap", "cr-doc-fields", "cr-desc-wrap", "cr-signer-wrap", "cr-private-say", "cr-preview-wrap"]) {
      el(id).hidden = !(cert || (editMode && editing?.kind === "work" && id !== "cr-tpls"));
    }
    // 로고·도장·사진 칸은 증명서(고치기 포함)에. 표 도구는 새로 만들 때만.
    el("cr-look").hidden = !(cert || (editMode && editing?.kind === "certificate"));
    bulk.setEditMode(editMode);
    // 고치기에서는 체인에 이미 있는 것(장수·이름·파일)을 못 바꾼다 — 칸을 감춘다.
    for (const id of ["cr-count-wrap", "cr-who-wrap", "cr-file-wrap"]) el(id).hidden = editMode;
    el("cr-check").hidden = editMode; el("cr-kind-back").hidden = editMode;
    el("cr-edit-save").hidden = !editMode; el("cr-edit-cancel").hidden = !editMode;
    setCopyText(el("cr-file-label"), () => t(cert ? "원본 문서 붙이기 (선택)" : "사진·파일 붙이기 (선택)"));
    setCopyText(el("cr-count-label"), () => t(kind === "ticket" ? "티켓 몇 장" : "몇 장"));
    paintTemplates();
    paintRecipientsSay();
  }
  function paintTemplates() {
    el("cr-tpls").querySelectorAll<HTMLButtonElement>("[data-cr-tpl]").forEach((b) => {
      const on = b.dataset.crTpl === template;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    descIn.placeholder = t(TEMPLATE_BODY[template]);
  }
  async function openForm(next: CreateKind) {
    kind = next; review = null; editing = null; quiet();
    countIn.max = String(kind === "ticket" ? MAX_TICKETS : MAX_COPIES);
    if (kind === "ticket" && countIn.value === "1") countIn.value = "100";
    if (kind !== "ticket" && countIn.value === "100") countIn.value = "1";
    if (!dateIn.value) dateIn.value = todayYmd();
    paintKindFields();
    show("form");
    titleIn.focus();
    try {
      const s = await loadStatus();
      // 🔴 방금 만든 브랜드는 한 블록 동안 「기록 중」이다(BRAND! 가 쓰였다가 돌아오는 중).
      //    그걸 빼고 보면 화면이 「처음」으로 바뀌어, 철자만 다르게 적으면 500 RVN 새
      //    브랜드 확인까지 갔다(검수 S4). 목록에 「기록 중」으로 같이 보여 준다.
      const pending = (s.pending ?? []).filter((b) => !s.brands.includes(b));
      const any = s.brands.length + pending.length > 0;
      el("cr-brand-wrap").hidden = !any;
      el("cr-maker-wrap").hidden = any;
      const option = (b: string, recording: boolean) => {
        const o = document.createElement("option");
        o.value = b; o.setAttribute("translate", "no");
        o.textContent = recording ? `${b} · ${t("기록 중")}` : b;
        if (recording) o.dataset.pending = "1";
        return o;
      };
      brandSel.replaceChildren(...s.brands.map((b) => option(b, false)), ...pending.map((b) => option(b, true)));
    } catch (e) {
      el("cr-brand-wrap").hidden = true; el("cr-maker-wrap").hidden = false;
      tell(() => tf("노드 지갑을 읽지 못했습니다: {0}", errText(e)));
    }
    paintMaker();
    void bulk.loadMarks();
    schedulePreview();
  }
  function paintMaker() {
    const preview = brandFrom(makerIn.value);
    const out = el("cr-maker-say");
    if (preview) setCopyText(out, () => tf("체인에는 {0}(으)로 새겨요", preview));
    else if (makerIn.value.trim()) setCopyText(out, () => t("영문이나 한글로 3자 이상 적어 주세요."));
    else out.replaceChildren();
  }
  function paintFileSay() {
    const out = el("cr-file-say");
    el("cr-file-clear").hidden = !fingerprint;
    // 🔴 지문은 소금 없이 파일 그대로의 해시다. 짧거나 양식이 뻔한 문서는 누가 후보를
    //    만들어 대 보면 맞출 수 있다 — 정직하게 한 줄 말한다.
    if (fingerprint) setCopyText(out, () => `${tf("붙인 파일 · {0} · 원본은 이 컴퓨터에 두고, 지문만 체인에 새겨요.", fileName)} ${t(FINGERPRINT_GUESS)}`);
    else setCopyText(out, () => t("파일은 올리지 않아요. 이 컴퓨터에서 지문만 만들어 체인에 새겨요."));
  }
  function paintRecipientsSay() {
    const people = parseRecipients(recipientsIn.value);
    const out = el("cr-recipients-say");
    const cert = kind === "certificate" && !editing;
    // 확인 표로 만들 때는 장수 = 발행할 줄 수. 장수 칸은 감추고 안내는 표가 한다.
    const bulkOn = cert && bulk.active();
    el("cr-count-wrap").hidden = !!editing || bulkOn;
    page.classList.toggle("cr-bulk", bulkOn);
    if (bulkOn) return;
    // 받는 사람을 적으면 장수는 사람 수다 — 두 칸이 어긋날 수 없게 장수 칸을 잠근다.
    countIn.disabled = cert && people.length > 0;
    if (cert && people.length) countIn.value = String(Math.min(people.length, MAX_COPIES));
    if (people.length > MAX_COPIES) setCopyText(out, () => tf("{0}명이 넘으면 「표 올리기」로 한 번에 만들 수 있어요(500줄까지, 50장씩 나눠 보내요).", MAX_COPIES));
    else if (people.length) setCopyText(out, () => tf("{0}명 · 한 사람에 한 장씩 {0}장을 만들어요.", people.length));
    else if (editing) out.replaceChildren();
    else setCopyText(out, () => t("비워 두면 이름 칸이 빈 줄로 인쇄돼요. 손으로 적을 수 있어요."));
  }
  makerIn.addEventListener("input", () => { paintMaker(); schedulePreview(); });
  recipientsIn.addEventListener("input", () => { paintRecipientsSay(); schedulePreview(); });
  for (const input of [titleIn, dateIn, issuerIn, signerIn, descIn, countIn]) input.addEventListener("input", schedulePreview);
  titleIn.addEventListener("input", () => bulk.refreshIssued());
  dateIn.addEventListener("change", () => bulk.refreshIssued());
  brandSel.addEventListener("change", schedulePreview);
  el("cr-tpls").querySelectorAll<HTMLButtonElement>("[data-cr-tpl]").forEach((b) => b.addEventListener("click", () => {
    template = (b.dataset.crTpl as CertTemplate) || "course";
    paintTemplates(); schedulePreview();
  }));
  fileIn.addEventListener("change", async () => {
    const file = fileIn.files?.[0];
    fingerprint = ""; fileName = "";
    paintFileSay();
    if (!file) return;
    const out = el("cr-file-say");
    setCopyText(out, () => t("파일 지문을 만드는 중…"));
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error(t("512MB 이하 파일만 붙일 수 있어요."));
      fingerprint = await fileFingerprint(file); fileName = file.name;
      paintFileSay(); schedulePreview();
    } catch (e) {
      setCopyText(out, () => tf("파일 지문을 만들지 못했어요: {0}", errText(e)));
    }
  });
  el("cr-file-clear").addEventListener("click", () => { fileIn.value = ""; fingerprint = ""; fileName = ""; paintFileSay(); schedulePreview(); });

  /** 지금 칸에 적힌 인쇄 내용. 체인에는 안 간다. */
  function detailsNow(): Details {
    return {
      template: kind === "certificate" || editing?.kind === "certificate" ? template : undefined,
      // 고치기는 줄이 곧 차례 — 빈 줄도 자리를 지킨다(러스트 clean_details 도 같다).
      recipients: (editing ? recipientSlots : parseRecipients)(recipientsIn.value).slice(0, MAX_COPIES),
      issued_on: dateIn.value || todayYmd(),
      issuer: issuerIn.value.trim(), signer: signerIn.value.trim(), description: descIn.value.trim(),
      file_name: fileName, lang, photo_slot: bulk.photoSlot(),
    };
  }
  /** 확인 표 한 줄의 칸(받는 사람 말고). 빈 발급일은 위의 발급일을 쓴다(러스트 render). */
  const cellsOf = (row: Line["row"]): RowCells => ({ course: row.course, grade: row.grade, number: row.number, date: row.date });

  /* ── 미리보기 — 채우면서 바로 본다 ─────────────────────────────── */
  let previewTimer: number | undefined, previewTicket = 0;
  function schedulePreview() {
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void paintPreview(), 220);
  }
  async function paintPreview() {
    if (form.hidden || el("cr-preview-wrap").hidden) return;
    const mine = ++previewTicket;
    const d = detailsNow();
    let name = editing?.names?.[0] || "";
    if (!name) {
      const brand = (status?.brands.length ? brandSel.value : brandFrom(makerIn.value)) || "MYNAME";
      try { name = itemNames({ kind: "certificate", brand: validBrand(brand) ? brand : "MYNAME", title: titleIn.value, date: new Date(), count: 1, run: 0 })[0]; } catch { name = "MYNAME#CERT-1"; }
    }
    // 확인 표로 만들 때는 고른 줄(처음엔 첫 줄)을 그 줄의 과정·번호·사진과 함께 그린다.
    const line = !editing && kind === "certificate" ? bulk.selected() : null;
    const details = line
      ? { ...d, recipients: line.row.recipient ? [line.row.recipient] : [], rows: [cellsOf(line.row)] }
      : { ...d, recipients: d.recipients.slice(0, 1) };
    const entry: Record<string, unknown> = {
      kind: editing?.kind || kind, title: titleIn.value.trim() || t("제목"), fingerprint: editing ? editing.fingerprint || "" : fingerprint,
      names: [name], details,
    };
    if (line?.photo && d.photo_slot) entry.preview_photo = line.photo;
    const lines = bulk.lines();
    const at = line ? lines.indexOf(line) : -1;
    setCopyText(el("cr-preview-say"), () => at >= 0
      ? tf("미리보기 · {0}번째 줄 · 표에서 줄을 누르면 그 사람으로 바뀌어요", at + 1)
      : t("미리보기 · 인쇄하면 이 모양이에요 (A4 한 장에 한 사람)"));
    try {
      const [html, fonts] = await Promise.all([invoke<string>("create_certificate_preview", { entry, lang }), bulk.fontCss()]);
      if (mine === previewTicket) setStyledSrcdoc(preview, html, fonts);
    } catch { /* 미리보기는 덤이다 — 칸 검사는 확인하기가 한다 */ }
  }
  window.addEventListener("desktop-language-change", () => { paintTemplates(); schedulePreview(); });
  // 미리보기 종이는 칸 폭에 맞춰 준다(좁은 창·폰 폭) — A4(794px) 문서를 그 폭으로 줄인다.
  const paper = preview.parentElement as HTMLElement;
  new ResizeObserver(() => {
    const w = paper.clientWidth;
    if (w > 0) preview.style.transform = `scale(${w / 794})`;
  }).observe(paper);

  /* ── 한 번에 여러 장 — 50장씩 조각 ─────────────────────────────── */
  /** 확인할 때의 줄을 굳혀 조각으로 나눈다. 받는 사람 이름이 들어 있어 메모리에만 둔다. */
  function batchOf(title: string, brand: string, base: Details, roster: Line[], pick: number[], date: Date): Batch {
    const lines = pick.map((i) => ({ row: { ...roster[i].row }, photo: roster[i].photo }));
    const chunks: Chunk[] = [];
    for (let at = 0; at < lines.length; at += MAX_COPIES) {
      chunks.push({ idx: lines.slice(at, at + MAX_COPIES).map((_, k) => at + k), state: "todo" });
    }
    return { title, brand, fingerprint, base, photoSlot: !!base.photo_slot, lines, chunks, usedRuns: new Set(), date };
  }
  /** 남은 조각의 소각 + 수수료 합(RVN). 이름 등록이 필요하면 첫 조각에 500 RVN. */
  /** 🔴 보냈는지 모르는 조각(unknown)은 「남은 것」이 아니다 — 체인에 있을 수 있다. */
  const isLeft = (c: Chunk) => c.state === "todo" || c.state === "bad";
  const chunkOf = (id?: string | null) => (batch && id ? batch.chunks.find((c) => c.historyId === id) ?? null : null);
  function batchTotal(b: Batch, needsBrand: boolean): number {
    const left = b.chunks.filter(isLeft);
    const sum = left.reduce((a, c, i) => a + totalRvn("certificate", c.idx.length, needsBrand && i === 0), 0);
    return Math.round(sum * 1e8) / 1e8;
  }
  const leftRows = (b: Batch) => b.chunks.filter(isLeft).reduce((a, c) => a + c.idx.length, 0);
  const doneRows = (b: Batch) => b.chunks.filter((c) => c.state === "done").reduce((a, c) => a + c.idx.length, 0);
  function chunkDetails(b: Batch, c: Chunk): Details {
    return { ...b.base, recipients: c.idx.map((i) => b.lines[i].row.recipient), rows: c.idx.map((i) => cellsOf(b.lines[i].row)) };
  }
  function chunkPhotos(b: Batch, c: Chunk): (string | null)[] {
    return c.idx.map((i) => (b.photoSlot ? b.lines[i].photo : null));
  }

  /* ── 3. 확인 ─────────────────────────────────────────────────────── */
  async function check() {
    if (busy) return;
    // 보냈는지 모르는 것이 있으면 새로 만들지 않는다 — 그 화면으로 돌아간다.
    if (loadDraft()?.stage === "sent-unknown") { paintUnknown(); tell(() => t("보냈는지 아직 모르는 만들기가 있어요. 기록될 때까지 기다린 뒤 「다시 확인」을 눌러 주세요.")); return; }
    busy = true; quiet();
    const ticket = ++epoch;
    try {
      const title = titleIn.value.trim().slice(0, 80);
      if (!title) throw new Error(t("무엇을 만드는지 제목을 적어 주세요."));
      const details = detailsNow();
      // 확인 표(표 올리기·붙여넣기·사진·라비)로 만들면 발행할 줄만 — 50장씩 나눠 보낸다.
      const roster = kind === "certificate" && bulk.active() ? bulk.lines() : null;
      // 🔴 방금(보냈는지 모름이 풀린 것 포함) 만든 줄을 다시 만들지 않게 — 기록을 지금 다시 읽고 고른다.
      if (roster) { await bulk.refreshIssuedNow(); if (ticket !== epoch) return; }
      const pick = roster ? bulk.issuable() : [];
      if (roster && !pick.length) throw new Error(t("발행할 줄이 없어요. 확인 표에서 받는 사람을 채우거나 발행 체크를 켜 주세요."));
      const people = roster ? pick.map((i) => roster[i].row.recipient) : parseRecipients(recipientsIn.value);
      // 🔴 제목은 로마자로 바뀌어 체인 이름에 영원히 남는다. 받는 사람 이름이 섞이면 안 된다.
      if (people.some((p) => p.length >= 2 && title.includes(p))) throw new Error(t("제목에 받는 사람 이름이 들어 있어요. 제목은 증서 번호(체인)에 들어가니, 이름은 받는 사람 칸에만 적어 주세요."));
      if (!roster && kind === "certificate" && people.length > MAX_COPIES) throw new Error(tf("받는 사람은 한 번에 {0}명까지예요. 나눠서 만들어 주세요.", MAX_COPIES));
      if (people.some((p) => p.length > 60)) throw new Error(t("받는 사람 이름은 60자까지 적을 수 있어요."));
      const count = roster ? pick.length : kind === "certificate" && people.length ? people.length : Number(countIn.value);
      const max = roster ? MAX_BATCH_ROWS : kind === "ticket" ? MAX_TICKETS : MAX_COPIES;
      if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(tf("1부터 {0}까지 적어 주세요.", max.toLocaleString("en-US")));
      const s = await loadStatus();
      const pending = s.pending ?? [];
      const wanted = s.brands.length || pending.length ? brandSel.value : brandFrom(makerIn.value);
      if (!validBrand(wanted)) throw new Error(t("만드는 사람 이름을 영문이나 한글로 3자 이상 적어 주세요."));
      let brand = wanted, needsBrand = !s.brands.includes(wanted);
      // 방금 만든 것이 기록되는 중이면 그 브랜드는 「없는」 게 아니다 — 새로 등록하지 않는다.
      if (needsBrand && brandCandidates(wanted).some((b) => pending.includes(b))) {
        throw new Error(t("방금 만든 것이 기록되는 중이에요. 1~2분 뒤에 다시 확인해 주세요."));
      }
      // 🔴 기록 중인 이름이 하나라도 있으면 새 이름(500 RVN)은 등록하지 않는다 — 기록이
      //    끝나면 그 이름이 목록에 돌아온다.
      if (needsBrand && pending.length) {
        throw new Error(t("기록 중인 이름이 있어요. 기록이 끝나면(보통 1~2분) 그 이름으로 만들 수 있어요 — 새 이름은 그 뒤에 등록해 주세요."));
      }
      if (needsBrand) {
        brand = "";
        const list = brandCandidates(wanted);
        const taken = await invoke<boolean[]>("create_names_taken", { names: list });
        for (let i = 0; i < list.length; i++) {
          if (s.brands.includes(list[i])) { brand = list[i]; needsBrand = false; break; }
          if (!taken[i]) { brand = list[i]; break; }
        }
        if (!brand) throw new Error(tf("{0} 이름은 이미 쓰이고 있어요. 폰이나 다른 컴퓨터에서 만든 내 이름이라면 그 주인 표 「{1}!」를 이 컴퓨터로 옮겨 주세요. 아니라면 다른 이름을 적어 주세요.", wanted, wanted));
      }
      const date = new Date();
      if (roster) {
        const b = batchOf(title, brand, details, roster, pick, date);
        const first = b.chunks[0].idx.length;
        const { names } = needsBrand
          ? { names: itemNames({ kind, brand, title, date, count: first, run: 0 }) }
          : await findFreeRun((run) => itemNames({ kind, brand, title, date, count: first, run }), (probe) => invoke<boolean[]>("create_names_taken", { names: probe }));
        if (ticket !== epoch) return;
        // 이름 등록과 함께 가는 첫 조각은 예전 흐름(등록 → 기다림 → 마저 만들기)을 그대로 탄다.
        review = {
          kind, title, count: first, brand, wanted, needsBrand, names, total: batchTotal(b, needsBrand), fingerprint, fileName,
          details: chunkDetails(b, b.chunks[0]), photos: chunkPhotos(b, b.chunks[0]), batch: b,
        };
        paintReview(review, s);
        return;
      }
      const copies = kind === "ticket" ? 1 : count;
      const { names } = needsBrand
        ? { names: itemNames({ kind, brand, title, date, count: copies, run: 0 }) }
        : await findFreeRun((run) => itemNames({ kind, brand, title, date, count: copies, run }), (probe) => invoke<boolean[]>("create_names_taken", { names: probe }));
      if (ticket !== epoch) return;
      review = { kind, title, count, brand, wanted, needsBrand, names, total: totalRvn(kind, copies, needsBrand), fingerprint, fileName, details };
      paintReview(review, s);
    } catch (e) {
      tellError(e);
    } finally {
      busy = false;
    }
  }
  function paintReview(r: Review, s: Status) {
    const short = Math.max(0, r.total - s.spendable);
    const someoneHasIt = r.needsBrand && r.brand !== r.wanted;
    const parts: HTMLElement[] = [
      node("h3", "이렇게 만들어요"),
      data("p", `${t(KIND_NAME[r.kind])} · ${r.title}`),
    ];
    const b = r.batch;
    if (b) {
      // 🔴 돈이 드는 곳 — 장수 · 체인 수수료 합계 · 지갑 잔액을 크게. 모자라면 아래에서 단추가 잠긴다.
      const n = leftRows(b), chunks = b.chunks.filter((c) => c.state !== "done").length;
      parts.push(node("p", () => tf("양식 · {0}", t(TEMPLATE_NAME[r.details.template || "course"])), "meta"));
      const bill = document.createElement("div");
      bill.className = "cr-bill";
      const cell = (big: HTMLElement, small: string, cls = "") => {
        const d = document.createElement("div");
        if (cls) d.className = cls;
        d.append(big, node("span", small));
        return d;
      };
      bill.append(
        cell(node("b", () => tf("{0}장", n.toLocaleString("en-US"))), "발행할 증서"),
        cell(data("b", `${rvnText(r.total)} RVN`), "체인 수수료 합계"),
        cell(data("b", `${rvnText(s.spendable)} RVN`), "지갑 잔액", s.spendable < r.total ? "short" : ""),
      );
      parts.push(bill);
      parts.push(node("p", () => tf("한 장에 {0} RVN이 체인에 태워지고, 보낼 때마다 네트워크 수수료가 조금 붙어요 · {1}번에 나눠 보내요(한 번에 {2}장까지).", 5, chunks, MAX_COPIES), "meta"));
      const withPhoto = b.photoSlot ? b.lines.filter((l) => l.photo).length : 0;
      if (withPhoto) parts.push(node("p", () => tf("사진 {0}장을 함께 인쇄해요 · 사진은 이 컴퓨터에만 둬요.", withPhoto), "meta"));
      parts.push(node("p", "받는 사람·과정·사진은 체인에 올리지 않아요. 인쇄하는 종이와 이 컴퓨터에만 남아요.", "meta"));
      if (r.needsBrand && chunks > 1) {
        parts.push(node("p", () => tf("처음 한 번은 이름 등록이 먼저예요 — 등록과 함께 첫 {0}장을 만들고, 기록되면(1~2분) 「나머지 이어서 만들기」로 {1}장을 더 만들어요.", r.count, n - r.count), "meta"));
      }
    } else if (r.kind === "certificate") {
      const people = r.details.recipients;
      parts.push(node("p", () => tf("양식 · {0}", t(TEMPLATE_NAME[r.details.template || "course"])), "meta"));
      if (people.length) {
        parts.push(node("p", () => tf("받는 사람 {0}명", people.length), "meta"));
        parts.push(data("p", people.length > 3 ? `${people.slice(0, 3).join(", ")} …` : people.join(", "), "meta"));
      }
      parts.push(node("p", "받는 사람·발급자·설명은 체인에 올리지 않아요. 인쇄하는 종이와 이 컴퓨터에만 남아요.", "meta"));
    }
    const shown = b ? leftRows(b) : r.names.length;
    parts.push(
      node("p", r.kind === "certificate" ? "증서 번호(체인에 새겨질 이름)" : "체인에 새겨질 이름", "meta"),
      data("p", shown > 1 ? tf("{0} 외 {1}장", r.names[0], shown - 1) : r.names[0], "cr-name"),
    );
    parts.push(node("p", r.fingerprint ? () => tf("파일 지문을 함께 새겨요 · {0}", r.fileName) : () => t("파일 없이 만들어요."), "meta"));
    if (r.kind === "ticket") parts.push(node("p", () => tf("티켓 {0}장 · 나중에 더 만들 수 있어요", r.count.toLocaleString("en-US")), "meta"));
    if (!b) parts.push(node("p", "필요한 RVN", "meta"), data("p", `${r.total.toLocaleString("en-US", { maximumFractionDigits: 2 })} RVN`, "cr-cost"));
    if (r.needsBrand) parts.push(node("p", () => tf("처음 한 번은 이름 {0} 등록(500 RVN)이 들어가요. 다음부터는 만드는 값만 들어요.", r.brand), "meta"));
    parts.push(node("p", "이 RVN은 네트워크에 태워져 이름과 기록을 지키는 데 쓰여요. 저희가 받는 돈이 아니에요.", "meta"));

    // 🔴 원하던 이름을 누가 이미 쓴다 — 그 「누가」가 폰이나 다른 컴퓨터의 나일 수 있다.
    //    이 컴퓨터의 노드 지갑은 거기 있는 주인 표를 못 본다. 새 이름(500 RVN)으로 가기 전에
    //    묻고, 손으로 고르기 전에는 등록 단추가 안 열린다.
    let chose: HTMLInputElement | null = null;
    if (someoneHasIt) {
      const box = document.createElement("div");
      box.className = "cr-mine";
      box.append(
        node("h4", "혹시 폰이나 다른 컴퓨터에서 만든 내 이름인가요?"),
        node("p", () => tf("그렇다면 500 RVN을 들여 새 이름을 사지 마세요. {0} 이름의 주인 표 「{1}!」를 이 컴퓨터의 받기 주소로 옮기면, 여기서 그 이름으로 바로 만들 수 있어요.", r.wanted, r.wanted)),
        node("p", "다른 컴퓨터라면 그 컴퓨터의 자산 화면에서 「주인 자격 옮기기」로 옮겨요. 옮긴 것이 기록되면 「다시 확인하기」를 눌러 주세요.", "meta"),
        actionsRow(button("받기 주소 보기", () => go("wallet"), true), button("다시 확인하기", () => void check(), true)),
      );
      const label = document.createElement("label");
      label.className = "cr-choose";
      chose = document.createElement("input");
      chose.type = "checkbox"; chose.id = "cr-not-mine";
      label.append(chose, node("span", () => tf("내 이름이 아니에요. {0}(으)로 새로 등록할게요.", r.brand)));
      box.append(label);
      parts.push(box);
    }

    let pass: HTMLInputElement | null = null, typed: HTMLInputElement | null = null;
    const actions = actionsRow();
    if (short > 0) {
      parts.push(node("p", () => tf("{0} RVN이 더 필요해요 · 지갑 화면의 받기 주소로 다른 지갑이나 거래소에서 보내 주세요.", short.toLocaleString("en-US", { maximumFractionDigits: 2 })), "cr-warn"));
      actions.append(button("받기 주소 보기", () => go("wallet")), button("다시 확인하기", () => void check(), true));
    } else {
      if (r.needsBrand) {
        // 이름은 영원하다. 보이는 글자를 그대로 베끼게 하지 않고, 칸은 비워 둔다.
        const label = node("label", () => tf("등록할 이름 {0} 을(를) 그대로 적어 주세요", r.brand));
        typed = document.createElement("input");
        typed.id = "cr-brand-confirm"; typed.autocomplete = "off"; typed.spellcheck = false;
        typed.setAttribute("autocapitalize", "characters"); typed.setAttribute("translate", "no");
        label.append(typed);
        parts.push(label);
      }
      if (s.locked) {
        const label = node("label", "지갑 암호");
        pass = document.createElement("input");
        pass.type = "password"; pass.autocomplete = "current-password"; pass.id = "cr-pass";
        label.append(pass);
        parts.push(label);
      }
      if (r.needsBrand) parts.push(node("p", "두 번 진행해요. 먼저 이름 등록, 기록된 뒤에 만들기.", "meta"));
      const makeBtn = r.needsBrand || !b
        ? button(r.needsBrand ? "이름 등록하고 만들기" : "만들기", () => void make(r, pass))
        : node("button", () => tf("{0}장 만들기", leftRows(b).toLocaleString("en-US")));
      if (b && !r.needsBrand) { makeBtn.setAttribute("type", "button"); makeBtn.addEventListener("click", () => void make(r, pass)); }
      makeBtn.id = "cr-make";
      const gate = () => {
        const typedOk = !typed || typed.value.trim().toUpperCase() === r.brand;
        const choseOk = !chose || chose.checked;
        makeBtn.disabled = !(typedOk && choseOk);
      };
      typed?.addEventListener("input", gate);
      chose?.addEventListener("change", gate);
      gate();
      actions.append(makeBtn);
    }
    actions.append(button("고치기", () => show("form"), true));
    reviewBox.replaceChildren(...parts, actions);
    show("review");
  }

  /* ── 4. 만들기 ───────────────────────────────────────────────────── */
  const rvnText = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  async function make(r: Review, pass: HTMLInputElement | null) {
    if (busy) return;
    if (loadDraft()?.stage === "sent-unknown") { paintUnknown(); return; }
    if (r.batch && !r.needsBrand) { await makeBatch(r, pass); return; }
    busy = true; quiet();
    const makeBtn = document.getElementById("cr-make") as HTMLButtonElement | null;
    if (makeBtn) makeBtn.disabled = true;
    let historyId: string | undefined;
    try {
      // 🔴 되돌릴 수 없는 일 앞의 8초. 이름 등록은 500 RVN 이고 이름은 영원하다.
      // 여러 장이면 지금 태우는 것은 이름 등록 + 첫 조각뿐이다(나머지는 이어서 만들 때 다시 묻는다).
      const now = r.batch ? totalRvn("certificate", r.count, true) : r.total;
      const ok = r.needsBrand
        ? await deps.hold(tf("이름 「{0}」을(를) 등록해요", r.brand), tf("{0} RVN이 태워지고, 이 이름은 영원히 바뀌지 않아요", rvnText(now)))
        : await deps.hold(tf("「{0}」을(를) 만들어요", r.title), tf("{0} RVN이 태워지고 되돌릴 수 없어요", rvnText(r.total)));
      if (!ok) { if (makeBtn) makeBtn.disabled = false; return; }
      const passphrase = pass?.value || null;
      if (pass) pass.value = "";
      if (r.details.issuer) { try { localStorage.setItem(ISSUER_KEY, r.details.issuer); } catch { /* 기억만 못 할 뿐 */ } }
      // 기록을 먼저 연다. 못 열면 만들지 않는다 — 받는 사람과 지문을 잃은 채 체인에만 남으면 안 된다.
      historyId = await invoke<string>("create_history_begin", {
        entry: { kind: r.kind, title: r.title, brand: r.brand, count: r.count, fingerprint: r.fingerprint || null, details: r.details },
      }) || undefined;
      // 사진은 기록과 같은 자리에(0600) — 못 두면 만들지 않는다(아래 catch 가 기록을 지운다).
      if (historyId && r.photos?.some(Boolean)) await invoke("create_photos_save", { id: historyId, photos: r.photos });
      if (r.batch && historyId) { batch = r.batch; batch.chunks[0].historyId = historyId; }
      tell(() => t(SENDING_NOTE));
      if (r.needsBrand) {
        // 0.4.6 부터 `{ txid, owner_pinned, … }` — 이름 등록은 새 주인 표를 만드는 발행이다.
        const txid = issuedOf(await invoke<unknown>("create_issue", { step: "brand", brand: r.brand, names: [], quantity: 0, ipfsHash: null, passphrase, historyId })).txid;
        quiet();
        saveDraft({ version: 1, kind: r.kind, title: r.title, count: r.count, brand: r.brand, stage: "brand-sent", txid, fingerprint: r.fingerprint || undefined, updatedAt: Date.now(), historyId });
        paintWait();
        return;
      }
      await finish(r.kind, r.title, r.count, r.brand, r.fingerprint, r.names, passphrase, historyId);
    } catch (e) {
      if (sentUnknown(e)) {
        // 🔴 「실패」가 아니다. 노드가 이미 보냈을 수 있다 — 단추를 다시 열지 않는다.
        quiet();
        const step = r.needsBrand ? "brand" : r.kind === "ticket" ? "ticket" : "uniques";
        saveDraft({ version: 1, kind: r.kind, title: r.title, count: r.count, brand: r.brand, stage: "sent-unknown", step, txid: "", fingerprint: r.fingerprint || undefined, names: r.needsBrand ? [] : r.names, updatedAt: Date.now(), historyId });
        paintUnknown();
        return;
      }
      // 분명히 안 나갔다 — 받는 사람 이름이 든 시작 기록을 남기지 않는다(러스트는
      // 보냈는지 모르는 줄은 지우지 않는다).
      if (historyId) await invoke("create_history_forget", { id: historyId }).catch(() => {});
      // 보냈는지 모르는 것이 이미 있다(보내다 앱이 꺼진 것 포함) — 그 화면으로 간다.
      if (/^SENT_UNKNOWN_PENDING: /.test(rawText(e)) && (await adoptUnresolved())) { paintUnknown(); return; }
      const why = errText(e);
      tellError(e);
      if (makeBtn) makeBtn.disabled = false;
      // 그사이 지갑이 다시 잠겼으면 암호 칸이 보이도록 확인 화면을 새로 그린다.
      if (!pass && why.includes("잠겨")) { busy = false; await check(); tell(() => why); }
    } finally {
      busy = false;
    }
  }
  async function finish(k: CreateKind, title: string, count: number, brand: string, fp: string, names: string[], passphrase: string | null, historyId?: string) {
    const step = k === "ticket" ? "ticket" : "uniques";
    // 티켓·작품은 브랜드 주인 표(BRAND!)를 쓰고 돌려받는다. 러스트가 표가 지금 있는 주소를
    // 거스름 자리에 넣는다(0.4.6) — 못 넣었으면 발행은 나갔고, 한 줄로 알린다.
    const issued = issuedOf(await invoke<unknown>("create_issue", { step, brand, names, quantity: k === "ticket" ? count : 0, ipfsHash: fp || null, passphrase, historyId: historyId ?? null }));
    const txid = issued.txid;
    quiet();
    const draft: CreateDraft = { version: 1, kind: k, title, count, brand, stage: "done", txid: txid || "", fingerprint: fp || undefined, names, updatedAt: Date.now(), historyId };
    saveDraft(draft);
    await paintDone(await entryOf(draft));
    if (issued.ownerPinned === false) tell(() => t(OWNER_NOT_PINNED));
  }
  /* ── 4-1. 여러 장 — 조각마다 기록 하나 · 발행 한 번 ───────────────── */
  async function makeBatch(r: Review, pass: HTMLInputElement | null) {
    const b = r.batch!;
    busy = true; quiet();
    const makeBtn = document.getElementById("cr-make") as HTMLButtonElement | null;
    if (makeBtn) makeBtn.disabled = true;
    let passphrase: string | null = null;
    try {
      const ok = await deps.hold(tf("「{0}」 {1}장을 만들어요", r.title, leftRows(b).toLocaleString("en-US")), tf("{0} RVN이 태워지고 되돌릴 수 없어요", rvnText(r.total)));
      if (!ok) { if (makeBtn) makeBtn.disabled = false; return; }
      passphrase = pass?.value || null;
      if (pass) pass.value = "";
      if (r.details.issuer) { try { localStorage.setItem(ISSUER_KEY, r.details.issuer); } catch { /* 기억만 못 할 뿐 */ } }
      batch = b;
      await runBatch(b, passphrase);
    } finally {
      passphrase = null;
      busy = false;
    }
  }
  /** 남은 조각을 차례로 보낸다. 🔴 보냈는지 모르면 멈추고 그 화면으로(두 번 태우지 않게),
   *  분명히 안 나갔으면 그 조각의 기록을 지우고 멈춘다 — 「이어서 만들기」는 남은 조각만. */
  async function runBatch(b: Batch, passphrase: string | null) {
    b.started ??= Date.now();
    batchRunning = true;
    try { await sendChunks(b, passphrase); } finally { batchRunning = false; }
  }
  async function sendChunks(b: Batch, passphrase: string | null) {
    for (const c of b.chunks) {
      // 🔴 보낼 것은 「아직」인 조각뿐. 보냈는지 모르는(unknown) 조각을 다시 보내면 같은 사람
      //    50명이 두 번 태워진다(검수 09-24 — 250 RVN).
      if (c.state !== "todo") continue;
      if (loadDraft()?.stage === "sent-unknown") { paintUnknown(); return; }
      paintBatchProgress(b, c);
      let historyId: string | undefined;
      try {
        historyId = await invoke<string>("create_history_begin", {
          entry: { kind: "certificate", title: b.title, brand: b.brand, count: c.idx.length, fingerprint: b.fingerprint || null, details: chunkDetails(b, c) },
        }) || undefined;
        c.historyId = historyId;
        const photos = chunkPhotos(b, c);
        if (historyId && photos.some(Boolean)) await invoke("create_photos_save", { id: historyId, photos });
        const { run, names } = await findFreeRun(
          (n) => itemNames({ kind: "certificate", brand: b.brand, title: b.title, date: b.date, count: c.idx.length, run: n }),
          (probe) => invoke<boolean[]>("create_names_taken", { names: probe }),
          b.usedRuns,
        );
        b.usedRuns.add(run);
        c.names = names;
        const issued = issuedOf(await invoke<unknown>("create_issue", { step: "uniques", brand: b.brand, names, quantity: 0, ipfsHash: b.fingerprint || null, passphrase, historyId: historyId ?? null }));
        c.txid = issued.txid; c.state = "done"; c.why = undefined;
      } catch (e) {
        if (sentUnknown(e)) {
          c.state = "unknown";
          saveDraft({ version: 1, kind: "certificate", title: b.title, count: c.idx.length, brand: b.brand, stage: "sent-unknown", step: "uniques", txid: "", fingerprint: b.fingerprint || undefined, names: c.names ?? [], updatedAt: Date.now(), historyId });
          paintUnknown();
          return;
        }
        // 분명히 안 나갔다 — 받는 사람 이름·사진이 든 시작 기록을 남기지 않는다.
        if (historyId) await invoke("create_history_forget", { id: historyId }).catch(() => {});
        c.historyId = undefined; c.names = undefined; c.state = "bad"; c.why = errText(e);
        if (/^SENT_UNKNOWN_PENDING: /.test(rawText(e)) && (await adoptUnresolved())) { paintUnknown(); return; }
        break;
      }
    }
    b.finished = Date.now();
    bulk.refreshIssued();
    await paintBatchDone(b);
  }
  function paintBatchProgress(b: Batch, now: Chunk) {
    const total = b.lines.length, done = doneRows(b);
    const bar = document.createElement("div");
    bar.className = "cr-prog";
    const fill = document.createElement("i");
    fill.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    bar.append(fill);
    const list = document.createElement("ol");
    list.className = "cr-chunks";
    b.chunks.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = c === now ? "now" : c.state === "done" ? "done" : c.state === "bad" ? "bad" : "";
      const state = c === now ? "보내는 중…" : c.state === "done" ? "보냄" : c.state === "bad" ? "안 나감" : "기다림";
      li.append(node("span", () => tf("{0}번째 묶음 · {1}장", i + 1, c.idx.length)), node("span", state));
      list.append(li);
    });
    waitBox.replaceChildren(
      node("h3", () => tf("{0}장을 만드는 중이에요", total.toLocaleString("en-US"))),
      node("p", "창을 닫지 마세요 — 50장씩 나눠 보내요. 한 묶음에 보통 몇 초, 노드가 바쁘면 더 걸려요.", "meta"),
      bar,
      node("p", () => tf("{0} / {1}장", done, total), "meta"),
      list,
    );
    show("wait");
  }
  /** 이름 등록과 함께 첫 조각을 만든 뒤 — 나머지 조각을 다시 확인(잔액·암호)하고 이어서. */
  async function resumeBatch() {
    const b = batch;
    if (!b || busy) return;
    quiet();
    try {
      const s = await loadStatus();
      if (!s.brands.includes(b.brand)) throw new Error(t("이름 등록이 아직 기록되지 않았어요. 1~2분 뒤에 다시 눌러 주세요."));
      // 🔴 보냈는지 모르는 조각이 있으면 이어서 만들지 않는다 — 그 화면에서 풀려야 한다.
      if (b.chunks.some((c) => c.state === "unknown") || loadDraft()?.stage === "sent-unknown") {
        if (loadDraft()?.stage === "sent-unknown") paintUnknown();
        throw new Error(t("보냈는지 아직 모르는 묶음이 있어요. 기록될 때까지 기다린 뒤 이어서 만들어 주세요."));
      }
      for (const c of b.chunks) if (c.state === "bad") { c.state = "todo"; c.why = undefined; }
      const next = b.chunks.find((c) => c.state === "todo");
      if (!next) { await paintBatchDone(b); return; }
      const { names } = await findFreeRun(
        (n) => itemNames({ kind: "certificate", brand: b.brand, title: b.title, date: b.date, count: next.idx.length, run: n }),
        (probe) => invoke<boolean[]>("create_names_taken", { names: probe }),
        b.usedRuns,
      );
      review = {
        kind: "certificate", title: b.title, count: leftRows(b), brand: b.brand, wanted: b.brand, needsBrand: false, names,
        total: batchTotal(b, false), fingerprint: b.fingerprint, fileName, details: chunkDetails(b, next), batch: b,
      };
      paintReview(review, s);
    } catch (e) {
      tellError(e);
    }
  }
  /** 한 묶음이 체인에 나갔다(이름 등록과 함께 간 첫 묶음, 보냈는지 모름이 풀린 묶음). */
  function markChunkDone(c: Chunk, names: string[]) {
    c.state = "done"; c.names = names; c.why = undefined;
    if (batch) batch.started ??= Date.now();
    const run = runOf(names[0] ?? "");
    if (run >= 0) batch?.usedRuns.add(run);
    bulk.refreshIssued();
  }
  type Made = { c: Chunk; j: number; row: Line["row"]; name: string };
  const madeRows = (b: Batch): Made[] => b.chunks.flatMap((c) => (c.state === "done" && c.names ? c.idx.map((i, j) => ({ c, j, row: b.lines[i].row, name: c.names![j] })) : []));
  async function saveList(b: Batch, ext: "xlsx" | "csv") {
    const rows = madeRows(b);
    const first = rows[0]?.c.historyId;
    if (!first) return;
    try {
      const m = await import("./cert-roster");
      const issued = rows.map(({ c, row, name }) => ({
        recipient: row.recipient, course: row.course || b.title, grade: row.grade, date: row.date || b.base.issued_on,
        number: row.number, asset: name, txid: c.txid ?? "", verifyUrl: verifyLink(name),
      }));
      const bytes = ext === "xlsx" ? m.resultXlsx(issued) : m.resultCsv(issued);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await invoke("certificate_file_save", { kind: "list", name: `${first}.${ext}`, data: btoa(bin), open: true });
      tell(() => t("번호 목록 표를 열었어요. 받는 사람 이름이 든 파일이라 먼저 이 컴퓨터의 앱 폴더에 만들었어요 — 열린 프로그램에서 원하는 곳에 저장해 주세요."));
    } catch (e) {
      tell(() => errText(e));
    }
  }
  async function paintBatchDone(b: Batch) {
    const made = madeRows(b);
    const total = b.lines.length, left = total - made.length;
    const stopped = b.chunks.find((c) => c.state === "bad");
    let index = 0;
    const qr = document.createElement("div"), current = data("p", "", "cr-name"), who = data("p", "", "cr-who");
    qr.className = "cr-qr";
    const list = document.createElement("ol");
    list.className = "cr-list";
    const rowsEl: HTMLButtonElement[] = [];
    const paint = async () => {
      rowsEl.forEach((x, i) => x.setAttribute("aria-current", i === index ? "true" : "false"));
      current.textContent = made[index]?.name ?? "";
      who.textContent = made[index]?.row.recipient ?? "";
      try {
        const svg = await invoke<string>("qr_svg", { text: verifyLink(made[index].name) });
        qr.innerHTML = svg.startsWith("<svg") || svg.startsWith("<?xml") ? svg : "";
      } catch { qr.replaceChildren(); }
    };
    made.forEach((m, i) => {
      const li = document.createElement("li");
      li.className = "cr-li2";
      const x = document.createElement("button");
      x.type = "button"; x.className = "cr-row";
      x.append(data("span", String(i + 1), "cr-no"), data("span", m.row.recipient || "—", "cr-person"), data("span", m.name, "cr-chain"));
      x.addEventListener("click", () => { index = i; void paint(); });
      const one = button("이 사람만", () => void printOne(m.c.historyId!, m.j), true);
      one.className = "ghost cr-one";
      rowsEl.push(x); li.append(x, one); list.append(li);
    });
    const secs = b.started && b.finished ? Math.max(1, Math.round((b.finished - b.started) / 1000)) : 0;
    const head: HTMLElement[] = [
      node("h3", () => (left ? tf("{0}장 중 {1}장을 만들었어요", total, made.length) : tf("{0}장을 만들었어요", made.length))),
      node("p", "블록에 기록되면 누구나 이 링크로 진짜인지 확인할 수 있어요. 보통 1~2분 걸려요.", "meta"),
      node("p", () => [`${t("증명서")} · ${b.title}`, tf("{0}번에 나눠 보냈어요", b.chunks.filter((c) => c.state === "done").length), secs ? tf("걸린 시간 {0}초", secs) : ""].filter(Boolean).join(" · ")),
    ];
    if (left) {
      const why = stopped?.why ? ` — ${stopped.why}` : "";
      head.push(node("p", () => tf("나머지 {0}장은 안 나갔어요{1}. 이미 만든 줄은 다시 만들지 않아요.", left, why), "cr-warn"));
    }
    const ids = b.chunks.filter((c) => c.state === "done" && c.historyId).map((c) => c.historyId!);
    const primary = actionsRow();
    if (left) primary.append(button(tf("나머지 {0}장 이어서 만들기", left), () => void resumeBatch()));
    if (made.length) {
      primary.append(
        node("button", () => tf("전체 인쇄 · PDF로 저장 ({0}장)", made.length)),
        button("번호 목록 표 받기 (엑셀)", () => void saveList(b, "xlsx"), true),
      );
      const all = primary.children[primary.children.length - 2] as HTMLButtonElement;
      all.type = "button";
      all.addEventListener("click", () => void printMany(ids));
    }
    const secondary = actionsRow(
      button("링크 복사", async () => {
        try { await navigator.clipboard.writeText(verifyLink(made[index].name)); tell(() => t("링크를 복사했어요.")); } catch { tell(() => t("복사하지 못했어요. QR을 보여 주세요.")); }
      }, true),
      button("확인 페이지 열기", () => openLink(verifyLink(made[index].name)), true),
      button("CSV로 받기", () => void saveList(b, "csv"), true),
      button("하나 더 만들기", () => { saveDraft(null); batch = null; resetForm(); show("kinds"); }, true),
      button("만든 것 보기", () => void paintHistory(), true),
    );
    const side = document.createElement("div");
    side.className = "cr-done-side";
    side.append(qr, who, current);
    const grid = document.createElement("div");
    grid.className = "cr-done-grid";
    grid.append(list, side);
    const notes = [
      node("p", "「전체 인쇄」는 한 파일에 A4 여러 쪽 — 인쇄 창에서 「PDF로 저장」하면 묶음 PDF 하나가 돼요. 「이 사람만」은 그 사람 한 장만 열어요.", "meta"),
      node("p", "받는 사람 이름·사진은 확인 페이지(/verify)에 나오지 않아요. 번호와 QR로 진짜인지만 확인해요.", "meta"),
    ];
    doneBox.replaceChildren(...head, ...(made.length ? [grid] : []), ...notes, primary, secondary);
    show("done");
    if (made.length) await paint();
  }
  async function printOne(id: string, index: number) {
    tell(() => t("인쇄할 파일을 만드는 중…"));
    try {
      await invoke("create_print", { id, lang, index });
      tell(() => t("브라우저에서 열었어요. ⌘P(윈도우는 Ctrl+P)를 누르면 인쇄하거나 「PDF로 저장」할 수 있어요."));
    } catch (err) { tell(() => errText(err)); }
  }
  async function printMany(ids: string[]) {
    if (!ids.length) return;
    tell(() => t("인쇄할 파일을 만드는 중…"));
    try {
      await invoke("create_print_many", { ids, lang });
      tell(() => t("브라우저에서 열었어요. ⌘P(윈도우는 Ctrl+P)를 누르면 인쇄하거나 「PDF로 저장」할 수 있어요."));
    } catch (err) { tell(() => errText(err)); }
  }

  /** 이어하기 표에서 기록을 찾는다. 기록이 없으면(옛 표) 표만으로 그린다 — 인쇄는 못 한다. */
  async function entryOf(d: CreateDraft): Promise<CreateEntry> {
    if (d.historyId) {
      try {
        const e = await invoke<CreateEntry | null>("create_history_get", { id: d.historyId });
        if (e && Array.isArray(e.names) && e.names.length) return e;
      } catch { /* 아래로 */ }
    }
    return { id: null, kind: d.kind, title: d.title, brand: d.brand, count: d.count, names: d.names ?? [], fingerprint: d.fingerprint ?? null, txid: d.txid };
  }

  /* ── 5. 기다림 ───────────────────────────────────────────────────── */
  function paintWait() {
    const d = loadDraft();
    if (!d) { show("kinds"); return; }
    const head = node("h3", "이름을 등록하는 중이에요");
    const lede = node("p", "보통 1~2분, 길면 10분쯤 걸려요. 창을 닫아도 괜찮아요 — 다시 열면 여기서 이어서 해요.", "meta");
    const state = node("p", "기록 기다리는 중", "meta");
    let pass: HTMLInputElement | null = null;
    const passWrap = document.createElement("div");
    const goOn = button("마저 만들기", () => void continueAfterBrand(d, pass));
    goOn.hidden = true;
    const actions = actionsRow(goOn, button("처음부터 다시", () => void startOver(d), true));
    const txShort = d.txid ? data("p", d.txid.slice(0, 8) + "…" + d.txid.slice(-6), "meta") : document.createElement("span");
    waitBox.replaceChildren(head, lede, node("p", "등록할 이름", "meta"), data("p", d.brand, "cr-name"), state, txShort, passWrap, actions);
    show("wait");
    const look = async () => {
      // 다른 화면으로 가면 묻지 않는다. 다시 들어오면 enter() 가 새로 시작한다.
      if (!page.classList.contains("on") && timer !== undefined) { clearInterval(timer); timer = undefined; return; }
      try {
        const s = await loadStatus();
        if (!s.brands.includes(d.brand)) {
          // 노드 지갑은 떨어진 거래를 다시 보낸다 — 끝난 것은 「무효」(음수)뿐이다.
          const conf = await invoke<number>("create_tx_state", { txid: d.txid }).catch(() => 0);
          if (conf < 0) { clearInterval(timer); timer = undefined; setCopyText(state, () => t("이 등록은 무효가 됐어요. 「처음부터 다시」를 눌러 주세요.")); state.className = "cr-warn"; }
          return;
        }
        clearInterval(timer); timer = undefined;
        setCopyText(head, () => t("이름 등록이 끝났어요"));
        setCopyText(state, () => t("기록 완료 · 이제 마저 만들면 돼요."));
        if (s.locked && !pass) {
          const label = node("label", "지갑 암호");
          pass = document.createElement("input");
          pass.type = "password"; pass.autocomplete = "current-password"; pass.id = "cr-pass-wait";
          label.append(pass); passWrap.append(label);
        }
        goOn.hidden = false;
      } catch { /* 다음 차례에 다시 본다 */ }
    };
    void look();
    timer = window.setInterval(() => void look(), POLL_MS);
  }
  /* ── 5-1. 보냈는지 모름 ──────────────────────────────────────────── */
  /** 🔴 발행 부름이 시간 초과로 끝났다. 노드는 이미 보냈을 수 있다.
   *  여기서는 **다시 보내는 단추가 없다.** 체인·지갑에 보이면 이어서 가고, 한 시간이
   *  넘게 어디에도 안 보일 때만(러스트가 다시 확인) 「처음부터 다시」가 열린다. */
  function paintUnknown() {
    const d = loadDraft();
    if (!d || d.stage !== "sent-unknown") { show("kinds"); return; }
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    const state = node("p", "기록 기다리는 중", "meta");
    const giveUp = button("안 나갔어요 — 처음부터 다시", () => void (async () => {
      try {
        if (d.historyId) await invoke("create_resolve_not_sent", { id: d.historyId });
        // 여러 장 중 한 묶음이었다 — 그 묶음만 「아직」으로 돌리고 묶음 화면으로(나머지는 그대로).
        const c = chunkOf(d.historyId);
        if (c && batch) {
          clearInterval(timer); timer = undefined;
          saveDraft(null);
          if (d.historyId) await invoke("create_history_forget", { id: d.historyId }).catch(() => {});
          c.state = "todo"; c.historyId = undefined; c.names = undefined; c.why = undefined;
          await paintBatchDone(batch);
          return;
        }
        await startOver(d);
      } catch (e) { tell(() => errText(e)); }
    })(), true);
    giveUp.hidden = true;
    const again = button("다시 확인", () => void resolve());
    again.id = "cr-resolve";
    const probe = d.step === "brand" ? d.brand : (d.names?.[0] ?? "");
    waitBox.replaceChildren(
      node("h3", "보냈는지 아직 몰라요 — 기록될 때까지 기다려 주세요"),
      node("p", "노드가 제때 답하지 않았어요. 이미 보냈을 수 있으니 다시 만들지 마세요 — 같은 것이 두 번 태워질 수 있어요. 기록되면 여기서 저절로 이어져요.", "meta"),
      node("p", d.step === "brand" ? "등록할 이름" : "체인에 새겨질 이름", "meta"),
      data("p", d.step !== "brand" && (d.names?.length ?? 0) > 1 ? tf("{0} 외 {1}장", probe, (d.names?.length ?? 1) - 1) : probe, "cr-name"),
      state,
      actionsRow(again, giveUp),
    );
    show("wait");
    let checking = false;
    async function resolve() {
      if (checking) return;
      checking = true;
      try {
        const cur = loadDraft();
        if (!cur || cur.stage !== "sent-unknown") { clearInterval(timer); timer = undefined; enter(); return; }
        let found = false, gone = false, sending = false;
        if (cur.historyId) {
          const r = await invoke<{ state: string; entry?: CreateEntry & { brand_txid?: string }; waited?: number } | null>("create_resolve", { id: cur.historyId });
          const st = r?.state ?? "";
          // 🔴 「찾았다」는 **그 단계가 끝난 것**만. 이름 등록은 brand-sent, 만들기는 done.
          //    예전에는 만들기 단계에서도 brand-sent 를 찾은 것으로 보고, 만들지도 않은
          //    증서에 「만들었어요」와 QR 을 보였다(검수 S7).
          if (cur.step === "brand" ? st === "brand-sent" || st === "done" : st === "done") found = true;
          else if (st === "not-sent") gone = true;
          else if (st === "sending") sending = true;
          else if (st !== "unknown") {
            // 러스트 기록은 「모름」이 아니다(보내기 전에 멈췄다) — 화면의 「모름」을 풀고
            // 확인·기다림 화면으로 돌아간다.
            clearInterval(timer); timer = undefined;
            await leaveUnknown(cur, st, r?.entry);
            return;
          }
        } else {
          // 기록이 없는 옛 표 — 지갑·체인에 그 이름이 보이나만 본다.
          const name = cur.step === "brand" ? `${cur.brand}!` : (cur.names?.[0] ?? "");
          const [taken] = name ? await invoke<boolean[]>("create_names_taken", { names: [name] }) : [false];
          found = !!taken;
          gone = !found && Date.now() - cur.updatedAt >= 3600_000;
        }
        if (found) {
          clearInterval(timer); timer = undefined;
          if (cur.step === "brand") {
            saveDraft({ ...cur, stage: "brand-sent", updatedAt: Date.now() });
            paintWait();
          } else {
            const done: CreateDraft = { ...cur, stage: "done", updatedAt: Date.now() };
            saveDraft(done);
            const entry = await entryOf(done);
            // 여러 장 중 한 묶음이었다 — 그 묶음을 「보냄」으로 적고 묶음 화면으로(남은 것은 이어서 만들기).
            const c = chunkOf(cur.historyId);
            if (c && batch && batch.chunks.length > 1) {
              markChunkDone(c, entry.names ?? cur.names ?? []);
              await paintBatchDone(batch);
            } else await paintDone(entry);
          }
          return;
        }
        if (gone) {
          setCopyText(state, () => t("한 시간 넘게 체인과 지갑 어디에도 안 보여요 — 보내지 않은 것으로 보여요. 처음부터 다시 만들 수 있어요."));
          giveUp.hidden = false;
        } else if (sending) {
          setCopyText(state, () => t(SENDING_NOTE));
        } else {
          setCopyText(state, () => t("아직 안 보여요. 노드가 따라잡는 중일 수 있어요 — 조금 더 기다려 주세요."));
        }
      } catch (e) {
        setCopyText(state, () => errText(e));
      } finally {
        checking = false;
      }
    }
    void resolve();
    timer = window.setInterval(() => void resolve(), POLL_MS);
  }
  /** 러스트는 「모름」이 아니라고 한다 — 이름 등록이 끝났으면 기다림 화면, 아무것도 안
   *  나갔으면(started) 표를 치우고 확인 화면으로. */
  async function leaveUnknown(cur: CreateDraft, st: string, entry?: CreateEntry & { brand_txid?: string }) {
    if (st === "brand-sent") {
      const txid = typeof entry?.brand_txid === "string" && /^[0-9a-f]{64}$/.test(entry.brand_txid) ? entry.brand_txid : "";
      saveDraft({ ...cur, stage: "brand-sent", txid, names: undefined, step: undefined, updatedAt: Date.now() });
      paintWait();
      return;
    }
    saveDraft(null);
    if (st === "started" && cur.historyId) await invoke("create_history_forget", { id: cur.historyId }).catch(() => {});
    const c = chunkOf(cur.historyId);
    if (c && batch) {
      // 그 묶음은 안 나갔다 — 「아직」으로 돌리고 묶음 화면으로(이미 보낸 묶음은 그대로).
      c.state = "todo"; c.historyId = undefined; c.names = undefined; c.why = undefined;
      await paintBatchDone(batch);
      tell(() => t("보내지 않았어요 — 내용을 확인하고 다시 만들어 주세요."));
      return;
    }
    if (titleIn.value.trim()) { show("form"); await check(); } else show("kinds");
    tell(() => t("보내지 않았어요 — 내용을 확인하고 다시 만들어 주세요."));
  }
  /** 러스트 기록에 보냈는지 모르는 줄이 있으면(보내다 앱이 꺼진 것 포함) 이어하기 표를 그 줄로 맞춘다. */
  async function adoptUnresolved(): Promise<boolean> {
    type Row = CreateEntry & { id: string; status: string; unknown?: { step?: string; names?: string[]; at?: number } };
    const u = await invoke<Row | null>("create_unresolved").catch(() => null);
    if (!u || typeof u !== "object" || !u.id) return false;
    const cur = loadDraft();
    if (cur?.stage === "sent-unknown" && cur.historyId === u.id) return true;
    const step = u.unknown?.step === "brand" || u.unknown?.step === "ticket" || u.unknown?.step === "uniques" ? u.unknown.step : null;
    if (!step) return false;
    const names = Array.isArray(u.unknown?.names) ? u.unknown!.names!.filter((n) => typeof n === "string") : [];
    saveDraft({
      version: 1, kind: u.kind, title: u.title, count: u.count, brand: u.brand, stage: "sent-unknown", step, txid: "",
      fingerprint: u.fingerprint || undefined, names: step === "brand" ? [] : names,
      updatedAt: Number(u.unknown?.at) > 0 ? Number(u.unknown!.at) * 1000 : Date.now(), historyId: u.id,
    });
    return loadDraft()?.stage === "sent-unknown";
  }
  async function startOver(d: CreateDraft) {
    saveDraft(null);
    // 끝나지 않은 기록에는 받는 사람 이름이 들어 있다 — 그만두면 지운다.
    if (d.historyId) await invoke("create_history_forget", { id: d.historyId }).catch(() => {});
    show("kinds");
  }
  async function continueAfterBrand(d: CreateDraft, pass: HTMLInputElement | null) {
    if (busy) return;
    busy = true; quiet();
    try {
      const copies = d.kind === "ticket" ? 1 : d.count;
      const cost = totalRvn(d.kind, copies, false);
      if (!(await deps.hold(tf("「{0}」을(를) 만들어요", d.title), tf("{0} RVN이 태워지고 되돌릴 수 없어요", rvnText(cost))))) return;
      const passphrase = pass?.value || null;
      if (pass) pass.value = "";
      const date = new Date();
      const { names } = await findFreeRun((run) => itemNames({ kind: d.kind, brand: d.brand, title: d.title, date, count: copies, run }), (probe) => invoke<boolean[]>("create_names_taken", { names: probe }));
      tell(() => t(SENDING_NOTE));
      try {
        await finish(d.kind, d.title, d.count, d.brand, d.fingerprint ?? "", names, passphrase, d.historyId);
      } catch (e) {
        if (!sentUnknown(e)) throw e;
        quiet();
        const c = chunkOf(d.historyId);
        if (c) { c.state = "unknown"; c.names = names; }
        saveDraft({ ...d, stage: "sent-unknown", step: d.kind === "ticket" ? "ticket" : "uniques", txid: "", names, updatedAt: Date.now() });
        paintUnknown();
      }
    } catch (e) {
      tellError(e);
    } finally {
      busy = false;
    }
  }

  /* ── 6. 완료 — 그리고 나중에 다시 열 때도 같은 화면 ───────────────── */
  async function paintDone(e: CreateEntry) {
    const names = e.names ?? [];
    const people = e.recipients ?? [];
    // 여러 장 중 한 묶음(이름 등록과 함께 간 첫 묶음 등) — 묶음에 적고, 남은 조각이 있으면 이어서 만들 단추를 낸다.
    const mine = chunkOf(e.id);
    const b = mine ? batch : null;
    if (mine && mine.state !== "done") markChunkDone(mine, names);
    let index = 0;
    const qr = document.createElement("div"), current = data("p", "", "cr-name"), who = data("p", "", "cr-who");
    qr.className = "cr-qr";
    const list = document.createElement("ol");
    list.className = "cr-list";
    const rows: HTMLButtonElement[] = [];
    const paint = async () => {
      rows.forEach((b, i) => b.setAttribute("aria-current", i === index ? "true" : "false"));
      current.textContent = names[index] ?? "";
      who.textContent = people[index] ?? "";
      try {
        const svg = await invoke<string>("qr_svg", { text: verifyLink(names[index]) });
        // 우리 러스트가 그린 SVG 만 넣는다. 사용자 글자는 링크 안에서 인코딩돼 있다.
        qr.innerHTML = svg.startsWith("<svg") || svg.startsWith("<?xml") ? svg : "";
      } catch { qr.replaceChildren(); }
    };
    names.forEach((name, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "cr-row";
      b.append(data("span", String(i + 1), "cr-no"), data("span", people[i] || "—", "cr-person"), data("span", name, "cr-chain"));
      b.addEventListener("click", () => { index = i; void paint(); });
      rows.push(b); li.append(b); list.append(li);
    });

    const printable = !!e.id && (e.kind === "certificate" || e.kind === "work");
    const primary = actionsRow();
    if (b && leftRows(b) > 0) primary.append(button(tf("나머지 {0}장 이어서 만들기", leftRows(b)), () => void resumeBatch()));
    if (printable) {
      primary.append(button(names.length > 1 ? "모두 인쇄 · PDF로 저장" : "인쇄 · PDF로 저장", () => void printEntry(e)));
    }
    if (e.kind === "ticket") {
      primary.append(button("팔기", async () => {
        const ok = await deps.sell(names[0]).catch(() => false);
        if (!ok) tell(() => t("블록에 기록된 뒤에 팔 수 있어요. 1~2분 뒤에 다시 눌러 주세요."));
      }));
    }
    const secondary = actionsRow(
      button("링크 복사", async () => {
        try { await navigator.clipboard.writeText(verifyLink(names[index])); tell(() => t("링크를 복사했어요.")); } catch { tell(() => t("복사하지 못했어요. QR을 보여 주세요.")); }
      }, true),
      button("확인 페이지 열기", () => openLink(verifyLink(names[index])), true),
    );
    if (printable) secondary.append(button("인쇄할 내용 고치기", () => void openEdit(e), true));
    secondary.append(
      button("하나 더 만들기", () => { saveDraft(null); batch = null; resetForm(); show("kinds"); }, true),
      button("만든 것 보기", () => void paintHistory(), true),
    );
    if (e.id) {
      const id = e.id;
      secondary.append(button("기록에서 지우기", async () => {
        const ok = await deps.sure(t("이 기록을 지울까요?"), t("받는 사람 이름과 인쇄 파일이 이 컴퓨터에서 지워져요. 체인에 만든 것은 그대로 남아요."), t("지웁니다"));
        if (!ok) return;
        await invoke("create_history_forget", { id }).catch((err) => tell(() => errText(err)));
        const d = loadDraft();
        if (d?.historyId === id) saveDraft(null);
        await paintHistory();
      }, true));
    }

    const when = e.done_at ? new Date(e.done_at * 1000).toLocaleString(lang) : "";
    const head: HTMLElement[] = [
      node("h3", "만들었어요"),
      node("p", "블록에 기록되면 누구나 이 링크로 진짜인지 확인할 수 있어요. 보통 1~2분 걸려요.", "meta"),
      data("p", `${t(KIND_NAME[e.kind])} · ${e.display_title || e.title}${when ? " · " + when : ""}`),
    ];
    if (e.fingerprint) head.push(node("p", () => tf("원본 지문 · {0}", e.fingerprint!), "meta cr-fp"));
    const side = document.createElement("div");
    side.className = "cr-done-side";
    side.append(qr, who, current);
    const grid = document.createElement("div");
    grid.className = names.length > 1 ? "cr-done-grid" : "cr-done-one";
    if (names.length > 1) grid.append(list);
    grid.append(side);
    const notes: HTMLElement[] = [];
    if (e.kind === "certificate") {
      notes.push(node("p", "받는 사람에게 인쇄한 증서를 드리거나 PDF로 보내 주세요. 종이의 QR과 증서 번호로 누구나 진짜인지 확인할 수 있어요.", "meta"));
      notes.push(node("p", "받는 사람이 RavenVault를 쓰면 지갑 화면의 「자산 보내기」로 그 번호를 보낼 수도 있어요.", "meta"));
    } else if (e.kind === "ticket") {
      notes.push(node("p", "「팔기」에서 값과 장수를 정하면 판매 QR과 링크가 생겨요.", "meta"));
    } else {
      notes.push(node("p", "받는 사람에게 이 한 장을 보내려면 지갑 화면의 「자산 보내기」를 써요.", "meta"));
    }
    doneBox.replaceChildren(...head, grid, ...notes, primary, secondary);
    show("done");
    if (names.length) await paint();
  }
  async function printEntry(e: CreateEntry) {
    if (!e.id) return;
    tell(() => t("인쇄할 파일을 만드는 중…"));
    try {
      await invoke("create_print", { id: e.id, lang });
      tell(() => t("브라우저에서 열었어요. ⌘P(윈도우는 Ctrl+P)를 누르면 인쇄하거나 「PDF로 저장」할 수 있어요."));
    } catch (err) {
      tell(() => errText(err));
    }
  }

  /* ── 인쇄할 내용 고치기 — 같은 폼, 체인은 안 건드린다 ─────────────── */
  async function openEdit(e: CreateEntry) {
    if (!e.id) return;
    editing = e;
    kind = e.kind;
    template = e.template || "course";
    titleIn.value = e.display_title || e.title;
    recipientsIn.value = (e.recipients ?? []).join("\n");
    dateIn.value = e.issued_on || todayYmd();
    issuerIn.value = e.issuer || ""; signerIn.value = e.signer || ""; descIn.value = e.description || "";
    bulk.setPhotoSlot(!!e.photo_slot);
    paintKindFields();
    show("form");
    schedulePreview();
  }
  async function saveEdit() {
    if (!editing?.id || busy) return;
    busy = true; quiet();
    try {
      const people = recipientSlots(recipientsIn.value);
      if (people.length > editing.names.length) throw new Error(tf("받는 사람은 {0}명까지 적을 수 있어요 — 만든 장수만큼이에요.", editing.names.length));
      const d = { ...detailsNow(), display_title: titleIn.value.trim() !== editing.title ? titleIn.value.trim() : "", file_name: editing.file_name || "" };
      const saved = await invoke<CreateEntry>("create_history_details", { id: editing.id, details: d });
      editing = null;
      await paintDone(saved);
      tell(() => t("고쳤어요. 다시 인쇄하면 고친 내용으로 나와요."));
    } catch (err) {
      tell(() => errText(err));
    } finally {
      busy = false;
    }
  }
  el("cr-edit-save").addEventListener("click", () => void saveEdit());
  el("cr-edit-cancel").addEventListener("click", async () => {
    const e = editing;
    editing = null;
    if (e?.id) {
      try {
        const back = await invoke<CreateEntry | null>("create_history_get", { id: e.id });
        if (back && Array.isArray(back.names) && back.names.length) { await paintDone(back); return; }
      } catch { /* 아래로 */ }
    }
    show("kinds");
  });

  /* ── 만든 것 — 기록 목록 ───────────────────────────────────────── */
  async function paintHistoryCount() {
    const out = el("cr-history-count");
    try {
      const list = await invoke<CreateEntry[]>("create_history_list");
      if (list.length) setCopyText(out, () => tf("{0}건", list.length));
      else out.replaceChildren();
    } catch { out.replaceChildren(); }
  }
  async function paintHistory() {
    quiet();
    let list: CreateEntry[] = [];
    try { list = await invoke<CreateEntry[]>("create_history_list"); } catch (e) { tellError(e); }
    const parts: HTMLElement[] = [
      node("h3", "만든 것"),
      node("p", "받는 사람 이름은 이 컴퓨터에만 있어요. 눌러서 QR·링크를 다시 보고, 다시 인쇄할 수 있어요.", "meta"),
    ];
    if (!list.length) parts.push(node("p", "아직 만든 것이 없어요.", "meta"));
    const ul = document.createElement("ul");
    ul.className = "cr-hlist";
    for (const e of list) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "cr-hrow";
      const when = e.done_at ? new Date(e.done_at * 1000).toLocaleDateString(lang) : "";
      const people = e.recipients ?? [];
      const whoText = people.length ? (people.length > 1 ? tf("{0} 외 {1}명", people[0], people.length - 1) : people[0]) : "";
      const main = document.createElement("span");
      main.className = "cr-hmain";
      main.append(data("b", e.display_title || e.title), data("span", e.names?.[0] ?? "", "cr-chain"));
      const meta = document.createElement("span");
      meta.className = "cr-hmeta";
      meta.append(node("span", () => `${t(KIND_NAME[e.kind])} · ${tf("{0}장", e.names?.length || e.count)}`), data("span", whoText), data("span", when));
      b.append(main, meta);
      b.addEventListener("click", () => void paintDone(e));
      li.append(b); ul.append(li);
    }
    parts.push(ul, actionsRow(button("← 만들기", () => show("kinds"), true)));
    historyBox.replaceChildren(...parts);
    show("history");
  }

  /* ── 연결 ───────────────────────────────────────────────────────── */
  kinds.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((b) => b.addEventListener("click", () => void openForm(b.dataset.kind as CreateKind)));
  el("cr-check").addEventListener("click", () => void check());
  el("cr-kind-back").addEventListener("click", () => { quiet(); show("kinds"); });
  el("cr-back").addEventListener("click", () => { editing = null; show("kinds"); go("assets"); });
  el("cr-history-open").addEventListener("click", () => void paintHistory());
  resetForm();

  /** 화면을 열 때마다 — 하던 것이 있으면 그 자리에서. */
  async function enter() {
    // 묶음을 보내는 중이면 그 화면 그대로 — 끝나면 저절로 결과로 간다.
    if (batchRunning) { show("wait"); return; }
    quiet();
    // 🔴 보내는 도중 앱이 꺼지면 이어하기 표에는 아무것도 없다 — 러스트 기록이 기억한다(검수 S10).
    if (await adoptUnresolved()) { paintUnknown(); return; }
    const d = loadDraft();
    if (d?.stage === "sent-unknown") { paintUnknown(); return; }
    if (d?.stage === "brand-sent") { paintWait(); return; }
    // 끝난 것은 한 번 보여 주고 표를 치운다 — 기록은 「만든 것」에 남아 있다.
    if (d?.stage === "done" && d.names?.length) { saveDraft(null); void entryOf(d).then(paintDone); return; }
    if (!form.hidden || !reviewBox.hidden || !doneBox.hidden || !historyBox.hidden) return;
    show("kinds");
  }
  async function startWithDocument(doc: { fingerprint: string; name: string }) {
    if (batchRunning) { show("wait"); tell(() => t("여러 장을 보내는 중이에요. 끝난 뒤에 문서를 다시 놓아 주세요.")); return; }
    if (await adoptUnresolved()) {
      paintUnknown();
      tell(() => t("보냈는지 아직 모르는 만들기가 있어요. 기록될 때까지 기다린 뒤 「다시 확인」을 눌러 주세요."));
      return;
    }
    const d = loadDraft();
    if (d?.stage === "sent-unknown") {
      paintUnknown();
      tell(() => t("보냈는지 아직 모르는 만들기가 있어요. 기록될 때까지 기다린 뒤 「다시 확인」을 눌러 주세요."));
      return;
    }
    if (d?.stage === "brand-sent") {
      // 이름 등록을 기다리는 중에는 새로 시작하지 않는다 — 그 표가 덮이면 이어서 못 한다.
      paintWait();
      tell(() => t("이름 등록을 기다리는 중이에요. 끝난 뒤에 문서를 다시 놓아 주세요."));
      return;
    }
    // 증명서 폼을 쓰는 중이면(표·사진 포함) 원본 문서의 지문만 붙인다 — 채우던 칸과 명단을 날리지 않는다.
    if (page.classList.contains("on") && !form.hidden && kind === "certificate" && !editing) {
      fingerprint = doc.fingerprint; fileName = doc.name;
      paintFileSay(); schedulePreview();
      return;
    }
    resetForm();
    fingerprint = doc.fingerprint; fileName = doc.name;
    paintFileSay();
    // 🔴 파일 이름을 제목으로 채우지 않는다. 「수료증_김하늘.pdf」 같은 이름이 흔하고,
    //    제목은 로마자로 바뀌어 체인 이름(영원히 공개)에 들어간다.
    void openForm("certificate").then(schedulePreview);
  }
  return {
    enter, startWithDocument,
    dropFiles: (paths) => bulk.dropPaths(paths),
    acceptsRoster: () => page.classList.contains("on") && !form.hidden && kind === "certificate" && !editing,
    rosterActive: () => bulk.active(),
  };
}
