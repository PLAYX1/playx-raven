# 레인 I 결정 표 — LAN 동기화 서버 쪽 수리 (2026-10-15)

기준: `claude/rv-lane-f` af4840e 에서 갈라진 `claude/rv-lane-i`. 검수 3종(Claude Opus·GPT 6.1 sol·아스트라) 지적을 코드로 직접 확인한 뒤 고쳤다.
배포·push·릴리스 빌드·SQL·스위치 켜기 없음. 새 크레이트 없음. 실제 열쇠·지갑·.env 를 열지 않았다(시험은 합성 벡터만).

검증: `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --offline --lib` → **1042 통과 · 0 실패 · 13 무시**(무시는 이 레인 이전부터 있던 것). 이 레인에서 시험 24개 추가.

| 항목 | 판정 | 무엇을 했나 · 근거 |
|---|---|---|
| **M1** 켜기/다시 켜기 때 재료 다시 읽기 | 고침 | `LanSlot::arm` 이 켜질 때마다 `build_material`(가게 번호·가게 키·데이터 열쇠·철회 목록 파일)을 다시 읽는다. 지문(`LanAuth::fingerprint`) 같으면 그대로, 같은 가게면 재료만 교체(옛 라우터가 쥔 같은 `Arc` 상태가 새 재료를 씀), 가게 번호가 바뀌면 그 가게 로그(`lan/log/<가게 번호>/`)를 열어 저장소째 교체. 다시 읽기 실패면 붙어 있던 경로도 멈춤(닫힌 실패). 처리기는 `cert.store_id == auth.store_id` 를 강제(`other-store`), 저장소에도 가게 번호를 달아 바뀌는 순간 옛 재료 요청은 503 `reloading`. 시험: `m1_*` 5개. 검수 #6·#8·「재활성화 키 갱신」 맞음. |
| **M2** 64KiB 평문 상한 | 고침 | `open_chunk` 가 복호화 직후 평문 > 65,536 이면 `OutOfRange` → 413 `chunk-too-big`(nonce 도 안 씀). push 는 저장 전 `serde_json` 재직렬화 크기도 본다. pull 은 혼자서도 64KiB 를 넘는 옛 항목을 건너뛰고 `counters.oversize_skipped` + 로그 한 줄(위치·크기만, 내용 없음) — 커서는 앞으로. 65,537바이트 단일 항목이 암호문 상한을 통과함을 시험으로 확인(검수 길이 계산 맞음). |
| **M3** nonce 순서·상한·속도·동시성·실행 중 압축 | 고침(시각 창은 보류) | push: 봉인·출처·종류·크기 확인이 **끝난 뒤** nonce 기록(그 전에는 `nonce_seen` 으로 보기만). nonce 상한 기기별 20,000 · 전체 200,000(→ 429 `nonce-quota`, 디스크에 아무것도 안 씀). 1분 창 속도 전체 600(증서 확인 전 — 서명 복구 비용 방어)·기기별 120(→ 429 `rate`). 동시 처리 4(→ 503 `busy`, 폰은 source-down). 잊은 nonce 줄이 4,096 이상이고 기억 중인 것보다 많으면 실행 중 압축. **요청 시각 창**은 시각 필드가 서명 규격(H1)과 함께 들어와야 하므로 이번엔 하지 않음. pull 은 H1 전까지 증서만으로 nonce 를 쓰는 구조가 남는다 — 상한들이 그 크기를 묶는다. |
| **M4** 압축 임시 파일 권한·폴더 fsync | 고침 | 임시 파일을 `create_new` + `mode(0o600)` 로 처음부터 0600, 만든 뒤 권한 재확인, 지난번 남은 임시 파일은 지우고 새로. 새 로그 파일 최초 생성 뒤·rename 뒤 부모 폴더 `sync_all`. rename 뒤 다시 열기 실패는 고장 상태. 검수(sol #7·아스트라 #4) 맞음 — 기존은 `File::create` 였다. 시험은 남은 0644 임시 파일을 두고 확인(프로세스 umask 자체는 다른 시험에 번지므로 바꾸지 않았다). |
| **M5** kind 별 권한 표 | 고침(보수적) | 폰 쪽 근거: `phone/network/real/lan/log.ts` 의 `kind` 는 길이만 보는 자유 문자열이고, 종류↔맡김 표는 **어디에도 없다**(폰 시험은 `note`). `core/sync/log.ts` 는 `draft` 만 기기가 쓸 수 있고 나머지(product·quote·order-status·receipt·refund·resolve·staff-*·seller-notice)는 원본(가게 키 PC, staff-pc)만. 그래서 표 = 맡김 이름과 같은 네 종류(`draft`·`ticket-check`·`key-request`·`notice-write`), 보낼 때 그 맡김 필요. 표에 없는 종류(`note` 포함)는 403 `kind-scope` + `counters.kind_refused`. 받기: `replicate` 는 아는 종류 전부, 그 밖엔 같은 맡김을 가진 기기만, 공지는 `read` 로도; 모르는 종류는 아무에게도 안 주고 `kind_skipped` 기록. **폰 레인 할 일**: 실제 항목 `kind` 를 이 네 낱말로 맞추거나, 다른 표가 필요하면 규격으로 정해 달라. |
| 저장 롤백(set_len) 실패 | 고침 | 쓰기/동기화 실패 뒤 `set_len`+`sync_data` 까지 실패하면 저장소 `Failed`. 이후 모든 쓰기·처리 요청이 500 `store-failed`(이미 저장된 조각의 409+확인값조차 안 나감). 복구 = `LanStore::recover`(다시 열어 꼬리 정리), 다시 켜기(`arm`)가 자동으로 시도. 검수(아스트라 #5) 맞음 — 기존은 `let _ = set_len`. |
| **L1** nonce 보관 ≥ 증서 수명 | 고침 | nonce 줄에 `x`(잊어도 되는 시각 = 그 요청 증서의 notAfter + 30초)·`d`(기기) 추가. 끝나지 않은 증서로는 재전송 불가. `x` 없는 옛 줄은 30일+30초 보관. 기존 7일은 증서 최대 30일보다 짧았다(검수 맞음 — 다만 조각 중복 검사로 이중 반영은 원래도 없었다). |
| **L2** 같은 id 다른 내용 | 고침 | 저장 전에 `LanStore::conflicts`(기존 항목·같은 조각 안끼리)로 보고 하나라도 있으면 조각 통째로 거절: **422** `{reason:"conflict", conflicts:[id…]}`, 확인값 없음. 409 는 폰이 「이미 저장」 확인값을 기대하는 자리라 쓰지 않았다(확인값 없는 409 는 폰이 `ack-proof` 로 계속 재시도). 폰 레인: 422 `conflict` 처리 필요. |
| **L3** `/lan` 바깥 판정 | 고침 | `/lan/*` 에만 `lan_from_outside`: cf-connecting-ip·cf-ray·cf-ipcountry·cf-visitor·cdn-loop·x-forwarded-for/host/proto/port·forwarded·x-real-ip 중 하나라도 있으면 바깥. Host 는 정확히 하나, 사설·링크 로컬 IPv4 숫자(포트는 숫자) 또는 `<이름>.local` 만 안쪽. localhost·127.0.0.1 도 `/lan` 에서는 바깥(터널이 넘겨주는 주소). 다른 경로의 `from_outside` 는 그대로. 검수 「10.example.com 을 안쪽으로 본다」 맞음. 실제 Cloudflare 터널로 그런 Host 가 오는지는 확인하지 않았다(필요 없게 막음). |
| **L5** 철회 목록 갱신 한 잠금 | 고침 | `LanSlot.serial` 잠금 하나로 `update_revocation` 전체(읽기→판정→저장→교체)와 `arm` 재료 교체를 줄 세움. 켜진 상태가 **가게 키와 가게 번호 모두** 같을 때만 메모리 목록을 바꾼다(다른 가게로 켜져 있으면 디스크만 — 검수 #6 의 A/B 섞임 경로 차단). |
| **L7** 철회 목록 서명 확인 캐시 | 고침 | 목록이 들어올 때(`LanAuth::new`·`set_revocation`) 한 번 `verify_revocation_list` 하고 결과를 담는다. 요청마다는 `verify_device_cert_prechecked`(증서 서명만 확인). 원래 경로와 모든 시험 벡터 증서×목록(정상·철회·낡음·없음·서명 깨짐·모양 깨짐)×시각×맡김에서 같은 답인지 대조 시험. |
| DataKey zeroize | 고침(크레이트 없이) | `zeroize` 는 Cargo.lock 에 간접으로만 있고 직접 의존성이 아니다 → 새 의존성 추가 대신 기존 `words::wipe_bytes`(volatile 0 쓰기)로 `Drop` 구현. 복사본도 각자 떨어질 때 지운다. |
| H1 요청 서명·확인값 열쇠 분리 | 보류(지시대로) | 폰 TS 와 와이어 규격·시험 벡터를 먼저 맞추는 별도 레인. 서명 검증 자리(trait)는 만들지 않았다. 검수 #1·#2(증서 베끼기·공유 키 보유자의 확인값 위조)는 **여전히 열려 있다** — 이번 수리는 그 피해 크기(로그 증식·속도)만 묶는다. |

## 검수가 틀렸거나 과장된 점
- 없음(사실관계는 모두 코드로 확인됨). 다만 아스트라 #3 「pull 도 증서와 새 nonce 만으로 기록 유발」은 H1 없이는 구조적으로 남는다 — nonce 순서 수정으로는 pull 을 막을 수 없고 상한(속도·개수)으로만 묶었다.
- sol 「nonce 7일 < 증서 30일」은 맞지만 영향은 「같은 요청 재처리」까지이고 조각 중복 검사가 이중 반영을 막고 있었다(검수도 그렇게 적음).

## 바뀐 와이어·디스크 모양(폰·운영에 알릴 것)
- 새 거절: 413 `chunk-too-big`, 403 `kind-scope`, 403 `other-store`, 422 `conflict`(+`conflicts`), 429 `rate`·`nonce-quota`, 503 `busy`·`reloading`, 500 `store-failed`(고장 상태).
- 로그 폴더: `lan/log/` → `lan/log/<가게 번호>/`. 데이터 열쇠 파일을 만드는 코드가 아직 없어 운영 로그는 없다(옛 위치를 옮기는 코드는 넣지 않았다).
- nonce 줄에 `x`·`d` 칸 추가(옛 줄도 읽는다).

## 남은 일
1. H1(요청 서명·응답 확인값 열쇠 HKDF 분리) — 규격 레인 뒤에.
2. 요청 시각 창(H1 서명 규격에 시각 필드가 들어오면 서버에서 창 검사).
3. 폰 레인: 항목 `kind` 를 네 낱말로, 422 `conflict`·429·503 처리, 철회 시 데이터 열쇠 회전.
4. 실행 중 설정 끄기 즉시 반영(설정 파일 감시)은 없다 — 끄기는 기존 `disarm` 경로, 켜기·재료 갱신은 폰 서버 다시 켜기 때.
