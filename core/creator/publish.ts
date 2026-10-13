import { sha256 } from '@noble/hashes/sha256';
import { sha256Hex } from './bytes';
import { burnCheck, checkCreatorAssetName, CREATOR_ASSET_PREFIX, type BurnCheck } from './asset-name';
import type { ContentType, FileInput, FilesCheck } from './limits';
import { CID_V0, CreatorError, type CreatorManifest, type Details } from './manifest';
import { atomsToRvn } from './bytes';
import type { Rng } from './lock';
import { legacyIssueGuard } from '../brand/legacy-asset';
import { REAL_MAINNET_ISSUE_ENABLED } from './mainnet-switches';
import { RVN_ASSET_TESTNET, chainAssetIssueGate, isConfirmedChain, type ConfirmedChain } from './asset-testnet';
import { assembleManifest, baseChecks } from './manifest-assemble';

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
  priceAtoms: string | null;
  /** 수수료 일정 참조(기본 rv-market). 옛 선언 요율(declaredFeeBps)은 호환 시험용 — 주면 옛 형식 매니페스트를 만든다. */
  feeScheduleId?: string; declaredFeeBps?: number;
  /** 종류별 칸(limits.ts CONTENT_TYPES[type].detailKeys). 화면이 만들고, 매니페스트 검사기가 엄격히 본다. */
  details: Details;
  now: Date; prefix?: string;
  /**
   * 열람 보호(RV-LOCK v1, lock.ts). 주면 files 의 모든 내용 파일을 상품 열쇠(key)로 암호화해 올리고, 매니페스트에 lock 칸을 넣는다.
   * 🔴 평문으로 남는 것은 previewClip(짧은 미리듣기·미리보기 클립) 하나뿐이다 — 본 파일은 하나도 평문으로 올리지 않는다.
   * previewClip 은 files 에 넣지 않는다(넣으면 암호화된다). details.previewFile 은 previewClip.path 또는 null 이어야 한다.
   * 열쇠(key)는 발행을 부른 쪽이 만들고 **판매자만 보관**한다(백업은 화면의 책임 — 잃으면 판매자도 못 연다).
   */
  lock?: { key: Uint8Array; previewClip?: FileInput | null; rng?: Rng; deliver?: string[] };
};
/**
 * 이어 올리기: 이미 보관한 파일의 SHA-256 → CID. 화면이 저장해 두었다가(파일 바이트는 저장하지 않는다) 다시 열면 넘긴다.
 * 같은 바이트면 다시 올리지 않는다. 저장된 CID 가 CIDv0 모양이 아니면 무시하고 다시 올린다.
 */
export type PinCache = Map<string, { cid: string; size: number }>;
export type PublishProgress = { done: number; total: number; path: string; skipped: boolean };
export type PublishResult = {
  check: FilesCheck; manifest: CreatorManifest; manifestBytes: Uint8Array; manifestCid: string; manifestSha256: string; pinnedBy: string; real: boolean;
};

/**
 * 올리기 전에 할 수 있는 검사 전부(파일·이름·주소). 돈도 네트워크도 쓰지 않는다.
 * 🔴 옛 `RV.` 이름은 새로 만들 수 없다(결정문 §26·§29 ④·§31 ⓑ) — 우회 칸은 없다. 옛 자산 읽기는 verifyManifest·parseLegacyAssetName 으로.
 */
export function precheck(input: PublishInput): { check: FilesCheck; problems: string[] } {
  const { check, problems } = baseChecks(input);
  const legacy = legacyIssueGuard(input.asset);
  if (!legacy.allowed) problems.push(legacy.say);
  return { check, problems };
}

/**
 * 올리기: 파일을 하나씩 보관하고 CID 를 받아 매니페스트를 만들고, 제작자 서명하고, 서명을 스스로 다시 확인한 뒤
 * 매니페스트 자체를 보관한다. 하나라도 틀리면 멈춘다(반쯤 올라간 파일은 보관소에 남을 수 있다 — 화면이 알린다).
 */
export async function publishContent(input: PublishInput, pin: PinAdapter, sign: MessageSigner,
  opts: { cache?: PinCache; onProgress?: (p: PublishProgress) => void } = {}): Promise<PublishResult> {
  const { check, problems } = precheck(input);
  if (problems.length) throw new CreatorError('manifest-files', problems.join(' / '));
  return assembleManifest(input, check, pin, sign, opts);
}

/* ── 발행 계획 ──────────────────────────────────────────────────────── */

/**
 * 🔴 실제 메인넷 발행 스위치. false 인 동안 화면은 메인넷에서 발행 단추를 잠그고, 시험망(test·regtest)에서만 노드 발행을 부른다.
 *    접두어·소각액 대조·핀 주체가 정해진 뒤 대표가 켠다. 상수는 mainnet-switches.ts 한 곳에 있고 여기서는 다시 내보내기만 한다.
 */
