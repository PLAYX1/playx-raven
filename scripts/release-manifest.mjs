import { signedReleaseMetadata } from './signed-release-metadata.mjs';
import { checkTargets, parseTargetsArg, TARGET_INSTALLERS } from './verify-published-release.mjs';
import { readdir, readFile, stat, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const installerSuffixes = ['windows.exe','windows.msi','mac-apple-silicon.dmg','mac-intel.dmg','linux.AppImage'];
export const ALL_RELEASE_TARGETS = Object.freeze(['windows-x86_64','darwin-aarch64','darwin-x86_64','linux-x86_64']);
const platforms = { 'windows.exe':'windows-x86_64', 'mac-apple-silicon.tar.gz':'darwin-aarch64', 'mac-intel.tar.gz':'darwin-x86_64', 'linux.AppImage':'linux-x86_64' };
const labels = { 'windows-x86_64':'windows', 'darwin-aarch64':'mac-apple-silicon', 'darwin-x86_64':'mac-intel', 'linux-x86_64':'linux' };
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a, b) => a.split('.').map(Number).reduce((order, n, i) => order || Math.sign(n - b.split('.').map(Number)[i]), 0);
/**
 * `targets` is required and has no default: every listed target must be complete (installers,
 * updater package, signature and, from 0.8.4, a signed statement). Targets left out get no updater
 * entry, their latest aliases are not touched, and their installer entries carry the previous
 * release's immutable files labeled with that older version.
 */
