import { canonicalJson, plain, sha256Hex, utf8, type Loose } from '../core/creator/bytes';
import { COVER_EXT, LIMITS, MIME_BY_EXT, extOf, safePath, type ContentType, type FileInput } from '../core/creator/limits';
import {
  CID_V0, CreatorError, MANIFEST_SIGN_DOMAIN, MANIFEST_SIGN_SCHEME, MAX_MANIFEST_BYTES, MAX_PREVIEW_MS, recoverMessageAddress, validateManifest, verifyManifest,
  type CreatorManifest, type FileEntry, type MusicSection, type UnsignedManifest,
} from '../core/creator/manifest';
import { mockCid, type MessageSigner, type PinAdapter, type PinCache, type PublishInput, publishContent } from '../core/creator/publish';
import { checkFiles } from '../core/creator/limits';
import { safeText, validateLook, type Look } from './drop-look';
import type { MusicFormat } from './drop-detect';
import { validateGenre, type GenreValue } from './drop-genre';

/*
 * 매니페스트 확장 v3(제안) — 꾸밈(look)과 음악 곡 목록(music)을 「검증 가능한 안전한 칸」으로 더한다.
 *
 * 🔴 왜 core/creator 를 안 고치고 여기 두나
 *    core/creator/* 는 지갑 저장소에서 바이트 그대로 복사한 것이고(vendor-sha256.json 이 고정), v2 검사기는 모르는 칸을 전부 거절한다.
 *    구매자 지갑이 v3 를 읽기 전에 v3 를 체인에 올리면 그 상품은 구매자 화면에서 「형식 오류」가 된다.
 *    그래서 순서는: (1) 이 파일로 v3 모양·검사·시험을 확정 → (2) 지갑 저장소 core/creator/manifest.ts 에 같은 규칙을 넣고 시험
 *    → (3) 양쪽 vendor-sha256.json 갱신·복사 → (4) DROP_MANIFEST_V3_ENABLED 를 켠다. 그 전까지 발행은 v2 그대로다
 *    (꾸밈·곡 목록은 판매자 화면 미리보기와 초안에만 있고 구매자에게는 아직 안 보인다 — 화면이 그렇게 말한다).
 *
 * v3 = v2 의 모든 칸(검사도 v2 검사기를 그대로 부른다) + 세 칸(genre 는 drop-genre.ts — { main: 종류별 고정 id | null, tags ≤3 }):
 *   look : { template, theme, tagline, tags[], coverImage, background, gallery[], images[] } | null
 *          images = 꾸밈 전용 그림(FileEntry, 최대 8장·각 5MB·PNG/JPG/WEBP). 표지·배경·갤러리는 경로로만 가리킨다.
 *   music: { format: single|ep|album, tracks: [{ title, file, durationMs, preview{startMs,endMs}|null }] } | null   (type=music 일 때 필수)
 *          모든 소리 파일이 tracks 에 정확히 한 번(순서 = 앨범 곡 순서). v2 details.previewFile 은 미리듣기가 있는 첫 곡과 같아야 한다.
 * 서명 도메인은 V3 로 바꾼다(v2 서명과 섞이지 않게). v2 매니페스트는 그대로 읽힌다(readManifestAny).
 */

export const MANIFEST_V3 = 3;
export const MANIFEST_SIGN_DOMAIN_V3 = 'RAVENVAULT-CREATOR-MANIFEST-V3';
/** 🔴 v3 발행 스위치. 지갑 저장소가 v3 를 읽게 되고 vendor SHA 를 갱신한 뒤에만 켠다(대표·지갑 담당 결정). */
export const DROP_MANIFEST_V3_ENABLED = false;

export type Track = { title: string; file: string; durationMs: number | null; preview: { startMs: number; endMs: number } | null };
export type MusicExt = { format: MusicFormat; tracks: Track[] };
export type LookExt = Look & { images: FileEntry[] };
export type UnsignedV3 = Omit<UnsignedManifest, 'version'> & { version: typeof MANIFEST_V3; look: LookExt | null; music: MusicExt | null; genre: GenreValue | null };
export type SignatureV3 = { scheme: typeof MANIFEST_SIGN_SCHEME; domain: typeof MANIFEST_SIGN_DOMAIN_V3; address: string; value: string };
export type ManifestV3 = UnsignedV3 & { signature: SignatureV3 };

