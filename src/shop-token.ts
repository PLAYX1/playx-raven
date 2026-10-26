/*
 * 가게 토큰 이름 — 「이 가게의 토큰 이름」 한 값과 새 가게 이름 규칙.
 *
 * 🔴 대표 확정(2026-10-11): **새 가게부터 `RV.S.<가게이름>`** 이다. 제작자 상품과 같은 `RV.<종류글자>.<이름>`
 *    규칙의 S(가게·Shop) 칸이다. 규칙(대문자·숫자·점·밑줄, 30자, 예약어 RVN·RAVEN·RAVENCOIN, 종류 글자)은
 *    `core/creator/asset-name.ts` 의 상수를 그대로 쓴다 — 접두어·길이·예약어를 여기서 다시 적지 않는다.
 *
 * 🔴 옛 가게(`SHOP.<이름>`, 예: 체인에 이미 발행된 `SHOP.PLAYX`)는 **이름을 못 바꾼다**(체인 자산 이름은 영구).
 *    그래서 읽기·보유·손님에게 나눠 주기는 두 모양을 모두 받는다. 새로 **만드는** 것만 `RV.S.` 다.
 *
 * 🔴 가정(코드에 명시): **이 컴퓨터는 가게 하나**다. `shop.json` 의 `chain_asset` 한 칸이 「이 가게의 토큰 이름」이고,
 *    화면은 하드코딩 이름 대신 그 값을 읽는다(`shopTokenOf`). 지갑에 가게 주인 표가 여럿(옛 SHOP.X! 와 새 RV.S.Y!)
 *    있으면 우리가 고르지 않는다 — 데스크탑 `shop_detect_asset` 이 후보만 돌려주고 칸을 비워 둔다.
 *    Rust 쪽 같은 규칙: src-tauri/src/shop.rs `SHOP_PREFIX`·`LEGACY_SHOP_PREFIX`·`shop_name_problems`.
 */
import { CREATOR_ASSET_PREFIX, MAX_ASSET_NAME, RESERVED_WORDS } from "../core/creator/asset-name";
import { romanPieces } from "./easy-create";

/** 가게 종류 글자. 제작자 표(M·G·B·T·X)와 겹치지 않는다. */
export const SHOP_KIND_LETTER = "S";
/** 새 가게 이름 앞부분 — `RV.S.` */
export const SHOP_PREFIX = `${CREATOR_ASSET_PREFIX}${SHOP_KIND_LETTER}.`;
/** 옛 가게 이름 앞부분 — 읽기 호환 전용. 새로 만들지 않는다. */
export const LEGACY_SHOP_PREFIX = "SHOP.";
/** 가게 목록 검색 패턴(listassets). 새 것 먼저, 옛 것도 같이. */
export const SHOP_SEARCH_PATTERNS: readonly string[] = Object.freeze([`${SHOP_PREFIX}*`, `${LEGACY_SHOP_PREFIX}*`]);

export type ShopNameStyle = "rv" | "legacy";

