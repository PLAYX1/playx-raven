# DECISIONS-LANE-C (브랜치 claude/rv-lane-c, 2026-10-15)

| 결정 | 선택 | 근거 | 참여 AI | 표 |
|---|---|---|---|---|
| F05 의 정체 | 「LAN 보냄(ACK)·커서 응답이 인증되지 않아 데이터 누락 가능」 — 보안 감사 `~/Desktop/레이븐볼트-보안감사-GPT교차.md` §F05. 고치는 방향 = 응답을 데이터 열쇠로 만든 확인값(proof)에 묶기 | 감사 문서 332행 정의 + 폰 `phone/network/real/lan/proof.ts` 머리 주석(「감사 F05」, 「데스크탑 쪽 서버가 같은 확인값을 내야 한다」) | 없음(문서 정의가 명확해 물을 것이 없었음) | - |
| 서버 쪽 구현 범위 | `src-tauri/src/lan_proof.rs`: 확인값 계산(push/pull)·nonce 검사·상수시간 비교. 폰 코드가 만든 시험값과 바이트까지 같음 | 데스크탑 Rust 서버에는 `/lan/push`·`/lan/pull` 처리기가 아직 없다(폰의 가짜 서버만 있음, 감사 문서의 `lan/client.ts` 도 폰 쪽). 없는 처리기를 지어내지 않고 처리기가 붙일 부품만 만듦 | 없음 | - |
| HMAC 구현 | `hmac` 0.12 크레이트 추가(Cargo.lock 에 이미 hkdf 가 끌어오던 것) | 직접 짜는 것보다 안전 | 없음 | - |
| ⑦ 이름 검사 | 코드 변경 없음 | 데스크탑 올리기 마법사(`src/creator-publish.ts`)에 이미 입력 중 검사(`checkCreatorAssetName`·`nameLine`·이름 제안·중복 조회)가 쉬운 한국어로 있고 브라우저 시험이 있음. 통합 브랜치 `core/creator/asset-name.ts` 와 바이트 동일(diff 0). 게다가 `RV.<종류>.<이름>` 규칙은 대표가 2026-10-13 폐기, 올리기는 `creator-pause.ts` 로 2026-10-14 잠금, 새 이름(`RVLT/S…#…`, asset-name-v2)은 키·문서 해시로 자동 생성되어 사람이 입력할 칸이 없음 | 없음 | - |

## 참여 AI 와 빠진 이유
Claude(본인)만 참여. codex·grok·gemini 는 부르지 않았다 — 위 결정이 모두 문서·코드로 확정되어 갈릴 선택지가 없었고, 지어낸 합의를 표에 넣지 않기 위해서다.

## 대표 판단이 필요한 것
1. ⑦ 은 이미 있는 기능 + 규칙 폐기라 구현하지 않았다. 새 이름 규칙(v2)의 입력 검사가 필요하면 그 화면이 생길 때 별도 작업.
2. `/lan/push`·`/lan/pull` 데스크탑 처리기 자체(기기 증서 확인·봉인 열기·로그 저장)는 아직 없다. 만들 때 `lan_proof::require_nonce`·`push_proof`·`pull_proof` 를 반드시 쓸 것(규격 정본은 폰 proof.ts).
