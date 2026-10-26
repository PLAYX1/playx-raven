/**
 * CSV 텍스트 → 상품 초안 목록(파싱·검증). 순수 함수만 — 네트워크·파일·Buffer·node:crypto 없음.
 * 서명·게시는 하지 않는다. 기존 product-doc / media-ref / download-terms / claim-words 를 재사용한다.
 */
import { findForbiddenPhrases } from '../brand';
import { hasClaimOrForbidden } from '../store/claim-words';
import { MAX_PRICE_ATOMS } from './manifest';
import {
  DOWNLOAD_DEFAULT_DAYS, DOWNLOAD_MAX_DAYS, DOWNLOAD_MIN_DAYS, isDownloadDays,
} from './download-terms';
import { MAX_CIPHER_URLS, sellerFileUrlProblem, type MediaHashItem } from './media-ref';
import {
  KNOWN_KINDS, MIN_FEE_OUTPUT_ATOMS, PRODUCT_DUST_ATOMS, ProductError, validateProductDoc,
  type ProductBody,
} from './product-doc';
import type { Loose } from './bytes';

/** 일괄 올리기 한계 — 한 곳에만 둔다. */
export const BULK_LIMITS = {
  /** 데이터 행 상한. 업로드·검토 UI 가 한 번에 다루기 쉬운 분량(대표 지시). 501이면 파일 단위로 거절. */
  maxRows: 500,
  /** 셀 한 칸 문자 상한(제목·설명·URL 등). 상품 문서 16KB·화면 입력과 맞춤. */
  maxCellChars: 2000,
  /** 재고 상한(개). 주문 수량 상한(MAX_ORDER_QTY)과 별도로, 일괄 표의 재고 칸용. */
  maxStock: 1_000_000,
} as const;

const ATOMS_PER_RVN = 100_000_000n;
const PRICE_RE = /^\d+(\.\d{1,8})?$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SIZE_RE = /^[1-9]\d*$/;
const INT_RE = /^-?\d+$/;
const FORMULA_RE = /^[=+\-@]/;

export type BulkIssue = { line: number; column?: string; code: string; say: string };
export type BulkContext = {
  seller: string;
  payTo: string;
  feeBps: number;
  feeSchedule: string;
};
export type BulkDraft = {
  line: number;
  body: ProductBody;
  fileUrls: string[];
  fileSha256: string[];
  fileSizes: number[];
  previewUrl: string | null;
  description: string;
  stock: number | null;
  downloadDays: number;
  warnings: BulkIssue[];
};
export type BulkResult = {
  ok: boolean;
  reviewOnly: true;
  autoPublish: false;
  fileErrors: BulkIssue[];
  rowErrors: BulkIssue[];
  warnings: BulkIssue[];
  drafts: BulkDraft[];
  rowCount: number;
  canApproveAll: boolean;
};

type ColKey =
  | 'title' | 'kind' | 'price' | 'description' | 'file_urls' | 'sha256' | 'size'
  | 'preview_url' | 'download_days' | 'stock';

/** 헤더 별칭(소문자·trim 후 비교). 한글·영문 혼합·열 순서 자유. */
const HEADER_ALIASES: Record<ColKey, readonly string[]> = {
  title: ['title', '제목'],
  kind: ['kind', '종류'],
  price: ['price', 'price_rvn', '가격', '가격 rvn'],
  description: ['description', '설명'],
  file_urls: ['file_urls', '파일 url'],
  sha256: ['sha256', '파일 sha256'],
  size: ['size', '파일 크기'],
  preview_url: ['preview_url', '미리보기 url'],
  download_days: ['download_days', '다운로드 기간 일수'],
  stock: ['stock', '재고'],
};

const aliasToKey = new Map<string, ColKey>();
for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColKey, readonly string[]][]) {
  for (const a of aliases) aliasToKey.set(a, key);
}

const knownKindSet = new Set<string>(KNOWN_KINDS);

const issue = (line: number, code: string, say: string, column?: string): BulkIssue =>
  (column === undefined ? { line, code, say } : { line, column, code, say });

