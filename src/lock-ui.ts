import { x25519 } from '@noble/curves/ed25519';
import { hex as bytesHex } from '../core/creator/bytes';
import { verifyManifest, type BookSection, type CreatorManifest, type LockFile, type MusicSection } from '../core/creator/manifest';
import type { FileInput } from '../core/creator/limits';
import type { PublishInput } from '../core/creator/publish';
import {
  DEFAULT_MIN_CONFIRMATIONS, LockError, createLockRequest, decodeLockRequest, decryptToMemory, lockKeyId, newLockKeypair, newProductKey, openLockGrant,
  processLockRequest, type LedgerEntry, type LockLedger, type LockTx, type Rng,
} from '../core/creator/lock';
import { sellerSharePayment } from '../core/creator/lock-payment';
import { pcmToWavClip } from '../core/creator/clip';
import { OPEN_MARKET_GAME_INDEX } from '../core/creator/open-market';

/*
 * 구매자 열람권(RV-LOCK v1, 수동 전달판)의 화면 배선. 암호 계산은 전부 core/creator/lock.ts(지갑 저장소에서 복사)가 하고, 여기는
 *   · 열쇠를 이 컴퓨터에 두고 꺼내고(Rust lockkey.rs: lock_secret_put/get) · 백업 파일을 내보내고 되돌리고(lock_key_export/import)
 *   · 결제 거래를 읽고(lock_tx_info) · 암호문을 구간으로 읽어(lock_cid_range) · 화면에 그린다.
 *
 * 문구 원칙(사실만): 쓰는 말 = 「파일은 암호화돼 있고, 구매하면 열람 키가 전달돼요. 파일 공유는 기술로 막을 수 없어요.」 수준.
 * 쓰지 않는 말 = 복사 방지 · 불법 복제 방지 · DRM · 구매자만 열람 · 완전 비공개 · 즉시 열림 · 24시간 자동 (시험 scripts/lock-ui.test.mjs 가 이 파일과 화면을 읽어 확인).
 * 🔴 독립 검수 전: 암호 조합은 core/creator/lock.ts 머리 주석 참조.
 */

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const LOCKABLE_TYPES = ['music', 'book', 'digital'] as const;
export const lockableType = (t: string | null): boolean => t !== null && (LOCKABLE_TYPES as readonly string[]).includes(t);

/** 화면 문구 한 곳(시험이 전부 읽어 금지어를 찾는다). */
export const LOCK_COPY = {
  onLines: (type: string | null): string[] => [
    '파일은 암호문으로 올라가요. 구매하면 열람 키가 전달돼요 — 구매자의 열람 요청을 내가 확인하고 직접 보내요. 파일 공유는 기술로 막을 수 없어요.',
    '열쇠는 이 컴퓨터에만 있어요. 잃으면 복구할 수 없어서, 올린 뒤 열쇠 파일을 저장해야 등록할 수 있어요.',
    ...(type === 'music' ? ['미리듣기는 고른 구간을 따로 잘라 만든 짧은 파일만 공개돼요. 자를 수 없으면 미리듣기를 끄고 올려요.'] : []),
    ...(type === 'book' ? ['미리보기는 따로 만든 PDF 한 파일만 공개돼요. 책 파일은 암호문으로 올라가요.'] : []),
    '내 컴퓨터가 꺼져 있으면 열람 허가를 보내 줄 수 없어서, 구매자가 바로 못 열 수 있어요.',
  ],
  offLines: ['암호화하지 않으면 올린 파일은 주소(CID)를 아는 누구나 받을 수 있어요(곡 전체가 공개 IPFS 에 올라가요). 미리듣기 구간은 화면에서만 정한 것이에요.'],
  noClip: '미리듣기를 만들 수 없어 끄고 올려요(이 파일 형식을 이 컴퓨터가 읽지 못했거나 너무 커요). 미리듣기 없이도 판매할 수 있어요.',
  backupHead: '열쇠 파일을 저장했어요. 백업 열쇠(52글자)는 종이에 적어 12단어 옆에 두세요.',
  backupMissing: '열쇠 파일을 아직 저장하지 않았어요 → 「열쇠 파일 저장」을 눌러 폴더를 골라 주세요. 저장하기 전에는 등록할 수 없어요.',
  sellerNeedsKey: '이 컴퓨터에 이 상품의 열쇠가 없어요 → 아래 「백업 파일에서 되돌리기」로 되돌려 주세요.',
  buyerNote: '구매하면 열람 키가 전달됩니다. 파일 공유는 기술로 막을 수 없습니다. 판매자 컴퓨터가 켜져 있을 때 열람 허가가 오기 때문에 바로 열리지 않을 수 있어요.',
  buyerFileFact: '파일은 암호화돼 있어요. 결제한 뒤 열람 요청 글을 판매자에게 보내면 열람 키가 돌아와요(판매자 컴퓨터가 켜져 있을 때). 열쇠를 받은 사람이 남에게 주는 것은 기술로 막을 수 없어요.',
  exchangePayer: '이 결제를 보낸 주소로 서명할 수 없어요(다른 지갑이나 거래소에서 보낸 결제일 수 있어요). 이 지갑에서 보낸 결제만 열람 요청을 만들 수 있어요.',
  noLock: '이 상품은 암호화돼 있지 않아요. 파일은 공개 IPFS 에서 주소를 아는 누구나 받을 수 있어요.',
} as const;

