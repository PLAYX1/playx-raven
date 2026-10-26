// 잠긴 기본 화면 · 매장용 읽기 전용 화면 — 큰 창(main)을 덮는다. 설계: docs/design/lock-and-dark.md
//
// 🔴 이 화면은 「가림막」이 아니다. 잠김 여부의 단일 진실은 Rust(app_lock)이고, 잠긴 동안 보내기·서명·
//    복구 단어·백업 내보내기·열쇠 IPC 는 Rust 문지기가 거절한다. 여기는 그 상태를 **보여 주고**,
//    지갑 암호를 받아 `app_unlock` 에 넘길 뿐이다. 화면에서 잠금을 「끄는」 길은 없다.
// 🔴 금액은 Rust 가 가린 한 장(mini::snapshot)만 받는다 — 주소·txid 는 오지 않는다. 글자는 전부 textContent.
// main.ts 는 import 한 줄만 한다(접점 최소화).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lang } from "./i18n";
import "./app-lock.css";
import "./money-card.css";

export type LockReason = "standby" | "store" | "manual";
export type LockState = { locked: boolean; reason: LockReason | null; wallet_encrypted?: boolean | null; backup_pass?: boolean };
type Recent = { dir: "in" | "out"; sale: boolean; amount: string | null; unit: string | null; conf: number; ago: number };
type Snap = {
  masked: boolean; status: string; node: { state: string };
  balance: { known: boolean; confirmed: string | null; pending: string | null; has_pending: boolean };
  recent: Recent[];
};
type Lang = "ko" | "en" | "ja" | "zh";

const HIDDEN = "••••";

