# 금액 입력·표시 안전 (유럽어 6개 추가 ①②단계, 2026-10-11)

번역 작업 아님. 언어와 무관하게 「1.234」를 1.234 와 1234 로 다르게 읽는 사고를 막는 단계.

## 모듈 (데스크탑·지갑 같은 바이트)

| 위치 | 역할 |
|---|---|
| 데스크탑 `src/amount-locale.ts` = 지갑 `core/i18n/amount-locale.ts` | 순수 함수(DOM·Node 없음). SHA-256 `bcb07085ad8d18bdacb6c0ff14b6500e2b4be1bb5e3eac5863fc08c9a4c4c0da` |
| 데스크탑 `src/amount-ui.ts` | 입력칸 묶기(type=text + inputmode=decimal), 언어 바뀔 때 값 보존, `fmtRvn`/`fmtCount`/`fmtSats`, `setNumberLocale` |
| 지갑 `phone/ui/amount.ts` | 폰 화면이 core 를 잇는 한 곳(used/ 규칙: core 직접 import 금지) |

고칠 때는 두 사본을 함께 고치고 이 SHA 를 갱신한다. 데스크탑 `scripts/amount-locale.test.mjs` 가 지갑 워크트리가 있으면 바이트 동일을 확인한다.
(이 파일은 기존 `core/creator/vendor-sha256.json` 핀 목록에는 넣지 않았다 — 그 목록은 다른 지갑 브랜치 원본과 대조하고 개수 13 을 고정한다.)

## 규칙

1. 금액은 안에서 정수 사토시(bigint). 글자 → 사토시는 자릿수 조립(parseFloat 없음).
2. 입력은 화면 지역의 소수기호만 소수점. 점·쉼표를 지우거나 바꾸지 않는다.
   점 관례(1,234.5)와 쉼표 관례(1.234,5) 두 가지로 읽어 보고 —
   - 같은 값이거나 이 지역 관례로만 읽히면 받아들임
   - 서로 다른 값이 둘 다 나오면 **ambiguous**(값을 정하지 않음, 두 후보를 돌려줌)
   - 다른 관례로만 읽히면 **other-format**(값을 정하지 않음)
   - 성질: **어떤 글자도 두 지역에서 서로 다른 값으로 받아들여지지 않는다**(지갑 시험이 6,375 글자 × 11 지역 전수 확인). 그래서 저장된 초안 글자도 언어를 바꿔 재해석될 수 없다.
3. 거절: 빈칸·음수(-, −)·지수(1e3)·소수 9자리 이상·총발행량 210억 RVN 초과·0.
4. 붙여넣기: 앞뒤 공백·줄바꿈, 「RVN」 접두/접미, 전각 숫자·전각 쉼표/점, 공백류 천단위(NBSP, U+202F) 처리.
5. 표시: 정수 부분만 `Intl.NumberFormat(지역)`, 소수는 글자 그대로 → 8자리 보존. 자리를 줄여 보일 때(maxFraction) 0 이 아닌 값은 「< 0,01」. 코드는 숫자 뒤 NBSP + 「RVN」. 화면과 낭독이 같은 글자.
6. 노드 경계: 노드 명령은 아직 f64(RVN). `satsToRvnNumber` 는 되돌렸을 때 같은 사토시가 나올 때만 수를 준다(15자리 넘는 값은 보내지 않음).
7. 주소·복구 단어·프로토콜 값은 대상 아님.

## 모호 입력 처리표 (시험과 같은 표, 일부)

| 입력 | de / it / es-ES / pt-BR / fr / ru | en / es-MX / ko / ja / zh |
|---|---|---|
| `1.234` | 모호 (1234 / 1.234) | 모호 (1.234 / 1234) |
| `1,234` | 모호 | 모호 |
| `100.000` | 모호 | 모호 |
| `1 234,5` | 1234.5 | 다른 형식(거절) |
| `1.234,5` | 1234.5 | 다른 형식 |
| `1,234.5` | 다른 형식 | 1234.5 |
| `1,5` | 1.5 | 다른 형식 |
| `1.5` | 다른 형식 | 1.5 |
| `0,001` | 0.001 | 다른 형식 |
| `1.234.567` | 1234567 | 다른 형식 |
| `1234` | 1234 | 1234 |
| `-1` · `1e3` · `0,000000001` · `0` | 거절(음수·지수·9자리·0) | 같음 |
| ` 1,5 RVN⏎` (de) · `１２３．４５` (ja) | 1.5 · 123.45 | |