/** RVN 소수 문자열 → atoms(BigInt). 부동소수 Number/parseFloat 금지. */
export function rvnTextToAtoms(text: string): bigint | null {
  if (typeof text !== 'string' || !PRICE_RE.test(text)) return null;
  const dot = text.indexOf('.');
  if (dot < 0) return BigInt(text) * ATOMS_PER_RVN;
  const whole = text.slice(0, dot);
  const frac = text.slice(dot + 1);
  return BigInt(whole) * ATOMS_PER_RVN + BigInt(frac.padEnd(8, '0'));
}

/** 제목 중복 비교 열쇠: NFC · 소문자 · 공백 정리. */
export const titleDedupKey = (title: string): string =>
  title.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * RFC4180 CSV 분해. BOM 제거, CRLF/LF/CR, 따옴표 안 쉼표·개행·"" 이스케이프.
 * 줄 번호 = 원본 파일의 실제 줄(따옴표 속 개행 포함). 완전히 빈 줄은 건너뜀.
 */
export function parseCsvRecords(text: string): { rows: { line: number; cells: string[] }[]; error?: BulkIssue } {
  if (typeof text !== 'string') return { rows: [], error: issue(1, 'csv-empty', '파일이 비어 있어요.') };
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.length === 0) return { rows: [], error: issue(1, 'csv-empty', '파일이 비어 있어요.') };

  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = '';
  let i = 0;
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let fieldStarted = false;
  let recordHasContent = false;

  const pushField = () => {
    cells.push(field);
    field = '';
    fieldStarted = false;
  };
  /** 현재 레코드를 확정. 다음 레코드 시작 줄은 줄바꿈 처리 쪽에서 recordLine 을 갱신한다. */
  const endRecord = () => {
    if (!recordHasContent && cells.length === 0) return;
    pushField();
    // 완전히 빈 줄(칸이 하나이고 그 칸도 빈 문자열)만 건너뜀 — "a,," 같은 줄은 유지
    if (cells.length === 1 && cells[0] === '') {
      cells = [];
      recordHasContent = false;
      return;
    }
    rows.push({ line: recordLine, cells });
    cells = [];
    recordHasContent = false;
  };

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (ch === '\r') {
        field += '\n';
        line++;
        if (s[i + 1] === '\n') i += 2; else i++;
        continue;
      }
      if (ch === '\n') { field += '\n'; line++; i++; continue; }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      if (fieldStarted && field.length > 0) {
        // 따옴표가 칸 중간에 오면 그대로 문자로(관대) — 다만 RFC 상 칸 시작만 따옴표
        field += ch; i++; fieldStarted = true; recordHasContent = true; continue;
      }
      inQuotes = true; fieldStarted = true; recordHasContent = true; i++; continue;
    }
    if (ch === ',') { pushField(); fieldStarted = true; recordHasContent = true; i++; continue; }
    if (ch === '\r') {
      endRecord();
      line++;
      recordLine = line;
      if (s[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
      i++;
      continue;
    }
    field += ch; fieldStarted = true; recordHasContent = true; i++;
  }

  if (inQuotes) {
    return { rows: [], error: issue(recordLine, 'csv-unclosed-quote', `${recordLine}번째 줄 근처에서 따옴표가 닫히지 않았어요.`) };
  }
  // 파일 끝 마지막 레코드(개행 없음)
  if (recordHasContent || cells.length > 0 || field.length > 0 || fieldStarted) endRecord();

  if (rows.length === 0) return { rows: [], error: issue(1, 'csv-empty', '파일이 비어 있어요.') };
  return { rows };
}

const pipeSplit = (raw: string): string[] => {
  if (raw === '') return [];
  return raw.split('|').map(p => p.trim());
};

const productErrorSay = (e: ProductError): string => {
  const d = e.detail ? ` (${e.detail})` : '';
  switch (e.code) {
    case 'product-shape': return `상품 문서 모양이 맞지 않아요${d}.`;
    case 'product-kind': return '상품 종류 값이 올바르지 않아요.';
    case 'product-seller': return '판매자 공개키 값이 올바르지 않아요.';
    case 'product-pay-to': return '받는 주소 값이 올바르지 않아요.';
    case 'product-price': return '가격 값이 상품 문서 규칙에 맞지 않아요.';
    case 'product-fee': return `수수료 칸이 올바르지 않아요${d}.`;
    case 'product-media': return '사진·미디어 칸이 올바르지 않아요.';
    case 'product-revision': return '판 연결 칸이 올바르지 않아요.';
    case 'product-too-large': return '상품 문서가 너무 커요.';
    default: return `상품 문서 검사에 실패했어요 (${e.code}${d}).`;
  }
};

