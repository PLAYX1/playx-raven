# 레이븐볼트 데스크탑 — 윈도우·리눅스 자동 업데이트 게시 순서

작성 2026-10-23 · 기준 브랜치 `claude/update-release` · 맥 쪽 순서는 `release-091-intel.md` 와 같은 방식이다(모순 없음).
이 문서는 **절차만** 적는다. 빌드·서명·게시는 대표가 직접 한다. 열쇠(서명 키·비밀번호)는 이 문서에 쓰지 않고, 아래 `<…>` 는 자리표시자다.

---

## 먼저 알아 둘 것 (쉬운 말로)

- **진술이 있어야 업데이트가 켜진다.** 윈도우·리눅스는 「서명된 진술(statement)」을 내지 않으면 지금처럼 자동 업데이트가 **차단**된다. 안 내면 안전하게 꺼진 채로 있다(이게 1차 스위치).
- **진술 서명은 맥에서, 오프라인으로만.** 서명 열쇠는 CI(깃허브 서버)에 맡기지 않는다. CI 는 설치 파일을 만들고 검산해서 묶음으로 내놓는 데까지만 한다. 게시(`dist` 에 올리기)는 사람이 맥에서 한다.
- **한 번 올린 판은 되돌릴 수 없다.** 잘못 올렸다면 지우거나 고치지 말고, **더 높은 판 번호(version)와 더 높은 sequence** 로 고친 판을 새로 낸다. 같은 판 번호는 다시 못 쓴다(`Version already exists`).
- **윈도우는 Authenticode(윈도우 코드 서명)가 없다.** 업데이트 서명은 우리 열쇠로 하지만, 윈도우 자체의 서명은 아니라서 처음 설치·실행 때 **SmartScreen/Defender 경고**가 뜰 수 있다. 사용자는 「추가 정보 → 실행」으로 진행한다.
- **업데이트는 사용자가 눌러서 설치한다.** 앱이 몰래 바꾸지 않는다.
- **자동 업데이트 대상은 윈도우 NSIS 설치 파일(`…-setup.exe`)과 리눅스 `.AppImage` 뿐이다.** `.msi` 와 `.deb` 로 설치한 사용자는 자동 업데이트 대상이 **아니다**(새 설치 파일을 직접 받아 설치).
- **리눅스 AppImage 는 안의 버전을 읽지 않는다.** 대신 서명된 진술의 version 을 믿는 방식이다. 그래서 `--version` 을 사람이 정확히 넣어야 하고, 도구는 파일 이름과의 일치만 확인한다. 윈도우 `.exe` 는 안의 ProductVersion 을 직접 읽어 `--version` 과 다르면 멈춘다.
- **파일 하나는 95,000,000 바이트 미만**이어야 한다(이 상한은 풀지 않는다). 2026-10-23 시험 산출물(0.9.5, 라비 목소리 모델을 뺀 변경 **전**에 만든 것)은 윈도우 setup.exe 424,827,156 바이트, 리눅스 AppImage 524,507,640 바이트로 상한을 크게 넘었다. 모델을 뺀 **새 빌드**의 크기를 CI 결과에서 꼭 다시 재어 보고 진행한다(5단계 전에 이미 CI 가 상한 검사를 한다).

---

## 순서

작업 폴더는 이 브랜치(또는 이것을 품은 릴리스 커밋)가 체크아웃된 곳이고, 판 번호는 `X.Y.Z` 로 쓴다. 판 올림 커밋(`tauri.conf.json`·`Cargo.toml`·`package.json`, `scripts/release-manifest.mjs` 의 `notes` 문구)은 `release-091-intel.md` 4절 1번과 같다 — `node preflight.mjs` 의 「판 번호 세 곳」 통과 확인.

### 1. CI 로 윈도우·리눅스 산출물 만들기
- 깃허브 → Actions → 「설치 파일 만들기」(`release.yml`) → Run workflow → `version` 에 `X.Y.Z`.
- 윈도우·리눅스 작업이 끝나면 각각 `windows`, `linux` 이름의 산출물이 올라온다. 안에 있어야 하는 것:
  - `RavenVault-Desktop-X.Y.Z-windows.exe` 와 `….exe.sig`, `…-windows.msi`
  - `RavenVault-Desktop-X.Y.Z-linux.AppImage` 와 `….AppImage.sig` (`.deb` 도 같이 나온다)
