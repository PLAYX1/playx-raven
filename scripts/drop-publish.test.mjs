// Drop-to-publish (desktop): kind detection, safe renaming, pasted CID parsing, template/theme rules, manifest v3 extension
// (v2 compatible), safety gates and the state machine. Pure — no network, no IPFS, no node, no real issuance. Throwaway keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['scripts/fixtures/drop-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const D = mod.exports;

const enc = s => new TextEncoder().encode(s);
const MP3 = () => Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, Math.floor(Math.random() * 255)]);
const PNG = n => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, n]);
const JPG = n => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, n]);
const PDF = s => enc(`%PDF-1.7\n${s}\n%%EOF`);
const EPUB = () => { const h = new Uint8Array(30); h.set([0x50, 0x4b, 0x03, 0x04]); return Uint8Array.from([...h, ...enc('mimetypeapplication/epub+zip rest')]); };
const f = (path, bytes, mime = '') => ({ path, bytes, mime });
const KEY = D.randomKey(), ADDRESS = D.addressOf(KEY);
const signer = async (address, message) => { assert.equal(address, ADDRESS); return D.signMessageForTest(message, KEY); };

test('detect: one song = single, a few = EP, many = album; cover picked by name; Korean names made safe, titles kept', () => {
  const one = D.guessDrop([f('01 - 숲의 노래.mp3', MP3())]);
  assert.equal(one.type, 'music'); assert.equal(one.format, 'single'); assert.equal(one.confidence, 'sure');
  assert.equal(one.tracks[0].title, '숲의 노래'); assert.match(one.files[0].path, /^[A-Za-z0-9._\-/]+$/);
  assert.ok(one.renamed.length === 1, 'Korean file name renamed once');
  const ep = D.guessDrop([f('02 sea.mp3', MP3()), f('01 sky.mp3', MP3()), f('cover.jpg', JPG(1)), f('.DS_Store', enc('x'))], '바다 EP');
  assert.equal(ep.format, 'ep'); assert.equal(ep.cover?.path, 'cover.jpg'); assert.equal(ep.title, '바다 EP');
  assert.deepEqual(ep.tracks.map(t => t.title), ['sky', 'sea'], 'natural order by leading number');
  assert.equal(ep.ignored.length, 0, '.DS_Store is skipped silently');
  const album = D.guessDrop(Array.from({ length: 8 }, (_, i) => f(`track ${i + 1}.mp3`, MP3())));
  assert.equal(album.format, 'album'); assert.equal(album.tracks[7].title, 'track 8', 'nothing but a number left → keep the file name');
  assert.equal(D.TRACK_COUNT.album[0] <= 8 && 8 <= D.TRACK_COUNT.album[1], true);
});

test('detect: folder with index.html = game (images stay as game files); pdf/epub = book with preview; pictures only asks once', () => {
  const g = D.guessDrop([f('index.html', enc('<!doctype html>')), f('js/game.js', enc('1')), f('img/shot1.png', PNG(1)), f('sub/index.html', enc('<p>'))], 'Star Run');
  assert.equal(g.type, 'game'); assert.equal(g.entry, 'index.html'); assert.equal(g.cover, null); assert.equal(g.files.length, 4);
  const b = D.guessDrop([f('sea.epub', EPUB()), f('sea-sample.pdf', PDF('p')), f('front.png', PNG(2))]);
  assert.equal(b.type, 'book'); assert.equal(b.bookFile, 'sea.epub'); assert.equal(b.bookPreview, 'sea-sample.pdf'); assert.equal(b.cover?.path, 'front.png');
  const b2 = D.guessDrop([f('book.pdf', PDF('long long long long long')), f('preview.pdf', PDF('p'))]);
  assert.equal(b2.bookFile, 'book.pdf'); assert.equal(b2.bookPreview, 'preview.pdf');
  const pics = D.guessDrop([f('a.png', PNG(1)), f('b.png', PNG(2))]);
  assert.equal(pics.confidence, 'ask'); assert.deepEqual(pics.options, ['digital', 'ticket']);
  const txt = D.guessDrop([f('poem.txt', enc('hello'))]);
  assert.equal(txt.type, 'digital'); assert.equal(txt.confidence, 'sure');
});

