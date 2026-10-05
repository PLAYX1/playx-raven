import appFacts from "./ravi-promo-facts.json";
export type PromoLang = "ko" | "en" | "ja" | "zh";
export const PROMO_CHANNELS = ["x", "instagram", "kakao", "local"] as const;
export type PromoChannel = typeof PROMO_CHANNELS[number];
export type PromoTarget = "shop" | "app" | "custom";
export const PROMO_TARGETS: PromoTarget[] = ["shop", "app", "custom"];
export const APP_PROMO_FACTS: Record<PromoLang, string[]> = appFacts;
export type PromoDrafts = Record<PromoChannel, string>;
export interface PromoShop {
  name: string; description: string; currency: string; orderUrl: string;
  pageUrl: string; category: string; location: string;
  menu: { name: string; price: number }[];
  hours: { day: number; open: string; close: string }[];
}
const clean = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
export function promoShop(saved: any, language: PromoLang): PromoShop {
  const orderUrl = safePromoUrl(saved?.order_url);
  const asset = clean(saved?.chain_asset, 100);
  const pageUrl = safePromoUrl(saved?.page_url || saved?.shop_url) || (asset ? `https://rvn.ex.erci.se/s/${encodeURIComponent(asset)}` : "");
  return {
    name: clean(saved?.[`name_${language}`] || saved?.name_ko || saved?.name, 100),
    description: clean(saved?.description, 400),
    currency: ["KRW", "USD", "JPY", "CNY", "EUR", "RVN"].includes(saved?.currency) ? saved.currency : "",
    orderUrl, pageUrl, category: clean(saved?.category || saved?.business_type, 100), location: clean(saved?.location, 100),
    menu: (Array.isArray(saved?.menu) ? saved.menu : []).slice(0, 100).flatMap((m: any) => {
      const name = clean(m?.name, 100), price = m?.price;
      return !isSampleMenu(m, saved) && name && typeof price === "number" && Number.isFinite(price) && price > 0 ? [{ name, price }] : [];
    }),
    hours: Object.entries(saved?.hours || {}).flatMap(([day, h]: [string, any]) =>
      /^[0-6]$/.test(day) && /^\d{2}:\d{2}$/.test(h?.open) && /^\d{2}:\d{2}$/.test(h?.close)
        ? [{ day: Number(day), open: h.open, close: h.close }] : []),
  };
}
// X weights CJK as two characters and public URLs as 23 (including short URLs).
export function promoLength(text: string, channel: PromoChannel): number {
  if (channel !== "x") return Array.from(text).length;
  return Array.from(text.replace(/https?:\/\/\S+/g, "\u0000")).reduce((n, c) => n + (c === "\u0000" ? 23 : c.codePointAt(0)! > 0x10ff ? 2 : 1), 0);
}
export const PROMO_LIMITS = { x: 280, instagram: 2200, kakao: 1000, local: 2000 };
export function limitPromo(text: string, channel: PromoChannel, orderUrl: string): string {
  let body = text.replace(/https?:\/\/\S+/g, "").trim();
  if (channel === "kakao") {
    const lines = body.split(/\n+/).filter(Boolean);
    body = orderUrl ? [lines[0] || "", lines.slice(1).join(" · ")].join("\n")
      : [lines[0] || "", lines[1] || "", lines.slice(2).join(" · ")].join("\n");
  }
  const suffix = orderUrl ? `\n${orderUrl}` : "";
  const chars = Array.from(body);
  while (chars.length && promoLength(chars.join("") + suffix, channel) > PROMO_LIMITS[channel]) chars.pop();
  const result = (channel === "kakao" ? chars.join("") : chars.join("").trimEnd()) + suffix;
  return channel === "kakao" ? result.split("\n").slice(0, 3).concat(Array(Math.max(0, 3 - result.split("\n").length)).fill("")).join("\n") : result;
}
function templateShopPromo(shop: PromoShop, language: PromoLang): PromoDrafts {
  const labels = {
    ko: { hello: "이웃 여러분, 들러 주세요!", menu: "메뉴", hours: "영업시간", days: ["일", "월", "화", "수", "목", "금", "토"], tag: "#동네가게" },
    en: { hello: "Hello neighbours, come visit!", menu: "Menu", hours: "Hours", days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], tag: "#LocalShop" },
    ja: { hello: "ご近所のみなさん、お立ち寄りください！", menu: "メニュー", hours: "営業時間", days: ["日", "月", "火", "水", "木", "金", "土"], tag: "#近所のお店" },
    zh: { hello: "邻居们，欢迎来看看！", menu: "菜单", hours: "营业时间", days: ["日", "一", "二", "三", "四", "五", "六"], tag: "#社区小店" },
  }[language];
  const prices = shop.menu.slice(0, 3).map(m => `${m.name} ${m.price.toLocaleString("en-US", { maximumFractionDigits: 8 })}${shop.currency === "KRW" ? "원" : shop.currency ? ` ${shop.currency}` : ""}`).join(" · ");
  const hours = shop.hours.map(h => `${labels.days[h.day]} ${h.open}–${h.close}`).join(" · ");
  const lines = [shop.name, shop.description, prices && `${labels.menu}: ${prices}`, hours && `${labels.hours}: ${hours}`].filter(Boolean);
  // For the short channel, add whole facts only: never cut a name or price in half.
  let short = "";
  for (const fact of lines) {
    const next = combinePromo([short, fact, shop.orderUrl || shop.pageUrl].filter(Boolean).join("\n"), promoHashtags(shop, "shop", language, "x"));
    if (promoLength(next, "x") <= 280) short = [short, fact].filter(Boolean).join("\n");
  }
  return {
    x: limitPromo(short, "x", shop.orderUrl),
    instagram: limitPromo([...lines, labels.tag].join("\n"), "instagram", shop.orderUrl),
    kakao: limitPromo([shop.name, [shop.description, prices, hours].filter(Boolean).join(" · ")].filter(Boolean).join("\n"), "kakao", shop.orderUrl),
    local: limitPromo([labels.hello, ...lines].join("\n"), "local", shop.orderUrl),
  };
}
export function promoPriceWarnings(text: string, shop: PromoShop): string[] {
  const warnings: string[] = [];
  const body = text.replace(/https?:\/\/\S+/g, "");
  const currency = { KRW: "KRW", USD: "USD", JPY: "JPY", CNY: "CNY", EUR: "EUR", RVN: "RVN", "원": "KRW", "ウォン": "KRW", "円": "JPY", "元": "CNY", "달러": "USD", "₩": "KRW", "$": "USD", "¥": shop.currency === "CNY" ? "CNY" : "JPY", "€": "EUR" } as Record<string, string>;
  const pattern = /([₩$¥€])\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)(\s*)(원|ウォン|円|元|달러|KRW|USD|JPY|CNY|EUR|RVN)/gi;
  for (const match of body.matchAll(pattern)) {
    const price = Number((match[2] || match[3]).replace(/,/g, ""));
    const unit = currency[match[1] || match[5].toUpperCase()] || "";
    const before = body.slice(Math.max(0, match.index! - 120), match.index).split(/[\n·]/).pop() || "";
    const named = shop.menu.filter(m => before.includes(m.name)).sort((a, b) => before.lastIndexOf(b.name) - before.lastIndexOf(a.name));
    const candidates = named.length ? [named[0]] : shop.menu;
    if (unit !== shop.currency || !candidates.some(m => Math.abs(m.price - price) < 1e-9)) warnings.push(match[0].trim());
  }
  // Also check unitless prices next to known item names, while ignoring times and quantities.
  for (const line of body.split(/[\n·]/)) {
    for (const item of shop.menu) {
      const index = line.lastIndexOf(item.name);
      if (index < 0) continue;
      const tail = line.slice(index + item.name.length);
      const naked = /^\s*[:：-]?\s*(\d[\d,]*(?:\.\d+)?)(?=\s*(?:$|[.!。]))/.exec(tail);
      if (naked && Math.abs(Number(naked[1].replace(/,/g, "")) - item.price) >= 1e-9) warnings.push(naked[1]);
    }
  }
  return [...new Set(warnings)];
}
export function isPromoRequest(text: string): boolean {
  return /홍보|특가.*(알려|글|만들)|(?:promot|advertis|social post)|宣伝|宣传/i.test(text);
}

