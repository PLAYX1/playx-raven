/*
 * 제작자 콘텐츠 자산 이름·소각 비용.
 *
 * 🔴 접두어는 **임시**다(대표 결정 대기). 이 상수 한 곳만 바꾸면 된다.
 *    `PLAYXG/` 처럼 「/」로 끝나면 하위 자산(sub-asset)이다: 부모 `PLAYXG` 의 주인 표(`PLAYXG!`)를 가진 지갑만
 *    발행할 수 있고 소각액은 하위 기준(저장소 기재값 100 RVN)이다. 그래서 이 값 그대로면 「누구나 올리기」가 아니라
 *    「주인 표를 가진 쪽(우리)이 발행하거나 하위 발행 표를 나눠 주는」 방식(설계 §2.2 B)이 된다.
 *    `.` 로 끝나는 관례 접두어(예: `PLAYXG.`)면 루트 자산(500 RVN)이고 누구나 발행할 수 있다(설계 §2.2 A).
 *
 * 이름 규칙은 Ravencoin assets.cpp 의 정규식을 옮긴 것이다(저장소 데스크탑 issue.rs 주석 + 기억 — 이번에 원본을 다시
 * 대조하지 않았다 → 확인 필요). 소각액은 데스크탑 issue.rs·issue2.rs 상수(chainparams.cpp 인용)이며 노드에 묻는 RPC 가
 * 없어 **체인 파라미터와 대조할 수 없다** → 화면에는 「확인 불가」로 표시한다(burnCheck).
 */

export const CREATOR_ASSET_PREFIX = 'PLAYXG/';
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
  if (!(root ? ROOT_CHARS : SUB_CHARS).test(part)) p.push(root ? '앞 이름은 영문 대문자·숫자·점·밑줄로 3글자 이상이어야 해요.' : '이름에는 영문 대문자·숫자·점(.)·밑줄(_)만 쓸 수 있어요.');
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
  if (!tail) problems.push('게임·음악 이름을 적어 주세요.');
  if (kind === 'sub') {
    if (parent) problems.push(...partProblems(parent, true).map(p => '접두어: ' + p));
    if (tail.includes('/') || tail.includes('#')) problems.push('이름에 / 나 # 를 쓸 수 없어요.');
    else if (tail) problems.push(...partProblems(tail, false));
  } else if (typeof name === 'string') {
    if (name.includes('/') || name.includes('#')) problems.push('이름에 / 나 # 를 쓸 수 없어요.');
    else problems.push(...partProblems(name, true));
  }
  if (typeof name === 'string' && name.length > MAX_ASSET_NAME) problems.push(`전체 이름은 ${MAX_ASSET_NAME}자를 넘을 수 없어요(지금 ${name.length}자).`);
  return { valid: problems.length === 0, name: String(name ?? ''), kind, parent, ownerTokenNeeded: parent ? parent + '!' : null, burnRvn: BURN_RVN[kind], problems: [...new Set(problems)] };
}

/** 사람이 적은 이름(「My Game 2」) → 규칙에 맞춘 제안(「PLAYXG/MY_GAME_2」). 제안일 뿐 — 발행 전 사람이 확인한다. */
export function suggestCreatorAssetName(input: string, prefix: string = CREATOR_ASSET_PREFIX): string {
  const tail = String(input ?? '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9._]+/g, '_').replace(/[._]{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
  return (prefix + tail).slice(0, MAX_ASSET_NAME).replace(/[._]+$/, '');
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