export async function prepareRelease(source, destination, version, statementDirectory, targets) {
  if (!semver.test(version)) throw new Error('Invalid release version');
  targets = checkTargets(targets);
  const partial = targets.length !== ALL_RELEASE_TARGETS.length;
  const listedLabels = new Set(targets.map(t => labels[t]));
  const ownInstallers = installerSuffixes.filter(s => targets.some(t => TARGET_INSTALLERS[t].includes(s)));
  const ownPlatforms = Object.fromEntries(Object.entries(platforms).filter(([, p]) => targets.includes(p)));
  const files = (await readdir(source)).sort();
  const prefix = files.some(name => name.startsWith(`RavenVault-Desktop-${version}-`)) ? `RavenVault-Desktop-${version}-` : `PLAY-X-Raven-${version}-`;
  const required = [...new Set([...ownInstallers, ...Object.keys(ownPlatforms)])];
  for (const suffix of required) if (!files.includes(prefix + suffix)) throw new Error(`Missing installer: ${suffix}`);
  for (const suffix of Object.keys(ownPlatforms)) if (!files.includes(prefix + suffix + '.sig')) throw new Error(`Missing updater signature: ${suffix}`);
  const assets = [];
  for (const name of files) {
    const match = name.startsWith(prefix) && /^(?:RavenVault-Desktop|PLAY-X-Raven)-[\d.]+-(windows|mac-apple-silicon|mac-intel|linux)\.(?:exe|msi|dmg|AppImage|deb|rpm|tar\.gz)(?:\.sig)?$/.exec(name);
    if (!match) throw new Error(`Unexpected release file: ${name}`);
    if (!listedLabels.has(match[1])) throw new Error(`Release file for a target that is not listed: ${name}`);
    const info = await stat(path.join(source, name));
    if (!info.isFile() || info.size < 1 || info.size >= 95_000_000) throw new Error(`Unsupported release file size: ${name}`);
    const data = await readFile(path.join(source, name));
    assets.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  // Never replace a previously published version. Old updater metadata stays usable.
  const versionDir = path.join(destination, `v${version}`);
  try { await stat(versionDir); throw new Error('Version already exists; use a new version'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let previous = null;
  try {
    previous = JSON.parse(await readFile(path.join(destination, 'latest.json'), 'utf8'));
    const current = previous.version;
    if (typeof current !== 'string' || !semver.test(current)) throw new Error('Invalid currently published version');
    if (compare(version, current) <= 0) throw new Error('Release must be newer than the currently published version');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const carried = [];
  if (partial) {
    if (!previous || !Array.isArray(previous.installers)) throw new Error('A partial release needs the current latest.json to carry the other targets');
    for (const suffix of installerSuffixes.filter(s => !ownInstallers.includes(s))) {
      const found = previous.installers.filter(item => item?.platform === suffix);
      if (found.length !== 1) throw new Error(`Cannot carry previous installer: ${suffix}`);
      const item = found[0], from = typeof item.version === 'string' ? item.version : previous.version;
      if (!semver.test(from) || compare(version, from) <= 0) throw new Error(`Invalid carried installer version: ${suffix}`);
      const okUrl = ['PLAY-X-Raven', 'RavenVault-Desktop'].some(b => item.url === `https://raw.githubusercontent.com/PLAYX1/playx-raven-releases/dist/v${from}/${b}-${from}-${suffix}`);
      if (!okUrl || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw new Error(`Invalid carried installer entry: ${suffix}`);
      carried.push({ platform: suffix, url: item.url, bytes: item.bytes, sha256: item.sha256, version: from });
    }
  }
  const base = `https://raw.githubusercontent.com/PLAYX1/playx-raven-releases/dist/v${version}`;
  const manifest = { version, notes: `RavenVault Desktop ${version} — 라비가 「몇 살이야」「생일이 언제야」 같은 자기 질문과 감정 표현(위로·응원 등)에 이 컴퓨터 안에서 바로 답하고, 위기 표현에는 전문기관 안내를 먼저 보여 줍니다. 내 정보가 필요 없는 질문에는 정보 선택 카드를 띄우지 않습니다. 체인 정보(읽기 전용)를 더했습니다 — 내 노드 높이·해시율·난이도·대기 거래·연결 수와 51% 공격 비용 기준 보안 순위(투자 조언 아님). 자산 파일(IPFS) 보관 화면: 한 번 탭하면 보관, 길게 누르면 해제(5초 안에 되돌리기), 앱 안 「진짜인지 확인」. 이야기 방 초대 링크가 새 지갑(ravenvault.ex.erci.se)을 엽니다. 새 버전이 없을 때 업데이트 단추가 「확인 중…」에 머물던 것을 고쳤습니다. 0.8.7 변경(지갑 파일 내보내기·가져오기, 백업 열쇠 52글자 종이 적기·인쇄 단계, 지갑 암호 없으면 대기화면·매장용 읽기 전용 거절, Ravencoin Core(MIT) 고지, 화면 언어 이탈리아어·스페인어·프랑스어·포르투갈어(브라질)·독일어·러시아어 AI 번역, 메인넷 자산 발행 안전 스위치 꺼짐)과 0.8.6 변경(라비 대화·창 모드·대기화면 잠금·다크 돈 카드 등)도 포함합니다. 서명된 업데이트 버전·해시·순서 검증을 유지합니다.`, pub_date: new Date().toISOString(), platforms: {}, installers: [] };
  const needsStatement = compare(version, '0.8.4') >= 0;
  if (needsStatement) {
    const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url),'utf8'));
    manifest.signed_releases = await signedReleaseMetadata(statementDirectory, source, prefix, version, config.plugins.updater.pubkey, targets);
  }
  for (const [suffix, platform] of Object.entries(ownPlatforms)) {
    const signature = (await readFile(path.join(source, prefix + suffix + '.sig'), 'utf8')).trim();
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(signature) || signature.length < 100 || signature.length > 2048) throw new Error(`Malformed updater signature: ${suffix}`);
    manifest.platforms[platform] = { signature, url: `${base}/${prefix}${suffix}` };
  }
  for (const suffix of installerSuffixes) {
    const item = assets.find(a => a.name === prefix + suffix);
    manifest.installers.push(item ? { platform: suffix, url: `${base}/${item.name}`, bytes: item.bytes, sha256: item.sha256 } : carried.find(c => c.platform === suffix));
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
  // A partial release keeps the checksum lines of the other targets' still-current files.
  let carriedSums = [];
  if (partial) {
    const keep = new Set(Object.values(labels).filter(l => !listedLabels.has(l)));
    const versions = new Set(carried.map(c => c.version));
    let text = '';
    try { text = await readFile(path.join(destination, 'SHA256SUMS.txt'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    carriedSums = text.split('\n').filter(line => {
      const m = /^[a-f0-9]{64} {2}v(\d+\.\d+\.\d+)\/(?:RavenVault-Desktop|PLAY-X-Raven)-\1-(windows|mac-apple-silicon|mac-intel|linux)\.[A-Za-z.]+$/.exec(line);
      return m && versions.has(m[1]) && keep.has(m[2]);
    });
  }
  const sums = [...assets.map(a => `${a.sha256}  v${version}/${a.name}`), ...carriedSums].join('\n') + '\n';
  const metadata = { 'latest.json': JSON.stringify(manifest, null, 2) + '\n', 'VERSION': version + '\n', 'SHA256SUMS.txt': sums, 'README.md': `# RavenVault Desktop ${version}\n\n공식 설치 안내: https://ravenvault.ex.erci.se/download/\n\nPLAY X Raven의 지갑·가게 데이터와 업데이트 서명을 이어받습니다. 버전별 파일은 보존합니다.\n${partial ? `\n이번 판 대상: ${targets.join(', ')}. 그 밖의 운영체제는 이전 판(${[...new Set(carried.map(c => c.version))].join(', ')})을 유지합니다.\n` : ''}` };
  for (const [name, text] of Object.entries(metadata)) { await writeFile(path.join(destination, name), text); paths.push(name); }
  await writeFile(path.join(destination, `v${version}`, 'manifest.json'), JSON.stringify(manifest, null, 2));
  paths.push(`v${version}/manifest.json`);
  return { manifest, paths };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { targets, rest } = parseTargetsArg(process.argv.slice(2));
  if (rest.length < 3 || rest.length > 4) throw new Error('Usage: node scripts/release-manifest.mjs <input> <dist> <version> [statements] --targets darwin-aarch64[,...]');
  const [source, destination, version, statementDirectory] = rest;
  const result = await prepareRelease(source, destination, version, statementDirectory, targets);
  await writeFile(path.resolve(destination, '../release-paths.txt'), result.paths.join('\n') + '\n');
  console.log(`Validated ${Object.keys(result.manifest.platforms).length} signed platforms (${targets.join(', ')}) and ${result.manifest.installers.length} installers for ${version}`);
}
