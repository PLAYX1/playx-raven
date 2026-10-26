/*
 * 「기기 연결」 — 가게 키 PC(사업자 원본 PC)가 새 폰·보조 PC 를 등록하고 끊는 화면. (판매자 기능)
 *
 * 규칙은 지갑 core/device(기기 증서 DeviceCert · 철회 목록 · 데이터 열쇠)를 그대로 쓴다. 이 파일은 화면과 연결 자리(포트)만 가진다.
 *
 * 🔴 키: 가게 키는 이 파일에 없다. 서명은 StoreKeyPort.signDigest 콜백 하나로만 한다(기본 = 연결 전, 서명 못 함).
 *    데스크탑에는 아직 「다이제스트를 서명하는」 기존 경로가 없다(노드 sign_message 는 문구+주소 서명이라 모양이 다르다) — 이어 붙일 자리만 만든다.
 * 🔴 전달: 새 기기와 주고받는 길(같은 Wi-Fi 서버 8790 등)은 새로 만들지 않았다. DeviceLinkPort 인터페이스 + Null. 화면은 「연결 전」이라고 말한다.
 * 🔴 QR: 기존 RV6 폰 연결 QR(`pairing_show_qr`)을 그대로 부른다 — 규격을 바꾸지 않는다. 증서에 쓸 기기 공개키는 아직 그 QR 로 받을 수 없어
 *    새 기기가 알려 준 공개키를 칸에 붙여 넣는다(받는 길이 생기면 DeviceLinkPort.receiveKey 로 대체).
 * 🔴 기본 만료 7일은 잠정(core DEVICE_CERT_DEFAULT_DAYS) — 대표 결정 대기. 화면에도 「잠정」이라고 적는다.
 * 🔴 끊기(레인 Y): 「끊기」 단추는 Rust `lan_device_disconnect` 한 길만 부른다 — 철회와 데이터 열쇠 회전을 한 동작으로(사장 확인 1번, 열쇠는 웹뷰를 지나지 않음).
 *    Rust 가 「나눠 준 열쇠가 아직 없음(noDataKey)」이라고 답할 때만 여기서 목록만 새로 서명한다(바꿀 열쇠가 없으니 그것으로 안전).
 *    이미 그 기기가 복사해 간 지난 데이터는 되돌릴 수 없다는 문구는 법적 확인 필요(문구 확정 전).
 * style="…" 속성은 쓰지 않는다(CSP) — 모양은 device-connect.css.
 */
import {
  DEVICE_CERT_DEFAULT_DAYS, DEVICE_CERT_MAX_MS, DEVICE_ROLE_SCOPES, deviceCertId, deviceCertWindow, deviceIdOf, encodeDeviceCert,
  issueDeviceCert, validateDeviceCert, verifyDeviceCert, type DeviceCert, type DeviceCertBody, type DeviceRole,
} from "../core/device/cert";
import {
  REVOCATION_LIST_MAX_AGE_MS, acceptDeviceRevocationList, signDeviceRevocationList, validateDeviceRevocationList, type DeviceRevocationList,
} from "../core/device/revoke";
import type { SignDigest } from "../core/signer/signmessage";
import { DICT } from "./dict";
import { DEVICE_COPY } from "./device-copy";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import { downloadExport, localStoreDocStorage, mountStoreDocCard, type StoreDocStorage } from "./store-doc-ui";
import "./device-connect.css";

