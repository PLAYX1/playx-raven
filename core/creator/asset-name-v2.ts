import { sha256 } from '@noble/hashes/sha256';
import { hex } from './bytes';

/*
 * 새 체인 자산 이름 규칙 — 🔶 **잠정**(결정문 §31, 23라운드). 시험망 확인(docs/testnet/CHECKLIST.md 「새 체인 자산 이름 v2」 절) 전에는
 * 확정·운영 금지. 이 파일은 이름을 만들고·읽고·검사할 뿐이며 발행하지 않는다(발행 계획 = publish-route.ts, 시험망 플래그 뒤).
 *
 *   RVLT/S<판매자 키 해시 10자>#<문서 해시 10자>      예: RVLT/S1A2B3C4D5E#0F9E8D7C6B
 *   · 문자 0-9A-F(대문자 16진수)만. 수량 1(고유 자산). 종류(티켓·멤버십…)는 이름이 아니라 서명 문서에 있다.
 *   · 판매자 키 해시 = SHA-256(판매자 압축 공개키 33바이트) 앞 10자. 문서 해시 = 상품 문서 해시(64 hex) 앞 10자.
 *
 * 🔴 이름은 **표시 힌트일 뿐 신원 증명이 아니다.** 10자(40비트)는 찾아 맞출 수 있는 길이이고, 누구든 같은 모양의 이름을 만들 수 있다.
 *    발행자 확인은 오직 서명 문서(판매자 공개키·서명)로 한다. 이름에서 키나 서명을 되살릴 방법은 없다(parse 결과에 키·서명 칸 없음).
 *    nameMatchesV2 는 「이 이름이 이 키·이 문서와 모양이 맞는가」만 본다 — 키 자체는 서명 문서로 이미 확인한 것이어야 한다.
 */

/** 잠정 상수 한 곳. 🔶 전부 시험망 확인 필요(레이븐코인 실제 이름 길이·문자·`/`·`#` 규칙을 원본과 대조하지 않았다). */
export const ASSET_NAME_V2 = Object.freeze({
  /** 루트(상위) 자산 이름. 🔶 시험망 확인 필요 — 소유·발행 주체(판매자 하위 소유권 이전 가능 여부) 미확정. */
  root: 'RVLT',
  /** 판매자 칸 머리 글자. */
  sellerTag: 'S',
  sellerHashLen: 10,
  docHashLen: 10,
  /** 고유 자산 전체 이름 최대 길이. 🔶 시험망 확인 필요(기존 저장소 기재: root/sub 30자, unique 31자 — core/wallet-offline/asset-name.ts). */
  maxTotalLen: 31,
  /** 고유 자산 수량. 🔶 시험망 확인 필요(issueunique 가 수량 1·소수 0 고정인지). */
  qty: 1,
});

const HEX_UP = /^[0-9A-F]+$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const DOC_HASH = /^[0-9a-f]{64}$/;

const bytesOfHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));

/** 판매자 압축 공개키(66 hex 소문자) → 이름 칸 10자. 키 모양이 아니면 null. */
export function sellerNameTag(sellerPubKeyHex: string): string | null {
  if (typeof sellerPubKeyHex !== 'string' || !PUBKEY.test(sellerPubKeyHex)) return null;
  return hex(sha256(bytesOfHex(sellerPubKeyHex))).slice(0, ASSET_NAME_V2.sellerHashLen).toUpperCase();
}
/** 문서 해시(64 hex 소문자) → 이름 칸 10자. 모양이 아니면 null. */
export function docNameTag(docHashHex: string): string | null {
  if (typeof docHashHex !== 'string' || !DOC_HASH.test(docHashHex)) return null;
  return docHashHex.slice(0, ASSET_NAME_V2.docHashLen).toUpperCase();
}

/** 이름 만들기. 키·문서 해시 모양이 아니면 null. */
export function makeAssetNameV2(p: { sellerPubKeyHex: string; docHashHex: string }): string | null {
  const s = sellerNameTag(p.sellerPubKeyHex), d = docNameTag(p.docHashHex);
  if (s === null || d === null) return null;
  return `${ASSET_NAME_V2.root}/${ASSET_NAME_V2.sellerTag}${s}#${d}`;
}