test('detect: executables, archives and unknown files are refused with a reason; mixed kinds ask with only possible options', () => {
  const r = D.guessDrop([f('setup.exe', enc('MZ')), f('pack.zip', Uint8Array.from([0x50, 0x4b, 3, 4])), f('evil.pdf', enc('MZ not a pdf')), f('song.mp3', MP3())]);
  assert.equal(r.type, 'music'); assert.equal(r.files.length, 1);
  assert.equal(r.ignored.length, 3); assert.ok(r.ignored.every(i => i.say.length > 5));
  const mixed = D.guessDrop([f('song.mp3', MP3()), f('book.pdf', PDF('x'))]);
  assert.equal(mixed.confidence, 'ask'); assert.deepEqual(mixed.options, ['digital']);
  const none = D.guessDrop([f('a.mp3', MP3()), f('b.html', enc('<p>'))]);
  assert.equal(none.type, 'game', 'html wins: a game folder may contain sounds');
  const dup = D.guessDrop([f('노래.mp3', MP3()), f('노래 .mp3', MP3())]);
  assert.equal(new Set(dup.files.map(x => x.path)).size, 2, 'renamed collisions get _2');
  assert.equal(D.safeName('../../etc/passwd'), 'etc/passwd'); assert.equal(D.safeName('스크린 샷.PNG'), 'file.png');
});

