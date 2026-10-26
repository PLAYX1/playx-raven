// 헤드리스 시험용 가짜 화면: main.ts 의 자산 목록이 하는 일(줄 그리기 · 일괄 보관 단추 · 패널)을 흉내 내고 asset-keep.ts 를 그대로 올린다.
// 가짜 Tauri(invoke)만 있다 — 노드·지갑·IPFS 는 실행하지 않는다.
import { createLazyKeep } from '../../src/asset-keep-lazy';

type A = { name: string; ipfs_hash: string | null; mine: boolean; amount: number };
export type Cfg = { assets: A[]; pinned: string[]; fingerprints: string[]; health: Record<string, 'found' | 'missing'> };

(window as any).__boot = (cfg: Cfg) => {
  const calls: Array<[string, any]> = (window as any).__calls = [];
  const fx = (window as any).__fx = { alive: {} as Record<string, boolean>, decisions: {} as Record<string, string>, verify: null as any, verifyFile: null as any, pinFail: new Set<string>(), repo: { used_bytes: 3.2e9, max_bytes: 15e9 } };
  const assets = new Map<string, A>(cfg.assets.map((a) => [a.name, a]));
  const health = new Map<string, any>(Object.entries(cfg.health));
  let pinned = new Set<string>(cfg.pinned);
  const prints = new Set(cfg.fingerprints);
  let selected: string | null = null;
  const invoke = async (cmd: string, args?: any) => {
    calls.push([cmd, JSON.parse(JSON.stringify(args ?? null))]);
    switch (cmd) {
      case 'asset_keep_state': return { auto_mine: true, migrated: true, damaged: false, decisions: fx.decisions };
      case 'asset_keep_set': for (const c of args.cids) { if (args.decision === 'clear') delete fx.decisions[c]; else fx.decisions[c] = args.decision; } return { auto_mine: true, migrated: true, damaged: false, decisions: fx.decisions };
      case 'cid_alive': return fx.alive[args.cid] ?? false;
      case 'pin_add': if (fx.pinFail.has(args.cid)) throw new Error('pin failed'); pinned = new Set(pinned).add(args.cid); return true;
      case 'pin_remove': { const s = new Set(pinned); s.delete(args.cid); pinned = s; return true; }
      case 'pin_list': return [...pinned];
      case 'ipfs_status': return { running: true, peers: 4 };
      case 'repo_size': return { ...fx.repo, objects: 1 };
      case 'asset_verify': return fx.verify;
      case 'asset_verify_file': return fx.verifyFile;
      default: return null;
    }
  };
  const keep = createLazyKeep({
    invoke: invoke as any, assets: assets as any, health,
    getPinned: () => pinned, setPinned: (s) => { pinned = s; }, isFingerprint: (c) => !!c && prints.has(c),
    renderList: () => renderList(), getSelected: () => selected, select: (n) => { selected = selected === n ? null : n; renderList(); renderPanel(); },
    errText: (e) => String((e as any)?.message ?? e), verifyLink: (n) => 'https://example.test/verify/?a=' + encodeURIComponent(n),
    openUrl: async (u) => { calls.push(['openUrl', u]); }, showSettings: () => { calls.push(['showSettings', null]); },
    saveHealth: () => {}, startScan: () => { calls.push(['startScan', null]); }, scanRunning: () => false,
  });
  function renderList() {
    document.getElementById('summary')!.textContent = keep.summary();
    keep.paintBulk(document.getElementById('pin-all') as HTMLButtonElement);
    document.getElementById('assets')!.innerHTML = [...assets.values()].map((a) =>
      `<tr data-row="${a.name}" class="${selected === a.name ? 'sel' : ''}"><td class="name"><span translate="no">${a.name}</span></td><td class="num">${a.amount}</td><td class="keepcell">${keep.badgeHtml(a)}</td><td class="act">${keep.actHtml(a)}</td></tr>`).join('');
    document.querySelectorAll<HTMLElement>('[data-row]').forEach((tr) => { tr.onclick = (e) => { if ((e.target as HTMLElement).closest('button')) return; (window as any).__rowClicked = tr.dataset.row; keep.paintPanel(null); selected = tr.dataset.row!; renderPanel(); }; });
    keep.bindOnce();
    keep.afterRender();
  }
  function renderPanel() {
    const a = selected ? assets.get(selected) ?? null : null;
    document.getElementById('panel')!.className = a ? 'panel' : 'panel hidden';
    document.getElementById('p-name')!.textContent = a?.name ?? '';
    keep.paintPanel(a);
  }
  document.getElementById('pin-all')!.addEventListener('click', () => void keep.bulkKeep());
  document.addEventListener('drop-files-test', ((e: CustomEvent) => { void (async () => { if (keep.acceptsDrop()) await keep.handleDrop(e.detail); })(); }) as any);
  (window as any).__keep = keep;
  void keep.onLoaded().then(() => renderList());
};
