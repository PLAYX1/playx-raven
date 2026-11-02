// 데스크탑 지갑 연결 규격. 고정 시험 시드·고정 키만(실 지갑·시계·네트워크 없음).
import { assert } from '../test-assert';
import { deriveAccount } from '../wallet-keys/derive';
import { schnorr } from '../crypto-backend';
import { publicKeyOf } from '../talk/event';
import { canonicalJson } from '../creator/bytes';
import {
  checkLinkRequest, encodeLinkOffer, linkConfirmCode, linkId, linkReceiveAddress, parseLinkOffer, signLinkAccept, signLinkRequest, signLinkResult,
  verifyLinkAccept, verifyLinkResult, LINK_DAILY_SATS, type LinkOffer, type LinkRecord, type LinkRequest,
} from './link';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const secret = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7));
const pubOf = (s: Uint8Array) => publicKeyOf(s);
const now = 1_793_600_000_000;
const desk = secret(1), phone = secret(2), other = secret(3);
const deskKey = pubOf(desk), phoneKey = pubOf(phone);
const account = deriveAccount(Uint8Array.from({ length: 64 }, (_, i) => i), 0), wrongAccount = deriveAccount(Uint8Array.from({ length: 64 }, (_, i) => i), 1);
const first = account.deriveAddress({ change: 0, index: 0 }).address;
const offer: LinkOffer = { v: 1, chain: 'rvn-main', account: 0, desktopKey: deskKey, name: '맥 지갑', xpub: account.xpub, firstAddress: first, nonce: 'ab'.repeat(32), expires: now + 60_000 };

// 서명 도구가 x-only 키와 맞는지 먼저 확인.
assert(schnorr.verify(new Uint8Array(32).fill(1), Uint8Array.from(phoneKey.match(/../g)!.map(x => parseInt(x, 16))), schnorr.sign(new Uint8Array(32).fill(1), phone)));

// 제안: 왕복 · 받기 주소는 계정 0 xpub 에서 · 바꿔치기·만료·개인키·다른 계정은 거절.
const text = encodeLinkOffer(offer);
assert.equal(canonicalJson(parseLinkOffer(text, now)), canonicalJson(offer));
assert.equal(linkReceiveAddress(account.xpub, 3), account.deriveAddress({ change: 0, index: 3 }).address);
assert.throws(() => parseLinkOffer(text, now + 61_000), 'expired');
assert.throws(() => parseLinkOffer(encodeLinkOffer({ ...offer, firstAddress: account.deriveAddress({ change: 0, index: 1 }).address }), now), 'first address must be index 0');
assert.throws(() => parseLinkOffer(encodeLinkOffer({ ...offer, xpub: wrongAccount.xpub, firstAddress: wrongAccount.deriveAddress({ change: 0, index: 0 }).address }), now), 'account 1 is not the main wallet');
assert.throws(() => parseLinkOffer(text.slice(0, -4) + 'AAAA', now));
assert.throws(() => parseLinkOffer(encodeLinkOffer({ ...offer, extra: 1 } as unknown as LinkOffer), now), 'no extra fields');

// 6자리: 두 키·xpub·난수 어느 하나가 바뀌어도 달라진다.
const code = linkConfirmCode(offer, phoneKey);
assert(/^\d{6}$/.test(code));
assert.equal(linkConfirmCode(offer, phoneKey), code);
assert(linkConfirmCode({ ...offer, nonce: 'cd'.repeat(32) }, phoneKey) !== code);
assert(linkConfirmCode({ ...offer, desktopKey: pubOf(other) }, phoneKey) !== code);
assert(linkConfirmCode({ ...offer, xpub: wrongAccount.xpub }, phoneKey) !== code, 'xpub swap changes the code');
assert(linkConfirmCode(offer, pubOf(other)) !== code);

