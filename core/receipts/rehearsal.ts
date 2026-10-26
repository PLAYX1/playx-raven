/**
 * 복원 연습 — 사업자 온보딩 필수(29라운드 §40-Q1 ③). 키·백업을 잃었을 때 처음 알게 되지 않도록, 상품을 올리기 전에
 * 「백업(지금 판) 만들기 → 같은 키로 열어 내용이 그대로인지 → 다른 키·바뀐 파일은 열리지 않는지」를 한 번 해 본다.
 * 서버·체인에 아무것도 보내지 않는다(전부 이 기기 안). 연습 기록에는 키 자체가 아니라 짧은 지문(keyTag)만 남긴다 — 지갑이 바뀌면 다시 연습.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8Bytes, concatBytes } from '../playx-asset-proof/crypto';
import { assertBackupKeyMaterial, BackupError, createBackup, openBackup, type BackupPayload } from './backup';
import type { Receipt } from './model';
import { RECEIPT_PARAMS } from './params';

/** 연습에 쓰는 가게 설정 칸 표식. 본문 비교용일 뿐 어디에도 저장하지 않는다. */
const PROBE_SETTINGS = { 복원연습: '1' };
export type RehearsalFail = 'bad-seed' | 'version' | 'roundtrip' | 'wrong-key-opened' | 'tamper-opened' | 'error';
export interface RehearsalReport {
  ok: boolean; reason?: RehearsalFail;
  backupVersion: number;
  /** 연습 백업에 담아 되돌려 본 영수증 수. */
  receipts: number;
  /** 같은 키로 열었더니 내용이 그대로. */
  roundtrip: boolean;
  /** 다른 키로는 열리지 않음. */
  wrongKeyRejected: boolean;
  /** 파일을 한 글자 바꾸거나 머리(생성 시각)를 바꾸면 열리지 않음. */
  tamperRejected: boolean;
}
const fail = (reason: RehearsalFail, over: Partial<RehearsalReport> = {}): RehearsalReport =>
  ({ ok: false, reason, backupVersion: RECEIPT_PARAMS.backupVersion, receipts: 0, roundtrip: false, wrongKeyRejected: false, tamperRejected: false, ...over });
const rejects = (f: () => unknown): boolean => { try { f(); return false; } catch (e) { return e instanceof BackupError && e.code === 'decrypt'; } };

/**
 * 복원 연습 한 번. seed = 백업 키 재료(assertBackupKeyMaterial 통과), receipts = 지금 가진 영수증(없어도 된다).
 * random 은 시험용으로 고정 가능(기본 = 암호 난수).
 */
export function runRestoreRehearsal(seed: Uint8Array, receipts: readonly Receipt[], now: number, random?: (n: number) => Uint8Array): RehearsalReport {
  try { assertBackupKeyMaterial(seed); } catch { return fail('bad-seed'); }
  try {
    const payload: BackupPayload = { receipts: [...receipts], shopSettings: { ...PROBE_SETTINGS }, createdAt: now };
    const file = createBackup(seed, payload, random);
    const head = JSON.parse(file) as { v: number; t: number; ct: string };
    if (head.v !== RECEIPT_PARAMS.backupVersion) return fail('version', { backupVersion: head.v });
    const opened = openBackup(seed, file);
    const roundtrip = JSON.stringify(opened) === JSON.stringify(JSON.parse(JSON.stringify(payload)));
    if (!roundtrip) return fail('roundtrip');
    const other = Uint8Array.from(seed, b => b ^ 0xa5);
    if (!rejects(() => openBackup(other, file))) return fail('wrong-key-opened', { roundtrip });
    const last = head.ct.length - 1, flipped = head.ct.slice(0, last) + (head.ct[last] === '0' ? '1' : '0');
    const tamperedBody = JSON.stringify({ ...head, ct: flipped }), tamperedHead = JSON.stringify({ ...head, t: head.t + 1 });
    if (!rejects(() => openBackup(seed, tamperedBody)) || !rejects(() => openBackup(seed, tamperedHead))) return fail('tamper-opened', { roundtrip, wrongKeyRejected: true });
    return { ok: true, backupVersion: head.v, receipts: receipts.length, roundtrip, wrongKeyRejected: true, tamperRejected: true };
  } catch { return fail('error'); }
}

/** 연습을 마쳤다는 기록(기기 안 저장용). 키는 없고 지문만. */
export interface RehearsalRecord { v: 1; doneAt: number; backupVersion: number; keyTag: string }
/** 키 재료의 짧은 지문(sha256 앞 8바이트, 용도 접두어로 다른 해시와 섞이지 않음). 이것으로 키를 되짚을 수 없다. */
export function rehearsalKeyTag(seed: Uint8Array): string { return bytesToHex(sha256(concatBytes(utf8Bytes('rv-restore-rehearsal-tag-v1'), seed)).slice(0, 8)); }
/** 성공한 연습만 기록이 된다. 실패 보고서로는 만들 수 없다(던진다). */
export function makeRehearsalRecord(seed: Uint8Array, report: RehearsalReport, now: number): RehearsalRecord {
  if (!report.ok) throw new Error('복원 연습이 끝나지 않았어요');
  return { v: 1, doneAt: now, backupVersion: report.backupVersion, keyTag: rehearsalKeyTag(seed) };
}
export function parseRehearsalRecord(text: string | null): RehearsalRecord | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'backupVersion,doneAt,keyTag,v' || r.v !== 1 || !Number.isSafeInteger(r.doneAt) || (r.doneAt as number) < 0 ||
        !Number.isSafeInteger(r.backupVersion) || typeof r.keyTag !== 'string' || !/^[0-9a-f]{16}$/.test(r.keyTag)) return null;
    return r as unknown as RehearsalRecord;
  } catch { return null; }
}

/** 상품 올리기 게이트: open = 올릴 수 있음. 나머지는 연습이 필요한 이유(화면 안내용). */
export type RehearsalGate = 'open' | 'practice-needed' | 'other-key' | 'old-version';
export function rehearsalGate(record: RehearsalRecord | null, seed: Uint8Array): RehearsalGate {
  if (!record) return 'practice-needed';
  if (record.keyTag !== rehearsalKeyTag(seed)) return 'other-key';
  if (record.backupVersion !== RECEIPT_PARAMS.backupVersion) return 'old-version';
  return 'open';
}
