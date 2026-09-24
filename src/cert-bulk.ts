/* 증명서 「한 번에 여러 장」 — 표 올리기 · 붙여넣기 · 사진 짝짓기 · 확인 표 · 로고/도장 · 라비.
 *
 * 대표 09-24: 「보통 수료증 같은 건 한번에 50명씩 하잖아. 엑셀을 올리고, 사진을 한번에…」
 *
 * 🔴 명단·사진은 이 컴퓨터 밖으로 나가지 않는다. 예외는 둘이고, 둘 다 사람이 누를 때 한 번만:
 *    · 「명단 사진 읽기」 — 그 사진 한 장이, 사람이 설정에 넣은 AI(자기 열쇠)로. 보내기 전에 묻는다.
 *    · 「문구 도와줘」 — 양식·제목·발급처만. 받는 사람 이름은 안 보낸다.
 *    발행 전까지는 러스트에도 안 간다. 발행할 때 만든 기록(0600)과 사진 폴더(0600)로만.
 * 🔴 AI 는 제안만 한다. 읽은 명단은 반드시 이 확인 표를 거치고, 발행은 사람이 누른다.
 */
import { lang, setCopyText, tf } from "./i18n";
import { MAX_COPIES, parseRecipients, type CertTemplate } from "./easy-create";
import {
  MAX_COURSE_CHARS, MAX_GRADE_CHARS, MAX_ISSUE_YEAR, MAX_NUMBER_CHARS, MAX_ROSTER_ROWS, MIN_ISSUE_YEAR, ROSTER_FIELDS, ROSTER_LABELS,
  type RawTable, type RosterField, type RosterMapping, type RosterRow, type RowProblem,
} from "./cert-types";
import { isImageName, matchPhotos, pickedFiles, preparePhoto } from "./cert-photos";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** 표 읽기(SheetJS)는 크다 — 표를 처음 만질 때 불러온다. */
type RosterMod = typeof import("./cert-roster");
let rosterP: Promise<RosterMod> | null = null;
const rosterMod = () => (rosterP ??= import("./cert-roster"));

/** 확인 표 한 줄. */
export type Line = {
  row: RosterRow;
  /** 사람이 고른 것. 문제(error)가 있는 줄은 이것과 상관없이 빠진다. */
  include: boolean;
  /** 사람이 발행 체크를 손으로 바꿨다 — 「이미 발행」이 저절로 끄지 않는다. */
  touched?: boolean;
  /** data:image/jpeg — 긴 변 800px, 3:4 로 자른 것. */
  photo: string | null;
  /** 짝지은 사진 파일 이름(확인 표에 보인다). */
  photoFrom: string;
  /** 손으로 고른 사진 — 사진을 다시 짝지어도 덮지 않는다. */
  manual?: boolean;
  photoBad?: string;
  /** 라비가 확실히 못 읽은 줄. */
  unsure?: boolean;
  /** 이미 발행한 증서의 체인 이름(같은 제목 · 받는 사람 · 번호). */
  issued?: string;
  problems: RowProblem[];
};

/** 러스트의 만든 기록에서 이미 발행한 줄을 찾는 데 쓰는 것만. */
type HistoryEntry = {
  kind: string; title: string; display_title?: string; names?: string[]; recipients?: string[]; issued_on?: string;
  rows?: { course?: string; number?: string; date?: string }[];
};

export type BulkDeps = {
  invoke: Invoke;
  t: (s: string) => string;
  sure: (title: string, message: string, ok: string) => Promise<boolean>;
  aiProvider: () => string | null;
  /** 지금 제목 — 같은 제목으로 이미 발행한 줄을 찾는다. */
  title: () => string;
  /** 위의 발급일 칸 — 줄에 발급일이 비면 이 날로 인쇄된다. */
  issuedOn: () => string;
  template: () => CertTemplate;
  issuer: () => string;
  /** 본문 칸에 문장을 넣는다(고른 문구). */
  setBody: (text: string) => void;
  /** 미리보기를 다시 그린다. */
  onChange: () => void;
  /** 표 모드가 켜지거나 꺼졌다 — 장수 칸·받는 사람 칸을 다시. */
  onModeChange: () => void;
};

export type BulkApi = {
  /** 확인 표로 만드는 중인가(표·붙여넣기·사진·라비). */
  active: () => boolean;
  lines: () => Line[];
  /** 발행할 줄의 차례 — 체크했고 오류가 없는 줄. */
  issuable: () => number[];
  /** 미리보기에 그릴 줄. */
  selected: () => Line | null;
  photoSlot: () => boolean;
  setPhotoSlot: (on: boolean) => void;
  /** 증서 글꼴 CSS(한 번 받아 둔다). */
  fontCss: () => Promise<string>;
  reset: () => void;
  /** 제목이 바뀌었다 — 이미 발행한 줄을 다시 본다. */
  refreshIssued: () => void;
  /** 발행 직전 — 만든 기록을 지금 다시 읽고 줄 문제까지 다 본 뒤에 돌아온다. */
  refreshIssuedNow: () => Promise<void>;
  /** 창에 떨어뜨린 경로(표·사진·사진 폴더). 받았으면 참. */
  dropPaths: (paths: string[]) => Promise<boolean>;
  /** 고치기(이미 만든 기록) 중에는 표 도구를 감춘다. */
  setEditMode: (on: boolean) => void;
  loadMarks: () => Promise<void>;
  summary: () => string;
};

const PHOTO_SLOT_KEY = "playx-raven-cert-photo-slot";
/** 러스트 한도(400KB)보다 조금 작게 — 넘으면 한 번 더 줄인다. */
const PHOTO_TARGET_BYTES = 380 * 1024;
/** 명단 사진을 AI 에 보낼 때 — 글씨는 읽히고 크기는 작게(제공자 한도 5MB 안). */
const AI_IMAGE_LONG_SIDE = 2000;
const TABLE_FIELDS: RosterField[] = ["recipient", "course", "grade", "date", "number"];

