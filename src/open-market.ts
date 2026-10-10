import { atomsToRvn, rvnToAtoms } from '../core/creator/bytes';
import { kindSearchPattern } from '../core/creator/asset-name';
import { CONTENT_TYPES, CONTENT_TYPE_IDS, type ContentType } from '../core/creator/limits';
import { discoverListings, type ChainAsset, type CreatorAllowlist, type CreatorDenylist, type Listing } from '../core/creator/listing';
import type { BookSection, MusicSection, TicketSection, GameSection, DigitalSection } from '../core/creator/manifest';
import type { MarketLists } from './market-lists';
import { BOND_BLOCKER_SAY, BONDED_WARNING, BOND_SAY, OPEN_MARKET_SALES_ENABLED, autoCheck, purchaseSummary, type AutoCheck } from '../core/creator/open-market';
import { bpsPercent, estimateHeight, heightDateKo, manifestFeeRef, marketRate, type FeeSchedule } from '../core/creator/fee-schedule';

/*
 * 데스크탑 「열린 장터(시험)」 — 구매자 최소 화면: 목록 → 상세(미리듣기·미리보기) → 구매 확인(수수료 분리 금액) → 내 구매 목록.
 *
 * 🔴 지금 이 화면은 **시험 전용**이다(판매자 기능 뒤에 숨김):
 *   · 노드에서 「RV.*」(종류 탭은 「RV.M.*」 등 — kindSearchPattern) 자산 목록과 IPFS 파일을 읽는 데스크탑 명령이 아직 없다 → source 를 주입하지 않으면 「목록을 읽는 기능이 아직 없어요」.
 *   · 판매 스위치(OPEN_MARKET_SALES_ENABLED)가 꺼져 있어 구매 단추는 확인 화면까지만 가고 잠긴다. 시험만 salesEnabled·buy 를 주입한다.
 *   · 실제 구매 거래(판매자 몫 + 수수료 출력 + 메모)는 지갑 저장소 core/creator/purchase.ts + 기존 v4 부품이 만들고 시험한다(데스크탑은 아직 연결 안 함).
 * 판정(검증됨·보증·미검증·숨김)은 전부 core/creator/listing.ts — 여기서 다시 판단하지 않는다.
 */

