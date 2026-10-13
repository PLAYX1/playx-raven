import { sha256Hex } from './bytes';
import { checkCreatorAssetName, CREATOR_ASSET_PREFIX } from './asset-name';
import { checkFiles, type FileInput, type FilesCheck, type ContentType } from './limits';
import {
  CID_V0, CreatorError, FEE_POLICY, MANIFEST_FORMAT, MANIFEST_VERSION, encodeManifest, isRvnAddress, manifestSigningMessage, verifyManifest, withSignature,
  MAX_PREVIEW_CLIP_BYTES, type FileEntry, type LockFile, type UnsignedManifest,
} from './manifest';
import { buildLockSection, sealLockedFile } from './lock';
import { scheduleFee } from './fee-schedule';
import type { MessageSigner, PinAdapter, PinCache, PinResult, PublishInput, PublishProgress, PublishResult } from './publish';

/*
 * 매니페스트 조립(파일 보관 → 매니페스트 → 서명 → 자기 검사 → 매니페스트 보관)의 공용 몸통. 🔴 내부 모듈:
 * 이름 발행 가드(옛 RV. 새 발행 차단)는 여기 없다. 가져가도 되는 곳은 publish.ts(가드 뒤)와 legacy-manifest-fixture.ts(시험 전용) 둘뿐이며,
 * publish-route.test.ts 가 다른 import 를 잡는다.
 */

const LOCK_TYPES: readonly ContentType[] = ['music', 'book', 'digital'];
/** 열람 보호면 클립을 내용 파일 목록 끝에 붙여 한 묶음으로 검사한다(클립도 확장자·머리·크기 검사를 받는다). */
const allFilesOf = (input: PublishInput): FileInput[] => input.lock?.previewClip ? [...input.files, { ...input.lock.previewClip, role: 'content' as const }] : input.files;

/** 이름 발행 가드를 뺀 나머지 사전 검사(파일·이름 모양·주소·제목·열람 보호). */
export function baseChecks(input: PublishInput): { check: FilesCheck; problems: string[] } {
  const check = checkFiles(input.type, allFilesOf(input));
  const problems = check.problems.map(p => p.path ? `${p.path}: ${p.say}` : p.say);
  if (input.lock) {
    if (!LOCK_TYPES.includes(input.type)) problems.push('이 종류는 열람 보호를 걸 수 없어요(게임·티켓).');
    if (input.lock.key.length !== 32) problems.push('상품 열쇠가 올바르지 않아요.');
    const clip = input.lock.previewClip ?? null;
    if (clip && input.type === 'digital') problems.push('이 종류에는 미리보기 클립이 없어요.');
    if (clip && clip.bytes.length > MAX_PREVIEW_CLIP_BYTES) problems.push('미리듣기·미리보기 클립이 너무 커요. 짧게 잘라 주세요.');
    if (clip && input.files.some(f => f.path === clip.path || sha256Hex(f.bytes) === sha256Hex(clip.bytes))) problems.push('미리듣기·미리보기 클립은 본 파일과 다른 파일이어야 해요.');
    const pf = (input.details as { previewFile?: string | null }).previewFile;
    if ((input.type === 'music' || input.type === 'book') && (pf ?? null) !== (clip?.path ?? null)) problems.push('열람 보호 상품의 미리듣기 파일은 따로 만든 클립이어야 해요(본 파일을 그대로 고를 수 없어요).');
  }
  const name = checkCreatorAssetName(input.asset, input.prefix ?? CREATOR_ASSET_PREFIX, { type: input.type });
  problems.push(...name.problems);
  if (!isRvnAddress(input.creatorAddress)) problems.push('제작자 주소(R…)가 올바르지 않아요.');
  if (!isRvnAddress(input.receivingAddress)) problems.push('판매 대금 받을 주소(R…)가 올바르지 않아요.');
  if (!input.title.trim()) problems.push('제목을 적어 주세요.');
  return { check, problems };
}