export type AssetNameV2 = Readonly<{
  name: string;
  /** 판매자 하위 자산(고유 자산의 부모). 발행하려면 그 주인 표(ownerToken)가 판매자 지갑에 있어야 한다. */
  parent: string;
  ownerToken: string;
  sellerHash: string;
  docHash: string;
  /** 항상 true: 표시 힌트. */
  displayHintOnly: true;
  /** 항상 false: 이름은 신원 증명이 아니다. */
  identityProof: false;
}>;

export type AssetNameV2Check = { valid: boolean; problems: string[]; parsed: AssetNameV2 | null };

/** 엄격 검사. 문제 목록(한국어)과, 맞으면 해석 결과. */
export function checkAssetNameV2(name: unknown): AssetNameV2Check {
  const problems: string[] = [];
  const C = ASSET_NAME_V2;
  if (typeof name !== 'string') return { valid: false, problems: ['이름이 없어요.'], parsed: null };
  if (name.length > C.maxTotalLen) problems.push(`전체 이름은 ${C.maxTotalLen}자를 넘을 수 없어요(잠정 한도, 지금 ${name.length}자).`);
  const head = `${C.root}/${C.sellerTag}`;
  if (!name.startsWith(head)) problems.push(`이름은 「${head}<판매자 10자>#<문서 10자>」 모양이어야 해요.`);
  else {
    const rest = name.slice(head.length);
    const parts = rest.split('#');
    if (parts.length !== 2) problems.push('# 는 정확히 한 번 있어야 해요.');
    else {
      const [s, d] = parts;
      if (s.length !== C.sellerHashLen || !HEX_UP.test(s)) problems.push(`판매자 칸은 0-9A-F ${C.sellerHashLen}자여야 해요.`);
      if (d.length !== C.docHashLen || !HEX_UP.test(d)) problems.push(`문서 칸은 0-9A-F ${C.docHashLen}자여야 해요.`);
    }
    if ((name.match(/\//g) ?? []).length !== 1) problems.push('/ 는 정확히 한 번 있어야 해요.');
  }
  if (problems.length) return { valid: false, problems: [...new Set(problems)], parsed: null };
  const parent = name.slice(0, name.indexOf('#'));
  const parsed: AssetNameV2 = Object.freeze({
    name, parent, ownerToken: parent + '!', sellerHash: parent.slice(head.length), docHash: name.slice(name.indexOf('#') + 1),
    displayHintOnly: true, identityProof: false,
  } as const);
  return { valid: true, problems: [], parsed };
}
/** 맞으면 해석 결과, 아니면 null. */
export const parseAssetNameV2 = (name: unknown): AssetNameV2 | null => checkAssetNameV2(name).parsed;

export type NameMatch = { matches: boolean; seller: boolean; doc: boolean; say: string };
/**
 * 이름이 (이미 서명으로 확인한) 판매자 키·문서 해시와 모양이 맞는지. 맞아도 신원 증명이 아니다 —
 * 판매자 키는 반드시 서명 문서 검증(verifyProductDoc 등)에서 온 값이어야 하고, 이 함수는 그 키를 증명하지 않는다.
 */
export function nameMatchesV2(name: string, p: { sellerPubKeyHex: string; docHashHex: string }): NameMatch {
  const parsed = parseAssetNameV2(name);
  const s = sellerNameTag(p.sellerPubKeyHex), d = docNameTag(p.docHashHex);
  const seller = !!parsed && s !== null && parsed.sellerHash === s;
  const doc = !!parsed && d !== null && parsed.docHash === d;
  const matches = seller && doc;
  return { matches, seller, doc,
    say: matches ? '이름 모양이 판매자 키·문서와 맞아요(이름은 표시용이에요 — 판매자 확인은 서명으로 해요).'
      : !parsed ? '새 이름 규칙 모양이 아니에요.' : !seller ? '이름의 판매자 칸이 이 문서의 판매자 키와 달라요.' : '이름의 문서 칸이 이 문서와 달라요.' };
}