const fail = (detail: string): never => { throw new CreatorError('manifest-shape', 'v3-' + detail); };
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const TRACK_COUNT: Readonly<Record<MusicFormat, [number, number]>> = Object.freeze({ single: [1, 3], ep: [2, 6], album: [4, 20] });
const DUMMY_V2_SIG = { scheme: MANIFEST_SIGN_SCHEME, domain: MANIFEST_SIGN_DOMAIN, address: '', value: '' };

function checkImageEntry(f: unknown): FileEntry {
  if (!plain(f) || Object.keys(f).sort().join() !== 'cid,mime,path,sha256,size') fail('image-keys');
  const e = f as Loose;
  if (!safePath(e.path) || typeof e.cid !== 'string' || !CID_V0.test(e.cid) || typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) fail('image-format');
  const ext = extOf(e.path);
  if (!COVER_EXT.has(ext) || MIME_BY_EXT[ext] !== e.mime || !int(e.size, 1, LIMITS.cover.maxFileBytes)) fail('image-type');
  return e as FileEntry;
}

function checkMusic(m: unknown, base: CreatorManifest): MusicExt {
  if (!plain(m) || Object.keys(m).sort().join() !== 'format,tracks') fail('music-keys');
  const x = m as Loose;
  if (!['single', 'ep', 'album'].includes(x.format)) fail('music-format');
  const [lo, hi] = TRACK_COUNT[x.format as MusicFormat];
  if (!Array.isArray(x.tracks) || x.tracks.length < lo || x.tracks.length > hi) fail('music-count');
  const audio = base.files.map(f => f.path);
  const seen = new Set<string>();
  for (const t of x.tracks as unknown[]) {
    if (!plain(t) || Object.keys(t).sort().join() !== 'durationMs,file,preview,title') fail('track-keys');
    const tr = t as Loose;
    if (!safeText(tr.title, 1, 80) || tr.title.trim() !== tr.title) fail('track-title');
    if (typeof tr.file !== 'string' || !audio.includes(tr.file) || seen.has(tr.file)) fail('track-file');
    seen.add(tr.file);
    if (tr.durationMs !== null && !int(tr.durationMs, 1, 24 * 3600_000)) fail('track-duration');
    if (tr.preview !== null) {
      if (!plain(tr.preview) || Object.keys(tr.preview).sort().join() !== 'endMs,startMs') fail('track-preview');
      const p = tr.preview as Loose;
      if (!int(p.startMs, 0, 24 * 3600_000) || !int(p.endMs, p.startMs + 1000, p.startMs + MAX_PREVIEW_MS)) fail('track-preview-range');
      if (tr.durationMs !== null && p.endMs > tr.durationMs + 1000) fail('track-preview-past-end');
    }
  }
  if (seen.size !== audio.length) fail('track-missing');
  const d = base.details as MusicSection;
  const firstPreview = (x.tracks as Track[]).find(t => t.preview);
  if (!firstPreview || firstPreview.file !== d.previewFile || firstPreview.preview!.startMs !== d.previewStartMs || firstPreview.preview!.endMs !== d.previewEndMs) fail('music-v2-preview');
  return x as MusicExt;
}

/** v3 엄격 검사. v2 칸은 v2 검사기(core)를 그대로 부르고, 더한 두 칸만 여기서 본다. 서명은 보지 않는다. */
export function validateManifestV3(raw: unknown, prefix?: string): ManifestV3 {
  if (!plain(raw)) return fail('shape');
  const r = raw as Loose;
  if (r.version !== MANIFEST_V3) fail('version');
  const { look, music, genre, signature, ...rest } = r;
  if (!('look' in r) || !('music' in r) || !('genre' in r)) fail('keys');
  const base = validateManifest({ ...rest, version: 2, signature: DUMMY_V2_SIG }, prefix);
  if (!plain(signature) || Object.keys(signature).sort().join() !== 'address,domain,scheme,value' || signature.scheme !== MANIFEST_SIGN_SCHEME ||
      signature.domain !== MANIFEST_SIGN_DOMAIN_V3 || typeof signature.value !== 'string' || signature.value.length > 200) fail('signature-shape');
  if (look !== null) {
    if (!plain(look)) fail('look');
    const { images, ...lookRest } = look as Loose;
    if (!Array.isArray(images) || images.length > 8) fail('look-images');
    const imgs = (images as unknown[]).map(checkImageEntry);
    const filePaths = new Set([...base.files.map(f => f.path.toLowerCase()), ...(base.cover ? [base.cover.path.toLowerCase()] : [])]);
    const imgPaths = new Set<string>();
    for (const i of imgs) { const k = i.path.toLowerCase(); if (filePaths.has(k) || imgPaths.has(k)) fail('look-image-duplicate'); imgPaths.add(k); }
    // 꾸밈이 가리킬 수 있는 그림 = 표지 + 꾸밈 그림 + (게임·디지털이면) 묶음 안 그림 파일.
    const usable = new Set([...imgs.map(i => i.path), ...(base.cover ? [base.cover.path] : []),
      ...(base.type === 'game' || base.type === 'digital' ? base.files.filter(f => COVER_EXT.has(extOf(f.path))).map(f => f.path) : [])]);
    try { validateLook(lookRest, base.type, usable); } catch (e) { fail('look-' + (e as Error).message.replace(/^look: /, '')); }
  }
  if (genre !== null) { try { validateGenre(genre, base.type); } catch (e) { fail('genre-' + (e as Error).message.replace(/^genre: /, '')); } }
  if (base.type === 'music') { if (music === null) fail('music-required'); checkMusic(music, base); }
  else if (music !== null) fail('music-not-music');
  try { canonicalJson(r); } catch { fail('canonical'); }
  return r as ManifestV3;
}

