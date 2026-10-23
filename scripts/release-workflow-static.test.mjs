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
  const allowed = new Set(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8_BASE64', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'RELEASES_DEPLOY_KEY']);
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
