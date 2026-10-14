/**
 * 암호화 백업 — 시드에서 파생한 키(HKDF)로 XChaCha20-Poly1305.
 * 복원 분업: 키·자금·거래 뼈대(txid·수량·시각)는 시드+체인, 상품명·KRW·가게 설정은 이 파일.
 * 서버로 올리지 않는다(기기 로컬/사용자가 직접 보관).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8Bytes } from '../playx-asset-proof/crypto';
import { noConversion, validateReceipt, type Receipt } from './model';
import { RECEIPT_PARAMS } from './params';

export interface BackupPayload { receipts: Receipt[]; shopSettings: Record<string, string>; createdAt: number }
/** 파일 머리(평문): v·kdf·t 는 AAD 로 묶여 있어 바꾸면 열리지 않는다. t = 생성 시각(ms) — 본문 createdAt 과 같아야 한다. */
interface BackupFile { v: number; alg: 'xchacha20poly1305'; kdf: number; t: number; n: string; ct: string }
export class BackupError extends Error { constructor(readonly code: 'bad-seed' | 'bad-file' | 'version' | 'decrypt' | 'invalid') { super(`백업 오류: ${code}`); } }

/** AAD = 키 파생 info / 파일 버전 / 키 파생 버전 / 생성 시각 — 머리의 버전·시각을 바꾸거나 다른 백업의 머리와 바꿔치기하면 복호화가 실패한다. */
const aad = (v: number, kdf: number, t: number) => utf8Bytes(`${RECEIPT_PARAMS.backupKeyInfo}/${v}/kdf${kdf}/${t}`);

/**
 * 키 재료 검사. HKDF 는 늘이기(stretching)가 없어 비밀번호·PIN 을 넣으면 그대로 무차별 대입된다.
 * 넘길 수 있는 값 = BIP39 시드 바이트(64) 또는 그것에서 파생한 32바이트 이상 키. 다음은 거절(bad-seed):
 * 길이 < backupMinSeedBytes · 서로 다른 바이트 16개 미만(0 채움·반복) · 모두 인쇄 가능 ASCII(니모닉·비밀번호 글자를 바이트로 넘긴 경우).
 */
export function assertBackupKeyMaterial(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length < RECEIPT_PARAMS.backupMinSeedBytes) throw new BackupError('bad-seed');
  if (new Set(seed).size < 16) throw new BackupError('bad-seed');
  if (seed.every(b => b >= 0x20 && b <= 0x7e)) throw new BackupError('bad-seed');
}
function key(seed: Uint8Array): Uint8Array {
  assertBackupKeyMaterial(seed);
  return hkdf(sha256, seed, utf8Bytes('rv-receipts-salt'), utf8Bytes(RECEIPT_PARAMS.backupKeyInfo), 32);
}

/** 파일 판 v 가 담을 수 있는 가장 높은 영수증 판(2 → 1, 3 → 2, 4 → 3). */
const maxReceiptVersion = (v: number): number => v - 1;
/** opts.version = 쓸 판(기본 = 지금 판). 옛 판은 그 판이 알던 영수증 판까지만 담을 수 있다(maxReceiptVersion) — 옛 앱과 주고받을 파일·시험용. */
export function createBackup(seed: Uint8Array, payload: BackupPayload, random: (n: number) => Uint8Array = n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  opts: { version?: number } = {}): string {
  if (!payload || !Number.isSafeInteger(payload.createdAt) || payload.createdAt < 0) throw new BackupError('invalid');
  const v = opts.version ?? RECEIPT_PARAMS.backupVersion;
  if (!RECEIPT_PARAMS.backupReadableVersions.includes(v)) throw new BackupError('version');
  if (Array.isArray(payload.receipts) && payload.receipts.some(r => v < 3 ? r?.version !== 1 : typeof r?.version === 'number' && r.version > maxReceiptVersion(v))) throw new BackupError('version');
  const k = key(seed), nonce = Uint8Array.from(random(24));
  if (nonce.length !== 24) throw new BackupError('bad-file');
  const kdf = RECEIPT_PARAMS.backupKdfVersion, t = payload.createdAt;
  const ct = xchacha20poly1305(k, nonce, aad(v, kdf, t)).encrypt(utf8Bytes(JSON.stringify(payload)));
  k.fill(0);
  const file: BackupFile = { v, alg: 'xchacha20poly1305', kdf, t, n: bytesToHex(nonce), ct: bytesToHex(ct) };
  return JSON.stringify(file);
}

