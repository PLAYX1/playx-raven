/* 자산 파일(IPFS) 보관 — 순수 판단 함수 (0.8.8a).
 *
 * 화면(asset-keep.ts)이 쓰는 모든 「무엇을 보여 줄까 · 무엇을 할까」 판단이 여기 있다.
 * DOM·Tauri·i18n 을 부르지 않는다 → node 단위 시험(scripts/asset-keep.test.mjs)이 그대로 돌린다.
 * 사람에게 보이는 글은 `Msg`(한국어 원문 열쇠 + 값)로만 돌려준다. 번역은 화면이 한다.
 */

export type Health = "unknown" | "checking" | "found" | "missing";
export type Decision = "keep" | "skip";
export type Msg = { k: string; a?: Array<string | number | Msg> };

/** 「내 뜻」(Rust asset_keep.rs)과 실제 상태(kubo·확인 결과)를 합친 줄 상태. */
export type RowKind = "nofile" | "fingerprint" | "kept" | "off" | "unknown" | "missing";

export type RowInput = {
  cid: string | null;
  fingerprint: boolean;
  pinned: boolean;
  health: Health;
  decision?: Decision;
};

export type RowState = {
  kind: RowKind;
  label: string; // 한국어 원문 열쇠
  /** 내가 일부러 뺀 것(자물쇠 표시) */
  declined: boolean;
  /** 못 찾았지만 「보관하기」를 눌러 둠 → 파일을 가진 컴퓨터가 켜지면 자동 보관 */
  reserved: boolean;
  checking: boolean;
  /** 배지를 탭하면 일어나는 일 */
  tap: "none" | "keep" | "find-keep" | "retry-keep";
};

export function rowState(i: RowInput): RowState {
  const base = { declined: false, reserved: false, checking: false };
  if (!i.cid) return { ...base, kind: "nofile", label: "파일 없음", tap: "none" };
  if (i.fingerprint) return { ...base, kind: "fingerprint", label: "원본 지문", tap: "none" };
  if (i.pinned) return { ...base, kind: "kept", label: "보관 중", tap: "none" };
  if (i.decision === "skip") return { ...base, kind: "off", label: "보관 안 함", declined: true, tap: "keep" };
  const reserved = i.decision === "keep";
  if (i.health === "found") return { ...base, kind: "off", label: "보관 안 함", tap: "keep" };
  if (i.health === "missing") {
    return { ...base, kind: "missing", label: reserved ? "찾지 못함 · 예약됨" : "찾지 못함", reserved, tap: "retry-keep" };
  }
  const checking = i.health === "checking";
  return { ...base, kind: "unknown", label: checking ? "확인 중…" : "확인 안 됨", reserved, checking, tap: "find-keep" };
}

/* ── 길게 누르기 ──────────────────────────────────────────────── */

export const HOLD_MS = 600;
export const UNDO_MS = 5000;

export type HoldDeps = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
};

/** 0.6초 길게 누르기. 도중에 떼면 아무 일도 없다. 한 번에 하나만 누른다. */
export function createHold(deps: HoldDeps, onComplete: (cid: string) => void, onChange: () => void = () => {}) {
  let cur: { cid: string; t0: number; timer: unknown } | null = null;
  return {
    start(cid: string): boolean {
      if (cur) return false;
      const t0 = deps.now();
      const timer = deps.setTimer(() => {
        const done = cur;
        cur = null;
        onChange();
        if (done) onComplete(done.cid);
      }, HOLD_MS);
      cur = { cid, t0, timer };
      onChange();
      return true;
    },
    cancel(): boolean {
      if (!cur) return false;
      deps.clearTimer(cur.timer);
      cur = null;
      onChange();
      return true;
    },
    /** 누르는 중이면 그 주소와 지난 시간(ms) — 화면이 다시 그려져도 링이 이어지게. */
    pressing(): { cid: string; elapsed: number } | null {
      return cur ? { cid: cur.cid, elapsed: Math.min(HOLD_MS, deps.now() - cur.t0) } : null;
    },
  };
}

/* ── 용량 ─────────────────────────────────────────────────────── */

export type CapacityLevel = "off" | "unknown" | "ok" | "warn" | "full";

