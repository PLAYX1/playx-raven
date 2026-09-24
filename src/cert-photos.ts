/**
 * 증서 사진 — 명단 줄과 사진 파일 짝짓기 + 증명사진(3×4 cm 칸 = 3:4 세로) 자르기·줄이기.
 *
 * 사진은 이 기기 밖으로 나가지 않는다(네트워크 없음). 디코딩·자르기·압축 모두 웹뷰 캔버스에서.
 *
 * 짝짓기 규칙(한 줄 = 사진 하나, 예측 가능하게):
 *   1) 「사진 파일명」 칸이 있으면 그 이름으로 찾는다(확장자는 있어도 없어도 된다).
 *   2) 칸이 비어 있으면 받는 사람 이름으로 찾는다(사진을 사람 이름으로 저장하는 일이 흔하다).
 *   3) 같은 이름표(photoKey)의 파일이 둘 이상이면 고르지 않고 「헷갈림」으로 돌려준다.
 *   4) 같은 사진 하나를 여러 줄이 써도 된다(한 사람이 여러 과정 수료 등).
 */

/** 사진으로 받는 확장자. HEIC/HEIF 는 이름으로는 받되, 읽기는 엔진마다 다르다(아래 preparePhoto). */
const IMAGE_EXT = /\.(jpe?g|png|webp|hei[cf]|gif|bmp|tiff?)$/i;

/** 경로에서 파일 이름만. 윈도우(\)·맥(/) 둘 다. */
function baseName(name: string): string {
  return name.replace(/^.*[\\/]/, "");
}

/**
 * 짝짓기용 이름표.
 * 🔴 맥 Finder 는 한글 파일명을 NFD(자모 분리)로 주고 엑셀 칸은 NFC 다 — 둘 다 NFC 로 맞춘다.
 * 경로·확장자 하나를 떼고, 소문자·앞뒤 공백 제거·연속 공백 하나로. "_" "-" 는 그대로 둔다.
 */
