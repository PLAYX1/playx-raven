/*
 * 마주 공동구매 — 데스크탑 쪽 자료·규칙(화면과 무관, 시험 가능). (2026-11-16)
 *
 * 폰·웹 원본: 지갑 저장소 phone/screens/majuSession.ts · phone/ui/maju-pay.ts. **문구·규칙을 그대로 옮겼다**(번역 열쇠가 같게).
 *   · 서버는 마주 함수 maju-rv. 데스크탑은 CSP 때문에 러스트 명령 `maju_call`(src-tauri/src/maju.rs)로 부른다.
 *   · 값·남은 수·보내는 날은 서버가 준 것만. 공급자 이름·공급가는 서버가 보내지 않는다(여기서도 받지 않는다).
 *   · 결제 대조는 러스트 `maju_pay` 가 다시 한다(받는 곳 목록·수수료 주소·1% 나누기). 여기 checkMajuPayTo 는 확인 칸을 그리기 전 같은 검사.
 *   · 이 컴퓨터에 남기는 것(폰과 같은 이름): 시험 스위치 · 내 주문 번호와 주문 표 · 마지막 받는 분 정보. 지갑 단어·암호와 섞이지 않는다.
 */

export type MajuRound = { id: string; no: number; goal: number; buyers: number; left: number; opensAt: number; closesAt: number; shipOn: string };
export type MajuProduct = {
  id: string; title: string; line: string; photoUrl: string | null;
  priceWon: number; shippingWon: number; priceRvnAtoms: string | null;
  left: number; storage: string; shipLine: string; shipByDate: string; test: boolean;
  open?: boolean; sellUntil?: number; round?: MajuRound;
};
export type MajuList = { seller: string; payReady: boolean; holdMinutes: number; qtyMax: number; ask: { phone: string | null }; products: MajuProduct[] };
export type MajuQuote = { qty: number; unitWon: number; itemsWon: number; shippingWon: number; totalWon: number; test: boolean; rvnAtoms: string | null };
export type MajuPayTo = { address: string; sellerAtoms: string; feeAddress: string; feeAtoms: string; totalAtoms: string };
export type MajuReservation = { reservationId: string; secret: string; expiresAt: number; quote: MajuQuote; payTo: MajuPayTo | null };
export type MajuShip = { name: string; phone: string; address: string; zip?: string; memo?: string };
export type MajuShipSaved = MajuShip & { road?: string; detail?: string };
export type MajuTracking = { carrier: string | null; trackingNumber: string | null; carrierName?: string | null; trackingUrl?: string | null };
export type MajuConfirmed = { orderId: string; orderToken: string; shortNo: string; status: string; step: number; totalWon: number; seller: string };
export type MajuAfter = {
  thread: { from: "me" | "maju" | "maker"; who: string; text: string; at: number }[];
  canReceive: boolean; canProblem: boolean; canPraise: boolean;
  praise: { tags: string[]; line: string } | null;
  problemSent: boolean; praiseTags: string[]; problemReasons: string[];
};
export type MajuOrderView = {
  orderId: string; shortNo: string; seller: string; title: string; qty: number; totalWon: number; test: boolean;
  status: string; step: number; paidAt: number; shippedAt: number | null; deliveredAt: number | null;
  ask: { phone: string | null }; after?: MajuAfter;
} & MajuTracking;
export type SavedMajuOrder = { orderId: string; token: string; title: string; shortNo: string; at: number; test: boolean };

export class MajuError extends Error {
  constructor(public code: string, public detail?: string, public status = 0) { super(code); }
}

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;
/** main.ts 가 한 번 끼운다(시험은 가짜를). */
export function bindMajuInvoke(next: Invoke): void { invokeFn = next; }

async function call<T>(method: "GET" | "POST", path: string, o: { query?: Record<string, string>; body?: unknown; token?: string } = {}): Promise<T> {
  if (!invokeFn) throw new MajuError("network");
  let r: { status: number; body: any };
  try {
    r = await invokeFn("maju_call", { method, path, query: o.query ?? null, body: o.body ?? null, token: o.token ?? null });
  } catch { throw new MajuError("network"); }
  const json = r?.body;
  const ok = r && r.status >= 200 && r.status < 300;
  if (!ok || !json || typeof json !== "object" || json.error) throw new MajuError(json?.error ?? "server", json?.detail, r?.status ?? 0);
  return json as T;
}

