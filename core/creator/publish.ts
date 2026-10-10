import { sha256 } from '@noble/hashes/sha256';
import { sha256Hex } from './bytes';
import { burnCheck, checkCreatorAssetName, CREATOR_ASSET_PREFIX, type BurnCheck } from './asset-name';
import { checkFiles, type ContentType, type FileInput, type FilesCheck } from './limits';
import {
  CID_V0, CreatorError, FEE_POLICY, MANIFEST_FORMAT, MANIFEST_VERSION, encodeManifest, isRvnAddress, manifestSigningMessage, verifyManifest, withSignature,
  type CreatorManifest, type FileEntry, type UnsignedManifest,
} from './manifest';

/*
 * 「내 콘텐츠 올리기」 흐름의 순수 부분: 파일 검사 → 보관(pin) → 매니페스트 → 제작자 서명 → 자기 검사 → 매니페스트 보관 → 발행 계획.
 * 바깥 세계(IPFS·노드)는 전부 주입한다 — 화면은 진짜 어댑터를, 시험은 모의 어댑터를 넣는다.
 *
 * 🔴 핀(보관)을 누가 계속 붙들고 있나: IPFS 는 누군가 그 파일을 「고정(pin)」해 두어야 남는다. 기본 어댑터(데스크탑 내장
 *    kubo)는 **제작자 컴퓨터**가 붙든다 — 그 컴퓨터가 꺼져 있거나 지우면 아무도 못 받는다. 외부 핀 서비스는 돈과 계정이
 *    필요하고 누가 낼지가 정해지지 않았다(대표 결정). 그래서 어댑터를 바꿀 수 있게만 해 두었다.
 */

