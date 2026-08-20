/**
 * 손님용 레이븐코인 지갑.
 *
 * 이 파일이 지키는 선 세 개:
 *
 *  1. 12단어와 개인키는 이 브라우저 밖으로 나가지 않는다. 서버로 가는 것은
 *     ① 조회할 "주소" 와 ② 이미 서명이 끝난 "거래 바이트" 뿐이다.
 *  2. 노드 RPC 를 브라우저에서 직접 부르지 않는다. 가게 서버가 열어 준
 *     /api/chain/address 와 /api/chain/send 두 개만 쓴다.
 *  3. 런타임에 바깥 인터넷을 쓰지 않는다. 손님 폰은 가게 와이파이만 잡혀
 *     있을 수 있다. QR 도 가게 서버(/api/qr)가 그려 준다.
 */
import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import { rvn, toBitcoinJS } from "@hyperbitjs/chains";
import RavencoinKey from "@ravenrebels/ravencoin-key";
import { sign } from "@ravenrebels/ravencoin-sign-transaction";
import { wordlists } from "bip39";
import { signEvent, publish, tag, KIND_LISTING } from "./nostr";

// ── 상수 ────────────────────────────────────────────────────────────────────

const NET_NAME = "rvn" as const;

/** bitcoinjs 가 쓰는 모양의 레이븐 메인넷 파라미터 (pubKeyHash 60 → R… 주소). */
const NETWORK: bitcoin.Network = (() => {
  const n = toBitcoinJS(rvn.mainnet as never) as unknown as bitcoin.Network;
  // ECPair 가 bech32 를 undefined 로 두면 터진다. 레이븐엔 bech32 가 없다.
  if (!n.bech32) (n as { bech32: string }).bech32 = "";
  return n;
})();

/**
 * 레이븐 코어와 같은 경로여야 한다. 여기가 어긋나면 코어에서 만든 지갑을
 * 여기서 열었을 때 "잔액 0" 으로 보인다 — 돈이 없어진 게 아니라 다른 서랍을
 * 열어 본 것이고, 사람은 그걸 구별하지 못한다.
 */
const derivationPath = (i: number) => `m/44'/175'/0'/0/${i}`;

/** 코어 지갑은 27번까지 쓴 실제 사례가 있고 keypool 이 984 다. 0번만 보면 안 된다. */
const SCAN_MAX = 100;
/** 연속으로 이만큼 비어 있으면 그만 본다. */
const GAP_LIMIT = 20;
/** 이보다 작은 출력은 수수료보다 싸서 릴레이가 거부될 수 있다 (shop.rs 와 같은 값). */
const DUST_SATS = 546;
/** kB 당 수수료. 손님이 카운터 앞에 서 있으므로 아껴서 묶이는 쪽보다 넉넉한 쪽을 고른다. */
const FEE_PER_KB = 1_000_000;
/** 계산 실수로 전 재산이 수수료가 되는 일만은 막는다. */
const FEE_CEILING_SATS = 100_000_000;

const STORE_KEY = "playx.raven.wallet.v1";
const PBKDF2_ITER = 210_000;

/// 잠그지 않기로 한 지갑에도 같은 형식을 쓴다. 저장·복호 경로가 하나여야
/// 나중에 잠글 때 새로운 버그가 생기지 않는다.
const NO_LOCK = "\u0000playx-open-wallet";
/** 카운터에 폰을 두고 자리를 뜨는 일이 있다. */
const IDLE_LOCK_MS = 10 * 60 * 1000;

const SATS = 100_000_000;

// ── 타입 ────────────────────────────────────────────────────────────────────

interface AddressObject {
  address: string;
  privateKey: string;
  publicKey: string;
  WIF: string;
  path?: string;
}

/** ravencoin-sign-transaction 의 IUTXO 와 같은 모양이어야 한다. */
interface SpendUtxo {
  address: string;
  assetName: string;
  txid: string;
  outputIndex: number;
  script: string;
  satoshis: number;
  value: number;
}

interface ChainReply {
  address: string;
  rvn: number;
  utxos: unknown[];
  source: string;
  trusted: boolean;
  error?: string;
}

interface ScanRow {
  index: number;
  address: string;
  utxos: SpendUtxo[];
  sats: number;
}

interface ScanResult {
  rows: ScanRow[];
  source: string;
  trusted: boolean;
  scanned: number;
  deep: boolean;
}

