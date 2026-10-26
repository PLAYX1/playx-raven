import { secp256k1 } from '@noble/curves/secp256k1';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { canonicalJson, hex, plain, sha256Hex, utf8 } from '../creator/bytes';
import { concatBytes, hexToBytes } from '../playx-asset-proof/crypto';
import { encodeDoc, fail, int, isNowMs, isPublicKey, keysAre, readDoc, SHA, signShopDoc } from '../shop-order/signed';
import type { SignDigest } from '../signer/signmessage';
import { DEVICE_CLOCK_SKEW_MS, deviceCertId, deviceSignedBy, verifyDeviceCert, type DeviceCert } from './cert';
import { acceptDeviceRevocationList, MAX_REVOKED, REVOCATION_LIST_MAX_AGE_MS, signDeviceRevocationList, verifyDeviceRevocationList, type DeviceRevocationList } from './revoke';

export const DEVICE_DATA_KEY_DOMAIN = 'RAVENVAULT-DEVICE-DATA-KEY-V1';
export const DATA_KEY_NOTES = '실측·법무 전 초안: 이미 복사된 데이터와 옛 열쇠로 읽을 수 있는 과거 데이터는 회수하거나 지울 수 없습니다.';
export type DeviceRandom = (size: number) => Uint8Array;
export type DataKey = { version: number; key: Uint8Array };
export type SealedDataKeyBody = {
  v: 1; storeId: string; certId: string; deviceId: string; devicePubKey: string;
  keyVersion: number; keyId: string; eph: string; nonce: string; ct: string;
};
export type SealedDataKey = SealedDataKeyBody & { sig: string };
export type DataKeyRotation = {
  dataKey: DataKey; oldVersion: number; revocations: DeviceRevocationList;
  sealed: SealedDataKey[]; notes: string;
};
const osRandom: DeviceRandom = size => globalThis.crypto.getRandomValues(new Uint8Array(size));
const isHex = (value: unknown, size: number): value is string => typeof value === 'string' && value.length === size * 2 && /^[a-f0-9]+$/.test(value);
function randomBytes(rng: DeviceRandom, size: number): Uint8Array {
  const bytes = rng(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) return fail('key', 'rng');
  return bytes.slice();
}
function validateDataKey(dataKey: DataKey): void {
  if (!dataKey || !int(dataKey.version, 1, Number.MAX_SAFE_INTEGER) || !(dataKey.key instanceof Uint8Array) || dataKey.key.length !== 32 || dataKey.key.every(b => b === 0)) fail('key', 'data-key');
}
/** 시드/가게 비밀키를 받지 않는다. 별도 OS 난수로만 만든다. 반환된 key 의 보관·폐기는 호출자 책임이다. */
export function createDataKey(rng: DeviceRandom = osRandom): DataKey {
  const dataKey = { version: 1, key: randomBytes(rng, 32) };
  validateDataKey(dataKey);
  return dataKey;
}
const keyIdOf = (storeId: string, dataKey: DataKey): string =>
  sha256Hex(utf8(canonicalJson([DEVICE_DATA_KEY_DOMAIN, storeId, dataKey.version, hex(dataKey.key)])));
const aad = (body: Omit<SealedDataKeyBody, 'ct'>): Uint8Array => utf8(canonicalJson([DEVICE_DATA_KEY_DOMAIN, body]));
/** lock.ts 의 ephemeral ECDH → HKDF → XChaCha 봉함 구조. X25519 대신 증서의 secp256k1 키를 noble 로 직접 사용한다. */
const wrapKey = (shared: Uint8Array, eph: string, recipient: string): Uint8Array =>
  hkdf(sha256, shared, concatBytes(hexToBytes(eph), hexToBytes(recipient)), utf8(DEVICE_DATA_KEY_DOMAIN), 32);
export const encodeSealedDataKey = (sealed: SealedDataKey): Uint8Array => encodeDoc(sealed);

