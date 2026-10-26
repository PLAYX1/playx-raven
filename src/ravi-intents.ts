import limits from "./ravi-similarity-thresholds.json";
import { raviSimilarity, type SimilarityDecision } from "./ravi-similarity";
/** Conservative explicit signals precede offline example retrieval.
 * Match stems across particles/endings; normalize spacing/width and only lexical typos.
 * Addresses and amounts are never corrected, resolved or executed here.
 */
export const normalizeRavi = (q: string) => String(q ?? "").normalize("NFKC").toLowerCase()
  .replace(/[\s?!？！.,·'’"「」]/g, "")
  .replace(/백엎|백압/g, "백업").replace(/송굼/g, "송금").replace(/잔엑|잔얙/g, "잔액")
  .replace(/메뉴판|매뉴/g, "메뉴").replace(/레이븐볼트|레븐볼트|ravenvaul?t/g, "ravenvault");
const concepts = {
  shop: /가게|매장|상점|영업|shop|store|店舗|お店|店铺|商店/,
  close: /휴무|휴업|쉬는날|쉬어|쉴|쉬겠|닫을|닫겠|문닫|문을닫|영업.*(?:중단|종료)|재료.*떨어|closed|clos(?:e|ing)|shut|dayoff|休業|休店|店休|閉め|休息|打烊|关门|停业/,
  hours: /영업시간|문(?:을)?여는시간|문(?:을)?닫는시간|오픈시간|운영시간|개점|폐점|openinghours|businesshours|storehours|営業時間|開店時間|閉店時間|营业时间|开门时间/,
  qr: /qr|큐알|큐아르|二次元コード|二维码|二維碼/,
  link: /주문링크|주문주소|주문url|orderlink|orderinglink|注文リンク|订购链接|下单链接/,
  order: /주문|입금대기|미입금|미결제|결제대기|order|pendingpayment|注文|未払い|订单|待付款/,
  sales: /매출|얼마벌|수입|매상|얼마(?:나)?팔|판매(?:액|한합계)|장사.*(?:어때|어땠|잘됐|실적|결과|됐어|얼마|얼마나|확인)|손님(?:이)?(?:몇명|얼마|얼마나).*(?:왔|오|온)|sales|revenue|takings|売上|销售额|营收/,
  export: /csv|엑셀|excel|스프레드시트|spreadsheet|장부|(?:세금|세무|회계).*(?:자료|서류)|세금자료|세무자료|(?:매출|매상).*(?:내보|밖으로|자료.*꺼내)|export|台帳|税務資料|書き出|导出|账本|税务资料/,
  receipt: /영수증|최근거래|거래내역|거래기록|(?:송금|이체)(?:한)?내역|입출금|거래목록|결제(?:한)?내역|receipt|transaction(?:s|history|record)|paymenthistory|領収書|取引履歴|明細|收据|交易记录|付款记录/,
  menu: /메뉴|품절|재고|가격.*(?:바꾸|바꿔|변경|올려|올리|낮춰|낮추)|품목|menu|stock|soldout|メニュー|在庫|品切れ|菜单|库存|售罄/,
  details: /이름|소개|주소|전화|연락처|등록|설정|정보|사진|로고|배달|포장|name|description|address|phone|settings|details|delivery|pickup|名前|店舗名|店名|紹介|住所|電話|設定|配達|持ち帰り|名称|简介|地址|电话|设置|配送|自提/,
  assets: /자산|회원권|쿠폰|이용권|티켓|굿즈|asset|membership|coupon|ticket|資産|会員券|クーポン|チケット|资产|优惠券|会员券/,
  owned: /받은|보유|내(?:자산|티켓|쿠폰|회원권)|내자산|목록|가지고|확인|보기|보여|있나|있어|list|owned|myassets|view|received|持って|一覧|受け取った|收到|持有|列表|查看/,
  create: /만들|발행|등록|생성|제작|create|issue|mint|作成|発行|作り|创建|发行|制作/,
  reward: /나눠|나누|배당|보유자|분배|distribut|dividend|holders|配布|配当|分发|分红/,
  phone: /폰|휴대폰|핸드폰|스마트폰|phone|mobile|スマホ|スマートフォン|携帯|手机/,
  connect: /연결|연동|페어링|짝짓|등록|붙이|붙여|connect|pair|接続|ペア|连接|配对/,
  talk: /채팅|메시지|쪽지|대화방|이야기.*(?:방|초대)|친구.*(?:추가|초대)|대화방|chat|message|invitefriend|チャット|メッセージ|聊天|消息/,
  media: /영상|동영상|파일|사진.*(?:보내|전송|첨부)|(?:보내|보낼|전송).*사진|비디오|video|sendfile|attachment|動画|ファイル|视频|文件/,
  report: /오류|버그|고장|먹통|문제.*(?:알리|알려|신고)|작동안|안돌아|error|bug|broken|reportproblem|エラー|不具合|故障|错误|故障|报错/,
  undo: /환불|취소|되돌|돌려받|(?:보낸|받을사람).*?(?:틀렸|잘못|다시가져|다시돌)|refund|cancel|undo|取消|取り消|返金|退款|撤销/,
  money: /돈|레이븐|레븐|코인|rvn|money|coin|funds|レイヴン|コイン|お金|钱|渡鸦币|币/,
  send: /송금|이체|보내|보낼|보낸|전송|send|transfer|送金|送って|转账|汇款|发送/,
  balance: /잔액|잔고|얼마(?:나|가)?있|얼마(?:나|가)?남|얼마(?:나|가)?갖|얼마들|몇개.*(?:있|가지)|보유량|balance|howmuch.*(?:have|left)|fundsleft|残高|いくら.*(?:ある|残)|余额|还剩多少|有多少/,
  pending: /안보|안들어|안떠|대기|확인중|pending|notarriv|notshow|入金待|未到账/,
  receive: /받기|받는(?:법|방법|주소)|받으려|돈받|코인받|입금주소|내주소|주소(?:알려|어디|복사)|receive|receiving|myaddress|depositaddress|受け取|入金アドレス|收款|收币/,
  incoming: /(?:나한테|내게|나에게|내쪽으로|내지갑에).*?(?:보내|보낸|송금한대|넣어준)|(?:돈|코인|레이븐|rvn)(?:을|를)?(?:보내준|준대|주겠대|준다고)|(?:친구|지인|동생|상대|누가|아는사람).*?(?:내게|나에게|나한테).*?(?:준|보낸)/,
  password: /(?:비번|비밀번호|지갑암호|암호).*?(?:까먹|잊|분실|잃|기억.*(?:안|않|못)|생각.*안|모르|가물)|(?:잊|분실|잃).*?(?:비번|비밀번호|지갑암호)|복구단어.*비번.*새로|(?:forgot|lost).*?(?:wallet)?(?:password|passcode)|walletpasswordrecovery|(?:パスワード.*(?:忘|紛失))|(?:钱包密码.*(?:忘|丢失))/,
  map: /(?:근처|주변|주위|근방|가까운|동네).*?(?:가게|매장|상점|가맹점|카페|식당)|(?:가게찾|가맹점|상점위치).*?(?:지도|어디|궁금)|(?:rvn|레이븐|코인)(?:을)?(?:받는|쓸|쓰는|결제).*?(?:가게|매장|상점|식당|곳)|(?:rvn|레이븐).*쓸.*어디|(?:nearbyshop|findnearbyshops|spendrvnnearby)|近く.*?(?:店|お店)|附近.*?(?:店铺|rvn)/,
  fee: /수수료|(?:송금|이체|보내).*(?:비용)|手数料|手续费|費用|费用/,
  seed: /복구단어|12단어|열두단어|시드|니모닉|seed|recovery(?:word|phrase)|mnemonic|復元(?:用の)?(?:単語|フレーズ)|シード|助记词|恢复词|种子/,
  backup: /(?:지갑|자료|파일).*(?:복구|복원|되살)|복원|walletrestore|restore.*(?:wallet|backup)|恢复钱包|还原|復元|백업|backup|back.?up|バックアップ|备份|備份/,
  cert: /증서|증명서|수료증|자격증|certificate|証明書|证书|證書/,
  key: /열쇠|api|키(?:를|는|넣|받|어디|연결)|apikey|キー|密钥|密鑰/,
  sync: /동기화|싱크|따라잡|노드|node|sync|同期|同步|ノード|节点|節點/,
  appearance: /테마|다크|밝게|어둡게|글씨|글자|폰트|theme|darkmode|fontsize|テーマ|文字サイズ|主题|字号/,
  about: /ravenvault.*(?:뭐|무엇|무슨|소개|설명)|(?:whatis|about).*ravenvault|ravenvaultとは|ravenvault是什么/,
  safety: /안전|보안|믿어도|해킹|사기|safe|secure|security|trust|安全|セキュリティ|安全吗|安全性/,
  help: /^(?:라비[야가]?)?(?:뭘할|뭐할|무엇을할|뭐가돼|할수있는|뭐해줄|기능(?:알|소개|목록)|사용법|도움말|도와줘|help|whatcanyoudo|howcanyouhelp|show.*features|何ができ|使い方|ヘルプ|你能做什么|可以做什么|功能介绍|帮助)/,
  promo: /홍보|광고(?:글|문구)|(?:카톡|카카오톡|단톡|인스타|instagram).*?(?:글|문장|문구|소식|소개|공지|올|포스|캡션|post|caption)|sns.*(?:글|문구|올)|특가.*(?:알려|글|만들)|promot|advertis|socialpost|instagram.*(?:post|caption)|宣伝|インスタ.*(?:投稿|文章)|宣传|推广|广告文案/,
  unsupported: /비트코인|bitcoin|\bbtc\b|比特币|比特幣|ビットコイン|이더리움|ethereum|以太坊|イーサリアム|usdt|테더|tether|솔라나|solana|도지코인|dogecoin|날씨|기온|weather|forecast|天気|天气|彩票|복권|로또/,
  market: /중고|판매글|secondhand|used.*rvn|中古|二手/,
};
type Concept = keyof typeof concepts;
export function raviFeatures(q: string): Set<Concept> {
  const text = normalizeRavi(q);
  const found = new Set<Concept>((Object.keys(concepts) as Concept[]).filter(k => concepts[k].test(text)));
  // English word boundaries survive normalization; "coffee" is not a fee question.
  if (/\bfees?\b/i.test(q)) found.add("fee");
  // A membership pass is a token; "password" is not an asset request.
  if (/\bpass(?:es)?\b/i.test(q)) found.add("assets");
  return found;
}
function ruleHelpIntent(q: string): boolean {
  const text = normalizeRavi(q);
  const features = raviFeatures(q);
  if (features.has("unsupported") || features.has("promo") || raviIntentIds(q).length) return false;
  return features.has("help") || /\bhelp\b/i.test(q) || /도움(?:말|이필요)|도와(?:줘|주|줄)|(?:어떻게|어찌)(?:써|쓰|사용)|(?:뭘|뭐|무엇을)할|(?:할수있는|뭐해줄|기능소개)|ヘルプ|使い方|機能一覧|帮助|何ができ|whatcan(?:you|ravi)do|what(?:do|does)(?:you|ravi)do|howcanyouhelp|(?:which|what)features|capabilit|yourfeatures|機能.*(?:教|紹介)|帮我一下|你能做什么|能干嘛|能做啥|怎么用/.test(text);
}
function rulePromoIntent(q: string): boolean {
  const f = raviFeatures(q);
  return f.has("promo") && !f.has("unsupported") && !f.has("send") && !f.has("undo");
}
/** Related feature hierarchies collapse; independent intents remain candidates.
 * No ranking by regex order: a request with two unrelated meanings must abstain.
 */
export function raviIntentIds(q: string): string[] {
  const f = raviFeatures(q), has = (...ks: Concept[]) => ks.every(k => f.has(k));
  if (has("unsupported")) return [];
  const ids = new Set<string>();
  const use = (id: string, condition: boolean) => { if (condition) ids.add(id); };
  use("password", has("password")); use("map", has("map") && !/지도.*(?:올리|올려|등록)|mapregister/.test(normalizeRavi(q)));
  use("promo", rulePromoIntent(q));
  use("hours", has("hours") || has("shop") && /(?:몇시|언제).*(?:열|여|닫)/.test(normalizeRavi(q))); use("closed", has("close"));
  use("qr", has("qr") && !has("phone") && !has("receive") && !has("money"));
  use("order-link", has("link")); use("orders", has("order"));
  use("sales", has("sales")); use("export", has("export")); use("receipt", has("receipt"));
  use("menu", has("menu") || /\d+(?:원|krw|円|元).*(?:넣|추가|등록|add|追加|添加)/.test(normalizeRavi(q))); use("shop", has("shop", "details") || /배달|포장|delivery|pickup|配達|配送|自提/.test(normalizeRavi(q)));
  use("cert", has("cert") && (!has("owned") || /진짜|진위|真偽|verify|验证/.test(normalizeRavi(q)))); use("assets", has("owned") && (has("assets") || has("cert") && !/진짜|진위|真偽|verify|验证/.test(normalizeRavi(q))));
  use("create", has("assets") && !has("owned") || has("assets", "create"));
  use("reward", has("reward") && !(has("create", "assets") && !/보유자|holders|保有者|持有者/.test(normalizeRavi(q)))); use("phone", has("phone", "connect"));
  use("talk", has("talk")); use("media", has("media")); use("report", has("report"));
  use("undo", !has("order") && has("undo") && (has("send") || has("order") || /환불|받을사람|refund|返金|退款/.test(normalizeRavi(q))));
  use("send", !has("incoming") && (has("send", "money") || /송금|이체|送金|转账|汇款/.test(normalizeRavi(q)) ||
    /(?:한테|에게|님께)\d+(?:rvn|원|코인|개)?(?:을|를)?보내/.test(normalizeRavi(q)) ||
    /\bsend\s+[0-9]+(?:\.[0-9]+)?\s+(?:to\s+|rvn\b)/i.test(q)));
  use("balance", has("balance") || has("money", "pending") || /입금.*(?:안보|안들어|안떠|확인중)|deposit.*pending/.test(normalizeRavi(q)));
  use("receive", (has("receive") || has("incoming")) && !has("owned", "assets") && !has("owned", "cert")); use("fee", has("fee")); use("seed", has("seed"));
  use("backup", has("backup")); use("key", has("key")); use("sync", has("sync"));
  use("appearance", has("appearance")); use("about", has("about")); use("safety", has("safety")); use("market", has("market"));
  // Only collapse an overlapping noun, not independently stated requests.
  const collapse: Record<string, string[]> = {
    "order-link": ["orders"], qr: ["orders"], hours: ["shop"], closed: ["shop"],
    export: ["sales", "media", "receive"], receipt: ["orders", "send"], cert: ["create", "assets"],
    assets: ["create"], seed: ["backup"], undo: ["send", "orders"],
    fee: ["send"], media: ["send", "talk"], market: ["send", "create"], reward: ["send", "assets", "create"],
    safety: ["key", "seed"], backup: ["media"], key: ["receive"],
    password: ["seed", "backup"], map: ["shop", "receive"],
  };
  for (const [parent, children] of Object.entries(collapse)) if (ids.has(parent)) children.forEach(id => ids.delete(id));
  // Writing about a menu/shop is promotion; independently requested edits stay ambiguous.
  if (ids.has("promo") && !/바꾸|바꿔|수정|삭제|추가|저장|등록/.test(normalizeRavi(q))) {
    ids.delete("shop"); ids.delete("menu");
  }
  return [...ids];
}
/** Retrieval is injectable so validation can rebuild the model without held-out examples. */
export function raviResolve(q: string, retrieve: (q: string) => SimilarityDecision = raviSimilarity): SimilarityDecision {
  const ids = raviIntentIds(q), f = raviFeatures(q);
  if (f.has("unsupported")) return { kind: "miss", ids: [], ranked: [] };
  const result = retrieve(q);
  // An exact learned expression has an unambiguous label; the table is never an exam key.
  if ((result.ranked[0]?.score ?? 0) > 0.999999) return result;
  if (ids.length > 1) return { kind: "clarify", ids: ids.slice(0, 2), ranked: result.ranked };
  // A verb plus money identifies the send guide; bare verbs remain weak.
  const certain = ids.filter(id => id !== "send" && (id !== "balance" || f.has("balance") || f.has("pending")) && (id !== "create" || f.has("create")) && (id !== "assets" || !f.has("create")) ||
    id === "send" && (/송금|이체|送金|转账|汇款/.test(normalizeRavi(q)) || f.has("send") && f.has("money") || /\d/.test(q) && f.has("send")));
  // Clear scoped signals outrank lexical similarity. Multiple independent signals
  // were handled above; all send matches still lead only to the offline guide.
  if (certain.length === 1 && !["password", "map", "receive", "send", "sales", "promo"].includes(certain[0]) &&
      result.ranked[0]?.intent !== certain[0] && result.ranked[0]?.intent !== "miss" &&
      result.ranked[0]?.score >= limits.low && result.ranked[0].score - (result.ranked.find(r => r.intent === certain[0])?.score ?? 0) >= limits.margin) {
    return { kind: "clarify", ids: [certain[0], result.ranked[0].intent], ranked: result.ranked };
  }
  if (certain.length) return { kind: certain.length === 1 ? "direct" : "clarify", ids: certain.slice(0, 2), ranked: result.ranked };
  if (rulePromoIntent(q)) return { kind: "direct", ids: ["promo"], ranked: result.ranked };
  if (ruleHelpIntent(q)) return { kind: "direct", ids: ["help"], ranked: result.ranked };
  return result;
}
export function raviHelpIntent(q: string): boolean { const d = raviResolve(q); return d.kind === "direct" && d.ids[0] === "help"; }
export function raviPromoIntent(q: string): boolean { const d = raviResolve(q); return d.kind === "direct" && d.ids[0] === "promo"; }
export type RaviLanguage = "ko" | "en" | "ja" | "zh";
/** Script in the question outranks UI locale. RVN/QR/CSV alone use the UI fallback. */
export function raviQuestionLanguage(q: string, fallback: RaviLanguage = "ko"): RaviLanguage {
  // Explicit language-selection requests choose their requested answer language.
  // These names select copy only; they do not classify an intent or change UI settings.
  const requested: [RaviLanguage, string[]][] = [
    ["ko", ["한국어", "korean", "韓国語", "韩语"]], ["en", ["영어", "영문", "english", "英語", "英语"]],
    ["ja", ["일본어", "일본말", "japanese", "日本語", "日语"]], ["zh", ["중국어", "중문", "chinese", "中国語", "中文"]],
  ];
  const target = requested.filter(([, names]) => names.some(name => q.toLowerCase().includes(name)));
  if (target.length === 1 && raviResolve(q).ids[0] === "language") return target[0][0];
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(q)) return "ko";
  if (/[ぁ-んァ-ヶ]/.test(q)) return "ja";
  if (/[一-鿿]/.test(q)) return /残高|手数料|営業|売上|証明書|資産|送金|領収書|取引|復元|配布|休業/.test(q) ? "ja" : "zh";
  if (/[a-z]{2}/i.test(q.replace(/\b(?:rvn|qr|csv|api|ai)\b/gi, ""))) return "en";
  return fallback;
}