const KO = {
  title: { standby: "지갑이 잠겨 있어요", manual: "지갑이 잠겨 있어요", store: "매장용 읽기 전용" } as Record<LockReason, string>,
  lede: {
    standby: "대기화면을 켤 때 잠갔어요. 들어온 돈은 계속 보여요. 보내기·서명·복구 단어는 잠금을 푼 뒤에 쓸 수 있어요.",
    manual: "지갑을 잠갔어요. 들어온 돈은 계속 보여요. 보내기·서명·복구 단어는 잠금을 푼 뒤에 쓸 수 있어요.",
    store: "조회만 돼요. 금액은 가려 두었고, 거래 상세·주소·복구 단어·보내기는 이 모드에서 열리지 않아요.",
  } as Record<LockReason, string>,
  readOnly: "읽기 전용", balance: "잔액", incoming: "들어오는 중", recent: "최근 들어온 돈", empty: "최근 들어온 돈이 없어요",
  checking: "잔액 확인 중", deposit: "입금", sale: "판매", confirmed: "확인됨", unconfirmed: "확인 전",
  node: { ok: "노드 정상", syncing: "따라잡는 중", rescanning: "지갑 되살리는 중", down: "노드 응답 없음", other: "노드 확인 중" } as Record<string, string>,
  pass: "지갑 암호", unlock: "잠금 풀기", checkingPass: "확인 중…", admin: "관리자: 잠금 풀기",
  noSecret: "이 지갑에는 암호가 없어 누구나 잠금을 풀 수 있어요. 지갑 화면에서 암호를 걸어 두세요.",
  noSecretGo: "암호 없이 풀기",
  wrong: "암호가 맞지 않습니다.", wait: "여러 번 틀려서 잠시 기다려야 해요. 조금 뒤에 다시 해 주세요.",
  cannotVerify: "노드가 응답하지 않아 암호를 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.",
  empty_pass: "암호를 넣어 주세요.", failed: "잠금을 풀지 못했어요. 다시 해 주세요.",
  startNode: "노드 켜기", standbyAgain: "대기화면 다시 켜기",
  storeOn: "매장용 읽기 전용 모드 켜기",
  storeNote: "켜면 지갑이 잠기고 조회만 돼요(금액 가림). 끌 때는 지갑 암호가 필요해요.",
};
type Copy = typeof KO;
const EN: Copy = {
  title: { standby: "Your wallet is locked", manual: "Your wallet is locked", store: "Store read-only mode" },
  lede: {
    standby: "Locked when the standby screen started. Incoming money is still shown. Sending, signing and recovery words need unlocking first.",
    manual: "The wallet is locked. Incoming money is still shown. Sending, signing and recovery words need unlocking first.",
    store: "View only. Amounts are hidden; transaction details, addresses, recovery words and sending are not available in this mode.",
  },
  readOnly: "Read-only", balance: "Balance", incoming: "Incoming", recent: "Recent incoming", empty: "No recent incoming money",
  checking: "Checking balance", deposit: "Deposit", sale: "Sale", confirmed: "confirmed", unconfirmed: "unconfirmed",
  node: { ok: "Node OK", syncing: "Catching up", rescanning: "Restoring wallet", down: "Node not responding", other: "Checking node" },
  pass: "Wallet password", unlock: "Unlock", checkingPass: "Checking…", admin: "Admin: unlock",
  noSecret: "This wallet has no password, so anyone can unlock it. Set a password on the Wallet screen.",
  noSecretGo: "Unlock without a password",
  wrong: "The password is not correct.", wait: "Too many wrong tries. Please wait a little and try again.",
  cannotVerify: "The node is not responding, so the password can't be checked. Start the node and try again.",
  empty_pass: "Please enter the password.", failed: "Couldn't unlock. Please try again.",
  startNode: "Start node", standbyAgain: "Start standby again",
  storeOn: "Turn on store read-only mode",
  storeNote: "Locks the wallet and shows view-only information (amounts hidden). Turning it off needs the wallet password.",
};
const JA: Copy = {
  title: { standby: "ウォレットはロックされています", manual: "ウォレットはロックされています", store: "店舗用 閲覧専用モード" },
  lede: {
    standby: "待機画面を開いたときにロックしました。入金は引き続き表示されます。送金・署名・復元ワードはロック解除後に使えます。",
    manual: "ウォレットをロックしました。入金は引き続き表示されます。送金・署名・復元ワードはロック解除後に使えます。",
    store: "閲覧のみです。金額は隠しています。取引の詳細・アドレス・復元ワード・送金はこのモードでは開けません。",
  },
  readOnly: "閲覧専用", balance: "残高", incoming: "入金中", recent: "最近の入金", empty: "最近の入金はありません",
  checking: "残高を確認中", deposit: "入金", sale: "販売", confirmed: "確認済み", unconfirmed: "未確認",
  node: { ok: "ノード正常", syncing: "同期中", rescanning: "ウォレット復元中", down: "ノード応答なし", other: "ノード確認中" },
  pass: "ウォレットのパスワード", unlock: "ロック解除", checkingPass: "確認中…", admin: "管理者: ロック解除",
  noSecret: "このウォレットにはパスワードがないため、誰でもロックを解除できます。ウォレット画面でパスワードを設定してください。",
  noSecretGo: "パスワードなしで解除",
  wrong: "パスワードが正しくありません。", wait: "何度も間違えたため、しばらく待ってからもう一度お試しください。",
  cannotVerify: "ノードが応答しないため、パスワードを確認できません。ノードを起動してからもう一度お試しください。",
  empty_pass: "パスワードを入力してください。", failed: "ロックを解除できませんでした。もう一度お試しください。",
  startNode: "ノードを起動", standbyAgain: "待機画面をもう一度開く",
  storeOn: "店舗用 閲覧専用モードをオン",
  storeNote: "オンにするとウォレットがロックされ、閲覧のみになります(金額は非表示)。オフにするにはウォレットのパスワードが必要です。",
};
const ZH: Copy = {
  title: { standby: "钱包已锁定", manual: "钱包已锁定", store: "店铺只读模式" },
  lede: {
    standby: "打开待机画面时已锁定。收到的钱仍会显示。发送、签名和恢复词需要先解锁。",
    manual: "钱包已锁定。收到的钱仍会显示。发送、签名和恢复词需要先解锁。",
    store: "仅可查看。金额已隐藏；此模式下无法打开交易详情、地址、恢复词和发送。",
  },
  readOnly: "只读", balance: "余额", incoming: "到账中", recent: "最近收款", empty: "最近没有收款",
  checking: "正在确认余额", deposit: "收款", sale: "销售", confirmed: "已确认", unconfirmed: "未确认",
  node: { ok: "节点正常", syncing: "正在同步", rescanning: "正在恢复钱包", down: "节点无响应", other: "正在检查节点" },
  pass: "钱包密码", unlock: "解锁", checkingPass: "正在确认…", admin: "管理员：解锁",
  noSecret: "此钱包没有密码，任何人都能解锁。请在钱包页面设置密码。",
  noSecretGo: "无密码解锁",
  wrong: "密码不正确。", wait: "错误次数过多，请稍后再试。",
  cannotVerify: "节点无响应，无法确认密码。请启动节点后再试。",
  empty_pass: "请输入密码。", failed: "无法解锁，请重试。",
  startNode: "启动节点", standbyAgain: "再次打开待机画面",
  storeOn: "开启店铺只读模式",
  storeNote: "开启后钱包会锁定，仅可查看(金额隐藏)。关闭时需要钱包密码。",
};
const COPY: Record<Lang, Copy> = { ko: KO, en: EN, ja: JA, zh: ZH };
export const lockCopy = (l: string = lang): Copy => COPY[(["ko", "en", "ja", "zh"].includes(l) ? l : "en") as Lang];

