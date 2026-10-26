# 레이븐볼트 데스크탑 메모리 예산

> 대표 요구: 「레이븐볼트가 메모리도 적게 먹어야 한다.」
> 노드를 늘 켜 두고 미니 창·메뉴바·대기화면으로 쓰는 사람이 늘어난다 — **안 볼 때 가장 가벼워야** 한다.

작성 2026-10-11 · 기준 `claude/rv-signed-lists-desktop` 4398376 · 브랜치 `claude/rv-memory-budget`
측정 원자료: `artifacts/memory-budget/*.json` · 시험: `npm run test:memory` (npm test 에도 포함)

표기: **실측** = 이 문서 작업에서 직접 잰 값 · **추정** = 코드·일반 지식 근거, 재지 않음 · **측정 불가** = 이유와 함께.

---

## 1. 한 장 요약

| 구성 요소 | 지금(대표 예: 가게 PC, 노드 상시) | 근거 | 가장 큰 지렛대 |
|---|---|---|---|
| 메인 웹뷰(큰 창, 숨겨도 살아 있음) | JS 힙 7.4–7.6MB, DOM 11천 개, 힙 스냅숏 14.5MB(실측, Chrome) / WebView 프로세스 전체 **150–300MB 추정** | 실측+추정 | 메뉴바 모드에서 창 **닫기(파괴)** |
| 라비 곁 창(companion) | 힙 4.9MB, DOM 302(실측) / 프로세스 **40–80MB 추정** | 실측+추정 | 번역 사전 안 싣기 |
| 미니 창(mini, 다른 브랜치) | 힙 0.8MB, DOM 97, 타이머 0(실측) | 실측 | 이미 가볍다 |
| Rust 본체 | **30–80MB 추정** | 추정(앱을 띄워 재지 못함, 6절) | 릴레이 저장소 상한 |
| ravend(메인넷) | regtest 바닥 **67MB**(실측) + 블록 색인·UTXO 캐시·mempool·연결 버퍼 → 메인넷 **수백 MB~(dbcache 상한까지)** 추정 | 실측+추정 | dbcache·maxmempool·연결 수 |
| kubo(IPFS) | 오프라인 18MB · lowpower 온라인 73–75MB · 기본 93–103MB(90초, 실측) | 실측 | 지갑 모드는 끈다(이미 그렇다) |

**이번에 고친 것(즉시·저위험)**: 숨김 상태에서 **초당 ~16번 전체 DOM 을 훑던 번역 고리**를 끊었다.
숨김 메인 스레드 사용 **76 → 1.1 ms/초**(98.6%↓), 보일 때 **91 → 26 ms/초**(71%↓), 숨김 IPC **31 → 24회/분**(그리기 호출 0).

---

## 2. 메모리 지도 (코드 근거)

### 2-1. 프로세스

| 프로세스 | 띄우는 곳 | 언제 | 비고 |
|---|---|---|---|
| RavenVault Desktop (Rust, Tauri 2) | — | 앱 실행 | 창 X = **숨기기**(`lib.rs` CloseRequested·`ravi_lifecycle.rs:70`). 메인 웹뷰는 숨겨도 **파괴되지 않는다** |
| WebView: main | `tauri.conf.json` `create:false` → 코드가 생성 | 늘 | macOS WKWebView(WebContent 프로세스 별도), 윈도우 WebView2(Chromium 프로세스 여럿) |
| WebView: ravi-companion | `ravi_companion.rs:543` | 곁 창 켰을 때 | 숨겨도 살아 있음(hide) |
| WebView: mini | `claude/rv-mini-window`(미병합) | 미니 창 | 이벤트 구동(폴링 없음) |
| ravend | `services.rs:375` `-datadir= -server=1` (+`-reindex*` 한 번) | 시작 시 자동(`boot.rs`) | **메모리 인자를 명령줄로 안 준다** — `raven.conf` 값만 쓴다 |
| ipfs(kubo) | `services.rs:458` `daemon --migrate=true` | 「가게」 모드만 자동(`mode.rs`) | 저장소 없으면 `init --profile=lowpower`(`boot.rs:58`) |
| cloudflared | `tunnel.rs` | 바깥 연결 켰을 때 | stdout/stderr 버리는 스레드 2개 |
| caffeinate | `awake.rs:100` | 「장사」 모드 | 약 1MB |

### 2-2. ravend 설정 출처

- 새 설치: `boot.rs prep_conf` 가 `server=1`, (장부 없을 때) `assetindex=1`·`addressindex=1` 만 쓴다. **dbcache·maxmempool·maxconnections 은 코어 기본값**(450MB·300MB·125).
- 템플릿(`conf.rs conf_templates`): 오래된 컴퓨터 `dbcache=300 maxmempool=100 maxconnections=16 prune=5000` · 보통 `450/40` · 가게용 `600/40 + 색인`.
- 첫 설정 추천(`setup.rs recommend_setup_for`): 메모리 16GB↑ 가게 전용 600, 16GB 450, 8GB 300, 그 밑 200 · 연결 16 또는 40 · mempool 100 또는 300.
- 따라잡기 가속(`conf.rs dbcache_boost`): (RAM−4GB)/2, 512~4096MB. 다 따라잡은 뒤 `dbcache_restore` 로 450 — **사람이 눌러야** 돌아온다.
- 시험·근거: 「절반을 주면 노드가 죽는다」 실측 이력(`conf.rs suggest_mb` 주석).

