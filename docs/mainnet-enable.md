# 메인넷 발행·판매 스위치 (0.9.2)

값은 `core/creator/mainnet-switch.json` **한 파일**이다.

| 키 | 읽는 곳 | 뜻 |
|---|---|---|
| `issue` | 지갑 core `publish.ts` `REAL_MAINNET_ISSUE_ENABLED`(데스크탑 복사본) · Rust `issue.rs` `REAL_MAINNET_ISSUE_ENABLED` | 메인넷 자산 발행·재발행·가게 등록 |
| `sales` | 지갑 core `open-market.ts` `OPEN_MARKET_SALES_ENABLED`(복사본) · Rust `issue.rs` `OPEN_MARKET_SALES_ENABLED` → `market.rs` | 장터 결제 거래 만들기·보내기 |
| `acknowledged` | 시험만 | 켜는 사람이 직접 `true` 로 바꾼다. `issue`/`sales` 가 켜졌는데 이것이 false 면 시험이 실패한다(슬쩍 켜진 커밋 방지). |
| `verifiedOnly` | `open-market.ts` | 1단계 제한. true = 서명된 허용 목록(검증됨)에 있는 상품만 결제. 허용 목록이 비어 있으면 아무 것도 결제되지 않는다. enable 커밋도 이 값은 건드리지 않는다. |

- 커밋된 기본값은 전부 꺼짐(`issue`·`sales`·`acknowledged` false, `verifiedOnly` true).
- 켜는 것은 **별도 enable 커밋**(이 파일의 세 줄만 바꿈)이다: 브랜치 `claude/rv-desktop-092-mainnet-enable`. 그 커밋을 얹으면 지갑 TS 두 상수·Rust 두 상수가 동시에 켜지고 모든 시험이 그대로 통과한다.
- 설정·환경 변수·화면으로 켜는 길은 없다(시험이 지킨다). 켠 빌드를 쓰는 사람은 새 판을 받기 전까지 계속 켜져 있다 — 끄려면 이 파일을 되돌린 새 릴리스가 필요하다.
- 메인넷에서만 막는다. 시험망(test)·연습(regtest)은 늘 허용.
- 이 파일을 읽는 지갑 core 두 줄은 지갑 원본과 다른 유일한 패치다(`core/creator/vendor-sha256.json` 의 `patches`). 지갑 저장소도 같은 패치를 받아야 바이트가 다시 같아진다.
