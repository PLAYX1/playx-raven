# 라비 음성 입력 수리 보고서

상태: 구현·모의 검증·bundle 전달. **전체 통과 또는 모든 OS 동작 확인으로 판정하지 않는다.** Linux WebKitGTK 권한 처리와 샌드박스에서 차단된 통합 검사가 남아 있다. 실제 AI 호출·마이크 녹음·송금·서명·공증은 수행하지 않았다.

## 기준과 변경

- 작업 기준 HEAD: `9318879` (`Handle locked keychains with explicit device-encrypted API key fallback`). 요청 설명은 0.8.1이지만 실제 package.json·Cargo.toml·tauri.conf.json은 0.8.0이었다. 버전·앱 식별자·서명 비밀은 변경하지 않았다.
- `bundle.macOS.entitlements`와 `infoPlist` 연결. 권한은 `com.apple.security.device.audio-input=true` **한 개뿐**이며 JIT 등은 추가하지 않았다. 한국어 기본 설명과 ko/en/ja/zh `InfoPlist.strings`를 앱 Resources에 배치한다.
- 기존 release 워크플로의 Tauri build가 설정을 읽는다. 앱 및 updater에서 추출한 앱의 서명 권한과 두 usage description을 검산하도록 추가했다. 기존 Developer ID·hardened runtime·공증 검사는 유지했다.
- `ravi-dictation.ts` 상태 머신과 `ravi-microphone.ts` UI를 큰 창/작은 ravi-panel 및 별도 상주 창에서 공유한다. 상주 창은 일반 AI·지갑·키 조회 명령을 계속 거부하고 받아쓰기·동의·취소·정확한 마이크 설정 열기만 허용한다.
- MediaRecorder/getUserMedia, WebM/MP4/OGG 지원 형식 선택, 30초 제한, 음성이 나온 뒤 2.2초 무음 종료, 시작부터 5초 무음이면 전송 없이 안내, 4 MiB 상한, 실시간 파형과 경과 표시를 구현했다. Web Audio는 클릭 시 준비해 권한/IPC 대기 이후의 사용자 활성화 소실을 피한다.
- 동의는 회사별 한 번 저장하며 모든 회사의 동의를 설정에서 철회할 수 있다. 취소·철회·창 숨김·승인 화면·회사/언어 변경·사용자의 직접 입력에서 진행 중 작업 또는 늦은 결과를 폐기한다. 다른 창의 녹음도 BroadcastChannel로 중단한다.
- Web Speech는 `processLocally`를 명시적으로 제공하는 환경에서만 보조로 사용한다. 실패·무응답은 MediaRecorder로 폴백한다. 선택한 회사와 다른 서비스로 음성이 나갈 수 있는 기존 원격 Web Speech는 제품 경로에서 사용하지 않는다. 기존 TTS 어댑터는 유지하고 녹음/재생 충돌을 막았다.
- 권한 거부, 권한 없음, 장치 없음, 장치 사용 중, 네트워크, 미지원 환경/회사, 키, 예산, 무음, 동의 저장 및 응답 오류를 4언어로 구분한다. 맥 설정 URL은 `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` **정확한 문자열**만 허용한다. 다른 항목·접미사·fragment는 거부한다.

## 데이터와 호출 경계

음성 캡처 때문에 프런트에는 녹음 중 Blob/배열이 일시적으로 존재한다. 저장소·파일·객체 URL·로그에 기록하지 않고 녹음 종료/취소 때 트랙·분석기·청크 참조를 해제한다. IPC 배열과 가변 바이트는 완료/실패 때 비운다. JS/Rust 메모리 관리 및 IPC 내부 복사본 전체의 보안 삭제까지 보장하는 구현은 아니다.

키는 Rust의 기존 저장소에서만 읽는다. Rust는 기존 `ai_endpoint::client()`의 리다이렉트 금지/타임아웃과 `ai_budget` Owner 예산을 재사용하고 **요청 전에** 사용량을 차감한다. 임의 서버 주소·다른 회사 자동 폴백·업로드 파일 API는 없다. 오류는 고정 코드만 반환하고 성공도 키를 가린 전사 문자열 하나만 반환한다. 응답 본문은 32 KiB, 전사 텍스트는 12,000바이트로 제한한다. 동의 철회/취소는 요청 future도 중단한다.

