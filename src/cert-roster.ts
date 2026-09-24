/**
 * 증서 명단 읽기 — 엑셀·CSV 파일 / 붙여넣은 표 → 명단 줄 → 확인 표의 문제 표시.
 *
 * 🔴 명단(이름·사진 파일명)은 이 기기 밖으로 나가지 않는다. 읽기·쓰기 모두 웹뷰 안에서 끝난다.
 *    그래서 DOM 도 네트워크도 안 쓴다 — 같은 코드가 node 시험(scripts/check-cert-roster.mjs)에서도 돈다.
 *
 * 흐름: readRosterFile / parsePasted → RawTable → guessMapping(머리글 짐작, 사람이 고칠 수 있다)
 *       → applyMapping → RosterRow[] → checkRows(줄마다 문제) → 발행 → resultXlsx(번호 목록 표)
 */
import * as XLSX from "xlsx";
import {
  MAX_COURSE_CHARS, MAX_GRADE_CHARS, MAX_ISSUE_YEAR, MAX_NUMBER_CHARS, MAX_RECIPIENT_CHARS, MAX_ROSTER_ROWS, MIN_ISSUE_YEAR,
  ROSTER_FIELDS, ROSTER_LABELS,
  type RawTable, type RosterField, type RosterMapping, type RosterRow, type RowProblem,
} from "./cert-types";

export const SAMPLE_FILE_BASE = "증서_명단_샘플";

const SHEET_EXT = new Set(["xlsx", "xlsm", "xls", "ods"]);
const TEXT_EXT = new Set(["csv", "tsv", "txt"]);
/** 샘플 파일의 설명 줄 표시. 이 글자로 시작하는 줄은 명단이 아니다. */
const NOTE_MARK = "※";

const pad2 = (n: number) => String(n).padStart(2, "0");
const chars = (s: string) => [...s].length; // 한도는 글자(코드 포인트) 수 — 이모지·한자도 한 글자

/** 칸 손질: NFC(맥에서 온 글자는 자모가 풀려 있다) · 보이지 않는 공백 제거 · 앞뒤 공백. */
function clean(v: unknown): string {
  return String(v ?? "").normalize("NFC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
}

// ───────────────────────── 날짜 ─────────────────────────

function ymd(y: number, m: number, d: number): string {
  // 1900~2199 밖은 오타(0226 등)로 본다. 달력에 없는 날(2월 30일)도 거른다.
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1) return "";
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad2(m)}-${pad2(d)}` : "";
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && ymd(+m[1], +m[2], +m[3]) === s;
}

/**
 * 발급일 → YYYY-MM-DD. 못 알아들으면 적힌 그대로 돌려준다(checkRows 가 bad-date 로 표시).
 * 받는 모양: 2026-09-24 · 2026.9.24 · 2026. 9. 24. · 2026/9/24 · 20260924 · 2026년 9월 24일 (목)
 *           · 엑셀 날짜 일련번호(46289, 날짜 칸이 숫자로 저장된 경우) · 뒤에 붙은 시각은 버린다.
 * 26.9.24 · 9/24/2026 처럼 순서가 모호한 것은 짐작하지 않는다.
 */
export function normalizeDate(text: string): string {
  const raw = clean(text);
  const s = raw.replace(/\s*\([월화수목금토일](?:요일)?\)$/, "");
  if (!s) return raw;
  let m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
    ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s)
    ?? /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]) || raw;
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    // 엑셀 1900 체계: 60 이후는 1899-12-30 + n 일. 20000~80000 = 1954~2119년.
    if (n >= 20000 && n <= 80000) {
      const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000);
      return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()) || raw;
    }
  }
  return raw;
}

// ───────────────────────── 파일 읽기 ─────────────────────────

/** 숫자 → 보이는 그대로의 글자. "1e+21" 도, 정수 뒤 ".0" 도 없이. 소수는 엑셀처럼 15자리. */
function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  const s = String(Number.isInteger(n) ? n : Number(n.toPrecision(15)));
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] ?? ""), exp = +m[4];
  if (exp < 0) return `${m[1]}0.${"0".repeat(-exp - 1)}${digits}`;
  const point = exp + 1;
  return m[1] + (digits.length <= point ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`);
}