interface Vault {
  v: 1;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

interface Selection {
  inputs: SpendUtxo[];
  amount: number;
  fee: number;
  change: number;
}

// ── 자잘한 도구 ─────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 사람이 친 "1.5" 를 정수 사토시로. 부동소수로 곱하면 1원씩 어긋난다. */
function toSats(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const n = Number(whole) * SATS + Number((frac + "00000000").slice(0, 8));
  return Number.isSafeInteger(n) ? n : null;
}

function fromSats(n: number): string {
  const sign_ = n < 0 ? "-" : "";
  const v = Math.abs(n);
  const whole = Math.floor(v / SATS);
  const frac = String(v % SATS).padStart(8, "0").replace(/0+$/, "");
  return sign_ + whole.toLocaleString() + (frac ? "." + frac : "");
}

const rvnText = (sats: number) => `${fromSats(sats)} RVN`;

function randomInt(max: number): number {
  // Math.random 은 지갑에 쓰지 않는다. 여기선 퀴즈용이지만 습관을 나누지 않는다.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

// ── 화면 전환 ───────────────────────────────────────────────────────────────

type Screen =
  | "loading" | "welcome" | "unlock" | "words" | "quiz"
  | "restore" | "password" | "main" | "send" | "confirm" | "sent"
  | "insecure" | "sell";

function show(screen: Screen): void {
  document.body.dataset.screen = screen;
  window.scrollTo(0, 0);
}

function say(id: string, msg: string, kind: "" | "err" | "ok" = ""): void {
  const el = $(id);
  el.textContent = msg;
  el.className = "msg" + (kind ? " " + kind : "");
}

// ── 금고: 12단어를 암호로 잠가서 이 브라우저에만 둔다 ────────────────────────

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── 지문 · 얼굴로 열기 ──────────────────────────────────────────────────────
//
// 폰에서 숫자 여섯 자리를 매번 치는 것이 이 지갑의 가장 잦은 마찰이다. 폰은
// 이미 얼굴이나 지문으로 잠겨 있는데 그 위에 또 한 겹을 요구하는 셈이라,
// 사람은 그걸 이기려고 123456 을 쓴다 — 그러면 잠금은 연극이 된다.
//
// ## 왜 "지문으로 잠금번호를 대신 기억" 이 아닌가
//
// 잠금번호를 어딘가에 저장해 두고 지문으로 꺼내는 방식은, 그 저장된 값이
// 디스크에 있다는 뜻이다. 폰을 뜯으면 지문 없이 나온다.
//
// 여기서 쓰는 것은 WebAuthn 의 `prf` 확장이다. 인증기(보안 칩)가 **자기만
// 아는 씨앗**으로 32바이트를 만들어 주는데, 그 값은 저장되지 않고 얼굴이나
// 지문이 맞을 때마다 다시 계산된다. 그 32바이트를 잠금번호 자리에 그대로
// 넣는다 — 자물쇠는 하나뿐이고, 열쇠만 바뀐다.
//
// ## 못 쓰는 환경이 있다
//
// prf 는 사파리 18, 크롬 132 언저리부터다. 없으면 **없다고 말하고 숫자를
// 받는다.** 되는 척하고 약한 방식으로 넘어가는 것이 제일 나쁘다.
//
// ## 이 기기를 잃으면
//
// 그 칩 안의 씨앗은 복제되지 않으므로 이 브라우저의 사본은 영영 못 연다.
// 12단어는 그대로 살아 있고, 그게 원래 진짜 열쇠다. 화면이 그 사실을 켜기
// 전에 말한다.

/** 이 지갑이 늘 같은 값을 얻도록 고정한다. 비밀이 아니라 이름표다. */
const PRF_SALT = new TextEncoder().encode("playx.raven.wallet.prf.v1");

function bioSupported(): boolean {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    // 보안 맥락이 아니면 WebAuthn 자체가 없다. 매장 LAN(http)이 그렇다.
    window.isSecureContext === true
  );
}

/** 인증기가 실제로 얼굴·지문을 갖고 있나. */
async function bioAvailable(): Promise<boolean> {
  if (!bioSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function prfSecret(cred: unknown): string | null {
  const r = (cred as { getClientExtensionResults?: () => { prf?: { results?: { first?: ArrayBuffer } } } })
    .getClientExtensionResults?.();
  const first = r?.prf?.results?.first;
  return first ? toB64(new Uint8Array(first)) : null;
}

/** 새 자격을 만들고 그 32바이트를 돌려준다. 없으면 null — 거짓말하지 않는다. */
async function bioEnrol(): Promise<{ id: string; secret: string } | null> {
  if (!(await bioAvailable())) return null;
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "PLAY X Raven 지갑" },
      user: {
        // 계정이 없는 지갑이다. 서버에 보낼 신원이 없으므로 고정값을 쓴다.
        id: new TextEncoder().encode("playx-raven-wallet"),
        name: "내 지갑",
        displayName: "내 지갑",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) return null;

  // 만들자마자 prf 가 안 나오는 인증기가 있다. 그때는 한 번 더 물어 얻는다.
  let secret = prfSecret(cred);
  const id = toB64(new Uint8Array(cred.rawId));
  if (!secret) secret = await bioSecret(id);
  return secret ? { id, secret } : null;
}

/** 등록해 둔 자격으로 같은 32바이트를 다시 얻는다. 얼굴·지문을 여기서 묻는다. */
async function bioSecret(idB64: string): Promise<string | null> {
  if (!bioSupported()) return null;
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: fromB64(idB64) as unknown as BufferSource }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    return cred ? prfSecret(cred) : null;
  } catch {
    return null;
  }
}

async function lockVault(mnemonic: string, password: string): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    enc.encode(mnemonic) as unknown as BufferSource,
  );
  return {
    v: 1, iter: PBKDF2_ITER,
    salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)),
  };
}

async function openVault(vault: Vault, password: string): Promise<string> {
  const key = await deriveKey(password, fromB64(vault.salt), vault.iter || PBKDF2_ITER);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(vault.iv) as unknown as BufferSource },
    key,
    fromB64(vault.ct) as unknown as BufferSource,
  );
  return dec.decode(pt);
}

function readVault(): Vault | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Vault;
    return v && v.ct && v.salt && v.iv ? v : null;
  } catch {
    return null;
  }
}

// ── 서버에 묻기 (주소만 나간다) ─────────────────────────────────────────────

async function fetchAddress(address: string): Promise<ChainReply> {
  const r = await fetch(`/api/chain/address?address=${encodeURIComponent(address)}`, {
    credentials: "omit",
    cache: "no-store",
  });
  const j = (await r.json()) as ChainReply;
  if (j && j.error) throw new Error(j.error);
  if (!r.ok) throw new Error("조회에 실패했습니다.");
  return j;
}

async function broadcast(hex: string): Promise<string> {
  const r = await fetch("/api/chain/send", {
    credentials: "omit",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hex }),
  });
  const j = (await r.json()) as { txid?: string; error?: string };
  if (j.error) throw new Error(j.error);
  if (!j.txid) throw new Error("노드가 거래번호를 주지 않았습니다.");
  return j.txid;
}

/**
 * 서버가 노드 색인(satoshis·txid·outputIndex·script)으로 답할 수도,
 * Electrum(value·tx_hash·tx_pos)으로 답할 수도 있다. 둘 다 받는다.
 *
 * 스크립트가 이 주소의 P2PKH 와 정확히 같은 것만 통과시킨다. 레이븐은 자산도
 * 같은 주소에 붙는데, 자산 출력을 RVN 인 줄 알고 입력으로 쓰면 그 자산은
 * 그대로 탄다. Electrum 응답에는 script 가 없으므로 주소에서 만들어 쓴다.
 */
