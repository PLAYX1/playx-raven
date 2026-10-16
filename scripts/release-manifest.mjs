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
  const manifest = { version, notes: `RavenVault Desktop ${version} — 같은 집 안 와이파이에서 폰을 안전하게 연결하는 「폰 연결」을 더했습니다(기본 꺼짐). 기기마다 증서를 쓰고, 기기를 끊으면 데이터 열쇠를 바꾸며 철회합니다. 메인넷 자산 발행·판매 스위치가 켜진 채로 들어 있습니다. 자산 발행에는 되돌릴 수 없는 500 RVN 보증 소각이 따릅니다. 맥 빌드 스크립트의 앱 이름 오류도 고쳤습니다. 자동 업데이트 대상은 맥(Apple Silicon·Intel)입니다. 0.9.1 변경: 인텔 맥(x86_64) 설치 파일을 추가했습니다. 윈도우·리눅스 지원 준비로 윈도우의 가게 시간대(늘 UTC 이던 것), 콘솔 창 깜빡임, 노드 정상 종료와 리눅스 설치본의 노드 경로를 고쳤습니다(맥 동작은 그대로). 0.9.0 변경: 설정 화면을 왼쪽 목록과 한 주제씩 보기로 바꾸고 설정 찾기를 더했습니다. 이야기: 처음 들어오면 이름 정하기 카드, 내 글에도 이름과 아이콘, 내가 만든 방의 이름·설명 고치기, 방 숨기기(「숨긴 방」에서 되돌리기). 「내 색」 설정은 없앴습니다. 백업: 이름을 「wallet.dat 백업 파일 내보내기·가져오기」로 정리했고, 백업 파일(.rvwallet·.pxlock)을 창에 끌어다 놓으면 무엇을 되살리는지 먼저 보여 주고 확인한 뒤에만 되살립니다. 레이븐 코어로 옮길 때 쓰는 「코어용 wallet.dat」을 꺼낼 수 있습니다(지갑 암호가 있어야 하며, 함께 든 레이븐 코어 4.8.0 에서 열리는 것만 확인했고 쓰려면 지갑 암호가 필요합니다). 새 가게 이름은 RV.S.<가게이름> 입니다(옛 SHOP. 가게는 그대로). 0.8.8 변경(라비 자기 질문·감정 대답과 위기 안내, 체인 정보(읽기 전용), 자산 파일(IPFS) 보관 화면, 이야기 방 초대 링크가 새 지갑 ravenvault.ex.erci.se 를 엶, 업데이트 단추 「확인 중…」 고침), 0.8.7 변경(wallet.dat 백업 파일 내보내기·가져오기, 백업 열쇠 52글자 종이 적기·인쇄 단계, 지갑 암호 없으면 대기화면·매장용 읽기 전용 거절, Ravencoin Core(MIT) 고지, 화면 언어 이탈리아어·스페인어·프랑스어·포르투갈어(브라질)·독일어·러시아어 AI 번역, 메인넷 자산 발행 안전 스위치 꺼짐), 0.8.6 변경(라비 대화·창 모드·대기화면 잠금·다크 돈 카드 등)과 0.8.5 변경(라비 스토리 카드 글자, 판매자 기능을 켠 경우에만 판매 대금 받기, 어두운 화면 단추 대비)도 포함합니다. 서명된 업데이트 버전·해시·순서 검증을 유지합니다.`, pub_date: new Date().toISOString(), platforms: {}, installers: [] };
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
