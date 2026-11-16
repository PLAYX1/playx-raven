/**
 * 11-17 레이븐볼트 단순화 2판 — 데스크탑 첫 화면 「내 것」(대표 「다 진행하자」 · 시안 debate/shots2/9-데스크탑.png).
 *
 * 이 파일은 **화면 배치·문구만** 맡는다. 노드·지갑·채굴·발행 동작은 main.ts 의 기존 함수를 부를 뿐이다.
 *  - 맨 위 「라비 한 줄」: 라비 얼굴(이 화면에 하나) + 말풍선 「오늘 할 일 N개 · …처럼 말해도 돼요」 + 마이크.
 *  - 노드 한 줄: 「공개 장부 받는 중 62% · 약 2시간 남음」 — 남은 시간은 이 창이 본 실제 속도로만 잰다(모르면 %만).
 *  - 내 돈 카드: 「약 ○원」 한 줄(기존 rvn_rate 환산 · 못 읽으면 숫자를 짐작하지 않는다).
 *  - 새 자산 만들기 카드 셋: 작품 한 점 5 · 티켓 100 · 내 이름표 500 RVN(easy-create BURN 과 같은 값).
 *    장부를 다 받기 전에는 「장부 다 받으면 켜져요」 — 적는 것은 되고, 새기기(발행)만 기다린다(create-page·발행 마법사가 막는다).
 *  - 내 것 N개: 만든 것 · 받은 것(산 것 포함).
 * 금지어(wording.rs BANNED)는 src-tauri/src/wording.rs 시험이 이 파일도 본다.
 */
import { t, tf, setCopyText } from "./i18n";
import { DICT } from "./dict";
import { BURN } from "./easy-create";

export type V2Node = { node: "unknown" | "ok" | "sync" | "warm" | "down"; pct: number };
export type V2Asset = { name: string; amount: number; mine: boolean };

export const V2_COPY = {
  say: "「이 폴더 음반으로 올려 줘」처럼 말해도 돼요",
  sayCount: "오늘 할 일 {0}개 · 「이 폴더 음반으로 올려 줘」처럼 말해도 돼요",
  nodeUnknown: "공개 장부 확인 중",
  nodeOk: "공개 장부 다 받음",
  nodeSync: "공개 장부 받는 중 {0}%",
  nodeSyncLeft: "공개 장부 받는 중 {0}% · 약 {1} 남음",
  nodeWarm: "공개 장부 여는 중",
  nodeDown: "노드 꺼짐 · 눌러서 켜기",
  hours: "{0}시간",
  minutes: "{0}분",
  days: "{0}일",
  krw: "약 {0}원",
  krwUnknown: "원화 환산 확인 중",
  wait: "장부 다 받으면 켜져요",
  mineTitle: "내 것 {0}개",
  mineEmpty: "아직 가진 것이 없어요. 위 「새 자산 만들기」나 장터에서 시작해요.",
  made: "만든 것",
  got: "받은 것 · 산 것",
  syncBlock: "공개 장부를 다 받으면 새길 수 있어요. 적은 내용은 그대로 남아 있어요.",
  bell: "알림",
  bellN: "알림 {0}개",
  noMic: "이 컴퓨터에서는 말로 하기가 아직 꺼져 있어요. 라비 창에 글로 적어 주세요.",
} as const;

