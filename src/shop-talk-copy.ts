/* 11-28 가게 대화방(src/shop-talk.ts · shop_room.rs · talk_dm.rs 가게 쪽지) 문구 — 한국어 원문이 열쇠, 값은 [영어, 일본어, 중국어].
 * 유럽어 여섯은 public/i18n/<말>.json 에 같은 열쇠로(없으면 영어로 내려간다). 같은 한국어가 이미 있으면 그 번역이 이긴다.
 */
export const SHOP_TALK_COPY: Record<string, [string, string, string]> = {
  "가게 대화방": ["Shop chat", "ショップトーク", "店铺聊天"],
  "가게 공지 방": ["Shop notice room", "ショップのお知らせルーム", "店铺公告房间"],
  "단골이 폰에서 이 방을 찾아 읽어요(끌어오기). 올리는 데 돈이 들지 않고, 한꺼번에 보내는 쪽지는 없어요.": [
    "Regulars open this room on their phones and read it themselves (pull). Posting costs nothing, and there is no bulk messaging.",
    "常連さんがスマホでこのルームを開いて読みます（取りに来る方式）。投稿は無料で、一斉送信のメッセージはありません。",
    "常客在手机上自己打开这个房间阅读（拉取）。发布免费，也没有群发私信。"],
  "가게 쪽지": ["Shop messages", "ショップのメッセージ", "店铺私信"],
  "손님이 가게 이름(간판 열쇠)으로 보낸 쪽지예요. 내 개인 쪽지와 섞이지 않아요. 먼저 말을 건 손님에게만 가게 이름으로 답할 수 있어요.": [
    "Messages customers sent to your shop (its sign key). They never mix with your personal messages. You can reply as the shop only to customers who wrote first.",
    "お客さんがショップ名（看板キー）宛てに送ったメッセージです。個人のメッセージとは混ざりません。先に話しかけてきたお客さんにだけ、ショップ名で返信できます。",
    "这是顾客发给店铺（招牌密钥）的私信，不会和你的个人私信混在一起。只能以店铺名义回复先来联系的顾客。"],
  "왼쪽에서 손님을 고르세요.": ["Pick a customer on the left.", "左からお客さんを選んでください。", "请在左侧选择一位顾客。"],
  "가게 간판 열쇠가 아직 없어요. 「가게 정보」에서 가게를 먼저 열어 주세요.": [
    "There is no shop sign key yet. Open your shop first under \"Shop info\".",
    "ショップの看板キーがまだありません。「ショップ情報」で先にショップを開いてください。",
    "还没有店铺招牌密钥。请先在「店铺信息」中开店。"],
  "아직 공지 방이 없어요. 한 번 만들면 링크가 바뀌지 않아요.": [
    "No notice room yet. Once created, its link never changes.",
    "まだお知らせルームがありません。一度作るとリンクは変わりません。",
    "还没有公告房间。创建后链接不会改变。"],
  "예: 매주 새 빵 소식": ["e.g. New bread every week", "例：毎週の新作パン情報", "例如：每周新面包消息"],
  "공지 방 만들기": ["Create notice room", "お知らせルームを作る", "创建公告房间"],
  "가게 열쇠": ["Shop key", "ショップのキー", "店铺密钥"],
  "방 링크 QR": ["Room link QR", "ルームリンクのQR", "房间链接二维码"],
  "단골 모으기 — 이 링크나 QR 을 가게에 붙여 두세요. 손님이 폰으로 열고 「단골 맺기」를 누르면 공지가 그 폰에 들어가요.": [
    "Gather regulars — post this link or QR in your shop. When a customer opens it on their phone and taps \"Follow shop\", your notices go to that phone.",
    "常連さんを集める — このリンクかQRを店内に貼ってください。お客さんがスマホで開いて「常連になる」を押すと、お知らせがそのスマホに届きます。",
    "招揽常客——把这个链接或二维码贴在店里。顾客用手机打开并点「关注店铺」后，公告就会进入那部手机。"],
  "공지 쓰기": ["Write a notice", "お知らせを書く", "写公告"],
  "예: 오늘 소금빵 30개 구웠어요. 5시까지!": ["e.g. Baked 30 salt rolls today. Until 5!", "例：今日は塩パンを30個焼きました。5時まで！", "例如：今天烤了30个盐面包，到5点为止！"],
  "내 상품": ["My products", "自分の商品", "我的商品"],
  "내 상품 고르기…": ["Pick one of my products…", "自分の商品を選ぶ…", "选择我的商品…"],
  "상품 붙이기": ["Attach product", "商品を添付", "附上商品"],
  "상품 공유 링크 붙여 넣기 (ravenvault.ex.erci.se/r/… · /g/…)": [
    "Paste a product share link (ravenvault.ex.erci.se/r/… · /g/…)",
    "商品の共有リンクを貼り付け（ravenvault.ex.erci.se/r/… · /g/…）",
    "粘贴商品分享链接（ravenvault.ex.erci.se/r/… · /g/…）"],
  "링크 붙이기": ["Attach link", "リンクを添付", "附上链接"],
  "상품 링크를 붙이면 손님 폰에 상품 카드로 보여요(서명을 확인한 것만).": [
    "Attached product links show as product cards on customers' phones (only signature-checked ones).",
    "商品リンクを添付すると、お客さんのスマホに商品カードで表示されます（署名を確認できたものだけ）。",
    "附上的商品链接会在顾客手机上显示为商品卡片（仅限已验证签名的）。"],
  "공지 올리기": ["Post notice", "お知らせを投稿", "发布公告"],
  "오늘 올린 공지 {0}/{1}": ["Notices in the last 24 h: {0}/{1}", "24時間のお知らせ {0}/{1}", "24小时内的公告 {0}/{1}"],
  "손님 화면에는 24시간에 공지 5개까지 펼쳐 보여요. 더 올리면 접혀 보이므로 데스크탑도 5개에서 멈춰요.": [
    "Customers' screens show up to 5 notices per 24 hours; more get folded away, so the desktop also stops at 5.",
    "お客さんの画面には24時間に5件まで表示されます。それ以上は折りたたまれるので、デスクトップも5件で止まります。",
    "顾客界面每24小时最多展开显示5条公告，多出的会被折叠，所以桌面端也在5条时停止。"],
  "최근 공지": ["Recent notices", "最近のお知らせ", "最近的公告"],
  "아직 올린 공지가 없어요.": ["No notices posted yet.", "まだお知らせを投稿していません。", "还没有发布公告。"],
  "링크를 복사했어요.": ["Link copied.", "リンクをコピーしました。", "已复制链接。"],
  "올리는 중…": ["Posting…", "投稿中…", "正在发布…"],
  "이미 만든 공지 방이 있어 그 방을 그대로 써요.": [
    "You already have a notice room, so it is used as is.",
    "すでに作ったお知らせルームがあるので、そのまま使います。",
    "已经有创建好的公告房间，继续使用它。"],
  "공지 방을 만들었어요.": ["Notice room created.", "お知らせルームを作りました。", "已创建公告房间。"],
  "공지에 쓸 말을 적어 주세요.": ["Write something for the notice.", "お知らせの内容を書いてください。", "请填写公告内容。"],
  "공지를 올렸어요. 단골 폰이 다음에 열 때 받아 가요.": [
    "Notice posted. Regulars' phones pick it up the next time they open.",
    "お知らせを投稿しました。常連さんのスマホが次に開いたときに受け取ります。",
    "公告已发布。常客的手机下次打开时会收到。"],
  "아직 손님 쪽지가 없어요.": ["No customer messages yet.", "まだお客さんのメッセージはありません。", "还没有顾客私信。"],
  "바깥 릴레이에 닿지 못했어요. 이 컴퓨터에 있는 것만 보여요.": [
    "Could not reach outside relays. Showing only what is on this computer.",
    "外部リレーに届きませんでした。このコンピューターにあるものだけを表示します。",
    "无法连接外部中继，只显示这台电脑上已有的内容。"],
  "손님 지문": ["Customer fingerprint", "お客さんの指紋", "顾客指纹"],
  "쪽지가 없어요.": ["No messages.", "メッセージがありません。", "没有私信。"],
  "가게 이름으로 답하기": ["Reply as the shop", "ショップ名で返信", "以店铺名义回复"],
  "답장 보내기": ["Send reply", "返信を送る", "发送回复"],
  "이 손님 한 분에게만 가요. 여러 손님에게 한꺼번에 보내기는 없어요.": [
    "This goes to this one customer only. There is no sending to many customers at once.",
    "このお客さん一人にだけ届きます。複数のお客さんへの一斉送信はありません。",
    "只发给这一位顾客，没有一次发给多位顾客的功能。"],
  "먼저 말을 건 손님에게만 가게 이름으로 답할 수 있어요.": [
    "You can reply as the shop only to customers who wrote first.",
    "先に話しかけてきたお客さんにだけ、ショップ名で返信できます。",
    "只能以店铺名义回复先来联系的顾客。"],
  "공지는 24시간에 5개까지예요. 더 올리면 손님 화면에서 접혀 보여요. 내일 다시 올려 주세요.": [
    "Up to 5 notices per 24 hours. More would be folded on customers' screens. Please post again tomorrow.",
    "お知らせは24時間に5件までです。それ以上はお客さんの画面で折りたたまれます。明日また投稿してください。",
    "每24小时最多5条公告，再多会在顾客界面被折叠。请明天再发。"],
  "공지 방을 먼저 만들어 주세요.": ["Create the notice room first.", "先にお知らせルームを作ってください。", "请先创建公告房间。"],
  "레이븐볼트 상품 공유 링크(ravenvault.ex.erci.se/r/… 또는 /g/…)만 붙일 수 있어요.": [
    "Only RavenVault product share links (ravenvault.ex.erci.se/r/… or /g/…) can be attached.",
    "RavenVault の商品共有リンク（ravenvault.ex.erci.se/r/… または /g/…）だけ添付できます。",
    "只能附上 RavenVault 商品分享链接（ravenvault.ex.erci.se/r/… 或 /g/…）。"],
  "공지가 너무 길어요. 8,000자 아래로 줄여 주세요.": [
    "The notice is too long. Please keep it under 8,000 characters.",
    "お知らせが長すぎます。8,000文字以下にしてください。",
    "公告太长了，请控制在8,000字以内。"],
  "받는 손님을 확인해 주세요.": ["Check the customer you are replying to.", "返信先のお客さんを確認してください。", "请确认要回复的顾客。"],
};
