# 레이븐볼트 데스크탑 — 인텔 맥(x86_64) 빌드 준비 (0.9.1)

작성 2026-10-12 · 기준 커밋 `e11de3c`(공개된 0.9.0 Apple Silicon) · 브랜치 `claude/rv-desktop-091-intel`
이 작업에서 한 것: 조사, 스크립트 준비(`bash -n` 만), 맥 로컬 컴파일 점검. **안 한 것**: 빌드·서명·공증·업로드·배포·앱 실행·키 열람.

---

## 한 줄 결론

**권장안 A — 대상별 따로 빌드(`aarch64-apple-darwin`, `x86_64-apple-darwin`) · 설치 파일 2개 · 판은 0.9.1.**
유니버설 한 파일(B)은 압축본이 약 128MB 가 되어 우리 공개 규칙의 파일 상한(95,000,000 바이트)과 GitHub 파일 한도(100MB)를 넘으므로 지금 구조로는 올릴 수 없다.
인텔용 포함 바이너리(레이븐 노드·kubo)는 **공식 파일을 이미 받아 두었고 해시가 공식 값과 맞는다** — 대표가 따로 빌드할 바이너리는 없다.

---

## 1. 설치 파일 방식 비교

| | A. 대상별 따로 (권장) | B. 유니버설 한 파일 |
|---|---|---|
| Tauri 지원 | 지금 쓰는 판(tauri 2.11.5 / CLI 2.11.4)에서 `--target x86_64-apple-darwin` 그대로. 0.8.4 때 이 맥에서 인텔 빌드·공증 성공 기록 있음(`~/rv-release-084/build-x64.log`, 3분 24초) | `--target universal-apple-darwin` 지원(Tauri 2). 단, 앱 본체만 `lipo` 로 합쳐 주고 **resources 의 ravend·ipfs 는 그대로 복사**하므로 우리가 두 바이너리를 직접 `lipo -create` 해야 함 |
| 파일 크기 | Apple Silicon dmg 약 65MB(0.9.0 실측 64,954,988) · Intel dmg 약 69MB(0.8.4 실측 68,654,622) | 압축본 약 128MB 추정(= 63.4 + 68.1 − 겹치는 아이콘·사전 약 3MB). 본체 40+44MB, ipfs 82+88MB, ravend 11+11MB 가 모두 두 벌 |
| 공개 규칙 | `release-manifest.mjs`·`verify-published-release.mjs` 가 처음부터 `mac-apple-silicon.*` / `mac-intel.*` 두 이름을 안다. 고칠 것 없음 | **불가.** 두 스크립트 모두 파일 하나가 95,000,000 바이트 이상이면 거절. `dist` 는 git 브랜치라 GitHub 의 파일당 100MB 한도에도 걸림 |
| 업데이트 명세 | 대상마다 명세 1개(`darwin-aarch64.json`, `darwin-x86_64.json`) — 지금 구조 그대로 | 같은 압축본을 두 이름으로 올리고 명세 2개(대상만 다르고 sha256 같음)를 만들어야 함. `update_policy.rs` 는 이것을 허용(명세의 `target` 이 앱의 `darwin-<ARCH>` 와 같고 sha256 이 내려받은 바이트와 같으면 됨 — 대상끼리 해시가 달라야 한다는 검사는 없음). `signed-release-metadata.mjs` 도 허용. 하지만 위 크기 상한에서 막힘 |
| 사용자 | 어느 맥인지 골라야 함(사이트가 두 단추) | 고를 필요 없음 |
| 업데이트 용량 | 각자 자기 것만(65~69MB) | Apple Silicon 사용자도 매번 2배(약 128MB) |
| 빌드 시간·디스크 | 대상마다 따로(디스크 대상당 약 12GB) | 한 번에 둘 다 빌드(시간·디스크 비슷) |

**결론 A.** B 가 사용자에게는 편하지만, 크기 상한을 풀려면 공개 저장소를 git 파일이 아니라 릴리스 자산으로 옮기는 별도 공사(토큰·스크립트·서버 주소 변경)가 먼저 필요하다. 인텔 맥 사용자는 「노드 머신으로 재활용하는 오래된 맥」이라 어느 맥인지 아는 사람이 대부분이다.

