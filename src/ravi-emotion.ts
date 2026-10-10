/* 라비 감정 엔진 — 이벤트 이름 하나를 받아 「지금 라비가 어떤 얼굴·한마디·소리인가」 하나를 낸다.
 *
 * 원칙(설계 문서 docs/design/ravi-emotion.md):
 *  1. 감정은 상황에서 나온다 — 규칙표(ravi-emotion-rules.ts)만 보고 정한다. 이벤트에는 값이 없다.
 *  2. 한 번에 하나 — 자리(slot)마다 한 감정, 화면엔 그중 가장 급한 하나. 경고 > 오류 > 돈 > 사람 > 일상.
 *  3. 지속·합치기·쿨다운 — 같은 일이 연달아 오면 한 번으로 합치고, 같은 표정을 너무 자주 되풀이하지 않는다.
 *  4. 읽기 전용 — 이 파일은 DOM·IPC·지갑을 모른다(시계·타이머도 주입 가능). 그래서 Node 에서 그대로 시험한다.
 */
import { RULES, PRIORITY, TONE, EMOTION_LABEL, type RaviEmotion, type RaviEventName, type Rule, type Slot, type SoundSlot, type Motion, type Tone } from "./ravi-emotion-rules";
import type { RaviMood } from "./ravi-face";

export * from "./ravi-emotion-rules";

/** 새 감정 → 기존 얼굴(RaviMood). 기존 이름은 그대로 쓰고, 더 세밀한 것은 overlay 가 그린다. */
export const BASE_MOOD: Record<RaviEmotion, RaviMood> = {
  neutral: "normal", happy: "happy", celebrate: "happy", fond: "love", surprised: "surprised",
  focused: "focused", thinking: "thinking", worried: "worried", calm: "normal", apologetic: "worried",
  sleepy: "sleepy", asleep: "sleep", welcome: "wake", waiting: "normal", puzzled: "normal",
  shy: "happy", proud: "happy", relieved: "happy",
};

export type Display = {
  emotion: RaviEmotion;
  baseMood: RaviMood;
  tone: Tone;
  priority: number;
  event: RaviEventName | null;
  /** 말풍선 문구(한국어 원문 = 번역 열쇠). 이번에 말풍선을 띄우지 않으면 null. */
  bubble: string | null;
  /** 문구에 끼울 값(건수만 — 금액은 엔진에 들어올 길이 없다). */
  bubbleArgs: number[];
  /** 지금 화면의 문구(말풍선을 새로 띄우지 않더라도 이미 떠 있는 것의 갱신용). */
  copy: string | null;
  sound: SoundSlot | null;
  motion: Motion;
  serious: boolean;
  /** 화면 낭독용 짧은 상태(한국어 열쇠). */
  label: string;
  /** 이번 갱신이 「새 감정의 등장」인가(움직임·소리·말풍선은 이때만). */
  fresh: boolean;
  /** 경고 등급 — 말풍선·낭독 빈도 제한을 건너뛴다. */
  urgent: boolean;
  holdMs: number;
  seq: number;
};

type Entry = { name: RaviEventName; rule: Rule; since: number; lastAt: number; until: number | null; count: number; masked: boolean };

export type EngineOptions = {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** 금액 가리기가 켜져 있나. 켜져 있으면 기념일 단서·건수를 지운다. */
  masked?: () => boolean;
  /** 「라비 소리」가 켜져 있나. */
  soundOn?: () => boolean;
  /** 방해 금지(운영체제 집중 모드·조용한 시간). 경고 소리(attention)만 남는다. */
  dnd?: () => boolean;
  /** 아무 감정도 없을 때의 얼굴(예: 열쇠 없으면 asleep). */
  rest?: () => RaviEmotion;
  /** 경고가 아닌 말풍선 사이 최소 간격. */
  bubbleGapMs?: number;
  /** 소리 사이 최소 간격. */
  soundGapMs?: number;
};

export type RaviEmotionEngine = ReturnType<typeof createRaviEmotionEngine>;