export function unsignedV3(doc: ManifestV3 | UnsignedV3): UnsignedV3 { const { signature: _s, ...rest } = doc as ManifestV3; return rest as UnsignedV3; }
export const signingMessageV3 = (doc: UnsignedV3) => `${MANIFEST_SIGN_DOMAIN_V3}\n${doc.asset}\nsha256:${sha256Hex(utf8(canonicalJson(unsignedV3(doc))))}`;
export const encodeV3 = (doc: ManifestV3) => utf8(canonicalJson(doc));

/** 받은 v3 바이트(정본 JSON)·서명 확인. */
export function verifyManifestV3(bytes: Uint8Array, opts: { expectedAsset?: string; prefix?: string } = {}): { manifest: ManifestV3; bytesSha256: string; signedBy: string } {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new CreatorError('manifest-too-large');
  let doc: unknown;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CreatorError('manifest-json'); }
  const m = validateManifestV3(doc, opts.prefix);
  const canonical = encodeV3(m);
  if (sha256Hex(bytes) !== sha256Hex(canonical)) fail('not-canonical');
  if (opts.expectedAsset !== undefined && m.asset !== opts.expectedAsset) throw new CreatorError('manifest-asset', 'mismatch');
  if (m.signature.address !== m.creator.address) throw new CreatorError('manifest-signature', 'address');
  const signer = recoverMessageAddress(signingMessageV3(m), m.signature.value);
  if (signer === null || signer !== m.signature.address) throw new CreatorError('manifest-signature', 'invalid');
  return { manifest: m, bytesSha256: sha256Hex(canonical), signedBy: signer };
}

/** v2 든 v3 든 읽는다(구매자 쪽 호환 계층의 모양). v2 는 look·music 이 null. */
export function readManifestAny(bytes: Uint8Array, opts: { expectedAsset?: string; prefix?: string } = {}): { version: 2 | 3; manifest: CreatorManifest | ManifestV3; look: LookExt | null; music: MusicExt | null } {
  let version: unknown = null;
  try { version = (JSON.parse(new TextDecoder().decode(bytes)) as Loose)?.version; } catch { /* below */ }
  if (version === MANIFEST_V3) { const v = verifyManifestV3(bytes, opts).manifest; return { version: 3, manifest: v, look: v.look, music: v.music }; }
  const v2 = verifyManifest(bytes, opts).manifest;
  return { version: 2, manifest: v2, look: null, music: null };
}

/** v3 → v2(꾸밈·곡 목록 제거). 서명은 다시 해야 한다(도메인·내용이 달라진다). */
export function toV2Unsigned(doc: UnsignedV3): UnsignedManifest {
  const { look: _l, music: _m, genre: _g, ...rest } = unsignedV3(doc);
  return { ...rest, version: 2 } as UnsignedManifest;
}

/* ── v3 올리기(스위치가 켜졌을 때만 화면이 부른다; 시험은 모의 어댑터로) ─────────────── */

export type V3Extra = { look: (Look & { imageFiles: FileInput[] }) | null; music: MusicExt | null; genre?: GenreValue | null };
export type PublishV3Result = { manifest: ManifestV3; manifestBytes: Uint8Array; manifestCid: string; manifestSha256: string; pinnedBy: string; real: boolean };

