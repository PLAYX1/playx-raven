/* 「만들기」 이름·비용 — RavenVault 폰(core/easy-create/plan.ts)과 **같은 규칙**이다.
 *
 * 같은 사람이 폰과 이 컴퓨터에서 번갈아 만들어도 이름이 같은 모양으로 이어져야
 * 한다. 규칙을 바꿀 때는 두 곳을 같이 바꾼다.
 *
 *   증명서·작품 → BRAND#SLUG260917-1 …  (한 장에 하나, 거래 하나로 여러 장)
 *   티켓        → BRAND/SLUG260917      (N장 · 소수 0 · 재발행 가능)
 *   처음이면 BRAND 를 먼저 등록하고, 기록된 뒤에 이어서 만든다.
 */

export type CreateKind = "certificate" | "ticket" | "work";

export const MAX_COPIES = 50;
export const MAX_TICKETS = 1_000_000;
export const BRAND_MAX = 12;
const SLUG_MAX = 8;
const RUN_LETTERS = "BCDEFGHJKLMNPQRSTUVWXYZ";
export const MAX_RUNS = RUN_LETTERS.length + 1;
export const VERIFY_URL = "https://ravenvault.ex.erci.se/verify/";

export const BURN = { brand: 500, ticket: 100, unique: 5 } as const;
/** 노드 지갑이 고르는 수수료의 넉넉한 몫(거래 하나). 실제로는 대개 0.01 RVN 아래다. */
export const FEE_ALLOWANCE = 0.05;

const INITIALS = ["G", "KK", "N", "D", "TT", "R", "M", "B", "PP", "S", "SS", "", "J", "JJ", "CH", "K", "T", "P", "H"];
const MEDIALS = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WO", "WE", "WI", "YU", "EU", "UI", "I"];
const FINALS = ["", "K", "K", "K", "N", "N", "N", "T", "L", "K", "M", "L", "L", "L", "P", "L", "M", "P", "P", "T", "T", "NG", "T", "T", "K", "T", "P", "T"];

/** 한글은 음절 하나가 한 조각, 영문·숫자는 단어 하나가 한 조각. */
export function romanPieces(text: string): string[] {
  const pieces: string[] = [];
  let word = "";
  const flush = () => { if (word) { pieces.push(word); word = ""; } };
  for (const ch of String(text ?? "").normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      flush();
      const n = code - 0xac00;
      pieces.push(INITIALS[Math.floor(n / 588)] + MEDIALS[Math.floor((n % 588) / 28)] + FINALS[n % 28]);
    } else if (/[A-Za-z0-9]/.test(ch)) {
      word += ch.toUpperCase();
    } else {
      flush();
    }
  }
  flush();
  return pieces;
}

function joinUpTo(pieces: string[], max: number): string {
  let out = "";
  for (const piece of pieces) {
    if (out.length + piece.length > max) { if (!out) out = piece.slice(0, max); break; }
    out += piece;
  }
  return out;
}

export function validBrand(brand: string): boolean {
  return typeof brand === "string" && /^[A-Z0-9]{3,12}$/.test(brand) && !/^(RVN|RAVEN|RAVENCOIN)$/.test(brand);
}

export function brandFrom(nickname: string): string {
  const base = romanPieces(nickname).join("").slice(0, BRAND_MAX);
  return validBrand(base) ? base : "";
}

export function brandCandidates(base: string): string[] {
  if (!validBrand(base)) return [];
  const out = [base];
  for (let i = 2; i <= 9; i++) out.push(base.slice(0, BRAND_MAX - 1) + i);
  return out.filter(validBrand);
}

const FALLBACK: Record<CreateKind, string> = { certificate: "CERT", ticket: "TICKET", work: "WORK" };
export function slugFrom(title: string, kind: CreateKind): string {
  return joinUpTo(romanPieces(title), SLUG_MAX) || FALLBACK[kind];
}

export function dateCode(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return two(date.getFullYear() % 100) + two(date.getMonth() + 1) + two(date.getDate());
}

/** 체인 이름에서 차례(run)를 되읽는다 — `BRAND#SLUG260924C-12` → 2. 모르면 -1. */
export function runOf(name: string): number {
  const m = /\d{6}([A-Z]?)-\d+$/.exec(name);
  if (!m) return -1;
  return m[1] ? RUN_LETTERS.indexOf(m[1]) + 1 || -1 : 0;
}