### 왜 0.9.0 에 덧붙이지 않고 0.9.1 인가
- `release-manifest.mjs` 는 `v<판>/` 폴더가 이미 있으면 `Version already exists; use a new version` 으로 멈춘다(덮어쓰기·덧붙이기 금지). `latest.json` 보다 새 판이어야 한다는 검사도 있다.
- 그러므로 **0.9.1 로 올리고 맥 두 대상을 모두 새로 만든다.** sequence 는 0.9.0 명세의 `2026101301` 보다 큰 값(기본 `2026101302`)을 두 대상이 같이 쓴다.
- (참고) 규칙상 0.9.1 을 인텔만 `--targets darwin-x86_64` 로 내는 것도 가능하다 — Apple Silicon 설치 파일은 0.9.0 이 그대로 따라간다. 하지만 윈도우·리눅스 레인도 0.9.1 에서 러스트 소스를 고치고 있어 판이 엇갈리므로 권하지 않는다.
- 🔴 **윈도우·리눅스 레인(`wt-rv-desktop-091-win`)도 0.9.1 을 겨냥한다.** `v0.9.1/` 은 한 번만 만들 수 있으므로, 두 레인을 한 커밋으로 합친 뒤 **한 번의 `release-manifest.mjs` 실행에 준비된 대상을 모두 넣어야** 한다. 한쪽이 먼저 올리면 다른 쪽은 0.9.2 가 된다.

### 지금 공개 상태 (2026-10-12 04:35 UTC 확인)
- `latest.json` = 0.9.0, 업데이트 대상 `darwin-aarch64` 하나, 서명 명세 `darwin-aarch64`(sequence 2026101301).
- `mac-intel.dmg` 설치 항목은 **0.8.3 인텔 파일이 따라가는 중**(68,245,301 바이트). `PLAY-X-Raven-latest-mac-intel.dmg`·`RavenVault-Desktop-latest-mac-intel.dmg` 별칭도 0.8.3.
- 0.8.3 인텔 사용자는 `darwin-x86_64` 업데이트 항목이 없어 지금 업데이트를 못 받는다(204). 0.9.1 에 인텔이 들어가면 받게 된다 — 0.8.3 앱은 서명 명세 이전 판이라 Tauri 패키지 서명만 보고 받는다.

---

## 2. 포함 바이너리

| 대상 | 파일 | 출처 | 해시(공식 값과 대조) | 로컬 위치 |
|---|---|---|---|---|
| Intel | 레이븐 노드 4.8.0 `raven-4.8.0-225491298-osx64.tar.gz` (안의 `bin/ravend` 만 씀) | https://github.com/RavenProject/Ravencoin/releases/download/v4.8.0/raven-4.8.0-225491298-osx64.tar.gz | SHA-256 `8610c117476697e7f34dedf0b85bf8386c79ecebfa36740eedc1260c7d1d5c5a` = 공식 `.sha256sum` 및 GitHub 자산 digest 와 일치 | `~/rv-release-084/vendor-dl/x64/node.pkg` |
| Intel | kubo v0.43.0 `kubo_v0.43.0_darwin-amd64.tar.gz` | https://github.com/ipfs/kubo/releases/download/v0.43.0/kubo_v0.43.0_darwin-amd64.tar.gz | SHA-512 `7edd038e9208b8024ef14329102a8bc40827c21337bb2d38ea52400c57a04e3c092086a11c9d342b85083a71df4bf77130fd676bdb68628b2d9e8e6f511ee305` = 공식 `.sha512` 와 일치 (SHA-256 `2ebb785c…4c73`) | `~/rv-release-084/vendor-dl/x64/ipfs.pkg` |
| Apple Silicon | 레이븐 노드 `ravend-macos-arm64` (공식에 arm64 판 없음 → 우리가 소스 v4.8.0-2-g0894f15de 무수정 빌드) | https://github.com/PLAYX1/playx-raven-releases/releases/download/vendor-ravend-4.8.0/ravend-macos-arm64 | SHA-256 `d008e5ed56497dc394ce32e95f61a5e5b19fb59a0cbb5b6600c7aa3bc69a4806` = 릴리스 자산 digest 와 일치 | `~/rv-release-084/vendor-dl/arm64/node.pkg` |
| Apple Silicon | kubo v0.43.0 `darwin-arm64` | 같은 kubo 릴리스 | SHA-512 `2377bc88…34ef6` = 공식 `.sha512` 와 일치 | `~/rv-release-084/vendor-dl/arm64/ipfs.pkg` |