/* 이 화면의 문구는 화면을 처음 열 때 사전에 합친다(시작 묶음을 키우지 않으려고 dict.ts 에 넣지 않는다). 이미 있는 번역은 덮지 않는다. */
for (const [source, values] of Object.entries(DEVICE_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

/* ── 연결 자리(포트) ───────────────────────────────────────── */

/** 가게 키 서명 자리. info() 가 null 이면 「가게 키 연결 전」 — 발급·끊기는 닫힌다. */
export type StoreKeyPort = {
  /** storeId 가 null 이면 「가게 키는 있으나 가게 문서(번호)가 없다」 — 키 지문은 보이고 발급·끊기는 닫힌다. */
  info(): Promise<{ storeId: string | null; storeKey: string } | null>;
  signDigest: SignDigest;
  /** 같은 키로 서명하되 사장 확인창에 다른 사유를 보인다(80자 이하). 연결 전 포트에는 없다. */
  withReason?(reason: string): StoreKeyPort;
};
export const nullStoreKey: StoreKeyPort = {
  info: async () => null,
  signDigest: async () => { throw new Error("store-key-not-connected"); },
};

type Invoke0 = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const SHA_HEX = /^[0-9a-f]{64}$/, PUB_HEX = /^0[23][0-9a-f]{64}$/;
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
/**
 * 데스크탑 가게 키(Rust `store_key_info` · `store_sign_digest`). 키·12단어는 Rust 안에만 있고 여기에는 공개키와 서명만 온다.
 * 서명할 때마다 Rust 가 사장에게 사유를 보여 주고 확인을 받는다(앱 잠금 중이면 거절). reason 은 80자 이하 한 줄.
 * storeId = 가게 문서(rev 0 해시) — 「가게 번호」 카드(store-doc-ui.ts)로 만들어 이 기기에 저장한 값을 호출자가 넘긴다(없으면 null → 발급 닫힘).
 */
export function tauriStoreKey(invoke: Invoke0, storeId: () => Promise<string | null> = async () => null, reason = "가게 기기·상품 서명"): StoreKeyPort {
  const port: StoreKeyPort = {
    info: async () => {
      const r = await invoke<{ store_key?: string }>("store_key_info");
      if (!r || typeof r.store_key !== "string" || !PUB_HEX.test(r.store_key)) return null;
      const id = await storeId().catch(() => null);
      return { storeId: id && SHA_HEX.test(id) ? id : null, storeKey: r.store_key };
    },
    signDigest: async digest => {
      if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error("store-sign-digest");
      const hex = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
      const r = await invoke<{ sig?: string }>("store_sign_digest", { digest: hex, reason });
      // 오류 문구는 Rust 의 고정 문장뿐이지만 화면 코드에는 옮기지 않는다(코드만).
      if (!r || typeof r.sig !== "string" || !/^[0-9a-f]{128}$/.test(r.sig)) throw new Error("store-sign-reply");
      return unhex(r.sig);
    },
    withReason: next => tauriStoreKey(invoke, storeId, next),
  };
  return port;
}

/** 새 기기와 주고받는 자리(같은 Wi-Fi). 지금은 아무것도 보내지 않는다. */
export type DeviceLinkPort = {
  /** 연결돼 있나(화면 표시용). */
  readonly connected: boolean;
  /** 새 기기가 알려 준 공개키(66 hex). 없으면 null. */
  receiveKey(): Promise<string | null>;
  /** 증서를 새 기기에 보낸다. 보냈으면 true. */
  deliverCert(cert: DeviceCert): Promise<boolean>;
};
export const nullDeviceLink: DeviceLinkPort = { connected: false, receiveKey: async () => null, deliverCert: async () => false };

/**
 * 기기 끊기 자리(레인 Y). 운영 = Rust `lan_device_disconnect`(회전 + 철회를 한 번에, 사장 확인 1번).
 * noDataKey = 기기끼리 나눈 데이터 열쇠가 아직 없음 → 화면이 목록만 새로 서명해도 안전하다. 그 밖에는 Rust 가 서명한 새 목록을 돌려준다.
 */
export type DisconnectResult = { noDataKey: true } | { noDataKey?: false; rotated: boolean; list: unknown };
export type DeviceDisconnectPort = { disconnect(deviceId: string, name: string, history: readonly DeviceCert[], list: DeviceRevocationList | null): Promise<DisconnectResult> };
export const nullDisconnect: DeviceDisconnectPort = { disconnect: async () => ({ noDataKey: true }) };
export function tauriDisconnect(invoke: Invoke0): DeviceDisconnectPort {
  return {
    disconnect: async (deviceId, name, history, list) => {
      const r = await invoke<{ ok?: boolean; noDataKey?: boolean; rotated?: boolean; list?: unknown }>("lan_device_disconnect", { deviceId, deviceName: name.slice(0, 40), knownCerts: history, knownList: list });
      if (r && r.noDataKey === true) return { noDataKey: true };
      if (!r || r.ok !== true || r.list === undefined) throw new Error("device-disconnect");
      return { rotated: r.rotated === true, list: r.list };
    },
  };
}

export type ShownQr = { svg: string; expiresAt: number; fingerprint: string };
export type DeviceQrPort = { show(): Promise<ShownQr | null>; cancel(): Promise<void> };
export const nullDeviceQr: DeviceQrPort = { show: async () => null, cancel: async () => {} };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** 기존 RV6 폰 연결 QR 를 그대로 쓴다(pairing-ui.ts 와 같은 명령 · 규격 불변). */
export function pairingQr(invoke: Invoke): DeviceQrPort {
  return {
    show: async () => {
      const s = await invoke<{ svg: string; expires_at: number; fingerprint: string }>("pairing_show_qr");
      return s && typeof s.svg === "string" ? { svg: s.svg, expiresAt: Number(s.expires_at) || 0, fingerprint: String(s.fingerprint ?? "") } : null;
    },
    cancel: async () => { await invoke("pairing_cancel_qr").catch(() => {}); },
  };
}

/* ── 폰 연결(같은 와이파이 짝 맺기 · 레인 Y 화면) ─────────────── */
/**
 * Rust `lan_sync_status` · `lan_pair_offer` · `lan_pair_pending` · `lan_pair_approve`(lan_mount.rs)를 그대로 부른다.
 * 🔴 같은 와이파이 자동 복사(lanSync)는 기본 꺼짐 — 켜는 것은 대표 승인 사항이라 이 화면은 켜지 않는다. 꺼져 있으면 「꺼져 있어요」만 말한다.
 * 🔴 새 기기 허락의 사장 확인은 Rust 가 1번만 묻는다(증서 + 열쇠 봉투 묶음 서명). 열쇠·12단어는 웹뷰를 지나지 않는다. 화면에는 QR 글(비밀 없음)·이름·확인 번호·지문만 온다.
 */
export type LanSyncStatus = { on: boolean; state: string; say: string };
export type LanPairOffer = { svg: string; expiresAt: number; restartNeeded: boolean; say: string };
export type LanPairPending = { name: string; code: string; fingerprint: string; approved: boolean; devicePubKey: string };
export type LanPairPort = {
  status(): Promise<LanSyncStatus>;
  offer(storeName: string): Promise<LanPairOffer>;
  pending(): Promise<LanPairPending[]>;
  approve(devicePubKey: string, role: DeviceRole, knownCerts: readonly DeviceCert[]): Promise<{ cert: DeviceCert; say: string }>;
};
export const nullLanPair: LanPairPort = {
  status: async () => ({ on: false, state: "off", say: "" }),
  offer: async () => { throw new Error("lan-off"); },
  pending: async () => [],
  approve: async () => { throw new Error("lan-off"); },
};
export function tauriLanPair(invoke: Invoke0): LanPairPort {
  return {
    status: async () => {
      const r = await invoke<{ on?: boolean; state?: string; say?: string }>("lan_sync_status");
      return { on: r?.on === true, state: String(r?.state ?? "off"), say: String(r?.say ?? "") };
    },
    offer: async storeName => {
      const r = await invoke<{ offerText?: string; expiresAt?: number; restartNeeded?: boolean; say?: string }>("lan_pair_offer", { storeName });
      if (!r || typeof r.offerText !== "string") throw new Error("lan-pair-offer");
      const svg = await invoke<string>("qr_svg", { text: r.offerText });
      return { svg, expiresAt: Number(r.expiresAt) || 0, restartNeeded: r.restartNeeded === true, say: String(r.say ?? "") };
    },
    pending: async () => {
      const r = await invoke<unknown>("lan_pair_pending");
      return (Array.isArray(r) ? r : []).map((p: Record<string, unknown>) => ({
        name: String(p.name ?? ""), code: String(p.code ?? ""), fingerprint: String(p.fingerprint ?? ""), approved: p.approved === true, devicePubKey: String(p.devicePubKey ?? ""),
      }));
    },
    approve: async (devicePubKey, role, knownCerts) => {
      const r = await invoke<{ ok?: boolean; cert?: DeviceCert; say?: string }>("lan_pair_approve", { devicePubKey, role, knownCerts });
      if (!r || r.ok !== true || !r.cert) throw new Error("lan-pair-approve");
      return { cert: r.cert, say: String(r.say ?? "") };
    },
  };
}

/* ── 저장 ──────────────────────────────────────────────────── */

export type DeviceState = {
  /** 발급한 증서 이력(영속 — 일련번호 중복 금지의 근거). */
  history: DeviceCert[];
  list: DeviceRevocationList | null;
  /** 사장이 붙인 기기 이름(증서에는 안 들어간다) · 마지막으로 확인된 때(ms). */
  names: Record<string, string>;
  lastSeen: Record<string, number>;
};
export const emptyState = (): DeviceState => ({ history: [], list: null, names: {}, lastSeen: {} });
export type DeviceStore = { load(): DeviceState; save(s: DeviceState): void };
export const DEVICE_STORE_KEY = "rv-devices-v1";

/** 저장소가 막혀 있어도 화면은 돈다(그 동안만 기억 안 함). 읽을 때 증서·목록은 core 규칙으로 다시 거른다. */
export function localDeviceStore(storage: Storage | null = (() => { try { return localStorage; } catch { return null; } })()): DeviceStore {
  return {
    load() {
      try {
        const raw = JSON.parse(storage?.getItem(DEVICE_STORE_KEY) ?? "null");
        if (!raw || typeof raw !== "object") return emptyState();
        const history: DeviceCert[] = [];
        for (const c of Array.isArray(raw.history) ? raw.history : []) { try { history.push(validateDeviceCert(c)); } catch { /* 깨진 칸은 건너뛴다 */ } }
        let list: DeviceRevocationList | null = null;
        try { list = raw.list ? validateDeviceRevocationList(raw.list) : null; } catch { list = null; }
        const names: Record<string, string> = {}, lastSeen: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.names ?? {})) if (typeof v === "string") names[k] = v.slice(0, 40);
        for (const [k, v] of Object.entries(raw.lastSeen ?? {})) if (typeof v === "number" && Number.isFinite(v)) lastSeen[k] = v;
        return { history, list, names, lastSeen };
      } catch { return emptyState(); }
    },
    save(s) { try { storage?.setItem(DEVICE_STORE_KEY, JSON.stringify(s)); } catch { /* 저장 못 해도 화면은 계속 */ } },
  };
}
export function memoryDeviceStore(initial: DeviceState = emptyState()): DeviceStore {
  let s = initial;
  return { load: () => structuredClone(s), save: next => { s = structuredClone(next); } };
}

