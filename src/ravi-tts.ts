// 라비 목소리 관리자 — 메인 스레드 쪽. 모델 읽기 → 워커 → 소리 재생, 그리고 **실패하면 늘 「폴백」을 돌려준다**
// (부른 쪽이 기기 목소리로 말한다: 라비는 항상 말할 수 있어야 한다).
// 가짜(주입) 의존물로 시험한다: scripts/ravi-tts.test.mjs

import { chunkPauseSec, voiceChunks } from "./ravi-tts-core";
/** { rest } = 앞부분은 라비 목소리로 이미 읽었고, 남은 글만 기기 목소리로 이어 읽어야 한다(같은 말을 두 번 하지 않는다). */
export type TtsResult = "played" | "fallback" | "cancelled" | { rest: string };
export interface WorkerLike {
  postMessage(m: unknown, t?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
/** 소리 조각을 이어 트는 줄. push 한 차례대로(앞 조각 끝 + 쉼 뒤, 이미 지났으면 바로), idle 은 넣은 것이 다 끝나면(또는 멈추면) 풀린다. */
export interface AudioQueue { push(pcm: Float32Array, rate: number, pauseSec: number): void; idle(): Promise<void>; stop(): void }
export interface RaviTtsDeps {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  newWorker(): WorkerLike;
  /** 재생 줄을 연다. 막히면 던진다(→ 기기 목소리). */
  queue(): Promise<AudioQueue>;
  base: string;
  setTimer?(fn: () => void, ms: number): number;
  clearTimer?(id: number): void;
}
export const CHUNK = 16 * 1024 * 1024;
export const IDLE_DISPOSE_MS = 5 * 60 * 1000;
export const LOAD_TIMEOUT_MS = 60_000;
/** 이 글에 허용하는 만드는 시간. 6초 분량 문장을 10초 안에가 목표이니 여유를 두되 끝없이 기다리지 않는다. */
export function synthBudgetMs(text: string): number { return Math.min(40_000, 12_000 + text.length * 300); }
/** 첫 조각(짧은 첫 문장)이 이 안에 안 오면 아무 소리도 안 냈으니 기기 목소리가 처음부터 읽는다. 폰 RAVI_VOICE.firstSoundLimitMs 와 같다. */
export const FIRST_SOUND_LIMIT_MS = 2500;
const CACHE_MAX = 24;

export function createRaviTts(deps: RaviTtsDeps) {
  const setT = deps.setTimer ?? ((f, ms) => setTimeout(f, ms) as unknown as number), clrT = deps.clearTimer ?? (id => clearTimeout(id));
  let state: "idle" | "loading" | "ready" | "unavailable" = "idle", worker: WorkerLike | null = null, loading: Promise<boolean> | null = null;
  let epoch = 0, nextId = 1, playing: AudioQueue | null = null, idleTimer = 0, strikes = 0;
  const cache = new Map<string, { pcm: Float32Array; rate: number }>();   // 조각 글 → 소리
  const pending = new Map<number, (m: any) => void>();
  let readyResolve: ((ok: boolean) => void) | null = null;

  const markUnavailable = () => { state = "unavailable"; dispose(false); };
  function dispose(keepState: boolean) {
    if (idleTimer) { clrT(idleTimer); idleTimer = 0; }
    if (worker) { worker.onmessage = worker.onerror = null; try { worker.terminate(); } catch { /* already gone */ } worker = null; }
    for (const resolve of pending.values()) resolve({ type: "error", message: "disposed" });
    pending.clear(); readyResolve?.(false); readyResolve = null;
    if (keepState && state !== "unavailable") state = "idle";
  }
  function touchIdle() { if (idleTimer) clrT(idleTimer); idleTimer = setT(() => { idleTimer = 0; dispose(true); }, IDLE_DISPOSE_MS); }

  async function readAll(key: string, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    for (let at = 0; at < size; at += CHUNK) {
      const part = await deps.invoke("ravi_tts_read", { key, offset: at, len: Math.min(CHUNK, size - at) }) as ArrayBuffer | Uint8Array | number[];
      const bytes = part instanceof Uint8Array ? part : Array.isArray(part) ? Uint8Array.from(part) : new Uint8Array(part);
      if (bytes.length !== Math.min(CHUNK, size - at)) throw new Error("short-read");
      out.set(bytes, at);
    }
    return out;
  }

  async function load(): Promise<boolean> {
    const status = await deps.invoke("ravi_tts_status") as { ok?: boolean; sizes?: [string, number][] } | null;
    if (!status?.ok || !status.sizes) return false;
    const size = Object.fromEntries(status.sizes) as Record<string, number>;
    const text = async (k: string) => new TextDecoder().decode(await readAll(k, size[k]));
    const models = { dp: await readAll("dp", size.dp), enc: await readAll("enc", size.enc), vec: await readAll("vec", size.vec), voc: await readAll("voc", size.voc), cfg: await text("cfg"), indexer: await text("indexer"), style: await text("style") };
    const w = worker = deps.newWorker();
    const ready = new Promise<boolean>(resolve => {
      readyResolve = resolve;
      const timer = setT(() => resolve(false), LOAD_TIMEOUT_MS);
      w.onerror = () => resolve(false);
      w.onmessage = e => {
        const m = e.data;
        if (m.type === "ready") { clrT(timer); resolve(true); }
        else if (m.type === "error" && m.phase === "init") { clrT(timer); resolve(false); }
        else if (m.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m); }
      };
    });
    w.postMessage({ type: "init", models, base: deps.base }, [models.dp.buffer, models.enc.buffer, models.vec.buffer, models.voc.buffer]);
    return ready;
  }

  /** 불러 두기(켜 두면 첫 말이 빨라진다). 안 되면 false. 여러 번 불러도 한 번만 읽는다. */
  function warm(): Promise<boolean> {
    if (state === "ready") { touchIdle(); return Promise.resolve(true); }
    if (state === "unavailable") return Promise.resolve(false);
    if (loading) return loading;
    state = "loading";
    loading = load().then(ok => { state = ok ? "ready" : "unavailable"; if (!ok) dispose(false); else touchIdle(); return ok; }, () => { markUnavailable(); return false; }).finally(() => { loading = null; });
    return loading;
  }

  function stopPlaying() { const p = playing; playing = null; try { p?.stop(); } catch { /* already stopped */ } }
  function cancel() {
    epoch++; stopPlaying();
    if (worker) for (const id of pending.keys()) worker.postMessage({ type: "cancel", id });
  }

  type Piece = { pcm: Float32Array; rate: number };
  function synthRaw(w: WorkerLike, text: string, budget: number): Promise<any> {
    return new Promise(resolve => {
      const id = nextId++;
      const timer = setT(() => { if (pending.delete(id)) { w.postMessage({ type: "cancel", id }); resolve({ type: "error", message: "slow" }); } }, budget);
      pending.set(id, m => { clrT(timer); resolve(m); });
      w.postMessage({ type: "speak", id, text });
    });
  }
  /** 한 조각(캐시 먼저). budget 안에 안 오면 slow. */
  async function piece(text: string, budget: number): Promise<Piece | { fail: "slow" | "broken" | "cancelled" }> {
    const hit = cache.get(text);
    if (hit) { cache.delete(text); cache.set(text, hit); return hit; }
    const w = worker; if (!w) return { fail: "broken" };
    const reply = await synthRaw(w, text, budget);
    if (reply.type === "cancelled" || reply.message === "disposed") return { fail: "cancelled" };
    if (reply.type !== "done" || !(reply.pcm instanceof Float32Array) || !(reply.rate > 0)) return { fail: reply.message === "slow" ? "slow" : "broken" };
    const made = { pcm: reply.pcm as Float32Array, rate: reply.rate as number };
    cache.set(text, made); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return made;
  }

  /**
   * 문장 조각 줄(스트리밍): 첫 조각만 만들면 바로 틀고, 그게 나오는 동안 다음 조각을 만든다(옛 방식 = 글 전체를 다 만든 뒤 재생 → 3~4문장에 M1 에서 15초).
   * 첫 조각이 FIRST_SOUND_LIMIT_MS 안에 안 오면 fallback(아무 소리도 안 났다), 중간 조각이 실패하면 나온 소리가 끝난 뒤 { rest }.
   */
  async function speak(text: string, hooks: { started?(): void } = {}): Promise<TtsResult> {
    cancel(); const mine = epoch; const alive = () => mine === epoch;
    const clean = text.trim(); if (!clean) return "cancelled";
    const parts = voiceChunks(clean); if (!parts.length) return "fallback";
    let q: AudioQueue | null = null, at = 0;
    const rest = (k: number) => parts.slice(k).join(" ");
    try {
      if (!parts.every(p => cache.has(p)) && (!(await warm()) || !alive())) return alive() ? "fallback" : "cancelled";
      let next = piece(parts[0], FIRST_SOUND_LIMIT_MS);
      for (; at < parts.length; at++) {
        const got = await next;
        if (!alive()) return "cancelled";
        if ("fail" in got) {
          if (got.fail === "cancelled") return "cancelled";
          if (got.fail === "slow" && ++strikes >= 2) markUnavailable();   // 두 번 느리면 이번 실행은 기기 목소리로
          if (!q) return "fallback";
          await q.idle(); return alive() ? { rest: rest(at) } : "cancelled";
        }
        if (at === 0) strikes = 0;
        if (at + 1 < parts.length) next = piece(parts[at + 1], synthBudgetMs(parts[at + 1]));   // 이 조각이 나오는 동안 다음 조각을 만든다
        if (!q) {
          q = await deps.queue();
          if (!alive()) { q.stop(); return "cancelled"; }
          playing = q; hooks.started?.();
        }
        q.push(got.pcm, got.rate, at === 0 ? 0 : chunkPauseSec(parts[at - 1]));
        touchIdle();
      }
      await q!.idle();
      return alive() ? "played" : "cancelled";
    } catch {
      if (!alive()) return "cancelled";
      if (!q) return "fallback";
      try { await q.idle(); } catch { /* 이미 멈춤 */ }
      return alive() ? (at < parts.length ? { rest: rest(at) } : "played") : "cancelled";
    }
  }

  return { speak, cancel, warm, dispose: () => dispose(true), get state() { return state; }, get cached() { return cache.size; } };
}
export type RaviTts = ReturnType<typeof createRaviTts>;