// 수락: 이 제안·이 폰 키에 묶인다.
const id = linkId(offer, phoneKey), phoneAddr = linkReceiveAddress(deriveAccount(Uint8Array.from({ length: 64 }, () => 9), 0).xpub, 0);
const accept = signLinkAccept({ v: 1, linkId: id, phoneKey, phoneAddresses: [phoneAddr] }, phone);
assert.equal(verifyLinkAccept(accept, offer).phoneKey, phoneKey);
assert.throws(() => verifyLinkAccept({ ...accept, body: { ...accept.body, phoneAddresses: [first] } }, offer), 'tampered addresses');
assert.throws(() => verifyLinkAccept(signLinkAccept({ v: 1, linkId: id, phoneKey, phoneAddresses: [phoneAddr] }, other), offer), 'wrong signer');
assert.throws(() => verifyLinkAccept(accept, { ...offer, nonce: 'cd'.repeat(32) }), 'other offer');

// 요청: 채우기(등록한 폰 주소) / 보내기(그 밖) · 위조·다른 연결·만료·재사용·끊김·하루 한도.
const link: LinkRecord = { linkId: id, phoneKey, phoneAddresses: [phoneAddr], revoked: false, dailySats: LINK_DAILY_SATS };
const req = (over: Partial<LinkRequest> = {}): LinkRequest => ({ v: 1, chain: 'rvn-main', account: 0, linkId: id, id: '11'.repeat(32), to: phoneAddr, sats: '20000000000', created: now, expires: now + 600_000, ...over });
const fill = signLinkRequest(req(), phone);
const ok = checkLinkRequest(fill, link, now + 1000, new Set(), []);
assert(ok.ok && ok.kind === 'fill');
const send = checkLinkRequest(signLinkRequest(req({ to: first }), phone), link, now, new Set(), []);
assert(send.ok && send.kind === 'send', 'unknown destination is a plain send');
assert.equal((checkLinkRequest({ ...fill, body: { ...fill.body, sats: '90000000000' } }, link, now, new Set(), []) as { reason: string }).reason, 'signature');
assert.equal((checkLinkRequest(signLinkRequest(req(), other), link, now, new Set(), []) as { reason: string }).reason, 'signature');
assert.equal((checkLinkRequest(signLinkRequest(req({ linkId: 'ee'.repeat(32) }), phone), link, now, new Set(), []) as { reason: string }).reason, 'other-link');
assert.equal((checkLinkRequest(fill, link, now + 700_000, new Set(), []) as { reason: string }).reason, 'expired');
assert.equal((checkLinkRequest(fill, link, now, new Set(['11'.repeat(32)]), []) as { reason: string }).reason, 'seen');
assert.equal((checkLinkRequest(fill, { ...link, revoked: true }, now, new Set(), []) as { reason: string }).reason, 'revoked');
assert.equal((checkLinkRequest(fill, link, now, new Set(), [{ at: now - 3_600_000, sats: LINK_DAILY_SATS - 1n }]) as { reason: string }).reason, 'daily-limit');
assert(checkLinkRequest(fill, link, now, new Set(), [{ at: now - 90_000_000, sats: LINK_DAILY_SATS - 1n }]).ok, 'yesterday does not count');
assert.throws(() => signLinkRequest(req({ expires: now + 3_600_000 }), phone), 'ttl over 10 minutes');

// 결과: 데스크탑 키로만, 이 연결에만.
const res = signLinkResult({ v: 1, linkId: id, id: '11'.repeat(32), txid: 'aa'.repeat(32) }, desk);
assert.equal(verifyLinkResult(res, deskKey, id).txid, 'aa'.repeat(32));
assert.throws(() => verifyLinkResult(res, phoneKey, id));
assert.throws(() => verifyLinkResult(res, deskKey, 'ff'.repeat(32)));
assert.throws(() => signLinkResult({ v: 1, linkId: id, id: '11'.repeat(32) }, desk), 'txid or refused');
console.log('wallet-link ok');