/** Rust 오류(한국어 원문) → 지금 말. 원문을 그대로 붙이지 않는다(노드 원문이 섞일 수 있다). */
export function unlockError(e: unknown, c: Copy = lockCopy()): { text: string; nodeDown: boolean } {
  const s = String((e as Error)?.message ?? e ?? "");
  if (s.includes("맞지 않")) return { text: c.wrong, nodeDown: false };
  if (s.includes("기다려야")) return { text: c.wait, nodeDown: false };
  if (s.includes("노드가 응답하지")) return { text: c.cannotVerify, nodeDown: true };
  if (s.includes("넣어 주세요")) return { text: c.empty_pass, nodeDown: false };
  return { text: c.failed, nodeDown: false };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  n.append(...kids);
  return n;
};
const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

/** 덮개를 만든다(하네스에서도 그대로). */
export function buildOverlay(c: Copy = lockCopy()): HTMLElement {
  const root = el("div", { id: "app-lock", className: "rv-lock", hidden: true });
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "rv-lock-title");
  root.setAttribute("aria-describedby", "rv-lock-lede");
  const head = el("div", { className: "rv-lock-head" }, el("span", { className: "rv-lock-ico", innerHTML: LOCK_SVG }), el("h2", { id: "rv-lock-title" }));
  const feed = el("section", { className: "rv-lock-feed", id: "rv-lock-feed" },
    el("p", { className: "rv-lock-tag", id: "rv-lock-tag", textContent: c.readOnly }),
    el("div", { className: "rv-lock-bal" }, el("span", { className: "k", id: "rv-lock-bal-k", textContent: c.balance }), el("strong", { id: "rv-lock-balance", translate: false, textContent: HIDDEN })),
    el("p", { className: "rv-lock-incoming", id: "rv-lock-incoming", hidden: true }),
    el("h3", { id: "rv-lock-recent-title", textContent: c.recent }),
    el("ul", { id: "rv-lock-recent", className: "rv-lock-recent" }),
    el("p", { className: "rv-lock-node", id: "rv-lock-node" }));
  feed.setAttribute("aria-labelledby", "rv-lock-tag");
  const pass = el("input", { id: "rv-lock-pass", type: "password", autocomplete: "current-password", spellcheck: false });
  const form = el("form", { id: "rv-lock-form", className: "rv-lock-form" },
    el("label", { htmlFor: "rv-lock-pass", id: "rv-lock-pass-label", textContent: c.pass }),
    el("div", { className: "rv-lock-row" }, pass, el("button", { type: "submit", id: "rv-lock-go", textContent: c.unlock })),
    el("p", { id: "rv-lock-nosecret", className: "rv-lock-warn", hidden: true, textContent: c.noSecret }),
    el("p", { id: "rv-lock-err", className: "rv-lock-err danger" }));
  form.querySelector("#rv-lock-err")!.setAttribute("role", "alert");
  const more = el("div", { className: "rv-lock-more" },
    el("button", { type: "button", id: "rv-lock-admin", className: "ghost", textContent: c.admin, hidden: true }),
    el("button", { type: "button", id: "rv-lock-node-start", className: "ghost", textContent: c.startNode, hidden: true }),
    el("button", { type: "button", id: "rv-lock-standby", className: "ghost", textContent: c.standbyAgain }));
  root.append(el("div", { className: "rv-lock-box" }, head, el("p", { id: "rv-lock-lede", className: "rv-lock-lede" }), feed, form, more));
  return root;
}

function text(id: string, v: string) {
  const n = document.getElementById(id);
  if (n && n.textContent !== v) n.textContent = v;
}

