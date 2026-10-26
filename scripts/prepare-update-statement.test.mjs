import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const script = new URL('./prepare-update-statement.py', import.meta.url).pathname;
const pad4 = n => (n + 3) & ~3;
const u16 = s => Buffer.from(s + '\0', 'utf16le');
function node(key, type, value, children = []) {
  const k = u16(key);
  let body = Buffer.concat([k]);
  body = Buffer.concat([body, Buffer.alloc(pad4(6 + body.length) - 6 - body.length)]);
  const valueLen = type === 1 ? value.length / 2 : value.length;
  body = Buffer.concat([body, value]);
  body = Buffer.concat([body, Buffer.alloc(pad4(6 + body.length) - 6 - body.length)]);
  for (const c of children) body = Buffer.concat([body, c, Buffer.alloc(pad4(c.length) - c.length)]);
  const head = Buffer.alloc(6); head.writeUInt16LE(6 + body.length, 0); head.writeUInt16LE(valueLen, 2); head.writeUInt16LE(type, 4);
  return Buffer.concat([head, body]);
}
function versionBlob(productString, fixed) {
  const ffi = Buffer.alloc(52);
  ffi.writeUInt32LE(0xFEEF04BD, 0); ffi.writeUInt32LE(0x10000, 4);
  if (fixed) { ffi.writeUInt32LE((fixed[0] << 16) | fixed[1], 16); ffi.writeUInt32LE((fixed[2] << 16) | fixed[3], 20); }
  const strings = productString === null ? [] : [node('ProductVersion', 1, u16(productString))];
  const table = node('040904b0', 1, Buffer.alloc(0), strings);
  const sfi = node('StringFileInfo', 1, Buffer.alloc(0), [table]);
  return node('VS_VERSION_INFO', 0, ffi, [sfi]);
}
/** Minimal synthetic PE32+ (x64) with one .rsrc section holding a RT_VERSION resource. */
function syntheticPe({ product = '0.9.6', fixed = [0, 9, 6, 0], machine = 0x8664, noResource = false } = {}) {
  const blob = versionBlob(product, fixed);
  const rsrc = Buffer.alloc(88 + blob.length);
  rsrc.writeUInt16LE(1, 14); rsrc.writeUInt32LE(16, 16); rsrc.writeUInt32LE((24 | 0x80000000) >>> 0, 20);
  rsrc.writeUInt16LE(1, 24 + 14); rsrc.writeUInt32LE(1, 40); rsrc.writeUInt32LE((48 | 0x80000000) >>> 0, 44);
  rsrc.writeUInt16LE(1, 48 + 14); rsrc.writeUInt32LE(0x409, 64); rsrc.writeUInt32LE(72, 68);
  rsrc.writeUInt32LE(0x1000 + 88, 72); rsrc.writeUInt32LE(blob.length, 76);
  blob.copy(rsrc, 88);
  const file = Buffer.alloc(0x200 + rsrc.length);
  file.write('MZ', 0); file.writeUInt32LE(64, 0x3C); file.write('PE\0\0', 64);
  file.writeUInt16LE(machine, 68); file.writeUInt16LE(1, 70); file.writeUInt16LE(240, 84);
  file.writeUInt16LE(0x20b, 88);
  if (!noResource) { file.writeUInt32LE(0x1000, 88 + 112 + 16); file.writeUInt32LE(rsrc.length, 88 + 112 + 20); }
  const sec = 88 + 240;
  file.write('.rsrc', sec); file.writeUInt32LE(rsrc.length, sec + 8); file.writeUInt32LE(0x1000, sec + 12);
  file.writeUInt32LE(rsrc.length, sec + 16); file.writeUInt32LE(0x200, sec + 20);
  rsrc.copy(file, 0x200);
  return file;
}
function syntheticAppImage({ machine = 62, ai = true } = {}) {
  const b = Buffer.alloc(4096);
  b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b[6] = 1;
  if (ai) { b[8] = 0x41; b[9] = 0x49; b[10] = 2; }
  b.writeUInt16LE(machine, 18);
  return b;
}
async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rv-prep-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const run = (pkg, target, version, out, extra = []) => spawnSync('python3', ['-I', script, pkg, '--target', target, ...(version ? ['--version', version] : []), '--sequence', '5', '--expires', '4102444800', '--output', out, ...extra], { encoding: 'utf8' });

