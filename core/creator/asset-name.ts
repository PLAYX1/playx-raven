import type { ContentType } from './limits';

/*
 * 제작자 상품 이름(레이븐코인 자산 이름)·소각 비용·이름 충돌/사칭 경고.
 *
 * 🔴 대표 확정(2026-10-10): 이름 방식은 `RV.<종류글자>.<작품이름>` 이다. 예: RV.M.FOREST(음악), RV.B.SEA_BOOK(책).
 *    제작자가 **직접 루트 자산을 발행**한다(500 RVN 보증, 주인 표 `RV.M.FOREST!` 는 제작자 지갑에 생기고 우리에게 묻지 않는다).
 *    `RV.` 는 「관례 접두어」일 뿐 우리가 소유하지 않는다 — 누구나 `RV.` 로 시작하는 루트를 만들 수 있다.
 *    종류 글자 칸 덕분에 목록을 종류별로 찾는다(listassets "RV.M.*" = 음악만). 종류 글자와 매니페스트 type 이 다르면 거절한다(사칭 방지).
 *    접두어·종류 표는 이 파일의 CREATOR_ASSET_PREFIX·ASSET_KIND_LETTER 두 상수에만 있다.
 *    접두어를 `/` 로 끝나게 바꾸면 하위 자산(주인 표 필요) 규칙이 되살아난다(시험 있음) — 이때도 `<부모>/<종류글자>.<작품>` 이다.
 *    비교한 안(A·B·C)과 결정 기록은 docs/open-seller-platform.md §2.
 *
 * 이름 규칙은 Ravencoin assets.cpp 의 정규식을 옮긴 것이다(데스크탑 issue.rs·create.rs 주석 + 기억 — 원본 재대조 안 함 → 확인 필요).
 * 소각액은 데스크탑 issue.rs·issue2.rs 상수이며 노드에 묻는 RPC 가 없어 **체인과 대조할 수 없다** → 「확인 불가」(burnCheck).
 */

export const CREATOR_ASSET_PREFIX = 'RV.';
/** 코어 MAX_NAME_LENGTH 31 에서 주인 표시 `!` 한 칸을 뺀 값(데스크탑 issue.rs, assets.cpp:370 인용). */
export const MAX_ASSET_NAME = 30;

export type AssetKindLetter = 'M' | 'G' | 'B' | 'T' | 'X';
/**
 * 종류 → 이름 안의 종류 글자(한 곳). M=음악, G=게임, B=책, T=티켓은 대표 확정.
 * 🔴 X=그 밖의 디지털 상품은 **제안**(대표 확인 대기) — 바꾸려면 이 표 한 줄만 고친다(KIND_LETTER_PENDING 도 같이).
 */
export const ASSET_KIND_LETTER: Readonly<Record<ContentType, AssetKindLetter>> = Object.freeze({ music: 'M', game: 'G', book: 'B', ticket: 'T', digital: 'X' });
/** 아직 대표 확인을 기다리는 종류 글자(문서·보고용 표시). */
export const KIND_LETTER_PENDING: ReadonlySet<AssetKindLetter> = new Set(['X']);
const TYPE_BY_LETTER: ReadonlyMap<string, ContentType> = new Map(Object.entries(ASSET_KIND_LETTER).map(([t, l]) => [l, t as ContentType]));
export const typeOfKindLetter = (letter: string): ContentType | null => TYPE_BY_LETTER.get(letter) ?? null;
/** 종류별 이름 앞부분(예: 음악 → 「RV.M.」). 마법사는 이 앞부분을 고정해 보여 주고 작품 이름 칸만 받는다. */
export const assetPrefixFor = (type: ContentType, prefix: string = CREATOR_ASSET_PREFIX): string => prefix + ASSET_KIND_LETTER[type] + '.';
/** 체인 목록 검색 패턴(listassets). 종류를 주면 그 종류만(「RV.M.*」), 없으면 전부(「RV.*」). */
export const kindSearchPattern = (type: ContentType | null = null, prefix: string = CREATOR_ASSET_PREFIX): string => (type ? assetPrefixFor(type, prefix) : prefix) + '*';

