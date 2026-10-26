# 레이븐볼트 2단계 · 라비 상주 모드와 물리 반응

**전달 상태: 구현 번들 제공. 요청 전체 완료는 아님.** 전역 단축키는 공식 `tauri-plugin-global-shortcut`이 캐시에 없고 crates.io DNS 접근이 차단되어 연결하지 못했다. 단축키 후보 저장은 구현했지만 실제 등록·충돌 감지는 작동하지 않는다. 화면에도 이 사실을 표시한다. 다른 단축키 의존성으로 대체하지 않았다.

기준 HEAD: `c9aec815dfb18eeb56ea1f9ad750a495d79c05fa` (agent1 반영 상태). 전달 ref: `refs/heads/claude/companion`. 번들: `artifacts/companion.bundle`. 작업 폴더·확인한 상위 경로·관련 하위 경로에서 AGENTS.md를 찾지 못했다. 사용자가 지정한 문서·소스 및 폰의 rig.ts/RaviParts.tsx는 읽었으며 폰 파일은 수정하지 않았다.

## 구현

- 별도 `companion.html` 진입점과 SVG 라비. 큰 화면의 코드·양식·대화를 상주 웹뷰에 적재하지 않는다. 120/160/200px, 밝은/어두운 배경, 눈·부리·깃털·고개 표정, 최대 12개 반짝임.
- 라비 트레이 아이콘과 부르기/숨기기, 큰 화면, 인사, 로그인 자동 실행, 종료 메뉴. 자동 실행은 기존 autostart.rs를 재사용한다. 트레이 생성 실패 시 큰 창을 열어 접근 경로를 확보한다.
- 트레이 아이콘 원본은 자체 SVG. OS 트레이 API가 요구하는 RGBA만 예외적으로 생성한다. 컬러 16/32/48/64px, macOS 템플릿 22/44px. 재생성: `python3 scripts/generate-ravi-tray.py`. 캐릭터 애니메이션에는 새 비트맵·GIF·캔버스를 쓰지 않는다.
- 드래그·던지기·마찰·모니터 경계 반사, 위치 저장. 물리 좌표와 네이티브 좌표를 분리하고 작업 영역으로 다시 제한한다. 다중 모니터 음수 좌표·간격·분리 상황을 순수 함수로 검사했다.
- 단일 클릭은 경량 말풍선, 이중 클릭은 큰 화면. 말풍선은 기존 오프라인 라비 안내를 사용한다. AI·홍보·지갑 작업은 큰 화면의 기존 경로에서 수행한다. 말풍선 질문을 AI에 자동 전송하거나 큰 화면에 자동 제출하지 않는다.
- 큰 창은 닫을 때 **숨기지 않고 웹뷰를 파기**한다. 트레이/Dock/라비에서 구성 파일로 다시 생성한다. 기존 드롭 이벤트 처리도 재설치한다. 창 종료와 앱 종료를 구별하고 노드·가게 서비스의 기존 종료 규칙을 유지한다.
- 재생성 시 허용 목록에 있는 마지막 페이지와 기존 저장 설정을 복원한다. 대화 DOM, 미완성 양식, 승인 화면, 비밀번호·키 입력은 복원하지 않는다. 이는 완전한 세션 복원이 아니라 **페이지·환경설정 복원**이다. 재개 시 시작 인사가 반복되지 않도록 프로세스 안에서 첫 창 여부를 기억한다.
- `src/ravi-physics.ts`: DOM 비의존, 고정 1/240초 적분, 시드가 있는 결정적 깜박임, 위치 오프셋·기울기·스케일 스프링, 관성·반사·감쇠, 착지 squash/stretch, 호흡·시선·졸림·집중·생각·도구 작업·기쁨·급이동 놀람·수면.
- 기존 RPC 응답과 주문 접수 처리에 고정된 기쁨 신호만 연결했다. 새 입금 조회용 네트워크 호출은 추가하지 않았다. 따라서 큰 창을 닫고 기존 서버도 조회하지 않는 지갑 전용 상태에서는 입금 반응이 실시간으로 보장되지 않는다. 거래·주문 값이나 AI 답변은 상주 이벤트에 넣지 않는다.
- 큰 화면의 실제 라비 상태와 도구 진행을 연결했다. 키 없는 기본 상태는 잠든 라비이며 안내 입력은 가능하다. 잠긴 지갑을 읽는 AI 도구의 기존 `locked` 검사와 노드의 잠금 만료 시각 처리는 수정하지 않았다.
- reduced-motion에서는 이동·회전·점프·파티클을 줄이고 짧은 투명도 변화·작은 호흡을 사용한다. 소리는 기본 꺼짐, 사용자 조작 후 AudioContext로 짧은 사인파를 합성한다. 마이크로 큰 소리를 감지하는 기능은 추가하지 않았다.
- 상주만 시작하는 설정에서는 창 내부 가장자리 진입·착지 연출을 한다. 화면 전체를 가로지르는 네이티브 비행 연출은 아니다.

