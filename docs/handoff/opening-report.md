# 데스크탑 0.8.4 오프닝·종료·대기 개선 보고

작업 폴더: `/Users/gimmusong/wt-rv-desktop-084`  
브랜치: `claude/rv-desktop-084`  
작성일: 2026-10-09

## 기존 코드 위치와 확인 결과

| 화면·흐름 | 기존 위치 | 확인한 구조 |
| --- | --- | --- |
| 시작 오프닝 | `src/ravi-agent.ts`의 `createRaviAgentUI().start()` | 실제 오버레이와 말풍선을 생성. `raviFace("happy", 180)` 한 장을 사용하고 CSS 종료 이벤트 또는 2.1초 타임아웃에 착륙 처리했다. |
| 오프닝 모양 | `src/ravi-home.css`의 `.ravi-arrival-bird`, `@keyframes ravi-arrive` | 1.7초 전체 그림 이동·회전·스쿼시. 기존 관절 리그를 사용하지 않았다. |
| 홈과 부팅 | `src/ravi-home.ts`, `src/main.ts`의 부팅 초기화 | 홈·패널·런처 리그는 이미 별도 마운트. `raviAgentUI`에 `finishRaviLanding`/`afterRaviLanding`을 전달한다. |
| 입력 배리어 | `src/firstrun.ts` | 캡처 단계 클릭/Enter/Space 보류, 착륙 후 마이크로태스크에서 재실행. 공통 모달·온보딩·키 입력·파일 드롭도 이 배리어를 사용한다. |
| 창 닫기·트레이 종료 | `src-tauri/src/ravi_companion.rs`의 `open_main`, 작은 창 `CloseRequested`, `ravi-quit`; `src-tauri/src/lib.rs`의 `ExitRequested`/`Exit` | 요청에 언급된 메인 종료 확인 팝업은 현재 코드에 없었다. 메인 닫기는 WebView 파괴, 트레이 종료는 `app.exit(0)` 직행. 작은 컴패니언 닫기는 숨기기. 실제 종료 시 기존 서비스 정리 루틴 실행. |
| 유휴·컴패니언 | `companion.html`, `src/ravi-companion.ts`, `src/ravi-companion.css`, `src/ravi-physics.ts` | 별도 컴패니언 창과 물리 시뮬레이션. 기존 `idle` 90초 후 sleepy 및 `frameRate` 60/24/15/0 규칙. 메인 화면의 민감정보 가림막은 없었다. |
| 지갑 잠금 | `src-tauri/src/raven.rs::wallet_lock_state`, `src-tauri/src/wallet.rs::lock_wallet` | 암호 미설정/잠김/일시 해제 구분. 기존 Core 잠금 만료 시간을 사용하며 이번 화면이 만료 시간을 늘리거나 잠금을 해제하지 않는다. |

저장소 및 상위 경로에서 적용할 `AGENTS.md`를 찾지 못했다. 기존에 수정되어 있던 `desktop-084-browser.json`, `desktop-084-games.png`, `desktop-084-sales-hidden.png`는 이번 변경/커밋 대상에서 제외했다.

## 구현

### 오프닝

- `src/ravi-choreography.ts`: DOM과 분리한 곡선 보간과 2,400ms 동작 샘플러.
- `src/ravi-opening.ts`: 실제 리그 렌더링, 프레임 예산, 숨김 복귀, 완료 타이머, 건너뛰기 수명 관리.
- `src/ravi-rig.ts`: 기존 SVG와 `RaviPose`/관절 값을 사용한 명시적 프레임 렌더러. 단일 이미지 CSS 비행을 제거했다.
- 약 0–1.18초 곡선 비행과 리듬 있는 날갯짓. 곡선 접선·속도로 몸 기울임을 계산하며 말미에 날개를 펴고 감속한다.
- 1.18초 발 접촉 → 두 번의 작은 반동 → 몸·꼬리 털기 → 눈 깜빡임·고개 갸웃 → 한쪽 날개 인사. 2.4초 후 말풍선.
- 라비 또는 보이는 「인사 건너뛰기」 단추를 누르면 착지 자세를 먼저 그린 뒤 배리어를 한 번만 해제한다. 일반 입력의 보류·재실행 규칙은 유지했다.
- reduced-motion은 220ms 제자리 페이드 인사. 숨김 상태에서도 완료 타이머가 착지 자세를 확정하므로 입력이 영구 보류되지 않는다.
- 말풍선은 토큰 색상을 사용하고 위치를 분리하여 말풍선이 나타날 때 새 전체가 위로 튀지 않게 했다.

