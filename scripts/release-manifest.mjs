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
  const manifest = { version, notes: 'RavenVault Desktop 0.4.5 — 0.4.3 다음 판입니다. 만들기와 종이 증명서, 가게 회원 관리, 보안 수리. 만들기: 증명서·티켓·작품을 고르고 제목과 장수만 적으면 만듦. 증명서는 받는 사람·발급일·발급자를 적어 A4 증서로 인쇄하거나 PDF로 저장(양식 셋: 수료증·증명서·감사장, 종이의 QR과 증서 번호로 누구나 진짜인지 확인). 받는 사람 이름·설명은 체인에 올리지 않고 이 컴퓨터에만 남고, 「만든 것」에서 다시 인쇄. PDF·한글·워드·사진 문서를 창에 놓으면 파일은 올리지 않고 지문만 적어 증명서로(짧거나 양식이 정해진 문서는 지문만으로도 내용을 짐작당할 수 있다고 안내). 티켓은 만든 뒤 바로 팔기. 이름 등록(500 RVN)은 이름을 한 번 더 적고 8초 안에 취소할 수 있으며(취소 창이 화면 안으로 보이게), 폰이나 다른 컴퓨터에서 만든 내 이름이면 먼저 주인 표를 옮기라고 안내. 아직 기록 중인 이름이 있으면 「기록 중」으로 보이고 새 이름 등록을 막음. 보냈는지 모름: 발행·보내기에서 노드가 제때 답하지 않으면(발행은 3분까지 기다림) 실패로 치지 않고 「보냈는지 아직 몰라요 — 다시 보내지 마세요」로 알림(보내기 전 읽기가 늦은 것은 보낸 것으로 치지 않음). 만들기: 보내는 동안 「보내는 중 — 창을 닫지 마세요 (최대 3분)」, 보내기 직전에 기록을 남겨 도중에 앱이 꺼져도 다시 켜면 「보냈는지 모름」으로 이어감, 체인과 지갑(확인 전 거래 포함)에 기록되면 그대로 완료, 한 번에 하나만 보냄 — 같은 것을 두 번 태우지 않음. 발행 창: 두 번 눌러도, 발행 뒤 「닫기」를 눌러도 한 번만 보냄. 「보냈는지 모름」은 이 컴퓨터의 작은 기록 파일(이름·종류·시각)에 남아 앱을 다시 켜도 같은 발행(더 찍기 포함)을 막고, 다시 보내기 전에 지갑의 확인 전 거래를 봄 — 한 시간 넘게 지갑에 안 보이면 풀림. 파일을 오래 올린 뒤에는 지갑 잠금을 다시 확인하고 발행. 발행: 고른 파일은 「발행하기」를 누를 때만 공개로 올라감(그 전에 창을 닫거나 8초 안에 취소하면 올라가지 않음). 이 컴퓨터에서 만든 원본 지문 자산은 파일로 착각하지 않고 「원본 지문」으로 표시(다른 기기에서 만든 지문은 알아보지 못할 수 있음). 만든 기록: 받는 사람 이름과 원본 지문이 담긴 만든 기록을 백업에 포함, 기록 파일이 손상되면 망가진 파일을 지우지 않고 옆에 남긴 채 「기록을 새로 시작」, 받는 사람·발급자·설명은 보관 기간(가게 회원 보관 기간, 없으면 12개월)이 지나면 지움(체인 이름·지문·거래 번호는 남음), 인쇄용 임시 파일은 7일 뒤 정리(앱이 쓴 이름의 파일만, 바로가기 폴더는 따라가지 않음). 회원: 표를 산 손님을 동의를 받고 회원으로 등록(사장 화면도 「회원에게 동의를 받았어요」 확인이 있어야 등록), 사장이 정한 수집 범위(받지 않음·이름만·이름과 전화 끝 4자리·이름과 전화 전체)를 사장 화면에서도 앱이 지킴, 생년·성별·비상 연락처는 「이름·전화 전체」일 때만 받고 동의 문구에도 적음(동의 문구 새 판), 동의 시각은 앱 시계로 적고 고쳐도 처음 동의 기록을 유지, 지워진 줄에 개인정보를 다시 적으려면 새 동의 필요, 새 회원 등록 전 회원 설정을 못 읽으면 5 RVN 발행 전에 멈춤, 보관 기간이 지나면 이름·전화·메모 자동 삭제. 회원 메모와 분류(성인반·PT 등), 이름·번호·전화 끝 4자리·메모로 찾기, 아이폰 직원도 앱 없이 직원 화면(사파리)에서 회원 찾기·등록·메모, 문 앞 태블릿은 회원 명단을 못 봄. 0.4.3 회원 자료는 그대로 읽힘. 가게: 다시 켜도 주문과 번호표를 기억, 주문 기록 파일을 잃어도 지갑의 자산 기록으로 이미 보낸 주문을 알아봐 다시 보내지 않음, 직원 환불은 가게 통화로, 메뉴판 「주소 복사」는 손님이 실제로 열 수 있는 주소를 복사. 파일 보존: 자산 화면의 「확인」과 자동 보존이 폴더로 묶인 파일(곡·영상 묶음 등)도 찾아 보존함 — 살아 있는지 파일 내용 대신 뿌리 블록으로 확인. 못 붙든 파일은 한동안 다시 묻지 않음. 보안: 창 보안 정책(CSP)과 외부 글자 이스케이프, 가게 파일 중계(/ipfs)는 스크립트를 실행하지 않음, 인터넷(터널)에서는 손님 화면과 웹 지갑 연결만 허용, 앱 자료 폴더를 본인 계정 전용으로 잠금, 복구 단어 보기가 개인키 임시 파일을 만들지 않음. 기존 지갑·가게 데이터 위치는 그대로입니다.', pub_date: new Date().toISOString(), platforms: {}, installers: [] };
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