/**
 * 엑셀 칸 하나 → 글자.
 * 🔴 SheetJS 0.20 은 날짜를 「UTC 로 읽으면 맞는」 Date 로 준다(자정 = 00:00Z).
 *    로컬로 읽으면 미국 시간대에서 하루 앞당겨진다(2026-09-24 → 09-23, 실측). 그래서 UTC 로 읽는다.
 */
function cellText(c: XLSX.CellObject | undefined): string {
  if (!c || c.v == null) return "";
  switch (c.t) {
    case "d": {
      const d = c.v instanceof Date ? c.v : new Date(String(c.v));
      if (isNaN(d.getTime())) return clean(c.w);
      const t = new Date(Math.round(d.getTime() / 1000) * 1000); // 소수점 잡음(23:59:59.999) 정리
      return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
    }
    case "n":
      // 서식이 붙은 숫자(001 · 2"급")는 사람이 보는 모양이 곧 뜻이다. 일반 서식은 값 그대로.
      return c.z && c.z !== "General" && c.w != null ? clean(c.w) : plainNumber(Number(c.v));
    case "b": return c.v ? "TRUE" : "FALSE";
    case "e": return ""; // #N/A 같은 오류 칸은 빈칸으로 — 이름이면 「비어 있어요」로 걸린다
    default: return clean(c.v);
  }
}

function sheetGrid(data: Uint8Array): string[][] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: "array", cellDates: true, cellNF: true, dense: true });
  } catch (e) {
    // 암호 파일은 "File is password-protected". 깨진 zip 도 "Unsupported ZIP encryption" 이라 하니 password 만 본다.
    if (/password/i.test(String((e as Error)?.message ?? e))) throw new Error("암호가 걸린 파일이에요. 엑셀에서 암호를 풀고 다시 저장해 올려 주세요.");
    throw new Error("파일을 읽지 못했어요. 엑셀에서 열어 다시 저장한 뒤 올려 주세요.");
  }
  // 「명단」 시트가 있으면 그것(샘플 파일), 없으면 숨기지 않은 첫 시트.
  const names = wb.SheetNames;
  const hidden = (i: number) => !!wb.Workbook?.Sheets?.[i]?.Hidden;
  const name = names.find(n => n.normalize("NFC").trim() === "명단") ?? names.find((_, i) => !hidden(i)) ?? names[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws) return [];
  const dense = ws["!data"];
  const out: string[][] = [];
  if (dense) {
    // 쓰인 범위(!ref)가 아니라 실제 칸만 돈다 — 서식만 1048576 줄까지 칠해 둔 파일이 흔하다.
    for (let r = 0; r < dense.length; r++) {
      const row = dense[r] ?? [], cells: string[] = [];
      for (let c = 0; c < row.length; c++) cells.push(cellText(row[c]));
      out.push(cells);
    }
    return out;
  }
  if (!ws["!ref"]) return out;
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined));
    out.push(cells);
  }
  return out;
}

/**
 * CSV 글자 풀기. 🔴 한국어 엑셀의 「CSV(쉼표로 분리)」는 CP949 로 저장한다(UTF-8 이 아니다).
 * BOM 있는 UTF-8 → UTF-16(엑셀 「유니코드 텍스트」) → UTF-8(엄격) → 실패하면 EUC-KR(=CP949).
 */
function decodeText(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    try { return new TextDecoder("euc-kr").decode(b); } catch { return new TextDecoder("utf-8").decode(b); }
  }
}

/**
 * 구분자 글 → 칸. 따옴표 칸(안의 쉼표·줄바꿈·"" 이스케이프), CRLF/LF/CR 모두.
 * SheetJS 에 맡기지 않는 까닭: 그쪽은 "001" 을 1 로, "2026-09-24" 를 날짜 수로 바꿔 버린다.
 * 닫히지 않은 따옴표가 있으면(메신저에서 복사한 글 등) 따옴표를 그냥 글자로 보고 다시 읽는다.
 */
function splitDelimited(text: string, delim: string, quotes = true): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else inQ = false;
    } else if (ch === '"' && quotes && cell === "" && !quoted) {
      inQ = quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = ""; quoted = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; quoted = false;
    } else cell += ch;
  }
  if (inQ) return splitDelimited(text, delim, false);
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** 첫 줄로 구분자를 고른다. .tsv 는 탭, 그 밖엔 탭 > 쉼표 > 세미콜론(유럽 엑셀). 없으면 한 열. */
function pickDelimiter(text: string, ext: string): string {
  if (ext === "tsv") return "\t";
  const first = text.split(/\r\n|\n|\r/).find(l => l.trim()) ?? "";
  const count = (d: string) => first.split(d).length - 1;
  const tabs = count("\t"), commas = count(",");
  if (tabs && tabs >= commas) return "\t";
  if (commas) return ",";
  return count(";") ? ";" : ",";
}

