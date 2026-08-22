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
import { signEvent, KIND_LISTING, type NostrEvent } from "./nostr";
import * as nip17 from "./nip17";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";

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
  /** 자산 이름 → 수량. 노드가 RVN 과 **갈라서** 준다.
   *  🔴 안 가르면 회원권 1장이 1 RVN 으로 세어진다. */
  assets?: Record<string, number>;
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


/**
 * 남의 글자를 HTML 에 넣기 전에 이빨을 뽑는다.
 *
 * 🔴 여태 이 파일에는 이런 함수가 **없었다.** 필요가 없었기 때문이다 —
 * 화면에 뜨는 글자가 전부 우리 것이었고, 남의 글자는 `textContent` 로만 넣었다.
 *
 * 「내가 올린 것」이 생기면서 사정이 바뀌었다. 목록에 뜨는 제목·동네·통화는
 * **릴레이에서 온 남의 글자**다(자기 글이라도 릴레이를 거쳐 돌아온다).
 * 그리고 이 페이지에는 **12단어가 있다.** 여기서 스크립트가 한 번 돌면
 * 지갑이 통째로 털린다 — 이 지갑에서 제일 비싼 실수가 될 자리다.
 */
function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  // 주소마다 딸려 오는 자산을 합쳐 둔다. 한 사람이 주소를 여러 개 쓰므로
  // 여기서 모아야 "회원권 1장" 이 흩어지지 않는다.
  if (j && j.assets) {
    for (const [name, qty] of Object.entries(j.assets)) {
      myAssets[name] = (myAssets[name] || 0) + Number(qty || 0);
    }
  }
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

/**
 * 보낼 만큼 동전을 고른다.
 *
 * `extraOut` 은 **출력이 하나 더 붙을 때** 준다(개발비). 🔴 이걸 안 세면
 * 수수료가 34바이트만큼 모자라고, 그러면 거래가 릴레이되지 않는다 —
 * 화면에는 "보냈습니다" 가 뜨는데 아무 데도 안 간다. 제일 나쁜 실패다.
 */