test('pasted IPFS address: ipfs://, bare Qm, gateway URL accepted; CIDv1 and junk refused with a reason', () => {
  const cid = 'Qm' + 'a'.repeat(44);
  for (const s of [cid, `ipfs://${cid}`, ` https://gw.example/ipfs/${cid}/x `]) assert.deepEqual(D.parsePastedCid(s), { ok: true, cid });
  assert.equal(D.parsePastedCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi').ok, false);
  assert.match(D.parsePastedCid('hello').say, /IPFS/);
});

test('themes: every text pair in every fixed theme is ≥ 4.5:1; templates fit their kinds; defaults per kind', () => {
  for (const [id, t] of Object.entries(D.THEMES)) for (const [pair, ratio] of D.themePairs(t)) assert.ok(ratio >= 4.5, `${id} ${pair} ${ratio.toFixed(2)}`);
  assert.equal(D.TEMPLATE_IDS.length, 7); assert.equal(D.THEME_IDS.length, 7);
  assert.equal(D.defaultTemplate('music', 'single'), 'single'); assert.equal(D.defaultTemplate('music', 'album'), 'album');
  assert.equal(D.defaultTemplate('game'), 'gallery'); assert.equal(D.defaultTemplate('ticket'), 'event'); assert.equal(D.defaultTemplate('shop'), 'shop');
  for (const k of ['game', 'music', 'book', 'ticket', 'digital']) assert.ok(D.templatesFor(k).includes('basic'));
});

test('look: only safe values — fixed template/theme ids, plain text (no bidi overrides), image refs inside the product', () => {
  const imgs = new Set(['cover.png', 'bg.png']);
  const ok = { template: 'album', theme: 'night', tagline: 'Songs for a rainy day', coverImage: 'cover.png', background: 'bg.png', gallery: [] };
  assert.deepEqual(D.validateLook(ok, 'music', imgs), ok);
  const bad = (patch, kind = 'music', why) => assert.throws(() => D.validateLook({ ...ok, ...patch }, kind, imgs), e => e.name === 'LookError' && (!why || e.detail === why));
  bad({ template: 'album' }, 'book', 'template-kind');
  bad({ template: '<script>' }, 'music', 'template');
  bad({ theme: 'url(javascript:1)' }, 'music', 'theme');
  bad({ tagline: 'evil‮gnp.exe' }, 'music', 'tagline');
  bad({ coverImage: 'https://evil.example/x.png' }, 'music', 'image-ref');
  assert.throws(() => D.validateLook({ ...ok, html: '<b>x</b>' }, 'music', imgs), /keys/);
  assert.deepEqual(D.parseTags(' #rain, Rain, 숲 , <b>, a,b,c,d'), ['rain', '숲', 'b']);
  assert.equal(D.safeImageUrl('javascript:alert(1)'), false); assert.equal(D.safeImageUrl('blob:http://127.0.0.1:1/abc-def'), true);
  assert.equal(D.safeImageUrl('data:image/svg+xml;base64,PHN2Zz4='), false, 'SVG data URLs can carry script');
});

async function musicInput(asset = 'RV.M.RAIN_EP') {
  const t1 = MP3(), t2 = MP3();
  return {
    input: { type: 'music', asset, title: 'Rain EP', description: '두 곡', files: [{ path: 'one.mp3', bytes: t1, mime: 'audio/mpeg' }, { path: 'two.mp3', bytes: t2, mime: 'audio/mpeg' }, { path: 'cover.png', bytes: PNG(9), mime: 'image/png', role: 'cover' }],
      creatorAddress: ADDRESS, receivingAddress: ADDRESS, priceAtoms: '1500000000', declaredFeeBps: 1500, details: { previewFile: 'one.mp3', previewStartMs: 0, previewEndMs: 30000 }, now: new Date('2026-10-11T00:00:00Z') },
    tracks: [{ path: 'one.mp3', title: '하나', durationMs: 180000 }, { path: 'two.mp3', title: '둘', durationMs: null }],
  };
}

test('manifest v3: look + tracks signed under the V3 domain, verified like v2, readable next to v2; v2 stays the default', async () => {
  assert.equal(D.DROP_MANIFEST_V3_ENABLED, false, 'v3 publishing stays off until the wallet repo reads it');
  const { input, tracks } = await musicInput();
  const pin = new D.MockPinAdapter();
  const look = { template: 'album', theme: 'forest', tagline: '비 오는 날', coverImage: 'cover.png', background: 'bg.png', gallery: [], imageFiles: [{ path: 'bg.png', bytes: PNG(7), mime: 'image/png' }] };
  const r = await D.publishV3(input, { look, genre: { main: 'ccm', tags: ['비', 'piano'] }, music: D.musicExtFrom('ep', tracks, { startMs: 0, endMs: 30000 }) }, pin, signer);
  const v = D.verifyManifestV3(r.manifestBytes, { expectedAsset: 'RV.M.RAIN_EP' });
  assert.equal(v.signedBy, ADDRESS); assert.equal(v.manifest.version, 3); assert.equal(v.manifest.look.images.length, 1);
  assert.deepEqual(v.manifest.music.tracks.map(t => t.title), ['하나', '둘']);
  assert.deepEqual(v.manifest.genre, { main: 'ccm', tags: ['비', 'piano'] });
  assert.ok(pin.stored.has(r.manifestCid), 'v3 manifest pinned'); assert.ok(pin.stored.has(v.manifest.look.images[0].cid), 'decoration image pinned');
  assert.ok(![...pin.stored.values()].some(b => { try { return JSON.parse(new TextDecoder().decode(b)).version === 2; } catch { return false; } }), 'the intermediate v2 manifest is not pinned');
  const any3 = D.readManifestAny(r.manifestBytes); assert.equal(any3.version, 3); assert.equal(any3.look.template, 'album');
  // A v2 manifest of the same content still reads, with no look.
  const v2 = await D.publishContent(input, new D.MockPinAdapter(), signer);
  const any2 = D.readManifestAny(v2.manifestBytes); assert.equal(any2.version, 2); assert.equal(any2.look, null);
  // Today's v2-only reader (vendored core) refuses v3 — the reason the switch is off.
  assert.throws(() => D.verifyManifest(r.manifestBytes), /manifest-shape/);
  // v3 → v2 (decoration dropped) re-signs into a valid v2.
  const down = D.toV2Unsigned(D.unsignedV3(r.manifest));
  const re = D.withSignature(down, ADDRESS, D.signMessageForTest(D.manifestSigningMessage(down), KEY));
  assert.equal(D.verifyManifest(D.encodeManifest(re)).signedBy, ADDRESS);
});

test('manifest v3: tampering and inconsistent fields are refused', async () => {
  const { input, tracks } = await musicInput();
  const r = await D.publishV3(input, { look: null, music: D.musicExtFrom('ep', tracks, { startMs: 0, endMs: 30000 }) }, new D.MockPinAdapter(), signer);
  const m = JSON.parse(new TextDecoder().decode(r.manifestBytes));
  const resign = doc => { const u = D.unsignedV3(doc); return { ...u, signature: { ...doc.signature, value: D.signMessageForTest(D.signingMessageV3(u), KEY) } }; };
  const bytes = doc => new TextEncoder().encode(D.canonicalJson(doc));
  // Changing the look after signing breaks the signature.
  assert.throws(() => D.verifyManifestV3(bytes({ ...m, look: null, music: { ...m.music, format: 'ep' }, title: 'Other' })), /manifest-signature/);
  const reject = (doc, re) => assert.throws(() => D.validateManifestV3(resign(doc)), re);
  reject({ ...m, music: { ...m.music, tracks: m.music.tracks.slice(0, 1) } }, /v3-music-count|v3-track-missing/);
  reject({ ...m, music: { format: 'album', tracks: m.music.tracks } }, /v3-music-count/);
  reject({ ...m, music: { ...m.music, tracks: [{ ...m.music.tracks[0], preview: null }, { ...m.music.tracks[1], preview: { startMs: 0, endMs: 30000 } }] } }, /v3-music-v2-preview/);
  reject({ ...m, music: { ...m.music, tracks: [{ ...m.music.tracks[0], title: 'x‮' }, m.music.tracks[1]] } }, /v3-track-title/);
  reject({ ...m, music: { ...m.music, tracks: [{ ...m.music.tracks[0], preview: { startMs: 170000, endMs: 200000 } }, m.music.tracks[1]] } }, /v3-track-preview-past-end|v3-music-v2-preview/);
  reject({ ...m, music: null }, /v3-music-required/);
  reject({ ...m, genre: { main: 'action', tags: [] } }, /v3-genre-main/);
  reject({ ...m, genre: { main: 'pop', tags: ['a', 'b', 'c', 'd'] } }, /v3-genre-tags/);
  reject({ ...m, genre: { main: 'pop' } }, /v3-genre-keys/);
  reject({ ...m, look: { template: 'book', theme: 'paper', tagline: '', coverImage: null, background: null, gallery: [], images: [] } }, /v3-look-template-kind/);
  reject({ ...m, look: { template: 'album', theme: 'paper', tagline: '', coverImage: null, background: null, gallery: [], images: [], css: 'x' } }, /v3-look-keys/);
  reject({ ...m, extra: 1 }, /manifest-shape/);
  assert.throws(() => D.validateManifestV3({ ...m, signature: { ...m.signature, domain: 'RAVENVAULT-CREATOR-MANIFEST-V2' } }), /v3-signature-shape/);
});

const okGate = (patch = {}) => ({
  input: { type: 'book', asset: 'RV.B.SEA_BOOK', title: '바다 책', description: '', files: [{ path: 'sea.pdf', bytes: PDF('x'), mime: 'application/pdf' }],
    creatorAddress: ADDRESS, receivingAddress: ADDRESS, priceAtoms: '2000000000', declaredFeeBps: 1500,
    details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: null, previewPages: 0, pageCount: null }, now: new Date() },
  nameTaken: false, neighbors: [], chain: 'regtest', chainBurnRvn: null, balanceAtoms: 600n * 100000000n, pastedCids: [], ...patch,
});
const blockIds = g => D.dropGates(g).blockers.map(c => c.id);

