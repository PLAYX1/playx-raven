# 라비 감정 시스템 (감정형 레이븐볼트)

작성 2026-10-11 · 브랜치 `claude/rv-emotion` · 상태: 엔진·규칙·문구·큰 창 연결 완료, 미니 창·트레이는 호환 인터페이스까지

대표 요청: 「어떤 상황에서는 라비가 행복해하고, 어떤 상황에서는 다른 감정을 보이는 것을 심어서 감정형 프로그램이 되게 하고 싶다.」

## 1. 구조 — 한 방향으로만 흐른다

```
앱 곳곳 ──emitRaviEvent("deposit_confirmed")──▶ 감정 엔진 ──Display──▶ 화면(크기별) ─▶ 얼굴·움직임·말풍선·낭독·소리 슬롯
          (이름만, 값 없음)                        규칙표·우선순위·합치기·쿨다운·만료
```

| 파일 | 하는 일 |
|---|---|
| `src/ravi-emotion-rules.ts` | 규칙표(데이터만): 이벤트 38종 → 감정·우선순위·지속·합치기·쿨다운·문구·소리 슬롯·움직임·serious |
| `src/ravi-emotion.ts` | 상태 기계(DOM 없음, 시계 주입 가능) · 크기별 표현 `expressionFor` · 미니/트레이 호환 · 전역 버스 `emitRaviEvent` |
| `src/ravi-emotion-copy.ts` | 문구 ko→[en, ja, zh]. 불러오면 DICT 에 **없는 것만** 채움(dict.ts 무수정) |
| `src/ravi-face-emotion.ts` | 기존 `ravi-face.ts` 는 그대로, 새 감정을 「기존 표정 + 덧그림」으로 |
| `src/ravi-emotion-view.ts` · `.css` | 말풍선·톤 점·스프링 움직임·낭독(live region 하나) |
| `src/ravi-emotion-app.ts` | 큰 창 연결: 기본 얼굴은 `setAllRaviMood` 를 그대로 거침, 밤·오래 안 씀 감시 |

기존 이름(`RaviMood` 12종, `setMood`, `raviFace`)은 하나도 바꾸지 않았다.

## 2. 지금까지 감정이 정해지던 곳 (작업 전, 기준 4398376)

| 상황 | 감정 | 어디서 | 표시 |
|---|---|---|---|
| 앱 시작·열쇠 연결 | surprised→wake→happy→normal | `main.ts animateRavi` | 모든 `.ravi-face` + 「빠밤!」 |
| 열쇠 없음 | thinking 0.65초 → sleep | `animateRavi` | 잠든 라비 |
| 홈에서 새 받기 감지 | surprised 1.3초 | `main.ts` 최근 거래 확인 | 얼굴만 |
| 보내기 검토 — 주소 무효 | worried(풀리지 않음) | `reviewSend` | 얼굴만 |
| 주소 끝 4자리 불일치 | worried | `reviewSend` | 얼굴만 |
| 보내기 끝 | happy 1.4초 | 보내기 확정 | 얼굴만 — **돈이 나간 일을 기뻐함(부적절)** |
| AI 생각 중 / 끝 | thinking / normal·sleep | `chatDebate`·`chatPopThinking` | 얼굴 |
| 컴패니언 알림 | joy + 소리 | `ravi-companion.ts` | 상주 라비 |
| 라비 홈 | idle·sleep·thinking·joy·speaking | `ravi-home.ts` | 홈 큰 라비 |

문제: 감정이 곳곳에 하드코딩, 우선순위·지속 규칙 없음(경고 뒤 다른 표정이 덮음), 말·소리·크기 규칙 없음.

## 3. 감정 규칙표

우선순위: **경고(alert 4) > 오류(error 3) > 돈(money 2) > 사람(social 1) > 일상(ambient 0)**. 화면엔 가장 급한 것 하나.