/** 영어·일본어·중국어(같은 한국어가 사전에 이미 있으면 그것이 이긴다). */
const COPY: Record<string, [string, string, string]> = {
  [V2_COPY.say]: ["You can just say “publish this folder as an album”", "「このフォルダをアルバムで出して」のように話しても大丈夫です", "也可以直接说“把这个文件夹发布成专辑”"],
  [V2_COPY.sayCount]: ["{0} things for today · you can just say “publish this folder as an album”", "今日やること {0}件 · 「このフォルダをアルバムで出して」のように話しても大丈夫です", "今天要做 {0} 件 · 也可以直接说“把这个文件夹发布成专辑”"],
  [V2_COPY.nodeUnknown]: ["Checking the public ledger", "公開台帳を確認中", "正在检查公开账本"],
  [V2_COPY.nodeOk]: ["Public ledger fully received", "公開台帳を受信済み", "公开账本已全部接收"],
  [V2_COPY.nodeSync]: ["Receiving the public ledger {0}%", "公開台帳を受信中 {0}%", "正在接收公开账本 {0}%"],
  [V2_COPY.nodeSyncLeft]: ["Receiving the public ledger {0}% · about {1} left", "公開台帳を受信中 {0}% · 残り約{1}", "正在接收公开账本 {0}% · 约剩 {1}"],
  [V2_COPY.nodeWarm]: ["Opening the public ledger", "公開台帳を開いています", "正在打开公开账本"],
  [V2_COPY.nodeDown]: ["Node is off · press to turn on", "ノードがオフ · 押してオン", "节点已关闭 · 点按开启"],
  [V2_COPY.hours]: ["{0} h", "{0}時間", "{0} 小时"],
  [V2_COPY.minutes]: ["{0} min", "{0}分", "{0} 分钟"],
  [V2_COPY.days]: ["{0} days", "{0}日", "{0} 天"],
  [V2_COPY.krw]: ["about ₩{0}", "約{0}ウォン", "约 {0} 韩元"],
  [V2_COPY.krwUnknown]: ["Checking won value", "ウォン換算を確認中", "正在确认韩元换算"],
  [V2_COPY.wait]: ["Turns on once the ledger is in", "台帳を受信すると使えます", "账本接收完后开启"],
  [V2_COPY.mineTitle]: ["My things: {0}", "自分のもの {0}個", "我的物品 {0} 个"],
  [V2_COPY.mineEmpty]: ["Nothing here yet. Start with “New asset” above or the market.", "まだ持っているものがありません。上の「新しいアセット」かマーケットから始めましょう。", "还没有物品。从上面的“新建资产”或市场开始吧。"],
  [V2_COPY.made]: ["Made", "作ったもの", "我做的"],
  [V2_COPY.got]: ["Received · bought", "受け取った・買ったもの", "收到的 · 买的"],
  [V2_COPY.bell]: ["Notifications", "お知らせ", "通知"],
  [V2_COPY.bellN]: ["{0} notifications", "お知らせ {0}件", "{0} 条通知"],
  [V2_COPY.noMic]: ["Speaking is off on this computer for now. Please type in Ravi's window.", "このコンピューターでは音声入力がまだオフです。ラビの窓に文字で書いてください。", "这台电脑暂时没有开启语音。请在拉比窗口里打字。"],
  [V2_COPY.syncBlock]: ["You can record it once the public ledger is fully received. What you wrote stays here.", "公開台帳をすべて受信すると刻めます。書いた内容はそのまま残ります。", "公开账本全部接收后即可写入。已填写的内容会保留。"],
  "내 것": ["My things", "自分のもの", "我的"],
  "내 돈": ["My money", "自分のお金", "我的钱"],
  "기록 ›": ["History ›", "記録 ›", "记录 ›"],
  "모두 보기 ›": ["See all ›", "すべて見る ›", "查看全部 ›"],
  "폰 연결": ["Link phone", "スマホ連携", "连接手机"],
  "새 자산 만들기": ["New asset", "新しいアセット", "新建资产"],
  "작품 한 점": ["One artwork", "作品1点", "一件作品"],
  "그림·음악 · 이름표 필요": ["Art · music · needs a name tag", "絵・音楽 · 名札が必要", "画·音乐 · 需要名牌"],
  "티켓": ["Ticket", "チケット", "门票"],
  "여러 장 · 더 찍기 가능": ["Many copies · can print more", "複数枚 · 追加発行できます", "多张 · 可以加印"],
  "내 이름표": ["My name tag", "自分の名札", "我的名牌"],
  "브랜드 · 처음 한 번": ["Brand · once, at the start", "ブランド · 最初に一度", "品牌 · 首次一次"],
  "기다리는 동안에도 0원 서명 올리기 · 폰에서 올린 것 확정은 돼요": ["While you wait you can still post free signed items and confirm what you sent from your phone", "待つ間も0ウォン署名の掲載・スマホから送ったものの確定はできます", "等待期间仍可发布 0 元签名、确认手机上传的内容"],
  "라비에게 말로 하기": ["Talk to Ravi", "ラビに話しかける", "对拉比说话"],
  "노드 지킴이 · 채굴": ["Node keeper · mining", "ノード番 · マイニング", "节点守护 · 挖矿"],
  "설정 · 문제 알리기": ["Settings · report a problem", "設定 · 問題を知らせる", "设置 · 报告问题"],
  "아티스트 이름표": ["Artist name tag", "アーティスト名札", "艺术家名牌"],
  "안 되는 것이 있으면 여기서 알려 주세요": ["Tell us here if something does not work", "うまくいかないことがあればここで知らせてください", "如果有问题请在这里告诉我们"],
  "새긴 이름은 공개 장부에 남고, 적힌 RVN은 없어져요(소각). 증명서는 작품 한 점 안에서 고를 수 있어요.": ["The name stays on the public ledger and the RVN shown is burned. Certificates are chosen inside One artwork.", "刻んだ名前は公開台帳に残り、表示のRVNは消えます(焼却)。証明書は「作品1点」の中で選べます。", "写入的名称会留在公开账本上，所示 RVN 会被销毁。证书可在“一件作品”里选择。"],
  "레이븐볼트": ["RavenVault", "レイブンボルト", "RavenVault"],
  "알림 · 할 일 · 최근 거래": ["Alerts · to do · recent", "お知らせ · やること · 最近の取引", "通知 · 待办 · 最近交易"],
  "접기 ↑": ["Close ↑", "閉じる ↑", "收起 ↑"],
  "노드가 아직 준비되지 않았어요. 공개 장부를 다 받으면 새길 수 있어요. 적은 내용은 그대로 남아 있어요.": ["The node is not ready yet. You can record it once the public ledger is fully received. What you wrote stays here.", "ノードの準備がまだです。公開台帳をすべて受信すると刻めます。書いた内容はそのまま残ります。", "节点尚未就绪。公开账本全部接收后即可写入。已填写的内容会保留。"],
};
for (const [source, values] of Object.entries(COPY)) (["en", "ja", "zh"] as const).forEach((lang, n) => { (DICT[lang] ??= {})[source] ??= values[n]; });

