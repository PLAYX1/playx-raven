/** Bounded photo pipeline. Errors contain stage names, never native error text.
 * 0.6.4 kept “사진 줄이는 중…” across bitmap decode, toBlob and FileReader.
 * A promise/callback that never settled bypassed catch forever. The report
 * narrows the stall to these pre-upload stages; it cannot identify one of them.
 */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export type PhotoStage = "bitmap" | "image" | "compress" | "data-url" | "preview" | "bytes" | "upload";
export class PhotoFailure extends Error {
  constructor(public stage: PhotoStage, public timedOut: boolean) {
    super(`${stage}:${timedOut ? "timeout" : "failed"}`);
  }
}
export function photoLimit<T>(run: () => Promise<T>, ms: number, stage: PhotoStage): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PhotoFailure(stage, true)), ms);
    // Catch synchronous unsupported APIs too. Late completions cannot update UI.
    Promise.resolve().then(run).then(resolve, e => reject(e instanceof PhotoFailure ? e : new PhotoFailure(stage, false)))
      .finally(() => clearTimeout(timer));
  });
}
type Decoded = { source: CanvasImageSource; width: number; height: number; dispose(): void };
export interface PhotoApi {
  bitmap(file: File): Promise<Decoded>;
  image(file: File, ms: number): Promise<Decoded>;
  canvas(decoded: Decoded): HTMLCanvasElement;
  blob(canvas: HTMLCanvasElement): Promise<Blob>;
  dataBlob(canvas: HTMLCanvasElement): Promise<Blob>;
  preview(blob: Blob, ms: number): Promise<string>;
  bytes(blob: Blob): Promise<ArrayBuffer>;
  upload(file: { name: string; bytes: number[] }): Promise<{ cid?: string }>;
}
export const PHOTO_MESSAGES: Record<PhotoStage, [string, string]> = {
  bitmap: ["사진 디코드(createImageBitmap)에 실패했습니다.", "사진 디코드(createImageBitmap)가 8초 안에 끝나지 않았습니다."],
  image: ["사진 디코드(img.decode)에 실패했습니다.", "사진 디코드(img.decode)가 8초 안에 끝나지 않았습니다."],
  compress: ["사진 압축(toBlob)에 실패했습니다.", "사진 압축(toBlob)이 8초 안에 끝나지 않았습니다."],
  "data-url": ["사진 압축(toDataURL)에 실패했습니다.", "사진 압축(toDataURL)이 8초 안에 끝나지 않았습니다."],
  preview: ["사진 미리보기를 읽지 못했습니다.", "사진 미리보기를 8초 안에 읽지 못했습니다."],
  bytes: ["업로드할 사진 파일을 읽지 못했습니다.", "업로드할 사진 파일을 8초 안에 읽지 못했습니다."],
  upload: ["파일창고에 사진을 올리지 못했습니다. 파일창고가 켜져 있는지 확인해 주세요.", "파일창고 업로드가 30초 안에 끝나지 않았습니다. 파일창고와 연결 상태를 확인해 주세요."],
};
export function photoErrorText(e: unknown): string {
  return e instanceof PhotoFailure ? PHOTO_MESSAGES[e.stage][Number(e.timedOut)] : "사진을 준비하지 못했습니다. 다른 JPG 또는 PNG 사진을 골라 주세요.";
}
export function browserPhotoApi(upload: PhotoApi["upload"]): PhotoApi {
  return {
    async bitmap(file) {
      // WKWebView follows the OS WebKit, not the Tauri version. Blob/File input
      // was implemented separately: https://bugs.webkit.org/show_bug.cgi?id=183247
      // API presence alone cannot prove File decoding works on the installed OS.
      // File is a Blob input under the HTML standard; modern Edge/WebView2 is
      // expected to support it. Do not invent a Windows File-support defect:
      // https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap
      const b = await createImageBitmap(file);
      return { source: b, width: b.width, height: b.height, dispose: () => b.close() };
    },
    async image(file, ms) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      try {
        img.src = url;
        await photoLimit(() => img.decode(), ms, "image");
        return { source: img, width: img.naturalWidth, height: img.naturalHeight, dispose: () => { img.src = ""; } };
      } catch (e) {
        img.src = "";
        throw e;
      } finally { URL.revokeObjectURL(url); }
    },
    canvas(decoded) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx || !decoded.width || !decoded.height) throw new PhotoFailure("compress", false);
      const side = Math.min(decoded.width, decoded.height);
      ctx.drawImage(decoded.source, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side, 0, 0, 512, 512);
      return canvas;
    },
    blob(canvas) {
      // toBlob may yield null/throw (encoding/security failures), or its callback
      // may be queued: https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob
      // may be delayed. WebKit support history: https://bugs.webkit.org/show_bug.cgi?id=148878
      // WebView2 uses Edge's platform capabilities, not its SDK version:
      // https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
      // Chromium uses queued/idle encoding with its own fallback timers; no claim
      // of a Windows-only bug: https://chromium.googlesource.com/chromium/src/+/828932702391775d9b4696c8a5f67f749690fd39/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc
      return new Promise((resolve, reject) => canvas.toBlob(b => b?.size ? resolve(b) : reject(new PhotoFailure("compress", false)), "image/jpeg", 0.82));
    },
    async dataBlob(canvas) {
      // Synchronous fallback is bounded in pixel count (512²); a JS timer cannot
      // preempt native synchronous code. Reject the empty-canvas "data:," result.
      const data = canvas.toDataURL("image/jpeg", 0.82);
      const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(data);
      if (!match) throw new PhotoFailure("data-url", false);
      const raw = atob(match[2]);
      return new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))], { type: match[1] });
    },
    preview(blob, ms) {
      const reader = new FileReader();
      return photoLimit(() => new Promise<string>((resolve, reject) => {
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new PhotoFailure("preview", false));
        reader.onerror = reader.onabort = () => reject(new PhotoFailure("preview", false));
        reader.readAsDataURL(blob);
      }), ms, "preview").finally(() => { if (reader.readyState === FileReader.LOADING) reader.abort(); });
    },
    bytes: blob => blob.arrayBuffer(), upload,
  };
}

