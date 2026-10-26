/* 자산 파일 보관 화면의 지연 묶음 이음매 (0.8.8a).
 *
 * 왜 지연인가: main 묶음이 메모리 예산(가장 큰 묶음 ≤ 1000KB, scripts/memory-budget.json)에 거의 닿아 있어서
 * 이 화면의 코드·문구·스타일(≈ 60KB)을 시작 묶음에 더할 수 없다. 자산 화면이 처음 그려질 때 한 번 읽는다.
 *
 * 읽는 동안(몇 십 ms)은 이전과 같은 최소 표시만 한다 — 상태 글자만, 단추 없음. 다 읽으면 줄을 다시 그린다.
 * 🔴 읽기에 실패해도 화면은 죽지 않는다(dynamic 조각 실패 = 페이지 사망 사고 이력): 경고만 남기고 최소 표시로 남는다.
 */
import { t } from "./i18n";
import type { AssetKeep, KeepAsset, KeepDeps } from "./asset-keep";

export type KeepApi = Omit<AssetKeep, "_state">;

export function createLazyKeep(deps: KeepDeps): KeepApi {
  let real: AssetKeep | null = null;
  let loading: Promise<AssetKeep | null> | null = null;
  const load = (): Promise<AssetKeep | null> => {
    if (!loading) {
      loading = import("./asset-keep")
        .then(async (m) => {
          const k = m.createAssetKeep(deps);
          await k.onLoaded(); // 내 뜻(보관 설정)을 읽은 뒤에 첫 그림 — 받은 파일 질문이 번쩍이지 않게
          real = k;
          deps.renderList();
          return k;
        })
        .catch((e) => { console.warn("asset-keep load failed", e); return null; });
    }
    return loading;
  };
  const plain = (a: KeepAsset): string => {
    void load();
    if (!a.ipfs_hash) return `<span class="muted">${t("파일 없음")}</span>`;
    if (deps.isFingerprint(a.ipfs_hash)) return `<span class="muted">${t("원본 지문")}</span>`;
    return deps.getPinned().has(a.ipfs_hash) ? `<span class="ok">${t("보관 중")}</span>` : `<span class="muted">${t("확인 안 됨")}</span>`;
  };
  const later = <A extends unknown[]>(run: (k: AssetKeep, ...a: A) => unknown) => (...a: A) => { if (real) return run(real, ...a); void load().then((k) => k && run(k, ...a)); };
  return {
    summary: () => (real ? real.summary() : (void load(), t("불러오는 중…"))),
    badgeHtml: (a) => (real ? real.badgeHtml(a) : plain(a)),
    actHtml: (a) => (real ? real.actHtml(a) : ""),
    afterRender: () => { if (real) real.afterRender(); },
    paintBulk: (btn) => { if (real) real.paintBulk(btn); else { btn.disabled = true; btn.textContent = t("불러오는 중…"); } },
    // 처음에는 load() 가 보관 설정을 읽는다. 자산을 다시 불러올 때마다는 읽은 구현이 새로 읽는다.
    onLoaded: async () => { if (real) await real.onLoaded(); else await load(); },
    bulkKeep: async (list) => { const k = await load(); await k?.bulkKeep(list); },
    bindOnce: () => { if (real) real.bindOnce(); },
    keepFromPanel: later((k, cid: string) => k.keepFromPanel(cid)),
    unkeepFromPanel: later((k, cid: string) => k.unkeepFromPanel(cid)),
    openVerify: later((k, a: KeepAsset) => k.openVerify(a)),
    paintPanel: (a) => { if (real) real.paintPanel(a); else if (a) void load().then((k) => k?.paintPanel(a)); },
    recheckCid: (cid) => (real ? real.recheckCid(cid) : deps.health.get(cid) !== "found"),
    stamp: (cid) => { if (real) real.stamp(cid); },
    scanEnded: (stopped) => { if (real) real.scanEnded(stopped); },
    acceptsDrop: () => (real ? real.acceptsDrop() : false),
    handleDrop: async (paths) => { const k = await load(); await k?.handleDrop(paths); },
  };
}