/**
 * 칸 격자 → 머리글 + 줄. 빈 줄·※ 설명 줄은 건너뛴다. 열 수는 가장 넓은 줄에 맞추고,
 * 비어 있는 머리글은 "열N" 으로 채운다(연결 화면에서 빈 이름표는 고를 수가 없다).
 * useHeader=false 면 머리글을 만들어 붙이고 모든 줄을 명단으로 본다.
 */
function tableFrom(grid: string[][], useHeader: boolean | ((first: string[]) => boolean) = true): RawTable {
  const lines = grid
    .map(r => r.map(clean))
    .filter(r => {
      const first = r.find(v => v !== "");
      return first !== undefined && !first.startsWith(NOTE_MARK);
    });
  if (!lines.length) return { headers: [], rows: [] };
  const hasHeader = typeof useHeader === "function" ? useHeader(lines[0]) : useHeader;
  const body = hasHeader ? lines.slice(1) : lines;
  if (body.length > MAX_ROSTER_ROWS) {
    throw new Error(`명단이 ${body.length}줄이에요. 한 번에 ${MAX_ROSTER_ROWS}줄까지 올릴 수 있으니 나눠서 올려 주세요.`);
  }
  const used = (r: string[]) => { let n = r.length; while (n && r[n - 1] === "") n--; return n; };
  const width = Math.max(1, ...lines.map(used));
  const fit = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const headers = hasHeader ? fit(lines[0]).map((h, i) => h || `열${i + 1}`) : Array.from({ length: width }, (_, i) => `열${i + 1}`);
  return { headers, rows: body.map(fit) };
}

/**
 * 올린 파일 → 표. 첫 번째 비어 있지 않은 줄이 머리글.
 * 받는 것: .xlsx .xlsm .xls .ods(SheetJS) · .csv .tsv .txt(직접 읽음).
 */
export function readRosterFile(fileName: string, bytes: ArrayBuffer | Uint8Array): RawTable {
  const ext = /\.([^./\\]+)$/.exec(String(fileName ?? "").trim())?.[1].toLowerCase() ?? "";
  if (!SHEET_EXT.has(ext) && !TEXT_EXT.has(ext)) {
    throw new Error(`이 파일은 읽을 수 없어요(${ext ? "." + ext : "확장자 없음"}). 엑셀(.xlsx·.xls)이나 CSV(.csv) 파일로 올려 주세요.`);
  }
  const data = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  if (!data.byteLength) throw new Error("파일이 비어 있어요. 샘플 파일에 명단을 채워서 올려 주세요.");
  let grid: string[][];
  if (TEXT_EXT.has(ext)) {
    const text = decodeText(data);
    grid = splitDelimited(text, pickDelimiter(text, ext));
  } else grid = sheetGrid(data);
  const table = tableFrom(grid);
  if (!table.headers.length) throw new Error("파일이 비어 있어요. 샘플 파일에 명단을 채워서 올려 주세요.");
  if (!table.rows.length) throw new Error("첫 줄(머리글) 말고는 명단이 없어요. 둘째 줄부터 한 사람씩 적어 주세요.");
  return table;
}

// ───────────────────────── 머리글 짐작 ─────────────────────────

const SYNONYMS: Record<RosterField, string[]> = {
  recipient: ["받는사람", "받는분", "이름", "성명", "성함", "수료자", "수상자", "대상자", "수강생", "참가자", "회원명", "학생명", "name", "recipient", "fullname"],
  course: ["과정", "과정명", "내용", "과정내용", "교육명", "교육과정", "과목", "강좌", "course", "program", "title"],
  grade: ["등급", "레벨", "급수", "단계", "grade", "level"],
  date: ["발급일", "발급일자", "날짜", "일자", "수료일", "수여일", "발행일", "발행일자", "date", "issued", "issuedate"],
  number: ["번호", "증서번호", "발급번호", "수료번호", "자격번호", "no", "number", "certno", "id"],
  photo: ["사진", "사진파일", "사진파일명", "사진파일이름", "파일명", "파일이름", "이미지", "photo", "image", "picture", "file", "filename"],
  note: ["비고", "메모", "참고", "note", "notes", "remark", "memo"],
};

