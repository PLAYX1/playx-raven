import { BURN_RVN, RESERVED_WORDS, checkCreatorAssetName, parseCreatorAssetName } from './asset-name';
import { parseAssetNameV2 } from './asset-name-v2';

/*
 * 체인 자산 이름 v3 — 가게·상품 이름. (대표 결정 2026-11-03, 오락실 1단계 C 묶음)
 *
 *   RVLT/<가게>                가게(하위 자산). 주인 표 RVLT! 가 있어야 발행된다.            소각 100 RVN
 *   RVLT/<가게>/<상품>          상품(하위 자산의 하위). 주인 표 RVLT/<가게>! 가 있어야 한다.   소각 100 RVN
 *   RVLT/<가게>#<이름·번호>      고유 자산(상품 하나·티켓 한 장). 주인 표 RVLT/<가게>! 필요.    소각 5 RVN, 수량 1, IPFS 해시를 싣는다
 *
 *   · 가게 + 상품(또는 # 뒤 꼬리표) 글자 수 합 ≤ 24 (대표 결정). 「RVLT/」 5 + 「/」 1 + 24 = 30 = 하위 자산 이름 한도.
 *   · 글자 규칙은 레이븐코인 assets.cpp 정규식을 옮긴 것이다(기존 asset-name.ts 와 같은 출처 — 원본 재대조 안 함, 🔶 시험망 확인 필요):
 *       가게·상품 칸(SUB_NAME_CHARACTERS) = ^[A-Z0-9._]+$ , 점·밑줄 두 번 잇기·앞뒤에 두기 금지
 *       # 뒤 꼬리표(UNIQUE_TAG_CHARACTERS) = ^[-A-Za-z0-9@$%&*()[\]{}_.?:]+$  (소문자·일부 기호 허용 — 체인 규칙 그대로 받는다)
 *       전체 길이: 하위 자산 ≤ 30(주인 표 「!」 한 칸 몫을 남긴 값), 고유 자산 ≤ 31 — 기존 저장소 기재값(asset-name.ts MAX_ASSET_NAME, asset-name-v2.ts).
 *   · 「제안」 함수는 꼬리표를 대문자·숫자·밑줄·빼기로만 만든다(눈으로 헷갈리는 기호를 피한다). 검사는 체인 규칙 전체를 받는다.
 *
 * 옛 이름(읽기 전용): v1 `RV.<종류글자>.<작품>`(asset-name.ts), v2 `RVLT/S<10 hex>#<10 hex>`(asset-name-v2.ts, 잠정·운영 안 함).
 *   v2 모양과 v3 고유 자산 모양이 겹치므로 v3 은 가게 이름 「S + 16진수 10자」를 받지 않는다 → 두 규칙이 한 이름을 두고 다투지 않는다.
 *   parseAnyAssetName 은 v2 → v3 → v1 순서로 읽고, v1·v2 는 readOnly: true(새로 만들지 않는다).
 *
 * 사람이 적은 이름 → 이름 칸(normalizeNamePart): 한글은 **뜻으로 번역하지 않는다.** 이미 영문이면 대문자·밑줄로 다듬어 value 로 주고,
 *   한글이 섞여 있으면 value 는 null 이고, 소리대로 옮긴 영문(로마자 표기, 뜻 번역 아님)을 suggestion 으로만 준다 — 사람이 확인해서 고른다.
 *
 * 🔴 이름은 표시 힌트일 뿐 신원 증명이 아니다. 판매자 확인은 서명된 상품 문서로 한다(arcade-product.ts · arcade-catalog.ts).
 * 이 파일은 이름을 만들고·읽고·검사할 뿐 발행하지 않는다.
 */

export const ASSET_NAME_V3 = Object.freeze({
  root: 'RVLT',
  /** 가게 + 상품(또는 꼬리표) 글자 수 합 상한(대표 결정 2026-11-03). */
  maxShopPlusItem: 24,
  /** 하위 자산 전체 이름 상한(주인 표 「!」 몫을 남김). 🔶 시험망 확인 필요. */
  maxSubTotal: 30,
  /** 고유 자산 전체 이름 상한. 🔶 시험망 확인 필요. */
  maxUniqueTotal: 31,
  /** 체인 목록 검색 패턴(listassets). */
  searchPattern: 'RVLT/*',
});