function normalizeUtxos(address: string, rows: unknown[]): SpendUtxo[] {
  const spk = bitcoin.address.toOutputScript(address, NETWORK).toString("hex").toLowerCase();
  const out: SpendUtxo[] = [];

  for (const raw of rows || []) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== "object") continue;

    const asset = r.assetName ?? r.asset ?? r.asset_name;
    if (asset && String(asset).toUpperCase() !== "RVN") continue;

    const txid = (r.txid ?? r.tx_hash) as unknown;
    const vout = (r.outputIndex ?? r.tx_pos) as unknown;
    const sats = (r.satoshis ?? r.value) as unknown;

    if (typeof txid !== "string" || !/^[0-9a-f]{64}$/i.test(txid)) continue;
    if (typeof vout !== "number" || !Number.isInteger(vout) || vout < 0) continue;
    if (typeof sats !== "number" || !Number.isFinite(sats) || sats <= 0) continue;

    const script = typeof r.script === "string" && r.script ? r.script.toLowerCase() : spk;
    if (script !== spk) continue;

    out.push({
      address, assetName: "RVN",
      txid: txid.toLowerCase(), outputIndex: vout,
      script, satoshis: Math.round(sats), value: Math.round(sats),
    });
  }
  return out;
}

// ── 주소 훑기 ───────────────────────────────────────────────────────────────

/**
 * 0..99 를 훑되 연속 20개가 비면 멈춘다.
 *
 * 한 가지는 솔직히 적어 둔다: 여기서 "비었다"는 것은 지금 UTXO 가 없다는
 * 뜻이지 한 번도 쓴 적이 없다는 뜻이 아니다. 받았다가 다 써 버린 주소도
 * 비어 보인다. 그래서 사이가 넓게 벌어진 지갑은 일찍 멈출 수 있고, 그럴 때를
 * 위해 화면에 "끝까지 찾기"(deep)를 남겨 둔다.
 */
async function scanAddresses(
  hd: unknown,
  deep: boolean,
  onProgress: (done: number) => void,
): Promise<ScanResult> {
  const rows: ScanRow[] = [];
  let source = "";
  let trusted = true;
  let scanned = 0;
  const CHUNK = 5;

  for (let start = 0; start < SCAN_MAX; start += CHUNK) {
    const batch: number[] = [];
    for (let i = start; i < Math.min(start + CHUNK, SCAN_MAX); i++) batch.push(i);

    const got = await Promise.all(
      batch.map(async (i) => {
        const a = RavencoinKey.getAddressByPath(NET_NAME, hd, derivationPath(i)) as AddressObject;
        return { i, address: a.address, reply: await fetchAddress(a.address) };
      }),
    );

    for (const g of got) {
      const utxos = normalizeUtxos(g.address, g.reply.utxos);
      rows[g.i] = {
        index: g.i,
        address: g.address,
        utxos,
        sats: utxos.reduce((s, u) => s + u.satoshis, 0),
      };
      if (g.reply.source) source = g.reply.source;
      if (g.reply.trusted === false) trusted = false;
    }

    scanned = Math.min(start + CHUNK, SCAN_MAX);
    onProgress(scanned);

    if (!deep) {
      let gap = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] && rows[i].sats === 0) gap++;
        else break;
      }
      if (gap >= GAP_LIMIT) break;
    }
  }

  return { rows: rows.filter(Boolean), source, trusted, scanned, deep };
}

// ── 거래 만들기 ─────────────────────────────────────────────────────────────

/** P2PKH 기준 어림. 입력 148, 출력 34, 머리꼬리 10. */
const estimateSize = (nIn: number, nOut: number) => 10 + 148 * nIn + 34 * nOut;
const feeFor = (bytes: number) => Math.ceil(bytes / 1000) * FEE_PER_KB;

function selectCoins(all: SpendUtxo[], target: number): Selection | { error: string } {
  const sorted = [...all].sort((a, b) => b.satoshis - a.satoshis);
  const inputs: SpendUtxo[] = [];
  let sum = 0;

  for (const u of sorted) {
    inputs.push(u);
    sum += u.satoshis;

    const fee2 = feeFor(estimateSize(inputs.length, 2));
    if (sum >= target + fee2 + DUST_SATS) {
      return { inputs: [...inputs], amount: target, fee: fee2, change: sum - target - fee2 };
    }
    // 거스름이 먼지밖에 안 되면 출력을 만들지 않고 수수료로 넘긴다.
    const fee1 = feeFor(estimateSize(inputs.length, 1));
    if (sum >= target + fee1) {
      return { inputs: [...inputs], amount: target, fee: sum - target, change: 0 };
    }
  }
  return { error: "잔액이 모자랍니다. 수수료까지 낼 만큼은 있어야 합니다." };
}

function selectAll(all: SpendUtxo[]): Selection | { error: string } {
  const inputs = [...all];
  if (!inputs.length) return { error: "보낼 것이 없습니다." };
  const sum = inputs.reduce((s, u) => s + u.satoshis, 0);
  const fee = feeFor(estimateSize(inputs.length, 1));
  const amount = sum - fee;
  if (amount < DUST_SATS) return { error: "수수료를 내고 나면 보낼 것이 남지 않습니다." };
  return { inputs, amount, fee, change: 0 };
}