/**
 * CSV → 상품 초안 목록. ctx 는 공개 값만(seller·payTo·feeBps·feeSchedule). 키·시드·서명 함수 없음.
 */
export function parseBulkProducts(csv: string, ctx: BulkContext): BulkResult {
  const empty = (over: Partial<BulkResult> = {}): BulkResult => ({
    ok: false, reviewOnly: true, autoPublish: false,
    fileErrors: [], rowErrors: [], warnings: [], drafts: [], rowCount: 0, canApproveAll: false,
    ...over,
  });

  const parsed = parseCsvRecords(csv);
  if (parsed.error) return empty({ fileErrors: [parsed.error] });
  const { rows } = parsed;
  if (rows.length === 0) return empty({ fileErrors: [issue(1, 'csv-empty', '파일이 비어 있어요.')] });
  if (rows.length === 1) {
    return empty({ fileErrors: [issue(rows[0].line, 'csv-header-only', '헤더만 있고 상품 행이 없어요.')] });
  }

  const headerRow = rows[0];
  const colIndex = new Map<ColKey, number>();
  const fileWarnings: BulkIssue[] = [];
  const seenKeys = new Set<ColKey>();

  for (let c = 0; c < headerRow.cells.length; c++) {
    const raw = headerRow.cells[c];
    if (raw.length > BULK_LIMITS.maxCellChars) {
      fileWarnings.push(issue(headerRow.line, 'cell-too-long', `헤더 칸이 ${BULK_LIMITS.maxCellChars}자를 넘어요.`, raw.slice(0, 40)));
    }
    const norm = raw.trim().toLowerCase();
    if (norm === '') {
      fileWarnings.push(issue(headerRow.line, 'unknown-column', '이름 없는 열이 있어요.'));
      continue;
    }
    const key = aliasToKey.get(norm);
    if (!key) {
      fileWarnings.push(issue(headerRow.line, 'unknown-column', `알 수 없는 열이에요: ${raw.trim()}`, raw.trim()));
      continue;
    }
    if (seenKeys.has(key)) {
      fileWarnings.push(issue(headerRow.line, 'duplicate-column', `열이 중복이에요: ${raw.trim()}`, key));
      continue;
    }
    seenKeys.add(key);
    colIndex.set(key, c);
  }

  const required: ColKey[] = ['title', 'kind', 'price'];
  const missing = required.filter(k => !colIndex.has(k));
  if (missing.length > 0) {
    const names = missing.map(k => HEADER_ALIASES[k][0]).join(', ');
    return empty({
      fileErrors: [issue(headerRow.line, 'missing-columns', `필수 열이 없어요: ${names} (제목·종류·가격은 반드시 필요해요.)`)],
      warnings: fileWarnings,
    });
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > BULK_LIMITS.maxRows) {
    return empty({
      fileErrors: [issue(dataRows[BULK_LIMITS.maxRows].line, 'too-many-rows',
        `데이터 행이 ${BULK_LIMITS.maxRows}개를 넘어요 (${dataRows.length}행). 파일을 나눠 주세요.`)],
      warnings: fileWarnings,
      rowCount: dataRows.length,
    });
  }

  const cellAt = (cells: string[], key: ColKey): string | undefined => {
    const idx = colIndex.get(key);
    if (idx === undefined) return undefined;
    return cells[idx] ?? '';
  };

  const rowErrors: BulkIssue[] = [];
  const allWarnings: BulkIssue[] = [...fileWarnings];
  const drafts: BulkDraft[] = [];
  const titleFirstLine = new Map<string, number>();

  for (const row of dataRows) {
    const { line, cells } = row;
    const errs: BulkIssue[] = [];
    const warns: BulkIssue[] = [];

    for (let c = 0; c < cells.length; c++) {
      if (cells[c].length > BULK_LIMITS.maxCellChars) {
        errs.push(issue(line, 'cell-too-long', `칸이 ${BULK_LIMITS.maxCellChars}자를 넘어요.`, `col${c}`));
      }
    }

    const markFormula = (col: ColKey, raw: string) => {
      if (raw !== '' && FORMULA_RE.test(raw)) {
        warns.push(issue(line, 'formula-injection', '수식처럼 보이는 값이에요. 그대로 두었으니 확인해 주세요.', col));
      }
    };

    // ── 제목 ──
    let titleRaw = cellAt(cells, 'title') ?? '';
    markFormula('title', titleRaw);
    const titleTrimmed = titleRaw.trim();
    if (titleTrimmed !== titleRaw) {
      warns.push(issue(line, 'title-trim', '제목 앞뒤 공백을 제거했어요.', 'title'));
    }
    let title = titleTrimmed.normalize('NFC');
    if (title.length < 1) errs.push(issue(line, 'title-empty', '제목이 비어 있어요.', 'title'));
    else if (title.length > 80) errs.push(issue(line, 'title-length', '제목은 1~80자여야 해요.', 'title'));

    // ── 종류 ──
    let kindRaw = cellAt(cells, 'kind') ?? '';
    markFormula('kind', kindRaw);
    const kind = kindRaw.trim().toLowerCase();
    if (!kind) errs.push(issue(line, 'kind-empty', '종류가 비어 있어요.', 'kind'));
    else if (!knownKindSet.has(kind)) {
      errs.push(issue(line, 'kind-unknown',
        `허용되지 않는 종류예요: ${kindRaw.trim()}. 허용: ${KNOWN_KINDS.join(', ')}`, 'kind'));
    }

    // ── 가격 ──
    const priceRaw = (cellAt(cells, 'price') ?? '').trim();
    // 가격은 형식 검사가 걸러 주므로 수식 경고 대상에서 제외(정상 숫자는 =+−@ 로 시작하지 않음)
    let priceAtoms: bigint | null = null;
    if (!priceRaw) {
      errs.push(issue(line, 'price-empty', '가격이 비어 있어요.', 'price'));
    } else if (priceRaw.includes(',')) {
      errs.push(issue(line, 'price-format', '가격에 천 단위 쉼표를 쓸 수 없어요.', 'price'));
    } else if (priceRaw.startsWith('-') || priceRaw.startsWith('+')) {
      errs.push(issue(line, 'price-sign', '가격은 0보다 큰 수여야 해요.', 'price'));
    } else if (/\.\d{9,}/.test(priceRaw) || (priceRaw.includes('.') && !/^\d+\.\d{1,8}$/.test(priceRaw) && /^\d+\.\d+$/.test(priceRaw))) {
      errs.push(issue(line, 'price-decimals', '가격 소수점은 최대 8자리까지예요.', 'price'));
    } else {
      priceAtoms = rvnTextToAtoms(priceRaw);
      if (priceAtoms === null) {
        errs.push(issue(line, 'price-format', '가격 형식이 올바르지 않아요. 예: 1.5 또는 0.0015', 'price'));
      } else if (priceAtoms <= 0n) {
        errs.push(issue(line, 'price-nonpositive', '가격은 0보다 커야 해요.', 'price'));
      } else if (priceAtoms < PRODUCT_DUST_ATOMS) {
        errs.push(issue(line, 'price-dust', '가격이 너무 작아요(먼지 한도 미만).', 'price'));
      } else if (priceAtoms > MAX_PRICE_ATOMS) {
        errs.push(issue(line, 'price-max', '가격이 허용 상한을 넘어요.', 'price'));
      } else if (priceAtoms < MIN_FEE_OUTPUT_ATOMS) {
        warns.push(issue(line, 'price-below-fee-line', '수수료 면제선 아래예요.', 'price'));
      }
    }

    // ── 설명 ──
    let description = cellAt(cells, 'description') ?? '';
    markFormula('description', description);

    // ── 금지·주장 문구 ──
    if (title && hasClaimOrForbidden(title)) {
      const hits = findForbiddenPhrases(title);
      errs.push(issue(line, 'title-forbidden',
        hits.length ? `제목에 쓸 수 없는 표현이 있어요 (${hits.join(', ')}).` : '제목에 쓸 수 없는 표현이 있어요.',
        'title'));
    }
    if (description && hasClaimOrForbidden(description)) {
      const hits = findForbiddenPhrases(description);
      errs.push(issue(line, 'description-forbidden',
        hits.length ? `설명에 쓸 수 없는 표현이 있어요 (${hits.join(', ')}).` : '설명에 쓸 수 없는 표현이 있어요.',
        'description'));
    }

    // ── 제목 중복 ──
    if (title && title.length >= 1 && title.length <= 80) {
      const key = titleDedupKey(title);
      const first = titleFirstLine.get(key);
      if (first !== undefined) {
        errs.push(issue(line, 'title-duplicate', `제목이 ${first}번째 줄과 겹쳐요.`, 'title'));
      } else {
        titleFirstLine.set(key, line);
      }
    }

    // ── 파일 URL / sha256 / size ──
    const urlsRaw = cellAt(cells, 'file_urls');
    const shaRaw = cellAt(cells, 'sha256');
    const sizeRaw = cellAt(cells, 'size');
    if (urlsRaw !== undefined) markFormula('file_urls', urlsRaw);
    if (shaRaw !== undefined) markFormula('sha256', shaRaw);
    if (sizeRaw !== undefined) markFormula('size', sizeRaw);

    const fileUrls = pipeSplit(urlsRaw?.trim() ?? '');
    const shaParts = pipeSplit(shaRaw?.trim() ?? '');
    const sizeParts = pipeSplit(sizeRaw?.trim() ?? '');
    const fileSha256: string[] = [];
    const fileSizes: number[] = [];

    if (fileUrls.length > 0) {
      if (fileUrls.length > MAX_CIPHER_URLS) {
        errs.push(issue(line, 'files-too-many', `파일 URL은 최대 ${MAX_CIPHER_URLS}개까지예요.`, 'file_urls'));
      }
      if (shaParts.length !== fileUrls.length) {
        errs.push(issue(line, 'sha256-count', '파일 sha256 개수가 URL 개수와 같지 않아요.', 'sha256'));
      }
      if (sizeParts.length !== fileUrls.length) {
        errs.push(issue(line, 'size-count', '파일 크기 개수가 URL 개수와 같지 않아요.', 'size'));
      }
      const shaSeen = new Set<string>();
      for (let fi = 0; fi < fileUrls.length; fi++) {
        const u = fileUrls[fi];
        if (!u) {
          errs.push(issue(line, 'file-url-empty', '파일 URL이 비어 있어요.', 'file_urls'));
          continue;
        }
        const prob = sellerFileUrlProblem(u);
        if (prob === 'ssrf') {
          errs.push(issue(line, 'file-url-ssrf', '내부·사설 주소는 쓸 수 없어요.', 'file_urls'));
        } else if (prob === 'shape') {
          errs.push(issue(line, 'file-url-shape', '파일 URL은 https 주소여야 해요.', 'file_urls'));
        }

        const shaIn = shaParts[fi] ?? '';
        const sha = shaIn.toLowerCase();
        if (!SHA_RE.test(sha)) {
          errs.push(issue(line, 'sha256-format', '파일 sha256 은 64자리 소문자 16진수여야 해요.', 'sha256'));
        } else if (shaSeen.has(sha)) {
          errs.push(issue(line, 'sha256-duplicate', '같은 파일 해시가 중복이에요.', 'sha256'));
        } else {
          shaSeen.add(sha);
          fileSha256.push(sha);
        }

        const szText = sizeParts[fi] ?? '';
        if (!SIZE_RE.test(szText)) {
          errs.push(issue(line, 'size-format', '파일 크기는 양의 정수(바이트)여야 해요.', 'size'));
        } else {
          const n = Number(szText);
          if (!Number.isSafeInteger(n) || n <= 0) {
            errs.push(issue(line, 'size-format', '파일 크기는 양의 안전 정수여야 해요.', 'size'));
          } else {
            fileSizes.push(n);
          }
        }
      }
    } else if (shaParts.length > 0 || sizeParts.length > 0) {
      errs.push(issue(line, 'files-orphan', '파일 URL 없이 sha256·크기만 있을 수 없어요.', 'file_urls'));
    }

    // ── 미리보기 URL ──
    let previewUrl: string | null = null;
    const previewRaw = cellAt(cells, 'preview_url');
    if (previewRaw !== undefined && previewRaw.trim() !== '') {
      markFormula('preview_url', previewRaw);
      const p = previewRaw.trim();
      const prob = sellerFileUrlProblem(p);
      if (prob === 'ssrf') errs.push(issue(line, 'preview-ssrf', '미리보기 주소에 내부·사설 주소는 쓸 수 없어요.', 'preview_url'));
      else if (prob === 'shape') errs.push(issue(line, 'preview-shape', '미리보기 URL은 https 주소여야 해요.', 'preview_url'));
      else previewUrl = p;
    }

    // ── 다운로드 기간 ──
    let downloadDays = DOWNLOAD_DEFAULT_DAYS;
    const daysRaw = cellAt(cells, 'download_days');
    if (daysRaw !== undefined && daysRaw.trim() !== '') {
      markFormula('download_days', daysRaw);
      const t = daysRaw.trim();
      if (!INT_RE.test(t)) {
        errs.push(issue(line, 'download-days-format', '다운로드 기간은 정수(일)여야 해요.', 'download_days'));
      } else {
        const n = Number(t);
        if (!isDownloadDays(n)) {
          errs.push(issue(line, 'download-days-range',
            `다운로드 기간은 ${DOWNLOAD_MIN_DAYS}~${DOWNLOAD_MAX_DAYS}일이에요.`, 'download_days'));
        } else {
          downloadDays = n;
        }
      }
    }

    // ── 재고 ──
    let stock: number | null = null;
    const stockRaw = cellAt(cells, 'stock');
    if (stockRaw !== undefined && stockRaw.trim() !== '') {
      markFormula('stock', stockRaw);
      const t = stockRaw.trim();
      if (!/^[1-9]\d*$/.test(t)) {
        errs.push(issue(line, 'stock-format', '재고는 1 이상의 정수여야 해요(비우면 제한 없음).', 'stock'));
      } else {
        const n = Number(t);
        if (!Number.isSafeInteger(n) || n < 1 || n > BULK_LIMITS.maxStock) {
          errs.push(issue(line, 'stock-range', `재고는 1~${BULK_LIMITS.maxStock} 사이여야 해요.`, 'stock'));
        } else {
          stock = n;
        }
      }
    }

    if (errs.length > 0) {
      rowErrors.push(...errs);
      allWarnings.push(...warns);
      continue;
    }

    // ── ProductBody 조립 + validateProductDoc ──
    const media: MediaHashItem[] = fileSha256.map(h => ({ sha256: h }));
    const x: Record<string, Loose> = {};
    const descTrim = description; // 값은 자르거나 바꾸지 않음(수식 경고만)
    if (descTrim !== '') x.description = descTrim;
    if (stock !== null) x.stock = stock;
    x.downloadDays = downloadDays;
    if (fileUrls.length > 0) {
      x.fileUrls = fileUrls;
      x.fileSizes = fileSizes;
    }
    if (previewUrl) x.previewUrl = previewUrl;

    const body: ProductBody = {
      v: 1,
      kind,
      seller: ctx.seller,
      payTo: ctx.payTo,
      title,
      price: String(priceAtoms!),
      media,
      feeBps: ctx.feeBps,
      feeSchedule: ctx.feeSchedule,
      rev: 0,
      id: null,
      prev: null,
      ...(Object.keys(x).length ? { x } : {}),
    };

    try {
      validateProductDoc({ ...body, sig: 'unsigned' });
    } catch (e) {
      if (e instanceof ProductError) {
        rowErrors.push(issue(line, e.code, productErrorSay(e)));
        allWarnings.push(...warns);
        continue;
      }
      rowErrors.push(issue(line, 'product-validate', '상품 문서 검사에 실패했어요.'));
      allWarnings.push(...warns);
      continue;
    }

    drafts.push({
      line,
      body,
      fileUrls: [...fileUrls],
      fileSha256: [...fileSha256],
      fileSizes: [...fileSizes],
      previewUrl,
      description: descTrim,
      stock,
      downloadDays,
      warnings: warns,
    });
    allWarnings.push(...warns);
  }

  rowErrors.sort((a, b) => a.line - b.line || (a.column ?? '').localeCompare(b.column ?? '') || a.code.localeCompare(b.code));

  const rowCount = dataRows.length;
  // ok = 파일 오류(이미 early return)·행 오류 전혀 없음. 경고만 있으면 ok 가능.
  const ok = rowErrors.length === 0;
  const canApproveAll = ok && drafts.length === rowCount && rowCount > 0;

  return {
    ok,
    reviewOnly: true,
    autoPublish: false,
    fileErrors: [],
    rowErrors,
    warnings: allWarnings,
    drafts,
    rowCount,
    canApproveAll,
  };
}
