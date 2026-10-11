/* 자산 파일(IPFS) 보관 화면 (0.8.8a) — 줄 상태·한 번 탭 보관·길게 눌러 해제·일괄 보관·용량·이유 안내·앱 안 확인.
 *
 * ## 설계 (docs/…자산보관-설계안, 대표 결정)
 *  1. 받은 자산의 파일은 자동으로 붙잡지 않는다 — 처음에 묻는다(내가 만든 것은 자동 보관 기본 켜짐).
 *  2. 앱 안에서 「진짜인지 확인」(내 노드가 직접). 웹 확인 페이지는 「확인 주소 복사」 보조로 유지.
 *  3. 줄마다 한 번 탭 = 보관. 해제 = 0.6초 길게 누르기(진행 링) + 마우스·키보드·스크린리더 대안 + 5초 되돌리기.
 *     용어는 「삭제」가 아니라 「보관 해제」 — 이 컴퓨터의 IPFS pin 만 푼다. 사용자 파일은 지우지 않는다.
 *
 * ## 내 뜻은 Rust 가 기억한다 (src-tauri/src/asset_keep.rs)
 * 화면에서 「해제」해도 앱이 30분 뒤 다시 붙잡으면 화면이 거짓말을 한다. 그래서 보관/해제 **직전에**
 * 내 뜻을 먼저 저장하고(asset_keep_set), 그다음 pin_add/pin_remove 를 부른다.
 *
 * main.ts 와의 이음매는 의존성 주입(KeepDeps)뿐이다 — 이 파일은 main.ts 를 import 하지 않는다.
 */
import "./asset-keep.css";
import "./asset-keep-copy";
import { t, tf } from "./i18n";
import {
  HOLD_MS, UNDO_MS, bulkTargets, capacityView, counts, createHold, fileMatchLine, fmtBytes, reasonFor, rowState, shouldRecheck,
  undecidedReceived, verifyLines, clip, type AssetRow, type Decision, type FileMatch, type Health, type Msg, type ReasonAction,
  type RowState, type VerifyResult, type VLine,
} from "./asset-keep-core";

export type KeepAsset = { name: string; ipfs_hash: string | null; mine: boolean };

export type KeepDeps = {
  invoke: <T = any>(cmd: string, args?: any) => Promise<T>;
  assets: Map<string, KeepAsset>;
  health: Map<string, Health>;
  getPinned: () => Set<string>;
  setPinned: (s: Set<string>) => void;
  isFingerprint: (cid: string | null | undefined) => boolean;
  renderList: () => void;
  getSelected: () => string | null;
  select: (name: string) => void;
  errText: (e: unknown) => string;
  verifyLink: (name: string) => string;
  openUrl: (url: string) => Promise<void>;
  showSettings: () => void;
  saveHealth: () => void;
  startScan: () => void;
  scanRunning: () => boolean;
};

type Prefs = { auto_mine: boolean; migrated: boolean; damaged: boolean; decisions: Record<string, Decision> };
type Phase = "finding" | "keeping" | "refinding" | "releasing";

const AT_KEY = "playx-raven-health-at";
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const msgText = (m: Msg): string => {
  if (!m.a?.length) return t(m.k);
  return tf(m.k, ...m.a.map((x) => (typeof x === "object" ? msgText(x) : x)));
};

const LOCK_SVG =
  '<svg class="klock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';