function buildAndSign(
  sel: Selection,
  toAddress: string,
  changeAddress: string,
  keys: Record<string, string>,
): string {
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  for (const u of sel.inputs) {
    tx.addInput(Buffer.from(u.txid, "hex").reverse(), u.outputIndex);
  }
  tx.addOutput(bitcoin.address.toOutputScript(toAddress, NETWORK), sel.amount);
  if (sel.change > 0) {
    tx.addOutput(bitcoin.address.toOutputScript(changeAddress, NETWORK), sel.change);
  }

  // 서명하기 전에 스스로 검산한다. 들어온 것에서 나간 것을 뺀 나머지가
  // 수수료다 — 이 숫자가 화면에 보여 준 것과 다르면 사람이 동의한 거래가
  // 아니므로 보내지 않는다.
  const inSum = sel.inputs.reduce((s, u) => s + u.satoshis, 0);
  const outSum = sel.amount + sel.change;
  const realFee = inSum - outSum;
  if (realFee !== sel.fee) throw new Error("수수료 계산이 맞지 않아 중단했습니다.");
  if (realFee <= 0) throw new Error("수수료가 0 이하입니다. 중단했습니다.");
  if (realFee > FEE_CEILING_SATS) throw new Error("수수료가 비정상적으로 큽니다. 중단했습니다.");

  return sign(NET_NAME, tx.toHex(), sel.inputs, keys);
}

// ── 지갑 상태 ───────────────────────────────────────────────────────────────

let mnemonic: string | null = null;
let hdKey: unknown = null;
let scan: ScanResult | null = null;
let pending: { sel: Selection; to: string; change: string } | null = null;

/** 만들기 흐름에서만 쓰는 임시 값. 잠글 때 같이 지운다. */
let draftMnemonic: string | null = null;
let quizPlan: { position: number; options: string[] }[] = [];
let quizAt = 0;

let idleTimer: number | undefined;

function touchIdle(): void {
  window.clearTimeout(idleTimer);
  if (!mnemonic) return;
  idleTimer = window.setTimeout(lock, IDLE_LOCK_MS);
}

function lock(): void {
  mnemonic = null;
  hdKey = null;
  scan = null;
  pending = null;
  draftMnemonic = null;
  quizPlan = [];
  window.clearTimeout(idleTimer);
  ($("unlock-pass") as HTMLInputElement).value = "";
  say("unlock-msg", "");
  const v = readVault();
  if (!v) {
    show("welcome");
    return;
  }
  void showLockedOrOpen(v);
}

// ── 중고 물건 올리기 (Nostr NIP-99) ────────────────────────────────────────
//
// 가게로 등록하려면 500 RVN 을 태우고 노드를 켜 둬야 한다. 장사하는 사람에겐
// 아무것도 아니지만, 자전거 한 대 파는 사람에게는 넘을 이유가 없는 벽이다.
// 그래서 개인 물건은 온체인이 아니라 Nostr 글로 간다 — 공짜고, 노드도 자산도
// 필요 없고, 서명만 하면 된다.
//
// 🔴 서명 키는 지갑 열쇠를 그대로 쓰지 않는다. Nostr 글은 공개고 영구적이라,
// 같은 키를 쓰면 **올린 글 전부가 그 사람의 잔액과 묶인다.** 누가 무엇을
// 팔았는지 보면 그 사람이 얼마를 가졌는지가 따라 보인다. 별도 경로로 판다.

