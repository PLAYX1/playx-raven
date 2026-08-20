# 조사할 것 — PLAY X Raven

우리가 이미 만든 것에 실제로 붙일 수 있는 남의 결과물을 찾는다.
**바퀴를 다시 만들지 않기 위해서고, 우리가 놓친 실패 사례를 남에게서 배우기 위해서다.**

각 항목은 **왜 필요한가 → 검색어 → 무엇을 확인할 것인가** 순서.
라이선스는 반드시 확인한다. GPL 계열은 우리 코드 전체를 GPL로 만들 수 있다.

---

## 1. 레이븐코인 자산·스왑

### 1-1. 원격 판매 (아토믹 스왑)

**왜:** 지금 벤딩머신은 "입금 감지 → 사람이 보내기"다. 사장이 자리를 비우면 멈춘다.
RIP-15 스왑이면 미리 서명해 두고 자리를 비울 수 있는데, 손님 쪽 소프트웨어가 문제다.

```
ravencoin atomic swap RIP-15 SIGHASH_SINGLE ANYONECANPAY
raven-trader-pro
ravencoin swap partial signed transaction
```

**확인할 것**
- 손님 쪽에 무엇이 필요한가. 폰 지갑으로 스왑을 완료한 사례가 실제로 있는가
- 서명한 오퍼가 만료되는 방법이 있는가. 없으면 시세가 변해도 옛 가격에 팔린다
- UTXO가 다른 데 쓰이면 오퍼가 깨지는가. 깨진 걸 사장이 어떻게 아는가

### 1-2. 메시지 채널

**왜:** 우리는 `sendmessage`만 배선했다. 실제로 이걸 쓰는 앱이 어떻게 구성하는지 모른다.

```
ravencoin messaging RIP-5 message channel wallet implementation
ravencoin IPFS message format json schema
```

**확인할 것**
- 메시지 본문 JSON 형식에 사실상의 표준이 있는가 (우리 형식이 다른 지갑에서 읽히는가)
- 만료 시각(`expire_time`)을 실제로 어떻게 쓰는가

### 1-3. 메타데이터 확장

**왜:** RIP-0014에는 다국어 필드가 없어서 `other_data`에 `name_ko`를 넣었다.
같은 문제를 먼저 푼 사람이 다른 키 이름을 썼다면 그쪽에 맞추는 게 낫다.

```
Extended-Ravencoin-Metadata-Specification
ravencoin asset metadata standard localization multilingual
ravencoin explorer metadata parser
```

**확인할 것**
- 탐색기(rvn.cryptoscope, ravencoin.asset explorer)가 어떤 필드를 실제로 읽는가
- 우리가 넣은 `other_data.name_ko`가 다른 곳에서 깨지지 않는가

---

## 2. IPFS

### 2-1. 저사양 PC에서 IPFS 돌리기

**왜:** "후진 컴퓨터에서도 돌아가야 한다"는 게 요구사항인데, kubo 기본 설정은 무겁다.

```
kubo low resource profile lowpower badgerds
ipfs config profile lowpower raspberry pi
ipfs datastore size limit gc policy
```

**확인할 것**
- `lowpower` 프로파일이 핀 유지에 영향을 주는가
- 연결 수 제한을 어디까지 낮춰도 핀이 유지되는가

### 2-2. 남의 컴퓨터가 대신 보관해 주기

**왜:** 가게 컴퓨터가 꺼지면 사진이 안 보인다. 여러 가게가 서로 보관해 주면 해결된다.

```
ipfs-cluster follow collaborative cluster
ipfs pinning service API spec
```

**확인할 것**
- ipfs-cluster를 우리 앱 안에 넣을 수 있는가, 별도 설치가 필요한가
- 서로 보관해 주는 구조에서 악의적 참여자가 무엇을 할 수 있는가

### 2-3. 폰이 직접 IPFS 읽기