### 2-3. kubo 설정 출처

- `ipfs init --profile=lowpower`(새 저장소만). 사장이 직접 깐 기존 `~/.ipfs` 는 그 설정 그대로.
- 화면에서 바꿀 수 있는 것: StorageMax·GCPeriod·ConnMgr High/Low·Pubsub(`ipfsconf.rs`).
- `setup.rs` 는 가게 전용 데스크톱에 `default-networking` 을 권한다(실제로 적용하는 코드는 찾지 못함 — 확신 낮음).

### 2-4. 프런트엔드(메인 웹뷰)

| 항목 | 값(실측) | 메모 |
|---|---|---|
| `index.html` | 431KB | **19개 화면 전부가 처음부터 DOM 에 있다**(11천 노드). 화면 전환 = class 토글 |
| JS | 2,290KB(main 904KB · 공유 청크 `ravi-physics` 927KB · `cert-roster` 504KB 지연 로드) | 공유 청크에 번역 사전(`desktop-copy.ts` 489KB 원문, `dict.ts` 272KB)이 들어 있다 |
| 힙 구성(스냅숏 14.5MB) | native(DOM) 7.85 · 배열 2.21 · 코드 1.56 · 문자열 1.47(그중 한중일 0.89) | DOM 이 절반 이상. 사전은 1MB 안팎 |
| 상시 setInterval | 17개 살아 있음 | 대부분 「그리는 함수가 스스로 쉰다」 규칙(`main.ts` `쉬는중()`) |
| 라비 몸(rig) | 홈 120 프레임/초(몸 2개 × 60), 다른 화면 60 | **reduced-motion 에서도**, 안 보이는 런처 몸(0×0)도 돈다. `frameRate()`(idle 15fps)를 안 쓴다 |
| 이미지 | 고유 0.67MB(얼굴 420² webp, 9곳에서 공유) | 문제 없음 |
| 번역 | `startI18n` MutationObserver → 60ms 뒤 **전체 DOM** 훑기 | 고리 버그는 이번에 수리(5절) |

### 2-5. 상시 동작

| 무엇 | 주기 | 숨김에도? | 성격 |
|---|---|---|---|
| 지갑 감시 `지갑감시` (wallet_since·balance·lock_state·node_status·backup_survey) | 15초 | 돈다 | **일**(입금 알림) — 매번 RPC 5건 |
| 주문 지킴이 / 대화 지킴이 | 30초 / 45초 | 돈다 | 일 |
| 재색인·복구 창 확인 | 60초 | 돈다 | 일 |
| 상태 점·건강·네트워크·홈 요약 | 20–30초 | `쉬는중()` 이면 안 그림 | 그리기 |
| 돈 상태 `money_status` | 60초 | **이번에 숨김 시 멈춤** | 그리기 |
| 폰 연결 대기 `pairing_waiting` · QR 칠하기 | 10초 · 2초 | **이번에 숨김 시 멈춤** | 그리기 |
| Rust 릴레이 저장 | 5초(바뀌었을 때만) | — | 저장소 통째 복제 후 직렬화 |
| Rust 지도 「영업 중」 / 터널 감시 / 수수료 / 이웃 | 5분 / 5분 / 3분 / 30분 | — | 일 |
| 곁 창 커서 판정 스레드 | 2Hz(보일 때만) | 숨기면 대기 | 문제 없음 |
| awake(caffeinate) | 상시 | — | 1MB |

### 2-6. Rust 쪽 상한(메모리에 쌓이는 것)

| 저장소 | 상한 | 최악 크기(추정) | 메모 |
|---|---|---|---|
| `relay.rs STORE` (Vec<serde_json::Value>) | 5,000건 × 32KB | 원문 160MB, `Value` 로는 **수백 MB 가능** | 5초마다 통째 `clone` → 저장 순간 2배. 실제 가게 글은 수 KB 라 평소엔 작다 |
| `relay.rs EPHEMERAL` | 2,000건·24시간 | 64MB 원문 | |
| `create_history` | 2,000건·지문 20,000 | 수 MB | |
| `words_restore SAMPLES` | 재검사 중에만, 끝나면 비움 | 작음 | |
| reqwest `Client::new()` 51곳 | 호출마다 새 연결 풀 | 누수 아님, 할당 잡음 | 공용 클라이언트 하나로 묶을 수 있음 |

---

## 3. 실측 (환경·방법)

- 기계: Apple silicon Mac(macOS 26.5), 디스크 여유 39→26GB(다른 작업 포함). 대표 데이터·실행 중인 대표 프로세스 **안 건드림**(임시 폴더·regtest·합성 자료만).
- 프런트엔드: 프로덕션 `vite build` → 로컬 HTTP → **headless Chrome 154 + puppeteer-core**, `desktop-fixture.mjs` 합성 IPC(비밀·송금 명령은 던짐), 외부 요청 전부 차단. CDP `HeapProfiler.collectGarbage` 2회 후 `Performance.getMetrics`·`Memory.getDOMCounters`. 숨김은 `document.hidden/visibilityState` 를 덮어쓰고 `visibilitychange` 발생(헤드리스 탭은 진짜로 숨길 수 없다).
  ⚠️ Tauri macOS 는 WKWebView 라 **절대값은 다르다**. DOM 수·타이머·IPC 횟수·누수 추세는 그대로 옮겨 간다.
