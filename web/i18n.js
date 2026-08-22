/* 손님 화면 4개 국어.
 *
 * 🔴 왜 손님 화면부터인가 — 사장은 한국 사람이지만 **손님은 아닐 수 있다.**
 * 관광지 카페에 들어온 사람이 한국어 화면을 보면 그냥 나간다. 사장 화면은
 * 그 사장이 읽으면 되고, 그건 나중 일이다.
 *
 * 라이브러리를 쓰지 않는다. 이 화면들의 조건은 **외부 스크립트 0개**다.
 * 사전 하나와 함수 하나면 된다.
 *
 * ⚠️ 가게가 올린 글(메뉴 이름·설명)은 번역하지 않는다. 우리가 번역하면
 *   「제육볶음」이 「stir-fried pork」가 되고, 손님이 카운터에서 그 말을 하면
 *   아무도 못 알아듣는다. 가게가 직접 적은 4개 국어만 쓴다.
 */
(function () {
  var DICT = {
    ko: {},
    en: {
      /* 장터·랜딩(2026-08-22) */
      "Groq 에서 공짜로 받으실 수 있어요":
        "You can get one free from Groq",
      "Groq 은 공짜":
        "Groq is free",
      "Ravi 깨우기":
        "Wake Ravi",
      "Ravi에게 물어보기":
        "Ask Ravi",
      "xai- · sk-ant- · AIza · sk- · gsk_ 로 시작하는 열쇠":
        "A key starting with xai- · sk-ant- · AIza · sk- · gsk_",
      "— 처음 보는 가게에 큰 돈을 보내기 전에 확인하세요.":
        "— check before sending a large amount to a shop you have never seen.",
      "♡ 찜":
        "♡ Save",
      "가게 목록을 불러오지 못했습니다.":
        "Could not load the shop list.",
      "가게 이름":
        "Shop name",
      "가게 정보는 각 가게가 직접 올린 것입니다. 아무도 검사하지 않습니다":
        "Shop details are posted by each shop itself. Nobody vets them",
      "가게 찾기":
        "Find a shop",
      "가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "Answers use only what the shop posted. If unsure, check with the shop directly.",
      "가까운 순으로":
        "Nearest first",
      "견과류 들어간 메뉴 있나요?":
        "Do you have anything with nuts in it?",
      "남의 컴퓨터에서는 넣지 마세요.":
        "do not enter it on someone else's computer.",
      "내 물건 올리기":
        "Post something of mine",
      "내 열쇠로 쓰기":
        "Use my own key",
      "내 열쇠로 쓰기 →":
        "Use my own key →",
      "다만 이 화면은 지갑과 같은 곳에 있으니,":
        "But this screen sits in the same place as your wallet, so",
      "답할 말":
        "Reply in",
      "라비가 자고 있어요. 열쇠를 넣으면 깨어납니다.":
        "Ravi is asleep. Enter a key and he wakes up.",
      "무엇을 찾으세요?":
        "What are you looking for?",
      "받기 →":
        "Get one →",
      "받은 글자를 그대로 아래에 붙여 넣으세요. 어느 회사 것인지는":
        "Paste what you received below, exactly. Which provider it belongs to",
      "불러오는 중…":
        "Loading…",
      "아래 어느 곳이든 열쇠를 받아 넣으시면 한도 없이 물어보실 수 있어요.":
        "Get a key from any of the places below and you can ask without limit.",
      "앞글자로 알아서 알아봅니다.":
        "we work out from the first characters.",
      "열쇠는":
        "The key is saved",
      "이 가게에 대해 물어보세요.":
        "Ask about this shop.",
      "이 목록을 가진 회사는 없습니다. 블록체인에서 그때그때 읽어 옵니다.":
        "No company owns this list. We read it from the blockchain each time.",
      "이 브라우저에만":
        "in this browser only",
      "이고, 나머지는 쓴 만큼 그 회사에 내십니다.":
        ", and for the rest you pay that provider for what you use.",
      "잠시 뒤에 다시 열어 주세요.":
        "Please open it again in a moment.",
      "저장됩니다. 우리 서버는 물어볼 때 잠깐 쓰고 저장하지 않아요.":
        ". Our server uses it briefly to ask and does not store it.",
      "저장하고 이어가기":
        "Save and continue",
      "(가게가 적은 메뉴 이름까지 번역하지는 않습니다).":
        "(we do not translate the menu names the shop wrote).",
      "0곳":
        "0 shops",
      "1:1 문의":
        "Private messages",
      "1분 뒤 끝":
        "Done in a minute",
      "1분, 앱 설치 없음":
        "One minute, no app to install",
      "1분.":
        "One minute.",
      "2020년 이전 맥 · 0.1.0":
        "Mac from before 2020 · 0.1.0",
      "34GB 정도를 내려받습니다":
        "It downloads about 34 GB",
      "AI 열쇠 없이 됩니다. 매출을 보는 데 남의 회사에 돈을 낼 이유가 없고, 열쇠가 없다고 매출을 못 보면 그건 이 프로그램이 남의 회사에 묶인 것입니다.":
        "Works without an AI key. There is no reason to pay another company to look at your own takings, and if a missing key stopped you seeing them, this program would be tied to that company.",
      "AI 열쇠를 한 번 넣으시면 되고, 어느 회사든 됩니다 — Grok · Claude · Gemini · ChatGPT · Groq.":
        "Enter an AI key once — any provider works: Grok · Claude · Gemini · ChatGPT · Groq.",
      "IPFS(프로그램 안에서는 「파일창고」)는 없어도 장사는 됩니다 — 메뉴 사진과 자산에 붙는 그림·음악에만 씁니다.":
        "You can trade without IPFS (called \"file store\" inside the program) — it is used only for menu photos and the pictures or music attached to assets.",
      "RVN 가격이 오르내리므로, 받은 코인을 바로 바꾸지 않으면 금액이 달라집니다.":
        "The RVN price moves, so if you do not convert received coins right away the amount changes.",
      "ravencoin.org 에서 노드 받기 →":
        "Get the node from ravencoin.org →",
      "· 문의":
        "· Contact",
      "— 블록체인 전부를 가게 컴퓨터가 직접 갖기 때문이고, 그래서 우리가 매출을 못 봅니다. 처음 한 번은 반나절쯤 걸립니다.":
        "— because the shop computer holds the entire blockchain itself, which is why we cannot see your takings. The first time takes about half a day.",
      "— 애플 로고가 있는 컴퓨터면 맥, 시작 단추가 있으면 윈도우입니다. 2020년 이후 산 맥이면 「애플 실리콘」이 맞습니다.":
        "— if the computer has an Apple logo it is a Mac; if it has a Start button it is Windows. A Mac bought after 2020 is \"Apple Silicon\".",
      "— 여태 프로그램 예닐곱 개로 하던 일을 한 창에 모았습니다.":
        "— what used to take six or seven programs now fits in one window.",
      "— 우리 서버를 지나가지 않습니다. 다만 개발비 1% 는 우리가 받습니다(아래).":
        "— it does not pass through our servers. We do take a 1% development fee (below).",
      "— 전기값과 그래픽카드를 넣으면 하루에 얼마인지 나옵니다. 채굴기는 받아 두신 것을":
        "— enter your electricity price and graphics card and it tells you the daily figure. As for the miner, it only",
      "— 터미널(맥)이나 PowerShell(윈도우)에 아래를 넣으면 나오는 값이 여기 적힌 것과 같아야 합니다. 다르면 받다가 깨졌거나 누가 바꾼 것이니":
        "— run the command below in Terminal (Mac) or PowerShell (Windows); the value it prints must match what is written here. If it differs, the download broke or someone altered it, so",
      "① 받은 파일이 맞는지 먼저 확인하세요.":
        "① First check that the file you downloaded is the right one.",
      "「맨날 하는 일이니 단추로 만들어줘」":
        "\"I do this every day — make it a button\"",
      "「열기」를 한 번 더 누릅니다":
        "press \"Open\" once more",
      "「우리가 보는 것: 없습니다」":
        "\"What we see: nothing\"",
      "「확인되지 않은 개발자」를 그냥 넘기라고 가르치는 안내는 나쁜 프로그램도 똑같이 씁니다. 해시가 같아야 우리가 만든 그 파일입니다.":
        "Instructions that teach you to click past \"unidentified developer\" are used by bad programs too. Only a matching hash proves it is the file we built.",
      "가 옆에 있습니다. 사장님께는 도우미로, 손님께는 가게를 대신해 답합니다.":
        "is right beside you — a helper for you, and an answerer on the shop's behalf for customers.",
      "가 첫 화면입니다. 하고 싶은 일을 그냥 말씀하시면 되고, 말하기 번거로운 날은":
        "is the first screen. Just say what you want to do; on days when talking is a bother,",
      "가게 결제·자동판매기·중고 거래":
        "Shop payments, vending machine, second-hand trades",
      "가게 계산대 · 자동판매기 · 중고 장터.":
        "Shop till · vending machine · second-hand market.",
      "가게 공지":
        "Shop notices",
      "가게 둘러보기":
        "Browse shops",
      "가게 컴퓨터 한 대에만":
        "on the shop computer alone",
      "가게 컴퓨터가 손님 폰에 직접 답합니다. 매출이 우리 서버를 지나가지 않아서, 요구받아도 넘길 것이 없습니다.":
        "The shop computer answers customer phones directly. Your takings never pass through our servers, so even if we were asked, there is nothing to hand over.",
      "가게 화면이 폰에 뜹니다. 앱 설치 없음.":
        "The shop screen appears on the phone. No app to install.",
      "가게는 무엇을 얻나요":
        "What does the shop get",
      "가게를 하시나요?":
        "Do you run a shop?",
      "가게용 프로그램 내려받기":
        "Download the shop program",
      "가게용 프로그램 받기 →":
        "Get the shop program →",
      "값이 하루 사이에 움직입니다.":
        "The price moves within a single day.",
      "같은 길":
        "the same path",
      "같은 일이 됩니다. 누르는 것과 말하는 것이":
        "does the same thing. Pressing and speaking are",
      "개발비":
        "Development fee",
      "고르고 보낸다":
        "Choose and send",
      "그 경고를 넘기기 전에 아래 해시부터 맞춰 보세요.":
        "Before clicking past that warning, check the hash below.",
      "그래서":
        "so",
      "그리고":
        "And",
      "깐 다음에 무엇을 하나요.":
        "What do you do after installing.",
      "깔 것도, 가입할 것도 없습니다.":
        "Nothing to install, nothing to sign up for.",
      "깝니다.":
        "installs it.",
      "나머지 99%는 사장님 지갑으로 바로 들어옵니다. 손님이 더 내는 것이 아니라 받으신 돈에서 나뉩니다.":
        "The other 99% arrives straight in your wallet. The customer does not pay extra; it is split out of what you received.",
      "남에게 묻지 않고 스스로 확인하기 때문에, 우리가 매출을 못 봅니다.":
        "It verifies for itself instead of asking anyone, which is why we cannot see your takings.",
      "내 단추 만들기":
        "Make my own button",
      "내 컴퓨터에서도 되나요?":
        "Will it run on my computer?",
      "노드·채굴·IPFS·자산·배당·계산대·장터·AI":
        "Node · mining · IPFS · assets · payouts · till · marketplace · AI",
      "노드를 꼭 깔아야 하나요?":
        "Do I have to install a node?",
      "노드와 IPFS 는 따로 깔아 두셔야 합니다.":
        "You need to install the node and IPFS separately.",
      "누르는 것은 사장님":
        "you are the one who presses it",
      "는 소스를 열어 보셔야 확인됩니다. 고쳐 주시거나 가져다 쓰셔도 됩니다.":
        "can only be verified by reading the source. You are welcome to fix it or reuse it.",
      "는 잠가서 주고받습니다 — 전화번호를 공개하지 않으셔도 됩니다.":
        "are exchanged locked — you do not have to publish your phone number.",
      "는 체인에 올라가 손님 폰에 뜨고,":
        "go onto the chain and appear on customer phones, and",
      "다음 달까지 기다리지 않습니다.":
        "No waiting until next month.",
      "단말기 임대료":
        "Terminal rental",
      "도 같습니다. 이 프로그램은 「우리를 안 믿어도 된다」를 팔고 있는데, 닫아 두면 그 말이 성립하지 않습니다. 위에 적은":
        "is the same. This program sells the idea that \"you do not have to trust us\", and keeping it closed would make that untrue. The",
      "돈은 손님 지갑에서 가게 지갑으로 바로 갑니다":
        "Money goes straight from the customer's wallet to the shop's wallet",
      "돈을 보내거나 자산을 발행하지 못합니다.":
        "cannot send money or issue assets.",
      "되돌릴 수 없는 일이라 그렇게 막아 뒀습니다 — 잘못 알아들은 AI 가 500 RVN 을 태우면 안 됩니다.":
        "These cannot be undone, so we blocked them — an AI that misheard must not burn 500 RVN.",
      "되돌릴 수 없습니다.":
        "It cannot be undone.",
      "두 번 누르지 말고 우클릭입니다. 두 번 누르면 열 방법이 안 나옵니다.":
        "Right-click, do not double-click. Double-clicking gives you no way to open it.",
      "둘 다 만들었습니다.":
        "We built both.",
      "들어온 돈이 되돌아가지 않습니다.":
        "Money that came in does not go back out.",
      "라고 하면 라비가 그 단추를 홈에 붙입니다(별표 표시, 최대 여덟 개).":
        "— say that and Ravi pins the button to your home screen (marked with a star, up to eight).",
      "라비":
        "Ravi",
      "라비가 하는 것":
        "What Ravi does",
      "라비는":
        "Ravi",
      "라비에게 물어보세요 — 예: 내 컴퓨터에서도 되나요?":
        "Ask Ravi — e.g. will it run on my computer?",
      "레이븐코인, 컴퓨터 한 대로":
        "Ravencoin, on one computer",
      "레이븐코인은":
        "Ravencoin",
      "레이븐코인은 회사가 없는 공개 블록체인입니다. 이 프로그램은 그 위에서 돕니다.":
        "Ravencoin is an open blockchain with no company behind it. This program runs on top of it.",
      "레이븐코인을 쓰려면 원래 프로그램 대여섯 개가 필요했습니다. 그걸 하나로 합쳤습니다.":
        "Using Ravencoin used to need five or six programs. We merged them into one.",
      "리눅스용":
        "For Linux",
      "만든 사람 김무송 · PLAY X (PLAX)":
        "Made by KIM, MOOSONG · PLAY X (PLAX)",
      "말로 부르면 화면을 채웁니다.":
        "Say it out loud and it fills in the screen.",
      "맥: shasum -a 256 ~/Downloads/받은파일이름":
        "Mac: shasum -a 256 ~/Downloads/your-file-name",
      "맥용":
        "For Mac",
      "맥용 (인텔)":
        "For Mac (Intel)",
      "먼저 레이븐코인 노드가 깔려 있어야 합니다.":
        "A Ravencoin node must be installed first.",
      "메뉴 넣기 · 자산 만들기 · 가게 소개 · 뭐든 묻기.":
        "Add to the menu · create an asset · write the shop introduction · ask anything.",
      "메시지":
        "Messages",
      "못 하는 것":
        "What it cannot do",
      "무엇이 들어 있나":
        "What is inside",
      "바로 되는 것":
        "Works right away",
      "받는 주소도 바꾸실 수 있습니다 — 못 끄는 것은 개발비가 아니라 세금이고, 소스가 열려 있으면 세금은 포크 한 번으로 사라집니다.":
        "You can change the receiving address too — what you cannot switch off is a tax, not a development fee, and with open source a tax disappears with a single fork.",
      "받으신 금액의 1%.":
        "1% of what you received.",
      "받은 돈은 그날 시세로 원화가 같이 적힙니다 — 세무 담당자가 묻는 숫자입니다.":
        "Money received is recorded with the day's KRW value alongside — the number your accountant asks for.",
      "받은 파일을 열고, 안의 앱을 「응용 프로그램」으로 끕니다":
        "Open the downloaded file and drag the app inside into \"Applications\"",
      "발행 · 재발행 · 유니크 · 배당.":
        "Issue · reissue · unique · payouts.",
      "번호표가 폰에 뜨고, 나오면 소리로 알려줍니다.":
        "A number appears on the phone, and a sound tells you when it is ready.",
      "부가세 계산이나 신고 대행은 하지 않습니다.":
        "We do not calculate VAT or file returns for you.",
      "붙는 곳은":
        "It applies to",
      "서식을 채워 드리고 그 화면까지 데려다 줄 뿐,":
        "It fills in the form and takes you to that screen, but",
      "설정에서 끄실 수 있습니다.":
        "You can switch it off in the settings.",
      "셋이고,":
        "these three, and",
      "소스가 전부 공개돼 있습니다 →":
        "The source is fully open →",
      "소스를 열어 둔 이유":
        "Why the source is open",
      "손님 화면":
        "The customer screen",
      "손님도 앱을 깔아야 하나요?":
        "Do customers need to install an app?",
      "손님에게 지갑이 필요합니다.":
        "Customers need a wallet.",
      "손님은 받을 것이 없습니다.":
        "Customers have nothing to download.",
      "손님은 이렇게 씁니다":
        "This is how customers use it",
      "손님이 낸 만큼 그대로 들어옵니다.":
        "What the customer paid arrives exactly as it is.",
      "수수료가 정말 1%뿐인가요?":
        "Is the fee really only 1%?",
      "수익이 나는지 먼저 계산해 드립니다":
        "We work out first whether it is profitable",
      "쓰던 컴퓨터 한 대면 됩니다.":
        "One computer you already use is enough.",
      "쓸 데가 없었습니다.":
        "there was nowhere to use it.",
      "쓸 만한 모바일 지갑이 없어서 쓰기 어렵고, 받는 가게가 없어서 팔 수가 없습니다. 둘 중 하나가 먼저 움직여야 하는데 아무도 안 움직였습니다.":
        "With no decent mobile wallet it is hard to spend, and with no shop accepting it there is nowhere to sell. One of the two had to move first, and nobody did.",
      "아직 시작 전입니다.":
        "We have not started yet.",
      "아직 쓰는 가게가 없습니다.":
        "No shop uses it yet.",
      "아직 없으시면 먼저 받으세요:":
        "If you do not have one yet, get it first:",
      "앞의 둘은 체인에, 장터는 Nostr 에 올라갑니다. 우리 서버가 아닙니다.":
        "The first two go on the chain, the marketplace goes on Nostr. Not on our servers.",
      "애플 공증을 아직 안 받아서입니다(연 12만 원, 준비 중).":
        "This is because we have not yet notarised with Apple (₩120,000 a year, in progress).",
      "애플 실리콘(M1 이상) · 0.1.0":
        "Apple Silicon (M1 or newer) · 0.1.0",
      "앱을":
        "the app",
      "어느 것을 받아야 할지 모르시겠으면":
        "If you are not sure which to download",
      "어떻게 쓰나 — 말하거나, 누르거나":
        "How you use it — speak, or tap",
      "업종별 서식이 있어서 카페든 도장이든 열면 바로 씁니다.":
        "There are templates by trade, so a cafe or a dojo can start the moment it opens.",
      "없습니다.":
        "None.",
      "열지 마세요.":
        "do not open it.",
      "오늘 얼마 · 손님 QR · 들어온 주문 · 지금 닫기.":
        "Today's takings · customer QR · orders received · close now.",
      "왜 만들었나":
        "Why we made it",
      "우리가 보는 것":
        "What we see",
      "우클릭":
        "Right-click",
      "원화로 보고, RVN으로 냅니다. 환율은 그 자리에서 계산됩니다.":
        "You see it in your currency and pay in RVN. The rate is worked out on the spot.",
      "위 「지갑 열기」로 1분이면 만들지만, 그래도 한 걸음입니다.":
        "\"Open wallet\" above makes one in a minute, but it is still a step.",
      "윈도우: Get-FileHash .\\받은파일이름 -Algorithm SHA256":
        "Windows: Get-FileHash .\\your-file-name -Algorithm SHA256",
      "윈도우용":
        "For Windows",
      "은 한국어·영어·중국어·일본어로 바뀝니다":
        "switches between Korean, English, Chinese and Japanese",
      "이 다음부터는 그냥 열립니다.":
        "After that it just opens.",
      "이 프로그램은 노드를 대신 내려받지 않고,":
        "This program does not download the node for you;",
      "이 프로그램은 노드를 대신 내려받지 않습니다.":
        "This program does not download the node for you.",
      "이 프로그램이 직접 캐지는 않습니다.":
        "This program does not mine by itself.",
      "이고, 첫 가게를 준비하는 중입니다. 지갑은 지금 바로 쓰실 수 있습니다.":
        ", and we are preparing the first shop. The wallet you can use right now.",
      "이라 배울 것이 하나뿐입니다.":
        ", so there is only one thing to learn.",
      "이미 깔린 것을 찾아 켭니다.":
        "it finds what is already installed and starts it.",
      "이미 깔아 두신 레이븐 노드·IPFS 를 켜고 씁니다.":
        "It starts and uses the Ravencoin node and IPFS you already installed.",
      "입니다.":
        ".",
      "입니다. 프리마인도 ICO도 없이 시작했고, 누구나 자기 자산을 발행할 수 있습니다. 좋은 설계인데":
        ". It launched with no premine and no ICO, and anyone can issue their own asset. A good design, but",
      "자동 백업 · 금고 자동이체 · 매출 장부(CSV).":
        "Automatic backups · auto-transfer to the vault · sales ledger (CSV).",
      "자산":
        "Assets",
      "자산을 위해 만들어진 체인":
        "a chain built for assets",
      "잘못 보낸 돈을 우리가 돌려드릴 방법이 없습니다. 그게 수수료가 없는 이유이기도 합니다.":
        "We have no way to return money you sent to the wrong place. That is also why there are no fees.",
      "장사":
        "Trading",
      "정산":
        "Settlement",
      "정직하게 — 이런 점은 감안하셔야 합니다":
        "Honestly — you should take these into account",
      "주문 · 메뉴 · 환불 · 재고 · 예약 · 출입.":
        "Orders · menu · refunds · stock · bookings · entry.",
      "지갑은 브라우저에서 바로 열리고, 가게는 컴퓨터 한 대로 시작합니다.":
        "The wallet opens right in the browser, and a shop starts with one computer.",
      "지금 1만원이면 몇 RVN?":
        "How much RVN is 10,000 won right now?",
      "지키는 것":
        "What it protects",
      "차지백":
        "Chargebacks",
      "채굴":
        "Mining",
      "채굴·그냥 보내기·자산 발행에는 안 붙습니다.":
        "It does not apply to mining, plain sends or issuing assets.",
      "처음 열 때 「확인되지 않은 개발자」가 뜹니다.":
        "The first time you open it, \"unidentified developer\" appears.",
      "첫 가게를 준비하는 중입니다.":
        "We are preparing the first shop.",
      "체인":
        "Chain",
      "체인에 등록된 가게는 지금":
        "Shops registered on the chain currently number",
      "체인에서 직접 읽습니다":
        "Read straight from the chain",
      "체인에서 직접 확인하실 수 있고,":
        "You can verify it directly on the chain, and",
      "카드 수수료":
        "Card fees",
      "켜고 끄기만":
        "only starts and stops",
      "켜면":
        "Turn it on and",
      "큰 아이콘을 누르시면":
        "tap the big icons and it",
      "테이블의 QR을 찍는다":
        "Scan the QR on the table",
      "파는 길":
        "Ways to sell",
      "프로그램을 열면 레이븐코인 노드가 켜지고, 같은 와이파이에 있는 폰에서 계산대 화면이 열립니다. 손님에게 보여줄 QR도 거기서 나옵니다.":
        "Open the program and the Ravencoin node starts; the till screen opens on phones on the same wifi. The QR you show customers comes from there too.",
      "합니다.":
        ".",
      "해시가 맞으면 이렇게 여십니다:":
        "If the hash matches, open it like this:",
      "화면을 저희가 정해 드리는 것이 아니라, 쓰시면서 늘리시는 것입니다.":
        "We do not decide your screen for you; you grow it as you use it.",
      "회원권도 상품권도 체인 위의 자산으로 만듭니다. 배당은 보유자 전원에게 한 번에 나갑니다.":
        "Memberships and gift vouchers alike become assets on the chain. Payouts go to every holder at once.",
      /* 문제 알리기(report.js) */
      "문제 알리기":
        "Report a problem",
      "무엇이 잘못됐나요?":
        "What went wrong?",
      "겪으신 것만 적어 주세요.":
        "Just write what happened to you.",
      "지갑이 안 열려요":
        "The wallet will not open",
      "보내기가 안 돼요":
        "Sending does not work",
      "주문·계산이 안 돼요":
        "Ordering or payment does not work",
      "라비가 틀리게 답해요":
        "Ravi answers incorrectly",
      "프로그램이 안 켜져요":
        "The program will not start",
      "화면 문제":
        "Something looks wrong",
      "보내는 중…":
        "Sending…",
      "고맙습니다.":
        "Thank you.",
      "보내지 못했습니다.":
        "Could not send.",
      "예: 보내기를 눌렀는데 아무 일도 없어요":
        "e.g. I pressed Send and nothing happened",
      /* ── 지갑 화면(2026-08-22). 돈이 걸린 곳이라 "되돌릴 수 없다"·
         "12단어를 잃으면 끝이다" 는 원문과 같은 무게로 옮겼다. ── */
      "내 지갑":
        "My wallet",
      "지갑을 여는 중…":
        "Opening your wallet…",
      "이 지갑은 손님 폰 안에만 있습니다. 가게도, 저희도 열 수 없습니다.":
        "This wallet lives only on your phone. Neither the shop nor we can open it.",
      "새 지갑 만들기":
        "Create a new wallet",
      "12단어로 되살리기":
        "Restore from 12 words",
      "12단어는 이 지갑의 열쇠 전부입니다. 종이에 적어 두지 않으면 폰을 바꾸거나 브라우저를 지우는 날 돈을 되찾을 방법이 없습니다.":
        "The 12 words are the entire key to this wallet. If you do not write them on paper, there is no way to get your money back the day you change phones or clear your browser.",
      "이 폰에 저장해 둔 지갑이 있습니다. 정해 두신 암호를 넣어 주세요.":
        "There is a wallet saved on this phone. Please enter the passcode you set.",
      "지문 · 얼굴로 열기":
        "Open with fingerprint or face",
      "안 되면 아래 12단어로 되살리세요. 기기를 바꾸셨다면 그 길뿐입니다.":
        "If that fails, restore with your 12 words below. If you changed devices, that is the only way.",
      "암호":
        "Passcode",
      "열기":
        "Open",
      "이 폰에서 지우고 새로 시작하기":
        "Erase from this phone and start over",
      "12단어를 종이에 적으세요":
        "Write the 12 words on paper",
      "사진으로 찍지 마세요. 카카오톡이나 메모앱에도 넣지 마세요. 종이에 적어서 남이 못 보는 곳에 두는 것이 가장 안전합니다.":
        "Do not photograph them. Do not put them in a messenger or notes app. Writing them on paper and keeping it where no one else can see is the safest.",
      "다 적었습니다":
        "I have written them down",
      "그만두기":
        "Cancel",
      "적으신 것을 확인합니다":
        "Let us check what you wrote",
      "종이를 보고 고르시면 됩니다.":
        "Just read your paper and pick.",
      "적어 두신 12단어를 순서대로 띄어쓰기로 구분해 적어 주세요.":
        "Type your 12 words in order, separated by spaces.",
      "되살리기":
        "Restore",
      "뒤로":
        "Back",
      "잠금번호를 정하세요":
        "Set a passcode",
      "이 폰에서 지갑을 열 때 씁니다.":
        "You will use it to open the wallet on this phone.",
      "숫자 6자리면 됩니다.":
        "Six digits is enough.",
      "잠금번호":
        "Passcode",
      "한 번 더":
        "Once more",
      "저장하고 시작":
        "Save and start",
      "지문 · 얼굴로 잠그기":
        "Lock with fingerprint or face",
      "잠그지 않고 쓰기":
        "Use without a lock",
      "잠금번호를 잊으면 저희도 풀어 드릴 수 없습니다. 그때는 종이에 적어 둔 12단어로만 되살릴 수 있습니다.":
        "If you forget the passcode, we cannot unlock it for you either. Then only the 12 words on your paper can restore it.",
      "지문·얼굴로 잠그면":
        "If you lock with fingerprint or face",
      "그 열쇠는 이 기기의 보안 칩 안에만 있습니다. 폰을 잃거나 바꾸면 이 브라우저의 사본은 못 엽니다 — 그때도":
        "that key lives only inside this device's secure chip. If you lose or change the phone, this browser's copy cannot be opened — even then you",
      "12단어로 되살립니다.":
        "restore with the 12 words.",
      "12단어가 원래 진짜 열쇠입니다.":
        "The 12 words are the real key all along.",
      "잠그기":
        "Lock",
      "잔액":
        "Balance",
      "받기":
        "Receive",
      "보내기":
        "Send",
      "받을 주소 ·":
        "Receiving address ·",
      "주소 복사하기":
        "Copy address",
      "잔액이 안 보이시나요? 쓰던 주소가 뒤쪽에 있을 수 있습니다.":
        "Balance not showing? An address you used before may be further back.",
      "찾아보기":
        "Search further",
      "내 물건 팔기":
        "Sell something of mine",
      "새로고침":
        "Refresh",
      "사업자가 아니어도 됩니다. 가게를 만들 필요도 없어요.":
        "You do not need to be a business. You do not need to create a shop either.",
      "무엇을 파시나요":
        "What are you selling",
      "설명":
        "Description",
      "얼마에":
        "Price",
      "원":
        "KRW",
      "달러":
        "USD",
      "어디서":
        "Where",
      "사진":
        "Photo",
      "(없어도 됩니다)":
        "(optional)",
      "사진 고르기":
        "Choose a photo",
      "사진 주소를 직접 넣기":
        "Paste a photo address instead",
      "사진은":
        "Photos are",
      "다른 곳(Nostr 사진 서버)에 보관":
        "kept somewhere else (a Nostr media server)",
      "됩니다. 저희가 갖고 있지 않아서, 그곳이 문을 닫으면 사진이 사라질 수 있습니다.":
        ". We do not hold them, so if that place shuts down the photo can disappear.",
      "연락받을 번호":
        "Phone number for replies",
      "이 번호는 전 세계 누구나 볼 수 있습니다.":
        "Anyone in the world can see this number.",
      "나중에 글을 지워도 이미 받아 간 곳에는 남습니다.":
        "Even if you delete the post later, it stays wherever it was already fetched.",
      "번호를 안 적으셔도 글은 올라가지만,":
        "The post will go up without a number, but",
      "사겠다는 사람이 연락할 방법이 없습니다.":
        "a buyer will have no way to reach you.",
      "동네 (거리 표시용)":
        "Neighbourhood (for showing distance)",
      "지금 자리":
        "Use my location",
      "누르기 전에는 위치를 읽지 않습니다. 눌러도":
        "We do not read your location until you press this. Even then only",
      "동네 정도(600m)":
        "the neighbourhood (about 600 m)",
      "만 담기고 정확한 자리는 담기지 않습니다.":
        "is included; your exact spot is not.",
      "지금 상태":
        "Status",
      "팝니다":
        "For sale",
      "판매 완료":
        "Sold",
      "예약 중":
        "Reserved",
      "이 글은 어느 회사 서버에도 안 올라갑니다.":
        "This post does not go to any company's server.",
      "공개 릴레이에 뿌려지고, 사라질 수도 있습니다. 값이 큰 물건은 가게로 등록하시는 편이 낫습니다.":
        "It is spread across public relays and may disappear. For something valuable, registering a shop is better.",
      "올린 글은":
        "A post you made",
      "지울 수 있지만":
        "can be deleted, but",
      ", 그건":
        ", that is",
      "지워 달라는 부탁":
        "a request to delete",
      "이지 명령이 아닙니다. 대부분 들어주지만 안 들어주는 곳도 있고, 이미 받아 간 사람의 화면에는 남습니다.":
        ", not an order. Most honour it, some do not, and it stays on the screen of anyone who already fetched it.",
      "올리기":
        "Post it",
      "고치기 그만두기":
        "Stop editing",
      "받은 문의":
        "Messages received",
      "지갑을 열면 여기에 보입니다.":
        "They appear here once your wallet is open.",
      "내가 올린 것":
        "What I posted",
      "보낼 수 있는 잔액":
        "Available to send",
      "받는 주소":
        "Recipient address",
      "금액 (RVN)":
        "Amount (RVN)",
      "수수료 빼고 전부 넣기":
        "Send everything minus the fee",
      "확인 화면으로":
        "Go to confirmation",
      "보낸 돈은 되돌릴 수 없습니다. 받는 주소를 한 글자씩 확인해 주세요.":
        "Money you send cannot be taken back. Please check the recipient address letter by letter.",
      "이대로 보낼까요?":
        "Send it exactly like this?",
      "받는 곳":
        "To",
      "보낼 금액":
        "Amount",
      "수수료":
        "Fee",
      "합계":
        "Total",
      "거스름":
        "Change",
      "보냈습니다":
        "Sent",
      "금액":
        "Amount",
      "거래번호":
        "Transaction ID",
      "네트워크가 확인하기까지 보통 몇 분 걸립니다. 그동안 잔액이 조금 다르게 보일 수 있습니다.":
        "The network usually takes a few minutes to confirm. Your balance may look slightly different until then.",
      "확인":
        "OK",
      "지갑":
        "Wallet",
      "가게":
        "Shops",
      "물건":
        "Items",
      "예) apple banana cherry …":
        "e.g. apple banana cherry …",
      "접이식 자전거":
        "Folding bicycle",
      "3년 썼고 잘 굴러갑니다. 직거래만 해요.":
        "Used for 3 years, rolls well. In-person only.",
      "의왕시 내손동":
        "Naeson-dong, Uiwang",
      "https://… 로 시작하는 사진 주소":
        "A photo address starting with https://",
      "누르지 않으면 비어 있습니다":
        "Empty until you press",
      "R 로 시작하는 주소":
        "An address starting with R",
      "지금 영업 중": "Open now",
      "지금은 주문을 받지 않습니다": "Not taking orders right now",
      "메뉴를 불러오는 중…": "Loading menu…",
      "메뉴를 준비하고 있어요": "The menu is being prepared",
      "품절": "Sold out",
      "주문하기": "Order",
      "궁금한 것 물어보기": "Ask a question",
      "묻기": "Ask",
      "닫기": "Close",
      "지갑 열기": "Open wallet",
      "주문번호": "Order number",
      "입금을 기다립니다": "Waiting for payment",
      "결제하시면 이 화면이 저절로 바뀝니다": "This screen changes by itself once you pay",
      "결제 확인됨": "Payment confirmed",
      "가게가 곧 시작합니다": "The shop will start soon",
      "만드는 중": "Being made",
      "조금만 기다려 주세요": "Just a moment please",
      "나왔습니다": "Ready",
      "카운터에서 받아 가세요": "Please collect it at the counter",
      "전달됨": "Handed over",
      "감사합니다": "Thank you",
      "금액이 모자랍니다": "The amount is short",
      "같은 QR로 나머지를 마저 보내 주세요": "Please send the rest using the same QR",
      "시간이 지난 뒤 도착했습니다": "It arrived after the quote expired",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "The money did arrive — please show this at the counter",
      "결제": "Paid",
      "나왔어요": "Ready",
      "매장·포장": "Dine in / takeaway",
      "배달": "Delivery",
      "지갑이 없으신가요?": "No wallet yet?",
      "1분이면 만듭니다": "It takes a minute",
      "개 남음": " left",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "The amount is filled in when the wallet opens. Just send it.",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "The assistant answers only from what this shop uploaded. When in doubt, ask the shop.",
    },
    ja: {
      /* 장터·랜딩(2026-08-22) */
      "Groq 에서 공짜로 받으실 수 있어요":
        "Groqで無料でもらえます",
      "Groq 은 공짜":
        "Groqは無料",
      "Ravi 깨우기":
        "Raviを起こす",
      "Ravi에게 물어보기":
        "Raviに聞いてみる",
      "xai- · sk-ant- · AIza · sk- · gsk_ 로 시작하는 열쇠":
        "xai-・sk-ant-・AIza・sk-・gsk_ で始まるキー",
      "— 처음 보는 가게에 큰 돈을 보내기 전에 확인하세요.":
        "— 初めて見るお店に大きなお金を送る前に確認してください。",
      "♡ 찜":
        "♡ お気に入り",
      "가게 목록을 불러오지 못했습니다.":
        "お店の一覧を読み込めませんでした。",
      "가게 이름":
        "お店の名前",
      "가게 정보는 각 가게가 직접 올린 것입니다. 아무도 검사하지 않습니다":
        "お店の情報は各店舗が自分で載せたものです。誰も検査していません",
      "가게 찾기":
        "お店を探す",
      "가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "お店が載せた情報だけで答えます。確かでないときはお店に直接確認してください。",
      "가까운 순으로":
        "近い順",
      "견과류 들어간 메뉴 있나요?":
        "ナッツが入ったメニューはありますか？",
      "남의 컴퓨터에서는 넣지 마세요.":
        "他人のパソコンでは入力しないでください。",
      "내 물건 올리기":
        "自分の品物を出す",
      "내 열쇠로 쓰기":
        "自分のキーで使う",
      "내 열쇠로 쓰기 →":
        "自分のキーで使う →",
      "다만 이 화면은 지갑과 같은 곳에 있으니,":
        "ただしこの画面はウォレットと同じ場所にあるので、",
      "답할 말":
        "返答する言語",
      "라비가 자고 있어요. 열쇠를 넣으면 깨어납니다.":
        "Raviは眠っています。キーを入れると目を覚まします。",
      "무엇을 찾으세요?":
        "何をお探しですか？",
      "받기 →":
        "取得する →",
      "받은 글자를 그대로 아래에 붙여 넣으세요. 어느 회사 것인지는":
        "受け取った文字列をそのまま下に貼り付けてください。どの会社のものかは",
      "불러오는 중…":
        "読み込み中…",
      "아래 어느 곳이든 열쇠를 받아 넣으시면 한도 없이 물어보실 수 있어요.":
        "下のどこかでキーをもらって入れれば、制限なく質問できます。",
      "앞글자로 알아서 알아봅니다.":
        "先頭の文字で自動的に判別します。",
      "열쇠는":
        "キーは",
      "이 가게에 대해 물어보세요.":
        "このお店について聞いてください。",
      "이 목록을 가진 회사는 없습니다. 블록체인에서 그때그때 읽어 옵니다.":
        "この一覧を持つ会社はありません。そのつどブロックチェーンから読み込みます。",
      "이 브라우저에만":
        "このブラウザにだけ",
      "이고, 나머지는 쓴 만큼 그 회사에 내십니다.":
        "で、ほかは使った分だけその会社に払います。",
      "잠시 뒤에 다시 열어 주세요.":
        "少し後にもう一度開いてください。",
      "저장됩니다. 우리 서버는 물어볼 때 잠깐 쓰고 저장하지 않아요.":
        "保存されます。私たちのサーバーは質問のときに一瞬使うだけで保存しません。",
      "저장하고 이어가기":
        "保存して続ける",
      "(가게가 적은 메뉴 이름까지 번역하지는 않습니다).":
        "（お店が書いたメニュー名までは翻訳しません）。",
      "0곳":
        "0店",
      "1:1 문의":
        "1対1の問い合わせ",
      "1분 뒤 끝":
        "1分で終わり",
      "1분, 앱 설치 없음":
        "1分、アプリのインストール不要",
      "1분.":
        "1分。",
      "2020년 이전 맥 · 0.1.0":
        "2020年より前のMac・0.1.0",
      "34GB 정도를 내려받습니다":
        "約34GBをダウンロードします",
      "AI 열쇠 없이 됩니다. 매출을 보는 데 남의 회사에 돈을 낼 이유가 없고, 열쇠가 없다고 매출을 못 보면 그건 이 프로그램이 남의 회사에 묶인 것입니다.":
        "AIキーなしで使えます。売上を見るのに他社にお金を払う理由はありませんし、キーがないと売上が見られないなら、それはこのプログラムが他社に縛られているということです。",
      "AI 열쇠를 한 번 넣으시면 되고, 어느 회사든 됩니다 — Grok · Claude · Gemini · ChatGPT · Groq.":
        "AIキーを一度入れるだけです。どの会社でも構いません — Grok・Claude・Gemini・ChatGPT・Groq。",
      "IPFS(프로그램 안에서는 「파일창고」)는 없어도 장사는 됩니다 — 메뉴 사진과 자산에 붙는 그림·음악에만 씁니다.":
        "IPFS（プログラム内では「ファイル倉庫」）がなくても商売はできます — メニューの写真とアセットに付く画像・音楽にだけ使います。",
      "RVN 가격이 오르내리므로, 받은 코인을 바로 바꾸지 않으면 금액이 달라집니다.":
        "RVNの価格は上下するので、受け取ったコインをすぐ換えないと金額が変わります。",
      "ravencoin.org 에서 노드 받기 →":
        "ravencoin.org でノードを入手 →",
      "· 문의":
        "・問い合わせ",
      "— 블록체인 전부를 가게 컴퓨터가 직접 갖기 때문이고, 그래서 우리가 매출을 못 봅니다. 처음 한 번은 반나절쯤 걸립니다.":
        "— ブロックチェーン全体をお店のパソコンが自分で持つからで、だから私たちには売上が見えません。最初の一度は半日ほどかかります。",
      "— 애플 로고가 있는 컴퓨터면 맥, 시작 단추가 있으면 윈도우입니다. 2020년 이후 산 맥이면 「애플 실리콘」이 맞습니다.":
        "— Appleのロゴがあればマック、スタートボタンがあればWindowsです。2020年以降に買ったマックなら「Apple Silicon」で合っています。",
      "— 여태 프로그램 예닐곱 개로 하던 일을 한 창에 모았습니다.":
        "— これまでプログラム6〜7個でしていたことを一つの窓にまとめました。",
      "— 우리 서버를 지나가지 않습니다. 다만 개발비 1% 는 우리가 받습니다(아래).":
        "— 私たちのサーバーを経由しません。ただし開発費1%は私たちが受け取ります（下記）。",
      "— 전기값과 그래픽카드를 넣으면 하루에 얼마인지 나옵니다. 채굴기는 받아 두신 것을":
        "— 電気代とグラフィックカードを入れると1日いくらか出ます。マイナーは用意されたものを",
      "— 터미널(맥)이나 PowerShell(윈도우)에 아래를 넣으면 나오는 값이 여기 적힌 것과 같아야 합니다. 다르면 받다가 깨졌거나 누가 바꾼 것이니":
        "— ターミナル（Mac）やPowerShell（Windows）に下を入れて出る値が、ここに書かれたものと同じでなければなりません。違えばダウンロードが壊れたか誰かが変えたので",
      "① 받은 파일이 맞는지 먼저 확인하세요.":
        "① まず受け取ったファイルが正しいか確認してください。",
      "「맨날 하는 일이니 단추로 만들어줘」":
        "「毎日やることだからボタンにして」",
      "「열기」를 한 번 더 누릅니다":
        "「開く」をもう一度押します",
      "「우리가 보는 것: 없습니다」":
        "「私たちが見るもの：ありません」",
      "「확인되지 않은 개발자」를 그냥 넘기라고 가르치는 안내는 나쁜 프로그램도 똑같이 씁니다. 해시가 같아야 우리가 만든 그 파일입니다.":
        "「開発元が未確認」をそのまま無視するよう教える案内は、悪いプログラムも同じように使います。ハッシュが一致してこそ私たちが作ったそのファイルです。",
      "가 옆에 있습니다. 사장님께는 도우미로, 손님께는 가게를 대신해 답합니다.":
        "がそばにいます。店主には助手として、お客様にはお店に代わって答えます。",
      "가 첫 화면입니다. 하고 싶은 일을 그냥 말씀하시면 되고, 말하기 번거로운 날은":
        "が最初の画面です。やりたいことをそのまま話せばよく、話すのが面倒な日は",
      "가게 결제·자동판매기·중고 거래":
        "店舗決済・自動販売機・中古取引",
      "가게 계산대 · 자동판매기 · 중고 장터.":
        "店舗レジ・自動販売機・中古市場。",
      "가게 공지":
        "お店のお知らせ",
      "가게 둘러보기":
        "お店を見て回る",
      "가게 컴퓨터 한 대에만":
        "お店のパソコン1台だけに",
      "가게 컴퓨터가 손님 폰에 직접 답합니다. 매출이 우리 서버를 지나가지 않아서, 요구받아도 넘길 것이 없습니다.":
        "お店のパソコンがお客様の端末に直接答えます。売上が私たちのサーバーを通らないので、求められても渡すものがありません。",
      "가게 화면이 폰에 뜹니다. 앱 설치 없음.":
        "お店の画面が端末に表示されます。アプリのインストールは不要。",
      "가게는 무엇을 얻나요":
        "お店は何を得ますか",
      "가게를 하시나요?":
        "お店をされていますか？",
      "가게용 프로그램 내려받기":
        "店舗用プログラムをダウンロード",
      "가게용 프로그램 받기 →":
        "店舗用プログラムを入手 →",
      "값이 하루 사이에 움직입니다.":
        "価格は一日のうちに動きます。",
      "같은 길":
        "同じ道",
      "같은 일이 됩니다. 누르는 것과 말하는 것이":
        "同じことになります。押すことと話すことが",
      "개발비":
        "開発費",
      "고르고 보낸다":
        "選んで送る",
      "그 경고를 넘기기 전에 아래 해시부터 맞춰 보세요.":
        "その警告を無視する前に、下のハッシュを確かめてください。",
      "그래서":
        "そのため",
      "그리고":
        "そして",
      "깐 다음에 무엇을 하나요.":
        "インストールしたあと何をするか。",
      "깔 것도, 가입할 것도 없습니다.":
        "インストールも登録も不要です。",
      "깝니다.":
        "入れます。",
      "나머지 99%는 사장님 지갑으로 바로 들어옵니다. 손님이 더 내는 것이 아니라 받으신 돈에서 나뉩니다.":
        "残り99%は店主のウォレットに直接入ります。お客様が余分に払うのではなく、受け取った金額から分かれます。",
      "남에게 묻지 않고 스스로 확인하기 때문에, 우리가 매출을 못 봅니다.":
        "誰かに尋ねるのではなく自分で確認するので、私たちには売上が見えません。",
      "내 단추 만들기":
        "自分のボタンを作る",
      "내 컴퓨터에서도 되나요?":
        "私のパソコンでも動きますか？",
      "노드·채굴·IPFS·자산·배당·계산대·장터·AI":
        "ノード・マイニング・IPFS・アセット・配当・レジ・市場・AI",
      "노드를 꼭 깔아야 하나요?":
        "ノードは必ず入れないといけませんか？",
      "노드와 IPFS 는 따로 깔아 두셔야 합니다.":
        "ノードとIPFSは別途インストールしておく必要があります。",
      "누르는 것은 사장님":
        "押すのは店主です",
      "는 소스를 열어 보셔야 확인됩니다. 고쳐 주시거나 가져다 쓰셔도 됩니다.":
        "はソースを見て確かめてください。直していただいても、持って行って使っていただいても構いません。",
      "는 잠가서 주고받습니다 — 전화번호를 공개하지 않으셔도 됩니다.":
        "はロックしてやり取りします — 電話番号を公開する必要はありません。",
      "는 체인에 올라가 손님 폰에 뜨고,":
        "はチェーンに載ってお客様の端末に表示され、",
      "다음 달까지 기다리지 않습니다.":
        "翌月まで待ちません。",
      "단말기 임대료":
        "端末レンタル料",
      "도 같습니다. 이 프로그램은 「우리를 안 믿어도 된다」를 팔고 있는데, 닫아 두면 그 말이 성립하지 않습니다. 위에 적은":
        "も同じです。このプログラムは「私たちを信じなくていい」を売っているのに、閉じていてはその言葉が成り立ちません。上に書いた",
      "돈은 손님 지갑에서 가게 지갑으로 바로 갑니다":
        "お金はお客様のウォレットからお店のウォレットへ直接行きます",
      "돈을 보내거나 자산을 발행하지 못합니다.":
        "お金を送ったりアセットを発行したりはできません。",
      "되돌릴 수 없는 일이라 그렇게 막아 뒀습니다 — 잘못 알아들은 AI 가 500 RVN 을 태우면 안 됩니다.":
        "取り消せないことなので、そう塞いであります — 聞き違えたAIが500 RVNを焼いてはいけません。",
      "되돌릴 수 없습니다.":
        "元に戻せません。",
      "두 번 누르지 말고 우클릭입니다. 두 번 누르면 열 방법이 안 나옵니다.":
        "ダブルクリックではなく右クリックです。ダブルクリックすると開く方法が出てきません。",
      "둘 다 만들었습니다.":
        "両方作りました。",
      "들어온 돈이 되돌아가지 않습니다.":
        "入ったお金が戻っていくことはありません。",
      "라고 하면 라비가 그 단추를 홈에 붙입니다(별표 표시, 최대 여덟 개).":
        "と言えば、Raviがそのボタンをホームに貼ります（星印、最大8個）。",
      "라비":
        "Ravi",
      "라비가 하는 것":
        "Raviがすること",
      "라비는":
        "Raviは",
      "라비에게 물어보세요 — 예: 내 컴퓨터에서도 되나요?":
        "Raviに聞いてみてください — 例：私のパソコンでも動きますか？",
      "레이븐코인, 컴퓨터 한 대로":
        "Ravencoinを、パソコン1台で",
      "레이븐코인은":
        "Ravencoinは",
      "레이븐코인은 회사가 없는 공개 블록체인입니다. 이 프로그램은 그 위에서 돕니다.":
        "Ravencoinは会社のない公開ブロックチェーンです。このプログラムはその上で動きます。",
      "레이븐코인을 쓰려면 원래 프로그램 대여섯 개가 필요했습니다. 그걸 하나로 합쳤습니다.":
        "Ravencoinを使うには本来プログラムが5〜6個必要でした。それを一つにまとめました。",
      "리눅스용":
        "Linux用",
      "만든 사람 김무송 · PLAY X (PLAX)":
        "制作：KIM, MOOSONG・PLAY X（PLAX）",
      "말로 부르면 화면을 채웁니다.":
        "話しかければ画面を埋めます。",
      "맥: shasum -a 256 ~/Downloads/받은파일이름":
        "Mac: shasum -a 256 ~/Downloads/受け取ったファイル名",
      "맥용":
        "Mac用",
      "맥용 (인텔)":
        "Mac用（Intel）",
      "먼저 레이븐코인 노드가 깔려 있어야 합니다.":
        "先にRavencoinノードがインストールされている必要があります。",
      "메뉴 넣기 · 자산 만들기 · 가게 소개 · 뭐든 묻기.":
        "メニューに入れる・アセットを作る・お店の紹介・何でも聞く。",
      "메시지":
        "メッセージ",
      "못 하는 것":
        "できないこと",
      "무엇이 들어 있나":
        "何が入っているか",
      "바로 되는 것":
        "すぐ使えること",
      "받는 주소도 바꾸실 수 있습니다 — 못 끄는 것은 개발비가 아니라 세금이고, 소스가 열려 있으면 세금은 포크 한 번으로 사라집니다.":
        "受取アドレスも変えられます — 切れないものは開発費ではなく税金であり、ソースが開いていれば税金はフォーク一回で消えます。",
      "받으신 금액의 1%.":
        "受け取った金額の1%。",
      "받은 돈은 그날 시세로 원화가 같이 적힙니다 — 세무 담당자가 묻는 숫자입니다.":
        "受け取ったお金はその日のレートでウォン換算も一緒に記録されます — 税務担当者が尋ねる数字です。",
      "받은 파일을 열고, 안의 앱을 「응용 프로그램」으로 끕니다":
        "受け取ったファイルを開き、中のアプリを「アプリケーション」へドラッグします",
      "발행 · 재발행 · 유니크 · 배당.":
        "発行・再発行・ユニーク・配当。",
      "번호표가 폰에 뜨고, 나오면 소리로 알려줍니다.":
        "番号札が端末に表示され、出来上がると音で知らせます。",
      "부가세 계산이나 신고 대행은 하지 않습니다.":
        "消費税の計算や申告代行はしません。",
      "붙는 곳은":
        "かかるのは",
      "서식을 채워 드리고 그 화면까지 데려다 줄 뿐,":
        "書式を埋めてその画面まで連れて行くだけで、",
      "설정에서 끄실 수 있습니다.":
        "設定でオフにできます。",
      "셋이고,":
        "この3つで、",
      "소스가 전부 공개돼 있습니다 →":
        "ソースはすべて公開されています →",
      "소스를 열어 둔 이유":
        "ソースを公開している理由",
      "손님 화면":
        "お客様の画面",
      "손님도 앱을 깔아야 하나요?":
        "お客様もアプリを入れる必要がありますか？",
      "손님에게 지갑이 필요합니다.":
        "お客様にはウォレットが必要です。",
      "손님은 받을 것이 없습니다.":
        "お客様が受け取るものはありません。",
      "손님은 이렇게 씁니다":
        "お客様はこう使います",
      "손님이 낸 만큼 그대로 들어옵니다.":
        "お客様が払った分がそのまま入ります。",
      "수수료가 정말 1%뿐인가요?":
        "手数料は本当に1%だけですか？",
      "수익이 나는지 먼저 계산해 드립니다":
        "まず採算が合うか計算します",
      "쓰던 컴퓨터 한 대면 됩니다.":
        "今使っているパソコン1台で足ります。",
      "쓸 데가 없었습니다.":
        "使うところがありませんでした。",
      "쓸 만한 모바일 지갑이 없어서 쓰기 어렵고, 받는 가게가 없어서 팔 수가 없습니다. 둘 중 하나가 먼저 움직여야 하는데 아무도 안 움직였습니다.":
        "まともなモバイルウォレットがなくて使いにくく、受け取るお店がなくて売れません。どちらかが先に動く必要があるのに、誰も動きませんでした。",
      "아직 시작 전입니다.":
        "まだ始まっていません。",
      "아직 쓰는 가게가 없습니다.":
        "まだ使っているお店はありません。",
      "아직 없으시면 먼저 받으세요:":
        "まだお持ちでなければ、先に入手してください：",
      "앞의 둘은 체인에, 장터는 Nostr 에 올라갑니다. 우리 서버가 아닙니다.":
        "前の2つはチェーンに、市場はNostrに載ります。私たちのサーバーではありません。",
      "애플 공증을 아직 안 받아서입니다(연 12만 원, 준비 중).":
        "Appleの公証をまだ受けていないためです（年12万ウォン、準備中）。",
      "애플 실리콘(M1 이상) · 0.1.0":
        "Apple Silicon（M1以降）・0.1.0",
      "앱을":
        "アプリを",
      "어느 것을 받아야 할지 모르시겠으면":
        "どれをダウンロードすればよいか分からない場合",
      "어떻게 쓰나 — 말하거나, 누르거나":
        "どう使うか — 話すか、押すか",
      "업종별 서식이 있어서 카페든 도장이든 열면 바로 씁니다.":
        "業種別の書式があるので、カフェでも道場でも開いてすぐ使えます。",
      "없습니다.":
        "ありません。",
      "열지 마세요.":
        "開かないでください。",
      "오늘 얼마 · 손님 QR · 들어온 주문 · 지금 닫기.":
        "今日の売上・お客様用QR・届いた注文・今すぐ閉める。",
      "왜 만들었나":
        "なぜ作ったか",
      "우리가 보는 것":
        "私たちが見るもの",
      "우클릭":
        "右クリック",
      "원화로 보고, RVN으로 냅니다. 환율은 그 자리에서 계산됩니다.":
        "自国通貨で見て、RVNで払います。レートはその場で計算されます。",
      "위 「지갑 열기」로 1분이면 만들지만, 그래도 한 걸음입니다.":
        "上の「ウォレットを開く」で1分で作れますが、それでも一手間です。",
      "윈도우: Get-FileHash .\\받은파일이름 -Algorithm SHA256":
        "Windows: Get-FileHash .\\受け取ったファイル名 -Algorithm SHA256",
      "윈도우용":
        "Windows用",
      "은 한국어·영어·중국어·일본어로 바뀝니다":
        "は韓国語・英語・中国語・日本語に切り替わります",
      "이 다음부터는 그냥 열립니다.":
        "次からはそのまま開きます。",
      "이 프로그램은 노드를 대신 내려받지 않고,":
        "このプログラムはノードを代わりにダウンロードせず、",
      "이 프로그램은 노드를 대신 내려받지 않습니다.":
        "このプログラムはノードを代わりにダウンロードしません。",
      "이 프로그램이 직접 캐지는 않습니다.":
        "このプログラム自体が掘るわけではありません。",
      "이고, 첫 가게를 준비하는 중입니다. 지갑은 지금 바로 쓰실 수 있습니다.":
        "で、最初のお店を準備中です。ウォレットは今すぐ使えます。",
      "이라 배울 것이 하나뿐입니다.":
        "なので覚えることは一つだけです。",
      "이미 깔린 것을 찾아 켭니다.":
        "すでに入っているものを探して起動します。",
      "이미 깔아 두신 레이븐 노드·IPFS 를 켜고 씁니다.":
        "すでにインストール済みのRavencoinノードとIPFSを起動して使います。",
      "입니다.":
        "です。",
      "입니다. 프리마인도 ICO도 없이 시작했고, 누구나 자기 자산을 발행할 수 있습니다. 좋은 설계인데":
        "です。プレマインもICOもなく始まり、誰でも自分のアセットを発行できます。良い設計なのに",
      "자동 백업 · 금고 자동이체 · 매출 장부(CSV).":
        "自動バックアップ・金庫への自動送金・売上台帳（CSV）。",
      "자산":
        "アセット",
      "자산을 위해 만들어진 체인":
        "アセットのために作られたチェーン",
      "잘못 보낸 돈을 우리가 돌려드릴 방법이 없습니다. 그게 수수료가 없는 이유이기도 합니다.":
        "誤って送ったお金を私たちが返す方法はありません。それが手数料がない理由でもあります。",
      "장사":
        "商売",
      "정산":
        "精算",
      "정직하게 — 이런 점은 감안하셔야 합니다":
        "正直に — この点はご承知おきください",
      "주문 · 메뉴 · 환불 · 재고 · 예약 · 출입.":
        "注文・メニュー・返金・在庫・予約・入退室。",
      "지갑은 브라우저에서 바로 열리고, 가게는 컴퓨터 한 대로 시작합니다.":
        "ウォレットはブラウザですぐ開き、お店はパソコン1台で始まります。",
      "지금 1만원이면 몇 RVN?":
        "今1万ウォンで何RVN？",
      "지키는 것":
        "守るもの",
      "차지백":
        "チャージバック",
      "채굴":
        "マイニング",
      "채굴·그냥 보내기·자산 발행에는 안 붙습니다.":
        "マイニング・通常の送金・アセット発行にはかかりません。",
      "처음 열 때 「확인되지 않은 개발자」가 뜹니다.":
        "初めて開くとき「開発元が未確認」と表示されます。",
      "첫 가게를 준비하는 중입니다.":
        "最初のお店を準備中です。",
      "체인":
        "チェーン",
      "체인에 등록된 가게는 지금":
        "チェーンに登録されたお店は今",
      "체인에서 직접 읽습니다":
        "チェーンから直接読み込みます",
      "체인에서 직접 확인하실 수 있고,":
        "チェーンで直接確認でき、",
      "카드 수수료":
        "カード手数料",
      "켜고 끄기만":
        "起動と停止だけ",
      "켜면":
        "オンにすると",
      "큰 아이콘을 누르시면":
        "大きなアイコンを押せば",
      "테이블의 QR을 찍는다":
        "テーブルのQRを読み取る",
      "파는 길":
        "売る手段",
      "프로그램을 열면 레이븐코인 노드가 켜지고, 같은 와이파이에 있는 폰에서 계산대 화면이 열립니다. 손님에게 보여줄 QR도 거기서 나옵니다.":
        "プログラムを開くとRavencoinノードが起動し、同じwifiの端末でレジ画面が開きます。お客様に見せるQRもそこから出ます。",
      "합니다.":
        "します。",
      "해시가 맞으면 이렇게 여십니다:":
        "ハッシュが一致したら、こうやって開いてください：",
      "화면을 저희가 정해 드리는 것이 아니라, 쓰시면서 늘리시는 것입니다.":
        "画面は私たちが決めるのではなく、使いながら増やしていくものです。",
      "회원권도 상품권도 체인 위의 자산으로 만듭니다. 배당은 보유자 전원에게 한 번에 나갑니다.":
        "会員券も商品券もチェーン上のアセットにします。配当は保有者全員へ一度に届きます。",
      /* 문제 알리기(report.js) */
      "문제 알리기":
        "問題を知らせる",
      "무엇이 잘못됐나요?":
        "何がうまくいきませんでしたか？",
      "겪으신 것만 적어 주세요.":
        "起きたことだけ書いてください。",
      "지갑이 안 열려요":
        "ウォレットが開きません",
      "보내기가 안 돼요":
        "送金できません",
      "주문·계산이 안 돼요":
        "注文・会計ができません",
      "라비가 틀리게 답해요":
        "Raviの答えが間違っています",
      "프로그램이 안 켜져요":
        "プログラムが起動しません",
      "화면 문제":
        "画面の問題",
      "보내는 중…":
        "送信中…",
      "고맙습니다.":
        "ありがとうございます。",
      "보내지 못했습니다.":
        "送信できませんでした。",
      "예: 보내기를 눌렀는데 아무 일도 없어요":
        "例：送るを押しても何も起きません",
      /* ── 지갑 화면(2026-08-22). 돈이 걸린 곳이라 "되돌릴 수 없다"·
         "12단어를 잃으면 끝이다" 는 원문과 같은 무게로 옮겼다. ── */
      "내 지갑":
        "マイウォレット",
      "지갑을 여는 중…":
        "ウォレットを開いています…",
      "이 지갑은 손님 폰 안에만 있습니다. 가게도, 저희도 열 수 없습니다.":
        "このウォレットはお客様の端末の中だけにあります。お店も私たちも開けません。",
      "새 지갑 만들기":
        "新しいウォレットを作る",
      "12단어로 되살리기":
        "12単語で復元する",
      "12단어는 이 지갑의 열쇠 전부입니다. 종이에 적어 두지 않으면 폰을 바꾸거나 브라우저를 지우는 날 돈을 되찾을 방법이 없습니다.":
        "12単語がこのウォレットの鍵のすべてです。紙に書き留めていないと、端末を替えた日やブラウザを消した日に、お金を取り戻す方法はありません。",
      "이 폰에 저장해 둔 지갑이 있습니다. 정해 두신 암호를 넣어 주세요.":
        "この端末に保存されたウォレットがあります。設定したパスコードを入力してください。",
      "지문 · 얼굴로 열기":
        "指紋・顔認証で開く",
      "안 되면 아래 12단어로 되살리세요. 기기를 바꾸셨다면 그 길뿐입니다.":
        "うまくいかない場合は下の12単語で復元してください。端末を替えたなら、その方法しかありません。",
      "암호":
        "パスコード",
      "열기":
        "開く",
      "이 폰에서 지우고 새로 시작하기":
        "この端末から消して最初から始める",
      "12단어를 종이에 적으세요":
        "12単語を紙に書いてください",
      "사진으로 찍지 마세요. 카카오톡이나 메모앱에도 넣지 마세요. 종이에 적어서 남이 못 보는 곳에 두는 것이 가장 안전합니다.":
        "写真に撮らないでください。メッセージアプリやメモアプリにも入れないでください。紙に書いて他人の目に触れない場所に置くのが最も安全です。",
      "다 적었습니다":
        "書き終えました",
      "그만두기":
        "やめる",
      "적으신 것을 확인합니다":
        "書いたものを確認します",
      "종이를 보고 고르시면 됩니다.":
        "紙を見ながら選んでください。",
      "적어 두신 12단어를 순서대로 띄어쓰기로 구분해 적어 주세요.":
        "書き留めた12単語を順番に、スペースで区切って入力してください。",
      "되살리기":
        "復元する",
      "뒤로":
        "戻る",
      "잠금번호를 정하세요":
        "パスコードを決めてください",
      "이 폰에서 지갑을 열 때 씁니다.":
        "この端末でウォレットを開くときに使います。",
      "숫자 6자리면 됩니다.":
        "数字6桁で十分です。",
      "잠금번호":
        "パスコード",
      "한 번 더":
        "もう一度",
      "저장하고 시작":
        "保存して始める",
      "지문 · 얼굴로 잠그기":
        "指紋・顔認証でロックする",
      "잠그지 않고 쓰기":
        "ロックせずに使う",
      "잠금번호를 잊으면 저희도 풀어 드릴 수 없습니다. 그때는 종이에 적어 둔 12단어로만 되살릴 수 있습니다.":
        "パスコードを忘れると、私たちにも解除できません。そのときは紙に書いた12単語でしか復元できません。",
      "지문·얼굴로 잠그면":
        "指紋・顔認証でロックすると",
      "그 열쇠는 이 기기의 보안 칩 안에만 있습니다. 폰을 잃거나 바꾸면 이 브라우저의 사본은 못 엽니다 — 그때도":
        "その鍵はこの端末のセキュアチップの中だけにあります。端末を失くしたり替えたりすると、このブラウザの控えは開けません — そのときも",
      "12단어로 되살립니다.":
        "12単語で復元します。",
      "12단어가 원래 진짜 열쇠입니다.":
        "12単語こそが本当の鍵です。",
      "잠그기":
        "ロックする",
      "잔액":
        "残高",
      "받기":
        "受け取る",
      "보내기":
        "送る",
      "받을 주소 ·":
        "受取アドレス ·",
      "주소 복사하기":
        "アドレスをコピー",
      "잔액이 안 보이시나요? 쓰던 주소가 뒤쪽에 있을 수 있습니다.":
        "残高が見えませんか？以前使ったアドレスが後ろにあるかもしれません。",
      "찾아보기":
        "さらに探す",
      "내 물건 팔기":
        "自分の品物を売る",
      "새로고침":
        "再読み込み",
      "사업자가 아니어도 됩니다. 가게를 만들 필요도 없어요.":
        "事業者でなくても大丈夫です。お店を作る必要もありません。",
      "무엇을 파시나요":
        "何を売りますか",
      "설명":
        "説明",
      "얼마에":
        "価格",
      "원":
        "ウォン",
      "달러":
        "ドル",
      "어디서":
        "場所",
      "사진":
        "写真",
      "(없어도 됩니다)":
        "（なくても大丈夫です）",
      "사진 고르기":
        "写真を選ぶ",
      "사진 주소를 직접 넣기":
        "写真のアドレスを直接入れる",
      "사진은":
        "写真は",
      "다른 곳(Nostr 사진 서버)에 보관":
        "別の場所（Nostrのメディアサーバー）に保管",
      "됩니다. 저희가 갖고 있지 않아서, 그곳이 문을 닫으면 사진이 사라질 수 있습니다.":
        "されます。私たちは持っていないので、そこが閉じると写真が消えることがあります。",
      "연락받을 번호":
        "連絡先の電話番号",
      "이 번호는 전 세계 누구나 볼 수 있습니다.":
        "この番号は世界中の誰でも見られます。",
      "나중에 글을 지워도 이미 받아 간 곳에는 남습니다.":
        "後から投稿を消しても、すでに取得された先には残ります。",
      "번호를 안 적으셔도 글은 올라가지만,":
        "番号を書かなくても投稿はできますが、",
      "사겠다는 사람이 연락할 방법이 없습니다.":
        "買いたい人が連絡する手段がありません。",
      "동네 (거리 표시용)":
        "エリア（距離表示用）",
      "지금 자리":
        "現在地を使う",
      "누르기 전에는 위치를 읽지 않습니다. 눌러도":
        "押すまで位置情報は読みません。押しても",
      "동네 정도(600m)":
        "エリア程度（約600m）",
      "만 담기고 정확한 자리는 담기지 않습니다.":
        "だけが含まれ、正確な位置は含まれません。",
      "지금 상태":
        "状態",
      "팝니다":
        "販売中",
      "판매 완료":
        "売却済み",
      "예약 중":
        "予約中",
      "이 글은 어느 회사 서버에도 안 올라갑니다.":
        "この投稿はどの会社のサーバーにも上がりません。",
      "공개 릴레이에 뿌려지고, 사라질 수도 있습니다. 값이 큰 물건은 가게로 등록하시는 편이 낫습니다.":
        "公開リレーに配られ、消えることもあります。高価な品物はお店として登録するほうが安全です。",
      "올린 글은":
        "投稿した記事は",
      "지울 수 있지만":
        "消せますが、",
      ", 그건":
        "それは",
      "지워 달라는 부탁":
        "消してほしいというお願い",
      "이지 명령이 아닙니다. 대부분 들어주지만 안 들어주는 곳도 있고, 이미 받아 간 사람의 화면에는 남습니다.":
        "であって命令ではありません。多くは応じますが応じない所もあり、すでに取得した人の画面には残ります。",
      "올리기":
        "投稿する",
      "고치기 그만두기":
        "編集をやめる",
      "받은 문의":
        "受け取った問い合わせ",
      "지갑을 열면 여기에 보입니다.":
        "ウォレットを開くとここに表示されます。",
      "내가 올린 것":
        "自分の投稿",
      "보낼 수 있는 잔액":
        "送れる残高",
      "받는 주소":
        "受取アドレス",
      "금액 (RVN)":
        "金額（RVN）",
      "수수료 빼고 전부 넣기":
        "手数料を除いて全額",
      "확인 화면으로":
        "確認画面へ",
      "보낸 돈은 되돌릴 수 없습니다. 받는 주소를 한 글자씩 확인해 주세요.":
        "送ったお金は取り戻せません。受取アドレスを一文字ずつ確認してください。",
      "이대로 보낼까요?":
        "この内容で送りますか？",
      "받는 곳":
        "送り先",
      "보낼 금액":
        "送る金額",
      "수수료":
        "手数料",
      "합계":
        "合計",
      "거스름":
        "おつり",
      "보냈습니다":
        "送りました",
      "금액":
        "金額",
      "거래번호":
        "取引ID",
      "네트워크가 확인하기까지 보통 몇 분 걸립니다. 그동안 잔액이 조금 다르게 보일 수 있습니다.":
        "ネットワークの確認まで通常数分かかります。その間、残高が少し違って見えることがあります。",
      "확인":
        "OK",
      "지갑":
        "ウォレット",
      "가게":
        "お店",
      "물건":
        "品物",
      "예) apple banana cherry …":
        "例）apple banana cherry …",
      "접이식 자전거":
        "折りたたみ自転車",
      "3년 썼고 잘 굴러갑니다. 직거래만 해요.":
        "3年使いましたがよく走ります。手渡しのみです。",
      "의왕시 내손동":
        "ソウル近郊・ウイワン市ネソン洞",
      "https://… 로 시작하는 사진 주소":
        "https:// で始まる写真のアドレス",
      "누르지 않으면 비어 있습니다":
        "押すまで空のままです",
      "R 로 시작하는 주소":
        "R で始まるアドレス",
      "지금 영업 중": "営業中",
      "지금은 주문을 받지 않습니다": "ただいま注文を受け付けていません",
      "메뉴를 불러오는 중…": "メニューを読み込み中…",
      "메뉴를 준비하고 있어요": "メニューを準備しています",
      "품절": "売り切れ",
      "주문하기": "注文する",
      "궁금한 것 물어보기": "質問する",
      "묻기": "聞く",
      "닫기": "閉じる",
      "지갑 열기": "ウォレットを開く",
      "주문번호": "注文番号",
      "입금을 기다립니다": "お支払いをお待ちしています",
      "결제하시면 이 화면이 저절로 바뀝니다": "お支払いいただくとこの画面が自動で変わります",
      "결제 확인됨": "支払いを確認しました",
      "가게가 곧 시작합니다": "まもなく準備を始めます",
      "만드는 중": "準備中",
      "조금만 기다려 주세요": "少々お待ちください",
      "나왔습니다": "できあがりました",
      "카운터에서 받아 가세요": "カウンターでお受け取りください",
      "전달됨": "お渡し済み",
      "감사합니다": "ありがとうございました",
      "금액이 모자랍니다": "金額が足りません",
      "같은 QR로 나머지를 마저 보내 주세요": "同じQRで残りをお送りください",
      "시간이 지난 뒤 도착했습니다": "期限を過ぎてから届きました",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "入金は届いています。カウンターでお見せください",
      "결제": "支払い",
      "나왔어요": "完成",
      "매장·포장": "店内・お持ち帰り",
      "배달": "配達",
      "지갑이 없으신가요?": "ウォレットをお持ちでない方",
      "1분이면 만듭니다": "1分で作れます",
      "개 남음": "個 残り",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "ウォレットが開くと金額が入力されています。そのまま送ってください。",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "店舗が登録した情報のみで回答します。不明な点は店舗にご確認ください。",
    },
    zh: {
      /* 장터·랜딩(2026-08-22) */
      "Groq 에서 공짜로 받으실 수 있어요":
        "可以在 Groq 免费获取",
      "Groq 은 공짜":
        "Groq 免费",
      "Ravi 깨우기":
        "唤醒 Ravi",
      "Ravi에게 물어보기":
        "问问 Ravi",
      "xai- · sk-ant- · AIza · sk- · gsk_ 로 시작하는 열쇠":
        "以 xai- · sk-ant- · AIza · sk- · gsk_ 开头的密钥",
      "— 처음 보는 가게에 큰 돈을 보내기 전에 확인하세요.":
        "—— 向陌生店铺转大额之前请先核实。",
      "♡ 찜":
        "♡ 收藏",
      "가게 목록을 불러오지 못했습니다.":
        "无法加载店铺列表。",
      "가게 이름":
        "店铺名称",
      "가게 정보는 각 가게가 직접 올린 것입니다. 아무도 검사하지 않습니다":
        "店铺信息由各店家自行发布。无人审核",
      "가게 찾기":
        "查找店铺",
      "가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "仅根据店家发布的信息回答。不确定时请直接询问店家。",
      "가까운 순으로":
        "按距离排序",
      "견과류 들어간 메뉴 있나요?":
        "有含坚果的菜品吗？",
      "남의 컴퓨터에서는 넣지 마세요.":
        "请勿在他人的电脑上输入。",
      "내 물건 올리기":
        "发布我的物品",
      "내 열쇠로 쓰기":
        "使用我自己的密钥",
      "내 열쇠로 쓰기 →":
        "使用我自己的密钥 →",
      "다만 이 화면은 지갑과 같은 곳에 있으니,":
        "但这个界面与钱包同处一地，因此",
      "답할 말":
        "回复语言",
      "라비가 자고 있어요. 열쇠를 넣으면 깨어납니다.":
        "Ravi 正在睡觉。填入密钥就会醒来。",
      "무엇을 찾으세요?":
        "您在找什么？",
      "받기 →":
        "获取 →",
      "받은 글자를 그대로 아래에 붙여 넣으세요. 어느 회사 것인지는":
        "把收到的字符串原样粘贴到下面。属于哪家厂商",
      "불러오는 중…":
        "加载中…",
      "아래 어느 곳이든 열쇠를 받아 넣으시면 한도 없이 물어보실 수 있어요.":
        "从下面任何一家获取密钥填入，就可以无限次提问。",
      "앞글자로 알아서 알아봅니다.":
        "我们会根据开头的字符自动识别。",
      "열쇠는":
        "密钥",
      "이 가게에 대해 물어보세요.":
        "请询问关于这家店的问题。",
      "이 목록을 가진 회사는 없습니다. 블록체인에서 그때그때 읽어 옵니다.":
        "没有任何公司拥有这份列表。我们每次都从区块链读取。",
      "이 브라우저에만":
        "仅保存在此浏览器中",
      "이고, 나머지는 쓴 만큼 그 회사에 내십니다.":
        "，其余则按用量向该厂商付费。",
      "잠시 뒤에 다시 열어 주세요.":
        "请稍后再打开。",
      "저장됩니다. 우리 서버는 물어볼 때 잠깐 쓰고 저장하지 않아요.":
        "。我们的服务器只在提问时短暂使用，不会保存。",
      "저장하고 이어가기":
        "保存并继续",
      "(가게가 적은 메뉴 이름까지 번역하지는 않습니다).":
        "（不会翻译店家自己写的菜名）。",
      "0곳":
        "0 家",
      "1:1 문의":
        "一对一咨询",
      "1분 뒤 끝":
        "1分钟搞定",
      "1분, 앱 설치 없음":
        "一分钟，无需安装应用",
      "1분.":
        "1分钟。",
      "2020년 이전 맥 · 0.1.0":
        "2020年以前的 Mac · 0.1.0",
      "34GB 정도를 내려받습니다":
        "大约需要下载 34GB",
      "AI 열쇠 없이 됩니다. 매출을 보는 데 남의 회사에 돈을 낼 이유가 없고, 열쇠가 없다고 매출을 못 보면 그건 이 프로그램이 남의 회사에 묶인 것입니다.":
        "无需 AI 密钥即可使用。查看自己的营业额没理由向别家公司付费；若没有密钥就看不到，那说明这个程序被别家公司绑住了。",
      "AI 열쇠를 한 번 넣으시면 되고, 어느 회사든 됩니다 — Grok · Claude · Gemini · ChatGPT · Groq.":
        "填入一次 AI 密钥即可，任何厂商都行 —— Grok · Claude · Gemini · ChatGPT · Groq。",
      "IPFS(프로그램 안에서는 「파일창고」)는 없어도 장사는 됩니다 — 메뉴 사진과 자산에 붙는 그림·음악에만 씁니다.":
        "没有 IPFS（程序内称“文件仓库”）也能做生意 —— 它只用于菜单照片和资产附带的图片、音乐。",
      "RVN 가격이 오르내리므로, 받은 코인을 바로 바꾸지 않으면 금액이 달라집니다.":
        "RVN 价格会波动，收到的币若不立即兑换，金额就会变化。",
      "ravencoin.org 에서 노드 받기 →":
        "从 ravencoin.org 获取节点 →",
      "· 문의":
        "· 联系",
      "— 블록체인 전부를 가게 컴퓨터가 직접 갖기 때문이고, 그래서 우리가 매출을 못 봅니다. 처음 한 번은 반나절쯤 걸립니다.":
        "—— 因为整条区块链由店铺电脑自己保存，所以我们看不到您的营业额。第一次大约需要半天。",
      "— 애플 로고가 있는 컴퓨터면 맥, 시작 단추가 있으면 윈도우입니다. 2020년 이후 산 맥이면 「애플 실리콘」이 맞습니다.":
        "—— 有苹果标志的是 Mac，有开始按钮的是 Windows。2020 年以后买的 Mac 选“Apple Silicon”。",
      "— 여태 프로그램 예닐곱 개로 하던 일을 한 창에 모았습니다.":
        "—— 过去需要六七个程序才能做的事，现在集中在一个窗口里。",
      "— 우리 서버를 지나가지 않습니다. 다만 개발비 1% 는 우리가 받습니다(아래).":
        "—— 不经过我们的服务器。但我们会收取 1% 的开发费（见下）。",
      "— 전기값과 그래픽카드를 넣으면 하루에 얼마인지 나옵니다. 채굴기는 받아 두신 것을":
        "—— 输入电价和显卡型号，就能算出每天赚多少。至于挖矿程序，它只",
      "— 터미널(맥)이나 PowerShell(윈도우)에 아래를 넣으면 나오는 값이 여기 적힌 것과 같아야 합니다. 다르면 받다가 깨졌거나 누가 바꾼 것이니":
        "—— 在终端（Mac）或 PowerShell（Windows）中执行下面的命令，输出的值必须与此处一致。若不同，说明下载损坏或被人篡改，因此",
      "① 받은 파일이 맞는지 먼저 확인하세요.":
        "① 请先确认下载到的文件是否正确。",
      "「맨날 하는 일이니 단추로 만들어줘」":
        "“我天天都做这个，做成按钮吧”",
      "「열기」를 한 번 더 누릅니다":
        "再点一次“打开”",
      "「우리가 보는 것: 없습니다」":
        "“我们能看到的：没有”",
      "「확인되지 않은 개발자」를 그냥 넘기라고 가르치는 안내는 나쁜 프로그램도 똑같이 씁니다. 해시가 같아야 우리가 만든 그 파일입니다.":
        "教您直接跳过“未识别的开发者”的说明，恶意程序也会同样使用。只有哈希一致，才是我们构建的那个文件。",
      "가 옆에 있습니다. 사장님께는 도우미로, 손님께는 가게를 대신해 답합니다.":
        "就在旁边。对店主是助手，对顾客则代表店铺作答。",
      "가 첫 화면입니다. 하고 싶은 일을 그냥 말씀하시면 되고, 말하기 번거로운 날은":
        "是首屏。想做什么直接说就行；懒得说话的日子，",
      "가게 결제·자동판매기·중고 거래":
        "店铺收款、自动售货机、二手交易",
      "가게 계산대 · 자동판매기 · 중고 장터.":
        "店铺收银台 · 自动售货机 · 二手市场。",
      "가게 공지":
        "店铺公告",
      "가게 둘러보기":
        "逛逛店铺",
      "가게 컴퓨터 한 대에만":
        "只在店铺的那一台电脑上",
      "가게 컴퓨터가 손님 폰에 직접 답합니다. 매출이 우리 서버를 지나가지 않아서, 요구받아도 넘길 것이 없습니다.":
        "店铺电脑直接回应顾客手机。营业额不经过我们的服务器，即使被要求，我们也没有可交出的东西。",
      "가게 화면이 폰에 뜹니다. 앱 설치 없음.":
        "店铺界面会显示在手机上。无需安装应用。",
      "가게는 무엇을 얻나요":
        "店铺能得到什么",
      "가게를 하시나요?":
        "您在经营店铺吗？",
      "가게용 프로그램 내려받기":
        "下载店铺程序",
      "가게용 프로그램 받기 →":
        "获取店铺程序 →",
      "값이 하루 사이에 움직입니다.":
        "价格在一天之内就会波动。",
      "같은 길":
        "同一条路",
      "같은 일이 됩니다. 누르는 것과 말하는 것이":
        "效果相同。按和说是",
      "개발비":
        "开发费",
      "고르고 보낸다":
        "选好并付款",
      "그 경고를 넘기기 전에 아래 해시부터 맞춰 보세요.":
        "在跳过该警告之前，请先核对下面的哈希。",
      "그래서":
        "因此",
      "그리고":
        "并且",
      "깐 다음에 무엇을 하나요.":
        "安装之后要做什么。",
      "깔 것도, 가입할 것도 없습니다.":
        "无需安装，也无需注册。",
      "깝니다.":
        "安装。",
      "나머지 99%는 사장님 지갑으로 바로 들어옵니다. 손님이 더 내는 것이 아니라 받으신 돈에서 나뉩니다.":
        "其余 99% 直接进入您的钱包。并非让顾客多付，而是从您收到的金额中分出。",
      "남에게 묻지 않고 스스로 확인하기 때문에, 우리가 매출을 못 봅니다.":
        "它自行验证而不是询问别人，所以我们看不到您的营业额。",
      "내 단추 만들기":
        "创建我的按钮",
      "내 컴퓨터에서도 되나요?":
        "我的电脑也能运行吗？",
      "노드·채굴·IPFS·자산·배당·계산대·장터·AI":
        "节点 · 挖矿 · IPFS · 资产 · 分红 · 收银台 · 市场 · AI",
      "노드를 꼭 깔아야 하나요?":
        "一定要安装节点吗？",
      "노드와 IPFS 는 따로 깔아 두셔야 합니다.":
        "节点和 IPFS 需要您另行安装。",
      "누르는 것은 사장님":
        "按下的是您本人",
      "는 소스를 열어 보셔야 확인됩니다. 고쳐 주시거나 가져다 쓰셔도 됩니다.":
        "需要您查看源码才能确认。您也可以修改或直接拿去使用。",
      "는 잠가서 주고받습니다 — 전화번호를 공개하지 않으셔도 됩니다.":
        "会加密收发 —— 您不必公开电话号码。",
      "는 체인에 올라가 손님 폰에 뜨고,":
        "会上链并显示在顾客手机上，而",
      "다음 달까지 기다리지 않습니다.":
        "不必等到下个月。",
      "단말기 임대료":
        "终端租金",
      "도 같습니다. 이 프로그램은 「우리를 안 믿어도 된다」를 팔고 있는데, 닫아 두면 그 말이 성립하지 않습니다. 위에 적은":
        "也一样。这个程序卖的是“您不必信任我们”，若闭源，这句话就不成立。上面写的",
      "돈은 손님 지갑에서 가게 지갑으로 바로 갑니다":
        "钱直接从顾客钱包进入店铺钱包",
      "돈을 보내거나 자산을 발행하지 못합니다.":
        "无法转账或发行资产。",
      "되돌릴 수 없는 일이라 그렇게 막아 뒀습니다 — 잘못 알아들은 AI 가 500 RVN 을 태우면 안 됩니다.":
        "这些操作无法撤销，所以我们做了封锁 —— 听错话的 AI 不该烧掉 500 RVN。",
      "되돌릴 수 없습니다.":
        "无法撤销。",
      "두 번 누르지 말고 우클릭입니다. 두 번 누르면 열 방법이 안 나옵니다.":
        "是右键点击，不是双击。双击的话不会出现打开的选项。",
      "둘 다 만들었습니다.":
        "两个都做了。",
      "들어온 돈이 되돌아가지 않습니다.":
        "进来的钱不会再退回去。",
      "라고 하면 라비가 그 단추를 홈에 붙입니다(별표 표시, 최대 여덟 개).":
        "这样一说，Ravi 就会把那个按钮贴到主屏（带星标，最多八个）。",
      "라비":
        "Ravi",
      "라비가 하는 것":
        "Ravi 负责的",
      "라비는":
        "Ravi",
      "라비에게 물어보세요 — 예: 내 컴퓨터에서도 되나요?":
        "问问 Ravi —— 例：我的电脑也能运行吗？",
      "레이븐코인, 컴퓨터 한 대로":
        "Ravencoin，一台电脑就够",
      "레이븐코인은":
        "Ravencoin",
      "레이븐코인은 회사가 없는 공개 블록체인입니다. 이 프로그램은 그 위에서 돕니다.":
        "Ravencoin 是没有公司的公开区块链。本程序在它之上运行。",
      "레이븐코인을 쓰려면 원래 프로그램 대여섯 개가 필요했습니다. 그걸 하나로 합쳤습니다.":
        "以前使用 Ravencoin 需要五六个程序。我们把它们合成了一个。",
      "리눅스용":
        "Linux 版",
      "만든 사람 김무송 · PLAY X (PLAX)":
        "制作：KIM, MOOSONG · PLAY X（PLAX）",
      "말로 부르면 화면을 채웁니다.":
        "说给它听，它就把界面填好。",
      "맥: shasum -a 256 ~/Downloads/받은파일이름":
        "Mac: shasum -a 256 ~/Downloads/下载的文件名",
      "맥용":
        "Mac 版",
      "맥용 (인텔)":
        "Mac 版（Intel）",
      "먼저 레이븐코인 노드가 깔려 있어야 합니다.":
        "需要先安装 Ravencoin 节点。",
      "메뉴 넣기 · 자산 만들기 · 가게 소개 · 뭐든 묻기.":
        "添加菜品 · 创建资产 · 撰写店铺简介 · 什么都问。",
      "메시지":
        "消息",
      "못 하는 것":
        "做不到的事",
      "무엇이 들어 있나":
        "里面有什么",
      "바로 되는 것":
        "立刻可用的",
      "받는 주소도 바꾸실 수 있습니다 — 못 끄는 것은 개발비가 아니라 세금이고, 소스가 열려 있으면 세금은 포크 한 번으로 사라집니다.":
        "收款地址也可以更改 —— 关不掉的那叫税，不叫开发费；源码公开的话，税一次分叉就没了。",
      "받으신 금액의 1%.":
        "您收到金额的 1%。",
      "받은 돈은 그날 시세로 원화가 같이 적힙니다 — 세무 담당자가 묻는 숫자입니다.":
        "收到的钱会按当天汇率一并记录韩元金额 —— 这正是会计要的数字。",
      "받은 파일을 열고, 안의 앱을 「응용 프로그램」으로 끕니다":
        "打开下载的文件，把里面的应用拖到“应用程序”",
      "발행 · 재발행 · 유니크 · 배당.":
        "发行 · 再发行 · 唯一 · 分红。",
      "번호표가 폰에 뜨고, 나오면 소리로 알려줍니다.":
        "号码会显示在手机上，做好时会有声音提示。",
      "부가세 계산이나 신고 대행은 하지 않습니다.":
        "我们不代算增值税，也不代为申报。",
      "붙는 곳은":
        "收取范围是",
      "서식을 채워 드리고 그 화면까지 데려다 줄 뿐,":
        "它只是帮您填好表单并带到那个界面，",
      "설정에서 끄실 수 있습니다.":
        "可以在设置中关闭。",
      "셋이고,":
        "这三处，而",
      "소스가 전부 공개돼 있습니다 →":
        "源码完全公开 →",
      "소스를 열어 둔 이유":
        "为什么公开源码",
      "손님 화면":
        "顾客界面",
      "손님도 앱을 깔아야 하나요?":
        "顾客也需要安装应用吗？",
      "손님에게 지갑이 필요합니다.":
        "顾客需要有钱包。",
      "손님은 받을 것이 없습니다.":
        "顾客不需要下载任何东西。",
      "손님은 이렇게 씁니다":
        "顾客这样使用",
      "손님이 낸 만큼 그대로 들어옵니다.":
        "顾客付多少就到账多少。",
      "수수료가 정말 1%뿐인가요?":
        "手续费真的只有 1% 吗？",
      "수익이 나는지 먼저 계산해 드립니다":
        "我们先帮您算是否划算",
      "쓰던 컴퓨터 한 대면 됩니다.":
        "一台您正在用的电脑就够了。",
      "쓸 데가 없었습니다.":
        "却没有用武之地。",
      "쓸 만한 모바일 지갑이 없어서 쓰기 어렵고, 받는 가게가 없어서 팔 수가 없습니다. 둘 중 하나가 먼저 움직여야 하는데 아무도 안 움직였습니다.":
        "没有好用的手机钱包就难以花出去，没有商家收就卖不掉。两者总得有一方先动，可谁也没动。",
      "아직 시작 전입니다.":
        "目前尚未开始。",
      "아직 쓰는 가게가 없습니다.":
        "还没有店铺在使用。",
      "아직 없으시면 먼저 받으세요:":
        "如果还没有，请先获取：",
      "앞의 둘은 체인에, 장터는 Nostr 에 올라갑니다. 우리 서버가 아닙니다.":
        "前两者上链，市场发布在 Nostr 上。不是我们的服务器。",
      "애플 공증을 아직 안 받아서입니다(연 12만 원, 준비 중).":
        "这是因为我们尚未通过苹果公证（每年 12 万韩元，正在办理）。",
      "애플 실리콘(M1 이상) · 0.1.0":
        "Apple Silicon（M1 及以上） · 0.1.0",
      "앱을":
        "把应用",
      "어느 것을 받아야 할지 모르시겠으면":
        "如果不确定该下载哪个",
      "어떻게 쓰나 — 말하거나, 누르거나":
        "怎么用 —— 说，或者按",
      "업종별 서식이 있어서 카페든 도장이든 열면 바로 씁니다.":
        "有按行业准备的模板，无论咖啡馆还是道馆，打开就能用。",
      "없습니다.":
        "没有。",
      "열지 마세요.":
        "请不要打开。",
      "오늘 얼마 · 손님 QR · 들어온 주문 · 지금 닫기.":
        "今天赚了多少 · 顾客二维码 · 收到的订单 · 立即打烊。",
      "왜 만들었나":
        "为什么做这个",
      "우리가 보는 것":
        "我们能看到的",
      "우클릭":
        "右键点击",
      "원화로 보고, RVN으로 냅니다. 환율은 그 자리에서 계산됩니다.":
        "以本币查看，用 RVN 支付。汇率当场换算。",
      "위 「지갑 열기」로 1분이면 만들지만, 그래도 한 걸음입니다.":
        "用上面的“打开钱包”一分钟就能建好，但终究是多一步。",
      "윈도우: Get-FileHash .\\받은파일이름 -Algorithm SHA256":
        "Windows: Get-FileHash .\\下载的文件名 -Algorithm SHA256",
      "윈도우용":
        "Windows 版",
      "은 한국어·영어·중국어·일본어로 바뀝니다":
        "可切换韩语、英语、中文、日语",
      "이 다음부터는 그냥 열립니다.":
        "此后就能直接打开。",
      "이 프로그램은 노드를 대신 내려받지 않고,":
        "本程序不会替您下载节点，",
      "이 프로그램은 노드를 대신 내려받지 않습니다.":
        "本程序不会替您下载节点。",
      "이 프로그램이 직접 캐지는 않습니다.":
        "本程序本身不挖矿。",
      "이고, 첫 가게를 준비하는 중입니다. 지갑은 지금 바로 쓰실 수 있습니다.":
        "，我们正在筹备第一家店。钱包现在就能用。",
      "이라 배울 것이 하나뿐입니다.":
        "，所以只需学一件事。",
      "이미 깔린 것을 찾아 켭니다.":
        "它会找到已安装的并启动。",
      "이미 깔아 두신 레이븐 노드·IPFS 를 켜고 씁니다.":
        "它会启动并使用您已安装的 Ravencoin 节点和 IPFS。",
      "입니다.":
        "。",
      "입니다. 프리마인도 ICO도 없이 시작했고, 누구나 자기 자산을 발행할 수 있습니다. 좋은 설계인데":
        "。它没有预挖也没有 ICO，任何人都能发行自己的资产。设计很好，但",
      "자동 백업 · 금고 자동이체 · 매출 장부(CSV).":
        "自动备份 · 自动转入金库 · 销售账本（CSV）。",
      "자산":
        "资产",
      "자산을 위해 만들어진 체인":
        "为资产而生的链",
      "잘못 보낸 돈을 우리가 돌려드릴 방법이 없습니다. 그게 수수료가 없는 이유이기도 합니다.":
        "如果您转错了，我们没有办法帮您追回。这也正是没有手续费的原因。",
      "장사":
        "做生意",
      "정산":
        "结算",
      "정직하게 — 이런 점은 감안하셔야 합니다":
        "坦白说 —— 这几点请您考虑清楚",
      "주문 · 메뉴 · 환불 · 재고 · 예약 · 출입.":
        "点单 · 菜单 · 退款 · 库存 · 预约 · 出入。",
      "지갑은 브라우저에서 바로 열리고, 가게는 컴퓨터 한 대로 시작합니다.":
        "钱包在浏览器里直接打开，开店只需一台电脑。",
      "지금 1만원이면 몇 RVN?":
        "现在一万韩元能换多少 RVN？",
      "지키는 것":
        "守护的部分",
      "차지백":
        "拒付",
      "채굴":
        "挖矿",
      "채굴·그냥 보내기·자산 발행에는 안 붙습니다.":
        "挖矿、普通转账、发行资产不收取。",
      "처음 열 때 「확인되지 않은 개발자」가 뜹니다.":
        "第一次打开时会出现“未识别的开发者”。",
      "첫 가게를 준비하는 중입니다.":
        "正在筹备第一家店。",
      "체인":
        "链",
      "체인에 등록된 가게는 지금":
        "目前链上注册的店铺为",
      "체인에서 직접 읽습니다":
        "直接从链上读取",
      "체인에서 직접 확인하실 수 있고,":
        "您可以在链上直接核对，而且",
      "카드 수수료":
        "刷卡手续费",
      "켜고 끄기만":
        "只负责启动和停止",
      "켜면":
        "开启后",
      "큰 아이콘을 누르시면":
        "按下大图标就",
      "테이블의 QR을 찍는다":
        "扫描桌上的二维码",
      "파는 길":
        "销售渠道",
      "프로그램을 열면 레이븐코인 노드가 켜지고, 같은 와이파이에 있는 폰에서 계산대 화면이 열립니다. 손님에게 보여줄 QR도 거기서 나옵니다.":
        "打开程序后 Ravencoin 节点启动，同一 wifi 下的手机就能打开收银界面。给顾客看的二维码也从这里生成。",
      "합니다.":
        "。",
      "해시가 맞으면 이렇게 여십니다:":
        "哈希一致的话，请这样打开：",
      "화면을 저희가 정해 드리는 것이 아니라, 쓰시면서 늘리시는 것입니다.":
        "界面不由我们替您决定，而是您在使用中自己扩充。",
      "회원권도 상품권도 체인 위의 자산으로 만듭니다. 배당은 보유자 전원에게 한 번에 나갑니다.":
        "会员卡和礼品券都做成链上资产。分红一次性发给所有持有者。",
      /* 문제 알리기(report.js) */
      "문제 알리기":
        "报告问题",
      "무엇이 잘못됐나요?":
        "出了什么问题？",
      "겪으신 것만 적어 주세요.":
        "只需写下您遇到的情况。",
      "지갑이 안 열려요":
        "钱包打不开",
      "보내기가 안 돼요":
        "无法转出",
      "주문·계산이 안 돼요":
        "无法下单或结账",
      "라비가 틀리게 답해요":
        "Ravi 回答有误",
      "프로그램이 안 켜져요":
        "程序无法启动",
      "화면 문제":
        "界面问题",
      "보내는 중…":
        "正在发送…",
      "고맙습니다.":
        "谢谢您。",
      "보내지 못했습니다.":
        "发送失败。",
      "예: 보내기를 눌렀는데 아무 일도 없어요":
        "例：点了转出但没有任何反应",
      /* ── 지갑 화면(2026-08-22). 돈이 걸린 곳이라 "되돌릴 수 없다"·
         "12단어를 잃으면 끝이다" 는 원문과 같은 무게로 옮겼다. ── */
      "내 지갑":
        "我的钱包",
      "지갑을 여는 중…":
        "正在打开钱包…",
      "이 지갑은 손님 폰 안에만 있습니다. 가게도, 저희도 열 수 없습니다.":
        "这个钱包只在您的手机里。店家和我们都打不开。",
      "새 지갑 만들기":
        "创建新钱包",
      "12단어로 되살리기":
        "用12个单词恢复",
      "12단어는 이 지갑의 열쇠 전부입니다. 종이에 적어 두지 않으면 폰을 바꾸거나 브라우저를 지우는 날 돈을 되찾을 방법이 없습니다.":
        "这12个单词就是这个钱包的全部钥匙。如果不写在纸上，换手机或清除浏览器的那天，没有任何办法取回您的钱。",
      "이 폰에 저장해 둔 지갑이 있습니다. 정해 두신 암호를 넣어 주세요.":
        "这台手机上有已保存的钱包。请输入您设定的密码。",
      "지문 · 얼굴로 열기":
        "用指纹或面容打开",
      "안 되면 아래 12단어로 되살리세요. 기기를 바꾸셨다면 그 길뿐입니다.":
        "若打不开，请用下面的12个单词恢复。如果换了设备，只有这一条路。",
      "암호":
        "密码",
      "열기":
        "打开",
      "이 폰에서 지우고 새로 시작하기":
        "从这台手机删除并重新开始",
      "12단어를 종이에 적으세요":
        "请把12个单词写在纸上",
      "사진으로 찍지 마세요. 카카오톡이나 메모앱에도 넣지 마세요. 종이에 적어서 남이 못 보는 곳에 두는 것이 가장 안전합니다.":
        "请不要拍照。也不要放进聊天软件或备忘录。写在纸上、放在别人看不到的地方最安全。",
      "다 적었습니다":
        "我已写好",
      "그만두기":
        "取消",
      "적으신 것을 확인합니다":
        "我们来核对您写下的内容",
      "종이를 보고 고르시면 됩니다.":
        "看着纸选就可以。",
      "적어 두신 12단어를 순서대로 띄어쓰기로 구분해 적어 주세요.":
        "请按顺序输入您写下的12个单词，用空格分隔。",
      "되살리기":
        "恢复",
      "뒤로":
        "返回",
      "잠금번호를 정하세요":
        "请设定锁屏密码",
      "이 폰에서 지갑을 열 때 씁니다.":
        "在这台手机上打开钱包时使用。",
      "숫자 6자리면 됩니다.":
        "6位数字就够了。",
      "잠금번호":
        "锁屏密码",
      "한 번 더":
        "再输一次",
      "저장하고 시작":
        "保存并开始",
      "지문 · 얼굴로 잠그기":
        "用指纹或面容锁定",
      "잠그지 않고 쓰기":
        "不锁定直接使用",
      "잠금번호를 잊으면 저희도 풀어 드릴 수 없습니다. 그때는 종이에 적어 둔 12단어로만 되살릴 수 있습니다.":
        "若忘记密码，我们也无法为您解开。那时只能用纸上写的12个单词恢复。",
      "지문·얼굴로 잠그면":
        "若用指纹或面容锁定",
      "그 열쇠는 이 기기의 보안 칩 안에만 있습니다. 폰을 잃거나 바꾸면 이 브라우저의 사본은 못 엽니다 — 그때도":
        "该钥匙只存在于这台设备的安全芯片中。手机丢失或更换后，这个浏览器里的副本就打不开了 — 那时也要",
      "12단어로 되살립니다.":
        "用12个单词恢复。",
      "12단어가 원래 진짜 열쇠입니다.":
        "12个单词本来就是真正的钥匙。",
      "잠그기":
        "锁定",
      "잔액":
        "余额",
      "받기":
        "收款",
      "보내기":
        "转出",
      "받을 주소 ·":
        "收款地址 ·",
      "주소 복사하기":
        "复制地址",
      "잔액이 안 보이시나요? 쓰던 주소가 뒤쪽에 있을 수 있습니다.":
        "看不到余额？您用过的地址可能排在后面。",
      "찾아보기":
        "继续查找",
      "내 물건 팔기":
        "卖我的东西",
      "새로고침":
        "刷新",
      "사업자가 아니어도 됩니다. 가게를 만들 필요도 없어요.":
        "不必是商户。也不需要开店。",
      "무엇을 파시나요":
        "您要卖什么",
      "설명":
        "说明",
      "얼마에":
        "价格",
      "원":
        "韩元",
      "달러":
        "美元",
      "어디서":
        "地点",
      "사진":
        "照片",
      "(없어도 됩니다)":
        "（可以不填）",
      "사진 고르기":
        "选择照片",
      "사진 주소를 직접 넣기":
        "直接填入照片地址",
      "사진은":
        "照片",
      "다른 곳(Nostr 사진 서버)에 보관":
        "保存在别处（Nostr 媒体服务器）",
      "됩니다. 저희가 갖고 있지 않아서, 그곳이 문을 닫으면 사진이 사라질 수 있습니다.":
        "。我们并不持有，若那里关闭，照片可能消失。",
      "연락받을 번호":
        "联系电话",
      "이 번호는 전 세계 누구나 볼 수 있습니다.":
        "全世界任何人都能看到这个号码。",
      "나중에 글을 지워도 이미 받아 간 곳에는 남습니다.":
        "即使以后删除帖子，已经取走的地方仍会保留。",
      "번호를 안 적으셔도 글은 올라가지만,":
        "不填号码也能发布，但",
      "사겠다는 사람이 연락할 방법이 없습니다.":
        "想买的人无法联系您。",
      "동네 (거리 표시용)":
        "所在区域（用于显示距离）",
      "지금 자리":
        "使用当前位置",
      "누르기 전에는 위치를 읽지 않습니다. 눌러도":
        "在您按下之前不会读取位置。即使按下也只包含",
      "동네 정도(600m)":
        "大致区域（约600米）",
      "만 담기고 정확한 자리는 담기지 않습니다.":
        "，不包含精确位置。",
      "지금 상태":
        "状态",
      "팝니다":
        "出售中",
      "판매 완료":
        "已售出",
      "예약 중":
        "已预定",
      "이 글은 어느 회사 서버에도 안 올라갑니다.":
        "这条帖子不会上传到任何公司的服务器。",
      "공개 릴레이에 뿌려지고, 사라질 수도 있습니다. 값이 큰 물건은 가게로 등록하시는 편이 낫습니다.":
        "它会散布到公开中继，也可能消失。贵重物品建议登记为店铺。",
      "올린 글은":
        "已发布的帖子",
      "지울 수 있지만":
        "可以删除，但",
      ", 그건":
        "那是",
      "지워 달라는 부탁":
        "请求删除",
      "이지 명령이 아닙니다. 대부분 들어주지만 안 들어주는 곳도 있고, 이미 받아 간 사람의 화면에는 남습니다.":
        "，而不是命令。多数会照做，也有不照做的，并且会留在已经取走的人的屏幕上。",
      "올리기":
        "发布",
      "고치기 그만두기":
        "停止编辑",
      "받은 문의":
        "收到的咨询",
      "지갑을 열면 여기에 보입니다.":
        "打开钱包后会显示在这里。",
      "내가 올린 것":
        "我发布的",
      "보낼 수 있는 잔액":
        "可转出余额",
      "받는 주소":
        "收款地址",
      "금액 (RVN)":
        "金额（RVN）",
      "수수료 빼고 전부 넣기":
        "扣除手续费后全部转出",
      "확인 화면으로":
        "前往确认页",
      "보낸 돈은 되돌릴 수 없습니다. 받는 주소를 한 글자씩 확인해 주세요.":
        "转出的钱无法收回。请逐字核对收款地址。",
      "이대로 보낼까요?":
        "就这样转出吗？",
      "받는 곳":
        "收款方",
      "보낼 금액":
        "转出金额",
      "수수료":
        "手续费",
      "합계":
        "合计",
      "거스름":
        "找零",
      "보냈습니다":
        "已转出",
      "금액":
        "金额",
      "거래번호":
        "交易编号",
      "네트워크가 확인하기까지 보통 몇 분 걸립니다. 그동안 잔액이 조금 다르게 보일 수 있습니다.":
        "网络确认通常需要几分钟。在此期间余额可能显示得略有不同。",
      "확인":
        "确定",
      "지갑":
        "钱包",
      "가게":
        "店铺",
      "물건":
        "物品",
      "예) apple banana cherry …":
        "例）apple banana cherry …",
      "접이식 자전거":
        "折叠自行车",
      "3년 썼고 잘 굴러갑니다. 직거래만 해요.":
        "用了3年，骑起来顺畅。只面交。",
      "의왕시 내손동":
        "京畿道义王市内孙洞",
      "https://… 로 시작하는 사진 주소":
        "以 https:// 开头的照片地址",
      "누르지 않으면 비어 있습니다":
        "不按就一直是空的",
      "R 로 시작하는 주소":
        "以 R 开头的地址",
      "지금 영업 중": "营业中",
      "지금은 주문을 받지 않습니다": "暂不接单",
      "메뉴를 불러오는 중…": "正在加载菜单…",
      "메뉴를 준비하고 있어요": "菜单准备中",
      "품절": "售罄",
      "주문하기": "下单",
      "궁금한 것 물어보기": "有问题？问一问",
      "묻기": "提问",
      "닫기": "关闭",
      "지갑 열기": "打开钱包",
      "주문번호": "取餐号",
      "입금을 기다립니다": "等待付款",
      "결제하시면 이 화면이 저절로 바뀝니다": "付款后本页面会自动更新",
      "결제 확인됨": "已确认付款",
      "가게가 곧 시작합니다": "店家马上开始制作",
      "만드는 중": "制作中",
      "조금만 기다려 주세요": "请稍候",
      "나왔습니다": "已完成",
      "카운터에서 받아 가세요": "请到柜台领取",
      "전달됨": "已交付",
      "감사합니다": "谢谢",
      "금액이 모자랍니다": "金额不足",
      "같은 QR로 나머지를 마저 보내 주세요": "请用同一个二维码补足余额",
      "시간이 지난 뒤 도착했습니다": "超时后才收到",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "款项已收到，请在柜台出示",
      "결제": "付款",
      "나왔어요": "完成",
      "매장·포장": "堂食・外带",
      "배달": "配送",
      "지갑이 없으신가요?": "还没有钱包？",
      "1분이면 만듭니다": "一分钟就能创建",
      "개 남음": "件剩余",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "打开钱包后金额已填好，直接发送即可。",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "仅根据店家上传的信息回答。不确定时请直接询问店家。",
    },
  };

  // 손님 폰이 정한 말을 따른다. 고르라고 묻지 않는다 — 폰은 이미 알고 있고,
  // 처음 보는 화면에서 언어부터 고르라는 것은 한 걸음 더 늘리는 일이다.
  var want = (navigator.language || "ko").slice(0, 2).toLowerCase();
  // 저장해 둔 선택이 있으면 그게 이긴다.
  try {
    var saved = localStorage.getItem("playx-raven-lang");
    if (saved) want = saved;
  } catch (e) {}
  var lang = DICT[want] ? want : "ko";

  window.PXLANG = lang;
  window.t = function (s) {
    if (lang === "ko") return s;
    var d = DICT[lang];
    return (d && d[s]) || s; // 없으면 한국어 그대로. 빈 화면보다 낫다.
  };

  // 화면에 이미 박힌 글자를 바꾼다. `data-t` 를 일일이 달지 않는 이유는
  // 그걸 빠뜨린 자리가 반드시 생기고, 그 자리만 한국어로 남기 때문이다.
  window.translateDom = function (root) {
    if (lang === "ko") return;
    var d = DICT[lang];
    var w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      // <script>·<style> 안의 글자는 화면에 안 보인다. 건드릴 이유가 없다.
      var tag = n.parentNode && n.parentNode.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      var raw = n.nodeValue.trim();
      if (!raw) continue;
      /* 🔴 긴 문장은 원본 HTML 에서 **줄바꿈으로 쪼개져** 있다. 그래서
         글자 사이에 줄바꿈과 들여쓰기가 들어가고, 한 줄짜리 사전 열쇠와
         안 맞는다. 실측(2026-08-22): 지갑 화면에서 짧은 말은 다 번역됐는데
         긴 안내문 열두 개만 한국어로 남아 있었다 — 사전에는 다 있었다.
         찾을 때만 공백을 고르게 편다. */
      var k = raw.replace(/\s+/g, " ");
      if (d[k]) n.nodeValue = n.nodeValue.replace(raw, d[k]);
    }
    var ph = (root || document).querySelectorAll("[placeholder]");
    for (var i = 0; i < ph.length; i++) {
      var p = ph[i].getAttribute("placeholder");
      if (d[p]) ph[i].setAttribute("placeholder", d[p]);
    }
    document.documentElement.lang = lang;
  };

  /* ── 스스로 번역한다 ─────────────────────────────────────────────
     🔴 여태 **화면마다 `translateDom()` 을 직접 불러야** 했다. 그리고
     실측(2026-08-22)에서 지갑 화면의 그 한 줄이 돌지 않았다 —
     `PXLANG` 은 en 인데 화면은 한국어 그대로였고, 손으로 부르면 됐다.

     원인을 더 좇기보다 **구조를 고친다.** 부르는 것을 화면에 맡기면
     빠뜨린 화면이 반드시 생기고, 그 화면만 한국어로 남는다.

     ⚠️ 그리고 더 큰 문제가 하나 더 있다. 번들이 목록·잔액을 **나중에 그린다.**
     한 번만 번역하면 그 뒤에 그려진 것은 다시 한국어다. 그래서 바뀔 때마다
     다시 번역한다.

     되돌이(번역 → 바뀜 → 다시 번역)는 저절로 멈춘다 — 번역된 글자는
     한국어 열쇠와 안 맞아서 두 번째부터는 아무것도 안 바뀐다. */
  function autoTranslate() {
    if (lang === "ko") return;
    var run = function () {
      try { window.translateDom(document.body); } catch (e) {}
    };
    run();
    if (!window.MutationObserver) return;
    var timer = null;
    new MutationObserver(function () {
      if (timer) return;                       // 한 번에 몰아서. 글자마다 돌면 느리다.
      timer = setTimeout(function () { timer = null; run(); }, 60);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ── 말 고르는 자리 ───────────────────────────────────────────────
     🔴 여태 **폰 설정만 따르고 바꿀 길이 없었다.** 폰은 한국어인데 화면은
     영어로 보고 싶은 사람, 남의 폰을 빌려 쓰는 사람, 폰 언어를 바꿀 줄
     모르는 사람 — 전부 갇힌다.

     자동 판정은 그대로 둔다(처음 온 사람에게 언어부터 고르라고 묻지 않는다).
     **바꿀 길만 더한다.**

     제목 줄 오른쪽 끝에 붙인다 — 「문제 알리기」와 같은 자리 규칙이라
     화면마다 찾을 곳이 하나다. */
  var NAMES = { ko: "한국어", en: "English", ja: "日本語", zh: "中文" };

  window.mountLangPick = function () {
    if (document.querySelector(".langsw")) return;
    /* 보이는 제목을 고른다. 지갑은 한 파일에 화면 여럿을 숨겨 두는 구조라,
       그냥 첫 h1 을 잡으면 지금 안 보이는 화면에 붙는다. */
    var h = null, hs = document.querySelectorAll("h1");
    for (var i = 0; i < hs.length; i++) {
      var vis = hs[i].checkVisibility ? hs[i].checkVisibility()
        : !!(hs[i].offsetWidth || hs[i].offsetHeight);
      if (vis) { h = hs[i]; break; }
    }
    if (!h) return;

    var s = document.createElement("style");
    s.textContent =
      /* ⚠️ width 를 못 박는다. 지갑 화면에는 select 를 폭 100% 로 만드는
         규칙이 있어서, 그냥 두면 이 작은 칸이 화면 폭 전체로 늘어난다. */
      ".langsw{float:right;width:auto!important;margin:2px 8px 0 0;min-height:36px;" +
      "padding:0 8px;border-radius:999px;border:1px solid rgba(128,128,128,.30);" +
      "background:transparent;color:#6b7280;font-size:14px;cursor:pointer}" +
      "@media(prefers-color-scheme:dark){.langsw{color:#9aa0ab}}";
    document.head.appendChild(s);

    var sel = document.createElement("select");
    sel.className = "langsw";
    sel.setAttribute("aria-label", "Language");
    for (var k in NAMES) {
      var o = document.createElement("option");
      o.value = k;
      o.textContent = NAMES[k];
      if (k === lang) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = function () { window.setLang(sel.value); };
    h.parentNode.insertBefore(sel, h);
  };

  function boot() {
    autoTranslate();
    window.mountLangPick();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.setLang = function (l) {
    try {
      localStorage.setItem("playx-raven-lang", l);
    } catch (e) {}
    location.reload();
  };
})();