export function safePromoUrl(value: unknown): string {
  try {
    const u = new URL(typeof value === "string" ? value : "");
    if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password && u.href.length <= 500) return u.href;
  } catch { /* Unknown public URL. */ }
  return "";
}
export function isSampleMenu(menu: any, saved: any = {}): boolean {
  const name = clean(menu?.name, 100);
  const demoImages = ["Qmd23gcQWAZTKZrstpnXTPyUo4VsbtVL5bcuXmks4JQuCC", "QmbibWRDaWKyJKQPKjAr7N83ckz3eAyU34vKdWss1eUQF6", "QmZ7vS5KRg9AT3ZkBMCo6TH8AV8gLauokonW3PbMuv1XHd"];
  return /^(샘플|sample|예시)/i.test(name) || menu?.sample === true || menu?.is_sample === true || menu?.example === true
    || saved?.sample === true || saved?.is_sample === true || demoImages.includes(menu?.image);
}
export function inferPromoTarget(request: string): PromoTarget {
  if (/레이븐볼트|raven\s*vault|이\s*앱|프로그램|지갑|this app|wallet|ウォレット|このアプリ|钱包|这个应用/i.test(request)) return "app";
  if (!request.trim() || /가게|메뉴|오늘\s*특가|shop|menu|today.?s special|店舗|お店|メニュー|店铺|菜单/i.test(request)) return "shop";
  return "custom";
}
export function appPromoUrl(language: PromoLang): string {
  return `https://ravenvault.ex.erci.se${language === "ko" ? "" : `/${language}/`}`;
}
export function promoImageUrl(shop: PromoShop, target: PromoTarget, language: PromoLang): string {
  return shop.orderUrl || (target === "shop" ? shop.pageUrl : appPromoUrl(language));
}
export const APP_TAGLINES: Record<PromoLang, string> = {
  ko: "레이븐코인으로 장사하는 지갑", en: "A wallet for doing business with Ravencoin",
  ja: "レイヴンコインで商売するウォレット", zh: "用渡鸦币做生意的钱包",
};
export function promoTagline(shop: PromoShop, target: PromoTarget, language: PromoLang, request: string): string {
  return (target === "app" ? APP_TAGLINES[language] : target === "custom" ? request : shop.description || shop.menu[0]?.name || shop.name).slice(0, 120);
}
export const HASHTAG_LIMITS = { x: [2, 4], instagram: [8, 15], kakao: [0, 3], local: [2, 4] } as const;
export function normalizeHashtags(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : value.split(/[\s#]+/u);
  const seen = new Set<string>();
  return parts.flatMap(part => {
    const tag = Array.from(part.normalize("NFKC").replace(/[^\p{L}\p{N}_]/gu, "")).slice(0, 60).join(""), key = tag.toLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key); return [`#${tag}`];
  });
}
export function promoHashtags(shop: PromoShop, target: PromoTarget, language: PromoLang, channel: PromoChannel): string {
  const metadata = target === "shop" ? [shop.name, shop.category, shop.location].filter(Boolean) : [];
  const local = language === "ja" ? ["レイヴンコイン", "ウォレット"] : language === "zh" ? ["渡鸦币", "钱包"] : [];
  // English is already included; English selection also adds an English topic tag.
  const languageTags = language === "en" ? [target === "shop" ? "LocalShop" : "CryptoWallet"] : local;
  const max = HASHTAG_LIMITS[channel][1];
  const shortMetadata = metadata.map(part => Array.from(part).slice(0, 18).join("")).join("");
  const candidates = channel === "instagram"
    ? ["레이븐코인", "Ravencoin", "레이븐볼트", "RavenVault", ...metadata, ...languageTags, "코인결제", "RVN", "QR주문", "QRorder", "비수탁", "NonCustodial", "CryptoPayment"]
    : [languageTags.length && metadata.length ? `레이븐코인${shortMetadata}` : "레이븐코인", "Ravencoin", ...(!languageTags.length && metadata.length ? [shortMetadata] : []), ...languageTags.slice(0, 1), "RavenVault"];
  return normalizeHashtags(candidates).slice(0, max).join(" ");
}
export function combinePromo(body: string, hashtags: string): string {
  return [body.trim(), normalizeHashtags(hashtags).join(" ")].filter(Boolean).join("\n");
}
export function preparePromo(text: string, channel: PromoChannel, shop: PromoShop, target: PromoTarget, language: PromoLang): { body: string; hashtags: string } {
  const hashtags = promoHashtags(shop, target, language, channel);
  const url = target === "shop" ? shop.orderUrl || shop.pageUrl : appPromoUrl(language);
  let body = limitPromo(text.replace(/#[^\s#]+/g, ""), channel, url).trim();
  // Reserve the tags and URL before clipping the body. Never clip either of them.
  if (promoLength(combinePromo(body, hashtags), channel) > PROMO_LIMITS[channel]) {
    const content = Array.from(body.replace(/https?:\/\/\S+/g, "").trim());
    while (content.length && promoLength(combinePromo([content.join("").trim(), url].filter(Boolean).join("\n"), hashtags), channel) > PROMO_LIMITS[channel]) content.pop();
    body = [content.join("").trim(), url].filter(Boolean).join("\n");
  }
  return { body, hashtags };
}
export function templatePromo(shop: PromoShop, language: PromoLang, target: PromoTarget = "shop", request = ""): PromoDrafts {
  let raw: PromoDrafts;
  if (target === "app") {
    const facts = APP_PROMO_FACTS[language];
    raw = { x: `RavenVault · ${APP_TAGLINES[language]}\n${facts[1]}\n${facts[8]}`, instagram: `RavenVault\n${facts.join("\n")}`, kakao: `RavenVault\n${facts[1]} ${facts[8]}`, local: `RavenVault\n${facts.join("\n")}` };
  } else if (target === "custom") {
    raw = Object.fromEntries(PROMO_CHANNELS.map(c => [c, request])) as PromoDrafts;
  } else if (!shop.menu.length) {
    const notice = { ko: "메뉴를 먼저 등록하세요", en: "Register your menu first", ja: "先にメニューを登録してください", zh: "请先登记菜单" }[language];
    raw = Object.fromEntries(PROMO_CHANNELS.map(c => [c, notice])) as PromoDrafts;
  } else raw = templateShopPromo(shop, language);
  return Object.fromEntries(PROMO_CHANNELS.map(c => { const p = preparePromo(raw[c], c, shop, target, language); return [c, combinePromo(p.body, p.hashtags)]; })) as PromoDrafts;
}
export function promoFactWarnings(text: string): string[] {
  const body = text.replace(/https?:\/\/\S+/g, "").replace(/#[^\s#]+/g, "").replace(/(?:4개?\s*언어|four languages|4 languages|4言語|4种语言)/gi, "");
  const numbers = body.match(/\d+(?:[.,]\d+)*(?:\s*[%％])?/g) || [];
  const warnings = numbers.filter(n => !/^1\s*[%％]$/.test(n));
  if (/수익\s*(보장|약속)|가격\s*(상승|전망)|guaranteed\s*(profit|return)|price\s*(forecast|prediction)|利益保証|価格予測|保证收益|价格预测/i.test(body)) warnings.push("claims");
  return [...new Set(warnings)];
}