/** 사전 검사를 이미 통과한 입력만 받는다(check 는 그 결과). */
export async function assembleManifest(input: PublishInput, check: FilesCheck, pin: PinAdapter, sign: MessageSigner,
  opts: { cache?: PinCache; onProgress?: (p: PublishProgress) => void } = {}): Promise<PublishResult> {
  const byPath = new Map(allFilesOf(input).map(f => [f.path, f]));
  const cache = opts.cache ?? new Map();
  const total = check.files.length + 1;
  let done = 0;
  const lockFiles: Array<LockFile> = [];
  const clipPath = input.lock?.previewClip?.path ?? null;
  const entryOf = async (path: string): Promise<FileEntry> => {
    const f = byPath.get(path)!, c = check.files.find(x => x.path === path)!;
    if (input.lock && c.role === 'content' && path !== clipPath) {
      // 열람 보호: 암호문만 보관한다. 조각 nonce 가 난수라 같은 파일도 올릴 때마다 CID 가 달라진다(이어 올리기 캐시를 쓰지 않는다).
      const sealed = sealLockedFile({ key: input.lock.key, asset: input.asset, path, bytes: f.bytes, rng: input.lock.rng });
      const r = await pin.add(path, sealed.cipher);
      if (!CID_V0.test(r.cid) || r.size !== sealed.cipher.length) throw new CreatorError('manifest-files', `보관소가 이상한 답을 줬어요: ${path}`);
      lockFiles.push({ path, cid: r.cid, plainSize: sealed.plainSize, plainSha256: sealed.plainSha256 });
      opts.onProgress?.({ done: ++done, total, path, skipped: false });
      return { path, cid: r.cid, sha256: sha256Hex(sealed.cipher), size: sealed.cipher.length, mime: c.mime };
    }
    const sha = sha256Hex(f.bytes);
    const hit = cache.get(sha);
    let r: PinResult;
    if (hit && CID_V0.test(hit.cid) && hit.size === f.bytes.length) r = hit;
    else {
      r = await pin.add(path, f.bytes);
      if (!CID_V0.test(r.cid) || r.size !== f.bytes.length) throw new CreatorError('manifest-files', `보관소가 이상한 답을 줬어요: ${path}`);
      cache.set(sha, { cid: r.cid, size: r.size });
    }
    opts.onProgress?.({ done: ++done, total, path, skipped: r === hit });
    return { path, cid: r.cid, sha256: sha, size: f.bytes.length, mime: c.mime };
  };
  const files: FileEntry[] = [];
  for (const c of check.files.filter(x => x.role === 'content')) files.push(await entryOf(c.path));
  const coverFile = check.files.find(x => x.role === 'cover');
  const cover = coverFile ? await entryOf(coverFile.path) : null;
  const unsigned: UnsignedManifest = {
    format: MANIFEST_FORMAT, version: MANIFEST_VERSION, type: input.type, asset: input.asset, title: input.title.trim(), description: input.description.trim(),
    files, cover, creator: { address: input.creatorAddress, receivingAddress: input.receivingAddress },
    price: input.priceAtoms === null ? null : { atoms: input.priceAtoms }, fee: input.declaredFeeBps === undefined ? scheduleFee(input.feeScheduleId) : { policy: FEE_POLICY, declaredBps: input.declaredFeeBps },
    details: input.details, createdAt: input.now.toISOString(),
    ...(input.lock ? { lock: buildLockSection({ asset: input.asset, key: input.lock.key, files: lockFiles, deliver: input.lock.deliver }) } : {}),
  };
  const signature = await sign(input.creatorAddress, manifestSigningMessage(unsigned));
  const manifest = withSignature(unsigned, input.creatorAddress, signature);
  const manifestBytes = encodeManifest(manifest);
  // 올리기 전에 받는 사람과 똑같이 검사한다 — 서명이 틀린 매니페스트를 세상에 내보내지 않는다.
  const verified = verifyManifest(manifestBytes, { expectedAsset: input.asset, prefix: input.prefix });
  const m = await pin.add('manifest.json', manifestBytes);
  if (!CID_V0.test(m.cid)) throw new CreatorError('manifest-files', '매니페스트 CID 가 이상해요');
  opts.onProgress?.({ done: ++done, total, path: 'manifest.json', skipped: false });
  return { check, manifest, manifestBytes, manifestCid: m.cid, manifestSha256: verified.bytesSha256, pinnedBy: pin.holder, real: pin.real };
}