/* ── 순수 규칙(화면 없이 시험) ─────────────────────────────── */

export const DEVICE_ROLES: readonly DeviceRole[] = ["remote", "staff-pc", "scanner", "replica"];
export const ROLE_LABEL: Record<DeviceRole, string> = {
  remote: "원격 폰",
  "staff-pc": "직원 PC",
  scanner: "확인용 단말",
  replica: "보조 PC(복제본)",
};
export const ROLE_HELP: Record<DeviceRole, string> = {
  remote: "보기·초안·표 확인 정도만 해요. 가격이나 환불은 못 바꿔요.",
  "staff-pc": "직원이 쓰는 PC예요. 돈이 나가는 일과 증서 발급은 못 해요.",
  scanner: "표 확인만 해요.",
  replica: "읽기와 복제만 해요. 쓰기는 이 PC 에서만 해요.",
};
export const DEVICE_TTL_DAYS = [1, 7, 14, 30] as const;
export const DAY_MS = 24 * 3600_000;
const PUBKEY = /^0[23][a-f0-9]{64}$/;

export const isDevicePublicKey = (v: string): boolean => PUBKEY.test(v);
export const nextSerial = (history: readonly DeviceCert[]): number => history.reduce((m, c) => Math.max(m, c.serial), 0) + 1;

export type DeviceStatus = "active" | "expired" | "revoked";
export type DeviceRow = {
  deviceId: string; certId: string; name: string; role: DeviceRole; notAfter: number; issuedAt: number; status: DeviceStatus; lastSeen: number | null; serial: number;
};
/** 기기 하나(가장 최근 증서)당 한 줄. 철회·만료도 보인다(숨기면 끊은 기기를 잊는다). */
export function deviceRows(state: DeviceState, now: number): DeviceRow[] {
  const latest = new Map<string, DeviceCert>();
  for (const c of state.history) { const p = latest.get(c.deviceId); if (!p || c.serial > p.serial) latest.set(c.deviceId, c); }
  const revoked = new Set(state.list?.revoked ?? []);
  return [...latest.values()].sort((a, b) => b.issuedAt - a.issuedAt).map(c => {
    const certId = deviceCertId(c);
    const status: DeviceStatus = revoked.has(certId) || (state.list ? c.notAfter <= state.list.prunedBefore : false) ? "revoked" : now >= c.notAfter ? "expired" : "active";
    return { deviceId: c.deviceId, certId, name: state.names[c.deviceId] || t("이름 없는 기기"), role: c.role, notAfter: c.notAfter, issuedAt: c.issuedAt, status, lastSeen: state.lastSeen[c.deviceId] ?? null, serial: c.serial };
  });
}
/** 철회 목록이 하루(core 규칙)보다 오래됐나 — 오래되면 증서 확인이 전부 거절된다. */
export const listIsStale = (list: DeviceRevocationList | null, now: number): boolean => !list || now - list.issuedAt > REVOCATION_LIST_MAX_AGE_MS;

