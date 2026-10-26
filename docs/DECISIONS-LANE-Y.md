# 레인 Y — 데이터 열쇠 만들기·봉투 전달·기기 끊기(회전) (데스크탑 Rust)

2026-10-15. 다기기 공유의 남은 부분. 규격 정본: 통합 브랜치 `docs/LAN-REQUEST-SIGNING.md` §7(이 레인에서 더함). 짝 결정 표: 통합 브랜치 `docs/DECISIONS-LANE-Y.md`(폰·코어).
새 크레이트·배포·스위치 변경·실제 키 없음. `lanSync` 는 계속 기본 꺼짐이고, 켜는 코드·화면은 만들지 않았다(대표 승인 항목).

## 바뀐 파일

| 파일 | 내용 |
| --- | --- |
| `src/lan_keys.rs` | `create_data_key`(OS 난수 32B), `seal_data_key_with_session`(폰과 같은 봉투 바이트), `seal_data_key_os`, `envelope_bound`. 세션 칸에 `envelope`(선택) — `check` 가 묶임·서명 확인 |
| `src/lan_handler.rs` | `LanDir`(push·pull·latest), `verify_lan_request_dir`(latest: 맡김 없음·판 안 맞춤·끊긴/만료는 `lapsed`), `handle_latest`·`handle_hello`·`handle_grant`, 라우터에 세 경로 |
| `src/lan_pair.rs`(새) | 짝 맺기 장부(1회용 안내 10분·대기 8대), `pair_code`, `offer_text`, `with_store_key_bundle`(사장 확인 1번 묶음 서명), `approve_plan`(증서 + 봉투) |
| `src/lan_rotate.rs`(새) | `rotate_plan`(core `rotateDataKey` 와 같은 순서), `clean_history`, 사장 화면 문구 `DISCONNECT_COPY`·`disconnect_reason` |
| `src/lan_mount.rs` | `devices.json`(이 PC 가 낸 증서 이력), `ensure_key_record`(판 1), `save_rotation` 목록 고르기, `update_revocation` 철회만 거절, 명령 `lan_pair_offer`·`lan_pair_pending`·`lan_pair_approve`·`lan_device_disconnect` |
| `src/device-connect.ts`·`device-copy.ts`·`main.ts` | 「끊기」 단추 → `disconnectFor` → Rust `lan_device_disconnect` 한 길. 문구 4개(영·일·중 번역 포함) |
| `testdata/rv-lan-v2-vectors.json` | 통합 브랜치 생성기 결과 그대로 복사(latest 서명·판정 24건·짝 번호 3건) |

## 결정

