/**
 * 이야기 — Nostr 이벤트 한 장의 번호·서명·검사. 방(NIP-28)·쪽지(NIP-17)·이름표(kind 0)가 모두 이 모양이다.
 *
 * 데스크탑(RavenVault Desktop `talk.rs`)·웹 지갑(`web/nostr.ts`)과 **바이트까지 같은** 계산이어야 서로의 글을 읽는다.
 * 서명은 core/crypto-backend 의 schnorr(BIP340)만 쓴다 — 다른 파일에서 secp256k1 을 직접 부르지 않는다.
 */
import { sha256 } from '@noble/hashes/sha256';
import { schnorr, secp256k1 } from '../crypto-backend';
import { bytesToHex as hex, hexToBytes as unhex, utf8Bytes as utf8 } from '../playx-asset-proof/crypto';

export type NostrEvent = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export type EventDraft = { created_at?: number; kind: number; tags: string[][]; content: string };

export const HEX64 = /^[a-f0-9]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const nowSec = () => Math.floor(Date.now() / 1000);

export function eventId(e: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): string {
  return hex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

/** 비밀 열쇠 → x 전용 공개키(64 hex). 못 만들면 던진다. */
export function publicKeyOf(secret: Uint8Array): string {
  const point = secp256k1.pointFromScalar(secret, true);
  if (!point) throw new Error('이야기 열쇠를 읽지 못했어요.');
  return hex(point.subarray(1));
}

export function signEvent(secret: Uint8Array, draft: EventDraft): NostrEvent {
  const pubkey = publicKeyOf(secret);
  const body = { pubkey, created_at: draft.created_at ?? nowSec(), kind: draft.kind, tags: draft.tags.map(t => [...t]), content: draft.content };
  const id = eventId(body);
  return { ...body, id, sig: hex(schnorr.sign(unhex(id), secret)) };
}

/** 모양·번호·서명이 맞는 순수 사본, 아니면 null. 남이 보낸 것은 전부 이걸 거친다. */
export function checkEvent(value: unknown, maxContent = 65_536): NostrEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as NostrEvent;
  if (typeof e.id !== 'string' || !HEX64.test(e.id) || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey) || typeof e.sig !== 'string' || !/^[a-f0-9]{128}$/.test(e.sig)) return null;
  if (!Number.isSafeInteger(e.kind) || e.kind < 0 || e.kind > 65535 || !Number.isSafeInteger(e.created_at) || e.created_at < 0) return null;
  if (typeof e.content !== 'string' || e.content.length > maxContent || LONE_SURROGATE.test(e.content)) return null;
  if (!Array.isArray(e.tags) || e.tags.length > 200 || e.tags.some(t => !Array.isArray(t) || t.length < 1 || t.length > 10 || t.some(x => typeof x !== 'string' || x.length > 2048))) return null;
  const clean: NostrEvent = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map(t => [...t]), content: e.content, sig: e.sig };
  if (eventId(clean) !== clean.id) return null;
  try { return schnorr.verify(unhex(clean.id), unhex(clean.pubkey), unhex(clean.sig)) ? clean : null; } catch { return null; }
}

export function tagValue(e: { tags: string[][] }, name: string): string {
  return e.tags.find(t => t[0] === name)?.[1] ?? '';
}
