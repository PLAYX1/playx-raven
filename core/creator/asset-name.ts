/*
 * 제작자 상품 이름(레이븐코인 자산 이름)·소각 비용·이름 충돌/사칭 경고.
 *
 * 🔴 2단계(누구나 판매): 제작자가 **직접 루트 자산을 발행**한다. 주인 표(`이름!`)는 제작자 지갑에 생기고 우리에게 묻지 않는다.
 *    접두어 `PLAYXG.` 는 「관례 접두어」(데스크탑 SHOP.* 과 같은 방식)일 뿐 우리가 소유하지 않는다. 목록 검색(listassets "PLAYXG.*")을
 *    위한 공통 앞부분이다. 비교한 안(docs/open-seller-platform.md §2):
 *      A. PLAYXG.<작품>            루트 · 500 RVN · 누구나 · 가장 단순          ← 채택(이 상수)
 *      B. PLAYXG.<제작자>.<작품>   루트 · 500 RVN · 누구나 · 제작자 칸은 아무나 쓸 수 있어 「신원」이 아니다(사칭에 더 취약) · 이름 칸이 더 짧다
 *      C. PLAYXG.<제작자> 루트 + PLAYXG.<제작자>/<작품> 하위  첫 500 + 작품마다 100 · 제작자가 이름 공간을 진짜로 소유
 *         · 그러나 두 번째부터는 소각이 100 이라 (b)층 「500 RVN 보증」이 약해지고, 하위 발행은 주인 표를 다루는 두 단계라 초보에게 어렵다.
 *    A 는 B 형태의 이름(PLAYXG.ALICE.SONG)도 그대로 받는다 — 점은 루트 이름 안에 쓸 수 있다. 다만 가운데 칸을 신원으로 쓰지 않는다.
 *    접두어를 바꾸려면 이 상수 한 곳만 바꾼다. `/` 로 끝나면 하위 자산(주인 표 필요) 규칙이 되살아난다(시험 있음).
 *
 * 이름 규칙은 Ravencoin assets.cpp 의 정규식을 옮긴 것이다(데스크탑 issue.rs 주석 + 기억 — 원본 재대조 안 함 → 확인 필요).
 * 소각액은 데스크탑 issue.rs·issue2.rs 상수이며 노드에 묻는 RPC 가 없어 **체인과 대조할 수 없다** → 「확인 불가」(burnCheck).
 */

export const CREATOR_ASSET_PREFIX = 'PLAYXG.';
/** 코어 MAX_NAME_LENGTH 31 에서 주인 표시 `!` 한 칸을 뺀 값(데스크탑 issue.rs, assets.cpp:370 인용). */
export const MAX_ASSET_NAME = 30;

/** RVN 단위 소각액(저장소 기재값). 출처: 데스크탑 src-tauri/src/issue.rs BURN_* · issue2.rs 재발행 100. 원본 미대조. */
export const BURN_RVN = Object.freeze({ root: 500, sub: 100, unique: 5, reissue: 100 });
export const BURN_SOURCE = '데스크탑 issue.rs·issue2.rs 상수(주석상 chainparams.cpp 에서 옮김). 노드에 묻는 RPC 가 없어 이번에 체인과 대조하지 못함.';

const ROOT_CHARS = /^[A-Z0-9._]{3,}$/;
const SUB_CHARS = /^[A-Z0-9._]+$/;
const DOUBLE_PUNCT = /[._]{2,}/;
const LEAD_PUNCT = /^[._]/;
const TRAIL_PUNCT = /[._]$/;
const RESERVED_ROOT = /^(?:RVN|RAVEN|RAVENCOIN)$/;

export type NameKind = 'root' | 'sub';
export type NameCheck = { valid: boolean; name: string; kind: NameKind; parent: string | null; ownerTokenNeeded: string | null; burnRvn: number; problems: string[] };

const partProblems = (part: string, root: boolean): string[] => {
  const p: string[] = [];
  if (!(root ? ROOT_CHARS : SUB_CHARS).test(part)) p.push(root ? '이름은 영문 대문자·숫자·점·밑줄로 3글자 이상이어야 해요.' : '이름에는 영문 대문자·숫자·점(.)·밑줄(_)만 쓸 수 있어요.');
  if (DOUBLE_PUNCT.test(part)) p.push('점·밑줄을 두 번 이어 쓸 수 없어요.');
  if (LEAD_PUNCT.test(part) || TRAIL_PUNCT.test(part)) p.push('점·밑줄로 시작하거나 끝날 수 없어요.');
  if (root && RESERVED_ROOT.test(part)) p.push('RVN·RAVEN·RAVENCOIN 은 쓸 수 없는 이름이에요.');
  return p;
};