export type PinResult = { cid: string; size: number };
export interface PinAdapter {
  /** 'local-kubo' | 'mock' | 외부 서비스 이름. 화면에 그대로 보인다. */
  readonly id: string;
  /** 사람에게 보일 한 줄 설명(누가 파일을 붙들고 있나). */
  readonly holder: string;
  /** 진짜 IPFS 에 올리는가. mock 은 false — 화면이 「시험」이라고 표시한다. */
  readonly real: boolean;
  add(name: string, bytes: Uint8Array): Promise<PinResult>;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
/** 모의 CID: CIDv0 모양(Qm…46자)이지만 실제 IPFS CID 가 아니다(원본 바이트의 sha256 을 그대로 쓴다). 시험 전용. */
export const mockCid = (bytes: Uint8Array) => base58(Uint8Array.from([0x12, 0x20, ...sha256(bytes)]));

/** 시험·미리보기용. 아무 데도 올리지 않고 받은 것을 기억만 한다. */
export class MockPinAdapter implements PinAdapter {
  readonly id = 'mock';
  readonly holder = '시험용 — 아무 데도 올리지 않아요';
  readonly real = false;
  readonly stored = new Map<string, Uint8Array>();
  async add(_name: string, bytes: Uint8Array): Promise<PinResult> {
    const cid = mockCid(bytes); this.stored.set(cid, bytes.slice()); return { cid, size: bytes.length };
  }
}

/** 외부 핀 서비스 자리. 서비스·계정·비용 주체가 정해지지 않아(대표 결정) 구현하지 않았다. 부르면 실패한다. */
export class UnconfiguredPinService implements PinAdapter {
  readonly id = 'pin-service-unconfigured';
  readonly holder = '외부 보관 서비스(아직 정하지 않음)';
  readonly real = true;
  async add(): Promise<PinResult> { throw new Error('외부 보관 서비스가 아직 정해지지 않았어요(대표 결정 대기).'); }
}

/** 노드 signmessage 를 부르는 쪽. 데스크탑은 sign_message 명령, 시험은 일회용 키. */
export type MessageSigner = (address: string, message: string) => Promise<string>;

export type PublishInput = {
  type: ContentType; asset: string; title: string; description: string;
  files: FileInput[]; creatorAddress: string; receivingAddress: string;
  priceAtoms: string | null; declaredFeeBps: number;
  game?: { entry: string; origin: string | null; identity: boolean; payment: boolean };
  music?: { previewFile: string; previewStartMs: number; previewEndMs: number };
  now: Date; prefix?: string;
};
export type PublishResult = {
  check: FilesCheck; manifest: CreatorManifest; manifestBytes: Uint8Array; manifestCid: string; manifestSha256: string; pinnedBy: string; real: boolean;
};

/** 올리기 전에 할 수 있는 검사 전부(파일·이름·주소). 돈도 네트워크도 쓰지 않는다. */
export function precheck(input: PublishInput): { check: FilesCheck; problems: string[] } {
  const check = checkFiles(input.type, input.files);
  const problems = check.problems.map(p => p.path ? `${p.path}: ${p.say}` : p.say);
  const name = checkCreatorAssetName(input.asset, input.prefix ?? CREATOR_ASSET_PREFIX);
  problems.push(...name.problems);
  if (!isRvnAddress(input.creatorAddress)) problems.push('제작자 주소(R…)가 올바르지 않아요.');
  if (!isRvnAddress(input.receivingAddress)) problems.push('판매 대금 받을 주소(R…)가 올바르지 않아요.');
  if (!input.title.trim()) problems.push('제목을 적어 주세요.');
  return { check, problems };
}

/**
 * 올리기: 파일을 하나씩 보관하고 CID 를 받아 매니페스트를 만들고, 제작자 주소로 서명하고, 서명을 스스로 다시 확인한 뒤
 * 매니페스트 자체를 보관한다. 하나라도 틀리면 멈춘다(반쯤 올라간 파일은 보관소에 남을 수 있다 — 화면이 알린다).
 */
export async function publishContent(input: PublishInput, pin: PinAdapter, sign: MessageSigner): Promise<PublishResult> {
  const { check, problems } = precheck(input);
  if (problems.length) throw new CreatorError('manifest-files', problems.join(' / '));
  const byPath = new Map(input.files.map(f => [f.path, f]));
  const entryOf = async (path: string): Promise<FileEntry> => {
    const f = byPath.get(path)!, c = check.files.find(x => x.path === path)!;
    const r = await pin.add(path, f.bytes);
    if (!CID_V0.test(r.cid) || r.size !== f.bytes.length) throw new CreatorError('manifest-files', `보관소가 이상한 답을 줬어요: ${path}`);
    return { path, cid: r.cid, sha256: sha256Hex(f.bytes), size: f.bytes.length, mime: c.mime };
  };
  const files: FileEntry[] = [];
  for (const c of check.files.filter(x => x.role === 'content')) files.push(await entryOf(c.path));
  const coverFile = check.files.find(x => x.role === 'cover');
  const cover = coverFile ? await entryOf(coverFile.path) : null;
  const unsigned: UnsignedManifest = {
    format: MANIFEST_FORMAT, version: MANIFEST_VERSION, type: input.type, asset: input.asset, title: input.title.trim(), description: input.description.trim(),
    files, cover, creator: { address: input.creatorAddress, receivingAddress: input.receivingAddress },
    price: input.priceAtoms === null ? null : { atoms: input.priceAtoms }, fee: { policy: FEE_POLICY, declaredBps: input.declaredFeeBps },
    game: input.type === 'game' ? { entry: input.game?.entry ?? '', origin: input.game?.origin ?? null, capabilities: { identity: !!input.game?.identity, payment: !!input.game?.payment } } : null,
    music: input.type === 'music' ? { previewFile: input.music?.previewFile ?? '', previewStartMs: input.music?.previewStartMs ?? 0, previewEndMs: input.music?.previewEndMs ?? 0 } : null,
    createdAt: input.now.toISOString(),
  };
  const signature = await sign(input.creatorAddress, manifestSigningMessage(unsigned));
  const manifest = withSignature(unsigned, input.creatorAddress, signature);
  const manifestBytes = encodeManifest(manifest);
  // 올리기 전에 받는 사람과 똑같이 검사한다 — 서명이 틀린 매니페스트를 세상에 내보내지 않는다.
  const verified = verifyManifest(manifestBytes, { expectedAsset: input.asset, prefix: input.prefix });
  const m = await pin.add('manifest.json', manifestBytes);
  if (!CID_V0.test(m.cid)) throw new CreatorError('manifest-files', '매니페스트 CID 가 이상해요');
  return { check, manifest, manifestBytes, manifestCid: m.cid, manifestSha256: verified.bytesSha256, pinnedBy: pin.holder, real: pin.real };
}

/* ── 발행 계획 ──────────────────────────────────────────────────────── */

/**
 * 🔴 실제 메인넷 발행 스위치. false 인 동안 화면은 메인넷에서 발행 단추를 잠그고, 시험망(test·regtest)에서만 노드 발행을 부른다.
 *    접두어·소각액 대조·핀 주체가 정해진 뒤 대표가 켠다. 이 상수 한 곳.
 */
export const REAL_MAINNET_ISSUE_ENABLED = false;
export const TEST_CHAINS: ReadonlySet<string> = new Set(['test', 'regtest']);

export type IssueParams = { name: string; qty: 1; units: 0; reissuable: true; ipfsHash: string };
export type IssuePlan = {
  params: IssueParams; burn: BurnCheck; canIssue: boolean; blockers: string[]; irreversible: string[]; chain: string; testChain: boolean;
};
export interface Issuer { issue(params: IssueParams): Promise<{ txid: string }> }

/**
 * 발행 확인 화면에 그릴 모든 것과 「지금 발행해도 되나」. 사람이 이름을 다시 적는 것(typedName)까지 맞아야 canIssue.
 * 자산은 qty 1·units 0·reissuable true 로 만든다(설계 §2.2 — 매니페스트를 고치려면 재발행이 필요하므로 잠그지 않는다).
 */
export function planIssue(p: { asset: string; manifestCid: string; chain: string; ownedAssets: readonly string[]; nameTaken: boolean | null;
  chainBurnRvn: number | null; typedName: string; prefix?: string; realMainnetEnabled?: boolean }): IssuePlan {
  const name = checkCreatorAssetName(p.asset, p.prefix ?? CREATOR_ASSET_PREFIX);
  const burn = burnCheck(name.kind, p.chainBurnRvn);
  const testChain = TEST_CHAINS.has(p.chain);
  const blockers: string[] = [...name.problems];
  if (!CID_V0.test(p.manifestCid)) blockers.push('매니페스트 CID 가 없어요. 먼저 올려 주세요.');
  if (name.ownerTokenNeeded && !p.ownedAssets.includes(name.ownerTokenNeeded))
    blockers.push(`이 이름 아래 만들려면 이 지갑에 「${name.ownerTokenNeeded}」 주인 표가 있어야 해요(접두어 방식은 대표 결정 대기).`);
  if (p.nameTaken === true) blockers.push('이미 있는 이름이에요. 자산 이름은 영구라 다시 쓸 수 없어요.');
  if (p.nameTaken === null) blockers.push('이름이 비어 있는지 노드에 확인하지 못했어요.');
  if (burn.status === 'mismatch') blockers.push(burn.say);
  if (!testChain && !(p.realMainnetEnabled ?? REAL_MAINNET_ISSUE_ENABLED)) blockers.push('실제 발행은 아직 꺼져 있어요(대표 결정 대기). 시험망에서만 발행할 수 있어요.');
  if (p.typedName !== p.asset) blockers.push('확인을 위해 자산 이름을 똑같이 다시 적어 주세요.');
  const irreversible = [
    `발행하면 ${burn.rvn} RVN 이 소각 주소로 가서 영영 돌아오지 않아요. PLAY X 도 레이븐볼트도 받지 않아요.`,
    '자산 이름은 영구예요. 지우거나 바꿀 수 없어요.',
    '발행한 뒤에는 되돌릴 수 없어요. 매니페스트를 바꾸려면 재발행(추가 소각)이 필요해요.',
    '발행해도 「검증됨」이 아니에요. 검증 전에는 외부 링크로만 보이고 지갑 결제·로그인이 연결되지 않아요.',
  ];
  return { params: { name: p.asset, qty: 1, units: 0, reissuable: true, ipfsHash: p.manifestCid }, burn, canIssue: blockers.length === 0, blockers, irreversible, chain: p.chain, testChain };
}

/** 시험용 발행기: 노드를 부르지 않고 부름만 기록한다. */
export class MockIssuer implements Issuer {
  readonly calls: IssueParams[] = [];
  async issue(params: IssueParams) { this.calls.push({ ...params }); return { txid: sha256Hex(new TextEncoder().encode(JSON.stringify(params))) }; }
}