- 맥 작업은 맥에서 손으로 만든다(`release-091-intel.md`). CI 의 `publish` 작업은 이제 **게시하지 않고** 묶음(`release-candidate`)만 만들고 파일 크기·필수 파일을 검산한다.

### 2. 내려받기
깃허브 실행 화면 아래쪽 Artifacts 에서 `windows`, `linux`(또는 묶음 `release-candidate`)를 내려받아, 맥 설치 파일이 모인 입력 폴더 하나에 **같이** 넣는다.
```bash
mkdir -p ~/rv-release-X.Y.Z/input ~/rv-release-X.Y.Z/statements
# 내려받은 파일을 전부 ~/rv-release-X.Y.Z/input 에 둔다(맥 파일 포함). 폴더 이름은 마음대로.
ls -la ~/rv-release-X.Y.Z/input     # 파일마다 95,000,000 바이트 미만인지 눈으로 확인
```
입력 폴더에는 `RavenVault-Desktop-X.Y.Z-…` 로 시작하는 릴리스 파일만 둔다(다른 파일이 있으면 `Unexpected release file` 로 멈춘다).

### 3. 진술 입력 만들기 (`prepare-update-statement.py`)
파일을 **실행하지 않고** 해시·크기만 읽는다. `--sequence` 는 직전 진술보다 **큰** 수(예: 날짜 기반 `2026102301`), `--expires` 는 미래 시각(유닉스 초).
```bash
cd <작업 폴더>
EXP=$(( $(date +%s) + 60*60*24*365*2 ))     # 예: 2년 뒤

python3 scripts/prepare-update-statement.py ~/rv-release-X.Y.Z/input/RavenVault-Desktop-X.Y.Z-windows.exe \
  --target windows-x86_64 --version X.Y.Z --sequence <시퀀스> --expires $EXP \
  --output ~/rv-release-X.Y.Z/statements/windows-x86_64.json

python3 scripts/prepare-update-statement.py ~/rv-release-X.Y.Z/input/RavenVault-Desktop-X.Y.Z-linux.AppImage \
  --target linux-x86_64 --version X.Y.Z --sequence <시퀀스> --expires $EXP \
  --output ~/rv-release-X.Y.Z/statements/linux-x86_64.json
```
- 윈도우: 출력에 `installer ProductVersion read and matches X.Y.Z` 가 나와야 한다. 다르면 `version mismatch` 로 멈춘다 — **멈추면 이유를 고치고(보통 `--version` 오타나 엉뚱한 파일) 다시 한다. 억지로 넘기지 않는다.**
- 리눅스: 출력에 `the version inside the AppImage is NOT checked` 가 나온다. 정상이다. 파일 이름에 `X.Y.Z` 가 없으면 멈춘다.
- 맥 두 대상도 같이 낼 때는 `release-091-intel.md` 의 `run-091-intel.sh` 가 만든 진술(`darwin-aarch64.json`, `darwin-x86_64.json`)을 같은 `statements` 폴더에 둔다.
- `.json` 은 한 줄짜리 공개 정보다. 안의 `target`·`version`·`sha256` 을 눈으로 한 번 확인한다.

### 4. 오프라인 minisign 서명 (맥에서만)
```bash
cd ~/rv-release-X.Y.Z/statements
for T in windows-x86_64 linux-x86_64; do
  rm -f "$T.json.sig" "$T.json.minisig"
  env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    npx tauri signer sign -f "<업데이트 키 파일 경로>" -p "<비밀번호>" "$T.json"
  base64 -d < "$T.json.sig" > "$T.json.minisig"
done
ls -la     # <대상>.json 과 <대상>.json.minisig 가 대상마다 있어야 함
```
- 키 파일 경로·비밀번호는 평소 쓰는 방식 그대로(`release-084.md` 94~118행). 화면·기록·채팅에 찍지 않는다.
- minisign 이 prehashed(`ED`) 모드여야 한다. 위 방식이 그 모드다.