/** RVN 단위 소각액(저장소 기재값). 출처: 데스크탑 src-tauri/src/issue.rs BURN_* · issue2.rs 재발행 100. 원본 미대조. */
export const BURN_RVN = Object.freeze({ root: 500, sub: 100, unique: 5, reissue: 100 });
export const BURN_SOURCE = '데스크탑 issue.rs·issue2.rs 상수(주석상 chainparams.cpp 에서 옮김). 노드에 묻는 RPC 가 없어 이번에 체인과 대조하지 못함.';

/**
 * 예약어. 체인(assets.cpp RVN_NAMES — 기억, 원본 미대조)은 **이름 전체**가 이 낱말일 때만 막는다.
 * 우리는 더 엄격하게, 작품 이름의 점(.)으로 나뉜 어느 칸이든 이 낱말이면 거절한다(RV.M.RVN, RV.M.RAVEN.COIN 의 RAVEN 칸).
 * 출처: 데스크탑 create.rs `matches!(s, "RVN" | "RAVEN" | "RAVENCOIN")` 와 같은 목록. 노드 원본 목록과 실제 대조는 **확인 필요**.
 */
export const RESERVED_WORDS: readonly string[] = Object.freeze(['RVN', 'RAVEN', 'RAVENCOIN']);

const ROOT_CHARS = /^[A-Z0-9._]{3,}$/;
const SUB_CHARS = /^[A-Z0-9._]+$/;
const DOUBLE_PUNCT = /[._]{2,}/;
const LEAD_PUNCT = /^[._]/;
const TRAIL_PUNCT = /[._]$/;
const RESERVED_ROOT = new RegExp(`^(?:${RESERVED_WORDS.join('|')})$`);

export type NameKind = 'root' | 'sub';
export type NameCheck = {
  valid: boolean; name: string; kind: NameKind; parent: string | null; ownerTokenNeeded: string | null; burnRvn: number; problems: string[];
  /** 이름의 종류 글자가 가리키는 종류(글자가 표에 없으면 null). */
  type: ContentType | null; kindLetter: string | null;
  /** 접두어·종류 글자를 뺀 작품 이름. */
  work: string;
};

const partProblems = (part: string, root: boolean): string[] => {
  const p: string[] = [];
  if (!(root ? ROOT_CHARS : SUB_CHARS).test(part)) p.push(root ? '이름은 영문 대문자·숫자·점·밑줄로 3글자 이상이어야 해요.' : '이름에는 영문 대문자·숫자·점(.)·밑줄(_)만 쓸 수 있어요.');
  if (DOUBLE_PUNCT.test(part)) p.push('점·밑줄을 두 번 이어 쓸 수 없어요.');
  if (LEAD_PUNCT.test(part) || TRAIL_PUNCT.test(part)) p.push('점·밑줄로 시작하거나 끝날 수 없어요.');
  if (root && RESERVED_ROOT.test(part)) p.push(`${RESERVED_WORDS.join('·')} 은 쓸 수 없는 이름이에요.`);
  return p;
};
const KIND_LIST = () => Object.entries(ASSET_KIND_LETTER).map(([, l]) => l).join('·');

/** 이름을 접두어 · 종류 글자 · 작품 이름으로 나눈다. 모양이 아니면 null. */
export function parseCreatorAssetName(name: string, prefix: string = CREATOR_ASSET_PREFIX): { kindLetter: string; type: ContentType | null; work: string } | null {
  if (typeof name !== 'string' || !name.startsWith(prefix)) return null;
  const m = /^([A-Z0-9])\.(.*)$/s.exec(name.slice(prefix.length));
  return m ? { kindLetter: m[1], type: typeOfKindLetter(m[1]), work: m[2] } : null;
}