### 종료 확인

- 새 `src/ravi-lifecycle.ts/css`: 네이티브 `<dialog>` 모달, 제목·설명 연결, 상태 알림, 기본 포커스 「계속 쓰기」, Escape 취소와 모달 내부 Tab 이동.
- 「계속 쓰기」「트레이에 두기」「종료」. 트레이가 없으면 해당 단추를 숨기며 Rust에서도 다시 검사한다.
- `src/ravi-lifecycle-copy.ts`를 기존 한국어 원문 키 `t()`/`DICT`에 연결: 한국어·영어·일본어·중국어.
- `src-tauri/src/ravi_lifecycle.rs` 추가. 메인 닫기·트레이 종료·OS 종료 요청이 모두 확인창으로 향한다. 부팅 전에 들어온 닫기 요청도 원자 플래그에 보존했다가 리스너 준비 후 소비한다.
- 기존 `sendingNow`와 네이티브 전송 중 개수를 확인한다. Core의 기존 `is_send_method` 목록 및 공개 전송 경로를 RAII 가드로 보호하여 종료 준비와 새 전송의 경쟁을 막는다. 인수·주소·금액은 저장하지 않고 개수만 센다.
- 암호화된 열린 지갑은 `lock_wallet` 성공 후 상태를 재조회한다. 실패하면 종료하지 않고 재시도 가능한 확인창을 유지한다.
- 이미 잠김/암호 미설정/상태 미확인을 구분한다. 상태를 읽을 수 없는 지갑에 대해 잠겼다는 보증을 하지 않는다. 상태 미확인·암호 미설정 상태의 명시적 종료는 허용하되 그 사실을 표시한다.
- 성공 시 약 760ms 날개 인사와 눈 감기 뒤 실제 종료. 기존 `Exit` 서비스 정리 루틴을 그대로 탄다. 트레이에 두기는 앱과 주문 접수를 유지하고 메인 창을 가린다.

### 대기 화면과 성능

- 메인에서 90초 무입력 시 불투명한 대기 모달. 창이 숨겨질 때도 가림 상태를 준비한다.
- 배경과 하위 요소의 가시성을 차단하며 잔액·주소·시각·대화·알림을 대기 화면에 복제하지 않는다. 모달 바깥은 키보드/접근성 상호작용에서도 격리된다.
- 24초의 조용한 동작 주기: 졸음·느린 호흡, 가끔 두리번거리기·기지개·하품. 같은 샘플을 기존 작은 컴패니언에도 적용했다.
- 첫 마우스/키 입력은 깨우기에 사용하고 배경 버튼으로 전달하지 않는다. 짧은 인사 뒤 돌아오며 그때까지 정보를 계속 가린다.
- 깨우기는 지갑 잠금을 해제하지 않는다. 기존 자동 잠금 만료 시간과 독립적인 화면 가림이다.
- 대기·종료 화면 표시 시 홈·패널의 배경 리그와 음성 입력을 멈춘다.
- 기존 `createFrameLoop`/`frameRate` 재사용: 활성 60fps, 배터리 24fps, 유휴 15fps, 숨김 0fps. Battery API가 없는 WebView에서는 기존 컴패니언 배터리 절약 설정도 사용한다.
- 기존 `--bg`, `--panel`, `--text`, `--muted`, `--line`, `--ravi-soft` 및 상속 글꼴 사용. 밝은/어두운 테마에서 동일한 여백·정렬·포커스 구조.

## 검증

최종 명령 결과는 `opening-checks/results.json`과 각 로그에 기록했다.

