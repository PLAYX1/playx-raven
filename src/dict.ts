/* 네 나라 말 사전 — 열쇠는 **한국어 원문 그대로**다.
 *
 * 왜 이렇게 하는지는 `i18n.ts` 맨 위에 적어 뒀다. 한 줄로 줄이면:
 * 이름표(`send_button` 같은 것)를 달면 반드시 빠뜨리고, 빠뜨린 자리만
 * 한국어로 남는다. 원문을 열쇠로 쓰면 **없을 때 한국어가 그대로 나온다.**
 *
 * ## 어떻게 모았나
 *
 * 처음엔 `main.ts` 에서 한국어가 든 문자열을 기계로 뽑았다. 645개가 나왔는데
 * 대부분 **코드 조각**이었다 — `>보존 중</span>` 이나
 * `자산 ${n}개 · 파일 있음 ${m}개` 처럼. 이런 것은 화면의 글자와 안 맞아
 * 옮겨 봐야 아무 데도 안 쓰인다.
 *
 * 그래서 **화면을 실제로 띄워 놓고 걷었다.** 483개였고, 그중 화면 파일에서
 * 이미 옮긴 것을 빼니 38개만 남았다. 645개가 아니었다.
 *
 * ⚠️ 다만 걷기에는 구멍이 있다 — **걷을 때 화면에 없던 것은 못 걷는다.**
 *    상태 문구(「보내는 중…」)·확인창(「되돌릴까요?」)·오류(「지갑을 열지
 *    못했습니다」)는 그 순간에만 뜬다. 실제로 장터에서 그 일이 났다 —
 *    빈 화면 문구 다섯 개가 배포 뒤에야 한국어로 드러났다.
 *    그래서 코드에서 **값이 안 섞인 깨끗한 문장**을 따로 골라 128개를 더했다.
 *    사장이 제일 불안한 순간에 보는 말이라 오히려 더 중요하다.
 *
 * ⚠️ 사장이 직접 적은 것(가게 이름·메뉴·자산 이름)은 여기 넣지 않는다.
 *    「제육볶음」을 우리가 옮기면 손님이 카운터에서 그 말을 하고
 *    아무도 못 알아듣는다. 사전에 없으면 그대로 나오므로 저절로 지켜진다.
 *
 * ⚠️ 값이 섞인 문장(`자산 3개 · …`)은 이 방식으로 못 옮긴다. 옮기려면
 *    코드를 고쳐야 하고, 그건 숫자를 잘못 끼울 위험을 만든다. 지금은
 *    한국어로 남겨 둔다 — 조용히 틀린 숫자보다 낫다.
 *
 * 🔴 열쇠는 **공백을 고르게 편 한 줄**이어야 한다. 원본 HTML 에서 줄바꿈으로
 *    쪼개진 문장도 찾을 때 한 줄로 펴서 비교하기 때문이다.
 */