type Signing = { storeId: string; storeKey: string; sign: SignDigest };
/** 철회 목록을 새로 서명한다(seq+1 · 같은 철회 목록 · prunedBefore 유지). 받는 쪽 규칙(후퇴 금지)을 통과한 것만 돌려준다. */
export async function resignList(state: DeviceState, k: Signing, now: number, add: readonly string[] = []): Promise<DeviceRevocationList> {
  const prev = state.list;
  const revoked = [...new Set([...(prev?.revoked ?? []), ...add])].sort();
  const body = { v: 1 as const, storeId: k.storeId, seq: (prev?.seq ?? 0) + 1, revoked, issuedAt: now, prunedBefore: prev?.prunedBefore ?? 0 };
  const next = await signDeviceRevocationList(body, k.storeKey, k.sign);
  return acceptDeviceRevocationList(prev, next, k.storeKey, k.storeId);
}

export type IssueInput = { devicePubKey: string; role: DeviceRole; ttlMs: number; name: string };
/** 증서 발급: 하루 지난 철회 목록은 먼저 새로 서명, 일련번호는 이력 최댓값+1. 결과 상태를 돌려준다(저장은 호출자). */
export async function issueFor(state: DeviceState, k: Signing, input: IssueInput, now: number): Promise<{ state: DeviceState; cert: DeviceCert }> {
  if (!isDevicePublicKey(input.devicePubKey)) throw new Error("device-key");
  if (!DEVICE_ROLES.includes(input.role)) throw new Error("device-role");
  if (!(input.ttlMs >= DAY_MS && input.ttlMs <= DEVICE_CERT_MAX_MS)) throw new Error("device-ttl");
  const list = listIsStale(state.list, now) ? await resignList(state, k, now) : state.list!;
  const win = deviceCertWindow(now, input.ttlMs);
  const body: DeviceCertBody = {
    v: 1, storeId: k.storeId, deviceId: deviceIdOf(input.devicePubKey), devicePubKey: input.devicePubKey, role: input.role,
    scopes: [...DEVICE_ROLE_SCOPES[input.role]], issuedAt: win.issuedAt, notAfter: win.notAfter, serial: nextSerial(state.history),
  };
  const cert = await issueDeviceCert(body, k.storeKey, k.sign, now, list, state.history);
  const verified = verifyDeviceCert(cert, k.storeKey, now, list);
  if (!verified.ok) throw new Error("device-verify:" + verified.reason);
  return { cert, state: { ...state, list, history: [...state.history, cert], names: { ...state.names, [cert.deviceId]: input.name.trim().slice(0, 40) } } };
}
/**
 * 목록만 새로 서명하는 끊기 — **화면 단추에서 직접 부르지 않는다**. `disconnectFor` 가 Rust 에게서 「나눠 준 열쇠 없음」을 받았을 때만 쓴다
 * (열쇠가 있으면 목록만 바꾸는 것은 끊긴 기기가 옛 열쇠를 쥔 채 남는 길이라 Rust 가 거절하고, 처리기 관문도 멈춘다).
 */
export async function revokeFor(state: DeviceState, k: Signing, deviceId: string, now: number): Promise<DeviceState> {
  const row = deviceRows(state, now).find(r => r.deviceId === deviceId);
  if (!row) throw new Error("device-unknown");
  const list = await resignList(state, k, now, [row.certId]);
  return { ...state, list };
}

/** 「끊기」 단추가 부르는 유일한 길: Rust 회전(철회 + 새 열쇠, 사장 확인 1번). 나눠 준 열쇠가 없을 때만 목록 서명으로 끝낸다. */
export async function disconnectFor(state: DeviceState, k: Signing, port: DeviceDisconnectPort, deviceId: string, now: number): Promise<{ state: DeviceState; rotated: boolean }> {
  const row = deviceRows(state, now).find(r => r.deviceId === deviceId);
  if (!row) throw new Error("device-unknown");
  const r = await port.disconnect(deviceId, row.name, state.history, state.list);
  if (r.noDataKey === true) return { state: await revokeFor(state, k, deviceId, now), rotated: false };
  const list = acceptDeviceRevocationList(state.list, r.list, k.storeKey, k.storeId);
  if (!list.revoked.includes(row.certId)) throw new Error("device-disconnect");
  return { state: { ...state, list }, rotated: r.rotated };
}

/* ── 화면 ──────────────────────────────────────────────────── */

