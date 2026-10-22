import type { RaviTtsDeps, WorkerLike } from "./ravi-tts";

/** 진짜 환경에서 쓰는 의존물(워커·소리 재생). 시험은 가짜를 넣는다. */
export function realDeps(invoke: RaviTtsDeps["invoke"]): RaviTtsDeps {
  return {
    invoke,
    base: new URL("./ravi-tts/", document.baseURI).href,
    newWorker: () => new Worker(new URL("./ravi-tts-worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    async play(wav) {
      const url = URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" }));
      const audio = new Audio(url);
      let finish!: () => void; const ended = new Promise<void>(r => { finish = r; });
      audio.onended = audio.onerror = () => { finish(); URL.revokeObjectURL(url); };
      await audio.play(); // 막히면 던져서 폴백으로
      return { ended, stop() { audio.onended = audio.onerror = null; audio.pause(); URL.revokeObjectURL(url); finish(); } };
    },
  };
}