test('safety gates: same checks as the wizard — taken/unknown name, burn mismatch, mainnet lock, dead CID, balance, bad files', () => {
  const ok = D.dropGates(okGate());
  assert.equal(ok.canPublish, true, JSON.stringify(ok.blockers));
  assert.equal(ok.chips.find(c => c.id === 'burn').status, 'warn', 'burn amount shown as 「확인 불가」, not hidden');
  assert.deepEqual(blockIds(okGate({ nameTaken: true })), ['chain-name']);
  assert.deepEqual(blockIds(okGate({ nameTaken: null })), ['chain-name']);
  assert.match(D.dropGates(okGate({ nameTaken: null })).blockers[0].say, /확인 불가/);
  assert.deepEqual(blockIds(okGate({ nameTaken: 'checking' })), ['chain-name']);
  assert.deepEqual(blockIds(okGate({ chainBurnRvn: 400 })), ['burn']);
  assert.equal(D.dropGates(okGate({ chainBurnRvn: 500 })).chips.find(c => c.id === 'burn').status, 'pass');
  assert.deepEqual(blockIds(okGate({ chain: 'main' })), ['network']);
  assert.equal(D.dropGates(okGate({ chain: 'main', realMainnetEnabled: true })).canPublish, true);
  assert.deepEqual(blockIds(okGate({ chain: 'unknown' })), ['network']);
  assert.deepEqual(blockIds(okGate({ pastedCids: [{ cid: 'Qm' + 'b'.repeat(44), alive: false }] })), ['cid']);
  assert.deepEqual(blockIds(okGate({ balanceAtoms: 10n })), ['balance']);
  assert.equal(D.dropGates(okGate({ balanceAtoms: null })).canPublish, true, 'unknown balance warns; issuing re-checks');
  assert.deepEqual(blockIds(okGate({ neighbors: [{ asset: 'RV.B.SEA_BOOK' }] })), ['chain-name'], 'exact neighbour = taken');
  const look = D.dropGates(okGate({ input: { ...okGate().input, asset: 'RV.B.PLAYX_OFFICIAL' }, neighbors: [{ asset: 'RV.B.SEA_B00K' }] }));
  assert.equal(look.chips.find(c => c.id === 'lookalike').status, 'warn'); assert.equal(look.canPublish, true, 'lookalike/official warns, does not block');
  const bad = okGate(); bad.input = { ...bad.input, files: [{ path: 'sea.pdf', bytes: enc('MZ'), mime: 'application/pdf' }] };
  assert.ok(blockIds(bad).includes('files'));
  const wrongKind = okGate(); wrongKind.input = { ...wrongKind.input, asset: 'RV.M.SEA_BOOK' };
  assert.ok(blockIds(wrongKind).includes('name'), 'kind letter must match the kind');
  const longTitle = okGate(); longTitle.input = { ...longTitle.input, title: 'x'.repeat(81) };
  assert.match(D.dropGates(longTitle).blockers.map(b => b.say).join(), /80자/, 'manifest limit caught before upload');
  const pre = D.dropGates({ ...okGate(), prepublished: { asset: 'RV.B.SEA_BOOK' }, input: { ...okGate().input, files: [] } });
  assert.equal(pre.canPublish, true, 'pasted, already-verified manifest needs no local files');
  assert.deepEqual(blockIds({ ...okGate({ nameTaken: null }), prepublished: { asset: 'RV.B.SEA_BOOK' } }), ['chain-name'], 'pasted manifest still needs the chain lookup');
  const noAddr = okGate(); noAddr.input = { ...noAddr.input, creatorAddress: '', receivingAddress: '' };
  assert.ok(blockIds(noAddr).includes('info'));
  const ticket = okGate(); ticket.input = { ...ticket.input, type: 'ticket', asset: 'RV.T.SHOW', files: [], details: { eventName: 'Show', startsAt: '2020-01-01T00:00:00Z', endsAt: null, venue: 'Hall', quantity: 10, redemption: { method: 'creator-signed-code', checkerAddress: ADDRESS }, refundPolicy: 'none', contact: 'a@b.c' } };
  assert.match(D.dropGates(ticket).blockers.map(b => b.say).join(), /이미 지났어요/);
  const game = okGate(); game.input = { ...game.input, type: 'game', asset: 'RV.G.STAR', files: [{ path: 'index.html', bytes: enc('<!doctype html>'), mime: 'text/html' }], details: { entry: 'index.html', origin: null, capabilities: { identity: false, payment: false } }, priceAtoms: null };
  assert.equal(D.dropGates(game).chips.find(c => c.id === 'runs-code').status, 'warn');
  // The final authority after upload is core planIssue: it agrees on the locks.
  const plan = D.planIssue({ asset: 'RV.B.SEA_BOOK', manifestCid: 'Qm' + 'c'.repeat(44), chain: 'main', ownedAssets: [], nameTaken: null, chainBurnRvn: null, typedName: 'RV.B.SEA_BOOK', type: 'book' });
  assert.equal(plan.canIssue, false); assert.equal(plan.blockers.length, 2);
});