/** 결과는 별도 LAN 봉함 채널로 전달한다. 증서에 데이터 열쇠를 넣지 않는다. */
export async function sealDataKey(dataKey: DataKey, cert: DeviceCert, storeKey: string, signer: SignDigest, now: number, list: DeviceRevocationList, rng: DeviceRandom = osRandom): Promise<SealedDataKey> {
  validateDataKey(dataKey);
  const result = verifyDeviceCert(cert, storeKey, now, list);
  if (!result.ok) return fail('cert', result.reason);
  const ephemeralPrivate = randomBytes(rng, 32);
  let shared: Uint8Array | undefined, wrap: Uint8Array | undefined;
  try {
    if (!secp256k1.utils.isValidPrivateKey(ephemeralPrivate)) return fail('key', 'rng');
    const header = {
      v: 1 as const, storeId: cert.storeId, certId: deviceCertId(cert), deviceId: cert.deviceId, devicePubKey: cert.devicePubKey,
      keyVersion: dataKey.version, keyId: keyIdOf(cert.storeId, dataKey), eph: hex(secp256k1.getPublicKey(ephemeralPrivate, true)), nonce: hex(randomBytes(rng, 24)),
    };
    shared = secp256k1.getSharedSecret(ephemeralPrivate, cert.devicePubKey, true);
    wrap = wrapKey(shared, header.eph, header.devicePubKey);
    const body = { ...header, ct: hex(xchacha20poly1305(wrap, hexToBytes(header.nonce), aad(header)).encrypt(dataKey.key)) };
    return await signShopDoc(signer, DEVICE_DATA_KEY_DOMAIN, body, storeKey);
  } finally { ephemeralPrivate.fill(0); shared?.fill(0); wrap?.fill(0); }
}

/** expectedVersion 은 저장된 최신 버전이다. 옛 봉투 재전송을 받지 않도록 호출자가 단조 증가로 보관한다. */
export function openDataKey(raw: unknown, cert: DeviceCert, devicePrivateKey: Uint8Array, storeKey: string, now: number, list: DeviceRevocationList, expectedVersion: number): DataKey {
  const result = verifyDeviceCert(cert, storeKey, now, list);
  if (!result.ok) return fail('cert', result.reason);
  const body = readDoc(raw, 4096);
  if (!plain(body) || !keysAre(body, 'v,storeId,certId,deviceId,devicePubKey,keyVersion,keyId,eph,nonce,ct,sig') || body.v !== 1 ||
      !int(expectedVersion, 1, Number.MAX_SAFE_INTEGER) || body.keyVersion !== expectedVersion || !isHex(body.keyId, 32) ||
      !isPublicKey(body.eph) || !isHex(body.nonce, 24) || !isHex(body.ct, 48) || typeof body.sig !== 'string') return fail('shape', 'sealed-key');
  if (body.storeId !== cert.storeId || body.certId !== deviceCertId(cert) || body.deviceId !== cert.deviceId || body.devicePubKey !== cert.devicePubKey ||
      !deviceSignedBy(DEVICE_DATA_KEY_DOMAIN, body as SealedDataKey, storeKey)) return fail('signature', 'sealed-key');
  let shared: Uint8Array | undefined, wrap: Uint8Array | undefined, key: Uint8Array | undefined;
  try {
    if (!(devicePrivateKey instanceof Uint8Array) || !secp256k1.utils.isValidPrivateKey(devicePrivateKey) || hex(secp256k1.getPublicKey(devicePrivateKey, true)) !== cert.devicePubKey) return fail('key', 'recipient');
    const { ct, sig: _sig, ...header } = body as SealedDataKey;
    shared = secp256k1.getSharedSecret(devicePrivateKey, header.eph, true);
    wrap = wrapKey(shared, header.eph, header.devicePubKey);
    key = xchacha20poly1305(wrap, hexToBytes(header.nonce), aad(header)).decrypt(hexToBytes(ct));
    const dataKey = { version: expectedVersion, key };
    validateDataKey(dataKey);
    if (keyIdOf(cert.storeId, dataKey) !== body.keyId) return fail('key', 'fingerprint');
    key = undefined; // 성공한 결과의 열쇠는 호출자가 소유한다.
    return dataKey;
  } catch { return fail('key', 'open'); }
  finally { shared?.fill(0); wrap?.fill(0); key?.fill(0); }
}

