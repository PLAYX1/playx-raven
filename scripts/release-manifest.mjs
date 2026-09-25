import { readdir, readFile, stat, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const installerSuffixes = ['windows.exe','windows.msi','mac-apple-silicon.dmg','mac-intel.dmg','linux.AppImage'];
const platforms = { 'windows.exe':'windows-x86_64', 'mac-apple-silicon.tar.gz':'darwin-aarch64', 'mac-intel.tar.gz':'darwin-x86_64', 'linux.AppImage':'linux-x86_64' };
export async function prepareRelease(source, destination, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid release version');
  const files = (await readdir(source)).sort();
  const prefix = files.some(name => name.startsWith(`RavenVault-Desktop-${version}-`)) ? `RavenVault-Desktop-${version}-` : `PLAY-X-Raven-${version}-`;
  const required = [...new Set([...installerSuffixes, ...Object.keys(platforms)])];
  for (const suffix of required) if (!files.includes(prefix + suffix)) throw new Error(`Missing installer: ${suffix}`);
  for (const suffix of Object.keys(platforms)) if (!files.includes(prefix + suffix + '.sig')) throw new Error(`Missing updater signature: ${suffix}`);
  const assets = [];
  for (const name of files) {
    if (!name.startsWith(prefix) || !/^(?:RavenVault-Desktop|PLAY-X-Raven)-[\d.]+-(?:windows|mac-apple-silicon|mac-intel|linux)\.(?:exe|msi|dmg|AppImage|deb|rpm|tar\.gz)(?:\.sig)?$/.test(name)) throw new Error(`Unexpected release file: ${name}`);
    const info = await stat(path.join(source, name));
    if (!info.isFile() || info.size < 1 || info.size >= 95_000_000) throw new Error(`Unsupported release file size: ${name}`);
    const data = await readFile(path.join(source, name));
    assets.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  // Never replace a previously published version. Old updater metadata stays usable.
  const versionDir = path.join(destination, `v${version}`);
  try { await stat(versionDir); throw new Error('Version already exists; use a new version'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    const current = JSON.parse(await readFile(path.join(destination, 'latest.json'), 'utf8')).version;
    if (typeof current !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) throw new Error('Invalid currently published version');
    const old = current.split('.').map(Number), next = version.split('.').map(Number);
    if (next.reduce((order, n, i) => order || Math.sign(n - old[i]), 0) <= 0) throw new Error('Release must be newer than the currently published version');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const base = `https://raw.githubusercontent.com/PLAYX1/playx-raven-releases/dist/v${version}`;
  const manifest = { version, notes: 'RavenVault Desktop 0.4.9 — 0.4.8 다음 판입니다. 12단어로 지갑 되살리기: 복구 단어(12·24단어)만 적어 둔 분도 데스크톱에서 지갑을 되살릴 수 있습니다. 첫 질문 「복구 단어 12개로」, 지갑 메뉴, 백업 되돌리기 화면에서 시작합니다. 단어를 칠 때 자동 완성과 단어 목록·체크섬 검사를 해서 틀린 단어를 그 자리에서 알려 줍니다. 폰·웹 RavenVault 와 같은 단어면 같은 주소가 나옵니다. 지금 쓰는 지갑은 지우거나 덮지 않고 옆에 둡니다 — 돈이 있는 지갑이면 백업을 먼저 권합니다. 되살린 뒤 옛 거래를 다시 찾아 잔액·자산·증서를 보여 줍니다(장부 전체를 가진 컴퓨터는 30분~2시간, 가게 모드는 마감 뒤가 기본). 단어는 화면 캡처가 막히고, 시작을 누르면 칸에서 지워지며, 로그·오류 보고·파일 어디에도 남지 않습니다. 되살린 뒤에는 지갑 암호를 걸어 두세요. 기존 지갑·가게 데이터 위치는 그대로입니다.', pub_date: new Date().toISOString(), platforms: {}, installers: [] };
  for (const [suffix, platform] of Object.entries(platforms)) {
    const signature = (await readFile(path.join(source, prefix + suffix + '.sig'), 'utf8')).trim();
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(signature) || signature.length < 100 || signature.length > 2048) throw new Error(`Malformed updater signature: ${suffix}`);
    manifest.platforms[platform] = { signature, url: `${base}/${prefix}${suffix}` };
  }
  for (const suffix of installerSuffixes) {
    const item = assets.find(a => a.name === prefix + suffix);
    manifest.installers.push({ platform: suffix, url: `${base}/${item.name}`, bytes: item.bytes, sha256: item.sha256 });
  }
  await mkdir(versionDir, { recursive: true });
  const paths = [];
  for (const item of assets) {
    const from = path.join(source, item.name), immutable = path.join(`v${version}`, item.name), alias = item.name.replace(prefix, 'PLAY-X-Raven-latest-');
    await copyFile(from, path.join(destination, immutable));
    await copyFile(from, path.join(destination, alias));
    const newAlias = item.name.replace(prefix, "RavenVault-Desktop-latest-");
    await copyFile(from, path.join(destination, newAlias));
    paths.push(immutable, alias, newAlias);
  }
  const sums = assets.map(a => `${a.sha256}  v${version}/${a.name}`).join('\n') + '\n';
  const metadata = { 'latest.json': JSON.stringify(manifest, null, 2) + '\n', 'VERSION': version + '\n', 'SHA256SUMS.txt': sums, 'README.md': `# RavenVault Desktop ${version}\n\n공식 설치 안내: https://ravenvault.ex.erci.se/download/\n\nPLAY X Raven의 지갑·가게 데이터와 업데이트 서명을 이어받습니다. 버전별 파일은 보존합니다.\n` };
  for (const [name, text] of Object.entries(metadata)) { await writeFile(path.join(destination, name), text); paths.push(name); }
  await writeFile(path.join(destination, `v${version}`, 'manifest.json'), JSON.stringify(manifest, null, 2));
  paths.push(`v${version}/manifest.json`);
  return { manifest, paths };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, version] = process.argv.slice(2);
  const result = await prepareRelease(source, destination, version);
  await writeFile(path.resolve(destination, '../release-paths.txt'), result.paths.join('\n') + '\n');
  console.log(`Validated ${Object.keys(result.manifest.platforms).length} signed platforms and ${result.manifest.installers.length} installers for ${version}`);
}