| # | 결정 | 고른 것 | 이유 | 대표 확인이 필요한 것 |
| --- | --- | --- | --- | --- |
| Y-1 | 열쇠 판 규칙 | 레인 L 의 L-4 채택: 같은 판에서 새 기기 세션 **추가만**. 같은 판에서 봉투를 바꾸는 것도 금지(`check_against` 가 봉투까지 비교). | 새 기기 허락마다 판을 올리면 다른 모든 기기가 열쇠를 다시 받아야 한다. 추가만이면 되감기·덮어쓰기는 그대로 막힌다. | 없음(위임 결정) |
| Y-2 | 시각 창 | ±5분 유지(latest 도 같음). latest 의 nonce 는 증서 끝 또는 지금+10분까지 기억. | 끊긴·만료된 증서도 latest 를 쓸 수 있어 증서 끝이 지났을 수 있다 — 그때도 창의 두 배는 기억한다. | 매장 기기 시계 오차 실측(레인 J 와 같음) |
| Y-3 | 회전 실행 위치 | Rust 가 직접. 열쇠·세션 열쇠는 웹뷰를 지나지 않는다. 서명은 `with_store_key_bundle` — 확인창 1번 → 12단어 1번 → 서명 1+N 번 → 비밀 열쇠 지움. 거절하면 단어를 읽지 않는다. | 기기가 여럿이면 확인창이 여러 번 뜨던 문제(레인 L 표 3번). `storesign::sign_flow` 와 같은 순서·같은 고정 오류 문장. | 확인창 한 번에 「서명 몇 번」을 보이는 문구가 충분한지 |
| Y-4 | 기기 끊기 | 「끊기」 단추는 `lan_device_disconnect` 하나만 부른다. 나눠 준 열쇠가 있으면 회전+철회 한 동작. 열쇠가 아직 없으면(같은 와이파이 복사를 한 번도 안 씀) Rust 가 `noDataKey` 로 답하고 화면이 예전처럼 목록만 서명한다(바꿀 열쇠가 없어 안전). 철회만 하는 길(`lan_revocation_update` 에 새 철회가 든 목록)은 `rotation-required` 로 거절. | 결정 ④. 철회만 하면 끊긴 기기가 옛 열쇠를 쥔 채 남는다. 관문 503 은 그대로 이중 안전. | 없음 |
| Y-5 | 회전 때 낡은 목록 | 지금 목록이 24시간을 넘었어도 회전은 거절하지 않는다(미래 시각만 거절). core `rotateDataKey` 는 거절한다 — **다른 점**. | 잃어버린 폰을 끊는 급한 일에 「먼저 목록 새로 서명」 확인을 하나 더 넣지 않으려고. 새 목록은 같은 묶음에서 지금 시각으로 서명되고, 남은 증서 확인은 새 목록으로 한다. | core 도 같게 바꿀지(지금은 폰·코어 쪽 회전 호출처가 없다) |
| Y-6 | `/lan/latest` 인증 | v2 요청 서명(dir `"latest"`). 봉투는 살아 있고 이 PC 가 낸 그 증서(세션 칸 기기·증서 서명 일치)일 때만. 끊긴·만료 증서는 서명된 목록만(`lapsed`). 서명 없는 옛 모양 400. | 봉투를 아무에게나 주지 않는다. 끊긴 폰도 스스로 「끊김」을 확인해야 한다(목록은 공개 서명 문서). | 없음 |
| Y-7 | `/lan/grant` 인증 | 서명 없음. 사장이 연 1회용 안내(OS 난수 16B, 10분)의 번호 + hello 한 공개키여야 한다. | 기기에 아직 증서가 없다. 봉투는 그 기기 개인키로만 열리는 암호문이라 엿본 사람이 받아도 못 연다. | 없음 |
| Y-8 | 증서 이력 | Rust 가 `lan/devices.json`(0600, 공개 증서)에 둔다. 허락·끊기 때 화면 이력(`knownCerts`)과 합치고 하나하나 가게 서명을 다시 본다. 같은 번호 다른 문서는 거절. | 회전에 남은 기기 공개키가 필요하고, 일련번호가 화면 발급과 겹치지 않아야 한다. | 화면 발급(`issueFor`)을 Rust 허락으로 합칠지(지금은 두 곳이 발급) |
| Y-9 | 처음 열쇠 | `lan_pair_offer` 가 열쇠 기록이 없으면 판 1 을 만든다(서명 필요 없음 — 세션 0, 함께 담는 목록은 이미 서명된 디스크 목록). 그 목록의 철회는 열쇠보다 먼저라 덮인 것으로 적는다. | 기록 없이는 LAN 이 켜지지 않고(`NoDataKey`), 허락은 LAN 이 켜져 있어야 하는 닭과 달걀. 처음이면 폰 서버를 한 번 다시 켜야 경로가 붙는다(라우터는 시작 때 한 번 만든다 — 기존 설계). | 처음 켤 때 서버 재시작 없이 붙일지 |
| Y-10 | 같은 판 추가 때 목록 | `save_rotation`: 같은 판 기록은 회전 때 목록을 지니므로, 그 사이 다시 서명된 더 새 목록을 그대로 쓴다. 새 판(회전)은 기록 안 목록이 가장 새것이어야 한다(아니면 `keys-list-rollback`). 저장 전 관문이 닫히면 `rotation-required`. | 하루마다 목록을 다시 서명하므로, 이 규칙이 없으면 허락 저장이 늘 「목록 되감기」로 거절된다. | 없음 |
| Y-11 | latest 의 `cert` 칸 | Rust 는 아직 싣지 않는다(증서 갱신 흐름이 Rust 에 없다). 규격상 선택 칸. | 지어내지 않는다. | 증서 자동 갱신(7일 잠정) 흐름 |