test('windows: matching PE ProductVersion produces the statement input with exact keys', () => withDir(async dir => {
  const exe = path.join(dir, 'RavenVault-Desktop-0.9.6-windows.exe'); await writeFile(exe, syntheticPe());
  const out = path.join(dir, 'windows-x86_64.json'), r = run(exe, 'windows-x86_64', '0.9.6', out);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(Object.keys(s), ['version', 'sha256', 'target', 'expires', 'sequence']);
  assert.equal(s.target, 'windows-x86_64'); assert.equal(s.version, '0.9.6'); assert.match(s.sha256, /^[a-f0-9]{64}$/);
  assert.match(r.stdout, /matches 0\.9\.6/);
}));
test('windows: four-part ProductVersion 0.9.6.0 is accepted; version mismatch, fixed-vs-string mismatch, missing --version are refused', () => withDir(async dir => {
  const exe = path.join(dir, 'a.exe'), out = path.join(dir, 'o.json');
  await writeFile(exe, syntheticPe({ product: '0.9.6.0' }));
  assert.equal(run(exe, 'windows-x86_64', '0.9.6', out).status, 0);
  assert.notEqual(run(exe, 'windows-x86_64', '0.9.7', path.join(dir, 'm.json')).status, 0);
  await writeFile(exe, syntheticPe({ product: '0.9.6', fixed: [0, 9, 5, 0] }));
  const r = run(exe, 'windows-x86_64', '0.9.6', path.join(dir, 'f.json')); assert.notEqual(r.status, 0); assert.match(r.stderr, /mismatch/);
  assert.notEqual(run(exe, 'windows-x86_64', null, path.join(dir, 'n.json')).status, 0);
  assert.equal((await readdir(dir)).filter(n => n === 'm.json' || n === 'f.json' || n === 'n.json').length, 0, 'no statement input is written on failure');
}));
test('windows: truncated, non-PE, wrong machine, no resource and .msi files are refused', () => withDir(async dir => {
  const out = path.join(dir, 'o.json'), good = syntheticPe();
  for (const [name, bytes] of [['trunc.exe', good.subarray(0, 0x210)], ['short.exe', good.subarray(0, 100)], ['text.exe', Buffer.from('not an exe at all'.repeat(10))],
    ['arm.exe', syntheticPe({ machine: 0xAA64 })], ['nores.exe', syntheticPe({ noResource: true })], ['nover.exe', syntheticPe({ product: null, fixed: null })], ['x.msi', good]]) {
    const f = path.join(dir, name); await writeFile(f, bytes);
    const r = run(f, 'windows-x86_64', '0.9.6', out);
    assert.notEqual(r.status, 0, name); assert.match(r.stderr, /error/, name);
  }
  await assert.rejects(readFile(out));
}));
test('linux: AppImage markers + file name accepted and the output says the inner version is not checked', () => withDir(async dir => {
  const f = path.join(dir, 'RavenVault-Desktop-0.9.6-linux.AppImage'); await writeFile(f, syntheticAppImage());
  const out = path.join(dir, 'linux-x86_64.json'), r = run(f, 'linux-x86_64', '0.9.6', out);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NOT checked/);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).target, 'linux-x86_64');
}));
test('linux: wrong name version, non-ELF, wrong machine, no AppImage marker, truncated and missing --version are refused', () => withDir(async dir => {
  const out = path.join(dir, 'o.json');
  const cases = [['RavenVault-Desktop-0.9.5-linux.AppImage', syntheticAppImage()], ['RavenVault-Desktop-10.9.6-linux.AppImage', syntheticAppImage()],
    ['RavenVault-Desktop-0.9.6-linux.AppImage', Buffer.from('plain text'.repeat(10))], ['RavenVault-Desktop-0.9.6-linux.AppImage', syntheticAppImage({ machine: 183 })],
    ['RavenVault-Desktop-0.9.6-linux.AppImage', syntheticAppImage({ ai: false })], ['RavenVault-Desktop-0.9.6-linux.AppImage', syntheticAppImage().subarray(0, 12)],
    ['RavenVault-Desktop-0.9.6-linux.deb', syntheticAppImage()]];
  for (const [name, bytes] of cases) { const f = path.join(dir, name); await writeFile(f, bytes); assert.notEqual(run(f, 'linux-x86_64', '0.9.6', out).status, 0, name); }
  const f = path.join(dir, 'RavenVault-Desktop-0.9.6-linux.AppImage'); await writeFile(f, syntheticAppImage());
  assert.notEqual(run(f, 'linux-x86_64', null, out).status, 0);
  await assert.rejects(readFile(out));
}));
test('mac behavior is unchanged: darwin choices still exist and a non-tarball is refused', () => withDir(async dir => {
  const f = path.join(dir, 'x.tar.gz'); await writeFile(f, 'not gzip');
  const r = run(f, 'darwin-aarch64', null, path.join(dir, 'o.json'));
  assert.notEqual(r.status, 0);
  assert.notEqual(run(f, 'darwin-x86_64', null, path.join(dir, 'o.json'), ['--bogus']).status, 0);
}));
test('real 0.9.5 NSIS installer from the trial build reads as 0.9.5 (skipped when not present)', async t => {
  const base = path.join(homedir(), 'Downloads', 'rv-095b-win');
  let exe = null;
  try { for (const d of await readdir(base)) if (d.includes('windows')) for (const n of await readdir(path.join(base, d))) if (n.endsWith('x64-setup.exe')) exe = path.join(base, d, n); } catch {}
  if (!exe) return t.skip('trial installer not present');
  await withDir(async dir => {
    const r = run(exe, 'windows-x86_64', '0.9.5', path.join(dir, 'o.json'));
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(run(exe, 'windows-x86_64', '0.9.4', path.join(dir, 'p.json')).status, 0);
  });
});
