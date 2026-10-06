# 데스크톱 배포 전 검사

- [ ] `npm run check:pre-release` — preflight, TypeScript, Vite, 첫 실행 컨트롤러 시나리오. release workflow가 실행한다.
- [ ] `node scripts/check-firstrun.mjs --browser` — 네 가지 첫 실행 조합의 첫 프레임부터 인사 만료까지 팝업 없음. 격리 Chrome 사용. 다른 경로의 Chrome은 `CHROME_PATH` 지정.
- [ ] `node scripts/check-ravi-panel.mjs`, `node scripts/check-ravi-state.mjs`, `node scripts/check-ravi-agent.mjs`, `node scripts/check-ravi-companion.mjs`.
- [ ] 기존 `scripts/check-*.mjs` 및 `scripts/*.test.mjs` 회귀 검사. `check-desktop-mutation.mjs`는 의도적 실패를 기대하므로 다른 빌드와 분리해서 실행.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` 및 `cargo test --manifest-path qa/restore-safety/Cargo.toml -- --test-threads=1`.
- [ ] 기존 release workflow의 백업 보존·복구 제외·설치 프로그램 ID·release manifest 검사.

실제 지갑이나 메인넷 앱을 실행하지 않고 합성 fixture만 사용한다. Chrome/루프백 바인딩이 차단된 환경의 미실행·실패를 통과로 기록하지 않는다. 이번 실행 결과와 전수 조사: [firstrun-report.md](firstrun-report.md).
