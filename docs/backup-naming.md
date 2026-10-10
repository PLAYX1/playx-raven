# 백업 이름 — 레이븐볼트로 바꾸기 (2026-10)

대표 요청: 백업이 `PLAYXRaven-Backup` 폴더에 저장돼 헷갈린다 → 「레이븐볼트」로.
대표 확인(2026-10-10): 외부 사용자가 아직 없으니 과한 호환 장치 없이 단순하게. 단, 대표 컴퓨터에
옛 이름 백업이 실제로 있으므로 **옛 백업은 읽기 전용으로 계속 찾고 열 수 있어야 한다.**

## 이름 표

| 무엇 | 새 이름 (지금 앱이 씀) | 옛 이름 (읽기만) | 어디서 정함 |
|---|---|---|---|
| 백업 폴더 (USB·클라우드·직접 고른 폴더) | `RavenVault-Backup/` | `PLAYXRaven-Backup/`, 그 안의 `RavenVault Desktop 백업/`·`PLAY X Raven 백업/`, 더 옛 `PLAYXRaven-백업/`, 직접 백업 `RavenVault Desktop 백업/`·`PLAY X Raven 백업/` | `backup.rs` `BACKUP_DIR` |
| 최신 백업 파일 | `RavenVault.zip.pxlock` (잠금 끈 USB면 `RavenVault.zip`) | `PLAYXRaven.zip.pxlock`, `PLAYXRaven.zip`, `PLAYXRaven.zip.잠김` | `backup.rs` `FILE_STEM` |
| 가게 이름 붙은 직접 백업 | `RavenVault-<가게>.zip.pxlock` | `PLAYXRaven-<가게>.zip.pxlock` | `publish_archive` |
| 한 판 전 사본 | `RavenVault-previous.zip.pxlock` | `PLAYXRaven-이전.zip.pxlock` | `backup_storage.rs` `previous_path` |
| 완료 영수증 | `.RavenVault.zip.pxlock.complete.json` (모든 새 파일) | `.PLAYXRaven.zip.pxlock.complete.json` (자동 백업에만 있었음) | `backup.rs` `receipt_path` |
| 폴더째 백업(「지금 백업」) | `RavenVault-<16자리>/` + `.backup-complete.json` | 같음 (`PLAYXRaven-<16자리>/` 도 읽음) | `backup_now` |
| 이 컴퓨터 안 날짜 백업 | `backups/2026-10-10/` (안 바뀜) | — | `auto_to` |
| 잠금 확장자 | `.pxlock` **유지** | `.잠김` | 아래 「확장자」 |
| 잠금 파일 머리말 | `PXRLOCK1` (안 바뀜, 형식) | — | `lockbox.rs` |
| 저장 중 잠금 | `.RavenVault.zip.pxlock.publish-lock` | — | `backup_storage.rs` |
| 앱 데이터 폴더 | `PlayXRaven` (**절대 안 바꿈** — 번들 ID 짝) | — | `paths.rs` |
| 화면 글자 | 「레이븐볼트 백업」 | (옛 이름은 목록에 작게 「옛 이름」) | `main.ts`·`dict.ts` |

zip 안 설명서는 `READ-ME.txt` 그대로다.

## 확장자 `.pxlock` 을 안 바꾼 이유

안전이 이름보다 먼저다. 이미 깔린 옛 앱의 되돌리기 파일 고르기 거르개는 `pxlock`·`zip`·`잠김`만 받는다.
확장자를 `.rvlock` 등으로 바꾸면 옛 앱만 있는 컴퓨터(새로 산 컴퓨터에 옛 설치 파일을 깐 경우 포함)에서
새 백업이 회색으로 떠 고를 수 없다. 파일 형식 자체(`PXRLOCK1`)도 그대로라 확장자를 바꿀 실익이 없다.

## 호환 규칙

1. **새 백업은 늘 새 폴더에.** 옛 이름 폴더가 있어도 거기에 쓰지 않는다(예전 코드는 `PLAY X Raven 백업`
   폴더가 있으면 그리로 썼는데, 이번에 없앴다).
2. **옛 파일은 읽기만.** 지우기·옮기기·이름 바꾸기·덮어쓰기·자동 복사 없음. 시험이 바이트 단위로 확인한다.
3. **찾기는 한 목록**(`recover::backup_folders` → `backup_find::find`, 화면 [이 컴퓨터] → 「백업 찾기」).
   기본 위치(내 서류함·바탕화면)·클라우드 동기화 폴더·외장 디스크·이 컴퓨터 안 날짜 백업을 한 번에 훑고,
   새 이름·옛 이름을 같이 찾아 최근 것부터 정렬한다.