| 검사 | 실제 결과 |
| --- | --- |
| `npm test` | 통과: 39/39, 실패 0 |
| `npm run typecheck` | 통과, 종료 코드 0 |
| `npm run check:pre-release` | 통과: build·firstrun·companion·home 검사 |
| `cargo test --manifest-path src-tauri/Cargo.toml ravi_lifecycle --lib --offline` | 통과: 1/1, 다른 787개는 필터됨 |
| `cargo check --manifest-path src-tauri/Cargo.toml --offline` | 통과, 기존 경고 40건 |
| `git diff --check` | 통과 |
| `node scripts/check-opening-browser.mjs` | 실패: Chrome 실행 불가, PNG 0장 |

빌드의 기존 큰 청크 경고와 Rust 미사용 코드 경고는 남아 있다. 전체 Rust 시험 및 실제 GUI 검사를 통과했다고 주장하지 않는다.

- Node 시험: 보간 끝점·범위, 유한 좌표, 감속·날갯짓·두 반동·인사 순서, reduced-motion, 숨김 폴백, 완료/건너뛰기 순서, 배리어 단일 해제, 프레임 예산, 유휴 가림·입력 소비, 전송 중 종료 차단, 잠금 실패 시 종료 금지, 정직한 상태 문구, 3개 번역 열 완전성.
- 기존 `check-firstrun.mjs`: 새 타이밍/즉시 착지에 맞춰 기대값을 갱신하고 보류 입력·경고·명시적 요청의 불변 조건을 유지했다.
- 기존 컴패니언 검사에서 오래된 “메인 닫기는 즉시 WebView 파괴” 계약을 새 “메인 확인창 경유” 계약으로 명시적으로 변경했다.
- Rust: 실제 전송 없이 가드 획득/해제·종료 중 거부 단위 시험과 오프라인 컴파일 검사.

### 브라우저/GUI 확인 한계

`node scripts/check-opening-browser.mjs` 실행 결과: **Chrome 프로세스 시작 실패** (`Failed to launch the browser process!`). `opening-captures/result.json`에 실패로 기록했다. 캡처 또는 육안 검증을 통과했다고 보고하지 않는다.

스크립트는 실제 모듈/리그/CSS를 번들하고 모든 네트워크를 합성 응답으로 가로챈다. 실행 가능한 환경에서는 오프닝 0/25/50/75/100%, 종료·대기 4개 언어 × 밝은/어두운 테마, 전송 중·각 잠금 상태·종료 인사·reduced-motion PNG를 저장하고 입력 배리어·모달 포커스·가림·실패 처리도 검사한다.

```sh
node scripts/check-opening-browser.mjs
# Chrome 경로가 다른 경우
CHROME_PATH=/path/to/chrome node scripts/check-opening-browser.mjs
```

실제 Tauri 창 닫기/트레이/OS 종료, WebKit 접근성, 실제 배터리 전환 및 최종 움직임의 육안 품질은 이 환경에서 미검증이다. GUI를 실행하여 지갑·송금·메인넷에 접근하지 않았다.

## 자산·범위

추가 그림/소리를 생성하지 않았다. 기존 파츠의 한계와 향후 선택 자산은 `opening-art-needs.md` 표에 기록했다. 시드·키·비밀번호를 읽어 옮기거나 보고서에 담지 않았다. 송금·메인넷 실행·배포·push·새 worktree 생성은 하지 않았다.

## 커밋

지정한 `git -c core.hooksPath=/dev/null commit`을 시도하고 결과를 아래에 기록한다. 파일시스템 제한으로 Git 메타데이터 쓰기가 막히면 `commit-opening.sh`로 동일한 파일 목록만 스테이징·커밋하도록 인계한다.


실제 결과: `git add`와 `git -c core.hooksPath=/dev/null commit -m "Refine Ravi rig opening, quit confirmation, and idle privacy"` 모두 종료 코드 128. 작업 폴더 밖 Git 메타데이터의 `index.lock` 생성이 `Operation not permitted`로 거부되었다. **커밋은 생성되지 않았다.**

`docs/handoff/commit-opening.sh`를 작성하고 실행 권한 및 `bash -n` 문법 검사를 확인했다. 지정 브랜치를 확인하고, 이미 스테이징된 다른 작업이 있으면 중단한다. 이번 작업 파일만 추가하고 동일한 hooks 비활성 커밋을 실행한다. push는 포함하지 않는다.