| 회사 | 요청 | 기본 모델 |
|---|---|---|
| OpenAI | `/v1/audio/transcriptions`, 메모리 multipart | `gpt-4o-transcribe` |
| Google | `generateContent`, inlineData, 음성 지시를 실행하지 않고 원어 전사만 요청 | `gemini-3.8-flash` |
| Groq | `/openai/v1/audio/transcriptions`, 메모리 multipart | `whisper-large-v3-turbo` |
| Anthropic/xAI/기타 | 네트워크·키 읽기·녹음 전에 미지원 안내 | 없음 |

MP4 녹음은 Google 요청에서 문서에 있는 M4A MIME으로 표시한다. 자동 모델 조회에 추가 비용/호출을 만들지 않고 문서상 기본값을 사용한다. 모델/키의 실제 계정 가용성은 미검증이다.

받아쓴 글은 입력칸만 채운다. 자동 제출/AI 채팅/결제/삭제/송금 명령 호출은 없다. 사용자가 글을 확인해 보내더라도 기존 위험 작업의 별도 직접 확인 규칙을 거친다. 단순히 음성으로 “승인”, “보내”, “삭제”라고 말해서 승인하는 경로는 없다.

## 플랫폼 한계와 보안 판단

- macOS: 선언과 UI는 구현·정적 검산 완료. 실제 설치 앱의 권한 창·녹음·서명 후 동작은 미검증이다. 설치된 Wry 0.55.1의 WKUIDelegate에는 media-capture 권한 처리기가 있다.
- Windows: 현재 배포는 MSI/NSIS Win32이며 맥 plist/entitlement에 해당하는 추가 선언은 없다. WebView2 및 Windows의 마이크 개인정보 설정은 여전히 필요하다. 실제 Windows 녹음은 미검증이다.
- **Linux: 공통 JS/Rust 경로는 있으나 이 작업으로 동작 완료라고 할 수 없다.** 현재 Wry 0.55.1 WebKitGTK 구현에는 `permission-request`의 UserMedia 처리기가 없고, WebKitGTK 기본 처리기는 미처리 요청을 거부한다. 배포판의 media/WebRTC 지원도 필요하다. Linux 설치 패키지 자체에 맥식 권한 선언은 없지만, 이것이 런타임 권한 처리가 불필요하다는 뜻은 아니다. 현재는 권한/미지원 오류가 표시된다. GTK 권한 처리용 직접 의존성 추가는 사용자가 허용한 새 의존성 범위 밖이므로 하지 않았다. 검증되지 않은 unsafe 네이티브 포인터 우회도 하지 않았다.
- 보안 판단: 샌드박스 정책을 우회해 Chrome/소켓을 실행하거나 위 금지 의존성을 추가하지 않았다. 따라서 모든 검사 통과라는 종료 조건은 충족하지 못했다. 이 제한을 숨기거나 실패 검사를 삭제하지 않았다.

## 모의 검증 결과

최종 결과 목록은 `checks-final.json`에 있다. 이 파일의 `exit=1`인 mutation 검사는 의도적으로 실패해야 하는 검사이며 별도로 표시했다.

| 검사 | 결과 |
|---|---|
| `npm run build` (preflight + tsc + Vite) | 통과. 기존 큰 청크 경고만 있음 |
| `node scripts/check-ravi-voice.mjs` | 통과. 실제 TS 상태 머신 및 UI 어댑터에 가짜 장치·시계·RPC 주입 |
| `scripts/check-*.mjs` 43개 전부 실행 | 28개 통과, 1개 예상 mutation 실패 검출, 14개 환경 차단 |
| `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml` | 홈 fixture 쓰기가 EPERM으로 차단됨 |
| `/tmp/rv-voice-test-fixture`로 전체 재실행 | **755 통과, 7 실패(전부 소켓 bind EPERM), 13 기존 ignored** |
| 같은 `/tmp` 시험에서 아래 7개만 명시적 `--skip` | **755 통과, 0 실패, 13 ignored, 7 filtered**. doc-test 1개 기존 ignored |
| plist/4언어 strings `plutil -lint` | 6개 파일 모두 통과 |
| `git diff --check` | 통과 |

신규 Rust 시험 4개는 소켓을 쓰지 않는 Axum 모의 서버로 실제 reqwest multipart/JSON body·인증 header·회사별 모델/형식·키 비노출·전사 텍스트만 반환·동의 지속/철회·형식/크기/길이 제한을 검증한다. 실제 키 저장소나 외부 AI에 접근하지 않는다.

