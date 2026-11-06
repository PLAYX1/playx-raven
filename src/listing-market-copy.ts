// 0.9.17 「피드」 메뉴 · 「내 글」 · 맞교환 장터(listing-market.ts) 문구 — 영·일·중.
// 열쇠는 한국어 원문 그대로(i18n.ts 규칙). 유럽어 여섯은 아직 없어 영어로 내려간다.
// 돈 문구(수수료·되돌릴 수 없음)는 검수 전이라 유럽어 사전에 넣지 않는다.
export const LISTING_MARKET_COPY: Record<string, [string, string, string]> = {
  // 메뉴
  "피드": ["Feed", "フィード", "动态"],
  "장터": ["Market", "マーケット", "集市"],

  // 내 소개 → 내 글
  "내 글": ["My posts", "自分の投稿", "我的帖子"],
  "내가 「모두에게」 올린 글이에요. 누구나 읽을 수 있어요.": ["Posts you shared with “Everyone”. Anyone can read them.", "「みんなへ」に投稿したものです。誰でも読めます。", "你发到「所有人」的帖子，任何人都能看到。"],
  "아직 올린 글이 없어요.": ["You haven’t posted anything yet.", "まだ投稿がありません。", "你还没有发过帖子。"],
  "내 글을 읽지 못했어요.": ["Couldn’t load your posts.", "自分の投稿を読み込めませんでした。", "无法读取你的帖子。"],
  "피드에서 보기": ["Open in feed", "フィードで見る", "在动态中查看"],
  "내 글 가져오는 중…": ["Loading your posts…", "自分の投稿を取得しています…", "正在获取你的帖子…"],

  // 장터 화면
  "다른 사람이 올린 맞교환 제안이에요. 돈과 자산이 한 거래 안에서 동시에 오가서, 누구도 먼저 보내지 않아요.": [
    "Swap offers posted by other people. Money and the asset move together in one transaction, so nobody sends first.",
    "ほかの人が出した交換の提案です。お金と資産が一つの取引の中で同時に動くので、誰も先に送りません。",
    "这是其他人发布的互换报价。资金和资产在同一笔交易中同时转移，谁都不用先付。"],
  "둘러보기": ["Browse", "見て回る", "浏览"],
  "내 판매 글": ["My listings", "自分の出品", "我的出售"],
  "전체": ["All", "すべて", "全部"],
  "노래": ["Music", "音楽", "音乐"],
  "이미지": ["Images", "画像", "图片"],
  "책": ["Books", "本", "书"],
  "티켓": ["Tickets", "チケット", "门票"],
  "작품": ["Works", "作品", "作品"],
  "기타": ["Other", "その他", "其他"],
  "장터 가져오는 중…": ["Loading the market…", "マーケットを取得しています…", "正在获取集市…"],
  "장터를 읽지 못했어요.": ["Couldn’t load the market.", "マーケットを読み込めませんでした。", "无法读取集市。"],
  "아직 올라온 것이 없어요.": ["Nothing has been listed yet.", "まだ出品がありません。", "还没有任何出售。"],
  "이 종류에는 아직 없어요.": ["Nothing in this category yet.", "この種類にはまだありません。", "这个类别还没有。"],
  "새로 읽기": ["Refresh", "読み込み直す", "刷新"],
  "가격": ["Price", "価格", "价格"],
  "수수료 1% 별도": ["plus 1% fee", "手数料1%別途", "另收 1% 手续费"],
  "살 수 없어요": ["Can’t buy", "買えません", "无法购买"],
  "내가 올린 것": ["Posted by you", "自分の出品", "你发布的"],
  "그림 보기": ["Show picture", "画像を見る", "显示图片"],
  "그림을 열면 그림이 있는 서버가 내 컴퓨터 주소(IP)를 알게 돼요.": ["Opening the picture lets the server that holds it see your computer’s address (IP).", "画像を開くと、画像のあるサーバーにこのパソコンのアドレス（IP）が伝わります。", "打开图片后，存放图片的服务器会知道你电脑的地址（IP）。"],

  // 사기
  "사기 전에 확인해 주세요": ["Please check before buying", "買う前に確認してください", "购买前请确认"],
  "받는 것": ["You get", "受け取るもの", "你得到"],
  "파는 사람에게": ["To the seller", "売り手へ", "付给卖家"],
  "개발비 1%": ["Development fee 1%", "開発費1%", "开发费 1%"],
  "공개 장부 수수료": ["Network fee", "公開台帳の手数料", "网络手续费"],
  "모두": ["Total", "合計", "合计"],
  "거래를 만들어 확인하는 중…": ["Building and checking the transaction…", "取引を作って確認しています…", "正在生成并检查交易…"],
  "아직 돈은 나가지 않았어요. 「정말 사기」를 눌러야 보내요. 보낸 뒤에는 되돌릴 수 없어요.": [
    "No money has left yet. It is sent only when you press “Buy now”. Once sent, it can’t be undone.",
    "まだお金は出ていません。「本当に買う」を押すと送ります。送った後は取り消せません。",
    "钱还没有付出。按「确认购买」才会发送。发送后无法撤回。"],
  "정말 사기": ["Buy now", "本当に買う", "确认购买"],
  "보내는 중…": ["Sending…", "送信中…", "正在发送…"],
  "보냈어요. 체인에 올라가려면 몇 분 걸려요.": ["Sent. It takes a few minutes to appear on the chain.", "送りました。チェーンに載るまで数分かかります。", "已发送。上链需要几分钟。"],
  "거래 번호": ["Transaction ID", "取引番号", "交易编号"],
  "보냈는지 확인하지 못했어요. 같은 것을 다시 사지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.": [
    "We couldn’t confirm whether it was sent. Don’t buy it again — check the wallet’s transaction history first.",
    "送れたか確認できませんでした。同じものをもう一度買わず、まずウォレットの取引履歴を確認してください。",
    "无法确认是否已发送。请不要再次购买，先在钱包的交易记录中确认。"],
  "살 때 내 몫을 서명하려면 지갑을 열어야 합니다.": ["To sign your part of the purchase, the wallet must be unlocked.", "購入の自分の分に署名するには、ウォレットを開く必要があります。", "要为购买签署你的部分，需要先解锁钱包。"],

  // 내 판매 글
  "아직 올린 판매 글이 없어요.": ["You have no listings yet.", "まだ出品がありません。", "你还没有出售。"],
  "내 판매 글을 읽지 못했어요.": ["Couldn’t load your listings.", "自分の出品を読み込めませんでした。", "无法读取你的出售。"],
  "올라가 있음": ["Listed", "出品中", "出售中"],
  "팔렸음": ["Sold", "売れました", "已售出"],
  "내렸음": ["Taken down", "取り下げ済み", "已下架"],
  "내리기": ["Take down", "取り下げる", "下架"],
  "정말 내릴까요? 내리면 이 제안에 묶어 둔 자산을 내 지갑으로 되돌리는 거래를 보내요. 공개 장부 수수료가 조금 들어요.": [
    "Take it down? This sends a transaction that returns the asset held for this offer to your wallet. A small network fee applies.",
    "本当に取り下げますか？この提案のために取っておいた資産を自分のウォレットに戻す取引を送ります。公開台帳の手数料が少しかかります。",
    "确定下架吗？下架会发送一笔交易，把为此报价预留的资产退回你的钱包，需要少量网络手续费。"],
  "네, 내리기": ["Yes, take it down", "はい、取り下げる", "是，下架"],
  "내리는 중…": ["Taking down…", "取り下げています…", "正在下架…"],
  "내렸어요.": ["Taken down.", "取り下げました。", "已下架。"],
  "내리려면 지갑을 열어야 합니다.": ["To take it down, the wallet must be unlocked.", "取り下げるにはウォレットを開く必要があります。", "要下架，需要先解锁钱包。"],

  // 맞교환 → 장터에 올리기
  "장터에 올리기": ["Post to market", "マーケットに出す", "发布到集市"],
  "장터 둘러보기": ["Browse the market", "マーケットを見る", "浏览集市"],
  "이 제안을 장터에 올리면 누구나 보고 살 수 있어요. 산 사람이 RVN 을 붙여야 거래가 돼요.": [
    "Post this offer to the market and anyone can see and buy it. The deal happens only when a buyer adds RVN.",
    "この提案をマーケットに出すと、誰でも見て買えます。買う人が RVN を付けたときに取引になります。",
    "把这个报价发布到集市后，任何人都能看到并购买。买家附上 RVN 后交易才会成立。"],
  "제목": ["Title", "タイトル", "标题"],
  "설명": ["Description", "説明", "说明"],
  "종류": ["Category", "種類", "类别"],
  "그림 주소 (없어도 돼요)": ["Picture address (optional)", "画像のアドレス（なくても大丈夫）", "图片地址（可不填）"],
  "예: 1집 한정판": ["e.g. First album, limited edition", "例：1stアルバム限定版", "例如：首张专辑限量版"],
  "어떤 것인지 짧게 적어 주세요": ["Describe it briefly", "どんなものか短く書いてください", "请简单介绍一下"],
  "미리 보기": ["Preview", "プレビュー", "预览"],
  "고치기": ["Edit", "直す", "修改"],
  "올리기": ["Post", "出す", "发布"],
  "아래처럼 보여요. 맞으면 「올리기」를 누르세요.": ["It will look like this. If it’s right, press “Post”.", "このように表示されます。よければ「出す」を押してください。", "会显示成这样。没问题就按「发布」。"],
  "제목을 적어 주세요.": ["Please enter a title.", "タイトルを入力してください。", "请填写标题。"],
  "그림 주소는 ipfs:// 나 https:// 로 시작해야 해요.": ["The picture address must start with ipfs:// or https://.", "画像のアドレスは ipfs:// か https:// で始めてください。", "图片地址必须以 ipfs:// 或 https:// 开头。"],
  "장터에 올렸어요.": ["Posted to the market.", "マーケットに出しました。", "已发布到集市。"],
  "장터에서 보기": ["See it in the market", "マーケットで見る", "在集市中查看"],
  "장터에 올리는 중…": ["Posting to the market…", "マーケットに出しています…", "正在发布到集市…"],
};