### 5. 게시 파일 만들기 (`release-manifest.mjs`) — 업로드 아님
`dist` 브랜치를 내려받은 폴더(`<dist 체크아웃>`)가 있어야 한다. **윈도우·리눅스를 켜려면 `--targets` 에 이름을 넣는다.** 안 넣으면 그 대상은 업데이트가 꺼진 채다.
```bash
git clone --depth 1 --branch dist git@github.com:PLAYX1/playx-raven-releases.git ~/rv-release-X.Y.Z/pub   # 이미 있으면 최신으로 갱신

node scripts/release-manifest.mjs ~/rv-release-X.Y.Z/input ~/rv-release-X.Y.Z/pub X.Y.Z \
  ~/rv-release-X.Y.Z/statements \
  --targets windows-x86_64,linux-x86_64,darwin-aarch64,darwin-x86_64
```
- `--targets` 에 넣은 대상마다 **설치 파일·`.sig`·서명된 진술**이 전부 있어야 한다. 하나라도 없으면 아무것도 쓰지 않고 멈춘다(예: `Signed release statement missing for windows-x86_64`).
- 윈도우 대상은 `…-windows.exe`(+`.sig`)에 더해 `…-windows.msi` 도 입력 폴더에 있어야 한다(설치 안내용).
- 이번 판에 안 내는 대상은 `--targets` 에서 빼면 된다. 그 대상은 이전 판 파일이 그대로 따라간다(`latest.json` 에 이전 판 번호로 표시).
- 끝나면 `latest.json` 을 열어 `platforms` 와 `signed_releases` 에 **넣은 대상이 전부** 있는지 눈으로 본다.

### 6. 검증 (`verify-published-release.mjs`)
올리기 **전에** 이 폴더가 맞는지는 위 5단계가 이미 서명·해시까지 대조했다. 올린 **뒤에** 공개 주소를 점검한다(HEAD 조회만; 다운로드·서명 재검증은 안 함).
```bash
node scripts/verify-published-release.mjs X.Y.Z --targets windows-x86_64,linux-x86_64,darwin-aarch64,darwin-x86_64
```
이 검증은 `--targets` 에 넣은 모든 대상의 서명된 진술이 매니페스트에 있는지까지 요구한다.

### 7. dist 에 올리기
```bash
cd ~/rv-release-X.Y.Z/pub
git add --pathspec-from-file=../release-paths.txt
git commit -m "RavenVault Desktop X.Y.Z"
git push origin HEAD:dist
```
- 푸시 전에 `git show --stat HEAD` 로 **올라가는 파일 목록을 눈으로 본다**(`v X.Y.Z/` 아래 파일, `latest.json`, `VERSION`, `SHA256SUMS.txt`, `README.md`, 별칭 파일들).
- 푸시 뒤 6단계 검증 명령을 돌린다. 캐시가 늦으면 최대 15분까지 알아서 기다리며 다시 확인한다.

---

## 되돌리기와 사고 대응
- 올린 판은 지우거나 덮지 않는다. 문제가 있으면 **X.Y.(Z+1)** 같은 더 높은 판과 더 높은 `--sequence` 로 고친 판을 낸다. 낮은 sequence 는 앱이 받지 않는다.
- 급히 막고 싶으면: 해당 대상을 뺀 새 판(`--targets` 에서 제외)을 내는 것은 그 대상 사용자를 **이전 판에 머물게** 할 뿐 되돌리지는 않는다. 되돌림이 필요하면 고친 높은 판밖에 길이 없다.
- 진술 서명 열쇠가 의심되면 판을 내지 말고 먼저 대표에게 알린다.

## 이 문서가 확인한 것 / 못 한 것
- 확인(오프라인 시험): 합성 PE/ELF 와 2026-10-23 시험 산출물 `RavenVault Desktop_0.9.5_x64-setup.exe` 의 ProductVersion 읽기(0.9.5 일치), 윈도우·리눅스 진술의 서명·해시·대상·버전·만료 대조, 진술 없는 대상 차단.
- 못 함: 실제 윈도우·리눅스에서 업데이트 설치(앱 쪽 검사는 별도 작업), 새 빌드(모델 제외)의 실제 크기, 실제 minisign 서명 실행.