export function photoKey(name: string): string {
  const base = baseName(String(name ?? "").normalize("NFC")).trim();
  return base.replace(IMAGE_EXT, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 사진 확장자인가. */
export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(String(name ?? "").normalize("NFC").trim());
}

/** 확장자까지 붙은 이름 비교용(이름표와 같은 손질, 확장자만 남긴다). */
function fullName(name: string): string {
  return baseName(String(name ?? "").normalize("NFC")).trim().toLowerCase().replace(/\s+/g, " ");
}

/** 숨김 파일(.DS_Store, 맥이 USB·압축에 남기는 "._사진.jpg")은 사진이 아니다. */
function isHiddenName(name: string): boolean {
  return baseName(String(name ?? "").normalize("NFC")).trim().startsWith(".");
}

export type PhotoMatch = {
  /** 줄마다 짝지은 파일 번호. 못 찾았거나 헷갈리면 -1. */
  fileOfRow: number[];
  /** 파일마다 그 사진을 쓰는 줄 번호들(같은 사진을 여러 줄이 쓸 수 있다). */
  rowsOfFile: number[][];
  /** 어느 줄과도 짝이 안 된 사진 파일(사진 아닌 파일·숨김 파일은 빼고). */
  unmatchedFiles: number[];
  /** 같은 이름표의 사진이 둘 이상이라 고르지 않은 줄. */
  ambiguousRows: number[];
};

/** 명단 줄과 사진 파일을 짝짓는다. 사진 아닌 파일은 짝짓지도, 남은 것으로 알리지도 않는다. */
export function matchPhotos(rows: { recipient: string; photo: string }[], files: { name: string }[]): PhotoMatch {
  const byKey = new Map<string, number[]>();
  const usable: boolean[] = files.map(f => isImageName(f.name) && !isHiddenName(f.name));
  files.forEach((f, i) => {
    if (!usable[i]) return;
    const key = photoKey(f.name);
    if (!key) return;
    const list = byKey.get(key);
    if (list) list.push(i); else byKey.set(key, [i]);
  });

  const fileOfRow: number[] = [];
  const rowsOfFile: number[][] = files.map(() => []);
  const ambiguousRows: number[] = [];
  rows.forEach((row, r) => {
    const cell = String(row.photo ?? "").trim();
    const key = photoKey(cell || String(row.recipient ?? ""));
    let hits = key ? byKey.get(key) ?? [] : [];
    // 칸에 확장자까지 적었으면(홍길동.jpg) 이름이 똑같은 파일 하나는 헷갈림이 아니다.
    if (hits.length > 1 && isImageName(cell)) {
      const same = hits.filter(i => fullName(files[i].name) === fullName(cell));
      if (same.length === 1) hits = same;
    }
    if (hits.length === 1) {
      fileOfRow.push(hits[0]);
      rowsOfFile[hits[0]].push(r);
    } else {
      fileOfRow.push(-1);
      if (hits.length > 1) ambiguousRows.push(r);
    }
  });

  const unmatchedFiles = files.map((_, i) => i).filter(i => usable[i] && rowsOfFile[i].length === 0);
  return { fileOfRow, rowsOfFile, unmatchedFiles, ambiguousRows };
}

/** "사진2" 가 "사진10" 앞에 오게(숫자는 숫자로). */
const NATURAL = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

/**
 * 끌어다 놓은/고른 파일에서 사진만, 이름순(자연 정렬)으로.
 * 폴더째 고르면(webkitRelativePath) .DS_Store·__MACOSX·숨김 폴더 속 파일은 뺀다.
 */
export function pickedFiles(list: FileList | File[]): File[] {
  const rel = (f: File) => String((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").normalize("NFC");
  const inHiddenFolder = (f: File) => {
    // 첫 칸은 사람이 고른 폴더 자체라 따지지 않는다.
    const parts = rel(f).split(/[\\/]/).slice(1, -1);
    return parts.some(p => p.startsWith(".") || p === "__MACOSX");
  };
  return Array.from(list as ArrayLike<File>)
    .filter(f => isImageName(f.name) && !isHiddenName(f.name) && !inHiddenFolder(f))
    .sort((a, b) =>
      NATURAL.compare(a.name.normalize("NFC"), b.name.normalize("NFC"))
      || NATURAL.compare(rel(a), rel(b))
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type PhotoOptions = {
  /** 긴 변 픽셀. 기본 800(3:4 이면 600×800 — 3×4 cm 를 인쇄해도 500dpi 넘게). */
  longSide?: number;
  /** 가로/세로. 기본 3/4(세로 증명사진). */
  aspect?: number;
  /** JPEG/WebP 품질 0~1. 기본 0.85. */
  quality?: number;
  /** 내보낼 형식. 기본 "image/jpeg". 엔진이 못 만드는 형식이면 엔진이 PNG 로 대신 준다(dataUrl 머리에 드러남). */
  mime?: string;
};

export type PreparedPhoto = {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** 얼굴을 찾아 그 얼굴에 맞춰 잘랐으면 true. 못 찾았거나 기능이 없으면 false(어림 자르기). */
  faceCentered: boolean;
};

const READ_FAIL = "이 사진 형식을 읽지 못했어요(HEIC 는 JPG 로 바꿔 주세요)";

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

/** 사진을 읽는다. EXIF 회전(폰 사진이 눕는 문제)을 따른다. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (bmp.width > 0 && bmp.height > 0) return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      bmp.close();
    } catch {
      // 옛 WebKit 은 이 옵션을 모른다 → <img> 로 다시(<img> 는 EXIF 회전을 기본으로 따른다).
    }
  }
  if (typeof Image !== "function" || typeof URL === "undefined") throw new Error(READ_FAIL);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, no) => {
      img.onload = () => ok();
      img.onerror = () => no(new Error(READ_FAIL));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error(READ_FAIL);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(READ_FAIL);
  }
}

type Box = { x: number; y: number; w: number; h: number };

/** 얼굴 찾기(Shape Detection API). 있는 엔진이 드물다 — 없거나 실패하면 null, 절대 던지지 않는다. */
async function findFace(source: CanvasImageSource, width: number, height: number): Promise<Box | null> {
  const FD = (globalThis as { FaceDetector?: new (o?: object) => { detect(s: unknown): Promise<{ boundingBox: DOMRectReadOnly }[]> } }).FaceDetector;
  if (typeof FD !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const detector = new FD({ fastMode: true, maxDetectedFaces: 5 });
    // 드물게 대답이 없는 엔진이 있어 오래 기다리지 않는다.
    const faces = await Promise.race([
      detector.detect(source),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timeout")), 3000); }),
    ]);
    let best: Box | null = null;
    for (const f of faces ?? []) {
      const b = f?.boundingBox;
      if (!b || !(b.width > 0) || !(b.height > 0) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      if (cx < 0 || cy < 0 || cx > width || cy > height) continue;
      if (!best || b.width * b.height > best.w * best.h) best = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 비율에 맞는 가장 큰 자르기 칸.
 * 얼굴이 있으면 얼굴 가운데를 가로 한가운데·세로 40% 에 둔다.
 * 없으면 가로는 한가운데, 세로는 남는 높이의 15% 지점부터(사람 머리는 사진 위쪽에 있다).
 */
function cropBox(iw: number, ih: number, aspect: number, face: Box | null): Box {
  const w = iw / ih > aspect ? ih * aspect : iw;
  const h = w / aspect;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max, 0));
  if (face) {
    const cx = face.x + face.w / 2, cy = face.y + face.h / 2;
    return { x: clamp(cx - w / 2, iw - w), y: clamp(cy - h * 0.4, ih - h), w, h };
  }
  return { x: (iw - w) / 2, y: (ih - h) * 0.15, w, h };
}

type Ctx = CanvasDrawImage & CanvasFillStrokeStyles & CanvasImageSmoothing & CanvasRect;
type Surface = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx };

/** 그림판. OffscreenCanvas 가 2D 를 못 주는 옛 WebKit(16.4 전)이면 문서 캔버스로. */
function surface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (ctx) return { canvas, ctx };
    } catch { /* 아래로 */ }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("사진을 줄일 그림판을 만들지 못했어요");
  return { canvas, ctx };
}

function smooth(ctx: Ctx) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

/** 큰 캔버스는 WebKit 이 메모리를 늦게 돌려준다 — 수백 장을 줄이니 다 쓰면 바로 비운다. */
function release(s: Surface) {
  s.canvas.width = 0;
  s.canvas.height = 0;
}

function exportBlob(s: Surface, mime: string, quality: number): Promise<Blob> {
  const c = s.canvas;
  if ("convertToBlob" in c) return c.convertToBlob({ type: mime, quality });
  return new Promise((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error("사진을 저장하지 못했어요"))), mime, quality));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(new Error("사진을 저장하지 못했어요"));
    r.readAsDataURL(blob);
  });
}