export type AssetNameV3Kind = 'shop' | 'product' | 'unique';
export type AssetNameV3 = Readonly<{
  name: string; kind: AssetNameV3Kind; shop: string;
  /** kind 'product' 일 때만. */ product: string | null;
  /** kind 'unique' 일 때만(# 뒤). */ tag: string | null;
  /** 이 이름을 발행하려면 지갑에 있어야 하는 주인 표. */ ownerTokenNeeded: string;
  /** 발행 소각액(RVN, 저장소 기재값 — asset-name.ts BURN_RVN). */ burnRvn: number;
  /** 고유 자산만 수량 1. 나머지는 발행하는 사람이 정한다(null). */ qty: 1 | null;
}>;
export type AssetNameV3Check = { valid: boolean; problems: string[]; parsed: AssetNameV3 | null };

const SUB_CHARS = /^[A-Z0-9._]+$/;
const UNIQUE_TAG_CHARS = /^[-A-Za-z0-9@$%&*()[\]{}_.?:]+$/;
const DOUBLE_PUNCT = /[._]{2,}/;
/** v2 판매자 칸 모양 — v3 가게 이름으로 받지 않는다(옛 v2 이름과 겹침 방지). */
const V2_SELLER_SHOP = /^S[0-9A-F]{10}$/;

/** 가게·상품 칸 하나의 문제(한국어). */
function subPartProblems(part: string, label: string): string[] {
  const p: string[] = [];
  if (!part) { p.push(`${label} 이름을 적어 주세요.`); return p; }
  if (!SUB_CHARS.test(part)) p.push(`${label} 이름에는 영문 대문자·숫자·점(.)·밑줄(_)만 쓸 수 있어요.`);
  if (DOUBLE_PUNCT.test(part)) p.push(`${label} 이름에 점·밑줄을 두 번 이어 쓸 수 없어요.`);
  if (/^[._]/.test(part) || /[._]$/.test(part)) p.push(`${label} 이름은 점·밑줄로 시작하거나 끝날 수 없어요.`);
  if (part.split('.').some(seg => RESERVED_WORDS.includes(seg))) p.push(`${label} 이름에 ${RESERVED_WORDS.join('·')} 은 쓸 수 없어요.`);
  return p;
}
function tagProblems(tag: string): string[] {
  if (!tag) return ['# 뒤 이름(번호)을 적어 주세요.'];
  return UNIQUE_TAG_CHARS.test(tag) ? [] : ['# 뒤에는 영문·숫자와 - @ $ % & * ( ) [ ] { } _ . ? : 만 쓸 수 있어요.'];
}
function shopProblems(shop: string): string[] {
  const p = subPartProblems(shop, '가게');
  if (V2_SELLER_SHOP.test(shop)) p.push('가게 이름이 옛 이름 규칙(S + 16진수 10자)과 겹쳐요. 다른 이름을 골라 주세요.');
  return p;
}