신규 JS 시험은 동의 전 장치 접근 없음, 동의 1회/철회, 권한 분류, 30초/무음 종료, 트랙 종료, 늦은 permission/전사 응답 폐기, 회사 변경, 로컬 Web Speech 실패 폴백, 4언어 문구, 파형 상태, 수동 입력 시 취소, 입력칸만 채움과 승인/전송 API 부재를 검증한다. 네이티브 브라우저/OS 실측을 대체하지는 않는다.

소켓 차단 7개:

- `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response`
- `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`
- `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`
- `relay::tests::live_push_and_pairing_rooms_stay_off_disk`
- `server::bind_probe::binding_the_phone_port_is_fast`
- `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`
- `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`

JS 차단 14개는 루프백 포트 권한 9개와 Chrome 프로세스 실행 5개다. 기존 브라우저 프로필과의 충돌은 새 fixture 경로로 재시도했으며 그 이후의 차단 사유를 기록했다. 기존 음성 브라우저 검사는 새 동의/로컬 인식 경로를 모의하도록 갱신했지만 여기서 실제 실행 완료하지 못했다. mutation 검사가 소스를 잠시 바꾸는 동안 겹친 중간 Rust 실패는 소스 원복을 확인하고 mutation 종료 후 전체/가능 시험을 순차 재실행하여 해소했다.

## 대표가 확인할 절차

1. 새로 서명·공증한 맥 앱을 설치하고 처음 실행한다. 기존 앱과 번들 ID가 같으면 기존 권한 결정이 남을 수 있으므로 허용/거부 이력을 확인한다.
2. OpenAI·Google·Groq 중 사용할 회사를 선택한다. 마이크 단추를 누르면 즉시 준비 상태와 첫 동의 카드가 나타나는지 확인한다.
3. 동의 후 **맥 마이크 권한 허용 창 → 허용 → 말하기 → 마이크를 다시 누르거나 잠시 침묵 → 입력창에 글이 채워짐**을 확인한다. 권한 창에서 포커스가 이동해도 흐름이 끊기지 않아야 한다.
4. 글이 자동으로 전송되지 않았는지 확인하고 직접 보낸다. 음성으로 송금·결제·삭제 승인을 말해도 실제 승인이 되지 않아야 한다.
5. 거부한 경우 구분된 안내 및 “시스템 설정 > 개인정보 보호 및 보안 > 마이크” 단추를 확인한다. 장치 없음·네트워크 끊김·미지원 회사도 확인한다.
6. 30초 종료, 무음 종료, 파형/초 표시, 받는 중 취소, TTS 중 마이크, 숨김/승인 화면에서 중단을 확인한다.
7. 상주 창·작은 패널·큰 패널에서 같은 방식으로 확인한다. 설정에서 동의를 철회한 뒤 다음 사용에서 다시 묻고, 진행 중 결과가 뒤늦게 입력되지 않는지 확인한다.
8. en/ja/zh 앱 언어와 OS 권한 설명, 배포 앱 및 updater 앱의 두 usage description/audio-input entitlement를 확인한다. Windows 실제 장치 및 Linux 권한 처리 해결 후 해당 플랫폼을 별도로 검증한다.

## 의존성과 근거

새 npm/Rust/플러그인 의존성 없음. lockfile 변경 없음. 기존 reqwest·serde_json(MIT/Apache-2.0), tokio(MIT), Tauri/Wry(MIT/Apache-2.0), 브라우저 MediaRecorder/Web Audio, 기존 base64 도우미를 재사용했다. RustCrypto도 새로 추가하지 않았다. 참고 문서의 코드를 복사해 의존성으로 넣지 않았다.

- [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Gemini audio formats and models](https://ai.google.dev/gemini-api/docs/audio)
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- [Tauri macOS configuration](https://v2.tauri.app/reference/config/#macosconfig)
- [WebView2 permission events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs)
- [WebKitGTK permission-request/default deny](https://www.webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.permission-request.html)

## 전달

`artifacts/voice.bundle`, ref `refs/heads/claude/voice`. 임시 `GIT_INDEX_FILE`과 `commit-tree`로 작업 파일만 커밋한다. 기본 인덱스와 현재 HEAD는 이동하지 않으며 push·태그는 만들지 않는다. 기존 작업 산출물의 변경/재생성 파일은 커밋에서 제외한다. bundle 검증 및 커밋/해시는 별도 `DELIVERY.json`에 기록한다.