export const loadMajuProducts = (test: boolean) => call<MajuList>("GET", "/products", { query: test ? { test: "1" } : {} });
export const reserveMaju = (productId: string, qty: number, address: string) => call<MajuReservation>("POST", "/reserve", { body: { productId, qty, address } });
export const confirmMaju = (r: Pick<MajuReservation, "reservationId" | "secret">, ship: MajuShip, consent: MajuConsent, txid: string | null = null) =>
  call<MajuConfirmed>("POST", "/confirm", { body: { reservationId: r.reservationId, secret: r.secret, ship, consent, txid } });
export const releaseMaju = (r: Pick<MajuReservation, "reservationId" | "secret">) => call<{ released: boolean }>("POST", "/release", { body: { reservationId: r.reservationId, secret: r.secret } });
export const loadMajuOrder = (o: Pick<SavedMajuOrder, "orderId" | "token">) => call<MajuOrderView>("GET", `/order/${o.orderId}`, { token: o.token });
type Owned = Pick<SavedMajuOrder, "orderId" | "token">;
export const majuReceived = (o: Owned) => call<{ ok: true }>("POST", `/order/${o.orderId}/received`, { token: o.token, body: {} });
export const majuAsk = (o: Owned, text: string) => call<{ ok: true }>("POST", `/order/${o.orderId}/ask`, { token: o.token, body: { text } });
export const majuProblem = (o: Owned, reason: string, text: string) => call<{ ok: true }>("POST", `/order/${o.orderId}/problem`, { token: o.token, body: { reason, text } });
export const majuPraise = (o: Owned, tags: string[], line: string) => call<{ ok: true }>("POST", `/order/${o.orderId}/praise`, { token: o.token, body: { tags, line } });
export type MajuAddressHit = { zip: string; road: string; jibun: string; building: string };
export const searchMajuAddress = (q: string, page = 1) =>
  call<{ ready: boolean; hits: MajuAddressHit[]; total: number; page?: number }>("GET", "/address", { query: { q, page: String(page) } });

/** 화면에 보일 말(우리말 원문 — t() 가 바꾼다). 폰 majuErrorText 와 한 글자도 다르지 않게. */
export function majuErrorText(e: unknown): string {
  const code = e instanceof MajuError ? e.code : "network", detail = e instanceof MajuError ? e.detail : undefined;
  if (code === "bad-input" && detail === "ask") return "두 글자 넘게, 500자 안으로 적어 주세요";
  if (code === "rate-limit" && detail === "ask") return "오늘은 많이 물어보셨어요. PLAY X 장터가 답하면 여기에 보여요";
  if (code === "state" && detail === "already") return "이미 남겼어요";
  if (code === "state" && (detail === "not-shipped" || detail === "not-yet")) return "아직 그 단계가 아니에요. 「새로 보기」를 눌러 주세요";
  if (code === "sold-out" && detail === "not-enough") return "남은 수량보다 많아요. 수량을 줄여 주세요";
  if (code === "sold-out") return "다 팔렸어요";
  if (code === "hold-limit") return "지금은 다른 분들이 사는 중이에요. 잠시 뒤 다시 해 주세요";
  if (code === "rate-limit") return "너무 자주 눌렀어요. 10분 뒤 다시 해 주세요";
  if (code === "not-on-sale") return "지금은 팔지 않는 상품이에요";
  if (code === "state" && detail === "expired") return "잡아 둔 15분이 지났어요. 다시 해 주세요";
  if (code === "state" && detail === "rvn-pay-not-ready") return "RVN 결제는 아직 준비 중이에요";
  if (code === "state" && detail === "already-confirmed") return "이미 주문했어요. 보관함의 주문에서 볼 수 있어요";
  if (code === "state" && detail === "rvn-not-seen") return "보낸 RVN 이 아직 장부에 안 보여요. 잠시 뒤 「주문 다시 확인」을 눌러 주세요. 다시 보내지 마세요";
  if (code === "state" && detail === "rvn-not-verified") return "보낸 거래가 이 주문 값과 맞지 않아요. PLAY X 장터에 연락해 주세요";
  if (code === "state" && detail === "paid-late") return "15분이 지나 RVN 이 도착했어요. 돈은 PLAY X 장터가 확인하고 연락드릴게요";
  if (code === "state" && detail === "txid-used") return "이미 다른 주문에 쓴 거래예요";
  if (code === "bad-input" && detail === "phone") return "연락처는 휴대폰 번호(010-1234-5678)로 넣어 주세요";
  if (code === "bad-input" && detail === "zip") return "우편번호를 다시 확인해 주세요";
  if (code === "bad-input" && (detail === "name" || detail === "address" || detail === "ship")) return "받는 분 이름·연락처·주소를 다시 확인해 주세요";
  if (code === "agree-required") return "개인정보 수집·이용·제공에 동의해 주세요";
  if (code === "unavailable" && detail === "juso") return "주소 찾기를 지금 쓸 수 없어요. 주소를 직접 써 주세요";
  if (code === "rate-limit" && detail === "address") return "주소 찾기를 너무 자주 했어요. 1분 뒤 다시 해 주세요";
  if (code === "bad-input" && detail === "q") return "도로명·건물 이름을 두 글자 넘게 넣어 주세요";
  if (code === "bad-code") return "주문 찾기 코드가 맞지 않아요";
  return "PLAY X 장터에 닿지 못했어요. 잠시 뒤 다시 해 주세요";
}