export const DICT: Record<string, Record<string, string>> = {
  ko: {},
  en: {
    "(문자·영수증·카운터 화면)을 보시고, 그":
      "(a message, a receipt, the counter screen) and type its",
    "). 이름·기간·정지는":
      "). The name, period and suspension stay",
    ", 받으신 금액에서 나뉩니다.":
      "; it is split out of what you received.",
    ", 키 없음.":
      ", no key needed.",
    "1 (고유)":
      "1 (unique)",
    "1. 명단을 굳힐 때를 정합니다":
      "1. Decide when to freeze the holder list",
    "10분 뒤":
      "in 10 minutes",
    "127.0.0.1:8766 · 쿠키 인증":
      "127.0.0.1:8766 · cookie auth",
    "1개월":
      "1 month",
    "1년":
      "1 year",
    "1세대":
      "Gen 1",
    "1시간 뒤":
      "in 1 hour",
    "2. 예약해 둔 것":
      "2. What you have booked",
    "20초 안에 열리지 않았습니다.":
      "It did not open within 20 seconds.",
    "2세대":
      "Gen 2",
    "3. 나눠 주기":
      "3. Distribute",
    "30일":
      "30 days",
    "3개월":
      "3 months",
    "5 RVN · 약 17원":
      "5 RVN · about ₩17",
    "6개월":
      "6 months",
    "6시간 뒤":
      "in 6 hours",
    "7일":
      "7 days",
    "9월 20일 하루 쉽니다":
      "Closed for the day on 20 September",
    "AI 도우미":
      "AI helper",
    "AI 열쇠":
      "AI key",
    "AI로 채우기":
      "Fill in with AI",
    "GPU를 몇 %로 쓸까요":
      "What % of the GPU shall we use",
    "IPFS 게이트웨이":
      "IPFS gateway",
    "Ollama는":
      "Ollama runs",
    "PLAY X Raven 백업":
      "PLAY X Raven backup",
    "PLAYX 수수료":
      "PLAYX fee",
    "RVN 또는 자산 이름":
      "RVN or an asset name",
    "RVN 보내기":
      "Send RVN",
    "Ravi에게 물어보기":
      "Ask Ravi",
    "USB 는 잃어버리고, 빌려주고, 꽂아 둔 채로 자리를 비웁니다 — 주운 사람이 가게 돈을 가져갑니다.":
      "USB sticks get lost, lent out, and left plugged in while you step away — whoever picks it up takes the shop's money.",
    "USB 백업도 잠그기":
      "Lock USB backups too",
    "playx-도매-2026":
      "playx-wholesale-2026",
    "— 돈이 들지 않습니다":
      "— it costs nothing",
    "— 이 프로그램이 꺼져 있어도 그렇습니다.":
      "— even if this program is off.",
    "— 화면을 보고 적으시면 이 확인이 아무 소용이 없기 때문입니다.":
      "— if you copy them off this screen, the check means nothing.",
    "← 가게":
      "← Shop",
    "「먼저 계산해 보기」로 몇 명에게 얼마가 가는지 확인한 뒤에만 보내기가 열립니다.":
      "Sending unlocks only after you use \"Calculate first\" to see how many people get how much.",
    "中文 (선택)":
      "Chinese (optional)",
    "日本語 (선택)":
      "Japanese (optional)",
    "가 생깁니다. 안 넣어도 가게는 보입니다.":
      ". Without them the shop still shows.",
    "가 이 프로그램을 만드는 곳으로 갑니다. 나머지 99%는 사장님 지갑으로 바로 들어옵니다.":
      "goes to whoever builds this program. The other 99% arrives straight in your wallet.",
    "가 캐고 수익만 이 지갑으로 옵니다.":
      "does the mining and only the earnings come to this wallet.",
    "가게":
      "Shop",
    "가게 결제 · 벤딩머신 · 중고 물건 사기":
      "Shop payments · vending machine · buying second-hand items",
    "가게 등록":
      "Register the shop",
    "가게 만들기":
      "Create a shop",
    "가게 소개":
      "Shop introduction",
    "가게 이름 (손님이 읽는 이름)":
      "Shop name (what customers read)",
    "가게 이름이 비어 있습니다":
      "The shop name is empty",
    "가게 정보":
      "Shop details",
    "가게 정보 · 처음 한 번":
      "Shop details · one time only",
    "가게·브랜드 (루트)":
      "Shop / brand (root)",
    "가게가 받은 총액입니다. 부가세 구분과 과세 여부는 사업자 유형에 따라 달라서 여기서 계산하지 않습니다 — 세무 담당자에게 이 파일을 그대로 주시면 됩니다.":
      "This is the total the shop received. VAT treatment depends on your business type, so we do not calculate it here — just hand this file to your accountant as it is.",
    "가게부터 만들까요?":
      "Shall we create your shop first?",
    "가게에만 씁니다":
      "Only for the shop",
    "가격":
      "Price",
    "가격 단위":
      "Currency",
    "가끔 씁니다. 잘하는 곳이 위로 오는 게 유리합니다.":
      "Used occasionally. It pays to put a capable provider on top.",
    "가는 자리":
      "Where it goes",
    "가볍게 시작합니다":
      "Start light",
    "가짜 체인":
      "a practice chain",
    "간판 사진":
      "Storefront photo",
    "강남 로스터리":
      "Gangnam Roastery",
    "강남지점 · 2층 계산대":
      "Gangnam branch · 2nd floor till",
    "같은 와이파이 주문은 됩니다. 다만 가게 목록에는 안 뜹니다.":
      "Ordering on the same wifi still works. It just will not appear in the shop list.",
    "같이 보내는 것":
      "What is sent with it",
    "개를 지키는 중":
      "files kept",
    "개발비 1%":
      "1% development fee",
    "거리와 길찾기":
      "distance and directions",
    "거절된 것":
      "doors that were refused",
    "건의 오류":
      " errors",
    "검토":
      "Review",
    "검표 태블릿":
      "Door tablet",
    "결제가 아닙니다.":
      "not a payment yet.",
    "계산대 컴퓨터로는":
      "On a till computer,",
    "계산대·주문만 돌리는 컴퓨터입니다. 장부를 전부 갖고 있어 가장 빠릅니다.":
      "A computer that only runs the till and orders. It keeps the whole ledger, so it is fastest.",
    "계산대에 남길 돈(RVN)":
      "Amount to leave at the till (RVN)",
    "계산대에 하루치가 쌓입니다. 정해 둔 금액을 넘으면 남는 돈이 자동으로":
      "A day's takings pile up at the till. Above the amount you set, the surplus automatically goes to",
    "고급 — 채굴 · AI 키 · 세부 설정":
      "Advanced — mining · AI keys · detailed settings",
    "고유 여러 개":
      "Several uniques",
    "고유 자산":
      "Unique asset",
    "고유 자산은 하나뿐입니다. 수량은":
      "A unique asset is one of a kind. The quantity is fixed at",
    "고치기":
      "Edit",
    "고치러 가기":
      "Go fix it",
    "공지":
      "Notices",
    "공지 보내기":
      "Send a notice",
    "구글·애플 지도에서 가게를 길게 눌러 좌표를 복사한 뒤 여기 붙이세요. 넣으면 손님 화면에":
      "Long-press your shop in Google or Apple Maps, copy the coordinates and paste them here. With them, the customer screen gains",
    "굳은 명단":
      "The frozen list",
    "그건 종이(복구 카드)나 비밀번호 금고에 두세요.":
      "Keep those on paper (the recovery card) or in a password vault.",
    "그냥 묻기":
      "Just ask",
    "그동안 이 컴퓨터의 다른 프로그램도 지갑을 쓸 수 있습니다. 가게용 지갑은":
      "During that time other programs on this computer can also use the wallet. Keep your shop wallet holding",
    "그래도 소량이나마 레이븐에 기여하고 싶을 때 켜세요. 채굴기는 우리가 넣어 두지 않았습니다 — 백신이 채굴기를 악성코드로 잡는 일이 흔해서, 넣으면 앱 전체가 격리됩니다. 아래에서 받아":
      "Turn it on if you still want to contribute a little to Ravencoin. We do not ship a miner — antivirus commonly flags miners as malware, and bundling one would quarantine the whole app. Download it below and put it in your",
    "그래도 전부 보관하기":
      "Keep everything anyway",
    "그만두기":
      "Cancel",
    "금고 주소 (이 컴퓨터가 아닌 지갑)":
      "Vault address (a wallet other than this computer)",
    "금고 주소는 켤 때 고정됩니다.":
      "The vault address is fixed at the moment you turn this on.",
    "금액":
      "Amount",
    "기간":
      "Period",
    "기간권 (한달·정기)":
      "Period pass (monthly, recurring)",
    "기본값으로":
      "Back to defaults",
    "기본값으로 되돌렸습니다.":
      "Restored to defaults.",
    "기본으로":
      "To defaults",
    "꺼 둡니다":
      "Leave it off",
    "꺼두면 수량과 설정을":
      "Leave it off and the quantity and settings can",
    "꺼짐":
      "Off",
    "끄기":
      "Turn off",
    "끄려면 체인을 처음부터 다시 받아야 합니다(몇 시간).":
      "Turning it back off means downloading the chain from scratch (several hours).",
    "끄면 바깥 주소로는 손님 화면만 열립니다. 켜면 사장·직원 화면도 열립니다.":
      "Off: the outside address opens only the customer screen. On: the owner and staff screens open too.",
    "끄시면 열쇠 없이 바로 쓸 수 있지만, 그 USB 하나가 곧 지갑입니다.":
      "Turn it off and it works without a key, but that one USB stick is the wallet itself.",
    "끊습니다":
      "Disconnect",
    "끝 네 글자":
      "last four characters",
    "끝 네 글자를 일부러 가려 두었습니다":
      "We deliberately hid the last four characters",
    "끝나는 날":
      "End date",
    "나머지는 전부 127.0.0.1 안에서 돕니다. 입력한 문장만 가고, 지갑·개인키·자산 목록은 보내지 않습니다.":
      "Everything else runs inside 127.0.0.1. Only the sentence you type goes out; the wallet, private keys and asset list do not.",
    "나에게는 안 보내기":
      "Do not send to me",
    "나중에 더 발행할 수 있게 (재발행 가능)":
      "Allow issuing more later (reissuable)",
    "남은 블록":
      "Blocks left",
    "남이 이 컴퓨터를 만져도 목적지를 바꿀 수 없고, 사장님 지갑으로 보내는 것만 할 수 있습니다. 주소를 바꾸려면 지갑 암호가 필요합니다.":
      "Even if someone else touches this computer they cannot change the destination; they can only send to your wallet. Changing the address requires the wallet passphrase.",
    "내 가게":
      "My shop",
    "내 주소 채우기":
      "Fill in my address",
    "내가 만든 것":
      "Created by me",
    "내가 만든 자산의 파일입니다":
      "This file belongs to an asset you created",
    "내놓은 자산":
      "Assets put up for sale",
    "내용":
      "Message",
    "내일 이맘때":
      "this time tomorrow",
    "넘어가는 순서 바꾸기":
      "Change the fallback order",
    "노드":
      "Node",
    "노드 RPC":
      "Node RPC",
    "노드 꺼짐":
      "Node is off",
    "노드 따라잡는 중":
      "Node is catching up",
    "노드 켜짐":
      "Node is on",
    "노드·사진 창고·지갑·계산대를 한 프로그램에서 씁니다.":
      "Node, file store, wallet and till — all in one program.",
    "노드가 꺼져 있어요":
      "The node is off",
    "노드가 꺼져 있어요.":
      "The node is off.",
    "노드가 바로 꺼집니다.":
      "the node shuts down immediately.",
    "노드가 켜져 있는지 보시고, 잠시 뒤에 다시 눌러 주세요.":
      "Check that the node is running, then press again in a moment.",
    "노드끼리 대화":
      "Node-to-node chat",
    "노드만 켭니다. 앱까지 저절로 켜지면 아무도 없는 방에서 지갑이 열립니다.":
      "Only the node starts. If the app started by itself too, a wallet would open in an empty room.",
    "누구에게":
      "To whom",
    "눌러서 보기":
      "Press to see",
    "다 됐습니다":
      "All done",
    "다른 일도 합니다":
      "I use it for other things too",
    "다른 지갑":
      "a different wallet",
    "다른 폴더 고르기…":
      "Choose another folder…",
    "다른 회사 · 내 컴퓨터의 AI":
      "Other providers · AI on my own computer",
    "다시 감추기":
      "Hide again",
    "다시 열기":
      "Open again",
    "다시 열었습니다.":
      "Opened again.",
    "다시 엽니다":
      "Reopening",
    "다시 읽어오기":
      "Read it again",
    "다시 켤 때까지 가게가 멈춥니다. 영업 중에는 누르지 마세요.":
      "The shop stops until you start it again. Do not press this while open for business.",
    "다시 확인":
      "Check again",
    "다운로드 폴더":
      "Downloads folder",
    "다음":
      "Next",
    "단말기 임대료도 정산 대기도 없습니다.":
      "no terminal rental and no waiting for settlement.",
    "단어를 꺼내는 동안 이 컴퓨터에 임시 파일이 잠깐 생겼다가 지워집니다. SSD에서는 지운 흔적이 완전히 사라지지 않을 수 있습니다.":
      "While the words are extracted, a temporary file briefly appears on this computer and is then deleted. On an SSD, traces of a deleted file may not disappear completely.",
    "단위":
      "Unit",
    "단추가 여덟 개까지입니다. 하나 지우고 다시 말씀해 주세요.":
      "Up to eight buttons. Please delete one and tell me again.",
    "닫기":
      "Close",
    "닫기 (Esc)":
      "Close (Esc)",
    "달러 ($)":
      "USD ($)",
    "담아 따로 두십시오.":
      "and keep it separate.",
    "답에 따라 이 프로그램이 컴퓨터를 얼마나 쓸지 정해집니다. 나머지는 알아서 맞춥니다.":
      "Your answer decides how much of the computer this program uses. We handle the rest.",
    "대신":
      "In exchange,",
    "대화방 이름 (상대와 미리 정한 것)":
      "Room name (agreed with the other side in advance)",
    "더 찍기":
      "Mint more",
    "덮어씁니다":
      "Overwrite",
    "돈 받을 주소":
      "Address that receives the money",
    "돈·발행·설정 전부":
      "Money, issuing, all settings",
    "돕니다.":
      "working as it is.",
    "되돌리는 중…":
      "Restoring…",
    "되돌릴 백업을 고르세요":
      "Choose a backup to restore",
    "되돌릴까요?":
      "Restore it?",
    "되돌립니다":
      "Restore",
    "되읽기":
      "Reload",
    "두 곳에 묻기":
      "Ask two of them",
    "두 노드가 같은 지갑을 쓰면 같은 주소를 두 번 나눠 주고 돈을 잃습니다. 원래 컴퓨터가":
      "If two nodes use the same wallet they hand out the same address twice and money is lost. Use it only when the original computer is",
    "뒤로":
      "Back",
    "드나든 기록":
      "Entry log",
    "들어감":
      "Included",
    "들어오고 나간 것":
      "What came in and went out",
    "들어온 수익":
      "Earnings received",
    "들어온 주문":
      "Orders received",
    "등록하면":
      "Registering",
    "디스크 45 GB → 5 GB, 메모리와 연결도 줄입니다.":
      "Disk 45 GB → 5 GB, and fewer connections and less memory too.",
    "따라잡음":
      "Caught up",
    "따로 있는 GPU 기계":
      "A separate GPU machine",
    "라비":
      "Ravi",
    "라비가 틀리게 답해요":
      "Ravi answers incorrectly",
    "라비를 깨웁니다":
      "Wakes Ravi up",
    "라비에게 묻기":
      "Ask Ravi",
    "레이븐 코어와 같은 주소록":
      "the same address book as Ravencoin Core",
    "레이븐코인으로 받으면 뭐가 좋아?":
      "What is good about getting paid in Ravencoin?",
    "로 고정됩니다.":
      ".",
    "루트 자산":
      "Root asset",
    "를 적어 주세요. 앞부분이 화면과 같은지도 눈으로 맞춰 보세요.":
      ". Also check by eye that the beginning matches what is on screen.",
    "를 한 번만 넣어 주세요.":
      "just once.",
    "만드는 것":
      "What you are creating",
    "만드는 중…":
      "Creating…",
    "만들고 · 되돌리기":
      "Make and restore",
    "말로 불러 주세요":
      "Just read them out",
    "말로 알려주면 화면을 채웁니다":
      "Tell me and I will fill in the screen",
    "맞추는 중…":
      "Matching…",
    "매장 밖에서도 주문·판매 링크가 열립니다. Cloudflare를 지나갑니다.":
      "Order and sale links open from outside the shop too. Traffic passes through Cloudflare.",
    "매장·포장":
      "Dine-in · takeaway",
    "매출 · 장부":
      "Sales · ledger",
    "먼저 계산해 보기":
      "Calculate first",
    "먼저 연습해 보기":
      "Practise first",
    "먼저 예약합니다":
      "Book it first",
    "먼저 이름을 정해 주세요.":
      "Please decide a name first.",
    "메뉴 넣기":
      "Add to the menu",
    "메뉴 넣을게요. 제가 부르는 대로 메뉴판에 넣어 주세요:":
      "Let me add to the menu. Put these on the menu as I read them out:",
    "메뉴 지우기를 그만두었습니다":
      "Cancelled clearing the menu",
    "메뉴가 하나도 없습니다":
      "There is not a single menu item",
    "메뉴판":
      "Menu",
    "메뉴판 올리기":
      "Publish the menu",
    "메모":
      "Note",
    "모델":
      "Model",
    "모든 폰을 끊을까요?":
      "Disconnect every phone?",
    "무엇에 쓰실 것인지 한 줄만 더 적어 주세요.":
      "Please add one more line about what you will use it for.",
    "무엇으로 줄까요":
      "What will you pay with",
    "무엇을":
      "What",
    "무엇을 만들고 싶으신지 말로 적어 보세요":
      "Describe in words what you want to create",
    "무엇을 만들고 싶으신지 한 줄만 적어 주세요.":
      "Please write one line about what you want to create.",
    "무엇을 만들까요":
      "What shall we create",
    "무엇을 할까요? 아래를 누르거나, 그냥 말씀하세요.":
      "What shall we do? Tap something below, or just tell me.",
    "무엇이 달라지나요":
      "What changes",
    "무엇이 잘못됐나요?":
      "What went wrong?",
    "무엇이든 물어봅니다. 화면은 안 건드립니다":
      "Ask anything. I will not touch the screen",
    "문":
      "Door",
    "문 설정":
      "Door settings",
    "문 앞에 두는 화면":
      "The screen you leave at the door",
    "문 저장":
      "Save door",
    "문제 알리기":
      "Report a problem",
    "문제 알리기 창을 열었습니다":
      "Opened the report window",
    "물어보기":
      "Ask something",
    "뭐든 물어보세요":
      "Ask me anything",
    "바깥에서 계산대까지 열기":
      "Open the till from outside too",
    "바깥에서도 열리게":
      "Make it reachable from outside",
    "바꾸기는 실패해도 지금 암호가 그대로 남고, 노드도 꺼지지 않습니다.":
      "If the change fails, your current passphrase stays and the node does not shut down.",
    "바꿀 수 없습니다.":
      "be changed.",
    "밖에서 주문하러 올 주소":
      "The address customers outside come to order from",
    "받기":
      "Receive",
    "받는 분이 알려 준 원본":
      "the original the recipient gave you",
    "받는 주소":
      "Recipient address",
    "받는 중…":
      "Receiving…",
    "받은 것":
      "Received",
    "받은 공지":
      "Notices received",
    "받은 금액":
      "Amount received",
    "받을 주소 만들기":
      "Create a receiving address",
    "받을 주소록":
      "Receiving address book",
    "발행 중…":
      "Issuing…",
    "배달":
      "Delivery",
    "배당":
      "Payouts",
    "백업 둘 곳":
      "Where to keep backups",
    "백업 만들기":
      "Make a backup",
    "백업본을 다른 컴퓨터에서 동시에 켜지 마세요.":
      "Do not run a backup copy on another computer at the same time.",
    "백업에서 되돌리기":
      "Restore from a backup",
    "번 돈 금고로 옮기기":
      "Move takings to the vault",
    "번호 · 시각":
      "Number · time",
    "보내기":
      "Send",
    "보내기 전 확인":
      "Check before sending",
    "보내기가 안 돼요":
      "Sending does not work",
    "보내는 중…":
      "Sending…",
    "보내려면 그때 암호를 묻습니다":
      "You will be asked for the passphrase when sending",
    "보낸 것은 되돌릴 수 없습니다.":
      "What you send cannot be taken back.",
    "보낸 공지는":
      "A notice you have sent",
    "보낸 사람이 같은 돈을 다시 쓸 수 있습니다. 커피 한 잔은 1확인, 값비싼 물건은 더 기다리십시오.":
      "The sender can still spend the same money again. One confirmation is fine for a cup of coffee; wait longer for expensive goods.",
    "보낸 주소":
      "Sending address",
    "보낼 때마다 네트워크 수수료가 듭니다. 답장은 오지 않습니다 — 이건 방송입니다.":
      "Each send costs a network fee. No replies come back — this is a broadcast.",
    "보낼 자산":
      "Asset to send",
    "보냈습니다. 고맙습니다.":
      "Sent. Thank you.",
    "보유자 전원에게":
      "To every holder",
    "보존 중…":
      "Keeping…",
    "보존을 해제할까요?":
      "Stop keeping it?",
    "보존하지 못했습니다":
      "Could not keep it",
    "보존할 항목 없음":
      "Nothing to keep",
    "보통 내가 가진 몫은 빼고 나눕니다.":
      "Usually your own share is excluded from the split.",
    "복구 단어":
      "Recovery words",
    "복구 단어 12개는 어느 경우에도 클라우드에 올라가지 않습니다.":
      "The 12 recovery words never go to the cloud under any circumstances.",
    "복구 단어 보기":
      "Show the recovery words",
    "복구 카드 인쇄":
      "Print a recovery card",
    "복사":
      "Copy",
    "복사가 안 됩니다":
      "Copying is not working",
    "복사해서 위 칸에 붙여넣으세요.":
      "Copy it and paste it into the box above.",
    "복사했습니다":
      "Copied",
    "불러오기":
      "Load",
    "불러오는 중…":
      "Loading…",
    "붙는 곳":
      "Where it applies",
    "붙어 있는 클라우드나 외장 디스크가 없습니다.":
      "No cloud folder or external disk is attached.",
    "브라우저를 열지 못했습니다":
      "Could not open the browser",
    "브랜드 아래 상품 (하위)":
      "Product under a brand (sub)",
    "블록":
      "blocks",
    "블록체인":
      "Blockchain",
    "비우면 수량 × 10":
      "Leave empty for quantity × 10",
    "비워 두면 가게 목록에 이름만 보이고":
      "If you leave it empty, only the name shows in the shop list and",
    "비워 두면 그 요일은 쉬는 날입니다. 닫는 시각이 여는 시각보다 이르면":
      "Leave a day empty and it is a day off. If the closing time is earlier than the opening time, we treat it as",
    "비워 두면 나에게도 보냅니다":
      "Leave empty to send to yourself as well",
    "사용 가능":
      "Available",
    "사장님만":
      "Owner only",
    "사장님을 도울 때":
      "When helping you",
    "사진 올리기":
      "Upload a photo",
    "사진 저장":
      "Photo storage",
    "사진 찍지 마세요. 메모 앱에 적지 마세요. 남에게 보여주지 마세요.":
      "Do not photograph them. Do not put them in a notes app. Do not show them to anyone.",
    "상담 내용, 주의사항":
      "Consultation notes, things to watch",
    "상대가 켜져 있어야":
      "the other side must be switched on",
    "상태":
      "Status",
    "새 버전 확인":
      "Check for a new version",
    "새 암호 (10자 이상)":
      "New passphrase (10 characters or more)",
    "새 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "If you forget the new passphrase, your money and assets are gone forever.",
    "새 이름을 체인에 새깁니다. RVN이 소각됩니다.":
      "Carves a new name onto the chain. RVN is burned.",
    "새 자산 만들기":
      "Create a new asset",
    "새 주소에 붙일 이름":
      "A name for the new address",
    "새로고침":
      "Refresh",
    "샘플 넣기":
      "Insert an example",
    "샘플 사진 (IPFS에 올라가 있습니다)":
      "Sample photo (already on IPFS)",
    "생각하는 중…":
      "Thinking…",
    "서로 다른 AI 두 곳에 같은 것을 묻습니다":
      "Asks the same thing of two different AIs",
    "서버 없이 두 컴퓨터가 직접 주고받습니다. 수수료도 없습니다.":
      "Two computers exchange directly with no server. There is no fee either.",
    "서울 강남구":
      "Gangnam-gu, Seoul",
    "석 달":
      "3 months",
    "설정에서":
      "In the settings",
    "설정에서 AI 열쇠를 넣으시면 라비가 골라 드립니다.":
      "Enter an AI key in the settings and Ravi will choose for you.",
    "설정에서 API 키를 넣으면 켜집니다":
      "It turns on once you enter an API key in the settings",
    "설치 중…":
      "Installing…",
    "세대":
      "Generation",
    "세부 설정":
      "Detailed settings",
    "셸리 스위치를 같은 공유기에 붙이고 셸리 앱에서 IP를 확인해 여기 적으세요. 열림 시간이 지나면":
      "Connect the Shelly switch to the same router, find its IP in the Shelly app, and enter it here. When the open time is up,",
    "셸리 아이디 · 비밀번호":
      "Shelly ID · password",
    "셸리 주소":
      "Shelly address",
    "셸리에 걸어 둔 비밀번호":
      "The password set on the Shelly",
    "소개":
      "About",
    "소비전력 (W)":
      "Power draw (W)",
    "소수점 자리":
      "Decimal places",
    "손님":
      "Customer",
    "손님 QR":
      "Customer QR",
    "손님 질문에 답할 때":
      "When answering customer questions",
    "손님 폰 서버를 켜지 못했습니다.":
      "Could not start the customer phone server.",
    "손님 폰으로 받기":
      "Take orders on customer phones",
    "손님 화면 맨 위가 빈 채로 뜹니다.":
      "The top of the customer screen appears blank.",
    "손님 화면 보기":
      "View the customer screen",
    "손님 화면에 보일 가게 소개를 써 주세요. 제 가게는":
      "Please write the shop introduction customers will see. My shop is",
    "손님에게 보일 글":
      "Text customers will read",
    "손님에게 보일 한마디 — 예: 재료가 떨어졌습니다":
      "One line customers will see — e.g. we have run out of ingredients",
    "손님에게 안 보입니다":
      "Customers will not see you",
    "손님이 QR 을 찍어도 시킬 것이 없습니다.":
      "Even if a customer scans the QR, there is nothing to order.",
    "손님이 QR을 찍어 주문합니다. 같은 wifi 안에서 됩니다.":
      "Customers scan a QR and order. It works on the same wifi.",
    "손님이 걸 수 있는 번호":
      "A number customers can call",
    "손님이 낸 돈의":
      "of what the customer paid",
    "손님이 더 내는 것이 아니라":
      "The customer does not pay extra",
    "손님이 시킨 것":
      "What customers ordered",
    "손님이 주문할 수 있어요":
      "Customers can order",
    "손님이 찾아올 수 있게 쓰세요":
      "Write it so customers can find you",
    "수량":
      "Quantity",
    "수익 계산 · 켜고 끄기":
      "Profit check · start and stop",
    "쉬는 날":
      "Closed",
    "쉬운 설정":
      "Easy setup",
    "스위치가 스스로 닫습니다":
      "the switch closes itself",
    "스위치가 이 값들을 대신 정합니다. 직접 만지실 때만 여세요.":
      "The switches above set these for you. Open this only if you want to change them yourself.",
    "시세를 못 가져왔습니다":
      "Could not fetch the exchange rate",
    "시작일":
      "Start date",
    "시험용 가게 만들기":
      "Create a test shop",
    "시험용 지우기":
      "Delete test data",
    "쓰세요.":
      "use it.",
    "쓰시는 대로 저장합니다. 나라마다 주소 모양이 달라서 쪼개지 않습니다.":
      "We save it exactly as you write it. Address formats differ by country, so we do not split it up.",
    "아래 문장을 그대로 입력하세요.":
      "Type the sentence below exactly.",
    "아래 버튼으로 만듭니다":
      "Create it with the button below",
    "아래 셋에는 열쇠가 들어 있습니다. 붙이지 말고, 찍을 때만 보여 주세요.":
      "The three below contain keys. Do not stick them up — show them only when someone is scanning.",
    "아래 아이콘은 지금 바로 됩니다. 말로 시키시려면":
      "The icons below work right now. To give me instructions in words, add",
    "아무것도 안 고르면 바탕화면에 만듭니다.":
      "If you choose nothing, we create it on the desktop.",
    "아이스 아메리카노":
      "Iced americano",
    "아이스 아메리카노 4500원 넣어줘":
      "add iced americano for 4500 won",
    "아직 안 된 것":
      "Not ready yet",
    "아직 안 된 것이 있습니다":
      "Some things are not ready yet",
    "아직 없습니다":
      "None yet",
    "아직 정해지지 않았습니다":
      "Not decided yet",
    "안 건드리면 지금 그대로":
      "Leave it alone and it keeps",
    "안 붙는 곳":
      "Where it does not apply",
    "안 함":
      "Not included",
    "안녕하세요, 라비입니다.":
      "Hello, I am Ravi.",
    "알겠습니다":
      "Got it",
    "암호 걸기":
      "Set a passphrase",
    "암호 바꾸기":
      "Change passphrase",
    "암호 없음":
      "No passphrase",
    "암호는":
      "The passphrase protects you",
    "암호를 걸면":
      "Once you set a passphrase,",
    "암호를 잊으면 되돌릴 수 없다":
      "If I forget the passphrase it cannot be undone",
    "약 47 GB":
      "about 47 GB",
    "약 6 GB":
      "about 6 GB",
    "어느 자산 보유자에게":
      "To holders of which asset",
    "어느 화면인지·무슨 오류가 났는지는 제가 알아서 같이 보냅니다. 겪으신 것만 적어 주세요.":
      "I will send which screen you were on and what error happened. Just write what you experienced.",
    "어디":
      "Where",
    "어떤 자산의 보유자":
      "Holders of which asset",
    "언제 명단을 굳힐까요":
      "When shall we freeze the list",
    "얼마":
      "How much",
    "없어도 등록됩니다":
      "You can register without one",
    "에 두시면 찾아서 씁니다.":
      "and we will find and use it.",
    "에 있습니다. 아무도 갖고 있지 않으면 찾을 수 없게 됩니다 — 이 컴퓨터가 켜져 있으면 이 컴퓨터가 갖고 있습니다.":
      ". If nobody keeps them, they become unfindable — while this computer is on, this computer keeps them.",
    "엑셀 파일로 내보내기":
      "Export as a spreadsheet",
    "여기서 시작합니다":
      "Start here",
    "여는 시각과 닫는 시각을 둘 다 넣으셔야 나머지 요일에 옮길 수 있습니다.":
      "You need both the opening and closing time before it can be copied to the other days.",
    "여는 중…":
      "Opening…",
    "연결과 뒷일을 줄입니다":
      "Reduces connections and background work",
    "연결만 확인":
      "Just test the connection",
    "연습 시작":
      "Start practice",
    "연습용 돈을 만드는 중…":
      "Creating practice money…",
    "연습용 체인을 켜는 중…":
      "Starting the practice chain…",
    "열려 있음":
      "Open",
    "열린 것과":
      "Doors that opened and",
    "열림 시간(초)":
      "Open time (seconds)",
    "열쇠 보기":
      "Show the key",
    "영업 중":
      "Open now",
    "영업시간":
      "Opening hours",
    "영업하는 것으로 봅니다 — 밤 6시 열고 새벽 2시 닫기.":
      "— open at 6 pm, close at 2 am.",
    "영원히":
      "never",
    "예: 강남에서 원두 직접 볶는 작은 카페, 포장만":
      "e.g. a small cafe in Gangnam that roasts its own beans, takeaway only",
    "예: 보내기를 눌렀는데 아무 일도 없어요":
      "e.g. I pressed Send and nothing happened",
    "예: 아메리카노 4500, 카페라떼 5000, 치즈케이크 6500":
      "e.g. americano 4500, cafe latte 5000, cheesecake 6500",
    "예: 우리 헬스장 3개월 회원권을 30명한테 주고 싶어요":
      "e.g. I want to give 30 people a 3-month gym membership",
    "예약":
      "Book it",
    "오늘":
      "Today",
    "오늘 얼마":
      "Today's takings",
    "오늘 팔 것만":
      "only what you will sell today",
    "오래 걸립니다":
      "This takes a while",
    "오래된 컴퓨터":
      "Older computer",
    "오래된 컴퓨터로 아끼기":
      "Save resources on an older computer",
    "오류 없음":
      "No errors",
    "올린 파일은 이 컴퓨터가 보존합니다.":
      "This computer keeps the file you upload.",
    "완전히 죽었을 때만":
      "completely dead",
    "원 (₩)":
      "KRW (₩)",
    "원두 20kg 다음 주에 가능할까요?":
      "Could you do 20 kg of beans next week?",
    "원두를 직접 볶는 작은 카페":
      "A small cafe that roasts its own beans",
    "원두를 직접 볶는 작은 카페입니다":
      "A small cafe that roasts its own beans",
    "원래대로":
      "Undo changes",
    "원본의 끝 4자리":
      "last 4 characters of the original",
    "월요일 시간을 나머지 요일에도":
      "Apply Monday's hours to the other days",
    "월요일부터 채워 주세요":
      "Please fill in Monday first",
    "위에 있는 곳부터 씁니다. 막히거나 실패하면 아래로 넘어갑니다.":
      "We use the one at the top first. If it is blocked or fails, we move down.",
    "위에 적힌 이름을 직접 입력":
      "Type the name written above",
    "위의":
      "The",
    "으로 갑니다. 컴퓨터를 잃어버려도 거기 있는 돈은 무사합니다.":
      ". Even if you lose the computer, the money there is safe.",
    "을 같이 남깁니다 — \"왜 안 열렸지\"가 카운터에서 제일 자주 나오는 질문입니다.":
      "are both recorded — \"why didn't it open\" is the question asked most often at the counter.",
    "을 해야 고쳐집니다 — 빠른 터널 주소는 켤 때마다 바뀌니 임시로만 쓰세요.":
      "to fix it — a quick tunnel address changes every time you start it, so use it only temporarily.",
    "이 가격에 내놓기":
      "List it at this price",
    "이 금액(RVN)을 넘으면":
      "When it exceeds this amount (RVN)",
    "이 기능만 이 컴퓨터 밖으로 나갑니다.":
      "This is the only feature that leaves this computer.",
    "이 노드":
      "This node",
    "이 단어를 아는 사람은 지갑 전부를 가져갈 수 있습니다.":
      "Anyone who knows these words can take the whole wallet.",
    "이 목록은":
      "This list is",
    "이 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "If you forget this passphrase, your money and assets are gone forever.",
    "이 앱과 레이븐 코어는 같은 지갑을 씁니다. 동시에 열 수 없습니다.":
      "This app and Ravencoin Core use the same wallet. They cannot be open at the same time.",
    "이 앱도, 레이븐코인도, 누구도 되돌릴 수 없습니다. 복구 방법이 없습니다.":
      "Not this app, not Ravencoin, not anyone can undo it. There is no recovery.",
    "이 이름으로 해 보기":
      "Try it with this name",
    "이 이름은 체인에 영구히 남고 누구도 다시 쓸 수 없습니다. 그대로 다시 입력하세요.":
      "This name stays on the chain forever and nobody can ever reuse it. Type it again exactly.",
    "이 이름을 아는 사람은 누구나 들을 수 있습니다. 비밀 대화가 아닙니다.":
      "Anyone who knows this name can listen in. This is not a private conversation.",
    "이 자물쇠의 열쇠":
      "The key to this lock",
    "이 주소는 내 지갑입니다.":
      "This address is your own wallet.",
    "이 주소는 체인에 올라가므로, 바뀌면":
      "This address goes onto the chain, so if it changes you need a",
    "이 지갑의 주소만 씁니다. 직접 입력하지 않는 이유는, 잘못 붙여넣으면 매출이 남에게 갑니다.":
      "Only addresses from this wallet are used. We do not let you type one because a bad paste sends your takings to someone else.",
    "이 컴퓨터":
      "This computer",
    "이 컴퓨터 → AI 열쇠":
      "This computer → AI key",
    "이 컴퓨터 안의 사본은 잠그지 않습니다 — 여기 있는 사람은 이미 지갑을 가졌으므로 잠가도 얻는 것이 없습니다.":
      "The copy inside this computer is not locked — anyone here already has the wallet, so locking gains nothing.",
    "이 컴퓨터, 가게에만 쓰시나요?":
      "Is this computer only for the shop?",
    "이 컴퓨터가 아닌 곳에 두세요.":
      "somewhere other than this computer.",
    "이 컴퓨터로 캐지 않습니다.":
      "This computer does not mine.",
    "이 컴퓨터로도 캐기":
      "Mine on this computer too",
    "이 컴퓨터를 보고 제가 정해 드릴게요.":
      "I will look at this computer and decide for you.",
    "이 컴퓨터를 쓸 수 있는 사람은 지갑도 쓸 수 있습니다":
      "Anyone who can use this computer can use the wallet",
    "이 컴퓨터에 맞게 살펴보는 중…":
      "Checking what this computer can do…",
    "이 컴퓨터에 보존":
      "Kept on this computer",
    "이 컴퓨터에만":
      "only on this computer",
    "이 컴퓨터에서 사본이 사라집니다. 다른 곳에 사본이 없으면 되찾을 수 없습니다.":
      "The copy on this computer disappears. If there is no copy elsewhere, it cannot be recovered.",
    "이 컴퓨터에서 열지 못했습니다":
      "Could not open it on this computer",
    "이 컴퓨터의 파일 창고에서만 찾습니다. 내가 가진 자산 목록을 바깥으로 보내지 않습니다.":
      "We look only in this computer's file store. Your list of assets is never sent outside.",
    "이것 없이는 클라우드 사본을 못 엽니다.":
      "Without it, the cloud copy cannot be opened.",
    "이대로 시작하기":
      "Start as is",
    "이대로 켜기":
      "Start with these settings",
    "이라 돈이 안 나가고, 마음에 안 들면 지우고 다시 하시면 됩니다.":
      ", so no money leaves, and if you do not like it you can wipe it and start again.",
    "이름":
      "Name",
    "이름 (지점명)":
      "Name (branch name)",
    "이름 · 사진 · 주소 · 영업시간 · 등록":
      "Name · photo · address · hours · registration",
    "이름 하나면 시작됩니다. 나머지는 나중에 채우셔도 됩니다.":
      "One name is enough to start. You can fill in the rest later.",
    "이름·전화 뒷자리·회원번호 아무거나 치면 됩니다.":
      "Type a name, the last digits of a phone number, or a member number — any of them.",
    "이름이 체인에 영구히 남고 RVN이 소각됩니다. 이름을 그대로 입력하세요.":
      "leaves the name on the chain forever and burns RVN. Type the name exactly.",
    "이미 들어 있는 것이 있습니다":
      "There is something already in there",
    "이미 만들어진 잠긴 백업은 그대로 남습니다.":
      "Locked backups already made stay as they are.",
    "이번 주 휴무 안내":
      "This week's closing notice",
    "읽기 전용":
      "Read only",
    "읽는 중…":
      "Reading…",
    "입니다. 여기서 붙인 이름이 코어에도 보이고, 코어에서 붙인 이름이 여기 보입니다.":
      ". Names you set here appear in Core, and names set in Core appear here.",
    "자격 배지":
      "Credential badge",
    "자격 증명":
      "Credential",
    "자동 발송 켜기":
      "Turn on auto-delivery",
    "자동 확인 (30초)":
      "Auto-check (30 s)",
    "자산":
      "Assets",
    "자산 만들기":
      "Create an asset",
    "자산 보내기":
      "Send an asset",
    "자산 이름":
      "Asset name",
    "자산에 붙은 그림·음악은 체인이 아니라":
      "Pictures and music attached to an asset are not on the chain but in the",
    "자산을 가진 사람 전원에게 갑니다. 답장은 받을 수 없습니다.":
      "It goes to everyone holding the asset. You cannot receive replies.",
    "자산을 가진 사람들에게 나눠 줍니다. 회원권·조합원 토큰에 씁니다.":
      "Distributes to everyone holding an asset. Used for membership and co-op tokens.",
    "자산을 발행하려면 지갑을 열어야 합니다.":
      "You must unlock the wallet to issue an asset.",
    "자산을 불러오는 중…":
      "Loading assets…",
    "자산을 하나 만들려고 합니다. 무엇을 물어봐야 하는지부터 알려 주세요.":
      "I want to create an asset. Start by telling me what I should be asked.",
    "자정 넘겨 영업":
      "Open past midnight",
    "자정을 넘겨":
      "staying open past midnight",
    "잠겨 있을 때만":
      "only while it is locked",
    "잠금":
      "Lock",
    "장비 이름":
      "Rig name",
    "재발행 가능":
      "Reissuable",
    "재발행(RVN 소각)":
      "reissue (burning RVN)",
    "재발행을 껐으므로 수량과 파일을 영원히 못 바꿉니다":
      "Reissue is off, so the quantity and file can never be changed",
    "저장":
      "Save",
    "저장 중…":
      "Saving…",
    "저장됩니다 — 체인에 올리면 지울 수 없고, 누구나 회원 명단과 계약 종료일을 볼 수 있게 됩니다.":
      "— putting them on the chain would make them unerasable, and anyone could see your member list and contract end dates.",
    "저장하고 다시 켜기 안내":
      "Save and restart guide",
    "저장했습니다":
      "Saved",
    "저장했습니다.":
      "Saved.",
    "전기값이 더 나갈 수 있습니다.":
      "the electricity may cost more than you earn.",
    "전기요금 (원/kWh)":
      "Electricity price (KRW/kWh)",
    "전부 이 컴퓨터에 둡니다":
      "Keep everything on this computer",
    "전원이 돌아오면 노드가 저절로 켜집니다. 앱은 켜지지 않습니다.":
      "When power returns the node starts by itself. The app does not.",
    "전체":
      "All",
    "전체 명단":
      "Full list",
    "전체 얼마":
      "Total amount",
    "전화":
      "Phone",
    "정문":
      "Front door",
    "정전 뒤 자동으로 켜기":
      "Start automatically after a power cut",
    "제 일도 하는 컴퓨터입니다. 꼭 필요한 만큼만 쓰게 합니다.":
      "A computer you also work on. We use only what is needed.",
    "제가 정해 드려요":
      "I will decide for you",
    "제목":
      "Subject",
    "제한 자산":
      "Restricted asset",
    "종류":
      "Type",
    "종이에 적어":
      "Write them on paper and keep them",
    "종이에 적어 12단어와 같이 보관하세요.":
      "Write it on paper and keep it with the 12 words.",
    "좌표 (선택)":
      "Coordinates (optional)",
    "주문 버튼이 안 생깁니다.":
      "no order button appears.",
    "주문·계산이 안 돼요":
      "Ordering or payment does not work",
    "주문·회원확인만":
      "Orders and member checks only",
    "주문마다 자동으로 만들어지는 주소는 목록에 넣지 않습니다 — 하루 장사하면 수십 줄이 되어 직접 붙인 이름이 묻힙니다.":
      "Addresses created automatically for each order are kept out of this list — one day of trading makes dozens of rows and buries the names you set yourself.",
    "주문마다 주소가 따로 생깁니다. 그 주소로 들어온 돈만 그 주문의 결제입니다.":
      "Each order gets its own address. Only money arriving at that address counts as payment for that order.",
    "주소":
      "Address",
    "주소 만들고 폰 여는 중…":
      "Creating the address and opening the phone…",
    "주소 만들기":
      "Create address",
    "주소를 만들지 못했습니다":
      "Could not create the address",
    "주소를 복사했습니다":
      "Address copied",
    "주소를 복사했습니다. 브라우저에 붙여넣어 확인하세요.":
      "Address copied. Paste it into a browser to check.",
    "주소를 읽지 못했습니다":
      "Could not read the address",
    "준비됐습니다. 「이 이름으로 해 보기」를 눌러 보세요.":
      "Ready. Try pressing \"Try it with this name\".",
    "지갑":
      "Wallet",
    "지갑 12단어·열쇠·주소·잔액은 보내지 않습니다.":
      "The wallet's 12 words, keys, addresses and balance are never sent.",
    "지갑 암호":
      "Wallet passphrase",
    "지갑 잠금":
      "Wallet lock",
    "지갑 파일도 같이 올라가지만, 잠겨 있어서 클라우드 계정이 털려도 열 수 없습니다.":
      "The wallet file goes up too, but it is locked, so even a breached cloud account cannot open it.",
    "지갑에 암호 걸기":
      "Set a passphrase on the wallet",
    "지갑을 열지 못했습니다":
      "Could not unlock the wallet",
    "지갑이 안 열려요":
      "The wallet will not open",
    "지갑이 잠겨 있습니다. 이 한 번만 열고 곧바로 다시 잠급니다.":
      "The wallet is locked. We open it just this once and lock it again immediately.",
    "지갑이 잠깐 열립니다.":
      "the wallet opens briefly.",
    "지금 결제를 바로 확인합니다":
      "Payments are confirmed instantly",
    "지금 닫기":
      "Close now",
    "지금 닫기 (시간표보다 우선)":
      "Close now (overrides opening hours)",
    "지금 상태":
      "Right now",
    "지금 설치할까요?":
      "Install it now?",
    "지금 쓰는 암호":
      "Current passphrase",
    "지금 쓸 곳":
      "What to use now",
    "지금 잠그기":
      "Lock now",
    "지금 켜기":
      "Turn it on now",
    "지금 터널 주소 넣기":
      "Use the current tunnel address",
    "지금은 닫혀 있습니다":
      "Currently closed",
    "지금은 암호 없이 보낼 수 있는 상태입니다. 자리를 비우기 전에 잠그세요.":
      "Right now money can be sent without a passphrase. Lock it before you leave your seat.",
    "지금이 최신입니다.":
      "You are up to date.",
    "지도 앱에서 복사해 붙여넣기":
      "Copy from a maps app and paste",
    "지도 주소를 복사했습니다. 브라우저에 붙여넣으세요.":
      "Map link copied. Paste it into a browser.",
    "지도에서 확인":
      "Check on a map",
    "지우고 처음부터":
      "Wipe and start over",
    "지우는 중…":
      "Deleting…",
    "지울 수 없습니다.":
      "cannot be deleted.",
    "지웁니다":
      "Delete it",
    "지웠습니다. 「연습 시작」부터 다시 하시면 됩니다.":
      "Deleted. Start again from \"Start practice\".",
    "지점 이름 · 손님 폰 연결 · 백업 · 금고 — 매일 여실 필요 없어요":
      "Branch name · customer phone link · backup · vault — no need to open these daily",
    "지킬 것이 없습니다":
      "Nothing to keep",
    "지킵니다. 자동 판매를 켜면 잠금이 풀리고, 그동안은 암호가 없는 것과 같습니다.":
      ". Turning on auto-selling unlocks it, and during that time it is as if there were no passphrase.",
    "직원":
      "Staff",
    "직원 폰도 같이 끊깁니다. 새 QR을 다시 찍어야 합니다.":
      "Staff phones are disconnected too. They will need to scan a new QR.",
    "직접 입력":
      "Enter manually",
    "진짜 지갑은 건드리지 않습니다.":
      "Your real wallet is never touched.",
    "진짜로 보내기":
      "Send for real",
    "진짜와 똑같이 한 번 해 보실 수 있습니다.":
      "You can go through it exactly as the real thing.",
    "찾는 중…":
      "Searching…",
    "채굴":
      "Mining",
    "채굴 · 그냥 보내기 · 자산 발행":
      "Mining · plain sends · issuing assets",
    "채굴 켜기":
      "Start mining",
    "채굴기 실행 파일 이름":
      "Miner executable name",
    "채널":
      "Channel",
    "채웠습니다. 고쳐서 쓰세요.":
      "Filled in. Edit it as you like.",
    "처음 보내는 주소입니다.":
      "This is an address you are sending to for the first time.",
    "처음 한 번 하는 것들":
      "Things you do once",
    "체인에 가게를 등록하지 않았습니다":
      "The shop is not registered on the chain",
    "체인에 남을 이름":
      "The name that stays on the chain",
    "체인에 영구히 남고 누구나 볼 수 있습니다.":
      "It stays on the chain forever and anyone can see it.",
    "체인에 저장되는 이름은 영문 대문자만 가능합니다. 손님이 보는 이름은 위에 적은 것입니다.":
      "The name stored on the chain can only use capital letters. What customers see is the name you typed above.",
    "체인에서 직접 확인하실 수 있습니다. 카드 수수료(2~3%)와 달리":
      "You can verify it directly on the chain. Unlike card fees (2–3%), there is",
    "체인은 지나간 순간의 명단을 되돌려주지 않습니다. 먼저 예약해야 그 블록이 지날 때 명단이 굳습니다.":
      "The chain will not give you a holder list from a moment that has passed. You must book it first, and the list freezes when that block goes by.",
    "최근 거래":
      "Recent transactions",
    "출입 · 회원":
      "Entry · Members",
    "취소":
      "Cancel",
    "치즈케이크":
      "Cheesecake",
    "카운터에 붙이는 것":
      "The one you stick on the counter",
    "카운터에 붙이세요. 이 QR 에는 열쇠가 없어 누가 봐도 괜찮습니다.":
      "Stick this on the counter. This QR holds no key, so it is fine for anyone to see.",
    "카페라떼":
      "Cafe latte",
    "칸이 비어 있어요. 키를 붙여넣고 다시 눌러 주세요.":
      "The box is empty. Paste the key and press again.",
    "캘 기계의 그래픽카드":
      "Graphics card of the mining machine",
    "커피값을 4500원으로 올릴까?":
      "Shall I raise the coffee price to 4,500 won?",
    "컴퓨터가 죽으면 이 열쇠도 같이 사라집니다.":
      "If the computer dies, this key dies with it.",
    "컴퓨터를 살펴보는 중…":
      "Looking over the computer…",
    "켜 두시길 권합니다.":
      "We recommend leaving this on.",
    "켜기":
      "Turn on",
    "켜면 QR 네 개가 나옵니다 — 사장님·직원·검표·손님.":
      "Turning it on produces four QR codes — owner, staff, door check, customer.",
    "쿠폰 · 회원권":
      "Coupons · memberships",
    "쿠폰 · 회원권 · 굿즈":
      "Coupons · memberships · merch",
    "클라우드":
      "Cloud",
    "클라우드로 나가는 파일은 저희가 한 번 더 잠급니다.":
      "Files that go to the cloud are locked once more by us.",
    "키 (없으면 비움)":
      "Key (leave empty if none)",
    "테이블마다 다른 QR 을 인쇄하려면":
      "To print a different QR for each table",
    "파일":
      "File",
    "파일 고르기":
      "Choose a file",
    "파일 지키기":
      "Keep the files",
    "파일 창고(IPFS)":
      "file store (IPFS)",
    "파일을 고르면 여기 자동으로 채워집니다":
      "This fills in automatically once you choose a file",
    "파일을 안 붙이셨습니다 — 나중에 붙이려면 재발행이 켜져 있어야 합니다":
      "You did not attach a file — to attach one later, reissue must be on",
    "파일이 자산의 얼굴입니다. 없어도 발행은 됩니다.":
      "The file is the asset's face. You can still issue without one.",
    "파일창고":
      "File store",
    "파일창고 꺼짐":
      "File store is off",
    "파일창고 켜짐":
      "File store is on",
    "판":
      "version",
    "판매중":
      "On sale",
    "팔고 있는 것":
      "What is on sale",
    "팔기":
      "Sell",
    "팔린 자산을 보내려면":
      "To send a sold asset,",
    "폰을 같은 와이파이에 붙이고 찍으세요":
      "Connect the phone to the same wifi and scan",
    "폰을 잃어버렸어요":
      "I lost my phone",
    "풀":
      "Pool",
    "품목 추가":
      "Add an item",
    "프로그램이 다시 시작합니다. 손님이 주문 중이면 그 화면이 끊깁니다.":
      "The program will restart. If a customer is ordering, their screen will cut out.",
    "프로그램이 안 켜져요":
      "The program will not start",
    "하고, 지나간 말은 남지 않습니다. 손님 폰에는 닿지 않습니다 — 그쪽은 위의 공지나 매장 wifi를 씁니다.":
      ", and past messages are not kept. It does not reach customer phones — for that, use the notices above or the shop wifi.",
    "하루 200번까지 옵니다. 싸고 빠른 곳이 위로 오는 게 유리합니다.":
      "Up to 200 a day arrive. It pays to put a cheap, fast provider on top.",
    "하루 자동 발송 한도 (수량)":
      "Daily auto-delivery limit (quantity)",
    "하위 자산":
      "Sub asset",
    "한 번 더":
      "Once more",
    "한 번 켜면 되돌릴 수 없습니다.":
      "Once turned on, this cannot be undone.",
    "한 번 하는 일":
      "One-time tasks",
    "한 사람에 하나 (유니크)":
      "One per person (unique)",
    "한국어 — 강남 카페":
      "Korean — Gangnam Cafe",
    "한도는 판매를 막는 것이 아니라, 뭔가 잘못됐을 때 손실이 멈추는 선입니다. 하루 100개 팔 생각이면 100으로 두세요.":
      "The limit is not there to block sales; it is the line where losses stop if something goes wrong. If you plan to sell 100 a day, set 100.",
    "한쪽만 적혀서 저장되지 않습니다":
      "Only one side filled — not saved",
    "할 말":
      "Message",
    "해시레이트 (MH/s)":
      "Hash rate (MH/s)",
    "해제하지 못했습니다":
      "Could not release it",
    "해제합니다":
      "Release",
    "홍길동 · 5678 · A7K2":
      "Jane Doe · 5678 · A7K2",
    "화면":
      "screen",
    "화면 문제":
      "Something looks wrong",
    "화면 채우기":
      "Fill in the screen",
    "확인":
      "OK",
    "확인 불가":
      "Cannot verify",
    "확인 수가 0이면 아직":
      "If the confirmation count is 0, it is",
    "확인 중…":
      "Checking…",
    "확인하지 못했습니다. 인터넷을 확인해 주세요.":
      "Could not check. Please check your internet.",
    "회원 등록":
      "Register a member",
    "회원권 번호":
      "Membership number",
    "회원번호를 체인에 하나 찍습니다 (":
      "This mints one member number on the chain (",
    "횟수":
      "Visits",
    "횟수권 (10회 등)":
      "Count pass (e.g. 10 visits)",
  },
  ja: {
    "(문자·영수증·카운터 화면)을 보시고, 그":
      "（メッセージ・レシート・カウンター画面）を見て、その",
    "). 이름·기간·정지는":
      "）。名前・期間・停止は",
    ", 받으신 금액에서 나뉩니다.":
      "、受け取った金額から分かれます。",
    ", 키 없음.":
      "、キー不要。",
    "1 (고유)":
      "1（ユニーク）",
    "1. 명단을 굳힐 때를 정합니다":
      "1. 名簿を確定する時点を決めます",
    "10분 뒤":
      "10分後",
    "127.0.0.1:8766 · 쿠키 인증":
      "127.0.0.1:8766・クッキー認証",
    "1개월":
      "1か月",
    "1년":
      "1年",
    "1세대":
      "第1世代",
    "1시간 뒤":
      "1時間後",
    "2. 예약해 둔 것":
      "2. 予約したもの",
    "20초 안에 열리지 않았습니다.":
      "20秒以内に開きませんでした。",
    "2세대":
      "第2世代",
    "3. 나눠 주기":
      "3. 配る",
    "30일":
      "30日",
    "3개월":
      "3か月",
    "5 RVN · 약 17원":
      "5 RVN・約17ウォン",
    "6개월":
      "6か月",
    "6시간 뒤":
      "6時間後",
    "7일":
      "7日",
    "9월 20일 하루 쉽니다":
      "9月20日は一日お休みします",
    "AI 도우미":
      "AIアシスタント",
    "AI 열쇠":
      "AIキー",
    "AI로 채우기":
      "AIで埋める",
    "GPU를 몇 %로 쓸까요":
      "GPUを何%使いますか",
    "IPFS 게이트웨이":
      "IPFSゲートウェイ",
    "Ollama는":
      "Ollamaは",
    "PLAY X Raven 백업":
      "PLAY X Raven バックアップ",
    "PLAYX 수수료":
      "PLAYX手数料",
    "RVN 또는 자산 이름":
      "RVNまたはアセット名",
    "RVN 보내기":
      "RVNを送る",
    "Ravi에게 물어보기":
      "Raviに聞いてみる",
    "USB 는 잃어버리고, 빌려주고, 꽂아 둔 채로 자리를 비웁니다 — 주운 사람이 가게 돈을 가져갑니다.":
      "USBはなくし、貸し、挿したまま席を離れます — 拾った人がお店のお金を持って行きます。",
    "USB 백업도 잠그기":
      "USBバックアップもロックする",
    "playx-도매-2026":
      "playx-卸-2026",
    "— 돈이 들지 않습니다":
      "— お金はかかりません",
    "— 이 프로그램이 꺼져 있어도 그렇습니다.":
      "— このプログラムが終了していてもそうです。",
    "— 화면을 보고 적으시면 이 확인이 아무 소용이 없기 때문입니다.":
      "— 画面を見て書き写したのでは、この確認に意味がないからです。",
    "← 가게":
      "← お店",
    "「먼저 계산해 보기」로 몇 명에게 얼마가 가는지 확인한 뒤에만 보내기가 열립니다.":
      "「先に計算してみる」で何人にいくら行くか確認した後にだけ、送信が開きます。",
    "中文 (선택)":
      "中国語（任意）",
    "日本語 (선택)":
      "日本語（任意）",
    "가 생깁니다. 안 넣어도 가게는 보입니다.":
      "が表示されます。入れなくてもお店は表示されます。",
    "가 이 프로그램을 만드는 곳으로 갑니다. 나머지 99%는 사장님 지갑으로 바로 들어옵니다.":
      "がこのプログラムを作るところへ行きます。残り99%は店主のウォレットに直接入ります。",
    "가 캐고 수익만 이 지갑으로 옵니다.":
      "が掘り、収益だけがこのウォレットに入ります。",
    "가게":
      "お店",
    "가게 결제 · 벤딩머신 · 중고 물건 사기":
      "店舗決済・自動販売機・中古品の購入",
    "가게 등록":
      "お店を登録",
    "가게 만들기":
      "お店を作る",
    "가게 소개":
      "お店の紹介",
    "가게 이름 (손님이 읽는 이름)":
      "お店の名前（お客様が読む名前）",
    "가게 이름이 비어 있습니다":
      "お店の名前が空です",
    "가게 정보":
      "お店の情報",
    "가게 정보 · 처음 한 번":
      "お店の情報・最初の一度だけ",
    "가게·브랜드 (루트)":
      "お店・ブランド（ルート）",
    "가게가 받은 총액입니다. 부가세 구분과 과세 여부는 사업자 유형에 따라 달라서 여기서 계산하지 않습니다 — 세무 담당자에게 이 파일을 그대로 주시면 됩니다.":
      "お店が受け取った総額です。消費税の扱いは事業形態によって異なるためここでは計算しません — このファイルをそのまま税務担当者に渡してください。",
    "가게부터 만들까요?":
      "まずお店を作りましょうか？",
    "가게에만 씁니다":
      "お店専用です",
    "가격":
      "価格",
    "가격 단위":
      "通貨単位",
    "가끔 씁니다. 잘하는 곳이 위로 오는 게 유리합니다.":
      "たまに使います。優秀なところを上にするのが有利です。",
    "가는 자리":
      "送り先",
    "가볍게 시작합니다":
      "軽く始めます",
    "가짜 체인":
      "練習用チェーン",
    "간판 사진":
      "看板の写真",
    "강남 로스터리":
      "江南ロースタリー",
    "강남지점 · 2층 계산대":
      "江南支店・2階レジ",
    "같은 와이파이 주문은 됩니다. 다만 가게 목록에는 안 뜹니다.":
      "同じwifiでの注文はできます。ただしお店の一覧には出ません。",
    "같이 보내는 것":
      "一緒に送るもの",
    "개를 지키는 중":
      "件を保管中",
    "개발비 1%":
      "開発費1%",
    "거리와 길찾기":
      "距離と経路案内",
    "거절된 것":
      "断られたもの",
    "건의 오류":
      "件のエラー",
    "검토":
      "確認",
    "검표 태블릿":
      "検札タブレット",
    "결제가 아닙니다.":
      "支払いではありません。",
    "계산대 컴퓨터로는":
      "レジのパソコンでは",
    "계산대·주문만 돌리는 컴퓨터입니다. 장부를 전부 갖고 있어 가장 빠릅니다.":
      "レジと注文だけを動かすパソコンです。台帳をすべて持つので最も速いです。",
    "계산대에 남길 돈(RVN)":
      "レジに残すお金（RVN）",
    "계산대에 하루치가 쌓입니다. 정해 둔 금액을 넘으면 남는 돈이 자동으로":
      "レジには一日分がたまります。決めた金額を超えると余りが自動的に",
    "고급 — 채굴 · AI 키 · 세부 설정":
      "詳細 — マイニング・AIキー・細かい設定",
    "고유 여러 개":
      "ユニーク複数",
    "고유 자산":
      "ユニークアセット",
    "고유 자산은 하나뿐입니다. 수량은":
      "ユニークアセットは1つだけです。数量は",
    "고치기":
      "修正する",
    "고치러 가기":
      "直しに行く",
    "공지":
      "お知らせ",
    "공지 보내기":
      "お知らせを送る",
    "구글·애플 지도에서 가게를 길게 눌러 좌표를 복사한 뒤 여기 붙이세요. 넣으면 손님 화면에":
      "GoogleマップやAppleマップでお店を長押しして座標をコピーし、ここに貼り付けてください。入れるとお客様の画面に",
    "굳은 명단":
      "確定した名簿",
    "그건 종이(복구 카드)나 비밀번호 금고에 두세요.":
      "それは紙（復元カード）かパスワード金庫に置いてください。",
    "그냥 묻기":
      "ただ聞く",
    "그동안 이 컴퓨터의 다른 프로그램도 지갑을 쓸 수 있습니다. 가게용 지갑은":
      "その間、このパソコンの他のプログラムもウォレットを使えます。お店用のウォレットには",
    "그래도 소량이나마 레이븐에 기여하고 싶을 때 켜세요. 채굴기는 우리가 넣어 두지 않았습니다 — 백신이 채굴기를 악성코드로 잡는 일이 흔해서, 넣으면 앱 전체가 격리됩니다. 아래에서 받아":
      "それでも少しでもRavencoinに貢献したいときにオンにしてください。マイナーは同梱していません — ウイルス対策ソフトがマイナーをマルウェアと判定することが多く、同梱するとアプリ全体が隔離されます。下から入手して",
    "그래도 전부 보관하기":
      "それでも全部保管する",
    "그만두기":
      "やめる",
    "금고 주소 (이 컴퓨터가 아닌 지갑)":
      "金庫アドレス（このパソコン以外のウォレット）",
    "금고 주소는 켤 때 고정됩니다.":
      "金庫アドレスはオンにした時点で固定されます。",
    "금액":
      "金額",
    "기간":
      "期間",
    "기간권 (한달·정기)":
      "期間券（1か月・定期）",
    "기본값으로":
      "初期値に戻す",
    "기본값으로 되돌렸습니다.":
      "初期値に戻しました。",
    "기본으로":
      "初期値に",
    "꺼 둡니다":
      "オフにしておきます",
    "꺼두면 수량과 설정을":
      "オフのままだと数量と設定を",
    "꺼짐":
      "オフ",
    "끄기":
      "オフにする",
    "끄려면 체인을 처음부터 다시 받아야 합니다(몇 시간).":
      "元に戻すにはチェーンを最初から取り直す必要があります（数時間）。",
    "끄면 바깥 주소로는 손님 화면만 열립니다. 켜면 사장·직원 화면도 열립니다.":
      "オフだと外部アドレスではお客様画面だけが開きます。オンにすると店主・スタッフ画面も開きます。",
    "끄시면 열쇠 없이 바로 쓸 수 있지만, 그 USB 하나가 곧 지갑입니다.":
      "オフにすれば鍵なしですぐ使えますが、そのUSB1本がそのままウォレットです。",
    "끊습니다":
      "切断します",
    "끝 네 글자":
      "末尾4文字",
    "끝 네 글자를 일부러 가려 두었습니다":
      "末尾4文字をわざと隠しています",
    "끝나는 날":
      "終了日",
    "나머지는 전부 127.0.0.1 안에서 돕니다. 입력한 문장만 가고, 지갑·개인키·자산 목록은 보내지 않습니다.":
      "ほかはすべて127.0.0.1の中で動きます。入力した文だけが送られ、ウォレット・秘密鍵・アセット一覧は送りません。",
    "나에게는 안 보내기":
      "自分には送らない",
    "나중에 더 발행할 수 있게 (재발행 가능)":
      "あとで追加発行できるようにする（再発行可能）",
    "남은 블록":
      "残りブロック",
    "남이 이 컴퓨터를 만져도 목적지를 바꿀 수 없고, 사장님 지갑으로 보내는 것만 할 수 있습니다. 주소를 바꾸려면 지갑 암호가 필요합니다.":
      "他人がこのパソコンを触っても送り先は変えられず、店主のウォレットに送ることしかできません。アドレスを変えるにはウォレットのパスフレーズが必要です。",
    "내 가게":
      "マイショップ",
    "내 주소 채우기":
      "自分のアドレスを入れる",
    "내가 만든 것":
      "自分が作ったもの",
    "내가 만든 자산의 파일입니다":
      "自分が作ったアセットのファイルです",
    "내놓은 자산":
      "出品したアセット",
    "내용":
      "本文",
    "내일 이맘때":
      "明日の今頃",
    "넘어가는 순서 바꾸기":
      "切り替え順を変える",
    "노드":
      "ノード",
    "노드 RPC":
      "ノードRPC",
    "노드 꺼짐":
      "ノードは停止中",
    "노드 따라잡는 중":
      "ノードが追いついています",
    "노드 켜짐":
      "ノードは稼働中",
    "노드·사진 창고·지갑·계산대를 한 프로그램에서 씁니다.":
      "ノード・ファイル倉庫・ウォレット・レジを一つのプログラムで。",
    "노드가 꺼져 있어요":
      "ノードが停止しています",
    "노드가 꺼져 있어요.":
      "ノードが停止しています。",
    "노드가 바로 꺼집니다.":
      "ノードはすぐに停止します。",
    "노드가 켜져 있는지 보시고, 잠시 뒤에 다시 눌러 주세요.":
      "ノードが起動しているか確認して、少し後にもう一度押してください。",
    "노드끼리 대화":
      "ノード同士の会話",
    "노드만 켭니다. 앱까지 저절로 켜지면 아무도 없는 방에서 지갑이 열립니다.":
      "ノードだけを起動します。アプリまで自動起動すると、誰もいない部屋でウォレットが開いてしまいます。",
    "누구에게":
      "誰に",
    "눌러서 보기":
      "押して見る",
    "다 됐습니다":
      "完了しました",
    "다른 일도 합니다":
      "ほかの作業にも使います",
    "다른 지갑":
      "別のウォレット",
    "다른 폴더 고르기…":
      "別のフォルダを選ぶ…",
    "다른 회사 · 내 컴퓨터의 AI":
      "他社・自分のパソコンのAI",
    "다시 감추기":
      "もう一度隠す",
    "다시 열기":
      "もう一度開ける",
    "다시 열었습니다.":
      "もう一度開けました。",
    "다시 엽니다":
      "もう一度開けます",
    "다시 읽어오기":
      "読み直す",
    "다시 켤 때까지 가게가 멈춥니다. 영업 중에는 누르지 마세요.":
      "再起動するまでお店は止まります。営業中には押さないでください。",
    "다시 확인":
      "もう一度確認",
    "다운로드 폴더":
      "ダウンロードフォルダ",
    "다음":
      "次へ",
    "단말기 임대료도 정산 대기도 없습니다.":
      "端末のレンタル料も精算待ちもありません。",
    "단어를 꺼내는 동안 이 컴퓨터에 임시 파일이 잠깐 생겼다가 지워집니다. SSD에서는 지운 흔적이 완전히 사라지지 않을 수 있습니다.":
      "単語を取り出す間、このパソコンに一時ファイルが少しの間できて削除されます。SSDでは削除の痕跡が完全には消えないことがあります。",
    "단위":
      "単位",
    "단추가 여덟 개까지입니다. 하나 지우고 다시 말씀해 주세요.":
      "ボタンは8個までです。1つ消してもう一度言ってください。",
    "닫기":
      "閉じる",
    "닫기 (Esc)":
      "閉じる（Esc）",
    "달러 ($)":
      "ドル（$）",
    "담아 따로 두십시오.":
      "入れて別に置いてください。",
    "답에 따라 이 프로그램이 컴퓨터를 얼마나 쓸지 정해집니다. 나머지는 알아서 맞춥니다.":
      "お答えによって、このプログラムがパソコンをどれだけ使うかが決まります。残りはこちらで調整します。",
    "대신":
      "その代わり",
    "대화방 이름 (상대와 미리 정한 것)":
      "ルーム名（相手と事前に決めたもの）",
    "더 찍기":
      "もっと発行",
    "덮어씁니다":
      "上書きします",
    "돈 받을 주소":
      "お金を受け取るアドレス",
    "돈·발행·설정 전부":
      "お金・発行・設定すべて",
    "돕니다.":
      "動きます。",
    "되돌리는 중…":
      "戻しています…",
    "되돌릴 백업을 고르세요":
      "戻すバックアップを選んでください",
    "되돌릴까요?":
      "戻しますか？",
    "되돌립니다":
      "戻します",
    "되읽기":
      "読み直す",
    "두 곳에 묻기":
      "2か所に聞く",
    "두 노드가 같은 지갑을 쓰면 같은 주소를 두 번 나눠 주고 돈을 잃습니다. 원래 컴퓨터가":
      "2つのノードが同じウォレットを使うと同じアドレスを二度配ってしまい、お金を失います。元のパソコンが",
    "뒤로":
      "戻る",
    "드나든 기록":
      "入退室の記録",
    "들어감":
      "含む",
    "들어오고 나간 것":
      "入ったもの・出たもの",
    "들어온 수익":
      "入ってきた収益",
    "들어온 주문":
      "届いた注文",
    "등록하면":
      "登録すると",
    "디스크 45 GB → 5 GB, 메모리와 연결도 줄입니다.":
      "ディスク45 GB → 5 GB、メモリと接続も減らします。",
    "따라잡음":
      "追いつき",
    "따로 있는 GPU 기계":
      "別にあるGPUマシン",
    "라비":
      "Ravi",
    "라비가 틀리게 답해요":
      "Raviの答えが間違っています",
    "라비를 깨웁니다":
      "Raviを起こします",
    "라비에게 묻기":
      "Raviに聞く",
    "레이븐 코어와 같은 주소록":
      "Ravencoin Coreと同じアドレス帳",
    "레이븐코인으로 받으면 뭐가 좋아?":
      "Ravencoinで受け取ると何が良い？",
    "로 고정됩니다.":
      "に固定されます。",
    "루트 자산":
      "ルートアセット",
    "를 적어 주세요. 앞부분이 화면과 같은지도 눈으로 맞춰 보세요.":
      "を入力してください。先頭部分が画面と同じかも目で確かめてください。",
    "를 한 번만 넣어 주세요.":
      "を一度だけ入力してください。",
    "만드는 것":
      "作るもの",
    "만드는 중…":
      "作成中…",
    "만들고 · 되돌리기":
      "作成・復元",
    "말로 불러 주세요":
      "口で読み上げてください",
    "말로 알려주면 화면을 채웁니다":
      "話していただければ画面を埋めます",
    "맞추는 중…":
      "照合中…",
    "매장 밖에서도 주문·판매 링크가 열립니다. Cloudflare를 지나갑니다.":
      "店舗の外からも注文・販売リンクが開きます。Cloudflareを経由します。",
    "매장·포장":
      "店内・持ち帰り",
    "매출 · 장부":
      "売上・台帳",
    "먼저 계산해 보기":
      "先に計算してみる",
    "먼저 연습해 보기":
      "先に練習してみる",
    "먼저 예약합니다":
      "先に予約します",
    "먼저 이름을 정해 주세요.":
      "先に名前を決めてください。",
    "메뉴 넣기":
      "メニューに入れる",
    "메뉴 넣을게요. 제가 부르는 대로 메뉴판에 넣어 주세요:":
      "メニューを入れます。私が読み上げるとおりにメニューへ入れてください：",
    "메뉴 지우기를 그만두었습니다":
      "メニューの削除をやめました",
    "메뉴가 하나도 없습니다":
      "メニューが一つもありません",
    "메뉴판":
      "メニュー",
    "메뉴판 올리기":
      "メニューを公開",
    "메모":
      "メモ",
    "모델":
      "モデル",
    "모든 폰을 끊을까요?":
      "すべての端末を切断しますか？",
    "무엇에 쓰실 것인지 한 줄만 더 적어 주세요.":
      "何に使うのか、もう一行だけ書いてください。",
    "무엇으로 줄까요":
      "何で配りますか",
    "무엇을":
      "何を",
    "무엇을 만들고 싶으신지 말로 적어 보세요":
      "何を作りたいか言葉で書いてみてください",
    "무엇을 만들고 싶으신지 한 줄만 적어 주세요.":
      "何を作りたいか、一行だけ書いてください。",
    "무엇을 만들까요":
      "何を作りましょうか",
    "무엇을 할까요? 아래를 누르거나, 그냥 말씀하세요.":
      "何をしましょうか？下を押すか、そのまま話しかけてください。",
    "무엇이 달라지나요":
      "何が変わりますか",
    "무엇이 잘못됐나요?":
      "何がうまくいきませんでしたか？",
    "무엇이든 물어봅니다. 화면은 안 건드립니다":
      "何でも聞けます。画面には触れません",
    "문":
      "ドア",
    "문 설정":
      "ドアの設定",
    "문 앞에 두는 화면":
      "ドアの前に置く画面",
    "문 저장":
      "ドアを保存",
    "문제 알리기":
      "問題を知らせる",
    "문제 알리기 창을 열었습니다":
      "問題を知らせる画面を開きました",
    "물어보기":
      "聞いてみる",
    "뭐든 물어보세요":
      "何でも聞いてください",
    "바깥에서 계산대까지 열기":
      "外からレジまで開く",
    "바깥에서도 열리게":
      "外からも開けるように",
    "바꾸기는 실패해도 지금 암호가 그대로 남고, 노드도 꺼지지 않습니다.":
      "変更に失敗しても現在のパスフレーズはそのまま残り、ノードも停止しません。",
    "바꿀 수 없습니다.":
      "変えられません。",
    "밖에서 주문하러 올 주소":
      "外から注文しに来るアドレス",
    "받기":
      "受け取る",
    "받는 분이 알려 준 원본":
      "受取人が知らせてくれた原本",
    "받는 주소":
      "受取アドレス",
    "받는 중…":
      "受信中…",
    "받은 것":
      "受け取ったもの",
    "받은 공지":
      "受け取ったお知らせ",
    "받은 금액":
      "受け取った金額",
    "받을 주소 만들기":
      "受取アドレスを作る",
    "받을 주소록":
      "受取アドレス帳",
    "발행 중…":
      "発行中…",
    "배달":
      "配達",
    "배당":
      "配当",
    "백업 둘 곳":
      "バックアップの保管先",
    "백업 만들기":
      "バックアップを作る",
    "백업본을 다른 컴퓨터에서 동시에 켜지 마세요.":
      "バックアップの控えを別のパソコンで同時に起動しないでください。",
    "백업에서 되돌리기":
      "バックアップから戻す",
    "번 돈 금고로 옮기기":
      "売上を金庫へ移す",
    "번호 · 시각":
      "番号・時刻",
    "보내기":
      "送る",
    "보내기 전 확인":
      "送る前の確認",
    "보내기가 안 돼요":
      "送金できません",
    "보내는 중…":
      "送信中…",
    "보내려면 그때 암호를 묻습니다":
      "送るときにパスフレーズを尋ねます",
    "보낸 것은 되돌릴 수 없습니다.":
      "送ったものは取り戻せません。",
    "보낸 공지는":
      "送ったお知らせは",
    "보낸 사람이 같은 돈을 다시 쓸 수 있습니다. 커피 한 잔은 1확인, 값비싼 물건은 더 기다리십시오.":
      "送った人が同じお金をもう一度使えます。コーヒー1杯なら1確認、高価な品物はもっと待ってください。",
    "보낸 주소":
      "送信元アドレス",
    "보낼 때마다 네트워크 수수료가 듭니다. 답장은 오지 않습니다 — 이건 방송입니다.":
      "送るたびにネットワーク手数料がかかります。返信は来ません — これは放送です。",
    "보낼 자산":
      "送るアセット",
    "보냈습니다. 고맙습니다.":
      "送りました。ありがとうございます。",
    "보유자 전원에게":
      "保有者全員へ",
    "보존 중…":
      "保管中…",
    "보존을 해제할까요?":
      "保管を解除しますか？",
    "보존하지 못했습니다":
      "保管できませんでした",
    "보존할 항목 없음":
      "保管する項目はありません",
    "보통 내가 가진 몫은 빼고 나눕니다.":
      "通常は自分の持ち分を除いて配ります。",
    "복구 단어":
      "復元用の単語",
    "복구 단어 12개는 어느 경우에도 클라우드에 올라가지 않습니다.":
      "復元用の12単語は、いかなる場合もクラウドには上がりません。",
    "복구 단어 보기":
      "復元用の単語を見る",
    "복구 카드 인쇄":
      "復元カードを印刷",
    "복사":
      "コピー",
    "복사가 안 됩니다":
      "コピーできません",
    "복사해서 위 칸에 붙여넣으세요.":
      "コピーして上の欄に貼り付けてください。",
    "복사했습니다":
      "コピーしました",
    "불러오기":
      "読み込む",
    "불러오는 중…":
      "読み込み中…",
    "붙는 곳":
      "かかるところ",
    "붙어 있는 클라우드나 외장 디스크가 없습니다.":
      "接続されたクラウドや外付けディスクがありません。",
    "브라우저를 열지 못했습니다":
      "ブラウザを開けませんでした",
    "브랜드 아래 상품 (하위)":
      "ブランド配下の商品（サブ）",
    "블록":
      "ブロック",
    "블록체인":
      "ブロックチェーン",
    "비우면 수량 × 10":
      "空欄にすると数量×10",
    "비워 두면 가게 목록에 이름만 보이고":
      "空欄にするとお店の一覧に名前だけが表示され、",
    "비워 두면 그 요일은 쉬는 날입니다. 닫는 시각이 여는 시각보다 이르면":
      "空欄にするとその曜日は定休日です。閉店時刻が開店時刻より早い場合は",
    "비워 두면 나에게도 보냅니다":
      "空欄にすると自分にも送ります",
    "사용 가능":
      "利用可能",
    "사장님만":
      "店主のみ",
    "사장님을 도울 때":
      "店主を手伝うとき",
    "사진 올리기":
      "写真をアップロード",
    "사진 저장":
      "写真の保存",
    "사진 찍지 마세요. 메모 앱에 적지 마세요. 남에게 보여주지 마세요.":
      "写真に撮らないでください。メモアプリに書かないでください。他人に見せないでください。",
    "상담 내용, 주의사항":
      "相談内容、注意事項",
    "상대가 켜져 있어야":
      "相手が起動している必要があり",
    "상태":
      "状態",
    "새 버전 확인":
      "新しいバージョンを確認",
    "새 암호 (10자 이상)":
      "新しいパスフレーズ（10文字以上）",
    "새 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "新しいパスフレーズを忘れると、お金とアセットは永久に失われます。",
    "새 이름을 체인에 새깁니다. RVN이 소각됩니다.":
      "新しい名前をチェーンに刻みます。RVNが焼却されます。",
    "새 자산 만들기":
      "新しいアセットを作る",
    "새 주소에 붙일 이름":
      "新しいアドレスに付ける名前",
    "새로고침":
      "再読み込み",
    "샘플 넣기":
      "サンプルを入れる",
    "샘플 사진 (IPFS에 올라가 있습니다)":
      "サンプル写真（IPFSに上がっています）",
    "생각하는 중…":
      "考えています…",
    "서로 다른 AI 두 곳에 같은 것을 묻습니다":
      "異なる2つのAIに同じことを聞きます",
    "서버 없이 두 컴퓨터가 직접 주고받습니다. 수수료도 없습니다.":
      "サーバーなしで2台のパソコンが直接やり取りします。手数料もかかりません。",
    "서울 강남구":
      "ソウル・江南区",
    "석 달":
      "3か月",
    "설정에서":
      "設定で",
    "설정에서 AI 열쇠를 넣으시면 라비가 골라 드립니다.":
      "設定でAIキーを入れるとRaviが選んでくれます。",
    "설정에서 API 키를 넣으면 켜집니다":
      "設定でAPIキーを入れるとオンになります",
    "설치 중…":
      "インストール中…",
    "세대":
      "世代",
    "세부 설정":
      "細かい設定",
    "셸리 스위치를 같은 공유기에 붙이고 셸리 앱에서 IP를 확인해 여기 적으세요. 열림 시간이 지나면":
      "Shellyスイッチを同じルーターに接続し、ShellyアプリでIPを確認してここに入力してください。開放時間が過ぎると",
    "셸리 아이디 · 비밀번호":
      "ShellyのID・パスワード",
    "셸리 주소":
      "ShellyのIPアドレス",
    "셸리에 걸어 둔 비밀번호":
      "Shellyに設定したパスワード",
    "소개":
      "紹介",
    "소비전력 (W)":
      "消費電力（W）",
    "소수점 자리":
      "小数点の桁",
    "손님":
      "お客様",
    "손님 QR":
      "お客様用QR",
    "손님 질문에 답할 때":
      "お客様の質問に答えるとき",
    "손님 폰 서버를 켜지 못했습니다.":
      "お客様の端末サーバーを起動できませんでした。",
    "손님 폰으로 받기":
      "お客様の端末で受ける",
    "손님 화면 맨 위가 빈 채로 뜹니다.":
      "お客様の画面の一番上が空のまま表示されます。",
    "손님 화면 보기":
      "お客様の画面を見る",
    "손님 화면에 보일 가게 소개를 써 주세요. 제 가게는":
      "お客様の画面に出るお店の紹介を書いてください。私のお店は",
    "손님에게 보일 글":
      "お客様に見せる文",
    "손님에게 보일 한마디 — 예: 재료가 떨어졌습니다":
      "お客様に見せる一言 — 例：材料が切れました",
    "손님에게 안 보입니다":
      "お客様には表示されません",
    "손님이 QR 을 찍어도 시킬 것이 없습니다.":
      "お客様がQRを読み取っても頼むものがありません。",
    "손님이 QR을 찍어 주문합니다. 같은 wifi 안에서 됩니다.":
      "お客様がQRを読み取って注文します。同じwifi内で動きます。",
    "손님이 걸 수 있는 번호":
      "お客様がかけられる番号",
    "손님이 낸 돈의":
      "お客様が払ったお金の",
    "손님이 더 내는 것이 아니라":
      "お客様が余分に払うのではなく",
    "손님이 시킨 것":
      "お客様が注文したもの",
    "손님이 주문할 수 있어요":
      "お客様が注文できます",
    "손님이 찾아올 수 있게 쓰세요":
      "お客様が来られるように書いてください",
    "수량":
      "数量",
    "수익 계산 · 켜고 끄기":
      "採算計算・起動と停止",
    "쉬는 날":
      "定休日",
    "쉬운 설정":
      "かんたん設定",
    "스위치가 스스로 닫습니다":
      "スイッチが自動で閉じます",
    "스위치가 이 값들을 대신 정합니다. 직접 만지실 때만 여세요.":
      "上のスイッチがこれらの値を代わりに決めます。ご自分で触るときだけ開いてください。",
    "시세를 못 가져왔습니다":
      "レートを取得できませんでした",
    "시작일":
      "開始日",
    "시험용 가게 만들기":
      "テスト用のお店を作る",
    "시험용 지우기":
      "テスト用を削除",
    "쓰세요.":
      "使ってください。",
    "쓰시는 대로 저장합니다. 나라마다 주소 모양이 달라서 쪼개지 않습니다.":
      "書かれたとおりに保存します。国によって住所の形が違うので分割しません。",
    "아래 문장을 그대로 입력하세요.":
      "下の文をそのまま入力してください。",
    "아래 버튼으로 만듭니다":
      "下のボタンで作ります",
    "아래 셋에는 열쇠가 들어 있습니다. 붙이지 말고, 찍을 때만 보여 주세요.":
      "下の3つには鍵が入っています。貼らずに、読み取るときだけ見せてください。",
    "아래 아이콘은 지금 바로 됩니다. 말로 시키시려면":
      "下のアイコンは今すぐ使えます。言葉で指示するには",
    "아무것도 안 고르면 바탕화면에 만듭니다.":
      "何も選ばなければデスクトップに作ります。",
    "아이스 아메리카노":
      "アイスアメリカーノ",
    "아이스 아메리카노 4500원 넣어줘":
      "アイスアメリカーノを4500ウォンで入れて",
    "아직 안 된 것":
      "まだできていないこと",
    "아직 안 된 것이 있습니다":
      "まだできていないことがあります",
    "아직 없습니다":
      "まだありません",
    "아직 정해지지 않았습니다":
      "まだ決まっていません",
    "안 건드리면 지금 그대로":
      "触らなければ今のまま",
    "안 붙는 곳":
      "かからないところ",
    "안 함":
      "含まない",
    "안녕하세요, 라비입니다.":
      "こんにちは、Raviです。",
    "알겠습니다":
      "わかりました",
    "암호 걸기":
      "パスフレーズを設定",
    "암호 바꾸기":
      "パスフレーズを変える",
    "암호 없음":
      "パスフレーズなし",
    "암호는":
      "パスフレーズは",
    "암호를 걸면":
      "パスフレーズを設定すると",
    "암호를 잊으면 되돌릴 수 없다":
      "パスフレーズを忘れたら元に戻せない",
    "약 47 GB":
      "約47 GB",
    "약 6 GB":
      "約6 GB",
    "어느 자산 보유자에게":
      "どのアセットの保有者に",
    "어느 화면인지·무슨 오류가 났는지는 제가 알아서 같이 보냅니다. 겪으신 것만 적어 주세요.":
      "どの画面か・どんなエラーかは私が一緒に送ります。起きたことだけ書いてください。",
    "어디":
      "場所",
    "어떤 자산의 보유자":
      "どのアセットの保有者",
    "언제 명단을 굳힐까요":
      "いつ名簿を確定しますか",
    "얼마":
      "いくら",
    "없어도 등록됩니다":
      "なくても登録できます",
    "에 두시면 찾아서 씁니다.":
      "に置けば、探して使います。",
    "에 있습니다. 아무도 갖고 있지 않으면 찾을 수 없게 됩니다 — 이 컴퓨터가 켜져 있으면 이 컴퓨터가 갖고 있습니다.":
      "にあります。誰も持っていないと見つけられなくなります — このパソコンが起動している間は、このパソコンが持っています。",
    "엑셀 파일로 내보내기":
      "表計算ファイルで書き出す",
    "여기서 시작합니다":
      "ここから始めます",
    "여는 시각과 닫는 시각을 둘 다 넣으셔야 나머지 요일에 옮길 수 있습니다.":
      "開店時刻と閉店時刻の両方を入れないと、ほかの曜日に移せません。",
    "여는 중…":
      "開いています…",
    "연결과 뒷일을 줄입니다":
      "接続と裏の処理を減らします",
    "연결만 확인":
      "接続だけ確認",
    "연습 시작":
      "練習を始める",
    "연습용 돈을 만드는 중…":
      "練習用のお金を作成中…",
    "연습용 체인을 켜는 중…":
      "練習用チェーンを起動中…",
    "열려 있음":
      "開いています",
    "열린 것과":
      "開いたものと",
    "열림 시간(초)":
      "開放時間（秒）",
    "열쇠 보기":
      "鍵を見る",
    "영업 중":
      "営業中",
    "영업시간":
      "営業時間",
    "영업하는 것으로 봅니다 — 밤 6시 열고 새벽 2시 닫기.":
      "営業していると見なします — 夜6時開店、深夜2時閉店。",
    "영원히":
      "永久に",
    "예: 강남에서 원두 직접 볶는 작은 카페, 포장만":
      "例：江南で豆を自家焙煎する小さなカフェ、持ち帰りのみ",
    "예: 보내기를 눌렀는데 아무 일도 없어요":
      "例：送るを押しても何も起きません",
    "예: 아메리카노 4500, 카페라떼 5000, 치즈케이크 6500":
      "例：アメリカーノ4500、カフェラテ5000、チーズケーキ6500",
    "예: 우리 헬스장 3개월 회원권을 30명한테 주고 싶어요":
      "例：うちのジムの3か月会員券を30人に配りたいです",
    "예약":
      "予約",
    "오늘":
      "今日",
    "오늘 얼마":
      "今日の売上",
    "오늘 팔 것만":
      "今日売る分だけを",
    "오래 걸립니다":
      "時間がかかります",
    "오래된 컴퓨터":
      "古いパソコン",
    "오래된 컴퓨터로 아끼기":
      "古いパソコンで節約する",
    "오류 없음":
      "エラーなし",
    "올린 파일은 이 컴퓨터가 보존합니다.":
      "アップロードしたファイルはこのパソコンが保管します。",
    "완전히 죽었을 때만":
      "完全に壊れたときだけ",
    "원 (₩)":
      "ウォン（₩）",
    "원두 20kg 다음 주에 가능할까요?":
      "豆20kgを来週お願いできますか？",
    "원두를 직접 볶는 작은 카페":
      "豆を自家焙煎する小さなカフェ",
    "원두를 직접 볶는 작은 카페입니다":
      "豆を自家焙煎する小さなカフェです",
    "원래대로":
      "元に戻す",
    "원본의 끝 4자리":
      "原本の末尾4文字",
    "월요일 시간을 나머지 요일에도":
      "月曜日の時間をほかの曜日にも",
    "월요일부터 채워 주세요":
      "まず月曜日を埋めてください",
    "위에 있는 곳부터 씁니다. 막히거나 실패하면 아래로 넘어갑니다.":
      "上にあるところから使います。詰まったり失敗したら下へ移ります。",
    "위에 적힌 이름을 직접 입력":
      "上に書かれた名前を入力",
    "위의":
      "上の",
    "으로 갑니다. 컴퓨터를 잃어버려도 거기 있는 돈은 무사합니다.":
      "へ行きます。パソコンを失っても、そこにあるお金は無事です。",
    "을 같이 남깁니다 — \"왜 안 열렸지\"가 카운터에서 제일 자주 나오는 질문입니다.":
      "を両方記録します —「なぜ開かなかったのか」はカウンターで最も多い質問です。",
    "을 해야 고쳐집니다 — 빠른 터널 주소는 켤 때마다 바뀌니 임시로만 쓰세요.":
      "が必要です — 簡易トンネルのアドレスは起動のたびに変わるので、一時的にだけ使ってください。",
    "이 가격에 내놓기":
      "この価格で出す",
    "이 금액(RVN)을 넘으면":
      "この金額（RVN）を超えたら",
    "이 기능만 이 컴퓨터 밖으로 나갑니다.":
      "この機能だけがこのパソコンの外に出ます。",
    "이 노드":
      "このノード",
    "이 단어를 아는 사람은 지갑 전부를 가져갈 수 있습니다.":
      "この単語を知っている人はウォレットのすべてを持ち去れます。",
    "이 목록은":
      "この一覧は",
    "이 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "このパスフレーズを忘れると、お金とアセットは永久に失われます。",
    "이 앱과 레이븐 코어는 같은 지갑을 씁니다. 동시에 열 수 없습니다.":
      "このアプリとRavencoin Coreは同じウォレットを使います。同時には開けません。",
    "이 앱도, 레이븐코인도, 누구도 되돌릴 수 없습니다. 복구 방법이 없습니다.":
      "このアプリも、Ravencoinも、誰も元に戻せません。復旧方法はありません。",
    "이 이름으로 해 보기":
      "この名前で試す",
    "이 이름은 체인에 영구히 남고 누구도 다시 쓸 수 없습니다. 그대로 다시 입력하세요.":
      "この名前はチェーンに永久に残り、誰も再利用できません。そのまま再入力してください。",
    "이 이름을 아는 사람은 누구나 들을 수 있습니다. 비밀 대화가 아닙니다.":
      "この名前を知っている人は誰でも聞けます。秘密の会話ではありません。",
    "이 자물쇠의 열쇠":
      "この錠前の鍵",
    "이 주소는 내 지갑입니다.":
      "このアドレスは自分のウォレットです。",
    "이 주소는 체인에 올라가므로, 바뀌면":
      "このアドレスはチェーンに載るため、変わったら",
    "이 지갑의 주소만 씁니다. 직접 입력하지 않는 이유는, 잘못 붙여넣으면 매출이 남에게 갑니다.":
      "このウォレットのアドレスのみを使います。直接入力させないのは、貼り間違えると売上が他人に行くからです。",
    "이 컴퓨터":
      "このパソコン",
    "이 컴퓨터 → AI 열쇠":
      "このパソコン → AIキー",
    "이 컴퓨터 안의 사본은 잠그지 않습니다 — 여기 있는 사람은 이미 지갑을 가졌으므로 잠가도 얻는 것이 없습니다.":
      "このパソコン内の控えはロックしません — ここにいる人はすでにウォレットを持っているので、ロックしても得るものがありません。",
    "이 컴퓨터, 가게에만 쓰시나요?":
      "このパソコンはお店専用ですか？",
    "이 컴퓨터가 아닌 곳에 두세요.":
      "このパソコン以外の場所に置いてください。",
    "이 컴퓨터로 캐지 않습니다.":
      "このパソコンでは掘りません。",
    "이 컴퓨터로도 캐기":
      "このパソコンでも掘る",
    "이 컴퓨터를 보고 제가 정해 드릴게요.":
      "このパソコンを見て私が決めますね。",
    "이 컴퓨터를 쓸 수 있는 사람은 지갑도 쓸 수 있습니다":
      "このパソコンを使える人はウォレットも使えます",
    "이 컴퓨터에 맞게 살펴보는 중…":
      "このパソコンに合わせて確認中…",
    "이 컴퓨터에 보존":
      "このパソコンに保管",
    "이 컴퓨터에만":
      "このパソコンにだけ",
    "이 컴퓨터에서 사본이 사라집니다. 다른 곳에 사본이 없으면 되찾을 수 없습니다.":
      "このパソコンの控えが消えます。他に控えがなければ取り戻せません。",
    "이 컴퓨터에서 열지 못했습니다":
      "このパソコンで開けませんでした",
    "이 컴퓨터의 파일 창고에서만 찾습니다. 내가 가진 자산 목록을 바깥으로 보내지 않습니다.":
      "このパソコンのファイル倉庫だけを探します。所有アセットの一覧を外に送ることはありません。",
    "이것 없이는 클라우드 사본을 못 엽니다.":
      "これがないとクラウドの控えは開けません。",
    "이대로 시작하기":
      "このまま始める",
    "이대로 켜기":
      "この設定で始める",
    "이라 돈이 안 나가고, 마음에 안 들면 지우고 다시 하시면 됩니다.":
      "なのでお金は出ていかず、気に入らなければ消してやり直せます。",
    "이름":
      "名前",
    "이름 (지점명)":
      "名前（支店名）",
    "이름 · 사진 · 주소 · 영업시간 · 등록":
      "名前・写真・住所・営業時間・登録",
    "이름 하나면 시작됩니다. 나머지는 나중에 채우셔도 됩니다.":
      "名前が一つあれば始められます。残りは後で埋めても大丈夫です。",
    "이름·전화 뒷자리·회원번호 아무거나 치면 됩니다.":
      "名前・電話番号の下4桁・会員番号のどれでも入力できます。",
    "이름이 체인에 영구히 남고 RVN이 소각됩니다. 이름을 그대로 입력하세요.":
      "名前がチェーンに永久に残り、RVNが焼却されます。名前をそのまま入力してください。",
    "이미 들어 있는 것이 있습니다":
      "すでに入っているものがあります",
    "이미 만들어진 잠긴 백업은 그대로 남습니다.":
      "すでに作られたロック済みバックアップはそのまま残ります。",
    "이번 주 휴무 안내":
      "今週の休業のお知らせ",
    "읽기 전용":
      "読み取り専用",
    "읽는 중…":
      "読み込み中…",
    "입니다. 여기서 붙인 이름이 코어에도 보이고, 코어에서 붙인 이름이 여기 보입니다.":
      "です。ここで付けた名前はCoreにも表示され、Coreで付けた名前はここに表示されます。",
    "자격 배지":
      "資格バッジ",
    "자격 증명":
      "資格証明",
    "자동 발송 켜기":
      "自動発送をオンにする",
    "자동 확인 (30초)":
      "自動確認（30秒）",
    "자산":
      "アセット",
    "자산 만들기":
      "アセットを作る",
    "자산 보내기":
      "アセットを送る",
    "자산 이름":
      "アセット名",
    "자산에 붙은 그림·음악은 체인이 아니라":
      "アセットに付いた画像・音楽はチェーンではなく",
    "자산을 가진 사람 전원에게 갑니다. 답장은 받을 수 없습니다.":
      "アセットを持つ全員に届きます。返信は受け取れません。",
    "자산을 가진 사람들에게 나눠 줍니다. 회원권·조합원 토큰에 씁니다.":
      "アセットを持つ全員に配ります。会員券・組合員トークンに使います。",
    "자산을 발행하려면 지갑을 열어야 합니다.":
      "アセットを発行するにはウォレットを開く必要があります。",
    "자산을 불러오는 중…":
      "アセットを読み込み中…",
    "자산을 하나 만들려고 합니다. 무엇을 물어봐야 하는지부터 알려 주세요.":
      "アセットを一つ作りたいです。まず何を聞かれるべきか教えてください。",
    "자정 넘겨 영업":
      "日をまたいで営業",
    "자정을 넘겨":
      "日付をまたいで",
    "잠겨 있을 때만":
      "ロックされている間だけ",
    "잠금":
      "ロック",
    "장비 이름":
      "機材の名前",
    "재발행 가능":
      "再発行可能",
    "재발행(RVN 소각)":
      "再発行（RVN焼却）",
    "재발행을 껐으므로 수량과 파일을 영원히 못 바꿉니다":
      "再発行をオフにしたので、数量とファイルは永久に変えられません",
    "저장":
      "保存",
    "저장 중…":
      "保存中…",
    "저장됩니다 — 체인에 올리면 지울 수 없고, 누구나 회원 명단과 계약 종료일을 볼 수 있게 됩니다.":
      "— チェーンに載せると消せなくなり、誰でも会員名簿と契約終了日を見られるようになります。",
    "저장하고 다시 켜기 안내":
      "保存して再起動する案内",
    "저장했습니다":
      "保存しました",
    "저장했습니다.":
      "保存しました。",
    "전기값이 더 나갈 수 있습니다.":
      "電気代のほうが高くつくことがあります。",
    "전기요금 (원/kWh)":
      "電気料金（ウォン/kWh）",
    "전부 이 컴퓨터에 둡니다":
      "すべてこのパソコンに置きます",
    "전원이 돌아오면 노드가 저절로 켜집니다. 앱은 켜지지 않습니다.":
      "電源が戻るとノードは自動で起動します。アプリは起動しません。",
    "전체":
      "すべて",
    "전체 명단":
      "全員の名簿",
    "전체 얼마":
      "合計いくら",
    "전화":
      "電話",
    "정문":
      "正面ドア",
    "정전 뒤 자동으로 켜기":
      "停電後に自動で起動する",
    "제 일도 하는 컴퓨터입니다. 꼭 필요한 만큼만 쓰게 합니다.":
      "ご自身の仕事にも使うパソコンです。必要な分だけ使います。",
    "제가 정해 드려요":
      "私が決めます",
    "제목":
      "件名",
    "제한 자산":
      "制限付きアセット",
    "종류":
      "種類",
    "종이에 적어":
      "紙に書いて",
    "종이에 적어 12단어와 같이 보관하세요.":
      "紙に書いて12単語と一緒に保管してください。",
    "좌표 (선택)":
      "座標（任意）",
    "주문 버튼이 안 생깁니다.":
      "注文ボタンは表示されません。",
    "주문·계산이 안 돼요":
      "注文・会計ができません",
    "주문·회원확인만":
      "注文・会員確認のみ",
    "주문마다 자동으로 만들어지는 주소는 목록에 넣지 않습니다 — 하루 장사하면 수십 줄이 되어 직접 붙인 이름이 묻힙니다.":
      "注文ごとに自動生成されるアドレスはこの一覧に入れません — 一日商売すると数十行になり、自分で付けた名前が埋もれます。",
    "주문마다 주소가 따로 생깁니다. 그 주소로 들어온 돈만 그 주문의 결제입니다.":
      "注文ごとに別のアドレスが作られます。そのアドレスに届いたお金だけがその注文の支払いです。",
    "주소":
      "住所",
    "주소 만들고 폰 여는 중…":
      "アドレスを作って端末を開いています…",
    "주소 만들기":
      "アドレスを作る",
    "주소를 만들지 못했습니다":
      "アドレスを作れませんでした",
    "주소를 복사했습니다":
      "アドレスをコピーしました",
    "주소를 복사했습니다. 브라우저에 붙여넣어 확인하세요.":
      "アドレスをコピーしました。ブラウザに貼り付けて確認してください。",
    "주소를 읽지 못했습니다":
      "アドレスを読み取れませんでした",
    "준비됐습니다. 「이 이름으로 해 보기」를 눌러 보세요.":
      "準備できました。「この名前で試す」を押してみてください。",
    "지갑":
      "ウォレット",
    "지갑 12단어·열쇠·주소·잔액은 보내지 않습니다.":
      "ウォレットの12単語・鍵・アドレス・残高は送りません。",
    "지갑 암호":
      "ウォレットのパスフレーズ",
    "지갑 잠금":
      "ウォレットのロック",
    "지갑 파일도 같이 올라가지만, 잠겨 있어서 클라우드 계정이 털려도 열 수 없습니다.":
      "ウォレットファイルも一緒に上がりますが、ロックされているのでクラウドのアカウントが破られても開けません。",
    "지갑에 암호 걸기":
      "ウォレットにパスフレーズを設定",
    "지갑을 열지 못했습니다":
      "ウォレットを開けませんでした",
    "지갑이 안 열려요":
      "ウォレットが開きません",
    "지갑이 잠겨 있습니다. 이 한 번만 열고 곧바로 다시 잠급니다.":
      "ウォレットはロックされています。この一度だけ開き、すぐに再ロックします。",
    "지갑이 잠깐 열립니다.":
      "ウォレットが一時的に開きます。",
    "지금 결제를 바로 확인합니다":
      "支払いをすぐ確認できます",
    "지금 닫기":
      "今すぐ閉める",
    "지금 닫기 (시간표보다 우선)":
      "今すぐ閉める（営業時間より優先）",
    "지금 상태":
      "今の状態",
    "지금 설치할까요?":
      "今インストールしますか？",
    "지금 쓰는 암호":
      "現在のパスフレーズ",
    "지금 쓸 곳":
      "今使うところ",
    "지금 잠그기":
      "今すぐロック",
    "지금 켜기":
      "今すぐオンにする",
    "지금 터널 주소 넣기":
      "今のトンネルアドレスを入れる",
    "지금은 닫혀 있습니다":
      "今は閉まっています",
    "지금은 암호 없이 보낼 수 있는 상태입니다. 자리를 비우기 전에 잠그세요.":
      "今はパスフレーズなしで送れる状態です。席を離れる前にロックしてください。",
    "지금이 최신입니다.":
      "これが最新です。",
    "지도 앱에서 복사해 붙여넣기":
      "地図アプリからコピーして貼り付け",
    "지도 주소를 복사했습니다. 브라우저에 붙여넣으세요.":
      "地図のリンクをコピーしました。ブラウザに貼り付けてください。",
    "지도에서 확인":
      "地図で確認",
    "지우고 처음부터":
      "消して最初から",
    "지우는 중…":
      "削除中…",
    "지울 수 없습니다.":
      "消せません。",
    "지웁니다":
      "削除します",
    "지웠습니다. 「연습 시작」부터 다시 하시면 됩니다.":
      "消しました。「練習を始める」からやり直せます。",
    "지점 이름 · 손님 폰 연결 · 백업 · 금고 — 매일 여실 필요 없어요":
      "支店名・お客様端末の接続・バックアップ・金庫 — 毎日開く必要はありません",
    "지킬 것이 없습니다":
      "保管するものがありません",
    "지킵니다. 자동 판매를 켜면 잠금이 풀리고, 그동안은 암호가 없는 것과 같습니다.":
      "守ります。自動販売をオンにするとロックが解除され、その間はパスフレーズがないのと同じです。",
    "직원":
      "スタッフ",
    "직원 폰도 같이 끊깁니다. 새 QR을 다시 찍어야 합니다.":
      "スタッフの端末も一緒に切れます。新しいQRを読み直す必要があります。",
    "직접 입력":
      "直接入力",
    "진짜 지갑은 건드리지 않습니다.":
      "本物のウォレットには触れません。",
    "진짜로 보내기":
      "本当に送る",
    "진짜와 똑같이 한 번 해 보실 수 있습니다.":
      "本番とまったく同じように一度試せます。",
    "찾는 중…":
      "探しています…",
    "채굴":
      "マイニング",
    "채굴 · 그냥 보내기 · 자산 발행":
      "マイニング・通常の送金・アセット発行",
    "채굴 켜기":
      "マイニングを開始",
    "채굴기 실행 파일 이름":
      "マイナーの実行ファイル名",
    "채널":
      "チャンネル",
    "채웠습니다. 고쳐서 쓰세요.":
      "埋めました。直してお使いください。",
    "처음 보내는 주소입니다.":
      "初めて送るアドレスです。",
    "처음 한 번 하는 것들":
      "最初の一度だけすること",
    "체인에 가게를 등록하지 않았습니다":
      "お店をチェーンに登録していません",
    "체인에 남을 이름":
      "チェーンに残る名前",
    "체인에 영구히 남고 누구나 볼 수 있습니다.":
      "チェーンに永久に残り、誰でも見られます。",
    "체인에 저장되는 이름은 영문 대문자만 가능합니다. 손님이 보는 이름은 위에 적은 것입니다.":
      "チェーンに保存される名前は英大文字のみです。お客様が見るのは上に入力した名前です。",
    "체인에서 직접 확인하실 수 있습니다. 카드 수수료(2~3%)와 달리":
      "チェーンで直接確認できます。カード手数料（2〜3%）と違って",
    "체인은 지나간 순간의 명단을 되돌려주지 않습니다. 먼저 예약해야 그 블록이 지날 때 명단이 굳습니다.":
      "チェーンは過ぎた時点の名簿を返してくれません。先に予約しておくと、そのブロックが過ぎた時に名簿が確定します。",
    "최근 거래":
      "最近の取引",
    "출입 · 회원":
      "入退室・会員",
    "취소":
      "キャンセル",
    "치즈케이크":
      "チーズケーキ",
    "카운터에 붙이는 것":
      "カウンターに貼るもの",
    "카운터에 붙이세요. 이 QR 에는 열쇠가 없어 누가 봐도 괜찮습니다.":
      "カウンターに貼ってください。このQRには鍵が入っていないので誰が見ても大丈夫です。",
    "카페라떼":
      "カフェラテ",
    "칸이 비어 있어요. 키를 붙여넣고 다시 눌러 주세요.":
      "欄が空です。キーを貼り付けてもう一度押してください。",
    "캘 기계의 그래픽카드":
      "掘るマシンのグラフィックカード",
    "커피값을 4500원으로 올릴까?":
      "コーヒーの値段を4500ウォンに上げますか？",
    "컴퓨터가 죽으면 이 열쇠도 같이 사라집니다.":
      "パソコンが壊れると、この鍵も一緒に消えます。",
    "컴퓨터를 살펴보는 중…":
      "パソコンを確認中…",
    "켜 두시길 권합니다.":
      "オンのままをおすすめします。",
    "켜기":
      "オンにする",
    "켜면 QR 네 개가 나옵니다 — 사장님·직원·검표·손님.":
      "オンにするとQRが4つ出ます — 店主・スタッフ・検札・お客様。",
    "쿠폰 · 회원권":
      "クーポン・会員券",
    "쿠폰 · 회원권 · 굿즈":
      "クーポン・会員券・グッズ",
    "클라우드":
      "クラウド",
    "클라우드로 나가는 파일은 저희가 한 번 더 잠급니다.":
      "クラウドへ出すファイルは私たちがもう一度ロックします。",
    "키 (없으면 비움)":
      "キー（なければ空欄）",
    "테이블마다 다른 QR 을 인쇄하려면":
      "テーブルごとに違うQRを印刷するには",
    "파일":
      "ファイル",
    "파일 고르기":
      "ファイルを選ぶ",
    "파일 지키기":
      "ファイルを守る",
    "파일 창고(IPFS)":
      "ファイル倉庫（IPFS）",
    "파일을 고르면 여기 자동으로 채워집니다":
      "ファイルを選ぶとここが自動で埋まります",
    "파일을 안 붙이셨습니다 — 나중에 붙이려면 재발행이 켜져 있어야 합니다":
      "ファイルを添付していません — 後から添付するには再発行がオンである必要があります",
    "파일이 자산의 얼굴입니다. 없어도 발행은 됩니다.":
      "ファイルはアセットの顔です。なくても発行はできます。",
    "파일창고":
      "ファイル倉庫",
    "파일창고 꺼짐":
      "ファイル倉庫は停止中",
    "파일창고 켜짐":
      "ファイル倉庫は稼働中",
    "판":
      "版",
    "판매중":
      "販売中",
    "팔고 있는 것":
      "販売中のもの",
    "팔기":
      "販売する",
    "팔린 자산을 보내려면":
      "売れたアセットを送るには",
    "폰을 같은 와이파이에 붙이고 찍으세요":
      "端末を同じwifiにつないで読み取ってください",
    "폰을 잃어버렸어요":
      "端末をなくしました",
    "풀":
      "プール",
    "품목 추가":
      "品目を追加",
    "프로그램이 다시 시작합니다. 손님이 주문 중이면 그 화면이 끊깁니다.":
      "プログラムが再起動します。お客様が注文中ならその画面が切れます。",
    "프로그램이 안 켜져요":
      "プログラムが起動しません",
    "하고, 지나간 말은 남지 않습니다. 손님 폰에는 닿지 않습니다 — 그쪽은 위의 공지나 매장 wifi를 씁니다.":
      "、過ぎた発言は残りません。お客様の端末には届きません — そちらは上のお知らせか店内wifiを使います。",
    "하루 200번까지 옵니다. 싸고 빠른 곳이 위로 오는 게 유리합니다.":
      "1日200件まで来ます。安くて速いところを上にするのが有利です。",
    "하루 자동 발송 한도 (수량)":
      "1日の自動発送上限（数量）",
    "하위 자산":
      "サブアセット",
    "한 번 더":
      "もう一度",
    "한 번 켜면 되돌릴 수 없습니다.":
      "一度オンにすると元に戻せません。",
    "한 번 하는 일":
      "一度だけの作業",
    "한 사람에 하나 (유니크)":
      "一人に一つ（ユニーク）",
    "한국어 — 강남 카페":
      "韓国語 — 江南カフェ",
    "한도는 판매를 막는 것이 아니라, 뭔가 잘못됐을 때 손실이 멈추는 선입니다. 하루 100개 팔 생각이면 100으로 두세요.":
      "上限は販売を止めるためではなく、何かがおかしくなったときに損失が止まる線です。1日100個売るつもりなら100にしてください。",
    "한쪽만 적혀서 저장되지 않습니다":
      "片方だけなので保存されません",
    "할 말":
      "伝えたいこと",
    "해시레이트 (MH/s)":
      "ハッシュレート（MH/s）",
    "해제하지 못했습니다":
      "解除できませんでした",
    "해제합니다":
      "解除します",
    "홍길동 · 5678 · A7K2":
      "山田太郎・5678・A7K2",
    "화면":
      "画面",
    "화면 문제":
      "画面の問題",
    "화면 채우기":
      "画面を埋める",
    "확인":
      "OK",
    "확인 불가":
      "確認できません",
    "확인 수가 0이면 아직":
      "確認数が0ならまだ",
    "확인 중…":
      "確認中…",
    "확인하지 못했습니다. 인터넷을 확인해 주세요.":
      "確認できませんでした。インターネットを確認してください。",
    "회원 등록":
      "会員を登録",
    "회원권 번호":
      "会員券番号",
    "회원번호를 체인에 하나 찍습니다 (":
      "会員番号をチェーンに1つ刻みます（",
    "횟수":
      "回数",
    "횟수권 (10회 등)":
      "回数券（10回など）",
  },
  zh: {
    "(문자·영수증·카운터 화면)을 보시고, 그":
      "（短信、收据、柜台屏幕），然后输入其",
    "). 이름·기간·정지는":
      "）。姓名、期限、暂停",
    ", 받으신 금액에서 나뉩니다.":
      "，而是从您收到的金额中分出。",
    ", 키 없음.":
      "，无需密钥。",
    "1 (고유)":
      "1（唯一）",
    "1. 명단을 굳힐 때를 정합니다":
      "1. 决定何时锁定名单",
    "10분 뒤":
      "10分钟后",
    "127.0.0.1:8766 · 쿠키 인증":
      "127.0.0.1:8766 · Cookie 认证",
    "1개월":
      "1个月",
    "1년":
      "1年",
    "1세대":
      "第1代",
    "1시간 뒤":
      "1小时后",
    "2. 예약해 둔 것":
      "2. 已预约的",
    "20초 안에 열리지 않았습니다.":
      "20 秒内没有打开。",
    "2세대":
      "第2代",
    "3. 나눠 주기":
      "3. 分发",
    "30일":
      "30天",
    "3개월":
      "3个月",
    "5 RVN · 약 17원":
      "5 RVN · 约17韩元",
    "6개월":
      "6个月",
    "6시간 뒤":
      "6小时后",
    "7일":
      "7天",
    "9월 20일 하루 쉽니다":
      "9月20日休息一天",
    "AI 도우미":
      "AI 助手",
    "AI 열쇠":
      "AI 密钥",
    "AI로 채우기":
      "用 AI 填写",
    "GPU를 몇 %로 쓸까요":
      "使用显卡的百分之几",
    "IPFS 게이트웨이":
      "IPFS 网关",
    "Ollama는":
      "Ollama",
    "PLAY X Raven 백업":
      "PLAY X Raven 备份",
    "PLAYX 수수료":
      "PLAYX 手续费",
    "RVN 또는 자산 이름":
      "RVN 或资产名称",
    "RVN 보내기":
      "转出 RVN",
    "Ravi에게 물어보기":
      "问问 Ravi",
    "USB 는 잃어버리고, 빌려주고, 꽂아 둔 채로 자리를 비웁니다 — 주운 사람이 가게 돈을 가져갑니다.":
      "U 盘会丢失、被借走、插着就离开座位 —— 捡到的人会拿走店里的钱。",
    "USB 백업도 잠그기":
      "U 盘备份也加锁",
    "playx-도매-2026":
      "playx-批发-2026",
    "— 돈이 들지 않습니다":
      "—— 不花钱",
    "— 이 프로그램이 꺼져 있어도 그렇습니다.":
      "—— 即使本程序已关闭也是如此。",
    "— 화면을 보고 적으시면 이 확인이 아무 소용이 없기 때문입니다.":
      "—— 如果照着屏幕抄，这道确认就毫无意义。",
    "← 가게":
      "← 店铺",
    "「먼저 계산해 보기」로 몇 명에게 얼마가 가는지 확인한 뒤에만 보내기가 열립니다.":
      "只有先用“先试算”确认有多少人、各得多少之后，发送才会解锁。",
    "中文 (선택)":
      "中文（可选）",
    "日本語 (선택)":
      "日语（可选）",
    "가 생깁니다. 안 넣어도 가게는 보입니다.":
      "。不填也能显示店铺。",
    "가 이 프로그램을 만드는 곳으로 갑니다. 나머지 99%는 사장님 지갑으로 바로 들어옵니다.":
      "归开发本程序的一方。其余 99% 直接进入您的钱包。",
    "가 캐고 수익만 이 지갑으로 옵니다.":
      "负责挖矿，只有收益进入这个钱包。",
    "가게":
      "店铺",
    "가게 결제 · 벤딩머신 · 중고 물건 사기":
      "店铺收款 · 自动售货机 · 购买二手物品",
    "가게 등록":
      "注册店铺",
    "가게 만들기":
      "创建店铺",
    "가게 소개":
      "店铺简介",
    "가게 이름 (손님이 읽는 이름)":
      "店名（顾客看到的名称）",
    "가게 이름이 비어 있습니다":
      "店名是空的",
    "가게 정보":
      "店铺信息",
    "가게 정보 · 처음 한 번":
      "店铺信息 · 只需设置一次",
    "가게·브랜드 (루트)":
      "店铺 / 品牌（根）",
    "가게가 받은 총액입니다. 부가세 구분과 과세 여부는 사업자 유형에 따라 달라서 여기서 계산하지 않습니다 — 세무 담당자에게 이 파일을 그대로 주시면 됩니다.":
      "这是店铺收到的总额。增值税处理因经营主体类型而异，我们不在此计算 —— 把这个文件原样交给会计即可。",
    "가게부터 만들까요?":
      "先来创建您的店铺吧？",
    "가게에만 씁니다":
      "只用于店里",
    "가격":
      "价格",
    "가격 단위":
      "价格单位",
    "가끔 씁니다. 잘하는 곳이 위로 오는 게 유리합니다.":
      "偶尔使用。把能力强的排在上面更划算。",
    "가는 자리":
      "去向",
    "가볍게 시작합니다":
      "轻量启动",
    "가짜 체인":
      "模拟链",
    "간판 사진":
      "门头照片",
    "강남 로스터리":
      "江南烘焙坊",
    "강남지점 · 2층 계산대":
      "江南分店 · 二楼收银台",
    "같은 와이파이 주문은 됩니다. 다만 가게 목록에는 안 뜹니다.":
      "同一 wifi 下点单仍可用。只是不会出现在店铺列表中。",
    "같이 보내는 것":
      "一并发送的内容",
    "개를 지키는 중":
      "个文件正在保存",
    "개발비 1%":
      "开发费 1%",
    "거리와 길찾기":
      "距离和导航",
    "거절된 것":
      "被拒绝的",
    "건의 오류":
      "个错误",
    "검토":
      "核对",
    "검표 태블릿":
      "验票平板",
    "결제가 아닙니다.":
      "还不算付款。",
    "계산대 컴퓨터로는":
      "用收银电脑挖矿，",
    "계산대·주문만 돌리는 컴퓨터입니다. 장부를 전부 갖고 있어 가장 빠릅니다.":
      "只运行收银和点单的电脑。保存完整账本，速度最快。",
    "계산대에 남길 돈(RVN)":
      "留在收银台的金额（RVN）",
    "계산대에 하루치가 쌓입니다. 정해 둔 금액을 넘으면 남는 돈이 자동으로":
      "收银台会积累一天的营业款。超过您设定的金额后，多余的钱会自动转到",
    "고급 — 채굴 · AI 키 · 세부 설정":
      "高级 —— 挖矿 · AI 密钥 · 详细设置",
    "고유 여러 개":
      "多个唯一资产",
    "고유 자산":
      "唯一资产",
    "고유 자산은 하나뿐입니다. 수량은":
      "唯一资产只有一个。数量固定为",
    "고치기":
      "修改",
    "고치러 가기":
      "去处理",
    "공지":
      "公告",
    "공지 보내기":
      "发送公告",
    "구글·애플 지도에서 가게를 길게 눌러 좌표를 복사한 뒤 여기 붙이세요. 넣으면 손님 화면에":
      "在谷歌或苹果地图上长按您的店铺，复制坐标粘贴到这里。填入后顾客界面会出现",
    "굳은 명단":
      "已锁定的名单",
    "그건 종이(복구 카드)나 비밀번호 금고에 두세요.":
      "请把它们放在纸上（恢复卡）或密码保险库中。",
    "그냥 묻기":
      "随便问",
    "그동안 이 컴퓨터의 다른 프로그램도 지갑을 쓸 수 있습니다. 가게용 지갑은":
      "在此期间，本机的其他程序也能使用钱包。请让店铺钱包只存放",
    "그래도 소량이나마 레이븐에 기여하고 싶을 때 켜세요. 채굴기는 우리가 넣어 두지 않았습니다 — 백신이 채굴기를 악성코드로 잡는 일이 흔해서, 넣으면 앱 전체가 격리됩니다. 아래에서 받아":
      "如果您仍想为 Ravencoin 出一份力，可以开启。我们没有内置挖矿程序 —— 杀毒软件常把挖矿程序判定为恶意软件，内置会导致整个应用被隔离。请从下方下载并放入",
    "그래도 전부 보관하기":
      "仍然全部保存",
    "그만두기":
      "取消",
    "금고 주소 (이 컴퓨터가 아닌 지갑)":
      "金库地址（本机以外的钱包）",
    "금고 주소는 켤 때 고정됩니다.":
      "金库地址在开启时即被固定。",
    "금액":
      "金额",
    "기간":
      "期限",
    "기간권 (한달·정기)":
      "期限卡（按月·定期）",
    "기본값으로":
      "恢复默认",
    "기본값으로 되돌렸습니다.":
      "已恢复默认值。",
    "기본으로":
      "恢复默认",
    "꺼 둡니다":
      "保持关闭",
    "꺼두면 수량과 설정을":
      "关闭后，数量和设置将",
    "꺼짐":
      "已关闭",
    "끄기":
      "关闭",
    "끄려면 체인을 처음부터 다시 받아야 합니다(몇 시간).":
      "若要关闭，需要从头重新下载整条链（数小时）。",
    "끄면 바깥 주소로는 손님 화면만 열립니다. 켜면 사장·직원 화면도 열립니다.":
      "关闭时，外部地址只能打开顾客界面。开启后，店主和员工界面也能打开。",
    "끄시면 열쇠 없이 바로 쓸 수 있지만, 그 USB 하나가 곧 지갑입니다.":
      "关闭后无需密钥即可直接使用，但那一支 U 盘就等于钱包本身。",
    "끊습니다":
      "断开",
    "끝 네 글자":
      "最后四位",
    "끝 네 글자를 일부러 가려 두었습니다":
      "我们特意隐藏了最后四位",
    "끝나는 날":
      "结束日期",
    "나머지는 전부 127.0.0.1 안에서 돕니다. 입력한 문장만 가고, 지갑·개인키·자산 목록은 보내지 않습니다.":
      "其余全部在 127.0.0.1 内运行。只发送您输入的语句，不发送钱包、私钥和资产清单。",
    "나에게는 안 보내기":
      "不发给我自己",
    "나중에 더 발행할 수 있게 (재발행 가능)":
      "允许日后追加发行（可再发行）",
    "남은 블록":
      "剩余区块",
    "남이 이 컴퓨터를 만져도 목적지를 바꿀 수 없고, 사장님 지갑으로 보내는 것만 할 수 있습니다. 주소를 바꾸려면 지갑 암호가 필요합니다.":
      "即使他人接触这台电脑也无法更改目的地，只能转到您的钱包。更改地址需要钱包密码。",
    "내 가게":
      "我的店",
    "내 주소 채우기":
      "填入我的地址",
    "내가 만든 것":
      "我创建的",
    "내가 만든 자산의 파일입니다":
      "这是您创建的资产的文件",
    "내놓은 자산":
      "已上架的资产",
    "내용":
      "内容",
    "내일 이맘때":
      "明天此时",
    "넘어가는 순서 바꾸기":
      "调整回退顺序",
    "노드":
      "节点",
    "노드 RPC":
      "节点 RPC",
    "노드 꺼짐":
      "节点已关闭",
    "노드 따라잡는 중":
      "节点正在同步",
    "노드 켜짐":
      "节点已开启",
    "노드·사진 창고·지갑·계산대를 한 프로그램에서 씁니다.":
      "节点、文件仓库、钱包、收银台，一个程序全包。",
    "노드가 꺼져 있어요":
      "节点已关闭",
    "노드가 꺼져 있어요.":
      "节点已关闭。",
    "노드가 바로 꺼집니다.":
      "节点会立即关闭。",
    "노드가 켜져 있는지 보시고, 잠시 뒤에 다시 눌러 주세요.":
      "请确认节点已启动，稍后再点一次。",
    "노드끼리 대화":
      "节点间对话",
    "노드만 켭니다. 앱까지 저절로 켜지면 아무도 없는 방에서 지갑이 열립니다.":
      "只启动节点。若连应用也自动启动，就会在无人的房间里打开钱包。",
    "누구에게":
      "转给谁",
    "눌러서 보기":
      "点击查看",
    "다 됐습니다":
      "已完成",
    "다른 일도 합니다":
      "还做别的事",
    "다른 지갑":
      "另一个钱包",
    "다른 폴더 고르기…":
      "选择其他文件夹…",
    "다른 회사 · 내 컴퓨터의 AI":
      "其他厂商 · 本机 AI",
    "다시 감추기":
      "重新隐藏",
    "다시 열기":
      "重新营业",
    "다시 열었습니다.":
      "已重新营业。",
    "다시 엽니다":
      "重新开门",
    "다시 읽어오기":
      "重新读取",
    "다시 켤 때까지 가게가 멈춥니다. 영업 중에는 누르지 마세요.":
      "在重新启动之前店铺会停摆。营业期间请勿点击。",
    "다시 확인":
      "重新检查",
    "다운로드 폴더":
      "下载文件夹",
    "다음":
      "下一步",
    "단말기 임대료도 정산 대기도 없습니다.":
      "没有终端租金，也不必等待结算。",
    "단어를 꺼내는 동안 이 컴퓨터에 임시 파일이 잠깐 생겼다가 지워집니다. SSD에서는 지운 흔적이 완전히 사라지지 않을 수 있습니다.":
      "提取单词时，本机会短暂生成一个临时文件随后删除。在固态硬盘上，删除痕迹可能无法完全消失。",
    "단위":
      "单位",
    "단추가 여덟 개까지입니다. 하나 지우고 다시 말씀해 주세요.":
      "最多八个按钮。请先删掉一个再告诉我。",
    "닫기":
      "关闭",
    "닫기 (Esc)":
      "关闭（Esc）",
    "달러 ($)":
      "美元（$）",
    "담아 따로 두십시오.":
      "，并单独存放。",
    "답에 따라 이 프로그램이 컴퓨터를 얼마나 쓸지 정해집니다. 나머지는 알아서 맞춥니다.":
      "您的回答决定本程序占用多少资源。其余的我们会自动调整。",
    "대신":
      "但是",
    "대화방 이름 (상대와 미리 정한 것)":
      "房间名称（与对方事先约定）",
    "더 찍기":
      "再铸造",
    "덮어씁니다":
      "覆盖",
    "돈 받을 주소":
      "收款地址",
    "돈·발행·설정 전부":
      "资金、发行、全部设置",
    "돕니다.":
      "运行。",
    "되돌리는 중…":
      "正在还原…",
    "되돌릴 백업을 고르세요":
      "请选择要还原的备份",
    "되돌릴까요?":
      "要还原吗？",
    "되돌립니다":
      "还原",
    "되읽기":
      "重新读取",
    "두 곳에 묻기":
      "问两家",
    "두 노드가 같은 지갑을 쓰면 같은 주소를 두 번 나눠 주고 돈을 잃습니다. 원래 컴퓨터가":
      "两个节点使用同一个钱包会把同一地址派发两次，从而丢钱。只有当原电脑",
    "뒤로":
      "返回",
    "드나든 기록":
      "进出记录",
    "들어감":
      "已包含",
    "들어오고 나간 것":
      "进出明细",
    "들어온 수익":
      "已到账收益",
    "들어온 주문":
      "收到的订单",
    "등록하면":
      "注册后",
    "디스크 45 GB → 5 GB, 메모리와 연결도 줄입니다.":
      "磁盘 45 GB → 5 GB，内存和连接数也一并减少。",
    "따라잡음":
      "已同步",
    "따로 있는 GPU 기계":
      "另外一台 GPU 机器",
    "라비":
      "Ravi",
    "라비가 틀리게 답해요":
      "Ravi 回答有误",
    "라비를 깨웁니다":
      "唤醒 Ravi",
    "라비에게 묻기":
      "问 Ravi",
    "레이븐 코어와 같은 주소록":
      "与 Ravencoin Core 是同一个地址簿",
    "레이븐코인으로 받으면 뭐가 좋아?":
      "用 Ravencoin 收款有什么好处？",
    "로 고정됩니다.":
      "。",
    "루트 자산":
      "根资产",
    "를 적어 주세요. 앞부분이 화면과 같은지도 눈으로 맞춰 보세요.":
      "。也请用眼睛核对开头部分是否与屏幕一致。",
    "를 한 번만 넣어 주세요.":
      "填入一次即可。",
    "만드는 것":
      "将要创建的",
    "만드는 중…":
      "创建中…",
    "만들고 · 되돌리기":
      "创建 · 还原",
    "말로 불러 주세요":
      "口述给我即可",
    "말로 알려주면 화면을 채웁니다":
      "告诉我，我来填写界面",
    "맞추는 중…":
      "匹配中…",
    "매장 밖에서도 주문·판매 링크가 열립니다. Cloudflare를 지나갑니다.":
      "店外也能打开下单和售卖链接。流量经过 Cloudflare。",
    "매장·포장":
      "堂食 · 外带",
    "매출 · 장부":
      "营业额 · 账本",
    "먼저 계산해 보기":
      "先试算",
    "먼저 연습해 보기":
      "先练习一次",
    "먼저 예약합니다":
      "先做预约",
    "먼저 이름을 정해 주세요.":
      "请先确定名称。",
    "메뉴 넣기":
      "添加菜品",
    "메뉴 넣을게요. 제가 부르는 대로 메뉴판에 넣어 주세요:":
      "我来添加菜品。按我念的加到菜单里：",
    "메뉴 지우기를 그만두었습니다":
      "已取消清空菜单",
    "메뉴가 하나도 없습니다":
      "一个菜品都没有",
    "메뉴판":
      "菜单",
    "메뉴판 올리기":
      "发布菜单",
    "메모":
      "备注",
    "모델":
      "模型",
    "모든 폰을 끊을까요?":
      "要断开所有手机吗？",
    "무엇에 쓰실 것인지 한 줄만 더 적어 주세요.":
      "请再写一行说明用途。",
    "무엇으로 줄까요":
      "用什么发放",
    "무엇을":
      "转什么",
    "무엇을 만들고 싶으신지 말로 적어 보세요":
      "请用文字描述您想创建什么",
    "무엇을 만들고 싶으신지 한 줄만 적어 주세요.":
      "请用一行写下您想创建什么。",
    "무엇을 만들까요":
      "要创建什么",
    "무엇을 할까요? 아래를 누르거나, 그냥 말씀하세요.":
      "要做什么？点下面的按钮，或者直接说给我听。",
    "무엇이 달라지나요":
      "有什么区别",
    "무엇이 잘못됐나요?":
      "出了什么问题？",
    "무엇이든 물어봅니다. 화면은 안 건드립니다":
      "什么都可以问。不会改动界面",
    "문":
      "门",
    "문 설정":
      "门禁设置",
    "문 앞에 두는 화면":
      "放在门口的界面",
    "문 저장":
      "保存门禁",
    "문제 알리기":
      "报告问题",
    "문제 알리기 창을 열었습니다":
      "已打开报告问题的窗口",
    "물어보기":
      "问问看",
    "뭐든 물어보세요":
      "什么都可以问",
    "바깥에서 계산대까지 열기":
      "从外部也能打开收银台",
    "바깥에서도 열리게":
      "让外部也能访问",
    "바꾸기는 실패해도 지금 암호가 그대로 남고, 노드도 꺼지지 않습니다.":
      "即使更改失败，当前密码仍然有效，节点也不会关闭。",
    "바꿀 수 없습니다.":
      "无法更改。",
    "밖에서 주문하러 올 주소":
      "店外顾客下单的网址",
    "받기":
      "收款",
    "받는 분이 알려 준 원본":
      "收款方给您的原始信息",
    "받는 주소":
      "收款地址",
    "받는 중…":
      "接收中…",
    "받은 것":
      "收到的",
    "받은 공지":
      "收到的公告",
    "받은 금액":
      "收到的金额",
    "받을 주소 만들기":
      "创建收款地址",
    "받을 주소록":
      "收款地址簿",
    "발행 중…":
      "发行中…",
    "배달":
      "配送",
    "배당":
      "分红",
    "백업 둘 곳":
      "备份存放位置",
    "백업 만들기":
      "创建备份",
    "백업본을 다른 컴퓨터에서 동시에 켜지 마세요.":
      "请勿在另一台电脑上同时运行备份副本。",
    "백업에서 되돌리기":
      "从备份还原",
    "번 돈 금고로 옮기기":
      "把收入转入金库",
    "번호 · 시각":
      "编号 · 时间",
    "보내기":
      "转出",
    "보내기 전 확인":
      "转出前确认",
    "보내기가 안 돼요":
      "无法转出",
    "보내는 중…":
      "发送中…",
    "보내려면 그때 암호를 묻습니다":
      "转出时会询问密码",
    "보낸 것은 되돌릴 수 없습니다.":
      "已发送的无法收回。",
    "보낸 공지는":
      "已发送的公告",
    "보낸 사람이 같은 돈을 다시 쓸 수 있습니다. 커피 한 잔은 1확인, 값비싼 물건은 더 기다리십시오.":
      "付款方仍可能把同一笔钱再花一次。一杯咖啡等 1 个确认即可，贵重物品请多等。",
    "보낸 주소":
      "付款地址",
    "보낼 때마다 네트워크 수수료가 듭니다. 답장은 오지 않습니다 — 이건 방송입니다.":
      "每次发送都要付网络手续费。不会有回复 —— 这是广播。",
    "보낼 자산":
      "要转出的资产",
    "보냈습니다. 고맙습니다.":
      "已发送。谢谢您。",
    "보유자 전원에게":
      "发给所有持有者",
    "보존 중…":
      "保存中…",
    "보존을 해제할까요?":
      "要取消保存吗？",
    "보존하지 못했습니다":
      "保存失败",
    "보존할 항목 없음":
      "没有需要保存的项目",
    "보통 내가 가진 몫은 빼고 나눕니다.":
      "通常会扣除您自己持有的份额再分配。",
    "복구 단어":
      "恢复单词",
    "복구 단어 12개는 어느 경우에도 클라우드에 올라가지 않습니다.":
      "12 个恢复单词在任何情况下都不会上传到云端。",
    "복구 단어 보기":
      "查看恢复单词",
    "복구 카드 인쇄":
      "打印恢复卡",
    "복사":
      "复制",
    "복사가 안 됩니다":
      "无法复制",
    "복사해서 위 칸에 붙여넣으세요.":
      "请复制后粘贴到上面的框中。",
    "복사했습니다":
      "已复制",
    "불러오기":
      "加载",
    "불러오는 중…":
      "加载中…",
    "붙는 곳":
      "收取范围",
    "붙어 있는 클라우드나 외장 디스크가 없습니다.":
      "没有已连接的云盘或外置硬盘。",
    "브라우저를 열지 못했습니다":
      "无法打开浏览器",
    "브랜드 아래 상품 (하위)":
      "品牌下的商品（子资产）",
    "블록":
      "个区块",
    "블록체인":
      "区块链",
    "비우면 수량 × 10":
      "留空则为数量 × 10",
    "비워 두면 가게 목록에 이름만 보이고":
      "留空的话，店铺列表中只显示名称，",
    "비워 두면 그 요일은 쉬는 날입니다. 닫는 시각이 여는 시각보다 이르면":
      "留空表示当天休息。若关门时间早于开门时间，则视为",
    "비워 두면 나에게도 보냅니다":
      "留空则也发给自己",
    "사용 가능":
      "可用",
    "사장님만":
      "仅限店主",
    "사장님을 도울 때":
      "协助店主时",
    "사진 올리기":
      "上传照片",
    "사진 저장":
      "照片存储",
    "사진 찍지 마세요. 메모 앱에 적지 마세요. 남에게 보여주지 마세요.":
      "不要拍照。不要写进备忘录。不要给任何人看。",
    "상담 내용, 주의사항":
      "咨询内容、注意事项",
    "상대가 켜져 있어야":
      "对方必须开着机",
    "상태":
      "状态",
    "새 버전 확인":
      "检查新版本",
    "새 암호 (10자 이상)":
      "新密码（10个字符以上）",
    "새 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "若忘记新密码，您的资金和资产将永久消失。",
    "새 이름을 체인에 새깁니다. RVN이 소각됩니다.":
      "将新名称刻入链上。会销毁 RVN。",
    "새 자산 만들기":
      "创建新资产",
    "새 주소에 붙일 이름":
      "为新地址取的名称",
    "새로고침":
      "刷新",
    "샘플 넣기":
      "填入示例",
    "샘플 사진 (IPFS에 올라가 있습니다)":
      "示例照片（已在 IPFS 上）",
    "생각하는 중…":
      "思考中…",
    "서로 다른 AI 두 곳에 같은 것을 묻습니다":
      "向两个不同的 AI 问同一个问题",
    "서버 없이 두 컴퓨터가 직접 주고받습니다. 수수료도 없습니다.":
      "两台电脑不经服务器直接交换。也没有手续费。",
    "서울 강남구":
      "首尔江南区",
    "석 달":
      "3个月",
    "설정에서":
      "在设置中",
    "설정에서 AI 열쇠를 넣으시면 라비가 골라 드립니다.":
      "在设置中填入 AI 密钥，Ravi 就会替您挑选。",
    "설정에서 API 키를 넣으면 켜집니다":
      "在设置中填入 API 密钥后即可启用",
    "설치 중…":
      "安装中…",
    "세대":
      "代数",
    "세부 설정":
      "详细设置",
    "셸리 스위치를 같은 공유기에 붙이고 셸리 앱에서 IP를 확인해 여기 적으세요. 열림 시간이 지나면":
      "请将 Shelly 开关连接到同一路由器，在 Shelly 应用中查看 IP 并填在这里。开门时间结束后，",
    "셸리 아이디 · 비밀번호":
      "Shelly 账号 · 密码",
    "셸리 주소":
      "Shelly 地址",
    "셸리에 걸어 둔 비밀번호":
      "在 Shelly 上设置的密码",
    "소개":
      "简介",
    "소비전력 (W)":
      "功耗（W）",
    "소수점 자리":
      "小数位数",
    "손님":
      "顾客",
    "손님 QR":
      "顾客二维码",
    "손님 질문에 답할 때":
      "回答顾客提问时",
    "손님 폰 서버를 켜지 못했습니다.":
      "无法启动顾客手机服务。",
    "손님 폰으로 받기":
      "用顾客手机接单",
    "손님 화면 맨 위가 빈 채로 뜹니다.":
      "顾客界面顶部会是空白。",
    "손님 화면 보기":
      "查看顾客界面",
    "손님 화면에 보일 가게 소개를 써 주세요. 제 가게는":
      "请写一段顾客能看到的店铺简介。我的店是",
    "손님에게 보일 글":
      "给顾客看的文案",
    "손님에게 보일 한마디 — 예: 재료가 떨어졌습니다":
      "给顾客看的一句话 —— 例：原料用完了",
    "손님에게 안 보입니다":
      "顾客将看不到",
    "손님이 QR 을 찍어도 시킬 것이 없습니다.":
      "即使顾客扫码，也没有可点的东西。",
    "손님이 QR을 찍어 주문합니다. 같은 wifi 안에서 됩니다.":
      "顾客扫码下单。在同一 wifi 内即可使用。",
    "손님이 걸 수 있는 번호":
      "顾客可以拨打的号码",
    "손님이 낸 돈의":
      "顾客支付金额的",
    "손님이 더 내는 것이 아니라":
      "并不是让顾客多付",
    "손님이 시킨 것":
      "顾客点的东西",
    "손님이 주문할 수 있어요":
      "顾客可以下单",
    "손님이 찾아올 수 있게 쓰세요":
      "写清楚，方便顾客找到",
    "수량":
      "数量",
    "수익 계산 · 켜고 끄기":
      "收益测算 · 启停",
    "쉬는 날":
      "休息日",
    "쉬운 설정":
      "简易设置",
    "스위치가 스스로 닫습니다":
      "开关会自动关闭",
    "스위치가 이 값들을 대신 정합니다. 직접 만지실 때만 여세요.":
      "上面的开关会替您设定这些值。只有需要亲自调整时才展开。",
    "시세를 못 가져왔습니다":
      "无法获取汇率",
    "시작일":
      "开始日期",
    "시험용 가게 만들기":
      "创建测试店铺",
    "시험용 지우기":
      "删除测试数据",
    "쓰세요.":
      "才可使用。",
    "쓰시는 대로 저장합니다. 나라마다 주소 모양이 달라서 쪼개지 않습니다.":
      "按您书写的原样保存。各国地址格式不同，我们不做拆分。",
    "아래 문장을 그대로 입력하세요.":
      "请原样输入下面这句话。",
    "아래 버튼으로 만듭니다":
      "用下面的按钮创建",
    "아래 셋에는 열쇠가 들어 있습니다. 붙이지 말고, 찍을 때만 보여 주세요.":
      "下面三个含有密钥。请不要张贴，只在扫描时出示。",
    "아래 아이콘은 지금 바로 됩니다. 말로 시키시려면":
      "下面的图标现在就能用。若要用语言指挥我，请在",
    "아무것도 안 고르면 바탕화면에 만듭니다.":
      "如果什么都不选，就创建在桌面上。",
    "아이스 아메리카노":
      "冰美式",
    "아이스 아메리카노 4500원 넣어줘":
      "把冰美式加进去，4500韩元",
    "아직 안 된 것":
      "尚未完成",
    "아직 안 된 것이 있습니다":
      "还有些事没准备好",
    "아직 없습니다":
      "还没有",
    "아직 정해지지 않았습니다":
      "尚未确定",
    "안 건드리면 지금 그대로":
      "不动它就保持现状",
    "안 붙는 곳":
      "不收取的范围",
    "안 함":
      "不包含",
    "안녕하세요, 라비입니다.":
      "您好，我是 Ravi。",
    "알겠습니다":
      "知道了",
    "암호 걸기":
      "设置密码",
    "암호 바꾸기":
      "更改密码",
    "암호 없음":
      "无密码",
    "암호는":
      "密码",
    "암호를 걸면":
      "设置密码后，",
    "암호를 잊으면 되돌릴 수 없다":
      "忘记密码就无法还原",
    "약 47 GB":
      "约 47 GB",
    "약 6 GB":
      "约 6 GB",
    "어느 자산 보유자에게":
      "发给哪个资产的持有者",
    "어느 화면인지·무슨 오류가 났는지는 제가 알아서 같이 보냅니다. 겪으신 것만 적어 주세요.":
      "我会一并发送您所在的界面和发生的错误。您只需写下遇到的情况。",
    "어디":
      "位置",
    "어떤 자산의 보유자":
      "哪个资产的持有者",
    "언제 명단을 굳힐까요":
      "何时锁定名单",
    "얼마":
      "多少",
    "없어도 등록됩니다":
      "没有也可以注册",
    "에 두시면 찾아서 씁니다.":
      "，我们会找到并使用。",
    "에 있습니다. 아무도 갖고 있지 않으면 찾을 수 없게 됩니다 — 이 컴퓨터가 켜져 있으면 이 컴퓨터가 갖고 있습니다.":
      "中。如果没人保存，就再也找不到 —— 只要这台电脑开着，它就替您保存。",
    "엑셀 파일로 내보내기":
      "导出为表格文件",
    "여기서 시작합니다":
      "从这里开始",
    "여는 시각과 닫는 시각을 둘 다 넣으셔야 나머지 요일에 옮길 수 있습니다.":
      "需要同时填写开门和关门时间，才能复制到其他日子。",
    "여는 중…":
      "正在打开…",
    "연결과 뒷일을 줄입니다":
      "减少连接和后台工作",
    "연결만 확인":
      "仅测试连接",
    "연습 시작":
      "开始练习",
    "연습용 돈을 만드는 중…":
      "正在生成练习用资金…",
    "연습용 체인을 켜는 중…":
      "正在启动练习链…",
    "열려 있음":
      "已开启",
    "열린 것과":
      "已开的和",
    "열림 시간(초)":
      "开门时长（秒）",
    "열쇠 보기":
      "查看密钥",
    "영업 중":
      "营业中",
    "영업시간":
      "营业时间",
    "영업하는 것으로 봅니다 — 밤 6시 열고 새벽 2시 닫기.":
      "继续营业 —— 晚上6点开门，凌晨2点关门。",
    "영원히":
      "永远",
    "예: 강남에서 원두 직접 볶는 작은 카페, 포장만":
      "例：江南一家自己烘豆的小咖啡馆，只做外带",
    "예: 보내기를 눌렀는데 아무 일도 없어요":
      "例：点了转出但没有任何反应",
    "예: 아메리카노 4500, 카페라떼 5000, 치즈케이크 6500":
      "例：美式4500，拿铁5000，芝士蛋糕6500",
    "예: 우리 헬스장 3개월 회원권을 30명한테 주고 싶어요":
      "例：我想给 30 个人发健身房三个月会员卡",
    "예약":
      "预约",
    "오늘":
      "今天",
    "오늘 얼마":
      "今天赚了多少",
    "오늘 팔 것만":
      "今天要卖的部分",
    "오래 걸립니다":
      "这需要一些时间",
    "오래된 컴퓨터":
      "旧电脑",
    "오래된 컴퓨터로 아끼기":
      "在旧电脑上节省资源",
    "오류 없음":
      "没有错误",
    "올린 파일은 이 컴퓨터가 보존합니다.":
      "上传的文件由这台电脑保存。",
    "완전히 죽었을 때만":
      "彻底报废时",
    "원 (₩)":
      "韩元（₩）",
    "원두 20kg 다음 주에 가능할까요?":
      "下周能供 20 公斤咖啡豆吗？",
    "원두를 직접 볶는 작은 카페":
      "一家自己烘豆的小咖啡馆",
    "원두를 직접 볶는 작은 카페입니다":
      "一家自己烘豆的小咖啡馆",
    "원래대로":
      "还原",
    "원본의 끝 4자리":
      "原始信息的最后4位",
    "월요일 시간을 나머지 요일에도":
      "把周一的时间套用到其他日子",
    "월요일부터 채워 주세요":
      "请先填好周一",
    "위에 있는 곳부터 씁니다. 막히거나 실패하면 아래로 넘어갑니다.":
      "从最上面的开始使用。若受阻或失败则往下切换。",
    "위에 적힌 이름을 직접 입력":
      "请输入上面写的名称",
    "위의":
      "上面的",
    "으로 갑니다. 컴퓨터를 잃어버려도 거기 있는 돈은 무사합니다.":
      "。即使电脑丢失，那里的钱也安然无恙。",
    "을 같이 남깁니다 — \"왜 안 열렸지\"가 카운터에서 제일 자주 나오는 질문입니다.":
      "都会记录 —— “为什么没开”是柜台最常被问到的问题。",
    "을 해야 고쳐집니다 — 빠른 터널 주소는 켤 때마다 바뀌니 임시로만 쓰세요.":
      "才能修改 —— 快速隧道地址每次启动都会变，请仅作临时使用。",
    "이 가격에 내놓기":
      "以此价格上架",
    "이 금액(RVN)을 넘으면":
      "超过此金额（RVN）时",
    "이 기능만 이 컴퓨터 밖으로 나갑니다.":
      "只有这项功能会离开这台电脑。",
    "이 노드":
      "本节点",
    "이 단어를 아는 사람은 지갑 전부를 가져갈 수 있습니다.":
      "知道这些单词的人可以拿走整个钱包。",
    "이 목록은":
      "这个列表",
    "이 암호를 잊으면 돈과 자산은 영원히 사라집니다.":
      "若忘记此密码，您的资金和资产将永久消失。",
    "이 앱과 레이븐 코어는 같은 지갑을 씁니다. 동시에 열 수 없습니다.":
      "本应用与 Ravencoin Core 使用同一个钱包，不能同时打开。",
    "이 앱도, 레이븐코인도, 누구도 되돌릴 수 없습니다. 복구 방법이 없습니다.":
      "本应用、Ravencoin、任何人都无法还原。没有恢复办法。",
    "이 이름으로 해 보기":
      "用这个名称试试",
    "이 이름은 체인에 영구히 남고 누구도 다시 쓸 수 없습니다. 그대로 다시 입력하세요.":
      "这个名称将永久留在链上，任何人都无法再用。请原样再输入一次。",
    "이 이름을 아는 사람은 누구나 들을 수 있습니다. 비밀 대화가 아닙니다.":
      "任何知道这个名称的人都能收听。这不是私密对话。",
    "이 자물쇠의 열쇠":
      "这把锁的钥匙",
    "이 주소는 내 지갑입니다.":
      "这个地址是您自己的钱包。",
    "이 주소는 체인에 올라가므로, 바뀌면":
      "该地址会上链，因此一旦变更就需要",
    "이 지갑의 주소만 씁니다. 직접 입력하지 않는 이유는, 잘못 붙여넣으면 매출이 남에게 갑니다.":
      "只使用本钱包的地址。不让手动输入，是因为粘贴错误会把营业款转给别人。",
    "이 컴퓨터":
      "这台电脑",
    "이 컴퓨터 → AI 열쇠":
      "这台电脑 → AI 密钥",
    "이 컴퓨터 안의 사본은 잠그지 않습니다 — 여기 있는 사람은 이미 지갑을 가졌으므로 잠가도 얻는 것이 없습니다.":
      "本机内的副本不加锁 —— 能接触到这里的人已经拥有钱包，加锁没有意义。",
    "이 컴퓨터, 가게에만 쓰시나요?":
      "这台电脑只用于店里吗？",
    "이 컴퓨터가 아닌 곳에 두세요.":
      "放在这台电脑之外的地方。",
    "이 컴퓨터로 캐지 않습니다.":
      "这台电脑不挖矿。",
    "이 컴퓨터로도 캐기":
      "也用这台电脑挖矿",
    "이 컴퓨터를 보고 제가 정해 드릴게요.":
      "我看看这台电脑，替您决定。",
    "이 컴퓨터를 쓸 수 있는 사람은 지갑도 쓸 수 있습니다":
      "能使用这台电脑的人也能使用钱包",
    "이 컴퓨터에 맞게 살펴보는 중…":
      "正在检查这台电脑的配置…",
    "이 컴퓨터에 보존":
      "保存在这台电脑上",
    "이 컴퓨터에만":
      "只保存在这台电脑上",
    "이 컴퓨터에서 사본이 사라집니다. 다른 곳에 사본이 없으면 되찾을 수 없습니다.":
      "本机上的副本将消失。若别处没有副本，就无法找回。",
    "이 컴퓨터에서 열지 못했습니다":
      "无法在这台电脑上打开",
    "이 컴퓨터의 파일 창고에서만 찾습니다. 내가 가진 자산 목록을 바깥으로 보내지 않습니다.":
      "只在这台电脑的文件仓库中查找。不会把您的资产清单发送到外部。",
    "이것 없이는 클라우드 사본을 못 엽니다.":
      "没有它就打不开云端副本。",
    "이대로 시작하기":
      "就这样开始",
    "이대로 켜기":
      "按此设置启动",
    "이라 돈이 안 나가고, 마음에 안 들면 지우고 다시 하시면 됩니다.":
      "，所以不会花钱，不满意就删掉重来。",
    "이름":
      "姓名",
    "이름 (지점명)":
      "名称（分店名）",
    "이름 · 사진 · 주소 · 영업시간 · 등록":
      "名称 · 照片 · 地址 · 营业时间 · 注册",
    "이름 하나면 시작됩니다. 나머지는 나중에 채우셔도 됩니다.":
      "有一个名字就能开始。其余的可以以后再填。",
    "이름·전화 뒷자리·회원번호 아무거나 치면 됩니다.":
      "输入姓名、手机尾号或会员编号，任意一种都可以。",
    "이름이 체인에 영구히 남고 RVN이 소각됩니다. 이름을 그대로 입력하세요.":
      "名称会永久留在链上，并销毁 RVN。请原样输入名称。",
    "이미 들어 있는 것이 있습니다":
      "里面已经有内容了",
    "이미 만들어진 잠긴 백업은 그대로 남습니다.":
      "已经生成的加锁备份会原样保留。",
    "이번 주 휴무 안내":
      "本周休息通知",
    "읽기 전용":
      "只读",
    "읽는 중…":
      "读取中…",
    "입니다. 여기서 붙인 이름이 코어에도 보이고, 코어에서 붙인 이름이 여기 보입니다.":
      "。您在这里取的名称会显示在 Core 中，在 Core 中取的名称也会显示在这里。",
    "자격 배지":
      "资格徽章",
    "자격 증명":
      "资格证明",
    "자동 발송 켜기":
      "开启自动发货",
    "자동 확인 (30초)":
      "自动检查（30秒）",
    "자산":
      "资产",
    "자산 만들기":
      "创建资产",
    "자산 보내기":
      "转出资产",
    "자산 이름":
      "资产名称",
    "자산에 붙은 그림·음악은 체인이 아니라":
      "资产附带的图片和音乐不在链上，而在",
    "자산을 가진 사람 전원에게 갑니다. 답장은 받을 수 없습니다.":
      "会发给所有持有该资产的人。无法收到回复。",
    "자산을 가진 사람들에게 나눠 줍니다. 회원권·조합원 토큰에 씁니다.":
      "分发给持有该资产的所有人。用于会员卡和合作社代币。",
    "자산을 발행하려면 지갑을 열어야 합니다.":
      "发行资产需要先解锁钱包。",
    "자산을 불러오는 중…":
      "正在加载资产…",
    "자산을 하나 만들려고 합니다. 무엇을 물어봐야 하는지부터 알려 주세요.":
      "我想创建一个资产。先告诉我应该问些什么。",
    "자정 넘겨 영업":
      "跨夜营业",
    "자정을 넘겨":
      "跨过午夜",
    "잠겨 있을 때만":
      "只在锁定时",
    "잠금":
      "锁定",
    "장비 이름":
      "设备名称",
    "재발행 가능":
      "可再发行",
    "재발행(RVN 소각)":
      "重新发行（销毁 RVN）",
    "재발행을 껐으므로 수량과 파일을 영원히 못 바꿉니다":
      "已关闭再发行，数量和文件将永远无法更改",
    "저장":
      "保存",
    "저장 중…":
      "保存中…",
    "저장됩니다 — 체인에 올리면 지울 수 없고, 누구나 회원 명단과 계약 종료일을 볼 수 있게 됩니다.":
      "—— 一旦上链就无法删除，任何人都能看到您的会员名单和合约到期日。",
    "저장하고 다시 켜기 안내":
      "保存并重启说明",
    "저장했습니다":
      "已保存",
    "저장했습니다.":
      "已保存。",
    "전기값이 더 나갈 수 있습니다.":
      "电费可能高于收益。",
    "전기요금 (원/kWh)":
      "电价（韩元/kWh）",
    "전부 이 컴퓨터에 둡니다":
      "全部保存在这台电脑上",
    "전원이 돌아오면 노드가 저절로 켜집니다. 앱은 켜지지 않습니다.":
      "来电后节点会自动启动。应用不会启动。",
    "전체":
      "全部",
    "전체 명단":
      "全部名单",
    "전체 얼마":
      "总金额",
    "전화":
      "电话",
    "정문":
      "正门",
    "정전 뒤 자동으로 켜기":
      "断电后自动启动",
    "제 일도 하는 컴퓨터입니다. 꼭 필요한 만큼만 쓰게 합니다.":
      "您也用来办公的电脑。只占用必要的资源。",
    "제가 정해 드려요":
      "我来替您决定",
    "제목":
      "标题",
    "제한 자산":
      "受限资产",
    "종류":
      "类型",
    "종이에 적어":
      "写在纸上，",
    "종이에 적어 12단어와 같이 보관하세요.":
      "请写在纸上，与 12 个单词一起保管。",
    "좌표 (선택)":
      "坐标（可选）",
    "주문 버튼이 안 생깁니다.":
      "不会出现下单按钮。",
    "주문·계산이 안 돼요":
      "无法下单或结账",
    "주문·회원확인만":
      "仅点单和会员核验",
    "주문마다 자동으로 만들어지는 주소는 목록에 넣지 않습니다 — 하루 장사하면 수십 줄이 되어 직접 붙인 이름이 묻힙니다.":
      "每笔订单自动生成的地址不会进入此列表 —— 做一天生意就会有几十行，把您自己取的名称淹没。",
    "주문마다 주소가 따로 생깁니다. 그 주소로 들어온 돈만 그 주문의 결제입니다.":
      "每笔订单都有独立地址。只有到达该地址的款项才算这笔订单的付款。",
    "주소":
      "地址",
    "주소 만들고 폰 여는 중…":
      "正在创建地址并打开手机…",
    "주소 만들기":
      "创建地址",
    "주소를 만들지 못했습니다":
      "无法创建地址",
    "주소를 복사했습니다":
      "已复制地址",
    "주소를 복사했습니다. 브라우저에 붙여넣어 확인하세요.":
      "已复制地址。请粘贴到浏览器中查看。",
    "주소를 읽지 못했습니다":
      "无法读取地址",
    "준비됐습니다. 「이 이름으로 해 보기」를 눌러 보세요.":
      "准备好了。试试点击“用这个名称试试”。",
    "지갑":
      "钱包",
    "지갑 12단어·열쇠·주소·잔액은 보내지 않습니다.":
      "不会发送钱包的 12 个单词、密钥、地址和余额。",
    "지갑 암호":
      "钱包密码",
    "지갑 잠금":
      "钱包锁定",
    "지갑 파일도 같이 올라가지만, 잠겨 있어서 클라우드 계정이 털려도 열 수 없습니다.":
      "钱包文件也会一并上传，但已加锁，即使云账号被攻破也打不开。",
    "지갑에 암호 걸기":
      "为钱包设置密码",
    "지갑을 열지 못했습니다":
      "无法解锁钱包",
    "지갑이 안 열려요":
      "钱包打不开",
    "지갑이 잠겨 있습니다. 이 한 번만 열고 곧바로 다시 잠급니다.":
      "钱包处于锁定状态。仅本次解锁，随后立即重新锁定。",
    "지갑이 잠깐 열립니다.":
      "钱包会短暂解锁。",
    "지금 결제를 바로 확인합니다":
      "可以立即确认付款",
    "지금 닫기":
      "立即打烊",
    "지금 닫기 (시간표보다 우선)":
      "立即打烊（优先于营业时间）",
    "지금 상태":
      "当前状态",
    "지금 설치할까요?":
      "现在安装吗？",
    "지금 쓰는 암호":
      "当前密码",
    "지금 쓸 곳":
      "当前使用",
    "지금 잠그기":
      "立即锁定",
    "지금 켜기":
      "立即开启",
    "지금 터널 주소 넣기":
      "填入当前隧道地址",
    "지금은 닫혀 있습니다":
      "目前打烊中",
    "지금은 암호 없이 보낼 수 있는 상태입니다. 자리를 비우기 전에 잠그세요.":
      "当前状态下无需密码即可转账。离开座位前请锁定。",
    "지금이 최신입니다.":
      "已是最新版本。",
    "지도 앱에서 복사해 붙여넣기":
      "从地图应用复制后粘贴",
    "지도 주소를 복사했습니다. 브라우저에 붙여넣으세요.":
      "已复制地图链接。请粘贴到浏览器中。",
    "지도에서 확인":
      "在地图上查看",
    "지우고 처음부터":
      "清空重来",
    "지우는 중…":
      "删除中…",
    "지울 수 없습니다.":
      "无法删除。",
    "지웁니다":
      "删除",
    "지웠습니다. 「연습 시작」부터 다시 하시면 됩니다.":
      "已删除。可以从“开始练习”重新来过。",
    "지점 이름 · 손님 폰 연결 · 백업 · 금고 — 매일 여실 필요 없어요":
      "分店名称 · 顾客手机连接 · 备份 · 金库 —— 不必每天打开",
    "지킬 것이 없습니다":
      "没有需要保存的",
    "지킵니다. 자동 판매를 켜면 잠금이 풀리고, 그동안은 암호가 없는 것과 같습니다.":
      "才起作用。开启自动售卖会解锁，在此期间等同于没有密码。",
    "직원":
      "员工",
    "직원 폰도 같이 끊깁니다. 새 QR을 다시 찍어야 합니다.":
      "员工手机也会一并断开。需要重新扫描新的二维码。",
    "직접 입력":
      "手动输入",
    "진짜 지갑은 건드리지 않습니다.":
      "不会碰您真正的钱包。",
    "진짜로 보내기":
      "真正发送",
    "진짜와 똑같이 한 번 해 보실 수 있습니다.":
      "您可以像真的一样完整走一遍。",
    "찾는 중…":
      "查找中…",
    "채굴":
      "挖矿",
    "채굴 · 그냥 보내기 · 자산 발행":
      "挖矿 · 普通转账 · 发行资产",
    "채굴 켜기":
      "开始挖矿",
    "채굴기 실행 파일 이름":
      "挖矿程序文件名",
    "채널":
      "通道",
    "채웠습니다. 고쳐서 쓰세요.":
      "已填好。请自行修改后使用。",
    "처음 보내는 주소입니다.":
      "这是您第一次向该地址转账。",
    "처음 한 번 하는 것들":
      "只需做一次的事",
    "체인에 가게를 등록하지 않았습니다":
      "尚未在链上注册店铺",
    "체인에 남을 이름":
      "留在链上的名称",
    "체인에 영구히 남고 누구나 볼 수 있습니다.":
      "会永久留在链上，任何人都能看到。",
    "체인에 저장되는 이름은 영문 대문자만 가능합니다. 손님이 보는 이름은 위에 적은 것입니다.":
      "存储在链上的名称只能使用大写英文字母。顾客看到的是您上面填写的名称。",
    "체인에서 직접 확인하실 수 있습니다. 카드 수수료(2~3%)와 달리":
      "您可以在链上直接核对。与刷卡手续费（2~3%）不同，",
    "체인은 지나간 순간의 명단을 되돌려주지 않습니다. 먼저 예약해야 그 블록이 지날 때 명단이 굳습니다.":
      "链不会回溯已经过去的名单。必须先预约，等那个区块经过时名单才会锁定。",
    "최근 거래":
      "最近交易",
    "출입 · 회원":
      "出入 · 会员",
    "취소":
      "取消",
    "치즈케이크":
      "芝士蛋糕",
    "카운터에 붙이는 것":
      "贴在柜台上的那个",
    "카운터에 붙이세요. 이 QR 에는 열쇠가 없어 누가 봐도 괜찮습니다.":
      "请贴在柜台上。这个二维码不含密钥，谁看到都没关系。",
    "카페라떼":
      "拿铁",
    "칸이 비어 있어요. 키를 붙여넣고 다시 눌러 주세요.":
      "框是空的。请粘贴密钥后再点一次。",
    "캘 기계의 그래픽카드":
      "挖矿机器的显卡",
    "커피값을 4500원으로 올릴까?":
      "要把咖啡价格提到 4500 韩元吗？",
    "컴퓨터가 죽으면 이 열쇠도 같이 사라집니다.":
      "电脑报废时，这把钥匙也会一起消失。",
    "컴퓨터를 살펴보는 중…":
      "正在查看电脑…",
    "켜 두시길 권합니다.":
      "建议保持开启。",
    "켜기":
      "开启",
    "켜면 QR 네 개가 나옵니다 — 사장님·직원·검표·손님.":
      "开启后会生成四个二维码 —— 店主、员工、验票、顾客。",
    "쿠폰 · 회원권":
      "优惠券 · 会员卡",
    "쿠폰 · 회원권 · 굿즈":
      "优惠券 · 会员卡 · 周边",
    "클라우드":
      "云端",
    "클라우드로 나가는 파일은 저희가 한 번 더 잠급니다.":
      "上传到云端的文件由我们再加一层锁。",
    "키 (없으면 비움)":
      "密钥（没有则留空）",
    "테이블마다 다른 QR 을 인쇄하려면":
      "要为每张桌子打印不同的二维码",
    "파일":
      "文件",
    "파일 고르기":
      "选择文件",
    "파일 지키기":
      "保存文件",
    "파일 창고(IPFS)":
      "文件仓库（IPFS）",
    "파일을 고르면 여기 자동으로 채워집니다":
      "选择文件后这里会自动填入",
    "파일을 안 붙이셨습니다 — 나중에 붙이려면 재발행이 켜져 있어야 합니다":
      "您没有附加文件 —— 若要以后添加，必须开启再发行",
    "파일이 자산의 얼굴입니다. 없어도 발행은 됩니다.":
      "文件是资产的门面。没有也能发行。",
    "파일창고":
      "文件仓库",
    "파일창고 꺼짐":
      "文件仓库已关闭",
    "파일창고 켜짐":
      "文件仓库已开启",
    "판":
      "版本",
    "판매중":
      "在售",
    "팔고 있는 것":
      "正在售卖的",
    "팔기":
      "出售",
    "팔린 자산을 보내려면":
      "为了发送已售出的资产，",
    "폰을 같은 와이파이에 붙이고 찍으세요":
      "让手机连上同一 wifi 后扫描",
    "폰을 잃어버렸어요":
      "我把手机弄丢了",
    "풀":
      "矿池",
    "품목 추가":
      "添加品项",
    "프로그램이 다시 시작합니다. 손님이 주문 중이면 그 화면이 끊깁니다.":
      "程序将重启。如果有顾客正在下单，其界面会中断。",
    "프로그램이 안 켜져요":
      "程序无法启动",
    "하고, 지나간 말은 남지 않습니다. 손님 폰에는 닿지 않습니다 — 그쪽은 위의 공지나 매장 wifi를 씁니다.":
      "，并且历史消息不会保留。它到不了顾客手机 —— 那边请用上面的公告或店内 wifi。",
    "하루 200번까지 옵니다. 싸고 빠른 곳이 위로 오는 게 유리합니다.":
      "每天最多 200 次。把便宜又快的排在上面更划算。",
    "하루 자동 발송 한도 (수량)":
      "每日自动发货上限（数量）",
    "하위 자산":
      "子资产",
    "한 번 더":
      "再输一次",
    "한 번 켜면 되돌릴 수 없습니다.":
      "一旦开启就无法撤销。",
    "한 번 하는 일":
      "一次性操作",
    "한 사람에 하나 (유니크)":
      "每人一个（唯一）",
    "한국어 — 강남 카페":
      "韩语 —— 江南咖啡",
    "한도는 판매를 막는 것이 아니라, 뭔가 잘못됐을 때 손실이 멈추는 선입니다. 하루 100개 팔 생각이면 100으로 두세요.":
      "上限不是为了限制销售，而是出问题时止损的界线。打算一天卖 100 个就设成 100。",
    "한쪽만 적혀서 저장되지 않습니다":
      "只填了一边，不会保存",
    "할 말":
      "要说的话",
    "해시레이트 (MH/s)":
      "算力（MH/s）",
    "해제하지 못했습니다":
      "无法取消",
    "해제합니다":
      "取消",
    "홍길동 · 5678 · A7K2":
      "张三 · 5678 · A7K2",
    "화면":
      "界面",
    "화면 문제":
      "界面问题",
    "화면 채우기":
      "填写界面",
    "확인":
      "确定",
    "확인 불가":
      "无法确认",
    "확인 수가 0이면 아직":
      "确认数为 0 时，",
    "확인 중…":
      "检查中…",
    "확인하지 못했습니다. 인터넷을 확인해 주세요.":
      "无法检查。请检查网络连接。",
    "회원 등록":
      "登记会员",
    "회원권 번호":
      "会员卡号",
    "회원번호를 체인에 하나 찍습니다 (":
      "将在链上铸造一个会员编号（",
    "횟수":
      "次数",
    "횟수권 (10회 등)":
      "次卡（如10次）",
  },
};
