import { atomsToRvn, rvnToAtoms } from '../core/creator/bytes';
import { kindSearchPattern } from '../core/creator/asset-name';
import { CONTENT_TYPES, CONTENT_TYPE_IDS, type ContentType } from '../core/creator/limits';
import { discoverListings, type ChainAsset, type CreatorAllowlist, type CreatorDenylist, type Listing } from '../core/creator/listing';
import type { BookSection, MusicSection, TicketSection, GameSection, DigitalSection } from '../core/creator/manifest';
import type { MarketLists } from './market-lists';
import { BOND_BLOCKER_SAY, BONDED_WARNING, BOND_SAY, OPEN_MARKET_SALES_ENABLED, autoCheck, purchaseSummary, type AutoCheck } from '../core/creator/open-market';
import { MARKET_FEE_ADDRESS, bpsPercent, estimateHeight, heightDateKo, manifestFeeRef, marketRate, type FeeSchedule } from '../core/creator/fee-schedule';
import { PAYMENT_ALLOWLIST_ONLY } from '../core/creator/mainnet-switches';
import { paymentGate } from '../core/creator/payment-allowlist';
import { purchasePlan } from '../core/creator/purchase-plan';
import * as T from './market-copy';
import { LOCK_COPY } from './lock-ui';

/*
 * 데스크탑 「열린 장터(시험)」 — 구매자 최소 화면: 목록 → 상세(미리듣기·미리보기) → 구매 확인(수수료 분리 금액) → 내 구매 목록.
 *
 * 🔴 지금 이 화면은 **시험 전용**이다(판매자 기능 뒤에 숨김):
 *   · 0.9.2: 노드 「RV.*」(종류 탭은 「RV.M.*」 등 — kindSearchPattern) 목록과 이 컴퓨터 IPFS 읽기는 market-node.ts 어댑터가 deps.source 로 넣는다(없으면 「목록을 읽는 기능이 아직 없어요」).
 *   · 판매 스위치(OPEN_MARKET_SALES_ENABLED = core/creator/mainnet-switch.json)가 꺼져 있으면 결제 단추는 확인 화면까지만 가고 잠긴다. 시험만 salesEnabled·buy·purchase 를 주입한다.
 *   · 1단계 제한(verifiedOnly): 서명된 허용 목록(검증됨)에 있는 상품만 결제한다. 허용 목록이 비어 있으면(출하 상태) 아무 것도 결제되지 않는다.
 *   · 결제 = deps.purchase.prepare(거래만 만듦, 돈 안 나감) → 확인 화면에 받는 곳·금액·네트워크 수수료 → 사람이 「승인하고 보내기」 → deps.purchase.send. 승인 없이는 send 를 부르지 않는다.
 *     거래 조립·서명은 러스트(market.rs)와 노드가 한다. 지갑 저장소 purchase.ts 는 복사하지 않았다(아래 「지갑 레인 과제」).
 * 판정(검증됨·보증·미검증·숨김)은 전부 core/creator/listing.ts — 여기서 다시 판단하지 않는다.
 */

export type MarketSource = {
  /** pattern = listassets 검색어. 종류 탭이 kindSearchPattern 으로 만든다(「RV.*」 전체, 「RV.M.*」 음악…). */
  assets(pattern: string): Promise<ChainAsset[]>;
  fetch(cid: string): Promise<Uint8Array | null>;
  allowlist?: CreatorAllowlist | null; denylist?: CreatorDenylist | null;
};
export type BuyRequest = { asset: string; sellerAddress: string; priceAtoms: string; sellerAtoms: string; feeAtoms: string; feeBps: number; tier: 'bonded' | 'verified';
  /** 검증됨(허용 목록) 상품의 메모 번호. 보증(b)층은 지갑 예약값을 쓴다. */
  gameIndex?: number };
/** 결제 기록. 🔴 구매자는 자산을 받지 않는다 — assetReceived 는 늘 false 로 남긴다(사실 기록). */
export type Purchase = { asset: string; title: string; txid: string; sellerRvn: string; feeRvn: string; at: string;
  manifestCid?: string; sellerAddress?: string; feeBps?: number; tier?: 'bonded' | 'verified'; networkFeeRvn?: string; memoScript?: string; ownerId?: string; chain?: string; assetReceived?: false };
