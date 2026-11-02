// 연결 운반: 겉봉 왕복 · 남의 것·다른 상대·모양 틀림은 null · 안의 서명은 그대로 검사된다.
import { assert } from '../test-assert';
import { publicKeyOf } from '../talk/event';
import { linkInboxFilter, openLinkMessage, packLinkMessage } from './transport';
import { signLinkRevoke, signLinkSeen, verifyLinkRevoke, verifyLinkSeen } from './link';
import { wrapFor } from '../talk/nip17';

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
// 「받았어요」(데스크탑 → 폰)도 같은 겉봉으로 오간다.
const seen = signLinkSeen({ v: 1, linkId, id: '11'.repeat(32), at: 1_793_600_001_000, dailySats: '100000000000', spentToday: '0' }, desk);
const seenGot = openLinkMessage(phone, packLinkMessage(desk, phonePub, { t: 'seen', s: seen }), deskPub);
assert(seenGot && seenGot.msg.t === 'seen');
assert.equal(verifyLinkSeen(seenGot!.msg.s as typeof seen, deskPub, linkId).dailySats, '100000000000');
// 모르는 종류는 오류 없이 null — 「seen」 을 모르던 폰이 새 데스크탑의 「받았어요」를 이렇게 버린다(이 다음 종류도 같다).
assert.equal(openLinkMessage(phone, wrapFor(desk, phonePub, phonePub, JSON.stringify({ rvwl1: 'later', s: seen })), deskPub), null, 'unknown type is dropped');
const f = linkInboxFilter(deskPub, 1_000_000);
assert(f.kinds?.[0] === 1059 && f['#p']?.[0] === deskPub && f.since === 1_000_000 - 172_800);
console.log('wallet-link transport ok');