export function createRaviEmotionEngine(options: EngineOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const bubbleGap = options.bubbleGapMs ?? 6000;
  const soundGap = options.soundGapMs ?? 4000;
  const slots = new Map<Slot, Entry>();
  const lastShown = new Map<RaviEventName, number>();
  const listeners = new Set<(d: Display) => void>();
  let lastBubbleAt = -Infinity, lastSoundAt = -Infinity, timer: unknown = null, seq = 0;
  let current: Display = restDisplay();

  function restDisplay(): Display {
    const emotion = options.rest?.() ?? "neutral";
    return { emotion, baseMood: BASE_MOOD[emotion], tone: TONE[emotion], priority: -1, event: null, bubble: null, bubbleArgs: [], copy: null, sound: null, motion: "none", serious: false, label: EMOTION_LABEL[emotion], fresh: false, urgent: false, holdMs: 0, seq };
  }

  function top(): Entry | null {
    let best: Entry | null = null;
    for (const e of slots.values()) {
      const p = PRIORITY[e.rule.priority];
      if (!best || p > PRIORITY[best.rule.priority] || (p === PRIORITY[best.rule.priority] && e.lastAt >= best.lastAt)) best = e;
    }
    return best;
  }

  function prune(t: number) {
    for (const [slot, e] of slots) if (e.until !== null && e.until <= t) slots.delete(slot);
  }

  function schedule() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    let next = Infinity;
    for (const e of slots.values()) if (e.until !== null) next = Math.min(next, e.until);
    if (next === Infinity) return;
    timer = setTimer(() => { timer = null; refresh(); }, Math.max(0, next - now()));
  }

  function view(e: Entry, fresh: boolean): Display {
    const t = now();
    const masked = e.masked;
    const m = masked && e.rule.masked ? e.rule.masked : null;
    const emotion = m ? m.emotion : e.rule.emotion;
    const baseCopy = m ? m.copy : e.rule.copy;
    // 가림 켬이면 건수도 말하지 않는다(「일반적 기쁨만」).
    const many = !masked && e.count > 1 && e.rule.copyMany ? e.rule.copyMany : null;
    const copy = many ?? baseCopy;
    const urgent = e.rule.priority === "alert";
    let bubble: string | null = null;
    if (fresh && copy && (urgent || t - lastBubbleAt >= bubbleGap)) { bubble = copy; lastBubbleAt = t; }
    let sound: SoundSlot | null = null;
    const slot = e.rule.sound;
    if (fresh && slot && options.soundOn?.() !== false && t - lastSoundAt >= soundGap) {
      const quiet = options.dnd?.() === true;
      if (!quiet || slot === "ravi.attention") { sound = slot; lastSoundAt = t; }
    }
    return {
      emotion, baseMood: BASE_MOOD[emotion], tone: TONE[emotion], priority: PRIORITY[e.rule.priority], event: e.name,
      bubble, bubbleArgs: many ? [e.count] : [], copy, sound, motion: m ? m.motion : e.rule.motion, serious: !!e.rule.serious,
      label: EMOTION_LABEL[emotion], fresh, urgent, holdMs: e.rule.holdMs, seq: ++seq,
    };
  }

  function publish(d: Display) {
    current = d;
    for (const fn of listeners) { try { fn(d); } catch { /* 한 화면의 오류가 다른 화면을 막지 않게 */ } }
  }

  /** 시간이 흘러 감정이 끝났는지 다시 본다(타이머가 부른다). */
  function refresh() {
    const t = now();
    prune(t);
    const e = top();
    const next = e ? view(e, false) : restDisplay();
    if (next.emotion !== current.emotion || next.event !== current.event || next.copy !== current.copy) publish(next);
    schedule();
  }

  /** 이벤트 하나. 이름만 받는다 — 값(금액·주소·글)은 받을 자리가 없다. 모르는 이름은 무시. */
  function emit(name: RaviEventName): Display | null {
    const rule = (RULES as Record<string, Rule | undefined>)[name];
    if (!rule) return null;
    const t = now();
    prune(t);
    for (const s of rule.clears ?? []) slots.delete(s);
    if (!rule.slot) { refresh(); return current; }

    const masked = options.masked?.() === true;
    const existing = slots.get(rule.slot);
    // 합치기: 같은 일이 짧은 사이에 또 오면 새 표정 대신 건수만 올린다(움직임·소리 없음).
    if (existing && existing.name === name && rule.mergeMs > 0 && t - existing.lastAt <= rule.mergeMs) {
      existing.count++; existing.lastAt = t; existing.masked = masked;
      existing.until = rule.holdMs ? t + rule.holdMs : null;
      const e = top();
      if (e === existing) publish(view(existing, false)); else refresh();
      schedule();
      return current;
    }
    // 머무는 감정(holdMs 0)이 이미 같은 이름으로 떠 있으면 다시 그리지 않는다(노드 끊김 반복 보고 등).
    if (existing && existing.name === name && rule.holdMs === 0) { existing.lastAt = t; return current; }
    // 쿨다운: 같은 일을 너무 자주 「알리지」 않는다 — 얼굴은 상황을 따르되 말풍선·소리·움직임은 쉰다.
    const last = lastShown.get(name);
    const cooling = last !== undefined && t - last < rule.cooldownMs;

    const entry: Entry = { name, rule, since: t, lastAt: t, until: rule.holdMs ? t + rule.holdMs : null, count: 1, masked };
    const before = top();
    slots.set(rule.slot, entry);
    const winner = top();
    if (winner === entry) {
      if (!cooling) lastShown.set(name, t);
      publish(view(entry, !cooling));
    } else if (before !== winner) {
      refresh();
    }
    schedule();
    return current;
  }

  return {
    emit,
    refresh,
    current: () => current,
    subscribe(fn: (d: Display) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 지금 남아 있는 자리(시험·진단용 — 값은 이벤트 이름뿐). */
    active: () => [...slots.entries()].map(([slot, e]) => ({ slot, event: e.name, count: e.count })),
    reset() { slots.clear(); lastShown.clear(); lastBubbleAt = lastSoundAt = -Infinity; if (timer !== null) clearTimer(timer); timer = null; publish(restDisplay()); },
  };
}