export type PreparedOutput = { role: 'seller' | 'fee' | 'memo' | 'change'; address: string | null; atoms: string };
/** 노드가 만든 뒤 다시 검사한 거래 요약(돈은 아직 안 나갔다). */
export type Prepared = { id: string; asset: string; outputs: PreparedOutput[]; networkFeeAtoms: string; totalAtoms: string; sellerAtoms: string; feeAtoms: string; chain: string; memoScript: string; ownerId: string };
export type MarketPurchaseDeps = {
  prepare(r: BuyRequest): Promise<Prepared>;
  /** 사람이 「승인하고 보내기」를 누른 뒤에만 불린다. */
  send(p: Prepared): Promise<{ txid: string }>;
  cancel(): void;
};
export type MarketDeps = {
  back: () => void; source?: MarketSource | null; now?: () => number; storage?: Storage | null;
  /** 서명된 최신 허용·차단 목록(market-lists.ts). 있으면 source.allowlist/denylist 보다 앞선다 — 목록을 다시 그릴 때마다 지금 것을 읽는다. */
  lists?: MarketLists | null;
  /** 장터 수수료 일정. 기본 = lists 의 서명된 일정(market-lists.ts). 없으면 구매 확인이 「일정을 아직 받지 못했어요」로 잠긴다. */
  feeSchedule?: () => FeeSchedule | null;
  /** 체인 팁 높이(요율은 팁 + 1 에서). 없으면 일정 시작 시각으로 어림(「예상」 표시 — 실제 구매 거래는 지갑이 체인 높이로 다시 계산). */
  chainHeight?: () => number | null;
  /** 시험만: 판매 스위치를 대신 켜고, 구매 거래를 모의로 만든다. */
  salesEnabled?: boolean; buy?: (r: BuyRequest) => Promise<{ txid: string }>;
  /** 실제 구매 길(준비 → 승인 → 전송). 있으면 buy 보다 앞선다. 판매 스위치가 켜져 있을 때만 쓰인다. */
  purchase?: MarketPurchaseDeps | null;
  /** 체인 팁 높이를 새로 읽는다(요율은 팁 + 1 에서 정해진다). 읽으면 chainHeight 보다 앞선다. */
  tip?: () => Promise<number | null>;
  /** 1단계 제한: true 면 서명된 허용 목록(검증됨)에 있는 상품만 결제한다. 기본 = mainnet-switch.json 의 verifiedOnly(커밋 기본 true). */
  verifiedOnly?: boolean;
  /** 신고 메일 열기(mailto). 없으면 복사로 대신한다. */
  openExternal?: (url: string) => void | Promise<void>;
  /** 구매한 암호화 상품의 열람 요청·허가·열기(lock-ui.ts wireLockBuyer). 없으면 결제 기록에 열람 단추가 없다. */
  lockBuyer?: { open(p: Purchase): void | Promise<void> } | null;
};
export const HIDDEN_KEY = 'rv-market-hidden-v1';
export const PURCHASES_KEY = 'rv-market-purchases-v1';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function list(target: HTMLElement, items: string[], cls = '') {
  target.replaceChildren(...items.map(text => { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; return li; }));
}
function facts(target: HTMLElement, rows: Array<[string, string]>) {
  target.replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; return [dt, dd]; }));
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
type Shown = Exclude<Listing, { status: 'hidden' }>;