// ── 결제 대조(폰 checkMajuPayTo 와 같은 규칙 — 러스트 maju_pay 가 다시 본다) ──
export const MAJU_PAY_TO: readonly string[] = ["RQD1AgwcS5DGDGnYBKXnjuJZpvUw52rMSt"];
export const MARKET_FEE_ADDRESS = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
export type MajuPayment = { address: string; sellerSats: number; feeAddress: string; feeSats: number; priceSats: number };
/** 지갑 splitPrice(100 bps) 와 같은 규칙: 수수료 올림 · 먼지 한계 1000. */
export function splitMaju(price: number): { seller: number; fee: number } {
  let fee = Math.ceil((price * 100) / 10_000);
  if (fee < 1000) fee = 1000;
  const seller = price - fee;
  if (!Number.isSafeInteger(price) || price < 1 || seller < 1000) throw new Error("bad-price");
  return { seller, fee };
}
export function checkMajuPayTo(payTo: unknown, quoteAtoms: string | null): MajuPayment {
  const p = payTo as MajuPayTo | null;
  const bad = (): never => { throw new Error("받는 곳이 확인되지 않아 보내지 않았어요."); };
  const sats = (v: unknown): number => (typeof v === "string" && /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : bad());
  if (!p || typeof p !== "object") return bad();
  if (!MAJU_PAY_TO.includes(p.address)) return bad();
  if (p.feeAddress !== MARKET_FEE_ADDRESS || p.address === MARKET_FEE_ADDRESS) return bad();
  const priceSats = sats(p.totalAtoms), sellerSats = sats(p.sellerAtoms), feeSats = sats(p.feeAtoms);
  if (quoteAtoms !== p.totalAtoms) return bad();
  let s: { seller: number; fee: number };
  try { s = splitMaju(priceSats); } catch { return bad(); }
  if (s.seller !== sellerSats || s.fee !== feeSats || sellerSats + feeSats !== priceSats) return bad();
  return { address: p.address, sellerSats, feeAddress: p.feeAddress, feeSats, priceSats };
}

