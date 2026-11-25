/**
 * 11-25 라비 「키 없이 바로 답」 1단계 — 「말로 준비, 단추로 끝」(페이블·제미나이 합의).
 *
 * AI 키가 없어도(어르신·처음 쓰는 분) 라비에게 말하면 **바로**(네트워크 없이) 답한다.
 *  - 잔액 · 오늘/이번 주 매출 · 새 주문 · 안 읽은 쪽지 — 이 컴퓨터 IPC 로 읽은 숫자만. 지어내지 않는다.
 *  - 화면 열기(장터·게임·설정·백업·지갑·자산·내 가게·홈) · 받기 주소(읽기만, 복사 단추)
 *  - 보내기 — **준비만**. 받을 사람 이름이 이 컴퓨터 「받을 사람」 목록과 똑같을 때만 주소를 채운다.
 *    보내기 단추는 사람이 누른다(라비는 확인 화면도 띄우지 않는다).
 *
 * 🔴 이 판정은 **사용자가 라비 대화칸에 직접 치거나 말한 글**에만 쓴다(main.ts chatSendExisting).
 *    남이 보낸 쪽지·글·주문 메모를 여기에 넣지 않는다.
 * 🔴 자신 있게 맞을 때만 답한다. 둘 이상 겹치거나·부정(「보내지 마」)·남의 잔액이면 null →
 *    기존 길(키 있으면 AI, 없으면 정해 둔 안내)로 그대로 간다.
 */
import { normalizeRavi } from "./ravi-intents";

export type InstantPage = "trade" | "games" | "settings" | "backup" | "wallet" | "assets" | "shop" | "home";
export type RaviInstant =
  | { kind: "balance" }
  | { kind: "sales"; period: "today" | "week" }
  | { kind: "orders" }
  | { kind: "messages" }
  | { kind: "receive" }
  | { kind: "open"; page: InstantPage }
  /** to = 「○○에게」 앞의 말(최대 세 낱말, 주소록 이름 맞추기용). amount = RVN 숫자(없거나 애매하면 null). */
  | { kind: "send"; to: string; amount: number | null };

/** 자주 나는 오타만 바로잡는다(돈 숫자·주소는 건드리지 않는다). */
const fix = (s: string) => s
  .replace(/잔약|잔엑|잔엌|짠액/g, "잔액").replace(/매츨|메출|맥출/g, "매출").replace(/쪽찌|족지/g, "쪽지")
  .replace(/메세지|매세지|메시즈/g, "메시지").replace(/설쩡|셜정|설졍/g, "설정").replace(/장떠|쟝터/g, "장터")
  .replace(/게잉|겜(?!블)/g, "게임").replace(/주뭄|쥬문/g, "주문").replace(/백엎|빽업|백압/g, "백업")
  .replace(/보네|보내조|보내져(?=$|요)/g, "보내").replace(/열어조|열어져(?=$|요)/g, "열어");
const norm = (q: string) => fix(normalizeRavi(q));