## 사장 화면 문구(초안 — 법적 확인 전)

- 끊기 확인창(웹뷰): 「이 기기를 끊을까요?」 / 「끊으면 그 기기는 바로 멈춰요.」 「남은 기기에는 새 열쇠를 나눠 줘요. 확인은 한 번만 하면 돼요.」 「이미 복사된 지난 데이터는 되돌릴 수 없어요.」
- 가게 서명 확인창(Rust, 80자 이하): 「「폰 이름」 연결 끊기 — 남은 기기 N대에 새 열쇠를 나눠요 (서명 N+1번을 한 번에 해요)」
- 끝: 「기기를 끊고 새 열쇠로 바꿨어요. 남은 기기는 같은 와이파이에서 앱을 열면 새 열쇠를 받아요.」 / 열쇠 없음: 「…기기끼리 나눈 열쇠는 아직 없어서 바꿀 것이 없어요.」
- 새 기기 허락 확인창: 「새 기기 「이름」 연결 허락 (확인 번호 123456) — 서명 2번을 한 번에 해요」
- 철회만 거절: 「기기 끊기는 「끊기」 단추로만 해요. 그래야 남은 기기의 열쇠도 함께 바뀌어요.」
- 내부 용어(증서·봉투·세션·회전·철회·nonce) 금지 — 시험 `y_owner_copy_is_plain_and_short`.

## 시험

- `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --offline --lib` 전체 통과(1081 통과, 13 무시).
- 폰 벡터 대조: 봉투 전체 바이트(서명 포함)·세션 열쇠 같음, 서명 본문·다이제스트·서명(push·pull·latest) 같음, 판정 24건(방향 latest 7건, `lapsed-revoked`·`lapsed-expired`) 같음, 짝 번호 3건 같음.
- 처리기: latest 자기 봉투만·판 0·재전송·옛 모양 400·남의 서명·서명 옮겨 쓰기·다른 증서 문서 403·끊긴/만료 기기 목록만·관문 503, hello/grant 안내 전·번호·가게·칸 거절.
- 흐름: 판 1 생성 → 두 기기 허락(사이에 하루치 새 목록) → grant 봉투 → 한 대 끊기(서명 2번) → 남은 기기 새 판 봉투·옛 판 410 → 끊긴 기기 목록만·revoked → 철회만 거절.
- 묶음 서명: 확인 1번·단어 1번으로 서명 5번, 잠금·거절이면 단어를 읽지 않음, 가게 키와 같은 서명.
- 웹뷰(`node --test scripts/biz-screens.test.mjs`, node_modules 임시 심링크): 23 통과 — 끊기 한 길·열쇠 없음일 때만 목록 서명·그 기기 빠진 목록 거절·번역 있음. `tsc --noEmit` 통과. 브라우저 시험(`biz-screens-browser`)은 돌리지 않았다.

## 남은 일(대표 결정)

1. `lanSync` 켜기(대표 승인) — 켠 뒤 첫 「폰 연결」에서 열쇠가 만들어지고 폰 서버 재시작이 한 번 필요(Y-9).
2. 「폰 연결」 화면에 새 명령(`lan_pair_offer`·`lan_pair_pending`·`lan_pair_approve`)을 붙이기 — 명령·문구는 있고 화면 배선은 아직(지금 화면의 RV6 QR 은 그대로).
3. 화면 발급(`issueFor`)과 Rust 허락을 하나로 합칠지(Y-8).
4. core `rotateDataKey` 의 낡은 목록 거절을 Rust 와 같게 풀지(Y-5).
5. 백업 판에 keys.json 을 넣을지(레인 L 부터 대기).