// ── 받는 곳 ──
export const MAJU_PRIVACY_VERSION = "rv-privacy-2026-11-13";
export type MajuConsent = { privacy: true; thirdParty: true; age14: true; version: string };
export const majuConsent = (): MajuConsent => ({ privacy: true, thirdParty: true, age14: true, version: MAJU_PRIVACY_VERSION });
/** 마주 engine/rv-ship.ts rvConsentLines 와 한 글자도 다르지 않게(서버가 같은 글을 기록에 남긴다). */
export const MAJU_PRIVACY_LINES = [
  "개인정보 수집·이용: 받는 분 이름·연락처·주소(배송 메모 포함) · 상품 배송과 교환·반품, 주문 문의에만 써요 · 주문이 되면 전자상거래법에 따라 5년(문의·분쟁 기록 3년) 보관한 뒤 지워요. 참여를 취소했거나 공동구매가 성사되지 않으면 90일 안에 지워요",
  "제3자 제공: 보내 주실 「생산·공급자」에 받는 분 이름·연락처·주소(배송 부탁 포함)를 드려요 · 상품 배송과 교환·반품에만 써요 · 배송·교환·반품이 끝날 때까지 보관해요",
  "만 14세 이상이에요",
] as const;
export const MAJU_RETURN_LINES = [
  "마음이 바뀌어 반품하면 돌려보내는 택배비는 손님이 내요. 처음 배송비는 돌려드리지 않아요",
  "신선식품은 시간이 지나 다시 팔 수 없으면 마음이 바뀐 반품이 안 될 수 있어요",
  "상했거나 깨졌거나 다른 상품이 왔으면 택배비 없이 바꾸거나 돌려드려요",
] as const;
/** 11-16 대표 — 폰 MAJU_DOMESTIC_ONLY 와 같은 글. */
export const MAJU_DOMESTIC_ONLY = "한국 안에서만 받을 수 있어요 · 해외 배송은 안 돼요";
export const MAJU_SELLER_LINE = "PLAY X 장터 공동구매 · 확인된 판매처";

export function majuPhone(raw: string): string | null {
  let d = raw.replace(/[^0-9+]/g, "");
  if (d.startsWith("+82")) d = "0" + d.slice(3);
  d = d.replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}
export type MajuShipDraft = { name: string; phone: string; zip: string; road: string; detail: string; manual: string; memo: string };
export type MajuShipField = "name" | "phone" | "address";
export function majuShipFromDraft(d: MajuShipDraft): { ok: true; ship: MajuShip; saved: MajuShipSaved } | { ok: false; field: MajuShipField } {
  const name = d.name.trim();
  if (!name || name.length > 40) return { ok: false, field: "name" };
  const phone = majuPhone(d.phone);
  if (!phone) return { ok: false, field: "phone" };
  const found = /^\d{5}$/.test(d.zip) && d.road.trim().length > 0;
  const detail = d.detail.replace(/\s+/g, " ").trim();
  const address = found ? [d.road.trim(), detail].filter(Boolean).join(" ") : d.manual.replace(/\s+/g, " ").trim();
  if (address.length < 8 || address.length > 300) return { ok: false, field: "address" };
  const memo = d.memo.trim();
  const ship: MajuShip = { name, phone, address, ...(found ? { zip: d.zip } : {}), ...(memo ? { memo } : {}) };
  return { ok: true, ship, saved: { ...ship, ...(found ? { road: d.road.trim(), detail } : {}) } };
}
export function majuDraftFromSaved(v: MajuShipSaved | null): MajuShipDraft {
  if (!v) return { name: "", phone: "", zip: "", road: "", detail: "", manual: "", memo: "" };
  const found = !!v.zip && !!v.road;
  return { name: v.name, phone: v.phone, zip: found ? v.zip! : "", road: found ? v.road! : "", detail: found ? v.detail ?? "" : "", manual: found ? "" : v.address, memo: v.memo ?? "" };
}
export function parseShip(raw: string | null): MajuShipSaved | null {
  try {
    const v = JSON.parse(raw ?? "");
    if (!v || typeof v.name !== "string" || typeof v.phone !== "string" || typeof v.address !== "string") return null;
    const out: MajuShipSaved = { name: v.name, phone: v.phone, address: v.address, memo: typeof v.memo === "string" ? v.memo : undefined };
    if (typeof v.zip === "string" && /^\d{5}$/.test(v.zip) && typeof v.road === "string" && v.road) { out.zip = v.zip; out.road = v.road; out.detail = typeof v.detail === "string" ? v.detail : ""; }
    return out;
  } catch { return null; }
}