/** 하지 말라는 말 — 이런 문장에서는 아무것도 준비하지 않는다. */
const NEG = /안보내|안열|필요없|[가-힣]지마|[가-힣]지말|지말아|말아줘|말고|말까|면안돼|면안되|안할래|하지않|금지|취소|그만|don'?t|donot|never|cancel|stop/;
/** 내 것이라는 말(이 앞말은 남이 아니다). */
const SELF = new Set(["", "내", "제", "나", "저", "나의", "저의", "우리", "내꺼", "my", "mine", "지갑", "내지갑", "지갑에", "지갑의", "rvn", "레이븐", "레이븐코인", "코인", "현재", "지금", "남은", "총", "전체", "오늘", "라비야", "라비", "그럼", "혹시", "좀", "확인", "통장", "the", "what's", "whats", "what", "check", "show", "is", "현재잔액"]);
/** 남을 가리키는 말 — 남의 잔액·주소는 답하지 않는다(이 컴퓨터 지갑만 안다). */
const OTHER = /친구|남(?:의|이|들|한테)|상대|그사람|저사람|다른사람|다른가게|옆가게|엄마|아빠|어머니|아버지|형(?:의|이|네)|누나|언니|오빠|동생|아들|딸|남편|아내|와이프|사장님(?:의|네)|님(?:의|은|이|네)|씨(?:의|는|네)|someone|somebody|\bhis\b|\bher\b|\btheir\b|friend|other/i;
/** 영어 소유격 「john's balance」(what's·it's 는 아니다). */
const OTHER_EN = /\b(?!(?:what|that|it|there|here|let|who|how|today|today’)'s)[a-z]+'s\s+(?:balance|wallet|address|money|coins?|rvn)/i;

/** 낱말 바로 앞의 말(조사 떼고) — 「철수 잔액」·「철수잔액」의 「철수」. 띄어 쓴 원문에서 찾는다. */
function ownerBefore(raw: string, noun: RegExp): string {
  const at = raw.search(new RegExp(noun.source, "i"));
  if (at <= 0) return "";
  const word = (raw.slice(0, at).trim().split(/\s+/).pop() || "").toLowerCase().replace(/[?!.,]/g, "");
  // 영어 앞말(how·much·show…)은 주인이 아니다 — 영어 소유격은 OTHER_EN 이 본다.
  return /[가-힣]/.test(word) ? word.replace(/(?:의|이|가|은|는|에|에게|한테)$/, "") : "";
}
const isOther = (raw: string, s: string, noun: RegExp) => {
  if (OTHER.test(raw) || OTHER.test(s) || OTHER_EN.test(raw)) return true;
  const w = ownerBefore(raw, noun);
  return !!w && !SELF.has(w);
};

const ADDRESS = /\bR[1-9A-HJ-NP-Za-km-z]{25,34}\b/;
const OPEN_VERB = /하고싶|할래|하러|play|열어|열기|열자|열래|켜줘|켜봐|보여|가자|가줘|가볼|가고싶|이동|들어가|띄워|화면|창|open|show|goto|takemeto|launch/;
const NOT_OPEN = /만들|올리|올려|등록|삭제|지워|바꿔|바꾸|어떻게|어떡|뭐야|뭔가|왜|방법|하는법|설명|팔고|팔래|어디서|what|how|why|create|make|upload/;

const PAGES: [InstantPage, RegExp][] = [
  ["trade", /장터|마켓|market|marketplace/],
  ["games", /게임|오락실|arcade|games?\b/],
  ["settings", /설정|세팅|셋팅|환경설정|settings?/],
  ["backup", /백업|backup/],
  ["wallet", /지갑|wallet/],
  ["assets", /내자산|자산(?:화면|목록)?|assets?/],
  ["shop", /내가게|가게화면|우리가게|myshop|myshop/],
  ["home", /^(?:홈|첫화면|처음화면|메인)|home(?:screen)?/],
];

function matchSend(raw: string, s: string): RaviInstant | null {
  s = s.replace(/내보내/g, "");
  if (!/보내|송금|이체|부쳐|부치|send|transfer|\bpay\b/i.test(raw + " " + s)) return null;
  // 지난 일·남이 보내는 일·묻기는 준비하지 않는다.
  if (/보냈|보낸|송금했|이체했|sent\b|received?/.test(s) || /(?:나한테|나에게|내게|저한테|저에게|tome\b)/.test(s)) return null;
  if (/어떻게|어떡|방법|하는법|수수료|얼마나걸|언제|왜|뭐야|가능해|돼\?|되나|howto|howdo|howcan|fee/.test(s)) return null;
  if (/환불|되돌|돌려|refund|undo/.test(s)) return null;
  // 쪽지·글·사진·초대를 보내는 것은 돈 보내기가 아니다(이야기 쪽 — 라비는 대신 보내지 않는다).
  if (/쪽지|메시지|메일|문자|글|사진|파일|영상|초대|링크|주소를|message|photo|file|invite|link|email/.test(s)) return null;
  const order = /보내줘|보내주세요|보내주라|보내줄래|보내요$|보내라|보내자|보낼래|보내고싶|보내려|보낼게|보내기|송금해|송금하고|송금할|이체해|이체하고|이체할|부쳐줘|^send|send\d|sendrvn|sendmoney|sendcoins?|sendto|opensend|sendscreen|sendpage|^transfer|transfer\d|^pay/.test(s);
  if (!order) return null;
  // 받을 사람: 「철수에게 / 철수한테 / 철수님께」 앞 낱말(최대 셋) · 「to chulsoo」.
  let to = "";
  const ko = /((?:[^\s]+\s+){0,2}[^\s]+?)\s*(?:님께|님에게|님한테|에게로|에게|한테|께)(?:\s|$)/.exec(raw);
  if (ko) to = ko[1].replace(/^(?:라비야|라비|그럼|지금|얼른|빨리|좀)\s+/, "").trim();
  const en = /\bto\s+([^\s\d][^\s]{0,39}(?:\s+[^\s\d][^\s]{0,39})?)\s*$/i.exec(raw.replace(/\s*(?:please|now)\s*$/i, "")) || /\bto\s+([^\s\d][^\s]{0,39})/i.exec(raw);
  if (!to && en) to = en[1].trim();
  if (/^(?:나|저|me|myself|내지갑)$/i.test(to)) return null;
  // 금액: 맨숫자(소수점 · 천 단위 쉼표)만. 「만·천·원·달러」가 붙으면 RVN 이 아니라서 비운다.
  let amount: number | null = null;
  const n = /(\d[\d,]*(?:\.\d+)?)\s*(만|천|억|원|krw|₩|달러|usd|\$|엔|위안)?/i.exec((to ? raw.replace(to, " ") : raw).replace(ADDRESS, ""));
  if (n && !n[2]) {
    const v = Number(n[1].replace(/,(?=\d{3}(?:\D|$))/g, ""));
    amount = Number.isFinite(v) && v > 0 && /^\d+(?:\.\d{1,8})?$/.test(n[1].replace(/,/g, "")) ? v : null;
  }
  return { kind: "send", to, amount };
}

/** 사용자가 직접 친 한 줄 → 바로 답할 일. 자신 없으면 null. */
export function raviInstantIntent(q: string): RaviInstant | null {
  const raw = String(q ?? "").normalize("NFKC").trim();
  const s = norm(raw);
  if (!s || s.length > 48) return null;
  // 주소가 들어간 말은 기존 길(공개 조회 제안·주소 확인·키 있는 보내기 준비)이 맡는다.
  if (ADDRESS.test(raw)) return null;
  if (NEG.test(s)) return null;

  const send = matchSend(raw, s);
  if (send) return send;
  if (/보내|송금|이체|send|transfer/.test(s.replace(/내보내/g, ""))) return null;

  const hits: RaviInstant[] = [];
  // 받기 주소 — 가게 링크·고정 주소·새 주소 만들기는 다른 길.
  if (/받기|받는주소|받을주소|입금주소|내주소|제주소|내지갑주소|지갑주소|rvn주소|코인주소|돈받는|코인받는|rvn받는|receive|myaddress|depositaddress|walletaddress/.test(s) &&
      !/가게|매장|고정|링크|url|shop|store|새주소|새로|newaddress|바꿔|어떻게바|받은|받았|받을사람/.test(s) &&
      !isOther(raw, s, /받기|받는|입금|주소|address/)) hits.push({ kind: "receive" });
  // 잔액 — 「RVN 얼마야」(시세 물음)는 빼고, 있/남/가지/내 가 함께일 때만.
  if ((/잔액|잔고|balance/.test(s) ||
       /(?:내|제|나의|우리)(?:지갑)?(?:에|의)?(?:돈|rvn|레이븐|코인)?(?:이|은|는|가)?(?:얼마|몇개)/.test(s) ||
       /(?:돈|rvn|레이븐|코인)(?:이|은|는|을|가)?(?:얼마|몇개)(?:나|가)?(?:있|남|가지|보유)/.test(s) ||
       /지갑에?(?:돈|rvn|코인)?(?:이|은)?얼마/.test(s) ||
       /howmuch(?:rvn|money|coins?)?(?:do|have)i(?:have|got)|howmuch(?:is|do)i?(?:have)?inmywallet|howmuch(?:rvn|money)(?:isleft|left)/.test(s)) &&
      !/시세|가격|환율|몇원|원이야|원이에|price|worth|rate|수수료|fee|부자|순위|rank|내야|내면|비용|요금|결제|cost/.test(s) &&
      !isOther(raw, s, /잔액|잔고|돈|지갑|balance|코인|rvn/)) hits.push({ kind: "balance" });
  // 매출 — 어제·지난·달 단위·내보내기·늘리는 법은 다른 길.
  if ((/매출|매상|얼마(?:나)?(?:벌|팔)|장사(?:는|가)?(?:어때|어땠|잘됐|됐어)|sales|revenue|earn/.test(s)) &&
      !/어제|그제|지난|작년|올해|이번달|지난달|한달|월별|month|yesterday|last|csv|엑셀|excel|장부|내보|export|늘리|올리는|방법|어떻게하면|어떻게늘|어떻게올|howto|howcan|increase|부가세|세금|tax/.test(s) &&
      !OTHER.test(raw)) hits.push({ kind: "sales", period: /이번주|금주|이주|주간|일주일|한주|thisweek|week|7일/.test(s) ? "week" : "today" });
  // 새 주문 — 주문 링크·주문 받는 법·환불·취소는 다른 길.
  if (/주문|order/.test(s) &&
      /(?:새|신규|들어온|들어왔|온|왔|있|몇|확인|봐|보여|check|new|any|pending|들어)/.test(s.replace(/주문|orders?/g, "")) &&
      !/링크|주소|url|link|qr|큐알|받는법|받는방법|어떻게|하는법|환불|취소|refund|cancel|넣|추가|만들|메뉴/.test(s)) hits.push({ kind: "orders" });
  // 안 읽은 쪽지·메시지 — 보내기·쓰기는 아니다.
  if (/쪽지|메시지|디엠|dm|unread|messages?|inbox/.test(s) &&
      /안읽|안본|읽지않|새|왔|있|몇|확인|봐|보여|unread|new|any|check/.test(s) &&
      !/써|쓰기|쓸|답장|write|reply|send/.test(s)) hits.push({ kind: "messages" });

  if (hits.length > 1) return null; // 두 가지를 한꺼번에 물으면 짐작하지 않는다.
  if (hits.length === 1) return hits[0];

  // 화면 열기 — 낱말 하나만(「장터」) 또는 열기 말과 함께(「장터 열어 줘」). 「게임 만들기」는 아니다.
  const pages = PAGES.filter(([, re]) => re.test(s)).map(([p]) => p);
  // 「내 자산」 ⊂ 「자산」, 「지갑 설정」 같은 두 낱말은 짐작하지 않는다.
  if (pages.length !== 1 || NOT_OPEN.test(s)) return null;
  const stripped = s.replace(/^(?:라비야|라비|좀|얼른|빨리)/, "").replace(PAGES.find(([p]) => p === pages[0])![1], "")
    .replace(/(?:으로|로|에|을|를|좀|화면|창|페이지|page|screen|the|please|요|줘|주세요|해줘|해)/g, "");
  if (!OPEN_VERB.test(s) && stripped.length > 0) return null;
  return { kind: "open", page: pages[0] };
}

/* ── 이 컴퓨터 「받을 사람」 이름 맞추기 ─────────────────────────────────── */

export type PayeeLike = { address: string; name: string };
const key = (s: string) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
/** 「김 철수에게」 → 「김 철수」 「철수」 순서로 **글자가 똑같은** 이름 하나만. 둘 이상이거나 없으면 null. */
export function payeeExact(to: string, payees: PayeeLike[]): PayeeLike | null {
  const words = String(to ?? "").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const want = key(words.slice(i).join(" "));
    if (!want) continue;
    const hit = payees.filter((p) => key(p.name) === want);
    const addrs = new Set(hit.map((p) => p.address));
    if (addrs.size === 1) return hit[0];
    if (addrs.size > 1) return null; // 같은 이름 두 주소 — 사람이 고른다
  }
  return null;
}

