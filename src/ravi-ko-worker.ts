// 라비 작은 목소리(한국어 ko-v2, 19MB) 워커 — 무거운 계산을 화면 밖에서.
// 모델은 앱 안 정적 파일(public/ravi-tts/ravi-ko-v2.int8.onnx)이라 내려받기·동의가 필요 없다. 네트워크는 쓰지 않는다(같은 출처 파일만).
// 메시지 약속은 ravi-tts-worker.ts 와 같다(init → ready, speak → done/cancelled/error) — 관리자(ravi-tts.ts)를 그대로 쓴다.
import { checkSamples } from "./ravi-tts-core";
import { textToKoIds } from "./ravi-ko-g2p";

export const RAVI_KO_MODEL = "ravi-ko-v2.int8.onnx";
const RATE = 22050;
// 대표가 귀로 고른 비교본과 같은 값(noise_scale·length_scale·noise_w).
const SCALES = [0.5, 1.0, 0.333];

type In = { type: "init"; base: string } | { type: "speak"; id: number; text: string } | { type: "cancel"; id: number } | { type: "dispose" };
type Ort = { Tensor: new (type: string, data: unknown, dims: number[]) => unknown; InferenceSession: { create(b: Uint8Array, o: unknown): Promise<Session> } };
type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>; outputNames?: string[] };

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent<In>) => void) | null };
let ort: Ort | null = null, session: Session | null = null;
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

async function init(base: string) {
  const mod = await import(/* @vite-ignore */ `${base}ort.wasm.min.mjs`);
  mod.env.wasm.numThreads = 1; mod.env.wasm.proxy = false;
  mod.env.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
  const res = await fetch(`${base}${RAVI_KO_MODEL}`);
  if (!res.ok) throw new Error(`model ${res.status}`);
  ort = mod as Ort;
  session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
}

async function synth(text: string): Promise<Float32Array> {
  const ids = textToKoIds(text);
  if (ids.length <= 5) throw new Error("empty");
  const o = ort!, feeds = {
    input: new o.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new o.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new o.Tensor("float32", Float32Array.from(SCALES), [3]),
  };
  const out = await session!.run(feeds);
  const first = out[session!.outputNames?.[0] ?? Object.keys(out)[0]];
  return Float32Array.from(first.data);
}

scope.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === "init") { await init(m.base); scope.postMessage({ type: "ready" }); }
    else if (m.type === "cancel") cancelled.add(m.id);
    else if (m.type === "dispose") { session = null; ort = null; scope.postMessage({ type: "disposed" }); }
    else if (m.type === "speak") {
      const job = queue.then(async () => {
        if (cancelled.has(m.id)) throw new Error("cancelled");
        if (!session) throw new Error("not-ready");
        const t0 = performance.now();
        const pcm = await synth(m.text);
        if (cancelled.has(m.id)) throw new Error("cancelled");
        if (!checkSamples(pcm, RATE).ok) throw new Error("bad-sound");
        scope.postMessage({ type: "done", id: m.id, pcm, rate: RATE, seconds: pcm.length / RATE, ms: Math.round(performance.now() - t0) }, [pcm.buffer]);
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