/**
 * 사진 하나 → 증명사진(기본 600×800 JPEG). 수백 장이면 한 장씩 차례로 부른다(메모리).
 * 작은 사진은 키우지 않는다. 투명 PNG 는 흰 바탕에 얹는다.
 */
export async function preparePhoto(file: Blob, opts: PhotoOptions = {}): Promise<PreparedPhoto> {
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 3 / 4;
  const longSide = opts.longSide && opts.longSide > 0 ? opts.longSide : 800;
  const quality = opts.quality ?? 0.85;
  const mime = opts.mime || "image/jpeg";

  const img = await decode(file);
  const temps: Surface[] = [];
  try {
    const face = await findFace(img.source, img.width, img.height);
    const crop = cropBox(img.width, img.height, aspect, face);
    const targetW = aspect <= 1 ? longSide * aspect : longSide;
    const scale = Math.min(1, targetW / crop.w);
    const outW = Math.max(1, Math.round(crop.w * scale));
    const outH = Math.max(1, Math.round(outW / aspect));

    // 한 번에 크게 줄이면 WebKit 에서 계단(앨리어싱)이 생긴다 → 두 배씩 줄여 내려온다(중간판은 최대 4배까지만).
    let steps = 0;
    while (steps < 2 && outW * 2 ** (steps + 1) < crop.w) steps++;
    let src: CanvasImageSource = img.source;
    let sx = crop.x, sy = crop.y, sw = crop.w, sh = crop.h;
    for (let k = steps; k >= 1; k--) {
      const s = surface(outW * 2 ** k, outH * 2 ** k);
      smooth(s.ctx);
      s.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, s.canvas.width, s.canvas.height);
      temps.push(s);
      src = s.canvas;
      sx = 0; sy = 0; sw = s.canvas.width; sh = s.canvas.height;
    }
    const out = surface(outW, outH);
    temps.push(out);
    out.ctx.fillStyle = "#fff";
    out.ctx.fillRect(0, 0, outW, outH);
    smooth(out.ctx);
    out.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, outW, outH);

    const blob = await exportBlob(out, mime, quality);
    return { dataUrl: await blobToDataUrl(blob), width: outW, height: outH, bytes: blob.size, faceCentered: !!face };
  } finally {
    img.close();
    temps.forEach(release);
  }
}