| 상황(이벤트) | 감정 | 지속 | 말풍선(한국어 원문) | 소리 슬롯 | 움직임 | 금지·비고 |
|---|---|---|---|---|---|---|
| 입금 감지(확인 전) `deposit_seen` | surprised | 4초 | 들어오는 게 보여요. 확인되면 알려 드릴게요. | soft | 끄덕 | 확인 전이라 **축하 안 함** |
| 입금 확인 `deposit_confirmed` | happy | 5초 | 입금이 확인됐어요. (여럿: 입금 {0}건…) | soft | 통통 | 20초 안 반복은 합침 |
| 입금 취소 가능 `deposit_dropped` | worried · serious | 12초 | 확인 전 입금이 사라졌어요. 상품을 보내기 전에 기록을 확인해 주세요. | attention | 없음 | |
| 새 주문 `order_received` / 판매 확인 `sale_done` | happy | 5초 | 새 주문이 들어왔어요. / 판매가 확인됐어요. | soft | 끄덕/통통 | |
| 첫 입금·첫 판매·판매 고개 | celebrate | 7초 | 첫 판매예요! 축하해요. 등 | bright | 반짝 1회 | 하루 1번. **가림 켬이면 happy + 「좋은 소식이 확인됐어요.」** |
| 새 팔로워 `follower_new` | fond | 4초 | 가게를 아껴 주는 분이 생겼어요. | 없음 | 끄덕 | 5분 쿨다운 |
| 고마워요/칭찬 `user_thanks` | shy | 3초 | 헤헤, 저도 고마워요. | 없음 | 갸웃 | |
| 노드 동기화 중 `node_syncing` | focused | 끝날 때까지 | 장부를 따라잡고 있어요. | 없음 | 없음 | |
| 동기화 끝 `node_synced` / 다시 정상 `node_recovered` | relieved | 3초 | 장부를 다 따라잡았어요. / 다시 정상이에요. | soft(정상화만) | 가라앉기 | |
| 노드 무응답·끊김·멈춤·잠들기 실패·확인 지연 | worried · serious | 풀릴 때까지(지연은 10초) | 노드가 응답하지 않아요. 입금 확인이 늦어질 수 있어요. 등 | attention | 없음 | |
| 보내기 검토 `send_review` | calm · serious | 60초/닫을 때까지 | 보내기 전에 주소와 금액을 한 번 더 확인해 주세요. | 없음 | 없음 | 2분 안 재검토는 말풍선 쉼 |
| 보낼 수 없음 `send_invalid` | calm · serious | 8초 | 이대로는 보낼 수 없어요. 표시된 칸을 확인해 주세요. | 없음 | 없음 | |
| 위험(주소 불일치) `risk_warning` | calm · serious | 30초 | 주소가 원본과 달라요. 보내지 마세요. | attention | 없음 | |
| 보냄 `send_done` · 구매 끝 `purchase_done` | relieved · serious | 3초 | 보냈어요. 기록에서 확인할 수 있어요. | **없음** | 가라앉기 | **돈이 나간 일은 축하 금지** |
| 오류 `error_generic`·`error_network` | apologetic | 8초 | 미안해요, 잘 안 됐어요. 잠시 뒤 다시 해 주세요. | oops | 처짐 | 해결 안내를 꼭 붙인다 |
| 오래 안 씀 `idle_long` → 복귀 `user_return` | sleepy → welcome | 머묾 → 3초 | (없음) → 다시 만나서 반가워요. | 없음 | 끄덕 | 죄책감 말 금지 |
| 밤 23~5시 `night_start` | sleepy | 아침까지 | 없음 | — | — | 밤엔 경고 소리만 |
| AI 생각 중 / 모를 때 | thinking / puzzled | 끝날 때까지 / 5초 | (없음) / 그건 잘 모르겠어요. 모르는 건 지어내지 않을게요. | 없음 | 갸웃 | |
| 열쇠 없음 / 연결 성공 | waiting / happy | 머묾 / 4초 | AI 열쇠를 넣어 주시면… / 연결됐어요! 무엇이든 물어보세요. | 없음 / soft | 통통 | 큰 창은 기존 「잠든 라비」 유지(아래 §8) |
| 백업 끝 `backup_done` | proud | 5초 | 백업을 마쳤어요. 백업 파일은 안전한 곳에 두세요. | soft | 끄덕 | |
| 지갑 잠금 `wallet_locked` | calm · serious | 3초 | 지갑을 잠갔어요. | 없음 | 없음 | |