const hexOf = (b: Uint8Array) => bytesHex(b);
const unhexOf = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const b64 = (s: string): Uint8Array => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errText = (e: unknown) => e instanceof LockError ? `${e.code}${e.detail ? ':' + e.detail : ''}` : String((e as Error)?.message ?? e);
const sizeText = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;

/* ── 열쇠 보관(Rust) ─────────────────────────────────────────────────── */
export function secretStore(invoke: Invoke) {
  return {
    async get(name: string): Promise<Uint8Array | null> {
      const r = await invoke<{ hex?: string | null }>('lock_secret_get', { name });
      return r?.hex ? unhexOf(r.hex) : null;
    },
    async put(name: string, key: Uint8Array): Promise<void> { await invoke('lock_secret_put', { name, hex: hexOf(key) }); },
  };
}
export const sellerKeyName = (asset: string) => `s.${asset}`;

/** 판매자 상품 열쇠: 이 컴퓨터에 이미 있으면 그것을 쓰고(발행을 다시 시도해도 같은 열쇠), 없으면 만들어 **올리기 전에** 먼저 저장한다. */
export async function ensureProductKey(invoke: Invoke, asset: string, rng?: Rng): Promise<Uint8Array> {
  const store = secretStore(invoke);
  const have = await store.get(sellerKeyName(asset));
  if (have) return have;
  const key = newProductKey(rng);
  await store.put(sellerKeyName(asset), key);
  const back = await store.get(sellerKeyName(asset)); // 저장이 되었는지 다시 읽어 확인한다.
  if (!back || hexOf(back) !== hexOf(key)) throw new Error('상품 열쇠를 이 컴퓨터에 저장하지 못했어요. 올리지 않았어요.');
  return key;
}