/** 읽기 전용 입금 표시. 매장 모드는 금액이 와도 가린다(가림 기본 — Rust 가림과 두 겹). */
export function renderFeed(snap: Snap | null, reason: LockReason, c: Copy = lockCopy()) {
  const store = reason === "store";
  const money = (v: string | null, unit = "RVN") => (v === null || store ? HIDDEN : `${v} ${unit}`);
  if (!snap) { text("rv-lock-balance", c.checking); return; }
  text("rv-lock-balance", snap.balance.known ? money(snap.balance.confirmed) : c.checking);
  const inc = document.getElementById("rv-lock-incoming");
  if (inc) { inc.hidden = !snap.balance.has_pending; text("rv-lock-incoming", `${c.incoming} ${money(snap.balance.pending)}`); }
  const list = document.getElementById("rv-lock-recent");
  const deposits = (snap.recent || []).filter((r) => r.dir === "in").slice(0, 3);
  list?.replaceChildren(...(deposits.length ? deposits.map((r) => {
    const li = el("li");
    li.append(el("span", { className: "k", textContent: r.sale ? c.sale : c.deposit }),
      // 매장 모드: 자산 이름도 가린다(무엇을 팔았는지가 상세다).
      el("span", { className: "v", translate: false, textContent: r.amount === null || store ? HIDDEN : `${r.amount} ${r.unit ?? ""}`.trim() }),
      el("span", { className: "m", textContent: r.conf > 0 ? c.confirmed : c.unconfirmed }));
    return li;
  }) : [el("li", { className: "empty", textContent: c.empty })]));
  text("rv-lock-node", c.node[snap.node?.state] ?? c.node.other);
  document.getElementById("app-lock")?.setAttribute("data-status", snap.status || "warn");
}

let current: LockState = { locked: false, reason: null };
/** 잠긴 채로 켜졌나 — 그랬다면 큰 창의 첫 준비(휴대폰 서버 주소·설정 읽기 등)가 문지기에 막혔다.
 *  잠금을 풀면 한 번 다시 불러 정상 첫 준비를 돌린다(잠긴 동안 적은 것이 없으므로 잃는 것이 없다). */
let bootLocked: boolean | null = null;
let lastSnap: Snap | null = null;
let inerted: Element[] = [];

/** 잠기는 순간 화면에 남은 민감한 것을 치운다 — 기존 「지금 잠그기」 정리와 같은 일 + 덮개. */
function scrub() {
  document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((i) => { if (i.id !== "rv-lock-pass") i.value = ""; });
  for (const [sheet, close] of [["sdw", "sdw-close"], ["wrs", "wrs-close"]]) {
    const s = document.getElementById(sheet);
    if (s && !s.classList.contains("hidden")) document.getElementById(close)?.click();
  }
  // 열려 있던 보내기 검토는 접는다(잠금이 풀린 뒤 처음부터 다시 — 검토를 건너뛰지 않게).
  const back = document.getElementById("s-back");
  if (document.getElementById("send-review")?.offsetParent) back?.click();
}

let watcher: MutationObserver | null = null;

/** 덮개 밖을 전부 inert 로. 잠긴 동안 나중에 붙는 것(알림·라비 창·대화상자)도 붙는 즉시 inert. */
function setInert(on: boolean, overlay: HTMLElement) {
  const mark = (n: Element) => {
    if (n === overlay || n.tagName === "SCRIPT" || n.hasAttribute("inert")) return;
    n.setAttribute("inert", "");
    inerted.push(n);
  };
  if (on) {
    [...document.body.children].forEach(mark);
    watcher ??= new MutationObserver((rs) => rs.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && n.parentElement === document.body && mark(n))));
    watcher.observe(document.body, { childList: true });
    // 덮개는 늘 맨 끝(같은 z 에서도 위).
    if (overlay.nextElementSibling) document.body.append(overlay);
  } else {
    watcher?.disconnect();
    inerted.forEach((n) => n.removeAttribute("inert"));
    inerted = [];
  }
}

