/* 라비 대화의 정해 둔 답 — AI 열쇠가 있든 없든 같은 답을 낸다.
 *
 * ## 🔴 왜 생겼나 (2026-10-11)
 *
 * 대표가 「380만개면 부자순위 몇위야?」를 두 번, 「돈 보내줘」를 한 번 물었는데 답이 **하나도** 없었다.
 * 질문은 정보 선택 카드에서 멈췄고(저장하지 않으면 버렸다), 그 사이 친 질문은 조용히 무시됐다.
 *
 * 여기 있는 것은 AI 에게 맡기면 안 되는 답이다.
 *  · 송금 부탁 — 라비는 대신 보내지 않는다. 보내기 화면으로 데려가고 안전 요령만 말한다.
 *  · 부자 순위 — 공개된 순위표가 없으면 **모른다고** 말한다. 시세는 사용자가 말한 값으로만 계산한다.
 *  · 주소 잔액 — 사용자가 적은 주소 **하나만** 공개 조회처에 묻고, 묻기 전에 알린다(단추를 눌러야 묻는다).
 *
 * 문구는 질문 언어로 낸다(ravi-capabilities.json 의 copy 표, 한국어 원문이 열쇠).
 */
import { GUIDE, guideById, guideHtml, raviCopy, raviQuestionLanguage } from "./ravi-guide";
import { normalizeRavi, type RaviLanguage } from "./ravi-intents";
import { findRavenAddress } from "./whose";