test('state machine: drop/pick/paste → detect → preview → confirm (cancel) → publishing → done; publishing ignores new drops', () => {
  const run = (...evs) => evs.reduce((s, e) => D.nextState(s, e), 'idle');
  assert.equal(run('drop', 'detected'), 'preview');
  assert.equal(run('pick', 'unsure', 'answer'), 'preview');
  assert.equal(run('drop', 'detected', 'publish', 'cancel'), 'preview');
  assert.equal(run('drop', 'detected', 'publish', 'confirm', 'issued'), 'done');
  assert.equal(run('drop', 'detected', 'publish', 'confirm', 'drop'), 'publishing', 'a new drop never replaces an upload in progress');
  assert.equal(D.acceptsDrop('publishing'), false); assert.equal(D.acceptsDrop('confirm'), false);
  assert.equal(run('drop', 'detected', 'publish', 'confirm', 'failed'), 'preview', 'failure returns to preview (resume with cache)');
  assert.equal(run('drop', 'detected', 'blocked', 'publish'), 'blocked', 'blocked cannot publish');
  assert.equal(run('drop', 'detected', 'blocked', 'unblocked', 'publish'), 'confirm');
  assert.equal(run('resume'), 'preview');
  for (const [from, edges] of Object.entries(D.DROP_TRANSITIONS)) for (const to of Object.values(edges)) assert.ok(to in D.DROP_TRANSITIONS, `${from} → ${to}`);
});