function selectCoins(
  all: SpendUtxo[],
  target: number,
  extraOut = 0,
): Selection | { error: string } {
  const sorted = [...all].sort((a, b) => b.satoshis - a.satoshis);
  const inputs: SpendUtxo[] = [];
  let sum = 0;

  for (const u of sorted) {
    inputs.push(u);
    sum += u.satoshis;

    const fee2 = feeFor(estimateSize(inputs.length, 2 + extraOut));
    if (sum >= target + fee2 + DUST_SATS) {
      return { inputs: [...inputs], amount: target, fee: fee2, change: sum - target - fee2 };
    }
    // 거스름이 먼지밖에 안 되면 출력을 만들지 않고 수수료로 넘긴다.
    const fee1 = feeFor(estimateSize(inputs.length, 1 + extraOut));
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

/**
 * 개발비를 받을 주소. 노드의 `shop.rs` 와 **같은 주소**다.
 *
 * 🔴 한 글자만 틀려도 그리로 간 돈은 영영 사라진다. 노드에게 검사시킨 값이다
 * (2026-08-21, `raven-cli validateaddress` → isvalid: true).
 * 여기를 고치는 사람은 그 명령을 다시 돌려서 확인하고 바꿀 것.
 */
const DEV_FEE_ADDRESS = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
const DEV_FEE_RATE = 0.01;

/**
 * 개발비 몫(사토시). **물건값에서 나온다 — 위에 얹지 않는다.**
 *
 * 얹으면 사는 사람이 내는 금액이 우리 때문에 올라가고, 화면에 적은 값과
 * 실제로 나가는 값이 달라진다.
 *
 * 티끌(dust)보다 작으면 **0 이다.** 티끌보다 작은 출력을 넣으면 거래 전체가
 * 릴레이되지 않아서, 1% 를 걷으려다 거래를 통째로 잃는다.
 */
function devFeeSats(amountSats: number): number {
  const fee = Math.round(amountSats * DEV_FEE_RATE);
  return fee >= DUST_SATS ? fee : 0;
}

function buildAndSign(
  sel: Selection,
  toAddress: string,
  changeAddress: string,
  keys: Record<string, string>,
  /** 개발비를 붙일지. 「이 물건 사기」로 들어왔을 때만 참이다. */
  withDevFee = false,
): string {
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  for (const u of sel.inputs) {
    tx.addInput(Buffer.from(u.txid, "hex").reverse(), u.outputIndex);
  }

  // 개발비는 **받는 사람 몫에서** 뗀다. 총액은 그대로다.
  const dev = withDevFee ? devFeeSats(sel.amount) : 0;
  // 같은 주소로 두 번 보내면 안 된다 — 파는 사람이 우리 주소를 적어 뒀다면
  // 출력 둘이 한 자리를 가리키고, 그건 조용히 돈을 잃는 길이다.
  const devOk = dev > 0 && toAddress !== DEV_FEE_ADDRESS;
  const toGets = devOk ? sel.amount - dev : sel.amount;

  tx.addOutput(bitcoin.address.toOutputScript(toAddress, NETWORK), toGets);
  if (devOk) {
    tx.addOutput(bitcoin.address.toOutputScript(DEV_FEE_ADDRESS, NETWORK), dev);
  }
  if (sel.change > 0) {
    tx.addOutput(bitcoin.address.toOutputScript(changeAddress, NETWORK), sel.change);
  }

  // 서명하기 전에 스스로 검산한다. 들어온 것에서 나간 것을 뺀 나머지가
  // 수수료다 — 이 숫자가 화면에 보여 준 것과 다르면 사람이 동의한 거래가
  // 아니므로 보내지 않는다.
  //
  // ⚠️ 개발비 출력이 늘었으므로 **여기도 같이 세어야 한다.** 안 그러면
  // 개발비가 채굴 수수료로 잘못 세어져 "수수료 계산이 맞지 않다" 로 막힌다.
  const inSum = sel.inputs.reduce((s, u) => s + u.satoshis, 0);
  const outSum = toGets + (devOk ? dev : 0) + sel.change;
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


// ── 내가 올린 것 ────────────────────────────────────────────────────────
//
// 🔴 화면에는 「내가 올린 것」 자리가 있었는데 **한 번도 채워진 적이 없다.**
// 이 페이지는 `connect-src 'self'` 라 릴레이를 직접 읽을 수 없기 때문이다
// (12단어가 여기 있어서 일부러 막아 둔 문이다). 올리는 길만 있고 읽는 길이
// 없었던 셈이라, 자기가 올린 글을 고치지도 지우지도 못했다.
//
// 이제 읽는 것도 서버가 대신한다(`/api/nostr/query`). 개인키는 안 넘어가고
// 공개키만 간다 — 누가 썼는지는 원래 릴레이에 공개돼 있는 정보다.

/** 지금 고치고 있는 글의 이름(`d`). 비어 있으면 새 글이다. */
let editing = "";

function stopEditing(): void {
  editing = "";
  const go = $("sl-go");
  if (go) go.textContent = "올리기";
  const c = $("sl-cancel");
  if (c) c.style.display = "none";
}

/** 이 지갑의 Nostr 공개키. 누가 썼는지를 나타내는 값이라 공개돼도 된다. */
function nostrPubHex(): string {
  return bytesToHex(schnorr.getPublicKey(nostrSecret()));
}

function tagOf(e: NostrEvent, name: string): string {
  return e.tags.find((t) => t[0] === name)?.[1] || "";
}


// ── 1:1 문의 ────────────────────────────────────────────────────────────
//
// 🔴 여태 물건 상세에는 **전화번호**뿐이었다. 그건 통하지만 번호가 공개
// 릴레이에 올라가고, 봇도 읽고, 지워도 회수되지 않는다. 개인이 자전거 한 대
// 파는데 번호를 전 세계에 거는 것은 큰 값이다.
//
// 이제 번호 없이 말을 걸 수 있다. 겉봉이 세 겹이라 **릴레이도 누가 누구에게
// 보냈는지 모른다**(`nip17.ts` 첫 주석).
//
// ⚠️ 이 암호는 아무도 검사하지 않았다. 화면에서 그렇게 말한다.

type Talk = { pub: string; last: number; lines: { me: boolean; at: number; text: string }[] };

let talks: Record<string, Talk> = {};

/** 릴레이에서 나에게 온 겉봉을 받아 대화로 푼다. */
async function loadTalks(): Promise<void> {
  if (!hdKey) return;
  const sec = nostrSecret();
  const me = nip17.pubOf(sec);
  let events: any[] = [];
  try {
    const r = await fetch("/api/nostr/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 🔴 겉봉은 보낸 이가 임시 열쇠라 `authors` 로 못 찾는다.
      // 받는 이 태그로만 찾을 수 있다.
      body: JSON.stringify({ filter: { kinds: [nip17.KIND_WRAP], "#p": [me], limit: 200 } }),
    }).then((x) => x.json());
    events = r?.events || [];
  } catch {
    return;
  }

  const next: Record<string, Talk> = {};
  for (const g of events) {
    const r = nip17.unwrap(sec, g);
    // 못 여는 것은 남의 겉봉이다. 오류가 아니다.
    if (!r) continue;
    const other = r.pubkey === me ? (r.tags.find((t: string[]) => t[0] === "p")?.[1] ?? "") : r.pubkey;
    if (!other) continue;
    const t = (next[other] ||= { pub: other, last: 0, lines: [] });
    t.lines.push({ me: r.pubkey === me, at: r.created_at, text: r.content });
    t.last = Math.max(t.last, r.created_at);
  }
  for (const t of Object.values(next)) t.lines.sort((a, b) => a.at - b.at);
  talks = next;
  renderTalks();
}

function renderTalks(): void {
  const box = $("talks");
  if (!box) return;
  const list = Object.values(talks).sort((a, b) => b.last - a.last);
  if (!list.length) {
    box.innerHTML = `<p class="sub">아직 온 문의가 없습니다.</p>`;
    return;
  }
  box.innerHTML = list
    .map((t) => {
      const last = t.lines[t.lines.length - 1];
      return `<div class="talk" data-pub="${escapeHtml(t.pub)}">
        <div class="tw">${escapeHtml(t.pub.slice(0, 8))}…</div>
        <div class="tl">${escapeHtml((last?.text || "").slice(0, 40))}</div>
        <div class="tt">${new Date(t.last * 1000).toLocaleDateString()}</div>
      </div>`;
    })
    .join("");
  box.querySelectorAll<HTMLElement>(".talk").forEach((el) => {
    el.onclick = () => openTalk(el.dataset.pub!);
  });
}

/** 한 사람과의 대화를 연다. */
function openTalk(pub: string): void {
  const box = $("sheet");
  if (!box) return;
  const t = talks[pub];
  const lines = (t?.lines || [])
    .map(
      (l) =>
        `<div class="bub ${l.me ? "me" : "you"}">${escapeHtml(l.text)}</div>`,
    )
    .join("");
  box.innerHTML = `<div class="sheetin">
      <button class="sheetx" id="sheet-close">닫기</button>
      <h2 style="margin:0 0 4px;font-size:18px">${escapeHtml(pub.slice(0, 12))}…</h2>
      <p class="sub" style="margin:0 0 10px">
        번호를 주고받지 않아도 됩니다. <b>릴레이도 누가 누구에게 보냈는지
        모릅니다.</b>
      </p>
      <div class="bubs">${lines || `<p class="sub">첫 말을 걸어 보세요.</p>`}</div>
      <div class="qa" style="margin-top:10px">
        <input id="talk-in" autocomplete="off" enterkeyhint="send"
               placeholder="예: 아직 있나요? 내일 볼 수 있을까요?" />
        <button id="talk-go" style="width:100%;margin-top:8px">보내기</button>
      </div>
      <p class="foot" style="margin-top:12px">
        ⚠️ 이 암호는 <b>아무도 검사하지 않았습니다.</b> 잠겨서 가지만,
        큰일이 걸린 말은 여기 적지 마세요.
      </p>
    </div>`;
  box.style.display = "";
  ($("sheet-close") as HTMLElement).onclick = () => (box.style.display = "none");
  box.onclick = (ev) => {
    if (ev.target === box) box.style.display = "none";
  };
  const send = async () => {
    const inp = $("talk-in") as HTMLInputElement;
    const text = inp.value.trim();
    if (!text) return;
    const btn = $("talk-go") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "보내는 중…";
    try {
      await sendTalk(pub, text);
      inp.value = "";
      await loadTalks();
      openTalk(pub);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "보내기";
      say("talk-err", String((e as Error)?.message || e), "err");
    }
  };
  ($("talk-go") as HTMLElement).onclick = () => void send();
  ($("talk-in") as HTMLInputElement).onkeydown = (e) => {
    if (e.key === "Enter") void send();
  };
}

/**
 * 한 마디를 보낸다.
 *
 * ⚠️ **겉봉을 둘 만든다** — 상대 것과 내 것. 내 것을 안 만들면 내가 보낸
 * 말을 내가 다시 못 읽는다(릴레이에는 상대만 열 수 있는 것이 올라간다).
 */
async function sendTalk(toPub: string, text: string): Promise<void> {
  if (!hdKey) throw new Error("지갑을 먼저 열어 주세요.");
  const sec = nostrSecret();
  const me = nip17.pubOf(sec);
  for (const forWhom of [toPub, me]) {
    const gift = nip17.wrap(sec, toPub, forWhom, text);
    const r = await fetch("/api/nostr/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gift),
    }).then((x) => x.json());
    if (r?.error) throw new Error(r.error);
  }
}

async function loadMine(): Promise<void> {
  const box = $("sl-mine");
  if (!box) return;
  if (!hdKey) {
    box.innerHTML = `<p class="sub">지갑을 열면 여기에 보입니다.</p>`;
    return;
  }
  box.innerHTML = `<p class="sub">불러오는 중…</p>`;
  let events: NostrEvent[] = [];
  try {
    const r = await fetch("/api/nostr/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: { kinds: [KIND_LISTING], authors: [nostrPubHex()] } }),
    }).then((x) => x.json());
    if (r?.error) throw new Error(r.error);
    events = (r?.events || []) as NostrEvent[];
  } catch (e) {
    // 못 읽은 것과 없는 것은 다르다. 있는 사람에게 없다고 말하지 않는다.
    box.innerHTML = `<p class="sub">목록을 못 불러왔습니다. ${escapeHtml(
      String((e as Error)?.message || e),
    )}</p>`;
    return;
  }

  // 같은 `d` 가 여러 번 오면 **가장 새 것만** 남긴다. NIP-99 는 덮어쓰기라,
  // 옛 판을 같이 보여주면 이미 고친 값이 아직 살아 있는 것처럼 보인다.
  const latest = new Map<string, NostrEvent>();
  for (const e of events) {
    const d = tagOf(e, "d");
    if (!d) continue;
    const prev = latest.get(d);
    if (!prev || e.created_at > prev.created_at) latest.set(d, e);
  }
  const mine = [...latest.values()].sort((a, b) => b.created_at - a.created_at);

  if (!mine.length) {
    box.innerHTML = `<p class="sub">아직 올린 것이 없습니다. 위에서 첫 물건을 올려 보세요.</p>`;
    return;
  }

  const LABEL: Record<string, string> = {
    active: "팝니다",
    sold: "판매 완료",
    reserved: "예약 중",
  };
  box.innerHTML = mine
    .map((e) => {
      const d = tagOf(e, "d");
      const st = tagOf(e, "status") || "active";
      const price = e.tags.find((t) => t[0] === "price");
      const money = price ? `${Number(price[1]).toLocaleString()} ${price[2] || ""}` : "";
      const when = new Date(e.created_at * 1000).toLocaleDateString();
      return `<div class="mineitem${st === "sold" ? " done" : ""}">
        <div class="mt">${escapeHtml(tagOf(e, "title") || "(제목 없음)")}</div>
        <div class="sub">${escapeHtml(money)} · ${escapeHtml(LABEL[st] || st)} · ${when}</div>
        <div class="minebtns">
          <button data-edit="${escapeHtml(d)}">고치기</button>
          ${st === "sold"
            ? ""
            : `<button data-sold="${escapeHtml(d)}">팔렸어요</button>`}
          <button class="danger" data-del="${escapeHtml(d)}">지우기</button>
        </div>
      </div>`;
    })
    .join("");

  // 고치기 — 그 글의 값을 칸에 도로 채우고, 같은 `d` 로 다시 올리게 한다.
  box.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const e = latest.get(b.dataset.edit!);
      if (!e) return;
      const set = (id: string, val: string) => {
        const el = $(id) as HTMLInputElement | null;
        if (el) el.value = val;
      };
      set("sl-title", tagOf(e, "title"));
      set("sl-desc", e.content || "");
      const price = e.tags.find((t) => t[0] === "price");
      set("sl-price", price?.[1] || "");
      const cur = $("sl-cur") as HTMLSelectElement | null;
      if (cur && price?.[2]) cur.value = price[2];
      set("sl-where", tagOf(e, "location"));
      set("sl-image", tagOf(e, "image"));
      const stSel = $("sl-status") as HTMLSelectElement | null;
      if (stSel) stSel.value = tagOf(e, "status") || "active";
      editing = tagOf(e, "d");
      const go = $("sl-go");
      if (go) go.textContent = "고쳐서 다시 올리기";
      const c = $("sl-cancel");
      if (c) c.style.display = "";
      $("sl-title").scrollIntoView({ behavior: "smooth", block: "center" });
      say("sl-msg", "고친 뒤 아래 단추를 누르시면 같은 글이 바뀝니다.");
    };
  });

  // 팔렸어요 — 상태만 바꿔 다시 올린다. 지우는 것과 다르다.
  box.querySelectorAll<HTMLElement>("[data-sold]").forEach((b) => {
    b.onclick = () => void markSold(latest.get(b.dataset.sold!));
  });

  box.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = () => void removeListing(latest.get(b.dataset.del!));
  });
}

