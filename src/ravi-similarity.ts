/** Local example retrieval only. Never parses addresses, amounts or secrets for actions. */
import examples from "./ravi-intent-examples.json";
import thresholds from "./ravi-similarity-thresholds.json";
export type ExampleGroup = { intent: string; examples: string[] };
export type RankedIntent = { intent: string; score: number };
export type SimilarityThresholds = { high: number; low: number; margin: number };
export type SimilarityDecision = { kind: "direct" | "clarify" | "miss"; ids: string[]; ranked: RankedIntent[] };
/** Particle/endings stripping is confined to retrieval features, never transaction data. */
export function similarityText(q: string): string {
  return String(q ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean).map(w => w.length > 2 ? w.replace(/(?:해주세요|해줘요|주세요|인가요|할까요|을까요|인가|해줘|줘요|어요|나요|이야|이요|할래|할게|해요|해|에서|으로|에게|한테|은|는|을|를|가|이|요)$/, "") : w).join("");
}
function grams(q: string): Set<string> {
  const compact = q.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const cleaned = similarityText(q);
  const out = new Set<string>();
  // Whole normalized tokens complement n-grams for short anchors such as AI/QR/CSV.
  for (const token of q.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const word = similarityText(token);
    if (/^[a-z]{2,}$/.test(word)) out.add("w" + word);
  }
  for (const s of new Set([compact, cleaned])) {
    for (const [prefix, value] of [["c", s], ["j", s.normalize("NFD")]]) {
      for (const n of [2, 3]) for (let i = 0; i + n <= value.length; i++) out.add(prefix + value.slice(i, i + n));
    }
  }
  return out;
}
export function createRaviSimilarity(table: ExampleGroup[]) {
  const samples = table.flatMap(g => g.examples.map(q => ({ intent: g.intent, grams: grams(q) })));
  const frequencies = new Map<string, number>();
  for (const s of samples) for (const g of s.grams) frequencies.set(g, (frequencies.get(g) ?? 0) + 1);
  const weight = (g: string) => (g[0] === "w" ? 4 : g[0] === "j" ? 0.55 : 1) * (1 + Math.log((samples.length + 1) / ((frequencies.get(g) ?? samples.length) + 1)));
  const vector = (features: Set<string>) => {
    const values = new Map([...features].map(g => [g, weight(g)]));
    return { values, norm: Math.sqrt([...values.values()].reduce((sum, v) => sum + v * v, 0)) };
  };
  const vectors = samples.map(s => ({ intent: s.intent, ...vector(s.grams) }));
  return (q: string): RankedIntent[] => {
    const input = vector(grams(q));
    const best = new Map<string, number>();
    for (const sample of vectors) {
      let dot = 0;
      for (const [g, v] of input.values) dot += v * (sample.values.get(g) ?? 0);
      const score = input.norm && sample.norm ? Math.min(1, dot / (input.norm * sample.norm)) : 0;
      best.set(sample.intent, Math.max(best.get(sample.intent) ?? 0, score));
    }
    return [...best].map(([intent, score]) => ({ intent, score })).sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  };
}
export function decideRaviSimilarity(ranked: RankedIntent[], limits: SimilarityThresholds = thresholds): SimilarityDecision {
  const [first, second] = ranked;
  if (!first || first.score < limits.low || first.intent === "miss" || (ranked.find(r => r.intent === "miss")?.score ?? -1) >= first.score - limits.margin) return { kind: "miss", ids: [], ranked };
  if (first.score >= limits.high && first.score - (second?.score ?? 0) >= limits.margin) {
    return { kind: first.intent === "miss" ? "miss" : "direct", ids: first.intent === "miss" ? [] : [first.intent], ranked };
  }
  // Refusal is an alternative, not a misleading feature button.
  const ids = ranked.filter(r => r.intent !== "miss").slice(0, 2).map(r => r.intent);
  return { kind: "clarify", ids, ranked };
}
const rank = createRaviSimilarity(examples);
export function raviSimilarity(q: string): SimilarityDecision { return decideRaviSimilarity(rank(q)); }