// ── 크기별 표현 ──────────────────────────────────────────────────
export type SizeName = "large" | "medium" | "mini-l" | "mini-m" | "mini-s" | "chip" | "tray";
export type Glyph = "dot" | "heart" | "ring" | "triangle" | "moon";
export type Expression = {
  /** 얼굴 — full: 기본 표정 + 세부(overlay), base: 기본 표정만, none: 얼굴 없음. */
  face: "full" | "base" | "none";
  motion: Motion;
  /** 말풍선 — full: 두 줄까지, line: 한 줄(말줄임), none. */
  bubble: "full" | "line" | "none";
  tone: Tone;
  /** 색에만 기대지 않게 톤마다 모양이 다르다. */
  glyph: Glyph;
};
export const GLYPH: Record<Tone, Glyph> = { warm: "heart", calm: "ring", alert: "triangle", rest: "moon", neutral: "dot" };

/** 작을수록 단순하게: 큰 창은 표정+움직임+말풍선, 미니 S·칩은 표정 하나, 트레이는 점 하나. */
export function expressionFor(d: Pick<Display, "emotion" | "tone" | "motion" | "serious">, size: SizeName, reducedMotion = false): Expression {
  const motion = reducedMotion || d.serious ? "none" : d.motion;
  const glyph = GLYPH[d.tone];
  switch (size) {
    case "large": return { face: "full", motion, bubble: "full", tone: d.tone, glyph };
    case "medium": return { face: "full", motion: motion === "sparkle" ? "bounce" : motion, bubble: "full", tone: d.tone, glyph };
    case "mini-l": return { face: "full", motion: motion === "none" ? "none" : "nod", bubble: "line", tone: d.tone, glyph };
    case "mini-m": return { face: "base", motion: "none", bubble: "line", tone: d.tone, glyph };
    case "mini-s": return { face: "base", motion: "none", bubble: "none", tone: d.tone, glyph };
    case "chip": return { face: "base", motion: "none", bubble: "none", tone: d.tone, glyph };
    case "tray": return { face: "none", motion: "none", bubble: "none", tone: d.tone, glyph };
  }
}

