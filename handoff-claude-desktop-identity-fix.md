# RavenVault Desktop — Fable 검증 지적 수리 (2026-09-14 오후)

**이건 무인 실행이다. 계획만 세우고 끝내면 완전 실패다. 실제로 고치고, 검사를 돌리고, 커밋하라.** 모델은 반드시 `gpt-6-astra`, 보고 첫 줄에 실제 모델.

- 작업 폴더 `~/wt-ravenvault-desktop-ux` (브랜치 `claude/ravenvault-desktop-ux`, HEAD `daa80d6` = 네가 앞서 한 이름·언어·한눈에 작업 위). 이전 작업서 `handoff-claude-desktop-identity.md` 의 금지·불변 규칙이 그대로 유효하다(식별자·자료 폴더·업데이터·설치 GUID 불변, 다른 워크트리 쓰기 금지, push·태그·릴리스·버전 올리기 금지, 설치된 앱·8790 쓰기 금지, sendrawtransaction/issue 금지, .env·지갑·12단어 읽기 금지).
- 독립 검증 결과(Fable): `artifacts/fable-verify-identity/` (`verify-screens.json`, 스크린샷). 하네스 참고: `/private/tmp/claude-501/-Users-gimmusong-playx/00caeab9-4f09-4b33-b84c-35286a1adde4/scratchpad/verify-screens.mjs`.

## 🔴 F1. 한국어(및 모든 언어) 화면에서 **남의 글·사용자 입력이 번역돼 버린다** — 최우선
- 원인(검증자 분석): `src/i18n.ts:93-104,108` — 0.4.2 까지 `translateDom` 은 ko 면 바로 return 했는데, 새 코드는 ko 에서도 돌며 사전의 **번역값→한국어 원문 역방향 표(`canonical`)** 를 처음 보는 텍스트 노드에도 적용한다.
- 재현: 한국어 모드에서 `#page-ravi` 안에 `<div>More</div><div>Photo</div><div>Invite</div><div>Chat</div><div>Message</div><div>ファンクラブ</div><div>写真</div><div>My node</div>` 를 넣고 400ms → `더 보기/사진/초대하기/이야기/내용/팬클럽/사진/내 노드` 로 바뀐다. en 모드에서도 일본어·중국어 사용자 글이 영어로 바뀐다. 이야기(Nostr 글), 메뉴판·가게 이름, 자산 이름 등 사용자가 쓴 모든 곳이 노출된다.
- 원칙: **사람이 쓴 것은 절대 옮기지 않는다.** 앱이 넣은 문구만 번역한다.
- 방향(최종 판단은 네가): 원문 복원은 우리가 번역한 적 있는 노드(`originals` WeakMap 에 기록된 노드)에만. 처음 보는 노드에는 역방향 조회 금지. JS 가 `t()` 로 그린 문구는 언어 바뀜 이벤트에서 다시 그리게 해 즉시 전환을 유지. 역방향 표 충돌 31건(`Cancel ⇐ 그만두기|취소` 등)도 이 수정으로 사라져야 한다.
- 🔴 회귀 검사를 `scripts/check-desktop-languages.mjs` 에 **추가**: 네 언어 각각에서 위 외국어/한국어 탐침 노드가 그대로 남는지(0.4.2 방식의 사용자 입력 영역 — 이야기 글 목록, 가게 이름, 메뉴 이름, 자산 이름 — 에 실제로 넣어 보기). 고치기 전 빨강(바뀐 탐침 수) → 뒤 초록(0). 기존 "한글 잔존 0"·"224회 전환" 검사도 계속 통과.

## 🟡 F2. 작은 수리들 (전부)
1. 지갑 화면 "확인 대기 중 9,999 RVN" 줄이 en 에서 한국어로 남는다(검사에서 `wallet_balance` 가 null 이라 안 그려졌음) → 번역 + 언어 검사 합성 응답에 미확정 잔액이 있는 경우 추가.
2. `index.html:1885` 근처 마지막 `:root` 가 라이트 토큰만 덮어써 **다크 OS** 에서 `--faint:#8794b3`, `--ravi-tint:#2a1f18` 가 흰 바탕에 남는다 → 다크 선호에서도 대비가 맞게(웹앱처럼 흰 바탕 고정이면 모든 토큰을 명시). 다크 에뮬레이션 스크린샷 1장.
3. **브랜드가 두 번**: 머리줄에 「RavenVault Desktop」+라비가 있는데 사이드바 위에도 큰 라비+이름이 또 있다 → 사이드바의 큰 이름/그림은 빼고 버전·새 버전 확인 알약만 남긴다(172px 넘침 없이).
4. **설정 단추 아이콘이 해(☀) 모양** → 웹앱(`~/wt-ravenvault-web-ux/phone/ui/icons.tsx` 의 설정 아이콘, 조절 막대)과 같은 뜻의 SVG 로.
5. **「폰에서 서명한 거래 보내기」가 한눈에 띠와 라비 타일 두 곳** → 타일 쪽을 뺀다(한눈에 띠가 입구). 가게가 없으면 타일 첫 칸 「가게 만들기」 유지.
6. **주황 채움 단추가 한 화면에 둘**(한눈에 「받기」, 타일 「가게 만들기」) → 한 화면의 주 행동은 하나. 「받기」와 「폰 거래 보내기」는 같은 무게의 테두리 단추로, 가게 만들기 lead 는 유지 — 또는 더 나은 배치를 판단하되 이유를 보고.
7. 손님 폰 페이지(`web/wallet.html`, `buy.html`, `customer.html`, `shops.html`)에 새로 생긴 49px 「RavenVault Desktop」 띠가 손님 화면을 붐비게 한다(`web-shops-390.png`) → 손님 페이지는 **제목(title)만** RavenVault 로 두고 띠는 빼거나 한 줄 작은 글자로. 390px 스크린샷.
8. 켤 때 `wallet_balance` 8회·`node_status` 7회 호출 → 첫 그리기에서 중복 호출을 합쳐 각 1~2회로(유휴 주기는 그대로). 전후 호출 수 계측.

## 검사
작업서 `handoff-claude-desktop-identity.md` 의 검사 목록 전부 + F1 새 회귀 검사. tsc 는 출력도 확인. 스크린샷(ko/en × 1120×780·1440×900 라비 홈, 설정 메뉴 열린 상태, 다크 1장, 손님 shops 390px)은 `artifacts/claude-desktop-identity-fix/`.

## 보고 (한국어, `artifacts/claude-desktop-identity-fix/REPORT.md`)
실제 모델 / F1 빨강→초록 수치 / F2 1~8 각각 파일·근거 / 검사 명령·결과 / 확인 못 한 것 / 로컬 커밋 해시
