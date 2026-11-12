/*
 * 「게임 올리기」 순수 규칙 — 폴더 검사 · 상품 문서 본문 만들기 · 자산 이름 · 소각액. 화면·네트워크·키 없음(시험 가능).
 *
 * 규칙은 새로 만들지 않고 이미 있는 것을 쓴다:
 *   · 문서 모양·한도 = core/creator/arcade-product.ts(validateArcadeProduct · ARCADE_LIMITS · ARCADE_GENRES)
 *   · 자산 이름 = core/creator/asset-name-v3.ts(RVLT/<가게>#<꼬리표> 고유 · RVLT/<가게>/<상품> 상품) · 소각액 = asset-name.ts BURN_RVN
 *   · 게임이 공유 사이트에서 열릴 수 있나 = 사이트 게임 CSP(지갑 저장소 scripts/web-csp.mjs WEB_GAME_CSP:
 *     script-src 'self' · 밖으로 연결·그림·글꼴 없음 · 인라인 스크립트 없음) + 파일 하나 4MB(release-site g-page GAME_FILE_MAX).
 *     이 둘에 걸리면 돈을 받고도 게임이 안 열린다 → 올리기 전에 막는다.
 */
import {
  ARCADE_FEE_BPS, ARCADE_GENRES, ARCADE_LIMITS, validateArcadeProduct, type ArcadeFile, type ArcadeGenre, type ArcadeProductBody,
} from "../core/creator/arcade-product";
import { checkAssetNameV3 } from "../core/creator/asset-name-v3";
import { BURN_RVN } from "../core/creator/asset-name";
import { MARKET_FEE_ADDRESS } from "../core/creator/trade-primitives";

/** 공유 사이트가 게임 파일 하나를 내줄 수 있는 크기(release-site/og/g-page.mjs GAME_FILE_MAX). */
export const SITE_FILE_MAX = 4 * 1024 * 1024;

export type FolderScan = { folder: string; files: ArcadeFile[]; skipped: string[]; badNames: string[]; htmlTexts: Record<string, string> };
export type Problem = { code: string; path?: string; say: string };

/** 러스트 arcade_pick_folder 답 → 모양을 믿지 않고 고친 값. 틀리면 null. */
export function scanOf(raw: unknown): FolderScan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const files = (Array.isArray(r.files) ? r.files : []).filter((f): f is ArcadeFile =>
    !!f && typeof f === "object" && typeof (f as any).path === "string" && typeof (f as any).sha256 === "string" && Number.isSafeInteger((f as any).size));
  const strs = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string");
  const texts: Record<string, string> = {};
  if (r.htmlTexts && typeof r.htmlTexts === "object") for (const [k, v] of Object.entries(r.htmlTexts as Record<string, unknown>)) if (typeof v === "string") texts[k] = v;
  return { folder: typeof r.folder === "string" ? r.folder : "", files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })), skipped: strs(r.skipped), badNames: strs(r.badNames), htmlTexts: texts };
}

export const isHtml = (p: string) => /\.html?$/i.test(p);
/** 시작 파일 후보 — index.html 이 있으면 맨 앞. */
export function entryCandidates(files: readonly ArcadeFile[]): string[] {
  const html = files.map((f) => f.path).filter(isHtml);
  return [...html.filter((p) => /^index\.html?$/i.test(p)), ...html.filter((p) => !/^index\.html?$/i.test(p))];
}

/**
 * HTML 한 장에서 공유 사이트 게임 CSP 가 막을 것을 찾는다. 막히면 그 게임은 열리지 않거나 반쯤만 돈다.
 *   · 밖의 주소(http:// · https:// · //)를 src/href/srcset 로 부름(스크립트·그림·글꼴·스타일 모두 'self' 만)
 *   · 인라인 <script>(src 없이 몸통이 있는 것) — script-src 'self' 는 인라인을 막는다
 *   · on…= 속성(onclick 등) — 인라인 스크립트와 같다
 *   · <iframe>·<form> — frame-src·form-action 'none'
 */
