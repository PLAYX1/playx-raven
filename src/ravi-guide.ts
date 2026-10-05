/** Conservative, offline Ravi contract. UI copy, chips and AI actions share this data. */
import capabilities from "./ravi-capabilities.json";
import { normalizeRavi, raviIntentIds, raviHelpIntent, raviQuestionLanguage, type RaviLanguage } from "./ravi-intents";
export { raviQuestionLanguage } from "./ravi-intents";
export type GuideGo = "receive" | "send" | "wallet" | "txs" | "backup" | "create" | "assets" | "node" | "key" | "orders" | "sales" | "shop" | "reward" | "phone" | "talk" | "settings" | "report" | "qr";
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
export const isRaviHelp = raviHelpIntent;
export function raviCandidates(q: string): GuideTopic[] {
  const text = normalizeRavi(q);
  if (!text) return [];
  const exact = GUIDE.filter(g => [g.say, ...(capabilities.copy as Record<string, string[]>)[g.say] || []].some(s => normalizeRavi(s) === text));
  if (exact.length === 1) return exact;
  return raviIntentIds(q).map(id => guideById(id)).filter((g): g is GuideTopic => !!g);
}
export function matchGuide(q: string): GuideTopic | null {
  const candidates = raviCandidates(q);
  return candidates.length === 1 ? candidates[0] : null;
}
/** Fixed-language chat copy must not be repainted by the global UI translator. */
export function raviText(source: string, language: RaviLanguage): string {
  const text = language === "ko" ? source : (capabilities.copy as Record<string, string[]>)[source]?.[["en", "ja", "zh"].indexOf(language)];
  if (text === undefined) throw new Error(`Missing Ravi translation: ${language}`);
  return String(text);
}
export function raviCopy(language: RaviLanguage): Copy {
  return source => raviText(source, language).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));
}
export function raviAnswerHtml(q: string, fallback: RaviLanguage = "ko"): string {
  const language = raviQuestionLanguage(q, fallback), copy = raviCopy(language);
  const candidates = raviCandidates(q);
  const html = isRaviHelp(q) ? raviHelpHtml(copy) : candidates.length === 1 ? guideHtml(candidates[0], copy) :
    candidates.length > 1 ? guideChoicesHtml(candidates, copy) : guideMissHtml(copy, q);
  return `<div data-ravi-language="${language}" translate="no">${html}</div>`;
}
export function guideChoicesHtml(candidates: GuideTopic[], copy: Copy): string {
  return `<div class="guide" data-guide="clarify" data-answer-kind="clarify"><div class="guidebadge">${copy("혹시 이거요? 아래 두 가지 중 골라 주세요.")}</div><div class="guidego">` +
    candidates.slice(0, 2).map(g => `<button type="button" class="ghost" data-ravi-input="${g.id}">${copy(g.name)}</button>`).join("") + `</div></div>`;
}
export function guideById(id: string): GuideTopic | null { return GUIDE.find(g => g.id === id) ?? null; }
export function raviActionAllowed(type: unknown): boolean { return RAVI_ACTIONS.some(a => a.type === type); }
type Copy = (source: string) => string;
// copyHtml both translates and escapes user-visible values. Data attributes use stable ids only.
export function guideHtml(topic: GuideTopic, copyHtml: Copy): string {
  return `<div class="guide" data-guide="${topic.id}" data-answer-kind="${topic.kind}"><div class="guidebadge">${copyHtml(GUIDE_BADGE)}</div><h4>${copyHtml(topic.name)}</h4>` +
    topic.lines.map(line => `<p>${copyHtml(line)}</p>`).join("") +
    `<div class="guidego">` + topic.go.map(g => `<button type="button" class="ghost" data-guide-go="${g.to}">${copyHtml(g.label)}</button>`).join("") + `</div></div>`;
}
/** Alternatives are related suggestions, never automatic navigation. */
export function raviSuggestions(q: string): GuideTopic[] {
  const text = normalizeRavi(q);
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
  return /(?:sk-(?:ant-)?|xai-|gsk_|AIza)[a-z0-9_-]{12,}|(?:token|api[_ -]?key|private[_ -]?key|개인키|비밀키|秘密鍵|私钥|密钥)\s*[:=]\s*\S+|(?:시드|복구\s*단어|mnemonic|seed|助记词|シード)\s*[:=]\s*\S+/i.test(q) ||
    /\b(?:[KL][1-9A-HJ-NP-Za-km-z]{51}|5[1-9A-HJ-NP-Za-km-z]{50})\b/.test(q) ||
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