4. **같은 백업은 한 번만.** 같은 경로(겹치는 뿌리)는 한 번, 같은 내용(SHA-256)은 새 이름 → 검증된 것 → 최근 순으로 하나만 남기고 나머지 경로는 `also` 에 적는다.
5. **검사는 체계별로.**
   - 새 이름: 완료 영수증이 **있어야** 하고 크기·SHA-256 이 맞아야 한다. 없거나 다르면 목록에서 빼고 「확인되지 않아 뺀 파일 N개」로만 센다.
   - 옛 이름: 영수증이 있으면 맞아야 하고(다르면 뺌), 없으면 받되 「완료 기록 없음」 표시(옛 직접 백업·`-이전` 파일엔 원래 영수증이 없었다).
   - 둘 다: `.pxlock`/`.잠김` 은 `PXRLOCK1` 로 시작해야, `.zip` 은 `PK` 또는 `PXRLOCK1` 로 시작해야 한다. 빈 파일·링크·4 GB 초과는 뺀다.
   - 폴더째 백업: `.backup-complete.json` 이 있으면 내용과 맞아야 한다. 새 이름 폴더는 완료 기록이 필수, 옛 이름 폴더는 `wallet.dat` 이 있으면 「완료 기록 없음」으로 받는다.
6. **열기(되돌리기)는 이름이 아니라 내용으로.** `unpack_with` 는 앞 8바이트 `PXRLOCK1` 로 잠금을 알아본다 — 이름이 뭐든 같은 길로 연다.
7. **이중 노드 경고는 그대로.** 레이븐볼트 백업도 원래 컴퓨터가 꺼진 것을 확인한 뒤에만 켠다(`backup.rs` 맨 위).

## 대표가 직접 해 볼 확인 (실제 지갑 없이)

1. 새 판을 깐 뒤 [이 컴퓨터] → 백업 → USB 한 줄을 눌러 백업한다.
   파인더에서 `USB/RavenVault-Backup/RavenVault.zip.pxlock` 과 숨김 파일 `.RavenVault.zip.pxlock.complete.json` 이 생겼는지 본다
   (숨김 파일 보기: ⌘⇧.).
2. 같은 USB 의 `PLAYXRaven-Backup` 폴더 수정 날짜가 **안 바뀌었는지** 본다.
3. [이 컴퓨터] → 「처음 한 번 하는 것들」 펼치기 → 「백업 찾기」. 새 백업과 옛 `PLAYXRaven` 백업이 한 목록에, 최근 것이 위에, 옛 것엔 작게 「옛 이름」이 붙어 보이는지.
4. 옛 백업 줄의 「이 백업 열기」를 누르면 내용(지갑·가게·회원 수)이 보여야 한다. **「이대로 되돌리기」는 누르지 않는다** — 확인만.
5. 한 번 더 백업하면 `RavenVault-previous.zip.pxlock` 가 생기고 목록에 「이전 판」으로 보인다.

## 위험·한계 (확신 낮은 것 포함)

- 첫 자동 백업 날, 외장 디스크·클라우드에는 새 폴더에 **처음부터 한 벌** 새로 쓴다(옛 폴더의 오늘 영수증은 안 본다). 공간을 백업 한 벌만큼 더 쓴다. 옛 폴더 정리는 대표 결정.
- 「백업 찾기」는 클라우드 폴더의 백업을 끝까지 읽어 지문을 낸다. iCloud 에서 「다운로드 안 됨」 상태인 파일은 읽는 순간 내려받기가 시작될 수 있고 오래 걸릴 수 있다(실제 iCloud 로는 시험 못 함).
- 옛 날 버전이 만든 이름 중 이 표에 없는 것(예: 사장이 손으로 바꾼 이름)은 목록에 안 나온다 — 그때는 「백업에서 되돌리기」로 직접 고르면 내용으로 열린다.
- 외장 디스크 찾기는 백업 때와 같은 목록(`list_external`)을 쓴다. 맥 `/Volumes` 아래 네트워크 공유가 있으면 그것도 훑는다(읽기만).
- 윈도우·리눅스는 이번에 실기 확인하지 않았다(코드 경로는 같다).