/** 머리글 비교용: NFC · 소문자 · 괄호 속 「(선택)」 떼기 · 글자·숫자만. */
export function headerKey(h: string): string {
  const s = String(h ?? "").normalize("NFC").toLowerCase();
  const strip = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");
  return strip(s.replace(/[(（[【<〈][^)）\]】>〉]*[)）\]】>〉]/g, "")) || strip(s);
}

const EXACT = new Map<string, RosterField>();
for (const f of ROSTER_FIELDS) for (const w of SYNONYMS[f]) EXACT.set(headerKey(w), f);

/** 구체적인 말이 이긴다: 「증서번호」가 「No」보다, 「사진파일명」이 「파일」보다. 한글 한 자 = 2. */
const weight = (w: string) => [...w].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 2 : 1), 0);
/** 부분 일치로는 잡지 않을 열(「전화번호」가 번호로, 「생년월일」이 날짜로 가면 안 된다). */
const NOT_ROSTER = /전화|휴대|핸드폰|연락|phone|mobile|email|메일|주소|address|생년|birth|생일/;

export function guessMapping(headers: string[]): RosterMapping {
  const mapping = Object.fromEntries(ROSTER_FIELDS.map(f => [f, -1])) as RosterMapping;
  const cand: { col: number; field: RosterField; exact: boolean; score: number }[] = [];
  headers.forEach((h, col) => {
    const key = headerKey(h);
    if (!key) return;
    const exact = EXACT.get(key);
    if (exact) { cand.push({ col, field: exact, exact: true, score: weight(key) }); return; }
    if (NOT_ROSTER.test(key)) return;
    // 부분 일치: 「교육과정명」「수료자 이름」 같은 변형. 영문은 4자 이상만(id·no 가 아무 데나 붙지 않게).
    for (const f of ROSTER_FIELDS) for (const w of SYNONYMS[f]) {
      const k = headerKey(w);
      if ((/[a-z]/.test(k) ? k.length >= 4 : true) && key.includes(k)) cand.push({ col, field: f, exact: false, score: weight(k) });
    }
  });
  cand.sort((a, b) => +b.exact - +a.exact || b.score - a.score || a.col - b.col || ROSTER_FIELDS.indexOf(a.field) - ROSTER_FIELDS.indexOf(b.field));
  const usedCols = new Set<number>();
  for (const c of cand) {
    if (mapping[c.field] >= 0 || usedCols.has(c.col)) continue;
    mapping[c.field] = c.col;
    usedCols.add(c.col);
  }
  // 이름만 한 줄씩 적은 표(머리글이 「참석자 명단」 같은 아무 말) — 그 한 열이 받는 사람이다.
  if (mapping.recipient < 0 && headers.length === 1 && !usedCols.has(0)) mapping.recipient = 0;
  return mapping;
}

// ───────────────────────── 줄 만들기 ─────────────────────────

/** 한 줄 손질(연결할 때 · 확인 표에서 고칠 때 같이 쓴다). 사진 파일명·비고는 공백을 건드리지 않는다. */
export function normalizeRow(row: Partial<RosterRow>): RosterRow {
  const one = (v: unknown) => clean(v).replace(/\s+/g, " ");
  return {
    recipient: one(row.recipient),
    course: one(row.course),
    grade: one(row.grade),
    date: normalizeDate(one(row.date)),
    number: one(row.number),
    photo: clean(row.photo),
    note: clean(row.note),
  };
}

export function applyMapping(table: RawTable, mapping: RosterMapping): RosterRow[] {
  return table.rows.map(cells => {
    const row = {} as RosterRow;
    for (const f of ROSTER_FIELDS) row[f] = mapping[f] >= 0 ? cells[mapping[f]] ?? "" : "";
    return normalizeRow(row);
  });
}

/**
 * 엑셀·구글 시트에서 복사해 붙인 글(탭 구분). 첫 줄에 아는 머리글이 하나라도 있으면 머리글로,
 * 아니면 모든 줄이 명단("열1"…). 흔한 경우는 이름만 한 줄에 하나.
 * 🔴 머리글 판단은 「정확히 같은 말」만 — 「필라테스 지도자 과정」처럼 「과정」이 든 과정 이름을 머리글로 오해하면 첫 사람이 사라진다.
 */
