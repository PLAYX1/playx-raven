import { secp256k1 } from '@noble/curves/secp256k1';
import { finishSignature, signMessageDigest, type RawDigestSignature, type SignDigest, type SignOptions } from './signmessage';

/*
 * 시험·도구 전용 — 비밀키를 받는 서명기. 앱(운영) 코드는 이 파일을 import 하지 않는다(signer.test.ts 가 소스를 검사).
 * 각 모듈의 *ForTest 는 여기의 signMessageWithKeyForTest 위에 얇게 얹혀, 운영 경로와 같은 finishSignature(low-S·recid·자기 검증)를 지난다.
 */

/** 다이제스트에 RFC6979 결정적 서명(noble 기본, 추가 난수 없음). */
export function signDigestWithKeyForTest(digest32: Uint8Array, privateKey: Uint8Array): RawDigestSignature {
  const s = secp256k1.sign(digest32, privateKey, { lowS: true });
  return { r: s.r, s: s.s, recid: s.recovery };
}
/** 메모리 키를 SignDigest 콜백으로 감싼다(시험에서 signMessageWith 를 돌릴 때). 키 사본을 쥐고 있다 — 시험 전용. */
export const keyDigestSignerForTest = (privateKey: Uint8Array): SignDigest => {
  const key = Uint8Array.from(privateKey);
  return async digest => signDigestWithKeyForTest(digest, key);
};
/** 동기 signmessage(시험·도구용). 결과 바이트는 signMessageWith(keyDigestSignerForTest(key), …) 와 같다. */
export function signMessageWithKeyForTest(message: string, privateKey: Uint8Array, opts: SignOptions = {}): string {
  const digest = signMessageDigest(message);
  return finishSignature(digest, signDigestWithKeyForTest(digest, privateKey), opts);
}