감정 18종: neutral·happy·celebrate·fond·surprised·focused·thinking·worried·calm·apologetic·sleepy·asleep·welcome·waiting·puzzled·shy·proud·relieved.

## 4. 안전 불변식 (시험이 지킨다: `scripts/ravi-emotion.test.mjs`)

1. **값이 없다.** `emitRaviEvent(name)` 은 이름만 받는다. 금액·주소·글이 엔진에 들어올 자리가 없으니 「큰 입금이라 더 기뻐함」은 만들 수 없다.
2. **금액 가림 켬** → celebrate 금지, 건수({0}) 문구 금지, 「첫·번째·고개」 같은 단서 금지(모든 이벤트로 시험).
3. **serious(돈·보안 경고)** → 감정은 calm·worried·apologetic·relieved 만, 움직임 없음(어느 크기에서도), 소리는 attention 만, 느낌표·「헤헤」·「축하」 금지(ko·en).
4. **돈이 나가는 일**(보내기·구매) → relieved, 소리 없음. 감정으로 쓰기를 부추기지 않는다.
5. **어두운 패턴 금지** — 「지금 사·놓치·서두르·마지막 기회·외로웠·보고 싶었·왜 안」, en 「buy now·hurry·don't miss·missed you」 문구 시험.
6. **깜빡임** — 감정 CSS 에 `infinite` 없음, 모든 움직임 1초 이하·1회, 반짝임 1회(초당 3회 상한보다 훨씬 아래). 기존 얼굴의 눈 깜빡임(4.2초)·zZ·생각 점(1.2초 주기)은 기존 그대로.
7. **IPC 무증가** — 감정 파일은 `invoke` 를 쓰지 않는다. 버스는 문자열만 받고 모르는 이름은 버린다.
8. 감정 표시 실패는 본 기능을 막지 않는다(`emitRaviEvent` 는 try/catch, 구독자 오류 격리).

## 5. 크기별 규칙 — 작을수록 단순

| 크기 | 얼굴 | 움직임 | 말풍선 | 톤 |
|---|---|---|---|---|
| 큰 창 홈·프로필(≥96px) | 기본 표정 + 덧그림 | 있음 | 4줄까지 | 고리 |
| 중간(대화 아바타 40–64px) | 기본 + 덧그림 | 반짝 → 통통으로 낮춤 | 4줄까지 | 고리 |
| 미니 창 L | 기본 + 덧그림 | 끄덕 하나로 | 한 줄(말줄임) | 점+모양 |
| 미니 창 M | 기본 표정만 | 없음 | 한 줄 | 점+모양 |
| 미니 창 S·칩(≤32px) | 기본 표정만 | 없음 | 없음(알림 제목이 대신) | 점+모양 |
| 트레이(메뉴바) | 없음 | 없음 | 없음 | 아이콘 3벌(normal·alert·sleep)+점 |

색에만 기대지 않게 톤마다 모양이 다르다: 따뜻함=하트, 차분=고리, 경고=삼각형, 쉼=달, 보통=점.

## 6. 움직임 (apple-design · emil-design-eng 적용)