/**
 * devices 는 같은 가게의 전체 발급 이력이다. 분실 deviceId 의 모든 일련번호를 철회한 뒤 남은 유효 기기에만 새 열쇠를 봉인한다.
 * 반환 목록/버전/봉투를 원자적으로 영속 저장한 뒤 전송한다. 과거 데이터 재암호화·LAN 전송·저장소는 호출자 영역이다.
 */
export async function rotateDataKey(input: {
  previous: DataKey; lostDeviceId: string; devices: readonly DeviceCert[]; storeId: string; storeKey: string;
  signer: SignDigest; now: number; revocations: DeviceRevocationList; rng?: DeviceRandom;
}): Promise<DataKeyRotation> {
  const { previous, devices, lostDeviceId, storeId, storeKey, signer, now } = input;
  validateDataKey(previous);
  if (!SHA.test(lostDeviceId) || !SHA.test(storeId) || !int(previous.version, 1, Number.MAX_SAFE_INTEGER - 1)) return fail('key', 'rotation');
  const current = verifyDeviceRevocationList(input.revocations, storeKey, storeId);
  if (!isNowMs(now)) return fail('cert', 'bad-clock');
  if (current.issuedAt > now + DEVICE_CLOCK_SKEW_MS || now - current.issuedAt > REVOCATION_LIST_MAX_AGE_MS) return fail('revocation', 'time');
  // 빈 목록/기한이 지난 증서만 있어도 시계와 목록 신선도를 먼저 확인한다.
  if (!devices.length) return fail('cert', 'no-devices');
  const lost = devices.filter(c => c.deviceId === lostDeviceId);
  if (!lost.length) return fail('cert', 'unknown-device');
  const serials = new Set<number>();
  for (const cert of devices) {
    // 철회·만료는 정상 이력이다. 다른 모든 실패는 전체 회전을 중단한다.
    const check = verifyDeviceCert(cert, storeKey, now, current);
    if (!check.ok && check.reason !== 'revoked' && check.reason !== 'expired') return fail('cert', check.reason);
    if (cert.storeId !== storeId || serials.has(cert.serial)) return fail('cert', 'history');
    serials.add(cert.serial);
  }
  const revoked = [...new Set([...current.revoked, ...lost.map(deviceCertId)])].sort();
  if (revoked.length > MAX_REVOKED) return fail('revocation', 'prune-required');
  const next = await signDeviceRevocationList({ v: 1, storeId, seq: current.seq + 1, revoked, issuedAt: now, prunedBefore: current.prunedBefore }, storeKey, signer);
  const revocations = acceptDeviceRevocationList(current, next, storeKey, storeId);
  const rng = input.rng ?? osRandom;
  const dataKey = createDataKey(rng);
  dataKey.version = previous.version + 1;
  try {
    if (hex(dataKey.key) === hex(previous.key)) return fail('key', 'repeated-rng');
    const sealed: SealedDataKey[] = [];
    for (const cert of devices) {
      if (cert.deviceId === lostDeviceId) continue;
      const check = verifyDeviceCert(cert, storeKey, now, revocations);
      if (!check.ok) {
        if (check.reason === 'revoked' || check.reason === 'expired') continue;
        return fail('cert', check.reason);
      }
      sealed.push(await sealDataKey(dataKey, cert, storeKey, signer, now, revocations, rng));
    }
    return { dataKey, oldVersion: previous.version, revocations, sealed, notes: DATA_KEY_NOTES };
  } catch (error) { dataKey.key.fill(0); throw error; }
}
