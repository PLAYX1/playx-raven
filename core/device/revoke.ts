import { plain } from '../creator/bytes';
import { encodeDoc, fail, int, keysAre, readDoc, SHA, signShopDoc, time } from '../shop-order/signed';
import { MAX_REVOKED, MAX_REVOKE_BYTES, REVOCATION_LIST_MAX_AGE_MS } from '../shop-order/delegation';
import type { SignDigest } from '../signer/signmessage';
import { DEVICE_CLOCK_SKEW_MS, deviceCertId, deviceSignedBy, type DeviceCertBody, type DeviceCertReason } from './cert';

export { MAX_REVOKED, REVOCATION_LIST_MAX_AGE_MS };
export const DEVICE_REVOKE_DOMAIN = 'RAVENVAULT-DEVICE-REVOKE-V1';
export type DeviceRevocationBody = { v: 1; storeId: string; seq: number; revoked: string[]; issuedAt: number; prunedBefore: number };
export type DeviceRevocationList = DeviceRevocationBody & { sig: string };
export const encodeDeviceRevocationList = (list: DeviceRevocationList): Uint8Array => encodeDoc(list);

export function validateDeviceRevocationList(raw: unknown, withSig = true): DeviceRevocationList {
  if (!plain(raw) || !keysAre(raw, 'v,storeId,seq,revoked,issuedAt,prunedBefore' + (withSig ? ',sig' : '')) || raw.v !== 1 ||
      typeof raw.storeId !== 'string' || !SHA.test(raw.storeId) || !int(raw.seq, 1, Number.MAX_SAFE_INTEGER) || !time(raw.issuedAt) || !int(raw.prunedBefore, 0, raw.issuedAt)) return fail('revocation', 'shape');
  if (!Array.isArray(raw.revoked) || raw.revoked.length > MAX_REVOKED || raw.revoked.some((s: unknown) => typeof s !== 'string' || !SHA.test(s))) return fail('revocation', 'ids');
  for (let i = 1; i < raw.revoked.length; i++) if (!(raw.revoked[i - 1] < raw.revoked[i])) fail('revocation', 'order');
  if (withSig && typeof raw.sig !== 'string') fail('revocation', 'sig');
  return raw as DeviceRevocationList;
}
export async function signDeviceRevocationList(body: DeviceRevocationBody, storeKey: string, signer: SignDigest): Promise<DeviceRevocationList> {
  validateDeviceRevocationList(readDoc(body, MAX_REVOKE_BYTES), false);
  return signShopDoc(signer, DEVICE_REVOKE_DOMAIN, body, storeKey);
}
export function verifyDeviceRevocationList(raw: unknown, storeKey: string, storeId: string): DeviceRevocationList {
  const list = validateDeviceRevocationList(readDoc(raw, MAX_REVOKE_BYTES));
  if (list.storeId !== storeId) fail('revocation', 'other-store');
  if (!deviceSignedBy(DEVICE_REVOKE_DOMAIN, list, storeKey)) fail('signature', 'revocation');
  return list;
}
/** seq·시각·가지치기 후퇴 금지. 빠진 ID 는 notAfter ≤ prunedBefore 인 증서만이라는 가게 키의 약속(직원 목록과 동일). */
export function acceptDeviceRevocationList(current: DeviceRevocationList | null, raw: unknown, storeKey: string, storeId: string): DeviceRevocationList {
  const next = verifyDeviceRevocationList(raw, storeKey, storeId);
  if (!current) return next;
  const previous = verifyDeviceRevocationList(current, storeKey, storeId);
  if (next.seq <= previous.seq) return previous;
  if (next.issuedAt < previous.issuedAt || next.prunedBefore < previous.prunedBefore) fail('revocation', 'rollback');
  if (next.prunedBefore === previous.prunedBefore && previous.revoked.some(id => !next.revoked.includes(id))) fail('revocation', 'shrunk');
  return next;
}
export function checkDeviceRevocations(cert: DeviceCertBody, storeKey: string, now: number, raw: unknown): DeviceCertReason | null {
  if (raw === null || raw === undefined) return 'no-revocation-list';
  let list: DeviceRevocationList;
  try { list = validateDeviceRevocationList(readDoc(raw, MAX_REVOKE_BYTES)); } catch { return 'shape'; }
  if (list.storeId !== cert.storeId) return 'other-store';
  if (!deviceSignedBy(DEVICE_REVOKE_DOMAIN, list, storeKey)) return 'signature';
  if (now + DEVICE_CLOCK_SKEW_MS < list.issuedAt) return 'not-yet';
  if (now - list.issuedAt > REVOCATION_LIST_MAX_AGE_MS) return 'stale-revocation-list';
  return cert.notAfter <= list.prunedBefore || list.revoked.includes(deviceCertId(cert)) ? 'revoked' : null;
}
