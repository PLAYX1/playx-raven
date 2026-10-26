# 레인 L — LAN v2 Rust 서버(검수 H1: 요청 서명·열쇠 나누기·철회=열쇠 회전)

2026-10-15. 데스크탑 Rust(`src-tauri`)만. 새 크레이트·배포·스위치·실제 키 없음(LAN 은 계속 기본 꺼짐). 규격 정본: 레인 J `docs/LAN-REQUEST-SIGNING.md`, 시험 벡터 `src-tauri/testdata/rv-lan-v2-vectors.json`(레인 J 파일 그대로 복사, 합성 열쇠).

## 바뀐 파일

| 파일 | 내용 |
| --- | --- |
| `src/lan_keys.rs`(새) | 압축 점 33B ECDH(`PublicKey::mul_tweak` → `serialize()`), 세션 열쇠·봉투 열쇠 HKDF, `derive_lan_key(seal/proof)`, 열쇠 기록 v2 `LanKeyRecord`(parse·check·check_against), 회전 관문 `rotation_gate_ok` |
| `src/lan_proof.rs` | `push_proof_v2`·`pull_proof_v2`(도메인 `RAVENVAULT-LAN-PROOF-V2`). v1 함수는 기존 벡터용으로 남김 |
| `src/lan_handler.rs` | 와이어 v2. `verify_lan_request`(TS `verifyLanRequest` 와 같은 순서·사유), `request_sig_body`, `session_keys`, 회전 관문 503 |
| `src/lan_mount.rs` | 열쇠 공급을 `keys.json`(v2 기록)으로. `save_rotation`, 다시 켤 때 §4.2 조건, 상태에 `keys{…}` |
| `src/lan_testkit.rs`(새, 시험 빌드만) | 합성 가게(0x11)·합성 기기(0x41~)로 증서 발급·요청 서명 |
| `src/server.rs` | 폰 서버 라우터 시험의 요청을 v2 서명 요청으로 |

## 결정

