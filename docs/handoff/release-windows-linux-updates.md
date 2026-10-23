# 윈도우·리눅스·맥 자동 업데이트 — 자동 게시 (2026-10-23)

## 한 줄 요약
새 판을 내는 일은 **태그 한 줄**이다. 나머지(빌드 → 번호 매기기 → 서명 → 검사 → 게시 → 공개 확인)는 CI(깃허브 서버)가 한다.

```
git tag v0.9.6 && git push origin v0.9.6
```
(태그 번호는 앱 판 번호와 같아야 한다: package.json·Cargo.toml·tauri.conf.json.)

## 흐름 (글로 그린 그림)
1. 태그 푸시 → 맥(2종)·윈도우·리눅스를 각각 빌드하고 패키지 서명(.sig)을 만든다.
2. 게시 작업이 산출물을 모은다. 하나라도 없으면 **전체 중단**(일부만 올라가지 않는다).
3. 지금 게시된 `latest.json` 의 sequence 를 읽어 **+1** 한 번호를 정한다. 같거나 낮은 버전은 거부한다.
4. 대상별(맥 2·윈도우·리눅스) 「서명된 진술」(version·sha256·target·expires·sequence)을 만들어 서명한다. 유효기간은 30일.
5. 95MB 상한, 서명·해시·대상 대조를 로컬에서 먼저 검사한다.
6. (연습이 아닐 때만) 모든 검사가 끝난 뒤 **한 번의 커밋·푸시**로 `dist` 에 올린다.
7. 푸시 뒤 공개 주소에서 모든 업데이트 주소를 다시 확인한다.

## 처음에는 연습(dry_run)부터
GitHub → Actions → 「설치 파일 만들기」 → Run workflow:
- version: 예) `0.9.6`, **dry_run: 체크(기본)** → 빌드·서명·검산까지만 하고 `dist` 에는 아무것도 올리지 않는다.
- 결과 묶음은 Actions 화면의 `release-candidate` 에서 받아 볼 수 있다.
- 연습이 통과하면 태그를 푸시하거나 dry_run 을 끄고 다시 돌린다(**태그 푸시는 항상 실제 게시**).

## 실패했을 때 보는 곳
- Actions 의 해당 실행 → 실패한 단계 로그. 단계 이름이 영어로 되어 있다: `Prepare, sign and verify the release` 가 번호·서명·검산, `Publish the whole version in one commit` 이 푸시.
- 「이미 게시된 버전과 같거나 낮다」: 판 번호를 올려서 다시 태그.
- 「산출물이 없다」: 해당 플랫폼 빌드 로그 확인. 이 경우 아무것도 게시되지 않았다.
- 게시 후 확인만 다시: 같은 워크플로를 verify_only 로 실행.

## 불량 판이 나갔을 때
게시된 판은 되돌릴 수 없다(앱이 낮은 번호를 거부하는 안전장치). **더 높은 버전의 수정판**을 다시 낸다. sequence 는 자동으로 +1 된다.

## 열쇠 — 알아 둘 위험
- 진술 서명에 쓰는 열쇠는 CI 에 이미 있던 `TAURI_SIGNING_PRIVATE_KEY`(앱의 updater 공개키와 짝)이다. 새 비밀값은 없다. `RELEASES_DEPLOY_KEY` 는 게시 단계에서만, 서명 열쇠는 서명 단계에서만 쓴다.
- 그래서 **저장소나 Actions 권한이 뚫리면 모든 사용자에게 악성 업데이트가 갈 수 있다.** 줄이는 방법(GitHub 설정에서 대표님이 켠다):
  1. 태그 보호: Settings → Rules → Rulesets → 새 태그 규칙 `v*` — 만들기·갱신·삭제를 대표 계정만.
  2. main 브랜치 보호: 직접 푸시 금지·PR 필수, 워크플로 파일(`.github/workflows/`)은 코드 오너 승인.
  3. 비밀값은 Environment 로 옮기기: Settings → Environments → `release-approval` 생성 + Required reviewers(대표) → 게시 작업(`publish`)에 `environment: release-approval` 한 줄을 더하면 **게시 전에 대표 승인 버튼 한 번**이 생긴다.
  4. 2단계 인증 필수, 저장소 접근 권한은 최소 인원.
- 진술 유효기간이 30일이라, 새 판이 30일 넘게 없으면 게시된 진술이 만료되어 앱이 업데이트를 받지 않는다. 그때는 아무 수정판이라도 한 번 내면 된다.

## 대상과 한계
- 자동 업데이트 대상: 맥(Apple Silicon·Intel), 윈도우 NSIS `…-setup.exe`, 리눅스 `.AppImage`. `.msi`·`.deb`·`.rpm` 은 대상이 아니다(앱이 「새 설치 파일을 받아 주세요」 안내).
- 리눅스는 AppImage 형식만 확인하고 버전은 서명된 진술의 값을 믿는다(윈도우는 설치 파일 안의 버전까지 대조).
- 실제 CI 에서만 확인되는 것: 진짜 열쇠로 서명(`tauri signer sign` 이 환경변수만으로 도는지, 비밀번호가 빈 값일 때), `RELEASES_DEPLOY_KEY` 푸시, 공개 주소 검증. 그래서 **처음은 반드시 dry_run**.

## 관련 파일
- `.github/workflows/release.yml` — publish 작업
- `scripts/auto-publish-flow.mjs` — 번호·서명·검산 흐름(푸시·네트워크 없음), 시험 `auto-publish-flow.test.mjs`
- `scripts/release-manifest.mjs`, `scripts/verify-published-release.mjs`, `scripts/prepare-update-statement.py`
- 정적 검사 시험: `scripts/release-workflow-static.test.mjs`
- 앱 쪽 검증: `src-tauri/src/update_policy.rs`, `secure_update.rs`, `pe_version.rs` (브랜치 claude/update-client)
