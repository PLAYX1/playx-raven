# 홈 접근성 보정 결과 — homefit2

2026-10-09. 지정 작업 폴더에서 제품 코드 수정과 로컬 검사를 수행했다. **브라우저 최종 통과는 미확인**이다. Chrome 실행 단계가 차단되어 수정 후 실측·스크린샷·실제 Tab 이동을 얻지 못했다. 이전의 넘침 0px를 이번 결과로 재사용하지 않았다.

## 기존 Chrome 실패 기록에서 확인한 요소

원본 `home-captures/after.json`과 기존 스크린샷을 보존했다. 16개 조합은 네 해상도 × 밝음/어두움 × 가게 없음/있음이다.

| 항목 | 기존 실패 | 확인 내용 |
|---|---:|---|
| Escape 후 홈 포커스 복귀 | 16 | 라비 패널은 홈의 `#ravi-open`으로 복귀하지만, `src/main.ts`의 언어 메뉴 전역 Escape 핸들러가 닫힌 상태에서도 설정 버튼으로 포커스를 이동시킴 |
| 단추 크기 또는 가시성 | 8 | 1440×900, 1728×1117의 모든 조합에서 **`#rv-home-more` / 잔액 카드 ‘더 보기’**. 크기 69.6875×44px, 좌표 (313.765625, 239), 오른쪽 383.453125, 아래 283. 크기·뷰포트 경계는 정상이나 `visible:false` |
| 키보드 순서 | 4 | 1024×640의 모든 조합. `extras.open:false`인데 원본 controls에는 닫힌 영역의 `#rv-home-nearby`, `#rv-home-games`, `#rv-home-chat`, `#rv-home-sales`의 레이아웃이 남아 있음 |

버튼 실패의 기존 JSON에는 hit-test 상대 요소가 없어 정확히 무엇이 가렸는지 확정할 수 없다. 이번 하네스가 실패 버튼 이름·크기·위치·클리핑 조상·세 지점의 실제 hit-test 요소를 남기도록 보완했다.

## 수정

- `src/main.ts`: 언어 메뉴가 열려 있고 Escape가 아직 처리되지 않았을 때만 닫는다. 메뉴나 설정 버튼이 포커스를 소유한 경우에만 설정 버튼으로 복귀한다. 기존 라비 패널의 홈 복귀 동작을 다른 핸들러가 덮어쓰지 않게 했다. `src/ravi-panel.ts`의 복귀 경로는 이미 올바르므로 변경하지 않았다.
- `src/ravi-home.css`: 잔액 작업 버튼 세 개의 모서리 반경을 10px에서 6px로 줄여 모서리 안쪽 클릭 영역을 확보했다. 최소 높이 44px와 너비·행 높이는 유지했다. 기존 가시성 실패가 모두 해소됐는지는 Chrome 재실측이 필요하다.
- 닫힌 `#rv-home-extras`의 `.rv-home-shortcuts`를 명시적으로 `display:none` 처리한다. 닫힌 영역의 버튼을 레이아웃과 Tab 순서에서 함께 제외하고, 펼치면 기존 DOM 순서대로 복원한다.
- `index.html`: 기존 작업에 이미 있던 행 우선 순서(잔액 → 알림 → 최근 거래 → 라비 → 매출 → 더 보기)를 보존하고 주석으로 명시했다. 잔액 작업 버튼에 그룹 이름을 추가했다. 양수 tabindex는 추가하지 않았다.
- 카드 2열·3행, 지원 해상도의 한 화면 예산, 하단 Raven 띠 예정 빈 공간은 유지했다. 새 카드는 넣지 않았다.
- `scripts/check-home-browser.mjs`: 기존 단언을 그대로 유지했다. 카드 DOM 순서와 실제 좌표 정렬 비교를 추가했다. `controlFailures`, `keyboard.expected`, `keyboard.actual`, `keyboard.focusAfterEscape`를 JSON 및 실패 콘솔에 기록한다. `--out`은 기존 실측 자료를 덮어쓰지 않는 출력 경로 옵션이다.
- `scripts/check-ravi-panel.mjs`: 실제 패널 컨트롤러와 실제 main.ts 언어 메뉴 핸들러를 함께 실행하는 회귀검사를 추가했다. 예전 핸들러를 메모리에서 대입하면 이 검사가 실패하는 것도 확인했다.

## 실행 결과

