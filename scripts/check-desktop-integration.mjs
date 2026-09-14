import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build, transform } from 'esbuild';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let source = read('src/desktop-links.ts');
if (process.argv.includes('--mutant-link')) source = source.replace('https://ravenvault.ex.erci.se/wallet/', 'https://rvn.ex.erci.se/wallet');
const code = (await transform(source, { loader: 'ts', format: 'esm' })).code;
const links = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const opened = [];
await links.openRavenVaultWallet(async url => opened.push(url));
assert.deepEqual(opened, ['https://ravenvault.ex.erci.se/wallet/']);
assert.equal(links.LEGACY_LOCAL_WALLET, 'http://127.0.0.1:8790/wallet');
await assert.rejects(links.openRavenVaultWallet(async () => { throw Error('synthetic unavailable browser'); }));
console.log('PASS actual open adapter: canonical entry, no secret query, error propagated, legacy origin preserved');

const ui = read('src/main.ts'), html = read('index.html');
assert.match(ui, /rv-phone-open[\s\S]{0,100}addEventListener\("click", \(\) => void openWebWallet\(\)\)/);
assert.match(ui, /await openUrl\(LEGACY_LOCAL_WALLET\)/);
assert.doesNotMatch(html, /id="rv-webwallet"/);
assert.doesNotMatch(ui, /\$\("rv-webwallet"\)/);
assert.doesNotMatch(ui, /label: "RavenVault 웹 지갑"/);
assert.equal((html.match(/id="rv-phone-open"/g) || []).length, 1);
assert.match(html, /id="ravi-face" src="\/raven-hello.webp"/);
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const previous = JSON.parse(execFileSync('git', ['show', 'v0.3.8:src-tauri/tauri.conf.json'], { encoding: 'utf8' }));
assert.equal(config.productName, 'RavenVault Desktop');
assert.equal(config.app.windows[0].title, 'RavenVault Desktop');
assert.equal(config.identifier, previous.identifier);
assert.deepEqual(config.plugins.updater, previous.plugins.updater);
assert.match(read('src-tauri/Cargo.toml'), /name = "playx-raven"/);
assert.equal(read('src-tauri/src/paths.rs'), execFileSync('git', ['show', 'v0.3.8:src-tauri/src/paths.rs'], { encoding: 'utf8' }));
for (const path of ['src-tauri/src/mining.rs', 'src-tauri/src/ipfs.rs', 'src-tauri/src/boot.rs', 'src-tauri/src/auto.rs', 'src-tauri/src/shop.rs', 'src-tauri/src/auction.rs', 'src-tauri/src/artist.rs', 'web/wallet.src.ts', 'web/wallet.bundle.js', 'web/wallet.html', 'web/buy.html']) {
  const released = execFileSync('git', ['show', 'v0.3.8:' + path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(read(path), path.endsWith('.html') ? released.replaceAll('PLAY X Raven', 'RavenVault Desktop').replace(/<title>.*?<\/title>/, '<title>RavenVault</title>').replaceAll('content="RavenVault Desktop"', 'content="RavenVault"').replaceAll('content="RavenVault Desktop 지갑"', 'content="RavenVault 지갑"') : path.startsWith('web/') ? released.replaceAll('PLAY X Raven', 'RavenVault Desktop') : released, path + ' must preserve the released behavior');
}
console.log('PASS update identity/data paths + released node/mining/IPFS/shop/artist/auction/legacy wallet remain intact');

const compiled = await build({ entryPoints: [new URL('../src/dict.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { DICT } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const copyCode = (await transform(read('src/desktop-copy.ts'), { loader: 'ts', format: 'esm' })).code;
const { DESKTOP_COPY } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
for (const source of Object.keys(DESKTOP_COPY)) for (const language of ['en', 'ja', 'zh']) assert.ok(DICT[language][source] && DICT[language][source] !== source, language + ': ' + source);
console.log(`PASS ${Object.keys(DESKTOP_COPY).length} new phrases have English/Japanese/Chinese translations; Korean is the source`);
