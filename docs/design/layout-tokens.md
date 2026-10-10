# 레이아웃 토큰과 관문 (레이븐볼트 데스크탑)

대표 요구(2026-10-11): 「화면이 글씨가 밀리고 칸이 좁고 그런 디자인 없이, 카카오톡처럼 잘 디자인되어야 한다.」

이 문서는 **숫자(토큰)** 와 **그 숫자를 지키는지 재는 시험(관문)** 을 한 곳에 둔다.
CSS 변수 파일: `src/layout-tokens.css`(설정 칸 모듈 `src/display-mode.ts` 가 들여와 큰 창 전체에 적용).
색은 바꾸지 않는다 — `index.html` 의 `--bg/--panel/--text/--muted/--line/--ravi…` 그대로(정체성 유지).

## 1. 토큰

| 묶음 | 변수 | 값 | 규칙 |
|---|---|---|---|
| 간격 | `--sp-1…--sp-10` | 4·8·12·16·20·24·32·40px | 4px 격자. 카드 안 여백 12~16, 카드 사이 8~12, 구역 사이 24 |
| 글자 | `--fs-xs/sm/md/lg/xl/2xl` | 12·13·15·17·20·28px | **12px 미만 금지**(현재 사이드바 11px — 아래 목록). 본문 15 |
| 큰 숫자 | `--fs-num` | clamp(28px, 4vw, 44px) | 자간 `--tr-display`(-0.02em), 고정폭 숫자(tabular-nums) |
| 줄 높이 | `--lh-tight/snug/body` | 1.15 · 1.3 · 1.5 | 큰 글자는 좁게, 본문은 넓게 |
| 칸 폭 | `--col-min` | 7.5em | 글이 들어가는 칸은 이보다 좁게 만들지 않는다(「3줄 넘게 꺾이는 48px 칸」 금지) |
| 본문 폭 | `--measure` | 68ch | 설명 글 한 줄 최대 |
| 말풍선 | `--bubble-max` | min(72%, 560px) | 좁은 칸(≤360px)은 86% |
| 누름 영역 | `--hit` / `--hit-min` | 44px / 24px | 큰 창은 44 권장, 미니·칩 보조 단추만 24 하한 |
| 누름 간격 | `--gap-hit` | 8px | 단추끼리 붙지 않게(「초기 설정」「휴대폰 연결」 0px 붙음 — 아래 목록) |
| 모서리 | `--radius-sm/…/bubble` | 6·10·14·18px | |
| 움직임 | `--ease-out` · `--ease-in-out` | (.23,1,.32,1) · (.77,0,.175,1) | 들어옴 ease-out, 화면 위 이동 ease-in-out. ease-in 금지 |
| 시간 | `--dur-press/fast/base/slow` | 100·160·220·320ms | 자주 쓰는 동작은 애니메이션 없음 또는 100ms. UI 는 300ms 이하 |

**글자 줄바꿈 규칙**
- 한국어는 낱말 단위(`word-break: keep-all`), 정말 안 들어갈 때만 쪼갬(`overflow-wrap: break-word`).
  `overflow-wrap: anywhere` 는 **주소·해시·말풍선 안**에서만 — 단추에 쓰면 넓은 자리에서도 「설 / 정」으로 쪼개진다
  (`index.html` 의 `main button { overflow-wrap:anywhere }` 가 그랬다 → `layout-tokens.css` ⑦ 로 덮음: 실측 낱말 쪼개짐 58건 감소).
- 한 줄 칸은 `white-space:nowrap` + `text-overflow:ellipsis` + `min-width:0`(flex 자식) 셋을 같이. 말줄임 없이 잘리면 관문 실패.
- 번역하지 않는 기호(S/M/L 크기 글자 등)는 `data-fixed-text`.

## 2. 대화(카카오톡 기준) — `src/chat-thread.ts` + `.rvc-*`

| 규칙 | 값 / 동작 |
|---|---|
| 말풍선 최대 폭 | 72%(560px 상한), 좁은 칸 86% |
| 긴 낱말·주소·txid | `overflow-wrap:anywhere`, 코드체는 `break-all` — 가로 넘침 0 (관문이 280px 폭에서 확인) |
| 시각 | 말풍선 **바깥 아래** 정렬, 고정폭 숫자, 같은 사람·같은 분 연속이면 마지막 줄에만(`timeShown`) |
| 입력창 | 1~6줄 자동(`rows` 속성 — style 속성을 쓰지 않아 Tauri nonce CSP 안전), 넘으면 안에서 스크롤 |
| 바닥 고정 | 바닥 48px 안에 있을 때만 새 글을 따라 내려감. 위를 읽는 중이면 「새 글 ↓」 단추 |
| 키보드 | Enter 보내기 · Shift+Enter 줄바꿈 · **한글 조합 중 Enter 무시**(isComposing) · 기록에서 ↑/↓ 말풍선 이동 · End 바닥 |
| 낭독 | 기록은 `role=log aria-live=polite`, 입력창 이름표 |
| 작은 창 | 컨테이너 폭 ≤360px 이면 시각 숨김·말풍선 86% |
| 움직임 | 새 말풍선만 160ms 아래→위 6px(ease-out), 움직임 줄이기면 없음 |
| 보안 | 글자는 전부 textContent(남이 쓴 글일 수 있다) |