export async function uploadArtistPhoto(file: File, api: PhotoApi,
  progress: (message: string) => void, preview: (data: string) => void,
  limits = { decode: 8000, compress: 8000, read: 8000, upload: 30000 }) {
  if (file.size > PHOTO_MAX_BYTES) throw new Error("사진이 너무 큽니다. 8MB 아래로 골라 주세요.");
  const type = file.type || (/\.png$/i.test(file.name) ? "image/png" : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "");
  if (!["image/jpeg", "image/png"].includes(type)) throw new Error("JPG 또는 PNG 사진을 골라 주세요.");
  const diagnostics: PhotoFailure[] = [];
  let blob: Blob = file;
  let original = true;
  let decoded: Decoded | undefined;
  const note = (e: unknown, stage: PhotoStage) => diagnostics.push(e instanceof PhotoFailure ? e : new PhotoFailure(stage, false));
  const decode = async (run: () => Promise<Decoded>, stage: "bitmap" | "image") => {
    let expired = false;
    try {
      return await photoLimit(() => run().then(b => { if (expired) b.dispose(); return b; }), limits.decode, stage);
    } catch (e) { expired = true; throw e; }
  };
  try {
    progress("사진 읽는 중…");
    try {
      // Dispose either decoder's result even if it resolves after the timeout.
      decoded = await decode(() => api.bitmap(file), "bitmap");
    } catch (e) {
      note(e, "bitmap");
      progress("다른 방법으로 사진 읽는 중…");
      decoded = await decode(() => api.image(file, limits.decode), "image");
    }
    progress("사진 줄이는 중…");
    if (!decoded) throw new PhotoFailure("image", false);
    const canvas = api.canvas(decoded);
    try { blob = await photoLimit(() => api.blob(canvas), limits.compress, "compress"); }
    catch (e) {
      note(e, "compress");
      progress("다른 방법으로 사진 줄이는 중…");
      blob = await photoLimit(() => api.dataBlob(canvas), limits.compress, "data-url");
    }
    if (!blob.size || blob.size > PHOTO_MAX_BYTES || !["image/jpeg", "image/png"].includes(blob.type)) throw new PhotoFailure("compress", false);
    original = false;
  } catch (e) { note(e, decoded ? "compress" : "image"); blob = file; }
  finally { decoded?.dispose(); }
  if (original) progress("사진을 줄이지 못해 원본 JPG/PNG를 올립니다.");
  progress("사진 미리보기 읽는 중…");
  // A broken preview must not prevent upload. Show its safe diagnostic afterwards.
  try { preview(await photoLimit(() => api.preview(blob, limits.read), limits.read, "preview")); }
  catch (e) { note(e, "preview"); }
  progress("업로드할 사진 파일 읽는 중…");
  const bytes = new Uint8Array(await photoLimit(() => api.bytes(blob), limits.read, "bytes"));
  if (original && !(type === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))) throw new PhotoFailure("bytes", false);
  progress("파일창고에 올리는 중…");
  const name = (original ? type : blob.type) === "image/png" ? "face.png" : "face.jpg";
  const added = await photoLimit(() => api.upload({ name, bytes: Array.from(bytes) }), limits.upload, "upload");
  const cid = String(added?.cid || "");
  if (!cid) throw new PhotoFailure("upload", false);
  return { cid, size: blob.size, original, diagnostics };
}