/** 라비 열쇠가 없을 때의 기본 예문 — AI 가 쓴 것이 아니라고 밝힌다. 조사(을/를)는 자리표 뒤에 두지 않는다. */
const BUILTIN_PHRASES: Record<"ko" | "en", Record<CertTemplate, string[]>> = {
  ko: {
    course: [
      "위 사람은 소정의 교육 과정을 성실히 마쳤기에 이 증서를 드립니다.",
      "{이름} 님은 「{과정}」의 모든 교육을 이수하였으므로 이 수료증을 드립니다.",
      "위 사람은 「{과정}」의 교육을 모두 마쳤음을 증명합니다.",
    ],
    proof: [
      "위 사람이 위 내용을 갖추었음을 증명합니다.",
      "{이름} 님이 「{과정}」의 요건을 갖추었음을 이에 증명합니다.",
      "위 사실이 틀림없음을 증명합니다.",
    ],
    thanks: [
      "{이름} 님, 보내 주신 마음과 수고에 깊이 감사드리며 이 글을 드립니다.",
      "늘 곁에서 함께해 주신 {이름} 님께 고마운 마음을 담아 이 감사장을 드립니다.",
      "「{과정}」에 보내 주신 정성에 깊이 감사드립니다.",
    ],
  },
  en: {
    course: [
      "This certifies that the person named above has successfully completed the course.",
      "{name} has completed all requirements of {course} and is awarded this certificate.",
      "Awarded in recognition of the successful completion of {course}.",
    ],
    proof: [
      "This certifies that the person named above meets the requirements stated.",
      "This is to certify that {name} has fulfilled the requirements of {course}.",
      "We hereby certify that the above is true and correct.",
    ],
    thanks: [
      "With sincere thanks for your kindness and dedication.",
      "Presented to {name} with heartfelt gratitude for your support.",
      "In grateful appreciation of your contribution to {course}.",
    ],
  },
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  csv: "text/csv", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const mimeOf = (name: string) => MIME[/\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? ""] ?? "application/octet-stream";

/** 그림을 캔버스로 다시 그린다 — 긴 변을 줄이고, 형식을 PNG(투명 유지)나 JPEG 로. */
async function redraw(file: Blob, longSide: number, type: "image/png" | "image/jpeg", quality = 0.88): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error("그림을 열지 못했어요. PNG나 JPG로 바꿔서 올려 주세요."); });
  const scale = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("그림을 그리지 못했어요.");
  if (type === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL(type, quality);
}

const dataUrlBytes = (url: string) => Math.floor((url.length - url.indexOf(",") - 1) * 3 / 4);