/**
 * 제작자가 고른 전체 자산 이름(접두어·종류 글자 포함)을 검사한다. 형식: `<접두어><종류글자>.<작품이름>`.
 * 접두어가 다르면 거절한다(다른 곳에 발행하지 않는다). opts.type 을 주면 이름의 종류 글자가 그 종류와 같아야 한다(사칭 방지).
 */
export function checkCreatorAssetName(name: string, prefix: string = CREATOR_ASSET_PREFIX, opts: { type?: ContentType | null } = {}): NameCheck {
  const problems: string[] = [];
  const kind: NameKind = prefix.endsWith('/') ? 'sub' : 'root';
  const parent = kind === 'sub' ? prefix.slice(0, -1) : null;
  const str = typeof name === 'string' ? name : '';
  if (typeof name !== 'string' || !name.startsWith(prefix)) problems.push(`이름은 「${prefix}<종류글자>.<작품이름>」 모양이어야 해요(예: ${prefix}M.FOREST).`);
  const parsed = parseCreatorAssetName(str, prefix);
  const tail = str.startsWith(prefix) ? str.slice(prefix.length) : '';
  let work = '';
  if (str.startsWith(prefix)) {
    if (!parsed) problems.push(`접두어 뒤에 종류 글자(${KIND_LIST()})와 점이 와야 해요(예: ${prefix}M.FOREST).`);
    else {
      work = parsed.work;
      if (!parsed.type) problems.push(`종류 글자 「${parsed.kindLetter}」는 없어요. ${KIND_LIST()} 중 하나여야 해요.`);
      if (!work) problems.push('작품 이름을 적어 주세요.');
      if (work && work.split(/[.]/).some(seg => RESERVED_WORDS.includes(seg))) problems.push(`작품 이름에 ${RESERVED_WORDS.join('·')} 은 쓸 수 없어요.`);
      if (opts.type && parsed.type && parsed.type !== opts.type)
        problems.push(`이름의 종류 글자 「${parsed.kindLetter}」가 고른 종류(${ASSET_KIND_LETTER[opts.type]})와 달라요. 「${assetPrefixFor(opts.type, prefix)}…」로 지어 주세요.`);
    }
  }
  if (kind === 'sub') {
    if (parent) problems.push(...partProblems(parent, true).map(p => '접두어: ' + p));
    if (tail.includes('/') || tail.includes('#')) problems.push('이름에 / 나 # 를 쓸 수 없어요.');
    else if (tail) problems.push(...partProblems(tail, false));
  } else if (typeof name === 'string') {
    if (name.includes('/') || name.includes('#') || name.includes('!') || name.includes('$') || name.includes('~')) problems.push('이름에 / # ! $ ~ 를 쓸 수 없어요.');
    else problems.push(...partProblems(name, true));
  }
  if (str.length > MAX_ASSET_NAME) problems.push(`전체 이름은 ${MAX_ASSET_NAME}자를 넘을 수 없어요(지금 ${str.length}자).`);
  return { valid: problems.length === 0, name: String(name ?? ''), kind, parent, ownerTokenNeeded: parent ? parent + '!' : null, burnRvn: BURN_RVN[kind], problems: [...new Set(problems)],
    type: parsed?.type ?? null, kindLetter: parsed?.kindLetter ?? null, work };
}

