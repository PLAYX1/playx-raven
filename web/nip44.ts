/**
 * 1:1 문의를 남이 못 읽게 잠근다 — NIP-44 v2.
 *
 * ## 왜 필요한가
 *
 * 지금 물건 상세에는 **전화번호**뿐이다. 그건 통하지만, 번호가 공개 릴레이에
 * 올라간다 — 봇도 읽고, 지워도 회수되지 않는다. 개인이 자전거 한 대 파는데
 * 번호를 전 세계에 거는 것은 큰 값이다.
 *
 * 그래서 번호 없이 말을 걸 길이 필요하다. 그게 이것이다.
 *
 * ## 🔴 직접 만들었다는 것의 뜻
 *
 * 암호를 직접 쓰는 것은 보통 나쁜 생각이다. 여기서 그렇게 한 이유는 이
 * 페이지의 조건 때문이다 — 지갑 화면은 의존성이 적어야 하고(손님 폰·가게
 * 와이파이), 이미 `@noble/*` 를 쓰고 있다. **암호 원시함수는 직접 만들지
 * 않았다.** ChaCha20·HKDF·HMAC·secp256k1 은 전부 `@noble` 것이고, 여기서
 * 하는 일은 NIP-44 가 정한 **순서대로 부르는 것**뿐이다.
 *
 * ⚠️ 그래도 이건 감사받지 않은 코드다. 목숨이 걸린 말을 여기 적지 마시라고
 * 화면에 적어야 한다.
 *
 * ## NIP-44 v2 가 정한 순서
 *
 * 1. ECDH — 내 개인키 × 상대 공개키 → 공유점. **x좌표만** 쓴다.
 * 2. HKDF-extract(salt: "nip44-v2") → 대화용 열쇠
 * 3. 임의 nonce 32바이트 → HKDF-expand → chacha 열쇠 32 + nonce 12 + hmac 열쇠 32
 * 4. 길이를 숨기려고 **패딩**한다(32의 배수로 올림). 안 하면 "네"와
 *    "안 됩니다"의 길이 차이로 내용이 새어 나간다.
 * 5. ChaCha20 으로 잠그고, HMAC 으로 봉인한다.
 * 6. `0x02 | nonce | 암호문 | mac` 을 base64.
 *
 * 🔴 MAC 은 **nonce 를 AAD 로** 넣고 계산한다. 빠뜨리면 nonce 를 바꿔치기
 * 해도 봉인이 통과한다.
 */

import { chacha20 } from "@noble/ciphers/chacha.js";
import { extract, expand } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils";

const VERSION = 2;
const SALT = utf8ToBytes("nip44-v2");

/** 이 사람과 나 사이의 열쇠. 둘 다 같은 값을 얻는다(그게 ECDH 다). */
export function conversationKey(mySecret: Uint8Array, theirPubHex: string): Uint8Array {
  // 🔴 Nostr 공개키는 x좌표만 32바이트다. secp256k1 은 앞에 짝수 표시(02)를
  // 붙여야 점으로 읽는다. 이걸 빠뜨리면 라이브러리가 조용히 다른 점을 쓴다.
  const shared = secp256k1.getSharedSecret(mySecret, "02" + theirPubHex);
  // 앞 1바이트는 형식 표시다. **x좌표 32바이트만** 쓴다 — NIP-44 규정이다.
  //
  // 🔴 `extract` 만 쓴다. `hkdf`(=extract+expand)를 쓰면 **다른 값이 나오고,
  // 우리끼리만 통하는 암호가 된다.** 공식 시험값이 정확히 그걸 잡았다:
  //   hkdf    → 4a2fad942a64c9df…  🔴
  //   extract → 3dfef0ce2a4d80a2…  ✅ (기대값과 같음)
  // NIP-44 는 대화 열쇠를 "extract 의 결과" 로 정의한다. expand 는 아래
  // `messageKeys` 에서만 한다.
  return extract(sha256, shared.subarray(1, 33), SALT);
}

/** 이 대화·이 메시지에만 쓰는 열쇠 셋. */
function messageKeys(convKey: Uint8Array, nonce: Uint8Array) {
  // 여기서만 expand 한다. 대화 열쇠(extract 결과)를 이 메시지용으로 늘린다.
  const k = expand(sha256, convKey, nonce, 76);
  return {
    chachaKey: k.subarray(0, 32),
    chachaNonce: k.subarray(32, 44),
    hmacKey: k.subarray(44, 76),
  };
}

/**
 * 길이를 숨긴다.
 *
 * 🔴 이게 없으면 **글자 수가 그대로 보인다.** "네" 와 "죄송합니다 안 됩니다"
 * 는 길이가 다르고, 그 차이만으로 대화의 내용을 짐작할 수 있다.
 */
function pad(plain: string): Uint8Array {
  const b = utf8ToBytes(plain);
  if (b.length < 1 || b.length > 65535) throw new Error("메시지 길이가 벗어났습니다.");
  const total = calcPadded(b.length);
  const out = new Uint8Array(2 + total);
  // 앞 2바이트에 진짜 길이. 나머지는 0으로 채운다.
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function calcPadded(len: number): number {
  if (len <= 32) return 32;
  const next = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = next <= 256 ? 32 : next / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function unpad(padded: Uint8Array): string {
  const len = (padded[0] << 8) | padded[1];
  const body = padded.subarray(2, 2 + len);
  if (len < 1 || body.length !== len) throw new Error("내용이 깨졌습니다.");
  return new TextDecoder().decode(body);
}

/** 잠근다. */
export function encrypt(plain: string, convKey: Uint8Array): string {
  const nonce = randomBytes(32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ct = chacha20(chachaKey, chachaNonce, pad(plain));
  // 🔴 nonce 를 함께 서명한다. 안 하면 nonce 를 바꿔치기해도 봉인이 통과한다.
  const mac = hmac(sha256, hmacKey, concat(nonce, ct));
  return b64(concat(new Uint8Array([VERSION]), nonce, ct, mac));
}

/** 연다. 봉인이 안 맞으면 **내용을 보기 전에** 멈춘다. */
export function decrypt(payload: string, convKey: Uint8Array): string {
  const raw = unb64(payload);
  if (raw.length < 1 + 32 + 32 + 32) throw new Error("너무 짧습니다.");
  if (raw[0] !== VERSION) throw new Error(`모르는 방식입니다(${raw[0]}).`);
  const nonce = raw.subarray(1, 33);
  const ct = raw.subarray(33, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const want = hmac(sha256, hmacKey, concat(nonce, ct));
  // ⚠️ 시간을 재서 맞히는 공격을 막으려면 한 글자씩 비교하면 안 된다.
  if (!equal(want, mac)) throw new Error("봉인이 맞지 않습니다. 열지 않았습니다.");
  return unpad(chacha20(chachaKey, chachaNonce, ct));
}

function concat(...arr: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arr.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arr) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** 길이가 같아도 **끝까지** 본다. 먼저 다르다고 끊으면 시간이 새어 나간다. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export { bytesToHex, hexToBytes };
