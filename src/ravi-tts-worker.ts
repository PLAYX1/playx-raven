// 라비 목소리 워커 — 화면(메인 스레드)을 멈추지 않으려고 무거운 계산은 전부 여기서 한다.
// 모델 바이트는 메인이 Rust 명령으로 읽어 넘겨 준다(워커는 Tauri 명령을 못 쓴다). 네트워크는 쓰지 않는다.
import { synthesize, checkSamples, parseStyle, type TtsRuntime, type TtsConfig, type TtsStyle } from "./ravi-tts-core";

type Models = { dp: Uint8Array; enc: Uint8Array; vec: Uint8Array; voc: Uint8Array; cfg: string; indexer: string; style: string };
type In = { type: "init"; models: Models; base: string } | { type: "speak"; id: number; text: string; steps?: number } | { type: "cancel"; id: number } | { type: "dispose" };

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent<In>) => void) | null };
let rt: TtsRuntime | null = null, cfg: TtsConfig | null = null, indexer: number[] | null = null, style: TtsStyle | null = null;
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

async function init(models: Models, base: string) {
  // ort 는 사본(public/ravi-tts)에서 불러온다 — 같은 출처라 CSP(script-src 'self')를 지킨다.
  const ort = await import(/* @vite-ignore */ `${base}ort.wasm.min.mjs`);
  ort.env.wasm.numThreads = 1; // SharedArrayBuffer 가 없는 웹뷰에서도 돌도록 한 줄기로
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
  const make = (bytes: Uint8Array) => ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  rt = { Tensor: ort.Tensor, dp: await make(models.dp), enc: await make(models.enc), vec: await make(models.vec), voc: await make(models.voc) };
  cfg = JSON.parse(models.cfg); indexer = JSON.parse(models.indexer); style = parseStyle(JSON.parse(models.style));
}

scope.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === "init") { await init(m.models, m.base); scope.postMessage({ type: "ready" }); }
    else if (m.type === "cancel") cancelled.add(m.id);
    else if (m.type === "dispose") { rt = null; cfg = indexer = style = null; scope.postMessage({ type: "disposed" }); }
    else if (m.type === "speak") {
      // 한 번에 한 조각만(같은 ORT 세션을 동시에 돌리지 않는다). 취소된 조각은 차례가 와도 바로 「cancelled」.
      const job = queue.then(async () => {
        if (cancelled.has(m.id)) throw new Error("cancelled");
        if (!rt || !cfg || !indexer || !style) throw new Error("not-ready");
        const t0 = performance.now();
        const r = await synthesize(rt, cfg, indexer, style, m.text, { steps: m.steps, cancelled: () => cancelled.has(m.id) });
        if (cancelled.has(m.id)) throw new Error("cancelled");
        const check = checkSamples(r.samples, r.sampleRate);
        if (!check.ok) throw new Error("bad-sound");
        // Float32 조각을 그대로 넘긴다 — 메인은 WAV 해독 없이 AudioBuffer 에 넣어 이어 튼다.
        const pcm = r.samples.slice();
        scope.postMessage({ type: "done", id: m.id, pcm, rate: r.sampleRate, seconds: r.seconds, ms: Math.round(performance.now() - t0) }, [pcm.buffer]);
      });
      queue = job.catch(() => {});
      await job;
    }
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (m.type === "speak" && msg === "cancelled") { cancelled.delete(m.id); scope.postMessage({ type: "cancelled", id: m.id }); }
    else scope.postMessage({ type: "error", id: (m as { id?: number }).id ?? 0, phase: m.type, message: msg.slice(0, 200) });
  }
};
