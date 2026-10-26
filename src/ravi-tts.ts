// 라비 목소리 관리자 — 메인 스레드 쪽. 모델 읽기 → 워커 → 소리 재생, 그리고 **실패하면 늘 「폴백」을 돌려준다**
// (부른 쪽이 기기 목소리로 말한다: 라비는 항상 말할 수 있어야 한다).
// 가짜(주입) 의존물로 시험한다: scripts/ravi-tts.test.mjs

export type TtsResult = "played" | "fallback" | "cancelled";
export interface WorkerLike {
  postMessage(m: unknown, t?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export interface PlayHandle { ended: Promise<void>; stop(): void }
export interface RaviTtsDeps {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  newWorker(): WorkerLike;
  play(wav: Uint8Array): Promise<PlayHandle>;
  base: string;
  setTimer?(fn: () => void, ms: number): number;
  clearTimer?(id: number): void;
}
export const CHUNK = 16 * 1024 * 1024;
export const IDLE_DISPOSE_MS = 5 * 60 * 1000;
export const LOAD_TIMEOUT_MS = 60_000;
/** 이 글에 허용하는 만드는 시간. 6초 분량 문장을 10초 안에가 목표이니 여유를 두되 끝없이 기다리지 않는다. */
export function synthBudgetMs(text: string): number { return Math.min(40_000, 12_000 + text.length * 300); }
const CACHE_MAX = 12;

export function createRaviTts(deps: RaviTtsDeps) {
  const setT = deps.setTimer ?? ((f, ms) => setTimeout(f, ms) as unknown as number), clrT = deps.clearTimer ?? (id => clearTimeout(id));
  let state: "idle" | "loading" | "ready" | "unavailable" = "idle", worker: WorkerLike | null = null, loading: Promise<boolean> | null = null;
  let epoch = 0, nextId = 1, playing: PlayHandle | null = null, idleTimer = 0, strikes = 0;
  const cache = new Map<string, Uint8Array>();
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

  async function speak(text: string, hooks: { started?(): void } = {}): Promise<TtsResult> {
    cancel(); const mine = epoch; const alive = () => mine === epoch;
    const clean = text.trim(); if (!clean) return "cancelled";
    try {
      let wav = cache.get(clean);
      if (wav) { cache.delete(clean); cache.set(clean, wav); } // 가장 최근으로
      else {
        if (!(await warm()) || !alive()) return alive() ? "fallback" : "cancelled";
        const id = nextId++, w = worker; if (!w) return "fallback";
        const reply = await new Promise<any>(resolve => {
          pending.set(id, resolve);
          const timer = setT(() => { if (pending.delete(id)) { w.postMessage({ type: "cancel", id }); resolve({ type: "error", message: "slow" }); } }, synthBudgetMs(clean));
          const original = resolve; pending.set(id, m => { clrT(timer); original(m); });
          w.postMessage({ type: "speak", id, text: clean });
        });
        if (!alive()) return "cancelled";
        if (reply.type === "cancelled") return "cancelled";
        if (reply.type !== "done" || !(reply.wav instanceof Uint8Array)) {
          if (reply.message === "slow") { if (++strikes >= 2) markUnavailable(); } // 두 번 느리면 이번 실행은 기기 목소리로
          return "fallback";
        }
        strikes = 0; wav = reply.wav as Uint8Array; cache.set(clean, wav);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        touchIdle();
      }
      const handle = await deps.play(wav);
      if (!alive()) { handle.stop(); return "cancelled"; }
      playing = handle; hooks.started?.();
      await handle.ended;
      return alive() ? "played" : "cancelled";
    } catch {
      return alive() ? "fallback" : "cancelled";
    }
  }

  return { speak, cancel, warm, dispose: () => dispose(true), get state() { return state; }, get cached() { return cache.size; } };
}
export type RaviTts = ReturnType<typeof createRaviTts>;