| # | 결정 | 고른 것 | 이유 | 대표 확인이 필요한 것 |
| --- | --- | --- | --- | --- |
| L-1 | 확인 순서 | 규격 §2.4 그대로. 다만 nonce 는 ⑤에서 **보기만** 하고, 기록은 열쇠 판·세션·(push)봉인·종류·크기 확인이 끝난 뒤 저장소 잠금 안에서(레인 I 순서). | 서명·시각 뒤에만 기록(규격) + 봉인이 틀린 요청도 로그를 못 키움(레인 I). 응답 사유는 TS 와 같다(벡터 14건). 차이: 410 으로 끝난 요청의 nonce 는 소비되지 않는다 — 폰은 매번 새 nonce 라 영향 없음. | 없음 |
| L-2 | nonce 저장 키 | 레인 I 저장소 그대로 nonce 하나(가게 전체)로 기억, 증서 끝 시각까지. | (certId, nonce) 보다 엄격하고, 10분 이상 기억 조건을 넘는다. 16바이트 OS 난수라 기기끼리 부딪힐 일 없음. | 없음 |
| L-3 | 열쇠 기록 모양 | `lan/keys.json` = `{v:2, keyVersion, dataKey, sessions:{certId:{key, deviceId, certSig}}, revocationSeq, revokedAtRotation, revocations}` 한 파일. 옛 `data-key.json`(v1)은 읽지 않음(만드는 코드도 없었음). | 회전 결과(열쇠 + 새 목록)를 **원자적으로 한 번에** 쓰려면 한 파일이어야 한다. 세션 칸에 기기 번호·증서 서명을 같이 두어 「이 PC 가 낸 그 증서」(§2.4 ⑦)를 발급 장부 없이 대조한다. 규격 §4.1 의 `{certId: sessionKey}` 보다 칸이 많다 — 회전·발급 코드를 만들 때 이 모양으로 써야 한다. | 없음(형식은 아직 아무도 쓰지 않음) |
| L-4 | 같은 판 기록 교체 | 판이 크면 받는다. 같은 판이면 데이터 열쇠 바이트가 같고 지금 세션을 하나도 바꾸지/빼지 않을 때만(새 기기 세션 **추가**만 허용). 작으면 거절. 목록 seq 도 뒤로 못 감. | 규격 §4.2 ②는 「같으면 바이트까지 같아야」인데, 그러면 새 기기를 들일 때(같은 판 봉투 추가)마다 판을 올려야 한다. 추가만 허용해도 되감기·덮어쓰기는 막힌다. | 새 기기 추가 때 판을 올릴지(규격대로) 추가만 허용할지 |
| L-5 | 받지 않은 새 기록 | 지금 상태(검증된 옛 기록)로 계속 받고 상태에 `keys.lastError` 를 보인다. 처음 켜기면 경로를 만들지 않음(`keys-rejected`). 파일 자체가 망가진 경우(모양)는 레인 I 그대로 경로를 멈춤. | 규격 §4.2 「옛 상태 유지 + 화면에 상태」. 모양 깨짐은 무엇이 들었는지 모르므로 닫힌 실패 유지. | 없음 |
| L-6 | 반쪽 회전 | 저장 순서 = 열쇠 기록(목록 동봉) → revocation.json. 켤 때 두 목록 중 받기 규칙으로 더 새것을 쓰고 디스크 목록도 맞춘다. 디스크 목록이 망가졌으면 기록 쪽 서명된 목록을 쓴다. | 두 파일 사이에 꺼져도 「새 열쇠 + 옛 목록」이나 「새 목록 + 옛 열쇠」로 돌지 않는다(시험함). 원자 쓰기는 기존 `atomic_write_0600`(임시·fsync·rename·폴더 fsync). | 없음 |
| L-7 | 목록이 없을 때의 관문 | 목록이 없거나 서명이 깨졌으면 관문은 'ok' 로 두고 증서 확인이 모두 403 으로 막는다. | 어느 쪽이든 닫힘. 레인 I 의 「목록 없음 = 모두 거절(403)」 응답을 그대로 둔다. | 없음 |
| L-8 | 세션 표와 다른 증서 | certId 세션이 없으면 410 key-version, 세션은 있는데 기기·증서 서명이 다르면 403 bad-cert. | 폰 가짜 서버(`fake-desktop.ts auth`)와 같은 판정. | 없음 |
| L-9 | 다른 가게 번호 | 레인 I 의 `other-store`(403) 사유 유지 — TS 에는 없는 사유. | 폰은 403 을 forbidden 으로 처리하므로 호환. | 없음 |
| L-10 | 크레이트 | `hkdf 0.12`·`sha2`·`secp256k1 0.30`·`chacha20poly1305` — 모두 이미 Cargo.toml/lock 에 있음. k256 은 쓰지 않음(압축 점은 secp256k1 `mul_tweak`). | 새 크레이트 금지. | 없음 |

## 봉투 전달 경로(이 레인에서 만들지 않음 — 필요한 것 정리)

지금 Rust 에는 `/lan/hello`·`/lan/grant`·`/lan/latest` 경로가 **없다**(폰 `device-link.ts` 와 가짜 서버만 있다). 데이터 열쇠를 처음 만드는 곳도 없다(Rust·화면 전체).