**왜:** 지금 손님 폰은 가게 게이트웨이로만 사진을 받는다. 가게가 꺼지면 못 본다.

```
helia browser ipfs verified fetch
ipfs service worker gateway trustless
```

**확인할 것**
- 폰 브라우저에서 얼마나 무거운가 (저가 안드로이드에서 실사용 가능한가)

---

## 3. 가게·주문·결제

### 3-1. 오픈소스 POS

**왜:** 우리가 만든 주문 화면은 처음부터 그린 것이다. 실제 매장에서 다듬어진 흐름을 안 봤다.

```
open source POS restaurant github (Floreant, uniCenta, Odoo POS)
KDS kitchen display system open source
```

**확인할 것**
- **주문 상태 흐름**을 어떻게 나누는가 (접수/조리/완료/픽업). 우리는 그냥 "입금됨"뿐이다
- 취소·환불을 어떻게 다루는가. **우리는 환불 설계가 아예 없다** — 이게 가장 큰 구멍
- 영업 마감·정산 화면에 무엇이 들어가는가

### 3-2. 암호화폐 결제 처리

**왜:** BTCPay는 우리와 같은 문제(자기 노드로 결제받기)를 오래 풀어온 프로젝트다.

```
btcpay server architecture invoice expiry
btcpay greenfield API store payment flow
bitcoin payment request BIP21 amount label
```

**확인할 것**
- **인보이스 만료**를 어떻게 다루는가. 우리 견적은 5분인데 근거가 약하다
- **부분 결제**(모자라게 보냄) 처리. 우리는 아예 생각을 안 했다
- **초과 결제**는? 거스름을 어떻게 하는가
- 결제 URI 형식 — 우리는 `raven:주소?amount=` 를 쓰는데 이게 폰 지갑에서 실제로 열리는가

### 3-3. 배달 주소 암호화

**왜:** 배달을 켜면 손님 집주소가 공개 IPFS에 올라간다. **이건 반드시 막아야 한다.**

```
ECIES secp256k1 encrypt to bitcoin address public key
age encryption tool rust
NIP-04 NIP-44 nostr encrypted direct message
```

**확인할 것**
- 레이븐 주소의 공개키로 바로 암호화할 수 있는가 (주소는 해시라 공개키가 필요하다 —
  **그 주소에서 나간 트랜잭션이 없으면 공개키를 모른다**. 이 문제를 남들은 어떻게 푸는가)
- nostr의 NIP-44가 검증된 구현이 있는가

---

## 4. 원격 접속 (사장이 밖에서 자기 노드 보기)

**왜:** 지금은 같은 wifi에서만 된다. "전국 어디서든"은 아직 못 한다.

```
tailscale headscale self hosted
cloudflare tunnel free tier limits
libp2p hole punching relay circuit v2 DCUtR
```

**확인할 것**
- 공유기 설정 없이 되는 방법 중 **외부 회사 의존이 가장 적은 것**
- libp2p 홀펀칭이 실제로 뚫리는 비율 (한국 통신사 NAT 환경)
- 터널을 쓰면 사장 노드가 외부에 노출되는 범위

---

## 5. AI 품질 — **글과 그림이 세련되게 나오는 법**

이게 지금 가장 약한 부분이다. 모델은 붙였는데 **결과물의 품질을 우리가 통제하지 못한다.**

### 5-1. 글 (가게 소개·메뉴 설명·번역)

**왜:** AI가 쓴 티가 나는 문장은 가게를 싸구려로 보이게 한다.
"최고의 맛을 자랑하는", "정성을 담아" 같은 말이 자동으로 나온다.

```
LLM copywriting system prompt brand voice guidelines
avoid AI slop writing prompt techniques
few-shot prompting product description quality
localization vs translation marketing copy Korean
```

**확인할 것**
- **예시를 몇 개 주는 것(few-shot)이 지시문보다 훨씬 낫다**는 게 정설인데, 우리는 지시문만 쓴다.
  좋은 가게 소개 3~5개를 프롬프트에 넣으면 결과가 어떻게 달라지는가