export function cspProblems(path: string, html: string): Problem[] {
  const out: Problem[] = [];
  const ext = html.match(/\b(?:src|href|srcset|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\/[^\s"'>]+/gi) ?? [];
  for (const m of ext.slice(0, 5)) out.push({ code: "external", path, say: `밖의 주소를 불러요(공유 사이트에서 막혀요): ${m.replace(/^[^=]+=\s*["']?\s*/, "").slice(0, 80)}` });
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.some((s) => !/\bsrc\s*=/.test(s[1]) && !/type\s*=\s*["']?(?:application\/json|application\/ld\+json|text\/template)/i.test(s[1]) && s[2].trim() !== ""))
    out.push({ code: "inline-script", path, say: "HTML 안에 바로 쓴 스크립트가 있어요. 공유 사이트는 파일로 된 스크립트(<script src=\"…\">)만 돌려요." });
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) out.push({ code: "inline-handler", path, say: "onclick 같은 속성은 공유 사이트에서 막혀요. 스크립트 파일 안에서 연결해 주세요." });
  if (/<iframe\b/i.test(html)) out.push({ code: "iframe", path, say: "게임 안의 <iframe> 은 공유 사이트에서 막혀요." });
  if (/<form\b[^>]*\baction\s*=/i.test(html)) out.push({ code: "form", path, say: "게임 안의 폼 보내기는 공유 사이트에서 막혀요." });
  return out;
}

/** 폴더 전체 검사. problems 가 하나라도 있으면 올리지 않는다. warnings 는 알리고 올린다. */
export function checkFolder(scan: FolderScan, entry: string | null): { problems: Problem[]; warnings: Problem[] } {
  const problems: Problem[] = [], warnings: Problem[] = [];
  if (!scan.files.length) problems.push({ code: "empty", say: "폴더에 파일이 없어요." });
  if (scan.files.length > ARCADE_LIMITS.files) problems.push({ code: "count", say: `파일이 너무 많아요(${ARCADE_LIMITS.files}개까지).` });
  const total = scan.files.reduce((n, f) => n + f.size, 0);
  if (total > ARCADE_LIMITS.totalBytes) problems.push({ code: "total", say: "폴더가 너무 커요(모두 200MB까지)." });
  for (const f of scan.files) if (f.size > SITE_FILE_MAX) problems.push({ code: "file-size", path: f.path, say: `파일 하나가 4MB를 넘어 공유 사이트에서 열리지 않아요: ${f.path}` });
  for (const p of scan.badNames) problems.push({ code: "name", path: p, say: `파일 이름에는 영문·숫자·점·밑줄·빼기만 쓸 수 있어요(한글·빈칸·바로가기는 안 돼요): ${p}` });
  const entries = entryCandidates(scan.files);
  if (!entries.length) problems.push({ code: "entry", say: "시작할 HTML 파일(index.html)이 없어요." });
  else if (!entry || !entries.includes(entry)) problems.push({ code: "entry", say: "시작 파일을 골라 주세요." });
  for (const p of scan.files.map((f) => f.path).filter(isHtml)) {
    const text = scan.htmlTexts[p];
    if (typeof text !== "string") { warnings.push({ code: "unread", path: p, say: `HTML 을 다 읽지 못해 검사하지 않았어요: ${p}` }); continue; }
    problems.push(...cspProblems(p, text));
  }
  if (scan.skipped.length) warnings.push({ code: "skipped", say: `숨김 파일 ${scan.skipped.length}개는 올리지 않아요(.DS_Store 등).` });
  return { problems, warnings };
}

/** 꼬리표(# 뒤) 제안: 영문 제목이면 대문자·숫자·밑줄로. 한글만이면 빈 칸(사람이 적는다 — 뜻 번역 안 함). */
export function suggestTag(title: string): string {
  return title.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
}
/** 문서 id(소문자·숫자·빼기 3~40자) — 꼬리표에서. */
export function idFromTag(tag: string): string {
  const s = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s.length >= 3 ? s : (s + "-game").slice(0, 40);
}

export type Target = { mode: "new"; shop: string; tag: string } | { mode: "update"; asset: string };
/** 올릴 자산 이름과 소각액. 새 게임 = 고유 자산(5 RVN), 고치기 = 상품 자산 재발행(100 RVN). */
export function targetName(t: Target): { name: string; burnRvn: number; problems: string[] } {
  if (t.mode === "update") {
    const c = checkAssetNameV3(t.asset);
    return { name: t.asset, burnRvn: BURN_RVN.reissue, problems: c.valid && c.parsed?.kind === "product" ? [] : ["고칠 수 있는 것은 RVLT/<가게>/<상품> 자산뿐이에요."] };
  }
  const name = `RVLT/${t.shop}#${t.tag}`;
  const c = checkAssetNameV3(name);
  return { name, burnRvn: BURN_RVN.unique, problems: c.valid && c.parsed?.kind === "unique" ? [] : c.problems.length ? c.problems : ["자산 이름이 맞지 않아요."] };
}

/** 지갑의 주인 표 목록 → 게임을 올릴 수 있는 가게(RVLT/<가게>!) · 고칠 수 있는 상품(RVLT/<가게>/<상품>!). */
export function sellerPlaces(ownerTokens: unknown): { shops: string[]; products: string[] } {
  const list = (Array.isArray(ownerTokens) ? ownerTokens : []).filter((x): x is string => typeof x === "string");
  const shops = list.map((n) => /^RVLT\/([A-Z0-9._]+)!$/.exec(n)?.[1]).filter((x): x is string => !!x).sort();
  const products = list.map((n) => /^(RVLT\/[A-Z0-9._]+\/[A-Z0-9._]+)!$/.exec(n)?.[1]).filter((x): x is string => !!x).sort();
  return { shops, products };
}

/** RVN 글 → atoms 문자열(소수 8자리까지). 틀리면 null. 0 = 무료. */
export function atomsOfRvnText(s: string): string | null {
  const m = /^\s*(\d{1,11})(?:\.(\d{1,8}))?\s*$/.exec(s);
  if (!m) return null;
  const a = BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
  return a.toString();
}

export type DraftInput = {
  id: string; version: number; title: string; description: string; priceSats: string; seller: string; payTo: string;
  entry: string; cid: string; files: ArcadeFile[]; minutes: number; genre: ArcadeGenre; assetName: string;
};
/** 상품 문서 본문(서명 전). core validateArcadeProduct 로 모양을 확인하고, 틀리면 그 오류를 던진다. */
export function buildBody(d: DraftInput): ArcadeProductBody {
  if (d.payTo === MARKET_FEE_ADDRESS) throw new Error("arcade-address: pay-to");
  if (!(ARCADE_GENRES as readonly string[]).includes(d.genre)) throw new Error("arcade-x: genre");
  const body: ArcadeProductBody = {
    format: "rv-arcade-product", v: 1, kind: "arcade-game", id: d.id, version: d.version, title: d.title.trim(), description: d.description,
    priceSats: d.priceSats, seller: d.seller, payTo: d.payTo, feeBps: ARCADE_FEE_BPS, entry: d.entry, cid: d.cid,
    files: [...d.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    assetName: d.assetName, x: { arcade: { mode: "solo", network: "none", minutes: d.minutes, genre: d.genre } },
  };
  validateArcadeProduct({ ...body, sig: "" });
  return body;
}

/** 시험·미리보기용 자리 CID(폴더를 아직 안 올렸을 때 모양 검사만). 체인·IPFS 에 쓰지 않는다. */
export const PLACEHOLDER_CID = "Qm" + "W".repeat(44);