export function openBackup(seed: Uint8Array, text: string): BackupPayload {
  let f: BackupFile;
  try { f = JSON.parse(text); } catch { throw new BackupError('bad-file'); }
  if (!f || typeof f !== 'object' || typeof f.v !== 'number') throw new BackupError('bad-file');
  if (!RECEIPT_PARAMS.backupReadableVersions.includes(f.v)) throw new BackupError('version');
  if (f.kdf !== RECEIPT_PARAMS.backupKdfVersion) throw new BackupError('version');
  if (f.alg !== 'xchacha20poly1305' || !Number.isSafeInteger(f.t) || f.t < 0 || !/^[0-9a-f]{48}$/.test(f.n ?? '') || !/^(?:[0-9a-f]{2}){16,}$/.test(f.ct ?? '')) throw new BackupError('bad-file');
  const k = key(seed);
  let plain: Uint8Array;
  try { plain = xchacha20poly1305(k, hexToBytes(f.n), aad(f.v, f.kdf, f.t)).decrypt(hexToBytes(f.ct)); } catch { throw new BackupError('decrypt'); }
  finally { k.fill(0); }
  let p: BackupPayload;
  try { p = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new BackupError('invalid'); }
  let bad = true;
  try {
    bad = !p || typeof p !== 'object' || p.createdAt !== f.t || !Array.isArray(p.receipts) || !p.shopSettings || typeof p.shopSettings !== 'object' ||
      Array.isArray(p.shopSettings) || Object.values(p.shopSettings).some(x => typeof x !== 'string') || p.receipts.some(r => validateReceipt(r) !== null) ||
      p.receipts.some(r => r.version > maxReceiptVersion(f.v));
  } catch { bad = true; }
  if (bad) throw new BackupError('invalid');
  return p;
}

/** 체인에서 재구성되는 거래 뼈대(내 주소 기준 입출금). direction 'out'(출금) 또는 0 이하·정수 아닌 sats 는 판매 수입이 아니다. */
export interface ChainTx { txid: string; sats: string; time: number; counterparty: string; direction?: 'in' | 'out' }

/**
 * 백업에 없는 체인 **입금** 거래는 뼈대 영수증(상품명 없음·환산 없음, skeletonOnly)으로 복원한다. 출금·음수·모양이 틀린 기록은 판매자 수입으로 넣지 않는다.
 * ChainTx 는 「내 주소가 받은 sats」 하나뿐이라 총액·수수료·공유 몫은 알 수 없다 → 빈 칸(모름)으로 두고 merchantSats = 받은 sats 만 적는다(CSV 도 빈칸).
 */
export function reconstructReceipts(chain: readonly ChainTx[], backed: readonly Receipt[]): Receipt[] {
  const have = new Set(backed.filter(r => r.txid).map(r => r.txid));
  const income = chain.filter(t => !!t && t.direction !== 'out' && typeof t.sats === 'string' && /^[1-9]\d*$/.test(t.sats) &&
    typeof t.txid === 'string' && /^[0-9a-f]{64}$/.test(t.txid) && Number.isSafeInteger(t.time) && t.time >= 0 && typeof t.counterparty === 'string');
  const seen = new Set<string>();
  const skeletons: Receipt[] = income.filter(t => !have.has(t.txid) && !seen.has(t.txid) && (seen.add(t.txid), true)).map(t => ({
    version: 2, id: `chain-${t.txid}`, method: 'rvn', status: 'paid', paidAt: t.time, productId: '', productName: '(복구된 거래 — 상품 정보 없음)',
    amountSats: '', merchantSats: t.sats, platformFeeSats: '', shareSats: '',
    conversion: noConversion('복구된 거래 — 총액·환산 모름'), counterparty: t.counterparty, txid: t.txid, selfReported: false, skeletonOnly: true,
  }));
  return [...backed, ...skeletons].sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id));
}

export interface RestoreDrillReport { ok: boolean; reason?: string; restored: number; skeletonOnly: number; notOnChain: number; selfReported: number }
/** 복원 훈련 — 파일을 열고 체인 뼈대와 대조만 한다(아무것도 덮어쓰지 않음). */
export function restoreDrill(seed: Uint8Array, backupText: string, chain: readonly ChainTx[]): RestoreDrillReport {
  try {
    const p = openBackup(seed, backupText);
    const onChain = new Set(chain.map(t => t.txid));
    const merged = reconstructReceipts(chain, p.receipts);
    return {
      ok: true, restored: p.receipts.length,
      skeletonOnly: merged.length - p.receipts.length,
      notOnChain: p.receipts.filter(r => !r.selfReported && r.txid && !onChain.has(r.txid)).length,
      selfReported: p.receipts.filter(r => r.selfReported).length,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof BackupError ? e.code : 'unknown', restored: 0, skeletonOnly: 0, notOnChain: 0, selfReported: 0 };
  }
}