/** 제작자가 고른 전체 자산 이름(접두어 포함)을 검사한다. 접두어가 다르면 거절한다(다른 곳에 발행하지 않는다). */
export function checkCreatorAssetName(name: string, prefix: string = CREATOR_ASSET_PREFIX): NameCheck {
  const problems: string[] = [];
  const kind: NameKind = prefix.endsWith('/') ? 'sub' : 'root';
  const parent = kind === 'sub' ? prefix.slice(0, -1) : null;
  if (typeof name !== 'string' || !name.startsWith(prefix)) problems.push(`이름은 「${prefix}」로 시작해야 해요.`);
  const tail = typeof name === 'string' ? name.slice(prefix.length) : '';
  if (!tail) problems.push('상품 이름을 적어 주세요.');
  if (kind === 'sub') {
    if (parent) problems.push(...partProblems(parent, true).map(p => '접두어: ' + p));
    if (tail.includes('/') || tail.includes('#')) problems.push('이름에 / 나 # 를 쓸 수 없어요.');
    else if (tail) problems.push(...partProblems(tail, false));
  } else if (typeof name === 'string') {
    if (name.includes('/') || name.includes('#') || name.includes('!') || name.includes('$') || name.includes('~')) problems.push('이름에 / # ! $ ~ 를 쓸 수 없어요.');
    else problems.push(...partProblems(name, true));
  }
  if (typeof name === 'string' && name.length > MAX_ASSET_NAME) problems.push(`전체 이름은 ${MAX_ASSET_NAME}자를 넘을 수 없어요(지금 ${name.length}자).`);
  return { valid: problems.length === 0, name: String(name ?? ''), kind, parent, ownerTokenNeeded: parent ? parent + '!' : null, burnRvn: BURN_RVN[kind], problems: [...new Set(problems)] };
}

/** 사람이 적은 이름(「My Game 2」) → 규칙에 맞춘 제안(「PLAYXG.MY_GAME_2」). 제안일 뿐 — 발행 전 사람이 확인한다. */
export function suggestCreatorAssetName(input: string, prefix: string = CREATOR_ASSET_PREFIX): string {
  const tail = String(input ?? '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9._]+/g, '_').replace(/[._]{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
  return (prefix + tail).slice(0, MAX_ASSET_NAME).replace(/[._]+$/, '');
}

/**
 * 이름 후보 여러 개(제목이 한글뿐이라 영문 제안이 안 나올 때도). 이미 있는 이름(taken)과 겹치지 않는 것만, 최대 n 개.
 * fallbackSeed 는 화면이 주는 짧은 영문(예: 종류 「BOOK」)이다.
 */
export function suggestNames(title: string, taken: ReadonlySet<string>, opts: { fallback?: string; n?: number; prefix?: string } = {}): string[] {
  const prefix = opts.prefix ?? CREATOR_ASSET_PREFIX, n = opts.n ?? 3, out: string[] = [];
  const base = suggestCreatorAssetName(title, prefix);
  const seed = checkCreatorAssetName(base, prefix).valid ? base : suggestCreatorAssetName(opts.fallback ?? 'ITEM', prefix);
  const add = (s: string) => { if (out.length < n && !out.includes(s) && !taken.has(s) && checkCreatorAssetName(s, prefix).valid) out.push(s); };
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
 * 체인은 「정확히 같은 이름」만 막는다. 「PLAYXG.STAR_RUN」과 「PLAYXG.STARRUN」「PLAYXG.STAR_RUM」「PLAYXG.5TAR_RUN」은 전부 따로 발행된다.
 * 그래서 비슷한 이름을 경고한다(막지는 않는다 — 우연히 비슷할 수도 있다). 구매자 화면도 같은 함수로 「비슷한 이름 있음」을 붙인다.
 * 공식처럼 보이는 낱말(PLAYX·RAVENVAULT·OFFICIAL 등)은 제작자에게 경고하고, 구매자에게도 「공식 아님」을 보인다.
 */
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({ '0': 'O', '1': 'I', L: 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '9': 'G', '4': 'A', '7': 'T', '3': 'E' });
/** 비교용 뼈대: 접두어·점·밑줄을 빼고, 헷갈리는 글자를 하나로 모은다. */
export function nameSkeleton(asset: string, prefix: string = CREATOR_ASSET_PREFIX): string {
  const s = String(asset ?? '').toUpperCase();
  const tail = s.startsWith(prefix) ? s.slice(prefix.length) : s;
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
export const OFFICIAL_LOOKING = /PLAY_?X|RAVEN_?VAULT|RAVI_?STORY|OFFICIAL|VERIFIED|ADMIN|SUPPORT|레이븐볼트|플레이엑스|공식/i;

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
  const tail = String(asset ?? '').slice(prefix.length);
  const officialLooking = OFFICIAL_LOOKING.test(tail) || OFFICIAL_LOOKING.test(String(title ?? ''));
  const say: string[] = [];
  if (taken) say.push('이 이름은 이미 누가 쓰고 있어요. 다른 이름을 골라 주세요.');
  if (similar.length) say.push(`비슷한 이름이 있어요: ${similar.slice(0, 3).map(s => s.asset).join(', ')}. 다른 사람 작품으로 오해받을 수 있어요.`);
  if (officialLooking) say.push('「공식」처럼 보이는 낱말(PLAYX·레이븐볼트·OFFICIAL 등)이 들어 있어요. 레이븐볼트 공식 상품이 아니면 쓰지 마세요. 구매자에게는 「공식 아님」으로 보여요.');
  return { taken, similar, officialLooking, say };
}