- ravend: `Ravencoin-4.8.0-macOS-arm64` zip 안의 `ravend v4.8.0.0-854fc7f30-dirty-playx` 를 scratch 로 풀어 regtest, 임시 datadir, `listen=0 connect=0`, 비표준 포트. `footprint`(phys_footprint)로 잼 — macOS 는 메모리 압축 때문에 RSS 가 15~73MB 사이를 오가서 **RSS 는 믿을 수 없었다**.
- kubo: 시스템 `ipfs 0.43.1`, 임시 `IPFS_PATH`, 포트 25001/28080/24001(대표 데몬과 안 겹침), 90초간 10초마다 footprint.

### 3-1. 프런트엔드 (`artifacts/memory-budget/frontend.json`)

| 화면 | 힙 MB | DOM | 리스너 |
|---|---|---|---|
| 시작(홈) | 7.41 | 10,635 | 705 |
| wallet / assets / talk / shop | 7.43–7.48 | 10.8–10.9천 | 707–717 |
| settings(최대) | 7.58 | 11,116 | 737 |
| 곁 창 companion | 4.85 | 302 | 37 |
| 미니 창 mini(`claude/rv-mini-window` 365f45f) | 0.78 | 97 | 12 |

- **누수**: 화면 이동 100회 — 힙 +2.6KB/회, DOM −1.07/회, 리스너 +0.08/회, 워밍업 뒤 +0.21MB. **누수 없음**. 살아 있는 setInterval 17개(이동해도 안 늘어남).
- **숨김 상태 35초**(수리 전 → 후):

| | 수리 전 | 수리 후 |
|---|---|---|
| setTimeout 콜백 | 535 (≈15/초) | **1** |
| 애니메이션 프레임 | 0 | 0 |
| IPC/분 | 30.9 (그리기: pairing_waiting·money_status 포함) | **24**(전부 일: 지갑 감시·대화·재색인) |
| 메인 스레드 task ms/초(20초 평균) | 76.2 | **1.1** |
| 보일 때 task ms/초 | 91.1 | **26.3** |

- **움직임**: 홈 rAF 120/초(reduced-motion 이어도), 숨김 0. 곁 창 숨김: 타이머 0·IPC 0.
- 미니 창: 5초간 타이머 0, IPC 는 시작 시 `mini_state` 1번 + 이벤트 구독 2번.

### 3-2. ravend regtest (`artifacts/memory-budget/ravend-regtest.json`)

| 설정 | 시작 직후 | 400블록 뒤 | mempool 150건(157KB) |
|---|---|---|---|
| 코어 기본 + 색인 2개 | 67MB | 68MB | 69MB |
| 템플릿 보통(450/40) | 67 | 69 | 69 |
| 템플릿 오래된 컴퓨터(300/100/16) | 67 | 68 | 69 |
| 제안 저메모리(100/50/12, par=1, rpcthreads=2, sigcache 8) | 67 | 69 | 69 |
| 가속(dbcache 4096) | 67 | 69 | 69 |

→ **regtest 에서는 설정 차이가 안 보인다.** dbcache·maxmempool 은 「상한」이라 메인넷에서 장부를 훑거나 UTXO 가 차야 쓰인다. 바닥은 약 **67MB**.
블록이 쌓이는 비용(합성): 지갑 켠 채 0→45,000블록에 67→125MB(≈1.3KB/블록, 지갑 거래 포함 상한) — `artifacts/memory-budget/ravend-blockindex.txt`. 지갑 없는 재측정은 4천 블록에서 노드가 멈춰 **블록 색인만의 비용은 못 갈랐다**(regtest 노드를 둘 동시에 돌리면 시작·유지가 실패했다, 원인 미확인 — 하나씩 돌릴 것).
메인넷(약 440만 블록) 블록 색인은 **수백 MB 로 추정**(확신 낮음) — 이것은 **dbcache·prune 으로 줄지 않는 고정비**다.

### 3-3. kubo (`artifacts/memory-budget/kubo.json`, 90초)

| 설정 | 5초 | 최고 | 끝 | 피어 |
|---|---|---|---|---|
| lowpower 오프라인 | 18MB | 18 | 18 | 0 |
| default-networking 온라인 | 44 | **103** | 93 | 77 |
| lowpower 온라인(앱 기본) | 41 | **75** | 73 | 67 |
| lowpower + ConnMgr 20/10 + ResourceMgr 128MB | 42 | 89 | 84 | 62 |
| 위 + Routing dhtclient | 43 | 84 | 83 | 51 |

→ lowpower 가 기본보다 약 25–30% 가볍다(앱이 이미 고른 값). 연결 수를 더 줄인 효과는 **90초 안에서는 잡음보다 작다**(ConnMgr 는 유예 시간 뒤에야 끊는다). 몇 시간 상시 값은 **측정 불가**(시간).

