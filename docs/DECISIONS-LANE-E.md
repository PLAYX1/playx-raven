# DECISIONS-LANE-E (브랜치 claude/rv-lane-e, 2026-10-15)

목표: 데스크탑 `/lan/push`·`/lan/pull` 처리기. 순서(34라운드 5표 합의): ① 증서 확인 → ② 봉인 열기 → ③ 추가만 되는 로그 저장 → ④ 처리기.

| 결정 | 선택 | 근거 |
|---|---|---|
| ① 증서 확인 규격 | `src-tauri/src/lan_cert.rs` — 통합 브랜치 `core/device/cert.ts verifyDeviceCert`·`revoke.ts checkDeviceRevocations`·`core/shop-order/signed.ts` 와 같은 순서·같은 사유 이름. 서명 = 레이븐 signmessage(sha256d) 65바이트 복구형, 낮은 S, 정본 base64, 복구 키 = 가게 키 | 폰 코드가 정본. 시험값은 폰 코드가 만든 합성 증서/철회 목록(`testdata/rv-lan-cert-vectors.json`, 가게 키 = 0x11 반복 개인키)이고 Rust 가 같은 답(ok·certId·사유)을 낸다 |
| 서명 복구 | `secp256k1` 크레이트에 `recovery` 기능만 켬 (새 크레이트 없음) | 폰은 복구한 키가 가게 키와 바이트까지 같은지 본다. 단순 검증은 복구 번호가 틀려도 통과하므로 같지 않다 |
| 가게 키·데이터 열쇠 | 처리기는 호출자가 준 값만 쓴다. 이 레인은 12단어·지갑·.env 를 열지 않는다 | 지시: 실제 키 금지 |
| 이 레인에서 안 만든 것 | 「우리가 낸 증서 목록과 대조」(FakeDesktop 의 `issued` 검사) | 폰 정본 `verifyDeviceCert` 에 없는 가짜 서버 전용 추가 검사. 서명 + 철회 목록으로 충분하다 |