- 얼굴 움직임은 **스프링**(Apple의 damping·response): 끄덕·가라앉기·처짐은 damping 1(넘침 없음), 통통·반짝·갸웃만 0.7–0.78. 곡선을 샘플링해 WAAPI 로 1회.
- **중단 가능**: 새 감정이 오면 앞 움직임을 지금 위치(`getComputedStyle().transform`)에서 끊고 다시 간다. 600ms 안 연속은 건너뜀.
- 말풍선은 CSS transition(도중에 바뀌어도 자연스럽게 되돌아감). 등장 220ms 강한 ease-out, 퇴장 150ms(퇴장이 더 빠름), `scale(.97)` + 투명도(0에서 튀어나오지 않음), 얼굴 쪽 모서리(`transform-origin: 0 100%`)에서 나온다.
- **동작 줄이기**: 이동·크기 변화 0, 투명도 교차만(브라우저 시험으로 확인).
- 돈·보안 경고: 움직임 없음. 진지함이 움직임보다 먼저다.

자체 점검(review-animations 기준):

| 항목 | 상태 |
|---|---|
| 목적 없는 움직임 | 없음 — 새 감정의 등장 때만 1회 |
| 빈도 | 같은 일 합치기·쿨다운·말풍선 6초 간격 → 자주 보는 일엔 움직임 0 |
| `transition: all` / `ease-in` | 없음 |
| scale(0) 등장 | 없음(.97/.6+투명도) |
| 무한 반복 | 감정 쪽 0. 기존 `rv-bob`(2.4초 둥실)은 손대지 않음 — 0.4Hz 라 Apple 기준(0.2Hz 근처 느린 반복 회피)에 걸리진 않지만, 대표 선택지로 남김 |
| 중단 가능 | 얼굴(WAAPI 지금 값에서 재시작)·말풍선(transition) 모두 |
| 동작 줄이기 | 이동 0 확인(시험) |
| transform/opacity 만 | 예(고리 box-shadow 전환 320ms 하나만 예외 — 작고 드묾) |

## 7. 접근성

- 낭독: 앱에 live region(`role=status`, polite) **하나**. 같은 말 30초 안 반복 금지, 경고가 아니면 8초에 한 번까지. 말풍선 자체는 `aria-hidden`(두 번 읽지 않게).
- 얼굴 `aria-label` 은 짧은 상태(「라비가 걱정해요」) — live 아님.
- 대비: 말풍선 글자 15.4:1(다크)–18.0:1(라이트), 톤 모양 ≥5.0:1(그래픽 기준 3:1 이상).
- `prefers-contrast: more` 에서 테두리 2px·그림자 없음.

## 8. 연결 지점 (main.ts 에 꽂은 한 줄들)

| 위치 | 전 | 후 |
|---|---|---|
| `setAllRaviMood` 아래 | — | `import { mountRaviEmotionApp, emitRaviEvent }` + `queueMicrotask(mount…)` |
| 홈 새 받기 감지 | surprised + 1.3초 타이머 | `emitRaviEvent("deposit_seen")` |
| `reviewSend` 주소 무효 | worried | `emitRaviEvent("send_invalid")` |
| 검토 화면 열림 | — | `emitRaviEvent("send_review")` |
| 끝 4자리 불일치 | worried | `emitRaviEvent("risk_warning")` |
| 보내기 끝 | happy + 1.4초 타이머 | `emitRaviEvent("send_done")` |
| `closeSend` | — | `emitRaviEvent("send_closed")` |
| 백업 끝 | — | `emitRaviEvent("backup_done")` |
| 지금 잠그기 | — | `emitRaviEvent("wallet_locked")` |

