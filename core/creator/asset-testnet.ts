/*
 * 새 체인 자산 발행 시험망 플래그 — **이 상수 한 곳**(결정문 §31 ⓒ). 기본 꺼짐.
 *
 * · 메인넷 스위치(mainnet-switch.json)와 **독립**이다. 그 JSON 을 읽지도 쓰지도 않는다.
 * · 켜도 시험망(test·regtest)에서만 열린다. 메인넷('main')이나 모르는 망은 플래그와 무관하게 항상 막힌다 —
 *   새 이름 규칙(asset-name-v2.ts, 잠정)은 시험망 확인 전 운영 금지이기 때문이다.
 * · 환경 변수·원격 설정으로 켜는 길은 없다. 켜려면 이 줄을 바꾸는 커밋 하나(그리고 asset-testnet 기본값 시험도 같이 고친다).
 */
export const RVN_ASSET_TESTNET = false;

/** 플래그가 열 수 있는 망. 'main' 은 넣지 않는다(넣으면 publish-route.test.ts 가 실패한다). */
export const ASSET_TESTNET_CHAINS: ReadonlySet<string> = new Set(['test', 'regtest']);

/** 레이븐코인 메인넷 genesis 블록 해시(release-site/chain.ts 와 같은 값). 시험망이라 우기는 메인넷 노드를 걸러 낸다. */
export const RVN_MAIN_GENESIS = '0000006b444bc2f2ffe627be9d9e7e7a0730000870ef6eb6da46c8eae389df90';
const KNOWN_CHAINS: ReadonlySet<string> = new Set(['main', 'test', 'regtest']);

/** 노드가 직접 답한 값: getblockchaininfo.chain 과 getblockhash 0. 화면·호출자가 적은 문자열이 아니다. */
export type NodeChainReport = Readonly<{ chain: string; genesisHash: string }>;
/**
 * 주입하는 검증 함수: 이 보고가 지금 발행에 쓸 그 노드에서 방금 온 것이고 그 망의 genesis 와 맞는가.
 * 데스크탑은 노드 RPC(getblockchaininfo·getblockhash 0)를 다시 불러 대조한다. 시험은 고정값 함수를 넣는다.
 */
export type ChainVerifier = (report: NodeChainReport) => boolean;
/** confirmNodeChain 만 만들 수 있는 확인 결과(객체 글자로 흉내 내면 통과하지 않는다). */
export type ConfirmedChain = Readonly<{ chain: string; genesisHash: string; testChain: boolean }>;
const CONFIRMED = new WeakSet<object>();

/**
 * 노드 보고 → 확인된 망. 모양(알려진 망 이름·64 hex), 메인넷 genesis 와의 모순(메인넷 genesis 인데 test/regtest 라 함, 또는 그 반대),
 * 주입한 검증 함수가 모두 통과해야 한다. 아니면 null(= 시험망으로 치지 않는다).
 */
export function confirmNodeChain(report: unknown, verify: ChainVerifier): ConfirmedChain | null {
  if (typeof report !== 'object' || report === null || typeof verify !== 'function') return null;
  const { chain, genesisHash } = report as Record<string, unknown>;
  if (typeof chain !== 'string' || !KNOWN_CHAINS.has(chain) || typeof genesisHash !== 'string' || !/^[0-9a-f]{64}$/.test(genesisHash)) return null;
  if ((chain === 'main') !== (genesisHash === RVN_MAIN_GENESIS)) return null;
  let ok = false;
  try { ok = verify(Object.freeze({ chain, genesisHash })) === true; } catch { ok = false; }
  if (!ok) return null;
  const confirmed: ConfirmedChain = Object.freeze({ chain, genesisHash, testChain: ASSET_TESTNET_CHAINS.has(chain) });
  CONFIRMED.add(confirmed);
  return confirmed;
}
export const isConfirmedChain = (c: unknown): c is ConfirmedChain => typeof c === 'object' && c !== null && CONFIRMED.has(c);

export type ChainAssetGate = { allowed: boolean; testChain: boolean; blockers: string[] };

/**
 * 새 체인 자산 발행이 이 망에서 열려 있는가. chain 은 confirmNodeChain 결과만(문자열·흉내 객체는 확인 안 됨으로 막힌다).
 * flag 는 기본 RVN_ASSET_TESTNET(시험에서만 바꿔 넣는다 — 켜도 메인넷은 열리지 않는다).
 */
export function chainAssetIssueGate(chain: ConfirmedChain | null, flag: boolean = RVN_ASSET_TESTNET): ChainAssetGate {
  const confirmed = isConfirmedChain(chain);
  const testChain = confirmed && ASSET_TESTNET_CHAINS.has(chain.chain);
  const blockers: string[] = [];
  if (!confirmed) blockers.push('노드에게 지금 망을 확인하지 못했어요. 확인될 때까지 체인 자산을 만들 수 없어요.');
  if (!testChain) blockers.push('새 체인 자산은 시험망에서만 만들 수 있어요. 이름 규칙이 아직 시험망 확인 전이라 메인넷에서는 막혀 있어요.');
  if (flag !== true) blockers.push('시험망 체인 자산 발행 스위치가 꺼져 있어요.');
  return { allowed: blockers.length === 0, testChain, blockers };
}