/* ── 답 문구(한국어 원문 → 영어) ────────────────────────────────────────── */

export type InstantLang = "ko" | "en";
const EN: Record<string, string> = {
  "내 지갑 잔액": "My wallet balance",
  "쓸 수 있는 돈 {0}": "Spendable: {0}",
  "들어오는 중 {0} (확인되면 쓸 수 있어요)": "Incoming: {0} (spendable once confirmed)",
  "이 컴퓨터 지갑에서 방금 읽은 숫자예요.": "Just read from the wallet on this computer.",
  "잔액을 아직 못 읽었어요. 노드가 준비되면 지갑 화면에서 보여 드려요.": "I could not read the balance yet. The wallet page will show it once the node is ready.",
  "앱이 잠겨 있어 잔액을 보여 드리지 않았어요. 잠금을 풀고 지갑을 열어 주세요.": "The app is locked, so I did not show the balance. Unlock it and open the wallet.",
  "지갑 열기": "Open wallet",
  "오늘 매출": "Today's sales", "이번 주 매출": "This week's sales",
  "받은 금액 {0} · 판매 {1}건": "Received {0} · {1} sales",
  "통화가 섞였거나 못 읽은 줄이 있어 합계는 매출 화면에서 확인해 주세요.": "Currencies are mixed or some rows could not be read, so please check the total on the sales page.",
  "아직 입금되지 않은 주문 {0}건은 넣지 않았어요.": "{0} unpaid orders are not included.",
  "가게 장부를 읽지 못했어요. 매출 화면에서 다시 확인해 주세요.": "I could not read the shop ledger. Please check the sales page.",
  "아직 가게가 없어요. 가게를 열면 매출을 알려 드릴게요.": "You do not have a shop yet. Once you open one, I can tell you the sales.",
  "매출 보기": "View sales", "내 가게 열기": "Open my shop",
  "새 주문": "New orders",
  "주문표를 마지막으로 본 뒤 새 주문 {0}건": "{0} new orders since you last looked",
  "새 주문은 없어요.": "No new orders.",
  "입금 기다리는 주문 {0}건": "{0} orders waiting for payment",
  "주문 보기": "View orders",
  "안 읽은 쪽지": "Unread messages",
  "안 읽은 쪽지 대화 {0}개": "{0} conversations with unread messages",
  "이야기 방 새 글 {0}개": "{0} new posts in rooms",
  "안 읽은 쪽지는 없어요.": "No unread messages.",
  "쪽지는 이야기 화면을 한 번 열어야 확인할 수 있어요.": "Open the Talk page once and I can check messages.",
  "이야기 열기": "Open Talk",
  "받을 주소": "Receive address",
  "이 컴퓨터의 노드가 확인한 내 지갑 주소예요.": "Your wallet address, confirmed by this computer's node.",
  "주소 복사": "Copy address", "복사했어요.": "Copied.", "복사하지 못했어요. 받기 화면에서 복사해 주세요.": "Could not copy. Please copy it from the Receive page.",
  "받기 화면 열기": "Open Receive",
  "주소를 확인하지 못했어요. 받기 화면에서 다시 열어 주세요.": "I could not confirm the address. Please open the Receive page.",
  "주소를 준비하는 중…": "Preparing the address…",
  "보내기 준비": "Send, prepared",
  "보내기 화면을 열었어요.": "I opened the send page.",
  "받을 사람: {0} (내 받을 사람 목록)": "To: {0} (from your saved recipients)",
  "「{0}」은(는) 내 받을 사람 목록에 없어 주소 칸을 비워 뒀어요.": "\"{0}\" is not in your saved recipients, so the address is blank.",
  "받을 주소를 직접 넣어 주세요.": "Please enter the address yourself.",
  "금액: {0} RVN": "Amount: {0} RVN",
  "라비는 보내지 않아요. 주소·금액을 확인하고 직접 「검토」와 「보내기」를 눌러 주세요.": "Ravi never sends. Check the address and amount, then press Review and Send yourself.",
  "「{0}」 화면을 열었어요.": "Opened {0}.",
  "장터": "Market", "게임": "Games", "설정": "Settings", "백업": "Backup", "지갑": "Wallet", "자산": "Assets", "내 가게": "My shop", "홈": "Home",
  "이 화면은 판매자 기능을 켜야 볼 수 있어요.": "This page needs seller features turned on.",
  "아직 이 말은 잘 몰라요. 이런 건 바로 할 수 있어요:": "I don't know that one yet. I can do these right away:",
  "AI 키를 넣으면 자유롭게 대화할 수도 있어요.": "With an AI key, you can also talk freely.",
  "내 잔액": "My balance", "받기 주소": "Receive address", "오늘 매출?": "Today's sales", "새 쪽지": "New messages", "장터 열기": "Open market", "보내기": "Send",
};
const ASK_KO: Record<string, string> = { "내 잔액": "내 잔액 얼마야", "받기 주소": "받기 주소 보여 줘", "오늘 매출?": "오늘 매출 얼마야", "새 쪽지": "안 읽은 쪽지 있어?", "장터 열기": "장터 열어 줘", "보내기": "보내기 열어 줘" };
const ASK_EN: Record<string, string> = { "내 잔액": "my balance", "받기 주소": "show my receive address", "오늘 매출?": "today's sales", "새 쪽지": "unread messages", "장터 열기": "open market", "보내기": "open send" };

const escHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** 고정 문구를 고른 언어로, {0}… 채우고 escape. */
export function instantCopy(lang: InstantLang) {
  return (source: string, ...values: (string | number)[]) => {
    const text = lang === "en" ? EN[source] ?? source : source;
    return escHtml(text.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)] ?? "")));
  };
}
export const INSTANT_COPY_EN = EN;
export const instantLang = (q: string): InstantLang => /[가-힣ㄱ-ㅎ]/.test(q) ? "ko" : /[a-z]{2}/i.test(q) ? "en" : "ko";

/** 답 카드 틀 — 기존 대화 목록 안(.guide)에 그린다. 새 CSS 없음. */
export function instantCard(lang: InstantLang, kind: string, title: string, body: string, buttons = ""): string {
  return `<div data-ravi-language="${lang}" translate="no"><div class="guide" data-guide="instant-${escHtml(kind)}" data-answer-kind="instant">` +
    `<h4>${title}</h4>${body}${buttons ? `<div class="guidego">${buttons}</div>` : ""}</div></div>`;
}

/** 모르는 말 — 짧게, 바로 할 수 있는 일 5개(누르면 그 말로 다시 묻는다) + AI 키 한 줄(재촉 없이). */
export function instantFallbackHtml(q: string, hasShop: boolean): string {
  const lang = instantLang(q), c = instantCopy(lang), ask = lang === "en" ? ASK_EN : ASK_KO;
  const chips = ["내 잔액", "받기 주소", hasShop ? "오늘 매출?" : "보내기", "새 쪽지", "장터 열기"];
  return `<div data-ravi-language="${lang}" translate="no"><div class="guide" data-guide="miss" data-answer-kind="unsupported" data-instant-fallback="1">` +
    `<p>${c("아직 이 말은 잘 몰라요. 이런 건 바로 할 수 있어요:")}</p><div class="guidego">` +
    chips.map((k) => `<button type="button" class="ghost" data-ravi-ask="${escHtml(ask[k])}">${c(k)}</button>`).join("") +
    `</div><p class="guide-keyhint">${c("AI 키를 넣으면 자유롭게 대화할 수도 있어요.")}</p></div></div>`;
}

/** 이번 주 월요일(이 컴퓨터 시간) — yyyymmdd 숫자. */
export function weekStartYmd(now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
