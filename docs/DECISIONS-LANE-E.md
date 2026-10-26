# DECISIONS-LANE-E (브랜치 claude/rv-lane-e, 2026-10-15)

목표: 데스크탑 `/lan/push`·`/lan/pull` 처리기. 순서(34라운드 5표 합의): ① 증서 확인 → ② 봉인 열기 → ③ 추가만 되는 로그 저장 → ④ 처리기.

| 결정 | 선택 | 근거 |
|---|---|---|
| ① 증서 확인 규격 | `src-tauri/src/lan_cert.rs` — 통합 브랜치 `core/device/cert.ts verifyDeviceCert`·`revoke.ts checkDeviceRevocations`·`core/shop-order/signed.ts` 와 같은 순서·같은 사유 이름. 서명 = 레이븐 signmessage(sha256d) 65바이트 복구형, 낮은 S, 정본 base64, 복구 키 = 가게 키 | 폰 코드가 정본. 시험값은 폰 코드가 만든 합성 증서/철회 목록(`testdata/rv-lan-cert-vectors.json`, 가게 키 = 0x11 반복 개인키)이고 Rust 가 같은 답(ok·certId·사유)을 낸다 |
| 서명 복구 | `secp256k1` 크레이트에 `recovery` 기능만 켬 (새 크레이트 없음) | 폰은 복구한 키가 가게 키와 바이트까지 같은지 본다. 단순 검증은 복구 번호가 틀려도 통과하므로 같지 않다 |
| 가게 키·데이터 열쇠 | 처리기는 호출자가 준 값만 쓴다. 이 레인은 12단어·지갑·.env 를 열지 않는다 | 지시: 실제 키 금지 |
| 이 레인에서 안 만든 것 | 「우리가 낸 증서 목록과 대조」(FakeDesktop 의 `issued` 검사) | 폰 정본 `verifyDeviceCert` 에 없는 가짜 서버 전용 추가 검사. 서명 + 철회 목록으로 충분하다 |
| ② 봉인 열기 규격 | `src-tauri/src/lan_seal.rs` — 폰 `phone/network/real/lan/seal.ts` 와 같음: XChaCha20-Poly1305, 열쇠 = 데이터 열쇠 32바이트 그대로, AAD = 정본JSON[도메인, 가게, 증서, 기기, 방향, 조각 번호, 커서, 열쇠 판], 봉투 `{v,keyVersion,nonce(hex48),ct(base64)}` | 폰이 같은 열쇠·nonce 로 만든 값(`testdata/rv-lan-seal-vectors.json`)을 Rust 가 열고, Rust 가 닫은 값이 바이트까지 같다. 다른 기기/가게/증서/방향/조각/커서로 옮기면 안 열린다 |
| ③ 로그 저장 | `src-tauri/src/lan_store.rs` — 한 파일 `lan-log.jsonl` 에 줄 단위 덧붙이기(조각 줄 `c`, 쓴 nonce 줄 `n`). 쓰기 + `sync_data` 가 성공한 뒤에만 메모리 반영·`Ok`. 같은 조각 번호는 한 번만 반영(`DuplicateChunk`), 같은 nonce 재사용은 `NonceReplay`, 같은 항목 id 는 처음 것을 지킴(폰 `ChangeLog` 와 같은 규칙) | 폰 `log.ts` 병합 규칙 + 지시(재전송 nonce 거절·조각 번호 중복 거절·재시작 복구·저장 성공 뒤에만 성공). 마지막 줄이 쓰다 만 것이면 그 줄만 버림, 중간이 깨졌으면 열지 않음(조용한 유실 방지). 파일 잠금으로 한 번에 한 프로그램만 |
| nonce 보관 기간 | 7일(`NONCE_KEEP_MS`, 증서 기본 기간과 같음). 잠정 — 대표 결정 대기 아님, 필요하면 상수만 바꾸면 됨 | 폰은 요청마다 새 nonce 를 쓰므로(client.ts) 같은 nonce 가 두 번 오면 재전송이다. 영구 보관하면 파일이 끝없이 자란다. 지난 nonce 의 재전송은 증서 만료·조각 번호 중복·확인값 nonce 묶음이 따로 막는다 |
| 다시 보낸 조각의 응답 | 이미 반영한 조각은 다시 반영하지 않고 409 + 확인값 | 폰 client.ts 가 「200 이든 409(이미 저장된 조각)이든 확인값이 맞으면 ACK」로 처리한다 |
| ④ 처리기 | `src-tauri/src/lan_handler.rs` — `handle_push`/`handle_pull`(순수 함수) + `router()`(axum 조각). 순서: 크기(128KiB, 413) → JSON → nonce 모양 → ① 증서(push 맡김 draft/ticket-check/key-request/notice-write 중 하나, pull 맡김 read/replicate 중 하나) → nonce 기록(재사용 403 replay) → ② 봉인 열기 → 조각 번호·개수·출처(origin = 증서 기기) 대조 → ③ 저장 → 응답에 `lan_proof` 확인값. 거절 응답에는 확인값 없음 | 경로·본문·응답 모양은 폰 `client.ts`/`transport.ts`/`fake-desktop.ts` 와 같다(이 레인 가정이 아니라 폰 정본). 맡김 집합은 `fake-desktop.ts` PUSH_SCOPES/PULL_SCOPES. 이미 반영한 조각은 409 + 확인값(`client.ts` 가 409 도 확인값이 맞으면 ACK) |
| 서버 켜기 | 기본 꺼짐: `LanConfig::default().enabled == false` → `router()` 는 `None`. 설정 JSON 의 `lanSync` 가 **불리언 true** 일 때만 켬. 이 레인은 listen 하지 않고, 기존 `server.rs` 에도 붙이지 않았다 | 지시: 기본 꺼짐·외부 노출/새 서버 금지. `server.rs` 는 6,400줄 공용 파일이라 장착(`merge`)·설정 화면·데이터 열쇠/가게 키 공급은 별도 승인 작업으로 남김 |
| 안 한 것(대표 판단 필요) | ⓐ 데이터 열쇠를 디스크/키체인에서 꺼내 `LanServerState` 에 주는 곳, ⓑ 가게 공개키 공급(12단어 필요 — 이 레인은 열지 않음), ⓒ 최신 철회 목록 갱신 경로, ⓓ `server.rs` 장착 + 설정 스위치 | 모두 실제 키를 다루거나 공용 서버 파일을 건드린다 |