export function runSuffix(run: number): string {
  if (!Number.isInteger(run) || run < 0 || run > RUN_LETTERS.length) throw new Error("같은 날 같은 제목으로는 더 만들 수 없습니다. 제목을 바꿔 주세요.");
  return run === 0 ? "" : RUN_LETTERS[run - 1];
}

export type NameInput = { kind: CreateKind; brand: string; title: string; date: Date; count: number; run: number };

export function itemNames(input: NameInput): string[] {
  if (!validBrand(input.brand)) throw new Error("브랜드 이름을 확인해 주세요.");
  const stem = slugFrom(input.title, input.kind) + dateCode(input.date) + runSuffix(input.run);
  if (input.kind === "ticket") return [`${input.brand}/${stem}`];
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_COPIES) throw new Error(`한 번에 1~${MAX_COPIES}장까지 만들 수 있습니다.`);
  return Array.from({ length: input.count }, (_, i) => `${input.brand}#${stem}-${i + 1}`);
}

/** 모든 단계의 소각 + 수수료 몫(RVN). 화면에는 이 숫자 하나만 보인다. */
export function totalRvn(kind: CreateKind, copies: number, needsBrand: boolean): number {
  const item = kind === "ticket" ? BURN.ticket : BURN.unique * copies;
  // 장이 많으면 거래가 커진다(50장 ≈ 8KB) — 수수료 몫도 늘린다.
  const itemFee = kind === "ticket" ? FEE_ALLOWANCE : Math.max(FEE_ALLOWANCE, 0.01 + 0.003 * copies);
  const sum = (needsBrand ? BURN.brand + FEE_ALLOWANCE : 0) + item + itemFee;
  return Math.round(sum * 1e8) / 1e8;
}