test('copy: ko/en/de/ru have every key; pseudo-localisation stretches by the factor', () => {
  const keys = Object.keys(D.DROP_COPY.ko);
  for (const l of D.DROP_LANGS) { assert.deepEqual(Object.keys(D.DROP_COPY[l]).sort(), [...keys].sort(), l); for (const k of keys) assert.ok(D.DROP_COPY[l][k].length > 0, `${l}.${k}`); }
  assert.equal(D.copy('ko', 'doneSay', { name: 'RV.M.X' }), '장터에서 「RV.M.X」(으)로 찾을 수 있어요.');
  const s = '여기에 놓으면 상품이 만들어져요';
  assert.ok(D.stretchText(s, 1.6).length >= s.length * 1.6); assert.ok(D.stretchText(s, 2).length >= s.length * 2);
});

test('genre: fixed list per kind (incl. proposed video), ≤3 free tags, not in the asset name; Ravi only suggests', () => {
  for (const k of ['music', 'game', 'book', 'ticket', 'digital', 'video']) {
    const ids = D.GENRES[k].map(g => g.id);
    assert.equal(new Set(ids).size, ids.length, k); assert.ok(ids.includes('other'), k);
  }
  assert.ok(['pop', 'hiphop', 'classical', 'ccm'].every(id => D.GENRES.music.some(g => g.id === id)));
  assert.ok(['action', 'puzzle', 'raising'].every(id => D.GENRES.game.some(g => g.id === id)));
  assert.ok(['concert', 'talk', 'meetup'].every(id => D.GENRES.ticket.some(g => g.id === id)));
  assert.ok(['lecture', 'workout', 'film', 'docu', 'kids'].every(id => D.GENRES.video.some(g => g.id === id)));
  assert.deepEqual(D.validateGenre({ main: 'hiphop', tags: ['밤', 'lofi'] }, 'music'), { main: 'hiphop', tags: ['밤', 'lofi'] });
  assert.deepEqual(D.validateGenre({ main: null, tags: [] }, 'book'), { main: null, tags: [] });
  assert.throws(() => D.validateGenre({ main: 'hiphop', tags: [] }, 'book'), /main/);
  assert.throws(() => D.validateGenre({ main: null, tags: ['x\u202E'] }, 'book'), /tags/);
  assert.equal(D.suggestGenre('music', { title: 'Midnight Rap Session' })?.id, 'hiphop');
  assert.equal(D.suggestGenre('music', { title: '주일 찬양 모음' })?.id, 'ccm');
  assert.equal(D.suggestGenre('ticket', { title: '가을 콘서트' })?.id, 'concert');
  assert.equal(D.suggestGenre('music', { title: 'trapdoor' }), null, 'whole words only for latin');
  assert.equal(D.suggestGenre('book', { title: '바다' }), null, 'no guess without evidence');
  assert.match(D.suggestGenre('game', { files: ['puzzle-01.png'] }).why, /puzzle/);
  assert.deepEqual(D.parseGenreTags('a, b, c, d'), ['a', 'b', 'c']);
});
