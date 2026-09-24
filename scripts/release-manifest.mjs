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
  const manifest = { version, notes: 'RavenVault Desktop 0.4.7 — 0.4.6 다음 판입니다. 화면 고침: 0.4.5·0.4.6 에서 숨겨 둬야 할 창(「손님 QR」·「무엇이 잘못됐나요?」)과 칸들이 앱을 덮고 있던 문제를 고쳤습니다 — 창 보안 규칙이 화면의 모양 지정을 막고 있었습니다. 되돌릴 수 없는 일 앞의 8초 취소 창 막대도 이제 제대로 차오릅니다. 증명서 새 양식: 수료증·증명서·감사장 세 양식을 A4 한 장에 맞게 다시 그렸습니다 — 받는 사람 이름을 가장 크게, 아래에 발급일·발급자·서명(도장) 세 칸, 오른쪽 아래 확인 QR. 글꼴을 앱에 넣어 어느 컴퓨터에서 인쇄해도 같은 모양. 발급처 로고·도장 그림을 올릴 수 있고, 사진 칸(3×4cm)을 켜고 끌 수 있습니다. 미리보기가 깨져 보이던 것도 고쳤습니다. 한 번에 여러 장: 샘플 표(엑셀·CSV)를 받아 명단을 채워 올리면(엑셀에서 붙여넣기도 됨) 확인 표에서 줄마다 고치거나 뺄 수 있습니다. 사진은 여러 장·폴더째 올리면 파일 이름으로 사람과 짝짓습니다. 발행 전에 장수·체인 수수료 합계·지갑 잔액을 크게 보여 주고 모자라면 단추가 잠깁니다. 50장씩 나눠 발행하고 끊기면 이어서 합니다. 끝나면 전체 PDF·한 장씩 인쇄·번호 목록 표를 받습니다. 명단과 사진은 이 컴퓨터 밖으로 나가지 않습니다. 라비(AI 열쇠가 있을 때): 증명서 문구 제안 3개, 명단 사진 읽기(읽은 것은 반드시 확인 표에서 확인). 영어·일본어·중국어 화면 말도 다듬었습니다. 기존 지갑·가게 데이터 위치는 그대로입니다.', pub_date: new Date().toISOString(), platforms: {}, installers: [] };
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