export type DeviceScreenDeps = {
  storeKey?: StoreKeyPort; link?: DeviceLinkPort; qr?: DeviceQrPort; store?: DeviceStore;
  /** 기기 끊기(운영 = tauriDisconnect). 없으면 「나눠 준 열쇠 없음」으로 보고 목록만 서명한다(시험·연결 전). */
  disconnect?: DeviceDisconnectPort;
  /** 폰 연결(운영 = tauriLanPair). 없으면 「꺼져 있어요」로 보인다. */
  lanPair?: LanPairPort;
  now?: () => number;
  /** 확인창. 기본은 window.confirm. 취소하면 false. okLabel 은 확인 단추 글자. */
  confirm?: (title: string, message: string, okLabel?: string) => Promise<boolean>;
  /** 「가게 번호」 카드가 쓰는 저장소(이 기기 안)와 파일 내보내기. */
  storeDocs?: StoreDocStorage;
  exportFile?: (name: string, bytes: Uint8Array) => Promise<void>;
  copyText?: (text: string) => Promise<void>;
};

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const el = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string) => root.querySelector<T>(`#${id}`)!;
const errCode = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function agoText(ms: number | null, now: number): string {
  if (ms === null) return t("아직 확인된 적 없어요");
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return t("방금");
  if (s < 3600) return tf("{0}분 전", Math.floor(s / 60));
  if (s < 86400) return tf("{0}시간 전", Math.floor(s / 3600));
  return tf("{0}일 전", Math.floor(s / 86400));
}
function certErrorSay(code: string): string {
  if (code.startsWith("device-verify")) return t("만든 증서가 검사를 통과하지 못했어요. 발급하지 않았어요.");
  if (code === "device-key") return t("새 기기의 공개키가 올바르지 않아요. 66자리 영문·숫자(02 또는 03 으로 시작)예요.");
  if (code === "store-key-not-connected") return t("가게 키 서명이 아직 연결되지 않았어요. 연결 전에는 발급할 수 없어요.");
  if (/duplicate-serial/.test(code)) return t("같은 번호의 증서가 이미 있어요. 발급하지 않았어요.");
  return t("발급하지 못했어요. 입력을 다시 확인해 주세요.");
}

const MARKUP = `
  <h1>${copyHtml("기기 연결")}</h1>
  <p class="meta">${copyHtml("이 컴퓨터(가게 키 PC)가 새 폰이나 보조 컴퓨터를 등록해요. 등록된 기기는 정해진 일만 하고, 기간이 지나면 저절로 멈춰요.")}</p>
  <p class="meta dv-keystate" id="dv-keystate" role="status"></p>
  <div class="card dv-card" id="dv-storecard"></div>
  <div class="card dv-card">
    <h2>${copyHtml("연결된 기기")}</h2>
    <p class="meta" id="dv-liststate"></p>
    <div class="dv-tablewrap"><table class="dv-table" id="dv-table"><thead><tr>
      <th>${copyHtml("기기")}</th><th>${copyHtml("역할")}</th><th>${copyHtml("증서 만료일")}</th><th>${copyHtml("마지막 확인")}</th><th>${copyHtml("상태")}</th><th><span class="dv-sr">${copyHtml("끊기")}</span></th>
    </tr></thead><tbody id="dv-rows"></tbody></table></div>
    <p class="meta" id="dv-empty" hidden>${copyHtml("아직 연결된 기기가 없어요.")}</p>
    <div class="dv-row"><button type="button" id="dv-resign" class="ghost">${copyHtml("철회 목록 새로 서명")}</button></div>
  </div>
  <div class="card dv-card">
    <h2>${copyHtml("새 기기 연결")}</h2>
    <p class="warnbox" id="dv-linkstate"></p>
    <div class="dv-form">
      <label>${copyHtml("기기 이름")} <input id="dv-name" maxlength="40" autocomplete="off" /></label>
      <label>${copyHtml("역할")} <select id="dv-role"></select></label>
      <p class="meta" id="dv-rolehelp"></p>
      <label>${copyHtml("증서 기간")} <select id="dv-ttl"></select></label>
      <p class="meta">${copyHtml("기본 7일은 잠정 값이에요. 정해지기 전까지 바뀔 수 있어요.")}</p>
    </div>
    <h3>${copyHtml("1. QR 만들기")}</h3>
    <p class="meta">${copyHtml("새 폰이나 컴퓨터에서 RavenVault 를 열고 이 QR 을 찍게 해요. 폰 연결과 같은 QR 이에요.")}</p>
    <div class="dv-row"><button type="button" id="dv-qr">${copyHtml("QR 만들기")}</button><button type="button" id="dv-qr-close" class="ghost" hidden>${copyHtml("QR 닫기")}</button></div>
    <div class="dv-qrbox" id="dv-qrbox" hidden><div class="dv-qr" id="dv-qrimg" translate="no"></div><p class="meta">${copyHtml("이 컴퓨터 확인 글자")}: <b id="dv-qrfp" translate="no"></b></p></div>
    <h3>${copyHtml("2. 새 기기의 공개키")}</h3>
    <p class="meta">${copyHtml("새 기기 화면에 나온 공개키를 붙여 넣어요. 자동으로 받는 길은 아직 연결 전이에요.")}</p>
    <label class="dv-key">${copyHtml("공개키")} <input id="dv-pub" spellcheck="false" autocomplete="off" translate="no" /></label>
    <h3>${copyHtml("3. 증서 발급")}</h3>
    <div class="dv-row"><button type="button" id="dv-issue" disabled>${copyHtml("증서 발급하기")}</button></div>
    <p class="meta" id="dv-say" role="status" aria-live="polite"></p>
    <div class="dv-result" id="dv-result" hidden>
      <p class="meta">${copyHtml("발급한 증서예요. 서명 확인됨 · 서명 이후 바뀌지 않아요. 새 기기에 그대로 옮겨 주세요.")}</p>
      <textarea id="dv-cert" readonly rows="6" spellcheck="false" translate="no"></textarea>
      <div class="dv-row"><button type="button" id="dv-copy" class="ghost">${copyHtml("복사")}</button></div>
    </div>
  </div>
  <div class="card dv-card" id="lp-card">
    <h2>${copyHtml("폰 연결")}</h2>
    <p class="meta">${copyHtml("같은 와이파이의 폰을 이 컴퓨터에 연결해요. 폰에서 QR 을 읽으면 폰에 확인 번호가 떠요. 이 화면의 번호와 같을 때만 허락해 주세요.")}</p>
    <p class="warnbox" id="lp-state" role="status"></p>
    <div id="lp-body" hidden>
      <div class="dv-form">
        <label>${copyHtml("가게 이름")} <input id="lp-store" maxlength="40" autocomplete="off" /></label>
        <label>${copyHtml("역할")} <select id="lp-role"></select></label>
        <p class="meta" id="lp-rolehelp"></p>
      </div>
      <div class="dv-row"><button type="button" id="lp-start">${copyHtml("폰 연결 시작")}</button><button type="button" id="lp-stop" class="ghost" hidden>${copyHtml("연결 닫기")}</button></div>
      <div class="dv-qrbox" id="lp-qrbox" hidden><div class="dv-qr" id="lp-qrimg" translate="no"></div><p class="meta" id="lp-qrhelp"></p></div>
      <h3>${copyHtml("연결을 기다리는 폰")}</h3>
      <p class="meta" id="lp-none">${copyHtml("아직 없어요. 폰에서 QR 을 읽으면 여기에 나와요.")}</p>
      <ul class="dv-pending" id="lp-list"></ul>
      <p class="meta" id="lp-say" role="status" aria-live="polite"></p>
    </div>
  </div>
  <div class="card dv-card dv-note">
    <h2>${copyHtml("기기를 끊을 때 알아 두세요")}</h2>
    <p>${copyHtml("끊으면 그 기기는 새 증서 확인에서 바로 멈춰요.")}</p>
    <p>${copyHtml("이미 복사된 지난 데이터는 되돌릴 수 없어요.")}</p>
    <p>${copyHtml("끊기를 누르면 데이터 열쇠도 함께 새것으로 바뀌어요. 새 열쇠는 남은 기기에만 나눠요.")}</p>
    <!-- 법적 확인 필요: 「되돌릴 수 없어요」 문구와 개인정보 안내 범위는 법무 확인 전 초안이다(core/device/data-key.ts DATA_KEY_NOTES 와 같은 상태). -->
  </div>
`;