### 3-4. 측정 불가 / 추정

| 항목 | 상태 | 이유 |
|---|---|---|
| Rust 본체 RSS | **추정 30–80MB** | 앱 바이너리를 띄우면 `ai::migrate_keys_on_start` 가 **대표 키체인**을 읽고, 포트 8790·5001 이 대표 앱과 겹친다. 금지선이라 안 띄움 |
| WKWebView/WebView2 프로세스 전체 | **추정**: 메인 150–300MB, 작은 창 40–80MB/개 | 실제 셸에서만 잴 수 있다 |
| ravend 메인넷 상시 | **추정** 수백 MB(블록 색인) + dbcache 사용분 + mempool + 연결당 버퍼 | regtest 로는 재현 불가, 대표 노드 관찰 금지 |
| kubo 몇 시간 상시 | 측정 불가 | 시간 |
| 윈도우 | 측정 불가 | 맥만 있음 |

---

## 4. 모드별 메모리 예산(목표)

「앱 전체」= Rust + 웹뷰들. 노드·IPFS 는 따로 적는다(사장이 노드를 끄면 0).

| 모드 | 무엇이 살아 있나 | 앱 전체 목표 | 지금(추정) | 노드 | IPFS |
|---|---|---|---|---|---|
| 메뉴바 전용 | Rust + 트레이(웹뷰 0) | **≤ 60MB** | 200–400(메인 웹뷰가 숨은 채 살아 있음) | 별도 | 별도 |
| 미니 창 | Rust + mini 웹뷰 | **≤ 120MB** | 같음 + mini | 별도 | 별도 |
| 대기화면(곁 창 라비) | Rust + companion | **≤ 150MB** | 같음 + companion | 별도 | 별도 |
| 큰 창 | Rust + main | **≤ 350MB**, JS 힙 ≤ 10MB, DOM ≤ 13천 | 200–400 | 별도 | 별도 |
| 노드 상시(지갑) | ravend | 다 따라잡은 뒤 **dbcache ≤ 300**, mempool ≤ 100 | 450/300 기본 | ✔ | 끔 |
| 노드 상시(가게) | ravend + kubo | ravend 위와 같음 + kubo **≤ 100MB** | kubo 73–75(90초) | ✔ | ✔ |

프런트엔드 예산은 `scripts/memory-budget.json` 에 숫자로 있고 `npm test` 가 지킨다(6절).

---

## 5. 절감안 우선순위

효과: 대(≥100MB 또는 CPU 반 이상) · 중(10–100MB) · 소(<10MB). 위험은 동기화·응답성·안전 영향.