export function parsePasted(text: string): RawTable {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  if (!s.trim()) return { headers: [], rows: [] };
  return tableFrom(splitDelimited(s, "\t"), first => first.some(c => EXACT.has(headerKey(c))));
}

// ───────────────────────── 확인 표 ─────────────────────────

const IMAGE_EXT = /\.(jpe?g|png|webp|hei[cf]|gif|bmp|tiff?)$/i;

/** 사진 짝짓기 이름표 — cert-photos.ts 의 photoKey 와 같은 규칙(경로·사진 확장자 떼기, NFC, 소문자). */
export function photoKey(name: string): string {
  const base = String(name ?? "").normalize("NFC").replace(/^.*[\\/]/, "").trim();
  return base.replace(IMAGE_EXT, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function checkRows(
  rows: RosterRow[],
  opts: { photoKeys?: Set<string>; requirePhoto?: boolean; photoKey?: (s: string) => string } = {},
): RowProblem[][] {
  const keyOf = opts.photoKey ?? photoKey;
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    const out: RowProblem[] = [];
    const name = clean(row.recipient).replace(/\s+/g, " ");
    const course = clean(row.course).replace(/\s+/g, " ");
    const date = clean(row.date);
    const photo = clean(row.photo);
    const nameLen = chars(name), courseLen = chars(course);

    if (!name) out.push({ field: "recipient", level: "error", code: "empty-name", message: "받는 사람이 비어 있어요" });
    else if (nameLen > MAX_RECIPIENT_CHARS) out.push({ field: "recipient", level: "error", code: "too-long", message: `받는 사람이 너무 길어요(${nameLen}자). ${MAX_RECIPIENT_CHARS}자까지 넣을 수 있어요` });
    else if (nameLen > 20) out.push({ field: "recipient", level: "warn", code: "long-name", message: `이름이 길어서(${nameLen}자) 증서에서 글자가 작아져요` });
    if (courseLen > MAX_COURSE_CHARS) out.push({ field: "course", level: "error", code: "too-long", message: `과정이 너무 길어요(${courseLen}자). ${MAX_COURSE_CHARS}자까지 넣을 수 있어요` });
    // 러스트(create_history)와 같은 한도 — 여기서 못 거르면 발행 도중 그 줄이 든 50장 묶음이 통째로 멈춘다.
    const gradeLen = chars(clean(row.grade)), numberLen = chars(clean(row.number));
    if (gradeLen > MAX_GRADE_CHARS) out.push({ field: "grade", level: "error", code: "too-long", message: `등급이 너무 길어요(${gradeLen}자). ${MAX_GRADE_CHARS}자까지 넣을 수 있어요` });
    if (numberLen > MAX_NUMBER_CHARS) out.push({ field: "number", level: "error", code: "too-long", message: `번호가 너무 길어요(${numberLen}자). ${MAX_NUMBER_CHARS}자까지 넣을 수 있어요` });
    if (date && !isIsoDate(normalizeDate(date))) out.push({ field: "date", level: "error", code: "bad-date", message: `발급일을 알아볼 수 없어요: "${date}" (예: 2026-09-24)` });
    else if (date) {
      const year = Number(normalizeDate(date).slice(0, 4));
      if (year < MIN_ISSUE_YEAR || year > MAX_ISSUE_YEAR) out.push({ field: "date", level: "error", code: "date-range", message: `발급일은 ${MIN_ISSUE_YEAR}년부터 ${MAX_ISSUE_YEAR}년 사이로 적어 주세요` });
    }
    if (opts.requirePhoto && !photo) out.push({ field: "photo", level: "error", code: "no-photo", message: "사진 파일명이 비어 있어요" });
    else if (photo && opts.photoKeys && !opts.photoKeys.has(keyOf(photo))) {
      out.push({ field: "photo", level: "warn", code: "photo-not-found", message: `올린 사진 중에 "${photo}"이(가) 없어요` });
    }
    if (name) {
      // 같은 사람·같은 과정·같은 날 = 두 번 찍힐 뻔한 줄. 영문은 대소문자를 가리지 않는다.
      const key = [name, course, normalizeDate(date)].join("\u0000").toLowerCase();
      const first = seen.get(key);
      if (first === undefined) seen.set(key, i);
      else out.push({ field: "row", level: "warn", code: "duplicate", message: `${first + 1}번째 줄과 같아요(받는 사람·과정·발급일)` });
    }
    return out;
  });
}

