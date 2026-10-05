export type PromoLang = "ko" | "en" | "ja" | "zh";
export const PROMO_CHANNELS = ["x", "instagram", "kakao", "local"] as const;
export type PromoChannel = typeof PROMO_CHANNELS[number];
export type PromoDrafts = Record<PromoChannel, string>;
export interface PromoShop {
  name: string; description: string; currency: string; orderUrl: string;
  menu: { name: string; price: number }[];
  hours: { day: number; open: string; close: string }[];
}
const clean = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
export function promoShop(saved: any, language: PromoLang): PromoShop {
  let orderUrl = "";
  try {
    const u = new URL(saved?.order_url);
    if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password && u.href.length <= 500) orderUrl = u.href;
  } catch { /* No invented order link. */ }
  return {
    name: clean(saved?.[`name_${language}`] || saved?.name_ko || saved?.name, 100),
    description: clean(saved?.description, 400),
    currency: ["KRW", "USD", "JPY", "CNY", "EUR", "RVN"].includes(saved?.currency) ? saved.currency : "",
    orderUrl,
    menu: (Array.isArray(saved?.menu) ? saved.menu : []).slice(0, 100).flatMap((m: any) => {
      const name = clean(m?.name, 100), price = m?.price;
      return name && typeof price === "number" && Number.isFinite(price) && price > 0 ? [{ name, price }] : [];
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
  if (channel === "instagram") {
    let tags = 0;
    body = body.replace(/#[^\s#]+/g, tag => ++tags <= 5 ? tag : "").trim();
  }
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
export function templatePromo(shop: PromoShop, language: PromoLang): PromoDrafts {
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
    const next = [short, fact, shop.orderUrl].filter(Boolean).join("\n");
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