// ── 이 컴퓨터에 남기는 것(폰과 같은 이름) ──
export const MAJU_TEST_KEY = "ravenvault.maju.test.v1", MAJU_ORDERS_KEY = "ravenvault.maju.orders.v1", MAJU_SHIP_KEY = "ravenvault.maju.ship.v1";
export function readPref(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function writePref(key: string, v: string): void { try { localStorage.setItem(key, v); } catch { /* 없어도 된다 */ } }
export const majuTestOn = () => readPref(MAJU_TEST_KEY) === "true";
export function parseSavedOrders(raw: string | null): SavedMajuOrder[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(o => o && typeof o.orderId === "string" && typeof o.token === "string" && typeof o.title === "string").slice(0, 50)
      .map(o => ({ orderId: o.orderId, token: o.token, title: o.title, shortNo: String(o.shortNo ?? ""), at: Number(o.at) || 0, test: !!o.test }));
  } catch { return []; }
}
export function addSavedOrder(list: readonly SavedMajuOrder[], o: SavedMajuOrder): SavedMajuOrder[] {
  return [o, ...list.filter(x => x.orderId !== o.orderId)].slice(0, 50);
}

// ── 배송 조회(폰 MAJU_CARRIERS 와 같은 표) ──
export const MAJU_CARRIERS: Record<string, { name: string; track?: string; home: string }> = {
  cj: { name: "CJ대한통운", track: "https://trace.cjlogistics.com/next/tracking.html?wblNo=", home: "https://www.cjlogistics.com/" },
  epost: { name: "우체국택배", track: "https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=", home: "https://service.epost.go.kr/" },
  hanjin: { name: "한진택배", track: "https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&wblnum=", home: "https://www.hanjin.com/" },
  lotte: { name: "롯데택배", track: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=", home: "https://www.lotteglogis.com/" },
  logen: { name: "로젠택배", track: "https://www.ilogen.com/web/personal/trace/", home: "https://www.ilogen.com/" },
  kdexp: { name: "경동택배", home: "https://kdexp.com/" },
};
export function majuSafeTrackingUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("https://") || url.length > 300) return null;
  return Object.values(MAJU_CARRIERS).some(c => url.startsWith(c.home) || (c.track && url.startsWith(c.track))) ? url : null;
}
export function majuTracking(t: MajuTracking): { name: string; number: string; url: string | null } | null {
  if (!t.trackingNumber) return null;
  const c = t.carrier ? MAJU_CARRIERS[t.carrier] : undefined;
  const okNumber = /^[0-9A-Za-z-]{6,30}$/.test(t.trackingNumber);
  const local = c ? (c.track && okNumber ? c.track + encodeURIComponent(t.trackingNumber) : c.home) : null;
  return { name: t.carrierName ?? c?.name ?? t.carrier ?? "", number: t.trackingNumber, url: majuSafeTrackingUrl(t.trackingUrl) ?? local };
}

// ── 다른 기기에서 한 주문(데스크탑은 주문 코드만 — 회차 참여 코드는 아직) ──
export function majuLookupCode(id: string, token: string): string { return `MJ1.o.${id}.${token}`; }
export function parseMajuOrderCode(raw: string): { id: string; token: string } | null {
  const m = /^MJ1\.o\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,80})$/i.exec(raw.replace(/\s+/g, ""));
  if (!m || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[1])) return null;
  return { id: m[1].toLowerCase(), token: m[2] };
}

/** 진행 막대 단계(서버 rvStep): 0 결제 · 1 준비 중 · 2 보냄 · 3 도착 · -1 취소 */
export const MAJU_STEPS = ["결제", "준비 중", "보냄", "도착"] as const;
/** 지금 살 수 있나 — 시험 상품(0원)이거나 서버가 RVN 결제를 열었을 때. */
export const majuOpen = (p: Pick<MajuProduct, "test" | "open">): boolean => p.test || p.open === true;
/** 데스크탑 1차에 보이는 상품 — 회차 공동구매(참여하기)는 아직 폰·웹에서만. */
export const desktopProducts = (list: readonly MajuProduct[]) => list.filter(p => !p.round);

/** atoms 글자 → RVN 글자(소수 끝 0 뺌). */
export function atomsText(atoms: string | number): string {
  const v = BigInt(atoms), whole = v / 100_000_000n, frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
