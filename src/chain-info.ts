/* 「체인 정보」 1단계 — 순수 함수. DOM·번역·네트워크에 기대지 않는다(node 시험에서 그대로 번들된다).
 * 값은 Rust(`chain_overview`·`chain_security`)가 준 것만 쓴다. 없으면 null — 숫자를 만들어 채우지 않는다. */
export type Num = number | null | undefined;
export type SecState = "ok" | "stale" | "very_stale" | "none";
export type SecurityRaw = {
  status?: string; attack_cost_usd_hour?: Num; hashrate_hs?: Num; market_cap_usd?: Num; nicehash_ratio?: Num;
  rank?: Num; coin_count?: Num; as_of?: Num; fetched_at?: Num; refresh_failed?: boolean | null;
};
export type OverviewRaw = {
  blocks?: Num; headers?: Num; progress?: Num; synced?: boolean | null; peers?: Num; tip_time?: Num;
  hashrate_hs?: Num; difficulty?: Num; mempool_count?: Num; mempool_bytes?: Num; as_of?: Num;
};

export const STALE_SECS = 24 * 3600;
export const VERY_STALE_SECS = 72 * 3600;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 기준 시각이 얼마나 오래됐나. Rust 의 `freshness` 와 같은 규칙(24시간 노랑 · 72시간 흐림). 미래 시각은 ok. */
export function freshness(nowSec: number, asOfSec: Num): "ok" | "stale" | "very_stale" | "unknown" {
  if (!num(asOfSec)) return "unknown";
  const age = nowSec - asOfSec;
  return age > VERY_STALE_SECS ? "very_stale" : age > STALE_SECS ? "stale" : "ok";
}

/** 「방금」「n분 전」… 을 열쇠+값으로. 번역은 부르는 쪽이 한다. */
export function ageParts(nowSec: number, asOfSec: Num): { key: "방금" | "{0}분 전" | "{0}시간 전" | "{0}일 전"; n: number } | null {
  if (!num(asOfSec)) return null;
  const s = Math.max(0, nowSec - asOfSec);
  if (s < 90) return { key: "방금", n: 0 };
  if (s < 3600) return { key: "{0}분 전", n: Math.round(s / 60) };
  if (s < 48 * 3600) return { key: "{0}시간 전", n: Math.round(s / 3600) };
  return { key: "{0}일 전", n: Math.round(s / 86400) };
}

const HASH_UNITS = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
/** 해시율(초당 해시 수) → 「620 GH/s」. 못 읽으면 null. */
export function fmtHashrate(hs: Num, locale = "ko"): string | null {
  if (!num(hs) || hs <= 0) return null;
  let i = 0, v = hs;
  while (v >= 1000 && i < HASH_UNITS.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString(locale, { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 })} ${HASH_UNITS[i]}`;
}
/** 달러 금액. 1,000 이상은 정수, 10 미만은 소수 둘. 못 읽으면 null. */
export function fmtUsd(n: Num, locale = "ko"): string | null {
  if (!num(n) || n < 0) return null;
  const digits = n >= 10 ? 0 : 2;
  return `$${n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function fmtInt(n: Num, locale = "ko"): string | null {
  return num(n) && n >= 0 ? Math.round(n).toLocaleString(locale) : null;
}
/** 난이도: 큰 수는 줄여서(예: 123.4 k). */
export function fmtDifficulty(d: Num, locale = "ko"): string | null {
  if (!num(d) || d <= 0) return null;
  const units = ["", " k", " M", " G", " T"];
  let i = 0, v = d;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString(locale, { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 })}${units[i]}`;
}
export function fmtPercent(ratio: Num, locale = "ko"): string | null {
  return num(ratio) && ratio >= 0 ? `${(ratio * 100).toLocaleString(locale, { maximumFractionDigits: ratio * 100 >= 10 ? 0 : 1 })}%` : null;
}

export type SecurityView = {
  state: SecState;
  /** 숫자를 흐리게(72시간 넘음). */
  dim: boolean;
  cost: string | null;
  rank: { rank: number; of: number } | null;
  hashrate: string | null;
  ratio: string | null;
  asOf: number | null;
  /** 새로 받지 못해 마지막으로 받은 값을 보여 주는 중. */
  refreshFailed: boolean;
};
/** crypto51 값 → 화면 모양. 상태는 Rust 가 준 것을 믿되, 기준 시각이 있으면 이쪽에서도 다시 판정해 더 나쁜 쪽을 따른다. */
export function securityView(raw: SecurityRaw | null | undefined, nowSec: number, locale = "ko"): SecurityView {
  const none: SecurityView = { state: "none", dim: false, cost: null, rank: null, hashrate: null, ratio: null, asOf: null, refreshFailed: false };
  if (!raw || !["ok", "stale", "very_stale"].includes(String(raw.status))) return none;
  const cost = fmtUsd(raw.attack_cost_usd_hour, locale);
  if (cost === null || !num(raw.as_of)) return none;
  const order = { ok: 0, stale: 1, very_stale: 2 } as const;
  const mine = freshness(nowSec, raw.as_of);
  const theirs = raw.status as keyof typeof order;
  const state = mine === "unknown" || order[theirs] >= order[mine] ? theirs : mine;
  const rank = num(raw.rank) && num(raw.coin_count) && raw.rank >= 1 && raw.rank <= raw.coin_count ? { rank: raw.rank, of: raw.coin_count } : null;
  return {
    state, dim: state === "very_stale", cost, rank,
    hashrate: fmtHashrate(raw.hashrate_hs, locale), ratio: fmtPercent(raw.nicehash_ratio, locale),
    asOf: raw.as_of, refreshFailed: raw.refresh_failed === true,
  };
}

export type OverviewView = {
  state: "ok" | "syncing" | "none";
  blocks: string | null;
  /** 따라잡는 중이면 0~100, 아니면 null */
  syncPercent: number | null;
  hashrate: string | null;
  difficulty: string | null;
  mempool: string | null;
  peers: string | null;
  asOf: number | null;
};
export function overviewView(raw: OverviewRaw | null | undefined, locale = "ko"): OverviewView {
  const none: OverviewView = { state: "none", blocks: null, syncPercent: null, hashrate: null, difficulty: null, mempool: null, peers: null, asOf: null };
  if (!raw || !num(raw.blocks)) return none;
  const synced = raw.synced === true;
  const pct = num(raw.progress) ? Math.max(0, Math.min(100, Math.floor(raw.progress * 1000) / 10)) : null;
  return {
    state: synced ? "ok" : "syncing",
    blocks: fmtInt(raw.blocks, locale),
    syncPercent: synced ? null : pct,
    // 따라잡는 중에는 Rust 가 null 로 준다. 여기서도 다시 막는다.
    hashrate: synced ? fmtHashrate(raw.hashrate_hs, locale) : null,
    difficulty: synced ? fmtDifficulty(raw.difficulty, locale) : null,
    mempool: fmtInt(raw.mempool_count, locale),
    peers: fmtInt(raw.peers, locale),
    asOf: num(raw.as_of) ? raw.as_of : null,
  };
}