1. **데이터 열쇠 만들기**: OS 난수 32B, 판 1. 가게 키 PC 에서만, `keys.json` 에만(백업 판 포함 여부 결정 대기 — `lan_mount` 주석 「백업 판 5」).
2. **봉투 만들기(Rust `sealDataKeyWithSession`)**: 헤더 `{v:1, storeId, certId, deviceId, devicePubKey, keyVersion, keyId=sha256(정본[DOMAIN, storeId, 판, hex(열쇠)]), eph, nonce(24B)}` → `lan_keys::ecdh_compressed`·`wrap_key_of`·`session_key_of` → XChaCha20-Poly1305(AAD = 정본[DOMAIN, 헤더]) → **가게 키 서명**(`sign_doc(RAVENVAULT-DEVICE-DATA-KEY-V1)`). 세션 열쇠는 `keys.json` 세션 칸에(L-3 모양). 바이트 대조용 벡터는 이미 있다(`envelope.*` — 봉투 열쇠·세션 열쇠·ct 대조는 이 레인 시험이 통과).
3. **가게 키 서명 횟수**: 회전 1번 = 새 목록 1 + 남은 기기마다 봉투 1. 지금 가게 키 서명은 매번 사장 확인창(`storesign`) — 기기가 여럿이면 확인창이 여러 번 뜬다. **한 번 확인으로 묶어 서명하는 흐름**이 필요(결정 필요).
4. **회전 실행 위치**: (a) Rust 가 직접(열쇠가 웹뷰를 거치지 않음 — 권장) 또는 (b) 웹뷰 TS `rotateDataKey` 결과를 명령으로 넘김(데이터 열쇠·세션 열쇠가 웹뷰 메모리를 지난다). 어느 쪽이든 끝은 `lan_mount::save_rotation(기록)` 한 줄이고, 「기기 끊기」 단추는 이 경로만 불러야 한다(철회 목록만 따로 서명하는 화면 경로 `device-connect.ts resignList` 는 관문을 닫게 된다 — 지금도 그 경우 503 으로 멈춤).
5. **`/lan/grant`**: 짝 맺기 승인 뒤 증서 + 철회 목록 + **현재 판 봉투**(`dataKey` 칸). 새 기기 세션을 같은 판에 추가(L-4) → `save_rotation` 과 같은 저장 경로(같은 판 추가 허용).
6. **`/lan/latest`**: 새 목록 + 그 기기의 현재 판 봉투(판이 바뀌었을 때). 이 요청도 v2 요청 서명(새 dir 값, 예: `"latest"`)으로 인증해야 봉투를 아무에게나 주지 않는다 — 규격 추가 필요(레인 J).
7. **폰**: `DeviceGrant`·`DeviceRefresh` 타입에 `dataKey`, `openDataKeyWithSession(…, expectedVersion = 저장된 판 이상)`, `deviceSession` 저장(`openLanKeys`), 판 단조 보관.
8. 화면 문구: 관문이 닫혔을 때(`keys.gate = rotation-required`)·기록을 받지 않았을 때(`keys.lastError`) 사장 화면 문구(지금은 `keys_status.say` 초안).

## 시험

- `cargo test --offline --lib` (RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture) 전체 통과.
- 폰 벡터 대조: 세션 열쇠(양쪽 ECDH·압축 점 33B)·봉투 열쇠로 ct 열기·봉인/확인값 열쇠·info 문자열·조각 봉인 바이트·서명 본문/정본/해시/문구/다이제스트(push·pull)·Rust 재서명 와이어 바이트 동일·서버 판정 14건·확인값 v2 3건·회전 관문 4건.
- 처리기: 변조 9종(count·sealed·chunkId·nonce·ts·cursor·서명 바이트·high-S·비정본 base64)+열쇠 판, 재전송, 시각 창 ±5분 경계, 남의 증서+내 서명, 서명 없는 증서, 서버 사칭(데이터 열쇠+자기 세션으로 만든 확인값·ACK·조각), 옛 열쇠 410, 세션 없음 410, 증서 서명 다름 403, 철회 기기(옛 열쇠 포함), 회전 관문 503(본문 읽기 전), v1 400.
- 서버 상태: 회전 저장 → 한 벌 교체, 나쁜 회전 7종 거절(상태·디스크 그대로), 철회만 → 503 → 회전 → 열림, 두 파일 사이 멈춤 복구, 다시 켤 때 옛 기록 거절, 실제 파일 0600·임시 파일 없음.