/** 상태만 「판매 완료」로 바꿔 같은 `d` 로 다시 올린다. */
async function markSold(e: NostrEvent | undefined): Promise<void> {
  if (!e) return;
  try {
    const tags = e.tags.filter((t) => t[0] !== "status").concat([["status", "sold"]]);
    const ev = signEvent(nostrSecret(), {
      kind: KIND_LISTING,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: e.content || "",
    });
    const r = await fetch("/api/nostr/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
    }).then((x) => x.json());
    if (r?.error) throw new Error(r.error);
    say("sl-msg", "판매 완료로 바꿨습니다.", "ok");
    void loadMine();
  } catch (err) {
    say("sl-msg", String((err as Error)?.message || err), "err");
  }
}

/**
 * 글을 지운다. NIP-09(kind 5).
 *
 * ⚠️ 이건 **지워 달라는 부탁**이지 명령이 아니다. 릴레이는 대부분 들어주지만
 * 안 들어주는 곳도 있고, 이미 받아 간 사람의 화면에는 남는다. 화면에 그렇게
 * 적어 뒀다 — "지웠습니다" 라고만 하면 나중에 남아 있는 걸 보고 속았다고
 * 느낀다.
 */
async function removeListing(e: NostrEvent | undefined): Promise<void> {
  if (!e) return;
  const title = tagOf(e, "title") || "이 글";
  if (!confirm(`「${title}」을 지울까요?\n\n되돌릴 수 없고, 이미 받아 간 곳에는 남을 수 있습니다.`)) {
    return;
  }
  try {
    const ev = signEvent(nostrSecret(), {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      // `e` 는 그 글 하나, `a` 는 "이 사람의 이 이름표를 가진 글" 전부.
      // 덮어쓰기 글은 판이 여러 개라 `a` 가 있어야 옛 판까지 같이 내려간다.
      tags: [
        ["e", e.id],
        ["a", `${KIND_LISTING}:${e.pubkey}:${tagOf(e, "d")}`],
      ],
      content: "판매자가 내렸습니다.",
    });
    const r = await fetch("/api/nostr/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
    }).then((x) => x.json());
    if (r?.error) throw new Error(r.error);
    say("sl-msg", "지워 달라고 알렸습니다. 릴레이에서 사라지기까지 잠깐 걸립니다.", "ok");
    if (editing === tagOf(e, "d")) stopEditing();
    void loadMine();
  } catch (err) {
    say("sl-msg", String((err as Error)?.message || err), "err");
  }
}