export { REAL_MAINNET_ISSUE_ENABLED };
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
/** planIssue 가 받는 접두어: 기본값만(다른 접두어로 바꿔 옛 이름 가드·이름 규칙을 비켜 가는 길을 닫는다). 바꾸려면 asset-name.ts 기본값 한 곳. */
export const ISSUE_PREFIXES: ReadonlySet<string> = new Set([CREATOR_ASSET_PREFIX]);

/**
 * chain 은 호출자 문자열이 아니라 confirmNodeChain(노드 보고, 검증 함수) 결과여야 한다(R25 리뷰 #10).
 * 🔴 지금 기본 접두어는 옛 규칙 「RV.」 이고 그 새 발행은 늘 막히므로, 이 옛 흐름으로는 어떤 이름도 발행 가능(canIssue)이 되지 않는다.
 *    새 체인 자산은 publish-route.ts planChainAssetIssueV2(§31 ⓒ) 로만.
 */
export function planIssue(p: { asset: string; manifestCid: string; chain: ConfirmedChain | null; ownedAssets: readonly string[]; nameTaken: boolean | null;
  chainBurnRvn: number | null; typedName: string; prefix?: string; realMainnetEnabled?: boolean;
  /** 새 체인 자산 시험망 플래그(기본 asset-testnet.ts RVN_ASSET_TESTNET). 켜도 메인넷은 열리지 않는다. */
  assetTestnet?: boolean;
  /** 매니페스트 종류. 주면 이름의 종류 글자와 같아야 한다(사칭 방지). */
  type?: ContentType }): IssuePlan {
  const prefix = p.prefix ?? CREATOR_ASSET_PREFIX;
  const name = checkCreatorAssetName(p.asset, prefix, { type: p.type ?? null });
  const burn = burnCheck(name.kind, p.chainBurnRvn);
  const confirmed = isConfirmedChain(p.chain);
  const chainName = confirmed ? p.chain!.chain : 'unconfirmed';
  const testChain = confirmed && TEST_CHAINS.has(chainName);
  const blockers: string[] = [...name.problems];
  if (!ISSUE_PREFIXES.has(prefix)) blockers.push(`이름 접두어는 기본값(${CREATOR_ASSET_PREFIX})만 쓸 수 있어요.`);
  const legacy = legacyIssueGuard(p.asset);
  if (!legacy.allowed) blockers.push(legacy.say);
  // §31 ⓒ: 옛 이름이 아닌 체인 자산 발행은 시험망 플래그 뒤에서만(메인넷 스위치와 독립, 메인넷은 항상 막힘).
  blockers.push(...chainAssetIssueGate(confirmed ? p.chain : null, p.assetTestnet ?? RVN_ASSET_TESTNET).blockers);
  if (!CID_V0.test(p.manifestCid)) blockers.push('매니페스트 CID 가 없어요. 먼저 올려 주세요.');
  if (name.ownerTokenNeeded && !p.ownedAssets.includes(name.ownerTokenNeeded))
    blockers.push(`이 이름 아래 만들려면 이 지갑에 「${name.ownerTokenNeeded}」 주인 표가 있어야 해요.`);
  if (p.nameTaken === true) blockers.push('이미 있는 이름이에요. 자산 이름은 영구라 다시 쓸 수 없어요.');
  if (p.nameTaken === null) blockers.push('이 이름이 체인에 이미 있는지 확인 불가 — 노드에 묻지 못했어요. 확인될 때까지 등록할 수 없어요.');
  if (burn.status === 'mismatch') blockers.push(burn.say);
  if (!testChain && !(p.realMainnetEnabled ?? REAL_MAINNET_ISSUE_ENABLED)) blockers.push('실제 발행은 아직 꺼져 있어요(대표 결정 대기). 시험망에서만 발행할 수 있어요.');
  if (p.typedName !== p.asset) blockers.push('확인을 위해 자산 이름을 똑같이 다시 적어 주세요.');
  const irreversible = [
    `등록하면 ${burn.rvn} RVN 이 소각 주소로 가서 영영 돌아오지 않아요. 이건 수수료가 아니라 보증(스팸 막기)이에요 — PLAY X 도 레이븐볼트도 받지 않아요.`,
    '상품 이름(등록증 이름)은 영구예요. 지우거나 바꿀 수 없어요.',
    '등록한 뒤에는 되돌릴 수 없어요. 내용을 바꾸려면 다시 등록(재발행, 추가 소각)이 필요해요.',
    '등록해도 「검증됨」이 아니에요. 자동 점검을 통과하면 「보증」 표시와 경고를 달고 팔 수 있고(실행되는 게임은 제외), 신원·세이브 연결은 검증된 뒤에만 돼요.',
    '환불·배송·티켓 취소 같은 판매 책임은 제작자에게 있어요. 레이븐볼트는 돈을 맡지 않아 대신 돌려줄 수 없어요.',
  ];
  return { params: { name: p.asset, qty: 1, units: 0, reissuable: true, ipfsHash: p.manifestCid }, burn, canIssue: blockers.length === 0, blockers, irreversible, chain: chainName, testChain };
}