/** 금액 표 — 화면 카드 값이 발행 규칙(easy-create BURN)과 같아야 한다. */
export const V2_PRICES = { work: BURN.unique, ticket: BURN.ticket, brand: BURN.brand } as const;

/* ── 노드 한 줄 · 남은 시간 ───────────────────────────────────────── */
type Sample = { at: number; pct: number };
const samples: Sample[] = [];
/** 실제로 본 진행 속도로 남은 시간(ms). 10분 넘게, 0.05%p 넘게 움직였을 때만 — 짐작하지 않는다. */
export function remainingMs(list: readonly Sample[], now: number, pct: number): number | null {
  const recent = list.filter((s) => now - s.at <= 2 * 3600_000);
  if (recent.length < 2) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const dt = last.at - first.at, dp = last.pct - first.pct;
  if (dt < 10 * 60_000 || dp < 0.05) return null;
  const left = ((100 - pct) / dp) * dt;
  return Number.isFinite(left) && left > 0 ? left : null;
}
export function leftText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return tf(V2_COPY.minutes, min);
  const h = Math.round(min / 60);
  if (h < 48) return tf(V2_COPY.hours, h);
  return tf(V2_COPY.days, Math.round(h / 24));
}
let lastNode: V2Node = { node: "unknown", pct: 0 };
export function nodeSynced(): boolean | null {
  if (lastNode.node === "ok") return true;
  if (lastNode.node === "unknown") return null;
  return false;
}
export function paintV2Node(n: V2Node): void {
  lastNode = { ...n };
  const now = Date.now();
  if (n.node === "sync") {
    if (!samples.length || now - samples[samples.length - 1].at >= 60_000) samples.push({ at: now, pct: n.pct });
    while (samples.length > 200) samples.shift();
  } else samples.length = 0;
  const btn = document.getElementById("v2-node"), label = document.getElementById("v2-node-t");
  if (btn && label) {
    const pct = Math.max(0, Math.min(100, n.pct));
    const p = pct >= 99.95 ? pct.toFixed(1) : String(Math.floor(pct));
    const left = n.node === "sync" ? remainingMs(samples, now, pct) : null;
    setCopyText(label, () =>
      n.node === "ok" ? t(V2_COPY.nodeOk)
      : n.node === "sync" ? (left ? tf(V2_COPY.nodeSyncLeft, p, leftText(left)) : tf(V2_COPY.nodeSync, p))
      : n.node === "warm" ? t(V2_COPY.nodeWarm)
      : n.node === "down" ? t(V2_COPY.nodeDown)
      : t(V2_COPY.nodeUnknown));
    btn.dataset.tone = n.node === "ok" ? "ok" : n.node === "down" ? "bad" : n.node === "unknown" ? "off" : "warn";
  }
  // 꺼짐은 노드 한 줄이 「눌러서 켜기」로 말한다 — 「장부 다 받으면」은 받는 중·여는 중에만.
  const waiting = n.node === "sync" || n.node === "warm";
  document.querySelectorAll<HTMLElement>("#v2-create-wait, [data-v2-wait]").forEach((el) => { el.hidden = !waiting; });
  const note = document.getElementById("v2-create-note");
  if (note) note.hidden = !(n.node === "sync" || n.node === "warm");
}

