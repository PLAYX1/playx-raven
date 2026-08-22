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
