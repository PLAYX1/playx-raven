// Static guards for the automatic publish job in .github/workflows/release.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const publish = text.slice(text.indexOf('\n  publish:'));

test('publish job exists and pushes only when not a dry run', () => {
  assert.ok(publish.includes('node scripts/auto-publish-flow.mjs flow rel pub'));
  for (const name of ['Prepare release-repository credential', 'Publish the whole version in one commit', 'Verify public version and every updater URL']) {
    const at = publish.indexOf(`- name: ${name}`);
    assert.ok(at > 0, name);
    assert.match(publish.slice(at, at + 200), /if: \$\{\{ inputs\.dry_run != true \}\}/, `${name} must be skipped on dry runs`);
  }
  assert.doesNotMatch(publish, /if: \$\{\{ false \}\}/, 'the post-publish check must stay on');
});

test('the published dist branch is never cloned in full (it is >14GB)', () => {
  const at = publish.indexOf('- name: Read the published dist branch');
  assert.ok(at > 0);
  const block = publish.slice(at, publish.indexOf('- name: Prepare, sign and verify'));
  assert.match(block, /git clone --depth 1 --filter=blob:none --no-checkout --branch dist/);
  assert.match(block, /git read-tree HEAD/, 'the index must hold the whole tree or the commit would delete old releases');
});

test('the signing tool is installed before the sign step, without install scripts', () => {
  const install = publish.indexOf('- name: Install the signing tool');
  const sign = publish.indexOf('- name: Prepare, sign and verify');
  assert.ok(install > 0 && install < sign, 'tauri must be installed before signing');
  assert.match(publish.slice(install, sign), /npm ci --ignore-scripts/);
});

test('dry_run input defaults to true', () => {
  const at = text.indexOf('dry_run:');
  assert.ok(at > 0);
  assert.match(text.slice(at, at + 400), /default: true/);
});

test('only the known secret names are used', () => {
  const allowed = new Set(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8_BASE64', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'RELEASES_DEPLOY_KEY',
    // 윈도우 코드서명(11-14) — 수단별, 대표가 GitHub Secrets 에 직접 넣는다.
    'WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WINDOWS_SIGN_COMMAND']);
  for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) assert.ok(allowed.has(m[1]), `new secret name: ${m[1]}`);
});

test('the deploy key is used only by its own publish steps; the signing key only by the sign step', () => {
  assert.equal([...publish.matchAll(/secrets\.RELEASES_DEPLOY_KEY/g)].length, 1);
  const sign = publish.slice(publish.indexOf('- name: Prepare, sign and verify'), publish.indexOf('- name: List the signed release'));
  assert.match(sign, /secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
  const rest = publish.replace(sign, '');
  assert.doesNotMatch(rest, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(rest, /^\s+TAURI_SIGNING_PRIVATE_KEY/m);
});

test('no step prints a secret', () => {
  for (const line of text.split('\n')) {
    if (/^\s*(echo|printf|cat)\b/.test(line) && /\$\{?(KEY|TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?)\b/.test(line)) {
      assert.match(line, /> ~\/\.ssh\/id_ed25519/, `secret may be printed: ${line.trim()}`);
    }
    assert.doesNotMatch(line, /set -x/);
  }
});

test('publish is serialized and needs a successful build', () => {
  assert.match(text, /concurrency:\n  group: release\n  cancel-in-progress: false/);
  assert.match(publish, /needs: build\n(?:\s+#.*\n)*\s+if: success\(\)/);
});

test('Raspberry Pi target: the build matrix has a native ARM Linux entry and both --targets lists include linux-aarch64', () => {
  const entry = text.match(/- os: ubuntu-24\.04-arm\n\s+target: aarch64-unknown-linux-gnu\n\s+label: linux-arm64\n/);
  assert.ok(entry, 'matrix entry for ubuntu-24.04-arm / aarch64-unknown-linux-gnu / linux-arm64');
  assert.equal([...text.matchAll(/- os: ubuntu-latest\n\s+target: x86_64-unknown-linux-gnu\n\s+label: linux\n/g)].length, 1, 'PC Linux entry is unchanged');
  const lists = [...text.matchAll(/verify-published-release\.mjs "\$[A-Z_{}]+[^\n]*--targets ([^\s]+)/g)].map(m => m[1].split(','));
  assert.equal(lists.length, 2, 'verify job and post-publish check');
  for (const list of lists) assert.deepEqual(list, ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64']);
  assert.match(publish, /auto-publish-flow\.mjs flow rel pub/);
});

// ── 윈도우 코드서명 (2026-11-14) ──
const WIN_SECRETS = /secrets\.(WINDOWS_|AZURE_)/;
test('windows signing secrets stay in the build job, never in publish', () => {
  assert.doesNotMatch(publish, WIN_SECRETS);
});
test('windows signing: prepare → vendor exes → build → verify → collect, in that order', () => {
  const at = n => text.indexOf(`- name: ${n}`);
  const order = [at('윈도우 서명 준비'), at('윈도우 포함 실행 파일 서명'), at('다른 운영체제 만들기'), at('윈도우 서명 검증'), at('만든 것 모으기')];
  assert.ok(order.every(i => i > 0), 'all windows signing steps exist');
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], 'step order');
});
test('windows signing verify uses signtool verify /pa and fails the build on any failure', () => {
  const v = text.slice(text.indexOf('- name: 윈도우 서명 검증'), text.indexOf('- name: 만든 것 모으기'));
  assert.match(v, /verify \/pa/);
  assert.match(v, /exit 1/);
  assert.match(v, /ravend\.exe/);
  assert.match(v, /ipfs\.exe/);
  assert.match(v, /\.msi/);
  assert.match(v, /nsis/);
});
test('windows sign script always timestamps and verifies', async () => {
  const fs = await import('node:fs');
  const ps = fs.readFileSync(new URL('./windows-sign.ps1', import.meta.url), 'utf8');
  assert.equal([...ps.matchAll(/\/tr', \$ts|\/tr \$ts/g)].length, 2, 'pfx and azure both pass /tr');
  assert.match(ps, /verify \/pa/);
  assert.match(ps, /timestamp/);
});
test('macOS signing and updater signing are untouched by windows signing', () => {
  const mac = text.slice(text.indexOf('- name: 맥 서명·공증 재료 확인'), text.indexOf('- name: 맥 만들기·앱 서명·공증'));
  assert.doesNotMatch(mac, WIN_SECRETS);
  assert.doesNotMatch(text.slice(text.indexOf('- name: 맥 만들기·앱 서명·공증'), text.indexOf('- name: 다른 운영체제 만들기')), WIN_SECRETS);
});