일부러 **안 꽂은 곳**(다른 브랜치가 고치는 중이거나 기존 연출과 겹침):
- 대화 `chatDebate`/`chatPopThinking`(라비 대화 수정 브랜치) → `ai_thinking`/`ai_done`/`ai_unknown` 을 꽂으면 됨.
- `animateRavi`(첫 인사·열쇠 연결 연출) → 기존 연출 유지. 원하면 끝에 `key_connected`.
- 라비 홈 큰 그림(`ravi-home.ts`)은 자체 모드(idle·joy…)만 있어 worried/calm 을 못 그림 → 다음 단계: `raviHome.mood()` 에 감정 톤 전달.
- 미니 창(`claude/rv-mini-window`): `mini-main.ts` 의 `listen("mini-notice")` 안에 한 줄 — `const ev = miniKindToRaviEvent(n.kind); if (ev) engine.emit(ev);` 그리고 `createEmotionView(host, face, { size: "mini-" + size, … })`. 미니 창 파일은 이 브랜치에서 고치지 않았다.
- 트레이: Rust `ravi_companion.rs` 에 이미 `tray_badge_image()` 가 있다. `trayHint(display)` 의 variant(normal·alert·sleep)를 이벤트(`companion-state`)로 넘기면 됨 — 아이콘 2벌(alert·sleep) 추가가 필요해 이번엔 설계만.
- 소리: 슬롯 id(`ravi.soft`·`ravi.bright`·`ravi.attention`·`ravi.oops`)만 낸다. 큰 창은 소리 끔이 기본(`soundOn` 미연결) — 「라비 소리」 설정과 잇는 것은 컴패니언/미니 창 쪽 작업.
- 금액 가리기: 큰 창에는 아직 가림 상태가 없어 `masked` 미연결(미니 창 `snapshot.masked` 와 잇는 것이 정석).

## 9. 위험 — 연출이 신뢰를 해치는 경우

- **돈 이야기에 감정이 끼면 판단을 흐린다.** 그래서 serious 규칙·나가는 돈 축하 금지를 시험으로 묶었다. 규칙표를 고치는 사람이 이 시험을 끄지 않게 할 것.
- **거짓 기쁨**: 확인 전 입금을 축하하면 사라졌을 때 배신감이 크다 → 확인 전은 「보여요」까지만.
- **잦은 말풍선은 소음** → 합치기·쿨다운·6초 간격. 그래도 장사가 바쁜 가게는 많을 수 있다(대표 선택 §10).
- 기본 그림의 **별 눈동자**는 들떠 보여 경고 표정과 어긋났다 → calm·worried·apologetic 에서는 둥근 눈 덧그림으로 덮었다(기존 얼굴 파일은 그대로).
- 큰 창 오른쪽 아래 말풍선은 클릭을 막지 않지만 화면 아래 내용을 몇 초 가릴 수 있다. 대화 화면에서는 띄우지 않는다.

## 10. 대표가 고를 것

1. **감정의 폭**: (A) 지금(절제 — 기념일만 반짝, 경고는 무표정에 가까운 진지함) / (B) 더 풍부(입금마다 통통·하트) / (C) 더 절제(표정만, 말풍선은 경고만).
2. **말풍선 빈도**: 지금 일상 6초 간격·같은 일 합치기. 바쁜 가게용 「말풍선은 경고만」 설정을 둘지.
3. **소리**: 슬롯 4개를 어떤 소리로(밝은 소리는 기념일만?), 기본 켬/끔, 밤 조용한 시간(지금 23–5시는 경고 소리만).
4. **밤 졸림**: 밤에 일하는 사장님께 졸린 라비가 「일 그만하라」로 읽힐 수 있다. 유지/끔.
5. 기존 `rv-bob`(얼굴이 늘 위아래로 둥실) 유지 여부.

## 11. 시험

- `npm run check:ravi-emotion` = 단위 14 + 브라우저 갤러리 11.
- `node --test scripts/ravi-emotion-app-browser.test.mjs` = 실제 앱(dist·합성 fixture)에서 버스→얼굴·말풍선·낭독, 경고 중 들뜸 없음, 페이지 오류 0.
- 갤러리: `artifacts/emotion-gallery/index.html` (감정 18 × 크기 5 × 라이트/다크 × 동작 줄이기, 표정 판, 크기 사다리, de·ru 긴 말풍선, 앱 캡처).
