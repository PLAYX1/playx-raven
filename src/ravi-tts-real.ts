import type { AudioQueue, RaviTtsDeps, WorkerLike } from "./ravi-tts";

// 웹 오디오: 조각을 AudioBufferSourceNode 로 「앞 조각 끝 + 쉼」 시각에 예약해 끊김 없이 잇는다(폰 웹 real-deps.ts 와 같은 방식).
let ctx: AudioContext | null = null;
function audioContext(): AudioContext | null {
  try {
    if (ctx && ctx.state !== "closed") return ctx;
    const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const C = g.AudioContext ?? g.webkitAudioContext;
    return ctx = C ? new C({ latencyHint: "interactive" }) : null;
  } catch { return null; }
}
function webAudioQueue(c: AudioContext): AudioQueue {
  const live = new Set<AudioBufferSourceNode>(); let end = 0, stopped = false; const waiters: (() => void)[] = [];
  const settle = () => { if (stopped || live.size === 0) waiters.splice(0).forEach(w => w()); };
  return {
    push(pcm, rate, pause) {
      if (stopped) return;
      const buf = c.createBuffer(1, pcm.length, rate); buf.getChannelData(0).set(pcm);
      const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
      const when = Math.max(c.currentTime + 0.03, end ? end + pause : 0);
      src.onended = () => { live.delete(src); try { src.disconnect(); } catch { /* 이미 끊김 */ } settle(); };
      live.add(src); src.start(when); end = when + buf.duration;
    },
    idle: () => new Promise<void>(r => { waiters.push(r); settle(); }),
    stop() { stopped = true; for (const src of live) { src.onended = null; try { src.stop(); src.disconnect(); } catch { /* 이미 멈춤 */ } } live.clear(); settle(); },
  };
}

// 오디오 요소(웹 오디오가 막힌 웹뷰): 조각을 WAV 로 차례로 하나씩 튼다(옛 방식과 같은 재생 경로).
function wavBytes(pcm: ArrayLike<number>, rate: number): Uint8Array {
  const n = pcm.length, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer); const t = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  t(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); t(8, "WAVE"); t(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); t(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return b;
}
function elementQueue(): AudioQueue {
  let chain = Promise.resolve(), count = 0, stopped = false, stopNow: (() => void) | null = null; const waiters: (() => void)[] = [];
  const settle = () => { if (stopped || count === 0) waiters.splice(0).forEach(w => w()); };
  const playOne = (pcm: Float32Array, rate: number, pause: number) => new Promise<void>(resolve => {
    const go = () => {
      if (stopped) return resolve();
      const url = URL.createObjectURL(new Blob([wavBytes(pcm, rate) as BlobPart], { type: "audio/wav" })), a = new Audio(url);
      const done = () => { a.onended = a.onerror = null; stopNow = null; URL.revokeObjectURL(url); resolve(); };
      stopNow = () => { a.pause(); done(); };
      a.onended = a.onerror = done; a.play().catch(done);
    };
    if (stopped) resolve(); else if (pause > 0) setTimeout(go, pause * 1000); else go();
  });
  return {
    push(pcm, rate, pause) { count++; chain = chain.then(() => playOne(pcm, rate, pause)).finally(() => { count--; settle(); }); },
    idle: () => new Promise<void>(r => { waiters.push(r); settle(); }),
    stop() { stopped = true; stopNow?.(); settle(); },
  };
}
// 웹뷰가 「누른 뒤에만 소리」 규칙이면: 아무 누름(묻기·단추)에서나 웹 오디오를 깨워 둔다. 한 번 깨면 계속 쓴다.
let wakeHooked = false;
function hookWake() {
  if (wakeHooked || typeof document === "undefined") return; wakeHooked = true;
  const wake = () => { const c = audioContext(); if (c && c.state !== "running") void c.resume().catch(() => {}); };
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, wake, { capture: true, passive: true });
}

/** 진짜 환경에서 쓰는 의존물(워커·소리 재생). 시험은 가짜를 넣는다. */
export function realDeps(invoke: RaviTtsDeps["invoke"]): RaviTtsDeps {
  hookWake();
  return {
    invoke,
    base: new URL("./ravi-tts/", document.baseURI).href,
    newWorker: () => new Worker(new URL("./ravi-tts-worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    async queue() {
      hookWake();
      const c = audioContext();
      if (c && c.state !== "running") { try { await Promise.race([c.resume(), new Promise(r => setTimeout(r, 300))]); } catch { /* 아래에서 판단 */ } }
      return c && c.state === "running" ? webAudioQueue(c) : elementQueue();   // 웹 오디오가 막힌 웹뷰는 옛 재생 경로(오디오 요소)
    },
  };
}
