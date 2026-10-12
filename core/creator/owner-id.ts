import { sha256 } from '@noble/hashes/sha256';

/*
 * 주인 ID 도출 — 복사 가능한 형태. (C6 통합, 2026-10-12)
 *
 * ownerId = UUIDv4 모양( SHA-256( "rv-game-owner-v1:<gameId>:" || 공개키 32바이트 )[0..16] ). 게임·결제 서버·지갑이 모두 같은 식이다.
 * 이 파일은 의존이 sha256 하나뿐이라 데스크탑 저장소가 바이트 그대로 복사해 간다(core/wallet-keys/identity.ts 는 여기서 가져다 쓴다 — 식을 두 곳에 두지 않는다).
 * 공용 벡터: core/creator/owner-id-vectors.json (지갑·데스크탑 시험이 같이 읽는다).
 * 🔴 공개키만 받는다. 개인키·시드·단어는 이 파일에 들어오지 않는다.
 */
const GAME_ID = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
export type OwnerIdErrorCode = 'owner-id-game' | 'owner-id-key';
export class OwnerIdError extends Error {
  constructor(readonly code: OwnerIdErrorCode) { super(code); this.name = 'OwnerIdError'; }
}

/** 주인 ID 도메인 'rv-game-owner-v1:<gameId>:' — 게임 owner-identity.js ownerDomain 과 같다. */
export const ownerDomainOf = (gameId: string): string => {
  if (typeof gameId !== 'string' || !GAME_ID.test(gameId)) throw new OwnerIdError('owner-id-game');
  return 'rv-game-owner-v1:' + gameId + ':';
};

export function ownerIdFromPublicKey(publicKey: Uint8Array, gameId: string): string {
  const domain = new TextEncoder().encode(ownerDomainOf(gameId));
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new OwnerIdError('owner-id-key');
  const input = new Uint8Array(domain.length + 32);
  input.set(domain); input.set(publicKey, domain.length);
  const b = sha256(input).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
