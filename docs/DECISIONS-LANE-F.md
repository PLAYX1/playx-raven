# DECISIONS-LANE-F (브랜치 claude/rv-lane-f, 2026-10-15)

목표: 레인 E 의 `/lan/push`·`/lan/pull` 처리기를 데스크탑 폰 서버에 붙이고(기본 꺼짐), 열쇠 공급·철회 목록 갱신·기기 증서 발급을 Rust 쪽에 둔다.
실제 지갑·키·12단어·.env 는 열지 않았고 실행하지 않았다. 시험은 합성 값만(시험 벡터 가게 개인키 = 0x11 반복).

## ① 서버 장착 + 스위치

| 결정 | 선택 | 근거 |
|---|---|---|
| 어디에 붙이나 | 기존 `server.rs build_phone_router` 의 라우터에 `merge`. **새 포트·새 listen 없음** | 이 라우터는 이미 `0.0.0.0:8790` 에 묶여 있다(`server.rs` 머리 주석·`start_phone_server` 의 `TcpListener::bind(("0.0.0.0", PORT))`). `/lan/*` 은 그 위에 경로만 더한다 |
| 바깥(터널) | `/lan/*` 은 `from_outside` 이면 **원격 관리를 켜도** 막는다(`outside_blocked` 맨 앞) | 결정문 §40-B 「같은 LAN 안 자동 복제」. 터널은 포트 전체를 넘기므로 경로 단위로 막아야 한다 |
| 문지기 | `/lan/*` 은 기존 두 문지기(`plain_member_gate`·`outside_gate`) 안쪽에 붙는다 | 문지기는 `merge` 뒤에 `layer` 로 걸려 모든 경로를 덮는다 |
| 스위치 | 앱 폴더 `lan/settings.json` 의 `lanSync` 가 **불리언 true** 일 때만. 없음·문자열·숫자·깨진 JSON = 꺼짐 | 레인 E `LanConfig::from_json` 그대로 |
| 꺼짐일 때 | 경로를 만들지 않는다(404). 열쇠 파일은 **읽지도 않는다** | 지시: 기본 꺼짐 |
| 끌 때 | `LanServerState::live` 를 내려 이미 붙은 경로도 곧바로 404. 상태(로그 파일 잠금)는 버리지 않고 다시 켜면 재사용 | 라우터는 서버 시작 때 한 번 만든다. 옛 라우터가 로그 잠금을 쥐고 있어 새로 열면 충돌한다 |
| 켜기 반영 시점 | 폰 서버를 (다시) 켤 때 | 라우터 재구성을 서버 도중에 하지 않는다(기존 구조 유지) |
| 🔴 켜는 화면·명령 | **만들지 않음.** `write_config` 함수만 있고 부르는 곳 없음 | 「사업자 PC 안 로컬 리스너 ≠ 새 서버」 해석·켜기는 대표 승인 항목(§40-B) |

## ② 열쇠 공급(가게 공개키·데이터 열쇠·철회 목록)

코드에서 찾은 현재 위치(이 브랜치 기준):

| 값 | 지금 있는 곳 | 근거 |
|---|---|---|
| 가게 공개키 | 저장된 곳 없음. Rust 가 12단어에서 그때그때 뽑는다(경로 `m/44'/175'/7'/1'/0'`) | `src-tauri/src/storesign.rs` `store_key_info`·`store_secret`, `identity::PATH_SHOP` |
| 가게 번호(storeId) | 화면(웹뷰) localStorage 에만 | `src/store-doc-ui.ts` `localStoreDocStorage` |
| 철회 목록 | 화면 localStorage `rv-devices-v1` 에만. 서명은 `store_sign_digest`(매번 사장 확인창) | `src/device-connect.ts` `localDeviceStore`·`resignList`·`tauriStoreKey` |
| 데이터 열쇠 | **어디에도 없다**(Rust·화면 전체 검색 0건, 화면 문구만) | `grep -rn "dataKey\|data_key" src src-tauri/src` |

| 결정 | 선택 | 근거 |
|---|---|---|
| 공급자 | `lan_mount::LanKeySource` trait. 시험 = `SynthKeys`(합성), 운영 = `FileLanKeys`(앱 폴더 `lan/` 파일, 0600) | 지시 ② |
| 가게 공개키 | `lan_store_set(store_id)` 명령이 **Rust 안에서 12단어로 직접 뽑아** `lan/store.json` 에 적는다. 화면이 주는 키는 받지 않는다. 앱 잠금 중 거절, 단어·비밀 열쇠는 바로 지움 | 화면이 준 키를 믿으면 가짜 키로 서명한 증서가 통과할 수 있다. `storesign` 과 같은 지우기 규칙 |
| 가게 번호 | 화면이 준다(64 hex 만). 틀린 번호면 그 번호로 서명된 증서가 없으니 문이 안 열린다(닫힌 실패) | Rust 에는 가게 문서 검증기(`verifyStoreDoc`)가 없다 |
| 데이터 열쇠 | `lan/data-key.json` `{v:1,version,key}` 을 **읽기만**. 만드는 코드 없음 → 지금은 늘 `no-data-key` 로 꺼진 채 | 만들기 시점·기기에 나눠 주기(`sealDataKey`)·백업 판 5·회전은 서로 묶인 결정이다. 반쪽만 만들면 열쇠가 백업 밖에 생긴다 |
| 빠진 것이 있으면 | 경로를 만들지 않고 이유 코드(`no-store`·`bad-store`·`no-data-key`·`bad-data-key`·`store-failed`)를 `lan_sync_status` 로 보인다. 열쇠·목록 본문은 싣지 않는다 | 정직한 상태 |
| 시험에서 한 것/안 한 것 | `lan_store_set` 은 **실행하지 않음**(12단어를 노드에서 받는다). 그 안의 순수 함수 `store_identity_from_words` 만 공개 BIP39 시험 단어(abandon…about)로 시험 | 지시: 실제 지갑·12단어 금지 |
