# 조사할 것 — 자산을 안전하게 무인 판매하는 법

**풀어야 할 문제 한 줄:** 작가가 컴퓨터 한 대로, 자리를 비운 채, 음악 토큰을
파는데, **그 컴퓨터가 털려도 아직 안 판 재고까지 잃지는 않아야 한다.**

지금 우리 구조와 이미 확인한 한계를 먼저 적는다. 조사할 때 이걸 기준으로
"이 사람들은 이 벽을 어떻게 넘었나"를 보면 된다.

---

## 우리가 이미 부딪힌 벽 (조사의 출발점)

| 벽 | 확인된 사실 |
|---|---|
| **누가 보냈는지 모른다** | 비트코인 계열은 받은 트랜잭션에 송신자 주소가 없다. 그래서 QR만으로는 자동 반송이 불가능하고, 구매자가 받을 주소를 적는 페이지가 필요하다 |
| **지갑을 못 나눈다** | 레이븐에는 `createwallet`/`loadwallet`이 없다. 노드 하나 = 지갑 하나. 핫/콜드 분리에 컴퓨터가 두 대 필요하다 |
| **암호는 꺼진 컴퓨터만 지킨다** | 무인 판매를 켜면 암호가 메모리에 있고 전송마다 지갑이 열린다. 그 상태에서 `encryptwallet`은 자물쇠가 아니다 |
| **아토믹 스왑은 폰 팬에게 불가능** | RIP-15는 구매자가 부분 서명 트랜잭션을 완성해야 한다. 웹페이지는 구매자 키를 만질 수 없고 만져서도 안 된다 |
| **한도는 우리 루프 안에서만 유효** | 악성코드가 RPC를 직접 부르면 한도·확인·1회제한이 전부 무의미하다 |

---

## 1. 핵심 질문 — 컴퓨터 한 대로 콜드 재고를 지키는 법

**왜:** 그록의 판정 — *"같은 지갑에 1,000장을 두고 소프트웨어 한도로 50만 판다고
콜드라고 부르면 안 된다. 그건 핫 1,000이다."*

```
bitcoin cold storage single machine hot wallet separation
watch-only wallet + offline signing workflow
PSBT offline signing air-gapped workflow
electrum offline wallet signing tutorial
```

**확인할 것**
- **워치온리 + 오프라인 서명**이 레이븐에서 되는가. 레이븐 코어에 `signrawtransaction`이 있으니
  이론상 가능한데, 판매 루프가 매번 사람 손을 요구하면 무인이 아니게 된다
- 하드웨어 지갑(Ledger/Trezor)이 레이븐 **자산**을 지원하는가. RVN만 되고 자산은 안 되면 소용없다
- 라이브 USB에서 일회성 서명 세션을 여는 실제 절차. 작가가 따라 할 수 있는 수준인가

## 2. 발행을 나눠서 하는 것 (지금 유일하게 확실한 답)

**왜:** *"아직 안 찍은 장은 훔칠 수 없다."* 50장 팔고 품절되면 그때 50장 재발행.
문제는 밤사이 품절이면 판매가 멈춘다는 것.

```
NFT lazy minting mint on demand
ERC-721A lazy mint signature voucher
open edition drop mechanics
```

**확인할 것**
- 이더리움의 **lazy minting**(팔릴 때 찍기)을 레이븐에서 흉내 낼 수 있는가.
  레이븐은 재발행에 RVN 소각이 없지만 트랜잭션은 필요하고, 지갑이 열려야 한다 —
  결국 같은 문제로 돌아오는가?
- 재발행 가능 자산의 **총량 상한**을 체인이 강제하는 방법이 있는가

## 3. 남의 컴퓨터가 대신 파는 것

**왜:** 작가 컴퓨터가 꺼져 있어도 팔리면 좋다. 그런데 키를 남에게 주면 안 된다.

```
non-custodial NFT marketplace architecture
escrow smart contract alternative UTXO chain
Ravencoin RIP-15 atomic swap marketplace implementation
raven-trader-pro swap order book
```