| # | 무엇 | 효과 | 위험 | 상태 |
|---|---|---|---|---|
| 1 | **번역 고리 끊기**: `translateDom` 이 같은 `lang` 을 매번 대입 → 마이크 모듈의 lang 감시가 글자를 다시 씀 → 번역 재실행… 초당 ~16번 11천 노드 훑기 | CPU 대(숨김 76→1ms/초), GC 쓰레기 감소 | 없음(값이 같을 때만 안 씀) | ✅ 적용 `src/i18n.ts` |
| 2 | 숨김 동안 번역 보류, 보이면 한 번 | 숨김 DOM 훑기 0 | 다시 보는 순간 한 프레임 한국어가 보일 수 있음(≤60ms) | ✅ 적용 `src/i18n.ts` |
| 3 | 그리기 전용 폴링 숨김 시 쉼(`money_status` 60초, `pairing_waiting` 10초, QR 2초) | IPC 31→24/분, Rust·RPC 부담↓ | 없음(창 다시 보면 다음 주기에 살아남) | ✅ 적용 `main.ts`·`pairing-ui.ts` |
| 4 | **메뉴바 전용 모드에서 메인 웹뷰 파괴**(숨김 N분 뒤 `close()`·다시 열 때 생성) | **대**(150–300MB 추정) | 다시 열 때 1–2초, 화면 상태 복원 필요(현재 페이지는 이미 `rememberCompanionPage` 로 기억). 입금 알림을 웹뷰가 아닌 Rust 가 해야 함(#6 선행) | 제안 — 대표 결정 |
| 5 | 라비 몸: 안 보이는 몸은 멈추고(0×0 런처), idle 은 `frameRate()` 15fps, reduced-motion 이면 상태 바뀔 때만 그리기 | CPU 중(보일 때 26ms/초의 대부분), 합성 메모리 소 | 표정 반응이 늦어 보일 수 있음 | 제안(ravi-emotion 담당과 충돌 피함) |
| 6 | **입금 감시를 Rust 로**: 15초마다 RPC 5건(웹뷰) → Rust 가 `getbestblockhash` 변화 때만 `listsinceblock`, 바뀌면 이벤트 | IPC·RPC 대폭↓, #4 의 전제 | 알림 경로 재작성 — 놓치면 돈 문제. 시험 필수 | 제안 |
| 7 | 곁 창이 번역 사전 전체를 싣지 않게: `ravi-microphone.ts` 가 `i18n` 을 import → `dict`·`desktop-copy` 가 곁 창 청크에 딸려 옴(927KB) | 곁 창 힙 1–2MB(추정)·파싱 시간 | 낮음(`lang` 을 인자로 받게) | 제안(음성 담당 파일) |
| 8 | 언어 사전 언어별 분할 로드(유럽어 6개 추가 대비): `Record<string,[en,ja,zh]>` 배열 → 언어별 JSON 을 `import()` | 지금 사전 ≈1MB 힙. 언어당 +0.3–0.6MB(추정)를 **고른 언어 하나만** | 낮음 — 첫 화면 전 로드 대기 필요 | 제안(유럽어 넣을 때 같이) |
| 9 | 화면 지연 렌더: 19개 화면이 처음부터 DOM(11천 노드, native 7.85MB) | 중(웹뷰 내부 수 MB~수십 MB, 레이아웃 비용) | 큼 — `main.ts` 94만 바이트가 id 로 요소를 찾는 구조 | 장기 |
| 10 | 지갑 감시가 숨김일 때 `backup_survey`·`wallet_lock_state` 생략 | IPC 24→~12/분 | 낮음 | 제안 |
| 11 | ravend 저메모리 프로필(아래 5-1) | 메인넷에서 중~대 | 아래 | 제안 — 대표 결정 |
| 12 | kubo: 「지갑」 모드는 이미 안 켬. 가게는 lowpower 유지, `Swarm.ResourceMgr.MaxMemory` 128–256MB 상한 | 상한 보장 | 핀 제공(손님 사진) 속도 약간 | 제안 |
| 13 | 릴레이 저장소: 총 바이트 상한(예 16MB) + 저장 시 통째 clone 대신 직렬화 후 잠금 해제 | 최악 수백 MB → 상한 | 낮음 | 제안 |
| 14 | reqwest 공용 클라이언트 | 소 | 없음 | 제안 |
| 15 | `dbcache_boost` 뒤 다 따라잡으면 **자동으로** 450(또는 300)으로 되돌리기 | 따라잡은 뒤 2–4GB 반환 | 낮음(재시작 필요 — 한가할 때) | 제안 |

### 5-1. ravend 저메모리 프로필(제안만 — 구현 안 함)

| 키 | 지금 기본 | 제안(지갑·가게 상시) | 안전 검토 |
|---|---|---|---|
| dbcache | 450(코어) | **300**(다 따라잡은 뒤) · 따라잡는 동안은 기존 가속 그대로 | 장부 다 받은 뒤엔 새 블록 1분 1개라 캐시가 거의 안 쓰인다. 재색인·초기 동기화 중에는 낮추면 **며칠 → 더 오래** — 그래서 「다 따라잡은 뒤」만 |
| maxmempool | 300 | **100** | 레이븐 mempool 은 평소 수 MB. 100MB 넘으면 수수료 낮은 거래부터 버린다 — 지갑이 보낸 거래는 지갑이 다시 퍼뜨림 |
| maxconnections | 125 | **16–24** | 8 미만이면 블록이 늦다(`conf.rs` 경고). 연결당 송수신 버퍼(기본 최대 5MB/1MB) 상한이 같이 준다 |
| maxorphantx | 100 | 20 | 영향 거의 없음 |
| par / rpcthreads | 자동 / 4 | 그대로 | regtest 차이 0. 낮추면 동기화 느려짐 — 이득 없음 |
| blocksonly | 0 | **쓰지 않는다** | 켜면 **0-확인 입금이 안 보인다** — 「들어오는 중」 알림과 충돌 |
| prune | 0 | 사람이 고른 경우만(기존) | addressindex 와 같이 못 씀, 12단어 복구 시 옛 거래 못 찾음 |
| assetindex / addressindex | 새 설치 1 | 그대로 | 끄면 재색인 몇 시간 + 기능 손실 |

채굴 충돌: 앱은 채굴기(kawpowminer)를 노드 밖에서 돌린다(`getblocktemplate`). 위 값은 템플릿 생성에 영향이 없다(mempool 이 작으면 수수료 수입이 미세하게 준다).
풀 노드 역할(손님 지갑 서버 `addressindex`): 연결 16 이상이면 유지된다.

---

## 6. 영구 시험·도구 (새 파일)

| 파일 | 하는 일 |
|---|---|
| `scripts/memory-budget-browser.test.mjs` | `npm test`·`npm run test:memory`. 8가지: 금지 명령 0 · 화면별 힙/DOM/리스너/이미지 · 100회 이동 누수 · **숨김: rAF 0·setTimeout ≤30/분·IPC ≤30/분·그리기 IPC 0** · 라비 rAF 악화 금지 · 곁 창 · 미니 창(`mini.html` 있을 때만) · 번들 크기. 약 3분 |
| `scripts/measure-memory.mjs` | 같은 측정을 시험 없이 → `artifacts/memory-budget/frontend.json`(`npm run measure:memory`, `RV_DIST`·`RV_NAV_ROUNDS`·`RV_HIDDEN_SECONDS`) |
| `scripts/memory-budget-lib.mjs` | 빌드·서버·Chrome·CDP 스냅숏·숨김 흉내·타이머/IPC 계수기 |
| `scripts/memory-budget.json` | 예산 숫자. 올리려면 이 문서에 이유를 적는다 |
| `scripts/measure-node-memory.sh` | ravend regtest·kubo 임시 저장소 footprint 측정(합성, 대표 데이터 무접촉). `scripts/measure-node-memory.sh <ravend 폴더> [kubo 초]`, `RV_SKIP_KUBO=1` 로 노드만 → `artifacts/memory-budget/ravend-regtest.json`·`kubo.json` |

번들 예산: 기존 `preflight.mjs` 에는 **크기 예산이 없었다**(배선·자원 검사만). 이 시험의 번들 항목(JS 2,600KB·최대 청크 1,000KB·index.html 480KB·CSS 60KB)이 첫 예산이다.

**JS 총량 예산 2,960KB → 3,000KB (2026-10-23, 라비 목소리).** 이유: 라비 목소리(Supertonic 3) 연결 코드 약 20KB 가 들어왔다 — 합성 계산(`ravi-tts-core`)·워커·관리자·「AI 음성」 표시·설정/정보 화면 연결. 전부 **처음 말할 때 불러오는 조각**(워커 6KB·관리자 3KB·진짜 의존물 0.5KB)과 홈 묶음 증가(약 5KB)이며 시작 묶음의 큰 덩어리는 아니다. 실행 중 비용(워커 메모리·모델)은 이 예산 밖이다: 맥 headless Chrome 에서 모델을 올리고 6초 문장을 만드는 동안 Chrome 전 프로세스 합계 최대 약 2.1GB(실측 2026-10-23, 메인 스레드 방식 시험 페이지). 그래서 모델은 **처음 읽을 때만** 올리고 말이 5분 없으면 내려놓는다. CSS 합계 88→90KB 는 「AI 음성」 표시 규칙 약 0.6KB 때문이다(88.4→89KB 로 반올림이 넘어감). 가장 큰 묶음 1,060KB 는 올리지 않았다(ORT 런타임 68KB·wasm 11MB 는 `public/ravi-tts/` 정적 파일이라 JS 묶음 밖).

**CSS 예산 60KB → 72KB (2026-10-11, 통합 `claude/rv-desktop-final`).** 이유: 0.8.6 통합에서 새 화면 네 개의 스타일이 함께 들어왔다 —
끌어놓기 발행(`drop-publish.css` 20.7KB + `drop-tokens.css` 1.2KB), 라비 감정(`ravi-emotion.css` 5.9KB), 창 모드
(`display-mode.css` 2.8KB·`layout-tokens.css` 7.0KB·`standby.css` 3.5KB, 원본 기준). 빌드 결과 CSS 합계 66.7KB.
CSS 는 화면을 그리는 데 쓰는 정적 규칙이라 힙·타이머 예산과 달리 숨김 상태 비용이 없다. 여유 약 5KB 를 두고 72KB 로 올린다.
JS 쪽 「가장 큰 묶음 1,000KB」는 올리지 않고 끌어놓기 발행을 따로 불러오는 조각으로 떼어 지켰다(main 930KB).
다음에 줄일 곳: `drop-publish.css` 의 템플릿 7종 규칙을 그 화면 조각과 함께 불러오기(지금은 시작 묶음 CSS 에 들어 있음).

결과(2026-10-11): `npm test` 77개 중 통과 74·건너뜀 1(미니 창 — 이 브랜치엔 mini.html 없음)·실패 1(`sales-account.test.mjs` 「vendored phone sources」 — 다른 워크트리 `wt-rv-web1008` 의 의존성 문제로 **기준 커밋에서도 똑같이 실패**, 이번 변경과 무관). `tsc --noEmit`·`preflight` 통과.

시험이 고장을 잡는지 확인: 수리 전 빌드(`dist-before`)로 돌리면 「928 setTimeout callbacks/min while hidden」으로 **실패**, 수리 뒤 통과. `claude/rv-mini-window` 빌드로 돌리면 미니 창 항목이 켜져 통과.

---

## 7. 위험

- 번역 보류(#2): 숨김 중 바뀐 글자는 다시 보일 때 번역된다. 창을 보이게 하는 순간 첫 프레임에 한국어가 잠깐 보일 수 있다(60ms 안). 숨김 중 알림은 OS 알림(Rust) 문구라 영향 없음 — 확신 중간.
- 수리 전 고리는 마이크 모듈의 `controller.stop()` 을 초당 ~16번 불렀다. **큰 창 받아쓰기가 시작 직후 끊기던 원인이었을 수 있다**(추정, 미검증). 고친 뒤 받아쓰기 동작은 실제 기기에서 확인 필요.
- 헤드리스 Chrome ≠ WKWebView. 예산 숫자는 「회귀를 잡는 문지기」이지 실제 MB 보증이 아니다.
- 숨김 흉내는 `document.hidden` 덮어쓰기다. 실제 macOS 에서 숨긴(orderOut) WKWebView 가 `hidden` 을 보고하는지는 **미검증**(WebKit 은 가림 감지로 보고하는 것으로 알지만 확신 중간). 보고하지 않으면 #1~#3 효과의 숨김 부분은 최소화했을 때만 난다 — #4(웹뷰 파괴)가 더 중요해지는 이유.

## 8. 못 한 것

- Rust 본체·실제 웹뷰 프로세스 실측(키체인·포트 충돌 금지선).
- 메인넷 ravend·kubo 장시간 상시 측정.
- 윈도우 WebView2.
- 라비 몸 프레임 수리(#5), 곁 창 사전 분리(#7) — 다른 에이전트 파일이라 제안만.

## 9. 대표가 고를 것

1. **노드 저메모리 모드를 기본으로 할까?** — 다 따라잡은 뒤 `dbcache=300 · maxmempool=100 · maxconnections=24`. 추천: 예(따라잡는 동안은 지금의 가속 유지).
2. **메뉴바 전용 모드에서 큰 창 웹뷰를 닫을까?** — 숨긴 지 10분 지나면 파괴, 다시 열면 1–2초 뒤 같은 화면. 추천: 예, 단 입금 감시를 Rust 로 옮긴 뒤(#6).
3. **가속 뒤 자동 되돌리기**(#15) — 다 따라잡으면 다음 한가한 시간에 450(또는 300)으로. 추천: 예.
4. 라비 몸 움직임을 reduced-motion·안 보일 때 멈추기(#5) — 표정 담당과 같이.

---

## 0.8.8a 예산 변경 (자산 파일 보관 화면)

- `bundle.cssTotalKB` 72 → **80**: 자산 보관 화면 스타일(`src/asset-keep.css`, 최소화 ≈ 7.3KB)이 늘었다. 기준 dist 는 71.4KB 로 72 에 0.6KB 만 남아 있었다. 이 CSS 는 지연 묶음(`src/asset-keep-lazy.ts` → `asset-keep.ts`)에 속해 자산 화면을 처음 그릴 때만 읽는다. 빌드 후 `npm run test:memory` 로 실측해 맞는지 확인할 것(이 작업에서는 빌드를 하지 못했다).
- JS: 화면 코드·문구(≈ 60KB)는 main 묶음(981KB, 한도 1000KB)에 더하지 않고 지연 묶음으로 뺐다. 읽는 동안·읽기 실패 때는 상태 글자만 있는 최소 표시로 남는다(죽지 않는다).

## 0.8.8 예산 변경 (병합본 — 대표 결정 2026-10-12)

- `bundle.jsTotalKB` 2,600 → **2,700**: 0.8.8 병합 빌드의 JS 합계가 2,691KB(시험 계산 `Math.round(바이트/1024)`)로 2,600 을 넘었다.
  늘어난 몫의 대부분은 라비 인물 지연 묶음(`ravi-persona-*.js` 97.4kB ≈ 95KiB — 라비 감정·생일 답변의 10개 언어 표)이고,
  나머지는 체인 정보(`chain-info-card-*.js` 7.5kB)·자산 보관(`asset-keep-*.js` 62kB) 지연 묶음이다.
- 이 묶음들은 **지연 로딩**이라 처음 화면을 그릴 때 읽지 않는다 — 첫 화면 비용(메인 묶음)은 늘지 않는다.
  메인 묶음은 990KiB(1,013,957 바이트)로 「가장 큰 묶음 1,000KB」 한도 안이다.
- **메인 묶음 1,000KB · CSS 80KB 한도는 올리지 않는다.** (같은 빌드 CSS 합계 80.3KiB → 시험 반올림 80, 한도와 같다 — 다음 CSS 추가 때는 먼저 줄일 것.)

## 0.9.0 예산 변경 (병합본 — 레인 A·B·C 를 하나로, 🔴 대표 결정 대기)

레인별 요청(C: JS 2,725·CSS 84 / B: JS 2,740 / A: 한도 변경 없음, CSS 는 index.html 인라인)을 **이 한 절로 합친다.**
실측은 병합 브랜치 `claude/rv-desktop-090-merge` 의 `npx vite build` dist(KiB = 1,024 바이트, 시험과 같이 반올림).

| 항목 | 기준 0693e8f | 병합 실측 | 한도 |
|---|---|---|---|
| 메인 묶음(main-*.js) | ≈990KiB | **977KiB**(1,000,500 바이트) | 1,000 (그대로) |
| JS 합계 | 2,699KiB | **2,772KiB** | 2,700 → **2,790** |
| CSS 파일 합계 | 80.3KiB | **83KiB**(83.4) | 80 → **84**(레인 C 요청 그대로) |
| index.html | — | **453KiB**(463,613 바이트) | 480 (그대로) |

- **메인 묶음을 지킨 방법.** 세 레인을 그냥 합치면 main 이 1,025,621 바이트(1,002KiB)로 한도를 넘었다.
  `wallet-file.ts`(지갑 파일 내보내기·가져오기·52글자 종이 단계, 압축 ≈38KB)가 display-mode 의 정적 import 때문에
  시작 묶음에 들어 있었다 → 「지갑 암호 없음」 안내 조각(`src/wallet-lock-refusal.ts`: showNeedPass·handleLockRefusal·
  트레이 거절 이벤트·그 문구 4개 언어)만 시작 묶음에 남기고, 나머지는 `void import("./wallet-file")` 로 지연 로딩했다.
  문구는 새 조각 한 곳에만 있고 wallet-file 의 Copy 가 펼쳐 쓴다(중복 표 없음). main −25KB.
- **JS 합계를 먼저 줄인 시도.** 레인 C 문구 중 desktop-copy.ts 에 이미 같은 한국어 열쇠가 있어 `??=` 때문에 한 번도 쓰이지
  않던 7개(「방 설정」·「방 이름」·「저장」·「지갑 열기」·「되돌리기」·「이름 없는 방」·「한 줄 설명 (없어도 됩니다)」)를 지웠다.
  그래도 줄어드는 양은 1KB 미만이다 — 늘어난 73KiB 의 대부분은 새 기능 자체다:
  레인 B 지연 묶음 `backup-extra` ≈34KB(한·영·일·중 문구 포함), 레인 C 지연 묶음 `talk-rooms-admin-sheet` ≈18KB + 시작 묶음 +3.7KB,
  레인 A `settings-nav` ≈3.7KB·`talk-identity` ≈3.1KB·desktop-copy 번역 +9KB. 이 셋은 모두 화면에 보이는 문구라 더 깎으면 기능이 빠진다.
  그래서 **실측 2,772 + 18 = 2,790** 으로 올린다(요청 규칙「실측 +30 이내」안). 다음 화면은 이 여유 안에서, 아니면 먼저 줄일 것.
- **CSS 를 index.html 에 넣은 레인 A 방식(vite 플러그인 `rv-inline-lane-css`)은 받아들인다.** 이유:
  (1) index.html 은 원래부터 화면 CSS 대부분을 `<style>` 로 품고 있어 같은 방식이다 — CSS 파일 한도(cssTotalKB)는 원래 index.html 안 CSS 를 세지 않았다.
  (2) 넣는 양 21.7KB 를 포함해 index.html 453KiB 로 자기 한도 480 안이다.
  (3) Tauri 가 `<style>` 마다 nonce 를 붙이므로 CSP(style-src)와 맞는다 — `check-style-csp` 를 CSP 씌운 채 돌려 확인(아래 검증 기록).
  (4) 플러그인의 줄바꿈 압축이 토큰을 붙여 뜻을 바꾸는 곳이 없는지 두 파일을 훑어 0건.
  ⚠️ 대신 index.html 여유가 27KiB 로 줄었다 — 다음 레인 CSS 는 같은 길로 넣지 말고 지연 묶음 CSS 로.
- **메인 1,000KB 한도는 올리지 않는다.**

## 2026-10-13 열람권(RV-LOCK v1) — JS 합계 한도 2,790 → 2,880KB
- 실측 2,838KB(+약 48KB 가 넘음). 늘어난 양은 새 기능 자체다: `core/creator/lock.ts`(암호문 쪼각·열쇠 싸기·요청/허가 글) + `lock-payment.ts` + `clip.ts` + 화면 `src/lock-ui.ts`(판매자 열쇠 저장·구매자 열람) + 마법사/끌어놓기/시장 연결.
  새 암호 부품은 넣지 않았고(기존 @noble 재사용) 새 의존성도 없다. 더 깎으면 안내 문구(보이는 글)가 빠진다.
- 실측 2,838 + 약 40 여유 = **2,880**. 최대 묶음(1,000KB)·index.html·CSS 한도는 그대로.
- **가장 큰 묶음(main) 한도 1,000 → 1,060KB (예외 — 위 「올리지 않는다」 방침을 이번 한 번 깬다).** 실측 main 1,040KB(이전 990KB, +약 50KB).
  원인: `core/creator/publish.ts` 가 암호화 올리기(lock.ts)를 직접 부르고, `creator-publish`·`open-market`·`main` 이 모두 `lock-ui.ts` 를 정적으로 불러서 지연 묶음으로 뗄 수 없다.
  끌어놓기 발행을 떼어 낸 때와 달리 이번엔 마법사(정적)·장터(정적)가 함께 쓰므로 한 번에 못 뗀다.
  **다음 일**: 마법사(`creator-publish`)를 지연 묶음으로 떼고, `lock-ui` 의 구매자·판매자 화면을 동적 import 로 옮겨 이 한도를 1,000 으로 되돌릴 것.

## 2026-10-14 판매자 화면 둘(기기 연결 · 상품 대량 등록) — JS 합계 한도 2,880 → 2,960KB
- 실측 2,922KB(기준 2,841KB, +약 81KB). 늘어난 양은 새 화면 둘이 전부다 — 둘 다 처음 열 때만 내려받는 지연 묶음이라 시작 묶음·메인 창 힙·DOM 예산은 그대로다.
  `device-connect`(32.7KB: 기기 증서·철회 목록·데이터 열쇠 core + 화면 + 문구 사전) · `bulk-products-ui`(36.3KB: CSV 파서·상품 문서 검사·가게 문서 말 사전 core + 화면 + 문구 사전).
  새 암호 부품이나 의존성은 넣지 않았다(기존 @noble). 문구 사전은 시작 묶음(dict.ts)에 넣지 않고 화면 모듈이 처음 열릴 때 합친다.
- 실측 2,922 + 약 38 여유 = **2,960**. 최대 묶음(1,060KB: main 1,043KB)·index.html 한도는 그대로.
- CSS 합계 한도 84 → **88KB**: 새 화면 둘의 모양 파일(`device-connect.css` 1.5KB · `bulk-products-ui.css` 1.6KB, 지연 묶음)로 86KB 가 됐다.