## 교체한 위치

### 데스크탑 `en-US` 고정 10곳 → 화면 지역
- `src/create-page.ts` 9곳: 434(최대 장수), 509(발행할 증서), 536(티켓 장수), 537(필요한 RVN — 소수 2자리 반올림 → 8자리), 566(모자란 RVN — 2자리 반올림이 모자람을 적게 보일 수 있었음), 588·687·766(장수), 607(`rvnText` 2자리 → 8자리)
- `src/ravi-promo.ts` 61: 홍보문 메뉴 가격 → 홍보문 언어의 숫자 형식
- 남김: `core/creator/open-market.ts:53` — vendor 핀 파일(지갑 원본에서 고친 뒤 다시 복사·핀 갱신해야 함). 한국어 문장 안 숫자라 ko 에서는 결과가 같다.

### 데스크탑 금액 입력 (parseFloat / Number → 지역 파서)
- 보내기 `s-qty`(type=number → text): composeChanged·reviewSend, 안내 줄 `s-qtynote` 추가, 검토 화면 금액·「보유/보내려는」 경고·수수료·합계(사토시 합산)
- 라비 보내기 카드 `rv-send-amount`(type=number → text): 확인·요약, 「계속」은 글자 대신 받아들인 사토시를 `s-qty` 로 넘김
- 라비 `send_prepare`(main.ts) · 짝 기기 송금 요청(`pairing-ui.ts`): `String(수)` → `setAmountRvn`(지역 글자)
- 환불 `rf-amt`: 제안값을 지역 글자로, 확인 대화·완료 화면 금액
- 배당 `rw-amt`, 자동 쓸어 담기 `sw-above`/`sw-keep`(parseFloat 로 de 「3.000」이 3 이 되던 것 — 켤 때 못 읽으면 저장 안 함), 장터 `sw-price`·`sl-price`·`sell-rvn`(type=number → text)

### 데스크탑 RVN 표시 (8자리·0 금지·코드 위치)
`fmtQty`(전체 공용), 잔액(w-confirmed·들어오는 중·overview), 최근 거래 목록 2곳(기본 3자리 반올림으로 작은 금액이 0 으로 보이던 것), 개발비 쌓임/보낸 것, 오늘 매출 합계, 장터 확인(가격·개발비 1%·모두·한 개당 — 기본 3자리 반올림), 발행 소각·잔액·모자란 금액(`(need-have).toFixed(2)` 부동소수 뺄셈 → 사토시), 연습 잔액(0자리 반올림), 백업 안의 RVN, 원화 환산의 정수 묶음.

### 지갑 (`/Users/gimmusong/wt-rv-i18n-num-wallet`)
- `phone/screens/common.tsx` `rvnToSats`: 🔴 쉼표를 **무조건 점으로 바꾸던** 파서 → 지역 파서. `satsToRvn`: 나눗셈+toFixed → 정수 자리 계산 + 지역 형식. `rvnInputProblem`, `requestAmountForInput` 추가.
- `phone/screens/Send.tsx`: 요청 QR 금액(점 소수)을 지역 입력 글자로, 막힌 이유를 구체적으로.
- `en-US` 3곳: `phone/ui/used/format.ts:28`(중고 가격), `phone/screens/Create.tsx:113·315`(장수). `parseRvn` 도 지역 파서로, 초안 가격 글자 `replace(/,/g,'')` 제거.
- 남김: `core/easy-create/plan.ts:168`(core 의 한국어 오류문, 지역 정보 없음), `release-site/landing/verify.js` 3곳(공개 사이트, 별도 언어 체계), `core/creator/open-market.ts:53`(핀).
