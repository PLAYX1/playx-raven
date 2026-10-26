// Synthetic browser/RPC boundaries only. Does not launch the app or a node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { test } from 'node:test';

async function load(file) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { uploadArtistPhoto, photoLimit, PhotoFailure, browserPhotoApi, PHOTO_MESSAGES } = await load('../src/artist-photo.ts');
const { seedUnlockButton, seedErrorKind, seedErrorMessage } = await load('../src/seed-recovery.ts');
const jpg = () => Object.assign(new Blob([Uint8Array.from([255, 216, 255, 1, 2])], { type: 'image/jpeg' }), { name: 'synthetic.jpg' });
const png = () => Object.assign(new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), { name: 'synthetic.png' });
const pending = () => new Promise(() => {});
const limits = { decode: 5, compress: 5, read: 5, upload: 5 };
function fixture(overrides = {}) {
  const uploads = [], progress = [], previews = [];
  let disposed = 0;
  const api = {
    bitmap: async () => ({ source: {}, width: 1200, height: 800, dispose: () => disposed++ }),
    image: async () => ({ source: {}, width: 800, height: 1200, dispose: () => disposed++ }),
    canvas: () => ({}), blob: async () => jpg(), dataBlob: async () => jpg(),
    preview: async () => 'data:image/jpeg;base64,synthetic', bytes: b => b.arrayBuffer(),
    upload: async file => { uploads.push(file); return { cid: 'synthetic-cid' }; }, ...overrides,
  };
  return { api, uploads, progress, previews, disposed: () => disposed,
    run: file => uploadArtistPhoto(file ?? jpg(), api, m => progress.push(m), d => previews.push(d), limits) };
}
test('normal crop upload and cleanup', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.original, false); assert.equal(f.disposed(), 1);
  assert.equal(f.uploads.length, 1); assert.equal(f.previews.length, 1);
  assert.deepEqual(result.diagnostics, []);
});
for (const [name, bitmap] of [['unsupported File decode', async () => { throw new TypeError('unsupported'); }], ['stalled bitmap', pending]]) {
  test(`${name} uses img.decode`, async () => {
    let called = 0; const f = fixture({ bitmap, image: async () => { called++; return { source: {}, width: 1, height: 1, dispose() {} }; } });
    const result = await f.run(); assert.equal(called, 1); assert.equal(result.original, false);
    assert.equal(result.diagnostics[0].stage, 'bitmap');
    assert.equal(result.diagnostics[0].timedOut, name === 'stalled bitmap');
  });
}
for (const [name, blob] of [['null toBlob', async () => { throw Error('null'); }], ['stalled toBlob', pending]]) {
  test(`${name} falls back to toDataURL`, async () => {
    let called = 0; const f = fixture({ blob, dataBlob: async () => { called++; return png(); } });
    const result = await f.run(); assert.equal(called, 1); assert.equal(result.original, false);
    assert.equal(f.uploads[0].name, 'face.png'); assert.equal(result.diagnostics[0].stage, 'compress');
  });
}
for (const [name, file, overrides] of [
  ['both decoders stall', jpg(), { bitmap: pending, image: pending }],
  ['both encoders stall', png(), { blob: pending, dataBlob: pending }],
  ['canvas drawing fails', jpg(), { canvas: () => { throw Error('canvas'); } }],
]) {
  test(`${name} uploads original bytes`, async () => {
    const f = fixture(overrides); const result = await f.run(file);
    assert.equal(result.original, true); assert.deepEqual(f.uploads[0].bytes, Array.from(new Uint8Array(await file.arrayBuffer())));
    assert.ok(result.diagnostics.length); assert.equal(result.cid, 'synthetic-cid');
  });
}
test('preview timeout still uploads and reports the failed stage', async () => {
  const f = fixture({ preview: pending }); const result = await f.run();
  assert.equal(f.uploads.length, 1); assert.equal(f.previews.length, 0);
  assert.equal(result.diagnostics[0].stage, 'preview'); assert.equal(result.diagnostics[0].timedOut, true);
});
for (const stage of ['bytes', 'upload']) test(`${stage} timeout ends with a stage-specific error`, async () => {
  const f = fixture({ [stage]: pending });
  await assert.rejects(f.run(), e => e instanceof PhotoFailure && e.stage === stage && e.timedOut);
});
test('missing CID and rejected upload have a safe message', async () => {
  for (const upload of [async () => ({}), async () => { throw Error('private-native-detail'); }]) {
    await assert.rejects(fixture({ upload }).run(), e => e instanceof PhotoFailure && e.stage === 'upload' && !String(e).includes('private-native-detail'));
  }
});
test('size, unsupported type, and original magic are checked before upload', async () => {
  const f = fixture({ bitmap: pending, image: pending });
  await assert.rejects(f.run(Object.assign(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), { name: 'big.jpg' })));
  await assert.rejects(f.run(Object.assign(new Blob(['svg'], { type: 'image/svg+xml' }), { name: 'no.svg' })));
  await assert.rejects(f.run(Object.assign(new Blob(['fake'], { type: 'image/jpeg' }), { name: 'fake.jpg' })));
  assert.equal(f.uploads.length, 0);
});
test('late bitmap is closed and cannot cause a second upload', async () => {
  let resolve, closed = 0;
  const f = fixture({ bitmap: () => new Promise(r => { resolve = r; }) });
  await f.run(); resolve({ source: {}, width: 1, height: 1, dispose: () => closed++ });
  await new Promise(r => setTimeout(r, 1)); assert.equal(closed, 1); assert.equal(f.uploads.length, 1);
});
test('time limiter handles sync throws, deadlines, and late completions', async () => {
  await assert.rejects(photoLimit(() => { throw Error('native'); }, 5, 'bytes'), e => e.stage === 'bytes' && !e.timedOut);
  await assert.rejects(photoLimit(pending, 5, 'upload'), e => e.stage === 'upload' && e.timedOut);
  assert.equal(await photoLimit(async () => 7, 5, 'bytes'), 7);
});
test('browser adapter rejects null toBlob and empty toDataURL', async () => {
  const api = browserPhotoApi(async () => ({}));
  await assert.rejects(api.blob({ toBlob: callback => callback(null) }));
  await assert.rejects(api.dataBlob({ toDataURL: () => 'data:,' }));
  assert.equal((await api.dataBlob({ toDataURL: () => 'data:image/jpeg;base64,/9j/AQI=' })).type, 'image/jpeg');
});
test('browser adapter crops the centre to 512 square and rejects a missing context', () => {
  const oldDocument = globalThis.document; const draws = [];
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args) }) };
  globalThis.document = { createElement: () => canvas };
  try {
    const api = browserPhotoApi(async () => ({})); const source = {};
    assert.equal(api.canvas({ source, width: 1200, height: 800 }), canvas);
    assert.deepEqual(draws, [[source, 200, 0, 800, 800, 0, 0, 512, 512]]);
    assert.equal(canvas.width, 512); assert.equal(canvas.height, 512);
    canvas.getContext = () => null;
    assert.throws(() => api.canvas({ source, width: 1, height: 1 }), e => e.stage === 'compress');
  } finally { globalThis.document = oldDocument; }
});
test('FileReader stall is aborted and its late callback never paints a preview', async () => {
  const oldReader = globalThis.FileReader; let aborted = 0;
  globalThis.FileReader = class {
    static LOADING = 1;
    readyState = 1;
    readAsDataURL() {}
    abort() { aborted++; this.readyState = 2; this.onabort(); }
  };
  try {
    await assert.rejects(browserPhotoApi(async () => ({})).preview(jpg(), 5), e => e.stage === 'preview' && e.timedOut);
    assert.equal(aborted, 1);
  } finally { globalThis.FileReader = oldReader; }
});
test('img.decode timeout and success both revoke object URLs', async () => {
  const oldImage = globalThis.Image, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const revoked = []; let decode = pending;
  globalThis.Image = class { naturalWidth = 2; naturalHeight = 3; decode() { return decode(); } };
  URL.createObjectURL = () => 'blob:synthetic'; URL.revokeObjectURL = u => revoked.push(u);
  try {
    const api = browserPhotoApi(async () => ({}));
    await assert.rejects(api.image(jpg(), 5), e => e.stage === 'image' && e.timedOut);
    decode = async () => {}; const d = await api.image(jpg(), 5); d.dispose();
    assert.deepEqual(revoked, ['blob:synthetic', 'blob:synthetic']);
  } finally { globalThis.Image = oldImage; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
test('locked inline control retries once only after successful unlock', async () => {
  const oldDocument = globalThis.document; let retries = 0, unlocks = 0;
  globalThis.document = { createElement: () => ({ disabled: false }) };
  try {
    const error = '[SEED_LOCKED] safe sentence'; const host = { append: b => { host.button = b; } };
    seedUnlockButton(host, error, async () => { unlocks++; return true; }, async () => { retries++; }, 'Unlock wallet');
    await host.button.onclick(); assert.equal(unlocks, 1); assert.equal(retries, 1);
    seedUnlockButton(host, error, async () => false, async () => { retries++; }, 'Unlock wallet');
    await host.button.onclick(); assert.equal(retries, 1); assert.equal(host.button.disabled, false);
    const absent = { append: () => assert.fail('non-locked failure must not offer unlock') };
    seedUnlockButton(absent, '[SEED_OTHER] safe', async () => true, async () => {}, 'Unlock wallet');
    assert.equal(seedErrorKind(error), 'LOCKED'); assert.equal(seedErrorMessage(error), 'safe sentence');
  } finally { globalThis.document = oldDocument; }
});
test('all photo error copy has translations in each language', () => {
  const copy = readFileSync(new URL('../src/desktop-copy.ts', import.meta.url), 'utf8');
  for (const message of Object.values(PHOTO_MESSAGES).flat()) assert.ok(copy.includes(JSON.stringify(message)), message);
});
test('actual artistSave wiring preserves the form and auto-publishes after unlock', async () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2020, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'artistSave');
  assert.ok(fn);
  const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const elements = {
    'ar-save': { textContent: 'publish', disabled: false },
    'ar-say': { append(b) { this.button = b; } },
    'ar-name': { value: 'Synthetic Artist' }, 'ar-about': { value: 'Synthetic About' },
    'ar-web': { value: 'https://example.invalid' },
  };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ disabled: false }) };
  const calls = []; let unlocks = 0, paints = 0;
  try {
    const save = new Function('$', 'invoke', 'setCopyText', 't', 'arNormWeb', 'addSeedUnlock', 'errText', 'escapeHtml', 'copyHtml', 'arPaintPreview',
      `let arPhotoBusy = false, arSaving = false, arPicture = 'https://example.invalid/photo'; ${js}; return artistSave;`)(
      id => elements[id], async (cmd, args) => {
        calls.push({ cmd, args });
        if (calls.length === 1) throw '[SEED_LOCKED] synthetic locked';
        return { ok: ['synthetic-relay'], failed: [] };
      }, (el, getText) => { el.textContent = getText(); }, s => s, s => s,
      (host, error, retry) => seedUnlockButton(host, error, async () => { unlocks++; return true; }, retry, 'Unlock wallet'),
      seedErrorMessage, s => s, s => s, () => { paints++; },
    );
    await save(); assert.equal(calls.length, 1); assert.equal(elements['ar-save'].disabled, false);
    assert.ok(elements['ar-say'].button);
    await elements['ar-say'].button.onclick();
    assert.equal(unlocks, 1); assert.equal(calls.length, 2); assert.equal(paints, 1);
    assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].cmd, 'artist_profile_set');
    assert.equal(calls[1].args.name, 'Synthetic Artist'); assert.equal(calls[1].args.picture, 'https://example.invalid/photo');
    assert.equal(elements['ar-save'].disabled, false); assert.equal(elements['ar-save'].textContent, 'publish');
  } finally { globalThis.document = oldDocument; }
});