export async function findFreeRun(
  make: (run: number) => string[],
  taken: (names: string[]) => Promise<boolean[]>,
  /** 이번 묶음에서 이미 쓴 차례 — 방금 보낸 것은 아직 체인에 안 보일 수 있다. */
  skip: ReadonlySet<number> = new Set(),
): Promise<{ run: number; names: string[] }> {
  for (let run = 0; run < MAX_RUNS; run++) {
    if (skip.has(run)) continue;
    const names = make(run);
    // BRAND 아래는 BRAND! 주인만 발행한다 — 겹치는 건 내 예전 발행뿐이라 처음·끝만 본다.
    const probes = names.length > 1 ? [names[0], names[names.length - 1]] : names;
    if (!(await taken(probes)).some(Boolean)) return { run, names };
  }
  throw new Error("같은 날 같은 제목으로는 더 만들 수 없습니다. 제목을 바꿔 주세요.");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** 파일 SHA-256 → 체인에 적는 지문(CIDv0). 확인 페이지가 같은 방식으로 대조한다. */
export function fingerprintOf(sha256: Uint8Array): string {
  if (sha256.length !== 32) throw new Error("파일 지문을 만들지 못했습니다.");
  const bytes = new Uint8Array(34);
  bytes[0] = 0x12; bytes[1] = 0x20; bytes.set(sha256, 2);
  return base58(bytes);
}

export async function fileFingerprint(file: Blob, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  return fingerprintOf(new Uint8Array(await subtle.digest("SHA-256", await file.arrayBuffer())));
}

export function verifyLink(name: string): string {
  return `${VERIFY_URL}?a=${encodeURIComponent(name)}`;
}

/** 체인 이름을 사람 말로 읽은 것(0.4.8-A5). */
export type ItemParts = { issuer: string; tag: string; date: string | null; number: number | null };

/**
 * 증서·작품 이름(`BRAND#SLUG260924-1`)을 **위 규칙대로** 거꾸로 읽는다 —
 * 발급자(`#` 앞, 부모 이름) · 발급일(이름 속 YYMMDD) · 번호(`-N`).
 *
 * 🔴 규칙대로 붙은 것만 읽는다. 날짜 자리가 달이 13 이거나 모양이 다르면 날짜·번호를
 *    **지어내지 않고** null 로 둔다 — 남이 손으로 지은 `ART#MONA` 같은 이름도 온다.
 * `#` 가 없으면(티켓·일반 자산) null.
 */
export function readItemName(name: string): ItemParts | null {
  const at = String(name ?? "").lastIndexOf("#");
  if (at <= 0 || at === name.length - 1) return null;
  const issuer = name.slice(0, at), tag = name.slice(at + 1);
  const m = /(\d{2})(\d{2})(\d{2})[A-Z]?-(\d+)$/.exec(tag);
  if (!m) return { issuer, tag, date: null, number: null };
  const month = Number(m[2]), day = Number(m[3]);
  const date = month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `20${m[1]}-${m[2]}-${m[3]}` : null;
  return { issuer, tag, date, number: date ? Number(m[4]) : null };
}

/* ── 이어서 하기 ─────────────────────────────────────────────────────
   이름 등록을 보내고 창을 닫아도, 다시 열면 기다림 화면에서 이어진다.
   비밀은 없다 — 제목·장수·브랜드·거래 번호·파일 지문뿐.
   🔴 받는 사람 이름·발급자·설명은 여기 두지 않는다. 그건 러스트의 만든 기록
   (`create_history.rs`, 0600)에 있고, 여기는 그 기록 번호(`historyId`)만 든다. */
export type CreateDraft = {
  version: 1; kind: CreateKind; title: string; count: number; brand: string;
  /** `sent-unknown` — 발행 부름이 시간 초과로 끝나 보냈는지 모른다. 풀리기 전에는 새로 안 만든다. */
  stage: "brand-sent" | "done" | "sent-unknown"; txid: string; fingerprint?: string; names?: string[]; updatedAt: number;
  historyId?: string;
  /** 보냈는지 모를 때 무엇을 보냈나 — 이름 등록인지, 만들기인지. */
  step?: "brand" | "ticket" | "uniques";
};

export function parseDraft(raw: string | null): CreateDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CreateDraft;
    const max = v.kind === "ticket" ? MAX_TICKETS : MAX_COPIES;
    if (v.version !== 1 || !["certificate", "ticket", "work"].includes(v.kind) || typeof v.title !== "string" || v.title.length > 80) return null;
    if (!Number.isInteger(v.count) || v.count < 1 || v.count > max || !validBrand(v.brand)) return null;
    // 거래 번호는 모를 수 있다(보냈는지 모름 → 체인에서 찾아 푼 것). 그때는 빈 글자.
    if (!["brand-sent", "done", "sent-unknown"].includes(v.stage) || !/^(?:[a-f0-9]{64})?$/.test(v.txid) || !Number.isSafeInteger(v.updatedAt)) return null;
    if (v.step !== undefined && !["brand", "ticket", "uniques"].includes(v.step)) return null;
    if (v.stage === "sent-unknown" && !v.step) return null;
    if (v.fingerprint !== undefined && !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(v.fingerprint)) return null;
    if (v.names !== undefined && (!Array.isArray(v.names) || v.names.length > MAX_COPIES || v.names.some((n) => typeof n !== "string" || n.length > 32))) return null;
    if (v.historyId !== undefined && !/^[a-f0-9]{32}$/.test(v.historyId)) return null;
    return v;
  } catch {
    return null;
  }
}

/* ── 증명서 칸 ────────────────────────────────────────────────────── */

export type CertTemplate = "course" | "proof" | "thanks";
export const CERT_TEMPLATES: CertTemplate[] = ["course", "proof", "thanks"];

/** 받는 사람 칸 — 한 줄에 한 명. 빈 줄은 뺀다. 이름은 체인에 안 간다. */
export function parseRecipients(text: string): string[] {
  return String(text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 고치기(이미 만든 기록) — 줄이 곧 차례다. 빈 줄도 자리를 지키고("") 끝의 빈 줄만 뗀다.
 *  🔴 가운데 빈 줄을 당기면 뒤 사람 이름이 앞 사람의 체인 이름·사진·번호와 붙는다. */
export function recipientSlots(text: string): string[] {
  const out = String(text ?? "").split(/\r?\n/).map((s) => s.trim());
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** 오늘(이 컴퓨터 시각) — 발급일 칸의 기본값. */
export function todayYmd(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