type Copy = (source: string) => string;
const fill = (template: string, ...values: string[]) => template.replace(/\{(\d+)\}/g, (_, i) => values[Number(i)] ?? "");
const wrap = (language: RaviLanguage, html: string) => `<div data-ravi-language="${language}" translate="no">${html}</div>`;
const LOCALE: Record<RaviLanguage, string> = { ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN" };


/** 이 파일의 질문 언어 답 문구 — [영어, 일본어, 중국어]. ravi-guide 번들(용량 상한 30KB)에 싣지 않으려고 여기 둔다. */
const COPY: Record<string, [string, string, string]> = {
  "공개된 부자 순위표를 찾지 못해 정확한 순위는 몰라요. 지어내지 않을게요.": ["I could not find a public rich list, so I do not know the exact rank. I will not make one up.", "公開された保有者ランキングが見つからないため、正確な順位は分かりません。作り話はしません。", "我没有找到公开的持币排行榜，所以不知道准确排名。我不会编造。"],
  "말씀하신 시세(1 RVN = {0})로 계산하면 {1} RVN은 약 {2}이에요.": ["At the price you gave (1 RVN = {0}), {1} RVN is about {2}.", "おっしゃった相場（1 RVN = {0}）で計算すると、{1} RVN は約 {2} です。", "按您给的价格（1 RVN = {0}）计算，{1} RVN 约为 {2}。"],
  "{0} RVN의 돈 가치는 시세를 알아야 계산할 수 있어요. 시세를 알려 주시면(예: 「1 RVN이 ○○원이면?」) 그 값으로 계산해 드려요.": ["I need a price to work out what {0} RVN is worth. Tell me a price (for example, \"if 1 RVN is ○○ KRW?\") and I will calculate with it.", "{0} RVN の金額は相場が分からないと計算できません。相場を教えていただければ（例：「1 RVN が○○ウォンなら？」）その値で計算します。", "要知道 {0} RVN 值多少钱，需要先有价格。告诉我一个价格（例如“如果 1 RVN 是○○韩元？”），我就按这个价格计算。"],
  "어느 주소에 얼마가 있는지는 공개 블록 탐색기에서 볼 수 있어요. 주소를 적고 「이 주소 잔액」이라고 물으시면 그 주소만 공개 조회처에 물어봐 드려요.": ["You can see how much an address holds on a public block explorer. Write the address and ask for \"this address balance\", and I will ask the public lookup about that address only.", "どのアドレスにいくらあるかは公開ブロックエクスプローラーで見られます。アドレスを書いて「このアドレスの残高」と聞いていただければ、そのアドレスだけを公開照会先に問い合わせます。", "某个地址里有多少，可以在公开区块浏览器中查看。写下地址并问“这个地址的余额”，我只会把这个地址发给公开查询服务。"],
  "AI 열쇠를 넣으면 더 잘 답해요.": ["Add an AI key and I can answer better.", "AIキーを入れると、もっと上手に答えられます。", "添加 AI 密钥后，我能回答得更好。"],
  "이 주소의 잔액을 공개 조회처(blockbook.ravencoin.org)에 물어볼까요?": ["Shall I ask the public lookup (blockbook.ravencoin.org) for this address's balance?", "このアドレスの残高を公開照会先（blockbook.ravencoin.org）に問い合わせますか？", "要向公开查询服务（blockbook.ravencoin.org）查询这个地址的余额吗？"],
  "보내는 것은 적어 주신 이 주소 하나뿐이에요. 내 지갑 주소 목록·주문 메모·고객 이름은 보내지 않아요.": ["Only this one address you wrote is sent. Your wallet address list, order notes and customer names are not sent.", "送るのは書いていただいたこのアドレス1つだけです。ウォレットのアドレス一覧・注文メモ・お客様の名前は送りません。", "只会发送您写下的这一个地址。不会发送您的钱包地址列表、订单备注或顾客姓名。"],
  "공개 조회하기": ["Look it up publicly", "公開照会する", "公开查询"],
  "공개 조회 결과: {0} RVN": ["Public lookup result: {0} RVN", "公開照会の結果: {0} RVN", "公开查询结果：{0} RVN"],
  "자산(회원권·쿠폰 등)은 이 조회로는 못 봐요. 공개 서버의 답이라 틀릴 수도 있어요.": ["Assets (memberships, coupons and so on) are not visible in this lookup. This is a public server's answer and may be wrong.", "資産（会員権・クーポンなど）はこの照会では見られません。公開サーバーの答えなので、間違っていることもあります。", "此查询看不到资产（会员卡、优惠券等）。这是公开服务器的回答，可能有误。"],
  "공개 조회처가 이 주소의 잔액을 주지 않았어요.": ["The public lookup did not return a balance for this address.", "公開照会先はこのアドレスの残高を返しませんでした。", "公开查询服务没有返回这个地址的余额。"],
  "공개 조회 · blockbook.ravencoin.org": ["Public lookup · blockbook.ravencoin.org", "公開照会 · blockbook.ravencoin.org", "公开查询 · blockbook.ravencoin.org"],
};
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** 고정 문구 → 질문 언어(없으면 라비 공용 표). 번역이 빠지면 시험이 잡도록 던진다. */
function chatCopy(language: RaviLanguage): Copy {
  const shared = raviCopy(language);
  return source => {
    if (!Object.prototype.hasOwnProperty.call(COPY, source)) return shared(source);
    return esc(language === "ko" ? source : COPY[source][["en", "ja", "zh"].indexOf(language)]);
  };
}
/** 시험용 — 이 파일의 번역 표. */
export const RAVI_PUBLIC_COPY = COPY;

/* ── 송금 부탁 ───────────────────────────────────────────────────────────── */

const SEND_WORDS = (() => { const g = GUIDE.find(x => x.id === "send"); return g ? g.words : /(?!)/; })();

/** 「돈 보내줘」「친구한테 5 RVN 보내줘」 — 보내기 안내로 답할 말인가. */
export function isRaviSendRequest(q: string): boolean {
  return SEND_WORDS.test(normalizeRavi(q));
}

/** 주소와 「숫자 RVN」을 둘 다 적은 직접 지시 — 이것만 기존 「보내기 확인 화면 준비」(사람이 마지막에 누름)로 간다. */
export function isExplicitSendOrder(q: string): boolean {
  return !!findRavenAddress(q) && /\d(?:[\d,]*)(?:\.\d+)?\s*rvn\b/i.test(q);
}

/** 송금 부탁에 대한 답 — 대신 보내지 않는다는 말 + 안전 요령 + 「보내기 열기」 단추(기존 data-guide-go 이동). */
export function raviSendAnswerHtml(q: string, fallback: RaviLanguage = "ko"): string {
  const language = raviQuestionLanguage(q, fallback);
  const topic = guideById("send");
  return wrap(language, topic ? guideHtml(topic, raviCopy(language)) : "");
}

/* ── 부자 순위·가치 환산 ─────────────────────────────────────────────────── */

const RANK_WORDS = /부자순위|부자랭킹|부자몇|리치리스트|rich-?list|몇(?:위|등)|순위|랭킹|ranking|rank|whatplace|top\d+%|상위몇|ランキング|何位|順位|長者番付|富豪|排名|第几/;
const NUM = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)";
const UNIT: Record<string, number> = { "천": 1e3, "千": 1e3, "만": 1e4, "万": 1e4, "萬": 1e4, "억": 1e8, "億": 1e8, "亿": 1e8, k: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const CURRENCY: [RegExp, string][] = [[/^(?:원|krw|₩|ウォン|韩元)$/i, "KRW"], [/^(?:달러|usd|\$|ドル|美元|dollars?)$/i, "USD"], [/^(?:円|엔|jpy|日元)$/i, "JPY"], [/^(?:元|위안|cny|人民币)$/i, "CNY"]];
const CUR = "(원|krw|₩|ウォン|韩元|달러|usd|ドル|美元|dollars?|円|엔|jpy|日元|元|위안|cny|人民币)";
const currencyOf = (s: string) => CURRENCY.find(([re]) => re.test(s))?.[1] ?? null;
const num = (s: string) => Number(s.replace(/,/g, ""));

export type RichQuestion = { amount: number; price: { value: number; currency: string } | null };

/** 사용자가 **직접 적은** 시세 하나. 없으면 null — 시세를 짐작하지 않는다. */
export function userStatedPrice(q: string): { value: number; currency: string; match: string } | null {
  const text = String(q ?? "").normalize("NFKC");
  const patterns = [
    // 1 RVN = 30원 · 개당 30원 · 시세 30원 · RVN당 $0.02 · per RVN $0.02
    new RegExp(`(?:1\\s*(?:rvn|개|코인|個|个|枚)|개당|rvn\\s*당|per\\s*rvn|each|시세|価格|单价|単価|价格)\\s*(?:=|:|은|는|이|가|에|이면|면|が|は)?\\s*(\\$|₩)?\\s*${NUM}\\s*${CUR}?`, "i"),
    // $0.02 per RVN · 30원씩 · 0.02달러/RVN
    new RegExp(`(\\$|₩)?\\s*${NUM}\\s*${CUR}?\\s*(?:per\\s*rvn|each|씩|/\\s*rvn)`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const currency = currencyOf(m[1] || m[3] || "");
    const value = num(m[2]);
    if (currency && Number.isFinite(value) && value > 0) return { value, currency, match: m[0] };
  }
  return null;
}

/** 「380만개면 부자순위 몇위야?」 — 순위를 묻고 개수를 적은 질문. 아니면 null. */
export function parseRichQuestion(q: string): RichQuestion | null {
  const text = String(q ?? "").normalize("NFKC");
  if (!RANK_WORDS.test(normalizeRavi(text))) return null;
  const price = userStatedPrice(text);
  const rest = price ? text.replace(price.match, " ") : text;
  const re = new RegExp(`${NUM}\\s*(천|千|만|万|萬|억|億|亿|million|billion|mil|k|m|b)?\\s*(개|個|个|枚|rvn|코인|coins?)?`, "gi");
  for (const m of rest.matchAll(re)) {
    const unit = m[2] ? UNIT[m[2].toLowerCase()] ?? UNIT[m[2]] : 1;
    if (!m[2] && !m[3]) continue; // 단위도 「개·RVN」도 없는 숫자(「몇 위」의 숫자 등)는 개수가 아니다
    const amount = num(m[1]) * unit;
    if (Number.isFinite(amount) && amount > 0 && amount <= 21e9) return { amount, price: price ? { value: price.value, currency: price.currency } : null };
  }
  return null;
}

const CURRENCY_NAME: Record<RaviLanguage, Record<string, string>> = {
  ko: { KRW: "원", USD: "달러", JPY: "엔", CNY: "위안" },
  en: { KRW: " KRW", USD: " USD", JPY: " JPY", CNY: " CNY" },
  ja: { KRW: "ウォン", USD: "ドル", JPY: "円", CNY: "元" },
  zh: { KRW: "韩元", USD: "美元", JPY: "日元", CNY: "元" },
};

/** 부자 순위 질문의 정직한 답. 순위표가 없으니 모른다고 하고, 말한 시세가 있을 때만 환산한다. */
export function raviRichAnswerHtml(q: string, rich: RichQuestion, fallback: RaviLanguage = "ko", keyed = true): string {
  const language = raviQuestionLanguage(q, fallback), copy = chatCopy(language);
  const n = (v: number) => v.toLocaleString(LOCALE[language], { maximumFractionDigits: 8 });
  const lines = [copy("공개된 부자 순위표를 찾지 못해 정확한 순위는 몰라요. 지어내지 않을게요.")];
  if (rich.price) {
    const unit = CURRENCY_NAME[language][rich.price.currency] ?? ` ${rich.price.currency}`;
    lines.push(fill(copy("말씀하신 시세(1 RVN = {0})로 계산하면 {1} RVN은 약 {2}이에요."),
      `${n(rich.price.value)}${unit}`, n(rich.amount), `${n(Math.round(rich.amount * rich.price.value * 100) / 100)}${unit}`));
  } else {
    lines.push(fill(copy("{0} RVN의 돈 가치는 시세를 알아야 계산할 수 있어요. 시세를 알려 주시면(예: 「1 RVN이 ○○원이면?」) 그 값으로 계산해 드려요."), n(rich.amount)));
  }
  lines.push(copy("어느 주소에 얼마가 있는지는 공개 블록 탐색기에서 볼 수 있어요. 주소를 적고 「이 주소 잔액」이라고 물으시면 그 주소만 공개 조회처에 물어봐 드려요."));
  if (!keyed) lines.push(copy("AI 열쇠를 넣으면 더 잘 답해요."));
  return wrap(language, `<div class="guide" data-guide="richlist" data-answer-kind="public"><div class="guidebadge">${copy("라비 안내 · AI 아님")}</div>` +
    lines.map(l => `<p>${l}</p>`).join("") + `</div>`);
}

/* ── 주소 잔액 공개 조회 ─────────────────────────────────────────────────── */

const BALANCE_WORDS = /잔액|잔고|얼마|몇개|balance|howmuch|holding|残高|いくら|余额|多少/;

/** 「R… 잔액 얼마야?」 — 사용자가 적은 주소 하나. 송금 부탁이면 null(그건 송금 안내로 간다). */
export function publicAddressQuestion(q: string): string | null {
  const address = findRavenAddress(q);
  if (!address || isRaviSendRequest(q)) return null;
  return BALANCE_WORDS.test(normalizeRavi(q.replace(address, " "))) ? address : null;
}

/** 묻기 전에 알린다 — 무엇이 어디로 가는지. 단추를 눌러야 묻는다. */
export function raviPublicOfferHtml(q: string, address: string, fallback: RaviLanguage = "ko"): string {
  const language = raviQuestionLanguage(q, fallback), copy = chatCopy(language);
  const safe = /^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(address) ? address : "";
  return wrap(language, `<div class="guide" data-guide="public-address" data-answer-kind="public"><div class="guidebadge">${copy("라비 안내 · AI 아님")}</div>` +
    `<p>${copy("이 주소의 잔액을 공개 조회처(blockbook.ravencoin.org)에 물어볼까요?")}</p>` +
    `<p>${copy("보내는 것은 적어 주신 이 주소 하나뿐이에요. 내 지갑 주소 목록·주문 메모·고객 이름은 보내지 않아요.")}</p>` +
    `<div class="guidego"><button type="button" class="ghost" data-ravi-public="${safe}">${copy("공개 조회하기")}</button></div></div>`);
}

export type PublicAddress = { status: string; rvn?: number; assets_unknown?: boolean; source?: string };
export function raviPublicResultHtml(result: PublicAddress | null, language: RaviLanguage = "ko"): string {
  const copy = chatCopy(language);
  const ok = result?.status === "ok" && typeof result.rvn === "number" && Number.isFinite(result.rvn);
  const body = ok
    ? `<p>${fill(copy("공개 조회 결과: {0} RVN"), result!.rvn!.toLocaleString(LOCALE[language], { maximumFractionDigits: 8 }))}</p>` +
      `<p>${copy("자산(회원권·쿠폰 등)은 이 조회로는 못 봐요. 공개 서버의 답이라 틀릴 수도 있어요.")}</p>`
    : `<p>${copy("공개 조회처가 이 주소의 잔액을 주지 않았어요.")}</p>`;
  return wrap(language, `<div class="guide" data-guide="public-result" data-answer-kind="public"><div class="guidebadge">${copy("공개 조회 · blockbook.ravencoin.org")}</div>${body}</div>`);
}

/** 열쇠 없이 「모르겠어요」로 끝나는 답 아래 한 줄. */
export function raviKeyHintHtml(q: string, fallback: RaviLanguage = "ko"): string {
  const language = raviQuestionLanguage(q, fallback);
  return wrap(language, `<p class="guide-keyhint">${chatCopy(language)("AI 열쇠를 넣으면 더 잘 답해요.")}</p>`);
}

export type { Copy as RaviChatCopy };

/* ── 열쇠를 넣은 뒤 (2026-10-11 대표 확정: 사용자가 자기 열쇠를 넣는 방식 · 넣으면 반드시 작동) ── */

/** ravi_agent.rs 의 고정 실패 문구와 글자 하나까지 같다(check-ravi-chat-flow 가 대조한다). */
export const AI_KEY_REJECTED = "AI 열쇠가 맞지 않아요. 열쇠를 다시 넣어 주세요. 실행한 송금은 없어요.";
export const AI_BUSY = "AI 사용 한도에 걸렸거나 AI가 바빠요. 잠시 뒤 다시 물어봐 주세요. 실행한 송금은 없어요.";
export const AI_OFFLINE = "AI에 연결하지 못했어요. 인터넷을 확인하고 잠시 뒤 다시 물어봐 주세요. 실행한 송금은 없어요.";
/** 저장 직후 「한 번 물어볼까요?」 — 내 정보가 하나도 없는 질문. */
export const RAVI_TEST_QUESTION = "레이븐코인은 어떤 코인이야?";

const attr = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 실패 뒤 다음 행동 단추 — 열쇠가 틀렸으면 「열쇠 다시 넣기」, 바쁘거나 끊겼으면 「다시 묻기」. 그 밖엔 "". */
export function raviFailureNextHtml(message: string, q: string, copy: Copy): string {
  if (message === AI_KEY_REJECTED) return `<div class="guidego"><button type="button" class="ghost" data-guide-go="key">${copy("열쇠 다시 넣기")}</button></div>`;
  if (message === AI_BUSY || message === AI_OFFLINE) return `<div class="guidego"><button type="button" class="ghost" data-ravi-ask="${attr(q.slice(0, 500))}">${copy("다시 묻기")}</button></div>`;
  return "";
}

/** 연결 확인이 끝난 뒤 한 줄 + 개인정보 없는 시험 질문 단추. */
export function raviConnectedHtml(copy: Copy): string {
  return `<p>${copy("연결됐어요 · 한 번 물어볼까요?")}</p><div class="guidego"><button type="button" class="ghost" data-ravi-ask="${attr(RAVI_TEST_QUESTION)}">${copy(RAVI_TEST_QUESTION)}</button></div>`;
}