/* ── 원화 한 줄 ─────────────────────────────────────────────────── */
let rate: { krw: number; at: number } | null = null;
let rateLoading = false;
export function paintV2Krw(confirmed: number | null, invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): void {
  const el = document.getElementById("v2-krw");
  if (!el) return;
  const draw = () => {
    const ok = rate && rate.krw > 0 && confirmed !== null && Number.isFinite(confirmed) && confirmed >= 0;
    setCopyText(el, () => ok ? tf(V2_COPY.krw, Math.round(confirmed! * rate!.krw).toLocaleString("ko-KR")) : t(V2_COPY.krwUnknown));
  };
  draw();
  if (rateLoading || (rate && Date.now() - rate.at < 10 * 60_000)) return;
  rateLoading = true;
  void invoke<any>("rvn_rate", { currency: "KRW" })
    .then((r) => { const k = Number(r?.rate) || 0; if (k > 0) rate = { krw: k, at: Date.now() }; })
    .catch(() => null)
    .finally(() => { rateLoading = false; draw(); });
}

/* ── 내 것 N개 ──────────────────────────────────────────────────── */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** 만든 기록(create_history_list)의 사람이 적은 제목 — 체인 이름(BOMSAGWA#GEURIM1) 대신 「봄 사과 그림」. 못 읽으면 체인 이름 그대로. */
const titles = new Map<string, string>();
export function rememberTitles(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const e of list as { title?: string; display_title?: string; names?: string[] }[]) {
    const title = String(e?.display_title || e?.title || "").trim();
    if (title) for (const n of e?.names ?? []) titles.set(String(n), title);
  }
}
export function paintV2Mine(rows: readonly V2Asset[], fmtQty: (n: number) => string): void {
  const title = document.getElementById("v2-mine-title"), list = document.getElementById("v2-mine-list");
  if (!title || !list) return;
  setCopyText(title, () => tf(V2_COPY.mineTitle, rows.length));
  if (!rows.length) { list.innerHTML = `<p class="v2-mine-empty">${esc(t(V2_COPY.mineEmpty))}</p>`; return; }
  const pick = [...rows.filter((a) => a.mine).slice(0, 2), ...rows.filter((a) => !a.mine).slice(0, 2)];
  for (const a of rows) { if (pick.length >= 4) break; if (!pick.includes(a)) pick.push(a); }
  list.innerHTML = pick.map((a) =>
    `<button type="button" class="v2-thing" data-v2-asset="${esc(a.name)}"><small>${esc(t(a.mine ? V2_COPY.made : V2_COPY.got))}</small>` +
    (titles.get(a.name) ? `<b>${esc(titles.get(a.name)!)}</b><span translate="no">${esc(a.name)} · ${esc(fmtQty(a.amount))}</span></button>`
      : `<b translate="no">${esc(a.name)}</b><span>${esc(fmtQty(a.amount))}</span></button>`)).join("");
}

