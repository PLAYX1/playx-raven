/**
 * NIP-17 쪽지 — 1:1 비밀 대화. 데스크탑 웹 지갑(`web/nip17.ts`)과 같은 세 겹 봉투.
 *
 * 1. 속지(rumor, kind 14) — 서명하지 않은 진짜 글. 새어 나가도 「내가 썼다」는 증거가 안 된다.
 * 2. 봉인(seal, kind 13) — 속지를 받는 사람만 열게 암호화하고 **내 열쇠로 서명**. 받는 쪽은 여기서 보낸 이를 안다.
 * 3. 겉봉(gift wrap, kind 1059) — 봉인을 **한 번 쓰고 버리는 열쇠**로 다시 싼다. 릴레이는 받는 이(`p`)만 알고 보낸 이는 모른다.
 *
 * 시각은 봉인·겉봉 모두 최대 이틀 앞당겨 흐린다(NIP-59) — 언제 썼는지도 릴레이가 모르게.
 * 🔴 겉봉은 **둘** 만든다 — 상대 것과 내 것. 내 것을 안 만들면 내가 보낸 말을 내가 다시 못 읽는다.
 */
import { conversationKey, decrypt, encrypt } from './nip44';
import { checkEvent, eventId, publicKeyOf, signEvent, type NostrEvent } from './event';

export const KIND_DM = 14;
export const KIND_SEAL = 13;
export const KIND_WRAP = 1059;

export type Rumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string };
export type DirectMessage = { id: string; from: string; to: string; at: number; text: string; wrapId: string };

function fuzzyTime(now: number): number {
  const back = Math.floor((globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * 172_800);
  return now - back;
}

/** 한 사람에게 갈 겉봉 하나. forWhom = 이 겉봉을 열 사람(상대 또는 나). */
export function wrapFor(mySecret: Uint8Array, toPub: string, forWhom: string, text: string, now = Math.floor(Date.now() / 1000)): NostrEvent {
  const me = publicKeyOf(mySecret);
  const body = { pubkey: me, created_at: now, kind: KIND_DM, tags: [['p', toPub]], content: text };
  const rumor: Rumor = { ...body, id: eventId(body) };
  const seal = signEvent(mySecret, { created_at: fuzzyTime(now), kind: KIND_SEAL, tags: [], content: encrypt(JSON.stringify(rumor), conversationKey(mySecret, forWhom)) });
  const once = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try {
    return signEvent(once, { created_at: fuzzyTime(now), kind: KIND_WRAP, tags: [['p', forWhom]], content: encrypt(JSON.stringify(seal), conversationKey(once, forWhom)) });
  } finally { once.fill(0); }
}

/** 상대 것 + 내 것. 둘 다 릴레이에 올린다. */
export function wrapMessage(mySecret: Uint8Array, toPub: string, text: string): NostrEvent[] {
  const me = publicKeyOf(mySecret);
  return toPub === me ? [wrapFor(mySecret, toPub, me, text)] : [wrapFor(mySecret, toPub, toPub, text), wrapFor(mySecret, toPub, me, text)];
}

/** 겉봉 → 쪽지. 못 열거나(남의 것) 봉인 서명·보낸 이가 안 맞으면 null — 오류가 아니다. */
export function unwrap(mySecret: Uint8Array, gift: NostrEvent): DirectMessage | null {
  try {
    if (gift.kind !== KIND_WRAP) return null;
    const seal = checkEvent(JSON.parse(decrypt(gift.content, conversationKey(mySecret, gift.pubkey))));
    if (!seal || seal.kind !== KIND_SEAL) return null;
    const rumor = JSON.parse(decrypt(seal.content, conversationKey(mySecret, seal.pubkey))) as Rumor;
    if (!rumor || rumor.kind !== KIND_DM || typeof rumor.content !== 'string' || !Array.isArray(rumor.tags)) return null;
    // 🔴 속지의 「보낸 이」는 서명이 없다. 봉인의 서명자와 같아야만 믿는다(사칭 막기).
    if (rumor.pubkey !== seal.pubkey) return null;
    const to = rumor.tags.find(t => Array.isArray(t) && t[0] === 'p')?.[1] ?? '';
    if (!/^[a-f0-9]{64}$/.test(to) || !Number.isSafeInteger(rumor.created_at)) return null;
    // 속지 번호는 내용으로 다시 계산해 맞춰 본다(같은 쪽지 판별이 이 번호를 믿는다).
    if (rumor.id !== eventId({ pubkey: rumor.pubkey, created_at: rumor.created_at, kind: rumor.kind, tags: rumor.tags, content: rumor.content })) return null;
    // 나에게 온 것이거나 내가 보낸 사본이어야 한다 — 남에게 쓴 쪽지를 나와의 대화처럼 끼워 넣지 못하게.
    const me = publicKeyOf(mySecret);
    if (to !== me && rumor.pubkey !== me) return null;
    return { id: rumor.id, from: rumor.pubkey, to, at: rumor.created_at, text: rumor.content.slice(0, 8000), wrapId: gift.id };
  } catch { return null; }
}

export type Conversation = { with: string; last: number; messages: DirectMessage[] };

/** 쪽지 → 상대별 대화. mine = 이 기기가 여는 내 열쇠들(사람 열쇠 + 중고 판매자 열쇠). 같은 쪽지는 한 번만. */
export function conversationsFrom(messages: DirectMessage[], mine: string[]): Conversation[] {
  const by = new Map<string, Conversation>(), seen = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.id)) continue; seen.add(m.id);
    const other = mine.includes(m.from) ? m.to : m.from;
    const c = by.get(other) ?? { with: other, last: 0, messages: [] };
    c.messages.push(m); c.last = Math.max(c.last, m.at); by.set(other, c);
  }
  for (const c of by.values()) c.messages.sort((a, b) => a.at - b.at);
  return [...by.values()].sort((a, b) => b.last - a.last);
}