- 금지어 목록을 주는 방식이 효과가 있는가 ("자랑하는", "정성", "특별한" 등)
- 번역이 아니라 **현지화** — 일본어 메뉴는 일본 가게가 쓰는 말투여야지 한국어 직역이면 안 된다

### 5-2. 그림 (간판·메뉴 사진·자산 아트워크)

**왜:** 우리가 만든 샘플 사진은 괜찮았지만 **왜 괜찮았는지 모른다.** 재현할 수 없다.

```
food photography prompt engineering guide
product photography lighting terms for image models
image model prompt structure subject lighting lens composition
brand consistency image generation reference image
```

**확인할 것**
- **사진 용어를 쓰면 결과가 좋아진다** (`shot on 35mm`, `soft window light`, `shallow depth of field`).
  우리 샘플에도 썼는데, 어떤 단어가 실제로 효과가 있었는지 통제 실험이 필요하다
- **레퍼런스 이미지**를 넣어 가게 톤을 통일하는 방법 (한 가게의 메뉴 사진 10장이 따로 놀면 안 된다)
- 음식 사진에서 **AI가 실물과 다르게 그리는 문제** — 보정만 하는 방법 (배경 제거, 조명 보정)
- 무료·저가로 쓸 수 있는 로컬 이미지 모델 (가게가 API 비용을 못 낼 때)

### 5-3. 손님 응대 품질

**왜:** 자동응대가 없는 메뉴를 지어내면 가게가 책임진다. 우리는 프롬프트로만 막고 있다.

```
RAG grounding hallucination prevention retrieval
structured output json schema function calling reliability
LLM refuse to answer when not in context prompt
```

**확인할 것**
- 프롬프트 지시만으로 충분한가, 아니면 답변을 다시 검사해야 하는가
- 답변에 없는 메뉴 이름이 나왔는지 **자동으로 검사**하는 방법

---

## 6. 화면·접근성

**왜:** "젊은 사람도 노인도 다 쓸 수 있어야 한다"가 요구사항이다.
크기는 키웠지만 실제 사용자로 검증한 적이 없다.

```
WCAG 2.2 target size minimum 24 44 CSS pixels
Korean typography web minimum font size hangul legibility
POS UI design glare high ambient light
senior friendly UI without looking like senior mode
```

**확인할 것**
- 한글 최소 크기에 대한 **실측 근거가 있는 자료** (우리는 그록 조언으로 15px을 정했다)
- 매장 조명(형광등·직사광)에서의 대비 기준
- 큰 글씨가 아니라 **일관된 위치**가 더 중요하다는 연구가 있는지

---

## 7. 우리가 아직 설계도 안 한 것

조사보다 먼저 **결정**이 필요한 것들. 남들이 어떻게 하는지 보면 결정이 쉬워진다.

| 구멍 | 지금 상태 | 찾아볼 것 |
|---|---|---|
| **환불** | 없음 | 암호화폐 결제에서 환불을 어떻게 하는가 (되돌릴 수 없는데) |
| **부분·초과 결제** | 없음 | BTCPay의 처리 방식 |
| **주문 상태** | "입금됨"뿐 | 오픈소스 POS의 상태 흐름 |
| **영수증** | 없음 | 세금 신고에 쓸 수 있는 형태인가 |
| **재고** | 없음 | 다 팔린 메뉴를 어떻게 내리는가 |
| **여러 직원** | 없음 | 사장 열쇠 하나뿐. 직원용 권한이 필요한가 |

---

## 라이선스 주의

- **GPL/AGPL** 코드를 가져오면 우리 앱 전체가 같은 라이선스가 될 수 있다
- **MIT/Apache-2.0/BSD** 는 안전
- 코드를 안 가져오고 **아이디어와 설계만 배우는 것은 라이선스와 무관하다** — 대부분 이쪽이면 충분하다