/* ── 연결 ───────────────────────────────────────────────────────── */
/** 첫 화면이면 body.v2-on-home — 왼쪽 아래 노드 줄·떠 있는 라비를 숨기는 기준(:has 없는 WebView 대비). */
let closeOld: (() => void) | null = null;
export function markHome(on: boolean): void {
  document.body.classList.toggle("v2-on-home", on);
  // 다른 화면에 갔다 오면 펼친 알림 묶음은 접혀 있다(첫 화면은 늘 같은 모양).
  if (!on) closeOld?.();
}
export type V2Deps = {
  showPage(id: string): void;
  openRavi(): void;
  startCreate(kind: "work" | "ticket"): void;
  openBrandWizard(): void;
  openNode(): void;
  openReport(): void;
  openAsset(name: string): void;
  phone(): void;
  face(): Node;
};
export function wireDeskV2(d: V2Deps): void {
  const $ = (id: string) => document.getElementById(id);
  $("v2-ravi-face")?.replaceChildren(d.face());
  const ravi = $("v2-ravi-say"); if (ravi) ravi.onclick = () => d.openRavi();
  const mic = $("v2-ravi-mic");
  if (mic) mic.onclick = () => {
    d.openRavi();
    // 라비 대화창이 열리면 그 안의 마이크(있을 때만 — 말 입력을 못 쓰는 창이면 숨겨져 있다)를 누른다.
    window.setTimeout(() => {
      const v = document.getElementById("rv-voice") as HTMLButtonElement | null;
      if (v && !v.hidden && v.offsetParent) { v.click(); return; }
      // 말 입력을 못 쓰는 창이면 조용히 넘어가지 않는다 — 어르신은 「안 되네」로 끝난다. 글로 하시라고 한 줄.
      const say = document.getElementById("v2-ravi-t");
      if (say) setCopyText(say, () => t(V2_COPY.noMic));
      (document.getElementById("chat-q") as HTMLTextAreaElement | null)?.focus();
    }, 400);
  };
  const node = $("v2-node"); if (node) node.onclick = () => d.openNode();
  const phone = $("v2-phone"); if (phone) phone.onclick = () => d.phone();
  const all = $("v2-mine-all"); if (all) all.onclick = () => d.showPage("assets");
  document.querySelectorAll<HTMLElement>("[data-v2-create]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.v2Create;
      if (k === "brand") d.openBrandWizard(); else d.startCreate(k === "ticket" ? "ticket" : "work");
    };
  });
  document.querySelectorAll<HTMLElement>("[data-v2-go]").forEach((b) => { b.onclick = () => d.showPage(String(b.dataset.v2Go)); });
  $("v2-mine-list")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-v2-asset]");
    if (b) d.openAsset(String(b.dataset.v2Asset));
  });
  const nav = $("v2-nav-node"); if (nav) nav.onclick = (e) => { e.preventDefault(); d.openNode(); };
  const rep = $("sx-report"); if (rep) rep.onclick = () => d.openReport();
  // 알림 종: 백업 확인 필요(주의·문제)·잠금 문제 수 — 안 본 이야기 글은 왼쪽 「이야기」 배지, 노드는 노드 줄이 이미 말한다(같은 것을 두 번 세지 않는다). 누르면 옛 「알림 · 할 일 · 최근 거래 · 바로 가기」 묶음을 펼치고 접는다.
  const bell = $("v2-bell"), bellN = $("v2-bell-n"), old = $("v2-old");
  const countBell = () => {
    if (!bell || !bellN) return;
    const n = document.querySelectorAll('#rv-home-lock-state[data-tone="bad"], #rv-home-backup-state:is([data-tone="bad"],[data-tone="warn"])').length;
    bellN.hidden = n === 0; bellN.textContent = n > 99 ? "99+" : String(n);
    const label = n ? tf(V2_COPY.bellN, n) : t(V2_COPY.bell);
    bell.setAttribute("aria-label", label); bell.title = label;
  };
  const setOld = (open: boolean) => {
    if (!bell || !old) return;
    old.hidden = !open; bell.setAttribute("aria-expanded", String(open));
    if (open) old.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (bell) bell.onclick = () => setOld(!!old?.hidden);
  // 펼치면 종이 화면 위로 올라가 안 보인다 — 묶음 맨 위에 「접기」 단추(어르신이 되돌아갈 곳).
  const close = $("v2-old-close"); if (close) close.onclick = () => { setOld(false); bell?.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  closeOld = () => setOld(false);
  const watch = new MutationObserver(countBell);
  for (const id of ["nav-talkbadge", "rv-home-safe"]) { const el = $(id); if (el) watch.observe(el, { attributes: true, childList: true, subtree: true, characterData: true }); }
  countBell();
  // 지금 첫 화면인가 — CSS :has() 를 못 읽는 옛 WebView 도 같은 결과가 나게 몸통 표시를 둔다(showPage 가 바꾼다).
  markHome(!!document.querySelector("#page-home.on"));
  // 라비 말풍선: 오늘 카드 수를 센다(카드 칸이 바뀔 때마다).
  const cards = $("rv-home-cards"), say = $("v2-ravi-t");
  const count = () => {
    if (!cards || !say) return;
    const n = cards.querySelectorAll(".rv-card").length;
    setCopyText(say, () => n > 0 ? tf(V2_COPY.sayCount, n) : t(V2_COPY.say));
  };
  if (cards) new MutationObserver(count).observe(cards, { childList: true });
  count();
}