| 실행 | 결과 | 증거 |
|---|---|---|
| `npm test` | 통과, 39/39, 종료 0 | [로그](homefit2-checks/npm-test.txt) |
| `npm run typecheck` | 통과, 종료 0 | [로그](homefit2-checks/typecheck.txt) |
| `npm run check:pre-release` | 통과, 종료 0. 빌드·첫 실행·companion·홈 산술/렌더 검사 포함 | [로그](homefit2-checks/pre-release.txt) |
| `npm run check:ravi-panel` | 통과, 종료 0. Escape 복귀·메뉴 포커스 소유권 포함 | [로그](homefit2-checks/ravi-panel.txt) |
| 예전 Escape 핸들러 메모리 대입 | 회귀검사가 기존 버그를 거부함. 종료 0 | `desktop listener must preserve panel return focus` 단언의 실패 확인 |
| `node --check scripts/check-home-browser.mjs` | 통과, 종료 0 | 문법 검사 |
| `node scripts/check-home-browser.mjs --out docs/handoff/homefit2-captures` | **차단, 종료 1**, `launch: Failed to launch the browser process!` | [JSON](homefit2-captures/after.json), [로그](homefit2-checks/browser.txt) |
| `git diff --check` | 통과 | 공백 검사 |

브라우저 `checks`는 빈 배열이다. Chrome이 시작되지 않아 localhost 수신 단계까지 도달하지 못했다. 따라서 이번 수정의 세로·가로 넘침, 가시성, 실제 키보드 순서, 브라우저 포커스 복귀는 통과로 선언하지 않는다. pre-release의 홈 검사는 CSS 산술 및 합성 렌더 검사이며 실브라우저 증거가 아니다. 빌드에는 기존 번들 크기 경고가 있다.

사용자 환경 재검사:

```sh
npm run build
node scripts/check-home-browser.mjs --out docs/handoff/homefit2-captures
```

16개 조합 모두 `passed`, 넘침 0, `controlFailures:[]`, expected/actual 일치, `focusAfterEscape:ravi-open`인지 확인해야 한다. 기본 `node scripts/check-home-browser.mjs` 명령도 그대로 동작하며 기존 home-captures 경로에 결과를 쓴다.

## 작업 범위와 커밋

민감 파일과 실제 자격 증명은 열거나 복사하지 않았다. 실제 송금·메인넷 쓰기·실서버 배포·push를 하지 않았다. 외부 전송 코드를 추가하지 않았다. 공개 조회도 이번 작업에는 필요하지 않았다. 브라우저 하네스의 외부 요청 차단을 유지했다.

작업 시작 전 존재한 index.html의 홈 개편은 필요한 선행 변경으로 보존한다. 기존 home-captures 자료, 산술 산출물, 병렬 Rust 변경은 이번 커밋 대상에서 제외한다. src-tauri/vendor, src-tauri/target, dist 및 바이너리도 제외한다.

`git add`는 작업 트리의 `index.lock` 생성 권한이 없어 종료 128로 실패했다(`Operation not permitted`). 요청한 `git -c core.hooksPath=/dev/null commit --only ...`도 시도했다. 새 파일을 포함한 첫 시도는 미등록 pathspec으로 실패했고, 추적 파일만 지정한 재시도도 잠금 파일 생성 권한으로 실패했다. **커밋은 생성되지 않았다.**

복구용 [commit-homefit2.sh](commit-homefit2.sh)를 남겼다. 지정 파일만 stage하고 `--only`로 커밋하므로 다른 병렬 작업의 staged 변경을 포함하지 않는다. 권한이 있는 사용자 환경에서 `bash docs/handoff/commit-homefit2.sh`로 실행할 수 있다. 스크립트는 push·배포를 하지 않는다.

## 2026-10-10 재검증 (Opus 5.5)

- 이 맥에서 실제 Chrome 이 정상 실행되어 `node scripts/check-home-browser.mjs --out docs/handoff/homefit2-captures` 를 다시 돌렸다. **16/16 PASS, 종료 0**. 모든 조합 넘침 0px, `controlFailures:[]`, keyboard expected=actual, `focusAfterEscape: ravi-open`, 브라우저 오류 0. 위 「브라우저 최종 통과 미확인」은 이 결과로 대체한다. 증거: `homefit2-captures/after.json`·`after.md`·PNG 16장, `homefit2-checks/browser.txt`.
- 같은 트리에서 `npm test`(39/39), `npm run typecheck`, `npm run check:pre-release`, `check-ravi-panel`, `check-sales-browser`, `check-opening-browser`, `cargo check --locked`, `cargo test --locked --lib`(775 통과·13 무시) 모두 종료 0. 로그는 `homefit2-checks/`.
- HEAD 44b0648 은 `src/main.ts` 가 `#rv-home-extras`·`#rv-home-nearby`·`#rv-home-games`·`#rv-home-sales` 를 쓰지만 `index.html` 에 그 요소가 없어 시작 처리에서 null 접근이 난다. 이 커밋의 `index.html` 이 그 누락을 메운다(0.8.4 필수).
- 병렬 Rust 작업(explorer·publicdata·price·mining·lib.rs)은 0.8.4 에서 제외하고 `claude/rv-desktop-084-wip-gpt` 브랜치(eec2a9b)에 보관했다.