/** 엄격 검사. 문제 목록(한국어)과, 맞으면 해석 결과. */
export function checkAssetNameV3(name: unknown): AssetNameV3Check {
  const C = ASSET_NAME_V3;
  if (typeof name !== 'string' || !name) return { valid: false, problems: ['이름이 없어요.'], parsed: null };
  const head = C.root + '/';
  if (!name.startsWith(head)) return { valid: false, problems: [`이름은 「${head}<가게>」로 시작해야 해요.`], parsed: null };
  const rest = name.slice(head.length);
  const problems: string[] = [];
  let parsed: AssetNameV3 | null = null;
  const hashes = (rest.match(/#/g) ?? []).length;
  if (rest.includes('!') || rest.includes('$') && hashes === 0 || rest.includes('~')) problems.push('이름에 ! $ ~ 는 쓸 수 없어요(주인 표·제한 자산 표시예요).');
  if (hashes > 1) problems.push('# 는 한 번만 쓸 수 있어요.');
  else if (hashes === 1) {
    const at = rest.indexOf('#');
    const shop = rest.slice(0, at), tag = rest.slice(at + 1);
    if (shop.includes('/')) problems.push('고유 자산은 「RVLT/<가게>#<이름>」 모양이어야 해요(가게 아래 상품 칸 없이).');
    else {
      problems.push(...shopProblems(shop), ...tagProblems(tag));
      if (shop.length + tag.length > C.maxShopPlusItem) problems.push(`가게와 # 뒤 이름은 합쳐서 ${C.maxShopPlusItem}자까지예요(지금 ${shop.length + tag.length}자).`);
      if (name.length > C.maxUniqueTotal) problems.push(`전체 이름은 ${C.maxUniqueTotal}자를 넘을 수 없어요(지금 ${name.length}자).`);
      parsed = Object.freeze({ name, kind: 'unique', shop, product: null, tag, ownerTokenNeeded: `${head}${shop}!`, burnRvn: BURN_RVN.unique, qty: 1 } as const);
    }
  } else {
    const parts = rest.split('/');
    if (parts.length > 2) problems.push('가게 아래에는 상품 한 칸만 둘 수 있어요(RVLT/<가게>/<상품>).');
    else {
      const [shop, product] = parts;
      problems.push(...shopProblems(shop));
      if (product !== undefined) {
        problems.push(...subPartProblems(product, '상품'));
        if (shop.length + product.length > C.maxShopPlusItem) problems.push(`가게와 상품 이름은 합쳐서 ${C.maxShopPlusItem}자까지예요(지금 ${shop.length + product.length}자).`);
        parsed = Object.freeze({ name, kind: 'product', shop, product, tag: null, ownerTokenNeeded: `${head}${shop}!`, burnRvn: BURN_RVN.sub, qty: null } as const);
      } else {
        parsed = Object.freeze({ name, kind: 'shop', shop, product: null, tag: null, ownerTokenNeeded: `${C.root}!`, burnRvn: BURN_RVN.sub, qty: null } as const);
      }
      if (name.length > C.maxSubTotal) problems.push(`전체 이름은 ${C.maxSubTotal}자를 넘을 수 없어요(지금 ${name.length}자).`);
    }
  }
  if (problems.length) return { valid: false, problems: [...new Set(problems)], parsed: null };
  return { valid: true, problems: [], parsed };
}
export const parseAssetNameV3 = (name: unknown): AssetNameV3 | null => checkAssetNameV3(name).parsed;

export type BuiltName = { ok: boolean; name: string | null; problems: string[] };
const built = (name: string): BuiltName => { const c = checkAssetNameV3(name); return { ok: c.valid, name: c.valid ? name : null, problems: c.problems }; };
/** RVLT/<가게>. 입력은 이미 이름 칸 모양이어야 한다(사람 입력은 normalizeNamePart 먼저). */
export const buildShopName = (shop: string): BuiltName => built(`${ASSET_NAME_V3.root}/${shop}`);
/** RVLT/<가게>/<상품>. */
export const buildProductName = (shop: string, product: string): BuiltName => built(`${ASSET_NAME_V3.root}/${shop}/${product}`);
/** RVLT/<가게>#<꼬리표>. */
export const buildUniqueName = (shop: string, tag: string): BuiltName => built(`${ASSET_NAME_V3.root}/${shop}#${tag}`);

/* ── 사람 입력 → 이름 칸 ─────────────────────────────────────────────── */

// 한글 음절 → 로마자(국어의 로마자 표기법, 음절 단위 — 이웃 음절의 소리 바뀜은 반영하지 않는다). 뜻 번역이 아니라 소리 옮기기.
const RR_INITIAL = ['G', 'KK', 'N', 'D', 'TT', 'R', 'M', 'B', 'PP', 'S', 'SS', '', 'J', 'JJ', 'CH', 'K', 'T', 'P', 'H'];
const RR_MEDIAL = ['A', 'AE', 'YA', 'YAE', 'EO', 'E', 'YEO', 'YE', 'O', 'WA', 'WAE', 'OE', 'YO', 'U', 'WO', 'WE', 'WI', 'YU', 'EU', 'UI', 'I'];
const RR_FINAL = ['', 'K', 'K', 'K', 'N', 'N', 'N', 'T', 'L', 'K', 'M', 'L', 'L', 'L', 'P', 'L', 'M', 'P', 'P', 'T', 'T', 'NG', 'T', 'T', 'K', 'T', 'P', 'T'];
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
/** 한글 음절을 소리대로 영문 대문자로 옮긴다(낱자모 ㄱ·ㅏ 처럼 음절이 아닌 글자는 지운다). 확인용 제안에만 쓴다. */
export function romanizeHangul(text: string): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) {
      const s = c - 0xac00;
      out += RR_INITIAL[Math.floor(s / 588)] + RR_MEDIAL[Math.floor((s % 588) / 28)] + RR_FINAL[s % 28];
    } else if (HANGUL.test(ch)) out += ' ';
    else out += ch;
  }
  return out;
}