/* ── 백업 표시(공개 정보만: 상품 이름과 시각) ──────────────────────────── */
export const BACKUP_KEY = 'rv-lock-backup-v1';
export function readBackups(store: Storage | null): Record<string, { at: string }> {
  try { const o = JSON.parse(store?.getItem(BACKUP_KEY) ?? '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
export function markBackedUp(store: Storage | null, asset: string, at: string) {
  try { store?.setItem(BACKUP_KEY, JSON.stringify({ ...readBackups(store), [asset]: { at } })); } catch { /* 저장 못 하면 다음에 다시 저장하라고 묻는다 */ }
}
export async function saveKeyFile(invoke: Invoke, asset: string, folder: string): Promise<{ path: string }> {
  const r = await invoke<{ path?: string; verified?: boolean }>('lock_key_export', { asset, dest: folder });
  if (!r?.path || r.verified !== true) throw new Error('열쇠 파일을 확인하지 못했어요.');
  return { path: String(r.path) };
}

/* ── 미리듣기 클립 ──────────────────────────────────────────────────── */
export type ClipMaker = (bytes: Uint8Array, mime: string, startMs: number, endMs: number) => Promise<Uint8Array | null>;
export const MAX_DECODE_BYTES = 80 * 1024 * 1024;
/** 웹뷰의 소리 해독기로 구간을 잘라 WAV 로. 해독이 안 되면(코덱·크기·환경) null → 미리듣기를 끈다. */
export const webAudioClip: ClipMaker = async (bytes, _mime, startMs, endMs) => {
  try {
    if (bytes.length > MAX_DECODE_BYTES) return null;
    const Ctx = (globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i));
      return pcmToWavClip({ channels, sampleRate: buf.sampleRate, startMs, endMs });
    } finally { void ctx.close?.(); }
  } catch { return null; }
};
export function wavDurationMs(wav: Uint8Array): number {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = dv.getUint32(28, true), data = dv.getUint32(40, true);
  return byteRate > 0 ? Math.floor(data / byteRate * 1000) : 0;
}
const uniquePath = (files: readonly FileInput[], want: string) => {
  const taken = new Set(files.map(f => f.path.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  for (let i = 2; ; i++) { const p = want.replace(/(\.\w+)$/, `-${i}$1`); if (!taken.has(p.toLowerCase())) return p; }
};

export type LockPrep = { input: PublishInput; previewOff: boolean; notes: string[] };
/**
 * 발행 입력에 열람 보호를 입힌다: 열쇠를 (없으면 만들어) 이 컴퓨터에 저장하고, 미리듣기·미리보기를 **별도 클립**으로 나눈다.
 *  · 음악: 고른 곡의 구간을 잘라 WAV 클립으로 만든다(못 만들면 미리듣기를 끈다 — 곡 전체를 「미리듣기」로 올리지 않는다).
 *  · 책: 미리보기로 고른 PDF 를 암호화 대상에서 빼 클립으로 쓴다.
 *  · 디지털: 클립 없음.
 */
export async function lockedInputFor(invoke: Invoke, input: PublishInput, opts: { makeClip?: ClipMaker; rng?: Rng } = {}): Promise<LockPrep> {
  const key = await ensureProductKey(invoke, input.asset, opts.rng);
  const notes: string[] = [];
  let files = input.files, clip: FileInput | null = null, details = input.details, previewOff = false;
  if (input.type === 'music') {
    const d = input.details as MusicSection;
    const src = d.previewFile && d.previewStartMs !== null && d.previewEndMs !== null ? files.find(f => f.path === d.previewFile && (f.role ?? 'content') === 'content') : undefined;
    const wav = src ? await (opts.makeClip ?? webAudioClip)(src.bytes, src.mime ?? '', d.previewStartMs as number, d.previewEndMs as number) : null;
    if (src && wav) {
      const path = uniquePath(files, 'preview-clip.wav');
      clip = { path, bytes: wav, mime: 'audio/wav', role: 'content' };
      details = { previewFile: path, previewStartMs: 0, previewEndMs: Math.max(1000, wavDurationMs(wav)) } satisfies MusicSection;
    } else {
      previewOff = true; if (src) notes.push(LOCK_COPY.noClip);
      details = { previewFile: null, previewStartMs: null, previewEndMs: null } satisfies MusicSection;
    }
  } else if (input.type === 'book') {
    const d = input.details as BookSection;
    const src = d.previewFile ? files.find(f => f.path === d.previewFile && (f.role ?? 'content') === 'content') : undefined;
    if (src) { clip = { ...src, role: 'content' }; files = files.filter(f => f !== src); }
    else { previewOff = true; details = { ...d, previewFile: null, previewPages: 0 } satisfies BookSection; }
  }
  return { input: { ...input, files, details, lock: { key, previewClip: clip, rng: opts.rng } }, previewOff, notes };
}

/* ── 장부(판매자: 한 결제에 몇 번 허가했나) ─────────────────────────────── */
export const LEDGER_KEY = 'rv-lock-ledger-v1';
function ledgerOf(store: Storage | null): LockLedger & { add(e: LedgerEntry): void } {
  const read = (): LedgerEntry[] => { try { const a = JSON.parse(store?.getItem(LEDGER_KEY) ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  return {
    list: (asset, txid) => read().filter(e => e.asset === asset && e.txid === txid),
    add(e) { const all = read(); if (all.some(x => x.asset === e.asset && x.txid === e.txid && x.lockPub === e.lockPub)) return; try { store?.setItem(LEDGER_KEY, JSON.stringify([...all, e].slice(-2000))); } catch { /* 장부를 못 써도 허가는 이미 만들었다 */ } },
  };
}

/* ── 판매자: 열람 요청 처리 ─────────────────────────────────────────── */
export type SellerDeps = {
  invoke: Invoke;
  /** 이 컴퓨터 IPFS 에서 CID 의 내용을 읽는다(매니페스트용 — 작다). */
  fetch: (cid: string) => Promise<Uint8Array | null>;
  /** 내가 올린 상품들(MINE_KEY). */
  mine: () => Array<{ asset: string; title: string; manifestCid: string }>;
  /** 검증됨 상품이면 허용 목록의 메모 번호. 보증층은 늘 OPEN_MARKET_GAME_INDEX. */
  verifiedIndex?: (asset: string) => number | null;
  pickFile?: () => Promise<string | null>;
  storage?: Storage | null; now?: () => number;
};
export function wireLockSeller(deps: SellerDeps) {
  const store = (() => { try { return deps.storage === undefined ? window.localStorage : deps.storage; } catch { return null; } })();
  const ledger = ledgerOf(store);
  const secrets = secretStore(deps.invoke);
  const now = () => deps.now?.() ?? Date.now();
  const manifests = new Map<string, CreatorManifest>();
  let pickedFile: string | null = null;
  const say = (t: string, cls = '') => { const e = el('lk-s-say'); e.textContent = t; e.className = cls; };

  async function manifestOf(m: { asset: string; manifestCid: string }): Promise<CreatorManifest | null> {
    const c = manifests.get(m.asset); if (c) return c;
    const bytes = await deps.fetch(m.manifestCid);
    if (!bytes) return null;
    try { const v = verifyManifest(bytes, { expectedAsset: m.asset }).manifest; manifests.set(m.asset, v); return v; } catch { return null; }
  }
  async function paintKey() {
    const asset = el<HTMLSelectElement>('lk-s-asset').value;
    const box = el('lk-s-key'); box.textContent = '';
    if (!asset) return;
    const item = deps.mine().find(x => x.asset === asset); const m = item ? await manifestOf(item) : null;
    const k = await secrets.get(sellerKeyName(asset)).catch(() => null);
    if (!m) { box.textContent = '상품 정보를 이 컴퓨터의 IPFS 에서 읽지 못했어요.'; return; }
    if (!m.lock) { box.textContent = LOCK_COPY.noLock; return; }
    if (!k) { box.textContent = LOCK_COPY.sellerNeedsKey; box.className = 'creator-bad'; return; }
    const same = lockKeyId(asset, k) === m.lock.keyId;
    box.textContent = same ? `열쇠: 이 컴퓨터에 있어요(지문 ${m.lock.keyId.slice(0, 8)}…). 열람 요청을 처리할 수 있어요.` : '이 컴퓨터의 열쇠가 상품에 적힌 지문과 달라요 → 백업 파일에서 되돌려 주세요.';
    box.className = same ? 'creator-good' : 'creator-bad';
  }
  function refresh() {
    const sel = el<HTMLSelectElement>('lk-s-asset'), keep = sel.value;
    sel.replaceChildren(...deps.mine().map(m => new Option(`${m.title} · ${m.asset}`, m.asset)));
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    void paintKey();
  }
  const toggle = (btn: string, box: string, onOpen?: () => void) => {
    el(btn).onclick = () => { const b = el(box); b.hidden = !b.hidden; el(btn).setAttribute('aria-expanded', String(!b.hidden)); if (!b.hidden) onOpen?.(); };
  };
  toggle('lk-s-toggle', 'lk-seller', refresh);
  toggle('lk-s-restore-toggle', 'lk-s-restore-box');
  el('lk-s-asset').addEventListener('change', () => void paintKey());

  async function txOf(txid: string): Promise<LockTx | null> {
    try {
      const r = await deps.invoke<{ txid: string; confirmations: number; blockHeight: number | null; inputAddresses: string[]; outputs: Array<{ atoms: string; scriptHex: string }> }>('lock_tx_info', { txid });
      return r?.txid === txid ? { txid, confirmations: Number(r.confirmations) || 0, blockHeight: r.blockHeight ?? null, inputAddresses: r.inputAddresses ?? [], outputs: r.outputs ?? [] } : null;
    } catch { return null; }
  }
  el('lk-s-go').onclick = async () => {
    const grantBox = el('lk-s-grant-wrap'), copy = el('lk-s-copy'); grantBox.hidden = true; copy.hidden = true;
    const text = el<HTMLTextAreaElement>('lk-s-request').value;
    const req = decodeLockRequest(text);
    if (!req) { say('열람 요청 글이 아니에요. 구매자가 보낸 글 전체를 다시 붙여 넣어 주세요.', 'creator-bad'); return; }
    const item = deps.mine().find(x => x.asset === req.asset);
    if (!item) { say('내가 올린 상품의 요청이 아니에요(다른 상품이거나 이 컴퓨터에서 올리지 않았어요).', 'creator-bad'); return; }
    const m = await manifestOf(item);
    if (!m || !m.lock) { say(m ? LOCK_COPY.noLock : '상품 정보를 읽지 못했어요 → IPFS 가 켜져 있는지 확인해 주세요.', 'creator-bad'); return; }
    const key = await secrets.get(sellerKeyName(req.asset)).catch(() => null);
    if (!key) { say(LOCK_COPY.sellerNeedsKey, 'creator-bad'); return; }
    say('결제 거래를 확인하는 중…');
    const tx = await txOf(req.txid);
    const idx = [OPEN_MARKET_GAME_INDEX, ...(deps.verifiedIndex?.(req.asset) != null ? [deps.verifiedIndex!(req.asset)!] : [])];
    const v = processLockRequest({ requestText: text, manifest: m, key, tx, verifyPayment: sellerSharePayment({ manifest: m, gameIndexes: idx }), ledger, now: Math.floor(now() / 1000), minConfirmations: DEFAULT_MIN_CONFIRMATIONS });
    key.fill(0);
    if (!v.ok) { say(v.say + (v.wait ? ' (기다리면 되는 경우예요.)' : ''), v.wait ? '' : 'creator-bad'); return; }
    ledger.add(v.entry);
    el<HTMLTextAreaElement>('lk-s-grant').value = v.grant;
    grantBox.hidden = false; copy.hidden = false;
    say(`확인했어요 — 결제한 주소 ${v.payer} 가 서명했고, 결제도 맞아요${v.repeat ? '(같은 요청이라 다시 만들어 드렸어요)' : ''}. 아래 열람 허가 글을 구매자에게 직접 보내 주세요(메신저·메일 등). 열쇠를 받은 사람이 남에게 주는 것은 막을 수 없어요.`, 'creator-good');
  };
  el('lk-s-copy').onclick = () => { void navigator.clipboard?.writeText(el<HTMLTextAreaElement>('lk-s-grant').value).catch(() => undefined); };

  // 백업 파일에서 되돌리기
  el('lk-s-pick').onclick = async () => { pickedFile = (await deps.pickFile?.().catch(() => null)) ?? null; el('lk-s-restore-say').textContent = pickedFile ? `고른 파일: ${pickedFile.split(/[\\/]/).pop()}` : '파일을 고르지 않았어요.'; };
  el('lk-s-restore').onclick = async () => {
    const out = el('lk-s-restore-say');
    if (!pickedFile) { out.textContent = '먼저 열쇠 파일을 골라 주세요.'; return; }
    const paper = el<HTMLInputElement>('lk-s-paper').value.trim();
    if (!paper) { out.textContent = '백업 열쇠(52글자)를 적어 주세요.'; return; }
    try { const r = await deps.invoke<{ asset?: string }>('lock_key_import', { file: pickedFile, key: paper }); out.textContent = `되돌렸어요: ${r?.asset ?? ''}`; el<HTMLInputElement>('lk-s-paper').value = ''; void paintKey(); }
    catch (e) { out.textContent = `되돌리지 못했어요(${errText(e)}) → 백업 열쇠와 파일이 맞는지 확인해 주세요. 이 컴퓨터의 다른 열쇠는 바꾸지 않았어요.`; }
  };
  return { refresh };
}

/* ── 구매자: 열람 요청 만들기 · 허가 받기 · 열기 ───────────────────────── */
export type BuyerPurchase = { asset: string; title: string; txid: string; manifestCid?: string };
export type BuyerDeps = {
  invoke: Invoke;
  fetch: (cid: string) => Promise<Uint8Array | null>;
  askPassword: () => Promise<string | null>;
  /** 암호문 구간 읽기. 기본 = lock_cid_range(Rust). */
  readRange?: (cid: string, offset: number, length: number) => Promise<Uint8Array>;
  now?: () => number; rng?: Rng;
};
export const READ_WINDOW = 4 * 1024 * 1024;
export function wireLockBuyer(deps: BuyerDeps) {
  const secrets = secretStore(deps.invoke);
  const now = () => deps.now?.() ?? Date.now();
  let cur: { p: BuyerPurchase; m: CreatorManifest } | null = null;
  let ac: AbortController | null = null;
  const urls: string[] = [];
  const say = (t: string, cls = '') => { const e = el('lk-b-say'); e.textContent = t; e.className = cls; };
  const readRange = deps.readRange ?? (async (cid, offset, length) => {
    const r = await deps.invoke<{ data?: string }>('lock_cid_range', { cid, offset, length });
    if (typeof r?.data !== 'string') throw new Error('range');
    return b64(r.data);
  });
  const clearMedia = () => { for (const u of urls.splice(0)) URL.revokeObjectURL(u); el('lk-b-media').replaceChildren(); };
  const closeAll = () => { ac?.abort(); ac = null; clearMedia(); };
  el('lk-b-close').onclick = () => { closeAll(); el('lk-buyer').hidden = true; };

  async function paintState() {
    if (!cur) return;
    const { p, m } = cur;
    const key = await secrets.get(`k.${p.asset}`).catch(() => null);
    const ok = !!key && !!m.lock && lockKeyId(p.asset, key) === m.lock.keyId;
    key?.fill(0);
    el('lk-b-request-box').hidden = ok; el('lk-b-open-box').hidden = !ok;
    el('lk-b-state').textContent = ok ? '열람 키가 이 컴퓨터에 있어요. 파일을 열 수 있어요.' : '아직 열람 키가 없어요. 열람 요청을 만들어 판매자에게 보내 주세요.';
    if (ok) paintFiles();
  }
  async function open(p: BuyerPurchase) {
    closeAll(); el('lk-buyer').hidden = false; el('lk-buyer').scrollIntoView?.({ block: 'nearest' });
    el('lk-b-title').textContent = `${p.title} · ${p.asset}`; el<HTMLTextAreaElement>('lk-b-request').value = ''; el<HTMLTextAreaElement>('lk-b-grant').value = '';
    el('lk-b-request-box').hidden = true; el('lk-b-open-box').hidden = true; say('상품 정보를 읽는 중…');
    if (!p.manifestCid) { say('이 결제 기록에는 상품 정보 주소가 없어요. 장터에서 이 상품을 다시 열어 주세요.', 'creator-bad'); return; }
    const bytes = await deps.fetch(p.manifestCid).catch(() => null);
    let m: CreatorManifest;
    try { if (!bytes) throw new Error('none'); m = verifyManifest(bytes, { expectedAsset: p.asset }).manifest; }
    catch { say('상품 정보를 읽지 못했어요 → IPFS 가 켜져 있는지 확인해 주세요.', 'creator-bad'); return; }
    if (!m.lock) { say(LOCK_COPY.noLock); el('lk-b-state').textContent = ''; return; }
    cur = { p, m }; say(''); await paintState();
  }

  const signer = (address: string) => async (message: string): Promise<string> => {
    const call = (passphrase?: string) => deps.invoke<{ signature: string }>('sign_message', { address, message, ...(passphrase ? { passphrase } : {}) });
    try { return String((await call())?.signature ?? ''); }
    catch (e) {
      if (!/잠겨/.test(String(e))) throw e;
      let pass = await deps.askPassword();
      if (!pass) throw new Error('비밀번호를 넣지 않아 서명하지 않았어요.');
      try { return String((await call(pass))?.signature ?? ''); } finally { pass = null; }
    }
  };
  el('lk-b-make').onclick = async () => {
    if (!cur) return;
    const { p } = cur;
    say('결제 거래를 읽는 중…');
    let inputs: string[] = [];
    try { inputs = (await deps.invoke<{ inputAddresses?: string[] }>('lock_tx_info', { txid: p.txid }))?.inputAddresses ?? []; }
    catch { say('노드에서 이 결제 거래를 찾지 못했어요 → 노드가 따라잡았는지 확인하고 다시 눌러 주세요.', 'creator-bad'); return; }
    // 열람 키쌍: 같은 결제로 다시 만들어도 같은 키쌍을 쓴다(허가 글이 이미 왔을 수 있다).
    let priv = await secrets.get(`b.${p.txid}`).catch(() => null);
    if (!priv) { const kp = newLockKeypair(deps.rng); priv = kp.priv; try { await secrets.put(`b.${p.txid}`, priv); } catch (e) { say(`열람 키를 이 컴퓨터에 저장하지 못했어요(${errText(e)}).`, 'creator-bad'); return; } }
    const lockPub = hexOf(x25519.getPublicKey(priv)); priv.fill(0);
    let text = '', lastErr = '';
    for (const addr of inputs) {
      try { text = await createLockRequest({ asset: p.asset, txid: p.txid, lockPub, at: Math.floor(now() / 1000), sign: signer(addr) }); break; }
      catch (e) { lastErr = String((e as Error)?.message ?? e); if (/비밀번호를 넣지/.test(lastErr)) break; }
    }
    if (!text) { say(/비밀번호를 넣지/.test(lastErr) ? lastErr : LOCK_COPY.exchangePayer, 'creator-bad'); return; }
    el<HTMLTextAreaElement>('lk-b-request').value = text;
    say('열람 요청 글을 만들었어요. 판매자에게 보내 주세요(메신저·메일 등). 판매자 컴퓨터가 켜져 있을 때 열람 허가 글이 돌아와요.', 'creator-good');
  };
  el('lk-b-copy').onclick = () => { void navigator.clipboard?.writeText(el<HTMLTextAreaElement>('lk-b-request').value).catch(() => undefined); };
  el('lk-b-accept').onclick = async () => {
    if (!cur) return;
    const { p, m } = cur;
    const priv = await secrets.get(`b.${p.txid}`).catch(() => null);
    if (!priv) { say('이 결제의 열람 키가 이 컴퓨터에 없어요 → 「열람 요청 만들기」를 먼저 눌러 주세요.', 'creator-bad'); return; }
    try {
      const key = openLockGrant({ grantText: el<HTMLTextAreaElement>('lk-b-grant').value, manifest: m, txid: p.txid, lockPriv: priv });
      await secrets.put(`k.${p.asset}`, key); key.fill(0);
      say('열람 허가를 확인했어요. 이제 파일을 열 수 있어요.', 'creator-good');
      el<HTMLTextAreaElement>('lk-b-grant').value = '';
      await paintState();
    } catch (e) {
      const code = e instanceof LockError ? e.code : '';
      say(code === 'asset' ? '다른 상품의 허가 글이에요.' : code === 'wrong-key' ? '허가 글 안의 열쇠가 이 상품과 맞지 않아요(가짜이거나 다른 상품이에요).'
        : `허가 글을 풀지 못했어요(${errText(e)}) → 판매자가 보낸 글 전체인지, 이 결제로 만든 요청에 대한 허가인지 확인해 주세요.`, 'creator-bad');
    } finally { priv.fill(0); }
  };

  function paintFiles() {
    if (!cur) return;
    const { m } = cur;
    const ul = document.createElement('ul'); ul.id = 'lk-b-files';
    for (const lf of m.lock!.files) {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button'; b.dataset.path = lf.path; b.textContent = `열기 · ${lf.path} · ${sizeText(lf.plainSize)}`;
      b.onclick = () => void play(lf);
      li.append(b); ul.append(li);
    }
    el('lk-b-files-slot').replaceChildren(ul);
  }
  /** 암호문을 구간으로 읽어 조각마다 풀고, 전체 평문 해시가 맞은 뒤에만 재생 주소(메모리 Blob)를 만든다. 디스크에는 아무것도 쓰지 않는다. */
  async function play(lf: LockFile) {
    if (!cur) return;
    const { p, m } = cur;
    clearMedia();
    const entry = m.files.find(f => f.path === lf.path);
    const key = await secrets.get(`k.${p.asset}`).catch(() => null);
    if (!entry || !key) { say('열람 키를 찾지 못했어요.', 'creator-bad'); return; }
    ac = new AbortController();
    const cancel = el<HTMLButtonElement>('lk-b-cancel'); cancel.hidden = false;
    cancel.onclick = () => { ac?.abort(); say('취소했어요. 풀어 둔 내용은 남기지 않았어요.'); };
    say(`파일을 받아 푸는 중… (${sizeText(lf.plainSize)}) 큰 파일은 메모리를 그만큼 써요.`);
    let win: { start: number; buf: Uint8Array } | null = null;
    const read = async (offset: number, length: number) => {
      if (win && offset >= win.start && offset + length <= win.start + win.buf.length) return win.buf.subarray(offset - win.start, offset - win.start + length);
      const buf = await readRange(entry.cid, offset, Math.min(READ_WINDOW, entry.size - offset));
      if (buf.length < length) throw new Error('short');
      win = { start: offset, buf };
      return buf.subarray(0, length);
    };
    try {
      const plain = await decryptToMemory({ key, asset: p.asset, file: lf, read, signal: ac.signal });
      const url = URL.createObjectURL(new Blob([plain.slice().buffer as ArrayBuffer], { type: entry.mime })); urls.push(url);
      plain.fill(0);
      const media = el('lk-b-media');
      if (entry.mime.startsWith('audio/')) {
        const audio = document.createElement('audio'); audio.controls = true; audio.src = url; audio.id = 'lk-b-audio'; media.replaceChildren(audio);
      } else {
        const a = document.createElement('a'); a.href = url; a.download = lf.path.split('/').pop() ?? 'file'; a.textContent = `받기 · ${lf.path}`; a.id = 'lk-b-download'; media.replaceChildren(a);
      }
      say('풀었어요. 파일 내용이 상품 정보의 지문과 같아요.', 'creator-good');
    } catch (e) {
      const code = e instanceof LockError ? e.code : '';
      if (code !== 'aborted') say(code === 'plain-hash' || code === 'chunk' ? '파일이 변조됐거나 받는 중에 깨졌어요. 아무것도 열지 않았어요 → 다시 시도해 주세요.' : `파일을 받지 못했어요(${errText(e)}) → IPFS 가 켜져 있는지, 판매자가 파일을 보관 중인지 확인해 주세요.`, 'creator-bad');
    } finally { key.fill(0); cancel.hidden = true; ac = null; }
  }
  return { open, close: closeAll };
}