**확인할 것**
- RIP-15 스왑을 **판매자가 미리 서명해 두고 자리를 비우는** 방식이 실제로 도는 사례
- 그 오퍼를 **만료**시키는 방법. 없으면 시세가 변해도 옛 가격에 팔린다
- 오퍼에 쓴 UTXO가 다른 데 쓰이면 오퍼가 죽는데, 그걸 판매자가 어떻게 아는가
- 구매자 쪽 요구사항이 정확히 무엇인가. **폰 지갑으로 되는 사례가 하나라도 있는가**

## 4. 무인 판매를 실제로 돌리는 사람들의 운영 방식

**왜:** 우리는 "핫재고를 작게"라는 원칙까지 왔는데, 그게 실무에서 어떤 숫자인지 모른다.

```
crypto exchange hot wallet cold wallet ratio policy
hot wallet replenishment threshold automation
lightning node liquidity management autopilot
BTCPay Server hot wallet best practices
```

**확인할 것**
- 거래소·결제 게이트웨이가 **핫월렛 비율**을 얼마로 두는가 (보통 총액의 2~5%라고 들었는데 근거)
- 자동 충전을 **사람 승인 없이** 하는 곳이 있는가. 있다면 무엇으로 막는가
- 핫월렛이 털렸을 때의 **탐지** 방법 — 우리는 지금 탐지가 아예 없다

## 5. 무인 결제 루프의 알려진 사고 유형

**왜:** 그록이 우리 코드에서 두 개를 찾았다(금액 미검증, 이중 발송). 남들이 겪은
나머지를 미리 알고 싶다.

```
payment processor double spend zero confirmation attack
idempotency key payment processing
blockchain reorg handling payment confirmation depth
underpayment overpayment handling crypto invoice
```

**확인할 것**
- **재조직(reorg)** 대응. 1컨펌으로 물건을 내줬는데 블록이 뒤집히면?
  큰 금액에 몇 컨펌을 요구하는지 업계 기준
- **초과 결제**를 어떻게 처리하는가. 우리는 지금 생각조차 안 했다
- **멱등성(idempotency)** 구현 방식. 우리는 메모리 집합 하나뿐이라 앱이 죽으면 사라진다 —
  디스크에 남겨야 하는가, 체인을 다시 읽는 게 맞는가

## 6. 이 컴퓨터가 털렸는지 아는 법

**왜:** 우리는 잔액만 보여준다. 나가는 걸 막지 못하면 **빨리 아는 것**이라도 해야 한다.

```
wallet balance change alert monitoring self hosted
bitcoin core walletnotify script
canary token honeypot address
```

**확인할 것**
- 레이븐 코어의 `-walletnotify`로 **모든 전송에 알림**을 걸 수 있는가.
  우리 루프가 보낸 것과 아닌 것을 구별해서, 우리가 안 보낸 전송이 생기면 즉시 사장 폰에 알림
- 미끼 주소(허니팟)를 두고 그게 움직이면 경보하는 방식이 실효가 있는가

---

## 7. 판단이 필요한 것 (조사가 답을 정해주지 않는 것)

| 질문 | 지금 우리 입장 |
|---|---|
| 무인 판매를 아예 기본으로 끄고, 켤 때마다 경고할 것인가 | 켜기 전 노출 금액을 원화로 보여주는 것까지 함 |
| 재고를 몇 장까지 이 컴퓨터에 둘 것인가 | 작가가 정함. 우리는 "잃어도 되는 만큼"이라고만 말함 |
| 로열티를 붙일 것인가 | **붙이지 않기로 함.** 앱 안에서만 되는 건 로열티가 아니라 장터 수수료 |
| 아토믹 스왑을 기다릴 것인가 | 기다리지 않음. 폰 팬에게 불가능 |

---

## 라이선스

코드를 가져올 때만 문제가 된다. **설계와 운영 방식을 배우는 것은 라이선스와 무관하다.**
이 목록은 대부분 후자다.