조회 시각: 2026-10-12 04:35 UTC 전후(GitHub API·공식 체크섬 파일). 이 값들은 `.github/workflows/release.yml`(2026-08-26 대조)과도 같다.

- 꺼낸 Intel `ravend` 의 SHA-256 은 `6025a069…a227`, 붙는 라이브러리는 `/usr/lib/libSystem.B.dylib`, `/usr/lib/libc++.1.dylib` 뿐(홈브루 무관). 최소 macOS 10.14.
- Intel `ipfs` SHA-256 `d08a8fdb…77a2`, 최소 macOS **12.0**(Go 런타임 요구). Apple Silicon `ipfs` 도 12.0.
- 0.8.4 때 서명해 둔 사본(`~/rv-release-084/vendor-x64-signed/`)도 있지만, 스크립트는 공식 꾸러미에서 **매번 새로 꺼내 해시·아키텍처를 확인한 뒤 서명**한다(옛 서명 사본에 기대지 않음). 로컬 꾸러미가 없으면 같은 공식 주소에서 받아 같은 해시로 대조한다.
- kubo 최신은 v0.43.1 이지만 0.9.0 Apple Silicon 과 같은 v0.43.0 에 고정한다(두 대상 동일).
- **arm64 ravend 재현 절차**: `~/build/Ravencoin/BUILD-NOTES-arm64.md`(2026-08-17) — depends `HOST=aarch64-apple-darwin`, brew qt@5, `-include stdexcept -include limits` 를 make 에만. 인텔은 공식 osx64 가 있으므로 크로스 빌드가 **필요 없다**(빌드 노트에도 x86_64 경로는 openssl.mk 패치가 필요하다고 적혀 있음 — 시도하지 않음).

**미확보: 없음.** 대표가 준비하거나 빌드할 바이너리는 없다.

---

## 3. 맥 로컬 점검 (2026-10-12, M1 Max · macOS 26.5.2)

| 점검 | 결과 |
|---|---|
| `rustup` 의 `x86_64-apple-darwin` 대상 | 이미 설치됨(stable 1.98.1). **Homebrew rustc(1.97.1, PATH 기본)에는 x86_64 표준 라이브러리가 없다** → 스크립트가 rustup 툴체인을 PATH 앞에 둔다 |
| `cargo check --offline --locked --target x86_64-apple-darwin` | ✅ 통과(1분 11초, 경고 42개는 기존과 같은 미사용 경고) |
| `cargo test --offline --locked --target x86_64-apple-darwin --lib update_policy::` | ✅ 2개 통과 — **x86_64 시험 바이너리가 Rosetta 로 실제 실행됨** |
| Rosetta | 설치·동작 확인(`arch -x86_64 /usr/bin/true`) |
| 러스트 소스의 아키텍처 의존 | 업데이트 대상 `darwin-<ARCH>` 는 컴파일 대상으로 정해짐(`secure_update.rs`). `cloudflared`·노드 찾기는 `/opt/homebrew/bin` 과 `/usr/local/bin`(인텔 brew) 둘 다 봄. 채굴 화면의 칩 판정(`Apple M` 접두)은 인텔에서 「Apple Silicon 아님」으로 정직하게 나옴. **인텔 때문에 고칠 러스트/TS 소스는 없음** |
| 실제 인텔 맥 | **미검증** |

---

## 4. 대표가 할 일 (순서)

1. **0.9.1 판 올림 커밋** — 윈도우·리눅스 레인과 이 브랜치를 합친 뒤 한 번만: `src-tauri/tauri.conf.json`·`src-tauri/Cargo.toml`·`package.json`(+ `Cargo.lock`·`package-lock.json` 의 자기 항목) 을 `0.9.1` 로, `CHANGELOG.md`, 그리고 **`scripts/release-manifest.mjs` 의 `notes` 문구가 0.9.0 내용으로 박혀 있으니 0.9.1 문구로**(인텔 맥 다시 지원 · 윈도우/리눅스 내용). `node preflight.mjs` 의 「판 번호 세 곳」 통과 확인.
2. 그 커밋이 체크아웃된 작업 폴더에서:
   ```bash
   export RV_WANT_SHA=<그 커밋 SHA>
   export RV_WT=<그 작업 폴더>             # 기본 /Users/gimmusong/wt-rv-desktop-091-intel
   export RV_NOTARY_PROFILE=<프로필 이름>
   export RV_UPDATE_KEY_FILE=<키 파일 경로>
   # RV_UPDATE_KEY_PASSWORD 는 정하지 않으면 숨김 입력으로 물어봄
   bash ~/rv-release-091-intel/run-091-intel.sh        # 두 대상 연달아(대상당 20~40분 + 공증)
   ```
   디스크 32GB 이상 필요(두 대상). 한쪽만 다시: `RV_ARCHS=x86_64 RV_SKIP_BUILD=1 bash …`.