/** 사람이 적은 이름(「My Song 2」) + 종류 → 규칙에 맞춘 제안(「RV.M.MY_SONG_2」). 제안일 뿐 — 발행 전 사람이 확인한다. */
export function suggestCreatorAssetName(input: string, type: ContentType, prefix: string = CREATOR_ASSET_PREFIX): string {
  const tail = String(input ?? '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9._]+/g, '_').replace(/[._]{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
  return (assetPrefixFor(type, prefix) + tail).slice(0, MAX_ASSET_NAME).replace(/[._]+$/, '');
}

/**
 * 이름 후보 여러 개(제목이 한글뿐이라 영문 제안이 안 나올 때도). 이미 있는 이름(taken)과 겹치지 않는 것만, 최대 n 개.
 * fallback 은 화면이 주는 짧은 영문(예: 종류 「BOOK」)이다. 예약어가 든 제목은 fallback 으로 넘어간다.
 */
export function suggestNames(title: string, taken: ReadonlySet<string>, opts: { type: ContentType; fallback?: string; n?: number; prefix?: string }): string[] {
  const prefix = opts.prefix ?? CREATOR_ASSET_PREFIX, n = opts.n ?? 3, out: string[] = [], type = opts.type;
  const ok = (s: string) => checkCreatorAssetName(s, prefix, { type }).valid;
  const base = suggestCreatorAssetName(title, type, prefix);
  const seed = ok(base) ? base : suggestCreatorAssetName(opts.fallback ?? 'ITEM', type, prefix);
  const add = (s: string) => { if (out.length < n && !out.includes(s) && !taken.has(s) && ok(s)) out.push(s); };
  add(seed);
  for (let i = 2; out.length < n && i < 200; i++) add(seed.slice(0, MAX_ASSET_NAME - String(i).length - 1).replace(/[._]+$/, '') + '_' + i);
  return out;
}

/** 자산 이름 → 영구 gameId(설계 §2.2: 소문자, . / _ → -). 등록부 gameId 규칙에 안 맞으면 null. */
export function gameIdForAsset(asset: string): string | null {
  const id = String(asset ?? '').toLowerCase().replace(/[./_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(id) ? id : null;
}

export type BurnCheck = { kind: NameKind | 'reissue'; rvn: number; atoms: string; status: 'matched' | 'mismatch' | 'unverifiable'; say: string };
/**
 * 소각액을 체인 파라미터와 대조한다. chainRvn 은 체인(노드·탐색기)에서 읽은 값이며, 지금은 읽는 방법이 없어 늘 null 이다
 * → 'unverifiable'(「확인 불가」). 값이 들어왔는데 다르면 'mismatch' — 화면은 발행 단추를 잠근다.
 */
export function burnCheck(kind: NameKind | 'reissue', chainRvn: number | null): BurnCheck {
  const rvn = BURN_RVN[kind];
  const atoms = (BigInt(rvn) * 100_000_000n).toString();
  if (chainRvn === null || chainRvn === undefined || !Number.isFinite(chainRvn)) return { kind, rvn, atoms, status: 'unverifiable', say: `확인 불가 — ${BURN_SOURCE}` };
  if (chainRvn !== rvn) return { kind, rvn, atoms, status: 'mismatch', say: `체인 값 ${chainRvn} RVN 이 저장소 값 ${rvn} RVN 과 달라요. 발행하지 마세요.` };
  return { kind, rvn, atoms, status: 'matched', say: '체인 값과 같아요.' };
}

/* ── 이름 충돌·사칭 경고 ──────────────────────────────────────────────
 * 체인은 「정확히 같은 이름」만 막는다. 「RV.G.STAR_RUN」과 「RV.G.STARRUN」「RV.G.STAR_RUM」「RV.G.5TAR_RUN」은 전부 따로 발행된다.
 * 종류 글자가 달라도(「RV.B.STAR_RUN」) 작품 이름이 같으면 비슷한 이름으로 본다 — 다른 종류로 같은 이름을 내 사칭할 수 있다.
 * 그래서 비슷한 이름을 경고한다(막지는 않는다 — 우연히 비슷할 수도 있다). 구매자 화면도 같은 함수로 「비슷한 이름 있음」을 붙인다.
 * 공식처럼 보이는 낱말(PLAYX·RAVENVAULT·OFFICIAL 등)은 제작자에게 경고하고, 구매자에게도 「공식 아님」을 보인다.
 */
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({ '0': 'O', '1': 'I', L: 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '9': 'G', '4': 'A', '7': 'T', '3': 'E' });
/** 비교용 뼈대: 접두어·종류 글자·점·밑줄을 빼고, 헷갈리는 글자를 하나로 모은다. */
export function nameSkeleton(asset: string, prefix: string = CREATOR_ASSET_PREFIX): string {
  const s = String(asset ?? '').toUpperCase();
  const p = parseCreatorAssetName(s, prefix);
  const tail = p ? p.work : s.startsWith(prefix) ? s.slice(prefix.length) : s;
  return Array.from(tail.replace(/[._/#\s-]+/g, ''), c => LOOKALIKE[c] ?? c).join('').replace(/(.)\1+/g, '$1');
}
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const titleKey = (t: string) => String(t ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
export const OFFICIAL_LOOKING = /PLAY_?X|RAVEN_?VAULT|RAVEN_?COIN|RAVI_?STORY|OFFICIAL|VERIFIED|ADMIN|SUPPORT|레이븐볼트|플레이엑스|공식/i;
/** 작품 이름이 다시 「RV.」·「RVN」으로 시작하면 접두어를 겹쳐 쓴 공식 흉내로 본다(예: RV.M.RV.OFFICIAL_SONG, RV.M.RVN_MUSIC). */
const NESTED_PREFIX = /^RVN?[._]/;

export type NameNeighbor = { asset: string; title?: string };
export type Similar = { asset: string; why: 'same-skeleton' | 'one-letter' | 'contains' | 'same-title' };
export type NameConflict = { taken: boolean; similar: Similar[]; officialLooking: boolean; say: string[] };

/** 새 이름(또는 목록의 한 항목)을 다른 항목들과 비교한다. taken = 정확히 같은 이름이 이미 있다(발행 불가). */
export function nameConflicts(asset: string, title: string, others: readonly NameNeighbor[], prefix: string = CREATOR_ASSET_PREFIX): NameConflict {
  const sk = nameSkeleton(asset, prefix), tk = titleKey(title);
  const similar: Similar[] = [];
  let taken = false;
  for (const o of others) {
    if (o.asset === asset) { taken = true; continue; }
    const ok = nameSkeleton(o.asset, prefix);
    let why: Similar['why'] | null = null;
    if (ok && ok === sk) why = 'same-skeleton';
    else if (sk.length >= 4 && ok.length >= 4 && distance(sk, ok, 2) <= (Math.min(sk.length, ok.length) >= 10 ? 2 : 1)) why = 'one-letter';
    else if (sk.length >= 5 && ok.length >= 5 && (sk.includes(ok) || ok.includes(sk))) why = 'contains';
    else if (tk.length >= 2 && o.title && titleKey(o.title) === tk) why = 'same-title';
    if (why) similar.push({ asset: o.asset, why });
  }
  const p = parseCreatorAssetName(String(asset ?? ''), prefix);
  const tail = p ? p.work : String(asset ?? '').slice(prefix.length);
  const officialLooking = OFFICIAL_LOOKING.test(tail) || NESTED_PREFIX.test(tail) || OFFICIAL_LOOKING.test(String(title ?? ''));
  const say: string[] = [];
  if (taken) say.push('이 이름은 이미 누가 쓰고 있어요. 다른 이름을 골라 주세요.');
  if (similar.length) say.push(`비슷한 이름이 있어요: ${similar.slice(0, 3).map(s => s.asset).join(', ')}. 다른 사람 작품으로 오해받을 수 있어요.`);
  if (officialLooking) say.push('「공식」처럼 보이는 낱말(PLAYX·레이븐볼트·OFFICIAL 등)이 들어 있어요. 레이븐볼트 공식 상품이 아니면 쓰지 마세요. 구매자에게는 「공식 아님」으로 보여요.');
  return { taken, similar, officialLooking, say };
}