/** 화면을 root 안에 그린다. 연결 자리는 deps 로 바꿔 끼운다. */
export function mountDeviceScreen(root: HTMLElement, deps: DeviceScreenDeps = {}) {
  const key = deps.storeKey ?? nullStoreKey, link = deps.link ?? nullDeviceLink, qr = deps.qr ?? nullDeviceQr, disconnect = deps.disconnect ?? nullDisconnect, lan = deps.lanPair ?? nullLanPair;
  const store = deps.store ?? localDeviceStore();
  const now = deps.now ?? (() => Date.now());
  const confirmBox = deps.confirm ?? (async (title: string, message: string, _ok?: string) => window.confirm(`${title}\n${message}`));
  const storeDocs = deps.storeDocs ?? localStoreDocStorage();
  const copy = deps.copyText ?? (async (text: string) => { await navigator.clipboard.writeText(text); });
  root.innerHTML = MARKUP;
  let state = store.load();
  let signing: Signing | null = null;
  let keyOnly: string | null = null;
  let busy = false;
  const REASON_ISSUE = "기기 증서 발급 - 새 기기를 등록합니다", REASON_REVOKE = "기기 끊기 - 철회 목록을 새로 서명합니다";
  const withReason = (k: Signing, reason: string): Signing => {
    const port = key.withReason?.(reason);
    return port ? { ...k, sign: port.signDigest } : k;
  };

  const say = (render: () => string) => setCopyText(el(root, "dv-say"), render);
  const storeCard = mountStoreDocCard(el(root, "dv-storecard"), {
    key, docs: storeDocs, now, confirm: confirmBox, exportFile: deps.exportFile ?? downloadExport, onChange: () => { void refreshKey(); },
  });
  const roleSel = el<HTMLSelectElement>(root, "dv-role"), ttlSel = el<HTMLSelectElement>(root, "dv-ttl");
  for (const r of DEVICE_ROLES) roleSel.add(new Option(t(ROLE_LABEL[r]), r));
  for (const d of DEVICE_TTL_DAYS) ttlSel.add(new Option(d === DEVICE_CERT_DEFAULT_DAYS ? tf("{0}일 (기본 · 잠정)", d) : tf("{0}일", d), String(d)));
  ttlSel.value = String(DEVICE_CERT_DEFAULT_DAYS);
  const roleHelp = () => setCopyText(el(root, "dv-rolehelp"), () => t(ROLE_HELP[roleSel.value as DeviceRole]));
  roleSel.onchange = roleHelp; roleHelp();

  const statusText = (s: DeviceStatus) => (s === "active" ? t("쓰는 중") : s === "expired" ? t("기간 지남") : t("끊음"));

  function paint() {
    const n = now();
    setCopyText(el(root, "dv-keystate"), () => signing
      ? tf("가게 키 연결됨 · 키 지문 {0}", signing.storeKey.slice(0, 12))
      : keyOnly ? tf("가게 키 있음 · 키 지문 {0} · 가게 문서(번호)가 아직 없어 발급과 끊기는 닫혀 있어요. 아래 「가게 번호」에서 만들 수 있어요.", keyOnly.slice(0, 12))
      : t("가게 키 서명이 아직 연결되지 않았어요(연결 전). 목록은 볼 수 있지만 발급과 끊기는 닫혀 있어요."));
    setCopyText(el(root, "dv-liststate"), () => !state.list
      ? t("철회 목록이 아직 없어요. 첫 발급 때 만들어요.")
      : listIsStale(state.list, n)
        ? t("철회 목록이 하루가 지났어요. 새로 서명하기 전에는 기기 증서가 모두 거절돼요.")
        : tf("철회 목록 {0}번째 판 · 끊은 기기 {1}대", state.list.seq, state.list.revoked.length));
    setCopyText(el(root, "dv-linkstate"), () => link.connected
      ? t("같은 Wi-Fi 로 새 기기와 바로 주고받아요.")
      : t("연결 전 — 새 기기와 자동으로 주고받는 길은 아직 없어요. 증서를 만들면 글로 보여 드리니 새 기기에 직접 옮겨 주세요."));
    const rows = deviceRows(state, n);
    const body = el(root, "dv-rows");
    body.innerHTML = rows.map(r => `<tr data-device="${esc(r.deviceId)}" data-status="${r.status}">
      <td class="dv-name" translate="no">${esc(r.name)}</td>
      <td>${copyHtml(ROLE_LABEL[r.role])}</td>
      <td>${esc(formatDay(r.notAfter))}</td>
      <td class="dv-seen"></td>
      <td class="dv-status"></td>
      <td>${r.status === "active" ? `<button type="button" class="ghost" data-revoke="${esc(r.deviceId)}">${copyHtml("끊기")}</button>` : ""}</td></tr>`).join("");
    body.querySelectorAll<HTMLElement>("tr").forEach((tr, i) => {
      setCopyText(tr.querySelector(".dv-seen")!, () => agoText(rows[i].lastSeen, now()));
      setCopyText(tr.querySelector(".dv-status")!, () => statusText(rows[i].status));
    });
    el(root, "dv-empty").hidden = rows.length > 0;
    el(root, "dv-table").hidden = rows.length === 0;
    (el(root, "dv-resign") as HTMLButtonElement).disabled = !signing;
    (el(root, "dv-issue") as HTMLButtonElement).disabled = !signing || busy;
  }

  async function refreshKey() {
    keyOnly = null;
    try {
      const i = await key.info();
      signing = i && i.storeId ? { storeId: i.storeId, storeKey: i.storeKey, sign: key.signDigest } : null;
      storeCard.paint();
      if (i && !i.storeId) keyOnly = i.storeKey;
    } catch { signing = null; }
    paint();
  }

  /* ── 폰 연결 ── */
  const lpRole = el<HTMLSelectElement>(root, "lp-role");
  for (const r of DEVICE_ROLES) lpRole.add(new Option(t(ROLE_LABEL[r]), r));
  lpRole.value = "remote";
  const lpHelp = () => setCopyText(el(root, "lp-rolehelp"), () => t(ROLE_HELP[lpRole.value as DeviceRole]));
  lpRole.onchange = lpHelp; lpHelp();
  const lpSay = (render: () => string) => setCopyText(el(root, "lp-say"), render);
  let lpOn = false, lpStateSay = "", lpTimer: ReturnType<typeof setInterval> | null = null, lpExpires = 0, lpPending: LanPairPending[] = [], lpBusy = false;
  const lpStop = () => {
    if (lpTimer !== null) { clearInterval(lpTimer); lpTimer = null; }
    el(root, "lp-qrbox").hidden = true; el(root, "lp-stop").hidden = true; lpExpires = 0;
  };
  function lpPaint() {
    setCopyText(el(root, "lp-state"), () => lpOn ? t("폰 연결을 쓸 수 있어요.") : lpStateSay ? lpStateSay : t("같은 와이파이 자동 복사가 꺼져 있어요."));
    el(root, "lp-body").hidden = !lpOn;
    const list = el(root, "lp-list");
    list.innerHTML = lpPending.map(p => `<li data-pk="${esc(p.devicePubKey)}"><span class="dv-pname" translate="no">${esc(p.name)}</span>
      <span class="meta">${copyHtml("확인 번호")}: <b translate="no">${esc(p.code)}</b> · ${copyHtml("지문")}: <span translate="no">${esc(p.fingerprint)}</span></span>
      ${p.approved ? `<span class="meta">${copyHtml("허락했어요")}</span>` : `<button type="button" data-lp-approve="${esc(p.devicePubKey)}" ${lpBusy ? "disabled" : ""}>${copyHtml("허락")}</button>`}</li>`).join("");
    el(root, "lp-none").hidden = lpPending.length > 0;
    (el(root, "lp-start") as HTMLButtonElement).disabled = lpBusy || !lpOn;
  }
  async function lpRefreshStatus() {
    try { const s = await lan.status(); lpOn = s.on || (s.state !== "off" && s.state !== ""); lpStateSay = s.say; } catch { lpOn = false; lpStateSay = ""; }
    if (!lpOn) lpStop();
    lpPaint();
  }
  async function lpPoll() {
    if (lpExpires && now() > lpExpires) { lpStop(); lpPending = []; lpSay(() => t("연결 시간이 끝났어요. 다시 시작해 주세요.")); lpPaint(); return; }
    try { lpPending = await lan.pending(); } catch { lpPending = []; }
    lpPaint();
  }
  async function lpAct(run: () => Promise<void>) {
    if (lpBusy) return; lpBusy = true; lpPaint();
    try { await run(); } catch (e) { const m = errCode(e); lpSay(() => (/[가-힣]/.test(m) ? m : t("폰 연결에 실패했어요. 아무것도 바뀌지 않았어요."))); } finally { lpBusy = false; lpPaint(); }
  }
  void lpRefreshStatus();
  async function act(run: () => Promise<void>) {
    if (busy) return; busy = true; paint();
    try { await run(); } catch (e) { const c = errCode(e); say(() => certErrorSay(c)); } finally { busy = false; paint(); }
  }

  root.addEventListener("click", ev => {
    const b = (ev.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.id === "lp-start") return void lpAct(async () => {
      const storeName = el<HTMLInputElement>(root, "lp-store").value.trim();
      if (!storeName) { lpSay(() => t("가게 이름을 적어 주세요.")); return; }
      const o = await lan.offer(storeName);
      el(root, "lp-qrimg").innerHTML = o.svg; el(root, "lp-qrbox").hidden = false; el(root, "lp-stop").hidden = false;
      setCopyText(el(root, "lp-qrhelp"), () => t("폰에서 이 QR 을 읽어 주세요. 10분 동안 쓸 수 있어요."));
      lpExpires = o.expiresAt;
      lpSay(() => (o.restartNeeded ? t("처음 연결이라 기기끼리 나눌 열쇠를 만들었어요. 폰 연결 서버를 한 번 껐다 켜 주세요.") : ""));
      if (lpTimer === null) lpTimer = setInterval(() => { void lpPoll(); }, 2000);
      await lpPoll();
    });
    if (b.id === "lp-stop") { lpStop(); lpPending = []; lpSay(() => ""); lpPaint(); return; }
    if (b.dataset.lpApprove) {
      const pk = b.dataset.lpApprove, who = lpPending.find(p => p.devicePubKey === pk);
      return void lpAct(async () => {
        const r = await lan.approve(pk, lpRole.value as DeviceRole, state.history);
        state = { ...state, history: [...state.history, r.cert], names: { ...state.names, [r.cert.deviceId]: (who?.name ?? "").trim().slice(0, 40) } }; store.save(state);
        lpSay(() => t("새 폰을 연결했어요. 폰 화면에서 「완료」를 눌러 주세요."));
        await lpPoll(); paint();
      });
    }
    if (b.id === "dv-qr") void act(async () => {
      const shown = await qr.show().catch(() => null);
      if (!shown) { say(() => t("QR 을 만들지 못했어요. 폰 연결 서버가 켜져 있는지 확인해 주세요.")); return; }
      el(root, "dv-qrimg").innerHTML = shown.svg; el(root, "dv-qrfp").textContent = shown.fingerprint;
      el(root, "dv-qrbox").hidden = false; el(root, "dv-qr-close").hidden = false; say(() => "");
    });
    else if (b.id === "dv-qr-close") void act(async () => { await qr.cancel(); el(root, "dv-qrbox").hidden = true; el(root, "dv-qr-close").hidden = true; });
    else if (b.id === "dv-issue") void act(async () => {
      if (!signing) throw new Error("store-key-not-connected");
      let pub = el<HTMLInputElement>(root, "dv-pub").value.trim().toLowerCase();
      if (!pub) pub = (await link.receiveKey().catch(() => null)) ?? "";
      const name = el<HTMLInputElement>(root, "dv-name").value.trim();
      if (!name) { say(() => t("기기 이름을 적어 주세요.")); return; }
      const r = await issueFor(state, withReason(signing, REASON_ISSUE), { devicePubKey: pub, role: roleSel.value as DeviceRole, ttlMs: Number(ttlSel.value) * DAY_MS, name }, now());
      state = r.state; store.save(state);
      el<HTMLTextAreaElement>(root, "dv-cert").value = new TextDecoder().decode(encodeDeviceCert(r.cert));
      el(root, "dv-result").hidden = false;
      const sent = await link.deliverCert(r.cert).catch(() => false);
      say(() => sent ? tf("{0} 기기에 증서를 보냈어요.", name) : tf("{0} 증서를 만들었어요. 아직 자동으로 보내지 못해요(연결 전) — 아래 글을 새 기기에 옮겨 주세요.", name));
      el<HTMLInputElement>(root, "dv-pub").value = "";
    });
    else if (b.id === "dv-copy") void copy(el<HTMLTextAreaElement>(root, "dv-cert").value).then(() => say(() => t("복사했어요."))).catch(() => say(() => t("복사하지 못했어요. 글을 직접 끌어 선택해 복사해 주세요.")));
    else if (b.id === "dv-resign") void act(async () => {
      if (!signing) throw new Error("store-key-not-connected");
      state = { ...state, list: await resignList(state, withReason(signing, REASON_REVOKE), now()) }; store.save(state);
      say(() => t("철회 목록을 새로 서명했어요."));
    });
    else if (b.dataset.revoke) {
      const id = b.dataset.revoke;
      void act(async () => {
        if (!signing) throw new Error("store-key-not-connected");
        const ok = await confirmBox(t("이 기기를 끊을까요?"), `${t("끊으면 그 기기는 바로 멈춰요.")}\n${t("남은 기기에는 새 열쇠를 나눠 줘요. 확인은 한 번만 하면 돼요.")}\n${t("이미 복사된 지난 데이터는 되돌릴 수 없어요.")}`);
        if (!ok) return;
        const r = await disconnectFor(state, withReason(signing, REASON_REVOKE), disconnect, id, now());
        state = r.state; store.save(state);
        say(() => r.rotated
          ? t("기기를 끊고 새 열쇠로 바꿨어요. 남은 기기는 같은 와이파이에서 앱을 열면 새 열쇠를 받아요. 이미 복사된 지난 데이터는 되돌릴 수 없어요.")
          : t("기기를 끊었어요. 이미 복사된 지난 데이터는 되돌릴 수 없어요. 기기끼리 나눈 열쇠는 아직 없어서 바꿀 것이 없어요."));
      });
    }
  });
  void refreshKey();
  return {
    enter() { state = store.load(); void refreshKey(); void lpRefreshStatus(); },
    /** 시험·연결용: 새 기기가 확인된 때를 적는다. */
    markSeen(deviceId: string, at: number) { state = { ...state, lastSeen: { ...state.lastSeen, [deviceId]: at } }; store.save(state); paint(); },
    state: () => state,
  };
}
