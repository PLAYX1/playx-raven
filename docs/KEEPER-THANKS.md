# 지킴이 고마움 (RavenVault, 11-08 설계 — 데스크탑·폰·웹·서버 공통 규약)

배경(대표): 레이븐코인은 지금 채굴해도 돈이 안 된다. 노드·릴레이를 돌리는 분들은 **희생**으로 돌린다.
→ 돈 보상(우리가 RVN 지급)은 하지 않는다(법·가짜 참여·다단계 모양 위험). 대신 **희생이 보이게** 한다.
문구 원칙: 「보상·수익·이자·벌기」 금지. 「섬김·고마움·내어 주심」의 말. 예: 「이 분이 모두를 위해 컴퓨터를 내어 주고 계세요」.
시세·투자 이야기 금지. 「최초」 주장 금지.

## 1. 릴레이 지킴이 표시 (badge `relay`)
- 정의: NIP-58 kind 30009, d=`rv-relay-keeper`, 서명 = 노드 지킴이와 **같은 확인 서버 열쇠** NODE_KEEPER_PUB(7f57c4…9b72).
  이름 `Relay Keeper`, 설명 영어(+「(릴레이 지킴이 · RavenVault)」), image/thumb = https://ravenvault.ex.erci.se/landing/assets/badges/relay-keeper-1024.png / -256.png (그림은 대표 세션이 만든다).
- 수여: kind 8, tags `["a","30009:<NODE_KEEPER_PUB>:rv-relay-keeper"]`, `["p",<사람 pubkey>]`, `["t","ravencoin"]`, `["day","YYYY-MM-DD"]`(created_at 의 UTC 날짜). 셈: 노드 지킴이와 똑같이 최근 30일 서로 다른 날 ≥ 25 → 표시.
- 확인 요청: 데스크탑이 「릴레이 나누기」를 켜고 내 주소를 알린 상태에서 하루 한 번
  `POST https://ravenvault.ex.erci.se/api/relay-check` body `{pubkey, relay, event}`.
  event = kind 27235, content `rv-relay-check`, tags `["relay",<wss 주소>]`,`["t","ravencoin"]`, 이야기 열쇠 서명, created_at ±120초.
- 서버 확인(🔴 SSRF 조심):
  1) URL 은 RELAY-SHARE.md §2 검사 통과(wss·DNS 이름·443·사설 이름 금지 등) + **DNS 를 풀어 모든 주소가 공개 IP 일 때만** 접속(사설·루프백·링크로컬·CGNAT·0.0.0.0·IPv6 사설 금지), 리다이렉트 안 따라감, 전체 8초 제한, 받는 크기 제한(64KB).
  2) 그 릴레이에 `REQ {kinds:[10002], authors:[pubkey], limit:1}` → 돌아온 이벤트가 그 pubkey 서명이 맞고 `r` 표에 그 relay 주소(정규화 비교)가 있고 `["t","ravenvault-relay"]` 가 있어야 OK.
  3) OK 면 그날 수여(kind 8)를 서명해 기본 릴레이들(N100+primal+nos.lol+damus)에 올리고 응답에 담는다. 같은 pubkey 같은 날 두 번이면 다시 서명하지 않고 ok.
  - 응답 `{ok, reason?, day, award?}` reason ∈ `bad-url|unreachable|no-list|mismatch|auth|not-configured|unavailable`.
  - 같은 IP·pubkey 요청 제한(분당 몇 번) — node-check 와 같은 방식 재사용.
- 우리 릴레이(relay.rs)는 확인 서버 열쇠의 `rv-relay-keeper` 정의·수여도 받는다(지금은 rv-node-keeper 만).
- 표시 방 gate 값에 `relay` 추가(누구나·채굴 기여·창작자·노드 지킴이·릴레이 지킴이).

## 2. 증서 나누기 (SNS 증서 카드)
- 공개 주소: `https://ravenvault.ex.erci.se/b/<npub>` — 그 사람의 표시들을 **그때그때 확인해** 보여 주는 쪽 + OG 그림(`/b/<npub>/card.png`, 1200×630).
  - 표시 계산은 앱과 같은 규칙(채굴 기여·창작자=이름표에 서명으로 걸린 주소의 체인 기록 → 게이트웨이 badges, 노드·릴레이 지킴이=확인 서버 수여 kind 8 날짜 수). 이름·사진은 그 사람 kind 0.
  - 카드 문구 예: 「○○님은 레이븐코인 노드를 지난 30일 중 28일 지켜 주셨어요」 / 「모두를 위해 컴퓨터를 내어 주고 계세요」. 아래 작은 글: 「표시는 체인 기록과 확인 서버 기록으로 누구나 확인할 수 있어요. 신원 확인이 아니에요.」
  - 표시가 없으면 카드는 「아직 확인된 표시가 없어요」(지어내지 않는다).
  - 캐시 짧게(5분). 기존 share 렌더러(release-site share.mjs·satori·Pretendard)를 재사용.
- 앱: 내 소개(내 표시 칸)에 「증서 나누기」 단추 → 폰은 공유 시트(링크), 웹·데스크탑은 링크 복사 + 「피드에 올리기」(글 초안에 링크를 넣어 열기 — 보내기는 내가 누름).

## 3. 응원 보내기 (사람끼리 RVN 선물)
- 사람 카드(이름 누르면 나오는 칸)에, 그 사람 이름표에 **서명으로 확인된 RVN 주소가 있을 때만** 「응원 보내기」.
- 누르면 기존 보내기 화면을 **받는 주소 채운 채** 연다. 금액 빠른 칸: 1 · 5 · 10 RVN(직접 입력 가능). 확인 단계·수수료 안내는 기존 보내기 그대로. **우리 수수료 없음**(사람끼리).
- 문구: 「고마운 마음을 RVN 으로 조금 전해요. 우리가 가져가는 몫은 없어요.」 받는 분 주소가 맞는지 끝 4글자를 크게 보여 준다.
- 보낸 뒤 선택: 「응원했다고 알리기」(그 사람에게 쪽지 초안 — 금액은 넣지 않음, 보내기는 내가 누름). 자동 공개 글 없음(누가 얼마 보냈는지 공개 안 함).
- 지갑이 잠겨 있으면 기존처럼 먼저 열게 한다. 지갑 정보는 AI·서버로 보내지 않는다.
