import { secp256k1 } from '@noble/curves/secp256k1';
import { base64Decode, base64Encode, canonicalJson, plain, sha256Hex, utf8 } from '../creator/bytes';
import { hexToBytes } from '../playx-asset-proof/crypto';
import { bodyHash, encodeDoc, fail, int, isNowMs, isPublicKey, keysAre, readDoc, SHA, signedBy, signShopDoc, time } from '../shop-order/signed';
import { STAFF_CLOCK_SKEW_MS } from '../shop-order/delegation';
import type { SignDigest } from '../signer/signmessage';
import { checkDeviceRevocations, type DeviceRevocationList } from './revoke';

export const DEVICE_CERT_DOMAIN = 'RAVENVAULT-DEVICE-CERT-V1';
/** 잠정 — 대표 결정 대기. */
export const DEVICE_CERT_DEFAULT_DAYS = 7;
export const DEVICE_CERT_MAX_MS = 30 * 24 * 3600_000;
export const DEVICE_CLOCK_SKEW_MS = STAFF_CLOCK_SKEW_MS;
export const MAX_DEVICE_CERT_BYTES = 4096;
export const DEVICE_SCOPES = ['read', 'replicate', 'draft', 'ticket-check', 'key-request', 'notice-write'] as const;
export type DeviceScope = typeof DEVICE_SCOPES[number];
export type DeviceRole = 'replica' | 'remote' | 'staff-pc' | 'scanner';
/** 허용 목록에 없는 철자·대소문자·공백·유니코드 변형도 전부 shape 로 거절한다. */
export const DEVICE_NEVER = ['price-change', 'refund-confirm', 'delegation-change', 'device-cert-issue', 'quote', 'payment', 'send', 'refund', 'transfer', 'fee-change'] as const;
/** 공지·열쇠 요청은 초안/요청만. 원본 확정 서명은 가게 키 PC 가 한다. 역할 정책은 잠정이다. */
export const DEVICE_ROLE_SCOPES: Readonly<Record<DeviceRole, readonly DeviceScope[]>> = {
  replica: ['read', 'replicate'],
  remote: ['read', 'draft', 'ticket-check', 'key-request', 'notice-write'],
  'staff-pc': DEVICE_SCOPES,
  scanner: ['read', 'ticket-check'],
};
export type DeviceCertBody = {
  v: 1; storeId: string; deviceId: string; devicePubKey: string; role: DeviceRole;
  scopes: DeviceScope[]; issuedAt: number; notAfter: number; serial: number;
};
export type DeviceCert = DeviceCertBody & { sig: string };
export type DeviceCertReason = 'shape' | 'signature' | 'other-store' | 'bad-clock' | 'not-yet' | 'expired' | 'scope' | 'revoked' | 'no-revocation-list' | 'stale-revocation-list';
export type DeviceCertResult = { ok: true; cert: DeviceCert; certId: string } | { ok: false; reason: DeviceCertReason };

export function deviceIdOf(publicKey: string): string {
  if (!isPublicKey(publicKey)) return fail('key', 'device');
  return sha256Hex(hexToBytes(publicKey));
}
/** 철회 식별자는 가게별 일련번호에 고정한다. 본문을 바꿔 같은 번호를 되살릴 수 없다. */
export const deviceCertId = (c: Pick<DeviceCertBody, 'storeId' | 'serial'>): string =>
  sha256Hex(utf8(canonicalJson([DEVICE_CERT_DOMAIN, c.storeId, c.serial])));
export const encodeDeviceCert = (c: DeviceCert): Uint8Array => encodeDoc(c);