// ───────────────────────── 샘플·결과 파일 ─────────────────────────

const SAMPLE_NOTE = `${NOTE_MARK} 이 줄은 설명이에요. 지우지 않아도 읽을 때 건너뛰어요 · 받는 사람만 꼭 채우세요 · 발급일 예: 2026-09-24 · 사진 파일명은 올릴 사진 파일 이름과 같게(예: 김하늘.jpg) · 한 번에 ${MAX_ROSTER_ROWS}줄까지`;

export function sampleRows(): RosterRow[] {
  return [
    { recipient: "김하늘", course: "필라테스 지도자 과정", grade: "2급", date: "2026-09-24", number: "PLNE-2026-001", photo: "김하늘.jpg", note: "" },
    { recipient: "박서준", course: "필라테스 지도자 과정", grade: "1급", date: "2026-09-24", number: "PLNE-2026-002", photo: "박서준.jpg", note: "우수 수료" },
    { recipient: "Jane Doe", course: "움직임 안정화 기초 과정", grade: "", date: "2026-09-24", number: "PLNE-2026-003", photo: "", note: "영문 이름도 돼요 · 사진은 없어도 돼요" },
  ];
}

function sampleAoa(): string[][] {
  return [ROSTER_FIELDS.map(f => ROSTER_LABELS[f]), [SAMPLE_NOTE], ...sampleRows().map(r => ROSTER_FIELDS.map(f => r[f]))];
}

/** CSV 쓰기 — BOM(엑셀이 UTF-8 로 알아보게) + CRLF + 필요한 칸만 따옴표.
 *  🔴 = + - @ 로 시작하는 칸은 엑셀이 수식으로 실행한다(받는 사람 칸에 `=HYPERLINK(…)` 를
 *     적어 넣은 명단). 앞에 ' 를 붙여 글자로 둔다 — xlsx 는 칸을 글자로 쓰므로 괜찮다. */
function csvBytes(aoa: string[][]): Uint8Array {
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const q = (raw: string) => { const v = safe(raw); return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return new TextEncoder().encode("\uFEFF" + aoa.map(r => r.map(q).join(",")).join("\r\n") + "\r\n");
}

function xlsxBytes(sheetName: string, aoa: string[][], widths: number[], link?: number): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = widths.map(wch => ({ wch }));
  if (link !== undefined) {
    // 확인 주소는 눌러서 열 수 있게.
    for (let r = 1; r < aoa.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: link })] as XLSX.CellObject | undefined;
      if (cell && /^https?:\/\//.test(String(cell.v))) cell.l = { Target: String(cell.v) };
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }));
}

const SAMPLE_WIDTHS = [14, 28, 8, 12, 16, 18, 24];

export function sampleCsv(): Uint8Array {
  return csvBytes(sampleAoa());
}

export function sampleXlsx(): Uint8Array {
  return xlsxBytes("명단", sampleAoa(), SAMPLE_WIDTHS);
}

/** 발행 뒤 「번호 목록 표」 한 줄. */
export type IssuedRow = { recipient: string; course: string; grade: string; date: string; number: string; asset: string; txid: string; verifyUrl: string };

const RESULT_COLS: { key: keyof IssuedRow; label: string; wch: number }[] = [
  { key: "recipient", label: "받는 사람", wch: 14 },
  { key: "course", label: "과정", wch: 28 },
  { key: "grade", label: "등급", wch: 8 },
  { key: "date", label: "발급일", wch: 12 },
  { key: "number", label: "번호", wch: 16 },
  { key: "asset", label: "체인 이름", wch: 32 },
  { key: "txid", label: "거래 번호", wch: 66 },
  { key: "verifyUrl", label: "확인 주소", wch: 60 },
];

function resultAoa(rows: IssuedRow[]): string[][] {
  return [RESULT_COLS.map(c => c.label), ...rows.map(r => RESULT_COLS.map(c => String(r[c.key] ?? "")))];
}

export function resultXlsx(rows: IssuedRow[]): Uint8Array {
  return xlsxBytes("발행 목록", resultAoa(rows), RESULT_COLS.map(c => c.wch), RESULT_COLS.findIndex(c => c.key === "verifyUrl"));
}

export function resultCsv(rows: IssuedRow[]): Uint8Array {
  return csvBytes(resultAoa(rows));
}