export function wireBulk(deps: BulkDeps): BulkApi {
  const { invoke, t } = deps;
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const box = el("cr-roster"), table = el<HTMLTableElement>("cr-table"), mapBox = el("cr-map");
  const sum = el("cr-roster-sum"), say = el("cr-roster-say"), recSay = el("cr-recipients-say");
  const recipientsIn = el<HTMLTextAreaElement>("cr-recipients");
  const slotIn = el<HTMLInputElement>("cr-photo-slot");

  let lines: Line[] = [];
  let raw: RawTable | null = null, mapping: RosterMapping | null = null;
  /** 명단을 어디서 받았나 — 열 맞추기는 올린 표·붙여넣기에만. */
  let source: "" | "file" | "paste" | "names" | "ai" = "";
  let sel = 0;
  /** 올린 사진 — 이름만 먼저, 내용은 짝지을 때 한 장씩 읽는다(폴더 600장을 한꺼번에 읽으면 메모리가 튄다). */
  type PhotoSrc = { name: string; blob: () => Promise<Blob> };
  let photoFiles: PhotoSrc[] = [];
  let prepared = new WeakMap<PhotoSrc, Promise<string>>();
  let history: HistoryEntry[] | null = null;
  let editMode = false;
  let busy = false;

  const tell = (render: () => string) => setCopyText(say, render);
  const errText = (e: unknown) => t(String(e instanceof Error ? e.message : e ?? "").replace(/^[A-Z_]+: /, ""));

  /* ── 사진 칸 · 로고 · 도장 ─────────────────────────────────────── */
  try { slotIn.checked = localStorage.getItem(PHOTO_SLOT_KEY) === "1"; } catch { /* 기억만 못 할 뿐 */ }
  slotIn.addEventListener("change", () => {
    try { localStorage.setItem(PHOTO_SLOT_KEY, slotIn.checked ? "1" : "0"); } catch { /* 기억만 못 할 뿐 */ }
    recheck(); deps.onChange();
  });

  let fontCssP: Promise<string> | null = null;
  const fontCss = () => (fontCssP ??= invoke<string>("certificate_font_css").catch(() => { fontCssP = null; return ""; }));

  type Marks = { logo: string | null; stamp: string | null };
  function paintMarks(m: Marks) {
    for (const kind of ["logo", "stamp"] as const) {
      const pic = el(`cr-${kind}-pic`);
      const url = m[kind];
      // CSSOM 으로 넣는다 — style="" 속성은 앱 CSP 에 막힌다.
      pic.style.backgroundImage = url ? `url("${url}")` : "";
      pic.classList.toggle("on", !!url);
      el(`cr-${kind}-clear`).hidden = !url;
      setCopyText(el(`cr-${kind}-pick`), () => t(url ? "바꾸기" : "올리기"));
    }
  }
  async function loadMarks() {
    try { paintMarks(await invoke<Marks>("certificate_marks")); } catch { paintMarks({ logo: null, stamp: null }); }
  }
  for (const kind of ["logo", "stamp"] as const) {
    const input = el<HTMLInputElement>(`cr-${kind}-in`);
    el(`cr-${kind}-pick`).addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      const out = el(`cr-${kind}-say`);
      try {
        // 투명 PNG 는 PNG 로(도장 뒤 종이가 비치게), 사진 같은 JPG 는 JPG 로. 크면 줄인다.
        const jpeg = file.type === "image/jpeg";
        let url = await redraw(file, 1200, jpeg ? "image/jpeg" : "image/png");
        if (dataUrlBytes(url) > 1400 * 1024) url = await redraw(file, 800, jpeg ? "image/jpeg" : "image/png");
        paintMarks(await invoke<Marks>("certificate_mark_save", { kind, image: url }));
        setCopyText(out, () => t(kind === "logo" ? "올렸어요 · 다음에 만들 때도 써요" : "올렸어요 · 서명 칸 위에 찍혀요"));
        deps.onChange();
      } catch (e) {
        setCopyText(out, () => errText(e));
      }
    });
    el(`cr-${kind}-clear`).addEventListener("click", async () => {
      try { paintMarks(await invoke<Marks>("certificate_mark_clear", { kind })); deps.onChange(); } catch (e) { setCopyText(el(`cr-${kind}-say`), () => errText(e)); }
    });
  }

  /* ── 확인 표 ─────────────────────────────────────────────────────── */
  const active = () => lines.length > 0 && !editMode;
  const errorOf = (l: Line) => l.problems.some((p) => p.level === "error");
  const issuable = () => lines.flatMap((l, i) => (l.include && !errorOf(l) ? [i] : []));

  function recheck(): Promise<void> {
    if (!lines.length) return Promise.resolve();
    return rosterMod().then((m) => {
      const keys = new Set(photoFiles.filter((f) => isImageName(f.name)).map((f) => m.photoKey(f.name)));
      const found = m.checkRows(lines.map((l) => l.row), { photoKeys: photoFiles.length ? keys : undefined });
      lines.forEach((l, i) => {
        const extra: RowProblem[] = [];
        if (l.issued) extra.push({ field: "row", level: "warn", code: "issued", message: tf("이미 발행했어요 · {0}", l.issued) });
        if (l.unsure) extra.push({ field: "recipient", level: "warn", code: "unsure", message: t("라비가 확실히 못 읽었어요 — 사진과 맞춰 보세요") });
        if (l.photoBad) extra.push({ field: "photo", level: "warn", code: "photo-bad", message: l.photoBad });
        else if (slotIn.checked && !l.photo) extra.push({ field: "photo", level: "warn", code: "photo-missing", message: t("사진 없음 — 사진 칸이 빈 채로 인쇄돼요") });
        // 사진을 짝지었으면 「올린 사진 중에 없어요」는 틀린 말이다(이름으로 짝지은 경우).
        l.problems = [...found[i].filter((p) => !(p.code === "photo-not-found" && l.photo)), ...extra];
        // 이미 발행한 줄은 처음 한 번 저절로 뺀다 — 사람이 다시 켜면 그대로 둔다.
        if (l.issued && !l.touched) l.include = false;
      });
      paintStates();
    });
  }

  function setLines(rows: RosterRow[], from: typeof source, flags: { unsure?: Set<number>; append?: boolean } = {}) {
    const fresh = rows.map((row, i): Line => ({ row, include: true, photo: null, photoFrom: "", problems: [], unsure: flags.unsure?.has(i) }));
    lines = flags.append ? [...lines, ...fresh].slice(0, MAX_ROSTER_ROWS) : fresh;
    source = flags.append && source ? source : from;
    if (!flags.append) sel = 0;
    markIssued();
    paintTable();
    recheck();
    deps.onModeChange();
    deps.onChange();
    refreshIssued();
    if (photoFiles.length) void matchAll();
  }

  function reset() {
    lines = []; raw = null; mapping = null; source = ""; sel = 0; photoFiles = []; prepared = new WeakMap();
    table.replaceChildren(); mapBox.replaceChildren(); mapBox.hidden = true;
    box.hidden = true; say.replaceChildren();
    el("cr-recipients-box").hidden = false;
    // 고치기에서 그 기록의 값으로 바꿨던 사진 칸을 이 컴퓨터의 기본값으로.
    try { slotIn.checked = localStorage.getItem(PHOTO_SLOT_KEY) === "1"; } catch { /* 기억만 못 할 뿐 */ }
    deps.onModeChange();
    deps.onChange();
  }

  /** 표 전체를 다시 만든다(명단이 바뀔 때만). 칸을 고칠 때는 paintStates 만. */
  function paintTable() {
    box.hidden = !lines.length;
    el("cr-recipients-box").hidden = !!lines.length;
    el("cr-map-toggle").hidden = !raw;
    if (!lines.length) { table.replaceChildren(); return; }
    const head = document.createElement("thead");
    const hr = document.createElement("tr");
    const th = (copy: string, cls = "") => { const c = document.createElement("th"); if (cls) c.className = cls; setCopyText(c, () => t(copy)); return c; };
    hr.append(th("발행"), th("#"), th("사진"), ...TABLE_FIELDS.map((f) => th(ROSTER_LABELS[f], `cr-c-${f}`)), th("확인"));
    head.append(hr);
    const body = document.createElement("tbody");
    lines.forEach((l, i) => {
      const tr = document.createElement("tr");
      tr.dataset.i = String(i);
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = l.include; check.dataset.act = "include";
      check.setAttribute("aria-label", tf("{0}번째 줄 발행", i + 1));
      const no = document.createElement("td"); no.className = "cr-c-no"; no.textContent = String(i + 1);
      const thumb = document.createElement("button");
      thumb.type = "button"; thumb.className = "cr-thumb"; thumb.dataset.act = "photo";
      thumb.setAttribute("aria-label", tf("{0}번째 줄 사진 고르기", i + 1));
      const cells = TABLE_FIELDS.map((f) => {
        const td = document.createElement("td");
        td.className = `cr-c-${f}`;
        const input = document.createElement("input");
        input.type = "text"; input.value = l.row[f]; input.dataset.field = f;
        input.autocomplete = "off"; input.spellcheck = false; input.setAttribute("translate", "no");
        input.maxLength = f === "course" ? MAX_COURSE_CHARS : f === "grade" ? MAX_GRADE_CHARS : f === "number" ? MAX_NUMBER_CHARS : 40;
        if (f === "date") input.placeholder = "2026-09-24";
        td.append(input);
        return td;
      });
      const state = document.createElement("td"); state.className = "cr-c-state";
      const c0 = document.createElement("td"); c0.append(check);
      const c2 = document.createElement("td"); c2.append(thumb);
      tr.append(c0, no, c2, ...cells, state);
      body.append(tr);
    });
    table.replaceChildren(head, body);
    paintStates();
  }

  /** 줄마다 상태·사진·체크만 새로. 입력 칸은 그대로(고치는 중인 칸의 커서를 안 잃게). */
  function paintStates() {
    const rows = table.tBodies[0]?.rows;
    if (!rows) return;
    lines.forEach((l, i) => {
      const tr = rows[i];
      if (!tr) return;
      const bad = errorOf(l);
      tr.classList.toggle("bad", bad);
      tr.classList.toggle("off", !l.include || bad);
      tr.classList.toggle("sel", i === sel);
      const check = tr.querySelector<HTMLInputElement>('input[data-act="include"]')!;
      check.checked = l.include && !bad; check.disabled = bad;
      const thumb = tr.querySelector<HTMLElement>(".cr-thumb")!;
      thumb.style.backgroundImage = l.photo ? `url("${l.photo}")` : "";
      thumb.classList.toggle("none", !l.photo);
      thumb.title = l.photoFrom || t("사진 고르기");
      const state = tr.cells[tr.cells.length - 1];
      state.replaceChildren();
      if (!l.problems.length) { const ok = document.createElement("span"); ok.className = "ok"; setCopyText(ok, () => t("좋아요")); state.append(ok); }
      for (const p of l.problems) {
        const s = document.createElement("div");
        s.className = p.level === "error" ? "e" : "w";
        s.textContent = problemText(p);
        state.append(s);
      }
    });
    paintSummary();
  }

  /** 줄 문제를 지금 말로. 한국어는 cert-roster 의 자세한 말(글자 수 등) 그대로, 다른 말은 사전의 짧은 말. */
  function problemText(p: RowProblem): string {
    if (lang === "ko" || ["issued", "unsure", "photo-bad", "photo-missing"].includes(p.code)) return p.message;
    const dup = /^(\d+)번째/.exec(p.message);
    switch (p.code) {
      case "empty-name": return t("받는 사람이 비어 있어요");
      case "too-long": return p.field === "course" ? tf("과정이 너무 길어요 — {0}자까지 넣을 수 있어요", MAX_COURSE_CHARS)
        : p.field === "grade" ? tf("등급이 너무 길어요 — {0}자까지 넣을 수 있어요", MAX_GRADE_CHARS)
        : p.field === "number" ? tf("번호가 너무 길어요 — {0}자까지 넣을 수 있어요", MAX_NUMBER_CHARS)
        : tf("받는 사람이 너무 길어요 — {0}자까지 넣을 수 있어요", 40);
      case "date-range": return tf("발급일은 {0}년부터 {1}년 사이로 적어 주세요", MIN_ISSUE_YEAR, MAX_ISSUE_YEAR);
      case "long-name": return t("이름이 길어서 증서에서 글자가 작아져요");
      case "bad-date": return t("발급일을 알아볼 수 없어요 (예: 2026-09-24)");
      case "duplicate": return tf("{0}번째 줄과 같아요(받는 사람·과정·발급일)", dup?.[1] ?? "?");
      case "no-photo": return t("사진 파일명이 비어 있어요");
      case "photo-not-found": return t("올린 사진 중에 이 줄의 사진 파일이 없어요");
      default: return p.message;
    }
  }

  function summaryText(): string {
    const n = lines.length, go = issuable().length;
    const errs = lines.filter(errorOf).length, off = lines.filter((l) => !l.include && !errorOf(l)).length;
    const photos = lines.filter((l) => l.photo).length, issued = lines.filter((l) => l.issued).length;
    const parts = [tf("{0}줄 중 {1}장 발행", n, go)];
    if (errs) parts.push(tf("고칠 줄 {0}", errs));
    if (off) parts.push(tf("뺀 줄 {0}", off));
    if (photos) parts.push(tf("사진 {0}장", photos));
    if (issued) parts.push(tf("이미 발행 {0}", issued));
    if (go > MAX_COPIES) parts.push(tf("{0}번에 나눠 보내요", Math.ceil(go / MAX_COPIES)));
    return parts.join(" · ");
  }
  function paintSummary() {
    setCopyText(sum, summaryText);
    setCopyText(recSay, () => t("아래 확인 표에서 고치고, 뺄 줄은 체크를 끄세요. 오류가 있는 줄은 저절로 빠져요."));
  }

  table.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const field = input.dataset.field as RosterField | undefined;
    const i = Number(input.closest("tr")?.dataset.i);
    if (!field || !lines[i]) return;
    lines[i].row = { ...lines[i].row, [field]: input.value };
    // 칸을 고치면 라비의 「확실히 못 읽음」은 사람이 본 것으로 친다.
    if (field === "recipient") lines[i].unsure = false;
    sel = i;
    markIssued();
    recheck();
    deps.onChange();
  });
  table.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const i = Number(input.closest("tr")?.dataset.i);
    if (!lines[i]) return;
    if (input.dataset.act === "include") { lines[i].include = input.checked; lines[i].touched = true; paintStates(); return; }
    if (input.dataset.field) {
      // 칸을 떠날 때 날짜·공백을 손질한다(2026.9.24 → 2026-09-24).
      void rosterMod().then((m) => {
        lines[i].row = m.normalizeRow(lines[i].row);
        input.value = lines[i].row[input.dataset.field as RosterField];
        recheck(); deps.onChange();
      });
    }
  });
  const onePhoto = document.createElement("input");
  onePhoto.type = "file"; onePhoto.accept = "image/*,.heic,.heif"; onePhoto.hidden = true;
  box.append(onePhoto);
  let photoFor = -1;
  table.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const tr = target.closest("tr");
    const i = Number(tr?.dataset.i);
    if (!tr || !lines[i]) return;
    if (target.dataset.act === "photo") { photoFor = i; onePhoto.click(); }
    if (sel !== i) { sel = i; paintStates(); deps.onChange(); }
  });
  onePhoto.addEventListener("change", async () => {
    const file = onePhoto.files?.[0];
    onePhoto.value = "";
    const l = lines[photoFor];
    if (!file || !l) return;
    try {
      l.photo = await prepare(srcOf(file)); l.photoFrom = file.name; l.manual = true; l.photoBad = undefined;
      if (!slotIn.checked) setPhotoSlot(true);
    } catch (e) { l.photoBad = errText(e); }
    recheck(); deps.onChange();
  });

  /* ── 열 맞추기 ─────────────────────────────────────────────────── */
  function paintMap(open: boolean) {
    if (!raw || !mapping) { mapBox.hidden = true; return; }
    const help = document.createElement("p");
    help.className = "meta cr-maphelp";
    setCopyText(help, () => t(mapping!.recipient < 0
      ? "어느 열이 받는 사람인가요? 열을 골라 주세요."
      : "열 이름이 달라도 여기서 맞추면 돼요. 열을 바꾸면 표에서 고친 칸은 처음 값으로 돌아가요."));
    const selects = ROSTER_FIELDS.map((f) => {
      const label = document.createElement("label");
      const name = document.createElement("span");
      setCopyText(name, () => t(ROSTER_LABELS[f]));
      const s = document.createElement("select");
      s.dataset.field = f;
      const none = document.createElement("option");
      none.value = "-1"; setCopyText(none, () => t("— 없음 —"));
      s.append(none);
      raw!.headers.forEach((h, c) => {
        const o = document.createElement("option");
        o.value = String(c);
        const example = raw!.rows.find((r) => r[c])?.[c] ?? "";
        o.textContent = example ? `${h} · ${example.slice(0, 16)}` : h;
        o.setAttribute("translate", "no");
        s.append(o);
      });
      s.value = String(mapping![f]);
      label.append(name, s);
      return label;
    });
    mapBox.replaceChildren(help, ...selects);
    mapBox.hidden = !open;
  }
  mapBox.addEventListener("change", (e) => {
    const s = e.target as HTMLSelectElement;
    const f = s.dataset.field as RosterField | undefined;
    if (!f || !raw || !mapping) return;
    const col = Number(s.value);
    // 한 열은 한 칸에만 — 다른 칸이 이 열을 쓰고 있었으면 비운다.
    for (const g of ROSTER_FIELDS) if (g !== f && mapping[g] === col && col >= 0) mapping[g] = -1;
    mapping[f] = col;
    void rosterMod().then((m) => {
      const keep = lines.map((l) => ({ photo: l.photo, photoFrom: l.photoFrom, manual: l.manual }));
      setLines(m.applyMapping(raw!, mapping!), source);
      lines.forEach((l, i) => { if (keep[i]?.manual) Object.assign(l, keep[i]); });
      paintMap(true);
    });
  });
  el("cr-map-toggle").addEventListener("click", () => paintMap(mapBox.hidden));
  el("cr-roster-clear").addEventListener("click", async () => {
    if (!(await deps.sure(t("명단을 비울까요?"), t("확인 표와 짝지은 사진이 화면에서 지워져요. 올린 파일은 그대로예요."), t("비웁니다")))) return;
    reset();
  });

  async function loadTable(table0: RawTable, from: "file" | "paste") {
    const m = await rosterMod();
    raw = table0;
    mapping = m.guessMapping(table0.headers);
    // 머리글 없이 붙인 여러 열 — 첫 열을 받는 사람으로 두고 열 맞추기를 열어 둔다.
    const blind = mapping.recipient < 0 && table0.headers.every((h) => /^열\d+$/.test(h));
    if (blind) mapping.recipient = 0;
    setLines(m.applyMapping(table0, mapping), from);
    paintMap(blind || mapping.recipient < 0);
    if (mapping.recipient < 0) tell(() => t("받는 사람 열을 찾지 못했어요. 위에서 어느 열이 받는 사람인지 골라 주세요."));
  }

  async function readTableFile(file: File) {
    tell(() => t("표를 읽는 중…"));
    try {
      const m = await rosterMod();
      const started = performance.now();
      const tbl = m.readRosterFile(file.name, await file.arrayBuffer());
      await loadTable(tbl, "file");
      const ms = Math.round(performance.now() - started);
      tell(() => tf("「{0}」에서 {1}줄을 읽었어요 ({2}초). 이 컴퓨터 안에서만 읽었어요.", file.name, tbl.rows.length, (ms / 1000).toFixed(1)));
    } catch (e) {
      tell(() => errText(e));
      box.hidden = false;
    }
  }

  const rosterIn = el<HTMLInputElement>("cr-roster-in");
  el("cr-roster-pick").addEventListener("click", () => rosterIn.click());
  rosterIn.addEventListener("change", () => {
    const file = rosterIn.files?.[0];
    rosterIn.value = "";
    if (file) void readTableFile(file);
  });

  // 엑셀에서 복사한 여러 칸(탭) · 50줄이 넘는 이름 목록은 확인 표로.
  recipientsIn.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const many = parseRecipients(text).length > MAX_COPIES;
    if (!text.includes("\t") && !many) return;
    e.preventDefault();
    void (async () => {
      try {
        const m = await rosterMod();
        const before = parseRecipients(recipientsIn.value);
        const pasted = m.parsePasted(text);
        if (before.length && !text.includes("\t")) {
          // 이미 적어 둔 이름 + 붙인 이름 — 둘 다 한 열 명단이다.
          await loadTable({ headers: ["받는 사람"], rows: [...before, ...pasted.rows.map((r) => r[0] ?? "")].map((n) => [n]) }, "paste");
        } else await loadTable(pasted, "paste");
        tell(() => tf("붙여 넣은 {0}줄을 확인 표로 옮겼어요.", lines.length));
      } catch (err) { tell(() => errText(err)); box.hidden = false; }
    })();
  });

  el("cr-sample").addEventListener("click", async () => {
    try {
      const m = await rosterMod();
      const save = (name: string, bytes: Uint8Array, open: boolean) =>
        invoke<{ path: string; where: string }>("certificate_file_save", { kind: "sample", name, data: bytesToB64(bytes), open });
      // 러스트는 있던 파일을 덮지 않는다 — 이미 있으면 「(2)」 같은 새 이름으로 만든다.
      const c = await save(`${m.SAMPLE_FILE_BASE}.csv`, m.sampleCsv(), false);
      const x = await save(`${m.SAMPLE_FILE_BASE}.xlsx`, m.sampleXlsx(), false);
      const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
      const openBtn = document.createElement("button");
      openBtn.type = "button"; openBtn.className = "link";
      setCopyText(openBtn, () => t("엑셀로 열기"));
      // 방금 만든 그 파일을 연다(다시 쓰지 않는다 — 그새 채우던 것을 덮으면 안 된다).
      openBtn.addEventListener("click", () => void invoke("certificate_sample_open", { path: x.path }).catch((e) => tell(() => errText(e))));
      const text = document.createElement("span");
      setCopyText(text, () => tf("{0} 폴더에 저장했어요 · {1} · {2} — 채워서 「표 올리기」로 올려 주세요.", x.where, base(x.path), base(c.path)));
      recSay.replaceChildren(text, document.createTextNode(" "), openBtn);
    } catch (e) { setCopyText(recSay, () => errText(e)); }
  });

  /* ── 사진 한꺼번에 ─────────────────────────────────────────────── */
  async function prepare(src: PhotoSrc): Promise<string> {
    let p = prepared.get(src);
    if (!p) {
      p = (async () => {
        const file = await src.blob();
        let out = await preparePhoto(file, { longSide: 800, aspect: 3 / 4, quality: 0.85 });
        if (out.bytes > PHOTO_TARGET_BYTES) out = await preparePhoto(file, { longSide: 640, aspect: 3 / 4, quality: 0.72 });
        if (out.bytes > PHOTO_TARGET_BYTES) throw new Error("사진이 너무 커요.");
        return out.dataUrl;
      })();
      prepared.set(src, p);
      // 못 읽은 것은 다음에 다시 해 볼 수 있게 기억하지 않는다.
      p.catch(() => prepared.delete(src));
    }
    return p;
  }

  async function matchAll() {
    if (!lines.length || !photoFiles.length) return;
    const match = matchPhotos(lines.map((l) => ({ recipient: l.row.recipient, photo: l.row.photo })), photoFiles);
    const todo = lines.map((l, i) => ({ l, i, f: match.fileOfRow[i] })).filter((x) => !x.l.manual);
    let done = 0;
    const started = performance.now();
    const step = async (x: (typeof todo)[number]) => {
      if (x.f < 0) {
        x.l.photo = null; x.l.photoFrom = "";
        x.l.photoBad = match.ambiguousRows.includes(x.i) ? t("이름이 같은 사진이 여러 장이에요 — 사진을 눌러 골라 주세요") : undefined;
      } else {
        try { x.l.photo = await prepare(photoFiles[x.f]); x.l.photoFrom = photoFiles[x.f].name; x.l.photoBad = undefined; }
        catch (e) { x.l.photo = null; x.l.photoFrom = photoFiles[x.f].name; x.l.photoBad = tf("사진을 읽지 못했어요({0}) — JPG·PNG로 바꿔 주세요", photoFiles[x.f].name); void e; }
      }
      done++;
      if (done % 5 === 0) tell(() => tf("사진 맞추는 중… {0}/{1}", done, todo.length));
    };
    // 세 장씩 — 한꺼번에 수백 장을 풀면 메모리가 튄다.
    const queue = [...todo];
    await Promise.all([0, 1, 2].map(async () => { for (let x = queue.shift(); x; x = queue.shift()) await step(x); }));
    const got = lines.filter((l) => l.photo).length;
    const left = match.unmatchedFiles.map((i) => photoFiles[i].name);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    tell(() => [
      tf("사진 {0}장을 짝지었어요 ({1}초). 사진은 이 컴퓨터 밖으로 안 나가요.", got, secs),
      left.length ? tf("짝 없는 사진 {0}장: {1}", left.length, left.slice(0, 6).join(", ") + (left.length > 6 ? " …" : "")) : "",
    ].filter(Boolean).join(" "));
    if (got && !slotIn.checked) setPhotoSlot(true);
    recheck();
    deps.onChange();
  }

  const srcOf = (f: File): PhotoSrc => ({ name: f.name, blob: async () => f });
  async function addPhotos(files: File[]) {
    await addPhotoSources(pickedFiles(files).map(srcOf));
  }
  async function addPhotoSources(picked: PhotoSrc[]) {
    if (!picked.length) { tell(() => t("사진 파일(JPG·PNG·HEIC)을 골라 주세요.")); box.hidden = !lines.length; return; }
    // 여러 번 나눠 넣어도 쌓인다 — 이름이 같은 사진은 새것으로.
    const fresh = new Set(picked.map((f) => f.name));
    const images = [...photoFiles.filter((f) => !fresh.has(f.name)), ...picked];
    // 표가 없으면 받는 사람 칸의 이름으로 표를 만든다 — 사진은 이름으로 짝짓는다.
    if (!lines.length) {
      const names = parseRecipients(recipientsIn.value);
      if (!names.length) {
        photoFiles = images;
        setCopyText(recSay, () => tf("사진 {0}장을 받았어요. 이제 명단(표 올리기·받는 사람 칸)을 넣으면 파일 이름으로 짝지어요.", images.length));
        return;
      }
      const m = await rosterMod();
      photoFiles = images;
      setLines(names.map((n) => m.normalizeRow({ recipient: n })), "names");
      return;
    }
    photoFiles = images;
    await matchAll();
  }
  const photosIn = el<HTMLInputElement>("cr-photos-in"), dirIn = el<HTMLInputElement>("cr-photodir-in");
  el("cr-photos-pick").addEventListener("click", () => photosIn.click());
  el("cr-photodir-pick").addEventListener("click", () => dirIn.click());
  for (const input of [photosIn, dirIn]) {
    input.addEventListener("change", () => {
      const files = input.files ? [...input.files] : [];
      input.value = "";
      if (files.length) void addPhotos(files);
    });
  }

  function setPhotoSlot(on: boolean) {
    slotIn.checked = on;
    try { localStorage.setItem(PHOTO_SLOT_KEY, on ? "1" : "0"); } catch { /* 기억만 못 할 뿐 */ }
    recheck();
    deps.onChange();
  }

  /* ── 이미 발행한 줄 ─────────────────────────────────────────────── */
  let issuedTimer: number | undefined;
  /** 같은 증서인지 — 받는 사람 · 번호 · 실제로 찍히는 발급일(줄에 없으면 위의 발급일). */
  const issuedKey = (who: string, number: string, date: string) => [who.trim(), number.trim(), date.trim()].join("\u0000");
  function markIssued() {
    const title = deps.title().trim();
    if (!history || !title) { lines.forEach((l) => { l.issued = undefined; }); return; }
    const done = new Map<string, string>();
    for (const e of history) {
      if (e.kind !== "certificate" || (e.display_title || e.title) !== title) continue;
      (e.recipients ?? []).forEach((who, i) => {
        const name = e.names?.[i];
        if (name) done.set(issuedKey(who, e.rows?.[i]?.number ?? "", e.rows?.[i]?.date || e.issued_on || ""), name);
      });
    }
    const top = deps.issuedOn();
    for (const l of lines) l.issued = done.get(issuedKey(l.row.recipient, l.row.number, l.row.date.trim() || top));
  }
  function refreshIssued() {
    if (issuedTimer !== undefined) clearTimeout(issuedTimer);
    issuedTimer = window.setTimeout(() => void refreshIssuedNow(), 300);
  }
  async function refreshIssuedNow() {
    if (issuedTimer !== undefined) { clearTimeout(issuedTimer); issuedTimer = undefined; }
    if (!lines.length) return;
    try { history = await invoke<HistoryEntry[]>("create_history_list"); } catch { history = null; }
    markIssued();
    await recheck();
  }

  /* ── 라비 — 문구 도와줘 ─────────────────────────────────────────── */
  const phrases = el("cr-phrases"), phraseSay = el("cr-phrase-say"), phraseBtn = el<HTMLButtonElement>("cr-ai-phrase");
  function paintPhrases(list: string[], fromAi: boolean) {
    const head = document.createElement("p");
    head.className = "meta";
    setCopyText(head, () => t(fromAi ? "라비 제안 · 눌러서 본문에 넣어요 (고쳐 써도 돼요)" : "기본 예문 · AI가 쓴 글이 아니에요 · 눌러서 본문에 넣어요"));
    const buttons = list.map((p) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ghost"; b.textContent = p; b.setAttribute("translate", "no");
      b.addEventListener("click", () => { deps.setBody(p); phrases.replaceChildren(); deps.onChange(); });
      return b;
    });
    phrases.replaceChildren(head, ...buttons);
  }
  phraseBtn.addEventListener("click", async () => {
    if (busy) return;
    const provider = deps.aiProvider();
    const builtin = BUILTIN_PHRASES[lang === "ko" ? "ko" : "en"][deps.template()];
    if (!provider) {
      paintPhrases(builtin, false);
      setCopyText(phraseSay, () => t("설정에서 AI 열쇠를 넣으면 라비가 제목에 맞춰 새로 써 드려요."));
      return;
    }
    busy = true; phraseBtn.disabled = true;
    setCopyText(phraseSay, () => t("라비가 쓰는 중…"));
    try {
      // 받는 사람 이름은 보내지 않는다 — 양식·제목·발급처만.
      const input = JSON.stringify({ template: deps.template(), title: deps.title().trim(), issuer: deps.issuer().trim(), lang });
      const r = await invoke<{ phrases?: unknown }>("ai_fill", { provider, task: "cert_phrases", input });
      const list = Array.isArray(r?.phrases) ? r.phrases.filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, 3) : [];
      if (!list.length) {
        paintPhrases(builtin, false);
        setCopyText(phraseSay, () => t("라비 답에서 쓸 만한 문장을 못 찾았어요 — 기본 예문을 보여 드려요."));
      } else {
        paintPhrases(list, true);
        phraseSay.replaceChildren();
      }
    } catch (e) {
      setCopyText(phraseSay, () => errText(e));
    } finally {
      busy = false; phraseBtn.disabled = false;
    }
  });

  /* ── 라비 — 명단 사진 읽기 ─────────────────────────────────────── */
  const aiIn = el<HTMLInputElement>("cr-ai-roster-in"), aiBtn = el<HTMLButtonElement>("cr-ai-roster");
  aiBtn.addEventListener("click", () => {
    if (!deps.aiProvider()) {
      box.hidden = !lines.length;
      setCopyText(recSay, () => t("설정에서 AI 열쇠를 넣으면 라비가 종이 명단·출석부 사진을 읽어 확인 표에 넣어 드려요. 사진은 누를 때 한 번, 고른 AI로만 가요."));
      return;
    }
    aiIn.click();
  });
  aiIn.addEventListener("change", async () => {
    const file = aiIn.files?.[0];
    aiIn.value = "";
    const provider = deps.aiProvider();
    if (!file || !provider || busy) return;
    const ok = await deps.sure(
      t("명단 사진을 라비에게 보낼까요?"),
      tf("이 사진 한 장이 이 컴퓨터 밖, 설정에서 고른 AI({0})로 한 번 나가요. 읽은 이름은 확인 표로 들어가요 — 틀릴 수 있으니 꼭 사진과 맞춰 보세요.", provider),
      t("보내고 읽기"),
    );
    if (!ok) return;
    busy = true; aiBtn.disabled = true;
    setCopyText(recSay, () => t("라비가 명단을 읽는 중… (보통 10~30초)"));
    try {
      const image = await redraw(file, AI_IMAGE_LONG_SIDE, "image/jpeg", 0.85);
      const r = await invoke<{ rows: Partial<RosterRow>[]; unsure: number[]; why?: string }>("ai_read_image", { provider, task: "cert_roster_photo", image });
      const m = await rosterMod();
      const rows = (r.rows ?? []).map((x) => m.normalizeRow(x));
      if (!rows.length) { setCopyText(recSay, () => r.why ? t(r.why) : t("사진에서 명단을 찾지 못했어요.")); return; }
      const append = lines.length > 0;
      // 라비가 읽은 줄은 올린 표의 열과 상관없다 — 열 다시 맞추기는 닫는다(맞추면 읽은 줄이 사라진다).
      raw = null; mapping = null; mapBox.hidden = true;
      setLines(rows, "ai", { unsure: new Set(r.unsure ?? []), append });
      const unsure = (r.unsure ?? []).length;
      setCopyText(recSay, () => [
        tf(append ? "라비가 {0}줄을 읽어 명단 끝에 붙였어요." : "라비가 {0}줄을 읽었어요.", rows.length),
        unsure ? tf("확실히 못 읽은 줄 {0}개는 노란 표시 — 사진과 맞춰 고쳐 주세요.", unsure) : t("틀릴 수 있으니 사진과 한 번 맞춰 보세요."),
      ].join(" "));
    } catch (e) {
      setCopyText(recSay, () => errText(e));
    } finally {
      busy = false; aiBtn.disabled = false;
    }
  });

  /* ── 창에 떨어뜨린 것 ───────────────────────────────────────────── */
  async function dropPaths(paths: string[]): Promise<boolean> {
    if (editMode) return false;
    const tables: File[] = [], images: PhotoSrc[] = [];
    type Read = { name?: string; kind?: string; data?: string; folder?: boolean; files?: string[] };
    const fileOf = (r: Read) => new File([b64ToBytes(r.data ?? "") as BlobPart], r.name ?? "file", { type: mimeOf(r.name ?? "") });
    for (const path of paths) {
      try {
        const r = await invoke<Read>("create_dropped_read", { path });
        if (r.folder) {
          // 이름만 받아 두고, 내용은 짝지을 때 한 장씩(러스트가 그 폴더 안의 그 이름만 읽는다).
          for (const name of r.files ?? []) {
            images.push({ name, blob: async () => fileOf(await invoke<Read>("create_dropped_read_in", { folder: path, name })) });
          }
        } else if (r.kind === "table") tables.push(fileOf(r));
        else if (r.kind === "image") images.push(srcOf(fileOf(r)));
      } catch { /* 표·사진이 아닌 것은 건너뛴다 */ }
    }
    if (!tables.length && !images.length) return false;
    box.hidden = false;
    if (tables.length) await readTableFile(tables[0]);
    if (images.length) await addPhotoSources(images);
    return true;
  }

  return {
    active,
    lines: () => lines,
    issuable,
    selected: () => (active() ? lines[sel] ?? lines[0] ?? null : null),
    photoSlot: () => slotIn.checked,
    setPhotoSlot: (on) => { slotIn.checked = on; },
    fontCss,
    reset,
    refreshIssued,
    refreshIssuedNow,
    dropPaths,
    setEditMode: (on) => {
      editMode = on;
      el("cr-rosterbar").hidden = on;
      box.hidden = on || !lines.length;
      el("cr-recipients-box").hidden = !on && !!lines.length;
    },
    loadMarks,
    summary: summaryText,
  };
}
