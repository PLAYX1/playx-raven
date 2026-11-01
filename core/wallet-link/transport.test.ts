// 연결 운반: 겉봉 왕복 · 남의 것·다른 상대·모양 틀림은 null · 안의 서명은 그대로 검사된다.
import { assert } from '../test-assert';
import { publicKeyOf } from '../talk/event';
import { linkInboxFilter, openLinkMessage, packLinkMessage } from './transport';
import { signLinkRevoke, verifyLinkRevoke } from './link';

const key = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 5));
const phone = key(1), desk = key(2), stranger = key(3);
const phonePub = publicKeyOf(phone), deskPub = publicKeyOf(desk);
const linkId = 'ab'.repeat(32);
const revoke = signLinkRevoke({ v: 1, linkId, at: 1_793_600_000_000 }, phone);
const gift = packLinkMessage(phone, deskPub, { t: 'revoke', s: revoke });
const got = openLinkMessage(desk, gift, phonePub);
assert(got && got.msg.t === 'revoke' && got.from === phonePub);
assert.equal(verifyLinkRevoke(got!.msg.s as typeof revoke, phonePub, linkId).at, 1_793_600_000_000);
assert.equal(openLinkMessage(stranger, gift), null, 'only the recipient can open');
assert.equal(openLinkMessage(desk, gift, publicKeyOf(stranger)), null, 'unexpected sender');
assert.throws(() => packLinkMessage(phone, deskPub, { t: 'pay', s: revoke } as never));
const f = linkInboxFilter(deskPub, 1_000_000);
assert(f.kinds?.[0] === 1059 && f['#p']?.[0] === deskPub && f.since === 1_000_000 - 172_800);
console.log('wallet-link transport ok');