export function paint(state: LockState, c: Copy = lockCopy()) {
  const root = document.getElementById("app-lock");
  if (!root) return;
  const was = !root.hidden;
  current = state;
  if (!state.locked) {
    root.hidden = true;
    setInert(false, root);
    document.documentElement.removeAttribute("data-app-locked");
    return;
  }
  const reason: LockReason = state.reason === "store" || state.reason === "manual" ? state.reason : "standby";
  const store = reason === "store";
  root.dataset.reason = reason;
  text("rv-lock-title", c.title[reason]);
  text("rv-lock-lede", c.lede[reason]);
  const noSecret = state.wallet_encrypted === false && !state.backup_pass;
  const form = document.getElementById("rv-lock-form") as HTMLFormElement;
  const pass = document.getElementById("rv-lock-pass") as HTMLInputElement;
  const go = document.getElementById("rv-lock-go") as HTMLButtonElement;
  const admin = document.getElementById("rv-lock-admin") as HTMLButtonElement;
  // 매장 모드: 잠금 풀기 칸은 「관리자」 단추 뒤에 접어 둔다(손님 화면에 암호 칸이 늘 떠 있지 않게).
  if (!was) form.hidden = store;
  admin.hidden = !store || !form.hidden;
  pass.hidden = noSecret;
  document.getElementById("rv-lock-pass-label")!.hidden = noSecret;
  document.getElementById("rv-lock-nosecret")!.hidden = !noSecret;
  go.textContent = noSecret ? c.noSecretGo : c.unlock;
  renderFeed(lastSnap, reason, c);
  root.hidden = false;
  document.documentElement.setAttribute("data-app-locked", reason);
  if (!was) {
    scrub();
    setInert(true, root);
    (form.hidden || noSecret ? (store ? admin : go) : pass).focus();
  }
}

async function refresh() {
  try {
    const s = await invoke<LockState>("app_lock_state");
    bootLocked ??= !!s?.locked;
    if (bootLocked && s && !s.locked) { location.reload(); return; }
    if (s && typeof s === "object") paint(s);
    if (s?.locked && !lastSnap) {
      const m = await invoke<{ snapshot: Snap }>("mini_state").catch(() => null);
      if (m?.snapshot) { lastSnap = m.snapshot; renderFeed(lastSnap, current.reason ?? "standby"); }
    }
  } catch { /* 옛 판·가짜 IPC — 잠금 명령이 없으면 잠금도 없다(Rust 문지기는 그대로) */ }
}

export function mountAppLock() {
  if (document.getElementById("app-lock")) return;
  const c = lockCopy();
  const root = buildOverlay(c);
  document.body.append(root);
  const form = root.querySelector<HTMLFormElement>("#rv-lock-form")!;
  const pass = root.querySelector<HTMLInputElement>("#rv-lock-pass")!;
  const go = root.querySelector<HTMLButtonElement>("#rv-lock-go")!;
  const err = root.querySelector<HTMLElement>("#rv-lock-err")!;
  const nodeBtn = root.querySelector<HTMLButtonElement>("#rv-lock-node-start")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const value = pass.value;
    pass.value = "";
    go.disabled = true;
    const label = go.textContent || c.unlock;
    go.textContent = c.checkingPass;
    err.textContent = "";
    try {
      await invoke("app_unlock", { passphrase: value || null });
      lastSnap = null;
      await refresh();
    } catch (x) {
      const m = unlockError(x, c);
      err.textContent = m.text;
      nodeBtn.hidden = !m.nodeDown;
    } finally {
      go.disabled = false;
      go.textContent = label;
    }
  });
  root.querySelector("#rv-lock-admin")!.addEventListener("click", () => {
    form.hidden = false;
    (root.querySelector("#rv-lock-admin") as HTMLElement).hidden = true;
    (pass.hidden ? go : pass).focus();
  });
  nodeBtn.addEventListener("click", () => { nodeBtn.disabled = true; void invoke("services_start", { only: "node" }).catch(() => {}).finally(() => { nodeBtn.disabled = false; }); });
  root.querySelector("#rv-lock-standby")!.addEventListener("click", () => void invoke("standby_open").catch(() => {}));
  // 덮개 밖으로 Tab 이 새지 않게(inert 가 막지만, 덮개 안에서 처음↔끝을 돈다).
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...root.querySelectorAll<HTMLElement>("button,input")].filter((n) => !n.hidden && !n.closest("[hidden]") && !(n as HTMLButtonElement).disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  void listen("app-lock-changed", () => { void refresh(); }).catch(() => {});
  void listen<Snap>("app-lock-snapshot", (e) => { lastSnap = e.payload; if (current.locked) renderFeed(lastSnap, current.reason ?? "standby"); }).catch(() => {});
  void refresh();
}

/** 설정 「표시 방식」 칸에서 매장용 읽기 전용 모드를 켠다(끌 때는 잠금 풀기 = 지갑 암호). */
export async function enterStoreMode(): Promise<void> {
  await invoke("app_lock_now", { reason: "store" });
  await refresh();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mountAppLock());
  else mountAppLock();
}
