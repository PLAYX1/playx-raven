/**
 * 1:1 문의 — NIP-17 (봉투는 NIP-59).
 *
 * ## 왜 봉투를 세 겹이나 쓰나
 *
 * 릴레이는 **누가 누구에게 보냈는지**를 본다. 그냥 암호만 걸면 내용은
 * 안 보여도 "이 사람이 저 사람에게 오늘 12번 보냈다" 가 남는다. 동네 장터에서
 * 그건 내용만큼 말이 많은 정보다.
 *
 * 그래서 세 겹이다:
 *
 * 1. **속말(rumor, kind 14)** — 서명하지 않는다.
 *    🔴 일부러다. 서명이 없으면 받은 사람도 "이건 네가 쓴 것" 이라고 남에게
 *    증명할 수 없다. 대화가 나중에 증거로 쓰이지 않는다.
 * 2. **봉인(seal, kind 13)** — 속말을 내 열쇠로 잠그고 **내가 서명**한다.
 *    받은 사람만 열 수 있고, 열면 누가 썼는지 안다.
 * 3. **겉봉(gift wrap, kind 1059)** — 봉인을 **한 번 쓰고 버리는 열쇠**로
 *    잠그고 그 열쇠로 서명한다. 릴레이에는 그 임시 열쇠만 보인다 —
 *    보낸 사람이 누구인지 릴레이가 모른다.
 *
 * ## ⚠️ 시각도 흐린다
 *
 * 겉봉의 `created_at` 을 과거 이틀 사이로 무작위로 흩는다. 안 그러면 보낸
 * 시각이 그대로 남아, 두 사람이 같은 시각에 올린 겉봉 둘로 짝이 드러난다.
 *
 * ## 🔴 감사받지 않았다
 *
 * `nip44.ts` 와 같다. 원시함수는 `@noble` 것이고 여기서 하는 일은 정해진
 * 순서대로 부르는 것뿐이지만, 그래도 아무도 검사하지 않은 코드다.
 * **목숨이 걸린 말을 여기 적지 마시라**고 화면에 적어야 한다.
 */

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils";
import { conversationKey, encrypt, decrypt } from "./nip44";
import type { NostrEvent } from "./nostr";

export const KIND_RUMOR = 14;
export const KIND_SEAL = 13;
export const KIND_WRAP = 1059;

type Rumor = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
};

function idOf(pubkey: string, d: { created_at: number; kind: number; tags: string[][]; content: string }) {
  const ser = JSON.stringify([0, pubkey, d.created_at, d.kind, d.tags, d.content]);
  return bytesToHex(sha256(utf8ToBytes(ser)));
}

function sign(sec: Uint8Array, d: { created_at: number; kind: number; tags: string[][]; content: string }): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sec));
  const id = idOf(pubkey, d);
  return { ...d, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sec)) };
}

/**
 * 겉봉의 시각을 흐린다.
 *
 * 🔴 지금 시각을 그대로 쓰면 **두 사람이 같은 초에 올린 겉봉 둘**이 짝으로
 * 보인다. 릴레이가 보낸 이를 몰라도 시각으로 이어 붙일 수 있다.
 * 과거 이틀 사이로 흩는다 — 미래로 보내면 릴레이가 거절하는 곳이 있다.
 */
function fuzzyTime(): number {
  const now = Math.floor(Date.now() / 1000);
  const back = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * 172_800);
  return now - back;
}

/**
 * 한 사람에게 보낼 겉봉 하나를 만든다.
 *
 * ⚠️ **받는 사람 것과 내 것, 두 개를 만들어야 한다.** 내 것을 안 만들면
 * 내가 보낸 말을 내가 다시 못 읽는다 — 릴레이에는 상대만 열 수 있는 것이
 * 올라가기 때문이다.
 */
export function wrap(mySec: Uint8Array, toPubHex: string, forPubHex: string, text: string): NostrEvent {
  const myPub = bytesToHex(schnorr.getPublicKey(mySec));

  // ① 속말. **서명하지 않는다** — 서명이 없어야 나중에 증거가 되지 않는다.
  const rumor: Rumor = {
    pubkey: myPub,
    created_at: Math.floor(Date.now() / 1000),
    kind: KIND_RUMOR,
    tags: [["p", toPubHex]],
    content: text,
    id: "",
  };
  rumor.id = idOf(myPub, rumor);

  // ② 봉인. 내 열쇠로 잠그고 내가 서명한다. `forPubHex` 는 이 봉인을 열 사람 —
  //    상대에게 보낼 때는 상대, 내 사본은 나 자신이다.
  const seal = sign(mySec, {
    created_at: fuzzyTime(),
    kind: KIND_SEAL,
    tags: [],
    content: encrypt(JSON.stringify(rumor), conversationKey(mySec, forPubHex)),
  });

  // ③ 겉봉. **한 번 쓰고 버리는 열쇠**로 잠그고 그 열쇠로 서명한다.
  //    릴레이에는 이 임시 열쇠만 보이므로, 보낸 사람이 누구인지 모른다.
  const once = randomBytes(32);
  return sign(once, {
    created_at: fuzzyTime(),
    kind: KIND_WRAP,
    tags: [["p", forPubHex]],
    content: encrypt(JSON.stringify(seal), conversationKey(once, forPubHex)),
  });
}

/**
 * 겉봉을 연다. 못 열면 `null` — 남의 겉봉일 뿐이고 오류가 아니다.
 *
 * 🔴 릴레이는 나에게 온 겉봉 말고도 많이 준다. 못 여는 것마다 오류를 띄우면
 * 화면이 오류로 덮인다.
 */
export function unwrap(mySec: Uint8Array, gift: NostrEvent): Rumor | null {
  try {
    // ③ → ② : 겉봉의 임시 공개키로 연다.
    const sealJson = decrypt(gift.content, conversationKey(mySec, gift.pubkey));
    const seal = JSON.parse(sealJson) as NostrEvent;
    if (seal.kind !== KIND_SEAL) return null;

    // ⚠️ 봉인의 서명을 **확인한다.** 안 하면 아무나 "누구의 말" 이라고
    // 꾸며서 보낼 수 있다 — 겉봉은 임시 열쇠라 아무 보증이 안 된다.
    const wantId = idOf(seal.pubkey, seal);
    if (wantId !== seal.id) return null;
    if (!schnorr.verify(hexToBytes(seal.sig), hexToBytes(seal.id), hexToBytes(seal.pubkey))) {
      return null;
    }

    // ② → ① : 봉인한 사람의 열쇠로 연다.
    const rumor = JSON.parse(decrypt(seal.content, conversationKey(mySec, seal.pubkey))) as Rumor;
    if (rumor.kind !== KIND_RUMOR) return null;

    // 🔴 속말의 `pubkey` 와 봉인한 사람이 다르면 **남의 말을 자기 것처럼**
    // 꾸민 것이다. 버린다.
    if (rumor.pubkey !== seal.pubkey) return null;
    return rumor;
  } catch {
    return null;
  }
}

/** 이 지갑의 Nostr 공개키. 누가 썼는지를 나타내는 값이라 공개돼도 된다. */
export function pubOf(sec: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sec));
}