function nostrSecret(): Uint8Array {
  if (!hdKey) throw new Error("지갑이 잠겨 있습니다.");
  // 지갑 주소 경로와 겹치지 않는 자리. 여기서 나온 키로는 돈을 못 움직인다.
  const k = RavencoinKey.getAddressByPath(NET_NAME, hdKey, "m/44'/175'/7'/0/0") as {
    privateKey: string;
  };
  const hex = k.privateKey;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sellPublish(): Promise<void> {
  const v = (id: string) => ($(id) as HTMLInputElement | HTMLTextAreaElement).value.trim();
  const title = v("sl-title");
  const desc = v("sl-desc");
  const price = v("sl-price");
  const cur = ($("sl-cur") as HTMLSelectElement).value;
  const where = v("sl-where");

  if (!title) return say("sl-msg", "무엇을 파시는지 적어 주세요.", "err");
  if (!price || !isFinite(Number(price)) || Number(price) <= 0)
    return say("sl-msg", "얼마에 파실지 숫자로 적어 주세요.", "err");

  const btn = $("sl-go") as HTMLButtonElement;
  btn.disabled = true;
  say("sl-msg", "올리는 중…");
  try {
    // NIP-99. d 는 이 글의 고유 이름 — 나중에 같은 d 로 다시 올리면 수정이 되고,
    // 없으면 고칠 때마다 새 글이 쌓인다.
    const d = `playx-${Date.now().toString(36)}-${Math.floor(
      crypto.getRandomValues(new Uint32Array(1))[0] % 1e6
    ).toString(36)}`;
    const tags: string[][] = [
      ["d", d],
      ["title", title],
      ["price", String(Number(price)), cur],
      ["published_at", String(Math.floor(Date.now() / 1000))],
      ["t", "playx"],
    ];
    if (where) tags.push(["location", where]);

    const ev = signEvent(nostrSecret(), {
      kind: KIND_LISTING,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: desc,
    });
    const res = await publish(ev);
    const okCount = res.ok.length;
    if (!okCount) {
      say("sl-msg", "어느 릴레이도 받지 못했습니다. 인터넷을 확인하고 다시 눌러 주세요.", "err");
    } else {
      say("sl-msg", `${okCount}곳에 올렸습니다. 「가게 둘러보기」의 물건 탭에서 보입니다.`, "ok");
      ["sl-title", "sl-desc", "sl-price", "sl-where"].forEach((id) => {
        ($(id) as HTMLInputElement).value = "";
      });
    }
  } catch (e) {
    say("sl-msg", String((e as Error)?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

function unlocked(m: string): void {
  mnemonic = m;
  hdKey = RavencoinKey.getHDKey(NET_NAME, m);
  touchIdle();
  // 「물건 올리기」로 들어온 사람을 지갑 첫 화면에 떨궈 두면, 왜 여기 왔는지
  // 잊는다. 잠금을 푼 다음 하려던 자리로 이어 준다.
  show(location.hash === "#sell" ? "sell" : "main");

  // 잠그지 않은 지갑이면 그 사실을 계속 보여 준다. 한 번 뜨고 사라지는 경고는
  // 장식이고, 남아 있는 것만 사실이다. 그리고 잠글 길을 그 자리에 둔다 —
  // 경고만 하고 고칠 방법이 없으면 그건 잔소리다.
  const v = readVault() as unknown as Record<string, unknown> | null;
  const bar = document.getElementById("openwarn");
  if (bar) {
    if (v && v.open) {
      bar.innerHTML =
        `이 지갑은 <b>잠겨 있지 않습니다.</b> 이 폰을 주운 사람이 그대로 씁니다.
         <button id="btn-lock-now" class="ghost" style="margin-top:8px">지금 잠그기</button>`;
      bar.style.display = "";
      const b = document.getElementById("btn-lock-now");
      if (b) b.onclick = () => { draftMnemonic = m; show("password"); };
    } else {
      bar.style.display = "none";
    }
  }

  void refresh(false);
}

// ── 받을 주소 / 잔액 ────────────────────────────────────────────────────────

function addressAt(i: number): AddressObject {
  return RavencoinKey.getAddressByPath(NET_NAME, hdKey, derivationPath(i)) as AddressObject;
}

function spendableUtxos(): SpendUtxo[] {
  return scan ? scan.rows.flatMap((r) => r.utxos) : [];
}

function totalSats(): number {
  return spendableUtxos().reduce((s, u) => s + u.satoshis, 0);
}

/** 아직 안 쓴 첫 주소. 훑은 범위 안이라 다음에 열어도 반드시 다시 찾는다. */
function receiveIndex(): number {
  if (!scan) return 0;
  for (const r of scan.rows) if (r.sats === 0) return r.index;
  return Math.min(scan.rows.length, SCAN_MAX - 1);
}

async function refresh(deep: boolean): Promise<void> {
  const btn = $("btn-refresh") as HTMLButtonElement;
  const deepBtn = $("btn-deep") as HTMLButtonElement;
  btn.disabled = true;
  deepBtn.disabled = true;
  say("scan-status", deep ? "주소를 끝까지 찾는 중…" : "주소를 찾는 중…");

  try {
    scan = await scanAddresses(hdKey, deep, (done) => {
      say("scan-status", `주소 ${done}개까지 확인했습니다…`);
    });
    renderMain();
  } catch (e) {
    say("scan-status", (e as Error).message || "조회에 실패했습니다.", "err");
  } finally {
    btn.disabled = false;
    deepBtn.disabled = false;
    touchIdle();
  }
}

function renderMain(): void {
  if (!scan) return;

  const total = totalSats();
  $("balance").textContent = fromSats(total);

  const idx = receiveIndex();
  const addr = addressAt(idx).address;
  $("recv-addr").textContent = addr;
  $("recv-index").textContent = `${idx}번 주소`;

  // QR 은 가게 서버가 그린다. 손님 폰에 라이브러리를 내려받게 하지 않는다.
  const img = $("recv-qr") as HTMLImageElement;
  img.src = `/api/qr?text=${encodeURIComponent("raven:" + addr)}`;
  img.alt = "받을 주소 QR";

  // 훑는 동안에만 진행을 말한다. 다 끝난 뒤에도 "주소 20개 확인" 이 남아
  // 있으면 그건 정보가 아니라 잡음이고, 잔액 옆에서 시선을 빼앗는다.
  say("scan-status", "");

  // 연결 상태는 한 줄. 자세한 사정은 문제가 있을 때만 길어진다.
  const note = $("source-note");
  if (scan.trusted) {
    note.className = "link1";
    note.innerHTML = `<b>·</b> 가게 노드에 연결됨`;
  } else {
    note.className = "note warn";
    note.textContent =
      `이 가게 노드가 답하지 못해 바깥 서버 ${scan.source || "알 수 없음"} 가 답했습니다. ` +
      `바깥 서버는 잔액을 틀리게 말할 수 있습니다 — 다만 12단어가 여기 있는 한 ` +
      `그 서버가 돈을 가져갈 수는 없습니다.`;
  }

  // 잔액이 0 일 때만 "찾아보기" 를 내놓는다. 평소에 그 버튼이 서 있으면
  // 뭔가 덜 됐다는 신호로 읽힌다. 이미 끝까지 훑었으면 더 권하지 않는다.
  $("zerohelp").style.display = total <= 0 && !scan.deep ? "" : "none";

  ($("btn-send") as HTMLButtonElement).disabled = total <= 0;
}

// ── 만들기 → 종이에 적기 → 되묻기 ───────────────────────────────────────────

function startCreate(): void {
  draftMnemonic = RavencoinKey.generateMnemonic();
  const words = draftMnemonic.split(" ");
  $("words-grid").innerHTML = words
    .map((w, i) => `<div class="word"><span class="n">${i + 1}</span><b>${w}</b></div>`)
    .join("");
  show("words");
}

function planQuiz(): void {
  const words = (draftMnemonic || "").split(" ");
  const list = (wordlists.english || []) as string[];

  // 12개 중 서로 다른 3자리를 고른다.
  const picks: number[] = [];
  while (picks.length < 3) {
    const p = randomInt(words.length);
    if (!picks.includes(p)) picks.push(p);
  }
  picks.sort((a, b) => a - b);

  quizPlan = picks.map((position) => {
    const correct = words[position];
    const options = [correct];
    // 보기는 자기 단어와 사전에서 섞어 낸다. 자기 단어만 쓰면 종이를 안 보고도
    // 눈에 익은 것을 고를 수 있다.
    while (options.length < 6) {
      const pool = options.length % 2 === 0 ? words : list;
      const w = pool[randomInt(pool.length)];
      if (w && !options.includes(w)) options.push(w);
    }
    for (let i = options.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { position, options };
  });

  quizAt = 0;
  renderQuiz();
  show("quiz");
}

function renderQuiz(): void {
  const q = quizPlan[quizAt];
  $("quiz-progress").textContent = `${quizAt + 1} / ${quizPlan.length}`;
  $("quiz-q").textContent = `${q.position + 1}번째 단어는 무엇입니까?`;
  say("quiz-msg", "");

  const box = $("quiz-opts");
  box.innerHTML = "";
  for (const w of q.options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.textContent = w;
    b.onclick = () => answerQuiz(w);
    box.appendChild(b);
  }
}

function answerQuiz(word: string): void {
  const words = (draftMnemonic || "").split(" ");
  const q = quizPlan[quizAt];

  if (word !== words[q.position]) {
    // 틀렸으면 단어 화면으로 되돌린다. 여기서 통과시켜 주면 종이에 안 적은
    // 사람이 그대로 지나가고, 브라우저를 지우는 날 돈이 사라진다.
    say("quiz-msg", "틀렸습니다. 적어 둔 종이를 다시 확인해 주세요.", "err");
    window.setTimeout(() => show("words"), 1200);
    return;
  }

  quizAt++;
  if (quizAt < quizPlan.length) {
    renderQuiz();
    return;
  }
  goPassword();
}

// ── 되살리기 ────────────────────────────────────────────────────────────────

function doRestore(): void {
  const raw = ($("restore-input") as HTMLTextAreaElement).value;
  const words = raw.toLowerCase().trim().split(/\s+/).filter(Boolean);

  if (words.length !== 12) {
    say("restore-msg", `12개가 필요합니다. 지금 ${words.length}개 적혀 있습니다.`, "err");
    return;
  }
  const list = (wordlists.english || []) as string[];
  const bad = words.filter((w) => !list.includes(w));
  if (bad.length) {
    say("restore-msg", `사전에 없는 단어입니다: ${bad.join(", ")}`, "err");
    return;
  }
  const phrase = words.join(" ");
  if (!RavencoinKey.isMnemonicValid(phrase)) {
    say("restore-msg", "12단어가 서로 맞지 않습니다. 순서와 철자를 확인해 주세요.", "err");
    return;
  }

  draftMnemonic = phrase;
  goPassword();
}

// ── 암호 걸기 ───────────────────────────────────────────────────────────────

function goPassword(): void {
  ($("pw1") as HTMLInputElement).value = "";
  ($("pw2") as HTMLInputElement).value = "";
  say("pw-msg", "");
  show("password");
}

/// Saves the wallet without a lock.
///
/// ## Why this is allowed
///
/// This is a spending wallet holding coffee money, on a phone that already has
/// a lock screen. Demanding a second long password is friction people defeat by
/// typing `123456`, which is worse than no lock because it looks like one.
///
/// So it is a choice — and the main screen says, permanently, that the wallet is
/// open. A warning that appears once is decoration; one that stays is a fact.
/// 지문·얼굴로 잠근다. 잠금번호 자리에 인증기가 만든 32바이트를 넣는다.
async function saveWithBio(): Promise<void> {
  if (!draftMnemonic) {
    say("pw-msg", "다시 시작해 주세요.", "err");
    return;
  }
  const btn = $("btn-pw-bio") as HTMLButtonElement;
  btn.disabled = true;
  say("pw-msg", "얼굴이나 지문을 확인합니다…");
  try {
    const got = await bioEnrol();
    if (!got) {
      // 되는 척하지 않는다. 못 하면 못 한다고 말하고 숫자를 받는다.
      say("pw-msg", "이 기기에서는 지문·얼굴로 잠글 수 없습니다. 숫자 6자리로 해 주세요.", "err");
      btn.disabled = false;
      return;
    }
    const vault = await lockVault(draftMnemonic, got.secret);
    (vault as unknown as Record<string, unknown>).bio = got.id;
    localStorage.setItem(STORE_KEY, JSON.stringify(vault));
    const m = draftMnemonic;
    draftMnemonic = null;
    quizPlan = [];
    unlocked(m);
  } catch (e) {
    say("pw-msg", (e as Error).message || "잠그지 못했습니다.", "err");
    btn.disabled = false;
  }
}

async function saveWithoutLock(): Promise<void> {
  if (!draftMnemonic) {
    say("pw-msg", "다시 시작해 주세요.", "err");
    return;
  }
  const btn = $("btn-pw-skip") as HTMLButtonElement;
  btn.disabled = true;
  try {
    // 잠그지 않아도 저장 형식은 같다. 나중에 잠글 때 다른 길을 타지 않게.
    const vault = await lockVault(draftMnemonic, NO_LOCK);
    (vault as unknown as Record<string, unknown>).open = true;
    localStorage.setItem(STORE_KEY, JSON.stringify(vault));
    const m = draftMnemonic;
    draftMnemonic = null;
    quizPlan = [];
    unlocked(m);
  } catch (e) {
    say("pw-msg", (e as Error).message || "저장하지 못했습니다.", "err");
    btn.disabled = false;
  }
}

async function savePassword(): Promise<void> {
  const p1 = ($("pw1") as HTMLInputElement).value;
  const p2 = ($("pw2") as HTMLInputElement).value;

  if (p1.length < 6) {
    say("pw-msg", "잠금번호는 6자리 이상으로 정해 주세요.", "err");
    return;
  }
  if (p1 !== p2) {
    say("pw-msg", "두 칸이 서로 다릅니다.", "err");
    return;
  }
  if (!draftMnemonic) {
    say("pw-msg", "다시 시작해 주세요.", "err");
    return;
  }

  const btn = $("btn-pw-save") as HTMLButtonElement;
  btn.disabled = true;
  say("pw-msg", "잠그는 중…");
  try {
    const vault = await lockVault(draftMnemonic, p1);
    localStorage.setItem(STORE_KEY, JSON.stringify(vault));
    const m = draftMnemonic;
    draftMnemonic = null;
    quizPlan = [];
    unlocked(m);
  } catch (e) {
    say("pw-msg", (e as Error).message || "잠그지 못했습니다.", "err");
  } finally {
    btn.disabled = false;
  }
}

async function doUnlock(): Promise<void> {
  const vault = readVault();
  if (!vault) {
    show("welcome");
    return;
  }
  const pass = ($("unlock-pass") as HTMLInputElement).value;
  const btn = $("btn-unlock") as HTMLButtonElement;
  btn.disabled = true;
  say("unlock-msg", "여는 중…");
  try {
    const m = await openVault(vault, pass);
    if (!RavencoinKey.isMnemonicValid(m)) throw new Error("암호가 맞지 않습니다.");
    ($("unlock-pass") as HTMLInputElement).value = "";
    say("unlock-msg", "");
    unlocked(m);
  } catch {
    say("unlock-msg", "암호가 맞지 않습니다.", "err");
  } finally {
    btn.disabled = false;
  }
}

// ── 보내기 ──────────────────────────────────────────────────────────────────

function openSend(): void {
  ($("send-to") as HTMLInputElement).value = "";
  ($("send-amount") as HTMLInputElement).value = "";
  say("send-msg", "");
  $("send-have").textContent = rvnText(totalSats());
  show("send");
}

function reviewSend(): void {
  const to = ($("send-to") as HTMLInputElement).value.trim();
  const amountText = ($("send-amount") as HTMLInputElement).value;
  const utxos = spendableUtxos();

  try {
    // 틀린 주소·다른 코인 주소는 여기서 걸린다. 보내고 나면 되돌릴 수 없다.
    bitcoin.address.toOutputScript(to, NETWORK);
  } catch {
    say("send-msg", "받는 주소가 레이븐 주소가 아닙니다. 다시 확인해 주세요.", "err");
    return;
  }

  const target = toSats(amountText);
  if (target === null || target <= 0) {
    say("send-msg", "금액을 숫자로 적어 주세요. (소수점 아래 8자리까지)", "err");
    return;
  }
  if (target < DUST_SATS) {
    say("send-msg", `너무 적습니다. ${fromSats(DUST_SATS)} RVN 이상 보내 주세요.`, "err");
    return;
  }

  const sel = selectCoins(utxos, target);
  if ("error" in sel) {
    say("send-msg", sel.error, "err");
    return;
  }

  // 거스름은 방금 훑어서 찾아낸 주소로 돌려보낸다. 훑는 범위 밖(예: 잔돈
  // 체인 m/44'/175'/0'/1/*)으로 보내면 다음에 열었을 때 그 돈이 안 보인다.
  const change = sel.inputs[0].address;
  pending = { sel, to, change };

  $("cf-to").textContent = to;
  $("cf-amount").textContent = rvnText(sel.amount);
  $("cf-fee").textContent = rvnText(sel.fee);
  $("cf-total").textContent = rvnText(sel.amount + sel.fee);
  $("cf-change").textContent = sel.change > 0 ? `${rvnText(sel.change)} → ${change}` : "없음";
  say("cf-msg", "");
  show("confirm");
}

function fillMax(): void {
  const sel = selectAll(spendableUtxos());
  if ("error" in sel) {
    say("send-msg", sel.error, "err");
    return;
  }
  ($("send-amount") as HTMLInputElement).value = fromSats(sel.amount).replace(/,/g, "");
  say("send-msg", `수수료 ${rvnText(sel.fee)} 를 빼고 채웠습니다.`);
}

async function confirmSend(): Promise<void> {
  if (!pending) return;
  const btn = $("btn-confirm") as HTMLButtonElement;
  btn.disabled = true;
  say("cf-msg", "서명하고 보내는 중…");

  try {
    // 개인키는 여기서 만들어서 여기서 쓰고 끝난다. 서버로 가는 것은
    // 서명이 끝난 hex 뿐이다.
    const keys: Record<string, string> = {};
    for (const u of pending.sel.inputs) {
      if (keys[u.address]) continue;
      const row = scan?.rows.find((r) => r.address === u.address);
      if (!row) throw new Error("주소를 찾지 못했습니다. 새로고침 후 다시 시도해 주세요.");
      keys[u.address] = addressAt(row.index).WIF;
    }

    const hex = buildAndSign(pending.sel, pending.to, pending.change, keys);
    const txid = await broadcast(hex);

    $("sent-txid").textContent = txid;
    $("sent-amount").textContent = rvnText(pending.sel.amount);
    $("sent-to").textContent = pending.to;
    pending = null;
    show("sent");
    void refresh(false);
  } catch (e) {
    say("cf-msg", (e as Error).message || "보내지 못했습니다.", "err");
  } finally {
    btn.disabled = false;
    touchIdle();
  }
}

// ── 배선 ────────────────────────────────────────────────────────────────────

function wire(): void {
  $("btn-new").onclick = startCreate;
  $("btn-restore").onclick = () => {
    ($("restore-input") as HTMLTextAreaElement).value = "";
    say("restore-msg", "");
    show("restore");
  };

  $("btn-words-done").onclick = planQuiz;
  $("btn-words-back").onclick = () => show("welcome");
  $("btn-restore-go").onclick = doRestore;
  $("btn-restore-back").onclick = () => show("welcome");

  $("btn-pw-save").onclick = () => void savePassword();
  $("btn-pw-skip").onclick = () => void saveWithoutLock();
  $("btn-pw-bio").onclick = () => void saveWithBio();
  $("btn-unlock-bio").onclick = () => {
    const v = readVault();
    if (v) void showLockedOrOpen(v);
  };
  // 이 기기에서 안 되는 것을 버튼으로 내밀지 않는다.
  void bioAvailable().then((ok) => {
    if (!ok) $("btn-pw-bio").style.display = "none";
  });
  $("btn-unlock").onclick = () => void doUnlock();
  ($("unlock-pass") as HTMLInputElement).onkeydown = (e) => {
    if ((e as KeyboardEvent).key === "Enter") void doUnlock();
  };

  $("btn-forget").onclick = () => {
    if (!confirm("이 브라우저에 저장된 지갑을 지웁니다. 12단어가 종이에 있어야 되살릴 수 있습니다. 지울까요?")) return;
    localStorage.removeItem(STORE_KEY);
    lock();
  };

  // 받기는 화면을 갈아 끼우지 않고 그 자리에서 편다. 카운터 앞에서 화면이
  // 통째로 바뀌면 사람은 자기가 어디 있는지 놓친다.
  $("btn-recv").onclick = () => {
    const box = $("recvbox");
    const open = box.style.display === "none";
    box.style.display = open ? "" : "none";
    $("btn-recv").textContent = open ? "받기 닫기" : "받기";
    if (open) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  $("btn-refresh").onclick = () => void refresh(false);
  $("btn-deep").onclick = () => void refresh(true);
  $("btn-lock").onclick = lock;

  $("btn-copy").onclick = async () => {
    const addr = $("recv-addr").textContent || "";
    try {
      await navigator.clipboard.writeText(addr);
      say("recv-msg", "주소를 복사했습니다.", "ok");
    } catch {
      say("recv-msg", "복사가 안 됩니다. 주소를 길게 눌러 복사해 주세요.", "err");
    }
  };

  $("btn-send").onclick = openSend;
  $("btn-send-back").onclick = () => show("main");
  $("btn-send-max").onclick = fillMax;
  $("btn-send-review").onclick = reviewSend;

  $("btn-confirm").onclick = () => void confirmSend();
  $("btn-cancel").onclick = () => {
    pending = null;
    show("send");
  };
  $("btn-sent-done").onclick = () => show("main");
  $("btn-sell").onclick = () => {
    say("sl-msg", "");
    show("sell");
  };
  $("sell-back").onclick = () => show("main");
  $("sl-go").onclick = () => void sellPublish();

  for (const ev of ["click", "keydown", "touchstart"]) {
    document.addEventListener(ev, touchIdle, { passive: true });
  }
}

/// Refuses to start where the browser will not let us keep a secret.
///
/// ## The platform rule that decides this
///
/// `crypto.subtle` exists only in a secure context — HTTPS, or localhost. On a
/// shop's LAN address like `http://192.168.0.58:8790` it is simply **undefined**,
/// so every path that stores the wallet fails, including the one that skips the
/// lock. Nothing here can work around it: it is the browser refusing, not a
/// missing feature.
///
/// So we say it plainly and point at the address that does work, rather than
/// letting someone type twelve words into a page that cannot save them.
function secureEnough(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && window.isSecureContext;
}

function boot(): void {
  wire();

  if (!secureEnough()) {
    const el = document.getElementById("s-insecure");
    if (el) {
      const host = location.host;
      el.innerHTML =
        `<h1>이 주소로는 지갑을 쓸 수 없습니다</h1>
         <p class="sub">
           브라우저가 <b>http 주소에서는 지갑을 잠글 수 없게</b> 막고 있습니다.
           우리가 고칠 수 있는 것이 아니라 브라우저 규칙입니다.
         </p>
         <div class="note warn">
           지금 주소 <code>${host}</code> 는 <b>http</b> 입니다.<br />
           가게에서 <b>https 로 시작하는 주소</b>를 받아 다시 열어 주세요.
         </div>
         <p class="sub">
           주문과 결제 확인은 이 주소에서도 그대로 됩니다. <b>지갑만</b> 안 됩니다.
         </p>`;
    }
    show("insecure");
    return;
  }

  const vault = readVault();
  if (!vault) {
    show("welcome");
    return;
  }
  void showLockedOrOpen(vault);
}

/// 잠그지 않은 지갑이면 바로 열고, 아니면 잠금번호를 묻는다.
///
/// `open` 표시를 **믿지 않고 실제로 열어 본다.** 표시를 보고 판단하면, 그
/// 표시가 생기기 전에 만들어진 지갑은 영영 못 연다 — 걸지도 않은 암호를
/// 묻고, 잠금 값(NO_LOCK)에는 NUL 문자가 들어 있어 사람이 칠 수도 없다.
/// 실제로 열어 보는 쪽은 그런 지갑도 살린다.
///
/// 잠긴 지갑에서 이 시도는 그냥 실패한다 — 잘못된 암호 한 번과 같고,
/// 아무것도 새지 않는다.
async function showLockedOrOpen(vault: Vault): Promise<void> {
  try {
    const m = await openVault(vault, NO_LOCK);
    if (RavencoinKey.isMnemonicValid(m)) {
      unlocked(m);
      return;
    }
  } catch {
    // 잠긴 지갑이다. 아래에서 묻는다.
  }

  // 지문·얼굴로 잠근 지갑이면 숫자 칸을 보여 주기 전에 얼굴부터 묻는다.
  // 칸을 먼저 띄우면, 지문으로 잠근 사람은 있지도 않은 숫자를 떠올린다.
  const bio = (vault as unknown as Record<string, unknown>).bio;
  if (typeof bio === "string" && bio) {
    show("unlock");
    $("unlock-bio").style.display = "";
    say("unlock-msg", "얼굴이나 지문을 확인합니다…");
    const secret = await bioSecret(bio);
    if (secret) {
      try {
        const m = await openVault(vault, secret);
        if (RavencoinKey.isMnemonicValid(m)) {
          say("unlock-msg", "");
          unlocked(m);
          return;
        }
      } catch { }
    }
    // 실패해도 갇히지 않는다. 취소했을 수도 있고, 기기를 바꿨을 수도 있다.
    say("unlock-msg", "확인하지 못했습니다. 다시 누르거나 12단어로 되살리세요.", "err");
    return;
  }
  show("unlock");
}

// 화면이 있을 때만 붙는다. 없으면(테스트) 아래 순수 함수만 꺼내 쓴다 —
// 돈을 세는 부분은 브라우저 없이도 검사할 수 있어야 한다.
if (typeof document !== "undefined") boot();

export {
  toSats, fromSats, normalizeUtxos, selectCoins, selectAll,
  buildAndSign, estimateSize, feeFor, derivationPath,
  NETWORK, DUST_SATS, GAP_LIMIT, SCAN_MAX,
};
export type { SpendUtxo, Selection };