/** 움직임 사양 — 깜빡임(밝기 반전·나타났다 사라짐) 횟수와 길이. 시험이 초당 3회 상한을 지킨다. */
export const MOTION_SPEC: Record<Motion, { durationMs: number; flashes: number; spring: { damping: number; response: number } | null }> = {
  none: { durationMs: 0, flashes: 0, spring: null },
  nod: { durationMs: 520, flashes: 0, spring: { damping: 1, response: 0.32 } },
  bounce: { durationMs: 700, flashes: 0, spring: { damping: 0.72, response: 0.34 } },
  sparkle: { durationMs: 900, flashes: 1, spring: { damping: 0.7, response: 0.36 } },
  sway: { durationMs: 760, flashes: 0, spring: { damping: 0.78, response: 0.4 } },
  droop: { durationMs: 560, flashes: 0, spring: { damping: 1, response: 0.4 } },
  settle: { durationMs: 480, flashes: 0, spring: { damping: 1, response: 0.3 } },
};

// ── 미니 창·트레이 호환 인터페이스(미니 창 파일은 건드리지 않는다) ──────────
/** 미니 창 알림 종류(Rust mini_feed::Kind, snake_case) → 라비 이벤트. */
export const MINI_KIND_EVENT: Record<string, RaviEventName> = {
  deposit_seen: "deposit_seen", deposit_confirmed: "deposit_confirmed", deposit_dropped: "deposit_dropped",
  order: "order_received", node_down: "node_down", node_disconnected: "node_disconnected", node_stalled: "node_stalled",
  node_recovered: "node_recovered", awake_lost: "awake_lost",
};
export function miniKindToRaviEvent(kind: string): RaviEventName | null {
  return Object.prototype.hasOwnProperty.call(MINI_KIND_EVENT, kind) ? MINI_KIND_EVENT[kind] : null;
}

/** 트레이(메뉴바) 아이콘 힌트 — 아이콘 세 벌(normal·alert·sleep)과 점 색만. Rust 쪽 연결은 문서 참고. */
export function trayHint(d: Pick<Display, "tone" | "emotion">): { variant: "normal" | "alert" | "sleep"; dot: Tone | null } {
  if (d.tone === "alert") return { variant: "alert", dot: "alert" };
  if (d.emotion === "asleep") return { variant: "sleep", dot: null };
  return { variant: "normal", dot: d.tone === "warm" ? "warm" : null };
}

/** 밤(23시~5시)인가 — 졸린 기운만 준다. 일을 막지 않는다. */
export const isNightHour = (h: number) => h >= 23 || h < 5;

// ── 앱 전역 이벤트 버스 ───────────────────────────────────────────
let shared: RaviEmotionEngine | null = null;
/** 앱 하나에 엔진 하나. 처음 부를 때 만든다(옵션은 처음 한 번만 적용). */
export function raviEmotion(options?: EngineOptions): RaviEmotionEngine {
  if (!shared) shared = createRaviEmotionEngine(options);
  return shared;
}
/** 어디서든 한 줄: emitRaviEvent("deposit_confirmed"). 값은 넘기지 않는다. */
export function emitRaviEvent(name: RaviEventName): void {
  try { raviEmotion().emit(name); } catch { /* 감정 표시는 본 기능을 절대 막지 않는다 */ }
}
/** import 없이도 쓸 수 있게 — window.dispatchEvent(new CustomEvent("ravi-event", { detail: "backup_done" })). 문자열만 받는다. */
export function listenRaviEventBus(target: EventTarget = globalThis as unknown as EventTarget): () => void {
  const fn = (e: Event) => { const name = (e as CustomEvent).detail; if (typeof name === "string") emitRaviEvent(name as RaviEventName); };
  target.addEventListener("ravi-event", fn);
  return () => target.removeEventListener("ravi-event", fn);
}