/** 가게 자산 이름이면 어느 모양인지(새 `RV.S.` / 옛 `SHOP.`), 아니면 null. 주인 표(`!`)·하위(`/`)·유니크(`#`)는 가게 자체가 아니다. */
export function shopNameStyle(name: unknown): ShopNameStyle | null {
  if (typeof name !== "string") return null;
  const n = name.trim().toUpperCase();
  if (/[!/#$~\s]/.test(n)) return null;
  if (n.startsWith(SHOP_PREFIX) && n.length > SHOP_PREFIX.length) return "rv";
  if (n.startsWith(LEGACY_SHOP_PREFIX) && n.length > LEGACY_SHOP_PREFIX.length) return "legacy";
  return null;
}

export const isShopToken = (name: unknown): boolean => shopNameStyle(name) !== null;

/** 간판용 짧은 이름 — 앞부분(`RV.S.`·`SHOP.`)만 뗀다. 가게 이름이 아니면 그대로. */
export function shopLabel(name: string): string {
  const s = String(name ?? "").trim();
  const u = s.toUpperCase();
  if (u.startsWith(SHOP_PREFIX)) return s.slice(SHOP_PREFIX.length);
  if (u.startsWith(LEGACY_SHOP_PREFIX)) return s.slice(LEGACY_SHOP_PREFIX.length);
  return s;
}

/**
 * 「이 가게의 토큰 이름」 한 값. `shop.json`(shop_load)의 `chain_asset` 이 근거다 — 발행 거래가 성공했거나
 * 지갑의 주인 표로 확인된 뒤에만 채워진다. 보통은 `RV.S.…`(새)·`SHOP.…`(옛)이지만, 사장이 이미 다른 이름(예: 하위
 * 자산 `HOMEFIT/SHOP`)을 가게 이름으로 저장해 두었으면 그 값을 그대로 존중한다 — 이름을 바꿔 읽지 않는다.
 * 자산 이름 모양이 아니거나(주인 표 `!`·유니크 `#`·빈 값) 30자를 넘으면 null(모르는 것을 지어내지 않는다).
 */
export function shopTokenOf(saved: unknown): string | null {
  const raw = saved && typeof saved === "object" ? (saved as { chain_asset?: unknown }).chain_asset : null;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return /^[A-Z0-9._/]{3,30}$/.test(name) ? name : null;
}

/**
 * 사장이 적은 이름(「강남 카페」·「Gangnam Cafe」·「gangnam_cafe」) → 새 가게 이름 제안 `RV.S.GANGNAM_CAFE`.
 * 한글은 easy-create 의 romanPieces(폰과 같은 로마자 표)를 낱말마다 붙여 쓴다. 이미 `RV.S.`·`SHOP.` 을 적었으면 떼고
 * 다시 붙인다 — 새 가게는 옛 `SHOP.` 으로 만들지 않는다. 30자를 넘으면 자른다. 제안일 뿐 — 발행 전 사람이 확인한다.
 */
export function suggestShopAssetName(input: string): string {
  let s = String(input ?? "").trim();
  for (;;) {
    const u = s.toUpperCase();
    if (u.startsWith(SHOP_PREFIX)) s = s.slice(SHOP_PREFIX.length);
    else if (u.startsWith(LEGACY_SHOP_PREFIX)) s = s.slice(LEGACY_SHOP_PREFIX.length);
    else break;
  }
  const words = s.split(/[\s_\-]+/).filter(Boolean).map(w => (/[가-힣]/.test(w) ? romanPieces(w).join("") : w));
  const tail = words.join("_").normalize("NFKD").toUpperCase()
    .replace(/[^A-Z0-9._]+/g, "_").replace(/[._]{2,}/g, "_").replace(/^[._]+|[._]+$/g, "");
  if (!tail) return "";
  return (SHOP_PREFIX + tail).slice(0, MAX_ASSET_NAME).replace(/[._]+$/, "");
}

/** 이름 검사 문구(한국어 원문 = 번역 열쇠). 숫자가 바뀌면 desktop-copy.ts 열쇠도 같이 바꾼다. */
export const SHOP_NAME_SAY = Object.freeze({
  empty: "가게 이름을 영문으로 적어 주세요.",
  prefix: "새 가게 이름은 RV.S. 로 시작합니다. 다른 종류 글자(RV.M. 등)나 옛 SHOP. 으로는 만들 수 없어요.",
  chars: "가게 이름에는 영문 대문자·숫자·점(.)·밑줄(_)만 쓸 수 있어요.",
  punct: "점·밑줄을 두 번 이어 쓰거나, 점·밑줄로 시작하거나 끝날 수 없어요.",
  reserved: "RVN·RAVEN·RAVENCOIN 은 가게 이름에 쓸 수 없어요.",
  long: "전체 이름은 30자를 넘을 수 없어요.",
});

export type ShopNameCheck = { valid: boolean; name: string; work: string; problems: string[] };

/**
 * 새 가게 전체 이름(`RV.S.<이름>`)을 검사한다. 제작자 상품 규칙(core/creator/asset-name.ts checkCreatorAssetName)과 같은
 * 기준: 영문 대문자·숫자·점·밑줄, 점·밑줄 연속·앞뒤 금지, 예약어는 점으로 나뉜 어느 칸이든 거절, 전체 30자.
 * 종류 글자는 S 여야 한다(RV.M.… 을 가게로 내면 음악 칸에 가게가 앉는다 — 사칭 방지).
 */
export function checkShopAssetName(name: string): ShopNameCheck {
  const full = typeof name === "string" ? name : "";
  const problems: string[] = [];
  const work = full.startsWith(SHOP_PREFIX) ? full.slice(SHOP_PREFIX.length) : "";
  if (!full.startsWith(SHOP_PREFIX)) problems.push(SHOP_NAME_SAY.prefix);
  else if (!work) problems.push(SHOP_NAME_SAY.empty);
  if (work) {
    if (!/^[A-Z0-9._]+$/.test(work)) problems.push(SHOP_NAME_SAY.chars);
    if (/[._]{2,}/.test(work) || /^[._]/.test(work) || /[._]$/.test(work)) problems.push(SHOP_NAME_SAY.punct);
    if (work.split(".").some(seg => RESERVED_WORDS.includes(seg))) problems.push(SHOP_NAME_SAY.reserved);
  }
  if (full.length > MAX_ASSET_NAME) problems.push(SHOP_NAME_SAY.long);
  return { valid: problems.length === 0, name: full, work, problems: [...new Set(problems)] };
}