## 플랫폼별 동작·제한

| 플랫폼 | 구현된 기본 동작 | 제한 / 검증 상태 |
|---|---|---|
| macOS | 44px 라비 템플릿 메뉴바 아이콘, 비투명 작은 배경판, 무테·항상 위, Dock으로 큰 창 재생성 | 네이티브 GUI·Retina·다중 화면 미검증. macOSPrivateApi 미사용 |
| Windows | 투명 무테·항상 위·작업표시줄 제외, 모서리 클릭 통과, 말풍선 전체 입력 가능 | 타원 근사 영역 바깥 모서리만 통과. 실제 SVG의 픽셀 단위 마스크는 아님. 2Hz 재판정으로 최대 약 0.5초 지연 가능. 실기기 미검증 |
| Linux X11 | 투명 무테·항상 위·작업표시줄 제외 요청, 이동·경계 제한 | WM·컴포지터마다 지원 차이. 창 생성 실패 시 일반 작은 창으로 재시도. 효과가 조용히 무시되는 환경은 설정에서 일반 작은 창 선택 |
| Linux Wayland | 처음부터 비투명·장식 있는 작은 일반 창, 제한 안내 | 강제 위치·항상 위·관성 있는 창 이동 보장 불가. 창틀 이동 사용. 글로벌 좌표/모니터 위치 저장은 컴포지터 제한, 실기기 미검증 |
| 모든 플랫폼 | 트레이와 말풍선, 단축키 후보 선택·저장 | **전역 단축키 미연결**. Option/Alt+Space, Alt+Shift+Space, Control+Shift+Space는 아직 후보 값뿐 |