export function wireOpenMarket(deps: MarketDeps) {
  const store = (() => { try { return deps.storage === undefined ? window.localStorage : deps.storage; } catch { return null; } })();
  const now = () => deps.now?.() ?? Date.now();
  const salesOn = deps.salesEnabled ?? OPEN_MARKET_SALES_ENABLED;
  const verifiedOnly = deps.verifiedOnly ?? PAYMENT_ALLOWLIST_ONLY;
  let lastTip: number | null = null, confirmSeq = 0, prepared: Prepared | null = null;
  /** 이 상품을 결제해도 되나(1단계 제한까지 합쳐서). 이유는 화면에 그대로 보인다. */
  const payGate = (l: Shown): { ok: boolean; say: string } => {
    // 판정은 지갑 core 의 paymentGate 한 곳(checkCreatorPurchase 와 같은 함수) — 화면이 따로 만든 규칙이 아니다.
    const gate = paymentGate(l, verifiedOnly);
    if (gate.ok) return { ok: true, say: '' };
    if (gate.reason === 'not-on-payment-allowlist') {
      const anyVerified = (deps.lists?.current().allowlist ?? deps.source?.allowlist ?? null)?.entries?.length;
      return { ok: false, say: anyVerified ? T.VERIFIED_ONLY_NOT_LISTED : T.VERIFIED_ONLY_EMPTY };
    }
    return { ok: false, say: '이 상품은 지금 지갑으로 결제할 수 없어요.' };
  };
  const hiddenSet = (): Set<string> => { try { const a = JSON.parse(store?.getItem(HIDDEN_KEY) ?? '[]'); return new Set(Array.isArray(a) ? a.filter((x: unknown) => typeof x === 'string') : []); } catch { return new Set(); } };
  const saveHidden = (h: Set<string>) => { try { store?.setItem(HIDDEN_KEY, JSON.stringify([...h].slice(-500))); } catch { /* 저장 못 하면 이번 화면에서만 숨는다 */ } };
  const checks = new Map<string, AutoCheck>();
  const blobs: string[] = [];
  let listings: Shown[] = [], current: Shown | null = null, busy = false, kind: ContentType | null = null;

  /** 이 상품의 지금 요율(서명된 일정 · 체인 높이 + 1). 못 정하면 bps null 과 이유 한 줄. */
  function rateOf(l: Shown): { bps: number; say: string } | { bps: null; say: string } {
    const schedule = deps.feeSchedule?.() ?? deps.lists?.current().feeSchedule ?? null;
    if (!schedule) return { bps: null, say: '수수료 일정을 아직 받지 못했어요 → 서명된 수수료 일정을 받기 전에는 살 수 없어요.' };
    if (!l.manifest.price) return { bps: null, say: '무료 상품이에요.' };
    const ceiling = l.status === 'verified' ? l.entry.feeBps : null;
    const ref = manifestFeeRef(l.manifest.fee, ceiling);
    if (!ref.ok || ref.scheduleId !== schedule.scheduleId) return { bps: null, say: '이 상품의 수수료 칸이 레이븐볼트 수수료 일정과 맞지 않아요 → 살 수 없어요.' };
    const tip = deps.chainHeight?.() ?? lastTip;
    const height = (tip ?? estimateHeight(schedule, now())) + 1;
    try {
      const r = marketRate({ schedule, kind: l.manifest.type, seller: { address: l.manifest.creator.address, receivingAddress: l.manifest.creator.receivingAddress }, height, priceAtoms: l.manifest.price.atoms, ceilingBps: ceiling });
      const est = tip === null ? '(예상)' : '';
      return { bps: r.bps, say: `지금 수수료 ${bpsPercent(r.bps)}%${est}${r.nextChange ? ` → ${heightDateKo(schedule, r.nextChange.height)} 무렵${est}(블록 ${r.nextChange.height})부터 ${bpsPercent(r.nextChange.bps)}%` : ''}. 기간은 체인 블록 높이로 정해요.` };
    } catch (e) {
      const c = (e as { code?: string }).code;
      return { bps: null, say: c === 'before-launch' ? `장터 시작 전이에요 → ${heightDateKo(schedule, schedule.launch.height)} 무렵(블록 ${schedule.launch.height})부터 살 수 있어요.`
        : c === 'cap-range' ? '가격이 너무 커서 수수료 상한(500 RVN) 안에서 나눌 수 없어요 → 살 수 없어요.' : '수수료를 계산하지 못했어요 → 살 수 없어요.' };
    }
  }

  /* 종류 탭: 전체 + 다섯 종류. 탭마다 체인 검색어가 다르다(이름의 종류 글자). */
  function paintTabs() {
    el('mk-tabs').replaceChildren(...([null, ...CONTENT_TYPE_IDS] as Array<ContentType | null>).map(k => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.kind = k ?? 'all';
      b.textContent = k ? CONTENT_TYPES[k].label : '전체';
      b.title = `찾는 이름: ${kindSearchPattern(k)}`;
      b.setAttribute('aria-pressed', String(kind === k));
      b.onclick = () => { if (kind !== k) { kind = k; paintTabs(); void load(); } };
      return b;
    }));
  }

  el('mk-note').textContent = `시험 화면이에요. 「검증됨」은 레이븐볼트가 검토한 판매자, 「보증 · 미검증」은 자동 점검과 보증만 통과한 판매자, 「미검증」은 외부 링크로만 볼 수 있어요. 판매(구매 결제)는 ${salesOn ? '시험용으로 켜져' : '아직 꺼져'} 있어요.`;
  const readPurchases = (): Purchase[] => { try { const a: unknown = JSON.parse(store?.getItem(PURCHASES_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((x): x is Purchase => !!x && typeof x === 'object' && !Array.isArray(x)) : []; } catch { return []; } };
  function paintPurchases() {
    const p = readPurchases();
    const text = (x: Purchase) => `${x.title} · ${x.asset} · 판매자 ${x.sellerRvn} RVN + 수수료 ${x.feeRvn} RVN${x.networkFeeRvn ? ` + 네트워크 ${x.networkFeeRvn} RVN` : ''} · 거래 ${x.txid.slice(0, 12)}… · 자산은 받지 않았어요(기록만)`;
    if (!deps.lockBuyer) { list(el('mk-purchases'), p.length ? p.map(text) : [T.PURCHASES_EMPTY]); return; }
    const buyer = deps.lockBuyer;
    el('mk-purchases').replaceChildren(...(p.length ? p.map(x => {
      const li = document.createElement('li'); li.textContent = text(x);
      if (x.manifestCid) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost mk-open-lock'; b.textContent = '열람하기'; b.onclick = () => void buyer.open(x); li.append(' ', b); }
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: T.PURCHASES_EMPTY })]));
  }
  function view(which: 'list' | 'detail' | 'confirm') {
    el('mk-list-view').hidden = which !== 'list'; el('mk-detail').hidden = which !== 'detail'; el('mk-confirm').hidden = which !== 'confirm';
  }
  const badgeClass = (l: Shown) => 'mk-badge ' + (l.status === 'verified' ? 'ok' : l.status === 'bonded' ? 'bond' : 'none');

  /* 지금 쓰는 목록 한 줄 + 「목록 새로 받기」(받는 길이 있을 때만). 실패해도 마지막으로 검증된 목록 그대로. */
  function paintListsSay(extra = '') {
    const say = document.getElementById('mk-lists-say');
    if (say) say.textContent = deps.lists ? deps.lists.current().say + (extra ? ' ' + extra : '') : '';
  }
  const refreshBtn = document.getElementById('mk-lists-refresh') as HTMLButtonElement | null;
  if (refreshBtn) {
    refreshBtn.hidden = !deps.lists?.refresh;
    refreshBtn.onclick = async () => {
      if (!deps.lists?.refresh || refreshBtn.disabled) return;
      refreshBtn.disabled = true; paintListsSay('새 목록을 받는 중…');
      let extra = '';
      try {
        const out = await deps.lists.refresh();
        extra = out.applied ? (out.changed ? '새 목록을 적용했어요.' : '바뀐 것이 없어요.')
          : `새 목록을 적용하지 않았어요(${out.tried.map(t => t.reason).join(', ') || '받을 곳 없음'}) → 지금 목록을 그대로 써요.`;
      } catch { extra = '새 목록을 받지 못했어요 → 지금 목록을 그대로 써요.'; }
      refreshBtn.disabled = false;
      await load();
      paintListsSay(extra);
    };
  }

  function paintHidden() {
    const n = hiddenSet().size, say = document.getElementById('mk-hidden-say'), btn = document.getElementById('mk-hidden-reset');
    if (say) say.textContent = n ? T.HIDDEN_SAY(n) : '';
    if (btn) btn.hidden = n === 0;
  }
  const hiddenReset = document.getElementById('mk-hidden-reset');
  if (hiddenReset) hiddenReset.onclick = () => { saveHidden(new Set()); void load(); };

  async function load() {
    view('list'); el('mk-list-say').textContent = '불러오는 중…';
    if (!deps.source) { el('mk-list').replaceChildren(); el('mk-list-say').textContent = '장터 목록을 읽는 기능이 아직 없어요(다음 단계: 노드 자산 목록·IPFS 읽기 연결).'; return; }
    try {
      if (deps.tip) lastTip = await deps.tip().catch(() => null);
      const assets = await deps.source.assets(kindSearchPattern(kind));
      const signed = deps.lists?.current() ?? null;
      paintListsSay();
      listings = await discoverListings({ assets, fetchManifest: c => deps.source!.fetch(c), allowlist: signed ? signed.allowlist : deps.source.allowlist ?? null,
        denylist: signed ? signed.denylist : deps.source.denylist ?? null,
        autoChecks: checks, now: now(), type: kind }) as Shown[];
      const hid = hiddenSet();
      listings = listings.filter(l => !hid.has(l.asset));
      paintHidden();
    } catch (e) { el('mk-list-say').textContent = `목록을 못 읽었어요(${String((e as Error)?.message ?? e)}) → 노드가 켜져 있는지 확인하고 다시 열어 주세요.`; return; }
    el('mk-list').replaceChildren(...listings.map(l => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mk-item'; b.dataset.asset = l.asset;
      const badge = document.createElement('span'); badge.className = badgeClass(l); badge.textContent = l.badge;
      const title = document.createElement('b'); title.textContent = l.manifest.title;
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = `${CONTENT_TYPES[l.manifest.type].label} · ${l.manifest.price ? atomsToRvn(l.manifest.price.atoms) + ' RVN' : '무료'} · ${l.asset}${l.lookalikes.length ? ' · 비슷한 이름 있음' : ''}`;
      b.append(badge, title, meta);
      b.onclick = () => detail(l);
      li.append(b); return li;
    }));
    el('mk-list-say').textContent = listings.length ? `${kind ? CONTENT_TYPES[kind].label + ' ' : ''}${listings.length}개` : kind ? `아직 올라온 ${CONTENT_TYPES[kind].label} 상품이 없어요.` : '아직 올라온 상품이 없어요.';
  }

  function previewBox(l: Shown) {
    const box = el('mk-d-preview'); box.replaceChildren();
    for (const u of blobs.splice(0)) URL.revokeObjectURL(u);
    if (l.access === 'external-link-only') {
      const p = document.createElement('p'); p.className = 'meta';
      p.textContent = `지갑 안에서 열지 않아요. 외부에서 보려면: ipfs://${l.manifestCid}`;
      box.append(p); return;
    }
    const files = (l as { _bytes?: Map<string, Uint8Array> })._bytes;
    if (!files) return;
    const blob = (path: string, mime: string) => { const b = files.get(path); if (!b) return null; const u = URL.createObjectURL(new Blob([b.slice().buffer as ArrayBuffer], { type: mime })); blobs.push(u); return u; };
    const m = l.manifest;
    if (m.type === 'music') {
      const d = m.details as MusicSection;
      if (d.previewFile === null || d.previewStartMs === null || d.previewEndMs === null) {
        const p = document.createElement('p'); p.className = 'meta'; p.textContent = '이 상품은 미리듣기가 없어요.'; box.append(p);
      } else {
        const f = m.files.find(x => x.path === d.previewFile)!, from = d.previewStartMs, to = d.previewEndMs;
        const u = blob(f.path, f.mime); if (!u) return;
        const audio = document.createElement('audio'); audio.controls = true; audio.src = u; audio.id = 'mk-d-audio';
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = from / 1000; });
        audio.addEventListener('timeupdate', () => { if (audio.currentTime * 1000 >= to) audio.pause(); });
        const p = document.createElement('p'); p.className = 'meta';
        p.textContent = m.lock ? `미리듣기 ${Math.round((to - from) / 1000)}초 — 따로 잘라 만든 짧은 파일이에요` : `미리듣기 ${Math.round(from / 1000)}초~${Math.round(to / 1000)}초 (옛 형식: 곡 전체가 공개 IPFS 에 있어요)`;
        box.append(p, audio);
      }
    } else if (m.type === 'book') {
      const d = m.details as BookSection;
      if (d.previewFile) {
        const u = blob(d.previewFile, 'application/pdf'); if (!u) return;
        const a = document.createElement('a'); a.href = u; a.download = d.previewFile; a.textContent = `미리보기 ${d.previewPages}쪽 받기(PDF)`; a.id = 'mk-d-book-preview';
        box.append(a);
      }
    }
    if (m.cover) {
      const u = blob(m.cover.path, m.cover.mime);
      if (u) { const img = document.createElement('img'); img.src = u; img.alt = `${m.title} 표지`; img.className = 'mk-cover'; box.prepend(img); }
    }
  }

  function detail(l: Shown) {
    current = l; view('detail');
    const m = l.manifest;
    const badge = el('mk-d-badge'); badge.className = badgeClass(l); badge.textContent = l.badge;
    el('mk-d-kind').textContent = CONTENT_TYPES[m.type].label;
    el('mk-d-title').textContent = m.title; el('mk-d-desc').textContent = m.description;
    el('mk-d-warning').textContent = l.status === 'verified' ? '레이븐볼트가 검토한 판매자예요. 그래도 환불·배송 책임은 판매자에게 있어요.'
      : l.status === 'bonded' ? `${BONDED_WARNING} ${BOND_SAY}`
      : `검토하지 않은 판매자예요. 지갑 결제·로그인이 연결되지 않고 외부 링크로만 볼 수 있어요.${l.bondBlockers.length ? ' 이유: ' + l.bondBlockers.map(b => BOND_BLOCKER_SAY[b]).join(' ') : ''}`;
    const alerts: string[] = [];
    if (l.lookalikes.length) alerts.push(`비슷한 이름의 상품이 있어요(${l.lookalikes.join(', ')}). 사칭일 수 있으니 판매자 주소를 꼭 확인하세요.`);
    if (l.officialLooking && l.status !== 'verified') alerts.push('「공식」처럼 보이는 이름이지만 레이븐볼트 공식 상품이 아니에요.');
    if (l.autoCheck?.warnings.length) alerts.push(...l.autoCheck.warnings.map(w => '주의 · ' + w));
    list(el('mk-d-alerts'), alerts, 'creator-warn');
    const rows: Array<[string, string]> = [['상품 등록증 이름', l.asset], ['가격', m.price ? `${atomsToRvn(m.price.atoms)} RVN` : '무료'], ['판매자 주소', m.creator.address], ['받는 주소', m.creator.receivingAddress]];
    if (m.type === 'ticket') {
      const t = m.details as TicketSection;
      rows.push(['행사', t.eventName], ['일시', `${when(t.startsAt)}${t.endsAt ? ' ~ ' + when(t.endsAt) : ''}`], ['장소', t.venue], ['수량', `${t.quantity}장`], ['환불 규정', t.refundPolicy], ['연락처', t.contact],
        ['입장 확인', '결제 뒤 판매자가 서명한 입장 코드(QR)를 보내 줘요. 재판매·환불·행사 취소 책임은 판매자에게 있어요.']);
    } else if (m.type === 'book') {
      const b = m.details as BookSection;
      rows.push(['형식', b.format.toUpperCase()], ['미리보기', b.previewFile ? `${b.previewPages}쪽` : '없음'], ['전체 쪽수', b.pageCount ? `${b.pageCount}쪽` : '모름']);
    } else if (m.type === 'music') {
      const d = m.details as MusicSection;
      rows.push(['미리듣기', d.previewFile === null || d.previewStartMs === null || d.previewEndMs === null ? '없음' : m.lock ? `${Math.round((d.previewEndMs - d.previewStartMs) / 1000)}초(따로 잘라 만든 파일)` : `${Math.round(d.previewStartMs / 1000)}~${Math.round(d.previewEndMs / 1000)}초(곡 전체가 공개 IPFS 에 있어요)`]);
    } else if (m.type === 'game') {
      const g = m.details as GameSection; rows.push(['외부 링크', g.origin ?? '없음']);
    } else rows.push(['종류', (m.details as DigitalSection).label]);
    rows.push(['파일', m.lock ? `${m.files.length}개 · ${LOCK_COPY.buyerFileFact}` : `${m.files.length}개 · 구매해도 파일은 공개 IPFS 에 있어요(잠금 없음)`]);
    facts(el('mk-d-facts'), rows);
    previewBox(l);
    el('mk-d-check').hidden = l.status === 'verified' && !!l.autoCheck;
    el('mk-d-check-say').textContent = l.autoCheck ? `자동 점검: ${l.autoCheck.status === 'fail' ? '통과 못 함 — ' + l.autoCheck.problems[0] : l.autoCheck.status === 'warn' ? '통과(주의 있음)' : '통과'}` : '';
    const buy = el<HTMLButtonElement>('mk-d-buy');
    const gate = payGate(l);
    buy.disabled = !gate.ok;
    el('mk-d-buy-say').textContent = gate.ok ? (salesOn ? '' : '결제 내용까지 볼 수 있어요. 판매 기능은 아직 꺼져 있어요.') : gate.say;
    const rs = document.getElementById('mk-d-report-say'); if (rs) rs.textContent = '';
    const rn = document.getElementById('mk-d-report-note'); if (rn) rn.textContent = `${T.REPORT_NOTE} ${T.HIDE_NOTE}`;
  }

  /* 신고(메일) · 내 목록에서 숨기기 — 처리 정책은 대표 결정 전이라 문구는 자리표시다. */
  const reportBody = (l: Shown) => [`상품 등록증 이름: ${l.asset}`, `상품 정보 주소(CID): ${l.manifestCid}`, `판매자 주소: ${l.manifest.creator.address}`, `받는 주소: ${l.manifest.creator.receivingAddress}`,
    `표시: ${l.badge}`, '', '신고 이유(적어 주세요):', ''].join('\n');
  const reportBtn = document.getElementById('mk-d-report');
  if (reportBtn) reportBtn.onclick = async () => {
    if (!current) return;
    const say = document.getElementById('mk-d-report-say')!;
    const url = `mailto:${T.REPORT_CONTACT}?subject=${encodeURIComponent('[열린 장터 신고] ' + current.asset)}&body=${encodeURIComponent(reportBody(current))}`;
    try { if (deps.openExternal) { await deps.openExternal(url); say.textContent = T.REPORT_OPENED; return; } } catch { /* 복사로 */ }
    try { await navigator.clipboard.writeText(`${T.REPORT_CONTACT}\n${reportBody(current)}`); say.textContent = `${T.REPORT_COPIED} ${T.REPORT_CONTACT}`; }
    catch { say.textContent = `${T.REPORT_FAILED} ${T.REPORT_CONTACT}`; }
  };
  const hideBtn = document.getElementById('mk-d-hide');
  if (hideBtn) hideBtn.onclick = () => { if (!current) return; const h = hiddenSet(); h.add(current.asset); saveHidden(h); current = null; void load(); };

  el('mk-d-check').onclick = async () => {
    if (!current || !deps.source || busy) return;
    busy = true; el('mk-d-check-say').textContent = '파일을 받아 점검하는 중…';
    const bytes = new Map<string, Uint8Array>();
    const byCid = new Map<string, string>([...current.manifest.files.map(f => [f.cid, f.path] as [string, string]), ...(current.manifest.cover ? [[current.manifest.cover.cid, current.manifest.cover.path] as [string, string]] : [])]);
    const c = await autoCheck(current.manifest, async cid => { const b = await deps.source!.fetch(cid); if (b) bytes.set(byCid.get(cid) ?? cid, b); return b; });
    checks.set(current.asset, c);
    busy = false;
    await load();
    const again = listings.find(l => l.asset === current!.asset);
    if (again) { (again as { _bytes?: Map<string, Uint8Array> })._bytes = c.status === 'fail' ? undefined : bytes; detail(again); }
  };
  const clearPrepared = () => { if (prepared) deps.purchase?.cancel(); prepared = null; };
  const payBtn = () => el<HTMLButtonElement>('mk-c-pay');
  const buyRequest = (l: Shown, s: NonNullable<ReturnType<typeof purchaseSummary>>): BuyRequest => ({ asset: l.asset, sellerAddress: l.manifest.creator.receivingAddress, priceAtoms: l.manifest.price!.atoms,
    sellerAtoms: rvnToAtoms(s.sellerRvn)!, feeAtoms: rvnToAtoms(s.feeRvn)!, feeBps: s.feeBps, tier: l.status === 'verified' ? 'verified' : 'bonded',
    ...(l.status === 'verified' ? { gameIndex: l.entry.gameIndex } : {}) });
  /** 준비된 거래가 화면에 보인 약속(판매자 몫·수수료·받는 주소)과 정확히 같은가. 어긋나면 사유 한 줄. */
  function preparedMismatch(l: Shown, r: BuyRequest, p: Prepared): string | null {
    const out = (role: PreparedOutput['role']) => p.outputs.filter(o => o.role === role);
    const [sellerOut, feeOut] = [out('seller'), out('fee')];
    if (p.asset !== l.asset) return '준비된 거래의 상품이 달라요.';
    // 화면에 보인 금액·메모가 지갑 core 의 구매 계획(purchasePlan, 러스트 검사와 같은 공유 벡터)과 같은지 먼저 본다.
    let plan: ReturnType<typeof purchasePlan>;
    try { plan = purchasePlan({ priceAtoms: r.priceAtoms, feeBps: r.feeBps, sellerAddress: r.sellerAddress, feeAddress: MARKET_FEE_ADDRESS, memoScript: p.memoScript }); }
    catch { return '준비된 거래를 수수료 규칙과 맞춰 볼 수 없어요.'; }
    if (plan.sellerAtoms !== r.sellerAtoms || plan.feeAtoms !== r.feeAtoms) return '화면에 보인 금액이 수수료 규칙과 달라요.';
    if (sellerOut.length !== 1 || sellerOut[0].address !== r.sellerAddress || sellerOut[0].atoms !== r.sellerAtoms || p.sellerAtoms !== r.sellerAtoms) return '준비된 거래의 판매자 몫이 화면과 달라요.';
    if (r.feeAtoms === '0' ? feeOut.length !== 0 : feeOut.length !== 1 || feeOut[0].address !== MARKET_FEE_ADDRESS || feeOut[0].atoms !== r.feeAtoms || p.feeAtoms !== r.feeAtoms) return '준비된 거래의 수수료가 화면과 달라요.';
    if (out('memo').length !== 1) return '준비된 거래에 기록(메모)이 없어요.';
    return null;
  }
  function paintPrepared(p: Prepared) {
    const rows: string[] = [];
    for (const o of p.outputs) {
      if (o.role === 'seller') rows.push(`판매자 받는 주소 ${o.address} ← ${atomsToRvn(o.atoms)} RVN`);
      else if (o.role === 'fee') rows.push(`레이븐볼트 수수료 주소 ${o.address} ← ${atomsToRvn(o.atoms)} RVN`);
      else if (o.role === 'memo') rows.push('체인 기록(메모) — 0 RVN. 이 계정이 이 상품 값을 냈다는 표시만 남아요.');
      else rows.push(`거스름 ${atomsToRvn(o.atoms)} RVN 은 내 지갑으로 돌아와요(${o.address}).`);
    }
    if (!p.outputs.some(o => o.role === 'fee')) rows.push('수수료 출력 없음(수수료 0%) — 기록(메모)만 남아요.');
    rows.push(`네트워크 수수료 약 ${atomsToRvn(p.networkFeeAtoms)} RVN`, `내 지갑에서 나가는 돈(거스름 제외) ${atomsToRvn(p.totalAtoms)} RVN`);
    list(el('mk-c-outputs'), rows);
  }
  el('mk-d-buy').onclick = async () => {
    if (!current?.payment || !current.manifest.price) return;
    const l = current, seq = ++confirmSeq;
    clearPrepared();
    if (deps.tip) lastTip = await deps.tip().catch(() => null);
    if (seq !== confirmSeq) return;
    const rate = rateOf(l);
    const s = rate.bps === null ? null : purchaseSummary(l.manifest, rate.bps);
    view('confirm');
    list(el('mk-c-lines'), [`${l.manifest.title} (${l.asset})`, ...(s ? s.lines : [`가격 ${atomsToRvn(l.manifest.price!.atoms)} RVN`]), rate.say]);
    list(el('mk-c-facts'), [...(l.manifest.lock ? T.MARKET_FACTS_LOCKED : T.MARKET_FACTS)]);
    list(el('mk-c-outputs'), []);
    el('mk-c-note').textContent = '판매자 몫은 판매자 받는 주소로 바로, 수수료는 레이븐볼트 수수료 주소로 — 한 거래 안에서 지갑이 나눠요. 레이븐볼트가 돈을 맡지 않아요.' +
      (l.status === 'bonded' ? ' ' + BONDED_WARNING : '');
    const gate = payGate(l);
    const blockers = salesOn ? [] : ['판매 기능이 아직 꺼져 있어요(대표 결정 대기). 지금은 결제할 수 없어요.'];
    if (!gate.ok) blockers.push(gate.say);
    if (!s) blockers.push(rate.say);
    if (salesOn && !deps.purchase && !deps.buy) blockers.push('이 데스크탑은 아직 결제 거래를 만들 수 없어요(지갑 연결 전).');
    list(el('mk-c-blockers'), blockers, 'creator-bad');
    payBtn().disabled = true; el('mk-c-say').textContent = '';
    if (blockers.length > 0 || !s) return;
    if (deps.purchase) {
      // 거래를 만들기만 한다(서명·전파 없음). 사람이 받는 곳·금액을 보고 승인해야 한 번 더 부른다.
      el('mk-c-say').textContent = T.PREPARING; busy = true;
      try {
        const req = buyRequest(l, s);
        const p = await deps.purchase.prepare(req);
        if (seq !== confirmSeq) { deps.purchase.cancel(); return; }
        const bad = preparedMismatch(l, req, p);
        if (bad) { deps.purchase.cancel(); list(el('mk-c-blockers'), [`${bad} → 보내지 않았어요. 돈은 나가지 않았어요.`], 'creator-bad'); el('mk-c-say').textContent = ''; return; }
        prepared = p; paintPrepared(p); el('mk-c-note').textContent += ' ' + T.PREPARED_NOTE;
        el('mk-c-say').textContent = ''; payBtn().disabled = false;
      } catch (e) {
        if (seq === confirmSeq) { list(el('mk-c-blockers'), [`거래를 만들지 못했어요(${String((e as Error)?.message ?? e)}) → 돈은 나가지 않았어요.`], 'creator-bad'); el('mk-c-say').textContent = ''; }
      } finally { busy = false; }
    } else payBtn().disabled = false;
  };
  payBtn().onclick = async () => {
    const l = current;
    if (!l || (!deps.buy && !deps.purchase) || !salesOn || busy || !l.manifest.price || !payGate(l).ok) return;
    const rate = rateOf(l);
    if (rate.bps === null) return;
    const s = purchaseSummary(l.manifest, rate.bps)!;
    const req = buyRequest(l, s);
    if (deps.purchase && !prepared) return; // 준비·확인 없이는 보내지 않는다
    busy = true; payBtn().disabled = true; el('mk-c-say').textContent = '보내는 중…';
    try {
      const p0 = prepared;
      const r = deps.purchase && p0 ? await deps.purchase.send(p0) : await deps.buy!(req);
      prepared = null;
      const rec: Purchase = { asset: l.asset, title: l.manifest.title, txid: r.txid, sellerRvn: s.sellerRvn, feeRvn: s.feeRvn, at: new Date(now()).toISOString(),
        manifestCid: l.manifestCid, sellerAddress: req.sellerAddress, feeBps: s.feeBps, tier: req.tier, assetReceived: false,
        ...(p0 ? { networkFeeRvn: atomsToRvn(p0.networkFeeAtoms), memoScript: p0.memoScript, ownerId: p0.ownerId, chain: p0.chain } : {}) };
      try { store?.setItem(PURCHASES_KEY, JSON.stringify([rec, ...readPurchases()].slice(0, 500))); } catch { /* 저장 못 해도 거래는 체인에 있다 */ }
      paintPurchases(); el('mk-c-say').textContent = T.PAID_SAY;
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (m.startsWith('SENT_UNKNOWN')) { prepared = null; el('mk-c-say').textContent = T.SENT_UNKNOWN_SAY; }
      else { el('mk-c-say').textContent = `보내지 못했어요(${m}) → 잔액을 확인하고 확인 화면부터 다시 해 주세요.`; if (!deps.purchase) payBtn().disabled = false; }
    }
    finally { busy = false; }
  };
  el('mk-c-cancel').onclick = () => { confirmSeq++; clearPrepared(); if (current) detail(current); };
  el('mk-d-back').onclick = () => view('list');
  el('market-back').onclick = deps.back;
  paintPurchases(); paintTabs();
  return { load };
}