export function createAssetKeep(deps: KeepDeps) {
  let prefs: Prefs = { auto_mine: true, migrated: false, damaged: false, decisions: {} };
  const busy = new Map<string, Phase>();
  const failed = new Map<string, string>();
  const undo = new Map<string, { until: number; name: string }>();
  let undoTick: ReturnType<typeof setInterval> | null = null;
  let checkedAt: Record<string, number> = {};
  let suppressClick = false;
  let lastFocus: string | null = null;
  let capacity: { used: number | null; max: number | null; running: boolean | null; peers: number | null } = { used: null, max: null, running: null, peers: null };
  let bulk = { running: false, done: 0, total: 0, stop: false };
  let includeReceived = false;
  let scanStopped = false;
  let liveText = "";
  const verifyState = new Map<string, { phase: "idle" | "running" | "done" | "error"; result?: VerifyResult; error?: string; file?: VLine; fileBusy?: boolean }>();
  let dropArm: { name: string; until: number } | null = null;

  try { checkedAt = JSON.parse(localStorage.getItem(AT_KEY) || "{}") || {}; } catch { checkedAt = {}; }
  const saveAt = () => { try { localStorage.setItem(AT_KEY, JSON.stringify(checkedAt)); } catch { /* 저장 못 해도 화면은 돈다 */ } };

  /* ── 기본 계산 ───────────────────────────────────────────────── */
  const decisionOf = (cid: string | null): Decision | undefined => (cid ? prefs.decisions[cid] : undefined);
  const healthOf = (cid: string): Health => deps.health.get(cid) ?? "unknown";
  const ownerOf = (cid: string) => [...deps.assets.values()].find((a) => a.ipfs_hash === cid && a.mine);
  const nameOf = (cid: string) => [...deps.assets.values()].find((a) => a.ipfs_hash === cid)?.name ?? cid;

  const toRow = (a: KeepAsset): AssetRow => ({
    name: a.name, cid: a.ipfs_hash, mine: a.mine, fingerprint: deps.isFingerprint(a.ipfs_hash),
    pinned: !!a.ipfs_hash && deps.getPinned().has(a.ipfs_hash), health: a.ipfs_hash ? healthOf(a.ipfs_hash) : "unknown",
    decision: decisionOf(a.ipfs_hash),
  });
  const allRows = () => [...deps.assets.values()].map(toRow);
  const stateOf = (a: KeepAsset): RowState => rowState(toRow(a));

  /* ── 말하기(눈으로도 · 스크린리더로도) ─────────────────────── */
  function announce(msg: string) {
    liveText = msg;
    const el = document.getElementById("keep-live");
    if (el) el.textContent = msg;
  }

  /* ── Rust 와 말하기 ──────────────────────────────────────────── */
  function takePrefs(v: any) {
    if (!v || typeof v !== "object") return;
    prefs = {
      auto_mine: v.auto_mine !== false,
      migrated: v.migrated === true,
      damaged: v.damaged === true,
      decisions: v.decisions && typeof v.decisions === "object" ? (v.decisions as Record<string, Decision>) : {},
    };
  }
  async function refreshPrefs() {
    try { takePrefs(await deps.invoke("asset_keep_state")); }
    catch { /* 못 읽으면 지난 값을 둔다 — 새로 정하는 것은 저장이 실패하면 막힌다 */ }
  }
  async function setDecision(cids: string[], decision: Decision | "clear") {
    takePrefs(await deps.invoke("asset_keep_set", { cids, decision }));
  }

  /* ── 보관 / 해제 ─────────────────────────────────────────────── */
  async function keepCid(cid: string): Promise<"kept" | "reserved" | "failed"> {
    if (busy.has(cid)) return "failed";
    const prev = decisionOf(cid);
    const pinnedNow = deps.getPinned().has(cid);
    const wasMissing = healthOf(cid) === "missing";
    busy.set(cid, pinnedNow || healthOf(cid) === "found" ? "keeping" : wasMissing ? "refinding" : "finding");
    failed.delete(cid);
    undo.delete(cid);
    deps.renderList();
    try {
      // 내 뜻을 먼저 저장 — 저장하지 못하면 보관도 시작하지 않는다.
      await setDecision([cid], "keep");
      if (!pinnedNow && healthOf(cid) !== "found") {
        let alive = false;
        deps.health.set(cid, "checking");
        deps.renderList();
        try { alive = await deps.invoke<boolean>("cid_alive", { cid, timeoutSecs: wasMissing ? 30 : 20 }); } catch { alive = false; }
        deps.health.set(cid, alive ? "found" : "missing");
        checkedAt[cid] = Date.now(); saveAt(); deps.saveHealth();
        if (!alive) {
          busy.delete(cid);
          announce(t("파일을 찾지 못했어요. 보관을 예약했어요 — 그 파일이 다시 나타나면 자동으로 보관해요."));
          deps.renderList();
          return "reserved";
        }
        busy.set(cid, "keeping");
        deps.renderList();
      }
      if (!pinnedNow) await deps.invoke("pin_add", { cid });
      const s = new Set(deps.getPinned()); s.add(cid); deps.setPinned(s);
      busy.delete(cid);
      announce(tf("보관 중: {0}", clip(nameOf(cid), 40)));
      deps.renderList();
      return "kept";
    } catch (e) {
      // 상태는 원래대로 — 실패한 보관을 「예약」으로 남기지 않는다.
      try { await setDecision([cid], prev ?? "clear"); } catch { /* 되돌리지 못하면 다음 새로고침이 바로잡는다 */ }
      busy.delete(cid);
      const why = deps.errText(e);
      failed.set(cid, why);
      announce(t("보관하지 못했어요. 다시 눌러 보세요."));
      deps.renderList();
      return "failed";
    }
  }

  async function unkeepCid(cid: string): Promise<boolean> {
    if (busy.has(cid)) return false;
    const prev = decisionOf(cid);
    busy.set(cid, "releasing");
    deps.renderList();
    try {
      // 먼저 「보관 안 하기」를 저장해야 자동 보관이 다시 붙잡지 못한다.
      await setDecision([cid], "skip");
      await deps.invoke("pin_remove", { cid });
      const s = new Set(deps.getPinned()); s.delete(cid); deps.setPinned(s);
      // 풀었을 뿐 데이터는 다음 정리(GC) 때까지 이 컴퓨터에 남아 있다 — 「찾음」으로 적어 두면 되돌리기가 다시 찾지 않고 바로 붙잡는다.
      deps.health.set(cid, "found"); stamp(cid); deps.saveHealth();
      busy.delete(cid);
      startUndo(cid);
      announce(t("보관을 풀었어요. 5초 안에 되돌릴 수 있어요."));
      deps.renderList();
      return true;
    } catch (e) {
      try { await setDecision([cid], prev ?? "clear"); } catch { /* 위와 같다 */ }
      busy.delete(cid);
      failed.set(cid, deps.errText(e));
      announce(t("보관을 풀지 못했어요."));
      deps.renderList();
      return false;
    }
  }

  function startUndo(cid: string) {
    undo.set(cid, { until: Date.now() + UNDO_MS, name: nameOf(cid) });
    if (undoTick === null) {
      undoTick = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of undo) if (v.until <= now) undo.delete(k);
        if (!undo.size && undoTick !== null) { clearInterval(undoTick); undoTick = null; }
        deps.renderList();
      }, 1000);
    }
  }

  async function undoUnkeep(cid: string) {
    undo.delete(cid);
    const r = await keepCid(cid);
    announce(r === "kept" ? t("되돌렸어요. 다시 보관 중이에요.") : t("되돌리지 못했어요. 「보관」을 다시 눌러 보세요."));
  }

  /** 해제 요청. 내가 만든 자산이거나 길게 누르기가 아니면 안내 창을 거친다. */
  async function requestUnkeep(cid: string, via: "hold" | "menu" | "key" | "panel") {
    if (!deps.getPinned().has(cid) || busy.has(cid)) return;
    const mine = !!ownerOf(cid);
    if (via === "hold" && !mine) { await unkeepCid(cid); return; }
    const name = nameOf(cid);
    const ok = mine
      ? await dialog({
          title: t("이 파일은 내가 만든 자산의 것이에요"),
          body: [
            tf("「{0}」의 파일이에요. 이 컴퓨터가 마지막 사본일 수 있어요.", clip(name, 48)),
            t("풀고 나면 이 파일을 열 수 없게 될 수 있어요. 다른 곳에 사본이 있는지는 알 수 없어요."),
            t("자산 자체와 내 잔액은 그대로입니다."),
          ],
          check: t("마지막 사본일 수 있음을 이해했어요"),
          ok: t("보관 해제"),
          cancel: t("취소"),
          danger: true,
        })
      : await dialog({
          title: t("이 파일의 보관을 풀까요?"),
          body: [t("이 컴퓨터가 더 이상 이 파일을 붙들지 않습니다. 자산 자체나 내 잔액은 그대로입니다."), t("파일은 다른 컴퓨터에 있으면 계속 열립니다. 이 컴퓨터에서는 잠시 뒤 정리될 수 있습니다.")],
          ok: t("보관 해제"),
          cancel: t("취소"),
        });
    if (ok) await unkeepCid(cid);
  }

  /** 줄 배지를 눌렀을 때. */
  async function tap(cid: string, name: string) {
    const a = deps.assets.get(name);
    if (!a) return;
    const st = stateOf(a);
    if (undo.has(cid)) { await undoUnkeep(cid); return; }
    if (busy.has(cid)) return;
    if (st.kind === "kept") { announce(t("보관 중이에요. 보관을 풀려면 길게 누르거나 Delete 키를 누르세요.")); return; }
    if (st.tap === "keep" || st.tap === "find-keep" || st.tap === "retry-keep") await keepCid(cid);
  }

  /* ── 줄 그리기 ───────────────────────────────────────────────── */
  const hold = createHold(
    { now: () => performance.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
    (cid) => { suppressClick = true; void requestUnkeep(cid, "hold"); },
    // 누르기 시작할 때는 줄을 다시 그리지 않는다 — 누르고 있는 단추가 바뀌면 손이 놓친 것처럼 된다. 클래스만 켠다.
    () => {
      const p = hold.pressing();
      if (!p) { deps.renderList(); return; }
      document.querySelectorAll<HTMLElement>(`button.keepbtn[data-keep="${CSS.escape(p.cid)}"]`).forEach((b) => {
        b.classList.add("holding");
        b.style.setProperty("--hold-delay", "0ms");
        const l = b.querySelector(".klabel");
        if (l) l.textContent = t("계속 누르면 해제");
      });
    },
  );

  function badgeHtml(a: KeepAsset): string {
    const cid = a.ipfs_hash;
    const st = stateOf(a);
    if (st.kind === "nofile") return `<span class="muted">${esc(t("파일 없음"))}</span>`;
    if (st.kind === "fingerprint") {
      return `<span class="muted" title="${esc(t("파일 대신 원본 지문만 새겼어요. 올린 파일이 없어서 확인·보존할 것이 없어요."))}">${esc(t("원본 지문"))}</span>`;
    }
    const c = cid!;
    const ph = busy.get(c);
    const u = undo.get(c);
    const pressing = hold.pressing();
    const holding = !!pressing && pressing.cid === c;
    const nm = clip(a.name, 40);
    let kind: string = st.kind;
    let label = t(st.label);
    let aria: string;
    if (u) {
      kind = "undo";
      label = tf("보관 해제됨 · 되돌리기 ({0})", Math.max(1, Math.ceil((u.until - Date.now()) / 1000)));
      aria = tf("{0}, 보관 해제됨. 누르면 되돌려요", nm);
    } else if (ph) {
      kind = "busy";
      label = t(ph === "finding" ? "찾는 중…" : ph === "refinding" ? "다시 찾는 중…" : ph === "releasing" ? "보관 푸는 중…" : "보관하는 중…");
      aria = tf("{0}, {1}", nm, label);
    } else if (holding) {
      label = t("계속 누르면 해제");
      aria = tf("{0}, 보관 해제 중", nm);
    } else if (st.kind === "kept") {
      aria = tf("{0}, 파일 보관 중. 누르면 아무 일 없음. 보관 해제는 길게 누르거나 Delete 키 또는 메뉴", nm);
    } else if (st.kind === "off") {
      aria = tf("{0}, 파일 보관 안 함. 누르면 보관", nm);
    } else if (st.kind === "missing") {
      aria = tf("{0}, 파일을 찾지 못함. 누르면 다시 찾고, 못 찾으면 보관을 예약", nm);
    } else {
      aria = tf("{0}, 파일 확인 안 됨. 누르면 찾아서 보관", nm);
    }
    const pressed = st.kind === "kept" || st.kind === "off" ? ` aria-pressed="${st.kind === "kept"}"` : "";
    const cls = `keepbtn kb-${kind}${st.declined ? " declined" : ""}${holding ? " holding" : ""}${st.reserved ? " reserved" : ""}`;
    const fail = failed.get(c) ? `<span class="kfail" role="status">${esc(t("보관하지 못했어요 · 다시 눌러 보세요"))}</span>` : "";
    return (
      `<button type="button" class="${cls}" data-keep="${esc(c)}" data-kname="${esc(a.name)}" data-kkind="${esc(kind)}"${pressed}` +
      ` aria-label="${esc(aria)}" title="${esc(kind === "kept" ? t("길게 누르면 보관 해제") : label)}"${busy.has(c) ? ' aria-busy="true"' : ""}>` +
      `<span class="kdot" aria-hidden="true"></span><span class="klabel">${esc(label)}</span>${st.declined ? LOCK_SVG : ""}` +
      `<span class="kbar" aria-hidden="true"></span><span class="kring" aria-hidden="true"></span></button>${fail}`
    );
  }

  function actHtml(a: KeepAsset): string {
    const st = stateOf(a);
    if ((st.kind === "unknown" || st.kind === "missing") && !busy.has(a.ipfs_hash!)) {
      return `<button type="button" class="ghost keepq" data-keepq="${esc(a.ipfs_hash)}" data-kname="${esc(a.name)}" aria-label="${esc(tf("{0}, 이유 보기", clip(a.name, 40)))}" title="${esc(t("이유 보기"))}">?</button>`;
    }
    return "";
  }

  /** renderList 가 줄을 새로 그린 직후 부른다 — 길게 누르는 중의 링을 이어 주고, 잃은 포커스를 되돌린다. */
  function afterRender() {
    const p = hold.pressing();
    if (p) {
      const b = document.querySelector<HTMLElement>(`button.keepbtn[data-keep="${CSS.escape(p.cid)}"]`);
      if (b) b.style.setProperty("--hold-delay", `-${Math.round(p.elapsed)}ms`);
    }
    if (lastFocus && (!document.activeElement || document.activeElement === document.body)) {
      document.querySelector<HTMLElement>(`button.keepbtn[data-keep="${CSS.escape(lastFocus)}"]`)?.focus({ preventScroll: true });
    }
    paintBar();
  }

  /* ── 위쪽 줄(요약 · 용량 · 받은 파일 질문 · 선택) ───────────── */
  function summary(): string {
    const c = counts(allRows());
    return tf("자산 {0}개 · 파일 있음 {1}개 · 보관 중 {2}개", c.total, c.files, c.kept) + (c.prints ? tf(" · 원본 지문 {0}개", c.prints) : "");
  }

  function paintBulk(btn: HTMLButtonElement) {
    if (bulk.running) {
      btn.disabled = false;
      btn.textContent = tf("{0}/{1} · 중지", bulk.done, bulk.total);
      return;
    }
    const n = bulkTargets(allRows(), includeReceived).length;
    btn.disabled = n === 0;
    btn.textContent = n ? tf("파일 있는 {0}개 모두 보관", n) : t("보관할 항목 없음");
  }

  function bar(): HTMLElement | null {
    let el = document.getElementById("keep-bar");
    if (el) return el;
    const anchor = document.getElementById("summary")?.closest(".bar");
    if (!anchor || !anchor.parentElement) return null;
    el = document.createElement("div");
    el.id = "keep-bar";
    el.className = "keep-bar";
    // 알림 칸은 한 번만 만든다 — 다시 그려도 스크린리더가 같은 말을 되읽지 않게.
    el.innerHTML = `<div id="keep-main"></div><div id="keep-live" class="keep-live" role="status" aria-live="polite"></div>`;
    anchor.insertAdjacentElement("afterend", el);
    el.addEventListener("click", onBarClick);
    el.addEventListener("change", onBarChange);
    return el;
  }

  let lastBarHtml = "";
  function paintBar() {
    const root = bar();
    const el = root?.querySelector<HTMLElement>("#keep-main");
    if (!root || !el) return;
    const cap = capacityView(capacity.used, capacity.max, capacity.running);
    const rows = allRows();
    const fresh = undecidedReceived(rows);
    const showAsk = fresh.length > 0 && dismissedCount() !== fresh.length && !prefs.damaged;
    let capHtml: string;
    if (cap.level === "off") capHtml = `<span class="kcap-off">${esc(t("파일 보관함(IPFS)이 꺼져 있어요. 설정에서 켜세요."))}</span>`;
    else if (cap.level === "unknown") capHtml = `<span class="meta">${esc(t("보관함 용량을 읽지 못했어요."))}</span>`;
    else {
      const warn = cap.level === "full" ? t("새 파일을 못 받을 수 있어요. 한도를 늘리거나 받은 파일 일부를 해제하세요.")
        : cap.level === "warn" ? t("보관함이 거의 찼어요. 설정에서 한도를 늘리거나 받은 파일 일부를 해제하세요.") : "";
      capHtml =
        `<span class="kcap-label">${esc(t("보관함"))}</span>` +
        `<span class="kcap-meter ${cap.level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${cap.pct}" aria-label="${esc(t("보관함 사용량"))}"><i></i></span>` +
        `<span class="kcap-num">${esc(`${fmtBytes(capacity.used!)} / ${fmtBytes(capacity.max!)} (${cap.pct}%)`)}</span>` +
        (warn ? `<span class="kcap-warn ${cap.level}">${esc(warn)}</span><button type="button" class="ghost" data-kact="settings">${esc(t("한도 늘리기"))}</button>` : "");
    }
    const html =
      (prefs.damaged
        ? `<div class="keep-note bad" role="alert">${esc(t("보관 설정 파일이 손상되어 자동 보관을 멈췄어요. 이미 보관 중인 파일은 그대로예요."))} <button type="button" data-kact="reset">${esc(t("자동 보관 다시 켜기"))}</button></div>`
        : "") +
      `<div class="keep-cap">${capHtml}</div>` +
      (showAsk
        ? `<div class="keep-note ask" role="region" aria-label="${esc(t("새로 받은 파일"))}"><span>${esc(tf("새로 받은 파일 {0}개 · 보관할까요?", fresh.length))}</span>` +
          `<button type="button" data-kact="ask-all">${esc(t("모두 보관"))}</button>` +
          `<button type="button" class="ghost" data-kact="ask-each">${esc(t("하나씩"))}</button>` +
          `<button type="button" class="ghost" data-kact="ask-none">${esc(t("모두 안 함"))}</button>` +
          `<button type="button" class="ghost kclose" data-kact="ask-dismiss" aria-label="${esc(t("나중에"))}" title="${esc(t("나중에"))}">×</button></div>`
        : "") +
      `<div class="keep-opts"><label><input type="checkbox" id="keep-incl"${includeReceived ? " checked" : ""}> ${esc(t("받은 것도 포함"))}</label>` +
      `<label><input type="checkbox" id="keep-auto"${prefs.auto_mine ? " checked" : ""}${prefs.damaged ? " disabled" : ""}> ${esc(t("내가 만든 파일은 자동으로 보관"))}</label></div>`;
    if (html !== lastBarHtml) {
      const keepId = (document.activeElement as HTMLElement | null)?.closest?.("#keep-bar") ? (document.activeElement as HTMLElement).id || (document.activeElement as HTMLElement).dataset.kact : "";
      el.innerHTML = html;
      lastBarHtml = html;
      if (keepId) (el.querySelector<HTMLElement>(`#${CSS.escape(keepId)}`) ?? el.querySelector<HTMLElement>(`[data-kact="${CSS.escape(keepId)}"]`))?.focus({ preventScroll: true });
      const live = document.getElementById("keep-live");
      if (live && liveText && !live.textContent) live.textContent = liveText;
    }
    const pin = document.getElementById("pin-all") as HTMLButtonElement | null;
    if (pin) paintBulk(pin);
  }

  const dismissKey = "playx-raven-keep-ask-dismissed";
  function dismissedCount(): number {
    try { return Number(sessionStorage.getItem(dismissKey) ?? "-1"); } catch { return -1; }
  }

  async function onBarClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kact]");
    if (!b) return;
    const act = b.dataset.kact;
    if (act === "settings") deps.showSettings();
    else if (act === "reset") {
      try { takePrefs(await deps.invoke("asset_keep_reset")); announce(t("자동 보관을 다시 켰어요.")); } catch (er) { announce(deps.errText(er)); }
      deps.renderList();
    } else if (act === "ask-all") await bulkKeep(undecidedReceived(allRows()));
    else if (act === "ask-none") {
      const cids = [...new Set(undecidedReceived(allRows()).map((r) => r.cid!))];
      try { await setDecision(cids, "skip"); announce(tf("{0}개는 보관하지 않아요. 언제든 줄에서 「보관」을 누를 수 있어요.", cids.length)); } catch (er) { announce(deps.errText(er)); }
      deps.renderList();
    } else if (act === "ask-each") {
      document.querySelector<HTMLElement>('[data-afilter="got"]')?.click();
      try { sessionStorage.setItem(dismissKey, String(undecidedReceived(allRows()).length)); } catch { /* 없어도 된다 */ }
      deps.renderList();
    } else if (act === "ask-dismiss") {
      try { sessionStorage.setItem(dismissKey, String(undecidedReceived(allRows()).length)); } catch { /* 없어도 된다 */ }
      paintBar();
    }
  }

  async function onBarChange(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.id === "keep-incl") { includeReceived = el.checked; deps.renderList(); }
    else if (el.id === "keep-auto") {
      try { takePrefs(await deps.invoke("asset_keep_auto_mine", { on: el.checked })); announce(el.checked ? t("내가 만든 파일은 자동으로 보관해요.") : t("내가 만든 파일을 자동으로 보관하지 않아요.")); }
      catch (er) { announce(deps.errText(er)); el.checked = prefs.auto_mine; }
    }
  }

  /* ── 일괄 보관 ───────────────────────────────────────────────── */
  async function bulkKeep(list?: AssetRow[]) {
    if (bulk.running) { bulk.stop = true; return; }
    const targets = list ?? bulkTargets(allRows(), includeReceived);
    const cids = [...new Set(targets.map((r) => r.cid!))];
    if (!cids.length) return;
    await refreshCapacity();
    const cap = capacityView(capacity.used, capacity.max, capacity.running);
    if (cap.level === "off") { announce(t("파일 보관함(IPFS)이 꺼져 있어서 보관할 수 없어요. 설정에서 켜세요.")); return; }
    if (cap.level === "full" || cap.level === "warn") {
      const go = await dialog({
        title: t("보관함이 거의 찼어요"),
        body: [t("지금 보관하면 남은 공간이 5% 아래로 줄 수 있어요. 파일 크기는 미리 알 수 없어요."), t("그래도 계속할까요?")],
        ok: t("계속"), cancel: t("취소"),
      });
      if (!go) return;
    }
    bulk = { running: true, done: 0, total: cids.length, stop: false };
    let kept = 0, reserved = 0, bad = 0;
    deps.renderList();
    for (const cid of cids) {
      if (bulk.stop) break;
      const r = await keepCid(cid);
      if (r === "kept") kept++; else if (r === "reserved") reserved++; else bad++;
      bulk.done++;
      deps.renderList();
    }
    const stopped = bulk.stop;
    bulk = { running: false, done: 0, total: 0, stop: false };
    announce(
      (stopped ? t("중지했어요.") + " " : "") +
      tf("{0}개 보관", kept) + (reserved ? " · " + tf("{0}개 못 찾아 예약", reserved) : "") + (bad ? " · " + tf("{0}개 실패", bad) : ""),
    );
    deps.renderList();
    void refreshCapacity();
  }

  /* ── 용량 · 새로 읽기 ───────────────────────────────────────── */
  async function refreshCapacity() {
    let running: boolean | null = null, peers: number | null = null, used: number | null = null, max: number | null = null;
    try {
      const s = await deps.invoke<any>("ipfs_status");
      running = s?.running === true ? true : s?.running === false ? false : null;
      peers = typeof s?.peers === "number" ? s.peers : null;
    } catch { running = null; }
    if (running !== false) {
      try {
        const r = await deps.invoke<any>("repo_size");
        used = typeof r?.used_bytes === "number" ? r.used_bytes : null;
        max = typeof r?.max_bytes === "number" && r.max_bytes > 0 ? r.max_bytes : null;
      } catch { used = max = null; }
    }
    capacity = { used, max, running, peers };
    paintBar();
  }

  async function refreshPinned() {
    try {
      const list = await deps.invoke<string[]>("pin_list");
      const cur = deps.getPinned();
      if (list.length !== cur.size || list.some((c) => !cur.has(c))) { deps.setPinned(new Set(list)); deps.renderList(); }
    } catch { /* 파일창고가 꺼져 있으면 지난 값을 둔다 */ }
  }

  /** 자산을 새로 불러온 직후 한 번. */
  async function onLoaded() {
    bar();
    await refreshPrefs();
    deps.renderList();
    void refreshCapacity();
  }

  /* ── 확인 시점 ───────────────────────────────────────────────── */
  const recheckCid = (cid: string) => shouldRecheck(deps.health.get(cid), checkedAt[cid], Date.now());
  function stamp(cid: string) { checkedAt[cid] = Date.now(); saveAt(); }
  function scanEnded(stoppedByUser: boolean) { scanStopped = stoppedByUser; }

  /* ── 안내 창(안전 문턱) ─────────────────────────────────────── */
  type DlgOpts = { title: string; body: string[]; ok: string; cancel: string; check?: string; danger?: boolean };
  let dlgOpen = false;
  function dialog(o: DlgOpts): Promise<boolean> {
    if (dlgOpen) return Promise.resolve(false);
    dlgOpen = true;
    const returnTo = document.activeElement as HTMLElement | null;
    const wrap = document.createElement("div");
    wrap.className = "keep-dlg-wrap";
    wrap.innerHTML =
      `<div class="keep-dlg${o.danger ? " danger" : ""}" role="alertdialog" aria-modal="true" aria-labelledby="keep-dlg-t" aria-describedby="keep-dlg-b">` +
      `<h3 id="keep-dlg-t">${esc(o.title)}</h3><div id="keep-dlg-b">${o.body.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` +
      (o.check ? `<label class="keep-dlg-check"><input type="checkbox" id="keep-dlg-c"> ${esc(o.check)}</label>` : "") +
      `<div class="keep-dlg-btns"><button type="button" id="keep-dlg-no">${esc(o.cancel)}</button><button type="button" id="keep-dlg-yes" class="${o.danger ? "danger" : "ghost"}"${o.check ? " disabled" : ""}>${esc(o.ok)}</button></div></div>`;
    document.body.appendChild(wrap);
    const yes = wrap.querySelector<HTMLButtonElement>("#keep-dlg-yes")!;
    const no = wrap.querySelector<HTMLButtonElement>("#keep-dlg-no")!;
    const chk = wrap.querySelector<HTMLInputElement>("#keep-dlg-c");
    chk?.addEventListener("change", () => { yes.disabled = !chk.checked; });
    no.focus(); // 기본 포커스 = 취소
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        dlgOpen = false;
        returnTo?.focus?.({ preventScroll: true });
        resolve(v);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(false); }
        else if (e.key === "Tab") {
          const f = [...wrap.querySelectorAll<HTMLElement>("input,button")].filter((x) => !(x as HTMLButtonElement).disabled);
          if (!f.length) return;
          const i = f.indexOf(document.activeElement as HTMLElement);
          const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
          e.preventDefault(); f[next].focus();
        }
      };
      document.addEventListener("keydown", onKey, true);
      no.addEventListener("click", () => done(false));
      yes.addEventListener("click", () => { if (!yes.disabled) done(true); });
    });
  }

  /* ── 이유 안내(「?」) ────────────────────────────────────────── */
  let pop: HTMLElement | null = null;
  function closePop() { pop?.remove(); pop = null; }
  async function openReason(btn: HTMLElement, cid: string, name: string) {
    closePop();
    const a = deps.assets.get(name);
    if (!a) return;
    const st = stateOf(a);
    let running: boolean | null = capacity.running, peers: number | null = capacity.peers;
    try { const s = await deps.invoke<any>("ipfs_status"); running = s?.running === true ? true : s?.running === false ? false : null; peers = typeof s?.peers === "number" ? s.peers : null; } catch { /* 모르면 모른다 */ }
    const r = reasonFor({
      kind: st.kind, reserved: st.reserved, mine: !!ownerOf(cid), ipfsRunning: running, peers,
      checkedAtSec: checkedAt[cid] ? Math.floor(checkedAt[cid] / 1000) : null, nowSec: Math.floor(Date.now() / 1000),
      stopped: scanStopped,
    });
    if (!r) return;
    const labels: Record<ReasonAction, string> = { check: "지금 확인", retry: "다시 찾기", resume: "이어서 확인", settings: "설정 열기" };
    const el = document.createElement("div");
    el.className = "keep-pop";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("이유 보기"));
    el.innerHTML =
      r.lines.map((m) => `<p>${esc(msgText(m))}</p>`).join("") +
      `<div class="keep-pop-btns">${r.actions.map((x) => `<button type="button" data-pact="${x}">${esc(t(labels[x]))}</button>`).join("")}<button type="button" class="ghost" data-pact="close">${esc(t("닫기"))}</button></div>`;
    document.body.appendChild(el);
    pop = el;
    const rc = btn.getBoundingClientRect();
    el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, rc.bottom + 6)}px`;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, rc.right - el.offsetWidth))}px`;
    el.querySelector<HTMLElement>("button")?.focus();
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-pact]")?.dataset.pact;
      if (!act) return;
      closePop();
      btn.focus?.({ preventScroll: true });
      if (act === "settings") deps.showSettings();
      else if (act === "check" || act === "resume") deps.startScan();
      else if (act === "retry") void keepCid(cid);
    });
  }

  /* ── 우클릭 · 메뉴 키 ───────────────────────────────────────── */
  let menu: HTMLElement | null = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function openMenu(x: number, y: number, a: KeepAsset) {
    closeMenu();
    const st = stateOf(a);
    const cid = a.ipfs_hash;
    const items: Array<[string, string]> = [];
    if (cid && st.kind !== "nofile" && st.kind !== "fingerprint") {
      items.push(st.kind === "kept" ? ["unkeep", "보관 해제…"] : ["keep", "보관"]);
      if (st.kind !== "kept") items.push(["recheck", "다시 확인"]);
    }
    items.push(["verify", "진짜인지 확인"], ["copy", "확인 주소 복사"]);
    const el = document.createElement("div");
    el.className = "keep-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = items.map(([k, l]) => `<button type="button" role="menuitem" data-mact="${k}">${esc(t(l))}</button>`).join("");
    document.body.appendChild(el);
    menu = el;
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4))}px`;
    el.querySelector<HTMLElement>("button")?.focus();
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-mact]")?.dataset.mact;
      if (!act) return;
      closeMenu();
      if (act === "keep" && cid) void keepCid(cid);
      else if (act === "unkeep" && cid) void requestUnkeep(cid, "menu");
      else if (act === "recheck" && cid) void recheckOne(cid);
      else if (act === "verify") { deps.getSelected() !== a.name && deps.select(a.name); void runVerify(a); }
      else if (act === "copy") void copyAddress(a.name);
    });
    el.addEventListener("keydown", (e) => {
      const btns = [...el.querySelectorAll<HTMLElement>("button")];
      const i = btns.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
  }

  async function recheckOne(cid: string) {
    if (busy.has(cid)) return;
    deps.health.set(cid, "checking");
    deps.renderList();
    let alive = false;
    try { alive = await deps.invoke<boolean>("cid_alive", { cid, timeoutSecs: 30 }); } catch { alive = false; }
    deps.health.set(cid, alive ? "found" : "missing");
    stamp(cid); deps.saveHealth();
    announce(alive ? t("파일을 찾았어요.") : t("파일을 찾지 못했어요."));
    deps.renderList();
  }

  /* ── 이벤트 (표 전체에 한 번만 묶는다 — 다시 그려도 그대로) ──── */
  function bindOnce() {
    const body = document.getElementById("assets");
    if (!body || body.dataset.keepBound === "1") return;
    body.dataset.keepBound = "1";

    // 캡처 단계: 줄을 고르는 기존 클릭(tr.onclick)보다 먼저 받아 배지·「?」 클릭을 삼킨다.
    body.addEventListener("click", (e) => {
      const q = (e.target as HTMLElement).closest<HTMLElement>("button.keepq");
      if (q) { e.stopPropagation(); void openReason(q, q.dataset.keepq!, q.dataset.kname!); return; }
      const b = (e.target as HTMLElement).closest<HTMLElement>("button.keepbtn");
      if (!b) return;
      e.stopPropagation();
      // 길게 눌러 해제를 마친 손가락이 떼어질 때 따라오는 클릭은 한 번만 삼킨다(되돌리기로 읽히지 않게).
      if (suppressClick) { suppressClick = false; return; }
      void tap(b.dataset.keep!, b.dataset.kname!);
    }, true);

    // 새로 누르기 시작하면 지난 길게 누르기의 남은 클릭 삼킴은 끝난 것이다(클릭이 안 와도 다음 클릭을 막지 않게).
    document.addEventListener("pointerdown", () => { suppressClick = false; }, true);
    body.addEventListener("pointerdown", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button.keepbtn");
      if (!b || e.button !== 0 || b.dataset.kkind !== "kept") return;
      hold.start(b.dataset.keep!);
    });
    body.addEventListener("pointerout", (e) => {
      const from = (e.target as HTMLElement).closest<HTMLElement>("button.keepbtn");
      if (!from) return;
      const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
      if (to && from.contains(to)) return;
      // 다시 그리는 중에 사라진 요소로는 취소하지 않는다(그 요소는 이미 DOM 에 없다).
      if (from.isConnected) hold.cancel();
    });
    const cancel = () => { hold.cancel(); };
    document.addEventListener("pointerup", cancel);
    document.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);

    body.addEventListener("contextmenu", (e) => {
      // 길게 누르는 중(터치)에 OS 메뉴가 같이 뜨지 않게.
      if (hold.pressing()) { e.preventDefault(); return; }
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-row]");
      if (!tr) return;
      const a = deps.assets.get(tr.dataset.row!);
      if (!a) return;
      e.preventDefault();
      const ev = e as MouseEvent;
      openMenu(ev.clientX, ev.clientY, a);
    });

    body.addEventListener("focusin", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button.keepbtn");
      lastFocus = b ? b.dataset.keep ?? null : null;
    });
    body.addEventListener("focusout", (e) => {
      const to = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (to && !to.closest("button.keepbtn")) lastFocus = null;
    });

    body.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      const b = (ev.target as HTMLElement).closest<HTMLElement>("button.keepbtn");
      if (!b || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const cid = b.dataset.keep!;
      const a = deps.assets.get(b.dataset.kname!);
      if (ev.key === "Delete") {
        ev.preventDefault(); ev.stopPropagation();
        if (b.dataset.kkind === "kept") void requestUnkeep(cid, "key"); else announce(t("보관 중인 파일만 풀 수 있어요."));
      } else if (ev.key === "r" || ev.key === "R") {
        ev.preventDefault(); ev.stopPropagation();
        if (b.dataset.kkind !== "kept") void recheckOne(cid);
      } else if (ev.key === "v" || ev.key === "V") {
        ev.preventDefault(); ev.stopPropagation();
        if (a) { deps.getSelected() !== a.name && deps.select(a.name); void runVerify(a); }
      } else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
        ev.preventDefault();
        if (a) { const r = b.getBoundingClientRect(); openMenu(r.left, r.bottom, a); }
      }
    });

    // 겹쳐 열린 것(메뉴·「?」)은 바깥을 누르거나 Esc 로 닫는다. Esc 가 오른쪽 패널까지 닫지 않게 가로챈다.
    document.addEventListener("pointerdown", (e) => {
      const el = e.target as HTMLElement;
      if (menu && !menu.contains(el)) closeMenu();
      if (pop && !pop.contains(el) && !el.closest("button.keepq")) closePop();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (menu) { e.stopImmediatePropagation(); closeMenu(); }
      else if (pop) { e.stopImmediatePropagation(); closePop(); }
    }, true);

    window.addEventListener("desktop-language-change", () => { deps.renderList(); paintPanel(deps.getSelected() ? deps.assets.get(deps.getSelected()!) ?? null : null); });
    setInterval(() => {
      if (document.hidden || !document.getElementById("assets")?.offsetParent) return;
      void refreshPinned();
      void refreshCapacity();
    }, 60_000);
  }

  /* ── 오른쪽 패널: 진짜인지 확인 ─────────────────────────────── */
  async function copyAddress(name: string) {
    const url = deps.verifyLink(name);
    try { await navigator.clipboard.writeText(url); announce(t("확인 주소를 복사했어요. 다른 사람에게 보내면 인터넷 창에서 확인할 수 있어요.")); }
    catch { announce(tf("복사하지 못했어요. 주소: {0}", url)); }
    paintVerify(name);
  }

  async function runVerify(a: KeepAsset) {
    const s = { phase: "running" as const };
    verifyState.set(a.name, s);
    paintVerify(a.name);
    document.getElementById("keep-panel")?.scrollIntoView({ block: "nearest" });
    try {
      const result = await deps.invoke<VerifyResult>("asset_verify", { name: a.name });
      verifyState.set(a.name, { phase: "done", result });
    } catch (e) {
      verifyState.set(a.name, { phase: "error", error: deps.errText(e) });
    }
    paintVerify(a.name);
  }

  function armDrop(name: string) {
    dropArm = { name, until: Date.now() + 60_000 };
    announce(t("이제 원본 파일을 이 창에 끌어놓으세요. (1분 안에)"));
    paintVerify(name);
  }
  const acceptsDrop = () => !!dropArm && Date.now() < dropArm.until && verifyState.get(dropArm.name)?.phase === "done";
  async function handleDrop(paths: string[]) {
    const arm = dropArm; dropArm = null;
    if (!arm || !paths.length) return;
    const st = verifyState.get(arm.name);
    if (!st) return;
    st.fileBusy = true; paintVerify(arm.name);
    try {
      const r = await deps.invoke<FileMatch>("asset_verify_file", { name: arm.name, path: paths[0] });
      st.file = fileMatchLine(r);
    } catch (e) {
      st.file = { tone: "unknown", msg: { k: deps.errText(e) } };
    }
    st.fileBusy = false;
    paintVerify(arm.name);
  }

  function lineHtml(l: VLine): string {
    const icon = l.tone === "ok" ? "✔" : l.tone === "warn" ? "!" : l.tone === "bad" ? "✕" : l.tone === "unknown" ? "?" : "i";
    return `<li class="kv-${l.tone}"><span class="kv-i" aria-hidden="true">${icon}</span><span>${esc(msgText(l.msg))}</span></li>`;
  }

  function paintVerify(name: string) {
    const box = document.getElementById("keep-verify-out");
    if (!box || deps.getSelected() !== name) return;
    const st = verifyState.get(name);
    let h = "";
    if (st?.phase === "running") h = `<p class="meta">${esc(t("내 노드에 묻는 중…"))}</p>`;
    else if (st?.phase === "error") h = `<p class="kv-bad-txt">${esc(st.error || "")}</p>`;
    else if (st?.phase === "done" && st.result) {
      const v = verifyLines(st.result);
      h = `<p class="kv-head kv-${v.headline.tone}">${esc(msgText(v.headline.msg))}</p>`;
      if (v.lines.length) h += `<ul class="kv-list">${v.lines.map(lineHtml).join("")}</ul>`;
      if (st.result.status === "found" && st.result.has_ipfs) {
        h += `<button type="button" class="ghost" data-vact="drop">${esc(t("원본 파일 대조하기"))}</button>`;
        if (dropArm && dropArm.name === name && acceptsDrop()) h += `<p class="meta kv-armed">${esc(t("이제 원본 파일을 이 창에 끌어놓으세요. (1분 안에)"))}</p>`;
      }
      if (st.fileBusy) h += `<p class="meta">${esc(t("파일 지문을 계산하는 중…"))}</p>`;
      if (st.file) h += `<ul class="kv-list">${lineHtml(st.file)}</ul>`;
      const at = st.result.at ? Math.max(0, Math.floor(Date.now() / 1000) - st.result.at) : 0;
      h += `<p class="meta">${esc(tf("이 확인은 내 노드가 직접 했어요 · 장부 높이 {0} · {1}", st.result.height ?? "-", msgText(at < 60 ? { k: "방금" } : at < 3600 ? { k: "{0}분 전", a: [Math.floor(at / 60)] } : { k: "{0}시간 전", a: [Math.floor(at / 3600)] })))}</p>`;
      if (v.web) h += `<p class="meta">${esc(t("내 노드로 답을 못 얻을 때만 인터넷 창의 확인 페이지가 대신할 수 있어요."))}</p>`;
    } else {
      h = `<p class="meta">${esc(t("내 노드가 공개 장부를 직접 읽어서 확인해요. 인터넷 서버를 거치지 않아요."))}</p>`;
    }
    box.innerHTML = h;
  }

  function paintPanel(a: KeepAsset | null) {
    const panel = document.getElementById("panel");
    if (!panel) return;
    let box = document.getElementById("keep-panel");
    if (!a) { box?.remove(); return; }
    if (!box) {
      box = document.createElement("div");
      box.id = "keep-panel";
      box.className = "keep-panel";
      panel.appendChild(box);
      box.addEventListener("click", (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-vact]")?.dataset.vact;
        const name = box!.dataset.kname!;
        const asset = deps.assets.get(name);
        if (!act || !asset) return;
        if (act === "verify") void runVerify(asset);
        else if (act === "copy") void copyAddress(name);
        else if (act === "web") void deps.openUrl(deps.verifyLink(name)).catch(() => {});
        else if (act === "drop") armDrop(name);
      });
    }
    const cid = a.ipfs_hash;
    const st = stateOf(a);
    const keepHint =
      cid && st.kind === "kept" ? `<p class="meta">${esc(t("길게 누르면 보관 해제 · Delete 키도 됩니다"))}</p>` : "";
    // 같은 자산·같은 안내면 다시 만들지 않는다 — 검사가 도는 동안 키보드 포커스가 날아가지 않게.
    const sig = `${a.name}|${st.kind === "kept"}|${document.documentElement.lang}`;
    if (box.dataset.sig === sig) { paintVerify(a.name); return; }
    box.dataset.sig = sig;
    box.dataset.kname = a.name;
    box.innerHTML =
      keepHint +
      `<h4>${esc(t("진짜인지 확인"))}</h4>` +
      `<div class="kv-btns"><button type="button" data-vact="verify">${esc(t("앱 안에서 확인"))}</button>` +
      `<button type="button" class="ghost" data-vact="copy">${esc(t("확인 주소 복사"))}</button>` +
      `<button type="button" class="ghost" data-vact="web">${esc(t("인터넷 창에서 열기"))}</button></div>` +
      `<div id="keep-verify-out" aria-live="polite"></div>`;
    paintVerify(a.name);
  }

  /** 오른쪽 패널의 기존 단추(보관·해제)와 「진짜인지 확인」을 이쪽 흐름에 연결한다. */
  function keepFromPanel(cid: string) { void keepCid(cid); }
  function unkeepFromPanel(cid: string) { void requestUnkeep(cid, "panel"); }
  function openVerify(a: KeepAsset) { void runVerify(a); }

  return {
    summary, badgeHtml, actHtml, afterRender, paintBulk, onLoaded, bulkKeep, bindOnce,
    keepFromPanel, unkeepFromPanel, openVerify, paintPanel,
    recheckCid, stamp, scanEnded,
    acceptsDrop, handleDrop,
    /** 시험·진단용 */
    _state: () => ({ prefs, busy: [...busy.keys()], undo: [...undo.keys()], bulk, hold: HOLD_MS }),
  };
}

export type AssetKeep = ReturnType<typeof createAssetKeep>;