플랫폼 정책은 `ravi_companion.rs`에 모았다. macOS 투명 배경은 사용 중인 Tauri 2.11.5 소스에서 `macos-private-api` feature가 필요한 조건부 API다. 공식 문서도 private API 및 App Store 제한을 명시하므로 비투명 대체를 선택했다. [Tauri 창 구성 문서](https://v2.tauri.app/reference/config/#transparent)

앱 이름·productName·번들 ID·버전·업데이트 주소·업데이트 공개키·Wix/NSIS 식별자는 변경하지 않았다. 서명 설정도 변경하지 않았지만 Developer ID 서명·공증·실제 업데이트 설치를 수행하지 않았으므로 배포 무영향을 실증한 것은 아니다. 실제 배포 전 기존 절차로 확인해야 한다. [Tauri macOS 서명·공증](https://v2.tauri.app/distribute/sign/macos/)

## 저전력·메모리

상주 렌더 스케줄은 대기 15fps 요청(디스플레이 정렬에 따라 약 12~15fps), 활동 60fps, 전력 절약 시 최대 24fps다. 숨김·페이지 숨김·blur 때 RAF, 렌더 timeout, 클릭 지연 timeout을 취소하고 오디오를 중단한다. 기존 Tauri에는 이 구현이 사용할 이식 가능한 가림 이벤트가 없어 **포커스 상실을 보수적으로 가림으로 처리**한다. 눈앞에 보이더라도 다른 앱에 포커스를 주면 라비 애니메이션이 멈출 수 있다. 전역 커서 표본은 활성 렌더 중 최대 2Hz다.

Windows 클릭 통과 판정은 별도 네이티브 2Hz 대기 루프를 사용한다. 웹 렌더가 멈춰도 클릭 영역 복구를 위해 창이 보이는 동안 유지하며, 숨기면 Condvar의 무기한 대기로 전환한다. Battery API 지원 시 배터리 방전 상태를 사용하고, API가 없는 WebView에서는 수동 전력 절약 스위치를 제공한다. OS 절전 상태의 자동 감지는 모든 플랫폼에서 보장되지 않는다. 큰 화면의 기존 리그 전체를 이 프레임 스케줄러로 바꾼 것은 아니다.

**목표:** 대기 중 앱+웹엔진 합계 RSS 70 MB (약 66.8 MiB) 이하, 큰 창 종료 후 더 낮아질 것. **실측 없음·목표 달성 미확인.** 이 샌드박스에서 `ps` 프로세스 조회가 거부됐고 실제 앱은 실행하지 않았다. `measure-attempt.log`는 PID 1을 사용한 권한 확인 실패 기록이며 앱 측정치가 아니다. 프런트엔드 분리 빌드 크기도 RSS를 대신하지 않는다.

허용된 테스트 장비에서 다음처럼 측정한다. 반드시 실제 키·지갑이 없는 모의 프로필을 사용하고 네트워크를 차단한다.

```sh
node scripts/measure-companion.mjs --launch /절대경로/레이븐볼트실행파일 --seconds 60
# 이미 실행한 모의 앱의 PID를 알고 있으면:
node scripts/measure-companion.mjs --pid 12345 --seconds 60
# macOS에서 재부모화된 해당 앱의 WebKit 프로세스를 확인한 경우:
node scripts/measure-companion.mjs --pid 12345 --engine-pids 12346,12347 --seconds 60
```

큰 화면 열린 대기 20초 → 큰 화면 닫기 → 라비만 대기 20초 → 라비 숨기기 순으로 비교한다. 스크립트는 `ps -axo pid=,ppid=,rss=,comm=`으로 부모·자식과 명시한 웹엔진 PID의 RSS를 합한다. argv·환경변수는 출력하지 않는다. ravend/IPFS/채굴/터널 자식은 별도 `serviceMiB`로 분리한다. macOS XPC 재부모화·공유 웹엔진을 자동 식별했다고 주장하지 않으며 웹엔진이 없으면 불완전한 측정이라고 출력한다. PID별 RSS 합에는 공유 페이지가 중복 포함될 수 있다.

Windows에서는 네이티브 PowerShell `Get-CimInstance Win32_Process`의 ProcessId/ParentProcessId/WorkingSetSize로 앱과 해당 WebView2 자식만 합산한다. WSL의 ps는 Windows 네이티브 앱의 대체 측정기가 아니다. 작업관리자의 프로세스 그룹과 교차 확인한다.

## 의존성·출처·라이선스

새 의존성은 최종 manifest/lockfile에 **추가되지 않았다**. Cargo/package lockfile과 기존 의존성 목록을 유지했다. SVG·트레이 생성기·합성음은 기존 라비 벡터를 바탕으로 이 저장소에서 작성했고 외부 이미지·음원을 받지 않았다. 폰 리그는 참고만 했다.

허용된 공식 플러그인 `tauri-plugin-global-shortcut`의 설치를 offline과 online으로 시도했다. 캐시 부재, `index.crates.io` DNS 실패(내부 재시도 포함)로 설치하지 못했다. Rust 플러그인만 설치하면 네이티브 트레이와 동일한 생명주기로 등록할 수 있으므로 JS 게스트 패키지가 필수인 설계는 아니다. 설치 후 실제 선택 버전·전이 의존성·라이선스와 Cargo.lock을 검토해야 한다.

- 공식 출처: [Tauri global-shortcut](https://v2.tauri.app/plugin/global-shortcut/), [공식 플러그인 소스·라이선스](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut). 상류 라이선스는 MIT / Apache-2.0 계열이며 실제 설치 버전은 아직 없다.
- Linux 전역 단축키의 기반 라이브러리는 X11 전용이라고 명시한다. Wayland 지원을 추정해서 표시하지 않는다. [Tauri global-hotkey 플랫폼 지원](https://github.com/tauri-apps/global-hotkey#platforms-supported)

## 검사 결과

정확한 명령별 종료 코드는 `checks-final.json`, 출력은 같은 폴더의 각 `.log`에 있다. 실제 AI·실제 송금·실제 메인넷 거래를 실행하지 않았다. 앱 GUI 자체도 실행하지 않았다.

- `npm run build`: 타입 검사와 프로덕션 빌드 통과. 기존 큰 화면 번들 크기 경고는 남아 있다.
- `scripts/check-ai-safety.mjs`, `scripts/check-send-confirmation.mjs`: 통과.
- `check-ravi-*.mjs` 전부 실행. companion, agent, key, panel, promo, promo-card, similarity, state, understanding, understanding2, understanding3, understanding5 통과. 60/120문항 계열과 예산·도구 안전 검사는 기존 모의 경로를 사용했다.
- panel-browser, promo-browser, understanding-browser: **Chrome 실행 실패, 미검증**. agent 검사는 모의 UI·Rust 8개가 통과했지만 포함된 Chrome 화면 검사는 미검증이다. 브라우저 실패를 통과로 바꾸지 않았다.
- 새 물리 검사: 수렴, 에너지 감소, 경계 반사·마찰·정지, 드래그 관성, 30/60fps 궤적 오차 1e-7 미만, 결정적 깜박임, 파티클 12개 상한, reduced-motion, 숨김 때 RAF/timeout 0개, RSS 합산, 페이지 상태 복원.
- Rust 상주 검사: 플랫폼 분기, 음수·분리 모니터, 큰 창 생성/소멸/재생성 모의, 명령 허용 목록, 설정 직렬화/거부, 실제 fixture 파일 저장·0600·손상 복구, 입금 중복 억제, 클릭 통과 영역.
- 요청한 `$HOME/rv-test-fixture` 전체 실행은 쓰기 제한으로 실패해 `/tmp/rv-test-fixture`로 재실행했다. 컴파일 중 발견한 invoke handler 타입 추론 오류를 수정했다. 병렬 전체 검사에서 발견한 설정 fixture 환경변수 경쟁도 공통 TEST_ENV 잠금으로 고쳤다.

아래 7개는 `/tmp`에서도 localhost 소켓 bind의 `Operation not permitted`로 실패한다. 기능 검사를 삭제하거나 성공으로 바꾸지 않았다.

```text
ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response
ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination
peers::tests::폴더_주소도_파일처럼_살아_있다고_본다
relay::tests::live_push_and_pairing_rooms_stay_off_disk
server::bind_probe::binding_the_phone_port_is_fast
server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers
upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length
```

전체 결과와 이 7개만 명시적으로 제외한 보조 실행 결과는 아래 최종 집계에 기록한다. 제외한 실행은 전체 통과가 아니다. 기존 ignored 검사도 그대로 남는다.

## 대표·Claude 실기기 확인과 다음 단계

1. 승인된 공식 global-shortcut을 다운로드할 수 있는 환경에서 설치·등록·해제·설정 변경 롤백을 구현한다. Alt+Space 충돌 시 대체 두 후보를 안내하고 선택한 단축키가 실제 등록된 경우에만 활성으로 표시한다. 단축키로 라비 표시 및 입력 포커스를 확인한다. 이 작업 전에는 2단계 전체 완료로 승인하면 안 된다.
2. macOS/Windows/X11/Wayland 각각 모의 프로필에서 트레이·더블 클릭·말풍선 입력·드래그·모니터 분리·배율 전환·재시작 위치·자동 실행 메뉴를 확인한다. Windows 투명 모서리를 통해 뒤쪽 앱을 누른 뒤 라비를 다시 클릭할 수 있는지 검증한다.
3. 큰 창을 닫고 웹엔진 프로세스/RSS가 줄어드는지 확인한다. 5회 닫기/복원 후 페이지·키 상태·라비 도구의 잠김 표시·기존 노드 서비스와 잠금 만료 동작을 확인한다. 승인·송금 입력이 재생성되어 자동 실행되지 않는지도 본다.
4. 15/60/24fps 상한, 숨김 시 JS 타이머·RAF 중단, 보수적 blur 중지, reduced-motion, 소리 기본 꺼짐, 3개 크기, 밝고 어두운 배경을 확인한다. 배터리 API가 없는 환경은 수동 절전 설정으로 검증한다.
5. 바인딩이 허용된 격리 환경에서 전체 cargo test와 실패한 브라우저 검사 3개를 재실행한다. 실측 RSS 70 MB 목표가 넘으면 의존성 추가 없이 guide 분리·웹엔진 수명 등을 다시 분석한다.
6. 기존 배포 파이프라인에서 Developer ID 서명·공증·Windows/Linux 패키지와 업데이트 설치를 검증한다. 현재 단계에서는 실제 배포·서명·업데이트 설치를 실행하지 않았다.

## 전달 방식

사용자 작업의 실제 Git 인덱스와 HEAD는 유지하고 임시 `GIT_INDEX_FILE`로 명시한 소스·이 보고서·검사 증거만 커밋한다. 기존 변경 및 다른 단계의 artifacts는 포함하지 않는다. ref와 bundle을 만들고 `git bundle verify`로 검사한다. push·태그는 만들지 않는다. 최종 커밋·번들 해시·기준 커밋은 별도 `delivery.json`에 기록한다.

## 최종 집계

- JavaScript 검사 17개 실행: 14개 통과, 브라우저 실행 실패 3개. agent 내부 화면 검사는 별도 미검증.
- `/tmp` 전체 Rust: `test result: FAILED. 746 passed; 7 failed; 13 ignored; 0 measured; 0 filtered out; finished in 14.36s`
- 소켓 제한 7개 제외 보조 Rust: `test result: ok. 746 passed; 0 failed; 13 ignored; 0 measured; 7 filtered out; finished in 14.30s`
- 새 상주 Rust 검사 8개 통과. 문서 테스트 1개는 기존 ignored 상태.
- 전체 Rust 통과 및 실기기 GUI·RSS·서명/공증 통과로 주장하지 않는다.