export type NamePartRole = 'shop' | 'product' | 'tag';
export type NormalizedPart = {
  /** 바로 쓸 수 있는 이름 칸. 한글이 섞였거나 고칠 수 없으면 null — 조용히 바꾸지 않는다. */
  value: string | null;
  /** 사람이 확인하고 고를 제안(소리대로 옮긴 영문 등). 없으면 null. */
  suggestion: string | null;
  /** 제안이 한글을 소리대로 옮긴 것인가(뜻 번역이 아님을 화면이 알린다). */
  romanized: boolean;
  problems: string[];
};
const slug = (s: string, role: NamePartRole): string => {
  const up = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return role === 'tag'
    ? up.replace(/[^A-Z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '')
    : up.replace(/[^A-Z0-9._]+/g, '_').replace(/[._]{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
};
const partValid = (v: string, role: NamePartRole): string[] => role === 'tag' ? tagProblems(v) : role === 'shop' ? shopProblems(v) : subPartProblems(v, '상품');
const clip = (v: string, max: number, role: NamePartRole) => { const c = v.slice(0, max); return role === 'tag' ? c.replace(/[_-]+$/, '') : c.replace(/[._]+$/, ''); };

/**
 * 사람이 적은 가게·상품·꼬리표 이름 → 이름 칸. maxLen 을 주면(예: 24 − 가게 길이) 그 길이도 본다.
 * · 영문·숫자·빈칸만: 대문자·밑줄로 다듬어 value(빈칸 → 밑줄은 바꿨다고 problems 에 적지 않는다 — 뜻이 그대로다).
 * · 한글이 섞임: value = null, suggestion = 소리대로 옮긴 영문(romanized: true), problems 에 「직접 확인」 안내.
 */
export function normalizeNamePart(input: string, role: NamePartRole, opts: { maxLen?: number } = {}): NormalizedPart {
  const raw = String(input ?? '').trim();
  const max = opts.maxLen ?? ASSET_NAME_V3.maxShopPlusItem;
  const label = role === 'shop' ? '가게' : role === 'product' ? '상품' : '# 뒤';
  if (!raw) return { value: null, suggestion: null, romanized: false, problems: [`${label} 이름을 적어 주세요.`] };
  if (HANGUL.test(raw)) {
    const s = clip(slug(romanizeHangul(raw), role), max, role);
    const ok = s && partValid(s, role).length === 0;
    return { value: null, suggestion: ok ? s : null, romanized: !!ok,
      problems: [`체인 자산 이름에는 한글을 쓸 수 없어요. ${ok ? `소리대로 옮긴 「${s}」를 제안해요(뜻 번역이 아니에요) — 맞는지 보고 고르거나 영문으로 직접 적어 주세요.` : '영문으로 직접 적어 주세요.'}`] };
  }
  const v = slug(raw, role);
  if (!v) return { value: null, suggestion: null, romanized: false, problems: [`${label} 이름에 쓸 수 있는 글자(영문·숫자)가 없어요.`] };
  if (v.length > max) {
    const s = clip(v, max, role);
    return { value: null, suggestion: s && partValid(s, role).length === 0 ? s : null, romanized: false, problems: [`${label} 이름이 너무 길어요(${max}자까지, 지금 ${v.length}자).`] };
  }
  const p = partValid(v, role);
  return p.length ? { value: null, suggestion: null, romanized: false, problems: p } : { value: v, suggestion: null, romanized: false, problems: [] };
}

/* ── 옛 이름까지 읽기 ─────────────────────────────────────────────── */

export type AnyAssetName =
  | { version: 3; readOnly: false; name: string; v3: AssetNameV3 }
  | { version: 2; readOnly: true; name: string; sellerHash: string; docHash: string }
  | { version: 1; readOnly: true; name: string; kindLetter: string; work: string };

/** 아는 규칙으로 이름을 읽는다(v2 → v3 → v1). v1·v2 는 읽기만 한다. 어느 규칙에도 맞지 않으면 null. */
export function parseAnyAssetName(name: unknown): AnyAssetName | null {
  if (typeof name !== 'string') return null;
  const v2 = parseAssetNameV2(name);
  if (v2) return { version: 2, readOnly: true, name, sellerHash: v2.sellerHash, docHash: v2.docHash };
  const v3 = parseAssetNameV3(name);
  if (v3) return { version: 3, readOnly: false, name, v3 };
  if (checkCreatorAssetName(name).valid) {
    const p = parseCreatorAssetName(name)!;
    return { version: 1, readOnly: true, name, kindLetter: p.kindLetter, work: p.work };
  }
  return null;
}