export type MarketSource = {
  /** pattern = listassets 검색어. 종류 탭이 kindSearchPattern 으로 만든다(「RV.*」 전체, 「RV.M.*」 음악…). */
  assets(pattern: string): Promise<ChainAsset[]>;
  fetch(cid: string): Promise<Uint8Array | null>;
  allowlist?: CreatorAllowlist | null; denylist?: CreatorDenylist | null;
};
export type BuyRequest = { asset: string; sellerAddress: string; priceAtoms: string; sellerAtoms: string; feeAtoms: string; feeBps: number; tier: 'bonded' | 'verified' };
export type Purchase = { asset: string; title: string; txid: string; sellerRvn: string; feeRvn: string; at: string };
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
};
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
    const tip = deps.chainHeight?.() ?? null;
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
  const readPurchases = (): Purchase[] => { try { return JSON.parse(store?.getItem(PURCHASES_KEY) ?? '[]') as Purchase[]; } catch { return []; } };
  function paintPurchases() {
    const p = readPurchases();
    list(el('mk-purchases'), p.length ? p.map(x => `${x.title} · ${x.asset} · 판매자 ${x.sellerRvn} RVN + 수수료 ${x.feeRvn} RVN · 거래 ${x.txid.slice(0, 12)}…`) : ['아직 산 것이 없어요.']);
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

  async function load() {
    view('list'); el('mk-list-say').textContent = '불러오는 중…';
    if (!deps.source) { el('mk-list').replaceChildren(); el('mk-list-say').textContent = '장터 목록을 읽는 기능이 아직 없어요(다음 단계: 노드 자산 목록·IPFS 읽기 연결).'; return; }
    try {
      const assets = await deps.source.assets(kindSearchPattern(kind));
      const signed = deps.lists?.current() ?? null;
      paintListsSay();
      listings = await discoverListings({ assets, fetchManifest: c => deps.source!.fetch(c), allowlist: signed ? signed.allowlist : deps.source.allowlist ?? null,
        denylist: signed ? signed.denylist : deps.source.denylist ?? null,
        autoChecks: checks, now: now(), type: kind }) as Shown[];
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
      const d = m.details as MusicSection, f = m.files.find(x => x.path === d.previewFile)!;
      const u = blob(f.path, f.mime); if (!u) return;
      const audio = document.createElement('audio'); audio.controls = true; audio.src = u; audio.id = 'mk-d-audio';
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = d.previewStartMs / 1000; });
      audio.addEventListener('timeupdate', () => { if (audio.currentTime * 1000 >= d.previewEndMs) audio.pause(); });
      const p = document.createElement('p'); p.className = 'meta'; p.textContent = `미리듣기 ${Math.round(d.previewStartMs / 1000)}초~${Math.round(d.previewEndMs / 1000)}초`;
      box.append(p, audio);
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
      const d = m.details as MusicSection; rows.push(['미리듣기', `${Math.round(d.previewStartMs / 1000)}~${Math.round(d.previewEndMs / 1000)}초`]);
    } else if (m.type === 'game') {
      const g = m.details as GameSection; rows.push(['외부 링크', g.origin ?? '없음']);
    } else rows.push(['종류', (m.details as DigitalSection).label]);
    rows.push(['파일', `${m.files.length}개 · 구매해도 파일은 공개 IPFS 에 있어요(잠금 없음)`]);
    facts(el('mk-d-facts'), rows);
    previewBox(l);
    el('mk-d-check').hidden = l.status === 'verified' && !!l.autoCheck;
    el('mk-d-check-say').textContent = l.autoCheck ? `자동 점검: ${l.autoCheck.status === 'fail' ? '통과 못 함 — ' + l.autoCheck.problems[0] : l.autoCheck.status === 'warn' ? '통과(주의 있음)' : '통과'}` : '';
    const buy = el<HTMLButtonElement>('mk-d-buy');
    buy.disabled = !l.payment;
    el('mk-d-buy-say').textContent = l.payment ? (salesOn ? '' : '구매 확인 화면까지 볼 수 있어요. 판매 기능은 아직 꺼져 있어요.') : '이 상품은 지금 지갑으로 살 수 없어요.';
  }

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
  el('mk-d-buy').onclick = () => {
    if (!current?.payment) return;
    const rate = rateOf(current);
    const s = rate.bps === null ? null : purchaseSummary(current.manifest, rate.bps);
    if (!current.manifest.price) return;
    view('confirm');
    list(el('mk-c-lines'), [`${current.manifest.title} (${current.asset})`, ...(s ? s.lines : [`가격 ${atomsToRvn(current.manifest.price.atoms)} RVN`]), rate.say]);
    el('mk-c-note').textContent = '판매자 몫은 판매자 받는 주소로 바로, 수수료는 레이븐볼트 수수료 주소로 — 한 거래 안에서 지갑이 나눠요. 레이븐볼트가 돈을 맡지 않아요.' +
      (current.status === 'bonded' ? ' ' + BONDED_WARNING : '');
    const blockers = salesOn ? [] : ['판매 기능이 아직 꺼져 있어요(대표 결정 대기). 지금은 살 수 없어요.'];
    if (!s) blockers.push(rate.say);
    if (salesOn && !deps.buy) blockers.push('이 데스크탑은 아직 구매 거래를 만들 수 없어요(지갑 연결 전).');
    list(el('mk-c-blockers'), blockers, 'creator-bad');
    el<HTMLButtonElement>('mk-c-pay').disabled = blockers.length > 0;
    el('mk-c-say').textContent = '';
  };
  el('mk-c-pay').onclick = async () => {
    if (!current || !deps.buy || !salesOn || busy || !current.manifest.price) return;
    const rate = rateOf(current);
    if (rate.bps === null) return;
    const s = purchaseSummary(current.manifest, rate.bps)!;
    busy = true; el<HTMLButtonElement>('mk-c-pay').disabled = true; el('mk-c-say').textContent = '보내는 중…';
    try {
      const r = await deps.buy({ asset: current.asset, sellerAddress: current.manifest.creator.receivingAddress, priceAtoms: current.manifest.price.atoms,
        sellerAtoms: rvnToAtoms(s.sellerRvn)!, feeAtoms: rvnToAtoms(s.feeRvn)!, feeBps: s.feeBps, tier: current.status === 'verified' ? 'verified' : 'bonded' });
      const p: Purchase = { asset: current.asset, title: current.manifest.title, txid: r.txid, sellerRvn: s.sellerRvn, feeRvn: s.feeRvn, at: new Date(now()).toISOString() };
      try { store?.setItem(PURCHASES_KEY, JSON.stringify([p, ...readPurchases()].slice(0, 500))); } catch { /* 저장 못 해도 거래는 체인에 있다 */ }
      paintPurchases(); el('mk-c-say').textContent = '샀어요. 내 구매 목록에 넣었어요.';
    } catch (e) { el('mk-c-say').textContent = `사지 못했어요(${String((e as Error)?.message ?? e)}) → 잔액을 확인하고 다시 해 주세요.`; el<HTMLButtonElement>('mk-c-pay').disabled = false; }
    finally { busy = false; }
  };
  el('mk-c-cancel').onclick = () => { if (current) detail(current); };
  el('mk-d-back').onclick = () => view('list');
  el('market-back').onclick = deps.back;
  paintPurchases(); paintTabs();
  return { load };
}
