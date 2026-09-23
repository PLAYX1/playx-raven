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
  const manifest = { version, notes: 'RavenVault Desktop 0.4.6 — 0.4.5 다음 판입니다. 내 지갑 주소인지 확실히 볼 수 있게 했습니다. 주소 확인: 지갑 화면에 주소를 붙여 넣으면 바로 이 지갑 주소인지 알려 줌 — 받기 주소 몇 번인지, 거스름 주소(거래할 때 노드가 자동으로 만든 주소) 몇 번인지, 가져온 열쇠의 주소인지, 감시만 하는 주소(이 지갑 돈 아님)인지, 이 지갑 주소가 아닌지, 레이븐 주소가 아닌지. 내 주소면 그 주소에 있는 RVN(확인 전은 따로)·자산·주인 표를 함께 보여 줌. raven: 주소나 앞뒤 공백을 붙여 넣어도 됨. 받을 주소록의 주소마다 「주소 확인」 단추. 내 주인 표: 이름 끝이 !인 표(발행 권한 열쇠)가 지금 어느 주소에 있는지 보여 주고 주소를 복사할 수 있음. 보내기 단추는 없음(보내면 발행 권한이 넘어감), 자산 목록에서는 예전처럼 숨김. 라비: 주소를 보내거나 「이 주소 내 거야?」라고 물으면 AI를 부르지 않고 이 컴퓨터의 노드에 바로 물어 같은 답을 줌(AI 열쇠가 없어도 됨). 발행 때 주인 표를 제자리에: 하위 자산·고유 자산·여러 개 한 번에·더 찍기·하위 자격·제한 자산·만들기(티켓·작품)를 만들 때 쓰는 주인 표를 원래 있던 주소로 돌려보냄 — 전에는 노드가 매번 새 거스름 주소로 옮겨 공유 카드의 「인증된 발행자」 확인이 깨졌음. 주인 표 주소를 확인하지 못하면(두 주소 이상·아직 기록 전·읽기 실패) 발행은 예전처럼 하고 화면에 한 줄로 알림. 이 앱이 보내지 않은 출금 알림: 자산과 주인 표가 나간 것도 알아봄(전에는 RVN만 봤음), 지갑 전체 대신 최근 블록만 읽음. 기존 지갑·가게 데이터 위치는 그대로입니다.', pub_date: new Date().toISOString(), platforms: {}, installers: [] };
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