**적용 상태:** 부품과 규칙만 이번에 만들었다. 기존 라비 대화(`ravi-agent.ts`·`ravi-panel.ts` 등)는 다른 에이전트가 고치는 중이라
**건드리지 않았다** — 같은 클래스·변수로 옮기는 것은 다음 단계(접점이 큼).

## 3. 관문 — `scripts/layout-gate-browser.test.mjs` (`npm test` 에 포함)

- 실제 Chrome, 빌드된 dist, 합성 자료(`desktop-fixture.mjs`). 노드·지갑·네트워크 없음.
- 글자 다섯 가지: 원문 · **+60%** · **+100%** · **독일어 긴 합성어**(Wiederherstellungsschlüssel…) · **러시아어**(Синхронизируется…).
  숫자·기호만 있는 칸(금액·시각·••••)은 늘리지 않는다.
- 폭: 320 · 390 · 768 · 1024 · 1440 × 라이트·다크(대기화면은 다크만, 미니·칩은 실제 창 크기 160×40·220×60·300×140·360×260, 대화는 280 추가).
- 재는 것(`scripts/layout-check.mjs`):

| 종류 | 뜻 | 관문 |
|---|---|---|
| `doc-overflow` | 문서 가로 스크롤 | 실패 |
| `offscreen` | 요소가 화면 오른쪽 밖(가로 스크롤 상자 안은 제외) | 실패 |
| `clip` | overflow hidden 안에서 말줄임 없이 잘림 | 실패 |
| `clip-y` | 세로로 잘림 | 실패 |
| `overlap` | 누를 수 있는 것끼리 **칠해진 부분**(글자·테두리·배경)이 겹침 | 실패 |
| `word-split` | 단추 안 한 낱말이 두 줄로 쪼개짐 | 실패 |
| `target-small` | 누름 영역 24px 미만 | 실패 |
| `narrow` | 48px 미만 칸에서 글이 3줄 넘게 꺾임 | 실패 |
| `ellipsis` · `target-under-44` | 말줄임(허용) · 44px 미만(권장 미달) | 표에만 |

- **새 화면은 반드시 0**: 미니(칩 포함 4 크기)·대기화면·설정 「표시 방식」 칸·대화 부품. (설정 칸은 큰 창 최소 폭 720 이상에서만 — 그보다 좁은 큰 창은 존재하지 않는다.)
- **기존 큰 창 화면**은 `scripts/layout-gate-baseline.json` 에 적힌 실패만 허용(2026-10-11: 124 열쇠). 새로 생기면 실패.
  고치면 `RV_LAYOUT_UPDATE=1 node --test scripts/layout-gate-browser.test.mjs` 로 기준선을 **줄인다**(늘리는 커밋 금지).
- 표·PNG: `artifacts/layout-gate/report.json`, PNG 는 `RV_LAYOUT_SHOTS=1`.
- 소요: 약 2분(기계가 바쁘면 6~7분).

⚠️ 관문을 만들며 헛짚은 것 둘(검사부터 의심하라):
1. 닫힌 `<details>` 안 요소는 `content-visibility:hidden` 이라 상자 크기가 남아 있다 → 「보임」으로 세면 겹침이 수천 건 나온다. `checkVisibility()` 로 거른다.
2. 투명한 넓은 `label` 상자·말줄임으로 잘린 글자 상자는 칠해지지 않은 자리다 → 겹침은 칠해진 부분(배경·테두리·글자 줄 상자를 자기 상자로 자른 것)으로만 잰다.

## 4. 기존 화면에 남은 것(기준선 요약, 실제 창 폭 ≥720 에서)

| 무엇 | 어디 | 원인 | 고치는 길 |
|---|---|---|---|
| 판 번호 단추 22px | 사이드바 `#appver` | `index.html` 이 `min-height:0 !important` 로 일부러 납작하게 | 사이드바 재배치 때(!important 를 또 !important 로 덮지 않음) |
| 「더 보기」 잘림 | 홈 `#rv-home-more` 768·1024 | 세 단추 한 줄 + overflow hidden | 단추 줄 `flex-wrap` 또는 「더 보기」를 아이콘 단추로 |
| 「백업 확인」·「보내기」 잘림(긴 말) | 홈 | 고정 폭 단추 | 최소 폭 대신 `min-width:max-content` + 줄 바꿈 |
| 보내기 단추 화면 밖 | 대화 `#tk-send` 768 | 입력 줄이 고정 폭 | 대화 부품(`.rvc-input`)으로 옮기기 |
| 사이드바 글(독일어) 쪼개짐·잘림 | `#upnag` `#rp-open` `#d-sum-row` | 사이드바 88px | 「중간」 규칙처럼 아이콘 + 툴팁, 글은 2줄 말줄임 |
| 사이드바 글 11px | 사이드바 전체 | 글자 하한 미달 | 12px 로(사이드바 폭 재조정 필요 — 대표 확인) |
| 320·390 폭 | 전 화면 | 큰 창 최소 폭이 720 이라 실제로는 안 생김 | 「자동 전환」(window-modes.md §6)이 들어오면 이 폭은 미니로 넘어간다 |
