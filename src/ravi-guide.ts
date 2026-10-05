/** Conservative, offline Ravi contract. UI copy, chips and AI actions share this data. */
import capabilities from "./ravi-capabilities.json";
export type GuideGo = "receive" | "send" | "wallet" | "txs" | "backup" | "create" | "assets" | "node" | "key" | "orders" | "sales" | "shop" | "reward" | "phone" | "talk" | "settings" | "report";
export type GuideTopic = {
  id: string; category: string; name: string; say: string; words: RegExp;
  lines: string[]; go: { label: string; to: GuideGo }[]; kind: string; starter: boolean;
};
export const GUIDE: GuideTopic[] = capabilities.guides.map(g => ({ ...g,
  words: new RegExp(g.words, "i"), go: g.go as GuideTopic["go"],
}));
export const RAVI_ACTIONS = capabilities.actions;
export const RAVI_SCREENS: Record<string, { page: string; tab?: string }> = capabilities.screens;
export const RAVI_CATEGORIES = capabilities.categories;
export const GUIDE_BADGE = "라비 안내 · AI 아님";
export const RAVI_GREETING = "키가 없어도 안내와 화면 열기를 도와드려요. 돈 보내기·결제·저장·발행은 직접 확인하고 승인해 주세요.";
const normalize = (s: string) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s?!？！.,·]/g, "");
export function isRaviHelp(q: string): boolean {
  return /^(뭘할수있어|무엇을할수있|뭐할수있|할수있는일|라비가할수있는일|도움말|도와줘|help|whatcanyoudo|何ができる|ヘルプ|你能做什么|帮助)/i.test(normalize(q));
}
/** A narrow typo dictionary, never fuzzy-match addresses or numbers. */
function question(q: string): string {
  return normalize(q).replace(/백엎/g, "백업").replace(/송굼/g, "송금").replace(/잔엑/g, "잔액").replace(/메뉴판/g, "메뉴");
}
export function matchGuide(q: string): GuideTopic | null {
  const text = question(q);
  if (!text) return null;
  // The exact localized help/chip phrases come from the same canonical entries.
  const exact = GUIDE.filter(g => [g.say, ...(capabilities.copy as Record<string, string[]>)[g.say] || []].some(s => question(s) === text));
  if (exact.length === 1) return exact[0];
  const matches = GUIDE.filter(g => g.words.test(text) || g.words.test(String(q).normalize("NFKC")));
  // Specific requests take precedence over broad nouns. Multiple unrelated requests abstain.
  const specific = matches.filter(g => !["send", "receive", "balance", "undo", "cert", "create", "key"].includes(g.id));
  if (specific.length > 1) return null;
  if (specific.length === 1) {
    const winner = specific[0];
    if (matches.some(g => g.id === "balance")) return null;
    if (matches.some(g => g.id === "send") && !["media", "market", "fee", "reward"].includes(winner.id)) return null;
    return winner;
  }
  if (matches.some(g => g.id === "fee")) return guideById("fee");
  if (matches.some(g => g.id === "seed")) return guideById("seed");
  if (matches.some(g => g.id === "undo")) return guideById("undo");
  if (matches.some(g => g.id === "assets")) return guideById("assets");
  return matches.length === 1 ? matches[0] : null;
}
export function guideById(id: string): GuideTopic | null { return GUIDE.find(g => g.id === id) ?? null; }
export function raviActionAllowed(type: unknown): boolean { return RAVI_ACTIONS.some(a => a.type === type); }
type Copy = (source: string) => string;
// copyHtml both translates and escapes user-visible values. Data attributes use stable ids only.
export function guideHtml(topic: GuideTopic, copyHtml: Copy): string {
  return `<div class="guide" data-guide="${topic.id}" data-answer-kind="${topic.kind}"><div class="guidebadge">${copyHtml(GUIDE_BADGE)}</div>` +
    topic.lines.map(line => `<p>${copyHtml(line)}</p>`).join("") +
    `<div class="guidego">` + topic.go.map(g => `<button type="button" class="ghost" data-guide-go="${g.to}">${copyHtml(g.label)}</button>`).join("") + `</div></div>`;
}
/** Alternatives are related suggestions, never automatic navigation. */
export function raviSuggestions(q: string): GuideTopic[] {
  const text = question(q);
  const category = /가게|주문|메뉴|매출|휴무|shop|order/.test(text) ? "shop" :
    /rvn|돈|지갑|입금|송금|wallet|coin/.test(text) ? "wallet" :
    /자산|증서|쿠폰|asset|certificate/.test(text) ? "assets" : "app";
  const ids = category === "shop" ? ["orders", "shop", "menu"] : category === "wallet" ? ["balance", "receive", "send"] :
    category === "assets" ? ["assets", "create", "cert"] : ["phone", "talk", "backup"];
  return ids.map(id => guideById(id)!);
}
export function guideMissHtml(copyHtml: Copy, q = ""): string {
  return `<div class="guide" data-guide="miss" data-answer-kind="unsupported"><div class="guidebadge">${copyHtml(GUIDE_BADGE)}</div>` +
    `<p>${copyHtml("이건 아직 못 해요. 대신 아래에서 할 수 있는 일을 골라 주세요.")}</p><div class="guidego">` +
    raviSuggestions(q).map(g => `<button type="button" class="ghost" data-ravi-input="${g.id}">${copyHtml(g.name)}</button>`).join("") + `</div></div>`;
}
export function raviHelpHtml(copyHtml: Copy): string {
  return `<div class="guide" data-guide="help"><div class="guidebadge">${copyHtml("라비가 할 수 있는 일")}</div><p>${copyHtml(RAVI_GREETING)}</p>` +
    Object.entries(RAVI_CATEGORIES).map(([category, name]) => `<section><h4>${copyHtml(name)}</h4><div class="guidego">` +
      GUIDE.filter(g => g.category === category).map(g => `<button type="button" class="ghost" data-ravi-input="${g.id}">${copyHtml(g.name)}</button>`).join("") + `</div></section>`).join("") +
    `<section><h4>${copyHtml("양식 초안·준비")}</h4><p>${copyHtml("일부 기능은 AI 키가 필요해요. 라비는 초안·준비만 도와드려요. 저장·승인은 해당 화면에서 직접 확인해 주세요.")}</p><div class="guidego">` +
    RAVI_ACTIONS.map(a => `<button type="button" class="ghost" data-ravi-action-input="${a.type}">${copyHtml(a.name)}</button>`).join("") + `</div></section></div>`;
}
export function raviStarterHtml(copyHtml: Copy): string {
  return GUIDE.filter(g => g.starter).map(g => `<button type="button" data-ravi-input="${g.id}" data-ravi-starter>${copyHtml(g.name)}</button>`).join("") +
    `<button type="button" data-ravi-help>${copyHtml("도움말")}</button>`;
}
/** Refuse pasted secrets before echoing or sending input; ordinary safety questions still work. */
export function containsRaviSecret(q: string): boolean {
  return /(?:sk-(?:ant-)?|xai-|gsk_|AIza)[a-z0-9_-]{12,}|\b(?:token|api[_ -]?key|private[_ -]?key)\s*[:=]\s*\S+|(?:시드|복구\s*단어|mnemonic|seed)\s*[:=]\s*\S+/i.test(q) ||
    q.trim().split(/\s+/).length >= 12 && /^(?:[a-z]+\s+){11,23}[a-z]+$/i.test(q.trim());
}
export function providerOfKey(key: string): string | null {
  const k = String(key ?? "").trim();
  if (/^sk-ant-/.test(k)) return "anthropic";
  if (/^xai-/.test(k)) return "xai";
  if (/^AIza/.test(k)) return "google";
  if (/^gsk_/.test(k)) return "groq";
  if (/^sk-/.test(k)) return "openai";
  return null;
}