export function deviceCertWindow(issuedAt: number, ttlMs = DEVICE_CERT_DEFAULT_DAYS * 24 * 3600_000): { issuedAt: number; notAfter: number } {
  if (!time(issuedAt) || !int(ttlMs, 1, DEVICE_CERT_MAX_MS) || !time(issuedAt + ttlMs)) return fail('cert', 'time');
  return { issuedAt, notAfter: issuedAt + ttlMs };
}
export function validateDeviceCert(raw: unknown, withSig = true): DeviceCert {
  if (!plain(raw) || !keysAre(raw, 'v,storeId,deviceId,devicePubKey,role,scopes,issuedAt,notAfter,serial' + (withSig ? ',sig' : ''))) return fail('shape', 'device-cert');
  if (raw.v !== 1 || typeof raw.storeId !== 'string' || !SHA.test(raw.storeId) || !isPublicKey(raw.devicePubKey) || raw.deviceId !== deviceIdOf(raw.devicePubKey) ||
      !int(raw.serial, 1, Number.MAX_SAFE_INTEGER)) return fail('shape', 'identity');
  if (typeof raw.role !== 'string' || !Object.hasOwn(DEVICE_ROLE_SCOPES, raw.role)) return fail('shape', 'role');
  const allowed = DEVICE_ROLE_SCOPES[raw.role as DeviceRole];
  if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > allowed.length ||
      raw.scopes.some((s: unknown) => !allowed.includes(s as DeviceScope)) || new Set(raw.scopes).size !== raw.scopes.length) return fail('shape', 'scopes');
  if (!time(raw.issuedAt) || !time(raw.notAfter) || raw.notAfter <= raw.issuedAt || raw.notAfter - raw.issuedAt > DEVICE_CERT_MAX_MS) return fail('shape', 'time');
  if (withSig && typeof raw.sig !== 'string') return fail('shape', 'sig');
  return raw as DeviceCert;
}
/** 기존 복구/도메인 검사에 low-S·압축 머리·정본 base64 검사를 덧붙인다. */
export function deviceSignedBy(domain: string, doc: { sig: string }, publicKey: string): boolean {
  try {
    const bytes = base64Decode(doc.sig);
    return bytes.length === 65 && bytes[0] >= 31 && bytes[0] <= 34 && base64Encode(bytes) === doc.sig &&
      !secp256k1.Signature.fromCompact(bytes.subarray(1)).hasHighS() && signedBy(domain, doc, publicKey);
  } catch { return false; }
}
/** storeKey 는 검증된 가게 문서의 판매자 키, 목록의 storeId 는 그 문서의 ID 여야 한다. 목록 서명도 매번 확인한다. */
export function verifyDeviceCert(raw: unknown, storeKey: string, now: number, revocationList: unknown, scope?: DeviceScope): DeviceCertResult {
  if (!isNowMs(now)) return { ok: false, reason: 'bad-clock' };
  let c: DeviceCert;
  try { c = validateDeviceCert(readDoc(raw, MAX_DEVICE_CERT_BYTES)); } catch { return { ok: false, reason: 'shape' }; }
  if (!deviceSignedBy(DEVICE_CERT_DOMAIN, c, storeKey)) return { ok: false, reason: 'signature' };
  if (now + DEVICE_CLOCK_SKEW_MS < c.issuedAt) return { ok: false, reason: 'not-yet' };
  if (now >= c.notAfter) return { ok: false, reason: 'expired' };
  if (scope !== undefined && !c.scopes.includes(scope)) return { ok: false, reason: 'scope' };
  const reason = checkDeviceRevocations(c, storeKey, now, revocationList);
  return reason ? { ok: false, reason } : { ok: true, cert: c, certId: deviceCertId(c) };
}
/** 발급 이력은 가게별로 영속 보관한다(철회 목록 가지치기와 별개). 번호 중복은 다른 기기라도 금지한다. */
export async function issueDeviceCert(body: DeviceCertBody, storeKey: string, signer: SignDigest, now: number, list: DeviceRevocationList, history: readonly DeviceCert[]): Promise<DeviceCert> {
  validateDeviceCert(readDoc(body, MAX_DEVICE_CERT_BYTES), false);
  for (const previous of history) {
    validateDeviceCert(readDoc(previous, MAX_DEVICE_CERT_BYTES));
    if (previous.storeId !== body.storeId || !deviceSignedBy(DEVICE_CERT_DOMAIN, previous, storeKey)) fail('cert', 'history');
    if (previous.serial === body.serial) fail('cert', 'duplicate-serial');
  }
  const cert = await signShopDoc(signer, DEVICE_CERT_DOMAIN, body, storeKey);
  const result = verifyDeviceCert(cert, storeKey, now, list);
  if (!result.ok) fail('cert', result.reason);
  return cert;
}
/** 수신 이력 합치기: 같은 문서 재전송은 허용, 같은 번호의 다른 본문은 거절한다. 결과를 영속 보관한다. */
export function acceptDeviceCert(history: readonly DeviceCert[], raw: unknown, storeKey: string, now: number, list: unknown): DeviceCert[] {
  const result = verifyDeviceCert(raw, storeKey, now, list);
  if (!result.ok) return fail('cert', result.reason);
  for (const c of history) {
    validateDeviceCert(readDoc(c, MAX_DEVICE_CERT_BYTES));
    if (c.storeId !== result.cert.storeId || !deviceSignedBy(DEVICE_CERT_DOMAIN, c, storeKey)) fail('cert', 'history');
    if (c.serial === result.cert.serial) {
      if (bodyHash(c) !== bodyHash(result.cert)) fail('cert', 'duplicate-serial');
      return [...history];
    }
  }
  return [...history, result.cert];
}