/**
 * 위도·경도를 geohash 로 접는다.
 *
 * 🔴 우리 물건에는 여태 `g` 태그가 없었다. 목록 화면은 그걸 보고 거리를
 * 재는데(`shops.src.ts`), 없으니 **우리 물건만 영영 거리가 안 떴다.**
 * 실측으로 남의 매물 348건 중 125건이 이 태그를 달고 온다.
 *
 * 자리 수는 **6자리**로 끊는다(대략 600m). 더 정밀하게 실으면 파는 사람의
 * 집이 좌표로 공개된다 — 동네를 알리려는 것이지 대문을 알리려는 게 아니다.
 */
function toGeohash(lat: number, lon: number, len = 6): string {
  const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let bit = 0, ch = 0, even = true, out = "";
  while (out.length < len) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon > mid) { ch = (ch << 1) + 1; lonMin = mid; } else { ch <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) { ch = (ch << 1) + 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

/**
 * 「지금 자리」를 누르면 대략의 동네를 담아 둔다.
 *
 * ⚠️ 누르기 전에는 **아무것도 안 가져온다.** 위치를 몰래 읽으면, 그게 한 번
 * 들통났을 때 이 프로그램 전체를 못 믿게 된다.
 */
async function fillGeo(): Promise<void> {
  const out = $("sl-geo") as HTMLInputElement | null;
  const btn = $("sl-geo-go") as HTMLButtonElement | null;
  if (!out || !btn) return;
  btn.disabled = true;
  btn.textContent = "찾는 중…";
  try {
    const pos = await new Promise<GeolocationPosition>((ok, bad) =>
      navigator.geolocation.getCurrentPosition(ok, bad, { timeout: 10_000 }),
    );
    out.value = toGeohash(pos.coords.latitude, pos.coords.longitude);
    btn.textContent = "이 동네로 두었습니다";
  } catch {
    // 거절했거나 못 읽었다. 그래도 글은 올라간다 — 거리만 안 뜬다.
    btn.disabled = false;
    btn.textContent = "위치를 못 읽었습니다. 다시";
  }
}


/**
 * 팔 물건 사진을 올린다.
 *
 * 🔴 「사진 없는 중고 글」은 안 팔린다. 그런데 여태 **주소를 붙여넣는 것**만
 * 있었다 — 폰으로 찍은 사진은 주소가 없으니 사실상 못 올렸다.
 *
 * ## 어디로 가나
 *
 * Nostr 미디어 서버(NIP-96)다. **우리가 갖고 있지 않는다** — 우리 서버는
 * 날라 주기만 한다. 사진 창고를 우리가 쥐면 우리가 문을 닫는 날 모두의
 * 사진이 사라진다.
 *
 * ⚠️ 대신 **그 서버가 문을 닫으면 사진이 사라진다.** 우리도 되살릴 수 없다.
 * 화면에서 그렇게 말한다.
 *
 * ## 서명
 *
 * NIP-98 — 우리 열쇠로 서명한 표를 같이 보낸다. 미디어 서버는 그게 없으면
 * 거절한다(실측: 둘 다 401). 개인키는 이 함수 밖으로 안 나간다.
 */
/**
 * 사진 사본을 가게 노드에 한 부 둔다.
 *
 * 🔴 `rvn.ex.erci.se` 에서 열면 노드가 없다 — 그때는 조용히 아무것도 안 한다.
 * 없는 기능을 있는 척하지 않는다. 가게 노드(같은 와이파이)에서 열었을 때만
 * 사본이 생기고, 그때만 화면에 그렇게 적는다.
 */
async function keepCopy(url: string, note: HTMLElement) {
  try {
    const r = await fetch("/api/keepphoto", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) return;
    const j = await r.json();
    if (!j?.kept) return;
    const add = document.createElement("div");
    add.className = "sub";
    add.textContent = "이 가게 컴퓨터에도 한 부 보관했습니다.";
    note.appendChild(add);
  } catch {
    // 노드가 없는 곳(웹)에서 열었으면 여기로 온다. 정상이다.
  }
}

/**
 * 사진을 줄인다.
 *
 * 🔴 여태 **파일을 그대로 올렸다.** 요즘 폰 사진은 3~6MB, 최신 기종은 10MB 를
 * 넘기도 한다. 우리 한도가 8MB 라 그런 사진은 「8MB 아래로 줄여 주세요」로
 * 거절당했는데 — **폰에서 그걸 할 방법이 마땅치 않다.** 사람이 못 하는 일을
 * 시키고 거절한 셈이다.
 *
 * 중고 물건 사진에 4000픽셀이 필요하지도 않다. 긴 쪽 1600px 이면 폰에서도
 * 데스크톱에서도 또렷하고, 보통 200~500KB 로 떨어진다. 가게 와이파이에서
 * 올리는 시간도 그만큼 짧아진다.
 *
 * ⚠️ `imageOrientation: "from-image"` 를 준다. 안 주면 세로로 찍은 사진이
 *    **눕는다** — 폰 사진에는 회전 정보가 따로 들어 있기 때문이다.
 * ⚠️ 줄이다 실패하면 **원본을 그대로 보낸다.** 사진 한 장 못 올리는 것보다
 *    큰 파일이라도 올라가는 편이 낫다.
 */
async function shrink(file: File): Promise<Blob> {
  const MAX = 1600;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    // 이미 작으면 손대지 않는다. 다시 그리면 화질만 떨어진다.
    if (scale >= 1 && file.size <= 1_500_000) return file;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext("2d");
    if (!cx) return file;
    cx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await new Promise<Blob | null>((ok) =>
      cv.toBlob((b) => ok(b), "image/jpeg", 0.85),
    );
    // 줄인 것이 더 크면(작은 png 등) 원본이 낫다.
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

async function uploadPhoto(file: File): Promise<string> {
  if (!hdKey) throw new Error("지갑을 먼저 열어 주세요.");
  const url = `${location.origin}/api/photo`;

  // 🔴 표 안에는 **어느 주소로 가는 것인지**(`u`)가 들어가고, 미디어 서버는
  // 그게 **자기 주소**여야 받는다. 우리 주소로 서명한 표를 넘기면 401 이다 —
  // 실측으로 그렇게 막혔다. 그래서 어디로 갈 수 있는지 먼저 묻고,
  // **호스트마다 하나씩** 표를 만든다.
  //
  // 우리 서버가 대신 서명할 수는 없다 — 그러려면 개인키가 거기 있어야 하고,
  // 그건 이 지갑이 절대 하지 않는 일이다.
  const hosts: string[] = await fetch(url)
    .then((x) => x.json())
    .then((j) => j?.hosts || [])
    .catch(() => []);
  if (!hosts.length) throw new Error("사진 서버를 찾지 못했습니다.");

  const sec = nostrSecret();
  const tokens: Record<string, string> = {};
  for (const h of hosts) {
    const ev = signEvent(sec, {
      kind: 27235, // NIP-98
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", h], ["method", "POST"]],
      content: "",
    });
    tokens[h] = "Nostr " + btoa(JSON.stringify(ev));
  }

  const fd = new FormData();
  fd.append("file", await shrink(file), file.name.replace(/\.[^.]+$/, "") + ".jpg");
  const r = await fetch(url, {
    method: "POST",
    body: fd,
    headers: { "x-nostr-auth": JSON.stringify(tokens) },
  });
  const j = await r.json();
  if (!r.ok || !j?.url) throw new Error(j?.error || "사진을 올리지 못했습니다.");
  return String(j.url);
}

async function sellPublish(): Promise<void> {
  const v = (id: string) => ($(id) as HTMLInputElement | HTMLTextAreaElement).value.trim();
  const title = v("sl-title");
  const desc = v("sl-desc");
  const price = v("sl-price");
  const cur = ($("sl-cur") as HTMLSelectElement).value;
  const where = v("sl-where");
  const status = ($("sl-status") as HTMLSelectElement)?.value || "active";
  const imageRaw = ($("sl-image") as HTMLInputElement | null)?.value.trim() || "";
  // http/https 만. 남의 글자가 태그로 들어가는 자리라 모양을 먼저 본다.
  const image = /^https?:\/\//i.test(imageRaw) ? imageRaw : "";
  // 숫자·+·- 만 남긴다. 남의 글자가 그대로 실리면 보는 쪽에서 문제가 된다.
  const phoneRaw = ($("sl-phone") as HTMLInputElement | null)?.value.trim() || "";
  const phone = phoneRaw.replace(/[^0-9+\-]/g, "");
  if (phoneRaw && phone.replace(/\D/g, "").length < 8) {
    return say("sl-msg", "전화번호가 짧습니다. 다시 봐 주세요.", "err");
  }
  // 좌표는 사장이 「지금 자리」를 눌렀을 때만 생긴다. 몰래 안 가져온다.
  const geohash = ($("sl-geo") as HTMLInputElement | null)?.value.trim() || "";
  if (imageRaw && !image) {
    return say("sl-msg", "사진 주소는 http 로 시작해야 합니다.", "err");
  }

  if (!title) return say("sl-msg", "무엇을 파시는지 적어 주세요.", "err");
  if (!price || !isFinite(Number(price)) || Number(price) <= 0)
    return say("sl-msg", "얼마에 파실지 숫자로 적어 주세요.", "err");

  const btn = $("sl-go") as HTMLButtonElement;
  btn.disabled = true;
  say("sl-msg", "올리는 중…");
  try {
    // NIP-99. d 는 이 글의 고유 이름 — 나중에 같은 d 로 다시 올리면 수정이 되고,
    // 없으면 고칠 때마다 새 글이 쌓인다.
    // 고치는 중이면 그 글의 이름을 그대로 쓴다. NIP-99 는 같은 `d` 로 다시
    // 올리면 **덮어쓰기**다. 새 이름을 쓰면 고친 게 아니라 한 개 더 올린 게
    // 되어, 릴레이에는 같은 자전거가 두 대 남는다.
    const d = editing || `playx-${Date.now().toString(36)}-${Math.floor(
      crypto.getRandomValues(new Uint32Array(1))[0] % 1e6
    ).toString(36)}`;
    const tags: string[][] = [
      ["d", d],
      ["title", title],
      ["price", String(Number(price)), cur],
      ["published_at", String(Math.floor(Date.now() / 1000))],
      ["t", "playx"],
      // 🔴 화면에는 「지금 상태」 칸이 있는데 여태 아무도 읽지 않았다. 팔린
      // 물건을 팔린다고 표시할 방법이 없어서, 연락은 계속 왔다.
      ["status", status],
    ];
    if (where) tags.push(["location", where]);
    // 🔴 연락처가 없으면 이건 장터가 아니라 게시판이다 — 올려도 안 팔린다.
    //
    // ⚠️ **이 번호는 전 세계에 공개된다.** 릴레이는 누구나 읽고 봇도 읽는다.
    // 지워도 이미 받아 간 곳에는 남는다. 그래서 화면에서 먼저 그렇게 말하고,
    // 적은 사람만 실린다.
    if (phone) tags.push(["phone", phone]);
    // 🔴 **받을 주소가 글에 없으면 살 방법이 없다.** 여태 연락처만 있어서
    // 「이 물건 사기」를 만들 수가 없었다. 이 지갑의 주소 하나를 같이 싣는다.
    //
    // ⚠️ 주소는 원래 공개되는 값이다(체인에 다 있다). 다만 **같은 주소를 계속
    // 쓰면 이 사람의 거래가 한 줄로 엮여 보인다** — 그래서 글마다 새 주소를
    // 쓴다. 지갑은 어차피 다 자기 것으로 본다.
    // 아직 안 쓴 주소를 준다(`receiveIndex`). 지갑을 안 훑었으면 없을 수도
    // 있는데, 그때는 안 싣는다 — 틀린 주소를 싣느니 없는 편이 낫다.
    const payTo = scan ? addressAt(receiveIndex()).address : "";
    if (payTo) tags.push(["pay", payTo]);
    // 지도에 뜨려면 좌표가 필요하다. 여태 `location`(글자)만 실어서
    // **우리 물건은 거리가 영영 안 떴다** — 가게 목록은 `g` 태그를 본다.
    if (geohash) tags.push(["g", geohash]);
    // 사진. NIP-99 는 주소(URL)를 받는다 — 사진 자체를 릴레이에 싣지 않는다.
    // 가게 컴퓨터에서 열었으면 IPFS 에 올려 그 주소를 쓸 수 있고, 웹에서는
    // 이미 인터넷에 있는 사진의 주소를 붙여 넣는다.
    if (image) tags.push(["image", image]);

    const ev = signEvent(nostrSecret(), {
      kind: KIND_LISTING,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: desc,
    });
    // 🔴 릴레이로 직접 못 나간다. 이 페이지는 `connect-src 'self'` 이고,
    // 그건 12단어가 여기 있어서 **일부러** 막아 둔 것이다. 서명은 여기서
    // 끝내고, 바깥으로 나가는 일은 노드에게 시킨다 — 개인키는 안 넘어간다.
    const res = await fetch("/api/nostr/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
    }).then((x) => x.json());
    if (res?.error) throw new Error(res.error);
    const okCount = (res?.ok || []).length;
    if (!okCount) {
      say("sl-msg", "어느 릴레이도 받지 못했습니다. 인터넷을 확인하고 다시 눌러 주세요.", "err");
    } else {
      say("sl-msg", `${okCount}곳에 올렸습니다. 「가게 둘러보기」의 물건 탭에서 보입니다.`, "ok");
      ["sl-title", "sl-desc", "sl-price", "sl-where", "sl-image"].forEach((id) => {
        const el = $(id) as HTMLInputElement | null;
        if (el) el.value = "";
      });
      stopEditing();
      void loadMine();
    }
  } catch (e) {
    say("sl-msg", String((e as Error)?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

/// 이 지갑이 **가게 컴퓨터**에서 열렸는가.
///
/// 🔴 브라우저 저장소는 출처(프로토콜+주소+포트)마다 나뉜다. 가게 로컬
/// 주소(`192.168.0.58:8790`)에서 만든 지갑은 **그 가게에서만 보인다.**
/// 손님이 다음 가게에 가면 "새 지갑 만들기" 가 뜨고, 돈이 사라진 줄 안다.
/// (실제로는 12단어만 있으면 되찾지만, 그 순간 그 사람은 그걸 모른다.)
///
/// 우리가 할 수 있는 것은 **미리 말해 주는 것**이다. 그리고 인터넷이 되면
/// 어디서나 열리는 자리(rvn.ex.erci.se)로 안내한다.
function isShopLocal(): boolean {
  const h = location.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h.endsWith(".local") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  );
}

function sayWhereThisWalletLives(): void {
  if (!isShopLocal()) return;
  const el = document.getElementById("wherebar");
  if (!el) return;
  el.innerHTML =
    `<b>이 지갑은 이 가게에서만 보입니다.</b> 가게 컴퓨터에 저장되기 때문입니다.<br />` +
    `다른 가게에서도 쓰시려면 <a href="https://rvn.ex.erci.se/wallet">rvn.ex.erci.se</a> ` +
    `에서 만드세요 — 같은 12단어로 어디서나 열립니다.`;
  el.style.display = "";
}

function unlocked(m: string): void {
  mnemonic = m;
  hdKey = RavencoinKey.getHDKey(NET_NAME, m);
  touchIdle();
  // 「물건 올리기」로 들어온 사람을 지갑 첫 화면에 떨궈 두면, 왜 여기 왔는지
  // 잊는다. 잠금을 푼 다음 하려던 자리로 이어 준다.
  // 「이 물건 사기」로 들어왔으면 보내기 화면을 채운 채로 연다.
  if (!openBuyFromHash()) {
    show(location.hash === "#sell" ? "sell" : "main");
    // 물건 화면에서 「문의하기」로 들어오면 그 사람과 바로 연다.
    const m = /^#talk\?to=([0-9a-f]{64})$/.exec(location.hash);
    if (m) {
      show("sell");
      void loadTalks().then(() => openTalk(m[1]));
    }
  }
  if (location.hash === "#sell") void loadMine();
  void loadTalks();
  sayWhereThisWalletLives();

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
    // 🔴 비우고 시작한다. 안 그러면 새로고침할 때마다 수량이 두 배가 된다.
    myAssets = {};
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


// ── 내 자산 ─────────────────────────────────────────────────────────────
//
// 🔴 여태 이 지갑은 **RVN 이 아닌 것을 통째로 버렸다**(`normalizeUtxos`).
// 버린 이유는 옳았다 — 자산 UTXO 를 RVN 인 줄 알고 쓰면 그 자산이 잔돈으로
// 태워져 **영영 사라진다.** 레이븐코인에서 제일 흔한 사고다.
//
// 그런데 "쓰지 않는다" 와 "보여주지 않는다" 는 다른 일이었다. 회원권을 사도
// 상품권을 받아도 화면에는 RVN 숫자 하나뿐이었고, 산 사람은 안 왔다고 여긴다.
// 체인에는 멀쩡히 있는데 지갑이 안 보여 준 것이다.
//
// 그리고 자산에 그림·음악이 딸려 있으면 **여기서 바로 보고 듣는다.**
// 그게 자산을 가진 재미이고, 그 재미가 없으면 그냥 숫자다.

type MyAsset = { name: string; qty: number };

/** 주소를 훑을 때 자산도 같이 모은다. */
let myAssets: Record<string, number> = {};

function renderAssets(): void {
  const box = $("myassets");
  if (!box) return;
  const rows: MyAsset[] = Object.entries(myAssets)
    .filter(([, q]) => q > 0)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!rows.length) {
    // 없는 것과 못 읽은 것은 다르다. 여기는 진짜 없는 경우다.
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    `<div class="asethead">가진 자산 ${rows.length}가지</div>` +
    rows
      .map(
        (a) => `<div class="aset" data-asset="${escapeHtml(a.name)}">
          <img class="art" alt="" src="/faces/raven-head.webp" />
          <div>
            <div class="nm">${escapeHtml(a.name)}</div>
            <div class="qt">${a.qty % 1 === 0 ? a.qty : a.qty.toFixed(8).replace(/0+$/, "")}개</div>
          </div>
          <button class="open">열어보기</button>
        </div>`,
      )
      .join("");

  box.querySelectorAll<HTMLElement>(".aset").forEach((el) => {
    const name = el.dataset.asset!;
    // 그림이 있으면 바꿔 끼운다. 없으면 라비 얼굴 그대로 — 깨진 그림보다 낫다.
    void paintAssetArt(name, el.querySelector("img") as HTMLImageElement);
    (el.querySelector(".open") as HTMLElement).onclick = () => void openAsset(name);
  });
}

/** 자산에 딸린 그림. 없으면 아무 일도 안 한다. */
async function paintAssetArt(name: string, img: HTMLImageElement): Promise<void> {
  try {
    const r = await fetch(`/api/chain/asset?name=${encodeURIComponent(name)}`).then((x) => x.json());
    const cid = String(r?.ipfs_hash || "").replace(/[^A-Za-z0-9]/g, "");
    if (!cid) return;
    const k = await fetch(`/api/ipfs-kind?cid=${cid}`).then((x) => x.json()).catch(() => null);
    if (k?.kind === "image") img.src = `/ipfs/${cid}`;
  } catch {
    /* 그림이 없는 자산이 훨씬 많다. 조용히 지나간다. */
  }
}

/**
 * 자산 하나를 연다. 그림이면 크게, 음악이면 재생기.
 *
 * ⚠️ 파일은 **우리 서버를 거쳐** 온다. 이 페이지는 `connect-src 'self'` 이고,
 * 같은 출처에 12단어가 있어서 바깥으로 나가는 문을 못 연다.
 */
async function openAsset(name: string): Promise<void> {
  const box = $("sheet");
  if (!box) return;
  box.innerHTML = `<div class="sheetin"><p class="sub">여는 중…</p></div>`;
  box.style.display = "";
  let body = `<p class="sub">이 자산에는 딸린 파일이 없습니다.</p>`;
  try {
    const r = await fetch(`/api/chain/asset?name=${encodeURIComponent(name)}`).then((x) => x.json());
    const cid = String(r?.ipfs_hash || "").replace(/[^A-Za-z0-9]/g, "");
    if (cid) {
      const k = await fetch(`/api/ipfs-kind?cid=${cid}`).then((x) => x.json()).catch(() => null);
      const url = `/ipfs/${cid}`;
      const kind = k?.kind || "image";
      body =
        kind === "audio"
          ? `<audio id="aset-play" controls preload="none" src="${url}"></audio>
             <p class="sub" style="margin-top:8px">가지고 계신 곡입니다. 눌러서 들어보세요.</p>`
          : kind === "video"
            ? `<video id="aset-play" controls preload="none" playsinline src="${url}"></video>`
            : kind === "book"
              ? `<a class="cbtn" href="${url}" target="_blank" rel="noopener">책 열기</a>
                 <p class="sub" style="margin-top:8px">새 창에서 열립니다.</p>`
              : kind === "web"
                ? // 🔴 `sandbox` 를 반드시 준다. 이 페이지에는 **12단어**가 있고,
                  // 자산에 딸린 것은 **남이 만든 파일**이다. 그 안의 스크립트가
                  // 우리 저장소를 읽으면 지갑이 통째로 털린다.
                  // allow-scripts 만 주고 allow-same-origin 은 주지 않는다 —
                  // 둘을 같이 주면 sandbox 가 스스로를 풀 수 있다.
                  `<iframe src="${url}" sandbox="allow-scripts"
                     style="width:100%;height:60vh;border:0;border-radius:14px"></iframe>
                   <p class="sub" style="margin-top:8px">
                     이 안의 내용은 <b>만든 사람이 넣은 것</b>입니다.
                     여기서는 지갑에 손댈 수 없게 막아 두었습니다.</p>`
                : `<img src="${url}" alt="" style="width:100%;border-radius:14px" />`;
    }
  } catch {
    body = `<p class="sub">파일을 불러오지 못했습니다.</p>`;
  }
  box.innerHTML = `<div class="sheetin">
      <button class="sheetx" id="sheet-close">닫기</button>
      <h2 style="margin:0 0 10px;font-size:19px;word-break:break-all">${escapeHtml(name)}</h2>
      ${body}
    </div>`;
  ($("sheet-close") as HTMLElement).onclick = () => (box.style.display = "none");
  box.onclick = (ev) => {
    if (ev.target === box) box.style.display = "none";
  };
}

function renderMain(): void {
  if (!scan) return;

  const total = totalSats();
  $("balance").textContent = fromSats(total);

  renderAssets();

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


/**
 * 「이 물건 사기」로 들어왔을 때.
 *
 * 가게 목록에서 `#pay?to=…&rvn=…&what=…` 로 넘어온다. 보내기 화면을 미리
 * 채워 두고, **개발비 1% 를 붙인다.**
 *
 * 🔴 왜 여기서만 붙나 — 그냥 「보내기」는 남에게 돈을 부치는 일이지 거래가
 * 아니다. 거기에 수수료를 붙이면 그건 장터 수수료가 아니라 **지갑 사용료**가
 * 되고, 그런 지갑은 아무도 안 쓴다.
 *
 * ⚠️ 주소·금액은 **주소창에서 온 남의 글자**다. 그대로 믿지 않는다.
 */
function openBuyFromHash(): boolean {
  const m = /^#pay\?(.+)$/.exec(location.hash);
  if (!m) return false;
  const q = new URLSearchParams(m[1]);
  const to = (q.get("to") || "").trim();
  const rvn = Number(q.get("rvn"));
  const what = (q.get("what") || "").trim().slice(0, 60);
  if (!to || !isFinite(rvn) || rvn <= 0) return false;
  try {
    // 레이븐 주소가 아니면 여기서 걸린다. 보내고 나면 되돌릴 수 없다.
    bitcoin.address.toOutputScript(to, NETWORK);
  } catch {
    return false;
  }
  buying = { to, rvn, what };
  openSend();
  ($("send-to") as HTMLInputElement).value = to;
  ($("send-amount") as HTMLInputElement).value = String(rvn);
  const dev = Math.round(rvn * DEV_FEE_RATE * 1e8) / 1e8;
  say(
    "send-msg",
    `${what ? `「${what}」 · ` : ""}파는 분에게 ${(rvn - dev).toFixed(8).replace(/0+$/, "")} RVN, ` +
      `개발비 ${dev} RVN(1%) 이 한 번에 나갑니다. ` +
      `돈은 만나서, 물건을 보고 보내세요.`,
  );
  return true;
}

/** 지금 물건을 사는 중인가. 개발비를 붙일지 정하는 유일한 근거다. */
let buying: { to: string; rvn: number; what: string } | null = null;

function openSend(): void {
  // 🔴 이 줄이 없으면 한 번 물건을 산 뒤 **그냥 보내기에도 개발비가 붙는다.**
  // 그건 장터 수수료가 아니라 몰래 걷는 지갑 사용료다.
  // (`openBuyFromHash` 가 이 함수를 부른 뒤 다시 채운다)
  buying = null;
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

  // 물건을 사는 중이고 받는 주소가 그 글의 주소일 때만 개발비를 붙인다.
  // 사람이 주소를 고쳤으면 그건 이미 다른 거래다.
  const withDev = !!buying && buying.to === to;
  const sel = selectCoins(utxos, target, withDev ? 1 : 0);
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

    // 서명 직전에 한 번 더 본다. `pending.to` 는 검토 화면이 굳힌 주소이고,
    // 그게 사려던 물건의 주소와 같을 때만 개발비가 붙는다.
    const hex = buildAndSign(
      pending.sel, pending.to, pending.change, keys,
      !!buying && buying.to === pending.to,
    );
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
  $("sl-cancel").onclick = () => {
    stopEditing();
    ["sl-title", "sl-desc", "sl-price", "sl-where", "sl-image"].forEach((id) => {
      const el = $(id) as HTMLInputElement | null;
      if (el) el.value = "";
    });
    say("sl-msg", "");
  };
  $("btn-sell").onclick = () => {
    say("sl-msg", "");
    show("sell");
    void loadMine();
  };
  $("sell-back").onclick = () => show("main");
  $("sl-go").onclick = () => void sellPublish();
  $("sl-geo-go").onclick = () => void fillGeo();
  $("sl-photo-go").onclick = () => {
    const pick = $("sl-photo") as HTMLInputElement;
    pick.value = "";
    pick.click();
  };
  ($("sl-photo") as HTMLInputElement).onchange = async () => {
    const f = ($("sl-photo") as HTMLInputElement).files?.[0];
    if (!f) return;
    const note = $("sl-photo-note");
    note.textContent = "사진을 올리는 중…";
    try {
      const url = await uploadPhoto(f);
      ($("sl-image") as HTMLInputElement).value = url;
      // 올라간 것을 **보여 준다.** 주소만 적히면 제대로 갔는지 알 수 없다.
      note.innerHTML = `<img src="${escapeHtml(url)}" alt="" class="shot" />
        <div class="sub">올렸습니다. 다른 사진을 고르시면 바뀝니다.</div>`;
      // 🔴 사본을 한 부 더 둔다. 사진은 남의 미디어 서버에 있고, 그곳이
      //    닫히면 사라진다 — 우리도 못 되살린다. 이 화면이 **가게 노드에서**
      //    열렸으면 그 노드가 한 부를 갖고 있게 한다.
      //
      //    ⚠️ 덤이다. 실패해도 아무 말 안 한다 — 사본 때문에 물건 올리기가
      //       막히거나 겁을 주면 안 된다. 성공했을 때만 한 줄 보탠다.
      void keepCopy(url, note);
    } catch (e) {
      note.innerHTML = `<span class="err">${escapeHtml(String((e as Error)?.message || e))}</span>`;
    }
  };

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