/** 사용률 80%~ 주황 · 95%~ 빨강. 값을 못 읽으면 0% 로 그리지 않는다. */
export function capacityView(used: number | null, max: number | null, running: boolean | null): { level: CapacityLevel; pct: number } {
  if (running === false) return { level: "off", pct: 0 };
  if (used === null || max === null || !(max > 0) || !(used >= 0)) return { level: "unknown", pct: 0 };
  const pct = Math.min(100, Math.round((used / max) * 100));
  return { level: pct >= 95 ? "full" : pct >= 80 ? "warn" : "ok", pct };
}

/** 1000 단위(kubo 의 「15GB」와 같은 쪽). 소수 한 자리. */
export function fmtBytes(n: number): string {
  if (!(n >= 0)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? Math.round(v) : Number(v.toFixed(v >= 100 ? 0 : 1))}${units[i]}`;
}

/* ── 목록 계산 ───────────────────────────────────────────────── */

export type AssetRow = { name: string; cid: string | null; mine: boolean; fingerprint: boolean; pinned: boolean; health: Health; decision?: Decision };

const hasFile = (r: AssetRow) => !!r.cid && !r.fingerprint;

/** 일괄 보관 대상: 파일이 있고 · 아직 안 붙잡았고 · 내가 「보관 안 함」으로 정하지 않은 것. 내가 만든 것부터. 같은 주소는 한 번만. */
export function bulkTargets(rows: AssetRow[], includeReceived: boolean): AssetRow[] {
  const seen = new Set<string>();
  const ok = rows.filter((r) => hasFile(r) && !r.pinned && r.decision !== "skip" && (includeReceived || r.mine));
  const sorted = [...ok.filter((r) => r.mine), ...ok.filter((r) => !r.mine)];
  return sorted.filter((r) => (seen.has(r.cid!) ? false : (seen.add(r.cid!), true)));
}

/** 처음 보는 받은 자산의 파일 — 아직 묻지 않았고(결정 없음) 붙잡지도 않은 것. */
export function undecidedReceived(rows: AssetRow[]): AssetRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => hasFile(r) && !r.mine && !r.pinned && r.decision === undefined && (seen.has(r.cid!) ? false : (seen.add(r.cid!), true)));
}

/** 「파일 있음」 / 「보관 중」 개수(같은 주소는 한 번이 아니라 자산마다 센다 — 표 줄과 맞춘다). */
export function counts(rows: AssetRow[]) {
  const files = rows.filter(hasFile);
  return { total: rows.length, files: files.length, kept: files.filter((r) => r.pinned).length, prints: rows.filter((r) => r.fingerprint).length };
}

/* ── 확인 시점 ───────────────────────────────────────────────── */

export const MISS_QUIET_MS = 6 * 3600 * 1000;

/** 목록을 열 때마다 「찾지 못함」을 전부 20초씩 다시 묻지 않는다 — 6시간 안에 물은 것은 건너뛴다. */
export function shouldRecheck(health: Health | undefined, checkedAt: number | undefined, now: number): boolean {
  if (health === "found") return false;
  if (health === "missing" && checkedAt !== undefined && now - checkedAt < MISS_QUIET_MS) return false;
  return true;
}

export function agoMsg(sec: number): Msg {
  if (sec < 60) return { k: "방금" };
  if (sec < 3600) return { k: "{0}분 전", a: [Math.floor(sec / 60)] };
  if (sec < 86400) return { k: "{0}시간 전", a: [Math.floor(sec / 3600)] };
  return { k: "{0}일 전", a: [Math.floor(sec / 86400)] };
}

/* ── 「?」 이유 안내 ─────────────────────────────────────────── */

export type ReasonCtx = {
  kind: RowKind;
  reserved: boolean;
  mine: boolean;
  /** 파일창고(IPFS) 가 켜져 있는가. 모르면 null */
  ipfsRunning: boolean | null;
  /** 연결된 다른 컴퓨터 수. 모르면 null */
  peers: number | null;
  checkedAtSec: number | null;
  nowSec: number;
  /** 확인을 중간에 멈췄다 */
  stopped: boolean;
};

export type ReasonAction = "check" | "retry" | "resume" | "settings";

export function reasonFor(c: ReasonCtx): { lines: Msg[]; actions: ReasonAction[] } | null {
  const last: Msg[] = c.checkedAtSec !== null ? [{ k: "마지막 확인: {0}", a: [agoMsg(c.nowSec - c.checkedAtSec)] }] : [];
  if (c.kind === "unknown") {
    return c.stopped
      ? { lines: [{ k: "확인을 중간에 멈췄어요." }], actions: ["resume"] }
      : { lines: [{ k: "아직 이 파일이 어디 있는지 물어보지 않았어요." }], actions: ["check"] };
  }
  if (c.kind !== "missing") return null;
  if (c.ipfsRunning === false) {
    return { lines: [{ k: "파일 보관함(IPFS)이 꺼져 있어서 찾을 수 없어요." }], actions: ["settings"] };
  }
  const lines: Msg[] = [{ k: "20초 동안 이 파일을 가진 컴퓨터를 찾지 못했어요. 파일이 없어졌다는 뜻이 아닙니다." }];
  if (c.peers === 0) lines.push({ k: "다른 컴퓨터와 연결되지 않았어요. 인터넷 연결을 확인해 보세요." });
  else lines.push({ k: "파일을 가진 컴퓨터가 꺼져 있거나 인터넷이 약할 수 있어요." });
  if (c.mine) lines.push({ k: "내가 올린 파일인데 이 컴퓨터에서도 못 찾아요. 파일 보관함을 다시 켜거나, 올릴 때 쓴 원본 파일이 있으면 다시 올리세요." });
  if (c.reserved) lines.push({ k: "보관하기를 눌러 두었어요. 그 파일이 다시 나타나면 자동으로 보관해요." });
  return { lines: [...lines, ...last], actions: ["retry"] };
}

/* ── 앱 안 「진짜인지 확인」 결과 → 줄 ──────────────────────── */

export type Tone = "ok" | "warn" | "info" | "unknown" | "bad";
export type VLine = { tone: Tone; msg: Msg };

export type VerifyResult = {
  name?: string;
  status: "found" | "not_found" | "unknown";
  reason?: "node_down" | "syncing" | "error" | null;
  height?: number | null;
  caught_up?: boolean | null;
  unique?: boolean;
  amount?: number | null;
  reissuable?: boolean | null;
  has_ipfs?: boolean;
  ipfs_hash?: string;
  index?: "on" | "off" | "unknown";
  owner_count?: number | null;
  owner_sample?: string[];
  holders?: number | null;
  local?: "none" | "pinned" | "not_pinned" | "fingerprint_made_here" | "unknown";
  at?: number;
};

/** 사람에게 보일 줄. 「안전」은 근거가 있을 때만 초록으로 말한다. */
export function verifyLines(r: VerifyResult): { lines: VLine[]; web: boolean; headline: VLine } {
  if (r.status === "not_found") {
    const m: VLine = { tone: "bad", msg: { k: "공개 장부에서 이 이름을 찾지 못했어요. 이름을 다시 확인하세요." } };
    return { lines: [], web: false, headline: m };
  }
  if (r.status === "unknown") {
    const k = r.reason === "node_down"
      ? "내 노드가 꺼져 있어서 지금은 확인할 수 없어요."
      : r.reason === "syncing"
        ? "노드가 아직 장부를 읽는 중이라 지금은 알 수 없어요. 없다는 뜻이 아니에요."
        : "지금은 확인하지 못했어요. 잠시 뒤 다시 해 보세요.";
    return { lines: [], web: true, headline: { tone: "unknown", msg: { k } } };
  }
  const lines: VLine[] = [];
  lines.push({ tone: "ok", msg: { k: "공개 장부에 있어요." } });
  const amount = r.amount ?? null;
  const kind: Msg = r.unique ? { k: "종류: 고유 자산" } : { k: "종류: 수량 자산" };
  lines.push({ tone: "ok", msg: kind });
  if (amount !== null) lines.push({ tone: "ok", msg: { k: "수량 {0}", a: [amount] } });
  if (r.reissuable === false) lines.push({ tone: "ok", msg: { k: "더 찍을 수 없고 붙은 파일도 바꿀 수 없어요." } });
  else if (r.reissuable === true) lines.push({ tone: "warn", msg: { k: "주인이 더 찍거나 붙은 파일을 바꿀 수 있어요." } });
  if (r.index === "on") {
    if (r.owner_count === 0) lines.push({ tone: "info", msg: { k: "주인 표를 가진 주소를 찾지 못했어요." } });
    else if (typeof r.owner_count === "number") lines.push({ tone: "ok", msg: { k: "주인 표를 가진 주소: {0}곳", a: [r.owner_count] } });
    if (typeof r.holders === "number") lines.push({ tone: "ok", msg: { k: "이 자산을 가진 주소: {0}곳", a: [r.holders] } });
  } else if (r.index === "off") {
    lines.push({ tone: "unknown", msg: { k: "주인·보유 주소는 이 노드에서 볼 수 없어요. 설정에서 자산 색인을 켜세요." } });
  } else {
    lines.push({ tone: "unknown", msg: { k: "주인·보유 주소를 지금은 읽지 못했어요." } });
  }
  if (r.has_ipfs === false || r.local === "none") {
    lines.push({ tone: "info", msg: { k: "이 자산에는 파일 주소가 새겨져 있지 않아요." } });
  } else if (r.local === "pinned") {
    lines.push({ tone: "ok", msg: { k: "이 컴퓨터가 가진 파일은 장부에 적힌 주소와 같아요." } });
  } else if (r.local === "fingerprint_made_here") {
    lines.push({ tone: "info", msg: { k: "이 컴퓨터가 원본 지문만 새긴 자산이에요. 원본 파일을 끌어놓으면 대조해요." } });
  } else {
    lines.push({ tone: "unknown", msg: { k: "이 컴퓨터에 파일이 없어서 파일 쪽은 확인하지 못했어요. 원본 파일을 끌어놓으면 대조해요." } });
  }
  if (r.caught_up === false) lines.push({ tone: "warn", msg: { k: "노드가 아직 따라잡는 중이라 숫자가 달라질 수 있어요." } });
  lines.push({ tone: "info", msg: { k: "받는 사람·제목은 공개 장부에 없어요. 발급한 곳의 종이나 파일로 확인하세요." } });
  lines.push({ tone: "info", msg: { k: "발행한 사람이 현실에서 누구인지는 이 확인으로 알 수 없어요." } });
  const allOk = r.caught_up !== false && r.local !== "unknown";
  return {
    lines,
    web: false,
    headline: allOk
      ? { tone: "ok", msg: { k: "공개 장부와 일치합니다." } }
      : { tone: "warn", msg: { k: "공개 장부에는 있어요. 아래에서 확인하지 못한 것을 보세요." } },
  };
}

export type FileMatch = { match_kind: "fingerprint" | "ipfs" | "none"; ipfs_checked?: boolean; ipfs_too_big?: boolean };

/** 끌어놓은 파일 대조 결과. 다르다고 위조라고 단정하지 않는다. */
export function fileMatchLine(f: FileMatch): VLine {
  if (f.match_kind === "fingerprint") return { tone: "ok", msg: { k: "이 파일은 장부에 적힌 원본과 같아요." } };
  if (f.match_kind === "ipfs") return { tone: "ok", msg: { k: "이 파일은 장부에 적힌 원본과 같아요 (파일 보관함 방식)." } };
  if (f.ipfs_too_big) {
    return { tone: "warn", msg: { k: "끌어놓은 파일의 지문이 장부와 달라요. 이 파일이 커서 파일 보관함 방식 대조는 하지 않았어요. 위조라고 단정할 수는 없어요." } };
  }
  return { tone: "warn", msg: { k: "끌어놓은 파일의 지문이 장부와 달라요. 위조라고 단정할 수는 없어요 — 다른 파일을 놓았거나 올린 방식이 다를 수 있어요. 원본 파일로 다시 해 보세요." } };
}

/** 짧게 줄인 주소 표시용 (이미 Rust 가 줄여 주지만 화면이 한 번 더 막는다). */
export function clip(s: string, n = 14): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