/**
 * v2 올리기(core publishContent)로 파일·표지·v2 서명까지 끝낸 뒤(같은 검사·같은 캐시), 꾸밈 그림을 보관하고
 * v3 매니페스트를 다시 만들어 V3 도메인으로 서명·자기 검사·보관한다. v2 매니페스트 자체는 보관하지 않는 대신
 * 파일 CID 는 그대로 재사용한다(이어하기 캐시 공유).
 */
export async function publishV3(input: PublishInput, extra: V3Extra, pin: PinAdapter, sign: MessageSigner, opts: { cache?: PinCache; onProgress?: (p: { done: number; total: number; path: string }) => void } = {}): Promise<PublishV3Result> {
  const cache = opts.cache ?? new Map();
  // v2 단계는 「보관만 하는」 어댑터로 감싸 매니페스트 v2 는 실제로 올리지 않는다(파일은 실제 pin 으로).
  const v2pin: PinAdapter = { id: pin.id, holder: pin.holder, real: pin.real, add: (name, bytes) => name === 'manifest.json' ? Promise.resolve({ cid: mockCid(bytes), size: bytes.length }) : pin.add(name, bytes) };
  const v2 = await publishContent(input, v2pin, sign, { cache, onProgress: p => opts.onProgress?.({ done: p.done, total: p.total, path: p.path }) });
  let look: LookExt | null = null;
  if (extra.look) {
    const imgs = extra.look.imageFiles;
    const chk = checkFiles('digital', imgs.map(f => ({ ...f, role: 'content' as const })));
    if (!chk.ok || imgs.some(f => !COVER_EXT.has(extOf(f.path)) || f.bytes.length > LIMITS.cover.maxFileBytes)) throw new CreatorError('manifest-files', '꾸밈 그림은 PNG·JPG·WEBP 5MB 이하만 돼요.');
    const images: FileEntry[] = [];
    for (const f of imgs) {
      const sha = sha256Hex(f.bytes), hit = cache.get(sha);
      const r = hit && CID_V0.test(hit.cid) ? hit : await pin.add(f.path, f.bytes);
      if (!CID_V0.test(r.cid)) throw new CreatorError('manifest-files', `보관소가 이상한 답을 줬어요: ${f.path}`);
      cache.set(sha, { cid: r.cid, size: f.bytes.length });
      images.push({ path: f.path, cid: r.cid, sha256: sha, size: f.bytes.length, mime: MIME_BY_EXT[extOf(f.path)] });
    }
    const { imageFiles: _i, ...lookFields } = extra.look;
    look = { ...lookFields, images };
  }
  const unsigned: UnsignedV3 = { ...v2.manifest, version: MANIFEST_V3, look, music: extra.music, genre: extra.genre ?? null } as unknown as UnsignedV3;
  delete (unsigned as Partial<ManifestV3>).signature;
  const value = await sign(input.creatorAddress, signingMessageV3(unsigned));
  const manifest: ManifestV3 = { ...unsigned, signature: { scheme: MANIFEST_SIGN_SCHEME, domain: MANIFEST_SIGN_DOMAIN_V3, address: input.creatorAddress, value } };
  const manifestBytes = encodeV3(manifest);
  const verified = verifyManifestV3(manifestBytes, { expectedAsset: input.asset, prefix: input.prefix });
  const m = await pin.add('manifest.json', manifestBytes);
  if (!CID_V0.test(m.cid)) throw new CreatorError('manifest-files', '매니페스트 CID 가 이상해요');
  return { manifest, manifestBytes, manifestCid: m.cid, manifestSha256: verified.bytesSha256, pinnedBy: pin.holder, real: pin.real };
}

/** 화면 상태 → v3 음악 칸. 곡 순서는 tracks 순서. 미리듣기는 첫 곡에만(나머지는 null) — v2 previewFile 과 맞춘다. */
export function musicExtFrom(format: MusicFormat, tracks: Array<{ path: string; title: string; durationMs: number | null }>, preview: { startMs: number; endMs: number }): MusicExt {
  return { format, tracks: tracks.map((t, i) => ({ title: t.title.trim().slice(0, 80) || `Track ${i + 1}`, file: t.path, durationMs: t.durationMs === null ? null : Math.max(1, Math.round(t.durationMs)), preview: i === 0 ? { ...preview } : null })) };
}
export type { ContentType };