/** 시험용 발행기: 노드를 부르지 않고 부름만 기록한다. */
export class MockIssuer implements Issuer {
  readonly calls: IssueParams[] = [];
  async issue(params: IssueParams) { this.calls.push({ ...params }); return { txid: sha256Hex(new TextEncoder().encode(JSON.stringify(params))) }; }
}

/* ── 비용 한눈에(마법사 ⑤) ───────────────────────────────────────────── */

/** 네트워크 수수료 추정(노드가 답하지 못할 때 쓰는 보수적 기본값). 발행 거래는 보통 이보다 작다 — 「추정」으로만 보인다. */
export const NETWORK_FEE_FALLBACK_ATOMS = 1_000_000n; // 0.01 RVN
export type CostPlan = {
  burnAtoms: string; networkFeeAtoms: string; networkFeeEstimated: boolean; totalAtoms: string;
  balanceAtoms: string | null; enough: boolean | null; shortAtoms: string; lines: string[];
};
/**
 * 등록에 드는 돈: 소각(보증) + 네트워크 수수료. 잔액(확정분만)과 비교해 모자란 금액을 알려 준다.
 * 판매 수수료는 여기에 없다 — 판매될 때 구매 거래에서 자동으로 떼고(지갑이 강제), 제작자가 미리 내는 돈이 아니다.
 */
export function costPlan(p: { burnRvn: number; networkFeeAtoms: bigint | null; balanceAtoms: bigint | null }): CostPlan {
  const burn = BigInt(p.burnRvn) * 100_000_000n;
  const fee = p.networkFeeAtoms !== null && p.networkFeeAtoms >= 0n ? p.networkFeeAtoms : NETWORK_FEE_FALLBACK_ATOMS;
  const total = burn + fee;
  const enough = p.balanceAtoms === null ? null : p.balanceAtoms >= total;
  const short = p.balanceAtoms === null || enough ? 0n : total - p.balanceAtoms;
  const lines = [
    `보증(소각) ${atomsToRvn(burn)} RVN — 수수료가 아니에요. 아무도 받지 않고 영영 사라져요. 아무나 마구 올리지 못하게 막는 보증이에요.`,
    `네트워크 수수료 약 ${atomsToRvn(fee)} RVN${p.networkFeeAtoms === null ? '(추정)' : ''} — 레이븐코인 거래를 처리하는 값이에요.`,
    `합계 ${atomsToRvn(total)} RVN`,
  ];
  if (enough === null) lines.push('잔액을 확인하지 못했어요. 지갑이 동기화된 뒤 다시 확인해 주세요.');
  else if (!enough) lines.push(`${atomsToRvn(short)} RVN 이 모자라요. 「받기」 화면의 내 주소로 RVN 을 받은 뒤(확정까지 몇 분) 다시 확인해 주세요.`);
  else lines.push('잔액이 충분해요.');
  return { burnAtoms: burn.toString(), networkFeeAtoms: fee.toString(), networkFeeEstimated: p.networkFeeAtoms === null, totalAtoms: total.toString(),
    balanceAtoms: p.balanceAtoms === null ? null : p.balanceAtoms.toString(), enough, shortAtoms: short.toString(), lines };
}

/* ── 보관 상태 점검(「내 파일이 지금 받아지는지」) ────────────────────────── */

/** cid 가 지금 네트워크에서 찾아지는가. 데스크탑은 기존 cid_alive 명령(제한 시간 안에 찾기)을 쓴다. */
export type CidProbe = (cid: string) => Promise<boolean>;
export type PinHealth = { ok: boolean; checked: number; missing: string[]; say: string };
/** 매니페스트와 그 안의 모든 파일을 하나씩 찾아본다. 하나라도 못 찾으면 구매자 목록에서 숨겨질 수 있다. */
export async function checkPinHealth(manifestCid: string, manifest: Pick<CreatorManifest, 'files' | 'cover'>, probe: CidProbe): Promise<PinHealth> {
  const items: Array<[string, string]> = [['manifest.json', manifestCid], ...manifest.files.map(f => [f.path, f.cid] as [string, string]), ...(manifest.cover ? [[manifest.cover.path, manifest.cover.cid] as [string, string]] : [])];
  const missing: string[] = [];
  for (const [path, cid] of items) {
    let alive = false;
    try { alive = CID_V0.test(cid) && await probe(cid); } catch { alive = false; }
    if (!alive) missing.push(path);
  }
  const ok = missing.length === 0;
  return { ok, checked: items.length, missing,
    say: ok ? `파일 ${items.length}개 모두 지금 받아져요.` : `${missing.length}개 파일을 지금 못 찾아요(${missing.slice(0, 3).join(', ')}). 이 컴퓨터를 켜 두고 IPFS 가 켜져 있는지 확인해 주세요.` };
}