3. **Rosetta 시험**(아래 체크리스트) + Apple Silicon 설치 확인(0.9.0 때와 같은 항목).
4. 업로드 준비(업로드 아님):
   `node scripts/release-manifest.mjs ~/rv-release-091-intel/input <dist checkout> 0.9.1 ~/rv-release-091-intel/statements --targets darwin-aarch64,darwin-x86_64`
   (윈도우·리눅스가 같이 준비되면 그 파일도 같은 input 에 넣고 `--targets` 에 추가 — 한 번에.)
   `latest.json` 에 `platforms.darwin-x86_64`·`signed_releases.darwin-x86_64` 가 생겼는지 눈으로 확인 → dist 커밋·푸시 → `node scripts/verify-published-release.mjs 0.9.1 --targets darwin-aarch64,darwin-x86_64`.
5. `https://rvn.ex.erci.se/update/darwin/x86_64/0.8.3` 가 0.9.1 과 `signed_releases.darwin-x86_64` 를 돌려주는지 확인(서버 경로는 `${target}-${arch}` 일반 처리라 고칠 것 없음).
6. 사이트 인텔 링크 되살리기(아래 6절) — 업로드가 끝난 뒤에.

### 스크립트 `~/rv-release-091-intel/run-091-intel.sh` (사본: `docs/handoff/run-091-intel.sh`)
run-090 의 안전장치를 그대로 유지하고 대상 반복으로 바꿨다.
- 유지: 디스크 검사(대상 1개 20GB + 대상당 12GB), WANT_SHA(이제 `RV_WANT_SHA` 필수·기본값 없음), 판 번호 세 곳, 언어 사전, 서명 신원, dmg 사전 정리 1b(대상별 bundle 폴더만), 명세 서명 줄 `env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `RV_SKIP_BUILD`/`RV_SKIP_NOTARIZE`, `tauri.conf.json` 원상 복구 trap.
- 더함: 공식 꾸러미 해시 대조(SHA-256/512) → 꺼내기 → `lipo -archs` 로 아키텍처 확인 → 맥 기본 밖 라이브러리 거절 → `codesign --force --options runtime --timestamp`. 앞 대상의 바이너리가 남지 않게 매번 지우고 다시 넣음. 빌드 뒤 앱 본체·ravend·ipfs 가 그 대상 아키텍처인지 다시 확인. 산출물 95,000,000 바이트 상한 미리 검사. 마지막에 `signed-release-metadata.mjs` 의 `verifyStatement` 로 두 명세 서명을 공개키로 다시 확인. 원본 설정은 작업 파일이 아니라 `git show HEAD:` 에서 꺼냄(지난 실행이 남긴 수정에 오염되지 않게). 작업 폴더에 커밋 안 된 추적 변경이 있으면 멈춤(artifacts/ 제외).
- `RV_MIN_MACOS`(기본 비움) — 7절 위험 참고.

---

## 5. Rosetta 시험 체크리스트 (대표 맥 = Apple Silicon)

인텔 전용 앱(x86_64 만 든 앱)은 Apple Silicon 에서 **자동으로 Rosetta 로** 돈다. 「Rosetta를 사용하여 열기」 체크는 유니버설 앱에만 있다.

🔴 **같은 앱 ID(`se.erci.ex.playx.raven`)라 데이터 폴더·지갑·업데이트 최소 판 기록이 지금 쓰는 Apple Silicon 앱과 같다.** 실제 지갑이 있는 계정에서 시험하지 말고 **새 macOS 사용자 계정**(시스템 설정 → 사용자 및 그룹)에서 한다.

1. 설치 전 확인(지금 계정에서 해도 됨 — 실행 아님):
   ```bash
   cd ~/rv-release-091-intel/input && hdiutil attach -nobrowse -readonly RavenVault-Desktop-0.9.1-mac-intel.dmg
   A="/Volumes/RavenVault Desktop/RavenVault Desktop.app"
   lipo -archs "$A/Contents/MacOS/playx-raven" "$A/Contents/Resources/vendor/ravend" "$A/Contents/Resources/vendor/ipfs"   # 셋 다 x86_64
   spctl -a -vvv -t exec "$A"; hdiutil detach "/Volumes/RavenVault Desktop"
   ```
2. 새 계정에서 dmg 를 열어 응용 프로그램으로 옮기고 실행. Rosetta 가 없으면 설치 창이 뜬다(이 맥은 이미 있음).
3. 활동 모니터 → 「종류」 열: `RavenVault Desktop`, `ravend`, `ipfs` 가 **Intel** 로 표시.
   (터미널로 직접 띄워 볼 때: `arch -x86_64 "/Applications/RavenVault Desktop.app/Contents/MacOS/playx-raven"`)
4. 첫 실행: Gatekeeper 경고 없이 열림 · 버전 0.9.1 · 화면 언어 바꾸기.
5. 노드: 「지금 상태」에서 레이븐 노드가 켜지고 블록을 받기 시작(완전 동기화까지 볼 필요 없음).
6. 파일창고(IPFS): 「파일창고가 없습니다」가 나오지 않음.
7. 새 시험 지갑 만들기 → 잠그기/풀기. **실제 지갑·시드는 쓰지 않는다.** 송금하지 않는다.
8. 설정 → 업데이트 확인: 「최신」 또는 업로드 전이면 0.9.0 이 아니라 「확인 실패/없음」 정도가 정상(0.9.1 이 아직 안 올라감).
9. 백업 화면 열기만(복원 누르지 않음) · 라비 패널 열기 · 창 모드 바꾸기 · 종료 후 `ravend`·`ipfs` 가 남지 않음.
10. 시험 계정 삭제.

**Rosetta 로 확인할 수 없는 것(미검증)**: 실제 인텔 CPU·인텔 GPU 의 웹뷰 그리기, 오래된 맥의 느린 디스크에서 노드 동기화, macOS 12~15 에서의 동작(이 맥은 26.5), 업데이트 끝까지(0.8.3 인텔 → 0.9.1 설치·재시작)는 공개 후에만 가능.
인텔 맥이 있으면: 0.8.3 인텔 설치 → 공개 후 업데이트 받기까지 보는 것이 가장 확실하다.

---

## 6. 사이트에서 인텔 링크를 되살릴 때 바꿀 곳

지금 `~/wt-rv-wallet-final12`(ravenvault 저장소, `claude/rv-wallet-final12`, 커밋 전 작업 중)가 인텔 옛 링크를 **지우는 중**이다. 0.9.1 공개 뒤 되살릴 곳:

| 파일 | 지금(final12) | 바꿀 것 |
|---|---|---|
| `release-site/download/download.js` | `URL_OK` 가 `mac-apple-silicon.dmg` 만 허용, `MAC_FILE` 하나 | `mac-intel.dmg` 도 허용, 맥 카드에 파일 2개 |
| `release-site/download/index.html` | 맥 카드에 Apple Silicon 단추 하나 | Intel 단추(`data-platform-file="mac-intel.dmg"`) 추가 |
| `release-site/download/mac-only-copy.mjs` | `dlLead`·`dlChip` 10개 언어 「Apple Silicon 전용, 인텔은 웹 지갑」 | 아래 문구로 교체(파일 이름도 바꿀 만함) |
| `release-site/download/copy.mjs`, `copy-euro.mjs` | 단추 이름 | 「Apple Silicon」「Intel」 두 단추 이름 |
| `release-site/download/download.test.mjs` | final12 시험이 `mac-intel` 이 **없음**을 단언 | 있음을 단언하도록 |
| `release-site/api/gateway.mjs` | `suffixes=['mac-apple-silicon.dmg']` | `'mac-intel.dmg'` 추가(업데이트 `platforms` 쪽은 이미 `darwin-x86_64` 를 받아 줌) |
| `release-site/gateway.test.mjs` | — | 설치 항목 2개 |
| `release-site/build.mjs` | `mac-only-copy.mjs` 복사 목록 | 파일 이름을 바꾸면 같이 |
| `release-site/landing/site.js` | `downloadDesktop`·`descriptionDownload`·`hmGetBody` 10개 언어 「Apple Silicon」 | 「Mac(Apple Silicon·Intel)」 |
| `release-site/landing/index.html`, `shop.html`, `i18n-manual/*.json` | 같은 문구의 정적 사본 | 같이 |
| `~/playx` `public/rvn/{index,en,ja,zh}.html` (옛 사이트) | 이미 `PLAY-X-Raven-latest-mac-intel.dmg` 링크가 있음(지금은 0.8.3) | **고칠 것 없음** — 0.9.1 에서 `darwin-x86_64` 를 포함하면 `release-manifest.mjs` 가 이 별칭을 0.9.1 로 덮는다 |

참고: final12 의 러시아어 `dlLead` 에 「Версии для Версии для」 중복이 있다(이번 레인 범위 밖이라 안 고침).

### 맥 카드 문구 제안 (A안: 두 단추)
브라우저는 인텔 맥과 Apple Silicon 을 구별하지 못한다(둘 다 「Intel Mac OS X」로 보고). 그래서 고르게 하고, 고르는 법을 한 줄로 알린다.

- 제목: **Mac 앱 받기**
- 단추: **[Apple Silicon (M1 이상)]** · **[Intel]**
- 안내(ko): 「Apple 메뉴 → 이 Mac에 관하여에서 『칩』이 보이면 Apple Silicon, 『프로세서』가 보이면 Intel이에요. Intel Mac은 macOS 12(Monterey) 이상에서 파일창고까지 쓸 수 있어요.」
- 안내(en): "Open the Apple menu → About This Mac. If you see “Chip”, choose Apple Silicon; if you see “Processor”, choose Intel. Intel Macs need macOS 12 (Monterey) or later for file storage."
- 오래된 맥 노드 안내(선택): 「쓰지 않는 Intel Mac을 노드 컴퓨터로 켜 두기에도 좋아요.」

(B안 유니버설이었다면 「모든 Mac(Apple Silicon·Intel)용 한 파일」 한 단추였겠지만 위 이유로 채택하지 않음.)

---

## 7. 위험

1. **최소 macOS 불일치** — 앱 Info.plist 의 `LSMinimumSystemVersion` 은 10.13 인데 포함한 kubo 는 macOS 12.0 이 있어야 돈다(ravend 는 10.14, Tauri 2 웹뷰는 10.15). macOS 10.15~11 의 인텔 맥은 설치·실행은 되지만 파일창고가 켜지지 않는다(0.8.3 인텔도 같은 처지일 가능성 높음). `RV_MIN_MACOS=12.0` 으로 올리면 새 설치는 깔끔하지만, **macOS 11 이하의 0.8.3 인텔 사용자가 자동 업데이트를 받으면 새 앱이 아예 안 열린다**(Tauri 업데이터는 최소 macOS 를 보지 않음). 그래서 기본값은 그대로 두고 사이트에 「macOS 12 이상」을 알리는 것을 권한다. 바꿀지는 대표 결정.
2. **두 레인 판 충돌** — 0.9.1 은 한 번만 공개 가능. 윈도우·리눅스 레인과 같은 커밋·같은 manifest 실행으로 묶어야 한다.
3. **`release-manifest.mjs` 의 notes 가 0.9.0 문구로 고정** — 그대로 돌리면 0.9.1 공지에 0.9.0 내용이 나간다.
4. **Rosetta ≠ 인텔** — 실제 인텔 맥 시험 없음. Apple 발표(WWDC 2025)로는 Rosetta 가 macOS 27 이후 일부 용도로만 남을 예정이라 대표 맥에서의 인텔 시험 경로도 오래가지 않는다.
5. **0.8.3 → 0.9.1 건너뛰기** — 인텔 사용자는 0.8.4~0.9.0 을 건너뛴다. Apple Silicon 에서 0.8.3 → 0.9.0 직행이 이미 있었으므로 데이터 이전은 같은 길이지만, 인텔에서 확인한 적은 없다.
6. **툴체인** — PATH 기본 rustc 는 Homebrew 1.97.1, 스크립트는 rustup 1.98.1 로 두 대상을 빌드한다(0.9.0 Apple Silicon 이 어느 쪽으로 빌드됐는지는 로그에 안 남음). 동작 차이는 없을 것이나 판이 다르다는 점은 기록.
7. 0.8.4 때 만든 인텔 0.8.4 설치본(`~/rv-release-084/intel-held-e54cc42/`)은 공개하지 않은 보류본이다. 쓰지 말 것(옛 판·옛 커밋).
