import { invoke as rawInvoke } from "@tauri-apps/api/core";

/**
 * 오래 걸리는 일에 **「하는 중」을 자동으로 보여 준다.**
 *
 * ## 🔴 왜 감싸나
 *
 * 사장 신고: 「단추를 누르면 한참 뒤에 작동하는 게 많다. 뭐 하는 중이니
 * 기다려 달라고 안내를 해 주는 게 좋겠다.」
 *
 * 세어 보니 눌렀을 때 아무 표시가 없는 자리가 **89곳**이었다. 한 곳씩
 * 고치면 89번 고쳐야 하고, 다음에 새로 짜는 사람이 또 빠뜨린다.
 *
 * 그래서 **부르는 자리(187곳)를 안 건드리고 여기 한 곳에서** 잡는다.
 * 0.4초 안에 끝나는 일에는 아무것도 안 띄운다 — 깜빡이면 그게 더 산만하다.
 */
let busyCount = 0;
let busyTimer: number | undefined;

function busyShow(on: boolean) {
  let el = document.getElementById("busybar");
  if (!el && on) {
    el = document.createElement("div");
    el.id = "busybar";
    el.setAttribute(
      "style",
      "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;" +
        "background:var(--fg,#222);color:var(--bg,#fff);padding:10px 18px;border-radius:999px;" +
        "font-size:15px;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none;" +
        "display:flex;align-items:center;gap:9px",
    );
    el.innerHTML =
      '<span style="width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;' +
      'border-radius:999px;display:inline-block;animation:busyspin .7s linear infinite"></span>' +
      "<span>하는 중… 잠시만요</span>";
    document.body.appendChild(el);
    if (!document.getElementById("busykeys")) {
      const st = document.createElement("style");
      st.id = "busykeys";
      st.textContent =
        "@keyframes busyspin{to{transform:rotate(360deg)}}" +
        "@media (prefers-reduced-motion: reduce){#busybar span:first-child{animation:none}}";
      document.head.appendChild(st);
    }
  }
  if (el && !on) el.remove();
}

/**
 * 마지막으로 사람이 손댄 때.
 *
 * 🔴 이 프로그램은 **타이머 13개**가 계속 상태를 물어본다. 노드가 34GB 를
 *    훑는 동안에는 그 물음의 답이 몇 초씩 늦는다 — 그러면 사장이 아무것도
 *    안 누르고 가만히 있는데도 「하는 중… 잠시만요」가 화면에 눌어붙는다.
 *    안 없어지는 안내는 안내가 아니라 고장으로 읽힌다.
 *
 *    그래서 **사람이 방금 뭘 눌렀을 때만** 알린다. 배경에서 도는 물음은
 *    조용히 지나간다.
 */
// 켠 직후도 「방금 손댄 것」으로 친다 — 아이콘을 누른 게 사람이다.
// 첫 화면이 뜨기까지가 제일 오래 걸리는데 거기서 아무 말이 없으면 안 된다.
let lastTouch = Date.now();
// 🔴 8초였다. 그런데 이 앱은 화면을 **5초마다 다시 그린다** — 그 배경
//    질문들이 전부 8초 창 안에 들어와 「사람이 시킨 일」로 세어졌고,
//    「하는 중… 잠시만요」가 꺼질 틈이 없었다. 대표님이 실제로 그렇게
//    겪으셨다("이거는 왜 계속 뜨나?").
//    누른 직후에 시작되는 부름만 사람 것이다. 1.5초면 충분하다.
const TOUCH_WINDOW = 1500;

/**
 * 🔴 **저절로 도는 일은 안내를 띄우지 않는다.**
 *
 * 시각으로 짐작하는 것(`lastTouch`)만으로는 부족했다. 5초 타이머가
 * 사람이 누른 직후에 돌면 그것도 사람 것으로 세어진다. 그래서 배경에서
 * 도는 자리는 **직접 표시한다.**
 *
 * ⚠️ 이 안에서 사람이 누른 일이 시작되면 그것도 조용해진다. 그 대신
 *    12초 자동 내림(`BUSY_MAX_MS`)이 그대로 남아 있어 눌어붙지는 않는다.
 */
let quietDepth = 0;
async function quietly<T>(fn: () => Promise<T> | T): Promise<T> {
  quietDepth++;
  try {
    return await fn();
  } finally {
    quietDepth--;
  }
}
document.addEventListener("pointerdown", () => (lastTouch = Date.now()), true);
document.addEventListener("keydown", () => (lastTouch = Date.now()), true);

/**
 * 안내가 **눌어붙지 않게 하는 두 장치.**
 *
 * ## 🔴 왜 필요했나
 *
 * 예전에는 도는 일의 개수(`busyCount`)가 0 이 될 때까지 안내를 띄웠다.
 * 그런데 노드가 장부를 훑는 동안에는 배경 질문 하나가 **몇 분씩** 안
 * 끝난다. 사장이 아무것도 안 눌렀는데 「하는 중… 잠시만요」가 화면에
 * 눌어붙었고, 실제로 그렇게 겪으셨다.
 *
 * ① **사람이 시킨 일만 센다.** 배경에서 도는 질문은 안내를 붙잡지 않는다.
 * ② **오래 붙어 있으면 스스로 내려간다.** 안 없어지는 안내는 안내가
 *    아니라 고장으로 읽힌다. 12초면 충분히 말했다.
 */
const BUSY_MAX_MS = 12_000;
let busyGuard: number | undefined;

async function invoke<T = any>(cmd: string, args?: any): Promise<T> {
  // 이 부름이 사람이 시킨 것인가. **시작할 때 정하고 끝까지 그대로 쓴다** —
  // 끝날 때 다시 재면 그사이 손을 댔는지에 따라 셈이 어긋난다.
  const mine = quietDepth === 0 && Date.now() - lastTouch < TOUCH_WINDOW;
  if (mine) {
    busyCount++;
    if (busyTimer === undefined) {
      // 눈에 띄기까지 0.4초. 그보다 빨리 끝나는 일은 조용히 지나간다.
      busyTimer = window.setTimeout(() => {
        busyShow(true);
        clearTimeout(busyGuard);
        busyGuard = window.setTimeout(busyDone, BUSY_MAX_MS);
      }, 400);
    }
  }
  try {
    return (await rawInvoke<T>(cmd, args)) as T;
  } finally {
    if (mine) {
      busyCount--;
      if (busyCount <= 0) busyDone();
    }
  }
}

function busyDone() {
  busyCount = 0;
  if (busyTimer !== undefined) {
    clearTimeout(busyTimer);
    busyTimer = undefined;
  }
  clearTimeout(busyGuard);
  busyGuard = undefined;
  busyShow(false);
}
import { open as pickFile } from "@tauri-apps/plugin-dialog";
// 🔴 이 창은 우리 화면만 그린다. 지갑 화면(쪽지)은 `127.0.0.1:8790/wallet`
//    에서 **인터넷 창으로** 열어야 한다 — 그 화면은 12단어를 들고 있어서
//    `connect-src 'self'` 로 잠겨 있고, 우리 창 안에 끌어들이면 그 잠금이
//    무슨 의미인지 아무도 알 수 없게 된다.
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t, lang, setLang, LANG_NAMES, startI18n } from "./i18n";

type Asset = {
  name: string;
  amount: number;
  ipfs_hash: string | null;
  mine: boolean;
  root: string;
  /** 쪼갤 수 있는 자릿수. 0 이면 통째로만 오간다. 못 읽었으면 null. */
  units: number | null;
  /** 더 찍고 붙은 파일을 바꿀 수 있는가. 못 읽었으면 null. */
  reissuable: boolean | null;
};
// "missing" rather than "dead": twenty seconds without a byte means nobody
// answered, not that the file is gone. Calling it death would be a diagnosis we
// cannot make, and it would tell the user to give up on something recoverable.
type Health = "unknown" | "checking" | "found" | "missing";

const assets = new Map<string, Asset>();
const health = new Map<string, Health>();
let pinned = new Set<string>();
let selected: string | null = null;
let assetFilter: "all" | "mine" | "got" | "selling" = "all";
const collapsed = new Set<string>();

// Scanning is cancellable. A background job you cannot stop is not something to
// put next to a wallet.
let scan = { running: false, done: 0, total: 0, current: "", stop: false, ms: [] as number[] };

const HEALTH_KEY = "playx-raven-health";
/// 화면 요소를 가져온다. 없으면 버려지는 자리를 준다.
///
/// 전에는 `getElementById(id)!` 였다. `!` 는 타입 검사만 넘길 뿐이라, 없는 칸에
/// 값을 넣는 순간 TypeError 가 나고 **그 함수가 거기서 통째로 멈춘다**. 설정
/// 화면을 스위치로 갈아엎으면서 옛 칸을 부르는 줄이 남았고, 그 결과 폰 서버
/// 켜기·가게 발행·상태 갱신이 첫 줄에서 죽어 있었다. 화면은 멀쩡해 보였다.
///
/// 그래서 없으면 떠 있지 않은 input 을 돌려준다. input 인 이유는 `.value` 와
/// `.checked` 를 읽는 코드가 있어서다 — div 를 주면 거기서 또 죽는다.
/// 그리고 한 번은 반드시 알린다. 조용히 넘어가면 이 사고가 그대로 반복된다.
const warned = new Set<string>();
const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el) return el;
  if (!warned.has(id)) {
    warned.add(id);
    console.warn(`화면에 '${id}' 칸이 없습니다 — 이 줄은 아무 일도 하지 않습니다`);
  }
  return document.createElement("input");
};
const $$ = $;

function loadHealth() {
  try {
    const saved = JSON.parse(localStorage.getItem(HEALTH_KEY) || "{}");
    for (const [cid, state] of Object.entries(saved)) {
      if (state === "found" || state === "missing") health.set(cid, state as Health);
    }
  } catch {}
}
function saveHealth() {
  const out: Record<string, string> = {};
  health.forEach((v, k) => { if (v === "found" || v === "missing") out[k] = v; });
  localStorage.setItem(HEALTH_KEY, JSON.stringify(out));
}

/// 아무것도 없는 화면에 레이븐을 세운다.
///
/// 당근이 그렇게 한다 — 마스코트는 **아무것도 없거나 기다리는 자리**에만
/// 나온다. 버튼 옆이나 금액 옆에 두면 눌러야 할 것을 가린다.
///
/// 한 함수로 묶는 이유: 빈 화면 문구가 지금 일곱 군데에 흩어져 있는데,
/// 각자 복붙하면 다음에 고칠 때 하나가 꼭 빠진다.
/// 빈 화면은 실패 화면이 아니라 모집 화면이다.
///
/// 표정을 고르게 한 이유: 여태 어느 자리든 같은 얼굴이었다. "아직 회원이
/// 없습니다"(이제 모으면 된다)와 "오늘 판 것이 없습니다"(조용한 날이다)는
/// 다른 말인데 같은 얼굴이 붙어 있으면 둘 다 고장으로 읽힌다.
function emptyWithRaven(html: string, face: "hello" | "sleep" | "wait" | "worry" = "hello"): string {
  return `<div class="ravibox">
      <img src="/raven-${face}.webp" alt="" />
      <div class="rs">${html}</div>
    </div>`;
}

/// 사람이 적은 글자를 innerHTML 에 넣기 전에./// 사람이 적은 글자를 innerHTML 에 넣기 전에.
///
/// 메뉴 이름·환불 사유는 사장과 직원이 직접 친 글자다. 거기 `<` 하나가 들어가면
/// 그 아래 표가 통째로 안 그려지고, 화면은 "매출이 없습니다" 처럼 보인다.
function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// 러스트에서 올라온 오류 글을 화면에 올리기 전에.
///
/// 🔴 오류는 **사장이 가장 겁먹은 순간**에만 뜬다. 그런데 여태 `String(e)` 로
///    그대로 올렸다 — 러스트 쪽 글은 전부 한국어라, 오사카 사장은 무슨 일이
///    났는지 영영 몰랐다. 사전을 한 번 거친다. 사전에 없으면 한국어 그대로다.
///
/// `alert()` 같은 브라우저 창은 `translateDom` 이 손댈 수 없다. 잘라 쓰는
/// 곳(`.slice()`)도 마찬가지다 — 자른 뒤에는 열쇠와 안 맞는다. 그래서
/// **화면에 올리기 전에** 여기서 옮긴다.
function errText(e: unknown): string {
  return t(String(e).trim());
}

function fmtQty(n: number): string {
  // 정수면 소수점을 붙이지 않는다. 고유 자산이 "1.00000000"으로 보이면
  // 이게 하나뿐인 물건이라는 사실이 숫자 뒤에 숨는다.
  if (Number.isInteger(n)) return n.toLocaleString();
  return String(parseFloat(n.toFixed(8)));
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

/** "방금", "3분 전" — an age reads as liveness in a way a timestamp does not. */
function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function fmtRemaining(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `약 ${s}초 남음`;
  return `약 ${Math.round(s / 60)}분 남음`;
}


function badge(a: Asset): string {
  const cid = a.ipfs_hash;
  if (!cid) return '<span class="muted">파일 없음</span>';
  if (pinned.has(cid)) return '<span class="ok">보존 중</span>';
  const s = health.get(cid) ?? "unknown";
  if (s === "found") return '<span class="warn">이 컴퓨터에 없음</span>';
  if (s === "missing") return '<span class="muted">찾지 못함</span>';
  if (s === "checking") return '<span class="muted">확인 중…</span>';
  return '<span class="muted">미확인</span>';
}

function renderList() {
  const rows = [...assets.values()];
  const withFile = rows.filter((a) => a.ipfs_hash);
  const savable = withFile.filter((a) => health.get(a.ipfs_hash!) === "found" && !pinned.has(a.ipfs_hash!));

  $("summary").textContent =
    `자산 ${rows.length}개 · 파일 있음 ${withFile.length}개 · 보존 중 ${withFile.filter(a => pinned.has(a.ipfs_hash!)).length}개`;

  const scanBtn = $("scan") as HTMLButtonElement;
  if (scan.running) {
    scanBtn.textContent = `${scan.done}/${scan.total} · 중지`;
    scanBtn.className = "";
    const avg = scan.ms.length ? scan.ms.reduce((x, y) => x + y, 0) / scan.ms.length : 0;
    $("scan-note").textContent = scan.current
      ? `${scan.current} 확인 중 · ${fmtRemaining(avg * (scan.total - scan.done))}`
      : "";
  } else {
    scanBtn.textContent = "다시 확인";
    scanBtn.className = "ghost";
    $("scan-note").textContent = "";
  }

  const pinBtn = $("pin-all") as HTMLButtonElement;
  pinBtn.disabled = savable.length === 0;
  pinBtn.textContent = savable.length ? `${savable.length}개 보존하기` : "보존할 항목 없음";

  // 내가 만든 것 / 남이 보낸 것. 아무나 아무 주소로 자산을 보낼 수 있으니
  // 지갑에는 부탁한 적 없는 토큰이 쌓인다. 그것들이 내가 만든 것과 같은
  // 줄에 섞여 있으면 목록 전체를 못 믿게 된다.
  const selling = new Set(offers.map((o) => o.asset));
  const shown = rows.filter((a) =>
    assetFilter === "all"
      ? true
      : assetFilter === "selling"
        ? selling.has(a.name)
        : a.mine === (assetFilter === "mine")
  );
  const mineCount = rows.filter((a) => a.mine).length;
  document.querySelectorAll<HTMLElement>("[data-afilter]").forEach((b) => {
    b.classList.toggle("on", b.dataset.afilter === assetFilter);
    const k = b.dataset.afilter!;
    const n =
      k === "all" ? rows.length
      : k === "mine" ? mineCount
      : k === "selling" ? selling.size
      : rows.length - mineCount;
    b.textContent = `${{ all: "전체", mine: "내가 만든 것", got: "받은 것", selling: "판매중" }[k]} ${n}`;
  });

  // 판매중 탭에서는 벤딩머신을 위로 올린다. 목록 아래에 숨어 있으면
  // "지금 무엇이 팔리는 중인가"를 매번 찾아 내려가야 한다.
  const vend = $("vend-wrap");
  vend.style.display = assetFilter === "selling" || offers.length ? "" : "none";
  vend.style.order = assetFilter === "selling" ? "-1" : "";
  if (assetFilter === "selling" && !offers.length) {
    $("vd-sales").innerHTML =
      `<div class="meta" style="padding:14px 0">아직 내놓은 자산이 없습니다.
        자산을 눌러 <b>팔기</b>를 고르면 여기에 나옵니다.</div>`;
  }

  /**
   * 「이 이름의 주인」 딱지.
   *
   * 🔴 소유권 토큰(`PLAYX!`)은 목록에서 **일부러 숨긴다** — 같은 이름이 두
   *    줄로 늘고 설명하는 게 없어서다(`raven.rs`). 그런데 숨기기만 하고
   *    **가졌다는 사실을 어디에도 안 적었다.** 대표님: "코어지갑에 내
   *    소유권 자산은 디자인이 다르게 나오는데 여기는 그냥 단순해서
   *    소유권인지 판단이 안 서네." 숨긴 것은 다른 자리에서 말해야 한다.
   *
   * ⚠️ 뜻을 딱지 하나에 다 못 담는다. 그래서 **눌러 보면 알게** 한다 —
   *    「주인」이 무엇을 할 수 있는 자리인지가 사람에겐 더 중요하다.
   */
  // 🔴 코어 지갑은 **그림**으로 표시한다(`assettablemodel.cpp` 의
  //    `asset_administrator` 아이콘). 대표님: "소유권이 있는 자산이라고
  //    그림에서 코어 지갑처럼 나오는거 아니였나?"
  //
  //    그림만 두지는 않는다 — 이름표 없는 아이콘은 40~70대에게 「저게 뭐지」다.
  //    **열쇠 그림 + 「주인」** 둘 다 둔다. 그림은 한눈에, 글자는 뜻으로.
  const ownMark = () =>
    `<span class="ownmark" title="${t(
      "이 이름의 주인입니다. 더 찍기·붙은 파일 바꾸기·가진 사람 전체에게 공지를 할 수 있습니다. 이 권한은 팔 수 없습니다.",
    )}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 19 4"/><path d="M17 6l2 2"/>` +
    `<path d="M14.5 8.5l2 2"/></svg>${t("주인")}</span>`;

  /**
   * 이 자산이 **무엇을 못 하는지**를 적는다.
   *
   * 🔴 코어 지갑은 단위(`units`)를 들고 있는데 우리는 안 들고 있었다. 그래서
   *    `SHOP.PLAYX` 가 **1개·쪼갤 수 없음**으로 찍혀서 손님에게 나눠 줄 수
   *    없다는 사실이 **화면 어디에도 없었다.** 팔로우가 왜 성립 안 하는지
   *    사장이 알 길이 없었다.
   *
   * ⚠️ 할 수 있는 것은 안 적는다. 「쪼갤 수 있음」을 모든 줄에 달면 그건
   *    벽지다. **막힌 것만** 적는다 — 그게 사장이 알아야 하는 것이다.
   *
   * ⚠️ 모르는 것(`null`)은 아무것도 안 적는다. 못 읽은 것을 「쪼갤 수 없음」
   *    으로 그리면 없는 사실을 만들어 내는 것이다.
   */
  const limitMarks = (a: Asset) => {
    const out: string[] = [];
    if (a.units === 0) {
      out.push(
        `<span class="limitmark" title="${t(
          "1개 단위로만 오갑니다. 손님에게 조금씩 나눠 줄 수 없어서 팔로우 토큰으로는 못 씁니다. 바꾸려면 재발행(100 RVN)입니다.",
        )}">${t("쪼갤 수 없음")}</span>`,
      );
    }
    if (a.reissuable === false) {
      out.push(
        `<span class="limitmark warn" title="${t(
          "더 찍을 수도, 붙은 파일을 바꿀 수도 없습니다. 되돌릴 방법이 없습니다.",
        )}">${t("바꿀 수 없음")}</span>`,
      );
    }
    return out.join("");
  };

  // 트리. PLAYX / PLAYX/MUSIC / PLAYX#tag 는 한 집안이다.
  const groups = new Map<string, Asset[]>();
  for (const a of shown) {
    if (!groups.has(a.root)) groups.set(a.root, []);
    groups.get(a.root)!.push(a);
  }

  const rowHtml = (a: Asset, child: boolean) => {
    const cid = a.ipfs_hash;
    const canSave = cid && health.get(cid) === "found" && !pinned.has(cid);
    // Viewing and preserving are separate gestures on purpose. If one click
    // could mean either, every click needs a moment of thought first.
    const act = canSave
      ? `<button data-pin="${cid}">보존</button>`
      : cid && pinned.has(cid)
        ? `<button data-unpin="${cid}" class="ghost">해제</button>`
        : "";
    // 자식 행은 전체 이름 대신 잎만 보여준다. 앞부분이 폴더 이름에 이미 있다.
    //
    // 🔴 그런데 **집안의 본체**(`PLAYX` 자신)는 앞부분을 지우고 나면 아무것도
    //    안 남는다. 그래서 이름이 빈 줄이 하나 있었고, 하필 그 줄에 제일 큰
    //    숫자(209억)가 붙어 있었다 — 「뭐가 뭔지 헷갈린다」의 정체가 이것이다.
    //    이름 없는 줄은 사람에게 고장으로 읽힌다.
    const leaf = child ? a.name.slice(a.root.length).replace(/^[/#]/, "") : a.name;
    const label = leaf || `${a.name}<span class="selfmark">이 이름 자체</span>`;
    // 🔴 **주인 표시.** 자식 줄에는 안 붙인다 — 집안 전체가 같은 값이라
    //    스무 줄에 같은 딱지가 스무 개 뜬다. 그건 정보가 아니라 벽지다.
    //    집안 머리글(아래)과 홑줄에만 붙는다.
    const own = !child && a.mine ? ownMark() : "";
    // 막힌 것은 **자식 줄에도** 적는다. 단위·재발행은 자산마다 다르다 —
    // 집안이 같다고 같은 값이 아니다(주인 표시와 다른 점이 여기다).
    const limits = limitMarks(a);
    return `<tr data-row="${a.name}" class="${selected === a.name ? "sel" : ""}${child ? " child" : ""}">
      <td class="name">${child ? '<span class="branch"></span>' : ""}${label}${own}${limits}</td>
      <td class="num">${fmtQty(a.amount)}</td>
      <td>${badge(a)}</td>
      <td class="act">${act}</td>
    </tr>`;
  };

  $("assets").innerHTML = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([root, list]) => {
      if (list.length === 1) return rowHtml(list[0], false);
      const open = !collapsed.has(root);
      // 접힌 폴더 안의 자산이 사라진 것처럼 보이면 안 된다. 개수를 항상 적는다.
      // 🔴 개수를 **수량 칸에 넣으면 안 된다.** 그 칸의 다른 줄은 전부
      //    「이 자산을 몇 개 가지고 있나」인데, 제목 줄만 「몇 종류인가」였다.
      //    한 칸에 두 가지 뜻이 있으면 사람은 둘 다 못 믿는다 — 실제로
      //    「PLAYX 자산이 여기 19개 있다는 건가?」라는 질문이 나왔다.
      //    개수는 이름 옆으로 옮기고, 단위도 「개」가 아니라 「종류」라고 쓴다.
      const head = `<tr class="grp" data-grp="${root}">
        <td class="name"><span class="tri ${open ? "open" : ""}"></span>${root}<span class="cnt">${list.length}종류</span>${
          list.some((a) => a.mine) ? ownMark() : ""
        }</td>
        <td class="num"></td>
        <td colspan="2"></td>
      </tr>`;
      return head + (open ? list.map((a) => rowHtml(a, true)).join("") : "");
    })
    .join("") || `<tr><td colspan="4" class="muted">해당하는 자산이 없습니다.</td></tr>`;

  document.querySelectorAll<HTMLElement>("[data-grp]").forEach((tr) => {
    tr.onclick = () => {
      const g = tr.dataset.grp!;
      collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g);
      renderList();
    };
  });

  document.querySelectorAll<HTMLElement>("[data-row]").forEach((tr) => {
    tr.onclick = (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      select(tr.dataset.row!);
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pin]").forEach((b) => {
    b.onclick = async (e) => { e.stopPropagation(); await pinOne(b.dataset.pin!, b); };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-unpin]").forEach((b) => {
    b.onclick = async (e) => { e.stopPropagation(); await unpinOne(b.dataset.unpin!, b); };
  });
}

async function pinOne(cid: string, btn?: HTMLButtonElement) {
  if (btn) { btn.disabled = true; btn.textContent = "보존 중…"; }
  try {
    await invoke("pin_add", { cid });
    pinned.add(cid);
  } catch (e) {
    say(t("보존하지 못했습니다"), errText(e));
  }
  renderList();
  if (selected) renderPanel();
}

async function unpinOne(cid: string, btn?: HTMLButtonElement) {
  /* 🔴 대표님 지적: "자산에서도 IPFS 이미지를 너무 쉽게 지우면 안 되지 않나?
     내가 만든 자산의 핀을 삭제하면 내용이 없어져 버리잖아."

     맞다. 남이 만든 자산이면 다른 사람도 갖고 있을 수 있지만, **내가 만든
     자산은 이 컴퓨터가 마지막 한 부일 수 있다.** 그때 핀을 지우면 그 자산의
     그림·음악이 세상에서 사라진다. 되돌릴 방법이 없다.

     그래서 내가 만든 것이면 **자산 이름을 직접 치게** 한다. 500 RVN 을 태울
     때 쓰는 것과 같은 문턱이다 — 되돌릴 수 없다는 점이 같기 때문이다. */
  // 🔴 `rows` 는 renderList 안의 지역 변수다. 여기서는 원본 맵을 본다 —
  //    짐작으로 이름을 갖다 쓰면 조용히 `undefined` 가 되고, 그러면
  //    **내가 만든 자산도 그냥 지워진다.**
  const owner = [...assets.values()].find((a) => a.ipfs_hash === cid && a.mine);
  if (owner) {
    const typed = await ask(
      "내가 만든 자산의 파일입니다",
      `이 컴퓨터가 마지막 사본일 수 있습니다. 지우면 「${owner.name}」의 파일이 ` +
        `세상에서 사라지고, 되돌릴 방법이 없습니다.\n\n` +
        `정말 지우시려면 자산 이름을 그대로 입력하세요.`,
      { ok: "지웁니다" },
    );
    if (typed?.trim() !== owner.name) return;
  } else if (!(await sure("보존을 해제할까요?", "이 컴퓨터에서 사본이 사라집니다. 다른 곳에 사본이 없으면 되찾을 수 없습니다.", "해제합니다"))) {
    return;
  }
  if (btn) btn.disabled = true;
  try {
    await invoke("pin_remove", { cid });
    pinned.delete(cid);
  } catch (e) {
    say(t("해제하지 못했습니다"), errText(e));
  }
  renderList();
  if (selected) renderPanel();
}

/**
 * 주인만 쓰는 단추 둘(공지·나눠주기)을 묶는다.
 *
 * 🔴 **두 곳에서 그리므로 묶는 것도 한 곳이어야 한다.** 자산에 붙은 파일이
 *    있으면 아래쪽에서, 없으면 위쪽 갈래에서 그린다. 손잡이를 양쪽에
 *    복사해 두면 한쪽만 고치는 날이 오고, 그날 단추는 보이는데 눌러도
 *    아무 일이 안 난다 — 이 저장소가 제일 자주 걸리는 병이다.
 */
function wireOwnerButtons(a: Asset) {
  const noticeBtn = document.getElementById("p-notice");
  if (noticeBtn)
    noticeBtn.onclick = async () => {
      showPage("msg");
      mtab("send");
      await loadChannels();
      const sel = $("nt-ch") as HTMLSelectElement;
      // 고른 자산이 채널 목록에 있으면 그것으로 맞춰 준다.
      if ([...sel.options].some((o) => o.value === a.root)) sel.value = a.root;
    };

  const rewardBtn = document.getElementById("p-reward");
  if (rewardBtn)
    rewardBtn.onclick = () => {
      showPage("reward");
      // 🔴 고른 자산을 채워 준다. 안 채우면 방금 고른 것을 **다시 타이핑**해야
      //    하고, 자산 이름은 길고 대소문자가 있어서 틀리기 쉽다.
      //    집안의 뿌리로 채운다 — 배당은 뿌리 단위로 하는 일이다.
      const box = document.getElementById("rw-asset") as HTMLInputElement | null;
      if (box) {
        box.value = a.root;
        // 값을 넣기만 하면 화면이 모른다. 사람이 친 것과 같게 알린다.
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
}

/** 「서로 파일 지켜 주기」 두 단추. 화면을 다시 그릴 때마다 새로 묶는다. */
function bindPeerHelp() {
  const say = (m: string, kind: "" | "err" | "ok" = "") => {
    const el = document.getElementById("pn-say");
    if (el) { el.textContent = m; el.className = "msg" + (kind ? " " + kind : ""); }
  };
  const 결과 = (r: any) => {
    const p = (r?.pinned || []).length, f = (r?.failed || []).length;
    // 숫자만 말하지 않는다 — 「12개 보관 중」은 확인할 수가 없다.
    const 이름 = (r?.pinned || []).map((x: any) => x.asset).slice(0, 6).join(" · ");
    return f
      ? `${p}개를 지킵니다. ${f}개는 못 받았습니다 — 그 파일을 든 컴퓨터가 꺼져 있을 수 있습니다.`
      : p
        ? `${p}개를 이 컴퓨터가 지킵니다${이름 ? " — " + 이름 : ""}.`
        : String(r?.note || "지킬 파일이 없습니다.");
  };
  const 누르면 = (id: string, run: () => Promise<any>, 중: string) => {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true;
      const 옛 = b.textContent;
      b.textContent = 중;
      try { say(결과(await run()), "ok"); }
      catch (e: any) { say(String(e?.message || e), "err"); }
      finally { b.disabled = false; b.textContent = 옛; }
    };
  };
  누르면("pn-mine", () => invoke<any>("pin_my_assets"), t("지키는 중…"));
  누르면(
    "pn-help",
    () => {
      const url = (document.getElementById("pn-url") as HTMLInputElement | null)?.value.trim() || "";
      if (!url) throw new Error("그 컴퓨터의 주소를 적어 주세요.");
      return invoke<any>("peer_help", { url });
    },
    t("받는 중…"),
  );
}

async function renderPanel() {
  const a = selected ? assets.get(selected) : null;
  if (!a) { $("panel").className = "panel hidden"; return; }
  $("panel").className = "panel";
  $("p-name").textContent = a.name;
  $("p-amount").textContent = `수량 ${fmtQty(a.amount)}`;

  const cid = a.ipfs_hash;
  if (!cid) {
    $("p-cid").textContent = "";
    $("p-body").innerHTML = '<p class="muted">이 자산에는 연결된 파일이 없습니다.</p>';
    // 🔴 **여기서 일찍 돌아간다.** 그래서 아래에 있는 단추들(공지·나눠주기)이
    //    **파일 없는 자산에는 하나도 안 나왔다.** 그런데 그 둘은 파일과
    //    아무 상관이 없다 — 자산을 가진 사람에게 보내는 일이다.
    //
    //    실제로 `PLAYX` 가 그 상태였다. 파일이 없어서 「나눠주기」를 넣어
    //    놓고도 **정작 그 자산에서는 안 보였다.** 대표님이 "아까 자산에서
    //    나눠주기는 어디 갔어?" 하고 물으신 것이 이것이다.
    $("p-actions").innerHTML =
      `<button id="p-send">보내기</button>` +
      (a.amount > 0 ? `<button class="ghost" id="p-sell">팔기</button>` : "") +
      (a.mine ? `<button class="ghost" id="p-notice">공지 보내기</button>` : "") +
      (a.mine ? `<button class="ghost" id="p-reward">나눠주기</button>` : "");
    const sb = document.getElementById("p-send");
    if (sb) sb.onclick = () => { showPage("wallet"); openSend("asset", a.name); };
    const lb = document.getElementById("p-sell");
    if (lb) lb.onclick = () => openSell(a);
    wireOwnerButtons(a);
    return;
  }

  $("p-cid").innerHTML = `<code>${cid.slice(0, 10)}…${cid.slice(-6)}</code> <button class="link" id="copy-cid">복사</button>`;
  $("copy-cid").onclick = () => navigator.clipboard.writeText(cid);
  $("p-body").innerHTML = '<p class="muted">파일을 확인하는 중…</p>';
  $("p-actions").innerHTML = "";

  let kind: any;
  try {
    kind = await invoke("content_kind", { cid });
  } catch {
    $("p-body").innerHTML = '<p class="muted">로컬 IPFS가 꺼져 있어 이 컴퓨터에서 열 수 없습니다.</p>';
    return;
  }
  if (selected !== a.name) return; // 사용자가 그 사이 다른 행을 골랐다

  if (!kind.available) {
    $("p-body").innerHTML =
      '<p class="muted">지금은 이 파일을 찾지 못했습니다. 나중에 다시 나타날 수 있습니다.</p>';
  } else if (kind.is_image) {
    // Seeing the image is what makes someone press 보존. Text cannot do that.
    $("p-body").innerHTML = `<img src="${kind.url}" alt="" />
      <p class="meta">${kind.mime}${kind.size ? " · " + fmtBytes(kind.size) : ""}</p>`;
  } else if (kind.is_video) {
    // The local gateway answers range requests, so this streams and seeks
    // instead of downloading the whole file before the first frame. Not
    // autoplaying: a wallet that starts making noise when you click a row is a
    // wallet you stop clicking rows in.
    $("p-body").innerHTML = `<video src="${kind.url}" controls preload="metadata"
        playsinline style="width:100%;border-radius:8px;background:#000"></video>
      <p class="meta">${kind.mime}${kind.size ? " · " + fmtBytes(kind.size) : ""}</p>`;
  } else if (kind.is_audio) {
    $("p-body").innerHTML = `<audio src="${kind.url}" controls preload="metadata"
        style="width:100%"></audio>
      <p class="meta">${kind.mime}${kind.size ? " · " + fmtBytes(kind.size) : ""}</p>`;
  } else if (kind.is_dir) {
    // One CID, several files. Show the picture if there is one, then the list —
    // a 3D model with a preview.png should look like its preview, not like a
    // folder icon.
    const entries: any[] = kind.entries || [];
    const pick = (re: RegExp) => entries.find((e) => re.test(e.name || ""));
    const cover =
      pick(/^(preview|thumb(nail)?|cover|icon|image)\.(png|jpe?g|webp|gif)$/i) ||
      pick(/\.(png|jpe?g|webp|gif)$/i);

    $("p-body").innerHTML =
      (cover ? `<img src="${kind.url}/${encodeURIComponent(cover.name)}" alt="" />` : "") +
      `<p class="meta">파일 ${entries.length}개</p>` +
      `<div class="dirlist">${entries
        .map(
          (e) =>
            `<div class="direntry"><span>${e.is_dir ? "폴더 " : ""}${e.name}</span>` +
            `<span class="meta">${e.size ? fmtBytes(e.size) : ""}</span></div>`
        )
        .join("")}</div>`;
  } else if (kind.metadata) {
    // RIP-0014: a JSON file describing the asset. Rendered as what it says, not
    // as raw JSON. Korean first where the issuer provided it.
    const meta: any = await invoke("read_metadata", { doc: kind.metadata, lang: "ko" }).catch(
      () => null
    );
    if (meta) {
      $("p-body").innerHTML =
        (meta.icon ? `<img src="${meta.icon}" alt="" />` : "") +
        (meta.name ? `<div style="font-size:15px;font-weight:600;margin-top:8px">${meta.name}</div>` : "") +
        (meta.description ? `<p class="meta" style="line-height:1.7">${meta.description}</p>` : "") +
        (meta.issuer ? `<div class="kv"><b>발행자</b><span>${meta.issuer}</span></div>` : "") +
        (meta.website ? `<div class="kv"><b>웹사이트</b><span>${meta.website}</span></div>` : "") +
        // 🔴 붙여 놓고 안 보여 주면 붙인 뜻이 없다. 이 저장소의 그 병이다.
        videoEmbed(String(meta.video_url || meta.videoUrl || "")) +
        `<p class="meta">RIP-0014 메타데이터</p>`;
    } else {
      $("p-body").innerHTML = `<p class="muted">메타데이터를 읽을 수 없습니다.</p>`;
    }
  } else if (kind.is_pdf) {
    // Shown inside a sandboxed frame: no scripts, no forms, no popups, no
    // navigation. The document is drawn and nothing else. Anyone can put a file
    // behind an asset's hash, so it is displayed but never trusted.
    $("p-body").innerHTML = `<iframe class="doc" src="${kind.url}#toolbar=0"
        sandbox referrerpolicy="no-referrer"></iframe>
      <p class="meta">PDF${kind.size ? " · " + fmtBytes(kind.size) : ""}</p>`;
  } else {
    // Everything else goes to the OS viewer rather than a renderer we would have
    // to keep safe ourselves.
    $("p-body").innerHTML = `<div class="filecard">
        <div class="ft">${(kind.mime || "파일").replace("application/", "")}</div>
        <p class="meta">${kind.size ? fmtBytes(kind.size) : ""}</p>
      </div>`;
  }

  const buttons: string[] = [];
  // 동사는 자산을 고른 뒤에만 나온다. 목록에는 보내는 버튼이 없다.
  buttons.push(`<button id="p-send">보내기</button>`);
  if (a.amount > 0) buttons.push(`<button class="ghost" id="p-sell">팔기</button>`);
  // 공지는 이 자산을 가진 사람에게 간다. 자산의 동사지 가게의 동사가 아니다 —
  // 다만 가게 탭에서도 같은 화면으로 들어갈 수 있게 링크를 남겼다.
  if (a.mine) buttons.push(`<button class="ghost" id="p-notice">공지 보내기</button>`);
  // 🔴 **나눠주기도 자산의 동사다.** 바로 위 주석이 공지에 대해 정한 규칙이
  //    그대로 적용된다 — 그런데 나눠주기만 1차 메뉴에 혼자 남아 있었다.
  //    대표님: "그럼 나눠주기가 자산 탭 안에 들어가야 하는거 아냐?"
  //
  //    나눠주기는 **언제나 자산 하나를 고르는 것으로 시작**한다. 고른 자산이
  //    이미 여기 있는데 다시 이름을 타이핑하게 하는 것은 같은 일을 두 번
  //    시키는 것이다. 화면은 그대로 두고(옛 길을 끊지 않는다) 여기서 들어가는
  //    문을 낸다 — 공지가 가게 탭에 링크를 남긴 것과 같다.
  if (a.mine) buttons.push(`<button class="ghost" id="p-reward">나눠주기</button>`);
  if (kind.available) buttons.push(`<button class="ghost" id="open-ext">이 컴퓨터에서 열기</button>`);
  if (pinned.has(cid)) buttons.push(`<button class="ghost" id="p-unpin">보존 해제</button>`);
  else if (health.get(cid) === "found") buttons.push(`<button id="p-pin">보존</button>`);
  $("p-actions").innerHTML = buttons.join("");

  const ext = document.getElementById("open-ext");
  if (ext)
    ext.onclick = async () => {
      try {
        await invoke("open_external", { url: kind.url });
      } catch (e) {
        // Swallowing this is what made the button look dead. If the OS refuses,
        // leave the user something they can act on.
        await navigator.clipboard.writeText(kind.url).catch(() => {});
        say("이 컴퓨터에서 열지 못했습니다", `주소를 복사했습니다.\n\n${kind.url}\n\n${e}`);
      }
    };
  const sendBtn = document.getElementById("p-send");
  if (sendBtn) sendBtn.onclick = () => { showPage("wallet"); openSend("asset", a.name); };
  const sellBtn = document.getElementById("p-sell");
  if (sellBtn) sellBtn.onclick = () => openSell(a);
  wireOwnerButtons(a);

  const pin = document.getElementById("p-pin");
  if (pin) pin.onclick = () => pinOne(cid);
  const unpin = document.getElementById("p-unpin");
  if (unpin) unpin.onclick = () => unpinOne(cid);
}

function select(name: string) {
  selected = selected === name ? null : name;
  renderList();
  renderPanel();
}

/// 발행권이 이 컴퓨터에 있는지. 있으면 숨기지 않고 맨 위에 적는다 —
/// 잃는 것이 오늘 재고가 아니라 그 자산의 미래 전부이기 때문이다.
async function checkOwnerTokens() {
  try {
    const owned = await invoke<string[]>("owner_tokens");
    if (!owned.length) {
      $("owner-warn").style.display = "none";
      return;
    }
    $("owner-warn").style.display = "";
    $("owner-warn").innerHTML =
      `<b>소유권 토큰이 이 컴퓨터에 있습니다 — ${owned.join(", ")}</b><br />
       이 컴퓨터가 털리면 재고뿐 아니라 <b>이 자산을 무한히 찍고 설명을 바꿀 권리</b>까지 넘어갑니다.
       파는 것과 발행하는 것은 다른 지갑이어야 합니다.<br />
       그래서 이것이 여기 있는 동안 <b>자동 판매를 켤 수 없습니다.</b>`;
  } catch {}
}

async function loadAssets(thenScan = true) {
  $("summary").textContent = "자산을 불러오는 중…";
  try {
    const list = await invoke<Asset[]>("list_assets");
    assets.clear();
    list.forEach((a) => assets.set(a.name, a));
    pinned = new Set(await invoke<string[]>("pin_list"));
    checkOwnerTokens();
    renderList();
    if (thenScan) startScan();
  } catch (e) {
    $("summary").textContent = errText(e);
  }
}

/** Runs by itself when the list loads. Checking is the reason the app exists;
 *  making the user press a button first only postpones the answer. */
async function startScan() {
  if (scan.running) { scan.stop = true; return; }

  const targets = [...assets.values()]
    .filter((a) => a.ipfs_hash && !pinned.has(a.ipfs_hash))   // 보존 중인 건 물어볼 필요가 없다
    .filter((a) => health.get(a.ipfs_hash!) !== "found")
    .map((a) => ({ name: a.name, cid: a.ipfs_hash! }));

  if (!targets.length) { renderList(); return; }

  scan = { running: true, done: 0, total: targets.length, current: "", stop: false, ms: [] };
  $("privacy-note").className = "privacy";
  renderList();

  for (const t of targets) {
    if (scan.stop) break;
    scan.current = t.name;
    health.set(t.cid, "checking");
    renderList();

    const t0 = performance.now();
    try {
      const found = await invoke<boolean>("check_alive", { cid: t.cid, timeoutSecs: 20 });
      health.set(t.cid, found ? "found" : "missing");
    } catch {
      health.set(t.cid, "missing");
    }
    scan.ms.push(performance.now() - t0);
    scan.done++;
    saveHealth();
    renderList();
    if (selected) renderPanel();
  }

  scan.running = false;
  scan.current = "";
  renderList();
}

async function pinAll() {
  const targets = [...assets.values()]
    .filter((a) => a.ipfs_hash && health.get(a.ipfs_hash) === "found" && !pinned.has(a.ipfs_hash))
    .map((a) => a.ipfs_hash!);
  for (const cid of targets) {
    try { await invoke("pin_add", { cid }); pinned.add(cid); renderList(); } catch {}
  }
}

/* ── 화면 전환 ───────────────────────────────────────────────
   Sections are separate because they carry different risk, not to be tidy.
   The asset view cannot spend anything; wallet, issue and shop can.        */
/* ── 묻는 창 ────────────────────────────────────────────────────────
   `prompt`·`confirm`·`alert` 는 이 앱에서 동작하지 않는다. WKWebView 는 앱이
   델리게이트를 붙여 주어야 이 창들을 그리는데 Tauri 는 붙이지 않는다. 그래서
   호출은 성공한 것처럼 즉시 null 을 돌려주고, 화면에서는 버튼이 고장난 것처럼
   보인다 — 지갑 암호를 묻는 자리 다섯 곳이 그렇게 죽어 있었다.

   그래서 직접 그린다. 세 가지만 있으면 된다. */

let askResolve: ((v: string | null) => void) | null = null;

function askClose(v: string | null) {
  $("askwrap").classList.remove("on");
  const r = askResolve;
  askResolve = null;
  r?.(v);
}

/// 한 줄 물어보고 답을 받는다. 취소하면 null.
function ask(
  title: string,
  message = "",
  opts: { value?: string; password?: boolean; numeric?: boolean; ok?: string } = {}
): Promise<string | null> {
  $("ask-title").textContent = title;
  $("ask-msg").textContent = message;
  const input = $("ask-input") as HTMLInputElement;
  input.style.display = "";
  input.type = opts.password ? "password" : opts.numeric ? "number" : "text";
  input.value = opts.value ?? "";
  ($("ask-yes") as HTMLButtonElement).textContent = opts.ok ?? "확인";
  $("ask-no").style.display = "";
  $("askwrap").classList.add("on");
  // 열자마자 칠 수 있어야 한다. 칸을 찾아 누르게 하면 그만큼 느려진다.
  setTimeout(() => input.focus(), 30);
  return new Promise((res) => (askResolve = res));
}

/// 예/아니오만. 예면 true.
function sure(title: string, message = "", ok = "네"): Promise<boolean> {
  $("ask-title").textContent = title;
  $("ask-msg").textContent = message;
  $("ask-input").style.display = "none";
  ($("ask-yes") as HTMLButtonElement).textContent = ok;
  $("ask-no").style.display = "";
  $("askwrap").classList.add("on");
  return new Promise((res) => (askResolve = (v) => res(v !== null)));
}

/// 알리기만. 되돌릴 것이 없을 때.
function say(title: string, message = ""): Promise<unknown> {
  $("ask-title").textContent = title;
  $("ask-msg").textContent = message;
  $("ask-input").style.display = "none";
  ($("ask-yes") as HTMLButtonElement).textContent = "알겠습니다";
  $("ask-no").style.display = "none";
  $("askwrap").classList.add("on");
  return new Promise((res) => (askResolve = () => res(null)));
}


/* ── 이 노드가 어디인지 · 인터넷 · 되돌리기 ─────────────────────────
   전부 Rust 쪽에만 있던 것들이다. 안 보이는 기능은 없는 기능이다. */

async function loadNode() {
  try {
    const n: any = await invoke("node_identity");
    ($("nd-name") as HTMLInputElement).value = n.name || "";
    $("nd-note").textContent = `번호 ${n.id} — 이 컴퓨터에 고정입니다`;
  } catch {}
}

async function saveNode() {
  const name = ($("nd-name") as HTMLInputElement).value;
  try {
    await invoke("node_rename", { name });
    $("nd-note").textContent = "저장했습니다";
    setTimeout(loadNode, 1200);
  } catch (e) {
    $("nd-note").textContent = errText(e);
  }
}

/* ══ 내 이름 ═══════════════════════════════════════════════════════════
   「이 컴퓨터」 화면의 `#idcard`. 폰(웹 지갑)의 나와 이 컴퓨터의 나가
   **같은 사람인가**를 보여 주고, 하나로 합치거나 옛 이름으로 되돌린다.

   🔴 이 화면의 값어치는 「합치기」 단추가 아니라 **갈라진 것을 보여 주는
      데** 있다. `identity.rs` 머리말이 그렇게 적어 놓았다 — 조용히 이름이
      바뀌는 것이 제일 나쁘고, 그다음이 **갈라진 줄 모르는 것**이다.

   🔴 그래서 셋을 정직하게 갈라 말한다:
        · 12단어를 못 읽었다   → 열쇠가 없는 게 아니라 **모르는 것**이다
        · 이름이 아직 없다     → 처음 글을 쓸 때 생긴다
        · 무작위로 만들어졌다  → **12단어로는 되살릴 수 없다**
      셋 다 러스트의 `advice` 한 문장에 들어 있어서, 우리는 그대로 띄운다. */

/** 열쇠 한 줄. 64자라 접어서 보여 주고, 전체는 그 밑에 작게 둔다. */
function idKeyRow(label: string, pk: unknown, note: string): string {
  const k = typeof pk === "string" && pk.trim() ? pk.trim() : "";
  if (!k) {
    return `<div class="kv"><b>${escapeHtml(label)}</b><span>${escapeHtml(note)}</span></div>`;
  }
  // 앞 8자만 봐도 다른 이름인지는 안다. 64자를 눈으로 다 맞출 사람은 없다.
  return (
    `<div class="kv" style="align-items:flex-start"><b>${escapeHtml(label)}</b>` +
    `<span><code style="font-size:15px">${escapeHtml(k.slice(0, 8))}…${escapeHtml(k.slice(-4))}</code>` +
    (note ? ` — ${escapeHtml(note)}` : "") +
    `<code class="idkey">${escapeHtml(k)}</code></span></div>`
  );
}

/** `talk::key_on_disk` 의 `from` 을 사람 말로. 셋 다 뜻이 아주 다르다. */
function idFromWord(from: unknown): string {
  const f = String(from ?? "");
  if (f === "seed") return t("12단어에서 나왔습니다");
  if (f === "none") return t("아직 이름이 없습니다");
  // 🔴 「무작위」를 얼버무리면 안 된다. 이 사람은 파일을 잃으면 끝이다.
  return t("무작위로 만들어졌습니다 — 12단어로는 되살릴 수 없습니다");
}

async function idLoad() {
  const body = $("id-body");
  const adopt = $("id-adopt");
  const legacy = $("id-legacy");
  // 다시 읽는 동안에는 단추를 감춘다. 옛 상태로 눌리면 안 된다.
  adopt.style.display = "none";
  legacy.style.display = "none";
  body.innerHTML = `<p class="meta">${t("읽는 중…")}</p>`;

  let s: any;
  try {
    s = await invoke<any>("identity_status");
  } catch (e) {
    body.innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
    return;
  }

  const nowPk = s?.now?.pubkey ?? null;
  const canon = s?.canonical?.pubkey ?? null;
  const leg = s?.legacy?.pubkey ?? null;
  const same = s?.same_as_wallet;

  // 한 줄 판정. 🔴 `null` 은 「다르다」가 아니라 「모른다」다 — 뭉뚱그리면
  //    12단어를 못 읽은 날 사장이 멀쩡한 이름을 바꾸려 든다.
  const verdict =
    same === true
      ? `<span class="ok">${t("이 컴퓨터와 폰·웹 지갑이 같은 사람입니다.")}</span>`
      : same === false
        ? `<span class="warn">${t("이 컴퓨터와 폰·웹 지갑이 다른 사람으로 보입니다.")}</span>`
        : `<span class="muted">${t("같은 사람인지 확인할 수 없습니다.")}</span>`;

  body.innerHTML =
    `<p style="font-size:15px;margin:10px 0 12px"><b>${verdict}</b></p>` +
    idKeyRow(t("이 컴퓨터"), nowPk, idFromWord(s?.now?.from)) +
    idKeyRow(t("폰 · 웹 지갑"), canon, t("12단어에서 나오는 이름")) +
    // 🔴 러스트의 `advice` 를 **그대로.** 무엇을 하면 되는지가 여기 들어 있다.
    (s?.advice ? `<p class="meta" style="margin-top:10px">${escapeHtml(String(s.advice))}</p>` : "") +
    // 12단어를 못 읽었으면 그 사실이 이 화면에서 제일 중요한 소식이다.
    (canon
      ? ""
      : `<div class="warnbox" style="margin-top:10px">
           <b>${t("12단어를 읽지 못했습니다.")}</b>
           ${t("지갑이 잠겨 있으면 열어 주세요. 12단어로 만든 지갑이 아니면, 이 이름은 백업 파일이 유일한 사본입니다 — 파일을 잃으면 이 이름으로 다시 못 돌아옵니다.")}
         </div>`) +
    // 옛 이름. 있고 지금 이름과 다를 때만 말한다.
    (leg && leg !== nowPk
      ? `<h3 class="grouphead">${t("옛 이름")}</h3>` +
        idKeyRow(t("옛 방식"), leg, "") +
        // 🔴 `history_why` 는 「글이 있다 / 없다 / 못 물어봤다」 셋을 갈라
        //    말한다. 릴레이가 잠깐 죽은 날 「없다」로 읽으면, 남의 글이
        //    붙어 있는 이름을 버려도 된다고 말하는 셈이 된다.
        (s?.legacy?.history_why
          ? `<p class="meta">${escapeHtml(String(s.legacy.history_why))}</p>`
          : "")
      : "") +
    // 가게 간판 열쇠. 이름을 합쳐도 **이건 안 따라온다** — 그 사실을 여기서 못 박는다.
    `<h3 class="grouphead">${t("가게 간판 열쇠")}</h3>` +
    (s?.shop?.exists
      ? `<p class="meta">${escapeHtml(String(s.shop.why ?? ""))}</p>`
      : `<p class="meta">${t("아직 가게 간판 열쇠가 없습니다.")}</p>`) +
    (s?.shop_note ? `<p class="meta">${escapeHtml(String(s.shop_note))}</p>` : "");

  // 단추는 **할 수 있을 때만** 보인다. 눌러도 「바꿀 것이 없습니다」만
  // 돌아오는 단추는 고장으로 읽힌다.
  if (canon && same !== true) adopt.style.display = "";
  if (leg && nowPk && leg !== nowPk) legacy.style.display = "";
}

/** 경로표. 「12단어 하나에서 무엇이 어디로 나오는가」를 사람이 읽고 확인한다. */
async function idPaths() {
  const box = $("id-pathbody");
  try {
    const p = await invoke<any>("identity_paths");
    const rows: any[] = Array.isArray(p?.rows) ? p.rows : [];
    box.innerHTML =
      `<p class="meta">${t("씨앗")} — ${escapeHtml(String(p?.seed ?? ""))}</p>` +
      rows
        .map(
          (r) =>
            `<div class="card" style="margin-top:8px">
               <b style="font-size:15px">${escapeHtml(String(r?.what ?? ""))}</b>
               <code class="idkey">${escapeHtml(String(r?.path ?? ""))}</code>
               <p class="meta">${escapeHtml(String(r?.who ?? ""))}</p>
               <p class="meta">${escapeHtml(String(r?.note ?? ""))}</p>
             </div>`,
        )
        .join("") +
      (p?.hardening ? `<p class="meta">${escapeHtml(String(p.hardening))}</p>` : "");
  } catch (e) {
    box.innerHTML = `<p class="meta"><span class="danger">${escapeHtml(errText(e))}</span></p>`;
  }
}

/**
 * **이름을 하나로 합친다.**
 *
 * 🔴 되돌리기 어려운 일이라 8초 확인창을 앞에 둔다(`holdBeforeDoing`).
 *    체크박스를 하나 더 두는 것과는 다르다 — 체크박스는 그냥 눌리고,
 *    여기서는 **시간이 흐르는 것을 보면서 아무것도 안 해야** 진행된다.
 *
 * 🔴 그리고 **무슨 일이 생기는지** 그 창에 적는다. 「정말 하시겠습니까?」만
 *    적어 두면 아무도 무엇을 잃는지 모른 채 누른다.
 */
async function idAdopt() {
  const ok = await holdBeforeDoing(
    t("이 컴퓨터의 이름을 폰·웹 지갑과 같은 이름으로 바꿉니다"),
    t(
      "① 지금 이름으로 쓴 글은 그 이름에 그대로 남습니다 — 새 이름으로 옮겨 오지 않습니다. " +
        "② 두 이름을 잇는 글(「같은 사람입니다」)을 양쪽 열쇠로 서명해 세계 릴레이에 올립니다. " +
        "한번 퍼진 글은 되거둘 수 없습니다. " +
        "③ 옛 열쇠 파일은 지우지 않고 talkkey-old-<시각>.json 으로 옆에 남깁니다. " +
        "④ 가게 간판 열쇠는 바뀌지 않습니다 — 그 공개키는 체인에 박혀 있습니다.",
    ),
  );
  if (!ok) return;
  const say = $("id-say");
  say.innerHTML = `<p class="meta">${t("바꾸는 중…")}</p>`;
  try {
    const r = await invoke<any>("identity_adopt_person_key");
    say.innerHTML =
      `<div class="card" style="margin-top:12px">
         <p style="margin:0;font-size:15px"><span class="ok">${t("이름을 합쳤습니다.")}</span></p>` +
      idKeyRow(t("새 이름"), r?.pubkey, "") +
      // 열쇠 파일이 아예 없던 경우에는 옛 이름이 없다. 없으면 빈 줄을 안 만든다.
      (r?.old_pubkey ? idKeyRow(t("옛 이름"), r.old_pubkey, "") : "") +
      `<p class="meta">${t("잇는 글")} ${Number(r?.linked ?? 0)}${t("개를 릴레이에 남겼습니다.")}</p>` +
      (r?.kept ? `<p class="meta">${escapeHtml(String(r.kept))}</p>` : "") +
      (r?.note ? `<p class="meta">${escapeHtml(String(r.note))}</p>` : "") +
      `</div>`;
    await idLoad();
    // 「이야기」 머리줄의 이름도 같이 바뀐다. 안 고치면 옛 이름이 남아 있다.
    void talkPaintMe();
  } catch (e) {
    say.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(errText(e))}</div>`;
  }
}

/** **옛 이름으로 되돌린다.** `talkkey.json` 을 잃고 12단어로만 돌아온 사람용. */
async function idLegacy() {
  const ok = await holdBeforeDoing(
    t("옛 방식으로 뽑은 예전 이름으로 되돌립니다"),
    t(
      "① 지금 이름으로 쓴 글은 지금 이름에 남습니다 — 옛 이름으로 옮겨 오지 않습니다. " +
        "② 되돌리고 나면 폰·웹 지갑에서는 이 컴퓨터가 **다른 사람**으로 보입니다. " +
        "③ 직전 열쇠 파일은 지우지 않고 talkkey-old-<시각>.json 으로 옆에 남깁니다. " +
        "④ 다시 합치시려면 「이름 합치기」를 누르시면 됩니다.",
    ),
  );
  if (!ok) return;
  const say = $("id-say");
  say.innerHTML = `<p class="meta">${t("되돌리는 중…")}</p>`;
  try {
    const r = await invoke<any>("identity_restore_legacy_key");
    say.innerHTML =
      `<div class="card" style="margin-top:12px">
         <p style="margin:0;font-size:15px"><span class="ok">${t("옛 이름으로 돌아왔습니다.")}</span></p>` +
      idKeyRow(t("지금 이름"), r?.pubkey, "") +
      (r?.kept ? `<p class="meta">${escapeHtml(String(r.kept))}</p>` : "") +
      (r?.note ? `<p class="meta">${escapeHtml(String(r.note))}</p>` : "") +
      `</div>`;
    await idLoad();
    void talkPaintMe();
  } catch (e) {
    say.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(errText(e))}</div>`;
  }
}

async function loadNet() {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  try {
    const n: any = await invoke("network_state");
    if (n.online) {
      // 잘 되고 있을 때는 조용히. 늘 떠 있는 배너는 아무도 안 읽는다.
      $("net-banner").innerHTML = "";
      return;
    }
    $("net-banner").innerHTML = `<div class="warnbox" style="margin-bottom:14px">
      <b>인터넷이 끊겼습니다.</b> ${n.advice}
      <div style="margin-top:8px">계속 됩니다 — ${(n.still_works || []).join(" · ")}</div>
      <div>멈췄습니다 — ${(n.stopped || []).join(" · ")}</div>
    </div>`;
  } catch {}
}

async function sampleFill(force = false) {
  $("sp-note").textContent = "만드는 중…";
  try {
    const r: any = await invoke("sample_fill", { nowUnix: nowSec(), force });
    $("sp-result").innerHTML =
      `<div class="card" style="margin-top:11px">
         <h3>시험용 가게를 만들었습니다</h3>
         <div class="kv"><b>메뉴 ${r.menu}개 · 회원 ${r.members}명 · 수업 ${r.sessions}개</b>
           <span>${r.note}</span></div>
         <p class="meta" style="margin-top:8px">이 순서로 눌러 보세요:</p>
         <ol style="margin:6px 0 0 18px;font-size:14px;line-height:1.9">
           ${(r.walk || []).map((x: string) => `<li>${x}</li>`).join("")}
         </ol>
       </div>`;
    loadShop();
  } catch (e) {
    // 진짜 회원 명단을 시험 데이터로 덮는 사고만은 막는다.
    const ok = await sure("이미 들어 있는 것이 있습니다", `${e}\n\n덮어쓸까요?`, "덮어씁니다");
    if (ok) return sampleFill(true);
    $("sp-result").innerHTML = "";
  }
  $("sp-note").textContent = "";
}

async function sampleClear() {
  try {
    const r: any = await invoke("sample_clear");
    const rows: any[] = r.removed || [];
    $("sp-result").innerHTML = rows.length
      ? `<div class="card" style="margin-top:11px"><h3>지웠습니다</h3>` +
        rows.map((x) => `<div class="kv"><b>${x.what}</b><span>${x.count}개</span></div>`).join("") +
        `<p class="meta">샘플 표시가 붙은 것만 지웠습니다. 그 사이에 넣으신 진짜 자료는 그대로입니다.</p></div>`
      : `<div class="card" style="margin-top:11px"><h3>지울 시험용 자료가 없습니다</h3></div>`;
    loadShop();
  } catch (e) {
    $("sp-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
  }
}

async function doRestore() {
  // 경로를 타이핑하게 하지 않는다. 이 파일 3,457행에 내가 직접 적어 둔 문장이
  // "폴더 경로를 타이핑하게 하는 것은 백업을 안 하게 하는 가장 확실한 방법"
  // 인데, 만들 때만 지키고 **되돌릴 때는 안 지키고 있었다.**
  // 파일 고르기는 OS 가 한다 — 사람은 파인더에서 눈으로 찾는 데 익숙하다.
  const where = await pickFile({
    title: "되돌릴 백업을 고르세요",
    multiple: false,
    directory: false,
    // 🔴 `zip` 만 적어 뒀더니, 잠근 백업(`.zip.pxlock`)이 **회색으로 뜨고
    //    「열기」가 안 눌렸다.** 백업은 만드는 것보다 **되돌리는 것**이 본업인데
    //    거르개 한 줄 때문에 되돌릴 수가 없었다. 만들 때 쓰는 이름을 바꾸면
    //    여는 쪽도 같이 바꿔야 한다 — 그걸 놓쳤다.
    //
    //    `잠김` 은 옛 이름이다. 이미 그렇게 만들어 둔 백업이 있으니 계속 받는다.
    filters: [
      { name: "PLAY X Raven 백업", extensions: ["pxlock", "zip", "잠김"] },
      { name: "모든 파일", extensions: ["*"] },
    ],
    defaultPath: undefined,
  }).catch(() => null);
  if (!where || typeof where !== "string") return;
  $("rs-result").innerHTML = `<div class="meta" style="margin-top:9px">읽는 중…</div>`;
  try {
    // 🔴 다른 컴퓨터에서 만든 백업은 **암호가 있어야** 열린다. 그런데 암호를
    //    칠 데가 없어서, 정작 백업이 필요한 그 상황에서 막혔다.
    //    같은 컴퓨터에서는 열쇠 파일로 바로 열리므로 안 물어본다.
    let rsPass = "";
    let r: any;
    try {
      r = await invoke("restore_survey", { folder: where, pass: null });
    } catch (e) {
      if (!String(e).includes("다른 컴퓨터")) throw e;
      const pw = await ask(
        "백업 암호",
        "이 백업은 다른 컴퓨터에서 만든 것입니다. 그때 정하신 암호를 넣어 주세요.",
        { password: true }
      );
      if (!pw) return;
      rsPass = pw;
      r = await invoke("restore_survey", { folder: where, pass: rsPass });
    }
    if (r.empty) {
      $("rs-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${r.note}</div>`;
      return;
    }
    // 무엇이 들어 있는지 먼저 눈으로 확인하게 한다. 되돌린 뒤에 알면 늦는다.
    $("rs-result").innerHTML =
      `<div class="card" style="margin-top:11px"><h3>${r.day} 백업</h3>` +
      r.items
        .map(
          (i: any) =>
            `<div class="kv"><b>${i.what} ${i.detail}</b><span>${i.why}</span></div>`
        )
        .join("") +
      `<p class="meta">${r.note}</p>
       <button id="rs-go" style="margin-top:10px">이대로 되돌리기</button></div>`;
    $("rs-go").addEventListener("click", async () => {
      const keys = r.items.map((i: any) => i.key);
      const ok = await sure(
        "되돌릴까요?",
        "지금 있는 것은 옆에 따로 남겨 둡니다.\n지갑을 되돌리려면 노드가 꺼져 있어야 합니다.",
        "되돌립니다"
      );
      if (!ok) return;
      const res: any = await invoke("restore_apply", {
        folder: where.trim(),
        keys,
        pass: rsPass || null,
      });
      $("rs-result").innerHTML =
        `<div class="card" style="margin-top:11px"><h3>되돌렸습니다</h3>` +
        (res.done || []).map((d: any) => `<div class="kv"><b>${d.what}</b><span>${d.note || "완료"}</span></div>`).join("") +
        ((res.failed || []).length
          ? `<div class="warnbox" style="margin-top:9px">` +
            res.failed.map((f: any) => `${f.what} — ${f.why}`).join("<br>") + `</div>`
          : "") +
        `<p class="meta">${res.note}</p></div>`;
    });
  } catch (e) {
    $("rs-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
  }
}

async function showCard() {
  try {
    const c: any = await invoke("recovery_card");
    $("rs-result").innerHTML =
      `<div class="card" style="margin-top:11px">
         <h3>복구 카드 — 인쇄해서 서랍에</h3>
         <div class="kv"><b>노드</b><span>${c.node?.name || "(이름 없음)"} · ${c.node?.id}</span></div>
         <div class="kv"><b>가게</b><span>${c.shop_name || "-"}</span></div>
         <div class="kv"><b>백업 위치</b><span>${c.backup_folder}</span></div>
         <ol style="margin:12px 0 0 18px;font-size:14px;line-height:1.9">
           ${(c.steps || []).map((x: string) => `<li>${x}</li>`).join("")}
         </ol>
         <div class="warnbox" style="margin-top:12px">
           ${(c.warnings || []).join("<br>")}
         </div>
         <button class="ghost" style="margin-top:10px" id="rs-print">인쇄할 파일 만들기</button>
         <div class="meta" id="rs-printnote" style="margin-top:8px"></div>
       </div>`;
    // window.print() 는 이 앱에서 아무 일도 하지 않는다 — WKWebView 에 print 가
    // 없다. prompt·alert·confirm 과 같은 부류이고, 눌러도 조용하다.
    // 그래서 진짜 파일을 만들어 브라우저로 연다. 그쪽 ⌘P 는 동작한다.
    $("rs-print").addEventListener("click", async () => {
      const note = $("rs-printnote");
      note.textContent = "만드는 중…";
      try {
        const d = new Date();
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const r = await invoke<any>("recovery_card_print", { nowYmd: ymd });
        note.textContent = `${r.say} (${r.path})`;
      } catch (e) {
        note.innerHTML = `<span class="danger">${e}</span>`;
      }
    });
  } catch (e) {
    $("rs-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
  }
}

async function phoneLost() {
  const p: any = await invoke("phone_lost_plan").catch(() => null);
  if (!p) return;
  $("rs-result").innerHTML =
    `<div class="card" style="margin-top:11px">
       <h3>${p.calm}</h3>
       <div class="warnbox" style="margin-top:9px">${p.risk}</div>
       <ol style="margin:12px 0 0 18px;font-size:14px;line-height:1.9">
         ${(p.steps || []).map((x: any) => `<li><b>${x.do}</b> — ${x.why}</li>`).join("")}
       </ol>
       <p class="meta">${(p.not_needed || []).join(" ")}</p>
       <button id="rs-logout" class="harm" style="margin-top:10px">모든 폰 로그아웃 — 직원 폰도 끊깁니다</button>
     </div>`;
  $("rs-logout").addEventListener("click", async () => {
    const ok = await sure(
      "모든 폰을 끊을까요?",
      "직원 폰도 같이 끊깁니다. 새 QR을 다시 찍어야 합니다.",
      "끊습니다"
    );
    if (!ok) return;
    const r: any = await invoke("logout_all_phones");
    $("rs-result").innerHTML = `<div class="card" style="margin-top:11px">
      <h3>${r.message}</h3><p class="meta">${r.next}</p></div>`;
  });
}

// ── 사이드바 아래의 두 점 ─────────────────────────────────────────────────
//
// 🔴 이 점들은 **아무도 칠하지 않고 있었다.** HTML 에 `class="dot off"` 로
// 박혀 있고 그걸 바꾸는 코드가 한 줄도 없었다 — 노드가 돌든 죽든 영원히
// 회색이다. 늘 같은 색인 표시등은 표시등이 아니라 장식이고, 장식이 상태처럼
// 생겼으면 그건 거짓말이다.
//
// 색만으로 말하지 않는다. 색맹인 사람과 흑백 화면에서는 초록과 회색이 같다 —
// 글자도 함께 바꾼다.

// ── 쉬운 설정 ────────────────────────────────────────────────────────────
//
// 🔴 이 설정 화면에는 입력칸 24개·단추 31개가 있었다. 판단을 하나씩 사장에게
// 떠넘긴 결과다. 노인이 쓸 화면이 아니다.
//
// 복잡함은 사라지지 않는다 — 사장에게서 걷어내면 **우리가 떠안는다.**
// 그 자리가 `src-tauri/src/spec.rs` 이고, 여기는 그 답을 읽어 주는 곳이다.
//
// 규칙 셋:
//   1. **값을 묻지 않는다.** 컴퓨터를 보고 우리가 정한다.
//   2. **왜 그렇게 정했는지 적는다.** 이유 없는 값은 못 믿고, 못 믿으면
//      결국 고급 설정을 열어 헤맨다.
//   3. **못 읽은 것은 못 읽었다고 한다.** 0 으로 적으면 멀쩡한 컴퓨터에서
//      "부족합니다" 가 되어 사장이 겁먹는다.


/// 금고 칸에 적은 RVN 이 **지금 시세로 얼마인지** 그 자리에서 보여 준다.
///
/// 🔴 이 두 칸은 RVN 인데 화면에 단위가 없었다. 사장은 원으로 읽는다.
/// 그리고 이 설정은 5분마다 **진짜로 돈을 보낸다**(`sweep.rs`). 잘못 읽으면
/// 금고가 영영 안 돌거나, 반대로 계산대 돈이 통째로 나간다.
///
/// ⚠️ 시세를 못 가져오면 **아무 말도 안 한다.** 틀린 환산을 보여주느니
/// 없는 편이 낫다 — 숫자가 붙어 있으면 그걸 믿고 정한다.
async function paintSweepKrw(): Promise<void> {
  let rate = 0;
  try {
    const r = await invoke<any>("rvn_rate", { currency: "KRW" });
    rate = Number(r?.rate) || 0;
  } catch {
    return;
  }
  if (rate <= 0) return;
  const pair: [string, string][] = [
    ["sw-above", "sw-above-krw"],
    ["sw-keep", "sw-keep-krw"],
  ];
  const draw = () => {
    for (const [inId, outId] of pair) {
      const inp = document.getElementById(inId) as HTMLInputElement | null;
      const out = document.getElementById(outId);
      if (!inp || !out) continue;
      const n = Number(inp.value.trim());
      out.textContent =
        inp.value.trim() && isFinite(n) && n > 0
          ? `지금 시세로 약 ${Math.round(n * rate).toLocaleString()}원`
          : "";
    }
  };
  for (const [inId] of pair) {
    const inp = document.getElementById(inId);
    if (inp) inp.addEventListener("input", draw);
  }
  draw();
}


// ── 클라우드 자물쇠 열쇠 ─────────────────────────────────────────────────
//
// 🔴 컴퓨터가 죽으면 이 열쇠도 같이 사라진다. 그러면 클라우드 사본은 열 수
// 없는 덩어리가 되고, 그건 백업이 아니라 짐이다. 그래서 **눌러서 보고 종이에
// 적으라고** 말한다.
//
// 처음부터 화면에 띄우지 않는 이유: 사장 뒤에 손님이 서 있을 수 있다.

// ── 개발비 ───────────────────────────────────────────────────────────────
//
// 🔴 이 칸은 여태 「고급 → 읽기 전용」 접힌 칸 맨 안쪽에 있었다. 화면 전체에서
// 딱 한 번, 제일 깊은 곳에. 나중에 발견한 사장은 1% 가 아니라 프로그램 전체를
// 의심한다 — 그게 숨기면 안 되는 진짜 이유다.
//
// ⚠️ 「읽는 중…」에서 멈추면 그건 고장으로 읽힌다. 못 읽었으면 못 읽었다고 한다.
async function paintFee(): Promise<void> {
  const el = document.getElementById("fee-addr");
  if (!el) return;
  try {
    const r = await invoke<any>("fee_read");
    const addr = String(r?.address || "").trim();
    el.textContent = addr || "아직 정해지지 않았습니다";
    // 꺼져 있으면 그렇게 말한다. 켜진 척하지 않는다.
    if (r && r.on === false) {
      el.textContent = `${addr || "—"} (지금은 꺼져 있습니다)`;
    }
  } catch (e) {
    el.textContent = "주소를 읽지 못했습니다";
  }
}


/// USB 백업을 잠글지. **기본은 잠금**이고, 끄는 것은 사장이 정할 일이다.
async function wireUsbLock(): Promise<void> {
  const box = document.getElementById("bk-usblock") as HTMLInputElement | null;
  const state = document.getElementById("bk-usbstate");
  if (!box) return;
  const paint = (on: boolean) => {
    box.checked = on;
    if (state) state.textContent = on ? "잠금" : "안 함";
  };
  try {
    const r = await invoke<any>("usb_lock_read");
    paint(r?.lock !== false);
  } catch {
    paint(true);
  }
  box.onchange = async () => {
    // ⚠️ 끄기는 되돌릴 수 있지만, 끈 뒤에 만든 USB 는 벗은 채로 남는다.
    // 그 사실을 그 자리에서 말한다.
    if (!box.checked && !confirm(
      "USB 백업을 잠그지 않으시겠습니까?\n\n" +
      "그 USB 를 주운 사람이 가게 돈을 가져갈 수 있습니다.\n" +
      "이미 만들어진 잠긴 백업은 그대로 남습니다.",
    )) {
      box.checked = true;
      return;
    }
    try {
      const r = await invoke<any>("usb_lock_set", { lock: box.checked });
      paint(r?.lock !== false);
    } catch {
      paint(!box.checked);
    }
  };
}

function wireCloudKey(): void {
  // 외우는 암호로도 열리게 하는 칸.
  const bpSave = document.getElementById("bp-save");
  const bpMsg = document.getElementById("bp-msg");
  if (bpSave && bpMsg) {
    // 🔴 암호가 이미 정해져 있으면 **긴 열쇠를 적을 필요가 없다.** 그런데
    //    화면은 계속 "종이에 적어 두세요"라고 말하고 있었다. 안 해도 되는
    //    일을 시키면 사장은 「암호가 둘인가?」로 읽고 둘 다 안 한다.
    void invoke<any>("backup_pass_state")
      .then((st) => {
        const need = document.getElementById("ck-need");
        const box = document.getElementById("bp-box");
        if (st?.set) {
          bpMsg.textContent = "암호가 정해져 있습니다. 새 백업부터 이 암호로 열립니다.";
          if (need)
            need.innerHTML =
              "<b>암호를 정해 두셨으니 이건 안 적으셔도 됩니다.</b> 새 컴퓨터에서는 그 암호를 치시면 됩니다. " +
              "아래 열쇠는 암호를 잊었을 때 쓰는 여벌입니다.";
          // 🔴 **접기만 하면 바꿀 길이 없어진다.** 러스트는 덮어쓸 수 있는데
          //    화면이 칸을 숨겨서, 암호를 한 번 정하면 영영 못 바꿨다.
          //    접되 **여는 단추**를 남긴다.
          if (box) box.style.display = "none";
          const again = document.getElementById("bp-again");
          if (again) {
            again.style.display = "";
            again.onclick = () => {
              if (box) box.style.display = "";
              again.style.display = "none";
              bpMsg.innerHTML =
                "새 암호를 넣으시면 <b>앞으로 만드는 백업</b>이 새 암호로 열립니다.<br />" +
                "⚠️ <b>이미 만들어 둔 백업은 예전 암호로만 열립니다</b> — 그 파일 안에 이미 굳어 있어서 " +
                "바꿀 수가 없습니다. 바꾸신 뒤에 한 부 새로 만들어 두세요.";
            };
          }
        } else if (need) {
          need.innerHTML =
            "🔴 <b>아직 암호를 안 정하셨습니다.</b> 컴퓨터가 죽으면 이 열쇠도 같이 사라져서 백업을 못 엽니다.<br />" +
            "<b>아래에서 암호를 정하시거나</b>, 이 열쇠를 종이에 적어 12단어와 같이 보관하세요.";
        }
      })
      .catch(() => null);
    // 🔴 두 칸이 다른 것을 **치는 동안** 알려 준다. 누르고 나서야 알려주면
    //    사장은 이미 「됐겠지」 하고 넘어간 뒤다.
    const bpCheck = () => {
      const p1 = (document.getElementById("bp-pass") as HTMLInputElement | null)?.value || "";
      const p2 = (document.getElementById("bp-pass2") as HTMLInputElement | null)?.value || "";
      if (p1 && p1.length < 10) bpMsg.textContent = `암호가 짧습니다. ${10 - p1.length}글자 더 필요합니다.`;
      else if (p2 && p1 !== p2) bpMsg.textContent = "🔴 두 번 넣은 암호가 다릅니다.";
      else if (p1 && p1 === p2) bpMsg.textContent = "✅ 두 암호가 같습니다.";
      else bpMsg.textContent = "";
    };
    ["bp-pass", "bp-pass2"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", bpCheck);
    });

    bpSave.onclick = async () => {
      const inp = document.getElementById("bp-pass") as HTMLInputElement | null;
      const inp2 = document.getElementById("bp-pass2") as HTMLInputElement | null;
      const pw = inp?.value || "";
      // 🔴 오타 난 암호는 **새 컴퓨터에서 백업을 못 여는 것**으로 나타난다.
      //    그때는 이미 늦었다. 여기서 잡는다.
      if (pw !== (inp2?.value || "")) {
        bpMsg.textContent = "두 번 넣은 암호가 다릅니다. 다시 해 주세요.";
        return;
      }
      try {
        // 🔴 이미 정해져 있으면 **본인인지 확인**한다. 잠깐 자리를 비운 사이
        //    누가 바꿔 놓으면 사장은 컴퓨터가 죽는 날에야 안다.
        const st = await invoke<any>("backup_pass_state").catch(() => null);
        let walletPass: string | null = null;
        if (st?.set) {
          walletPass = await ask(
            "지갑 암호",
            "이미 정해진 백업 암호를 바꾸려 합니다. 본인이 맞는지 지갑 암호로 확인합니다.",
            { password: true }
          );
          if (!walletPass) return;
        }
        await invoke("backup_pass_set", { pass: pw, walletPass });
        if (inp) inp.value = "";
        if (inp2) inp2.value = "";
        bpMsg.innerHTML =
          "<b>정했습니다.</b> 이제부터 만드는 백업이 이 암호로 열립니다.<br />" +
          "⚠️ 이미 만들어 둔 백업은 <b>예전 암호</b>로만 열립니다. 지금 한 부 새로 만들어 두세요.";
        const again2 = document.getElementById("bp-again");
        const box2 = document.getElementById("bp-box");
        if (box2) box2.style.display = "none";
        if (again2) again2.style.display = "";
      } catch (e) {
        bpMsg.textContent = errText(e);
      }
    };
  }

  const show = document.getElementById("ck-show");
  const box = document.getElementById("ck-key");
  const copy = document.getElementById("ck-copy");
  if (!show || !box) return;
  let key = "";
  show.onclick = async () => {
    try {
      const r = await invoke<any>("cloud_key_show");
      key = String(r?.key || "");
      box.textContent = key;
      box.classList.add("on");
      show.textContent = "다시 감추기";
      show.onclick = () => {
        box.textContent = "눌러서 보기";
        box.classList.remove("on");
        wireCloudKey();
    void wireUsbLock();
    void paintFee();
      };
    } catch (e) {
      box.textContent = `열쇠를 읽지 못했습니다: ${String((e as Error)?.message || e)}`;
    }
  };
  if (copy) {
    copy.onclick = async () => {
      if (!key) return;
      try {
        await navigator.clipboard.writeText(key);
        copy.textContent = "복사했습니다";
        // ⚠️ 클립보드에 오래 두지 않는다. 다른 프로그램이 읽는다.
        setTimeout(() => { void navigator.clipboard.writeText(" "); copy.textContent = "복사"; }, 30_000);
      } catch {
        copy.textContent = "복사가 안 됩니다";
      }
    };
  }
}

async function paintEasySetup(): Promise<void> {
  const body = document.getElementById("easy-body");
  if (!body) return;
  let v: any;
  try {
    // 🔴 시간 제한이 없으면 **영원히 「살펴보는 중」** 이 된다. 지갑의
    // 「불러오는 중…」이 똑같은 병이었다 — 끝나지 않는 화면은 고장으로 읽히고,
    // 사장은 프로그램이 멈춘 줄 안다. 디스크가 잠자고 있으면 df 가 몇 초씩
    // 걸리기도 한다.
    v = await Promise.race([
      invoke<any>("suggest_setup"),
      new Promise((_, bad) =>
        setTimeout(() => bad(new Error("오래 걸립니다")), 8000),
      ),
    ]);
  } catch (e) {
    // 못 본 것과 안 본 것은 다르다. 다음에 할 일을 그 자리에 둔다.
    body.innerHTML = `<div class="easywhy">
        <p>이 컴퓨터를 살펴보지 못했습니다.</p>
        <p class="muted">${escapeHtml(String((e as Error)?.message || e))}</p>
        <p>아래 <b>고급 설정</b>에서 직접 정하실 수 있고, 다시 눌러 보셔도 됩니다.</p>
      </div>
      <button id="easy-go">다시 살펴보기</button>`;
    const retry = document.getElementById("easy-go");
    if (retry) retry.onclick = () => void paintEasySetup();
    return;
  }

  const seen = v?.seen || {};
  const sug = v?.suggest || {};
  // 못 읽은 값은 숫자 대신 "모름" 이다. 0 이라고 적지 않는다.
  const num = (x: unknown, unit: string) =>
    typeof x === "number" ? `${x}${unit}` : "모름";

  const rows = [
    ["블록체인",
      sug.full_chain
        ? "전부 이 컴퓨터에 둡니다"
        : "가볍게 시작합니다"],
    ["채굴", "꺼 둡니다"],
    ["사진 저장", typeof sug.ipfs_gb === "number" ? `${sug.ipfs_gb}GB 까지` : "기본값"],
  ];

  body.innerHTML = `
    ${rows.map(([k, val]) =>
      `<div class="easyrow"><div class="k">${k}</div><div class="v">${val}</div></div>`,
    ).join("")}
    <div class="easywhy">
      ${(v?.why || []).map((t: string) => `<p>${escapeHtml(t)}</p>`).join("")}
    </div>
    <button id="easy-go">이대로 시작하기</button>
    <div class="easyseen">
      살펴본 것 — 일꾼 ${num(seen.cores, "명")} ·
      기억장치 ${num(seen.memory_gb, "GB")} ·
      빈 공간 ${num(seen.free_gb, "GB")}
    </div>`;

  const go = document.getElementById("easy-go") as HTMLButtonElement | null;
  if (!go) return;
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "맞추는 중…";
    try {
      await applyEasySetup(sug);
      go.textContent = "다 됐습니다";
      // 다음에 할 일을 그 자리에 둔다. "완료" 만 뜨면 사장은 다음을 못 찾는다.
      const must = (v?.must_do || []) as string[];
      body.insertAdjacentHTML(
        "beforeend",
        `<div class="easywhy" style="margin-top:12px">
           <p><b>이제 이 셋만 하시면 장사가 됩니다.</b></p>
           <p>${must.map((m) => escapeHtml(m)).join(" · ")}</p>
           <p class="muted">「내 가게」에서 하실 수 있어요.</p>
         </div>`,
      );
    } catch (e) {
      go.disabled = false;
      go.textContent = "이대로 시작하기";
      body.insertAdjacentHTML(
        "beforeend",
        `<div class="easywhy" style="margin-top:12px">맞추지 못했습니다.
           ${escapeHtml(String((e as Error)?.message || e))}</div>`,
      );
    }
  };
}

/**
 * 정한 값을 실제로 넣는다.
 *
 * ⚠️ **여기서 하나라도 조용히 실패하면 「다 됐습니다」가 거짓말이 된다.**
 * 그래서 실패는 던진다 — 화면이 성공했다고 말하는 일이 없게.
 */
async function applyEasySetup(sug: any): Promise<void> {
  // 채굴은 끈다. 장사하는 컴퓨터가 뜨거워지고 느려지면 계산대가 느려지고,
  // 그건 손님이 기다린다는 뜻이다.
  if (sug?.mining === false) {
    await invoke("miner_stop").catch(() => {
      /* 원래 꺼져 있으면 이건 실패가 아니다 */
    });
  }
  if (typeof sug?.ipfs_gb === "number") {
    await invoke("ipfs_set_storage_max", { gb: sug.ipfs_gb });
  }
}

/// 노드가 살아 있는가. 라비가 자는지 정하는 **유일한** 근거다.
/// `null` = 아직 안 물어봤다 — 그때는 깨어 있는 쪽으로 친다. 켜자마자
/// 자는 얼굴이 뜨면 사장은 고장으로 읽는다.
let nodeUp: boolean | null = null;
/** 바깥 연결이 켜져 있나. `null` 은 아직 모른다 — 모를 때 「꺼짐」이라고
 *  말하면 켜 둔 사장에게 거짓말이 된다. */
let outUp: boolean | null = null;

/**
 * 따라잡기 막대. `null` 이면 감춘다 — 다 따라잡았거나 노드가 꺼졌을 때.
 *
 * 🔴 100% 에서 안 감추면 늘 꽉 찬 막대가 남는다. 늘 있는 표시는 아무도 안 본다.
 */
function setSyncBar(pct: number | null) {
  const bar = document.getElementById("d-node-bar");
  const fill = document.getElementById("d-node-fill");
  if (!bar || !fill) return;
  if (pct == null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  // 0% 면 막대가 안 보여서 「멈춘 것」으로 읽힌다. 최소 2% 는 그려 준다.
  fill.style.width = `${Math.max(2, pct)}%`;
}

/**
 * 노드가 **시작하는 중**인가.
 *
 * ## 🔴 왜 이 판별이 따로 필요한가
 *
 * 대표님 화면에 이 둘이 **같이** 떠 있었다:
 *
 *     가운데:  getblockchaininfo: Loading block index...
 *     왼쪽:    RVN 노드 꺼짐        ← 라비도 "노드가 꺼져 있어요"
 *
 * **꺼져 있으면 저 말을 할 수가 없다.** 노드에 물어봤더니 「장부 여는 중」
 * 이라고 **답한** 것이다. 살아 있다.
 *
 * 표시등은 켜짐/꺼짐 둘뿐이라 「아직 답 못 함」을 꺼짐으로 쳤고, 그래서
 * 사장이 「노드 켜기」를 몇 번이나 누르셨다 — 이미 켜져 있는 것을.
 *
 * 큰 화면(`paintPart`)은 이 판별을 이미 하고 있었는데 표시등이 몰랐다.
 * **한 군데서 정하고 둘이 같이 쓴다.**
 */
function isWarming(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /Loading block index|Verifying|Rewinding|Activating|Loading wallet|warming up|-28/i.test(
    msg
  );
}

/** 표시등이 「시작하는 중」을 아는가. 라비도 이 값을 본다. */
let nodeWarming = false;

async function paintStatusDots() {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  const set = (dot: string, label: string, ok: boolean, text: string) => {
    const d = document.getElementById(dot);
    const t = document.getElementById(label);
    if (d) {
      d.classList.toggle("on", ok);
      d.classList.toggle("off", !ok);
    }
    if (t) t.textContent = text;
  };

  try {
    const n = await invoke<any>("node_status");
    // 켜져 있는 것과 따라잡은 것은 다르다. 동기화 중이면 결제 확인이 늦는다.
    const pct = Math.max(0, Math.min(1, Number(n?.progress ?? 0))) * 100;
    const synced = (n?.progress ?? 0) > 0.9999;
    // 🔴 「따라잡는 중」만 적으면 **끝이 안 보인다.** 34GB 를 훑는 동안
    //    사장은 이게 10분짜리인지 하루짜리인지 알 수가 없다. 숫자를 준다.
    set("d-node", "d-node-t", true, synced ? "RVN 노드 켜짐" : `노드 ${pct.toFixed(1)}%`);
    setSyncBar(synced ? null : pct);
    nodeUp = true;
    nodeWarming = false;
  } catch (e) {
    // 🔴 답을 못 받은 것과 꺼진 것은 **다르다.** 「장부 여는 중」이라는
    //    답이 왔다면 그건 살아 있다는 뜻이다.
    nodeWarming = isWarming(e);
    set(
      "d-node",
      "d-node-t",
      nodeWarming,
      nodeWarming ? "RVN 노드 여는 중" : "RVN 노드 꺼짐"
    );
    setSyncBar(null);
    nodeUp = false;
  }
  // 노드 상태가 바뀌면 라비 얼굴도 따라 바뀐다.
  paintRaviFace();
  void refreshKeys().catch(() => {});

  try {
    const i = await invoke<any>("ipfs_status");
    set("d-ipfs", "d-ipfs-t", !!i?.running, i?.running ? "파일창고 켜짐" : "파일창고 꺼짐");
    // 채굴과 릴레이도 같이. 넷이 이 프로그램의 전부다.
    void (async () => {
      try {
        const m = await invoke<any>("miner_running");
        set("d-mine", "d-mine-t", !!m?.running, m?.running ? "채굴 켜짐" : "채굴 꺼짐");
      } catch {
        set("d-mine", "d-mine-t", false, "채굴 꺼짐");
      }
      try {
        const r = await invoke<any>("relay_status");
        set("d-relay", "d-relay-t", !!r?.running, r?.running ? "릴레이 켜짐" : "릴레이 꺼짐");
      } catch {
        set("d-relay", "d-relay-t", false, "릴레이 꺼짐");
      }
      // 🔴 바깥에서 손님이 들어올 수 있는가. 위의 넷이 다 초록이어도 이게
      //    꺼져 있으면 **가게 밖에서는 아무도 못 들어온다.**
      try {
        const o = await invoke<any>("tunnel_status");
        outUp = !!o?.running;
        set("d-out", "d-out-t", !!o?.running, o?.running ? "바깥 연결 켜짐" : "바깥 연결 꺼짐");
      } catch {
        outUp = false;
        set("d-out", "d-out-t", false, "바깥 연결 꺼짐");
      }
    })();
  } catch {
    set("d-ipfs", "d-ipfs-t", false, "파일창고(IPFS) 꺼짐");
  }
}

// ── 판올림 ────────────────────────────────────────────────────────────────
//
// 🔴 **저절로 설치되면 안 된다.** 계산대는 장사 중이고, 재시작하면 손님 폰
// 서버(8790)가 끊겨 QR 이 먹통이 된다. 받아만 두고 **사장이 고른다.**
//
// 확인은 하루 한 번이면 충분하다. 매번 켤 때마다 물어보면 그것도 방해다.

/**
 * 사람이 판 번호를 눌렀을 때.
 *
 * 🔴 **없을 때도 답한다.** 배경 확인은 조용히 넘어가지만, 손으로 누른
 *    것에 아무 반응이 없으면 그건 고장이다.
 */
/**
 * 받아서 깐다. **묻고 나서.**
 *
 * 🔴 장사 중에 저절로 다시 시작되면 손님 QR 이 먹통이 된다. 그래서
 *    받는 것까지는 자동이어도 **다시 시작은 사람이 정한다.**
 */
async function doInstall(up: any) {
  const nag = document.getElementById("upnag") as HTMLButtonElement | null;
  const ok = await sure(
    t("지금 받아서 설치할까요?"),
    `${t("새 버전")} ${up?.version ?? ""} · ` +
      t("받은 뒤 프로그램이 다시 시작합니다. 손님이 주문 중이면 그 화면이 끊깁니다.")
  );
  if (!ok) return;
  try {
    if (nag) {
      nag.disabled = true;
      nag.textContent = t("받는 중…");
    }
    await up.downloadAndInstall((e: any) => {
      // 얼마나 왔는지 말한다. 큰 파일이라 아무 말이 없으면 멎은 줄 안다.
      if (e?.event === "Progress" && nag) {
        nag.textContent = t("받는 중…");
      }
      if (e?.event === "Finished" && nag) nag.textContent = t("설치 중…");
    });
    await relaunch();
  } catch (e) {
    if (nag) {
      nag.disabled = false;
      nag.textContent = t("새 버전 받기");
    }
    await sure(t("받지 못했습니다"), errText(e), t("닫기"));
  }
}

async function checkNow() {
  const nag = document.getElementById("upnag") as HTMLButtonElement | null;
  // 🔴 판 번호 글자는 그대로 둔다. 번호가 「확인 중…」으로 바뀌면 사장은
  //    자기가 쓰는 판이 무엇인지 그 순간 못 본다. 아래 단추가 답한다.
  if (nag) {
    nag.classList.remove("new");
    nag.textContent = t("확인 중…");
  }
  await checkForUpdate(true);
  // 새 버전이 있으면 설치 칸으로 데려간다. 없으면 단추가 「최신 버전」이라
  // 적혀 있고, 그게 답이다.
  if (nag?.classList.contains("new")) {
    showPage("settings");
    setTimeout(() => $("up-box")?.scrollIntoView({ block: "center" }), 60);
  }
}

async function checkForUpdate(quiet = true) {
  try {
    const up = await checkUpdate();
    const nag = document.getElementById("upnag") as HTMLButtonElement | null;
    if (!up) {
      // 🔴 **감추지 않는다.** 「최신이다」도 답이다. 아무 말이 없으면
      //    사장은 확인이 된 건지 안 된 건지 알 수 없다.
      if (nag) {
        nag.hidden = false;
        nag.classList.remove("new");
        nag.textContent = t("최신 버전");
        nag.onclick = () => void checkNow();
      }
      if (!quiet) $("up-note").textContent = "지금이 최신입니다.";
      return;
    }
    // 🔴 **늘 보이는 자리에 먼저 말한다.** 아래 자세한 칸은 「설정」 화면
    //    안쪽 스크롤 한참 밑에 있다 — 앱은 새 판이 있는 걸 알면서도
    //    보이는 데서는 아무 말도 안 했다. 그래서 몇 판이나 뒤처진 채로
    //    쓰고 계셨다. 판 번호 옆에 붙여 두고, 누르면 그 칸으로 데려간다.
    if (nag) {
      nag.hidden = false;
      // 🔴 이때만 눈에 띄게 한다. 최신일 때도 주황이면 늘 할 일이 있는
      //    것처럼 보이고, 그러면 진짜 있을 때 안 보인다.
      nag.classList.add("new");
      nag.textContent = t("새 버전 받기");
      // 🔴 **이름이 「받기」면 받아야 한다.** 여태 화면만 옮겼다 —
      //    사장은 눌렀는데 아무 일도 안 일어난다고 겪었고, 실제 설치는
      //    저 아래 「받아서 설치」를 **또** 눌러야 했다. 그 칸이 화면
      //    밖에 있으면 그런 단추가 있는 줄도 모른다.
      nag.onclick = () => void doInstall(up);
    }
    // 무엇이 바뀌는지 말하지 않고 "새 버전" 만 띄우면 아무도 안 누른다.
    $("up-box").style.display = "";
    $("up-box").innerHTML =
      `<div class="card" style="border-color:var(--ravi)">
         <h3>새 버전이 있습니다 — ${escapeHtml(up.version)}</h3>
         <p class="meta" style="white-space:pre-wrap">${escapeHtml(up.body || "").slice(0, 600)}</p>
         <div class="row" style="margin-top:12px">
           <button id="up-go">받아서 설치</button>
           <button class="ghost" id="up-later">나중에</button>
           <span class="meta" id="up-note"></span>
         </div>
         <p class="note" style="margin-top:10px">
           설치하면 프로그램이 <b>다시 시작</b>합니다. 그동안 손님 QR 이 잠깐
           멈추니, <b>손님이 없을 때</b> 누르세요.
         </p>
       </div>`;
    ($("up-go") as HTMLElement).onclick = async () => {
      const ok = await sure(
        "지금 설치할까요?",
        "프로그램이 다시 시작합니다. 손님이 주문 중이면 그 화면이 끊깁니다.",
        "설치",
      );
      if (!ok) return;
      $("up-note").textContent = "받는 중…";
      try {
        let got = 0;
        let total = 0;
        await up.downloadAndInstall((e: any) => {
          if (e.event === "Started") total = e.data?.contentLength || 0;
          if (e.event === "Progress") {
            got += e.data?.chunkLength || 0;
            $("up-note").textContent = total
              ? `받는 중 ${Math.round((got / total) * 100)}%`
              : "받는 중…";
          }
          if (e.event === "Finished") $("up-note").textContent = "설치 중…";
        });
        await relaunch();
      } catch (e) {
        $("up-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
      }
    };
    ($("up-later") as HTMLElement).onclick = () => {
      $("up-box").style.display = "none";
      // 이 큰 칸만 접는다. **판 번호 옆의 작은 표시는 남긴다** — 새 판이
      // 있다는 사실 자체를 감추면, 그게 지금까지 벌어진 일이다.
      localStorage.setItem("playx-raven-update-snooze", String(Date.now()));
    };
  } catch (e) {
    // 업데이트 서버가 없거나 인터넷이 끊긴 것은 사고가 아니다. 조용히 넘긴다 —
    // 다만 사장이 직접 눌러 확인했을 때는 말해 준다.
    // 🔴 「확인 중…」에서 멈춘 채로 두면 사장은 프로그램이 멎은 줄 안다.
    const nag2 = document.getElementById("upnag") as HTMLButtonElement | null;
    if (nag2) {
      nag2.hidden = false;
      nag2.classList.remove("new");
      nag2.textContent = t("확인 못 했습니다");
      nag2.onclick = () => void checkNow();
    }
    if (!quiet) $("up-note").textContent = "확인하지 못했습니다. 인터넷을 확인해 주세요.";
  }
}

/* ══ 라비 첫 화면 ═════════════════════════════════════════════════════
   🔴 왜 아이콘을 「라비에게 하는 말」로 만들었나

   보통 이런 화면은 아이콘마다 다른 코드를 붙인다. 그러면 같은 일에 길이
   둘이 되고(눌러서 하는 길 · 말해서 하는 길), 둘이 조금씩 어긋난다.

   여기서는 아이콘이 **문장을 대신 쳐 주는 것**뿐이다. 누르든 말하든 같은
   `chatSend` 를 지난다. 사장이 배울 것은 하나다 — 라비에게 말하는 법.

   ⚠️ 다만 **열쇠 없이도 되는 일**은 라비를 거치지 않는다. 오늘 매출을
   보는 데 AI 회사에 돈을 낼 이유가 없고, 열쇠가 없다고 매출을 못 보면
   그건 프로그램이 남의 회사에 묶인 것이다. 그래서 타일이 두 종류다:
     do  — 이 컴퓨터가 바로 한다. 열쇠와 무관.
     say — 라비가 한다. 열쇠가 없으면 눌렀을 때 그 자리에서 넣게 한다. */
/* 🔴 사장이 **말해서 만든 단추**를 여기 둔다.

   Nothing 의 Essential Apps, Rabbit 의 Creations 가 하는 일이 이것이다 —
   화면을 우리가 정해 주는 것이 아니라, 쓰는 사람이 말로 늘린다.
   "맨날 이거 해" 라고 하면 라비가 단추를 만들어 홈에 붙인다.

   ⚠️ 이 컴퓨터에만 남는다(체인도 서버도 아니다). 단추는 **말 한 줄**일
   뿐이라 잃어도 잃는 것이 없고, 남의 손에 넘어가도 위험한 값이 아니다. */
const MYTILE_KEY = "playx-ravi-mytiles";
type MyTile = { label: string; sub: string; say: string };

function myTiles(): MyTile[] {
  try {
    const v = JSON.parse(localStorage.getItem(MYTILE_KEY) || "[]");
    return Array.isArray(v) ? v.slice(0, 8) : [];
  } catch {
    return [];
  }
}
function setMyTiles(v: MyTile[]) {
  localStorage.setItem(MYTILE_KEY, JSON.stringify(v.slice(0, 8)));
}

type Tile = {
  /** 가게가 없을 때 맨 앞에 서는 칸. 눈에 띄게 채워 그린다. */
  lead?: boolean;
  mine?: boolean;
  icon: string;
  label: string;
  sub: string;
  do?: () => void | Promise<void>;
  say?: string;
};

const I = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

function raviTiles(): Tile[] {
  const closed = ($("sh-closednow") as HTMLInputElement | null)?.checked ?? false;
  const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
  const hasShop = !!(val("sh-ko") || val("sh-en"));

  /* 🔴 가게가 아직 없으면 **가게 만들기가 맨 앞**이다.
     대표님 지적: "주문 관련 한 것은 있는데 가게 만들기는 없나?"
     맞다 — 오늘 매출·들어온 주문은 가게가 있어야 뜻이 있는 것인데,
     정작 가게를 만드는 자리가 없었다. 없는 사람에게 첫 칸은 그것이다. */
  const first: Tile[] = hasShop ? [] : [{
    icon: I('<path d="M4 9l1.6-4.2h12.8L20 9"/><path d="M4.5 9h15v10.5h-15z"/><path d="M9.5 19.5v-6h5v6"/><path d="M12 3.5v2M10.5 4.5h3"/>'),
    label: "가게 만들기",
    sub: "여기서 시작합니다",
    lead: true,
    do: () => { showPage("shop"); shopTab("mine");
      // 「가게 정보 · 처음 한 번」은 접혀 있다. 여기로 온 사람에게는 펼쳐 준다.
      const d = document.querySelector<HTMLDetailsElement>("#shoptab-mine details.onceoff");
      if (d) d.open = true;
      setTimeout(() => $("sh-ko")?.focus(), 250);
    },
  }];

  return first.concat([
    {
      icon: I('<path d="M4 19V9M10 19V5M16 19v-7M21 19H3"/>'),
      label: "오늘 얼마",
      sub: "매출 · 장부",
      do: () => { showPage("shop"); shopTab("sales"); },
    },
    {
      icon: I('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><path d="M13.5 13.5h3v3h-3zM20.5 13.5v3M17.5 20.5h3"/>'),
      label: "손님 QR",
      sub: "카운터에 붙이는 것",
      // 🔴 설정 화면으로 데려다 놓지 않는다. **QR 을 그 자리에 띄운다.**
      do: () => void openQrSheet(),
    },
    {
      icon: I('<path d="M6 3h12v18l-3-1.6-3 1.6-3-1.6L6 21z"/><path d="M9.5 8h5M9.5 12h5"/>'),
      label: "들어온 주문",
      sub: "손님이 시킨 것",
      do: () => { showPage("shop"); shopTab("orders"); },
    },
    {
      // 🔴 되돌릴 수 있는 일이라 바로 한다. 체인에 남지 않고, 다시 누르면
      //    원래대로다. 대신 **무엇으로 바뀌었는지 반드시 말한다** —
      //    조용히 바뀌면 손님이 못 들어오는 이유를 사장이 모른다.
      icon: closed
        ? I('<path d="M12 3v3M7.5 6h9a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 14.5v-7A1.5 1.5 0 017.5 6z"/><path d="M9 11h6M12 18.5V21"/>')
        : I('<path d="M12 3v3M7.5 6h9a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 14.5v-7A1.5 1.5 0 017.5 6z"/><path d="M9 11h6"/>'),
      label: closed ? "다시 열기" : "지금 닫기",
      sub: closed ? "지금은 닫혀 있습니다" : "손님에게 안 보입니다",
      do: () => {
        const box = $("sh-closednow") as HTMLInputElement | null;
        if (!box) return;
        box.checked = !box.checked;
        // 화면에 이미 붙어 있는 처리(미리보기·저장)를 그대로 태운다.
        box.dispatchEvent(new Event("change", { bubbles: true }));
        chatSay("did", box.checked ? "지금 닫았습니다. 손님에게 「주문 받지 않음」으로 보입니다." : "다시 열었습니다.");
        paintRavi();
      },
    },
    {
      icon: I('<path d="M4 6.5h16v11H4zM4 10h16M8 14h4"/>'),
      label: "메뉴 넣기",
      sub: "말로 불러 주세요",
      say: "메뉴 넣을게요. 제가 부르는 대로 메뉴판에 넣어 주세요: ",
    },
    {
      icon: I('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
      label: "자산 만들기",
      sub: "쿠폰 · 회원권 · 굿즈",
      say: "자산을 하나 만들려고 합니다. 무엇을 물어봐야 하는지부터 알려 주세요.",
    },
    {
      icon: I('<path d="M4 5.5h11l5 4.5v8.5H4z"/><path d="M8 9h5M8 13h8"/>'),
      label: "가게 소개",
      sub: "손님에게 보일 글",
      say: "손님 화면에 보일 가게 소개를 써 주세요. 제 가게는 ",
    },
    {
      icon: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-5M12 8h.01"/>'),
      label: "물어보기",
      sub: "뭐든 물어보세요",
      say: "",
    },
    // 사장이 말해서 만든 단추. 별표를 달아 우리 것과 구별한다 —
    // 지울 수 있는 것과 없는 것이 같아 보이면 안 된다.
    ...myTiles().map((m) => ({
      icon: I('<path d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>'),
      label: m.label,
      sub: m.sub,
      say: m.say,
      mine: true,
    })),
  ]);
}

/** 라비 화면을 그린다. 상태가 바뀔 때마다 다시 부른다. */
function paintRavi() {
  const box = $("ravi-tiles");
  if (!box) return;

  // 자는 얼굴의 뜻은 한 곳에서만 정한다 — **노드가 꺼졌을 때**다.
  // AI 열쇠가 없는 것은 잠이 아니다(장사는 전부 돈다).
  const nodeDown = !(nodeUp ?? true);
  const face = $("ravi-face") as HTMLImageElement | null;
  if (face) {
    // 깨어 있으면 **정면 얼굴**, 자면 자는 그림. 헤더(전신)와 다른 그림이라
    // 한 화면에 같은 것이 둘로 보이지 않는다.
    face.src = nodeDown ? "/raven-sleep.webp" : "/raven-face.webp";
    face.classList.toggle("asleep", nodeDown);
  }
  const hi = $("ravi-hello");
  const sub = $("ravi-sub");
  if (hi && sub) {
    /* 🔴 가게를 만들었으면 **그 이름이 여기 뜬다.**
       대표님 지적: "가게 만들면 가게 이름이 보이는 화면과 통합되어야 하지
       않나?" 맞다 — 매일 여는 화면에 자기 가게 이름이 없으면, 이 프로그램이
       내 가게의 것이라는 느낌이 안 든다. 왼쪽 메뉴에만 있었다. */
    const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
    const shop = val("sh-ko") || val("sh-en");

    if (nodeDown) {
      hi.textContent = nodeWarming
        ? "노드가 장부를 여는 중이에요. 처음이면 며칠 걸릴 수 있어요 — 남은 시간은 「이 컴퓨터」에서 보여요."
        : "노드가 꺼져 있어요.";
      sub.innerHTML = "결제가 들어와도 확인을 못 합니다. <b>이 컴퓨터</b>에서 켜 주세요.";
    } else if (!shop) {
      // 가게가 없는 사람에게는 **가게 이야기부터** 한다.
      hi.textContent = "가게부터 만들까요?";
      sub.textContent = "이름 하나면 시작됩니다. 나머지는 나중에 채우셔도 됩니다.";
    } else if (!aiProvider) {
      hi.textContent = shop;
      sub.innerHTML = "아래 아이콘은 지금 바로 됩니다. 말로 시키시려면 <b>이 컴퓨터 → AI 열쇠</b>를 한 번만 넣어 주세요.";
    } else {
      hi.textContent = shop;
      // 🔴 체인 등록 전에는 그렇다고 말한다. 이름만 적어 둔 가게에 「무엇을
      //    할까요?」만 뜨면, 다 끝난 줄 알고 손님이 장터에서 찾기를 기다린다.
      //    영영 안 나온다 — 등록을 안 했기 때문이다.
      const onChain = !!($("sh-registered") as HTMLInputElement)?.value.trim();
      sub.innerHTML = onChain
        ? t("무엇을 할까요? 아래를 누르거나, 그냥 말씀하세요.")
        : `${t("무엇을 할까요? 아래를 누르거나, 그냥 말씀하세요.")}
           <span class="ravinote">${t("아직 이 컴퓨터에만 있습니다 — 손님은 QR 로 옵니다.")}</span>`;
    }
  }

  /* 🔴 아직 안 된 것이 있으면 **타일에 적어 둔다.** 눌러 보고 알게 하면
     그 사람은 이미 한 번 헛걸음한 것이다. 대표님 지적이 정확했다 —
     가게 등록을 안 했으면 QR 을 눌러도 소용이 없는데, 눌러야만 알았다. */
  const todo = shopTodo();
  const noteBox = $("ravi-todo");
  if (noteBox) {
    /* 🔴 여태 이 줄은 **읽기만 하는 글**이었다. 대표님:
       "「체인에 가게를 등록하지 않았습니다」 이러면 가게 만들기 버튼은
        어디 간 거야?"

       맞다. 안 됐다고 알려 주면서 고칠 길이 없으면, 그건 알려 준 것이
       아니라 답답하게 만든 것이다. **줄마다 눌러서 그 자리로 간다.** */
    // 🔴 라비가 **먼저 아는 것**을 같이 얹는다. 새 창을 만들지 않는다 —
    //    이 줄이 이미 「누르면 그 자리로 간다」라서, 규칙만 더하면 된다.
    const 합친것 = [...todo, ...라비가아는것];
    noteBox.innerHTML = 합친것.length
      ? `<b>${t("아직 안 된 것")}</b> ` +
        합친것.map((x, i) =>
          `<button class="todochip" data-todo="${i}">${escapeHtml(x.label)} →</button>`).join("")
      : "";
    noteBox.style.display = 합친것.length ? "" : "none";
    noteBox.querySelectorAll<HTMLElement>("[data-todo]").forEach((b) => {
      b.onclick = () => 합친것[+b.dataset.todo!].go?.();
    });
    // 다음에 라비 화면을 열 때 최신이 되게, 지금 조용히 다시 잰다.
    void 라비살피기();
  }

  const tiles = raviTiles();
  box.innerHTML = tiles
    .map((t, i) => {
      const needs = t.say !== undefined;
      const cls = ["tile", needs ? "needsai" : "", needs && !aiProvider ? "asleep" : "",
                   t.mine ? "mytile" : "", t.lead ? "leadtile" : ""].join(" ");
      // 내가 만든 단추만 지울 수 있다. 붙박이에는 ×가 없다 —
      // 지워지는 것과 안 지워지는 것이 같아 보이면 손이 멈춘다.
      const x = t.mine ? `<span class="tilex" data-del="${escapeHtml(t.label)}" title="이 단추 지우기">×</span>` : "";
      return `<button class="${cls}" data-tile="${i}">${x}${t.icon}` +
             `<span>${escapeHtml(t.label)}</span>` +
             `<span class="tsub">${escapeHtml(t.sub)}</span></button>`;
    })
    .join("");

  box.querySelectorAll<HTMLElement>("[data-del]").forEach((x) => {
    x.onclick = (e) => {
      e.stopPropagation();   // 안 막으면 지우면서 그 단추가 실행된다
      const label = x.dataset.del!;
      setMyTiles(myTiles().filter((m) => m.label !== label));
      chatSay("did", `「${label}」 단추를 지웠습니다.`);
      paintRavi();
    };
  });

  box.querySelectorAll<HTMLElement>("[data-tile]").forEach((b) => {
    b.onclick = () => {
      const t = tiles[+b.dataset.tile!];
      if (t.do) return void t.do();
      // 말로 하는 일. 🔴 **열쇠가 없어도 막지 않는다.** 막으면 왜 안 되는지도
      // 모른 채 지나간다. 눌러 보고 그 자리에서 넣는 편이 배운다.
      const q = $("chat-q") as HTMLInputElement;
      /* 🔴 여기서 값을 **한 번에 꽂아 넣었다.** 그러면 아무 일도 안 일어난 것처럼
         보인다 — 대표님: "입력하면 인터랙티브하게 입력된 모습을 같이 보여주면서
         되어야 하는 거 아닌가?"

         맞다. 라비가 대신 치는 것이니 **치는 모습이 보여야** 한다.
         칸으로 눈을 먼저 데려간 다음, 한 글자씩 친다. */
      const line = t.say!;
      q.scrollIntoView({ behavior: "smooth", block: "center" });
      q.focus();
      q.value = "";
      typeInto(q, line, () => {
        // 문장이 끝나 있으면 바로 보낸다. 뒤에 이어 적어야 하는 것(“제 가게는 ”)은
        // 커서만 두고 기다린다 — 반쪽짜리 문장을 보내면 엉뚱한 답이 온다.
        if (line && !line.endsWith(" ") && !line.endsWith(": ")) void chatSend();
      });
    };
  });
}

/* ══ 문제 알리기 ═══════════════════════════════════════════════════════
   웹(지갑·장터)과 **같은 상자**로 간다(`px_bug_reports`). 상자가 둘이면
   한 곳은 반드시 안 보게 된다.

   🔴 화면·오류·이 컴퓨터의 형편은 **묻지 않고** 담는다. 사람은 "안 돼요"
   라고만 적고, 그것만으로는 못 고친다. 대신 담지 않는 것이 분명히 있다 —
   12단어·개인키·AI 열쇠·주소·잔액. 신고 하나 편하자고 그걸 보내면 이
   프로그램이 여태 지켜 온 것이 한 줄로 무너진다. */
const RP_CATS: [string, string][] = [
  ["wallet-broken", "지갑이 안 열려요"],
  ["send-failed", "보내기가 안 돼요"],
  ["shop-order", "주문·계산이 안 돼요"],
  ["ravi-wrong", "라비가 틀리게 답해요"],
  ["install-run", "프로그램이 안 켜져요"],
  ["ui", "화면 문제"],
];

/** 방금 난 오류. 신고할 때 물어보면 이미 지나간 뒤다. */
const rpErrors: { kind: string; msg: string; at: string }[] = [];
function rpNote(kind: string, msg: unknown) {
  if (rpErrors.length >= 5) rpErrors.shift();
  rpErrors.push({ kind, msg: String(msg ?? "").slice(0, 300), at: new Date().toISOString() });
}
window.addEventListener("error", (e) => rpNote("error", e.message));
window.addEventListener("unhandledrejection", (e) =>
  rpNote("promise", (e.reason as Error)?.message ?? e.reason));

/** 지금 어느 화면인가. 신고에서 제일 값어치 있는 한 줄이다. */
function rpScreen(): string {
  const page = document.querySelector(".page.on")?.id?.replace("page-", "") || "?";
  const nav = document.querySelector<HTMLElement>(`nav a[data-page="${page}"] span`)?.textContent;
  // 🔴 탭은 **가게 화면일 때만** 붙인다. 가게 탭은 화면을 옮겨도 그대로
  //    남아 있어서, 그냥 붙이면 「라비 · orders」 같은 없는 자리가 적힌다.
  //    신고에서 제일 값어치 있는 한 줄이라 틀리면 엉뚱한 데를 열어 본다.
  if (page !== "shop") return nav || page;
  const tab = document.querySelector(".shoptab.on")?.id?.replace("shoptab-", "") || "";
  const say: Record<string, string> = {
    orders: "들어온 주문", menu: "메뉴판", sales: "매출·장부", mine: "가게 정보",
  };
  return (nav || page) + (tab ? ` · ${say[tab] || tab}` : "");
}

let rpPick: [string, string] | null = null;

function openReport(prefill = "") {
  const wrap = $("rpwrap");
  const text = $("rp-text") as HTMLTextAreaElement;
  const chips = $("rp-chips");
  rpPick = null;
  text.value = prefill;
  chips.innerHTML = RP_CATS.map(
    (c, i) => `<button data-rc="${i}">${escapeHtml(c[1])}</button>`,
  ).join("");
  chips.querySelectorAll<HTMLElement>("[data-rc]").forEach((b) => {
    b.onclick = () => {
      chips.querySelectorAll("[data-rc]").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      rpPick = RP_CATS[+b.dataset.rc!];
    };
  });
  // 무엇을 같이 보내는지 **먼저 보여 준다.** 몰래 담으면 그건 수집이다.
  // 🔴 값이 섞인 문장이라 화면 걷기로는 못 옮긴다 — 조각으로 쪼개져서
  //    사전 열쇠와 안 맞는다. 이런 자리만 `t()` 로 직접 옮긴다.
  $("rp-what").innerHTML =
    `${t("같이 보내는 것")} — <b>${escapeHtml(rpScreen())}</b> ${t("화면")} · ` +
    // 판 번호는 화면에 이미 있다(사이드바 로고 옆). 없는 이름을 새로
    // 만들면 두 곳이 어긋난다.
    `${rpErrors.length ? `${rpErrors.length}${t("건의 오류")}` : t("오류 없음")} · ` +
    `${t("판")} ${document.querySelector(".brand span")?.textContent || "?"}<br />` +
    `${t("지갑 12단어·열쇠·주소·잔액은 보내지 않습니다.")}`;
  wrap.style.display = "flex";
  setTimeout(() => text.focus(), 60);
}

async function sendReport() {
  const text = ($("rp-text") as HTMLTextAreaElement).value.trim();
  if (!text) return void ($("rp-text") as HTMLTextAreaElement).focus();
  const btn = $("rp-send") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "보내는 중…";
  try {
    const r = await invoke<any>("report_send", {
      title: text.slice(0, 60),
      description: text,
      category: rpPick ? rpPick[0] : "ui",
      screen: rpScreen(),
      context: {
        errors: rpErrors.slice(-5),
        theme: document.documentElement.dataset.theme || "",
        // 🔴 손님 폰 서버가 왜 안 켜졌는지. 이게 안 실려 오면 「손님이 주문할
        //    곳이 없습니다」라는 결과만 보고 원인을 못 찾는다 — 실제로 그랬다.
        phone_error: lastPhoneError,
      },
    });
    // 🔴 못 보냈으면 못 보냈다고 말한다. "고맙습니다" 만 띄우면 사장은
    //    보냈다고 여기고, 우리는 못 받는다. 대신 사라지지는 않는다.
    $("rp-what").innerHTML = r?.sent
      ? "보냈습니다. 고맙습니다."
      : "지금 인터넷이 안 닿아 <b>이 컴퓨터에 넣어 뒀습니다.</b> 다음에 켤 때 저절로 갑니다.";
    ($("rp-text") as HTMLTextAreaElement).value = "";
    setTimeout(() => { $("rpwrap").style.display = "none"; void rpLabel(); }, 1600);
  } catch (e) {
    $("rp-what").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "보내기";
  }
}

/** 못 보낸 것이 있으면 그렇게 말한다. 조용히 삼키면 보냈다고 여긴다. */
async function rpLabel() {
  try {
    const n = await invoke<number>("report_parked");
    const b = $("rp-open");
    b.textContent = n > 0 ? `문제 알리기 · 못 보낸 ${n}건` : "문제 알리기";
    b.classList.toggle("parked", n > 0);
  } catch {
    /* 이 줄이 실패해도 신고는 된다. 라벨일 뿐이다. */
  }
}

/* ══ QR 창 ═════════════════════════════════════════════════════════════
   🔴 여태 「손님 QR」 타일은 **설정 화면으로 데려다 놓기만** 했다. QR 은
   거기서 또 찾아야 했고, 사장·직원·검표 QR 은 어디 있는지도 몰랐다.
   카운터에서 손님이 기다리는데 화면을 뒤지게 하면 안 된다.

   ⚠️ 손님 QR 만 벽에 붙일 수 있다. 나머지 셋에는 **열쇠가 들어 있어서**,
   붙이면 열쇠를 벽에 붙이는 것이다. 그래서 손님 QR 을 크게 하나,
   나머지 셋을 작게 아래에 두고 테두리로 구별한다. */
/** 아직 안 된 것. 🔴 QR 을 띄우기 **전에**, 물어보지 않고 먼저 말한다. */
/**
 * **라비가 먼저 말할 것들** — 재어 둔 사실.
 *
 * 🔴 대표님: "사람들은 블록체인이면 인공지능처럼 자동으로 되는걸 원할걸."
 *
 *    지금 앱은 **이미 아는데 말을 안 한다.** 색인이 꺼져 나눠주기가 죽는
 *    것도, 사진을 이 컴퓨터만 들고 있어 노트북을 닫으면 손님 화면이 비는
 *    것도 앱은 안다. 사장만 모른다.
 *
 * ## 말할 것과 안 할 것 (그록과 정한 규칙)
 *
 * > **손님이 지금 막히거나 오늘 돈이 안 세어지는 것만 말한다.
 * > 상태는 묻지 않는다. 고칠 단추 없이 말하지 않는다. 모르면 침묵.**
 *
 * 「색인이 꺼져 있다」는 **상태**다. 「나눠주기·팬 수가 안 됩니다」가
 * 말해야 할 **실패**다.
 *
 * ⚠️ **LLM 을 부르지 않는다.** 이 사실들은 이미 잰 값이라 물어볼 것이
 *    없다. 돈이 들고, 기다리게 되고, 열쇠가 없으면 죽는다 — 그런데 열쇠가
 *    없어도 장사는 돌아야 한다. 그리고 매일 **같은 문장**이어야 사장이
 *    단추를 외운다. LLM 이 바꿔 말하면 못 외운다.
 *
 * ⚠️ **계산대(주문표)에서는 침묵한다.** 손님이 줄 서 있는 화면을 가리면
 *    그건 도움이 아니라 방해다.
 */
let 라비가아는것: { key: string; label: string; go?: () => void }[] = [];

/** 조용히 재 둔다. 화면을 막지 않게 실패는 그냥 넘긴다. */
async function 라비살피기() {
  const out: { key: string; label: string; go?: () => void }[] = [];

  // ① 색인이 꺼져 나눠주기·팬 수가 **죽는다.** 상태가 아니라 실패를 말한다.
  try {
    const r = await invoke<any>("reward_ready").catch(() => null);
    if (r && r.ready === false) {
      out.push({
        key: "index",
        label: t("나눠주기·팬 수를 셀 수 없습니다"),
        go: () =>
          raviPoint({
            page: "reward",
            el: "rw-gate",
            say: t(
              "자산 색인이 꺼져 있어 명단을 못 셉니다. 켜려면 43GB 를 다시 훑고 그동안 노드가 멈춥니다 — 문 닫는 시간에 하세요.",
            ),
          }),
      });
    }
  } catch { /* 못 재면 말하지 않는다 */ }

  // ② 사진을 이 컴퓨터만 들고 있다 → 노트북을 닫으면 손님 화면이 빈다.
  //    peers 도움은 **이 줄에 합친다.** 따로 잔소리하지 않는다.
  try {
    const mine = await invoke<any>("pin_list").catch(() => null);
    const assets = await invoke<any>("list_assets").catch(() => null);
    const 붙은것 = (Array.isArray(assets) ? assets : [])
      .filter((a: any) => !String(a?.name || "").endsWith("!"))
      .filter((a: any) => String(a?.ipfs_hash || "").startsWith("Qm"));
    const 지킴 = new Set(Array.isArray(mine) ? mine : []);
    const 안지킴 = 붙은것.filter((a: any) => !지킴.has(a.ipfs_hash));
    if (안지킴.length) {
      out.push({
        key: "pin",
        label: t("사진을 이 컴퓨터만 들고 있습니다"),
        go: () =>
          raviPoint({
            page: "parts",
            el: "pn-mine",
            say: t(
              "이 컴퓨터를 끄면 손님 화면에서 사진이 사라집니다. 「내 파일 지키기」를 누르시고, 다른 컴퓨터가 있으면 서로 들어 주게 하세요.",
            ),
          }),
      });
    }
  } catch { /* 못 재면 침묵 */ }

  라비가아는것 = out;
}

function shopTodo(): { bad: boolean; label: string; why: string; go?: () => void }[] {
  const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
  const name = val("sh-ko") || val("sh-en");
  const toShop = (tab: string) => () => {
    $("qrwrap").style.display = "none";
    showPage("shop");
    shopTab(tab);
  };
  return [
    {
      bad: !(nodeUp ?? true),
      label: t(nodeWarming ? "노드가 여는 중이에요" : "노드가 꺼져 있어요"),
      why: t("결제가 들어와도 확인을 못 합니다."),
      go: () => { $("qrwrap").style.display = "none"; showPage("settings"); },
    },
    {
      bad: !name,
      label: t("가게 이름이 비어 있습니다"),
      why: t("손님 화면 맨 위가 빈 채로 뜹니다."),
      go: toShop("mine"),
    },
    {
      bad: menuItems.length === 0,
      label: t("메뉴가 하나도 없습니다"),
      why: t("손님이 QR 을 찍어도 시킬 것이 없습니다."),
      go: toShop("menu"),
    },
    {
      // 체인 등록은 **장사에 꼭 필요한 것이 아니다.** 같은 와이파이 주문은
      // 등록 없이도 된다. 등록은 가게 목록(장터)에 뜨기 위한 것이다.
      // 🔴 여태 `sh-asset`(사장이 **치는 중인** 이름)을 봤다. 그건 등록
      //    여부와 상관없는 칸이라, 체인에 멀쩡히 올라가 있어도 이 띠가
      //    「등록하지 않았습니다」를 계속 띄웠다. 실제로 그 상태였다.
      //    등록됐다는 증거는 **체인에 올라간 이름**(`sh-registered`)이다.
      bad: !val("sh-registered"),
      label: t("체인에 가게를 등록하지 않았습니다"),
      why: t("같은 와이파이 주문은 됩니다. 다만 가게 목록에는 안 뜹니다."),
      // 탭만 열면 또 찾아야 한다. **체인에 남을 이름 칸**까지 데려간다.
      go: () => {
        $("qrwrap").style.display = "none";
        showPage("shop");
        shopTab("mine");
        const d = document.querySelector<HTMLDetailsElement>("#shoptab-mine details.onceoff");
        if (d) d.open = true;
        setTimeout(() => {
          const el = $("sh-asset");
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          (el as HTMLInputElement)?.focus?.();
          el?.classList.add("justwent");
          setTimeout(() => el?.classList.remove("justwent"), 1600);
        }, 220);
      },
    },
    {
      // 🔴 이건 **매일 켜고 끄는 것**이라 여기 있어야 한다.
      //
      //    지금까지는 왼쪽 아래 점으로만 보였다. 그 점을 누르면 설정 화면으로
      //    갈 뿐이라, 켜려면 두 번 눌러야 했다. 그런데 이게 꺼져 있으면
      //    **손님이 아예 못 들어온다** — 가게 문을 잠가 둔 것과 같다.
      //    가장 중요한 스위치를 가장 안 보이는 데 둔 셈이었다.
      // 모를 때(`null`)는 안 띄운다. 켜 둔 사장에게 「꺼져 있습니다」라고
      // 하면 그게 거짓말이고, 사장은 앱 말을 안 믿게 된다.
      bad: outUp === false,
      label: t("바깥 연결이 꺼져 있습니다"),
      why: t("가게 안 손님은 QR 로 시킬 수 있습니다. 바깥 손님은 못 들어옵니다."),
      go: () => toggleDot("out"),
    },
  ].filter((x) => x.bad);
}

async function openQrSheet() {
  const wrap = $("qrwrap");
  const body = $("qr-body");
  wrap.style.display = "flex";

  // 🔴 안 된 것을 **먼저** 그린다. QR 을 기다리는 동안 빈 창을 보여 주면
  //    사장은 고장으로 읽는다. 그리고 여기 적힌 것이 진짜 원인일 때가 많다.
  const todo = shopTodo();
  const todoHtml = todo.length
    ? `<div class="warnbox" style="margin-bottom:14px">
         <b>${t("아직 안 된 것이 있습니다")}</b>
         ${todo.map((x, i) =>
           `<div style="margin-top:8px">• <b>${escapeHtml(x.label)}</b><br />
              <span class="meta">${escapeHtml(x.why)}</span>
              ${x.go ? ` <button class="ghost" data-todo="${i}" style="min-height:32px;padding:0 10px;margin-left:4px">${t("고치러 가기")}</button>` : ""}
            </div>`).join("")}
       </div>`
    : "";
  body.innerHTML = todoHtml + `<div class="meta">${t("여는 중…")}</div>`;
  body.querySelectorAll<HTMLElement>("[data-todo]").forEach((b) => {
    b.onclick = () => todo[+b.dataset.todo!].go?.();
  });

  try {
    // 이미 켜져 있으면 그대로 다시 읽고, 꺼져 있으면 여기서 켠다 —
    // 「손님 QR」을 누른 사람은 이미 켜고 싶다는 뜻이다.
    // ⚠️ 무엇이 걸리든 창이 「여는 중…」에서 멈추면 안 된다. 20초를 넘기면
    //    멈춘 이유를 말해 준다 — 말없이 기다리게 하는 것이 제일 나쁘다.
    const r = await Promise.race([
      invoke<any>("start_phone_server"),
      new Promise((_, no) =>
        setTimeout(() => no(new Error(t("20초 안에 열리지 않았습니다."))), 20000)),
    ]) as any;
    serverIp = r.ip;
    localStorage.setItem(PHONE_KEY, "1");
    // 가게 정보를 손님 화면에 올리는 것은 QR 보다 뒤여도 된다. 여기서
    // 실패해도 QR 은 나와야 한다.
    try { await publishShop(r.ip); } catch { /* 메뉴만 빈다 */ }

    const [adminQr, staffQr, scanQr, custQr, extraIps] = await Promise.all([
      invoke<string>("qr_svg", { text: r.admin_url }),
      invoke<string>("qr_svg", { text: r.staff_url }),
      invoke<string>("qr_svg", { text: r.scan_url }),
      invoke<string>("qr_svg", { text: r.customer_url }),
      invoke<string[]>("all_local_ips").catch(() => [] as string[]),
    ]);

    const qrLinks = (url: string) => {
      let path = "";
      try {
        const u = new URL(url);
        path = u.pathname + u.search;
      } catch {
        return `<code class="addr qrurl">${escapeHtml(url)}</code>`;
      }
      const hosts = extraIps.length ? extraIps : [String(r.ip)];
      return hosts
        .map((ip) => `<code class="addr qrurl">http://${escapeHtml(ip)}:${escapeHtml(String(r.port))}${escapeHtml(path)}</code>`)
        .join("");
    };

    body.innerHTML = todoHtml +
      `<div class="qrmain">${custQr}
         <div>
           <b style="font-size:19px">${t("손님")}</b>
           <div class="meta" style="margin-top:6px;font-size:15px;line-height:1.7">
             ${t("카운터에 붙이세요. 이 QR 에는 열쇠가 없어 누가 봐도 괜찮습니다.")}<br />
             ${escapeHtml(r.ip)}:${escapeHtml(String(r.port))} ·
             ${t("폰을 같은 와이파이에 붙이고 찍으세요")}
             <span id="qr-ips"></span>
           </div>
           ${qrLinks(r.customer_url)}
         </div>
       </div>` +
      `<div class="meta" style="margin-bottom:8px">
         🔴 ${t("아래 셋에는 열쇠가 들어 있습니다. 붙이지 말고, 찍을 때만 보여 주세요.")}
         ${t("QR 이 안 열리면 아래 주소를 폰 브라우저에 치세요.")}
       </div>` +
      `<div class="qrothers">
         <div class="qrcard haskey">${adminQr}<b>${t("사장님만")}</b>
           <span>${t("돈·발행·설정 전부")}</span>
           ${qrLinks(r.admin_url)}</div>
         <div class="qrcard haskey">${staffQr}<b>${t("직원")}</b>
           <span>${t("주문·회원확인만")}</span>
           ${qrLinks(r.staff_url)}</div>
         <div class="qrcard haskey">${scanQr}<b>${t("검표 태블릿")}</b>
           <span>${t("문 앞에 두는 화면")}</span>
           ${qrLinks(r.scan_url)}</div>
       </div>` +
      // 🔴 여기는 「이 컴퓨터 → 손님 폰으로 받기 에 있습니다」라고만 적혀
      //    있었다. **그 화면에도 없었다.** 러스트 명령(`table_qr_sheet`)도,
      //    배선도 다 있는데 칸(`tbl-list`·`tbl-print`)이 index.html 에 아예
      //    없어서, 누르는 곳 자체가 존재하지 않았다.
      //
      //    찾아가라고 적는 대신 **여기서 바로 뽑는다.** 손님 QR 을 보러 온
      //    사람이 찾는 것이 그것이다.
      `<div class="tblbox">
         <b>${t("테이블마다 다른 QR")}</b>
         <span class="meta" style="margin-left:8px">${t("안 쓰셔도 됩니다")}</span>
         <div class="meta" style="margin:4px 0 8px">
           ${t("위의 손님 QR 하나로도 장사가 됩니다.")}
           ${t("테이블이 있는 가게만, 자리마다 다른 QR 을 붙이면 어느 자리 주문인지 저절로 찍힙니다.")}<br />
           ${t("번호를 쉼표나 띄어쓰기로 적으세요. 인쇄용 한 장이 만들어집니다.")}
         </div>
         <div class="row" style="gap:8px">
           <input id="tbl-list" placeholder="1 2 3 4 5 · 창가 · 룸A" autocomplete="off"
                  style="flex:1;min-width:0" />
           <button class="ghost" id="tbl-print" style="flex:none">${t("만들기")}</button>
         </div>
         <div class="meta" id="tbl-note" style="margin-top:8px"></div>
       </div>`;

    // 창을 다시 그릴 때마다 새 칸이 생긴다. 시작할 때 한 번 묶어 두면
    // 두 번째 여는 사람에게는 안 걸린다 — 그래서 여기서 묶는다.
    bindTableQr();

    /* 🔴 **주소가 둘 이상이면 전부 알려 준다.**
       계산대 컴퓨터에 랜선과 와이파이가 둘 다 꽂혀 있는 일이 흔하다.
       그때 우리가 고른 하나가 손님 폰과 **다른 망**일 수 있고, 그러면
       QR 을 찍어도 아무것도 안 열린다 — 아무 설명 없이.

       실제로 그랬다: 이 컴퓨터가 en0 에 .57(와이파이), en6 에 .58(랜선)을
       가지고 있었고 QR 에는 .58 이 박혔다. 폰은 와이파이에 있었다.

       어느 것이 맞는지는 이 컴퓨터가 알 수 없다. 폰을 든 사람은 한 번
       눌러 보면 안다. */
    {
      const box = document.getElementById("qr-ips");
      if (box && extraIps.length >= 2) {
        box.innerHTML =
          `<br /><b>${t("이 컴퓨터는 주소가 둘 이상입니다")}</b> —
           ${t("위 QR 이 안 열리면 폰 브라우저에 이 주소를 쳐 보세요:")}<br />` +
          extraIps
            .map((ip) => `<code class="addr">http://${escapeHtml(ip)}:${r.port}</code>`)
            .join(" · ");
      }
    }
  } catch (e) {
    // 못 켰으면 못 켰다고 말한다. 빈 창을 띄우면 고장으로 읽는다.
    // 🔴 다만 **원문 오류를 크게 띄우지 않는다.** 영어 한 줄을 보여 주면
    //    사장은 다음에 할 일을 못 찾는다. 할 일을 먼저 적고, 원문은
    //    작게 아래에 둔다(신고할 때 이 줄이 쓸모 있다).
    body.innerHTML = todoHtml +
      `<div class="warnbox">
         <b>${t("손님 폰 서버를 켜지 못했습니다.")}</b><br />
         ${t("노드가 켜져 있는지 보시고, 잠시 뒤에 다시 눌러 주세요.")}
       </div>
       <div class="meta" style="margin-top:10px">${escapeHtml(errText(e))}</div>`;
  }
}

/** 영업 중 / 지금 닫기 두 칸. 체크박스는 숨어서 그대로 남아 있고,
    저장·라비의 「closed」 동사·「아직 안 된 것」이 전부 그 칸을 읽는다. */
function paintOpenPick() {
  const box = $("sh-closednow") as HTMLInputElement | null;
  if (!box) return;
  const closed = box.checked;
  $("sh-open-btn")?.classList.toggle("on", !closed);
  $("sh-close-btn")?.classList.toggle("on", closed);
  // 🔴 「손님에게 보일 한마디」는 **닫았을 때만** 보인다. 열려 있는데
  //    「재료가 떨어졌습니다」를 적어 두라고 하면 그 칸이 무엇인지 알 수 없다.
  const note = $("sh-closednote");
  if (note) note.style.display = closed ? "" : "none";
}

/** 두 칸 중 하나를 고른다. 이미 그 상태면 아무 일도 안 한다 —
    같은 칸을 두 번 눌러 장사가 껐다 켜졌다 하면 안 된다. */
function setOpenState(closed: boolean) {
  const box = $("sh-closednow") as HTMLInputElement | null;
  if (!box || box.checked === closed) return;
  box.checked = closed;
  // 화면에 이미 붙어 있는 처리(미리보기·저장)를 그대로 태운다.
  box.dispatchEvent(new Event("change", { bubbles: true }));
  paintOpenPick();
  paintRavi();
}

/* ══ 화면마다 큰 아이콘 줄 ═══════════════════════════════════════════
   대표님: "다른 메뉴들도 안 되어 있다면 라비 화면과 같은 문법으로 모두
   수정해줘."

   🔴 화면을 다시 짜지 않는다. 지갑·자산·배당·이 컴퓨터는 **잘 돌고 있고**,
   돈과 발행이 걸린 화면이라 재작성은 그 자체가 위험이다. 대신 **맨 위에
   할 일을 큰 아이콘으로** 얹는다 — 아래 있던 것은 그대로 둔다.

   그러면 배울 것이 하나가 된다: 어느 화면이든 위쪽 큰 칸이 「지금 할 일」,
   아래는 「자세한 것」. 라비 화면과 같은 문법이다. */
type PageTile = { icon: string; label: string; sub: string; go: () => void };

function pageTiles(page: string): PageTile[] {
  /* 🔴 그냥 스크롤만 하면 **아무 일도 안 일어난다.** 대표님이 겪은 그것이다 —
     백업·AI 열쇠·채굴은 전부 접힌 「고급」 안에 있어서, 접힌 것을 스크롤해
     봐야 화면이 그대로다.

     그래서 셋을 한다: ① 가는 길의 접힌 것을 **전부 펼치고**
     ② 그 자리로 가고 ③ **잠깐 빛나게** 해서 어디로 갔는지 보이게 한다.
     빛나지 않으면, 이미 보이던 자리로 간 경우 눌러도 안 눌린 줄 안다. */
  const jump = (id: string) => () => {
    const el = document.getElementById(id);
    if (!el) return;
    // ① 이 자리를 감싼 접힌 것을 전부 펼친다.
    let up: HTMLElement | null = el;
    while (up) {
      if (up instanceof HTMLDetailsElement) up.open = true;
      up = up.parentElement;
    }
    // ② 펼치고 나서 자리가 잡히면 간다.
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      (el as HTMLInputElement).focus?.();
      // ③ 잠깐 빛낸다.
      el.classList.add("justwent");
      setTimeout(() => el.classList.remove("justwent"), 1600);
    }, 60);
  };
  if (page === "wallet") {
    return [
      { icon: I('<path d="M12 4v11M8 11l4 4 4-4"/><path d="M4.5 19.5h15"/>'),
        label: "받기", sub: "받을 주소 만들기", go: () => $("w-newaddr")?.click() },
      { icon: I('<path d="M12 20V9M8 13l4-4 4 4"/><path d="M4.5 4.5h15"/>'),
        label: "보내기", sub: "RVN 보내기", go: () => openSend("rvn") },
      { icon: I('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
        label: "자산 보내기", sub: "쿠폰 · 회원권", go: () => openSend("asset") },
      { icon: I('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17M8 14h4"/>'),
        label: "최근 거래", sub: "들어오고 나간 것", go: jump("w-foreign") },
    ];
  }
  if (page === "assets") {
    return [
      { icon: I('<path d="M12 5v14M5 12h14"/>'),
        label: "새 자산 만들기", sub: "쿠폰 · 회원권 · 굿즈", go: () => $("new-asset")?.click() },
      { icon: I('<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v4h-4"/>'),
        label: "새로고침", sub: "다시 읽어오기", go: () => $("refresh")?.click() },
      /* 🔴 이 둘이 **눌러도 아무 일이 없었다.** 하나는 disabled, 하나는
         display:none 이라 스크롤해도 화면이 그대로였다. 대표님이 겪은 그것이다.
         이제 **지금 상태를 칸에 적고**, 눌리지 않는 때에도 어디를 봐야 하는지
         데려간다. 아무 일도 안 일어나는 칸은 고장으로 읽힌다. */
      (() => {
        const btn = $("pin-all") as HTMLButtonElement | null;
        const none = !btn || btn.disabled;
        return {
          icon: I('<path d="M12 3.5l7.5 4v9L12 20.5 4.5 16.5v-9z"/><path d="M9 12l2 2 4-4"/>'),
          label: "파일 지키기",
          sub: none ? "지킬 것이 없습니다" : "이 컴퓨터에 보존",
          go: () => (none ? jump("assets")() : btn!.click()),
        };
      })(),
      (() => {
        const wrap = $("vend-wrap");
        const none = !wrap || wrap.style.display === "none";
        return {
          icon: I('<path d="M4 6.5h16v11H4z"/><path d="M4 10h16M8 14h4"/>'),
          label: "내놓은 자산",
          sub: none ? "아직 없습니다" : "팔고 있는 것",
          go: () => (none ? jump("assets")() : jump("vend-wrap")()),
        };
      })(),
      /* 🔴 **나눠주기를 1차 메뉴에서 내렸으면 들어갈 문을 눈에 보이게 둬야 한다.**

         자산을 고른 뒤에 나오는 단추로만 두었더니, 이 앱을 제일 잘 아는
         대표님이 **두 번 못 찾으셨다.** 「자산 → 자산 누르기 → 패널 → 단추」는
         세 걸음이고 세 번째까지는 아무 데도 안 보인다. 숨긴 것은 옮긴 것이
         아니다 — 그건 없앤 것이다.

         메뉴로 되돌리지는 않는다. 나눠주기는 **자산에 하는 일**이 맞다.
         대신 이 줄(「지금 할 일」)에 둔다 — 자산을 안 골라도 보이고,
         눌러 들어가면 그 화면이 열린다. */
      {
        icon: I('<circle cx="12" cy="9" r="5.5"/><path d="M8.5 13.5L7 21l5-2.5L17 21l-1.5-7.5"/>'),
        label: "나눠주기",
        sub: "가진 사람들에게",
        // 🔴 그냥 `showPage` 하면 **화면만 툭 바뀐다.** 라비가 데려갈 때와
        //    같은 대접을 한다 — 어디로 왔는지 말하고, 첫 칸을 빛나게.
        go: () =>
          raviPoint({
            page: "reward",
            el: "rw-asset",
            say: "자산을 가진 사람들에게 RVN 을 나눠 주는 곳입니다. 먼저 어느 자산인지 적습니다.",
          }),
      },
      /* 🔴 접힌 칸은 **스크롤해도 아무 일이 안 일어난다.** 이 화면에서 이미
         한 번 겪은 병이라(위 두 칸의 주석), 팬클럽도 같은 실수를 안 하게
         **펼치고 · 데려가고 · 빛나게** 한다. */
      {
        icon: I(
          '<circle cx="9" cy="8.5" r="3"/><path d="M2.8 19.5c0-3.2 2.8-5.2 6.2-5.2s6.2 2 6.2 5.2"/>' +
            '<path d="M16.5 5.9a3 3 0 0 1 0 5.2"/><path d="M18.4 14.6c1.8.8 2.8 2.3 2.8 4"/>',
        ),
        label: "팬클럽",
        sub: "음반마다 팬 방 · 한 번에 알리기",
        go: () => {
          const d = document.getElementById("fanbox") as HTMLDetailsElement | null;
          if (d) d.open = true;
          // 펼친 뒤에 읽어 온다. 읽기 전에 데려가면 빈 칸으로 도착한다.
          void fanLoad();
          jump("fanbox")();
        },
      },
    ];
  }
  if (page === "reward") {
    return [
      { icon: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
        label: "명단 굳히기", sub: "먼저 예약합니다", go: () => $("rw-asset")?.focus() },
      { icon: I('<path d="M4 6.5h16v11H4z"/><path d="M8 10h8M8 14h5"/>'),
        label: "예약해 둔 것", sub: "굳은 명단", go: jump("rw-list") },
      { icon: I('<path d="M12 3v9M8 8l4-4 4 4"/><path d="M4 14v5.5h16V14"/>'),
        label: "나눠 주기", sub: "보유자 전원에게", go: () => $("rw-pay")?.focus() },
    ];
  }
  if (page === "settings") {
    return [
      // 🔴 **제일 앞에 둔다.** 대표님이 두 번 연속으로 못 찾으셨다 —
      //    "이 컴퓨터 어디에 입력해야 하는거야", "한 번에 준비하기 버튼이
      //    안 보이는데". 노드 상태 화면 안에만 뒀기 때문이다.
      //    처음 깐 사람이 설정을 찾을 자리는 거기가 아니라 여기다.
      { icon: I('<path d="M12 3.5l3 3-3 3-3-3z"/><path d="M4.5 12l3 3-3 3-3-3z" transform="translate(4.5 -1.5)"/><path d="M12 14.5v6M6 20.5h12"/>'),
        label: "한 번에 준비하기", sub: "백신 · 방화벽 · 메모리", go: gotoPrep },
      { icon: I('<path d="M12 3.5l7.5 4v9L12 20.5 4.5 16.5v-9z"/><path d="M12 8.5v4M12 15.5h.01"/>'),
        label: "쉬운 설정", sub: "제가 정해 드려요", go: jump("easy-setup") },
      { icon: I('<path d="M4 7.5h16v12H4z"/><path d="M9 7.5V5h6v2.5M12 11v5M9.5 13.5h5"/>'),
        label: "백업", sub: "만들고 · 되돌리기", go: jump("bk-go") },
      { icon: I('<path d="M9 12a3 3 0 116 0 3 3 0 01-6 0z"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
        label: "AI 열쇠", sub: "라비를 깨웁니다", go: jump("key-note") },
      { icon: I('<path d="M4 18.5h16"/><path d="M7 18.5V11M12 18.5V6M17 18.5v-4.5"/>'),
        label: "채굴", sub: "수익 계산 · 켜고 끄기", go: jump("mn-gpu") },
    ];
  }
  return [];
}

/**
 * 「한 번에 준비하기」로 데려간다.
 *
 * 🔴 데려가기만 하면 또 못 찾는다 — 그 화면에도 칸이 여럿이다.
 *    그래서 **그 단추를 화면 가운데로 올리고 잠깐 깜빡인다.**
 *    누르는 것은 사장이 한다(관리자 창이 뜨는 일이라 대신 누르지 않는다).
 */
function gotoPrep() {
  toggleDot("node");
  // 화면이 그려질 때까지 기다린다. paintPart 가 비동기라 바로는 없다.
  let tries = 0;
  const look = window.setInterval(() => {
    const b = document.getElementById("pc-go");
    if (b) {
      window.clearInterval(look);
      b.scrollIntoView({ block: "center", behavior: "smooth" });
      b.classList.add("flash");
      setTimeout(() => b.classList.remove("flash"), 2400);
    } else if (++tries > 40) {
      window.clearInterval(look);
    }
  }, 120);
}

/** 화면 맨 위에 큰 아이콘 줄을 그린다. 없으면 아무 일도 안 한다. */
function paintPageTiles(page: string) {
  const host = document.getElementById(`pt-${page}`);
  if (!host) return;
  const tiles = pageTiles(page);
  host.innerHTML = tiles
    .map((x, i) => `<button class="tile" data-pt="${i}">${x.icon}` +
      `<span>${escapeHtml(t(x.label))}</span>` +
      `<span class="tsub">${escapeHtml(t(x.sub))}</span></button>`)
    .join("");
  host.querySelectorAll<HTMLElement>("[data-pt]").forEach((b) => {
    b.onclick = () => tiles[+b.dataset.pt!].go();
  });
}

/** 한 글자씩 친다. 라비가 대신 치는 것이니 **치는 모습이 보여야** 한다.
 *
 * ⚠️ 너무 느리면 기다리게 되고, 너무 빠르면 안 보인다. 한 글자 14ms 면
 *    30글자에 0.4초다 — 눈에는 보이고 손은 안 기다린다.
 * ⚠️ 사람이 중간에 손대면 **즉시 멈춘다.** 내가 치는데 화면이 계속
 *    글자를 밀어 넣으면 그건 방해다. */
let typing: number | null = null;
function typeInto(el: HTMLInputElement, text: string, done?: () => void) {
  if (typing !== null) window.clearInterval(typing);
  let i = 0;
  el.classList.add("typing");
  typing = window.setInterval(() => {
    // 사람이 끼어들었으면 그만둔다.
    if (document.activeElement !== el && el.value !== text.slice(0, i)) {
      window.clearInterval(typing!);
      typing = null;
      el.classList.remove("typing");
      return;
    }
    i += 1;
    el.value = text.slice(0, i);
    if (i >= text.length) {
      window.clearInterval(typing!);
      typing = null;
      el.classList.remove("typing");
      done?.();
    }
  }, 14);
}

/* ══ 표시등을 눌러서 지금 상태 보기 ═══════════════════════════════════
   대표님: "노드 켜짐 버튼과 파일창고 켜짐 누르면 얼마나 어떻게 작동하고
   있는지 실시간 보여주나?" — 안 보여줬다. 불 하나만 켜져 있었다.

   ⚠️ 펼쳐 놓았을 때만 다시 읽는다. 접혀 있는데 계속 물어보면 노드가
   쓸데없이 바빠지고, 그 노드는 손님 결제를 확인해야 하는 노드다. */

type Part = "node" | "mine" | "ipfs" | "relay" | "out";
let partOpen: Part = "node";
let partTimer: number | null = null;
/** 바깥 연결 안내 문구. 🔴 5초마다 다시 그리므로 화면 밖에 둬야 안 지워진다. */
let outSay = "";

/**
 * 표시등을 누르면 **오른쪽 넓은 화면**에 상태와 설정이 열린다.
 *
 * 🔴 두 번 틀렸다. 처음엔 172px 사이드바에서 펼쳤는데
 * `.navfoot div { display: flex }` 가 줄을 가로로 눕혀 **글자가 한 줄에 한
 * 자씩** 흘렀다. 그다음엔 「이 컴퓨터」로 보냈는데, 그건 어디를 보라는
 * 건지 알 수 없었다 — 대표님 말씀대로 **상태를 보여줘야** 하는 자리다.
 *
 * 넷이 이 프로그램의 전부다: 노드·채굴·파일창고·릴레이.
 */
function toggleDot(which: Part) {
  partOpen = which;
  showPage("parts");
  document.querySelectorAll<HTMLElement>("[data-part]").forEach((b) => {
    b.classList.toggle("on", b.dataset.part === which);
  });
  if (partTimer !== null) {
    clearInterval(partTimer);
    partTimer = null;
  }
  void paintPart();
  // 열려 있는 동안만 갱신한다. 닫힌 화면을 5초마다 부르면 헛일이다.
  partTimer = window.setInterval(() => void quietly(paintPart), 5000);
}

/** 지금 고른 것의 상태와 설정. */
/**
 * 꺼져 있는 것에 붙이는 「지금 켜기」.
 *
 * 🔴 여태 넷(노드·채굴·파일창고·릴레이) 다 「꺼져 있습니다」라고만 하고
 *    켜는 단추가 없었다. 사장은 그 화면에서 할 일이 없어 나간다.
 *    무엇이 꺼졌는지 아는 것보다 켜는 것이 목적이다.
 */
function turnOnBtn(id: string): string {
  return `<button id="${id}" style="margin-top:12px">${t("지금 켜기")}</button>
          <div class="meta" id="${id}-say" style="margin-top:10px"></div>`;
}

/** 위 단추를 눌리게 묶는다. HTML 을 넣은 뒤에 부른다. */
function bindTurnOn(id: string, cmd: string) {
  const b = document.getElementById(id);
  if (!b) return;
  b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    const say = document.getElementById(`${id}-say`);
    if (say) say.textContent = t("켜는 중…");
    try {
      const r = await invoke<any>(cmd);
      // 못 켰으면 이유를 그대로 보여 준다. 조용히 실패하면 또 누른다.
      const why = (r?.skipped || []).map((x: any) => `${x.what}: ${x.why}`).join(" · ");
      if (say) say.textContent = why || t("켰습니다. 잠시 뒤 다시 봐 주세요.");
    } catch (e) {
      if (say) say.textContent = String((e as Error)?.message || e);
    }
    setTimeout(() => void paintPart(), 3000);
  });
}


/**
 * 켤 때 앱이 대신 해 둔 일. 노드·파일창고를 묻지 않고 켜고, 첫 설치면
 * 설정까지 갖춘다(러스트 `boot.rs`).
 *
 * 아직 안 끝났으면 `pending` 이 온다 — 그때는 담아 두지 않고 다음에 다시 묻는다.
 */
let bootRep: any = null;
async function bootReport(): Promise<any> {
  if (bootRep) return bootRep;
  const r = await invoke<any>("boot_report").catch(() => null);
  if (r && !r.pending) bootRep = r;
  return r;
}

/**
 * 「켤 때 이런 일을 했습니다 / 이건 못 켰습니다」 한 칸.
 *
 * 🔴 못 켠 것이 **없으면 아무것도 안 그린다.** 늘 떠 있는 안내는 아무도 안
 *    읽고, 진짜 문제가 생겼을 때 그 속에 묻힌다.
 */
async function bootStrip(): Promise<string> {
  const r = await bootReport();
  if (!r || r.pending) return "";
  const notes: string[] = (r.notes || []).map(String);
  const bad: string[] = (r.skipped || [])
    .filter((x: any) => !String(x?.why || "").includes("이미 켜져"))
    .map((x: any) => `${x.what} — ${x.why}`);
  if (!notes.length && !bad.length) return "";
  return (
    `<div class="card" data-bootstrip style="margin-bottom:14px">` +
    (notes.length
      ? `<div class="meta">${t("켤 때 대신 해 둔 일")}<br />${notes
          .map((n) => `· ${escapeHtml(n)}`)
          .join("<br />")}</div>`
      : "") +
    (bad.length
      ? `<div class="meta" style="color:var(--warn);margin-top:${notes.length ? 8 : 0}px">` +
        `${t("이건 못 켰습니다")}<br />${bad.map((n) => `· ${escapeHtml(n)}`).join("<br />")}</div>`
      : "") +
    `</div>`
  );
}

/**
 * 파트 화면. 그리고 나서 **맨 위에 「켤 때 있었던 일」을 붙인다.**
 * 각 갈래마다 붙이면 열두 군데를 고쳐야 하고, 언젠가 한 곳을 빠뜨린다.
 */
async function paintPart(): Promise<void> {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  await paintPartBody();
  const box = document.getElementById("pt-body");
  if (!box || box.querySelector("[data-bootstrip]")) return;
  const strip = await bootStrip();
  if (strip) box.insertAdjacentHTML("afterbegin", strip);
}

/**
 * 따라잡는 중일 때만 나오는 칸 — **메모리를 넉넉히 주면 빨라진다.**
 *
 * ## 🔴 우리가 반대로 권하고 있었다
 *
 * 노드 설정의 권장값이 300MB 였다. 코어 기본값 450 보다도 낮다. 그런데
 * 장부를 처음부터 훑을 때 이 값이 **속도를 가장 크게 가른다.**
 * 대표님 윈도우가 5시간에 0.63% 였고, 그중 상당 부분이 이 탓이다.
 *
 * ⚠️ 다 따라잡으면 이 칸이 사라진다. 그때는 되돌리는 편이 낫다고 적는다 —
 *    계산대 메모리를 노드가 계속 물고 있으면 주문 화면이 느려진다.
 */
async function speedCard(): Promise<string> {
  let s: any = null;
  try {
    s = await invoke<any>("dbcache_suggest");
  } catch (e) {
    // 🔴 **조용히 감추지 않는다.** 예전에는 여기서 빈 글자를 돌려줘서
    //    칸이 통째로 사라졌고, 사장은 「빠르게 따라잡기가 안 보인다」만
    //    겪었다. 왜 안 보이는지 화면 어디에도 없었다.
    return `<div class="card" style="margin-top:12px">
        <h3>${t("빠르게 따라잡기")}</h3>
        <p class="meta danger">${escapeHtml(errText(e))}</p>
        <p class="meta">${t("「노드 설정 열기」에서 「메모리 사용」을 2000 이상으로 직접 정하셔도 됩니다.")}</p>
      </div>`;
  }
  try {
    // 이미 넉넉하면 **그렇다고 말한다.** 칸이 없으면 사장은 눌러야 할
    // 것이 있는지 없는지 알 수 없다.
    if (!s?.worth_it) {
      return `<div class="card" style="margin-top:12px">
          <h3>${t("빠르게 따라잡기")}</h3>
          <div class="kv"><b>${t("지금 메모리")}</b><span>${Number(s?.now ?? 0).toLocaleString()} MB</span></div>
          <p class="meta"><span class="ok">${t("이미 넉넉합니다. 더 올려도 크게 안 빨라집니다.")}</span></p>
        </div>`;
    }
    // 🔴 칸 제목과 단추 이름을 **같게** 둔다. 달라서 「그 단추가 이건가」를
    //    묻게 됐다. 같은 것을 두 이름으로 부르면 안 된다 — 오늘만 두 번째다.
    return `<div class="card" style="margin-top:12px;border-color:var(--brand)">
        <h3>${t("빠르게 따라잡기")}</h3>
        <p class="meta">${t("노드에 메모리를 더 주면 장부를 훨씬 빨리 훑습니다.")}</p>
        <div class="kv"><b>${t("지금 메모리")}</b><span>${Number(s.now).toLocaleString()} MB</span></div>
        <div class="kv"><b>${t("권하는 값")}</b><span><b>${Number(s.suggest).toLocaleString()} MB</b></span></div>
        <p class="meta">${escapeHtml(String(s.why || ""))}</p>
        ${s.measured ? "" : `<p class="meta warn">${t("이 컴퓨터의 메모리를 못 읽어서 8GB 로 셈했습니다. 실제와 다르면 「노드 설정 열기」에서 직접 정하세요.")}</p>`}
        <div class="row" style="margin-top:10px">
          <button id="nd-fast">${t("빠르게 따라잡기")}</button>
          <span class="meta" id="nd-fastsay"></span>
        </div>
      </div>`;
  } catch {
    // 못 읽어도 나머지 화면은 그대로 보여야 한다.
    return "";
  }
}

/**
 * 다 따라잡은 뒤 **되돌리는 칸.**
 *
 * 🔴 올리는 단추만 주고 되돌리는 길을 안 주면, 계산대 메모리를 노드가
 *    영원히 물고 있게 된다. 빠르게 해 주려다 느리게 만드는 셈이다.
 *    되돌릴 것이 없으면 안 그린다 — 늘 있는 칸은 아무도 안 읽는다.
 */
/**
 * **멈춰 있는가.**
 *
 * 🔴 대표님 화면에서 블록이 13분 동안 한 칸도 안 움직였는데, 우리는
 *    「따라잡는 중」이라고만 적고 있었다. 도는 것과 멈춘 것을 구별하지
 *    못한 것이다. 사장은 그 앞에서 몇 시간을 기다린다.
 *
 * ⚠️ 「따라잡음 %」로는 못 본다. 재색인 초반에는 거래가 적어 그 값이
 *    거의 안 움직이기 때문이다. **블록 수**가 실제로 나아가는 표시다.
 */
/**
 * **이 컴퓨터 준비하기** — 단추 하나.
 *
 * 🔴 대표님: "백신에 등록하던가 그런 거 다 알아서 해 줄 수는 없나?"
 *            "프로그램 하나로 처리가 안 되나?"
 *
 *    그동안 우리는 사장에게 숙제를 다섯 개 냈다 — 백신 예외, 방화벽,
 *    메모리, 자동 시작, 폴더 경로 붙여넣기. 하나하나는 별것 아닌데
 *    다섯이 되면 아무도 안 한다. 그리고 못 한 채로 「느리다」고 겪는다.
 */
/**
 * 🔴 준비 결과는 **화면 밖에 둔다.**
 *
 * 이 화면은 5초마다 통째로 다시 그린다(`partTimer`). 준비하기는 관리자
 * 창을 띄우고 몇 초 걸리는데, 그사이 다시 그려지면 `innerHTML` 이 결과를
 * **지운다.** 사장은 눌러도 아무 일 없었던 것처럼 겪는다 — 실제로 그렇게
 * 겪으셨다("한번에 준비하기 눌렀는데 지금 화면 맞나? 예도 눌렀어").
 *
 * 같은 함정을 `outSay` 에 이미 적어 놨는데 또 밟았다. 그래서 여기에도 적는다.
 */
let prepFolder = "";
let prepSay = "";
let prepOut = "";
let prepBusy = false;

function prepCard(behind: number): string {
  return `<div class="card" style="margin-top:12px">
      <h3>${t("이 컴퓨터 준비하기")}</h3>
      <p class="meta">${t(
        "백신 검사에서 빼기 · 방화벽 열기 · 메모리 넉넉히 주기 · 켤 때 같이 켜기 — 한 번에 해 드립니다."
      )}</p>
      <p class="meta">${t("관리자 권한을 묻는 창이 한 번 뜹니다. 「예」를 눌러 주십시오.")}</p>
      <div class="row" style="margin-top:10px">
        <button id="pc-go"${prepBusy ? " disabled" : ""}>${t("한 번에 준비하기")}</button>
        <span class="meta" id="pc-say">${prepSay}</span>
      </div>
      <div id="pc-out">${prepOut}</div>
    </div>`.replace("<!--behind-->", String(behind));
}

/** 복사 단추만 붙인다. 결과가 다시 그려질 때마다 새 단추가 생기기 때문이다. */
/**
 * **너무 오래 걸릴 때 왜 그런지 말한다.**
 *
 * 🔴 「기다리십시오」만 적으면 사장은 한 달을 기다린다. 무엇이 느리게
 *    만드는지는 **우리가 켜 놓은 것**이라 우리가 안다.
 */
function slowCard(behind: number, rate: number): string {
  if (rate <= 0 || behind <= 0) return "";
  const day = behind / rate / 86400;
  if (day < 7) return "";
  return `<div class="card" style="margin-top:12px;border-color:var(--warn)">
      <h3>${t("이대로면 너무 오래 걸립니다")}</h3>
      <p class="meta">${t("지금 속도로는")} ${Math.round(day)}${t(
        "일 걸립니다. 아래 셋 중 하나가 원인인 경우가 대부분입니다."
      )}</p>
      <div class="kv"><b>${t("① 디스크")}</b><span>${t(
        "HDD 면 SSD 보다 20~50배 느립니다. 작업 관리자 → 성능 → 디스크 에서 보실 수 있습니다."
      )}</span></div>
      <div class="kv"><b>${t("② 백신")}</b><span>${t(
        "장부 폴더를 검사에서 빼야 합니다 — 위 「한 번에 준비하기」가 해 드립니다."
      )}</span></div>
      <div class="kv"><b>${t("③ 색인")}</b><span>${t(
        "「이 노드로 지갑도 열기」를 켜 두면 여러 배 느려집니다. 급하시면 다 따라잡은 뒤에 켜셔도 됩니다."
      )}</span></div>
      <p class="meta" style="margin-top:10px">${t(
        "그리고 다 따라잡기 전에도 가게는 여실 수 있습니다 — 노드가 따라잡는 동안에는 결제가 늦게 보일 뿐입니다."
      )}</p>
    </div>`;
}

function bindPrepCopy() {
  const copy = document.getElementById("pc-copy");
  if (!copy) return;
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(prepFolder).catch(() => {});
    prepSay = escapeHtml(t("복사했습니다"));
    $("pc-say").innerHTML = prepSay;
  });
}

function bindPrep(behind: number) {
  const b = document.getElementById("pc-go");
  if (!b) return;
  bindPrepCopy();
  b.addEventListener("click", async () => {
    prepBusy = true;
    (b as HTMLButtonElement).disabled = true;
    prepSay = escapeHtml(t("하는 중… 관리자 창이 뜨면 「예」를 눌러 주십시오"));
    $("pc-say").innerHTML = prepSay;
    try {
      // 따라잡는 중일 때만 메모리를 올린다. 다 따라잡은 노드에 올리면
      // 쓰지도 않을 메모리를 잡아 둔다.
      const r = await invoke<any>("pc_prepare", { boost: behind > 0 });
      const rows = (r?.steps || [])
        .map(
          (x: any) =>
            `<div class="kv"><b>${escapeHtml(String(x.what))}</b><span class="${
              x.ok ? "ok" : "danger"
            }">${escapeHtml(String(x.say))}</span></div>`
        )
        .join("");
      // 🔴 우리가 **못 하는 것을 먼저** 말한다. 다 된 줄 알고 기다리는 것이
      //    제일 나쁘다 — 다른 회사 백신은 스크립트로 못 만진다.
      prepFolder = String(r?.folder || "");
      // 🔴 화면이 아니라 **변수에 담는다.** 5초 뒤 다시 그려도 살아남는다.
      prepOut =
        `<div style="margin-top:10px">${rows}</div>
         <p class="meta" style="margin-top:10px">${escapeHtml(String(r?.manual || ""))}</p>
         <div class="row" style="margin-top:6px">
           <code style="font-size:12px;word-break:break-all">${escapeHtml(prepFolder)}</code>
           <button class="ghost" id="pc-copy">${t("폴더 주소 복사")}</button>
         </div>`;
      prepSay = escapeHtml(
        Number(r?.failed || 0) === 0
          ? t("다 됐습니다")
          : t("일부는 못 했습니다 — 아래를 봐 주십시오")
      );
    } catch (e) {
      prepSay = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    } finally {
      prepBusy = false;
      (b as HTMLButtonElement).disabled = false;
      // 담아 둔 것을 지금 화면에도 붙인다. 다음 다시 그리기에서도 그대로 온다.
      $("pc-say").innerHTML = prepSay;
      $("pc-out").innerHTML = prepOut;
      // ⚠️ 여기서 bindPrep 을 다시 부르면 **같은 단추에 처리기가 두 번**
      //    붙는다 — 한 번 눌러도 두 번 돈다. 방금 새로 생긴 복사 단추만 붙인다.
      bindPrepCopy();
    }
  });
}

/**
 * **언제 끝나는지 실측으로 말한다.**
 *
 * ## 🔴 우리가 거짓말하고 있었다
 *
 * 화면은 「며칠 걸릴 수 있습니다」라고 적어 놨다. 대표님 노드를 8시간
 * 재어 보니 **초당 1.25블록**이었고, 남은 320만 블록이면 **한 달**이다.
 *
 * 「며칠」이라 적힌 걸 보고 사장은 이틀쯤 기다린다. 그리고 안 끝난다.
 * 그러면 다음에는 우리가 하는 말을 안 믿는다.
 *
 * ⚠️ 모르면 모른다고 하는 편이 낫지만, **잴 수 있는 것을 안 재고 어림잡아
 *    적는 것**이 제일 나쁘다. 남은 블록도 속도도 우리가 이미 알고 있다.
 */
function etaText(behind: number, rate: number): string {
  if (rate <= 0) return t("재는 중…");
  const sec = behind / rate;
  const hour = sec / 3600;
  if (hour < 1) return `${t("약")} ${Math.max(1, Math.round(sec / 60))}${t("분")}`;
  if (hour < 48) return `${t("약")} ${Math.round(hour)}${t("시간")}`;
  const day = Math.round(hour / 24);
  // 🔴 일주일이 넘으면 **그 숫자를 그대로 보여 준다.** 「오래 걸립니다」로
  //    뭉개면 사장은 얼마나 오랜지 모른 채 기다린다.
  return `${t("약")} ${day}${t("일")}`;
}

async function stallCard(): Promise<string> {
  try {
    const s = await invoke<any>("sync_stalled");
    if (!s?.known || !s.stalled) return "";
    return `<div class="card" style="margin-top:12px;border-color:var(--warn)">
        <h3>${t("진행이 멈춰 있습니다")}</h3>
        <div class="kv"><b>${t("블록")}</b><span>${Number(s.blocks).toLocaleString()}</span></div>
        <div class="kv"><b>${t("안 움직인 시간")}</b><span>${Number(s.quiet_min)}${t("분")}</span></div>
        <p class="meta">${t("확인하실 것 — ① 이 컴퓨터의 남은 디스크 공간(장부에 40GB 넘게 듭니다) ② 노드를 껐다 켜 보기. 재색인은 이어서 합니다.")}</p>
        <div class="row" style="margin-top:10px">
          <button class="ghost" id="nd-restart">${t("노드 껐다 켜기")}</button>
          <button class="ghost" id="nd-log">${t("노드가 뭐 하는지 보기")}</button>
          <span class="meta" id="nd-restartsay"></span>
        </div>
        <div id="nd-logbox"></div>
      </div>`;
  } catch {
    return "";
  }
}

/**
 * 노드가 남긴 기록을 그대로 보여 준다.
 *
 * 🔴 **우리가 해석하지 않는다.** 해석해서 틀리면 사장을 엉뚱한 데로
 *    보낸다. 노드가 한 말을 그대로 옮기고, 판단은 사람이 한다.
 *    「멈춘 것 같다」까지가 우리가 말할 수 있는 전부다.
 */
function bindLog() {
  const b = document.getElementById("nd-log");
  if (!b) return;
  b.addEventListener("click", async () => {
    const box = $("nd-logbox");
    box.innerHTML = `<p class="meta">${t("읽는 중…")}</p>`;
    try {
      const r = await invoke<any>("node_log_tail");
      if (!r?.ok) {
        box.innerHTML = `<p class="meta danger">${escapeHtml(String(r?.why || ""))}</p>`;
        return;
      }
      box.innerHTML =
        `<p class="meta" style="margin-top:10px">${escapeHtml(String(r.path))} · ${r.size_mb} MB</p>
         <pre style="max-height:260px;overflow:auto;font-size:12px;line-height:1.6;
           background:var(--panel);border:1px solid var(--line);border-radius:10px;
           padding:10px;white-space:pre-wrap;word-break:break-all">${escapeHtml(
             (r.lines || []).join("\n")
           )}</pre>
         <div class="row" style="margin-top:8px">
           <button class="ghost" id="nd-logcopy">${t("이 글자 복사")}</button>
           <span class="meta" id="nd-logsay"></span>
         </div>`;
      $("nd-logcopy").addEventListener("click", async () => {
        await navigator.clipboard.writeText((r.lines || []).join("\n")).catch(() => {});
        $("nd-logsay").textContent = t("복사했습니다");
      });
    } catch (e) {
      box.innerHTML = `<p class="meta danger">${escapeHtml(errText(e))}</p>`;
    }
  });
}

function bindRestart() {
  const b = document.getElementById("nd-restart");
  if (!b) return;
  b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    const say = $("nd-restartsay");
    say.textContent = t("다시 켜는 중…");
    try {
      await invoke("services_stop").catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      await invoke("services_start").catch(() => {});
      say.innerHTML = `<span class="ok">${t("다시 켰습니다")}</span>`;
      setTimeout(() => void paintPart(), 5000);
    } catch (e) {
      (b as HTMLButtonElement).disabled = false;
      say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  });
}

async function restoreCard(): Promise<string> {
  try {
    const s = await invoke<any>("dbcache_suggest");
    const now = Number(s?.now ?? 450);
    if (now <= 450) return "";
    return `<div class="card" style="margin-top:12px">
        <h3>${t("메모리 되돌리기")}</h3>
        <div class="kv"><b>${t("지금")}</b><span>${now.toLocaleString()} MB</span></div>
        <div class="kv"><b>${t("되돌릴 값")}</b><span>450 MB</span></div>
        <p class="meta">${t("다 따라잡았습니다. 이제 이만큼 필요 없습니다 — 계산대 메모리를 노드가 계속 물고 있으면 주문 화면이 느려집니다.")}</p>
        <div class="row" style="margin-top:10px">
          <button class="ghost" id="nd-back">${t("메모리 되돌리기")}</button>
          <span class="meta" id="nd-backsay"></span>
        </div>
      </div>`;
  } catch {
    // 되돌리기는 급한 일이 아니다. 못 읽으면 조용히 넘어간다 —
    // 올리는 쪽과 달리 여기서는 감춰도 잃는 것이 없다.
    return "";
  }
}

function bindRestore() {
  const b = document.getElementById("nd-back");
  if (!b) return;
  b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    const say = $("nd-backsay");
    try {
      const r = await invoke<any>("dbcache_restore");
      if (!r?.changed) {
        say.innerHTML = `<span class="ok">${t("이미 기본값입니다")}</span>`;
        return;
      }
      const ok = await sure(
        t("노드를 껐다 켤까요?"),
        t("그래야 적용됩니다. 그동안 결제 확인이 멈추고, 얼마나 걸릴지는 장부 크기에 따라 다릅니다.")
      );
      if (!ok) {
        say.innerHTML = `<span class="ok">${t("450 MB 로 정했습니다. 다음에 켤 때 적용됩니다.")}</span>`;
        return;
      }
      say.textContent = t("다시 켜는 중…");
      await invoke("services_stop").catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      await invoke("services_start").catch(() => {});
      say.innerHTML = `<span class="ok">${t("다시 켰습니다")}</span>`;
      setTimeout(() => void paintPart(), 4000);
    } catch (e) {
      (b as HTMLButtonElement).disabled = false;
      say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  });
}

function bindSpeed() {
  const b = document.getElementById("nd-fast");
  if (!b) return;
  b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    const say = $("nd-fastsay");
    try {
      const r = await invoke<any>("dbcache_boost");
      // 🔴 「다시 켜야 한다」를 반드시 말한다. 안 그러면 값만 바꿔 놓고
      //    「똑같이 느리다」고 겪는다.
      say.innerHTML =
        `<span class="ok">${Number(r.set).toLocaleString()} MB ${t("로 정했습니다")}</span>`;
      const ok = await sure(
        t("노드를 껐다 켤까요?"),
        t("그래야 적용됩니다. 재색인은 이어서 합니다 — 처음부터 다시 하지 않습니다. 몇 분 동안 결제 확인이 멈춥니다.")
      );
      if (!ok) return;
      say.textContent = t("다시 켜는 중…");
      await invoke("services_stop").catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      await invoke("services_start").catch(() => {});
      say.innerHTML = `<span class="ok">${t("다시 켰습니다")}</span>`;
      setTimeout(() => void paintPart(), 4000);
    } catch (e) {
      (b as HTMLButtonElement).disabled = false;
      say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  });
}

async function paintPartBody(): Promise<void> {
  const box = document.getElementById("pt-body");
  if (!box) return;
  const title = document.getElementById("pt-title");

  try {
    if (partOpen === "node") {
      if (title) title.textContent = "RVN 노드";
      // 🔴 노드가 꺼져 있으면 `node_status` 가 던진다. 여태 그 영어 오류만
      //    화면에 남고 **끝이었다** — 왜 안 뜨는지도, 켜는 단추도 없었다.
      //    「.cookie 를 못 읽었습니다」는 증상이지 원인이 아니다.
      //    꺼져 있을 때야말로 사장이 이 화면을 연다. 여기서 할 일을 준다.
      let s: any = null;
      try {
        s = await invoke<any>("node_status");
      } catch (e) {
        // 🔴 노드가 **시작하는 중**이면 코어는 「장부 읽는 중」이라고 답한다.
        //    44GB 를 확인하는 데 몇 분 걸린다. 그걸 오류로 보고 「꺼져
        //    있습니다」라고 쓰면, 사장은 멀쩡히 켜지는 중인 노드를 붙잡고
        //    「지금 켜기」를 다시 누른다 — 그러면 두 번째 노드가 뜨려다
        //    잠금에 걸려 「레이븐 코어가 켜져 있습니다」가 나온다.
        //    코어를 껐는데 그 말이 나오는 이유가 이것이다. 실측으로 만났다.
        const msg = String((e as Error)?.message || e);
        // 표시등과 **같은 판별**을 쓴다. 두 벌로 두면 한쪽만 고쳐진다.
        const warming = isWarming(msg);
        if (warming) {
          box.innerHTML =
            `<div class="card">
               <h3>${t("노드가 시작하는 중입니다")}</h3>
               <p class="meta">${t("장부를 확인하고 있습니다. 몇 분 걸립니다 — 그동안 아무것도 안 하셔도 됩니다.")}</p>
               <p class="meta" style="opacity:.7">${escapeHtml(msg.slice(0, 120))}</p>
             </div>`;
          setTimeout(() => void paintPart(), 5000);
          return;
        }
        const sv = await invoke<any>("services_status").catch(() => null);
        const n = sv?.node || {};
        const looked: string[] = Array.isArray(n.looked) ? n.looked : [];
        // 🔴 **왜 꺼졌는지 노드가 자기 기록에 적어 놨다.** 우리는 안 읽었다.
        //    대표님은 「지금 켜기」를 몇 번이나 누르셨고 그때마다 노드는
        //    같은 자리에서 스스로 죽었다:
        //
        //      ERROR: VerifyDB(): *** irrecoverable inconsistency at 732975
        //      : Corrupted block database detected.
        //
        //    켜는 단추를 아무리 눌러도 안 되는 종류다. 읽고, 말하고,
        //    고칠 단추를 준다.
        const brk = await invoke<any>("chain_broken").catch(() => null);
        if (brk?.broken) {
          box.innerHTML =
            `<div class="card" style="border-color:var(--warn)">
               <h3>${t("장부가 깨졌습니다")}</h3>
               <p class="meta">${t(
                 "그래서 노드가 켜질 때마다 그 자리를 만나 스스로 꺼집니다. 「지금 켜기」를 눌러도 소용이 없습니다."
               )}</p>
               <p class="meta">${t(
                 "계산을 다시 하면 고쳐집니다. 블록 파일은 그대로 쓰므로 다시 받지 않습니다 — 몇 시간 걸릴 수 있고, 그동안 컴퓨터를 켜 두시면 됩니다."
               )}</p>
               <div class="row" style="margin-top:12px">
                 <button id="nd-heal">${t("장부 고치기")}</button>
                 <button class="ghost" id="nd-log">${t("노드가 뭐 하는지 보기")}</button>
                 <span class="meta" id="nd-say"></span>
               </div>
               <div id="nd-logbox"></div>
             </div>`;
          bindLog();
          document.getElementById("nd-heal")?.addEventListener("click", async () => {
            const ok = await sure(
              t("장부를 다시 계산할까요?"),
              t("몇 시간 걸릴 수 있습니다. 그동안 결제 확인이 안 됩니다. 블록 파일은 다시 받지 않습니다.")
            );
            if (!ok) return;
            const b = document.getElementById("nd-heal") as HTMLButtonElement;
            b.disabled = true;
            $("nd-say").textContent = t("시작하는 중…");
            try {
              const r = await invoke<any>("chain_heal");
              $("nd-say").textContent = String(r?.note || t("시작했습니다."));
            } catch (e) {
              b.disabled = false;
              $("nd-say").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
            }
          });
          return;
        }
        box.innerHTML =
          `<div class="card">
             <h3>${t("노드가 꺼져 있습니다")}</h3>
             <p class="meta">${t("결제 확인도 색인도 이 노드가 합니다.")}</p>
             ${
               n.installed
                 ? `<p class="meta">${t("프로그램은 있습니다")} — <code class="addr">${escapeHtml(String(n.path || ""))}</code></p>
                    <button id="nd-go" style="margin-top:12px">${t("지금 켜기")}</button>`
                 : `<p class="meta" style="color:var(--warn)">${t("노드 프로그램을 찾지 못했습니다.")}</p>
                    <p class="meta">${escapeHtml(String(n.install || ""))}</p>` +
                   (looked.length
                     ? `<details style="margin-top:10px"><summary class="meta">${t("어디를 봤는지 보기")}</summary>
                          <div class="meta" style="margin-top:6px;line-height:1.8">
                            ${looked.slice(0, 24).map((x) => `<code class="addr">${escapeHtml(x)}</code>`).join("<br />")}
                          </div></details>`
                     : "")
             }
             <div class="meta" id="nd-say" style="margin-top:12px"></div>
           </div>`;
        const go = document.getElementById("nd-go");
        if (go) {
          go.addEventListener("click", async () => {
            (go as HTMLButtonElement).disabled = true;
            $("nd-say").textContent = t("켜는 중…");
            try {
              const r = await invoke<any>("services_start");
              // 🔴 못 켠 이유를 **그대로 보여 준다.** 레이븐 코어가 켜져 있어서
              //    못 켜는 경우가 제일 흔한데, 그걸 안 말하면 몇 시간을 헤맨다.
              const why = (r?.skipped || [])
                .filter((x: any) => x?.what === "노드")
                .map((x: any) => String(x.why || ""))
                .join(" ");
              $("nd-say").textContent = why || t("켰습니다. 잠시 뒤 다시 봐 주세요.");
            } catch (e) {
              $("nd-say").textContent = String((e as Error)?.message || e);
            }
            setTimeout(() => void paintPart(), 3000);
          });
        }
        return;
      }
      const behind = Number(s?.behind ?? 0);
      // 🔴 **어느 노드를 쓰고 있는지 화면에 적는다.**
      //
      //    대표님이 이걸 확인하려고 터미널을 여셔야 했다 —
      //    `"C:\Program Files\Raven\daemon\ravend.exe" -version`.
      //    우리 앱은 「깔려 있는 것을 먼저」 쓰는데, **그게 어느 것인지도
      //    그 판이 쓸 수 있는 판인지도 말하지 않았다.**
      //
      //    레이븐코인은 이게 치명적이다. 4.8.0 미만은 블록 4,489,527 에서
      //    멈춘다. 며칠을 따라잡고 나서 거기서 서고, 사장은 왜인지 모른다.
      const nv = await invoke<any>("node_version").catch(() => null);
      // 속도는 두 번 재야 나온다. 처음엔 아직 모른다고 말한다.
      const st = await invoke<any>("sync_stalled").catch(() => null);
      const rate = Number(st?.rate ?? 0);
      // 20초를 모아야 첫 값이 나온다. 그동안은 재는 중이라고 말한다.
      const rateText =
        rate > 0 ? `${t("초당")} ${rate.toLocaleString()}${t("블록")}` : t("재는 중… (20초)");
      box.innerHTML =
        card(
          [
            [t("연결"), s?.peers != null ? `${s.peers}${t("곳")}` : t("확인 중")],
            [t("블록"), Number(s?.blocks ?? 0).toLocaleString()],
            // 판을 숨기지 않는다. 못 읽었으면 못 읽었다고 적는다.
            [
              t("노드 판"),
              nv?.line
                ? String(nv.line).replace(/^.*?(v[0-9].*)$/, "$1") +
                  (nv.ok === false ? ` ⚠️` : "")
                : t("확인 못 함"),
            ],
            [t("따라잡음"), `${(Number(s?.progress ?? 0) * 100).toFixed(behind > 0 ? 2 : 1)}%`],
            // 🔴 **재색인 중에는 「남은 블록」을 적지 않는다.**
            //    그때 headers 는 진짜 체인 끝이 아니라 디스크에서 읽어 나간
            //    만큼이라, 늘 작게 나온다. 대표님 화면에 「남은 블록
            //    167,999」가 떴는데 실제로는 전체의 0.6% 였다 — 「곧 끝나겠네」
            //    하고 기다리게 만든다. 며칠이 걸린다.
            //
            //    대신 **초당 몇 블록인지**를 적는다. 「멈춘 거 아닌가」에
            //    답하는 건 %가 아니라 그 숫자다.
            behind > 0 && s?.behind_honest === false
              ? [t("속도"), rateText]
              : behind > 0 && rate > 0
                ? [t("남은 시간"), etaText(behind, rate)]
              : [
                  t("결제 확인"),
                  behind > 0
                    ? `${t("남은 블록")} ${behind.toLocaleString()}`
                    : t("지금 바로 됩니다"),
                ],
          ],
          behind > 0 && s?.behind_honest === false
            ? t(
                "다시 훑는 중입니다. 남은 양은 아직 알 수 없습니다. 「따라잡음 %」는 초반에 거의 안 움직이는 것이 정상입니다(옛 블록은 거래가 적어서입니다). 도는지 멈췄는지는 위 속도로 보십시오."
              )
            : behind > 0
              ? t("따라잡는 동안에는 방금 들어온 결제가 늦게 보입니다.")
              : t("이 컴퓨터가 체인을 통째로 들고 있습니다. 남에게 묻지 않습니다."),
        ) +
        // 🔴 못 따라잡는 판이면 **제일 먼저** 말한다. 며칠 기다린 뒤에
        //    알게 되면 그 며칠이 통째로 버려진다.
        (nv?.ok === false
          ? `<div class="card" style="margin-top:12px;border-color:var(--danger)">
               <h3>${t("이 노드 판으로는 끝까지 못 갑니다")}</h3>
               <p class="meta">${escapeHtml(String(nv?.say || ""))}</p>
               <p class="meta"><code class="addr">${escapeHtml(String(nv?.path || ""))}</code></p>
             </div>`
          : "") +
        (behind > 0 ? await stallCard() : "") + slowCard(behind, rate) + prepCard(behind) +
        (behind > 0 ? await speedCard() : await restoreCard()) + (await indexCard()) +
        goto("settings", t("노드 설정 열기"));
      bindSpeed();
      bindRestore();
      bindRestart();
      bindLog();
      bindPrep(behind);
    } else if (partOpen === "mine") {
      if (title) title.textContent = "채굴";
      const m = await invoke<any>("miner_running").catch(() => null);
      const net = await invoke<any>("mining_status").catch(() => null);
      const on = !!m?.running;
      const hps = Number(net?.network_hps || 0);
      box.innerHTML =
        card(
          [
            [t("지금"), on ? t("캐는 중") : t("꺼져 있습니다")],
            [
              t("네트워크 전체"),
              hps ? `${(hps / 1e9).toFixed(1)} GH/s` : t("확인 중"),
            ],
            [t("블록"), Number(net?.blocks ?? 0).toLocaleString()],
          ],
          // 🔴 이 프로그램은 직접 캐지 않는다. 그렇게 적어야 안 캐지는 것을
          //    고장으로 안 읽는다.
          on
            ? t("따로 있는 GPU 기계가 캐고 수익만 이 지갑으로 옵니다.")
            : // 🔴 꺼져 있을 때는 **이 컴퓨터에서 되는 일인지**부터 말한다.
              //    켤 때 앱이 대신 확인해 둔 답을 그대로 쓴다. 안 되는 것을
              //    「설정에서 켜세요」로 넘기면 사장은 없는 단추를 찾는다.
              String((await bootReport())?.mining?.why || "") ||
              t("켜려면 두 가지가 필요합니다 — 캐는 프로그램(kawpowminer)과 받을 주소.")
        ) + goto("settings", t(on ? "채굴 설정 열기" : "채굴 켜는 곳으로"));
    } else if (partOpen === "ipfs") {
      if (title) title.textContent = "파일창고 (IPFS)";
      const s = await invoke<any>("ipfs_status");
      box.innerHTML = !s?.running
        ? card([[t("지금"), t("꺼져 있습니다")]], t("사진과 메뉴판이 여기 들어갑니다. 꺼져 있으면 손님이 사진을 못 봅니다.")) +
            turnOnBtn("ip-go")
        : card(
            [
              [t("연결"), s.peers != null ? `${s.peers}${t("곳")}` : t("확인 중")],
              [t("지키는 파일"), `${pinned.size.toLocaleString()}${t("개")}`],
              [t("판"), String(s.version || "—").slice(0, 22)],
            ],
            t("내 컴퓨터에만 있는 창고가 아니라, 손님 폰과 다른 노드가 같이 나눠 갖는 곳입니다.")
          ) +
          /* 🔴 **서로 보완하는 자리.** 대표님: "탈중앙인데 서로가 보완해
             가면서 가는 구조가 좋은데 말야. 내 406호 컴퓨터와 내 맥북이
             서로를 보완해 줄수도 있으면 좋지 않나?"

             맞다. 그리고 이건 겉멋이 아니라 **오늘 난 사고의 처방**이다 —
             가게 사진이 사라진 것은 그 파일을 **한 대만** 들고 있었기
             때문이다. 발행하는 노트북은 닫혀 있는 게 맞고(소유권 토큰이
             사는 자리다), 계산대는 하루 종일 켜져 있다.

             ⚠️ `peers` 기능은 러스트에 **통째로 만들어져 있었는데 화면이
                없어서 한 번도 안 돌았다.** 만든 것과 보이는 것은 다르다. */
          `<div class="card" style="margin-top:14px">
             <h3>${t("서로 파일 지켜 주기")}</h3>
             <p class="meta">${t(
               "자산에 붙은 사진·음악은 그 파일을 든 컴퓨터가 켜져 있어야 보입니다. 두 대가 서로 들고 있으면 한 대가 꺼져도 손님에게 보입니다.",
             )}</p>
             <div class="row" style="margin-top:10px">
               <button id="pn-mine">${t("내 파일 지키기")}</button>
             </div>
             <label class="fld" style="margin-top:12px">${t("다른 내 컴퓨터 주소")}</label>
             <input id="pn-url" placeholder="http://192.168.0.5:9111" autocomplete="off" spellcheck="false" />
             <p class="meta">${t(
               "그 컴퓨터의 「바깥 연결」에 적힌 주소입니다. 같은 와이파이면 집 주소로도 됩니다.",
             )}</p>
             <button class="ghost" id="pn-help">${t("저 컴퓨터 파일도 내가 들기")}</button>
             <div class="msg" id="pn-say"></div>
           </div>` +
          goto("settings", t("파일창고 설정 열기"));
      bindTurnOn("ip-go", "services_start");
      bindPeerHelp();
    } else if (partOpen === "relay") {
      if (title) title.textContent = "릴레이";
      const r = await invoke<any>("relay_status").catch(() => null);
      box.innerHTML =
        card(
          [
            [t("지금"), r?.running ? t("돌고 있습니다") : t("꺼져 있습니다")],
            [t("들고 있는 공지"), `${Number(r?.events ?? 0).toLocaleString()}${t("개")}`],
            [
              t("바깥 주소"),
              r?.url ? String(r.url) : t("가게 안에서만 — 「바깥에서 열기」를 켜면 밖에서도 붙습니다"),
            ],
          ],
          // 이게 왜 있는지 한 줄로. 안 적으면 「이건 또 뭐지」가 된다.
          t("이 컴퓨터가 다른 가게의 공지도 같이 나릅니다. 가게가 늘수록 그물이 촘촘해지고, 남의 릴레이가 끊겨도 서로 붙습니다.")
        ) +
        // 🔴 릴레이는 따로 도는 프로그램이 아니라 **가게 서버 안에** 있다.
        //    그래서 켜는 길도 가게 서버를 켜는 것 하나뿐이다.
        (r?.running ? goto("settings", t("바깥에서 열기 설정")) : turnOnBtn("rl-go"));
      bindTurnOn("rl-go", "start_phone_server");
    } else {
      // ── 바깥 연결 ──────────────────────────────────────────────
      // 손님이 가게 밖에서 들어오는 길. 여기가 꺼져 있으면 위의 넷이 다
      // 초록이어도 밖에서는 아무도 못 들어온다.
      if (title) title.textContent = "바깥 연결";
      const o = await invoke<any>("tunnel_status").catch(() => null);
      const auto = await invoke<boolean>("autostart_get").catch(() => false);
      box.innerHTML =
        card(
          [
            [t("지금"), o?.running ? t("바깥에서 들어올 수 있습니다") : t("가게 안에서만 됩니다")],
            [t("바깥 주소"), o?.url ? String(o.url) : t("없음")],
            [t("준비물"), o?.installed ? t("갖춰져 있습니다") : t("아직 안 받았습니다")],
          ],
          o?.running
            ? t("손님이 가게 밖에서도 QR 로 들어옵니다.")
            : t("지금은 같은 와이파이에 있는 손님만 들어옵니다. 밖에서도 받으려면 켜세요.")
        ) +
        // 🔴 자동 시작이 여기 있는 이유: 손님이 들어오려면 이 컴퓨터가
        //    켜져 있어야 한다. 정전 한 번에 QR 이 죽는데, 사장은 프로그램을
        //    다시 여는 것이 답인 줄 모른다. 실측으로 로그인 항목에 없었다.
        `<label class="card" style="display:flex;align-items:center;gap:12px;cursor:pointer">
           <input type="checkbox" id="pt-autostart" ${auto ? "checked" : ""}
                  style="width:22px;height:22px;flex:none">
           <span><b style="display:block">${t("컴퓨터를 켜면 저절로 시작")}</b>
           <span class="meta">${t("정전이나 재시작 뒤에도 손님 QR 이 살아 있습니다.")}</span></span>
         </label>` +
        // 🔴 여기에 **켜는 단추가 있어야 한다.** 「설정 열기 →」 로 보냈더니
        //    「이 컴퓨터」 화면이 나와서 어디서 켜라는 건지 알 수가 없었다.
        //    상태를 보여 주는 자리가 곧 고치는 자리다.
        `<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
           <button id="pt-out-go" style="min-height:48px;font-size:16px">
             ${o?.running ? t("바깥 연결 끄기") : o?.installed ? t("지금 켜기") : t("준비물 받고 켜기")}
           </button>
           ${o?.url ? `<button class="ghost" id="pt-out-copy" style="min-height:48px">${t("주소 복사")}</button>` : ""}
         </div>
         <p class="meta" id="pt-out-say" style="margin-top:8px">${escapeHtml(outSay)}</p>`;

      const say = (m: string) => {
        outSay = m;
        const el = document.getElementById("pt-out-say");
        if (el) el.textContent = m;
      };
      const go = document.getElementById("pt-out-go") as HTMLButtonElement | null;
      if (go) {
        go.onclick = async () => {
          go.disabled = true;
          try {
            if (o?.running) {
              await invoke("tunnel_stop");
              say(t("껐습니다. 이제 같은 와이파이에서만 들어옵니다."));
            } else {
              if (!o?.installed) {
                say(t("준비물을 받는 중입니다. 1~2분 걸립니다."));
                await invoke("tunnel_install");
              }
              say(t("켜는 중입니다…"));
              await invoke("tunnel_start", { port: 8790 });
              say(t("켰습니다. 이제 밖에서도 손님이 들어옵니다."));
            }
          } catch (e) {
            say(errText(e));
          } finally {
            go.disabled = false;
            void paintPart();
          }
        };
      }
      const cp = document.getElementById("pt-out-copy");
      if (cp && o?.url) {
        cp.addEventListener("click", () => {
          void navigator.clipboard.writeText(String(o.url));
          say(t("주소를 복사했습니다."));
        });
      }

      const sw = document.getElementById("pt-autostart") as HTMLInputElement | null;
      if (sw) {
        sw.onchange = async () => {
          try {
            sw.checked = await invoke<boolean>("autostart_set", { on: sw.checked });
          } catch (e) {
            sw.checked = !sw.checked;
            alert(errText(e));
          }
        };
      }
    }
    bindIndexCard();
  } catch (e) {
    box.innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
  }
}

/** 색인 칸의 단추들. 화면을 다시 그릴 때마다 붙인다. */
function bindIndexCard(): void {
  const say = (m: string) => {
    const el = document.getElementById("rx-say");
    if (el) el.textContent = m;
  };
  const arm = document.getElementById("rx-arm") as HTMLInputElement | null;
  if (arm) {
    arm.onchange = async () => {
      try {
        arm.checked = await invoke<boolean>("reindex_arm", { on: arm.checked });
        say(arm.checked
          ? "한가해지면 알아서 시작하겠습니다. 이 프로그램이 켜져 있어야 합니다."
          : "알아서 시작하지 않겠습니다.");
      } catch (e) {
        say(errText(e));
      }
    };
  }
  const now = document.getElementById("rx-now") as HTMLButtonElement | null;
  if (now) {
    now.onclick = async () => {
      if (!confirm("지금 시작하면 몇 시간 동안 입금 확인이 멈춥니다. 시작할까요?")) return;
      now.disabled = true;
      say("노드를 다시 띄우는 중입니다…");
      try {
        await invoke("reindex_start");
        say("시작했습니다. 이 화면에서 진행을 보실 수 있습니다.");
      } catch (e) {
        say(errText(e));
      } finally {
        now.disabled = false;
        void paintPart();
      }
    };
  }
}

/**
 * 「한가해지면 알아서」를 켜 뒀으면, 1분마다 지금이 그때인지 본다.
 *
 * 🔴 시계를 따로 두지 않는 이유: 앱이 꺼져 있던 시간을 못 따라잡으면
 *    사장은 예약해 놓고 안 됐다고 겪는다. 물어보는 쪽이 정직하다.
 */
async function reindexTick(): Promise<void> {
  try {
    const st = await invoke<any>("reindex_state");
    if (!st?.armed || st.running || st.done) return;
    const w = await invoke<any>("reindex_window", {
      nowUnix: Math.floor(Date.now() / 1000),
      tzOffsetMin: -new Date().getTimezoneOffset(),
    });
    // 지금이 창 안이고, 그 창이 넉넉할 때만 시작한다.
    if (w?.kind === "window" && Number(w.starts_in_min) === 0 && !w.tight) {
      await invoke("reindex_start");
    }
  } catch {
    // 조용히 넘긴다. 다음 분에 다시 본다.
  }
}

/**
 * 주소 색인 — 이 노드가 남의 지갑에 답할 수 있게 하는 것.
 *
 * 🔴 「몇 시에 할까요」라고 묻지 않는다. 사장은 이게 몇 시간짜리 일인지
 *    모른다. 이미 받아 둔 **영업시간**에서 한가한 창을 우리가 계산해서
 *    「그때 하겠습니다」라고 말하고, 사장은 예/아니오만 답한다.
 */
async function indexCard(): Promise<string> {
  const st = await invoke<any>("reindex_state").catch(() => null);
  if (!st) return "";
  if (st.running) {
    const p = await invoke<any>("reindex_progress").catch(() => null);
    const pct = Math.floor(Number(p?.progress ?? 0) * 1000) / 10;
    return card(
      [
        [t("주소 색인"), t("다시 훑는 중입니다")],
        [t("진행"), `${pct}%`],
        [t("블록"), Number(p?.blocks ?? 0).toLocaleString()],
      ],
      t("끝날 때까지 입금 확인이 멈춥니다. 중간에 꺼져도 괜찮습니다 — 다시 켜면 이어서 합니다.")
    );
  }
  if (st.done) {
    return card([[t("주소 색인"), t("켜져 있습니다")]],
      t("이 노드가 손님 지갑의 잔액 질문에 직접 답합니다. 남의 서버에 안 묻습니다."));
  }

  const now = Math.floor(Date.now() / 1000);
  const w = await invoke<any>("reindex_window", { nowUnix: now, tzOffsetMin: -new Date().getTimezoneOffset() })
    .catch(() => null);
  const hm = (min: number) => {
    const h = Math.floor(min / 60);
    return h >= 24 ? `${Math.floor(h / 24)}${t("일")} ${h % 24}${t("시간")}` : `${h}${t("시간")}`;
  };
  let say: string;
  let can = false;
  if (!w || w.kind === "no_hours") {
    say = t("가게 영업시간을 아직 안 받았습니다. 「내 가게」에서 문 여는 시간과 닫는 시간을 적어 주시면, 한가한 때를 골라 알아서 하겠습니다.");
  } else if (w.kind === "bad_hours") {
    say = t("영업시간을 읽지 못했습니다. 「내 가게」에서 다시 봐 주세요. 아무 때나 시작하지 않겠습니다.");
  } else if (w.kind === "always_open") {
    say = t("쉬는 시간이 없는 가게라 한가한 때가 없습니다. 정기 휴무일을 적어 주시거나, 장사에 지장이 없는 때를 골라 「지금 시작」을 눌러 주세요.");
    can = true;
  } else {
    const starts = Number(w.starts_in_min ?? 0);
    say = starts === 0
      ? t("지금이 한가한 때입니다. 시작하면 좋습니다.")
      : `${hm(starts)} ${t("뒤부터 한가합니다")} · ${hm(Number(w.window_min ?? 0))} ${t("동안")}`;
    if (w.tight) say += ` · ${t("넉넉하지는 않습니다")}`;
    can = true;
  }
  return `<div class="card">
      <b>${t("주소 색인 — 이 노드로 지갑도 열기")}</b>
      <p class="meta" style="margin-top:8px">${t(
        "지금은 손님 지갑이 잔액을 우리 서버 한 곳에 묻습니다. 이걸 켜면 이 컴퓨터가 직접 답합니다. 대신 한 번 다시 훑어야 하고, 그동안 입금 확인이 멈춥니다."
      )}</p>
      <p class="meta" style="margin-top:8px"><b>${escapeHtml(say)}</b></p>
      ${can ? `<label style="display:flex;align-items:center;gap:10px;margin-top:12px;cursor:pointer">
        <input type="checkbox" id="rx-arm" ${st.armed ? "checked" : ""} style="width:22px;height:22px;flex:none">
        <span>${t("한가해지면 알아서 시작하기")}</span></label>
      <button id="rx-now" style="margin-top:12px">${t("지금 시작")}</button>` : ""}
      <p class="meta" id="rx-say" style="margin-top:8px"></p>
    </div>`;
}

/** 값 몇 줄과 설명 한 줄. 네 화면이 같은 문법을 쓴다. */
function card(rows: [string, string][], note: string): string {
  return (
    `<div class="card">` +
    rows.map(([k, v]) => `<div class="kv"><b>${k}</b><span>${escapeHtml(v)}</span></div>`).join("") +
    `<p class="meta" style="margin-top:10px">${note}</p></div>`
  );
}

/** 설정으로 가는 길. 상태만 보여 주고 끝내면 고칠 데를 못 찾는다. */
function goto(page: string, label: string): string {
  return `<button class="ghost" data-gopage="${page}" style="margin-top:12px">${label} →</button>`;
}

/* ══ 개발비 1% — 진짜로 끌 수 있게 ═══════════════════════════════════
   🔴 러스트에는 `fee_read`·`fee_save` 가 다 있고 명령 등록도 돼 있는데,
   **화면에 스위치가 없었다.** 그런데 랜딩에는 「설정에서 끄실 수 있습니다」
   라고 적혀 있다 — 못 하는 것을 한다고 적어 둔 것이다.

   이 프로그램의 주장은 *"못 끄는 것은 개발비가 아니라 세금이고, 소스가
   열려 있으면 세금은 포크 한 번으로 사라진다"* 이다. 그 주장이 성립하려면
   여기에 진짜 스위치가 있어야 한다.

   ⚠️ 주소를 읽어 적는 일은 이미 `paintFee` 가 한다(위). 여기서는 **스위치
      두 칸만** 칠한다 — 같은 일을 하는 함수를 또 만들면 둘이 어긋난다.
      실제로 처음에 그렇게 만들었다가 「Duplicate function」으로 잡혔다. */
async function paintFeePick(): Promise<void> {
  // 🔴 예전에는 여기서 「내기/안 내기」 스위치를 그렸다. 스위치를 없앤 뒤
  //    `fee-say` 칸도 같이 사라졌는데, 이 함수 첫 줄이 그 칸을 찾아 **없으면
  //    바로 나가고** 있었다. 그래서 그 아래 `paintFee`(가는 주소)와
  //    `paintOwed`(쌓인 개발비)가 통째로 안 돌았고, 화면은 「읽는 중…」에서
  //    영원히 멈췄다.
  //
  //    없어진 칸을 찾지 않는다. 할 일을 바로 한다.
  void paintFee();
  void paintOwed();
}

/**
 * 테이블 QR 뽑기 단추를 묶는다.
 *
 * 🔴 창을 열 때마다 부른다. 시작할 때 한 번만 묶으면, 그때는 이 칸이
 * 화면에 없어서 아무 데도 안 걸린다 — 실제로 그래서 여태 안 눌렸다.
 */
function bindTableQr() {
  const btn = document.getElementById("tbl-print");
  if (!btn) return;
  btn.onclick = async () => {
    const note = $("tbl-note");
    const raw = ($("tbl-list") as HTMLInputElement).value.trim();
    // 쉼표·띄어쓰기·줄바꿈 아무거나 받는다. 사장이 형식을 외우게 하지 않는다.
    const tables = raw ? raw.split(/[,\s]+/).filter(Boolean) : ["카운터"];
    note.textContent = t("만드는 중…");
    try {
      // 주소를 지금 다시 읽는다. 서버를 켤 때 잡은 값을 쓰면, 공유기가 새
      // 주소를 준 뒤에 인쇄한 QR 이 죽은 주소를 가리킨다.
      const ip = await invoke<string>("now_ip").catch(() => serverIp || "127.0.0.1");
      const r = await invoke<any>("table_qr_sheet", { ip, tables });
      note.innerHTML = `<span class="ok">${escapeHtml(r.say)}</span> (${escapeHtml(r.path)})`;
    } catch (e) {
      note.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  };
}

/** 쌓인 개발비. 0 이면 아예 안 보인다 — 빈 칸은 「고장」으로 읽힌다. */
async function paintOwed() {
  const box = document.getElementById("fee-owedbox");
  if (!box) return;
  try {
    const o = await invoke<any>("fee_owed");
    const owed = Number(o.owed || 0);
    const sent = Number(o.sent_total || 0);
    // 한 번도 안 쌓였고 보낸 적도 없으면 이 상자를 안 보여 준다. 처음 켠
    // 사장에게 「0 RVN」을 보여 줘 봐야 할 일이 하나도 없다.
    if (owed <= 0 && sent <= 0) {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    $("fee-owed").textContent = `${owed.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} RVN`;
    $("fee-sent").textContent = `${sent.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} RVN`;
    const btn = $("fee-send") as HTMLButtonElement;
    // 🔴 못 보내는 이유를 눌러 보고 알게 하지 않는다. 미리 말한다.
    btn.disabled = !o.ready || owed < 0.01;
    $("fee-sendsay").textContent = !o.ready
      ? t("보낼 주소가 아직 정해지지 않았습니다.")
      : owed < 0.01
        ? t("아직 보낼 만큼 쌓이지 않았습니다.")
        : `${o.count || 0}${t("건에서 쌓였습니다.")}`;
  } catch {
    box.style.display = "none";
  }
}

async function sendOwed() {
  const btn = $("fee-send") as HTMLButtonElement;
  const say = $("fee-sendsay");
  btn.disabled = true;
  say.textContent = t("보내는 중…");
  try {
    const r = await invoke<any>("fee_pay");
    say.innerHTML = `<span class="ok">${t("보냈습니다")} — ${r.sent} RVN</span>`;
  } catch (e) {
    // 실패해도 장부는 안 줄어든다. 다시 누르면 된다고 말해 준다.
    say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
  await paintOwed();
}


/** 지금 열려 있는 화면. 끌어다 놓기가 **자리마다 다르게** 굴려면 필요하다. */
let currentPage = "ravi";

function showPage(id: string) {
  // 🔴 화면을 떠나면 그 화면 때문에 도는 타이머를 끈다.
  //
  //    「부품」 화면을 한 번 열었다가 지갑으로 나가면, **앱을 끌 때까지**
  //    5초마다 노드 RPC 7건을 계속 불렀다(2026-08-29 실측). 하루 종일 켜 두는
  //    앱에서 이건 그냥 낭비다.
  //
  //    ⚠️ 「돕기」 타이머는 여기서 안 끈다 — 돕기는 화면이 아니라 **모드**라,
  //       다른 화면을 보는 동안에도 돌아야 한다. 대신 장사 모드로 바꿀 때 끈다.
  try {
    const 갈곳 = String(id ?? "");
    if (갈곳 !== "parts" && partTimer !== null) {
      clearInterval(partTimer);
      partTimer = null;
    }
  } catch {
    /* 타이머 정리가 실패해도 화면 이동은 막지 않는다 */
  }

  currentPage = id;
  if (id === "ravi") paintRavi();
  paintPageTiles(id);
  // 🔴 라비 화면에서는 떠 있는 「Ravi에게 물어보기」를 숨긴다.
  //    대화창이 바로 앞에 있는데 그리로 가는 단추가 그 위에 떠 있으면,
  //    같은 것이 둘로 보이고 오른쪽 아래 내용을 가린다.
  const fab = document.getElementById("chat-open");
  if (fab) fab.style.display = id === "ravi" ? "none" : "";
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === `page-${id}`));
  document.querySelectorAll("nav a").forEach((a) =>
    a.classList.toggle("on", (a as HTMLElement).dataset.page === id));
  if (id === "wallet") loadWallet();
  if (id === "shop") void paintFlow();
  if (id === "settings") {
    loadNode();
    loadNet();
    // 🔴 쉬운 설정이 **제일 먼저** 그려져야 한다. 고급 설정이 먼저 뜨면
    // 사장은 그걸 읽다가 지친다 — 그게 지금까지 일어난 일이다.
    void paintEasySetup();
    void paintSweepKrw();
    wireCloudKey();
    // 🔴 「내 이름」은 **열 때마다** 다시 본다. 다른 창에서 이름을 바꿨거나
    //    지갑을 열었을 수 있고, 그러면 아까 본 판정이 이미 거짓이다.
    void idLoad();
  }
  if (id === "reward") void loadReward();
  // 간판 열쇠 옮기기. 이미 씨앗 열쇠면 이 안에서 스스로 숨는다.
  if (id === "shop") void paintKeyMove();
  // 🔴 화면을 열 때 부르지 않으면 빈 칸만 보인다. 만들어 놓고 안 부르는
  //    것이 이 저장소의 고질병이라 여기 한 줄을 꼭 남긴다.
  if (id === "talk") {
    // 열었으면 「안 본 글」 숫자를 내린다. 지금부터는 눈으로 본다.
    대화봤다();
    // 지금 보고 있는 방은 지켜보는 명단 맨 앞으로. 나갔다 와도 이 방의
    // 새 글은 알림을 받는다.
    방지켜보기(tkRoom);
    void talkPaintMe();
    void talkPaintRooms();
    // 명단은 닫힌 채로 두되 **머리줄 단추에 인원수는 적는다** — 열어 보기
    // 전에는 내가 누굴 숨겼는지 알 길이 없으면 그것도 숨긴 셈이다.
    // 「되돌렸습니다」는 지난 판의 말이므로 들어올 때 지운다.
    tkJustBack = [];
    talkPaintMuted();
    // 처음 세 번만 안내를 띄운다. 늘 띄우면 안 읽고, 안 읽히면 없는 것과 같다.
    tk처음안내();
    // 들어올 때마다 서랍은 닫힌 채로. 열어 둔 것을 기억하면 「복잡한 화면」이
    // 그대로 돌아온다.
    const 서랍 = document.getElementById("tk-morebox");
    if (서랍) 서랍.hidden = true;
    document.getElementById("tk-more")?.setAttribute("aria-expanded", "false");
    void talkPaint();
  }
}

/* ── 지갑 ─────────────────────────────────────────────────── */
async function loadWallet() {
  try {
    const b: any = await invoke("wallet_balance");
    $("w-confirmed").textContent = `${b.confirmed.toLocaleString(undefined, { maximumFractionDigits: 8 })} RVN`;
    // Unconfirmed money is shown apart from spendable money on purpose: a shop
    // that ships on an unconfirmed payment can be paid with one that never lands.
    $("w-unconfirmed").textContent = b.unconfirmed
      ? `확인 대기 중 ${b.unconfirmed.toLocaleString(undefined, { maximumFractionDigits: 8 })} RVN`
      : "";
  } catch (e) {
    $("w-confirmed").textContent = "—";
    $("w-unconfirmed").textContent = errText(e);
  }

  try {
    // 자물쇠는 글자와 그림을 같이 준다. 그림만 있으면 무슨 뜻인지 모르고,
    // 글자만 있으면 눈에 안 들어온다. 70대도 25살도 같은 화면을 본다.
    const shut = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" style="vertical-align:-2px;margin-right:6px"><rect x="4" y="11" width="16" height="10"
      rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
    const open = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" style="vertical-align:-2px;margin-right:6px"><rect x="4" y="11" width="16" height="10"
      rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;

    const l: any = await invoke("wallet_lock_state");
    const enc = $("w-enc") as HTMLButtonElement;
    const lockNow = $("w-lock-now") as HTMLButtonElement;

    if (!l.encrypted) {
      $("w-lock").innerHTML = open + "암호 없음";
      $("w-lock").className = "state warn";
      $("w-lock-detail").textContent = "이 컴퓨터를 쓸 수 있는 사람은 지갑도 쓸 수 있습니다";
      enc.textContent = "암호 걸기";
      enc.style.display = "";
      lockNow.style.display = "none";
    } else if (l.unlocked) {
      $("w-lock").innerHTML = open + "열려 있음";
      $("w-lock").className = "state warn";
      $("w-lock-detail").textContent =
        "지금은 암호 없이 보낼 수 있는 상태입니다. 자리를 비우기 전에 잠그세요.";
      // 열려 있을 때만 잠그기가 보인다. 늘 떠 있으면 뜻이 없다.
      enc.textContent = "암호 바꾸기";
      enc.style.display = "";
      lockNow.style.display = "";
    } else {
      $("w-lock").innerHTML = shut + "잠김";
      $("w-lock").className = "state ok";
      $("w-lock-detail").textContent = "보내려면 그때 암호를 묻습니다";
      // "열기" 버튼은 일부러 없다. 미리 열어 두는 습관이 생기면 지갑은
      // 하루 종일 열려 있게 되고, 그건 암호를 안 건 것과 같다. 보낼 때
      // 그 자리에서 묻는 것이 안전하고, 이미 그렇게 동작한다.
      enc.textContent = "암호 바꾸기";
      enc.style.display = "";
      lockNow.style.display = "none";
    }
  } catch (e) {
    $("w-lock").textContent = "확인 불가";
    $("w-lock").className = "state muted";
    $("w-lock-detail").textContent = errText(e);
  }

  try {
    const txs: any[] = await invoke("recent_transactions", { count: 15 });
    $("w-txs").innerHTML = txs
      .slice()
      .reverse()
      .map((t) => {
        const amt = typeof t.amount === "number" ? t.amount : 0;
        const incoming = t.category === "receive" || amt >= 0;
        const when = t.time
          ? new Date(t.time * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
          : "";
        const what = t.assetName || "RVN";

        // Bitcoin-derived chains cannot tell you who paid — a received entry only
        // knows which of *our* addresses it landed on. That is precisely why
        // orders get their own address: the address becomes the order number.
        const addr = t.address || "";
        const addrLine = addr
          ? `<div class="meta">${incoming ? "받은 주소" : "보낸 주소"} <code>${addr.slice(0, 12)}…${addr.slice(-6)}</code></div>`
          : "";
        // A label is whatever this wallet wrote down locally — an order tag, a
        // note. It never travelled on-chain, so it is ours and only ours.
        const note = t.label || t.comment || "";
        const noteLine = note ? `<div class="meta">${note}</div>` : "";

        return `<tr data-txid="${t.txid || ""}">
          <td>
            <div>${incoming ? "받음" : "보냄"} · ${what}</div>
            ${addrLine}${noteLine}
            <div class="meta">${when}</div>
          </td>
          <td class="num ${incoming ? "ok" : "danger"}">${amt.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
          <td class="num">${t.confirmations ?? 0}</td>
        </tr>`;
      })
      .join("") || '<tr><td colspan="3" class="muted">거래 내역이 없습니다</td></tr>';
  } catch (e) {
    $("w-txs").innerHTML = `<tr><td colspan="3" class="muted">${e}</td></tr>`;
  }
}

async function makeAddress() {
  try {
    const addr = await invoke<string>("new_address", { label: "" });
    $("w-addr").innerHTML =
      `<div class="card"><h3>받을 주소</h3><code class="addr">${addr}</code>
       <div style="margin-top:8px"><button class="ghost" id="w-copy">복사</button></div></div>`;
    $("w-copy").onclick = () => navigator.clipboard.writeText(addr);
  } catch (e) {
    say(t("주소를 만들지 못했습니다"), errText(e));
  }
}

/**
 * 영상 주소 하나를 **화면에 맞는 재생 틀**로 바꾼다.
 *
 * ## 🔴 왜 「비메오 전용」이면 안 되나
 *
 * 대표님: "사람들은 비메오가 뭔지도 몰라. 그냥 영상 링크라고 하는 게 좋지.
 * 아무 영상 링크 올리면 되니 말이야."
 *
 * 맞다. 사장은 이미 어딘가에 올려 뒀고, 그 주소를 붙여넣을 뿐이다. 그래서
 * 우리가 **주소 모양을 보고 알아서** 맞춘다. 못 알아보는 곳이면 억지로
 * 끼우지 않고 **「영상 열기」 단추**를 준다 — 깨진 네모를 보여 주는 것보다
 * 낫다. 임베드를 막아 둔 곳(인스타·틱톡 등)이 실제로 있다.
 *
 * ## 화면에 맞게
 *
 * `aspect-ratio: 16/9` 에 `width: 100%`. 이러면 창을 줄이든 폰에서 보든
 * 가로에 맞춰 세로가 따라온다. 높이를 픽셀로 박으면 폰에서 위아래가
 * 잘리거나 검은 띠가 생긴다.
 */
function videoEmbed(raw: string): string {
  const url = (raw || "").trim();
  if (!url) return "";
  let src = "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      src = `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    } else if (host.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      const short = u.pathname.match(/\/(shorts|embed|live)\/([\w-]+)/);
      if (v) src = `https://www.youtube.com/embed/${v}`;
      else if (short) src = `https://www.youtube.com/embed/${short[2]}`;
    } else if (host.endsWith("vimeo.com")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (/^\d+$/.test(id || "")) src = `https://player.vimeo.com/video/${id}`;
    } else if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(u.pathname)) {
      // 파일 주소는 그대로 재생한다. 임베드가 필요 없다.
      return `<video class="vid" src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>`;
    }
  } catch {
    // 주소가 아니면 아래 폴백으로 간다.
  }
  if (!src) {
    return `<a class="btn ghost" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener"
              style="display:inline-flex;margin-top:10px">${t("영상 열기")} →</a>
            <div class="meta">${t("이곳은 화면 안에서 못 틀어서 새 창으로 엽니다.")}</div>`;
  }
  // 🔴 `sandbox` 를 안 건다. 유튜브·비메오 플레이어는 스크립트로 도는데
  //    막으면 검은 네모만 나온다. 대신 `referrerpolicy` 로 우리 주소를
  //    안 넘기고, 이 틀 안에서 지갑에 닿을 길은 없다.
  return `<div class="vidwrap"><iframe src="${src}" title="영상" allowfullscreen
            referrerpolicy="no-referrer" loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe></div>`;
}

/* ── 끌어다 놓기 ─────────────────────────────────────────────
   🔴 **떨어뜨린 자리가 곧 뜻이다.** 같은 사진이라도 자산 화면에 놓으면
   발행이고, 이야기 화면에 놓으면 글에 붙이는 것이다. 하나로 뭉뚱그리면
   채팅에 사진 올리려던 사람이 500 RVN 을 태우게 된다.

   그리고 **끌고 오는 순간** 무슨 일이 일어날지 말한다. 놓고 나서 알려
   주면 늦다 — 되돌릴 수 없는 일이 섞여 있다.                          */

type DropJob = { title: string; why: string; ok: boolean };

function dropJob(): DropJob {
  switch (currentPage) {
    case "assets":
      return {
        title: t("새 자산으로 발행합니다"),
        why: t("파일이 파일창고에 올라가고, 이어서 이름을 정하는 화면이 열립니다. RVN 이 소각되는 것은 마지막에 한 번 더 여쭙습니다."),
        ok: true,
      };
    case "talk":
      return {
        title: t("사진을 글에 붙입니다"),
        // 🔴 놓자마자 나가지 않는다. 입력칸 위에서 기다렸다가 「보내기」를
        //    눌러야 나간다 — 그 사이에 「이거 얼마예요」를 적을 수 있다.
        why: t("자산으로 만드는 것이 아닙니다. 입력칸 위에 붙여 두고, 「보내기」를 누르면 글과 함께 나갑니다 — 값이 들지 않습니다."),
        ok: true,
      };
    case "shop":
      return {
        title: t("가게 사진으로 씁니다"),
        why: t("가게 정보에 붙습니다. 체인은 안 건드리므로 값이 들지 않습니다."),
        ok: true,
      };
    default:
      return {
        title: t("여기서는 받지 않습니다"),
        why: t("「자산」에 놓으면 발행하고, 「이야기」에 놓으면 글에 붙입니다."),
        ok: false,
      };
  }
}

function dropVeil(on: boolean) {
  const v = $("dropveil");
  if (!on) {
    v.classList.remove("on");
    return;
  }
  const j = dropJob();
  $("dropveil-t").textContent = j.title;
  $("dropveil-p").textContent = j.why;
  v.classList.toggle("no", !j.ok);
  v.classList.add("on");
}

/** 사진인가. 영상은 **안 올린다** — 링크로 받는다.
 *
 *  🔴 `heic`·`heif` 를 넣는다. **아이폰 사진의 기본 형식**인데 여기서 빠져
 *     있어서, 폰에서 옮긴 사진을 떨어뜨리면 「사진만 받습니다」가 떴다.
 *     러스트(`ext_kind`)는 처음부터 받고 있었다 — 화면만 안 받고 있었다. */
function looksLikeImage(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|svg)$/i.test(path);
}

async function onDropped(paths: string[]) {
  dropVeil(false);
  const j = dropJob();
  if (!j.ok || !paths.length) return;

  const vids = paths.filter((p) => /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(p));
  const files = paths.filter(looksLikeImage);
  if (vids.length && !files.length) {
    await sure(
      t("영상은 올리지 않습니다"),
      t("영상 파일 대신 **영상 주소**를 붙여넣으시면 됩니다. 계산대 컴퓨터가 영상을 나르면 가게 인터넷이 느려지고, 그 인터넷은 주문 받는 길이기도 합니다.").replace(/\*\*/g, ""),
      t("알겠습니다")
    );
    return;
  }
  if (!files.length) {
    await sure(t("사진만 받습니다"), t("사진(jpg · png · gif · webp)을 놓아 주세요."), t("알겠습니다"));
    return;
  }

  const one = files[0];

  // 🔴 「이야기」는 여기서 갈라진다. 예전에는 떨어뜨리는 즉시 파일창고에
  //    올리고 **게이트웨이 주소 한 줄을 입력칸에 붙였다.** 그러면
  //    ① 글에 `imeta`·`ipfs` 표가 안 붙어서 우리 화면도 남의 앱도 사진인 줄
  //       모르고 파란 링크 한 줄로만 보였고,
  //    ② 사진은 이미 올라갔는데 사장이 안 보내면 아무도 못 볼 사진만
  //       파일창고에 영영 남았다.
  //    이제는 **보낼 때 한 번에** 올린다(`talk_photo_post`). 여기서는
  //    경로만 붙잡아 둔다 — 내용은 안 읽는다(`dropbox.rs` 가 대조한다).
  if (currentPage === "talk") {
    const 이름 = one.split(/[\\/]/).pop() || "photo";
    tkStagePhoto({ name: 이름, size: 0, path: one });
    $("tk-note").innerHTML =
      `<span class="ok">${t("사진을 붙였습니다 — 「보내기」를 누르면 나갑니다")}</span>`;
    return;
  }

  try {
    const added = await invoke<any>("ipfs_add_dropped", { path: one });
    const cid = String(added.cid || "");
    if (!cid) throw new Error(t("올리지 못했습니다"));

    if (currentPage === "assets") {
      // 마법사를 열고 **이미 올라간 상태**로 시작한다. 다시 고르게 하면
      // 끌어다 놓은 뜻이 없다.
      openWizard();
      ($("i-ipfs") as HTMLInputElement).value = cid;
      $("i-preview").innerHTML =
        `<img src="http://127.0.0.1:8080/ipfs/${cid}" alt="" style="max-width:220px;border-radius:8px;margin-top:9px" />`;
      // 「이야기」는 위에서 이미 갈라져 나갔다 — 여기로 안 온다.
    } else if (currentPage === "shop") {
      const el = document.getElementById("sh-icon") as HTMLInputElement | null;
      if (el) el.value = cid;
      $("sh-refreshsay").innerHTML =
        `<span class="ok">${t("가게 사진으로 넣었습니다. 「바뀐 것 손님에게 알리기」를 눌러 주세요.")}</span>`;
    }
  } catch (e) {
    await sure(t("올리지 못했습니다"), errText(e), t("닫기"));
  }
}

/* ── 간판 열쇠 옮기기 ─────────────────────────────────────────
   🔴 100 RVN 이 타고 되돌릴 수 없다. **일어날 일을 다 적고 나서** 묻는다. */

async function paintKeyMove() {
  const box = document.getElementById("km-box");
  const body = document.getElementById("km-body");
  if (!box || !body) return;
  let p: any;
  try {
    p = await invoke("shop_key_move_plan");
  } catch {
    // 가게가 없거나 노드가 아직 안 따라잡았다. 조용히 감춘다 —
    // 이 칸은 없어도 장사가 된다.
    box.style.display = "none";
    return;
  }
  // 이미 12단어에서 나온 열쇠면 이 칸을 아예 안 보여 준다.
  if (String(p.blocked || "").includes("이미 12단어")) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  const max = Number(p.max_add || 0);
  const blocked = p.blocked ? String(p.blocked) : "";
  body.innerHTML =
    `<p class="meta">${t("지금 간판 열쇠는 무작위로 만들어졌습니다. 이 컴퓨터의 백업 파일이 유일한 사본이라, 그 파일을 잃으면 「지금 여기서 주문받습니다」를 영영 못 고칩니다.")}</p>
     <div class="kv"><b>${t("가게")}</b><span><code class="addr">${escapeHtml(String(p.asset))}</code></span></div>
     <div class="kv"><b>${t("지금 열쇠")}</b><span><code class="addr">${escapeHtml(String(p.now_pubkey || "").slice(0, 16))}…</code></span></div>
     <div class="kv"><b>${t("새 열쇠")}</b><span><code class="addr">${escapeHtml(String(p.new_pubkey || "—").slice(0, 16))}…</code> ${t("(12단어에서)")}</span></div>
     <div class="kv"><b>${t("지금 수량")}</b><span>${Number(p.amount || 0).toLocaleString()}${t("개")}</span></div>
     ${blocked ? `<p class="meta danger" style="margin-top:10px">${escapeHtml(blocked)}</p>` : `
     <label style="margin-top:12px">${t("이참에 더 찍을 수량")}
       <input id="km-qty" type="number" min="0" step="1" value="${max}" /></label>
     <div class="meta">
       ${t("넣을 수 있는 최대")} <b>${max.toLocaleString()}</b>${t("개")} —
       ${t("상한은 210억인데 이미 있는 것만큼 빼야 합니다. 넘으면 거래가 통째로 실패합니다.")}
     </div>
     <div class="note" style="margin-top:12px">
       <b>${t("일어나는 일")}</b>
       <div class="meta" style="margin-top:6px;line-height:1.9">
         · ${t("100 RVN 이 소각됩니다. 돌아오지 않습니다.")}<br />
         · ${t("가게 정보를 그대로 가져와 열쇠 한 줄만 바꿔 다시 새깁니다 — 다른 정보는 안 잃습니다.")}<br />
         · ${t("체인에 새긴 뒤에야 열쇠 파일을 바꿉니다. 실패하면 아무것도 안 바뀝니다.")}<br />
         · ${t("옛 열쇠는 지우지 않고 옆에 남깁니다.")}<br />
         · ${t("「재발행 가능」은 켠 채로 둡니다 — 끄면 결제 주소도 영영 못 바꿉니다.")}<br />
         · ${t("확인되기까지 몇 분 걸리고, 그동안 손님 화면은 옛 정보를 봅니다.")}
       </div>
     </div>
     <div class="row" style="margin-top:12px">
       <button id="km-go">${t("100 RVN 소각하고 바꾸기")}</button>
       <span class="meta" id="km-note"></span>
     </div>`}`;
  const go = document.getElementById("km-go");
  if (go) go.addEventListener("click", () => void doKeyMove(p));
}

async function doKeyMove(p: any) {
  const qty = parseFloat(($("km-qty") as HTMLInputElement)?.value || "0") || 0;
  const max = Number(p.max_add || 0);
  if (qty > max) {
    $("km-note").innerHTML = `<span class="danger">${t("넣을 수 있는 최대를 넘었습니다")} — ${max.toLocaleString()}</span>`;
    return;
  }
  const ok = await sure(
    t("정말 바꿀까요?"),
    `${p.asset} · ${t("100 RVN 이 소각되고 돌아오지 않습니다.")} ` +
      (qty > 0 ? `${qty.toLocaleString()}${t("개를 더 찍습니다.")} ` : t("수량은 안 늘립니다. ")) +
      t("되돌릴 수 없습니다.")
  );
  if (!ok) return;
  if (!(await ensureUnlocked(t("체인에 새기려면 지갑을 열어야 합니다.")))) return;
  const btn = $("km-go") as HTMLButtonElement;
  btn.disabled = true;
  $("km-note").textContent = t("새기는 중… 몇 분 걸립니다");
  try {
    const r = await invoke<any>("shop_key_move", { qty, passphrase: null });
    $("km-note").innerHTML =
      `<span class="ok">${t("새겼습니다")} — <code class="addr">${escapeHtml(String(r.txid)).slice(0, 20)}…</code></span>`;
  } catch (e) {
    btn.disabled = false;
    $("km-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/* ── 이야기 ───────────────────────────────────────────────────
   세계와 한 방에서. 🔴 여기는 **RVN 이 필요 없다** — 레이븐을 아직 안 쓰는
   사람이 이 프로그램을 켜 둘 이유가 여기서 생긴다.                      */

let tkRoom = "";
let tkMine = "";
/** 공개키 → 이름표. 없는 사람은 여기 없다 — **없는 이름을 지어내지 않는다.** */
const tkNames = new Map<string, any>();

/* ── 안 보기 (차단) ──────────────────────────────────────────────────
 *
 * ## 🔴 「내보내기」는 만들지 않았다 — 만들 수 없어서다
 *
 * 대표님: "채팅방에 이상한 사람 내보내기 기능이나 차단 기능,
 *          차단해제 기능도 있어야 하지 않나?"
 *
 * 텔레그램은 방을 텔레그램이 갖고 있어서 방장이 사람을 내보낼 수 있다.
 * 여기는 다르다. 이 방은 **세계에 흩어진 릴레이 수십 곳**에 동시에 있고,
 * 아무나 아무 릴레이에나 글을 올린다. 방을 만든 사람에게도 남의 글을
 * 지우거나 막을 권한이 **없다** — 그런 권한을 둘 자리가 없다.
 *
 * 그러니 「내보내기」 단추를 다는 것은 **거짓말**이다. 눌러도 그 사람은
 * 계속 쓴다. 사장은 처리했다고 믿고 있다가 다음 글을 보고 「고장났다」고
 * 한다. 없는 힘을 있는 척하는 것이 가장 나쁘다.
 *
 * ## 할 수 있는 것 — 내 화면에서 안 보기
 *
 * 숨기는 것은 **이 컴퓨터 안에서만** 일어난다. 그래서 화면에 그렇게 적는다.
 *
 * ## 어디에 저장하나 — `localStorage`
 *
 * 이 프로그램은 「이 컴퓨터에서 내가 정한 것」을 전부 `localStorage` 에 둔다
 * (말 고르기·업데이트 미루기·내 타일). 안 보기도 같은 성격이다 —
 * 돈도 열쇠도 아니고, 없어져도 글이 다시 보일 뿐 잃는 것이 없다.
 * 러스트 파일로 옮기면 백업·복구·권한을 다 따라 만들어야 하는데
 * 그만한 값이 아니다.
 *
 * ## ⚠️ Nostr 표준(NIP-51 kind 10000)에 자리는 있는데 못 올린다
 *
 * 올리려면 **이 사람의 열쇠로 서명**해야 하는데, 이야기 열쇠는 러스트의
 * `talkkey.json` 안에만 있고 화면으로 내려오지 않는다(일부러 그렇다).
 * 서명해 주는 명령이 생기면 그때 다른 앱과 명단을 나눌 수 있다.
 * 지금은 **이 컴퓨터에서만** 듣는다 — 화면에도 그렇게 적었다.
 */
const TK_MUTE_KEY = "playx-raven-talk-mute";

/* ── 대화 화면을 카톡처럼 ────────────────────────────────────────────
 *
 * 🔴 **대표님 지적(2026-08-30): "화면이 복잡하다. 심플하지 않다."**
 *
 * 원인은 기능이 많아서가 아니라 **내가 경고를 전부 늘 띄운 것**이었다.
 * 「신뢰」를 지키려고 넣은 문장인데, 매번 보이면 안 읽는다 —
 * 안 읽히는 경고는 아무것도 안 지킨다. 그래서 **한 번만 말하고 접는다.**
 *
 * ⚠️ 없앤 것은 하나도 없다. 접은 것은 「더 보기」 안에 글자로 들어 있고,
 *    처음 세 번은 저절로 보인다. 「숨긴 기능은 안 적으면 없앤 기능」이라는
 *    이 파일의 원칙은 그대로다 — 자리를 옮겼을 뿐이다.
 */
const TK_본횟수_KEY = "playx-raven-talk-seen";
const TK_처음몇번 = 3;

/** 이야기 화면을 몇 번 열었나. 세 번까지는 안내를 저절로 보여 준다. */
function tk본횟수(): number {
  try {
    return Number(localStorage.getItem(TK_본횟수_KEY) || "0") || 0;
  } catch {
    return TK_처음몇번; // 못 읽으면 안 보여 준다 — 매번 뜨는 것보다 낫다
  }
}

/** 화면을 열 때 한 번 부른다. 처음 세 번만 안내가 뜬다. */
function tk처음안내() {
  const n = tk본횟수();
  const 처음 = n < TK_처음몇번;
  const first = document.getElementById("tk-first");
  const hint = document.getElementById("tk-hint");
  if (first) first.hidden = !처음;
  if (hint) hint.hidden = !처음;
  if (!처음) return;
  try {
    localStorage.setItem(TK_본횟수_KEY, String(n + 1));
  } catch {
    /* 못 세어도 화면은 열린다 */
  }
}

/* ── 다른 나라 말은 저절로 옮긴다 ───────────────────────────────────
 *
 * 대표님: "결국 이 암호화폐의 성패는 전세계가 커뮤니티로 서로 도와주는데
 * 있는것 같아."
 *
 * 그런데 그 기능이 **글마다 단추 한 번 뒤에** 숨어 있었다. 일본 손님이
 * 쓴 글을 읽으려면 누르고, 다음 글에서 또 누른다. 그러면 아무도 안 쓴다.
 *
 * ## 🔴 무엇을 옮기고 무엇을 안 옮기나
 *
 * **글자만 보고 정한다.** 한글이 있으면 한국말, 가나가 있으면 일본말,
 * 한자만 있으면 중국말, 그 밖은 영어로 본다. 내 말과 같으면 **안 부른다** —
 * 이것이 값을 아끼는 자리다(번역은 우리가 값을 내는 유일한 자리다).
 *
 * ⚠️ 짐작이 틀릴 수 있다. 한자만 쓴 한국어 글은 중국말로 읽힌다.
 *    그때는 옮긴 글이 하나 더 붙을 뿐 **원문은 그대로 남는다** —
 *    원문이 진짜고 옮긴 것은 곁들이다. 틀려도 잃는 것이 없다.
 *
 * ⚠️ 한 번에 열두 개까지만. 서버가 분당 40개에서 막는데, 방에 글이
 *    백 개면 한 번 그릴 때 다 부르고 **나머지는 전부 실패**한다.
 *    화면에 보이는 것은 아래쪽이라 **최근 것부터** 옮긴다.
 */
const TK_자동옮김_KEY = "playx-raven-talk-auto-tr";
const TK_한번에 = 12;

/**
 * 이미 옮긴 글. **글 번호로 기억한다.**
 *
 * 🔴 이게 없으면 값이 샌다. `talkPaint` 는 목록을 통째로 다시 그리는데,
 *    그때 「이건 옮겼다」는 표시(`dataset`)가 같이 지워진다. 새 글이 하나
 *    올 때마다 **보이는 글 열둘을 처음부터 다시 옮긴다** — 옮기기는 우리가
 *    값을 내는 유일한 자리이고, 서버도 분당 마흔에서 막는다.
 *
 * 글 번호는 안 변하니까 한 번 옮긴 것은 영영 안 다시 부른다.
 * 창을 닫으면 사라진다(그때는 어차피 다시 받아 그린다).
 */
const tk옮긴것 = new Map<string, string>();

function tk자동옮김(): boolean {
  try {
    return localStorage.getItem(TK_자동옮김_KEY) === "1";
  } catch {
    return false;
  }
}

/** 글자만 보고 무슨 말인지 짐작한다. 서버를 안 부르므로 값이 안 든다. */
function tk무슨말(s: string): "ko" | "ja" | "zh" | "en" {
  if (/[가-힣ᄀ-ᇿ]/.test(s)) return "ko";
  // 가나가 하나라도 있으면 일본말이다. 일본 글은 한자와 섞여 있다.
  if (/[぀-ゟ゠-ヿ]/.test(s)) return "ja";
  if (/[一-鿿]/.test(s)) return "zh";
  return "en";
}

/** 옮길 값이 있는 글인가. 숫자·주소·이모티콘만 있는 줄은 부르지 않는다. */
function tk옮길만한가(s: string): boolean {
  const 글 = s.trim();
  if (글.length < 2) return false;
  // 글자가 하나도 없으면(주소·숫자·기호뿐) 옮길 것이 없다.
  if (!/[\p{L}]/u.test(글)) return false;
  return tk무슨말(글) !== lang;
}

/**
 * 지금 그려져 있는 글 중 **내 말이 아닌 것**을 찾아 옮겨 붙인다.
 *
 * 이미 옮긴 것(`.tr` 이 붙은 것)은 건너뛴다 — `talkTranslate` 도 같은
 * 자리를 본다. 두 길이 같은 규칙을 쓰므로 두 번 붙지 않는다.
 */
async function tk옮길것찾기() {
  if (!tk자동옮김()) return;
  const box = document.getElementById("tk-list");
  if (!box) return;
  const 후보: { el: HTMLElement; 글: string; id: string }[] = [];
  box.querySelectorAll<HTMLElement>("[data-say]").forEach((el) => {
    if (el.querySelector(".tr")) return;
    const id = String(el.dataset.say || "");
    // 🔴 **이미 옮긴 것은 다시 안 부른다.** 다시 그릴 때마다 붙여만 준다.
    //    이 두 줄이 없으면 새 글 하나에 열두 번씩 값을 낸다.
    const 있던것 = tk옮긴것.get(id);
    if (있던것 !== undefined) {
      if (있던것) el.insertAdjacentHTML("beforeend", `<div class="tr">${escapeHtml(있던것)}</div>`);
      return;
    }
    if (el.dataset.trDone === "1") return;
    // 🔴 사진이 붙은 풍선은 **첫 글자 마디만** 본다. 통째로 읽으면 사진
    //    칸의 「받는 중…」 같은 우리 안내문까지 옮기러 보낸다.
    const 첫 = el.childNodes[0];
    const 글 = 첫 && 첫.nodeType === Node.TEXT_NODE ? String(첫.textContent || "").trim() : "";
    if (!tk옮길만한가(글)) return;
    후보.push({ el, 글, id });
  });
  // 🔴 최근 것부터. 화면에 보이는 것은 아래쪽인데, 위에서부터 세면
  //    한도를 옛날 글로 다 써 버리고 **보이는 글은 하나도 안 옮겨진다.**
  const 할것 = 후보.slice(-TK_한번에);
  for (const { el, 글, id } of 할것) {
    // 두 번 부르지 않게 먼저 표시한다. 실패해도 이 판에는 다시 안 부른다 —
    // 서버가 막고 있는데 계속 두드리면 더 오래 막힌다.
    el.dataset.trDone = "1";
    try {
      const j = await invoke<any>("talk_translate", { text: 글, to: lang });
      const 옮김 = String(j?.translation || "");
      // 같은 글이 돌아오면 붙이지 않는다. 같은 말을 두 번 적는 셈이다.
      // 🔴 그때도 **기억은 해 둔다**(빈 값으로). 안 그러면 다시 그릴 때마다
      //    「옮길 것이 없더라」를 확인하러 또 값을 낸다.
      if (!옮김 || 옮김.trim() === 글) {
        tk옮긴것.set(id, "");
        continue;
      }
      tk옮긴것.set(id, 옮김);
      if (el.querySelector(".tr")) continue;
      el.insertAdjacentHTML("beforeend", `<div class="tr">${escapeHtml(옮김)}</div>`);
    } catch {
      // 🔴 조용히 넘어간다. 옮기기는 **곁들이**다 — 못 옮겼다고 빨간 글씨를
      //    글마다 띄우면 대화가 오류 목록이 된다. 원문은 그대로 보인다.
      //
      // ⚠️ 실패는 **기억하지 않는다.** 잠깐 끊긴 것일 수 있고, 그때 영영
      //    안 옮기기로 하면 인터넷이 돌아와도 그 글은 계속 원문뿐이다.
      //    이 판에서만 안 부른다(`trDone`).
    }
  }
}

/** 숨긴 사람. 값에 이름을 같이 둔다 — 숨긴 뒤에는 릴레이에서 이름표를
 *  다시 안 읽으므로, 안 적어 두면 명단이 16진수만 늘어선 표가 된다. */
type TkMute = { at: number; name: string };
let tkMuted: Record<string, TkMute> = {};

/** 방금 되돌린 사람. 「눌렀는데 뭐가 바뀌었지?」를 없애려고 한 판만 기억한다. */
let tkJustBack: string[] = [];

function tkMuteLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(TK_MUTE_KEY) || "{}");
    // 깨진 값이 들어 있어도 이야기 화면은 열려야 한다.
    if (v && typeof v === "object" && !Array.isArray(v)) tkMuted = v as Record<string, TkMute>;
  } catch {
    tkMuted = {};
  }
}
tkMuteLoad();

function tkMuteSave() {
  try {
    localStorage.setItem(TK_MUTE_KEY, JSON.stringify(tkMuted));
  } catch {
    // 저장을 못 해도 이번 판은 숨겨진다. 다음에 켜면 되돌아올 뿐이다.
  }
}

/** 명단에 보일 이름. 숨길 때 적어 둔 이름 → 지금 아는 이름 → 앞자리. */
function tkMuteName(pk: string): string {
  const saved = tkMuted[pk]?.name || tkNames.get(pk)?.name || "";
  return saved ? String(saved) : `${pk.slice(0, 10)}…`;
}

/**
 * 이 사람 글을 내 화면에서 숨긴다.
 *
 * 🔴 묻는 창에서 **무슨 일이 일어나는지 그대로 적는다.** 「차단하시겠습니까」
 *    만 적으면 사장은 내보내는 줄 안다.
 */
async function talkMute(pk: string) {
  if (!pk || pk === tkMine) return;
  const ok = await sure(
    `${tkMuteName(pk)} ${t("님 안 보기")}`,
    t("내 화면에서만 숨깁니다. 그 사람은 계속 쓸 수 있고, 다른 사람에게는 그대로 보입니다. 내보내는 것이 아닙니다. 언제든 되돌릴 수 있습니다."),
    t("안 보기")
  );
  if (!ok) return;
  tkMuted[pk] = { at: Date.now(), name: String(tkNames.get(pk)?.name || "") };
  tkJustBack = tkJustBack.filter((p) => p !== pk);
  tkMuteSave();
  talkPaintMuted();
  void talkPaint();
}

/** 되돌리기. 지운 자리에 「되돌렸습니다」를 남긴다 — 조용히 사라지면 불안하다. */
function talkUnmute(pk: string) {
  if (!tkMuted[pk]) return;
  const name = tkMuteName(pk);
  delete tkMuted[pk];
  tkMuteSave();
  if (!tkJustBack.includes(name)) tkJustBack.push(name);
  talkPaintMuted();
  void talkPaint();
}

/** 안 보기 명단을 열고 닫는다. 열 때만 다시 그린다. */
function talkToggleMuted() {
  const box = $("tk-mutebox");
  box.hidden = !box.hidden;
  if (!box.hidden) talkPaintMuted();
}

function talkOpenMuted() {
  $("tk-mutebox").hidden = false;
  talkPaintMuted();
}

/**
 * 안 보기 명단.
 *
 * ⚠️ 40~70대 화면이다. 단추는 44px, 글자는 15px 이상 — 여기서만은
 *    말풍선 옆의 작은 단추 문법을 따르지 않는다. 되돌리는 자리는
 *    실수 없이 눌려야 한다.
 */
function talkPaintMuted() {
  const list = $("tk-mutelist");
  const btn = document.getElementById("tk-muted");
  const keys = Object.keys(tkMuted).sort((a, b) => (tkMuted[b]?.at || 0) - (tkMuted[a]?.at || 0));

  // 머리줄 단추에 몇 명인지 적는다. 안 적으면 명단을 열기 전까지
  // 내가 누굴 숨겼는지 알 길이 없다.
  if (btn) btn.textContent = keys.length ? `${t("안 보기")} ${keys.length}` : t("안 보기 명단");

  const back = tkJustBack.length
    ? `<p class="muteback">${t("다시 보기로 되돌렸습니다")} — ${escapeHtml(tkJustBack.join(", "))}</p>`
    : "";

  if (!keys.length) {
    list.innerHTML =
      back +
      `<p class="mutenone">${t("안 보기로 한 사람이 없습니다.")}</p>`;
    return;
  }

  list.innerHTML =
    back +
    keys
      .map((pk) => {
        const when = new Date(tkMuted[pk]?.at || 0).toLocaleDateString();
        return `<div class="muterow">
            <span class="mutewho" title="${escapeHtml(pk)}">${escapeHtml(tkMuteName(pk))}</span>
            <span class="mutewhen">${escapeHtml(when)}</span>
            <button data-unmute="${escapeHtml(pk)}">${t("다시 보기")}</button>
          </div>`;
      })
      .join("");

  list.querySelectorAll("[data-unmute]").forEach((b) => {
    (b as HTMLElement).onclick = () => talkUnmute(String((b as HTMLElement).dataset.unmute));
  });
}

/* ── 경고는 문장이 아니라 **그 순간**이어야 한다 ────────────────────
 *
 * 🔴 자문(2026-08-30): "접은 것은 옳지만 **횟수로 접은 것이 틀렸다.**
 *    위험은 세 번째 이후에 온다. 경고는 위험한 행동의 순간에 붙어야 지킨다."
 *
 * 맞는 말이다. 「이름은 누구나 같게 달 수 있습니다」를 머리줄에 늘 띄워
 * 봐야, 정작 누가 사장 이름을 흉내 내고 「계좌가 바뀌었어요」라고 쓰는
 * **그 글 옆에는 아무 표시도 없었다.** 위험한 것은 화면이 아니라 그 글이다.
 *
 * 그래서 두 가지를 글 옆에 붙인다:
 *   ① 주소나 돈이 적힌 글 → 그 말풍선에 「확인하고 보내세요」
 *   ② 같은 이름을 쓰는 열쇠가 둘 이상 → 그 이름표에 「같은 이름 N명」
 *
 * ②가 진짜 방어다. 흉내 내는 사람이 나타나는 **바로 그때** 표시가 뜬다.
 * 늘 떠 있는 경고문은 아무 때도 안 뜨는 것과 같다.
 */

/** 이 방에서 같은 이름을 쓰는 열쇠가 둘 이상인 이름들. 한 판 그릴 때마다 새로 센다. */
let tk겹친이름 = new Map<string, number>();

/** 지금 그릴 사람들 중 이름이 겹치는 것을 센다. 열쇠가 다르면 다른 사람이다. */
function tk겹친이름세기(pubkeys: string[]) {
  const 이름별열쇠 = new Map<string, Set<string>>();
  for (const pk of new Set(pubkeys)) {
    const 이름 = String(tkNames.get(pk)?.name || "").trim();
    if (!이름) continue; // 이름을 안 정한 사람끼리는 겹칠 것이 없다
    if (!이름별열쇠.has(이름)) 이름별열쇠.set(이름, new Set());
    이름별열쇠.get(이름)!.add(pk);
  }
  tk겹친이름 = new Map(
    [...이름별열쇠].filter(([, 열쇠들]) => 열쇠들.size > 1).map(([n, s]) => [n, s.size]),
  );
}

/**
 * 이 글에 **돈이나 주소가 적혀 있나.**
 *
 * ⚠️ 넉넉하게 잡는다. 못 잡아서 안 띄우는 것보다 한 번 더 띄우는 편이 낫다 —
 *    이 표시가 하는 말은 「확인하고 보내세요」지 「이 사람은 사기꾼입니다」가
 *    아니라서, 틀려도 잃는 것이 없다.
 */
function tk돈이야기인가(s: string): boolean {
  // 레이븐 주소는 R 로 시작하는 34자 안팎이다.
  if (/\bR[1-9A-HJ-NP-Za-km-z]{25,40}\b/.test(s)) return true;
  // 「계좌」·「입금」·「보내」·「송금」·「지갑주소」 같은 말과 숫자가 같이 있을 때.
  if (/(계좌|입금|송금|이체|보내\s*주|지갑\s*주소|주소\s*바뀌|바뀌었)/.test(s)) return true;
  if (/\d[\d,]{2,}\s*(원|RVN|만원|천원)/i.test(s)) return true;
  return false;
}

/** 16진수 64자 대신 보여 줄 것. 이름이 있으면 이름, 없으면 앞자리. */
function tkWho(pk: string): string {
  const p = tkNames.get(pk);
  if (p?.name) {
    const 이름 = String(p.name);
    const 겹침 = tk겹친이름.get(이름.trim());
    return (
      escapeHtml(이름) +
      // 🔴 흉내 내는 사람이 나타난 **그때** 뜬다. 색(`--h`)이 이미 열쇠에서
      //    나오지만, 색만으로는 「다른 색이네」로 끝나고 뜻이 안 전해진다.
      (겹침
        ? `<span class="samename" title="${t("이름은 누구나 같게 달 수 있습니다. 색이 다르면 다른 분입니다.")}">${t("같은 이름")} ${겹침}${t("명")}</span>`
        : "")
    );
  }
  // 🔴 이름을 안 정한 사람. `.key` 는 **색을 안 받는다** — 열쇠 앞자리는
  //    이름이 아니라서, 거기에 사람 색을 칠하면 「이게 이름이구나」로 읽힌다.
  return `<span class="key">${escapeHtml(pk.slice(0, 10))}…</span>`;
}

/**
 * 열쇠에서 이름 색을 뽑는다. 같은 열쇠 = 늘 같은 색.
 *
 * 🔴 **아바타(얼굴 사진)는 없다. 없는 것을 그리지 않는다.** 이름 첫 글자를
 *    동그라미에 넣는 앱이 많지만, 여기는 이름을 안 정한 사람이 흔해서 그
 *    동그라미에 16진수 「a」가 들어간다. 그건 얼굴이 아니라 잡음이다.
 *
 *    대신 색을 준다. 색은 **이름이 아니라 열쇠**에서 나온다 — 그래서 남의
 *    이름을 똑같이 흉내 낸 사람은 색이 다르다. 이 화면이 이미 「이름은
 *    누구나 같게 달 수 있습니다」라고 경고하는 그 위험을 조금 덜어 준다.
 */
function tkHue(pk: string): number {
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 31 + pk.charCodeAt(i)) % 360;
  // 노랑~연두(45~75)는 흰 바탕에서 대비가 무너진다. 그 구간은 비켜 간다.
  if (h >= 45 && h <= 75) h = (h + 40) % 360;
  return h;
}

/** 「오후 3:12」. 날짜는 안 붙인다 — 날짜는 하루 구분선이 한 번만 말한다. */
function tkClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** 「2026년 8월 29일 금요일」. 하루가 바뀌는 자리에만 쓴다. */
function tkDay(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  } catch {
    return "";
  }
}

/** 같은 사람이 이 시간 안에 이어 쓰면 한 덩어리로 본다. */
const TK_이음 = 5 * 60 * 1000;

async function talkPaintMe() {
  try {
    const me = await invoke<any>("talk_me");
    tkMine = String(me.pubkey || "");
    await tkLoadNames([tkMine]);
    const mine = tkNames.get(tkMine);
    const shown = mine?.name ? escapeHtml(String(mine.name)) : t("이름 없음");
    // 머리줄은 좁다. 긴 설명은 「내 이름」 단추 안에서 말한다.
    $("tk-me").innerHTML =
      `<b>${shown}</b>` +
      (me.recoverable ? "" : ` <span class="warn">${t("· 백업 파일이 유일한 사본")}</span>`);
  } catch (e) {
    $("tk-me").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

let tkRoomNames = new Map<string, string>();

async function talkPaintRooms() {
  const box = $("tk-rooms");
  let rooms: any[] = [];
  try {
    rooms = await invoke("talk_rooms");
  } catch {
    // 방 목록을 못 읽어도 전체 글은 보여야 한다. 조용히 넘어간다.
  }
  tkRoomNames = new Map(rooms.map((r) => [String(r.id), String(r.name)]));
  paintInvite();
  box.innerHTML =
    `<button class="room${tkRoom ? "" : " on"}" data-room="">${t("레이븐 이야기")}</button>` +
    rooms
      .map(
        (r) =>
          `<button class="room${tkRoom === String(r.id) ? " on" : ""}" data-room="${escapeHtml(String(r.id))}"
             title="${escapeHtml(String(r.about || ""))}">${escapeHtml(String(r.name))}` +
          // 🔴 자산 방인 것을 **들어가기 전에** 알려 준다. 글을 다 쓰고
          //    보내기를 눌렀을 때 「못 씁니다」가 뜨면 그건 우리 잘못이다.
          (r.asset
            ? `<span class="tag" title="${t("이 자산을 가진 분만 씁니다")}">${escapeHtml(String(r.asset))}</span>`
            : "") +
          `</button>`
      )
      .join("");
  box.querySelectorAll("[data-room]").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      tkRoom = String((b as HTMLElement).dataset.room || "");
      // 한 번 연 방은 나가 있어도 지켜본다 — 그 방에 새 글이 오면 알린다.
      방지켜보기(tkRoom);
      $("tk-title").textContent = tkRoom
        ? tkRoomNames.get(tkRoom) || t("방")
        : t("레이븐 이야기");
      paintInvite();
      void talkPaintRooms();
      void talkPaint();
    };
  });
}

/**
 * **방에 남을 부르는 링크.**
 *
 * ## 🔴 왜 필요한가
 *
 * 대표님: "방을 sns 로 공유는 못하나?"
 *
 * 방을 만드는 것은 되는데 **남을 부를 길이 없었다.** 그러면 혼자 쓰는
 * 방이다. 만들어 놓고 안 잇는 그 병이 여기에도 있었다.
 *
 * ⚠️ 링크에 담는 것은 **방 번호뿐**이다. 대화 내용도 열쇠도 안 담는다 —
 *    링크는 어디로든 퍼지고, 한번 퍼지면 못 거둔다.
 */
function inviteLink(): string {
  if (!tkRoom) return "https://rvn.ex.erci.se/talk";
  return `https://rvn.ex.erci.se/talk?room=${encodeURIComponent(tkRoom)}`;
}

function paintInvite() {
  const host = document.getElementById("tk-invite");
  if (!host) return;
  const name = tkRoom ? tkRoomNames.get(tkRoom) || t("방") : t("레이븐 이야기");
  host.innerHTML = `<button class="ghost" id="tk-inv">${t("초대하기")}</button>`;
  document.getElementById("tk-inv")!.addEventListener("click", () => {
    const url = inviteLink();
    // 붙여넣기 좋게 **문구까지** 담는다. 사장이 문장을 지어내지 않아도 된다.
    const msg = `${t("이 방으로 오세요")} — ${name}\n${url}`;

    // 🔴 대표님(맥): "초대하기 누르면 링크 복사 기능이 없어. 윈도우에서는
    //    나오는데 맥에서는 안 나와."
    //
    //    원인은 **공유 시트에 맡긴 것**이었다. 맥 WebView 에도
    //    `navigator.share` 가 있어서 OS 시트가 열렸는데, **맥 시트에는
    //    「복사」가 없다** — AirDrop·메일·메시지 같은 앱만 나온다.
    //    그리고 `return` 으로 끝나서 복사 코드에 **도달하지 못했다.**
    //
    //    ⚠️ OS 가 무엇을 줄지 우리가 모른다. 그러니 **복사는 우리가 준다.**
    //       공유 시트는 있으면 얹는 것이지 기대는 것이 아니다.
    // 🔴 대표님: "공유 기능이 QR로도 되고 링크로도 되어야해."
    //    자리마다 다르게 만들지 않는다 — `shareBox` 하나를 쓴다.
    //    손님이 앞에 있으면 QR, 멀리 있으면 링크. 둘 다 한 자리에.
    void shareBox(host, url, msg, name).then(() => {
      // 닫으면 「초대하기」 단추로 되돌아간다.
      const back = document.createElement("button");
      back.className = "ghost";
      back.textContent = t("닫기");
      back.addEventListener("click", () => paintInvite());
      host.querySelector(".invbtns")?.appendChild(back);
    });

  });
}

/* ── 받은 글 안의 사진 ─────────────────────────────────────────────
   러스트가 사진 글에 표를 셋 붙인다(`talk_photo_post`):

     본문   "이거 얼마예요\nhttps://ipfs.io/ipfs/<CID>"
     imeta  ["imeta", "url …", "m image/jpeg", "x …", "size …"]   ← 남의 앱용
     ipfs   ["ipfs", "<CID>"]                                     ← 우리 앱용

   🔴 우리는 `ipfs` 표를 보고 **이 컴퓨터의 파일창고**에서 그린다. 남의
      게이트웨이(ipfs.io)를 거치면 느리고, 우리가 무슨 사진을 보는지 그쪽에
      다 남는다. 우리 파일창고는 못 가진 사진도 그물에서 받아 온다. */

/** 이 글에 사진이 붙어 있나. 있으면 주소와 종류를 준다. */
function tkPicOf(e: any): { cid: string; gateway: string; size: number } | null {
  const tags: any[] = Array.isArray(e?.tags) ? e.tags : [];
  const cid = String(tags.find((x) => Array.isArray(x) && x[0] === "ipfs")?.[1] || "");
  // imeta 는 한 표 안에 「열쇠 값」을 띄어쓰기로 이어 붙인다(NIP-92).
  const imeta: string[] = tags.find((x) => Array.isArray(x) && x[0] === "imeta") || [];
  const 뽑기 = (k: string) => {
    const 조각 = imeta.find((s) => typeof s === "string" && s.startsWith(`${k} `));
    return 조각 ? 조각.slice(k.length + 1).trim() : "";
  };
  const url = 뽑기("url");
  const size = Number(뽑기("size")) || 0;
  // 우리 표가 없어도 게이트웨이 주소에서 CID 를 꺼낼 수 있다 — 남의 앱
  // (damus·primal)에서 온 사진도 그러면 그려진다.
  const 남의것 = url.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1] || "";
  const 진짜 = cid || 남의것;
  if (!진짜) return null;
  return { cid: 진짜, gateway: url || `https://ipfs.io/ipfs/${진짜}`, size };
}

/**
 * 사진 주소 한 줄을 본문에서 뺀다.
 *
 * ⚠️ **본문을 고쳐 쓰는 것이 아니다.** 사진을 바로 아래에 그리므로, 같은
 *    것을 가리키는 주소 한 줄이 글자로 또 있으면 두 번 말하는 셈이다.
 *    주소 말고 다른 글자는 한 자도 안 건드린다 — 원문이 진짜다.
 */
function tkStripPicUrl(content: string, cid: string): string {
  return content
    .split("\n")
    .filter((line) => !(line.trim().includes(`/ipfs/${cid}`) && /^https?:\/\/\S+$/.test(line.trim())))
    .join("\n")
    .trim();
}

/**
 * 말풍선에 들어갈 사진 조각.
 *
 * 🔴 **못 받을 수 있다.** 사진은 보낸 사람 컴퓨터 한 곳에만 있을 수 있고,
 *    그 컴퓨터가 꺼져 있으면 세상 어디에도 없다. 그때 깨진 그림 아이콘만
 *    두면 사장은 우리 프로그램이 고장 난 줄 안다. 「사진을 못 받았습니다」와
 *    **왜 그런지**를 적고, 다시 받을 길과 인터넷 창으로 여는 길을 준다.
 */
function tkPicHtml(p: { cid: string; gateway: string; size: number }): string {
  const local = `http://127.0.0.1:8080/ipfs/${p.cid}`;
  return (
    `<div class="picwrap" data-cid="${escapeHtml(p.cid)}" data-gw="${escapeHtml(p.gateway)}">` +
    `<div class="picwait">${t("사진을 받는 중…")}</div>` +
    `<img class="bubpic" alt="${t("사진")}" hidden src="${escapeHtml(local)}" />` +
    `</div>`
  );
}

/**
 * 그려 놓은 사진마다 「받았나·못 받았나」를 지켜본다.
 *
 * ⚠️ 파일창고는 없는 사진을 물어보러 그물을 도는 동안 **오류도 안 내고
 *    그냥 안 답한다.** `onerror` 만 걸어 두면 영영 「받는 중…」이다.
 *    그래서 25초를 세고, 넘으면 못 받았다고 말한다 — 기다림은 답이 아니다.
 */
function tkWatchPics(box: HTMLElement) {
  box.querySelectorAll<HTMLElement>(".picwrap").forEach((w) => {
    const img = w.querySelector("img") as HTMLImageElement | null;
    const wait = w.querySelector(".picwait") as HTMLElement | null;
    if (!img) return;
    let 끝났나 = false;
    const 실패 = (why: string) => {
      if (끝났나) return;
      끝났나 = true;
      const gw = String(w.dataset.gw || "");
      w.innerHTML =
        `<div class="picfail"><b>${t("사진을 못 받았습니다")}</b>` +
        `<span class="picwhy">${escapeHtml(why)}</span>` +
        `<button data-picretry="1">${t("다시 받기")}</button>` +
        (gw ? `<button data-picweb="1">${t("인터넷 창에서 열기")}</button>` : "") +
        `</div>`;
      const again = w.querySelector("[data-picretry]") as HTMLElement | null;
      // ⚠️ 말풍선을 누르면 「내 말로」 단추 줄이 열린다. 사진 안의 단추를
      //    누른 것이 그 줄까지 여닫으면 손이 어디를 눌렀는지 모르게 된다.
      if (again) again.onclick = (ev) => {
        ev.stopPropagation();
        // 다시 그리고 다시 지켜본다. 파일창고를 방금 켰을 수도 있다.
        w.innerHTML =
          `<div class="picwait">${t("사진을 받는 중…")}</div>` +
          `<img class="bubpic" alt="${t("사진")}" hidden ` +
          `src="http://127.0.0.1:8080/ipfs/${escapeHtml(String(w.dataset.cid || ""))}?t=${Date.now()}" />`;
        tkWatchPics(w.parentElement || w);
      };
      const web = w.querySelector("[data-picweb]") as HTMLElement | null;
      if (web) web.onclick = (ev) => {
        ev.stopPropagation();
        void openUrl(gw);
      };
    };
    img.onload = () => {
      if (끝났나) return;
      끝났나 = true;
      if (wait) wait.remove();
      img.hidden = false;
    };
    // 🔴 **왜** 안 뜨는지를 갈라서 말한다. 원인이 다르면 할 일도 다르다.
    img.onerror = () =>
      실패(t("이 컴퓨터의 파일창고가 꺼져 있거나, 보낸 분이 컴퓨터를 끄셔서 사진이 어디에도 남아 있지 않습니다."));
    // 눌러서 크게 본다. 우리 창은 좁으니 인터넷 창에 맡긴다.
    img.onclick = (ev) => {
      ev.stopPropagation();
      void openUrl(`http://127.0.0.1:8080/ipfs/${String(w.dataset.cid || "")}`);
    };
    window.setTimeout(
      () => 실패(t("25초를 기다렸는데 아직 못 받았습니다. 보낸 분의 컴퓨터가 켜져 있어야 받을 수 있습니다.")),
      25000,
    );
  });
}

/**
 * 글 목록.
 *
 * 🔴 원문을 지운 자리에 번역을 넣지 않는다. **원문이 진짜다** — 서명되어
 *    릴레이에 남는 것은 원문이고, 번역은 읽기 위한 보조다. 번역 서버가
 *    죽어도 대화는 그대로 보여야 한다.
 */
async function talkPaint() {
  const box = $("tk-list");
  // ⚠️ 어느 방을 읽는지 **여기서 붙잡아 둔다.** 릴레이가 답하는 사이에
  //    사장이 다른 방을 누르면 `tkRoom` 이 바뀌어, 아래에서 이 목록을
  //    엉뚱한 방의 것으로 세게 된다.
  const 읽은방 = tkRoom;
  box.innerHTML = `<div class="meta" style="margin:auto">${t("세계 릴레이에서 읽는 중…")}</div>`;
  try {
    const list: any[] = await invoke("talk_read", { room: 읽은방 || null, limit: 60 });
    // 🔴 알림 판단은 **한 곳**에만 둔다. 화면이 읽은 것도 지킴이가 읽은 것도
    //    같은 곳(`대화살피기`)으로 보낸다 — 두 곳에 나눠 두면 한쪽만 고치는
    //    날이 온다. 주문 알림의 `주문살피기` 와 같은 배치다.
    //    ⚠️ 글이 없어도 부른다. 「이 방은 여기까지가 이미 아는 것」을 적는
    //       첫 바퀴가 여기이기 때문이다.
    대화살피기(읽은방, list);
    if (!list.length) {
      box.innerHTML =
        `<div class="meta" style="margin:auto;text-align:center;line-height:1.9">` +
        `${t("아직 글이 없습니다.")}<br />${t("첫 글을 올려 보세요 — 세계 릴레이로 함께 나갑니다.")}</div>`;
      return;
    }
    // 🔴 이름표를 **먼저** 가져온다. 안 그러면 화면에 16진수가 한 번
    //    떴다가 이름으로 바뀌는데, 그 깜빡임이 「고장났나」로 읽힌다.
    await tkLoadNames(list.map((e) => String(e.pubkey || "")));
    // 🔴 오래된 것이 위, 새것이 아래 — 대화창은 그 방향이다. 읽어 온 것은
    //    최신순이라 뒤집는다. 안 뒤집으면 인사가 맨 아래에 있다.
    const all = [...list].reverse();
    // 안 보기 한 사람의 글을 뺀다. 🔴 **거른 것을 말없이 없애지 않는다** —
    //    윗줄에 몇 개를 숨겼는지 적고, 거기서 바로 명단을 열 수 있게 한다.
    //    그래야 "어제 있던 글이 없어졌다" 가 고장으로 읽히지 않는다.
    const asc = all.filter((e) => !tkMuted[String(e.pubkey || "")]);
    const hid = all.length - asc.length;
    const hidNote = hid
      ? `<div class="hidnote">${t("안 보기 한 분의 글")} ${hid}${t("개를 숨겼습니다")} ·
           <button data-openmute="1">${t("명단 보기")}</button></div>`
      : "";
    // 앞뒤 글을 봐야 「이름을 또 적을까」·「시각을 찍을까」를 정할 수 있다.
    // 그래서 map 안에서 옆 글을 꺼내 쓴다.
    const 때 = asc.map((e) => Number(e.created_at || 0) * 1000);
    const 쓴이 = asc.map((e) => String(e.pubkey || ""));
    // 🔴 그리기 전에 **같은 이름을 쓰는 열쇠**를 센다. 흉내 내는 사람이
    //    나타난 그 판에만 이름표에 표시가 붙는다 — 늘 떠 있는 경고문과 달리
    //    이건 위험이 실제로 있을 때만 뜬다.
    tk겹친이름세기(쓴이);
    const 날 = 때.map((ms) => new Date(ms).toDateString());

    box.innerHTML = hidNote + asc
      .map((e, i) => {
        const who = 쓴이[i];
        const mine = who === tkMine;
        const id = String(e.id || "");
        const ms = 때[i];

        // ① 날짜는 **하루에 한 번**. 글마다 날짜를 적는 것이 게시판이다.
        const day = i > 0 && 날[i - 1] === 날[i]
          ? ""
          : `<div class="daysep">${escapeHtml(tkDay(ms))}</div>`;

        // ② 이름은 사람이 바뀌거나·날이 바뀌거나·5분이 지났을 때만.
        //    🔴 예전에는 `who === prev` 만 봤다. 그래서 어제 마지막으로 쓴
        //       사람이 오늘 아침 첫 글을 쓰면 **이름이 안 붙었다** — 밤을
        //       사이에 두고 이어 쓴 것처럼 보였다.
        //    ⚠️ 내 글에는 이름을 안 적는다. 오른쪽에 붙은 파란 풍선이 이미
        //       「나」다. 「나」라고 또 적으면 내 말마다 이름표가 하나씩 더
        //       붙는데, 그게 카톡과 게시판을 가르는 자리다.
        const 이어짐 =
          !day && i > 0 && 쓴이[i - 1] === who && ms - 때[i - 1] < TK_이음;
        const head =
          mine || 이어짐
            ? ""
            : `<div class="who" style="--h:${tkHue(who)}">${tkWho(who)}</div>`;

        // ③ 시각은 **덩어리의 마지막 글 옆에** 한 번. 한 사람이 세 줄을
        //    이어 쓰면 시각도 세 번 찍혔는데, 그게 글마다 메타 줄이 붙는
        //    게시판 문법이다. 정확한 날짜·초는 얹으면(title) 나온다.
        const 다음이어짐 =
          i + 1 < asc.length &&
          쓴이[i + 1] === who &&
          날[i + 1] === 날[i] &&
          때[i + 1] - ms < TK_이음;
        const clock = 다음이어짐
          ? ""
          : `<time class="tstamp" title="${escapeHtml(new Date(ms).toLocaleString())}">${escapeHtml(tkClock(ms))}</time>`;

        // ④ 사진이 붙어 있으면 말풍선 안에 그린다. 주소 한 줄은 본문에서
        //    빼고 — 사진을 바로 아래 그리므로 같은 말을 두 번 하는 셈이다.
        const pic = tkPicOf(e);
        const 본문 = pic
          ? tkStripPicUrl(String(e.content || ""), pic.cid)
          : String(e.content || "");

        // ⑤ 🔴 **돈·주소가 적힌 글에는 그 자리에서 표시한다.** 늘 떠 있는
        //    경고문은 아무도 안 읽지만, 「계좌가 바뀌었어요」라고 적힌 글
        //    바로 아래에 붙은 한 줄은 읽는다. 내 글에는 안 붙인다 —
        //    내가 쓴 것을 나에게 조심하라고 하는 것은 잡음이다.
        const 조심 =
          !mine && tk돈이야기인가(본문)
            ? `<p class="moneywarn">${t("돈·주소가 적힌 글입니다. 이름은 누구나 같게 달 수 있으니, 보내기 전에 다른 길로 한 번 확인하세요.")}</p>`
            : "";

        return (
          day +
          head +
          `<div class="line${mine ? " me" : ""}">
             <div class="bub${mine ? " me" : ""}" data-say="${id}">${escapeHtml(본문)}${pic ? tkPicHtml(pic) : ""}</div>
             ${clock}
           </div>` +
          조심 +
          `
           <div class="bubacts${mine ? " r" : ""}" data-acts="${id}">
             <button data-tr="${id}">${t("내 말로")}</button>
             <button data-keep="${id}">${t("간직")}</button>` +
          // 내 글에는 안 붙인다. 나를 안 보기로 할 이유가 없고,
          // 눌렀다가 내 글이 사라지면 그것부터 고장으로 읽힌다.
          (mine ? "" : `<button data-mute="${escapeHtml(who)}">${t("안 보기")}</button>`) +
            // 🔴 내 글에만. 이름이 「삭제」가 아니라 **「지우기 요청」**인 것이
            //    전부다 — Nostr 의 지움은 **부탁**이지 명령이 아니고, 릴레이가
            //    따를 의무가 없다. 「삭제」라 적으면 지워졌다고 믿는데 안 지워진다.
            (mine ? `<button data-del="${id}">${t("지우기 요청")}</button>` : "") +
          `<span class="meta" data-note="${id}"></span>
           </div>`
        );
      })
      .join("");
    // 새 글이 아래에 있으므로 맨 아래로 내린다. 안 하면 옛날 글만 보인다.
    box.scrollTop = box.scrollHeight;
    // 🔴 사진은 그려 놓고 **지켜봐야** 한다. 안 지켜보면 「받는 중…」에서
    //    영영 멈춰 있고, 그건 못 받았다는 말을 안 하는 것과 같다.
    tkWatchPics(box);
    // 🔴 다른 나라 말은 저절로 옮긴다(스위치가 켜져 있을 때만). 그리고 나서
    //    부른다 — 그려지기 전에 부르면 옮길 글을 하나도 못 찾는다.
    void tk옮길것찾기();
    // 🔴 **말풍선을 누르면 그 글의 단추만 나온다.**
    //
    //    단추 줄은 예전에 `opacity:0` 으로 **자리를 늘 차지**했고(손가락
    //    화면에서는 아예 보였다), 그래서 말 하나에 줄이 셋씩 쌓였다.
    //    이제는 누른 것 하나만 열린다 — 여러 개가 열려 있으면 다시 서류다.
    //
    //    ⚠️ 기능은 하나도 안 없앴다. 「내 말로」·「간직」·「안 보기」·
    //       「지우기 요청」이 전부 그대로 있고, 꺼내는 법은 입력칸 위에
    //       한 줄로 적어 뒀다(`.talkhint`). 숨긴 기능은 안 적으면 없앤 기능이다.
    box.querySelectorAll<HTMLElement>("[data-say]").forEach((b) => {
      b.onclick = () => {
        const gid = String(b.dataset.say || "");
        const acts = box.querySelector(`[data-acts="${gid}"]`) as HTMLElement | null;
        const 이미열림 = acts?.classList.contains("on") === true;
        box.querySelectorAll(".bubacts.on").forEach((x) => x.classList.remove("on"));
        // 같은 글을 다시 누르면 닫힌다 — 연 것을 못 닫으면 그것도 갇힌 것이다.
        if (acts && !이미열림) acts.classList.add("on");
      };
    });
    box.querySelectorAll("[data-tr]").forEach((b) => {
      (b as HTMLElement).onclick = () => void talkTranslate(String((b as HTMLElement).dataset.tr), list);
    });
    box.querySelectorAll("[data-keep]").forEach((b) => {
      (b as HTMLElement).onclick = () => void talkKeep(String((b as HTMLElement).dataset.keep), list);
    });
    box.querySelectorAll("[data-del]").forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        const gid = (b as HTMLElement).dataset.del!;
        const ok = await sure(
          t("지워 달라고 요청할까요?"),
          t("이미 본 사람의 화면과, 따르지 않는 릴레이에는 남을 수 있습니다."),
          t("요청합니다"),
        );
        if (!ok) return;
        const note = box.querySelector(`[data-note="${gid}"]`) as HTMLElement | null;
        try {
          const r = await invoke<any>("talk_delete_request", { id: gid });
          // 🔴 글을 화면에서 없애지 않는다. 없애면 지워진 줄 안다.
          (b as HTMLElement).textContent = t("지우기 요청함");
          (b as HTMLButtonElement).disabled = true;
          if (note) note.textContent = String(r?.say || "");
        } catch (e) {
          if (note) note.textContent = errText(e);
        }
      };
    });

    box.querySelectorAll("[data-mute]").forEach((b) => {
      (b as HTMLElement).onclick = () => void talkMute(String((b as HTMLElement).dataset.mute));
    });
    // 숨겼다는 윗줄에서 바로 명단으로. 되돌리는 길이 한 번에 보여야 한다.
    box.querySelectorAll("[data-openmute]").forEach((b) => {
      (b as HTMLElement).onclick = () => talkOpenMuted();
    });
  } catch (e) {
    box.innerHTML = `<p class="meta danger">${escapeHtml(errText(e))}</p>`;
  }
}

/** 아직 모르는 사람의 이름표만 가져온다. 이미 아는 것은 다시 안 묻는다. */
async function tkLoadNames(pubkeys: string[]) {
  const want = [...new Set(pubkeys.filter((p) => p && !tkNames.has(p)))].slice(0, 50);
  if (!want.length) return;
  try {
    const got: any = await invoke("talk_profiles", { pubkeys: want });
    for (const [pk, p] of Object.entries(got || {})) tkNames.set(pk, p);
    // 못 찾은 사람도 적어 둔다 — 안 그러면 화면을 그릴 때마다 또 묻는다.
    for (const p of want) if (!tkNames.has(p)) tkNames.set(p, null);
  } catch {
    // 이름표를 못 읽어도 글은 보여야 한다. 16진수로 보일 뿐이다.
  }
}

/** 내 이름 정하기. 이름표는 표준(kind 0)이라 damus·primal 에서도 보인다. */
async function talkSetName() {
  const now = tkNames.get(tkMine);
  const name = await ask(t("내 이름"), t("대화에서 이 이름으로 보입니다."), {
    value: String(now?.name || ""),
  });
  if (!name) return;
  const about = (await ask(t("한 줄 소개"), t("비워 두셔도 됩니다."), {
    value: String(now?.about || ""),
  })) || "";
  $("tk-note").textContent = t("올리는 중…");
  try {
    await invoke("talk_profile_set", { name, about, picture: String(now?.picture || "") });
    tkNames.set(tkMine, { name, about, picture: now?.picture || "" });
    $("tk-note").innerHTML = `<span class="ok">${t("이름을 정했습니다")}</span>`;
    void talkPaintMe();
    void talkPaint();
  } catch (e) {
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/** 읽는 사람 말로 바꿔 준다. 원문 아래에 붙인다 — 지우지 않는다. */
async function talkTranslate(id: string, list: any[]) {
  const note = document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
  const body = document.querySelector(`[data-say="${id}"]`) as HTMLElement | null;
  const ev = list.find((e) => String(e.id) === id);
  if (!note || !body || !ev) return;
  // 두 번 눌러도 두 번 붙지 않는다.
  if (body.querySelector(".tr")) return;
  note.textContent = t("옮기는 중…");
  try {
    // 🔴 화면이 직접 부르면 **CORS 로 막힌다.** 앱의 출처는
    //    `tauri://localhost` 라, 브라우저가 rvn.ex.erci.se 로 나가는 것을
    //    거절하고 화면에는 `TypeError: Load failed` 라는 뜻 모를 글자만 뜬다.
    //    실제로 그렇게 났다. 러스트에는 그 규칙이 없다 —
    //    화면은 부탁하고 나가는 일은 노드가 한다(`nostrpub.rs` 와 같은 길).
    const j = await invoke<any>("talk_translate", {
      text: String(ev.content || ""),
      to: lang,
    });
    if (!j?.translation) throw new Error("옮기지 못했습니다");
    // 모양은 `.tr` 이 정한다. 여기서 또 적으면 저절로 옮긴 글과 다르게 보인다.
    body.insertAdjacentHTML("beforeend", `<div class="tr">${escapeHtml(String(j.translation))}</div>`);
    // 🔴 **손으로 옮긴 것도 같은 자리에 기억한다.** 두 길이 따로 기억하면
    //    다시 그릴 때 저절로 옮기기가 같은 글을 또 부른다 — 값을 두 번 낸다.
    tk옮긴것.set(id, String(j.translation));
    body.dataset.trDone = "1";
    note.textContent = "";
  } catch (e) {
    note.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/**
 * 지우기 싫은 글을 파일창고에 굳힌다. 여기서부터가 우리만 하는 일이다.
 *
 * ## 🔴 남의 글이면 **먼저 여쭙는다**
 *
 * 이 단추는 조건 없이 **모든 글**에 붙는다. 옆의 「안 보기」는 남의 글에만,
 * 「지우기 요청」은 내 글에만 붙는데 이것만 안 가렸다.
 *
 * 그런데 하는 일은 「간직」이라는 말보다 크다 — 그 글이 파일창고에 올라가고
 * **릴레이가 지워도 남는다.** 주소를 아는 누구나 볼 수 있고,
 * **쓴 사람은 이 일을 모른다.** 남의 말을 영구히 박제하는 일이다.
 *
 * ⚠️ **막지는 않는다.** 그 글은 이미 세계 릴레이에 공개돼 있고, 누구나
 *    받아다 자기 창고에 넣을 수 있다. 단추를 없애면 우리 화면만 못 하게
 *    되고 실제로는 아무것도 안 막힌다 — 지키는 척이 제일 나쁘다.
 *
 * 그래서 **막는 대신 말한다.** 무슨 일이 일어나는지 알고 누르게 한다.
 * 「신뢰를 저해하는 행위는 용납하지 않는다」가 이 자리에서 뜻하는 것은
 * 금지가 아니라 **모르고 하지 않게 하는 것**이다.
 */
async function talkKeep(id: string, list: any[]) {
  const note = document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
  const ev = list.find((e) => String(e.id) === id);
  if (!note || !ev) return;
  // 내 글은 그냥 굳힌다. 내 말을 내가 보관하는 것은 물어볼 일이 아니다.
  const 남의글 = String(ev.pubkey || "") !== tkMine;
  if (남의글) {
    const ok = await sure(
      t("남이 쓴 글을 굳힐까요?"),
      // ⚠️ 「릴레이가 지워도 남습니다」도 과장이었다 — 남는 곳은
      //    **이 컴퓨터**다. 그 조건을 빼고 말하면 또 다른 거짓말이 된다.
      t("이 컴퓨터의 파일창고에 사본이 생깁니다. 주소를 아는 누구나 볼 수 있고, 쓰신 분은 이 일을 모릅니다."),
      t("굳힙니다"),
    );
    if (!ok) return;
  }
  note.textContent = t("굳히는 중…");
  try {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(ev)));
    const added = await invoke<any>("ipfs_add_file", {
      file: { name: `talk-${id.slice(0, 12)}.json`, bytes },
    });
    note.innerHTML =
      // 🔴 「굳혔습니다」는 **영구 보관으로 읽힌다**(그록 검증 2026-08-30).
      //    사실은 「이 컴퓨터의 파일창고에 핀으로 박아 두었다」다.
      //    핀이라 이 컴퓨터에서는 안 지워지지만, **밖에서 보려면 이
      //    컴퓨터가 켜져 있어야 한다.** 다른 사람이 받아 갔는지 확인하는
      //    코드는 이 길에 한 줄도 없다.
      //    겁주는 말 대신 **할 일 둘**만 남긴다: 주소를 적을 것, 켜 둘 것.
      `<span class="ok">${t("이 컴퓨터에 두었습니다")} — <code class="addr">${escapeHtml(String(added.cid))}</code></span>` +
      `<span class="meta"> ${t("주소를 적어 두시고, 다른 분이 보시려면 이 컴퓨터를 켜 두세요.")}</span>`;
  } catch (e) {
    note.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/* ── 사진 보내기 ───────────────────────────────────────────────────
   러스트(`talk_photo_post`)가 다 만들어 놓았는데 **부르는 자리가 없었다.**
   이 앱이 여러 번 걸린 그 병이다 — 없는 기능과 안 부르는 기능은 사장에게
   똑같다.

   ## 사진이 오는 길은 둘뿐이다

   - **끌어다 놓기**: 러스트가 들고 있는 「방금 떨어뜨린 목록」에 있는 것만
     읽는다(`dropbox.rs`). 그래서 화면은 **경로만** 넘긴다 — 내용을 안 읽으니
     화면이 뚫려도 `wallet.dat` 을 지목할 수가 없다.
   - **「사진」 단추**: 브라우저 파일 고르기가 읽어 준 내용을 그대로 넘긴다.
     애초에 경로가 아니라 내용이라 남의 파일을 가리킬 수가 없다.

   ## 🔴 고르자마자 보내지 않는다

   사진만 덜렁 가는 것이 아니라 「이거 얼마예요」가 같이 가야 한다. 그래서
   고른 사진은 입력칸 위에서 **기다리고**, 「보내기」를 눌러야 글과 함께
   나간다. 잘못 고른 것은 「취소」로 무른다. */

/** 보내려고 골라 둔 사진. 둘 중 하나만 채워진다 — 경로(떨어뜨림)나 내용(고름). */
type TkPhoto = {
  name: string;
  size: number;
  /** 창에 떨어뜨린 파일의 경로. 러스트가 목록과 대조한다. */
  path?: string;
  /** 파일 고르기로 읽은 내용. */
  bytes?: number[];
  /** 미리보기 주소(`blob:`). 떨어뜨린 것은 내용을 안 읽으므로 없다. */
  preview?: string;
};
let tkPhoto: TkPhoto | null = null;
/** 보내는 중에 「몇 초째」를 세는 시계. 멈추면 반드시 끈다. */
let tkPhotoTick: number | undefined;

/** 「2.4MB」·「180KB」. 사람이 읽는 크기 — 바이트 숫자는 아무 말도 안 한다. */
function tkSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/** 고른 사진을 입력칸 위에 세워 둔다. 아직 안 보낸다. */
function tkStagePhoto(p: TkPhoto) {
  // 앞서 고른 것이 있으면 미리보기 주소를 놓아준다. 안 놓으면 고를 때마다
  // 이 창이 사진 하나씩을 계속 물고 있는다.
  if (tkPhoto?.preview) URL.revokeObjectURL(tkPhoto.preview);
  tkPhoto = p;
  const img = $("tk-photoprev") as HTMLImageElement;
  if (p.preview) {
    img.src = p.preview;
    img.hidden = false;
  } else {
    // 🔴 떨어뜨린 사진은 **내용을 안 읽었으므로 미리 못 보여 준다.**
    //    있는 척 회색 네모를 그리지 않는다. 이름으로 확인하게 한다.
    img.removeAttribute("src");
    img.hidden = true;
  }
  $("tk-photoname").textContent = p.name;
  $("tk-photometa").textContent = p.size
    ? `${tkSize(p.size)} · ${t("「보내기」를 누르면 글과 함께 나갑니다")}`
    : t("「보내기」를 누르면 글과 함께 나갑니다");
  $("tk-photoprog").hidden = true;
  $("tk-photobox").hidden = false;
  ($("tk-text") as HTMLTextAreaElement).focus();
}

/** 골라 둔 사진을 무른다. */
function tkClearPhoto() {
  if (tkPhoto?.preview) URL.revokeObjectURL(tkPhoto.preview);
  tkPhoto = null;
  $("tk-photobox").hidden = true;
  $("tk-photoprog").hidden = true;
  ($("tk-photoprev") as HTMLImageElement).removeAttribute("src");
}

/**
 * 「사진」 단추. 파일 고르기를 연다.
 *
 * ⚠️ 여기서는 크기·종류를 안 막는다. 막는 자리는 러스트 하나뿐이어야 한다
 *    (`photo_kind`) — 두 곳에 두면 한쪽만 고치는 날이 오고, 그때 화면과
 *    러스트가 서로 다른 말을 한다. 대신 러스트의 오류 문구가 「무엇을 하면
 *    되는지」까지 적어 두었으니 그대로 띄운다.
 */
function talkPickPhoto() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      tkStagePhoto({
        name: file.name,
        size: file.size,
        bytes,
        preview: URL.createObjectURL(file),
      });
    } catch (e) {
      $("tk-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  };
  input.click();
}

/**
 * 러스트가 준 `say` 를 **그대로** 띄운다.
 *
 * 🔴 여기서 문장을 고쳐 쓰지 않는다. 「보냈습니다」로 줄이면 그게 거짓말이다 —
 *    올린 사진은 처음에 이 컴퓨터 한 곳에만 있고, 사본이 생기기 전에 컴퓨터를
 *    끄면 상대 화면에서 안 뜬다. 그 사실이 저 문장 안에 들어 있다.
 *    스스로 사라지지도 않는다. 읽고 닫아야 한다.
 */
function tkSaid(msg: string) {
  if (!msg) return;
  $("tk-saidtext").textContent = msg;
  $("tk-said").hidden = false;
}

/**
 * **보내는 순간 내 말풍선을 붙인다.**
 *
 * 🔴 자문 지적(2026-08-30): "카톡은 누르는 순간 내 말풍선이 생긴다.
 *    이 앱은 1.2초 뒤에 목록을 통째로 갈아끼운다."
 *
 * 그 1.2초가 「이거 갔나?」다. 그동안 화면은 아무 일도 없었고, 그래서
 * 한 번 더 누르는 사람이 생긴다. 릴레이는 세계에 흩어져 있어서 실제로
 * 더 걸릴 수도 있다 — 기다림을 없앨 수는 없으니 **기다림을 보이게** 한다.
 *
 * ⚠️ 다 간 것처럼 그리지 않는다. 흐리게(`.pending`) 그려 두고, 노드가
 *    받았다고 답해야 또렷해진다. **못 갔으면 지우고 글을 입력칸에 돌려준다** —
 *    안 간 말이 간 것처럼 남아 있는 것이 이 화면에서 가장 나쁜 거짓말이다.
 */
function tk임시풍선(text: string): HTMLElement | null {
  const box = document.getElementById("tk-list");
  if (!box) return null;
  const wrap = document.createElement("div");
  wrap.className = "line me pending";
  wrap.innerHTML =
    `<div class="bub me">${escapeHtml(text)}</div>` +
    `<time class="tstamp">${escapeHtml(t("보내는 중"))}</time>`;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

async function talkSend() {
  const box = $("tk-text") as HTMLTextAreaElement;
  const text = box.value.trim();
  // 사진이 걸려 있으면 글이 비어도 보낸다 — 사진 한 장이 곧 본문인 나이대다.
  if (!text && !tkPhoto) return;
  if (tkPhoto) return void talkSendPhoto(text);
  // 누른 즉시 붙는다. 입력칸도 즉시 비운다 — 그래야 다음 말을 바로 친다.
  const 임시 = tk임시풍선(text);
  box.value = "";
  box.style.height = "auto";
  $("tk-note").textContent = "";
  try {
    await invoke("talk_post", { text, room: tkRoom || null });
    // 또렷해진다. 「올렸습니다」 같은 알림은 안 띄운다 — 풍선이 곧 답이다.
    임시?.classList.remove("pending");
    const 시각 = 임시?.querySelector(".tstamp");
    if (시각) 시각.textContent = tkClock(Date.now());
    // 🔴 두 번 다시 그린다. 릴레이가 느리면 1.2초에는 아직 안 돌아와서
    //    붙여 둔 풍선만 사라진다 — 방금 쓴 말이 눈앞에서 없어지는 셈이다.
    setTimeout(() => void talkPaint(), 1200);
    setTimeout(() => void talkPaint(), 4000);
  } catch (e) {
    // 🔴 못 갔으면 지운다. 그리고 **글을 돌려준다** — 다시 치게 만들지 않는다.
    임시?.remove();
    box.value = text;
    box.style.height = "auto";
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/**
 * 골라 둔 사진을 실제로 올린다.
 *
 * ## ⚠️ 여기가 이 화면에서 제일 오래 걸리는 자리다
 *
 * 8MB 사진은 집 인터넷에서 십수 초~1분이 걸린다. 그동안 아무 표시가 없으면
 * 사장은 **멈춘 줄 알고 한 번 더 누른다** — 그러면 같은 사진이 두 번 올라간다.
 *
 * 그래서 세 가지를 한다:
 *   ① 「보내기」와 「사진」·「취소」를 잠근다. 두 번 누를 길을 없앤다.
 *   ② 도는 막대 + **몇 초째인지 숫자**. 막대만 돌면 멈춘 것과 구별이 안 된다.
 *   ③ 오래 걸릴 것을 **미리** 말한다. 예고한 느림은 고장이 아니다.
 *
 * 🔴 진짜 퍼센트는 못 보여 준다. 러스트 명령은 한 번에 갔다 오고, 파일창고에
 *    얼마나 들어갔는지 중간에 알려주지 않는다. **없는 퍼센트를 지어내지
 *    않는다** — 30%에서 멈춰 있는 막대가 제일 나쁜 거짓말이다.
 */
async function talkSendPhoto(text: string) {
  const p = tkPhoto;
  if (!p) return;
  const box = $("tk-text") as HTMLTextAreaElement;
  const send = $("tk-send") as HTMLButtonElement;
  const pick = $("tk-photo") as HTMLButtonElement;
  const cancel = $("tk-photocancel") as HTMLButtonElement;
  const prog = $("tk-photoprog");

  send.disabled = pick.disabled = cancel.disabled = true;
  $("tk-note").textContent = "";
  prog.hidden = false;

  const 시작 = Date.now();
  const 오래 = p.size > 2 * 1024 * 1024;
  const 그리기 = () => {
    const 초 = Math.floor((Date.now() - 시작) / 1000);
    prog.innerHTML =
      `<b>${t("사진을 보내는 중…")} ${초}${t("초")}</b>` +
      (오래
        ? `<br /><span class="pbmeta">${t("큰 사진은 1분까지 걸립니다. 창을 닫지 마세요.")}</span>`
        : "") +
      `<div class="photobar"><i></i></div>`;
  };
  그리기();
  clearInterval(tkPhotoTick);
  tkPhotoTick = window.setInterval(그리기, 1000);

  // ⚠️ 8MB 짜리 내용을 러스트로 넘기려면 화면이 그것을 한 번 통째로 옮겨
  //    적어야 하고, 그 몇 초 동안 화면은 아무것도 못 그린다. **먼저 그리고**
  //    넘긴다 — 안 그러면 「보내는 중」이 뜨기도 전에 창이 굳는다.
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  try {
    // 🔴 `path` 와 `bytes` 중 **하나만** 넘긴다. 러스트가 `path` 를 먼저 보므로
    //    둘 다 넘기면 내용이 조용히 무시된다.
    const r = await invoke<any>("talk_photo_post", {
      path: p.path ?? null,
      name: p.path ? null : p.name,
      bytes: p.path ? null : (p.bytes ?? null),
      text,
      room: tkRoom || null,
      replyTo: null,
      replyPub: null,
    });
    box.value = "";
    box.style.height = "auto";
    tkClearPhoto();
    // 🔴 응답의 `say` 를 **그대로.** 여기서 요약하면 경고가 사라진다.
    tkSaid(String(r?.say || ""));
    setTimeout(() => void talkPaint(), 1200);
  } catch (e) {
    // 러스트의 오류 문구는 「무엇을 하면 되는지」까지 적혀 있다(파일창고를
    // 켜세요·크기를 줄이세요…). 줄이지 말고 그대로 띄운다.
    // ⚠️ 고른 사진은 **안 지운다.** 파일창고를 켜고 그대로 다시 누를 수 있어야
    //    한다 — 실패했다고 고른 것까지 뺏으면 처음부터 다시다.
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  } finally {
    clearInterval(tkPhotoTick);
    tkPhotoTick = undefined;
    prog.hidden = true;
    send.disabled = pick.disabled = cancel.disabled = false;
  }
}

/**
 * 「쪽지」 — 지갑 화면을 인터넷 창에 연다.
 *
 * ## 🔴 왜 이 창이 아니라 저기인가
 *
 * 1:1 암호 쪽지(NIP-17)는 **지갑 화면에만** 있다. 지갑의 12단어에서 나온
 * 열쇠로 서명하고 풀기 때문이다. 이 창에는 그 12단어가 없다 — 그리고 없는
 * 편이 맞다. 12단어를 들고 있는 화면은 `connect-src 'self'` 로 바깥 통로를
 * 막아 두었고, 우리 창이 그 화면을 품으면 그 잠금이 무의미해진다.
 *
 * ## ⚠️ 서버를 먼저 켠다
 *
 * 그 화면은 이 컴퓨터의 손님 서버(`127.0.0.1:8790`)가 내준다. 안 켜져 있으면
 * 인터넷 창에 「연결할 수 없음」만 뜨는데, 그건 사장에게 아무것도 안 알려
 * 준다. 이미 켜져 있으면 그대로 쓴다.
 */
async function talkOpenDm() {
  const say = $("tk-dmsay");
  const go = $("tk-dmgo") as HTMLButtonElement;
  go.disabled = true;
  say.textContent = t("여는 중…");
  try {
    // 20초를 넘기면 멈춘 이유를 말한다. 말없이 기다리게 두지 않는다.
    await Promise.race([
      invoke<any>("start_phone_server"),
      new Promise((_, no) =>
        setTimeout(() => no(new Error(t("20초 안에 열리지 않았습니다."))), 20000)),
    ]);
    await openUrl("http://127.0.0.1:8790/wallet");
    say.innerHTML =
      `<span class="ok">${t("인터넷 창에 쪽지 화면을 열었습니다.")}</span> ` +
      escapeHtml(t("12단어가 아직 없으면 그 화면이 먼저 만들라고 합니다."));
  } catch (e) {
    say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  } finally {
    go.disabled = false;
  }
}

/**
 * 방 만들기 — **한 자리에서 끝낸다.**
 *
 * ## 🔴 전에는 모달을 연달아 띄웠다
 *
 *     ask("방 이름") → ask("한 줄 설명") → (자산까지 넣으면 셋째)
 *
 * 「다음, 다음, 다음」은 40~70대에게 제일 나쁜 흐름이다. 중간에 무엇을
 * 적었는지 안 보이고, 되돌아갈 수도 없다. 세 칸을 한 화면에 둔다.
 *
 * ## ⚠️ 자산 목록은 **열 때 미리 받는다**
 *
 * 고르는 순간에 노드에 물으면 그 사이가 빈다. 사람은 그 빈틈을 「고장」으로
 * 읽는다. 열자마자 받아 두고, 아직 못 받았으면 그렇다고 적는다.
 */
async function talkNewRoom() {
  const box = $("tk-newbox");
  const open = box.hidden;
  box.hidden = !open;
  if (!open) return;
  (($("tk-nname") as HTMLInputElement).value = ""), (($("tk-nabout") as HTMLInputElement).value = "");
  $("tk-nsay").textContent = "";
  ($("tk-nname") as HTMLInputElement).focus();

  const sel = $("tk-nasset") as HTMLSelectElement;
  sel.innerHTML = `<option value="">${t("누구나 (자산 없이)")}</option>`;
  $("tk-nhint").textContent = t("자산 목록을 읽는 중…");
  try {
    const r = await invoke<any>("talk_my_assets");
    const list: string[] = r?.assets || [];
    sel.innerHTML =
      `<option value="">${t("누구나 (자산 없이)")}</option>` +
      list.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    // 🔴 **없는 것과 못 읽은 것을 가른다.** 노드가 장부를 훑는 중이면
    //    자산이 없는 게 아니라 아직 모르는 것이다.
    $("tk-nhint").textContent = r?.ok
      ? list.length
        ? t("고르시면 그 자산을 가진 분만 이 방에 글을 씁니다. 넘기면 그 순간 끊깁니다.")
        : t("가진 자산이 없습니다 — 누구나 들어오는 방이 됩니다.")
      : t("지금은 자산을 확인할 수 없습니다(노드가 따라잡는 중). 누구나 들어오는 방으로 만드실 수 있습니다.");
  } catch {
    $("tk-nhint").textContent = t("자산을 확인하지 못했습니다.");
  }
}

async function talkMakeRoomGo() {
  const name = ($("tk-nname") as HTMLInputElement).value.trim();
  if (!name) {
    $("tk-nsay").innerHTML = `<span class="danger">${t("방 이름을 적어 주세요")}</span>`;
    ($("tk-nname") as HTMLInputElement).focus();
    return;
  }
  const about = ($("tk-nabout") as HTMLInputElement).value.trim();
  const asset = ($("tk-nasset") as HTMLSelectElement).value || null;
  const b = $("tk-nmake") as HTMLButtonElement;
  b.disabled = true;
  // 누른 즉시 말한다. 아무 표시 없이 기다리게 두지 않는다.
  $("tk-nsay").textContent = t("만드는 중…");
  try {
    await invoke("talk_make_room", { name, about, asset });
    $("tk-newbox").hidden = true;
    await talkPaintRooms();
    $("tk-note").innerHTML = `<span class="ok">${t("방을 만들었습니다")}</span>`;
  } catch (e) {
    $("tk-nsay").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  } finally {
    b.disabled = false;
  }
}

/* ══ 팬클럽 ═══════════════════════════════════════════════════════════
   자산 화면(`#fanbox`)에 붙는다. **왜 거기인가는 index.html 의 주석**에
   길게 적어 두었다 — 한 줄로 줄이면: 러스트가 방이 아니라 **자산**을
   주어로 답하기 때문이다(`fan_rooms` 는 `listmyassets` 에서 시작한다).

   🔴 이 칸의 절반은 **못 하는 것을 그대로 옮기는 일**이다. 러스트가
      `say` · `caveat` · `limits` · `privacy` 로 정직하게 써 놓았고,
      여기서는 **한 자도 안 고치고** 붙인다. 요약하거나 「간단히」 다시
      쓰면 그 순간 거짓말이 된다 — 사장은 이 방을 비밀 단톡으로 알고
      「1년 회원권」을 팔겠다고 한다. 둘 다 이 구조로는 안 된다.        */

type FanRoom = { id?: string; name?: string; about?: string; created_at?: number };
type FanGroup = {
  asset: string;
  i_issued?: boolean;
  rooms?: FanRoom[];
  room_count?: number;
  need_room?: boolean;
};

/** 지금 화면에 있는 묶음. 다시 그릴 때 러스트를 또 부르지 않으려고 들고 있다. */
let fanGroups: FanGroup[] = [];
/** 한 번이라도 읽었나. 칸을 접었다 펼 때마다 노드를 두드리지 않는다. */
let fanLoaded = false;
/**
 * 고른 자산.
 *
 * ⚠️ 화면(체크박스)이 아니라 **여기**가 진짜 목록이다. 목록을 다시 그리면
 *    체크박스는 새로 만들어지므로, 화면만 믿으면 「팬 수 세기」 한 번에
 *    골라 둔 것이 전부 날아간다.
 */
const fanPicked = new Set<string>();
/**
 * 자산마다 「몇 분이 가졌나」로 그린 조각.
 *
 * 🔴 **안 물어본 것과 0곳은 다른 말이다.** 그래서 미리 0 을 채워 두지 않고,
 *    누른 자산만 여기 들어온다. 비어 있으면 화면에도 아무 말이 없다.
 */
const fanHolders = new Map<string, string>();

/**
 * 「못 하는 것」을 그린다. **러스트가 준 문장 그대로.**
 *
 * ⚠️ 아는 열쇠만 골라 쓰지 않고 `Object.values` 로 **전부** 돈다. 나중에
 *    러스트가 못 하는 것을 하나 더 적어 넣으면 이 화면이 저절로 그것도
 *    띄운다 — 여기에 열쇠 이름을 박아 두면 그날 조용히 하나가 빠진다.
 */
function fanPaintLimits(limits: unknown) {
  const rows =
    limits && typeof limits === "object"
      ? Object.values(limits as Record<string, unknown>)
          .filter((v) => typeof v === "string" && v.trim())
          .map(String)
      : [];
  // 못 받았으면 있던 말을 지우지 않는다. 빈 칸이 되면 「없다」로 읽힌다.
  if (!rows.length) return;
  $("fan-limits").innerHTML =
    `<b>${t("먼저 아셔야 할 것")}</b>` +
    rows.map((v) => `<p>${escapeHtml(v)}</p>`).join("");
}

/** 몇 개를 골랐는지 · 그게 몇 곳의 방인지. 보내기 전에 알아야 하는 숫자다. */
function fanPaintPicked() {
  const picked = fanGroups.filter((g) => fanPicked.has(g.asset));
  const rooms = picked.reduce((n, g) => n + (Number(g.room_count) || 0), 0);
  $("fan-picked").textContent = picked.length
    ? `${t("고른 자산")} ${picked.length} · ${t("보낼 방")} ${rooms}${t("곳")}`
    : t("아직 고른 자산이 없습니다.");
}

async function fanLoad(force = false) {
  if (fanLoaded && !force) return;
  const say = $("fan-say");
  say.textContent = t("불러오는 중…");
  let r: any;
  try {
    r = await invoke<any>("fan_rooms");
  } catch (e) {
    // 🔴 못 읽었으면 **읽었다고 치지 않는다.** 다음에 열 때 다시 시도한다.
    fanLoaded = false;
    say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    return;
  }
  fanLoaded = true;
  fanPaintLimits(r?.limits);
  // 🔴 러스트의 `say` 를 그대로. 「자산이 없습니다」와 「못 읽었습니다」를
  //    거기서 이미 갈라 말한다 — 우리가 다시 쓰면 그 구분이 사라진다.
  say.textContent = String(r?.say ?? "");
  fanGroups = Array.isArray(r?.groups) ? (r.groups as FanGroup[]) : [];
  // 목록에서 사라진 자산은 고른 것에서도 뺀다. 안 그러면 화면에 없는 것에
  // 보내겠다고 하고, 결과는 「방이 없습니다」만 돌아온다.
  for (const a of [...fanPicked]) if (!fanGroups.some((g) => g.asset === a)) fanPicked.delete(a);
  fanPaintGroups();
}

function fanPaintGroups() {
  const box = $("fan-groups");
  if (!fanGroups.length) {
    box.innerHTML = "";
    fanPaintPicked();
    return;
  }
  box.innerHTML = fanGroups
    .map((g) => {
      const a = String(g.asset ?? "");
      const key = escapeHtml(a);
      const rooms = Array.isArray(g.rooms) ? g.rooms : [];
      const need = !!g.need_room;
      // 🔴 **방이 필요 없는 자산에까지 방을 권하고 있었다**(대표님 지적).
      //
      //    지갑에는 내가 낸 음반뿐 아니라 **남에게서 받은 자산**도 들어 있다.
      //    거기에 「방 만들기」를 걸면, 남의 음반 팬클럽을 내가 여는 꼴이다.
      //    권하는 것은 **내가 낸 자산**에만 한다 — 팬 방은 낸 사람이 연다.
      //
      //    ⚠️ 막는 것은 아니다. 「이야기 → 방 만들기」에서는 어느 자산으로든
      //       열 수 있다. 여기서 **권하지 않을** 뿐이다.
      const 내가낸것 = !!g.i_issued;
      const 권함 = need && 내가낸것;
      return (
        `<div class="fangroup">
           <div class="fanrow">` +
        // 🔴 방이 없으면 **고를 수 없게** 한다. 골라 봐야 「이 자산으로 만든
        //    방이 없습니다」가 돌아올 뿐이고, 그건 실패 목록만 늘린다.
        //    대신 그 자리에서 방을 만들러 갈 수 있게 한다.
        (need
          ? `<span class="fanname" style="margin-right:auto;font-weight:600">${key}</span>`
          : `<label class="fanpick">
               <input type="checkbox" data-fanpick="${key}"${fanPicked.has(a) ? " checked" : ""} />
               <span>${key}</span></label>`) +
        // 내가 낸 자산인지. 「내가 낸 것」과 「내가 산 것」은 팬클럽에서 뜻이 다르다.
        (g.i_issued ? `<span class="tag">${t("내가 낸 자산")}</span>` : "") +
        `<button class="ghost" data-fanwho="${key}">${t("팬 수 세기")}</button>` +
        (권함 ? `<button class="ghost" data-fanroom="${key}">${t("방 만들기")}</button>` : "") +
        `</div>` +
        (권함
          ? `<p class="fanrooms">${t("아직 방이 없습니다. 「방 만들기」를 누르면 「이야기」로 가고, 이 자산이 골라져 있습니다.")}</p>`
          : need
          ? // 🔴 「방이 없습니다」로 끝내지 않는다. 그러면 고장으로 읽힌다.
            //    왜 여기서 안 권하는지, 그래도 열 수 있는 길이 어디인지 적는다.
            `<p class="fanrooms">${t("제가 낸 자산이 아닙니다 — 팬 방은 낸 분이 엽니다. 그래도 여시려면 「이야기 → 방 만들기」에서 이 자산을 고르세요.")}</p>`
          : `<p class="fanrooms">${t("방")} ${rooms.length}${t("곳")} — ` +
            rooms
              .map((r) => escapeHtml(String(r?.name ?? t("이름 없는 방"))))
              .join(" · ") +
            `</p>`) +
        // 「몇 분이 가졌나」는 누른 자산에만 있다. 안 누른 자산은 조용하다.
        `<div class="fanwho" data-fanwhobox="${key}">${fanHolders.get(a) ?? ""}</div>` +
        `</div>`
      );
    })
    .join("");

  box.querySelectorAll<HTMLInputElement>("[data-fanpick]").forEach((c) => {
    c.onchange = () => {
      const a = String(c.dataset.fanpick || "");
      if (c.checked) fanPicked.add(a);
      else fanPicked.delete(a);
      fanPaintPicked();
    };
  });
  box.querySelectorAll<HTMLButtonElement>("[data-fanwho]").forEach((b) => {
    b.onclick = () => void fanCount(String(b.dataset.fanwho || ""), b);
  });
  box.querySelectorAll<HTMLButtonElement>("[data-fanroom]").forEach((b) => {
    b.onclick = () => void fanMakeRoom(String(b.dataset.fanroom || ""));
  });
  fanPaintPicked();
}

/**
 * **몇 분이 가졌나.** 숫자 하나뿐이다.
 *
 * 🔴 주소 목록은 **애초에 안 온다**(러스트가 노드에 개수만 달라고 묻고,
 *    옛 노드가 목록으로 답해도 거기서 세고 버린다). 그러니 화면이 할 일은
 *    숫자 옆에 `caveat` 와 `privacy` 를 **그대로 붙이는 것**이다. 숫자만
 *    적어 두면 사장은 그걸 「팬 82명」으로 읽는데, 그건 사실이 아니다 —
 *    주소의 개수지 사람의 수가 아니다.
 */
async function fanCount(asset: string, btn: HTMLButtonElement) {
  const box = $("fan-groups").querySelector<HTMLElement>(
    `[data-fanwhobox="${CSS.escape(asset)}"]`,
  );
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("세는 중…");
  try {
    const r = await invoke<any>("fan_holders", { asset });
    // 🔴 못 센 것은 **빨간 글씨가 아니다.** 팬 수는 있으면 좋은 숫자지
    //    팬클럽을 쓰는 조건이 아니다 — 공지를 보내는 데는 안 쓰인다.
    //    러스트가 `counted:false` 로 갈라 말해 준다.
    const html =
      `<b>${escapeHtml(String(r?.say ?? ""))}</b>` +
      (r?.why ? `<p class="meta">${escapeHtml(String(r.why))}</p>` : "") +
      (r?.ok_without ? `<p class="meta">${escapeHtml(String(r.ok_without))}</p>` : "") +
      (r?.caveat ? `<p class="meta">${escapeHtml(String(r.caveat))}</p>` : "") +
      (r?.privacy ? `<p class="meta">${escapeHtml(String(r.privacy))}</p>` : "");
    fanHolders.set(asset, html);
    if (box) box.innerHTML = html;
    // 색인이 꺼져 있으면 러스트가 「켜세요」까지 적어서 오류로 돌려준다.
    fanPaintLimits(r?.limits);
  } catch (e) {
    const html = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    fanHolders.set(asset, html);
    if (box) box.innerHTML = html;
  } finally {
    btn.disabled = false;
    btn.textContent = wasLabel;
  }
}

/**
 * **「이야기 → 방 만들기」로 데려가고 자산까지 골라 놓는다.**
 *
 * 🔴 여기서 방을 만들지 않는다. 같은 일을 두 곳에 두면 어느 쪽이 진짜인지
 *    매번 고민하게 되고, 고치는 사람은 한쪽만 고친다. 러스트의 안내문도
 *    「이야기 → 방 만들기」로 보낸다 — 화면이 그 말과 어긋나면 안 된다.
 */
async function fanMakeRoom(asset: string) {
  showPage("talk");
  // `talkNewRoom` 은 **토글**이다. 이미 펼쳐져 있으면 접어 버린다 —
  // 그러면 방을 만들러 왔는데 칸이 닫힌다. 먼저 접어 두고 부른다.
  $("tk-newbox").hidden = true;
  // 자산 목록을 다 받을 때까지 기다린다. 안 기다리면 아래에서 고를 것이 없다.
  await talkNewRoom();
  const sel = $("tk-nasset") as HTMLSelectElement;
  const want = asset.trim().toUpperCase();
  const hit = [...sel.options].find((o) => o.value.trim().toUpperCase() === want);
  if (hit) {
    sel.value = hit.value;
    // 이름을 미리 적어 둔다. 빈 칸으로 두면 「방 이름을 적어 주세요」에서 막힌다.
    ($("tk-nname") as HTMLInputElement).value = `${asset} ${t("팬 방")}`;
    ($("tk-nname") as HTMLInputElement).select();
  } else {
    // 🔴 **못 골랐으면 못 골랐다고 말한다.** 조용히 「누구나」로 두면
    //    사장은 자산 방을 만든 줄 알고 아무나 쓸 수 있는 방을 만든다.
    $("tk-nsay").innerHTML =
      `<span class="danger">${escapeHtml(asset)} ${t("을(를) 자산 목록에서 못 찾았습니다. 노드가 장부를 훑는 중일 수 있습니다 — 자산 칸을 직접 확인해 주세요.")}</span>`;
  }
  $("tk-newbox").scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 보낸 곳과 **못 간 곳**을 그린다. */
function fanPaintResult(r: any) {
  const sent: any[] = Array.isArray(r?.sent) ? r.sent : [];
  const failed: any[] = Array.isArray(r?.failed) ? r.failed : [];
  const where = (x: any) =>
    escapeHtml(String(x?.room_name ?? x?.room ?? "")) || t("방을 못 찾았습니다");
  $("fan-result").innerHTML =
    `<div class="card" style="margin-top:12px">` +
    // 러스트가 쓴 한 줄. 몇 곳에 가고 몇 곳에 못 갔는지가 여기 들어 있다.
    `<p style="margin:0;font-size:15px">${escapeHtml(String(r?.say ?? ""))}</p>` +
    (sent.length
      ? `<h3 class="grouphead">${t("간 곳")} ${sent.length}${t("곳")}</h3>` +
        sent
          .map(
            (x) =>
              `<div class="kv"><b>${escapeHtml(String(x?.asset ?? ""))}</b><span>${where(x)}</span></div>`,
          )
          .join("")
      : "") +
    // 🔴 **못 간 곳은 접지 않는다.** 어디에 못 갔는지 모르면 사장은 갔다고
    //    믿는다. 이유까지 한 줄씩 적는다 — 이유를 봐야 다시 보낼지,
    //    방을 먼저 만들지 판단이 선다.
    (failed.length
      ? `<div class="fanfail">
           <b class="danger">${t("못 간 곳")} ${failed.length}${t("곳")}</b>` +
        failed
          .map(
            (x) =>
              `<div class="kv" style="margin-top:8px"><b>${escapeHtml(String(x?.asset ?? ""))}</b>` +
              `<span>${where(x)}<br /><span class="danger">${escapeHtml(String(x?.why ?? ""))}</span></span></div>`,
          )
          .join("") +
        `</div>`
      : "") +
    // 「보냈습니다」로 끝내지 않는다. 릴레이 한 곳만 받아도 성공으로 친다.
    (r?.caveat ? `<p class="meta">${escapeHtml(String(r.caveat))}</p>` : "") +
    `</div>`;
}

async function fanSend() {
  const assets = [...fanPicked];
  const text = ($("fan-text") as HTMLTextAreaElement).value.trim();
  const link = ($("fan-link") as HTMLInputElement).value.trim();
  const res = $("fan-result");
  if (!assets.length) {
    res.innerHTML = `<p class="meta"><span class="danger">${t("어느 자산의 방에 보낼지 골라 주세요.")}</span></p>`;
    return;
  }
  if (!text) {
    res.innerHTML = `<p class="meta"><span class="danger">${t("보낼 내용이 없습니다.")}</span></p>`;
    ($("fan-text") as HTMLTextAreaElement).focus();
    return;
  }
  const rooms = fanGroups
    .filter((g) => fanPicked.has(g.asset))
    .reduce((n, g) => n + (Number(g.room_count) || 0), 0);
  // 🔴 릴레이에 올린 글은 **못 거둔다.** 몇 곳에 가는지 세어 보여 주고,
  //    「자산이 없는 분도 읽습니다」를 여기서 한 번 더 말한다 — 위쪽
  //    「못 하는 것」을 안 읽고 내려온 사람이 마지막으로 걸리는 자리다.
  const okGo = await sure(
    t("이 글을 보낼까요?"),
    `${t("자산")} ${assets.length} · ${t("방")} ${rooms}${t("곳")}${t("에 갑니다. 올린 글은 되돌릴 수 없고, 자산이 없는 분도 읽을 수 있습니다.")}`,
    t("보내기"),
  );
  if (!okGo) return;

  const b = $("fan-send") as HTMLButtonElement;
  b.disabled = true;
  res.innerHTML = `<p class="meta">${t("보내는 중…")}</p>`;
  try {
    // 링크는 안 적었으면 `null`. 빈 문자열도 러스트가 받지만, 「안 넣었다」를
    // 값으로 말하는 쪽이 정직하다.
    const r = await invoke<any>("fan_announce", { assets, text, link: link || null });
    fanPaintLimits(r?.limits);
    fanPaintResult(r);
    // 🔴 글칸은 **안 지운다.** 못 간 곳이 있으면 그 글을 그대로 다시
    //    보내야 하는데, 지워 버리면 사장이 다시 쳐야 한다.
  } catch (e) {
    // 러스트가 통째로 막은 경우다(링크가 이상하거나, 글이 너무 길거나,
    // 방 목록을 못 읽었거나). 그때는 **아무 곳에도 안 갔다.**
    res.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(errText(e))}</div>`;
  } finally {
    b.disabled = false;
  }
}

/**
 * **손님을 받기까지 무엇이 남았나.**
 *
 * ## 🔴 왜 이 칸이 생겼나
 *
 * 대표님: "출입도 내 가게에서 하는 일 아닌가? 내 가게가 헬스장일지 술집일지
 *          모르는 거잖아. 내 가게 안에 구현되어야 하는 게 아닌가."
 *
 * 맞다. 헬스장을 열려면 **「자산」 → 「내 가게」 → 「출입」** 세 화면을 돌아야
 * 하는데, 그 순서를 아는 사람은 이 코드를 쓴 사람뿐이었다.
 *
 * ⚠️ **지금 할 것 하나만 도드라지게 한다.** 셋을 나란히 놓으면 어느 것부터
 *    인지 모른다. 나머지는 옅게 둔다.
 */
/** 라비가 「지금 무엇을 해야 하는지」 알 수 있게 들고 있는다. */
export let setupState: any = null;

async function paintFlow() {
  const host = document.getElementById("sh-flow");
  if (!host) return;
  let d: any;
  try {
    d = await invoke<any>("shop_setup");
  } catch {
    host.innerHTML = "";
    return;
  }
  setupState = d;
  if (d?.ready) {
    host.innerHTML = `<p class="meta" style="margin:0 0 10px">${t(
      "손님 받을 준비가 됐습니다."
    )}</p>`;
    return;
  }
  const icon = (st: string) =>
    st === "done" ? "✓" : st === "unknown" ? "?" : "·";
  host.innerHTML = `<div class="card" style="margin:0 0 14px">
      <h3>${t("손님을 받으시려면")}</h3>
      ${(d?.steps || [])
        .map((s: any, i: number) => {
          const now = s.key === d.next;
          const done = s.state === "done";
          return `<div style="display:flex;gap:10px;align-items:flex-start;
                    padding:8px 0;opacity:${now || done ? 1 : 0.55}">
              <b style="min-width:20px;color:${done ? "var(--ok)" : "var(--accent)"}">${
                done ? icon(s.state) : i + 1
              }</b>
              <div style="flex:1;min-width:0">
                <b>${escapeHtml(t(s.title))}</b>
                <p class="meta" style="margin:2px 0 0">${escapeHtml(t(s.why))}</p>
                <p class="meta" style="margin:2px 0 0;opacity:.8">${escapeHtml(String(s.note || ""))}</p>
              </div>
              ${
                done
                  ? ""
                  : `<button class="${now ? "" : "ghost"}" data-flow="${escapeHtml(String(s.go))}"
                     data-flow-key="${escapeHtml(String(s.key))}"
                       style="flex-shrink:0">${t(now ? "지금 하기" : "가기")}</button>`
              }
            </div>`;
        })
        .join("")}
    </div>`;
  host.querySelectorAll("[data-flow]").forEach((b) => {
    // 🔴 그냥 `showPage` 만 하면 **화면만 툭 바뀐다.** 대표님: "내 가게 가면
    //    뭘 어떻게 하는 건지 모르겠어." 데려다 놓고 아무 말도 안 하니 그렇다.
    //    라비가 데려갈 때와 같은 대접을 한다 — 어디로 왔는지 말하고,
    //    지금 손댈 칸을 빛나게 한다.
    (b as HTMLElement).onclick = () => {
      const key = String((b as HTMLElement).dataset.flowKey || "");
      const 곳: Record<string, { el: string; say: string }> = {
        asset: {
          el: "sh-ko",
          say: "여기에 가게 이름을 적고 아래 「가게 등록」을 누르시면 됩니다. 한 번만 하면 됩니다.",
        },
        shop: {
          el: "sh-ko",
          say: "가게 이름·사진·파는 것을 적어 올리면 손님이 폰으로 봅니다.",
        },
        door: {
          el: "dr-doors",
          say: "회원권을 가진 분이 스스로 들어오게 하는 문입니다. 헬스장·스터디카페에만 필요합니다.",
        },
      };
      const 안내 = 곳[key];
      const page = (b as HTMLElement).dataset.flow!;
      if (안내) raviPoint({ page, el: 안내.el, say: 안내.say });
      else showPage(page);
    };
  });
}

/* ── 맞교환 ───────────────────────────────────────────────────
   🔴 러스트(`swap.rs`)에 다 만들어 놓고 **부르는 줄을 안 만들면** 오늘
   하루 종일 고친 그 병이 그대로 반복된다. 여기가 그 줄이다.        */

/** 팔 준비가 됐는지 물어보고, 안 됐으면 무엇을 해야 하는지 적는다. */
async function swapReady() {
  const asset = ($("sw-asset") as HTMLInputElement).value.trim();
  const amount = parseFloat(($("sw-amt") as HTMLInputElement).value) || 0;
  const note = $("sw-ready");
  const lot = $("sw-lot") as HTMLButtonElement;
  if (!asset || amount <= 0) { note.textContent = ""; lot.style.display = "none"; return; }
  try {
    const r = await invoke<any>("swap_ready", { asset, amount });
    if (r.ready) {
      note.innerHTML = `<span class="ok">${t("팔 준비가 됐습니다")} — ${t("가진 것")} ${Number(r.have).toLocaleString()}</span>`;
      lot.style.display = "none";
    } else {
      note.innerHTML = `<span class="warn">${escapeHtml(String(r.why || ""))}</span>`;
      lot.style.display = "";
    }
  } catch (e) {
    note.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

async function swapMakeLot() {
  const asset = ($("sw-asset") as HTMLInputElement).value.trim();
  const amount = parseFloat(($("sw-amt") as HTMLInputElement).value) || 0;
  if (!(await ensureUnlocked("묶음을 만들려면 지갑을 열어야 합니다."))) return;
  try {
    const r = await invoke<any>("swap_make_lot", { asset, amount, passphrase: null });
    $("sw-ready").innerHTML = r.already
      ? `<span class="ok">${t("이미 준비돼 있습니다")}</span>`
      : `<span class="ok">${escapeHtml(String(r.note || ""))}</span>`;
  } catch (e) {
    $("sw-ready").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

async function swapMakeOffer() {
  const asset = ($("sw-asset") as HTMLInputElement).value.trim();
  const amount = parseFloat(($("sw-amt") as HTMLInputElement).value) || 0;
  const price = parseFloat(($("sw-price") as HTMLInputElement).value) || 0;
  const box = $("sw-offer");
  if (!(await ensureUnlocked("제안에 서명하려면 지갑을 열어야 합니다."))) return;
  box.innerHTML = `<p class="meta">${t("만드는 중…")}</p>`;
  try {
    const r = await invoke<any>("swap_offer", { asset, amount, price, passphrase: null });
    box.innerHTML =
      `<div class="card" style="margin-top:12px">
         <h3>${t("제안을 만들었습니다")}</h3>
         <div class="kv"><b>${t("파는 것")}</b><span>${escapeHtml(asset)} ${amount.toLocaleString()}${t("개")}</span></div>
         <div class="kv"><b>${t("받을 돈")}</b><span>${price.toLocaleString()} RVN</span></div>
         <p class="meta">🔴 ${t("이 글자만으로는 아무 일도 안 일어납니다. 사는 사람이 RVN 을 붙여야 거래가 됩니다 — 그래서 아무 데나 보내셔도 됩니다.")}</p>
         <textarea readonly rows="3" id="sw-out">${escapeHtml(String(r.hex))}</textarea>
         <div class="row" style="margin-top:10px">
           <button class="ghost" id="sw-copy">${t("글자 복사")}</button>
           <span class="meta" id="sw-copied"></span>
         </div>
       </div>`;
    $("sw-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(String(r.hex)).catch(() => {});
      $("sw-copied").textContent = t("복사했습니다");
    });
  } catch (e) {
    box.innerHTML = `<p class="meta danger">${escapeHtml(errText(e))}</p>`;
  }
}

/** 받은 제안이 진짜인지 **체인에 물어서** 보여 준다. 글자를 믿지 않는다. */
async function swapLook() {
  const hex = ($("sw-hex") as HTMLTextAreaElement).value.trim();
  const box = $("sw-take");
  if (!hex) return;
  box.innerHTML = `<p class="meta">${t("체인에 물어보는 중…")}</p>`;
  try {
    const r = await invoke<any>("swap_check", { hex });
    if (!r.ok) {
      box.innerHTML = `<p class="meta danger">${escapeHtml(String(r.why))}</p>`;
      return;
    }
    box.innerHTML =
      `<div class="card" style="margin-top:12px">
         <div class="kv"><b>${t("받는 것")}</b><span>${escapeHtml(String(r.asset))} ${Number(r.amount).toLocaleString()}${t("개")}</span></div>
         <div class="kv"><b>${t("파는 사람에게")}</b><span>${Number(r.price).toLocaleString()} RVN</span></div>
         <div class="kv"><b>${t("개발비 1%")}</b><span>${Number(r.fee || 0).toLocaleString()} RVN</span></div>
         <div class="kv"><b>${t("모두")}</b><span><b>${Number(r.total || r.price).toLocaleString()} RVN</b></span></div>
         <div class="kv"><b>${t("한 개당")}</b><span>${Number(r.each).toLocaleString()} RVN</span></div>
         <p class="meta">${t("한 거래 안에서 동시에 오갑니다. 먼저 보내지 않습니다.")}</p>
         <div class="row" style="margin-top:12px"><button id="sw-buy">${t("사기")}</button>
           <span class="meta" id="sw-note"></span></div>
       </div>`;
    $("sw-buy").addEventListener("click", () => void swapBuy(hex, r));
  } catch (e) {
    box.innerHTML = `<p class="meta danger">${escapeHtml(errText(e))}</p>`;
  }
}

/**
 * 사기. **미리 조립해서 보여 주고**, 사람이 한 번 더 누를 때 보낸다.
 *
 * 🔴 돈이 오가는 일에 미리보기 없는 단추를 두지 않는다.
 */
async function swapBuy(hex: string, info: any) {
  if (!(await ensureUnlocked("살 때 내 몫을 서명하려면 지갑을 열어야 합니다."))) return;
  $("sw-note").textContent = t("조립하는 중…");
  try {
    const dry = await invoke<any>("swap_take", { hex, broadcast: false, passphrase: null });
    const ok = await sure(
      t("이대로 보낼까요?"),
      `${info.asset} ${Number(info.amount).toLocaleString()}개를 받고 ` +
        `모두 ${Number(info.total || info.price).toLocaleString()} RVN 을 냅니다 ` +
        `(파는 사람 ${Number(info.price).toLocaleString()} · 개발비 ${Number(info.fee || 0).toLocaleString()}). ` +
        `그 밖에 체인 수수료 ${dry.fee} RVN. 되돌릴 수 없습니다.`
    );
    if (!ok) { $("sw-note").textContent = ""; return; }
    const r = await invoke<any>("swap_take", { hex, broadcast: true, passphrase: null });
    $("sw-note").innerHTML = `<span class="ok">${t("보냈습니다")} — ${escapeHtml(String(r.txid)).slice(0, 20)}…</span>`;
    void loadAssets(false);
  } catch (e) {
    $("sw-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
  }
}

/* ── 발행 ─────────────────────────────────────────────────────
   Nothing here is reversible, so the flow is built to slow the user down at the
   two places that matter: the name (permanent, global, unrepeatable) and the
   reissuable flag (the door that locks behind you).                         */

let issueCheck: any = null;
let wizStep = 1;
type WizKind = "root" | "sub" | "unique" | "reissue" | "bulk" | "qualifier" | "restricted";
let wizKind: WizKind = "root";
/** 이미 있는 자산을 고르는 종류. 이름이 **남아 있으면** 안 되고 **있어야** 한다. */
const NEEDS_EXISTING: WizKind[] = ["reissue", "bulk"];
const BURN: Record<string, number> = {
  root: 500, sub: 100, unique: 5, reissue: 100, bulk: 5, qualifier: 1000, restricted: 1500,
};
const KIND_KO: Record<string, string> = {
  root: "루트 자산", sub: "하위 자산", unique: "고유 자산",
  reissue: "더 찍기", bulk: "고유 여러 개", qualifier: "자격 증명", restricted: "제한 자산",
};

/// 종류 고르는 화면. 값이 아니라 "언제 쓰는지"를 먼저 보여준다.
///
/// 자격 증명 1,000 RVN, 제한 자산 1,500 RVN 같은 것은 이름만으로는 무엇인지
/// 알 수 없고, 값만 보면 비싸서 안 누른다. 어느 가게가 어떤 상황에서 쓰는지를
/// 옆에 두면 "나한테 필요한가"를 스스로 답할 수 있다.
async function renderKinds() {
  const kinds: any[] = await invoke<any>("asset_kinds").catch(() => []);
  $("wz-kinds").innerHTML = kinds
    .map(
      (k) => `<div class="choice" data-kind="${k.id}">
        <b>${k.name} <span class="form">${k.form}</span></b>
        <span>${k.one_line} · <b>${k.burn.toLocaleString()} RVN 소각</b></span>
        <div class="ex">
          ${k.examples
            .map((e: any) => `<div class="exrow"><b>${e.case}</b><span><code>${e.name}</code> — ${e.why}</span></div>`)
            .join("")}
        </div>
        <div class="no">이럴 땐 쓰지 마세요 — ${k.not_for}</div>
      </div>`
    )
    .join("");

  document.querySelectorAll("[data-kind]").forEach((c) => {
    (c as HTMLElement).onclick = () => {
      wizKind = (c as HTMLElement).dataset.kind as any;
      document.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("on", x === c));
      // 고른 것만 사례가 펼쳐진다. 전부 펼치면 첫 화면이 벽이 된다.
      wizGate();
    };
  });
}

async function openWizard() {
  await renderKinds();
  wizStep = 1;
  wizKind = "root";
  issueCheck = null;
  document.querySelectorAll("[data-kind]").forEach((c) => c.classList.remove("on"));
  ["i-name", "i-ipfs", "i-confirm"].forEach((id) => (($(id) as HTMLInputElement).value = ""));
  ($("i-qty") as HTMLInputElement).value = "1";
  ($("i-units") as HTMLInputElement).value = "0";
  ($("i-reissuable") as HTMLInputElement).checked = true;
  const vid = $("i-video") as HTMLInputElement | null;
  if (vid) vid.value = "";
  $("i-namecheck").textContent = "";
  $("i-preview").innerHTML = "";
  $("i-result").innerHTML = "";
  $("wiz").classList.remove("hidden");
  wizGo(1);
}

function wizGo(step: number) {
  wizStep = Math.max(1, Math.min(5, step));
  document.querySelectorAll<HTMLElement>(".wstep").forEach((d) =>
    d.classList.toggle("on", +d.dataset.step! === wizStep)
  );
  $("wz-steps").innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<i class="${n <= wizStep ? "on" : ""}"></i>`)
    .join("");
  $("wz-title").textContent =
    ["", "무엇을 만들까요", "이름", "파일", "수량", "확인"][wizStep] || "새 자산 만들기";
  ($("wz-back") as HTMLButtonElement).style.visibility = wizStep === 1 ? "hidden" : "visible";

  // 고유 자산은 하나뿐이다. 수량 칸을 보여주면 2를 넣는 사람이 생긴다.
  const unique = wizKind === "unique";
  $("i-qtyrow").style.display = unique || wizKind === "bulk" ? "none" : "";
  $("i-uniquenote").style.display = unique ? "" : "none";
  if (unique) {
    ($("i-qty") as HTMLInputElement).value = "1";
    ($("i-units") as HTMLInputElement).value = "0";
  }
  // 소수점 자리는 **새로 만들 때만** 정한다. 더 찍기는 원래 자리를 따르고,
  // 자격 증명은 개수만 있는 딱지다.
  const unitsBox = $("i-units").parentElement?.parentElement as HTMLElement | null;
  if (unitsBox) {
    unitsBox.style.display =
      ["reissue", "qualifier"].includes(wizKind) ? "none" : "";
  }
  // 「더 찍기」는 다시 잠글 수 있고, 자격 증명은 그 개념이 없다.
  const reBox = $("i-reissuable").closest("label") as HTMLElement | null;
  if (reBox) reBox.style.display = ["qualifier", "bulk"].includes(wizKind) ? "none" : "";
  $("i-reissue-note").style.display = ["qualifier", "bulk"].includes(wizKind) ? "none" : "";
  renderExtra();

  if (wizStep === 5) renderSummary();
  const next = $("wz-next") as HTMLButtonElement;
  next.textContent = wizStep === 5 ? `${burnNow().toLocaleString()} RVN 소각하고 발행` : "다음";
  wizGate();
}

/**
 * 종류마다 더 필요한 칸.
 *
 * 🔴 여태 이 칸이 없어서 넷(더 찍기·고유 여러 개·자격 증명·제한 자산)은
 *    **고를 수는 있는데 끝까지 갈 수가 없었다.** 값까지 적어 놓고 팔면서
 *    실제로는 물건이 없었던 것이다.
 */
function renderExtra() {
  const box = $("i-extra");
  if (wizStep !== 4) return;
  if (wizKind === "bulk") {
    box.innerHTML = `
      <label style="margin-top:12px">고유 이름들 — <b>한 줄에 하나</b>
        <textarea id="x-tags" rows="6" spellcheck="false"
          placeholder="001&#10;002&#10;VIP-A"></textarea></label>
      <div class="meta">한 개마다 ${BURN.unique} RVN 이 소각됩니다. 줄 수만큼 곱해집니다.</div>`;
    $("x-tags").addEventListener("input", () => { renderSummary(); wizGate(); });
  } else if (wizKind === "restricted") {
    box.innerHTML = `
      <label style="margin-top:12px">누가 받을 수 있나 (검증식)
        <input id="x-verifier" spellcheck="false" placeholder="#KYC" value="#KYC" /></label>
      <div class="meta">
        먼저 만든 <b>자격 증명</b>의 이름을 씁니다. <code>#KYC &amp; !#AML</code> 처럼
        <code>&amp;</code>(그리고) · <code>|</code>(또는) · <code>!</code>(아닌)을 쓸 수 있습니다.
        <b>여기에 적은 딱지가 붙은 주소만</b> 이 자산을 받습니다.
      </div>
      <label style="margin-top:12px">처음 받을 주소
        <input id="x-to" spellcheck="false" placeholder="R..." /></label>
      <div class="meta">🔴 이 주소에도 위 딱지가 붙어 있어야 합니다. 안 붙어 있으면 노드가 거절합니다.</div>`;
    ["x-verifier", "x-to"].forEach((id) =>
      $(id).addEventListener("input", () => wizGate())
    );
  } else {
    box.innerHTML = "";
  }
}

/**
 * 지금 고른 대로면 얼마가 타는가.
 *
 * 🔴 「고유 여러 개」는 **줄 수만큼 곱해진다.** 값을 하나로 보여 주면
 *    50줄을 넣은 사장이 5 RVN 인 줄 알고 누르고 250 RVN 이 탄다.
 */
function burnNow(): number {
  if (wizKind === "bulk") return BURN.unique * Math.max(1, bulkTags().length);
  return BURN[wizKind] ?? BURN.root;
}

function wizGate() {
  const next = $("wz-next") as HTMLButtonElement;
  if (wizStep === 1) next.disabled = !document.querySelector(".choice.on");
  else if (wizStep === 2) next.disabled = !issueCheck;
  else if (wizStep === 5) {
    const typed = ($("i-confirm") as HTMLInputElement).value.trim();
    next.disabled = !issueCheck || typed !== issueCheck.name;
  } else if (wizStep === 4) {
    // 빈 칸으로 5단계에 가면, 값을 다 보여 준 뒤 마지막에 실패한다.
    if (wizKind === "bulk") {
      next.disabled = bulkTags().length === 0;
    } else if (wizKind === "restricted") {
      const v = ($("x-verifier") as HTMLInputElement)?.value.trim();
      const to = ($("x-to") as HTMLInputElement)?.value.trim();
      next.disabled = !v || !to;
    } else next.disabled = false;
  } else next.disabled = false;
}

/** 「고유 여러 개」에 적은 이름들. 빈 줄과 겹치는 줄은 뺀다. */
function bulkTags(): string[] {
  const raw = ($("x-tags") as HTMLTextAreaElement)?.value || "";
  return [...new Set(raw.split("\n").map((l) => l.trim()).filter(Boolean))];
}

function wizNext() {
  if (wizStep < 5) return wizGo(wizStep + 1);
  doIssue();
}

async function checkIssueName() {
  const name = ($("i-name") as HTMLInputElement).value.trim();
  const note = $("i-namecheck");
  issueCheck = null;
  wizGate();
  if (!name) { note.textContent = ""; return; }

  const v: any = await invoke("validate_name", { name });
  if (!v.valid) {
    note.innerHTML = v.problems.map((p: string) => `<span class="danger">${p}</span>`).join("<br>");
    return;
  }
  // 🔴 자격 증명·제한 자산은 **표식이 곧 종류**다. 안 맞으면 딴 것이 만들어진다.
  if (wizKind === "qualifier" && v.kind !== "qualifier") {
    note.innerHTML = `<span class="danger">자격 증명은 <code>#</code> 으로 시작합니다 — 예: <code>#KYC</code></span>`;
    return;
  }
  if (wizKind === "restricted" && v.kind !== "restricted") {
    note.innerHTML = `<span class="danger">제한 자산은 <code>$</code> 로 시작합니다 — 예: <code>$SHARE</code></span>`;
    return;
  }
  // 고른 종류와 이름이 어긋나면 사람이 의도한 것과 다른 게 만들어진다.
  if (["root", "sub", "unique"].includes(wizKind) && v.kind !== wizKind) {
    note.innerHTML =
      `<span class="danger">${KIND_KO[wizKind]}을 고르셨는데 이 이름은 ${KIND_KO[v.kind]} 형태입니다.` +
      (wizKind === "sub" ? " 하위는 <code>루트/이름</code>" : wizKind === "unique" ? " 고유는 <code>루트#태그</code>" : " 루트는 <code>/</code>나 <code>#</code> 없이") +
      "</span>";
    return;
  }

  // 이름이 남았는지는 체인이 답한다. 남이 가져간 이름은 영원히 못 쓰고,
  // 그걸 실패한 트랜잭션으로 알게 되면 RVN이 날아간다.
  let taken = false;
  try { taken = await invoke<boolean>("name_taken", { name }); } catch {}
  // 🔴 「더 찍기」와 「고유 여러 개」는 **이미 가진 자산에 얹는 것**이다.
  //    그런데 여기서 「이미 존재하는 이름」을 무조건 막고 있어서, 그 둘은
  //    2단계를 **영영 통과할 수 없었다.** 고를 수는 있는데 갈 수가 없었다.
  if (NEEDS_EXISTING.includes(wizKind)) {
    if (!taken) {
      note.innerHTML =
        `<span class="danger">체인에 없는 이름입니다. ` +
        (wizKind === "reissue" ? "더 찍으려면" : "고유 자산을 붙이려면") +
        ` 이미 가진 자산의 이름을 넣으세요.</span>`;
      return;
    }
    note.innerHTML = `<span class="ok">찾았습니다 — 이 자산에 얹습니다</span>`;
    issueCheck = { ...v, name };
    wizGate();
    return;
  }
  if (taken) {
    note.innerHTML = `<span class="danger">이미 존재하는 이름입니다. 자산 이름은 영구적이라 다시 쓸 수 없습니다.</span>`;
    return;
  }

  note.innerHTML = `<span class="ok">쓸 수 있는 이름입니다</span>`;
  issueCheck = { ...v, name };
  wizGate();
}

function pickIssueFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    $("i-preview").innerHTML = `<p class="meta">올리는 중…</p>`;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const added = await invoke<any>("ipfs_add_file", { file: { name: file.name, bytes } });
      ($("i-ipfs") as HTMLInputElement).value = added.cid;
      $("i-preview").innerHTML = file.type.startsWith("image/")
        ? `<img src="http://127.0.0.1:8080/ipfs/${added.cid}" alt="" style="max-width:220px;border-radius:8px;margin-top:9px" />`
        // 🔴 자산이 가리키는 그림이 사라지면 **자산만 남고 그림이 없어진다.**
        //    `upload.rs` 첫 줄이 「그게 이 앱이 막으려는 바로 그 실패」라고
        //    적어 두었는데, 정작 화면은 「올렸습니다」로 끝났다.
        : `<p class="meta">${file.name} · ${t("이 컴퓨터에 두었습니다")}</p>`;
    } catch (e) {
      $("i-preview").innerHTML = `<p class="meta danger">${e}</p>`;
    }
  };
  input.click();
}

function renderSummary() {
  const qty = parseFloat(($("i-qty") as HTMLInputElement).value) || 1;
  const units = parseInt(($("i-units") as HTMLInputElement).value) || 0;
  const re = ($("i-reissuable") as HTMLInputElement).checked;
  const cid = ($("i-ipfs") as HTMLInputElement).value.trim();

  $("i-r-kind").textContent = KIND_KO[wizKind];
  $("i-r-name").textContent = issueCheck?.name || "";
  const tags = wizKind === "bulk" ? bulkTags() : [];
  $("i-r-qty").innerHTML =
    wizKind === "unique"
      ? "1 (고유)"
      : wizKind === "bulk"
        ? `${tags.length}개 — ${escapeHtml(tags.slice(0, 6).join(", "))}${tags.length > 6 ? " …" : ""}`
        : wizKind === "reissue"
          ? `${qty.toLocaleString()}개를 <b>더</b> 찍습니다 · ` +
            (re ? "다음에도 더 찍을 수 있음" : '<b class="danger">이번이 마지막 — 영원히 잠깁니다</b>')
          : `${qty.toLocaleString()} · 소수점 ${units}자리 · ` +
            (re ? "재발행 가능" : '<b class="danger">재발행 불가 — 되돌릴 수 없음</b>');
  $("i-r-file").textContent = cid || "없음";
  // 제한 자산은 **누가 받을 수 있는지**가 수량보다 중요하다. 요약에 없으면
  // 검증식을 잘못 적은 채로 1,500 RVN 을 태우게 된다.
  if (wizKind === "restricted") {
    const v = ($("x-verifier") as HTMLInputElement)?.value.trim() || "";
    $("i-r-file").innerHTML =
      `${escapeHtml(cid || "파일 없음")}<br /><b>받을 수 있는 주소</b>: <code>${escapeHtml(v)}</code>` +
      ` 딱지가 붙은 곳만`;
  }

  const need = burnNow();
  $("i-cost").innerHTML = `<div class="burn danger">${need.toLocaleString()} RVN 소각</div>
    <div class="meta">소각된 RVN은 돌아오지 않습니다. 네트워크 수수료는 별도입니다.</div>
    <div class="meta" id="i-have">지갑 확인 중…</div>`;
  // 🔴 여기에 `issueCheck.name` 을 넣어 뒀었다. 즉 **정답을 칸 안에 흐리게
  // 적어 두고 그걸 베끼라고** 한 셈이다. 그러면 이 게이트는 "이 이름이 맞다"
  // 를 확인하는 것이 아니라 "베낄 줄 안다" 를 확인한다.
  //
  // 특히 이름을 라비가 채웠을 때 위험하다. 김치를 `KIMCHEE` 로 잘못 옮기면
  // 사장은 화면에 뜬 글자를 그대로 쳐서 통과하고, **500 RVN 이 타고 그 이름은
  // 영원히 안 바뀐다.** 보내기 확인의 「끝 4자리」와 똑같은 병이다.
  //
  // 답은 화면 위쪽 요약에만 있고, 이 칸은 비워 둔다.
  ($("i-confirm") as HTMLInputElement).placeholder = "위에 적힌 이름을 직접 입력";

  // 소각액만 보여 주고 잔액을 안 보면, 사람은 이름을 다 적고 마지막에
  // "insufficient funds" 를 만난다. 그리고 매출 자동 이체가 5분마다 도니까
  // 발행하려고 넣어 둔 돈을 그 사이에 쓸어가 버린다 — 화면에 아무 설명도 없이.
  invoke<any>("wallet_balance")
    .then((b) => {
      const have = b?.confirmed ?? 0;
      const ok = have >= need + 0.1;
      $("i-have").innerHTML = ok
        ? `지갑에 ${have.toLocaleString(undefined, { maximumFractionDigits: 2 })} RVN 있습니다.`
        : `<span class="danger">지갑에 ${have.toLocaleString(undefined, { maximumFractionDigits: 2 })} RVN뿐입니다 —
           ${(need - have).toFixed(2)} RVN 더 넣으셔야 합니다.</span>`;
      // 🔴 여태 **나가는 돈만** 보여 줬다. 배당은 dry-run 으로 "무엇이
      // 어떻게 되는지" 를 강제로 보게 하는데, 발행은 소각량 한 줄뿐이었다.
      //
      // 사람은 "500 RVN" 을 읽고도 그게 자기 지갑에서 얼마를 덜어내는지
      // 잘 모른다. **끝난 뒤의 모습**을 같이 보여 준다 — 그게 결정에 쓰이는
      // 숫자다. 그리고 되돌릴 수 없는 것을 그 옆에 나란히 적는다.
      const after = have - need;
      const rvn = (n: number) =>
        n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const forever: string[] = [`이름 「${issueCheck?.name || ""}」 은 영원히 바뀌지 않습니다`];
      if (!re && wizKind !== "unique") {
        forever.push("재발행을 껐으므로 수량과 파일을 영원히 못 바꿉니다");
      }
      if (!cid) forever.push("파일을 안 붙이셨습니다 — 나중에 붙이려면 재발행이 켜져 있어야 합니다");
      $("i-after").innerHTML = ok
        ? `<div class="afterbox">
             <div class="ab-row"><span>지금 지갑</span><b>${rvn(have)} RVN</b></div>
             <div class="ab-row"><span>태울 돈</span><b class="danger">− ${rvn(need)} RVN</b></div>
             <div class="ab-row ab-sum"><span>끝나면</span><b>${rvn(after)} RVN</b></div>
             <div class="ab-get">그리고 <b>${
               wizKind === "unique" ? "1개" : `${qty.toLocaleString()}개`
             }</b>의 「${escapeHtml(issueCheck?.name || "")}」 이 이 지갑에 들어옵니다.</div>
             <div class="ab-never">되돌릴 수 없는 것<ul>${
               forever.map((t) => `<li>${escapeHtml(t)}</li>`).join("")
             }</ul></div>
           </div>`
        : "";

      const go = $("wz-next") as HTMLButtonElement;
      go.disabled = !ok;
      // 이 단계의 「다음」은 되돌릴 수 없는 발행이다. 앞 단계들과 글자가
      // 같으면 손이 습관대로 누른다. 대가를 버튼 안에 둔다.
      go.textContent = `발행하기 · ${need.toLocaleString(undefined, { maximumFractionDigits: 2 })} RVN 소각`;
    })
    .catch(() => {
      $("i-have").textContent = "";
    });

  // 발행 준비 중에는 자동 이체를 30분 멈춘다.
  invoke("sweep_hold", { untilUnix: Math.floor(Date.now() / 1000) + 1800 }).catch(() => {});
}

/// 잠긴 지갑에서 돈이나 자산을 움직이기 전에 한 번 연다.
///
/// 🔴 회원권 발행은 이걸 성실히 하는데 **자산 발행과 가게 등록은 안 했다.**
/// 잠근 채 영업하는 것이 기본 상태라, 사장이 발행 버튼을 누르면 노드가
/// "wallet is locked" 를 뱉고 화면은 조용히 멈춘다 — 40~70대 사장은 왜 안
/// 되는지 알 길이 없다. 500 RVN 을 태우려던 참인데 아무 일도 안 일어난다.
///
/// 이미 열려 있거나 암호가 없는 지갑이면 아무것도 묻지 않는다.
/// 취소하면 `false` 를 준다 — 부르는 쪽이 거기서 멈춰야 한다.
async function ensureUnlocked(why: string): Promise<boolean> {
  try {
    const lock: any = await invoke("wallet_lock_state");
    if (!lock?.encrypted || lock?.unlocked) return true;
    const pass = await ask("지갑 암호", why, { password: true });
    if (!pass) return false;
    await invoke("unlock_for", { passphrase: pass, seconds: 60 });
    return true;
  } catch (e) {
    await sure(t("지갑을 열지 못했습니다"), errText(e), t("닫기"));
    return false;
  }
}


/**
 * 되돌릴 수 없는 일 앞의 **취소 창.**
 *
 * 🔴 왜 필요한가 — 마법사는 「다음」을 네 번 누르게 한다. 손이 그 리듬에
 * 들어가면 다섯 번째도 누른다. 그 다섯 번째가 500 RVN 이다.
 *
 * 🔴 왜 **부르기 전**에 두나 — `issue` RPC 는 만들고 **곧바로 뿌린다.**
 * 부른 뒤에는 취소할 자리가 없다. 체인은 되돌리지 않는다.
 *
 * ⚠️ 확인 체크박스를 하나 더 두는 것과는 다르다. 체크박스는 그냥 눌린다.
 * 여기서는 **시간이 흐르는 것을 보면서** 아무것도 안 해야 진행된다 —
 * 습관이 아니라 기다림이 통과 조건이다.
 *
 * @returns 사용자가 그대로 두면 `true`, 취소하면 `false`
 */
function holdBeforeDoing(what: string, cost: string, seconds = 8): Promise<boolean> {
  return new Promise((done) => {
    const box = document.createElement("div");
    box.className = "holdbox";
    let left = seconds;
    const paint = () => {
      box.innerHTML = `
        <div class="hb-top">${escapeHtml(what)}</div>
        <div class="hb-cost">${escapeHtml(cost)}</div>
        <div class="hb-bar"><i style="width:${((seconds - left) / seconds) * 100}%"></i></div>
        <div class="hb-left">${left}초 뒤에 시작합니다</div>
        <button class="hb-cancel">그만두기</button>`;
      (box.querySelector(".hb-cancel") as HTMLElement).onclick = () => {
        clearInterval(t);
        box.remove();
        done(false);
      };
    };
    paint();
    // 지금 열려 있는 화면 안에 그린다. 화면 밖에 그리면 스크롤 위치에
    // 따라 안 보이고, 안 보이는 취소 단추는 없는 것과 같다.
    const host =
      document.querySelector("#wiz:not(.hidden) #i-result") ||
      // 🔴 **지금 열려 있는 화면이 스스로 내놓은 자리**가 있으면 거기 그린다.
      //
      //    아래 마지막 두 줄(`$("i-result")`)은 **자산 마법사 안쪽**이다.
      //    자산 화면에서 부를 때는 맞는 자리지만, 다른 화면(「이 컴퓨터」의
      //    「내 이름」)에서 부르면 확인창이 **접혀 있는 마법사 속**에 그려져
      //    아무도 못 본다 — 그러면 8초 뒤에 아무 예고 없이 일이 벌어진다.
      //    안 보이는 취소 단추는 없는 것과 같다.
      //
      //    `.holdhost` 를 둔 화면이 아직 없던 때와 똑같이 굴러가므로,
      //    이 줄이 여태 있던 자리를 건드리지는 않는다.
      document.querySelector(".page.on .holdhost") ||
      (document.getElementById("page-shop")?.classList.contains("on")
        ? document.getElementById("sh-result")
        : null) ||
      $("i-result") ||
      document.body;
    host.prepend(box);
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(t);
        box.innerHTML = `<div class="hb-top">${escapeHtml(what)}</div>
          <div class="hb-left">시작합니다…</div>`;
        done(true);
        // 잠깐 남겨 둔다 — 바로 사라지면 눌린 줄 모른다.
        setTimeout(() => box.remove(), 1500);
        return;
      }
      paint();
    }, 1000);
  });
}

async function doIssue() {
  if (!issueCheck) return;
  // 발행은 500 RVN 을 태운다. 잠겨 있으면 여기서 멈추고 이유를 말한다.
  if (!(await ensureUnlocked("자산을 발행하려면 지갑을 열어야 합니다."))) return;

  // 🔴 취소 창. `issue` RPC 는 만들고 곧바로 뿌리므로, 되돌릴 수 있는
  // 마지막 순간이 **여기**다. 마법사가 「다음」을 네 번 누르게 하고, 손이
  // 그 리듬에 들어가면 다섯 번째도 누른다 — 그 다섯 번째가 500 RVN 이다.
  const ok = await holdBeforeDoing(
    `「${issueCheck.name}」 을 만듭니다`,
    `${BURN[wizKind]} RVN 이 타고, 이 이름은 영원히 바뀌지 않습니다`,
  );
  if (!ok) return;
  const btn = $("wz-next") as HTMLButtonElement;
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "발행 중…";
  try {
    // 🔴 **`|| 1` 이 0 을 삼키고 있었다.** `parseFloat("0")` 은 0 이고 0 은
    //    거짓값이라, 사장이 0 을 적으면 조용히 1 이 나갔다.
    //
    //    재발행에서 **수량 0 은 뜻이 있는 값**이다 — 「아무것도 새로 안
    //    만들고 붙은 파일만 바꾼다」. 이미 상한(21,000,000,000)까지 찍은
    //    자산은 그 길밖에 없다. 0 이 1 로 바뀌면 노드가 상한 초과로
    //    거절하고, 화면은 **왜 안 되는지 말하지 못한다.**
    //
    //    빈 칸·글자만 1 로 본다. 적은 0 은 0 으로 보낸다.
    const qtyTyped = parseFloat(($("i-qty") as HTMLInputElement).value);
    const qty = wizKind === "unique" ? 1 : Number.isFinite(qtyTyped) ? qtyTyped : 1;
    const units = wizKind === "unique" ? 0 : parseInt(($("i-units") as HTMLInputElement).value) || 0;
    let cid = ($("i-ipfs") as HTMLInputElement).value.trim() || null;
    // 🔴 자산에는 IPFS 해시가 **하나**만 박힌다. 사진과 영상 링크를 둘 다
    //    담으려면 그 둘을 적은 쪽지를 만들어 그 쪽지 주소를 박아야 한다.
    //    사진만 있으면 쪽지를 안 만든다 — 한 겹 덜 거치는 쪽이 빠르다.
    const video = ($("i-video") as HTMLInputElement)?.value.trim() || "";
    if (video) {
      const up = await invoke<any>("ipfs_add_bundle", {
        files: [],
        metadata: {
          name: issueCheck.name,
          image: cid || "",
          // 표준 이름을 쓴다. 남의 지갑도 이 이름을 읽는다.
          video_url: video,
        },
      });
      cid = String(up.cid || cid || "");
    }
    const re = ($("i-reissuable") as HTMLInputElement).checked;

    // 🔴 여기가 **언제나 `issue_asset` 하나였다.** 화면은 일곱을 고르게 하고,
    //    실행은 하나만 했다. 고른 것이 무엇이든 평범한 발행이 나갔고,
    //    자격 증명·제한 자산은 노드가 영어로 거절했다.
    //    러스트에는 넷 다 이미 있었다 — 부르는 줄이 없었을 뿐이다.
    let txid: string;
    if (wizKind === "reissue") {
      txid = await invoke<string>("reissue", {
        asset: issueCheck.name,
        qty,
        toAddress: null,
        keepReissuable: re,
        newIpfs: cid,
        passphrase: null,
      });
    } else if (wizKind === "bulk") {
      const r = await invoke<any>("issue_many_unique", {
        root: issueCheck.name,
        tags: bulkTags(),
        toAddress: null,
        passphrase: null,
      });
      txid = typeof r === "string" ? r : String(r?.txid || r?.[0] || "");
    } else if (wizKind === "qualifier") {
      const r = await invoke<any>("issue_qualifier", {
        name: issueCheck.name,
        qty,
        passphrase: null,
      });
      txid = typeof r === "string" ? r : String(r?.txid || r?.[0] || "");
    } else if (wizKind === "restricted") {
      const r = await invoke<any>("issue_restricted", {
        name: issueCheck.name,
        qty,
        verifier: ($("x-verifier") as HTMLInputElement).value.trim(),
        toAddress: ($("x-to") as HTMLInputElement).value.trim(),
        units,
        reissuable: re,
        ipfsHash: cid,
        passphrase: null,
      });
      txid = typeof r === "string" ? r : String(r?.txid || r?.[0] || "");
    } else {
      txid = await invoke<string>("issue_asset", {
        name: issueCheck.name,
        qty,
        units,
        reissuable: re,
        ipfsHash: cid,
        toAddress: null,
      });
    }
    $("i-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>발행했습니다</h3>
       <div class="kv"><b>자산</b><span>${issueCheck.name}</span></div>
       <div class="kv"><b>트랜잭션</b><code class="addr">${txid}</code></div>
       <p class="meta">확인되기까지 몇 분 걸립니다.</p></div>`;
    btn.textContent = "닫기";
    btn.disabled = false;
    // 빈 폼에 남겨 두지 않는다. 만든 자산이 있는 목록으로 돌려보낸다.
    btn.onclick = () => {
      $("wiz").classList.add("hidden");
      ($("wz-next") as HTMLButtonElement).onclick = wizNext;
      loadAssets(false);
    };
  } catch (e) {
    $("i-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
    // 정상 경로와 같은 글자로 되돌린다. 예전에는 여기서만 소각량을 말해서,
    // 대가를 실패한 뒤에야 보게 되어 있었다.
    btn.textContent = wasLabel || `발행하기 · ${BURN[wizKind]} RVN 소각`;
    btn.disabled = false;
  }
}

// ── 보내기 ────────────────────────────────────────────────────────────────
//
// Sending an asset and sending RVN are two screens sharing one box, and the
// mode is fixed the moment it opens. You cannot switch mid-compose: changing
// what you are sending is starting over, because "I meant the other one" is
// exactly the thought that precedes an irreversible mistake.

/// 이 금액 이상을 **처음 보는 주소**로 보낼 때만 끝 4자리를 묻는다.
/// 3만 RVN 이면 시세로 10만 원 언저리다 — 커피값에는 안 걸리고, 잃으면
/// 아픈 금액에는 걸린다.
const TAIL_CHECK_RVN = 30_000;

let sendMode: "asset" | "rvn" | null = null;
let sendPreview: any = null;

function openSend(mode: "asset" | "rvn", preselect?: string) {
  sendMode = mode;
  sendPreview = null;
  $("send-review").style.display = "none";
  $("send-compose").style.display = "";
  $("s-result").innerHTML = "";
  $("s-mode").textContent = mode === "asset" ? "자산 보내기" : "RVN 보내기";
  // 🔴 두 버튼 중 하나만 클래스가 없어 **항상** 진하게 그려지고 있었다.
  // 선택 상태가 아니라 그냥 스타일인데, RVN 을 눌러도 「자산 보내기」가 계속
  // 진하니 "자산 탭이 열렸다" 로 읽혔다. 이제 열린 쪽만 표시한다.
  $("w-send-asset").classList.toggle("ghost", mode !== "asset");
  $("w-send-rvn").classList.toggle("ghost", mode !== "rvn");
  $("s-assetrow").style.display = mode === "asset" ? "" : "none";
  ($("s-addr") as HTMLInputElement).value = "";
  ($("s-qty") as HTMLInputElement).value = "";
  $("s-addrnote").textContent = "";
  $("s-held").textContent = "";
  ($("s-review") as HTMLButtonElement).disabled = true;

  if (mode === "asset") {
    const sel = $("s-asset") as HTMLSelectElement;
    // Only assets with a positive balance — offering ones you cannot send is
    // an error message disguised as a choice.
    sel.innerHTML = [...assets.values()]
      .filter((a) => a.amount > 0)
      .map((a) => `<option value="${a.name}">${a.name} — ${fmtQty(a.amount)}</option>`)
      .join("");
    if (preselect) sel.value = preselect;
  }
}

function closeSend() {
  sendMode = null;
  sendPreview = null;
  $("send-compose").style.display = "none";
  $("send-review").style.display = "none";
}

function composeChanged() {
  const addr = ($("s-addr") as HTMLInputElement).value.trim();
  const qty = parseFloat(($("s-qty") as HTMLInputElement).value);
  ($("s-review") as HTMLButtonElement).disabled = !(addr.length > 20 && qty > 0);
}

async function reviewSend() {
  const address = ($("s-addr") as HTMLInputElement).value.trim();
  const amount = parseFloat(($("s-qty") as HTMLInputElement).value);
  const asset = sendMode === "asset" ? ($("s-asset") as HTMLSelectElement).value : null;

  const btn = $("s-review") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "확인 중…";
  try {
    sendPreview = await invoke<any>("preview_send", { address, asset, amount });
  } catch (e) {
    $("s-addrnote").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
    btn.textContent = "검토";
    btn.disabled = false;
    return;
  }
  btn.textContent = "검토";
  btn.disabled = false;

  if (!sendPreview.valid) {
    $("s-addrnote").innerHTML =
      `<span style="color:var(--bad)">이 체인의 주소가 아닙니다. 한 글자라도 틀리면 이렇게 나옵니다.</span>`;
    return;
  }
  $("s-addrnote").textContent = "";

  const h = sendPreview.history || {};
  // The name is the check a human can actually perform. When there is no name,
  // that absence *is* the warning — it is not drawn as a neutral blank.
  $("r-who").innerHTML = h.label
    ? `<b>${h.label}</b>`
    : `<span style="color:var(--warn)">처음 보내는 주소</span>`;
  $("r-addr").textContent = address;
  $("r-hist").textContent = h.known
    ? `지난번 ${h.last_amount ?? "?"} · ${h.last_time ? ago(h.last_time) : ""}`
    : "";

  $("r-what").textContent = asset ?? "RVN";
  $("r-amount").textContent = `${amount}${asset ? "" : " RVN"}`;

  const warns: string[] = [];
  if (!sendPreview.enough)
    warns.push(`보유 ${sendPreview.held}. 보내려는 ${amount}보다 적습니다.`);
  if (sendPreview.is_mine) warns.push("이 주소는 내 지갑입니다.");
  $("r-warn").innerHTML = warns.length
    ? `<div class="warnbox" style="margin-top:12px">${warns.join("<br>")}</div>`
    : "";

  // 처음 보내는 주소에 **큰 금액**일 때만 끝 4자리를 묻는다.
  //
  // 이 확인이 막는 것은 오타가 아니라 **클립보드를 바꿔치기하는 악성코드**다.
  // 복사한 주소가 남의 주소로 바뀌어 붙는 공격이 실제로 있고, 지갑 암호는
  // 그걸 못 막는다 — 암호는 "이 사람이 맞나" 를 묻지 "이 주소가 맞나" 를
  // 묻지 않기 때문이다.
  //
  // 다만 커피값마다 물으면 손이 외워서 치게 되고, 반사가 된 확인은 안 물은
  // 것과 같다. 그래서 잃으면 아픈 금액에서만 묻는다.
  // 자산은 금액을 원화로 환산할 수 없다 — 고유 자산 한 개가 집 한 채일 수도
  // 있고 쿠폰 한 장일 수도 있다. 값을 모르면 무겁게 다룬다.
  const big = asset ? true : (Number(amount) || 0) >= TAIL_CHECK_RVN;
  const needTail = !h.known && big;
  $("r-tailbox").style.display = needTail ? "" : "none";
  ($("s-tail") as HTMLInputElement).value = "";
  $("s-tailwarn").textContent = "";
  if (needTail) {
    // 주소를 4자씩 끊어 보여 준다. 34자를 한 줄로 흘리면 아무도 비교하지
    // 않고, 비교하지 않는 확인은 확인이 아니다.
    //
    // 🔴 **끝 4자리는 가린다.** 여태 여기에 굵게 적혀 있었다. 바로 위 안내는
    // "화면에 뜬 주소를 보지 마시고 받는 분이 알려 준 원본을 보세요" 인데,
    // 답을 화면에 적어 두면 아무도 원본을 안 본다 — 굵은 글자를 그대로 친다.
    //
    // 그러면 이 확인이 막으려던 공격이 **그대로 통과한다.** 클립보드를
    // 바꿔치기하는 악성코드는 흔하고, 그때 화면의 주소는 이미 공격자 것이다.
    // 공격자 주소를 보고 공격자 주소의 끝 4자리를 적으면 당연히 맞는다.
    //
    // 가려 두면 답이 화면 밖(문자·영수증·카운터 화면)에만 있다. 그게 이
    // 확인이 성립하는 유일한 조건이다.
    const a = String(sendPreview.address);
    const head = a.slice(0, -4).replace(/(.{4})/g, "$1 ");
    $("r-tailshow").innerHTML =
      `${escapeHtml(head)}<b class="masked" aria-label="가려진 네 글자">••••</b>`;
  }

  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  const needPass = lock && lock.encrypted && !lock.unlocked;
  $("r-passbox").style.display = needPass ? "" : "none";
  ($("s-pass") as HTMLInputElement).value = "";

  $("send-compose").style.display = "none";
  $("send-review").style.display = "";
  gateSend();
}

function gateSend() {
  if (!sendPreview) return;
  const needTail = $("r-tailbox").style.display !== "none";
  const needPass = $("r-passbox").style.display !== "none";
  const tail = ($("s-tail") as HTMLInputElement).value.trim();
  const pass = ($("s-pass") as HTMLInputElement).value;
  const tailOk =
    !needTail || tail.toLowerCase() === String(sendPreview.address).slice(-4).toLowerCase();
  const go = $("s-go") as HTMLButtonElement;
  go.disabled = !tailOk || (needPass && !pass) || !sendPreview.enough;
  // 네 자를 다 쳤는데 안 맞으면 말해 준다. 조용히 버튼만 막으면 사람은
  // 자기가 오타를 낸 줄 알고 다시 친다 — 정작 봐야 할 것은 주소다.
  $("s-tailwarn").innerHTML =
    needTail && tail.length >= 4 && !tailOk
      ? `<span class="danger">원본과 다릅니다. 주소가 바뀌었을 수 있으니 보내지 마세요.</span>`
      : "";
  // 대가를 버튼에 박는다. 누르는 순간 손이 보는 것은 옆의 설명문이 아니라
  // 버튼이고, 체인에 나간 전송은 되돌릴 방법이 없다.
  const amt = Number(sendPreview.amount ?? sendPreview.rvn ?? 0);
  const what = sendPreview.asset && sendPreview.asset !== "RVN" ? sendPreview.asset : "RVN";
  go.textContent = amt > 0 ? `${fmtQty(amt)} ${what} 보내기` : "보내기";
}

async function doSend() {
  if (!sendPreview) return;
  const btn = $("s-go") as HTMLButtonElement;
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "보내는 중…";
  const pass = ($("s-pass") as HTMLInputElement).value || null;

  try {
    const txid =
      sendMode === "asset"
        ? await invoke<string>("send_asset", {
            asset: sendPreview.asset,
            qty: sendPreview.amount,
            toAddress: sendPreview.address,
            passphrase: pass,
          })
        : await invoke<string>("send_rvn", {
            toAddress: sendPreview.address,
            amount: sendPreview.amount,
            comment: null,
            passphrase: pass,
          });

    $("s-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>보냈습니다</h3>
       <div class="kv"><b>받는 곳</b><code class="addr">${sendPreview.address}</code></div>
       <div class="kv"><b>트랜잭션</b><code class="addr">${txid}</code></div>
       <p class="meta">확인되기까지 몇 분 걸립니다. 되돌릴 수 없습니다.</p></div>`;
    $("r-tailbox").style.display = "none";
    $("r-passbox").style.display = "none";
    sendPreview = null;
    loadWallet();
  } catch (e) {
    $("s-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
    // 실패했으니 다시 누를 수 있어야 하고, 라벨도 금액으로 돌아와야 한다.
    // "보내는 중…" 이 남아 있으면 얼마를 보내려던 건지 사라진다.
    btn.textContent = wasLabel || "보내기";
    btn.disabled = false;
  }
  btn.textContent = "보내기";
}

// ── 가게 ──────────────────────────────────────────────────────────────────
//
// A shop is an asset; its profile is the IPFS file that asset points at. There
// is no shop server anywhere — the directory is a chain query. That is the
// whole architecture, and everything below is bookkeeping around it.

const REGISTER_BURN = 500; // 루트 자산. chainparams.cpp.
let shopAddress = "";
let menuItems: any[] = [];
let orderTimer: any = null;

let shopIcon: string | null = null;
/** 가게 안 사진들이 든 파일창고 폴더 주소. 사진이 아니라 **주소 하나**다. */
let shopPhotosCid: string | null = null;
/**
 * 메뉴를 파일창고에 올린 주소.
 *
 * 🔴 **메뉴가 바깥으로 한 번도 안 나갔다.** 공지를 만드는 쪽(`shopkey.rs`)은
 * `menu_cid` 를 실어 나를 준비가 돼 있는데, 그 값을 넣는 코드가 이 파일에
 * **한 곳도 없었다.** 그래서 손님 목록에는 「메뉴 6가지」라는 **개수만** 뜨고,
 * 가게를 끄면 그 개수마저 사라졌다.
 *
 * 🔴 왜 체인이 아니라 공지에 싣나 — 체인 문서를 고치려면 **재발행 100 RVN**
 * 이다. 메뉴는 자주 바뀌는 것이라 그 자리에 두면 안 된다. 「안 바뀌는 것은
 * 체인에, 바뀌는 것은 공지에」가 이 프로그램의 규칙이고 메뉴는 뒤쪽이다.
 */
let shopMenuCid: string | null = null;

// ── AI 도우미 ──
//
// Whatever it produces lands in the same inputs the owner would have typed
// into, and they are shown filled rather than submitted. The one irreversible
// thing on this screen — the burn — still needs the name retyped by hand.

let aiProvider: string | null = null;

/// 열쇠를 넣는 칸의 순서. 위에 있는 것이 먼저 눈에 들어오고, 대부분은
/// 첫 칸 하나만 채운다. 그래서 이 순서는 취향이 아니라 기본값에 가깝다.
///
/// 답할 때의 우선순위는 이것과 **별개**다 — `ai.rs` 의 CUSTOMER_ORDER 는
/// 손님 질문에 빠른 쪽부터, OWNER_ORDER 는 사장 질문에 똑똑한 쪽부터 쓴다.
const PROVIDERS: Record<string, [string, string, string]> = {
  xai: ["xAI (Grok)", "xai-…", "https://console.x.ai/"],
  anthropic: ["Anthropic (Claude)", "sk-ant-…", "https://console.anthropic.com/settings/keys"],
  google: ["Google (Gemini)", "AIza…", "https://aistudio.google.com/apikey"],
  openai: ["OpenAI", "sk-…", "https://platform.openai.com/api-keys"],
  groq: ["Groq", "gsk_…", "https://console.groq.com/keys"],
};

// ── 넘어가는 순서 ──────────────────────────────────────────────────────────
//
// 한 곳이 할당량을 넘기면 다음으로 넘어간다. 그 순서가 곧 요금이라서, 원하는
// 사장님은 정할 수 있어야 한다. 다만 **묻지는 않는다** — 안 건드리면 기본값이다.
//
// 끌어서 옮기는 것만 두면 손이 떨리는 분은 못 쓴다. ↑↓ 를 같이 둔다.

let aiOrder: { customer: string[]; owner: string[] } = { customer: [], owner: [] };
let aiKeyed: Record<string, boolean> = {};

function renderOrder(lane: "customer" | "owner") {
  const list = aiOrder[lane];
  const box = $(lane === "customer" ? "ord-customer" : "ord-owner");
  box.innerHTML = list
    .map((p, i) => {
      const label = PROVIDERS[p]?.[0] || p;
      // 키가 없는 곳은 순서에 있어도 건너뛴다. 그걸 말해 주지 않으면
      // 1번으로 올려 놓고 왜 안 쓰이는지 모른다.
      const no = aiKeyed[p] ? "" : `<span class="nokey">키 없음 — 건너뜁니다</span>`;
      return `<div class="ordrow" draggable="true" data-p="${escapeHtml(p)}" data-i="${i}">
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <span class="rank">${i + 1}</span>
        <span class="nm">${escapeHtml(label)}</span>
        ${no}
        <button class="ghost" data-mv="up" ${i === 0 ? "disabled" : ""} title="위로">↑</button>
        <button class="ghost" data-mv="down" ${i === list.length - 1 ? "disabled" : ""} title="아래로">↓</button>
      </div>`;
    })
    .join("");

  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    renderOrder(lane);
    saveOrder(lane);
  };

  box.querySelectorAll<HTMLElement>("[data-mv]").forEach((b) => {
    b.onclick = () => {
      const row = b.closest(".ordrow") as HTMLElement;
      const i = Number(row.dataset.i);
      move(i, b.dataset.mv === "up" ? i - 1 : i + 1);
    };
  });

  let from = -1;
  box.querySelectorAll<HTMLElement>(".ordrow").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      from = Number(row.dataset.i);
      // 이게 없으면 파이어폭스 계열에서 끌기가 시작조차 안 된다.
      (e as DragEvent).dataTransfer?.setData("text/plain", String(from));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("over");
      if (from >= 0) move(from, Number(row.dataset.i));
      from = -1;
    });
  });
}

async function saveOrder(lane: "customer" | "owner") {
  $("ord-note").textContent = "저장 중…";
  try {
    await invoke("ai_order_save", { customer: lane === "customer", order: aiOrder[lane] });
    $("ord-note").textContent = "저장했습니다.";
  } catch (e: any) {
    $("ord-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  }
}

async function loadOrder() {
  try {
    const r = await invoke<any>("ai_order_read");
    aiOrder = {
      customer: r?.customer?.order || [],
      owner: r?.owner?.order || [],
    };
    renderOrder("customer");
    renderOrder("owner");
  } catch {}
}

async function resetOrder() {
  $("ord-note").textContent = "되돌리는 중…";
  try {
    // 빈 목록 = 기본값으로. 그러고 나서 기본값을 다시 읽어 화면에 그린다.
    await invoke("ai_order_save", { customer: true, order: [] });
    await invoke("ai_order_save", { customer: false, order: [] });
    await loadOrder();
    $("ord-note").textContent = "기본값으로 되돌렸습니다.";
  } catch (e: any) {
    $("ord-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  }
}

function renderKeyRows(st: any, models: any) {
  aiKeyed = st || {};
  renderOrder("customer");
  renderOrder("owner");
  $("keyrows").innerHTML =
    Object.entries(PROVIDERS)
      .map(([p, [label, ph, console_]]) =>
        st[p]
          ? // 모델 이름은 회사가 예고 없이 바꾼다. 우리 배포를 기다리지 않고
            // 직접 고칠 수 있어야 한다.
            `<div class="keyrow"><span class="who">${label}</span>
               <input id="model-${p}" value="${models?.[p]?.model || ""}"
                      placeholder="${models?.[p]?.default || ""}" autocomplete="off" spellcheck="false" />
               <button class="ghost" data-delkey="${p}">지우기</button></div>`
          : `<div class="keyrow"><span class="who">${label}</span>
               <input id="key-${p}" type="password" placeholder="${ph}" autocomplete="off" />
               <button class="ghost" data-console="${console_}">열쇠 받기</button></div>`
      )
      .join("") +
    (st.custom
      ? `<div class="keyrow"><span class="who">${st.custom_label || "커스텀"}</span>
           <span class="saved">저장됨</span>
           <button class="ghost" data-delkey="custom">지우기</button></div>`
      : "");

  $("keyrows")
    .querySelectorAll("[data-console]")
    .forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        try {
          await invoke("open_external", { url: (b as HTMLElement).dataset.console });
        } catch (e) {
          await sure(t("브라우저를 열지 못했습니다"), errText(e), t("닫기"));
        }
      };
    });

  $("keyrows")
    .querySelectorAll("[data-delkey]")
    .forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        const p = (b as HTMLElement).dataset.delkey!;
        await invoke("delete_api_key", { provider: p });
        await refreshKeys();
      };
    });
}

async function refreshKeys() {
  try {
    const st = await invoke<any>("api_key_status");
    const models = await invoke<any>("model_settings").catch(() => ({}));
    renderKeyRows(st, models);
    const have = [...Object.keys(PROVIDERS), "custom"].filter((p) => st[p]);
    const labelOf = (p: string) =>
      p === "custom" ? st.custom_label || "커스텀" : PROVIDERS[p][0];

    // Keep the current pick if its key is still there; otherwise fall back to
    // whatever is available. Silently switching providers on someone who chose
    // one would show up as a surprise bill on the wrong account.
    const sel = $("ai-pick") as HTMLSelectElement;
    const previous = sel.value;
    sel.innerHTML = have.map((p) => `<option value="${p}">${labelOf(p)}</option>`).join("");
    if (have.includes(previous)) sel.value = previous;
    aiProvider = sel.value || null;

    $("key-note").textContent = have.length ? `${have.length}곳 연결됨` : "아직 없습니다";
    // 대화창은 쓸 수 있는 곳이 하나라도 있을 때만 의미가 있다.
    // 🔴 여태 API 키가 없으면 이 버튼을 **숨겼다.** 그러면 Ravi 가 있다는
    // 것을 알 길이 없다 — 키를 넣을 이유도 못 만난다.
    // 키가 없을 때는 대화창 안에서 그 자리에 넣게 되어 있으므로(chatNeedsKey),
    // 버튼은 **늘 보인다.**
    // 🔴 **여기서 무조건 켜면 안 된다.** `showPage` 가 라비 화면에서 숨긴
    //    것을 이 줄이 도로 켰다. 그러면 대화창 위에 그리로 가는 단추가
    //    떠 있고, 오른쪽 아래 내용을 가린다(그록 감사 2026-08-27).
    //    지금 어느 화면인지 보고 정한다.
    {
      const onRavi = document.getElementById("page-ravi")?.classList.contains("on");
      $("chat-open").style.display = onRavi ? "none" : "";
    }
    // 🔴 「자고 있다」의 뜻을 바꾼다.
    //
    // 여태 **API 키가 없으면** 라비가 잤다. 그리고 화면은 이렇게 말했다:
    // "Ravi 는 AI 회사의 열쇠 하나로 깨어납니다."
    //
    // 사장이 그 말에서 읽는 것은 **"이 프로그램의 본체는 남의 회사다"** 이다.
    // 그건 사실이 아닐 뿐 아니라(계산대·주문·QR·정산은 키 없이 전부 돈다),
    // 소스를 열고 "아무 회사도 안 낀다" 고 말하는 것과 정면으로 부딪힌다.
    //
    // 자는 얼굴은 **진짜로 장사가 멈춘 상태**에만 쓴다 — 노드가 꺼졌을 때.
    // 그때는 결제 확인이 안 되므로 자는 것이 사실이다.
    // AI 열쇠가 없는 것은 "잠"이 아니라 **"아직 못 하는 일이 있음"** 이고,
    // 그건 눌렀을 때 그 자리에서 말한다(`chatNeedsKey`).
    const nodeDown = !(nodeUp ?? true);
    const asleep = nodeDown;
    $("chat-open").classList.toggle("asleep", asleep);
    const img = $("chat-open").querySelector("img");
    if (img) (img as HTMLImageElement).src = asleep ? "/raven-sleep.webp" : "/raven-head.webp";
    const lbl = $("chat-open").querySelector("span");
    if (lbl) {
      lbl.textContent = asleep
        ? (nodeWarming ? "노드가 여는 중이에요" : "노드가 꺼져 있어요")
        : have.length
          ? "라비에게 물어보기"
          // 키가 없어도 라비는 깨어 있다. 다만 할 수 있는 일이 적다.
          : "라비에게 물어보기";
    }
    // Without a key the AI boxes are dead weight; say why rather than failing
    // on click.
    ["ai-shop-note", "ai-menu-note"].forEach((id) => {
      if (!aiProvider) $(id).textContent = "설정에서 API 키를 넣으면 켜집니다";
      else if ($(id).textContent?.startsWith("설정에서")) $(id).textContent = "";
    });
  } catch {}
}

/// 지금 시세. 메뉴 가격 옆에 RVN 환산이 붙는 근거다.
async function showRate() {
  const cur = ($("mn-cur") as HTMLSelectElement).value;
  if (cur === "RVN") {
    $("mn-rate").textContent = "";
    renderMenu();
    return;
  }
  try {
    const r = await invoke<any>("rvn_rate", { currency: cur });
    const per = cur === "KRW" ? r.rate.toFixed(2) : r.rate.toFixed(6);
    $("mn-rate").innerHTML =
      `1 RVN = ${r.symbol}${per} · ${(r.sources || []).join("·")}` +
      // 두 거래소가 크게 어긋나면 어느 쪽도 믿을 수 없다.
      (r.unstable ? ` <span style="color:var(--warn)">시세가 흔들립니다</span>` : "");
  } catch (e) {
    $("mn-rate").innerHTML = `<span style="color:var(--warn)">시세를 못 가져왔습니다</span>`;
  }
  renderMenu();
}

async function saveKeys() {
  const btn = $("key-save") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const cu = ($("cu-url") as HTMLInputElement).value.trim();
    if (cu) {
      await invoke("save_custom_provider", {
        label: ($("cu-label") as HTMLInputElement).value.trim(),
        baseUrl: cu,
        model: ($("cu-model") as HTMLInputElement).value.trim(),
        key: ($("cu-key") as HTMLInputElement).value.trim(),
      });
      ($("cu-key") as HTMLInputElement).value = "";
    }
    for (const p of Object.keys(PROVIDERS)) {
      const el = document.getElementById(`key-${p}`) as HTMLInputElement | null;
      if (el && el.value.trim()) {
        await invoke("save_api_key", { provider: p, key: el.value.trim() });
        el.value = "";
      }
      const m = document.getElementById(`model-${p}`) as HTMLInputElement | null;
      if (m) await invoke("save_model", { provider: p, model: m.value.trim() });
    }
    await refreshKeys();
  } catch (e) {
    $("key-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
  }
  btn.disabled = false;
}

// ── AI 대화 ──
//
// The model returns a reply plus a list of edits. Edits are applied here, in
// this file, from a fixed whitelist — the model cannot name a function, only
// pick from a list this code already knows how to do. Nothing on that list
// spends, burns, or issues.

const chatHistory: any[] = [];

function chatSay(who: "me" | "ai" | "did", text: string) {
  chatPut(who, escapeHtml(text).replace(/\n/g, "<br />"));
}

/// 이미 escape 된 HTML 을 넣을 때. 나눠 둔 이유: `chatSay` 는 textContent 라
/// 안전했지만, 굵게·줄바꿈을 쓰려고 태그를 넘긴 자리들이 **태그 글자 그대로**
/// 화면에 나오고 있었다. 안전한 기본값과 의도적인 HTML 을 함수로 가른다.
function chatHtml(who: "me" | "ai" | "did", html: string) {
  chatPut(who, html);
}

function chatPut(who: "me" | "ai" | "did", html: string) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  // Ravi 가 말한 것은 Ravi 얼굴을 달고 나온다. 누가 말하는지가 보이면
  // 대화가 도구 출력이 아니라 대화로 읽힌다.
  div.innerHTML =
    who === "ai"
      ? `<img class="msgravi" src="/raven-head.webp" alt="" /><div class="msgtxt">${html}</div>`
      : `<div class="msgtxt">${html}</div>`;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

const SHOP_FIELDS: Record<string, string> = {
  name_ko: "sh-ko",
  name_en: "sh-en",
  name_ja: "sh-ja",
  name_zh: "sh-zh",
  description: "sh-desc",
  location: "sh-loc",
  phone: "sh-phone",
  asset: "sh-asset",
  // 🔴 돈 받을 주소(`sh-addr`)와 소각 확인칸(`sh-confirm`)은 **일부러 없다.**
  // 그 둘은 틀리면 되돌릴 수 없다 — 라비가 채우면 사장은 화면에 뜬 것을
  // 확인이라 여기고 그대로 누른다.
  order_url: "sh-orderurl",
};

/**
 * **라비가 가리킬 수 있는 자리들.**
 *
 * ## 🔴 왜 목록으로 두나
 *
 * 대표님: "어려우면 무조건 라비 버튼 누르고 도움을 받을 수 있게 말야.
 *          라비가 이 프로그램을 다 조정해 줄 수 있게. **승인은 사람이 누르고**
 *          라비가 버튼 알려주면 반짝거리거나 하이라이트로 알려주는 거지."
 *
 * 그 말대로 만든다. 다만 **라비가 화면 이름을 지어내게 두지 않는다.**
 * AI 는 그럴듯한 이름을 잘 만들어 내고, 없는 자리를 가리키면 사장은
 * 「라비가 시킨 대로 했는데 아무 일도 안 난다」를 겪는다. 그게 제일 나쁘다.
 *
 * 여기 적힌 것만 가리킬 수 있다. 목록에 없으면 조용히 무시한다.
 *
 * ## ⚠️ **누르지는 않는다**
 *
 * 데려가고 반짝이는 데까지가 라비의 일이다. **누르는 것은 사람이 한다** —
 * 돈이 나가는 일, 체인에 새기는 일이 여기 섞여 있다.
 */
// 🔴 화면을 큰 메뉴에서 내릴 때마다 밟는 함정: **가는 길이 하나도 안 남는다.**
//    켤 때 확인한다 — 길이 없어지면 그 화면은 있어도 없는 것이다.
if (typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
  bindQrCopy();
  bindMoving();
    for (const page of ["door", "shop", "wallet"]) {
      const 길 = document.querySelectorAll(`[data-page="${page}"],[data-goto="${page}"]`).length;
      if (!길) console.error(`[배선] ${page} 화면으로 가는 길이 하나도 없습니다.`);
    }
  });
}

/**
 * 창을 안 보고 있으면 **화면 그리는 일을 쉰다.**
 *
 * 🔴 실측(2026-08-29): `document.hidden` 을 보는 코드가 **한 군데도 없었다.**
 *    사장이 창을 내려놓아도 아래가 계속 돌았다 —
 *
 *      4초  채굴 상태      5초  부품 상태(노드 RPC 7건)
 *      8초  돕기 화면      20초 상태 점            30초 건강·네트워크·주문
 *
 *    이 앱은 카운터에 **하루 8~14시간** 켜져 있고, 그 컴퓨터는 대개 낡았다.
 *    화면을 안 보는 동안 노드를 5초마다 때리는 것이 이 앱에서 가장 비쌌다.
 *
 * ⚠️ **타이머를 멈추지 않는다.** 멈췄다 켜는 코드는 「다시 켜는 것을 잊는」
 *    버그를 부른다. 대신 **그리는 함수가 스스로 쉰다** — 타이머는 돌지만
 *    아무 일도 안 한다. 창을 다시 보면 다음 주기에 저절로 살아난다.
 *
 * ⚠️ **일하는 것은 안 쉰다.** 자동 발송·백업·정산은 화면과 무관하게 돌아야
 *    한다. 이 함수는 **그리는 것**에만 쓴다.
 */
/**
 * QR 창의 주소를 눌러서 복사한다.
 *
 * 🔴 **가장 많이 뿌리는 링크인데 복사 버튼이 없었다.** 가게 QR 창의 주소는
 *    `<code>` 글자일 뿐이었고, 사장은 11.5px 글자를 손으로 긁어야 했다.
 *    카톡에 보내려면 그것부터 해야 하는데 40~70대에게는 그게 벽이다.
 *
 * ⚠️ 화면을 다시 그려도 살아 있어야 하므로 **문서 전체에 한 번만** 건다.
 */
/**
 * 어디서든 같은 방식으로 나눈다 — **QR 과 링크 둘 다.**
 *
 * 🔴 대표님: "공유 기능이 QR로도 되고 링크로도 되어야해."
 *
 *    여태 자리마다 달랐다. 이야기 방은 링크만, 가게 QR 은 그림만, 물건 팔기는
 *    SNS 버튼만. 사장은 **같은 일을 자리마다 다르게** 배워야 했다.
 *
 *    · **QR** — 손님이 눈앞에 있을 때. 화면을 보여 주면 끝이다
 *    · **링크** — 손님이 멀리 있을 때. 카톡·문자로 보낸다
 *
 *    둘 다 필요하고, 둘 다 **한 자리에** 있어야 한다.
 *
 * ⚠️ 공유 시트(`navigator.share`)에 기대지 않는다. 맥 시트에는 「복사」가
 *    없다(2026-08-29 실측). 복사는 우리가 준다.
 */
async function shareBox(host: HTMLElement, url: string, msg: string, name: string): Promise<void> {
  const has = typeof (navigator as any).share === "function";
  host.innerHTML =
    `<div class="invbox">` +
    `<div class="shareqr" id="sq-qr">${escapeHtml(t("QR 만드는 중…"))}</div>` +
    `<p class="meta">${escapeHtml(t("손님이 앞에 계시면 이 QR 을 보여 주세요."))}</p>` +
    `<code class="invlink" id="sq-url">${escapeHtml(url)}</code>` +
    `<div class="invbtns">` +
    `<button class="primary" id="sq-copy">${escapeHtml(t("링크 복사"))}</button>` +
    (has ? `<button class="ghost" id="sq-send">${escapeHtml(t("다른 앱으로"))}</button>` : "") +
    `<button class="ghost" id="sq-png">${escapeHtml(t("QR 그림 저장"))}</button>` +
    `</div></div>`;

  // QR 은 늦게 와도 된다 — 링크는 이미 눌러 쓸 수 있다.
  void invoke<string>("qr_svg", { text: url })
    .then((svg) => {
      const box = document.getElementById("sq-qr");
      if (box) box.innerHTML = svg;
    })
    .catch(() => {
      const box = document.getElementById("sq-qr");
      // ⚠️ QR 이 안 되어도 **링크는 살아 있다.** 그렇다고 말한다.
      if (box) box.textContent = t("QR 을 만들지 못했습니다. 아래 링크는 그대로 쓰실 수 있습니다.");
    });

  const copy = document.getElementById("sq-copy") as HTMLButtonElement | null;
  copy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(msg);
      copy.textContent = t("복사했습니다");
    } catch {
      const el = document.getElementById("sq-url");
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      copy.textContent = t("직접 복사해 주세요");
    }
    setTimeout(() => (copy.textContent = t("링크 복사")), 2500);
  });
  document.getElementById("sq-send")?.addEventListener("click", () => {
    void (navigator as any).share({ title: name, text: msg, url }).catch(() => {});
  });
  document.getElementById("sq-png")?.addEventListener("click", () => {
    // 인쇄해서 문에 붙이는 사장이 있다. SVG 를 그대로 내려준다.
    const svg = document.getElementById("sq-qr")?.innerHTML || "";
    if (!svg.includes("<svg")) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w가-힣.-]+/g, "_")}-QR.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
}

/**
 * 가게를 다른 컴퓨터로 옮긴다.
 *
 * 🔴 대표님: 노트북은 들고 다녀서 꺼지고, 406호는 계속 켜져 있다.
 *    손님은 언제 올지 모르니 **가게는 항상 켜진 쪽**에 있어야 한다.
 *
 * ⚠️ 사장에게 두 번 판단하게 하지 않는다. 보낼 때 「전부/가게만」을 골랐으면,
 *    받는 쪽은 **묻지 않고 짐에 든 것을 그대로** 되살린다.
 */
function bindMoving(): void {
  const box = () => document.getElementById("mv-box");
  const 보내기 = async (what: string) => {
    const b = box();
    if (!b) return;
    b.innerHTML = `<p class="meta">${escapeHtml(t("짐을 싸는 중… 잠시 걸립니다"))}</p>`;
    try {
      const r = await invoke<any>("move_offer", { what });
      const 주소 = (r.hosts || []).slice(0, 3);
      b.innerHTML =
        `<div class="invbox">` +
        `<p class="meta">${escapeHtml(String(r.say || ""))}</p>` +
        `<p style="font-size:15px;margin:10px 0 4px">${escapeHtml(t("새 컴퓨터에서 「가져오기」를 누르고 아래를 넣으세요."))}</p>` +
        `<code class="invlink">${escapeHtml(t("컴퓨터 주소"))}: ${escapeHtml(주소.join(t(" 또는 ")))}</code>` +
        `<div style="font-size:34px;font-weight:700;letter-spacing:6px;text-align:center;margin:12px 0">${escapeHtml(String(r.code))}</div>` +
        `<p class="meta">${escapeHtml(t("이 숫자는"))} ${escapeHtml(String(r.minutes))}${escapeHtml(t("분 뒤에 사라집니다. 세 번 틀리면 처음부터 다시 하셔야 합니다."))}</p>` +
        `<div class="invbtns"><button class="ghost" id="mv-cancel">${escapeHtml(t("그만두기"))}</button></div>` +
        `</div>`;
      document.getElementById("mv-cancel")?.addEventListener("click", () => {
        void invoke("move_cancel").catch(() => {});
        if (box()) box()!.innerHTML = "";
      });
    } catch (e) {
      b.innerHTML = `<p class="danger">${escapeHtml(errText(e))}</p>`;
    }
  };

  document.getElementById("mv-all")?.addEventListener("click", () => void 보내기("all"));
  document.getElementById("mv-shop")?.addEventListener("click", () => void 보내기("shop"));

  document.getElementById("mv-get")?.addEventListener("click", () => {
    const b = box();
    if (!b) return;
    b.innerHTML =
      `<div class="invbox">` +
      `<p class="meta">${escapeHtml(t("옛 컴퓨터 화면에 뜬 주소와 숫자를 넣으세요."))}</p>` +
      `<div class="rm-newbox"><input id="mv-host" placeholder="192.168.0.15" autocomplete="off" /></div>` +
      `<div class="rm-newbox"><input id="mv-code" placeholder="000000" inputmode="numeric" maxlength="6" autocomplete="off" />` +
      `<button class="btn" id="mv-go">${escapeHtml(t("가져오기"))}</button></div>` +
      `<p class="meta" id="mv-say"></p></div>`;
    const go = async () => {
      const host = (document.getElementById("mv-host") as HTMLInputElement)?.value.trim() || "";
      const code = (document.getElementById("mv-code") as HTMLInputElement)?.value.trim() || "";
      const say = document.getElementById("mv-say");
      const btn = document.getElementById("mv-go") as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      if (say) say.textContent = t("받는 중… 짐이 크면 몇 분 걸립니다");
      try {
        const r = await invoke<any>("move_fetch", { host, code });
        if (say)
          say.innerHTML =
            `<b class="ok">${escapeHtml(t("옮겼습니다."))}</b> ` +
            // 🔴 이 말을 안 하면 사장이 자산을 새로 만든다. 100 RVN 이 타고
            //    손님이 아는 QR 이 죽는다.
            `<b>${escapeHtml(String(r.warn || ""))}</b><br />` +
            escapeHtml(t("프로그램을 한 번 껐다 켜 주세요."));
      } catch (e) {
        if (say) say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    document.getElementById("mv-go")?.addEventListener("click", () => void go());
    document.getElementById("mv-code")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void go();
    });
  });
}

function bindQrCopy(): void {
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement)?.closest?.(".qrurl") as HTMLElement | null;
    if (!el) return;
    const url = (el.textContent || "").trim();
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        const 원래 = el.dataset.o || (el.dataset.o = el.textContent || "");
        el.textContent = t("복사했습니다 — 카톡·문자에 붙여넣으세요");
        setTimeout(() => (el.textContent = 원래), 2000);
      })
      .catch(() => {
        // 클립보드가 막힌 기계도 있다. 그때는 글자를 골라 준다.
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      });
  });
}

function 쉬는중(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

const RAVI_SPOTS: Record<string, { page: string; el?: string; say: string }> = {
  "새 자산 만들기": { page: "assets", el: "as-new", say: "회원권·쿠폰·굿즈를 만드는 곳입니다" },
  "가게 열기": { page: "shop", el: "sh-save", say: "손님이 볼 화면을 여는 곳입니다" },
  "문 등록": { page: "door", el: "dr-doors", say: "입구 문을 등록하는 곳입니다" },
  "회원 등록": { page: "door", el: "dr-new", say: "회원을 등록하는 곳입니다" },
  "이야기 방 만들기": { page: "talk", el: "tk-newroom", say: "방을 만드는 곳입니다" },
  "방 초대하기": { page: "talk", el: "tk-inv", say: "초대 링크를 만드는 곳입니다" },
  "이 컴퓨터 준비하기": { page: "parts", el: "pc-go", say: "백신·방화벽·메모리를 한 번에 정합니다" },
  "노드 상태": { page: "parts", say: "노드가 어떤지 보는 곳입니다" },
  // 🔴 대표님: "라비가 이걸 어떻게 사용하는지도 다 설명이 가능해야해"
  //    1차 메뉴 중 **「나눠주기」와 「내 가게」를 라비가 못 가리켰다.**
  //    누가 「자산 가진 사람들한테 나눠주려면 어디로 가?」 하고 물으면
  //    라비가 아무 데도 못 가리켰다는 뜻이다.
  // ⚠️ 1차 메뉴에서는 내렸다(`index.html` 참고). 그래도 라비는 그대로
  //    가리킨다 — `raviPoint` 는 메뉴를 누르는 것이 아니라 `showPage` 로
  //    화면을 여니까(`door` 도 같은 상태로 살아 있다).
  //    다만 **어디서 들어가는지**를 말해 준다. 안 그러면 라비가 데려다 준
  //    뒤에 사장이 「다음에 혼자 어떻게 오지」를 모른다.
  "나눠주기": {
    page: "reward",
    say: "자산을 가진 사람들에게 RVN 을 나눠 주는 곳입니다. 평소에는 「자산」에서 자산을 고르면 나오는 「나눠주기」로 들어오시면 됩니다",
  },
  "내 가게": { page: "shop", say: "주문·메뉴판·출입·매출이 다 여기 있습니다" },
  "지갑": { page: "wallet", say: "받은 돈과 보낼 곳입니다" },
  "백업": { page: "settings", el: "bk-go", say: "12단어와 지갑을 지키는 곳입니다" },
  "손님 받기 순서": { page: "shop", el: "sh-flow", say: "무엇이 남았는지 여기 있습니다" },
};

/**
 * 그 자리로 데려가고 **잠깐 반짝인다.**
 *
 * ⚠️ 데려가기만 하면 그 화면에도 칸이 여럿이라 또 못 찾는다. 대표님이
 *    실제로 두 번 못 찾으셨다(0.1.50). 그래서 가운데로 올리고 반짝인다.
 */
/** 1차 메뉴의 사람 말 이름. 「어느 탭인지」를 말풍선에 적는다. */
const PAGE_NAMES: Record<string, string> = {
  ravi: "라비", talk: "이야기", wallet: "지갑", assets: "자산",
  reward: "나눠주기", shop: "내 가게", parts: "이 컴퓨터", msg: "이야기",
  door: "출입", settings: "설정",
};

/**
 * **데려다 준 뒤 라비가 남는다.**
 *
 * 🔴 대표님: "메뉴 이동했는데 라비가 따라 다니지도 않는데."
 *    "뭐 하이라이트도 없고 갑자기 나눠주기가 나오네."
 *
 *    둘 다 사실이었고, 둘 다 **적혀 있는데 안 돌던 것**이다:
 *
 *    · `spot.say`(라비가 할 말)를 자리 열다섯 곳에 적어 두고 **한 번도
 *      화면에 안 그렸다.** 그냥 조용히 화면만 바뀌었다.
 *    · `classList.add("flash")` 를 네 곳에서 부르는데 **`.flash` 를 정의한
 *      CSS 가 한 곳도 없었다.** 브라우저는 모르는 클래스를 조용히 넘어간다.
 *
 * 말풍선은 **화면(page)이 아니라 body 에** 붙는다. 그래야 탭을 옮겨도
 * 같이 간다 — 라비를 화면으로 만들어 둔 것이 애초에 사라지는 이유였다.
 */
function raviBubble(pageId: string, say: string) {
  document.getElementById("ravibub")?.remove();
  const box = document.createElement("div");
  box.className = "ravibub";
  box.id = "ravibub";
  const 어디 = PAGE_NAMES[pageId] || pageId;
  box.innerHTML =
    `<img src="/raven-face.webp" alt="" />` +
    `<div class="rb"><div class="rbwhere">${escapeHtml(t("여기는"))} · ${escapeHtml(t(어디))}</div>` +
    `<div class="rbsay">${escapeHtml(say)}</div></div>` +
    `<button class="rbx" type="button" aria-label="${escapeHtml(t("닫기"))}">✕</button>`;
  box.querySelector(".rbx")!.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

function raviPoint(spot: { page: string; el?: string; say: string }) {
  showPage(spot.page);
  // 🔴 **말을 먼저 띄운다.** 자리를 못 찾아도 설명은 남아야 한다 —
  //    데려다 놓고 아무 말도 없으면 「갑자기 화면이 바뀌었다」가 된다.
  if (spot.say) raviBubble(spot.page, spot.say);
  if (!spot.el) return;
  let tries = 0;
  const look = window.setInterval(() => {
    const el = document.getElementById(spot.el!);
    if (el) {
      window.clearInterval(look);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 2600);
    } else if (++tries > 40) {
      window.clearInterval(look);
    }
  }, 120);
}

/**
 * **라비 얼굴이 지금 상황을 말한다.**
 *
 * 대표님: "라비의 동적 인터랙티브 움직임이 프로그램의 감정을 표현하듯이
 *          움직이면 사람들에게 더 사랑받을 것 같은데."
 *
 * 그림은 이미 일곱 장 있었다(happy·worry·wait·sleep·hello·face·head).
 * **만들어 놓고 두 장만 쓰고 있었다** — 이 저장소에서 오늘만 스무 번 본 병이다.
 *
 * ⚠️ 얼굴로 **거짓말하지 않는다.** 노드가 죽었는데 웃고 있으면 사장은
 *    괜찮은 줄 안다. 걱정스러우면 걱정스러운 얼굴이어야 한다.
 */
function raviMood(): string {
  if (!nodeUp && !nodeWarming) return "/raven-worry.webp";
  if (nodeWarming) return "/raven-wait.webp";
  if (setupState && !setupState.ready) return "/raven-hello.webp";
  return "/raven-happy.webp";
}

function paintRaviFace() {
  const img = document.querySelector<HTMLImageElement>("#chat-open img");
  if (img) img.src = raviMood();
}

function applyActions(actions: any[]): string[] {
  const done: string[] = [];
  for (const a of actions || []) {
    try {
      switch (a.type) {
        // 🔴 **라비가 단추를 가리킨다. 누르지는 않는다.**
        //    승인은 사람이 한다 — 돈이 나가는 일이 섞여 있다.
        case "point": {
          const spot = RAVI_SPOTS[String(a.spot || "")];
          if (!spot) break; // 지어낸 이름은 조용히 무시한다
          raviPoint(spot);
          done.push(`${a.spot} — ${spot.say}`);
          break;
        }
        case "shop_set": {
          const id = SHOP_FIELDS[a.field];
          if (!id) break;
          ($(id) as HTMLInputElement).value = String(a.value ?? "");
          done.push(`${a.field} → ${a.value}`);
          break;
        }
        // 사장이 **제일 자주 하는 일**이다 — "오늘 쉰다", "재료 떨어졌다".
        // 체크박스를 찾는 것보다 말하는 편이 확실히 빠르고, 틀려도 값이 0이다
        // (다시 켜면 그만이고 체인에 남지 않는다).
        case "closed": {
          const box = $("sh-closednow") as HTMLInputElement | null;
          const note = $("sh-closednote") as HTMLInputElement | null;
          if (!box) break;
          box.checked = !!a.today;
          // 이유를 같이 적는다. 닫힌 문만 보는 것과 "재료가 떨어졌습니다" 를
          // 보는 것은 손님에게 아주 다른 일이다.
          if (note && typeof a.note === "string") note.value = a.note.slice(0, 60);
          done.push(a.today ? `오늘 쉼${a.note ? ` — ${a.note}` : ""}` : "다시 엽니다");
          break;
        }
        // 🔴 홈 화면을 사장이 늘린다. 우리가 정한 여덟 개가 전부가 아니다.
        //    다만 **말 한 줄을 저장하는 것**뿐이라 위험한 값이 아니고,
        //    이 컴퓨터를 벗어나지 않는다.
        case "tile_add": {
          const label = String(a.label || "").trim().slice(0, 8);
          const say = String(a.say || "").trim();
          if (!label || !say) break;
          const now = myTiles().filter((m) => m.label !== label);
          if (now.length >= 8) {
            done.push("단추가 여덟 개까지입니다. 하나 지우고 다시 말씀해 주세요.");
            break;
          }
          now.push({ label, sub: String(a.sub || "").trim().slice(0, 14) || "눌러서 시키기", say });
          setMyTiles(now);
          paintRavi();
          done.push(`「${label}」 단추를 홈에 만들었습니다`);
          break;
        }
        // 🔴 라비가 대신 보내지 않는다. 창을 **열어 주기만** 한다.
        //    무엇이 같이 가는지 보고 사장이 누르는 것이 맞다 —
        //    모르는 사이에 이 컴퓨터의 형편이 나가면 그건 수집이다.
        case "report": {
          openReport(String(a.text || "").slice(0, 400));
          done.push("문제 알리기 창을 열었습니다");
          break;
        }
        case "tile_remove": {
          const label = String(a.label || "").trim();
          const before = myTiles().length;
          setMyTiles(myTiles().filter((m) => m.label !== label));
          if (myTiles().length !== before) {
            paintRavi();
            done.push(`「${label}」 단추를 지웠습니다`);
          }
          break;
        }
        case "shop_flag": {
          const id = a.field === "delivery" ? "sh-delivery" : "sh-pickup";
          ($(id) as HTMLInputElement).checked = !!a.value;
          done.push(`${a.field === "delivery" ? "배달" : "매장·포장"} ${a.value ? "켬" : "끔"}`);
          break;
        }
        case "menu_add": {
          // 🔴 기간·재고는 **적힌 것만** 담는다. 없는 값을 0 으로 채우면
          //    커피가 「품절」이 되고(재고 0), 이용권이 「0일짜리」가 된다.
          const months = Number(a.pass_months || 0);
          const days = Number(a.pass_days || 0);
          menuItems.push({
            name: a.name || "",
            name_en: a.name_en || "",
            price: a.price ?? null,
            image: null,
            kind: months > 0 || days > 0 ? "pass" : a.stock != null ? "stock" : undefined,
            pass_months: months > 0 ? months : null,
            pass_days: days > 0 ? days : null,
            stock: a.stock == null ? null : Math.max(0, Math.floor(Number(a.stock)) || 0),
          });
          done.push(`메뉴 추가: ${a.name}`);
          break;
        }
        case "menu_set":
          if (menuItems[a.index]) {
            // 숫자 칸은 숫자로. 빈 값은 **0 이 아니라 없음**이다 —
            // 재고를 0 으로 만들면 팔던 물건이 품절로 뜬다.
            const numeric = ["price", "pass_months", "pass_days", "stock"].includes(a.field);
            menuItems[a.index][a.field] =
              !numeric ? a.value
              : a.value === "" || a.value == null ? null
              : Number(a.value);
            if (["pass_months", "pass_days"].includes(a.field)) menuItems[a.index].kind = "pass";
            if (a.field === "stock" && menuItems[a.index].kind !== "pass") menuItems[a.index].kind = "stock";
            done.push(`${a.index + 1}번 ${a.field} → ${a.value}`);
          }
          break;
        case "menu_remove":
          if (menuItems[a.index]) {
            done.push(`메뉴 삭제: ${menuItems[a.index].name}`);
            menuItems.splice(a.index, 1);
          }
          break;
        case "menu_clear":
          // 🔴 라비가 **혼자서** 할 수 있는 유일한 파괴적 동작이었다.
          // 돈은 아니지만 사장이 하루 걸려 넣은 메뉴가 한 번에 사라지고,
          // 되돌릴 방법이 없다. 말로 시킨 것과 시킨 줄 아는 것은 다르다.
          if (menuItems.length && !confirm(
            `메뉴 ${menuItems.length}개를 전부 지울까요?\n되돌릴 수 없습니다.`,
          )) {
            done.push("메뉴 지우기를 그만두었습니다");
            break;
          }
          done.push(`메뉴 ${menuItems.length}개 모두 지움`);
          menuItems.length = 0;
          break;
        case "issue_set": {
          const id = { name: "i-name", qty: "i-qty", units: "i-units" }[
            a.field as string
          ];
          if (a.field === "reissuable") {
            ($("i-reissuable") as HTMLInputElement).checked = !!a.value;
            done.push(`재발행 ${a.value ? "가능" : "불가"}`);
          } else if (id) {
            ($(id) as HTMLInputElement).value = String(a.value ?? "");
            done.push(`발행 ${a.field} → ${a.value}`);
            // 이름이 바뀌면 체인에 이미 있는지 다시 확인해야 한다.
            if (a.field === "name") checkIssueName();
          }
          break;
        }
        case "go":
          if (["assets", "wallet", "issue", "shop", "order", "settings"].includes(a.screen)) {
            showPage(a.screen);
            done.push(`${a.screen} 화면으로 이동`);
          }
          break;

        // 🔴 이 케이스가 **없었다.** 라비에게는 색 바꾸는 법을 7줄에 걸쳐
        // 가르쳐 놓고(`ai.rs:321·329`), 받는 쪽이 비어 있었다. 뒤쪽은
        // 멀쩡히 있다(`shop.rs` theme_read/save, `server.rs` 경로).
        // **중간만 끊겨서**, 사장이 "가게 색 바꿔줘" 하면 라비는 바꿨다고
        // 답하고 아무 일도 일어나지 않았다. 거짓말을 하게 만든 셈이다.
        case "theme": {
          const hex = (v: unknown) =>
            /^[0-9a-f]{6}$/i.test(String(v ?? "")) ? `#${String(v)}` : "";
          const accent = hex(a.accent);
          const tint = hex(a.tint);
          if (!accent) break;
          // ⚠️ 옅은 accent 는 노드가 거절한다(`shop.rs`의 `ok_accent`) —
          // 흰 글자가 안 읽히는 주문 단추가 되기 때문이다. 거절당하면
          // 그 사실을 그대로 말한다. 조용히 넘기면 또 거짓말이 된다.
          // `applyActions` 는 동기 함수다. 여기서 기다리면 나머지 동작이
          // 멈추므로 보내 놓고, 결과는 대화창에 따로 적는다.
          void invoke("theme_save", { accent, tint: tint || null })
            .then(() => chatSay("ai", `가게 색을 ${accent} 로 바꿨습니다.`))
            .catch((e) =>
              chatSay("ai", `색을 못 바꿨습니다. ${String((e as Error)?.message || e)}`),
            );
          done.push(`가게 색 ${accent} 로 바꾸는 중`);
          break;
        }
        // 목록에 없는 것은 조용히 버린다. 모르는 동작을 추측해서 실행하면 안 된다.
      }
    } catch {}
  }
  if (done.length) renderMenu();
  return done;
}

// 무엇을 시킬 것인가. 여태 이 창은 양식 채우기 전용이라, 사장님이 "이거 어떻게
// 생각해" 라고 물으면 엉뚱하게 메뉴를 고쳤다.
let chatMode: "fill" | "ask" | "debate" = "fill";

/// 지금 무엇을 시키는 중인지. 이름만으로는 모자란다 —
/// 「둘에게」가 무엇 둘인지 대표가 물었고, 그건 이름이 틀렸다는 뜻이다.
const MODE_SAY: Record<string, string> = {
  fill:
    "가게 이름이나 메뉴를 <b>말로 알려주시면</b> 화면에 채워 드릴게요.<br />" +
    '<span class="muted">발행·전송·소각은 하지 못합니다. 그건 직접 누르셔야 합니다.</span>',
  ask: "무엇이든 물어보세요. <b>화면은 건드리지 않습니다.</b>",
  debate:
    "서로 다른 <b>AI 두 곳</b>에 같은 것을 묻고 <b>양쪽 답을 그대로</b> 보여 드려요.<br />" +
    '<span class="muted">한 곳만 물으면 답이 그럴듯해서 반박할 거리가 없습니다. ' +
    "두 답이 어긋나는 자리가 사장님이 정하실 자리예요.</span>",
};

const MODE_HINT: Record<string, string> = {
  fill: "아이스 아메리카노 4500원 넣어줘",
  ask: "레이븐코인으로 받으면 뭐가 좋아?",
  debate: "커피값을 4500원으로 올릴까?",
};

function setChatMode(m: "fill" | "ask" | "debate") {
  chatMode = m;
  $("chat-mode")
    .querySelectorAll<HTMLElement>("[data-mode]")
    .forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  ($("chat-q") as HTMLInputElement).placeholder = MODE_HINT[m];

  // 🔴 모드를 바꿀 때마다 안내가 **쌓이고 있었다.** 같은 말이 두 번 세 번
  // 남아, 방금 무엇을 고른 건지 알 수 없게 된다.
  // 안내는 **맨 위 한 줄만** 있고, 모드가 바뀌면 그 줄이 바뀐다.
  const log = $("chat-log");
  let intro = log.querySelector<HTMLElement>(".msg.intro");
  if (!intro) {
    intro = document.createElement("div");
    intro.className = "msg ai intro";
    log.prepend(intro);
  }
  intro.innerHTML =
    `<img class="msgravi" src="/raven-head.webp" alt="" /><div class="msgtxt">${MODE_SAY[m]}</div>`;
}

async function chatAsk(q: string) {
  chatHtml("ai", "<span class=\"muted\">생각하는 중…</span>");
  try {
    const r = await invoke<any>("ai_ask_owner", { provider: aiProvider, question: q });
    chatPopThinking();
    chatHtml("ai", escapeHtml(r?.text || "").replace(/\n/g, "<br />"));
  } catch (e: any) {
    chatPopThinking();
    chatHtml("ai", `<span class="warn">${escapeHtml(errText(e))}</span>`);
  }
}

async function chatDebate(q: string) {
  chatHtml("ai", "<span class=\"muted\">두 곳에 묻는 중…</span>");
  try {
    const r = await invoke<any>("ai_debate", { question: q });
    chatPopThinking();
    const one = (side: any) =>
      side?.error
        ? `<div><div class="who">${escapeHtml(side.provider || "?")}</div>
             <span class="warn">${escapeHtml(side.error)}</span></div>`
        : `<div><div class="who">${escapeHtml(side?.provider || "")}</div>
             ${escapeHtml(side?.text || "").replace(/\n/g, "<br />")}</div>`;
    chatHtml("ai", `<div class="duo">${one(r?.a)}${one(r?.b)}</div>`);
  } catch (e: any) {
    chatPopThinking();
    chatHtml("ai", `<span class="warn">${escapeHtml(errText(e))}</span>`);
  }
}

// "생각하는 중…" 을 지운다. 남겨 두면 대화가 기다림으로 채워진다.
function chatPopThinking() {
  const log = $("chat-log");
  const last = log.lastElementChild;
  if (last && last.textContent?.includes("중…")) last.remove();
}

/// 키가 없으면 **그 자리에서** 넣게 한다.
///
/// 여태 `if (!q || !aiProvider) return;` 이었다 — 사장이 질문을 치고 보내기를
/// 눌러도 **아무 일도 안 일어났다.** 조용한 실패는 고장으로 읽히고, 고장으로
/// 읽힌 기능은 다시 안 눌린다. 설정 화면으로 보내는 것도 답이 아니다 —
/// 하려던 말을 들고 다른 화면으로 가면 거기서 뭘 하려 했는지 잊는다.
/// 키가 없으면 Ravi 는 **자고 있다.**
///
/// 대표: "라비는 api 로 구동되니까 자고 있다가 API 셋업을 마치면 눈을 뜨는 거지"
///
/// 이 비유가 맞는 이유: 사장에게 "API 키가 없습니다" 는 오류로 읽히고,
/// 오류로 읽힌 화면은 다시 안 눌린다. **자고 있다**는 고장이 아니라 상태고,
/// 깨우는 방법이 있다는 뜻이다.
function chatNeedsKey() {
  const rows = Object.entries(PROVIDERS)
    .map(
      ([p, [label, ph, console_]]) =>
        `<div class="keyask">
           <span class="who">${escapeHtml(label)}</span>
           <input type="password" data-k="${p}" placeholder="${escapeHtml(ph)}" autocomplete="off" />
           <button class="ghost" data-console="${escapeHtml(console_)}">받기</button>
         </div>`,
    )
    .join("");
  chatHtml(
    "ai",
    `<div class="wake">
       <img src="/raven-sleep.webp" alt="" />
       <div>
         <b>말로 시키려면 열쇠가 하나 필요해요.</b><br />
         <span class="muted">주문·결제·QR·정산은 <b>지금도 전부 됩니다</b> —
         이건 그 위에 얹는 도우미예요. AI 회사에서 열쇠를 하나 받아
         넣으시면 말로 설정하고 물어보실 수 있어요.</span>
       </div>
     </div>
     <div class="muted" style="margin-top:10px;font-size:13px">
       [받기] 를 누르면 그 회사 페이지가 열립니다. 가입하고 키를 복사해
       아래 칸에 붙여 넣으세요.<br />
       키는 <b>이 컴퓨터에만</b> 저장됩니다(0600). 우리 서버로 가지 않아요.
     </div>
     ${rows}
     <button id="keyask-save" style="margin-top:10px;width:100%">깨우기</button>`,
  );

  const log = $("chat-log");
  log.querySelectorAll<HTMLElement>("[data-console]").forEach((b) => {
    b.onclick = () =>
      void invoke("open_external", { url: b.dataset.console }).catch(() => {});
  });
  const save = document.getElementById("keyask-save");
  if (save)
    save.onclick = async () => {
      let put = 0;
      for (const el of log.querySelectorAll<HTMLInputElement>("[data-k]")) {
        const v = el.value.trim();
        if (!v) continue;
        try {
          await invoke("save_api_key", { provider: el.dataset.k, key: v });
          put++;
          el.value = "";
        } catch (e) {
          chatHtml("ai", `<span class="warn">${escapeHtml(errText(e))}</span>`);
        }
      }
      if (!put) return chatSay("ai", "칸이 비어 있어요. 키를 붙여넣고 다시 눌러 주세요.");
      await refreshKeys();
      // 깨어나는 순간을 보여 준다. "됐어요" 한 줄보다 이게 기억에 남는다.
      chatHtml(
        "ai",
        `<div class="wake awake">
           <img src="/raven-hello.webp" alt="" />
           <div><b>안녕하세요, 라비예요.</b><br />
             <span class="muted">무엇이든 물어보세요. 가게 일이면 화면도 채워 드려요.</span>
           </div>
         </div>`,
      );
    };
}

async function chatSend() {
  const q = ($("chat-q") as HTMLInputElement).value.trim();
  if (!q) return;
  if (!aiProvider) {
    chatSay("me", q);
    ($("chat-q") as HTMLInputElement).value = "";
    return chatNeedsKey();
  }
  ($("chat-q") as HTMLInputElement).value = "";
  chatSay("me", q);

  if (chatMode === "ask") return chatAsk(q);
  if (chatMode === "debate") return chatDebate(q);

  const val = (id: string) => ($(id) as HTMLInputElement)?.value || "";
  const state = {
    shop: {
      name_ko: val("sh-ko"),
      name_en: val("sh-en"),
      description: val("sh-desc"),
      location: val("sh-loc"),
      asset: val("sh-asset"),
      pickup: ($("sh-pickup") as HTMLInputElement)?.checked,
      delivery: ($("sh-delivery") as HTMLInputElement)?.checked,
    },
    // 🔴 기간·재고도 보낸다. 안 보내면 라비가 「하루권 얼마야?」에 답을
    //    못 하고, 이미 있는 이용권을 또 만들라고 한다. 빈 값은 안 보낸다 —
    //    토큰만 늘고 뜻은 그대로다.
    menu: menuItems.map((m, i) => ({
      index: i,
      name: m.name,
      price: m.price,
      ...(m.pass_months ? { pass_months: m.pass_months } : {}),
      ...(m.pass_days ? { pass_days: m.pass_days } : {}),
      ...(m.stock != null ? { stock: m.stock } : {}),
    })),
    currency: ($("mn-cur") as HTMLSelectElement)?.value,
  };

  try {
    const r = await invoke<any>("ai_chat", {
      provider: aiProvider,
      message: q,
      state,
      // 마지막 몇 마디만 보낸다. 전부 보내면 매번 값이 늘어난다.
      history: chatHistory.slice(-6),
    });
    chatSay("ai", r.reply || "");
    const done = applyActions(r.actions);
    // 무엇을 바꿨는지 눈에 보여야 한다. 조용히 고치면 나중에 원인을 못 찾는다.
    if (done.length) chatSay("did", done.join(" · "));

    chatHistory.push({ role: "user", text: q }, { role: "assistant", text: r.reply || "" });
  } catch (e) {
    chatSay("ai", errText(e));
  }
}


/**
 * 말로 적은 것을 보고 **어떤 자산인지 라비가 고른다.**
 *
 * 🔴 `ai.rs` 에 이 안내가 완성돼 있었는데(여섯 종류·각 소각량·무엇이 영원한지·
 * 더 싼 대안까지) **부르는 코드가 없었다.** 만들어졌는데 길이 없던 것이다.
 *
 * 사장은 "회원권 만들고 싶다" 라고 말할 줄 알지 "유니크 자산" 이라는 말은
 * 모른다. 그 사이를 잇는 것이 이 함수다.
 *
 * ⚠️ **라비는 고르고 채우기만 한다.** 다음 단계로 자동으로 넘기지 않고,
 * 소각 단추를 대신 누르지도 않는다. 500 RVN 이 타고 이름은 영원하다 —
 * 그 마지막 한 번은 사람이 눌러야 하고, 그러려면 사람이 읽어야 한다.
 */

// ── 연습 ────────────────────────────────────────────────────────────────
//
// 🔴 요약 화면과 취소 창은 "이렇게 됩니다" 를 **말해 줄** 뿐이다. 직접 해
// 보는 것과는 다르고, 사람은 읽은 것보다 해 본 것을 안다. 그런데 사장이
// 발행을 처음 해 보는 자리가 **진짜 발행**이었다 — 500 RVN 이 타는 자리.
//
// regtest 로 사설 체인을 띄운다. 돈이 안 들고, 진짜 노드에 닿지도 않는다
// (포트 19766·폴더 「연습」 — `rehearse.rs` 의 시험이 그걸 지킨다).

async function rhSay(t: string, warn = false): Promise<void> {
  const el = $("rh-note");
  el.innerHTML = warn ? `<span class="danger">${escapeHtml(t)}</span>` : escapeHtml(t);
}

async function rhPaint(): Promise<void> {
  try {
    const st = await invoke<any>("rehearse_status");
    $("rh-out").innerHTML = st?.running
      ? `<div class="rhbadge">연습 중</div>
         <div class="meta" style="margin-top:6px">
           연습용 돈 ${Number(st.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} RVN ·
           만들어 본 자산 ${st.assets || 0}개
         </div>`
      : "";
  } catch {
    $("rh-out").innerHTML = "";
  }
}

function wireRehearse(): void {
  const start = document.getElementById("rh-start");
  if (!start) return;
  start.onclick = async () => {
    await rhSay("연습용 체인을 켜는 중…");
    try {
      await invoke("rehearse_start");
      // 돈이 없으면 발행이 안 된다. 켜자마자 만들어 둔다 — 묻지 않는다.
      await rhSay("연습용 돈을 만드는 중…");
      await invoke("rehearse_fund");
      await rhSay("준비됐습니다. 「이 이름으로 해 보기」를 눌러 보세요.");
      await rhPaint();
    } catch (e) {
      await rhSay(String((e as Error)?.message || e), true);
    }
  };

  (document.getElementById("rh-try") as HTMLElement).onclick = async () => {
    const name = ($("i-name") as HTMLInputElement).value.trim().toUpperCase();
    if (!name) return void rhSay("먼저 이름을 정해 주세요.", true);
    await rhSay(`「${name}」 을 연습으로 만드는 중…`);
    try {
      const r = await invoke<any>("rehearse_issue", {
        name,
        qty: parseFloat(($("i-qty") as HTMLInputElement).value) || 1,
        units: parseInt(($("i-units") as HTMLInputElement).value) || 0,
        reissuable: ($("i-reissuable") as HTMLInputElement).checked,
      });
      // ⚠️ 여기서 "발행했습니다" 라고만 쓰면 진짜와 헷갈린다. 연습이라고 적는다.
      await rhSay(
        `연습으로 만들었습니다. 진짜로 하시면 이대로 됩니다. (연습용 잔액 ${
          Number(r?.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
        } RVN)`,
      );
      await rhPaint();
    } catch (e) {
      // 연습에서 실패하는 편이 훨씬 낫다. 이유를 그대로 보여 준다.
      await rhSay(
        `연습에서 막혔습니다 — 진짜로 했어도 같았을 것입니다.\n${String((e as Error)?.message || e)}`,
        true,
      );
    }
  };

  (document.getElementById("rh-reset") as HTMLElement).onclick = async () => {
    if (!confirm("연습한 것을 전부 지울까요?\n연습이라 아무것도 잃지 않습니다.")) return;
    await rhSay("지우는 중…");
    try {
      await invoke("rehearse_reset");
      await rhSay("지웠습니다. 「연습 시작」부터 다시 하시면 됩니다.");
      await rhPaint();
    } catch (e) {
      await rhSay(String((e as Error)?.message || e), true);
    }
  };
}

async function aiPickIssue(): Promise<void> {
  const input = ($("ai-issue") as HTMLInputElement).value.trim();
  const note = $("ai-issue-note");
  const out = $("ai-issue-out");
  if (!input) {
    note.textContent = "무엇을 만들고 싶으신지 한 줄만 적어 주세요.";
    return;
  }
  if (!aiProvider) {
    note.textContent = "설정에서 AI 열쇠를 넣으시면 라비가 골라 드립니다.";
    return;
  }
  note.textContent = "생각하는 중…";
  out.innerHTML = "";
  try {
    const r = await invoke<any>("ai_fill", { provider: aiProvider, task: "issue", input });

    // 무엇을 만들지 못 정했으면 되묻는다. 억지로 하나 고르면 그게 500 RVN 이 된다.
    if (!r?.kind) {
      note.textContent = "";
      out.innerHTML = `<div class="aipick">
        <div class="k">조금 더 알려 주세요</div>
        <div class="row2">${escapeHtml(r?.why || "무엇에 쓰실 것인지 한 줄만 더 적어 주세요.")}</div>
      </div>`;
      return;
    }

    // 🔴 라비가 만들 수 없는 종류를 고르면 여기서 막는다. 화면이 그 종류를
    //    안 갖고 있으면 사장은 "골라 줬는데 없다" 를 겪는다.
    const KNOWN: Record<string, string> = {
      root: "가게·브랜드 (루트)",
      sub: "브랜드 아래 상품 (하위)",
      unique: "한 사람에 하나 (유니크)",
      qualifier: "자격 배지",
      restricted: "제한 자산",
    };
    const label = KNOWN[String(r.kind)];
    if (!label) {
      note.textContent = "";
      out.innerHTML = `<div class="aipick">
        <div class="k">이건 아직 이 화면에서 못 만듭니다</div>
        <div class="row2">라비가 <b>${escapeHtml(String(r.kind))}</b> 를 골랐는데
          이 프로그램에 그 종류가 없습니다. 아래에서 직접 골라 주세요.</div>
      </div>`;
      return;
    }

    const burn = Number(r.burn_rvn) || 0;
    note.textContent = "";
    out.innerHTML = `<div class="aipick">
      <div class="k">${escapeHtml(label)}</div>
      <div class="row2">${escapeHtml(String(r.why || ""))}</div>
      <div class="row2">태울 돈 <span class="burn">${burn} RVN</span>
        ${r.name ? ` · 이름 <code>${escapeHtml(String(r.name))}</code>` : ""}</div>
      ${r.permanent ? `<div class="row2">🔴 ${escapeHtml(String(r.permanent))}</div>` : ""}
      ${r.alternative ? `<div class="row2 muted">${escapeHtml(String(r.alternative))}</div>` : ""}
      <div class="row2 muted">아래에서 <b>직접 고르셔야</b> 다음으로 넘어갑니다 —
        라비는 골라 드리기만 합니다.</div>
    </div>`;

    // 이름·수량은 미리 채워 둔다. 여기까지는 틀려도 값이 0이다.
    const set = (id: string, v: unknown) => {
      const el = $(id) as HTMLInputElement | null;
      if (el && v !== undefined && v !== null && String(v) !== "") el.value = String(v);
    };
    set("i-name", r.name);
    set("i-qty", r.qty);
    set("i-units", r.units);
    const re = $("i-reissuable") as HTMLInputElement | null;
    if (re && typeof r.reissuable === "boolean") re.checked = r.reissuable;
  } catch (e) {
    note.innerHTML = `<span style="color:var(--bad)">${escapeHtml(errText(e))}</span>`;
  }
}

async function aiFillShop() {
  const input = ($("ai-shop") as HTMLInputElement).value.trim();
  if (!aiProvider) return;
  $("ai-shop-note").textContent = "생각하는 중…";
  try {
    const r = await invoke<any>("ai_fill", { provider: aiProvider, task: "shop", input });
    const set = (id: string, v: any) => {
      if (v) ($(id) as HTMLInputElement).value = String(v);
    };
    set("sh-ko", r.names?.ko);
    set("sh-en", r.names?.en);
    set("sh-ja", r.names?.ja);
    set("sh-zh", r.names?.zh);
    set("sh-desc", r.description_ko);
    set("sh-loc", r.location);
    set("sh-asset", r.asset);
    ($("sh-pickup") as HTMLInputElement).checked = r.pickup !== false;
    ($("sh-delivery") as HTMLInputElement).checked = r.delivery === true;
    $("ai-shop-note").textContent = "채웠습니다. 고쳐서 쓰세요.";
    labelShopNav();
    await checkShopName();
  } catch (e) {
    $("ai-shop-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
  }
}

async function aiFillMenu() {
  const input = ($("ai-menu") as HTMLInputElement).value.trim();
  if (!aiProvider) return;
  $("ai-menu-note").textContent = "생각하는 중…";
  try {
    const r = await invoke<any>("ai_fill", { provider: aiProvider, task: "menu", input });
    const items: any[] = r.items || [];
    // Added to what is there rather than replacing it: a second pass should
    // extend the menu, not silently discard the first.
    for (const it of items) {
      menuItems.push({ name: it.name || "", name_en: it.name_en || "", price: it.price ?? null, image: null });
    }
    renderMenu();
    $("ai-menu-note").textContent = `${items.length}개 넣었습니다. 사진은 직접 올리세요.`;
  } catch (e) {
    $("ai-menu-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
  }
}

/// 손으로 하나하나 채우지 않고 화면을 확인하기 위한 샘플.
///
/// 사진은 실제로 이 컴퓨터의 IPFS에 올라가 고정돼 있는 것들이다. 가짜 주소가
/// 아니라 진짜로 열리는 것이라야, 손님 화면이 실제로 도는지 확인이 된다.
async function fillSample() {
  const set = (id: string, v: string) => (($(id) as HTMLInputElement).value = v);
  set("sh-ko", "강남 로스터리");
  set("sh-en", "Gangnam Roastery");
  set("sh-ja", "江南ロースタリー");
  set("sh-zh", "江南烘焙坊");
  set("sh-desc", "원두를 직접 볶는 작은 카페입니다");
  set("sh-loc", "서울 강남구");
  set("sh-asset", "GANGNAM_ROASTERY");
  ($("sh-pickup") as HTMLInputElement).checked = true;
  ($("sh-delivery") as HTMLInputElement).checked = false;

  shopIcon = "QmZYRLyTXskYN89TSrhELMm5CCHRi3RyXCjSyABz8tRbvK";
  $("sh-picprev").innerHTML =
    `<img src="http://127.0.0.1:8080/ipfs/${shopIcon}" alt="" style="max-width:180px;border-radius:8px;margin-top:8px" />`;
  $("sh-picnote").textContent = "샘플 사진 (IPFS에 올라가 있습니다)";

  menuItems.length = 0;
  menuItems.push(
    { name: "아이스 아메리카노", name_en: "Iced Americano", price: 4500,
      image: "Qmd23gcQWAZTKZrstpnXTPyUo4VsbtVL5bcuXmks4JQuCC" },
    { name: "카페라떼", name_en: "Cafe Latte", price: 5000,
      image: "QmbibWRDaWKyJKQPKjAr7N83ckz3eAyU34vKdWss1eUQF6" },
    { name: "치즈케이크", name_en: "Cheesecake", price: 6500,
      image: "QmZ7vS5KRg9AT3ZkBMCo6TH8AV8gLauokonW3PbMuv1XHd" }
  );
  renderMenu();
  checkShopName();
  labelShopNav();

  // 폰에서 바로 보이게 여기까지 해 준다. 체인 등록(500 RVN 소각)은 필요 없다 —
  // 손님 화면은 이 컴퓨터가 직접 내보내는 것이라 체인과 무관하다.
  $("ai-shop-note").textContent = "주소 만들고 폰 여는 중…";
  try {
    if (!shopAddress) await makeShopAddress();
    await startPhone();
    $("ai-shop-note").innerHTML =
      "샘플이 폰에서 보입니다. <b>등록 버튼은 누르지 마세요</b> — 500 RVN이 소각됩니다.";
    showPage("settings");
  } catch (e) {
    $("ai-shop-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
  }
}

/// 간판 사진. 프로필에 인라인으로 들어가므로 작게 줄여 담는다.
/**
 * 가게 안 사진 여러 장.
 *
 * 🔴 한 장씩 올리면 주소가 여러 개가 되고, 그게 다 공지에 실린다. 폴더
 * **하나**로 묶어 올리면 공지에는 주소 하나(60바이트)만 실린다 — 100장을
 * 올려도 릴레이가 안 무겁다.
 *
 * 🔴 그리고 **실패를 조용히 넘기지 않는다.** 간판 사진이 그렇게 넘어가서
 * 사진이 통째로 공지에 실렸고, 사장은 올라간 줄 알았다.
 */
function pickShopPhotos() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    const note = $("sh-picsnote");
    note.textContent = t("줄이는 중…");
    try {
      // 긴 쪽 1200px. 가게 안 사진은 크게 볼 일이 없고, 손님 폰에서 빨리
      // 떠야 한다. 원본을 그대로 올리면 한 장에 몇 MB 다.
      const out: { name: string; bytes: number[] }[] = [];
      for (let i = 0; i < files.length && i < 30; i++) {
        const bmp = await createImageBitmap(files[i]);
        const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale);
        const h = Math.round(bmp.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.82));
        if (!blob) continue;
        out.push({
          name: `${String(i + 1).padStart(2, "0")}.jpg`,
          bytes: [...new Uint8Array(await blob.arrayBuffer())],
        });
      }
      if (!out.length) throw new Error("읽을 수 있는 사진이 없습니다.");
      note.textContent = t("올리는 중…");
      const up = await invoke<any>("ipfs_add_bundle", { files: out, metadata: null });
      if (!up?.cid) throw new Error("파일창고가 주소를 주지 않았습니다.");
      shopPhotosCid = up.cid;
      $("sh-picsprev").innerHTML = out
        .map(
          (f) =>
            `<img src="http://127.0.0.1:8080/ipfs/${up.cid}/${f.name}" alt=""
                  style="width:84px;height:84px;object-fit:cover;border-radius:8px" />`
        )
        .join("");
      // 🔴 손님은 이 사진을 **이 가게 서버**(`/ipfs/`)로만 본다.
      //    가게가 컴퓨터를 끄면 안 보인다. 그런데 「올렸습니다」로만
      //    끝나서, 사장은 어디 안전한 데 올라간 줄 안다.
      note.textContent =
        `${out.length}${t("장 올렸습니다. 바꾸셔도 소각은 없습니다.")} ` +
        t("손님은 이 컴퓨터를 통해 봅니다 — 꺼 두시면 사진이 안 보입니다.");
    } catch (e) {
      // 사진이 안 올라간 것을 조용히 넘기지 않는다.
      $("sh-picsnote").innerHTML =
        `<span class="warn"><b>못 올렸습니다.</b> 왼쪽 「파일창고」가 켜져 있는지 봐 주세요. ` +
        `<span class="meta">${escapeHtml(String((e as Error)?.message || e).slice(0, 70))}</span></span>`;
    }
  };
  input.click();
}

function pickShopPhoto() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    $("sh-picnote").textContent = t("줄이는 중…");
    try {
      const bitmap = await createImageBitmap(file);

      // 🔴 **정사각형으로 잘라 준다.** 손님 목록에서 이 사진은 56×56 정사각
      //    자리에 들어가고, 가로로 긴 사진을 넣으면 양옆이 잘려 간판 글씨가
      //    날아간다. 「정사각형으로 올려 주세요」라고 적어 두는 것은 답이
      //    아니다 — 사장은 폰 갤러리에서 자를 줄 모르고, 안내문을 읽지도 않는다.
      //
      //    가운데를 기준으로 자른다. 간판 사진은 대개 가운데가 주인공이다.
      const side = Math.min(bitmap.width, bitmap.height);
      const sx = (bitmap.width - side) / 2;
      const sy = (bitmap.height - side) / 2;
      const out = 512;
      const canvas = document.createElement("canvas");
      canvas.width = out;
      canvas.height = out;
      canvas.getContext("2d")!.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

      // 🔴 사진을 프로필 **안에** 박지 않는다. 그러면 사진을 바꿀 때마다
      //    프로필이 통째로 바뀌고, 체인에 반영하려면 재발행(100 RVN)이다.
      //    IPFS 에 따로 올리고 **주소만** 들고 있으면, 사진 교체는 새 주소를
      //    릴레이에 올리는 것으로 끝난다 — 소각 0원.
      $("sh-picnote").textContent = t("올리는 중…");
      let cid = "";
      let picFail = "";
      try {
        const bin = await (await fetch(dataUrl)).blob();
        const up = await invoke<any>("ipfs_add_bundle", {
          files: [{ name: "icon.jpg", bytes: [...new Uint8Array(await bin.arrayBuffer())] }],
          metadata: null,
        });
        // 🔴 `ipfs_add_bundle` 은 **폴더** 주소를 준다(`wrap-with-directory`).
        //    그대로 쓰면 폴더를 그림으로 여는 셈이라 아무것도 안 뜬다.
        //    안에 든 파일 이름까지 붙여야 그림이 나온다.
        // 🔴 **두 번째 무언 경로였다.** 응답 모양이 다르면 `catch` 에도 안
        //    걸리고 조용히 빈 문자열이 되어, 사진이 통째로 공지에 실렸다.
        //    페이블 지적. 없으면 없다고 던진다.
        if (!up?.cid) throw new Error("파일창고가 주소를 주지 않았습니다.");
        cid = `${up.cid}/icon.jpg`;
      } catch (e) {
        // 🔴 **조용히 비상 경로로 떨어지면 안 된다.** 실제로 그 일이 났고,
        //    사장은 사진이 올라간 줄 알았다. 결과는 이렇다:
        //      · 사진이 공지 안에 **통째로** 실려 18KB 를 차지한다(94%)
        //      · 릴레이 한 건 32KB 라 **한 장만 더 넣으면 넘친다**
        //      · 손님 화면에서 안 보일 수 있다
        //    무엇이 안 됐는지 사장에게 말한다.
        picFail = String((e as Error)?.message || e).slice(0, 80);
      }

      shopIcon = cid || dataUrl;
      $("sh-picprev").innerHTML =
        `<img src="${dataUrl}" alt="" style="max-width:180px;border-radius:8px;margin-top:8px" />`;
      if (cid) {
        $("sh-picnote").textContent = t("정사각형으로 잘라 올렸습니다. 나중에 바꾸셔도 소각은 없습니다.");
      } else {
        // 괄호 안 작은 글씨로 적으면 사장은 그냥 넘어간다. 문제로 보이게 한다.
        $("sh-picnote").innerHTML =
          `<span class="warnbox" style="display:block;margin-top:8px">` +
          `<b>파일창고에 못 올렸습니다.</b> 사진을 공지 안에 그대로 담았습니다 — ` +
          `공지가 무거워져서 <b>사진을 더 넣으면 손님에게 안 갑니다.</b><br />` +
          `왼쪽 「파일창고」가 켜져 있는지 보시고 다시 올려 주세요.` +
          (picFail ? `<br /><span class="meta">${escapeHtml(picFail)}</span>` : "") +
          `</span>`;
      }

      // 등록한 가게면 바뀐 사진을 바로 알린다. 안 그러면 45분을 기다린다.
      try {
        await invoke("shop_refresh");
      } catch {
        /* 아직 등록 전이면 알릴 곳이 없다. */
      }
    } catch (e) {
      $("sh-picnote").innerHTML = `<span style="color:var(--bad)">${escapeHtml(errText(e))}</span>`;
    }
  };
  input.click();
}


// ── 출입 ──────────────────────────────────────────────────────────────────
//
// 7시에 "들어가도 되나"에 답하는 화면. 회원은 아무것도 하지 않는다 —
// 직원이 이름을 치고 누른다. 회원이 폰에서 토큰을 보내는 설계는 잠긴 화면,
// 없는 수수료, 서는 줄에서 사흘이면 종이로 돌아간다.

let msEditing: string | null = null;

const nowSec = () => Math.floor(Date.now() / 1000);

function ymdToInput(v: number): string {
  if (!v) return "";
  const s = String(v);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function inputToYmd(v: string): number {
  return parseInt(v.replace(/-/g, ""), 10) || 0;
}
function fmtYmd(v: number): string {
  if (!v) return "—";
  const s = String(v);
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}

function memberCard(m: any, big: boolean): string {
  const ok = m.valid;
  const sub =
    m.kind === "punch"
      ? `${m.left}회 남음 · 총 ${m.visits_total}회`
      : m.frozen_at
        ? `정지 중 (${fmtYmd(m.frozen_at)}부터)`
        : `${fmtYmd(m.expires)}까지 · ${m.days_left}일`;

  // 만료가 코앞이면 회원이 카운터 앞에 있을 때 말한다. 문자보다 갱신으로 이어진다.
  const soon = m.kind === "period" && ok && m.days_left <= 7;

  return `<div class="mcard ${ok ? "ok" : "no"}${big ? " big" : ""}" data-m="${m.asset}">
      <div class="mhead">
        <div>
          <div class="mname">${m.name || "(이름 없음)"}</div>
          <div class="msub">${sub}</div>
          ${m.note ? `<div class="msub">${m.note}</div>` : ""}
        </div>
        <div class="mstate">${ok ? "들어오세요" : m.why}</div>
      </div>
      <!-- 🔴 사장이 실제로 묻는 것: 「이 사람 요즘 나오나」. 전체 횟수만으로는
           안 보인다 — 3년 다닌 사람의 200회와 이번 달 0회가 같은 줄에 있다. -->
      <div class="meta" style="margin-top:4px">
        ${m.age != null ? `${m.age}세 · ` : ""}${
          m.visit_count
            ? `${t("여태")} ${m.visit_count}${t("번")} · ${t("최근 30일")} <b>${m.visits_30d ?? 0}${t("번")}</b>` +
              (m.last_visit ? ` · ${t("마지막")} ${agoDays(m.last_visit)}` : "")
            : t("아직 한 번도 안 오셨습니다")
        }
      </div>
      ${soon ? `<div class="msoon">${m.days_left}일 뒤 만료 — 지금 말씀드리세요</div>` : ""}
      <div class="mrow">
        ${ok ? `<button data-in="${m.asset}">${m.kind === "punch" ? "1회 차감" : "입장"}</button>` : ""}
        <button class="ghost" data-edit="${m.asset}">고치기</button>
        ${
          m.frozen_at
            ? `<button class="ghost" data-thaw="${m.asset}">정지 풀기</button>`
            : `<button class="ghost" data-freeze="${m.asset}">정지</button>`
        }
        ${m.kind === "period" ? `<button class="ghost" data-ext="${m.asset}">기간 연장</button>` : `<button class="ghost" data-addv="${m.asset}">횟수 추가</button>`}
      </div>
    </div>`;
}

/**
 * 오늘부터의 예약 일정.
 *
 * 🔴 **안 낸 것도 같이 보여 준다.** 「지금 누가 고르는 중」이 안 보이면
 * 사장이 그 시간에 다른 일을 잡고, 몇 분 뒤 결제가 들어와 겹친다.
 * 다만 낸 것과 구별은 확실히 한다 — 안 낸 것은 안 올 수도 있다.
 */
async function showBookings() {
  const box = $("dr-hits");
  box.innerHTML = `<div class="meta" style="padding:14px 0">${t("불러오는 중…")}</div>`;
  try {
    const r = await invoke<any>("booking_list", { nowUnix: Math.floor(Date.now() / 1000) });
    const rows: any[] = r.bookings || [];
    if (!rows.length) {
      box.innerHTML =
        `<div class="card" style="margin-top:12px">
           <h3 style="margin-top:0">${t("잡힌 예약이 없습니다")}</h3>
           <p class="meta">${t("메뉴판에 「예약 받는 것」을 넣고 손님이 시간을 고르면 여기에 뜹니다.")}</p>
         </div>`;
      return;
    }
    const when = (s: number) => {
      const d = new Date(s * 1000);
      const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
      const h = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${mm}`;
    };
    box.innerHTML =
      `<table class="tbl" style="margin-top:12px">
         <thead><tr>
           <th>${t("언제")}</th><th class="num">${t("걸리는 시간")}</th>
           <th>${t("상태")}</th><th></th>
         </tr></thead>
         <tbody>${rows
           .map((b) => {
             const paid = b.state === "paid";
             return `<tr class="${paid ? "" : "muted"}">
               <td>${when(b.at)}</td>
               <td class="num">${b.minutes}${t("분")}</td>
               <td>${paid ? `<span class="ok">${t("결제됨")}</span>` : t("고르는 중 — 안 올 수 있음")}</td>
               <td class="act"><button class="ghost" data-bcancel="${escapeHtml(b.addr || "")}">${t("취소")}</button></td>
             </tr>`;
           })
           .join("")}</tbody>
       </table>`;
    box.querySelectorAll("[data-bcancel]").forEach((el) => {
      (el as HTMLElement).onclick = async () => {
        const addr = (el as HTMLElement).dataset.bcancel!;
        // 🔴 되돌릴 수 없다. 손님은 이미 그 시간에 오기로 알고 있다.
        const yes = await ask(
          t("이 예약을 취소합니다"),
          t("손님은 이 시간에 오기로 알고 계십니다. 연락하실 방법이 있는지 먼저 확인하세요."),
          { ok: t("취소합니다") }
        );
        if (!yes) return;
        try {
          await invoke("booking_cancel", { addr });
        } catch (e) {
          box.innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
          return;
        }
        void showBookings();
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(errText(e))}</div>`;
  }
}

/**
 * 카운터에서 판 이용권 목록.
 *
 * 🔴 이게 없으면 손님이 폰을 닫는 순간 그 표는 사장에게 존재하지 않는다.
 * 돈은 받았는데 못 들여보내고, 그건 카운터에서 바로 싸움이 된다.
 *
 * 번호를 그대로 보여 준다. 손님이 「제 표가 K7P2 로 시작했어요」라고 말할
 * 때 찾을 수 있어야 하고, 직원이 검표 칸에 손으로 칠 수도 있어야 한다.
 */
async function showPasses() {
  const box = $("dr-hits");
  box.innerHTML = `<div class="meta" style="padding:14px 0">${t("불러오는 중…")}</div>`;
  try {
    const r = await invoke<any>("ticket_list", { nowUnix: Math.floor(Date.now() / 1000) });
    const rows: any[] = r.tickets || [];
    if (!rows.length) {
      // 빈 화면은 실패가 아니라 안내다. 어떻게 하면 여기 뜨는지 적는다.
      box.innerHTML =
        `<div class="card" style="margin-top:12px">
           <h3 style="margin-top:0">${t("아직 판 이용권이 없습니다")}</h3>
           <p class="meta">${t("메뉴판에 「기간 이용권」을 넣고 손님이 사면 여기에 쌓입니다.")}</p>
         </div>`;
      return;
    }
    const ymd = (v: number) =>
      v ? `${Math.floor(v / 10000)}.${String(Math.floor(v / 100) % 100).padStart(2, "0")}.${String(v % 100).padStart(2, "0")}` : "";
    box.innerHTML =
      `<table class="tbl" style="margin-top:12px">
         <thead><tr>
           <th>${t("표 번호")}</th><th>${t("품목")}</th>
           <th>${t("언제까지")}</th><th class="num">${t("남은 날")}</th><th>${t("들어온 횟수")}</th>
         </tr></thead>
         <tbody>${rows
           .map(
             (p) => `<tr class="${p.valid ? "" : "muted"}">
               <td><code class="addr">${escapeHtml(p.code || "")}</code></td>
               <td>${escapeHtml(p.item || "")}</td>
               <td>${ymd(p.until)}</td>
               <td class="num">${p.valid ? `${p.left_days}${t("일")}` : escapeHtml(p.why || "")}</td>
               <td>${(p.visits || []).length}</td>
             </tr>`
           )
           .join("")}</tbody>
       </table>
       <p class="meta" style="margin-top:8px">${t("총")} ${rows.length}${t("장")}</p>`;
  } catch (e) {
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(errText(e))}</div>`;
  }
}

/** 「3일 전」처럼. 날짜를 적으면 사장이 머리로 뺄셈을 한다. */
function agoDays(unix: number): string {
  const d = Math.floor((Date.now() / 1000 - unix) / 86400);
  if (d <= 0) return t("오늘");
  if (d === 1) return t("어제");
  if (d < 30) return `${d}${t("일 전")}`;
  const m = Math.floor(d / 30);
  return `${m}${t("달 전")}`;
}

function bindMemberCards(root: string) {
  const el = $(root);
  el.querySelectorAll("[data-in]").forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      // 🔴 **손님이 문 앞에 서 있다.** 누른 뒤 아무 표시가 없으면 한 번 더
      //    누르고, 그러면 입장이 두 번 찍힌다(그록 감사 2026-08-27).
      const btn = b as HTMLButtonElement;
      const was = btn.textContent || "";
      btn.disabled = true;
      btn.textContent = t("여는 중…");
      $("dr-note").textContent = t("확인하고 문을 여는 중입니다…");
      try {
        const asset = (b as HTMLElement).dataset.in!;
        await invoke("check_in", { asset, nowUnix: nowSec() });
        $("dr-note").innerHTML = `<span class="ok">입장 처리했습니다</span>`;
        // 문이 등록돼 있으면 실제로 연다. 이 줄이 없어서 「입장」은 기록만
        // 남기고 회원은 잠긴 문 앞에 서 있었다. open_for_member 가 회원권을
        // 다시 확인하므로, 여기서 통과했다고 문이 무조건 열리지는 않는다.
        if (firstDoorId) {
          try {
            const r: any = await invoke("open_for_member", {
              asset, doorId: firstDoorId, nowUnix: nowSec(), cnonce: newCnonce(),
            });
            $("dr-note").innerHTML = r.opened
              ? `<span class="ok">입장 · ${escapeHtml(r.name || "문")} 열렸습니다</span>`
              : `<span class="danger">입장은 됐지만 문이 안 열렸습니다 — ${escapeHtml(r.why || "")}</span>`;
          } catch (e) {
            $("dr-note").innerHTML = `<span class="danger">입장은 됐지만 문이 안 열렸습니다 — ${e}</span>`;
          }
        }
        doorSearch();
        loadMembers();
      } catch (e) {
        $("dr-note").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
      } finally {
        // 🔴 **실패해도 단추를 푼다.** `try` 안에서만 풀면 실패했을 때
        //    영영 잠겨서 다시 시도할 수 없다 — 손님은 문 앞에 서 있고
        //    사장은 누를 수 있는 것이 없다.
        btn.disabled = false;
        btn.textContent = was;
      }
    };
  });
  el.querySelectorAll("[data-edit]").forEach((b) => {
    (b as HTMLElement).onclick = () => openMember((b as HTMLElement).dataset.edit!);
  });
  el.querySelectorAll("[data-freeze]").forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      await invoke("set_frozen", { asset: (b as HTMLElement).dataset.freeze, frozen: true, nowUnix: nowSec() });
      doorSearch();
      loadMembers();
    };
  });
  el.querySelectorAll("[data-thaw]").forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      // 정지했던 날수만큼 만료를 뒤로 민다. 카운터에서 날짜로 다투지 않게.
      await invoke("set_frozen", { asset: (b as HTMLElement).dataset.thaw, frozen: false, nowUnix: nowSec() });
      doorSearch();
      loadMembers();
    };
  });
  el.querySelectorAll("[data-ext]").forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      const m = await ask("몇 개월 연장할까요?", "달력 기준입니다 — 1월 31일 + 1개월 = 2월 28일\n일수로 하려면 앞에 d를 붙이세요 (예: d10)", { value: "1" });
      if (!m) return;
      const byDays = m.trim().toLowerCase().startsWith("d");
      await invoke("extend", {
        asset: (b as HTMLElement).dataset.ext,
        days: byDays ? parseInt(m.slice(1)) || 0 : 0,
        months: byDays ? 0 : parseInt(m) || 0,
        nowUnix: nowSec(),
      });
      doorSearch();
      loadMembers();
    };
  });
  el.querySelectorAll("[data-addv]").forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      const n = await ask("몇 회 추가할까요?", "", { value: "10", numeric: true });
      if (!n) return;
      await invoke("add_visits", { asset: (b as HTMLElement).dataset.addv, count: parseInt(n) || 0, nowUnix: nowSec() });
      doorSearch();
      loadMembers();
    };
  });
}

let doorTimer: any;
async function doorSearch() {
  const q = ($("dr-q") as HTMLInputElement).value.trim();
  if (!q) {
    $("dr-hits").innerHTML = "";
    return;
  }
  try {
    const r = await invoke<any>("check_in_lookup", { query: q, nowUnix: nowSec() });
    const hits: any[] = r.matches || [];
    $("dr-hits").innerHTML = hits.length
      ? hits.map((m) => memberCard(m, hits.length === 1)).join("")
      : `<p class="muted" style="margin-top:14px">찾지 못했습니다. 이름 일부나 전화 뒷자리로 다시 쳐보세요.</p>`;
    bindMemberCards("dr-hits");
  } catch (e) {
    $("dr-hits").innerHTML = `<p class="danger">${e}</p>`;
  }
}

async function loadMembers() {
  if ($("dr-list").innerHTML === "") return;
  try {
    const r = await invoke<any>("list_members", { nowUnix: nowSec() });
    const list: any[] = r.members || [];
    // 🔴 **만료된 회원과 다니는 회원을 섞어 두면 안 된다.** 명단이 길어질수록
    //    사장이 찾는 것은 「지금 다니는 사람」인데, 그 사이에 작년에 끊은
    //    사람이 끼어 있으면 매번 눈으로 걸러야 한다.
    //
    //    끝난 회원을 지우지도 않는다 — 다시 오는 사람이 많고, 그때 옛 기록이
    //    있으면 「예전에 다니셨죠」가 된다. 나누기만 한다.
    const live = list.filter((m) => m.valid);
    const ending = live.filter((m) => m.kind === "period" && m.days_left <= 7);
    const going = live.filter((m) => !ending.includes(m));
    const over = list.filter((m) => !m.valid);

    const group = (title: string, rows: any[], why: string) =>
      rows.length
        ? `<div class="mgroup"><div class="mgrouphead">${title}
             <span class="meta">${rows.length}${t("명")}</span></div>
             ${why ? `<div class="meta" style="margin-bottom:8px">${why}</div>` : ""}
             ${rows.map((m) => memberCard(m, false)).join("")}</div>`
        : "";

    $("dr-list").innerHTML = list.length
      ? group(t("곧 끝납니다"), ending, t("지금 카운터에서 말씀드리면 대개 갱신하십니다.")) +
        group(t("다니는 중"), going, "") +
        group(t("끝난 회원"), over, t("지우지 않았습니다 — 다시 오시면 그대로 이어집니다."))
      : emptyWithRaven("아직 등록된 회원이 없습니다.<br />「회원 등록」으로 첫 회원을 넣어 보세요.", "hello");
    bindMemberCards("dr-list");
    $("dr-note").textContent =
      `${t("다니는 중")} ${live.length}${t("명")} · ${t("끝남")} ${over.length}${t("명")}`;
  } catch (e) {
    $("dr-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

async function openMember(asset?: string): Promise<void> {
  msEditing = asset || null;
  $("ms-title").textContent = asset ? "회원 고치기" : "회원 등록";
  $("ms-chain").style.display = asset ? "none" : "";
  $("ms-result").innerHTML = "";
  $("ms-note2").textContent = "";

  const set = (id: string, v: any) => (($(id) as HTMLInputElement).value = v ?? "");
  if (asset) {
    const r = await invoke<any>("list_members", { nowUnix: nowSec() });
    const m = (r.members || []).find((x: any) => x.asset === asset);
    if (m) {
      set("ms-name", m.name);
      set("ms-phone", m.phone);
      ($("ms-kind") as HTMLSelectElement).value = m.kind;
      set("ms-exp", ymdToInput(m.expires));
      set("ms-start", "");
      ($("ms-months") as HTMLSelectElement).value = "0";
      set("ms-visits", m.visits_total || 10);
      set("ms-note", m.note);
      // 추가 항목도 되살린다. 안 하면 전화번호만 고치러 열었다가 저장하는
      // 순간 생년·성별이 빈 값으로 덮인다.
      set("ms-birth", m.extra?.birth_year);
      set("ms-emg", m.extra?.emergency);
      ($("ms-gender") as HTMLSelectElement).value = m.extra?.gender || "";
    }
  } else {
    ["ms-name", "ms-phone", "ms-note", "ms-birth", "ms-emg"].forEach((id) => set(id, ""));
    ($("ms-gender") as HTMLSelectElement).value = "";
    await loadUnclaimed();
    // 오늘 시작, 한 달. 시작일을 강제하지는 않는다 — 금요일에 결제하고
    // 월요일부터 시작하는 회원이 실제로 있다.
    set("ms-start", new Date().toISOString().slice(0, 10));
    ($("ms-months") as HTMLSelectElement).value = "1";
    set("ms-visits", 10);
    await recalcPeriod();
  }
  msKindChanged();
  $("msheet").classList.remove("hidden");
}

/// 시작일과 기간에서 끝나는 날을 계산한다.
///
/// 헬스장의 "한 달"은 30일이 아니라 같은 날짜다. 1월 31일에 한 달권을 사면
/// 2월 28일까지고, 30일을 더하면 3월 2일이 되어 이틀을 더 주게 된다.
async function recalcPeriod() {
  const months = parseInt(($("ms-months") as HTMLSelectElement).value);
  const start = inputToYmd(($("ms-start") as HTMLInputElement).value);
  if (!months || !start) {
    $("ms-calc").textContent = months ? "" : "끝나는 날을 직접 정하세요";
    return;
  }
  try {
    const r = await invoke<any>("period_end", { fromYmd: start, months, extraDays: 0 });
    ($("ms-exp") as HTMLInputElement).value = ymdToInput(r.end);
    $("ms-calc").textContent = `${fmtYmd(r.start)} ~ ${fmtYmd(r.end)} · ${r.days}일`;
  } catch {}
}

/// 이미 나가 있는 회원권 번호를 고르게 한다.
///
/// 온라인으로 판 회원권은 손님 지갑에 있고, 그 손님이 체육관에 오면 이 번호를
/// 대고 이름을 적는다. 새로 찍는 것은 아무도 번호를 안 갖고 온 경우뿐이다.
async function loadUnclaimed() {
  const root = (($("sh-asset") as HTMLInputElement)?.value || "GYM").trim();
  const sel = $("ms-num") as HTMLSelectElement;
  try {
    const r = await invoke<any>("unclaimed_numbers", { root });
    const list: any[] = r.numbers || [];
    sel.innerHTML =
      list
        .map(
          (n) =>
            `<option value="${n.asset}">${n.asset.split("#")[1]} ${n.sold ? "· 팔린 것" : "· 여분"}</option>`
        )
        .join("") + `<option value="">새로 발급 (5 RVN 소각)</option>`;

    // 팔린 번호가 있으면 그쪽이 기본값이다. 손님이 그걸 들고 서 있을 테니까.
    const sold = list.find((n) => n.sold);
    sel.value = sold ? sold.asset : list.length ? list[0].asset : "";
    msNumChanged();
  } catch {
    sel.innerHTML = `<option value="">새로 발급 (5 RVN 소각)</option>`;
    msNumChanged();
  }
}

function msNumChanged() {
  const v = ($("ms-num") as HTMLSelectElement).value;
  $("ms-numnote").innerHTML = v
    ? `<span class="ok">이미 있는 번호를 씁니다</span> — 소각되는 RVN이 없습니다`
    : "체인에 새 번호를 찍습니다. 손님이 번호를 갖고 오셨으면 위에서 고르세요.";
  $("ms-chain").style.display = v ? "none" : "";
}

function msKindChanged() {
  const punch = ($("ms-kind") as HTMLSelectElement).value === "punch";
  $("ms-period").style.display = punch ? "none" : "";
  $("ms-punch").style.display = punch ? "" : "none";
}

async function saveMember() {
  const btn = $("ms-save") as HTMLButtonElement;
  const val = (id: string) => ($(id) as HTMLInputElement).value.trim();
  if (!val("ms-name")) {
    $("ms-note2").innerHTML = `<span class="danger">이름을 넣어 주세요</span>`;
    return;
  }
  btn.disabled = true;

  try {
    // 고른 번호가 있으면 그걸 쓴다. 없을 때만 새로 찍는다.
    let asset = msEditing || ($("ms-num") as HTMLSelectElement)?.value || null;
    if (!asset) {
      // 회원번호는 난수 태그다. 이름에서 만들면 체인이 이름을 알게 된다.
      const seed = `${Date.now()}-${Math.random()}-${val("ms-name")}`;
      const root = (($("sh-asset") as HTMLInputElement)?.value || "GYM").trim();
      asset = await invoke<string>("member_number", { root, seed });

      $("ms-note2").textContent = "체인에 회원번호를 찍는 중…";
      const lock = await invoke<any>("wallet_lock_state").catch(() => null);
      const pass =
        lock?.encrypted && !lock?.unlocked
          ? await ask("지갑 암호", "", { password: true })
          : null;
      if (lock?.encrypted && !lock?.unlocked && !pass) {
        btn.disabled = false;
        $("ms-note2").textContent = "";
        return;
      }
        // 🔴 **여기서 5 RVN 이 말없이 탄다.** 「저장」을 누르는 순간
        //    되돌릴 수 없는 체인 기록이 생기고 코인이 소각된다. 그런데
        //    자산 발행·가게 등록에는 있는 8초 확인창이 **여기엔 없었다** —
        //    안내는 드롭다운 글자 한 줄뿐이었다.
        //
        //    회원을 열 명 등록하면 50 RVN 이다. 사장이 알고 눌러야 한다.
        if (
          !(await holdBeforeDoing(
            `회원 이름표 「${asset}」 을(를) 체인에 만듭니다`,
            "5 RVN 이 타서 없어집니다. 되돌릴 수 없습니다.",
          ))
        ) {
          btn.disabled = false;
          $("ms-note2").textContent = "";
          return;
        }
      if (pass) await invoke("unlock_for", { passphrase: pass, seconds: 30 }).catch(() => {});
      await invoke("issue_asset", {
        name: asset,
        qty: 1,
        units: 0,
        reissuable: false,
        ipfsHash: null,
        toAddress: null,
      });
    }

    await invoke("save_member", {
      asset,
      name: val("ms-name"),
      phone: val("ms-phone"),
      kind: ($("ms-kind") as HTMLSelectElement).value,
      expires: inputToYmd(val("ms-exp")),
      visitsTotal: parseInt(val("ms-visits")) || 0,
      note: val("ms-note"),
      nowUnix: nowSec(),
      // 체육관마다 다른 것들. 빈 칸은 안 보낸다 — 보내면 예전 값을 빈 값으로
      // 덮어쓴다(러스트가 「이번에 온 것만」 합치기 때문).
      extra: (() => {
        const e: Record<string, string> = {};
        for (const [k, id] of [
          ["birth_year", "ms-birth"],
          ["gender", "ms-gender"],
          ["emergency", "ms-emg"],
        ] as const) {
          const v = val(id);
          if (v) e[k] = v;
        }
        return Object.keys(e).length ? e : null;
      })(),
    });

    $("msheet").classList.add("hidden");
    loadMembers();
    doorSearch();
  } catch (e) {
    $("ms-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
  btn.disabled = false;
}

// ── 지갑 암호 ──
//
// Encrypting is irreversible and the thing that actually hurts people is
// forgetting, not theft. So it gets the same friction as issuing: a sentence
// typed out by hand. Nothing here stores, hints at, or recovers a passphrase.

let encMode: "new" | "change" = "new";

async function openEncrypt() {
  const st = await invoke<any>("encryption_state").catch(() => null);
  encMode = st?.encrypted ? "change" : "new";
  $("enc-title").textContent = encMode === "new" ? "지갑에 암호 걸기" : "암호 바꾸기";
  $("enc-old-row").style.display = encMode === "change" ? "" : "none";
  // 바꾸는 것은 되돌릴 수 있다 — 실패해도 옛 암호가 남는다. 처음 거는 것만 무섭다.
  $("enc-phrase").textContent =
    encMode === "new" ? "암호를 잊으면 되돌릴 수 없다" : "암호를 바꾼다";
  ($("enc-go") as HTMLButtonElement).textContent = encMode === "new" ? "암호 걸기" : "암호 바꾸기";
  ["enc-old", "enc-new", "enc-new2", "enc-confirm"].forEach(
    (id) => (($(id) as HTMLInputElement).value = "")
  );
  $("enc-result").innerHTML = "";
  $("encbox").style.display = "";
  gateEnc();
}

function gateEnc() {
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  const ok =
    v("enc-new").length >= 10 &&
    v("enc-new") === v("enc-new2") &&
    v("enc-confirm").trim() === ($("enc-phrase").textContent || "").trim() &&
    (encMode === "new" || v("enc-old").length > 0);
  ($("enc-go") as HTMLButtonElement).disabled = !ok;

  // 🔴 **단추를 안 눌리게만 하면 안 된다.** 왜 안 눌리는지 말해 주지 않으면
  //    사장은 화면이 고장 난 줄 안다. 특히 「두 번 넣은 암호가 다르다」는
  //    본인은 같게 쳤다고 믿기 때문에 절대 스스로 못 찾는다.
  const say = document.getElementById("enc-why");
  if (!say) return;
  const a1 = v("enc-new");
  const a2 = v("enc-new2");
  let why = "";
  if (a1 && a1.length < 10) why = `암호가 짧습니다. ${10 - a1.length}글자 더 필요합니다.`;
  else if (a2 && a1 !== a2) why = "🔴 두 번 넣은 암호가 다릅니다.";
  else if (a1 && a1 === a2 && !ok) why = "아래 문장을 그대로 입력하시면 됩니다.";
  else if (a1 && a1 === a2) why = "✅ 두 암호가 같습니다.";
  say.textContent = why;
  say.className = why.startsWith("🔴") ? "warnbox" : "meta";
  say.style.marginTop = why ? "8px" : "0";
}

async function doEncrypt() {
  const btn = $("enc-go") as HTMLButtonElement;
  btn.disabled = true;
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  try {
    if (encMode === "new") {
      await invoke("encrypt_wallet", { passphrase: v("enc-new"), confirm: v("enc-new2") });
      // 🔴 **같은 암호로 백업도 열리게 해 둔다.** 백업 암호를 따로 두면
      //    사장은 암호 두 개를 갖게 되고, 그 둘을 헷갈린다. 지금 이 순간이
      //    암호를 손에 쥔 유일한 때다 — 여기서 안 하면 다시는 못 한다
      //    (우리는 암호를 저장하지 않으므로).
      //
      //    실패해도 지갑 암호는 이미 걸렸으므로 조용히 넘어간다.
      const alsoBackup = await invoke("backup_pass_set", { pass: v("enc-new"), walletPass: v("enc-new") })
        .then(() => true)
        .catch(() => false);
      $("enc-result").innerHTML =
        `<div class="warnbox" style="margin-top:12px"><b>암호를 걸었습니다. 노드가 꺼졌습니다.</b><br />
         레이븐 노드를 다시 켜야 가게가 다시 돕니다. 암호를 종이에 적어 안전한 곳에 두세요 —
         이 컴퓨터가 아닌 곳에.<br /><br />
         ${
           alsoBackup
             ? "<b>이 암호 하나로 백업도 열립니다.</b> 새 컴퓨터에서 가게를 되살릴 때 이 암호를 칩니다."
             : "⚠️ 백업 암호는 따로 정하셔야 합니다 — 「이 컴퓨터」에서."
         }</div>`;
    } else {
      await invoke("change_passphrase", {
        old: v("enc-old"),
        new: v("enc-new"),
        confirm: v("enc-new2"),
      });
      // 🔴 **여기가 비어 있었다.** 암호를 바꿔도 백업 봉투는 옛 암호 그대로라,
      //    새 컴퓨터에서 새 암호를 쳐도 안 열렸다. 사장은 열릴 거라 믿는다.
      //    바꾸는 이 순간이 새 암호를 손에 쥔 유일한 때다.
      const synced = await invoke("backup_pass_set", { pass: v("enc-new"), walletPass: v("enc-new") })
        .then(() => true)
        .catch(() => false);
      $("enc-result").innerHTML =
        `<div class="card" style="margin-top:12px"><h3>바꿨습니다</h3>
         <p class="meta">${
           synced
             ? "앞으로 만드는 백업은 <b>새 암호</b>로 열립니다.<br />⚠️ 이미 만들어 둔 백업은 <b>예전 암호</b>로만 열립니다 — 그 파일 안에 이미 굳어 있어서 바꿀 수가 없습니다. 새로 한 부 만들어 두세요."
             : "⚠️ 백업 암호는 따로 정하셔야 합니다 — 「이 컴퓨터」에서."
         }</p></div>`;
    }
    loadWallet();
  } catch (e) {
    $("enc-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
    btn.disabled = false;
  }
}

// ── 자산 팔기 ──


let offers: any[] = [];
let sellTarget: any = null;
/// 폰 서버가 켜지면 채워진다. 판매 링크가 이 주소로 만들어진다.
let serverIp = "";
let autoTimer: any = null;

/// 팔기는 자산에서 시작한다. 목록을 덮는 시트로 열려서, 나가는 길은 취소뿐이다.
async function openSell(asset: Asset) {
  sellTarget = asset;
  $("sl-title").textContent = `${asset.name} 팔기`;
  ($("sl-qty") as HTMLInputElement).value = "";
  ($("sl-price") as HTMLInputElement).value = "";
  $("sl-qr").innerHTML = "";
  $("sl-note").textContent = `보유 ${fmtQty(asset.amount)}`;
  $("sellsheet").classList.remove("hidden");
  sellRate();
}

async function sellRate() {
  const cur = ($("sl-cur") as HTMLSelectElement).value;
  if (cur === "RVN") { $("sl-rate").textContent = ""; return; }
  try {
    const r = await invoke<any>("rvn_rate", { currency: cur });
    $("sl-rate").innerHTML =
      `1 RVN = ${r.symbol}${cur === "KRW" ? r.rate.toFixed(2) : r.rate.toFixed(6)} · ${(r.sources || []).join("·")}` +
      (r.unstable ? ` <span class="warn">시세가 흔들립니다</span>` : "");
  } catch {
    $("sl-rate").innerHTML = `<span class="warn">시세를 못 가져왔습니다</span>`;
  }
}

async function listOffer() {
  if (!sellTarget) return;
  const qty = parseFloat(($("sl-qty") as HTMLInputElement).value);
  const price = parseFloat(($("sl-price") as HTMLInputElement).value);
  if (!(qty > 0) || !(price > 0)) {
    $("sl-note").textContent = "수량과 가격을 넣어 주세요";
    return;
  }
  if (qty > sellTarget.amount) {
    $("sl-note").innerHTML = `<span class="danger">보유 ${fmtQty(sellTarget.amount)}보다 많습니다</span>`;
    return;
  }

  const currency = ($("sl-cur") as HTMLSelectElement).value;

  // 같은 조건이면 주소를 다시 만들지 않는다. 버튼을 두 번 누르면 이미 공유한
  // QR이 어느 것이었는지 사장도 모르게 되고, 그 QR을 보고 온 손님의 돈이
  // 목록에 없는 주소로 들어간다.
  let offer = offers.find(
    (o) => o.asset === sellTarget.name && o.qty === qty && o.price === price && o.currency === currency
  );
  const isNew = !offer;
  if (!offer) {
    const address = await invoke<string>("new_address", { label: `sell:${sellTarget.name}` });
    offer = { asset: sellTarget.name, qty, price, currency, address, rvn: price };
    offers.push(offer);
  }

  if (currency !== "RVN") {
    const now = Math.floor(Date.now() / 1000);
    const q = await invoke<any>("quote_price", { amount: price, currency, nowUnix: now }).catch(() => null);
    if (q) offer.rvn = q.rvn;
  }

  // 온라인 판매는 그림이 아니라 링크로 한다. 이 사슬은 누가 보냈는지 모르기
  // 때문에, 손님이 받을 주소를 적어 줄 자리가 있어야 자동 발송이 성립한다.
  offer.id = offer.id || `${offer.asset}-${Math.round(offer.price)}-${offers.length}`.replace(/[^A-Za-z0-9._-]/g, "");
  offer.daily_cap = parseFloat(($("sl-cap") as HTMLInputElement)?.value) || offer.qty * 10;
  try {
    await invoke("publish_offer", {
      id: offer.id,
      offer: {
        asset: offer.asset,
        qty: offer.qty,
        price: offer.price,
        currency: offer.currency,
        rvn: offer.rvn,
        symbol: offer.currency === "USD" ? "$" : offer.currency === "KRW" ? "₩" : "",
        shop: ($("sh-ko") as HTMLInputElement)?.value || "",
        image: assets.get(offer.asset)?.ipfs_hash || null,
        // 손님 폰은 IPFS 게이트웨이(8080)에 닿지 못한다 — 그건 127.0.0.1 에만
        // 묶여 있다. 우리 서버가 중계하므로 우리 포트를 준다.
        gateway: `http://${(serverIp || "127.0.0.1")}:8790`,
        daily_cap: offer.daily_cap,
      },
    });
    const base = await invoke<any>("public_base", { localIp: serverIp || "127.0.0.1", port: 8790 });
    offer.link = `${base.base}/buy?id=${encodeURIComponent(offer.id)}`;
    offer.public = base.public;
    offer.linkNote = base.note || "";
  } catch {
    // 폰 서버가 안 켜져 있으면 링크는 없고 QR만 쓴다.
  }

  await showOfferQr(offer, isNew);
  checkSales();
}

/// QR과 주소, 그리고 그것을 실제로 가져갈 수 있는 방법.
///
/// 화면에만 있는 QR은 카운터에서만 쓸 수 있다. X에 올리거나 단톡방에 뿌리려면
/// 파일로 나와야 하고, 주소는 손으로 옮겨 적을 수 있는 것이 아니다.
async function showOfferQr(offer: any, isNew: boolean) {
  // 링크가 있으면 그것을 QR에 넣는다. 주소 QR은 손님이 받을 주소를 남길
  // 자리가 없어서 자동 발송이 안 된다 — 사장이 일일이 물어봐야 한다.
  const uri = offer.link || `raven:${offer.address}?amount=${offer.rvn}`;
  const qr = await invoke<string>("qr_svg", { text: uri });

  $("sl-qr").innerHTML =
    `<div class="qrbox" style="margin-top:14px" id="sl-qrbox">${qr}
       <div class="cap"><b>${fmtQty(offer.qty)} × ${offer.asset}</b>${offer.rvn} RVN</div></div>
     <code class="addr">${offer.address}</code>
     <div class="row" style="margin-top:10px;flex-wrap:wrap">
       <button class="ghost" id="sl-save">QR 이미지 저장</button>
       <button class="ghost" id="sl-copyaddr">주소 복사</button>
       <button class="ghost" id="sl-copylink">${offer.link ? "판매 링크 복사" : "결제 링크 복사"}</button>
     </div>` +
    (offer.link && offer.public
      ? `<p class="meta">이 링크를 X나 단톡방에 올리세요. 손님이 <b>받을 주소를 적으면</b>
           결제 후 자동으로 보내집니다.</p>
         <div id="sl-share" style="margin-top:10px"></div>`
      : offer.link
      ? `<div class="warnbox" style="margin-top:11px;font-size:13px">
           <b>이 링크는 같은 wifi 안에서만 열립니다.</b> X에 올리면 밖에서는 아무것도 안 보입니다.<br />
           이 컴퓨터 → <b>바깥에서도 열리게 하기</b>를 켜면 전 세계에서 열리는 주소가 생깁니다.
         </div>`
      : `<div class="warnbox" style="margin-top:11px;font-size:13px">
           <b>폰 연결이 꺼져 있어 판매 링크를 만들지 못했습니다.</b>
           지금 QR은 주소만 담고 있어서, 손님이 보낸 뒤 받을 주소를 따로 물어봐야 합니다.
           <br />이 컴퓨터 → 폰 연결을 켜면 링크가 생깁니다.
         </div>`) +
    (offer.currency !== "RVN"
      ? `<div class="warnbox" style="margin-top:11px;font-size:13px">
           이 QR에는 <b>지금 시세로 계산한 ${offer.rvn} RVN</b>이 박혀 있습니다.
           X나 단톡방처럼 오래 남는 곳에 올리려면 <b>가격 단위를 RVN으로</b> 두세요.
           원화로 두면 시세가 움직인 뒤 손님이 내는 금액이 달라집니다.
         </div>`
      : "");

  $("sl-note").innerHTML = isNew
    ? `내놓았습니다 (모두 ${offers.length}건)`
    : `<span class="ok">같은 조건이라 기존 주소를 그대로 씁니다</span> — 올려둔 QR이 계속 유효합니다`;

  // PNG로 굽는다. SVG를 그대로 주면 X·카톡이 미리보기를 못 만든다.
  $("sl-save").onclick = () => {
    const svg = $("sl-qrbox").querySelector("svg");
    if (!svg) return;
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const S = 720;
      c.width = S;
      c.height = S + 96;
      const g = c.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 40, 40, S - 80, S - 80);
      // 캡션을 구워 넣는다. 이미지만 떠도는 곳에서 무엇을 사는 QR인지 남게.
      g.fillStyle = "#111";
      g.font = "600 30px -apple-system, sans-serif";
      g.textAlign = "center";
      g.fillText(`${fmtQty(offer.qty)} × ${offer.asset}`, S / 2, S - 4);
      g.font = "26px -apple-system, sans-serif";
      g.fillStyle = "#555";
      g.fillText(`${offer.rvn} RVN`, S / 2, S + 36);
      URL.revokeObjectURL(url);

      c.toBlob((png) => {
        if (!png) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(png);
        a.download = `${offer.asset.replace(/[^A-Za-z0-9]/g, "_")}-${offer.rvn}RVN.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      }, "image/png");
    };
    img.src = url;
  };

  const copy = async (text: string, btn: HTMLElement) => {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = "복사됨";
    setTimeout(() => (btn.textContent = was), 1300);
  };
  // 공유. 글과 링크만 채워 준다 — 어느 플랫폼도 URL로 이미지를 받지 않아서
  // 사진은 저장한 QR을 직접 붙여야 한다.
  const shareBox = document.getElementById("sl-share");
  if (shareBox && offer.public) {
    const text = `${offer.qty > 1 ? offer.qty + " × " : ""}${offer.asset} · ${offer.rvn} RVN`;
    const t = await invoke<any>("share_targets", { text, url: offer.link }).catch(() => null);
    if (t) {
      shareBox.innerHTML =
        `<div class="row" style="flex-wrap:wrap">` +
        t.links.map((l: any) => `<button class="ghost" data-share="${l.url}">${l.name}</button>`).join("") +
        `</div>` +
        // 없는 버튼이 왜 없는지 적는다. 안 적으면 우리가 빠뜨린 것으로 읽힌다.
        `<div class="meta" style="margin-top:8px">` +
        t.manual.map((m: any) => `<b>${m.name}</b> — ${m.why}`).join("<br>") +
        `</div>`;
      shareBox.querySelectorAll("[data-share]").forEach((b) => {
        (b as HTMLElement).onclick = () =>
          invoke("open_share", { url: (b as HTMLElement).dataset.share }).catch((e) => say(t("열지 못했습니다"), errText(e)));
      });
    }
  }
  $("sl-copyaddr").onclick = () => copy(offer.address, $("sl-copyaddr"));
  $("sl-copylink").onclick = () => copy(uri, $("sl-copylink"));
}

async function checkSales() {
  $("vend-wrap").style.display = offers.length ? "" : "none";
  if (!offers.length) return;
  try {
    const r = await invoke<any>("pending_sales", { offers, minConf: 1 });
    const sales: any[] = r.sales || [];
    $("vd-sales").innerHTML = sales.length
      ? sales
          .map(
            (s, i) => `<tr>
              <td>${s.asset} × ${fmtQty(s.qty)}</td>
              <td class="num">${s.paid}</td>
              <td class="num">${
                s.settled ? s.confirmations : `<span class="warn">${s.confirmations} 대기</span>`
              }</td>
              <td class="act">${s.settled ? `<button data-fulfil="${i}">보내기</button>` : ""}</td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="muted">내놓은 ${offers.length}건. 아직 입금이 없습니다.</td></tr>`;

    $("vd-sales")
      .querySelectorAll("[data-fulfil]")
      .forEach((b) => {
        (b as HTMLElement).onclick = () => fulfil(sales[+(b as HTMLElement).dataset.fulfil!]);
      });
  } catch {}
}

async function fulfil(sale: any) {
  // 보낸 주소가 곧 받을 주소는 아니다. 거래소를 거쳐 왔다면 그리로 보내는 순간
  // 자산이 사라진다. 그래서 물어본다.
  const to = await ask(
    `${sale.asset} ${sale.qty}개를 어디로 보낼까요?`,
    "손님에게 받은 주소를 넣으세요. 돈이 온 주소가 아닙니다."
  );
  if (!to) return;
  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  const pass = lock?.unlocked
    ? null
    : await ask("지갑 암호", "한 번만 열고 바로 잠급니다.", { password: true });

  try {
    const txid = await invoke<string>("fulfil_sale", {
      asset: sale.asset,
      qty: sale.qty,
      toAddress: to.trim(),
      passphrase: pass,
    });
    $("vd-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>보냈습니다</h3>
       <div class="kv"><b>트랜잭션</b><code class="addr">${txid}</code></div></div>`;
    checkSales();
    loadAssets(false);
  } catch (e) {
    $("vd-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
}

/// 자동 발송. 사장이 안 보고 있어도 도는 유일한 돈 관련 동작이라,
/// 무엇을 보냈고 무엇을 왜 못 보냈는지 화면에 남긴다.
async function autoRound() {
  try {
    const pend = await invoke<any>("pending_claims");
    const claims: any[] = pend.claims || [];
    if (!claims.length) return;

    const r = await invoke<any>("auto_fulfil", { offers: claims, minConf: 1, passphrase: null });
    const sent: any[] = r.sent || [];
    if (sent.length) {
      await invoke("mark_sent", { addresses: sent.map((s: any) => s.address) });
      loadAssets(false);
    }

    const skipped: any[] = (r.skipped || []).filter((s: any) => s.why !== "확인 대기");
    $("vd-result").innerHTML =
      (sent.length
        ? `<div class="card" style="margin-top:12px"><h3>자동으로 보냈습니다</h3>` +
          sent.map((s: any) => `<div class="kv"><b>${s.asset}</b><span>${fmtQty(s.qty)} → <code class="addr">${s.to}</code></span></div>`).join("") +
          `</div>`
        : "") +
      // 왜 안 나갔는지 말하지 않으면, 고장난 것과 구별되지 않는다.
      (skipped.length
        ? `<div class="warnbox" style="margin-top:12px"><b>사람이 봐야 하는 건</b><br>` +
          skipped.map((s: any) => `${s.asset} — ${s.why}`).join("<br>") + `</div>`
        : "") +
      (r.error ? `<div class="warnbox" style="margin-top:12px">${r.error}</div>` : "");
  } catch {}
}

async function toggleAuto() {
  const btn = $("vd-auto") as HTMLButtonElement;
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    await invoke("auto_disable").catch(() => {});
    btn.textContent = "자동 발송 켜기";
    btn.className = "ghost";
    $("vd-autonote").textContent = "";
    return;
  }

  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  let pass: string | null = null;
  if (lock?.encrypted && !lock?.unlocked) {
    pass = await ask(
      "지갑 암호",
      "자동 발송을 켜면 앱이 암호를 기억합니다.\n\n" +
        "· 디스크에는 절대 저장하지 않습니다\n" +
        "· 앱을 끄면 사라집니다\n" +
        "· 이 컴퓨터를 쓸 수 있는 사람은 여전히 지갑을 쓸 수 있습니다",
      { password: true }
    );
    if (!pass) return;
  }

  try {
    await invoke("auto_enable", { passphrase: pass || "" });
    autoTimer = setInterval(autoRound, 30000);
    autoRound();
    btn.textContent = "자동 발송 끄기";
    btn.className = "";
    const ex = await invoke<any>("exposure").catch(() => null);
    // 조언이 아니라 숫자로 보여준다.
    $("vd-autonote").innerHTML = ex
      ? `이 컴퓨터에 <b>${ex.rvn.toLocaleString()} RVN</b>` +
        (ex.krw ? ` (약 ${Math.round(ex.krw).toLocaleString()}원)` : "") +
        ` 있습니다. 털리면 이만큼입니다.`
      : "";
  } catch (e) {
    $("vd-autonote").innerHTML = `<span class="danger">${e}</span>`;
  }
}


// ── 알림 ──────────────────────────────────────────────────────────────────

function mtab(which: string) {
  document.querySelectorAll("[data-mtab]").forEach((b) =>
    (b as HTMLElement).classList.toggle("on", (b as HTMLElement).dataset.mtab === which)
  );
  document.querySelectorAll(".mtab").forEach((d) =>
    d.classList.toggle("on", d.id === `mtab-${which}`)
  );
  if (which === "inbox") loadInbox();
  if (which === "direct") checkPubsub();
}

async function loadChannels() {
  try {
    const r = await invoke<any>("my_channels");
    const list: string[] = r.channels || [];
    ($("nt-ch") as HTMLSelectElement).innerHTML = list
      .map((c) => `<option value="${c}">${c}</option>`)
      .join("");
    $("nt-chnote").textContent = list.length
      ? `이 자산을 가진 사람 전원에게 갑니다`
      : "보낼 수 있는 채널이 없습니다. 자산을 발행하면 그 자산이 채널이 됩니다.";
    ($("nt-go") as HTMLButtonElement).disabled = !list.length;
  } catch (e) {
    $("nt-chnote").innerHTML = `<span class="danger">${e}</span>`;
  }
}

async function sendNotice() {
  const btn = $("nt-go") as HTMLButtonElement;
  btn.disabled = true;
  $("nt-note").textContent = "IPFS에 올리고 체인에 기록하는 중…";
  try {
    const r = await invoke<any>("broadcast", {
      channel: ($("nt-ch") as HTMLSelectElement).value,
      title: ($("nt-title") as HTMLInputElement).value,
      body: ($("nt-body") as HTMLInputElement).value,
    });
    $("nt-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>보냈습니다</h3>
       <div class="kv"><b>트랜잭션</b><code class="addr">${r.txid}</code></div>
       <p class="meta">되돌릴 수 없습니다. 고칠 것이 있으면 정정 공지를 하나 더 보내야 합니다.</p></div>`;
    ($("nt-title") as HTMLInputElement).value = "";
    ($("nt-body") as HTMLInputElement).value = "";
  } catch (e) {
    $("nt-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
  $("nt-note").textContent = "";
  btn.disabled = false;
}

async function loadInbox() {
  $("in-note").textContent = "불러오는 중…";
  try {
    const r = await invoke<any>("inbox");
    const list: any[] = r.messages || [];
    $("in-list").innerHTML = list.length
      ? list
          .map((m) => {
            const n = m.notice?.playx_notice || {};
            return `<div class="notice">
              <h4>${n.title || m.channel || "공지"}</h4>
              ${n.body ? `<div>${n.body}</div>` : `<div class="meta">내용을 불러오지 못했습니다</div>`}
              <div class="when">${m.channel || ""}${m.time ? " · " + ago(m.time) : ""}</div>
            </div>`;
          })
          .join("")
      : `<p class="muted">받은 공지가 없습니다. 어떤 자산을 갖고 있으면 그 발행자의 공지가 여기 옵니다.</p>`;
    $("in-note").textContent = `${list.length}건`;
  } catch (e) {
    $("in-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

async function checkPubsub() {
  try {
    const r = await invoke<any>("pubsub_ready");
    $("ps-state").innerHTML = r.ready
      ? `<span class="ok">노드끼리 직접 대화할 수 있습니다.</span> 서버도 수수료도 없습니다.`
      : `<b>아직 켜져 있지 않습니다.</b><br />${r.how}`;
    ($("ps-go") as HTMLButtonElement).disabled = !r.ready;
  } catch {}
}

async function sendDirect() {
  const topic = ($("ps-topic") as HTMLInputElement).value.trim();
  const text = ($("ps-text") as HTMLInputElement).value.trim();
  if (!topic || !text) return;
  try {
    await invoke("pubsub_send", {
      topic,
      from: ($("sh-ko") as HTMLInputElement)?.value || "",
      text,
    });
    ($("ps-text") as HTMLInputElement).value = "";
    $("ps-note").innerHTML = `<span class="ok">보냈습니다.</span> 상대가 켜져 있어야 받습니다.`;
  } catch (e) {
    $("ps-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

// ── 환불 ──
//
// 환불은 되돌리기가 아니라 새로 보내는 것이다. 그래서 받는 주소가 있어야 하고,
// 가게에 RVN이 있어야 하고, 사람이 눌러야 한다.

/**
 * 환불 — **한 화면에서 끝낸다.**
 *
 * ## 🔴 전에는 창을 넷 띄웠다
 *
 *     ask(금액) → ask(주소) → ask(사유) → ask(지갑 암호)
 *
 * 그록 감사(2026-08-27):
 * > 같은 `#askwrap` 을 네 번 갈아끼워, 방금 친 금액·주소가 다음 창에서
 * > 안 보인다. **환불은 손님이 계산대에 서 있는 일이다.**
 *
 * 주소를 잘못 쳤는지 확인하려면 처음부터 다시 해야 했다. 그리고 그 사이
 * 손님은 서 있다. 넷을 한 화면에 놓고, 보내기 전에 **전부 한눈에** 보인다.
 *
 * ⚠️ 주소는 **되돌릴 수 없다.** 잘못 보내면 끝이다. 그래서 보내기 전에
 *    한 번 더 확인하고, 확인 문구에 주소와 금액을 그대로 적는다.
 */
async function doRefund(payAddress: string, suggested: number) {
  const box = $("or-refund");
  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  const needPass = !!(lock?.encrypted && !lock?.unlocked);
  box.innerHTML =
    `<div class="card" style="margin-top:12px">
       <h3>${t("환불하기")}</h3>
       <p class="meta">${t("받은 금액은")} ${suggested} RVN ${t("입니다. 일부만 돌려주시려면 더 적게 넣으세요.")}</p>
       <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
         <label class="meta" for="rf-amt">${t("얼마를 돌려드릴까요? (RVN)")}</label>
         <input id="rf-amt" inputmode="decimal" value="${suggested}" />
         <label class="meta" for="rf-to">${t("어느 주소로 돌려드릴까요?")}</label>
         <input id="rf-to" placeholder="R..." autocomplete="off" spellcheck="false" />
         <p class="meta" id="rf-fromsay">${t("보낸 주소를 찾는 중…")}</p>
         <label class="meta" for="rf-why">${t("사유 (내 지갑에만 남습니다)")}</label>
         <input id="rf-why" value="${t("주문 취소")}" />
         ${
           needPass
             ? `<label class="meta" for="rf-pass">${t("지갑 암호")}</label>
                <input id="rf-pass" type="password" autocomplete="off" />`
             : ""
         }
       </div>
       <div class="row" style="margin-top:12px">
         <button id="rf-go">${t("돌려주기")}</button>
         <button class="ghost" id="rf-cancel">${t("취소")}</button>
         <span class="meta" id="rf-say"></span>
       </div>
     </div>`;
  ($("rf-to") as HTMLInputElement).focus();

  // 🔴 대표님: "상대방 지갑주소가 안 보이던데."
  //
  //    화면은 「체인은 누가 보냈는지 기록하지 않습니다. 손님에게 물어보셔야
  //    합니다」라고 적고 있었다. **사실이 아니다** — 거래의 입력에는 그 돈이
  //    어느 주소에서 왔는지 그대로 적혀 있다(2026-08-29 실측).
  //
  //    그리고 그 문구대로면 **환불이 사실상 불가능하다.** 손님은 이미 갔다.
  //
  //    ⚠️ 다만 채워 넣고 끝내면 안 된다. 거래소에서 보냈으면 거래소 주소가
  //       나오고, 거기로 보내면 돈이 사라질 수 있다. **채우되 확인을 청한다.**
  void (async () => {
    const say = $("rf-fromsay");
    if (!say) return;
    try {
      const r = await invoke<any>("refund_payer", { address: payAddress });
      const a = r?.address;
      if (!a) {
        say.innerHTML = t("보낸 주소를 찾지 못했습니다. 손님에게 물어봐 주세요.");
        return;
      }
      const el = $("rf-to") as HTMLInputElement;
      if (!el.value.trim()) el.value = String(a);
      say.innerHTML =
        `<b>${t("이 돈을 보낸 주소입니다")}</b> — ` +
        t("맞는지 손님과 확인해 주세요. 거래소에서 보낸 돈이면 이 주소로 돌려주시면 안 됩니다.");
    } catch {
      say.innerHTML = t("보낸 주소를 찾지 못했습니다. 손님에게 물어봐 주세요.");
    }
  })();
  $("rf-cancel").addEventListener("click", () => {
    box.innerHTML = "";
  });
  $("rf-go").addEventListener("click", async () => {
    const amount = parseFloat(($("rf-amt") as HTMLInputElement).value);
    const to = ($("rf-to") as HTMLInputElement).value.trim();
    const reason = ($("rf-why") as HTMLInputElement).value.trim();
    const pass = needPass ? ($("rf-pass") as HTMLInputElement).value : null;
    if (!(amount > 0)) {
      $("rf-say").innerHTML = `<span class="danger">${t("금액을 확인해 주세요")}</span>`;
      return;
    }
    if (!to) {
      $("rf-say").innerHTML = `<span class="danger">${t("받을 주소가 필요합니다")}</span>`;
      ($("rf-to") as HTMLInputElement).focus();
      return;
    }
    // 🔴 **되돌릴 수 없다.** 주소와 금액을 그대로 다시 보여 주고 묻는다.
    const ok = await sure(
      t("이 주소로 보낼까요?"),
      `${amount} RVN\n${to}\n\n${t("보내면 되돌릴 수 없습니다.")}`,
    );
    if (!ok) return;
    const b = $("rf-go") as HTMLButtonElement;
    b.disabled = true;
    $("rf-say").textContent = t("보내는 중…");
    try {
      const r = await invoke<any>("refund", {
        toAddress: to,
        amount,
        reason,
        passphrase: pass,
      });
      box.innerHTML =
        `<div class="card" style="margin-top:12px"><h3>${t("환불했습니다")}</h3>
         <div class="kv"><b>${t("금액")}</b><span>${r.amount} RVN</span></div>
         <div class="kv"><b>${t("거래 번호")}</b><code class="addr">${escapeHtml(String(r.txid))}</code></div></div>`;
      loadWallet();
    } catch (e) {
      b.disabled = false;
      $("rf-say").innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  });
}

// ── 이 앱이 보내지 않은 출금 ──
//
// 막지는 못한다. 빨리 아는 것이 전부다. 그래서 "보안"이라고 부르지 않는다.

async function checkForeign() {
  try {
    const r = await invoke<any>("foreign_spends", { sinceHours: 24 });
    const list: any[] = r.spends || [];
    if (!list.length) {
      $("w-foreign").innerHTML = "";
      return;
    }
    const owner = list.some((s) => s.is_owner_token);
    $("w-foreign").innerHTML =
      `<div class="warnbox" style="margin-top:12px">
         <b>이 앱이 보내지 않은 출금이 ${list.length}건 있습니다.</b><br />
         ${owner ? `<b class="danger">소유권 토큰이 나갔습니다.</b> 그 자산의 발행권이 넘어갔습니다.<br />` : ""}
         ${list
           .slice(0, 5)
           .map(
             (s) =>
               `${s.time ? ago(s.time) : ""} · ${s.asset || "RVN"} ${s.amount ?? ""} → <code class="addr">${(s.address || "").slice(0, 12)}…</code>`
           )
           .join("<br>")}
         <br /><br />직접 보내신 것이면 괜찮습니다. 아니라면 <b>자동 판매를 끄고 이 컴퓨터를 끄세요.</b>
         ${r.note ? `<br /><span class="meta">${r.note}</span>` : ""}
       </div>`;
  } catch {}
}




// ── ElectrumX ─────────────────────────────────────────────────────────────
//
// 없어도 전부 돌아간다. 있으면 두 가지가 달라진다: 회원 확인이 우리 파일이
// 아니라 체인에서 답해지고, 손님 폰의 경량 지갑이 이 노드에 붙을 수 있다.
// 두 번째가 더 크다 — "가게가 회원이라고 한다"와 "체인이 그렇다고 했고 손님이
// 직접 봤다"는 다른 물건이다.


// ── 채굴 ──────────────────────────────────────────────────────────────────
//
// 사람들이 안 하는 이유는 하기 싫어서가 아니라 방법을 몰라서다. 그래서 막지
// 않는다 — 숫자를 먼저 보여주고, 하겠다고 하면 붙여넣을 한 줄을 만들어 준다.
//
// 다만 이 컴퓨터로 캐게 하지는 않는다. 카운터 PC가 GPU를 다 쓰면 주문 화면이
// 버벅이고, 그건 채굴 수익보다 비싸다.

let mnAddress = "";

async function loadMining() {
  try {
    // 이 컴퓨터로 캘 수 있는지 먼저 답한다. 맥은 그래픽이 좋아도 KAWPOW
    // 마이너가 없어서 못 캔다 — 그걸 모르면 밤새 방법을 찾게 된다.
    const d = await invoke<any>("detect_gpu").catch(() => null);
    if (d) {
      let miners = "";
      if (d.apple_silicon) {
        const list: any[] = await invoke<any>("mac_miners").catch(() => []);
        miners = list.length
          ? `<div class="meta" style="margin-top:8px">맥용 마이너: ` +
            list.map((m) => `<b>${m.name}</b> — ${m.what}`).join("<br>") +
            `</div>`
          : "";
      }
      $("mn-detect").innerHTML = d.can_mine
        ? `<div class="meta"><b>${d.chipset}</b> — ${d.why}</div>${miners}`
        : `<div class="warnbox" style="font-size:13px">
             <b>이 컴퓨터로는 캘 수 없습니다 — ${d.chipset}</b><br />${d.why}
           </div>`;
    }
    const gpus: any[] = await invoke<any>("gpu_presets");
    ($("mn-gpu") as HTMLSelectElement).innerHTML = gpus
      .map((g, i) => `<option value="${i}">${g.name} · 약 ${g.mh} MH/s</option>`)
      .join("");
    (window as any).__gpus = gpus;

    const pools: any[] = await invoke<any>("known_pools");
    ($("mn-pool") as HTMLSelectElement).innerHTML = pools
      .map((p) => `<option value="${p.url}">${p.name} — ${p.url}</option>`)
      .join("");

    calcMining();
    showPowerCurve();
  } catch (e) {
    $("mine-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

async function calcMining() {
  const gpus: any[] = (window as any).__gpus || [];
  let g = gpus[+($("mn-gpu") as HTMLSelectElement).value] || gpus[0];
  if (!g) return;
  // "직접 입력"이면 사용자가 넣은 값을 쓴다.
  const custom = g.mh === 0;
  $("mn-custom").style.display = custom ? "" : "none";
  if (custom) {
    g = {
      mh: parseFloat(($("mn-mh") as HTMLInputElement).value) || 30,
      watts: parseFloat(($("mn-watts") as HTMLInputElement).value) || 150,
    };
  }
  const kwh = parseFloat(($("mn-kwh") as HTMLInputElement).value) || 150;
  const power = parseInt(($("mn-power") as HTMLInputElement)?.value || "70");
  const curve = await invoke<any>("power_curve", { power }).catch(() => ({ hash_ratio: 1 }));

  try {
    // 제한을 건 상태의 실제 해시와 전력으로 계산한다. 100% 기준으로 보여주면
    // 화면의 숫자와 실제 통장이 어긋난다.
    const r = await invoke<any>("mining_reality", {
      hashrateMh: g.mh * curve.hash_ratio,
      watts: g.watts * (power / 100),
      krwPerKwh: kwh,
    });
    const net = r.net_krw;
    // 🔴 이 값은 `contribution` **안에** 있다. 밖에서 읽으면 `undefined` 고,
    //    아래에서 `solo.toFixed(0)` 이 터진다 — 화면에 영문 TypeError 가
    //    그대로 떴다. 사장이 할 수 있는 일이 하나도 없는 문장이다.
    //
    //    값이 없어도 화면은 나와야 한다. 「모른다」와 「고장났다」는 다르다.
    const solo = Number(r?.contribution?.solo_days_per_block);

    $("mn-calc").innerHTML = `<div class="cost">
      <div class="burn ${net > 0 ? "ok" : "danger"}">
        하루 ${net > 0 ? "+" : ""}${Math.round(net).toLocaleString()}원
      </div>
      <div class="meta" style="margin-top:6px">
        캐는 것 ${r.rvn_per_day.toFixed(3)} RVN (약 ${Math.round(r.income_krw).toLocaleString()}원)
        · 전기 ${Math.round(r.power_krw).toLocaleString()}원
      </div>
      <div class="meta">
        네트워크 전체의 ${(r.share * 100).toExponential(1)}% ·
        혼자 캐면 블록 하나에 평균 ${
          !Number.isFinite(solo) ? "—"
          : solo > 36500 ? "100년 넘게"
          : solo > 365 ? `${(solo / 365).toFixed(0)}년`
          : `${solo.toFixed(0)}일`
        } 걸립니다 — 그래서 풀에 들어갑니다
      </div>
      ${
        net <= 0
          ? `<div class="meta warn" style="margin-top:6px">지금 시세·전기료로는 손해입니다.
             시세가 오르거나 전기가 싸면 달라집니다.</div>`
          : ""
      }
    </div>`;
  } catch (e) {
    $("mn-calc").innerHTML = `<div class="warnbox">${e}</div>`;
  }
}

async function makeMiningAddress() {
  try {
    mnAddress = await invoke<string>("mining_address");
    await renderMinerSetup();
    $("mine-note").innerHTML = `<span class="ok">주소를 만들었습니다</span>`;
  } catch (e) {
    $("mine-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

/// 전력 제한이 손해가 아니라는 것을 숫자로 보여준다.
async function showPowerCurve() {
  const p = parseInt(($("mn-power") as HTMLInputElement).value);
  try {
    const c = await invoke<any>("power_curve", { power: p });
    const gpus: any[] = (window as any).__gpus || [];
    let g = gpus[+($("mn-gpu") as HTMLSelectElement).value];
    if (g && g.mh === 0) {
      g = {
        mh: parseFloat(($("mn-mh") as HTMLInputElement).value) || 30,
        watts: parseFloat(($("mn-watts") as HTMLInputElement).value) || 150,
      };
    }
    const mh = g ? (g.mh * c.hash_ratio).toFixed(1) : "";
    const w = g ? Math.round(g.watts * (p / 100)) : "";

    $("mn-powernote").innerHTML =
      `<b>${p}%</b> — 해시 ${Math.round(c.hash_ratio * 100)}%${mh ? ` (약 ${mh} MH/s)` : ""}` +
      `${w ? ` · ${w}W` : ""} · ${c.noise}` +
      (p >= 95
        ? `<br><span class="warn">마지막 10%를 얻으려고 전력을 30% 더 씁니다. 가게에서는 손해입니다.</span>`
        : p <= 70
          ? `<br><span class="ok">와트당 수익이 100%일 때보다 높습니다.</span>`
          : "");
  } catch {}
}

// ── 이 컴퓨터로 캐기 ───────────────────────────────────────────────────────
//
// 지금까지 이 화면은 명령어 문자열만 만들어 줬다. 사장은 터미널을 열어
// 붙여넣고, 끄려면 그 창을 찾아 Ctrl-C 를 눌러야 했다 — 터미널을 여는 순간
// 이건 더 이상 노인도 쓸 수 있는 프로그램이 아니다.

let minerPoll: any = null;

async function showMiners() {
  try {
    const list: any[] = await invoke("mac_miners");
    $("mn-miners").innerHTML = list
      .map(
        (m) => `<div class="kv"><b>${escapeHtml(m.name)}</b>
          <span>${escapeHtml(m.what)} <button class="ghost" data-getminer="${escapeHtml(m.url)}">받으러 가기</button></span></div>`,
      )
      .join("");
    $("mn-miners").querySelectorAll("[data-getminer]").forEach((b) => {
      (b as HTMLElement).onclick = () =>
        invoke("open_external", { url: (b as HTMLElement).dataset.getminer }).catch(() => {});
    });
  } catch {}
}

async function refreshMiner() {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  // 네트워크가 얼마나 센지. 내 해시가 이 안에서 어느 정도인지 모르면
  // "왜 하나도 안 나오지"의 답을 찾을 수 없다.
  invoke<any>("mining_status")
    .then((n) => {
      const hps = Number(n.network_hps || 0);
      $("mn-net").innerHTML = hps
        ? `네트워크 전체 <b>${(hps / 1e9).toFixed(1)} GH/s</b> · 블록 ${Number(n.blocks || 0).toLocaleString()} · 난이도 ${Number(n.difficulty || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
        : "";
    })
    .catch(() => {});

  try {
    const r: any = await invoke("miner_running");
    // 채운 색은 "지금 할 일" 하나뿐이어야 한다. 캐는 중이면 지금 할 일은
    // 끄는 것이고, 그때 「켜기」가 계속 빛나면 눌러도 안 되는 버튼이 화면에서
    // 제일 밝다 — 사장은 그걸 고장으로 읽는다.
    const run = $("mn-run") as HTMLButtonElement;
    const halt = $("mn-halt") as HTMLButtonElement;
    run.classList.toggle("ghost", !!r.running);
    halt.classList.toggle("ghost", !r.running);
    run.disabled = !!r.running;
    halt.disabled = !r.running;

    if (r.running) {
      $("mn-runstate").innerHTML =
        `<span class="ok">캐는 중 · ${r.minutes}분째</span><br />
         <span class="meta">${escapeHtml(r.binary || "")}</span><br />
         <span class="meta">${escapeHtml(r.last || "")}</span>`;
    } else {
      $("mn-runstate").textContent = "";
    }
    // 켜져 있을 때만 계속 본다. 꺼진 뒤에도 1초마다 물으면 그 자체가 전기다.
    if (r.running && !minerPoll) minerPoll = setInterval(refreshMiner, 4000);
    if (!r.running && minerPoll) { clearInterval(minerPoll); minerPoll = null; }
  } catch {}
}

async function startMiner() {
  const note = $("mn-runnote");
  if (!mnAddress) {
    // 주소 없이 캐면 그 몫은 아무에게도 가지 않는다. 조용히 시작하면
    // 사장은 며칠 뒤 "왜 한 푼도 안 들어오지"를 묻게 된다.
    note.innerHTML = `<span class="danger">받을 주소를 먼저 만드세요.</span>`;
    return;
  }
  note.textContent = "켜는 중…";
  try {
    const r: any = await invoke("miner_start", {
      binary: ($("mn-bin") as HTMLInputElement).value.trim() || "kawpowminer",
      pool: ($("mn-pool") as HTMLSelectElement).value,
      address: mnAddress,
      worker: ($("mn-worker") as HTMLInputElement).value,
      power: parseInt(($("mn-power") as HTMLInputElement).value) || 70,
    });
    note.innerHTML = `<span class="ok">켰습니다 — ${escapeHtml(r.note || "")}</span>`;
    await refreshMiner();
  } catch (e) {
    note.innerHTML = `<span class="danger">${e}</span>`;
  }
}

async function stopMiner() {
  try {
    const r: any = await invoke("miner_stop");
    $("mn-runnote").textContent = r.was_running ? "껐습니다." : "캐고 있지 않았습니다.";
  } catch (e) {
    $("mn-runnote").innerHTML = `<span class="danger">${e}</span>`;
  }
  await refreshMiner();
}

async function renderMinerSetup() {
  if (!mnAddress) return;
  const pool = ($("mn-pool") as HTMLSelectElement).value;
  const worker = ($("mn-worker") as HTMLInputElement).value;
  const power = parseInt(($("mn-power") as HTMLInputElement).value);
  const c = await invoke<any>("miner_command", { pool, address: mnAddress, worker, power });

  $("mn-setup").innerHTML =
    `<div class="card" style="margin-top:11px">
       <div class="kv"><b>받을 주소</b><code class="addr">${mnAddress}</code></div>
       <p class="meta">GPU 기계에서 아래 한 줄을 넣으면 끝입니다. 주소는 손으로 옮겨 적지 마세요 —
         한 글자만 틀려도 한 달치가 아무도 없는 곳으로 갑니다.</p>
       ${["trex", "nbminer", "gminer"]
         .map(
           (k) => `<div style="margin-top:9px">
             <div class="meta">${{ trex: "T-Rex", nbminer: "NBMiner", gminer: "GMiner" }[k]}</div>
             <pre class="conf">${c[k]}</pre>
             <button class="link" data-mncopy="${k}">복사</button>
           </div>`
         )
         .join("")}
       <p class="meta">${c.note}</p>
     </div>`;

  $("mn-setup")
    .querySelectorAll("[data-mncopy]")
    .forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        await navigator.clipboard.writeText(c[(b as HTMLElement).dataset.mncopy!]);
        const was = b.textContent;
        b.textContent = "복사됨";
        setTimeout(() => (b.textContent = was), 1300);
      };
    });
}

async function loadMiningIncome() {
  $("mn-incomenote").textContent = "확인 중…";
  try {
    const r = await invoke<any>("mining_income", { days: 30 });
    $("mn-incomebox").innerHTML = r.count
      ? `<div class="card" style="margin-top:11px">
           <div class="big">${r.total_rvn.toLocaleString(undefined, { maximumFractionDigits: 4 })} RVN</div>
           <div class="detail">${
             r.total_krw ? `약 ${Math.round(r.total_krw).toLocaleString()}원 · ` : ""
           }최근 30일 · ${r.count}회${r.last ? " · 마지막 " + ago(r.last) : ""}</div>
         </div>`
      : `<p class="muted" style="margin-top:11px">아직 들어온 채굴 수익이 없습니다.
         위에서 만든 주소를 마이너에 넣고 돌리면 여기 뜹니다.</p>`;
    $("mn-incomenote").textContent = "";
  } catch (e) {
    $("mn-incomenote").innerHTML = `<span class="danger">${e}</span>`;
  }
}

// ── 체인과 IPFS ───────────────────────────────────────────────────────────
//
// 체인은 "이 자산이 저 파일을 가리킨다"만 기록한다. 파일은 누군가 갖고 있어야
// 남고, IPFS는 보존하라고 시킨 것만 지키며 나머지는 주기적으로 지운다.
// 그 두 사실이 한 화면에 같이 있어야 사람이 행동한다.


let ifOptions: any[] = [];

async function loadIpfsConf() {
  try {
    ifOptions = await invoke<any>("ipfs_options");
    const cur = await invoke<any>("ipfs_config_read");
    const v = cur.values || {};

    $("if-fields").innerHTML = ifOptions
      .map((o) => {
        const val = v[o.key];
        const shown = val === undefined || val === null ? "" : String(val).replace(/^"|"$/g, "");
        const input =
          o.type === "switch"
            ? `<label class="check" style="margin:0">
                 <input type="checkbox" data-if="${o.key}" ${shown === "true" ? "checked" : ""} />
                 <span>${shown === "true" ? "켬" : "끔"}</span></label>`
            : `<input data-if="${o.key}" value="${shown}" placeholder="기본값" />`;
        return `<div class="cfrow">
          <div class="lb">${o.label}<small>${o.key.split(".").pop()}</small></div>
          <div>${input}</div>
          <div class="ex">${o.what}
            ${o.cost ? `<br><b class="hint">${o.cost}</b>` : ""}
            ${o.warn ? `<span class="w">${o.warn}</span>` : ""}
          </div>
        </div>`;
      })
      .join("");

    $("if-note").innerHTML =
      `저장소 ${fmtBytes(cur.repo_size || 0)} / ${fmtBytes(cur.storage_max || 0)} · 객체 ${(cur.objects || 0).toLocaleString()}개`;

    // 값을 고치면 바로 반영한다 — IPFS는 항목 단위로 저장되고, 한 번에 쓰는
    // 파일이 아니라 저장 버튼을 따로 둘 이유가 없다.
    $("if-fields")
      .querySelectorAll("[data-if]")
      .forEach((el) => {
        (el as HTMLElement).onchange = async () => {
          const e = el as HTMLInputElement;
          const key = e.dataset.if!;
          const isSwitch = e.type === "checkbox";
          const value = isSwitch ? String(e.checked) : e.value.trim();
          const isJson = isSwitch || /^\d+$/.test(value);
          try {
            await invoke("ipfs_config_write", { key, value, isJson });
            $("if-result").innerHTML =
              `<div class="meta ok" style="margin-top:9px">${key} → ${value} · IPFS를 다시 켜야 적용됩니다</div>`;
          } catch (err) {
            $("if-result").innerHTML = `<div class="warnbox" style="margin-top:9px">${err}</div>`;
          }
        };
      });

    $("if-profiles")
      .querySelectorAll("[data-ipfsprofile]")
      .forEach((el) => {
        (el as HTMLElement).onclick = async () => {
          const name = (el as HTMLElement).dataset.ipfsprofile!;
          try {
            await invoke("ipfs_apply_profile", { name });
            $("if-result").innerHTML =
              `<div class="card" style="margin-top:10px">적용했습니다. <b>IPFS를 다시 켜야</b> 반영됩니다.
               보존한 파일은 그대로입니다.</div>`;
            loadIpfsConf();
          } catch (err) {
            $("if-result").innerHTML = `<div class="warnbox" style="margin-top:10px">${err}</div>`;
          }
        };
      });
  } catch (e) {
    $("if-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

// ── 노드 설정 ─────────────────────────────────────────────────────────────
//
// raven.conf 는 대부분의 사장이 평생 안 여는 파일이고, 여는 사람은 보통
// 어딘가에서 본 줄을 붙여넣었다가 노드가 안 뜨는 것으로 끝난다. 그래서 값이
// 아니라 "무엇이 어떻게 달라지는지"를 먼저 보여준다.

let cfOptions: any[] = [];
let cfValues: Record<string, number | null> = {};

async function loadConf() {
  try {
    cfOptions = await invoke<any>("conf_options");
    const cur = await invoke<any>("conf_read");
    cfValues = { ...(cur.values || {}) };

    // 지금 얼마나 쓰고 있는지를 설정보다 먼저 보여준다. 숫자를 보기 전에는
    // "장부 정리"가 무엇을 아끼는 것인지 알 수 없다.
    try {
      const d = await invoke<any>("disk_now");
      $("cf-disk").innerHTML = d.pruned
        ? `<div class="ok" style="margin-bottom:14px">
             장부를 아껴 쓰는 중입니다 — 지금 <b>${d.chain_gb} GB</b>.
           </div>`
        : `<div class="ok" style="margin-bottom:14px">
             지금 장부에 <b>${d.chain_gb} GB</b>, 사진 창고에 <b>${d.ipfs_gb} GB</b>를 쓰고 있습니다.` +
          (d.reclaimable_gb > 3
            ? ` 아래 <b>장부 정리</b>를 ${cfOptions.find((o: any) => o.key === "prune")?.recommended ?? 5000}으로 두면
                 약 <b>${d.reclaimable_gb} GB</b>를 돌려받습니다. 잔액·자산·주문은 그대로입니다.`
            : "") +
          `</div>`;
    } catch {
      $("cf-disk").innerHTML = "";
    }

    const tpls: any[] = await invoke<any>("conf_templates");
    $("cf-templates").innerHTML = tpls
      .map(
        (t) => `<div class="tpl" data-tpl="${t.id}">
          <b>${t.name}</b><span>${t.why}</span>
        </div>`
      )
      .join("");
    $("cf-templates")
      .querySelectorAll("[data-tpl]")
      .forEach((el) => {
        (el as HTMLElement).onclick = () => {
          const t = tpls.find((x) => x.id === (el as HTMLElement).dataset.tpl);
          if (!t) return;
          // 템플릿은 값을 채워만 준다. 저장은 여전히 사람이 누른다 —
          // prune 처럼 되돌릴 수 없는 것이 섞여 있다.
          cfValues = { ...t.values };
          renderConf();
          $("cf-note").innerHTML = `<b>${t.name}</b> 값을 채웠습니다. ${t.note}`;
        };
      });

    renderConf();
    $("cf-others").innerHTML = (cur.others || []).length
      ? `<p class="meta" style="margin-top:12px">이 앱이 관리하지 않는 줄 ${cur.others.length}개는
         그대로 둡니다: <code>${cur.others.join("</code> <code>")}</code></p>`
      : "";
  } catch (e) {
    $("cf-note").innerHTML = `<span class="danger">${e}</span>`;
  }
}

function renderConf() {
  $("cf-fields").innerHTML = cfOptions
    .map((o) => {
      const v = cfValues[o.key];
      const isSet = v !== undefined && v !== null;
      const input =
        o.type === "switch"
          ? `<label class="check" style="margin:0">
               <input type="checkbox" data-cf="${o.key}" ${isSet && v ? "checked" : ""} />
               <span>${isSet && v ? "켬" : "끔"}</span>
             </label>`
          : `<input type="number" data-cf="${o.key}" value="${isSet ? v : ""}"
                    placeholder="기본값" min="0" />`;
      return `<div class="cfrow">
        <div class="lb">${o.label}<small>${o.key}</small></div>
        <div>${input}</div>
        <div class="ex">${o.what}
          ${o.cost ? `<br><b class="hint">${o.cost}</b>` : ""}
          ${o.warn ? `<span class="w">${o.warn}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");

  $("cf-fields")
    .querySelectorAll("[data-cf]")
    .forEach((el) => {
      (el as HTMLElement).oninput = () => {
        const k = (el as HTMLElement).dataset.cf!;
        const e = el as HTMLInputElement;
        // 빈 칸은 "지운다"는 뜻이다. prune=0 을 쓰는 것과 줄을 없애는 것은
        // 노드에게 다른 말이다.
        cfValues[k] = e.type === "checkbox" ? (e.checked ? 1 : null) : e.value === "" ? null : +e.value;
        if (e.type === "checkbox") renderConf();
      };
    });
}

async function saveConf() {
  // 되돌릴 수 없는 것이 켜지는지 먼저 본다.
  const dangerous = cfOptions
    .filter((o) => o.danger && cfValues[o.key])
    .map((o) => `· ${o.label} — ${o.warn}`);
  if (dangerous.length) {
    if (!(await sure("되돌리기 어려운 설정이 있습니다", dangerous.join("\n"), "저장합니다"))) return;
  }

  try {
    const r = await invoke<any>("conf_write", { values: cfValues });
    $("cf-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>저장했습니다</h3>` +
      (r.wrote || []).map((w: any) => `<div class="kv"><b>${w.key}</b><span>${w.value}</span></div>`).join("") +
      `<p class="meta"><b>노드를 다시 켜야 적용됩니다.</b> 지금은 아직 예전 설정으로 돌고 있습니다.<br />
       이전 설정은 <code>raven.conf.bak</code> 로 남겼습니다.</p></div>`;
    $("cf-note").textContent = "";
  } catch (e) {
    $("cf-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
}

// ── 배당 ──────────────────────────────────────────────────────────────────
//
// 자산을 내는 것은 쉽다(500 RVN). 그 자산을 **가질 이유**를 만드는 것이 어렵다.
// 배당이 그 이유다. 코어에는 있고 우리에겐 없던 기능이다.

let rwDryOk = false;

async function loadReward() {
  try {
    const g = await invoke<any>("reward_ready");
    if (!g.ready) {
      // 노드가 뱉는 영문 오류를 그대로 보여 주면 사장은 무슨 말인지 모른다.
      $("rw-gate").innerHTML =
        `<div class="warnbox">
           <b>${escapeHtml(g.why)}</b><br />${escapeHtml(g.fix)}
         </div>`;
      $("rw-body").style.display = "none";
      return;
    }
    $("rw-gate").innerHTML = "";
    $("rw-body").style.display = "";
    const n = await invoke<any>("reward_now");
    // 사장은 블록 번호를 모른다. "언제" 를 고르면 우리가 번호로 바꾼다.
    const setWhen = (min: number) => {
      const blocks = Math.max(2, Math.round((min * 60) / (n.seconds_per_block || 60)));
      ($("rw-height") as HTMLInputElement).value = String(n.height + blocks);
      $("rw-now").textContent = `그때 명단이 굳습니다. (${(n.height + blocks).toLocaleString()}번 블록)`;
    };
    $("rw-when")
      .querySelectorAll<HTMLElement>("[data-min]")
      .forEach((b) => {
        b.onclick = () => {
          $("rw-when").querySelectorAll("[data-min]").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          setWhen(Number(b.dataset.min));
        };
      });
    setWhen(10);
    await loadRewardList();
  } catch (e) {
    $("rw-gate").innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
  }
}

async function loadRewardList() {
  try {
    const r = await invoke<any>("reward_requests", {
      asset: ($("rw-asset") as HTMLInputElement).value.trim(),
    });
    const list: any[] = Array.isArray(r.requests) ? r.requests : [];
    $("rw-list").innerHTML = list.length
      ? list
          .map((x) => {
            const h = x.block_height ?? x.height ?? 0;
            const left = h - (r.now || 0);
            return `<div class="kv"><b>${escapeHtml(String(x.asset_name || x.asset || ""))} · ${h}</b>
              <span>${left > 0 ? `${left}블록 남음 (약 ${Math.round(left / 1)}분)` : "굳었습니다"}
              <button class="ghost" data-snap="${h}" style="min-height:30px;padding:0 9px">명단 보기</button></span></div>`;
          })
          .join("")
      : `<div class="meta">아직 예약이 없습니다.</div>`;
    $("rw-list")
      .querySelectorAll<HTMLElement>("[data-snap]")
      .forEach((b) => {
        b.onclick = async () => {
          try {
            const v = await invoke<any>("reward_snapshot", {
              asset: ($("rw-asset") as HTMLInputElement).value.trim(),
              height: Number(b.dataset.snap),
            });
            $("rw-out").innerHTML =
              `<div class="card"><h3>보유자 ${v.holders}명</h3>
                 <div class="kv"><b>합계</b><span>${fmtQty(v.total_owned)}</span></div></div>`;
          } catch (e) {
            $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
          }
        };
      });
  } catch {}
}

function rwArgs(dry: boolean) {
  return {
    asset: ($("rw-asset") as HTMLInputElement).value.trim(),
    height: Number(($("rw-height") as HTMLInputElement).value),
    payWith: ($("rw-pay") as HTMLInputElement).value.trim(),
    amount: parseFloat(($("rw-amt") as HTMLInputElement).value),
    skip: ($("rw-skip") as HTMLInputElement).value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    dry,
    passphrase: null as string | null,
  };
}

async function rewardDry() {
  $("rw-out").innerHTML = `<div class="meta">계산 중…</div>`;
  rwDryOk = false;
  ($("rw-go") as HTMLButtonElement).disabled = true;
  try {
    const r = await invoke<any>("reward_distribute", rwArgs(true));
    $("rw-out").innerHTML =
      `<div class="card"><h3>이렇게 나갑니다</h3>
         <pre style="white-space:pre-wrap;font-size:13px;margin:0">${escapeHtml(
           JSON.stringify(r.result, null, 2),
         )}</pre></div>`;
    rwDryOk = true;
    ($("rw-go") as HTMLButtonElement).disabled = false;
  } catch (e) {
    $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
  }
}

async function rewardGo() {
  // 미리보기를 안 본 사람은 못 보낸다. 몇 명에게 얼마가 가는지 모르고 누르는
  // 버튼은 버튼이 아니라 함정이다.
  if (!rwDryOk) return;
  const a = rwArgs(false);
  const ok = await sure(
    "정말 보낼까요?",
    `${a.asset} 보유자에게 ${a.payWith} ${a.amount} 을 나눠 줍니다. 되돌릴 수 없습니다.`,
    "보내기",
  );
  if (!ok) return;
  const pass = await ask("지갑 암호", "한 번만 열고 바로 잠급니다.", { password: true });
  if (!pass) return;
  $("rw-out").innerHTML = `<div class="meta">보내는 중…</div>`;
  try {
    const r = await invoke<any>("reward_distribute", { ...a, passphrase: pass });
    $("rw-out").innerHTML =
      `<div class="card"><h3>보냈습니다</h3>
         <pre style="white-space:pre-wrap;font-size:13px;margin:0">${escapeHtml(
           JSON.stringify(r.result, null, 2),
         )}</pre></div>`;
    rwDryOk = false;
    ($("rw-go") as HTMLButtonElement).disabled = true;
  } catch (e) {
    $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
  }
}

// ── 받을 주소록 ───────────────────────────────────────────────────────────
//
// 코어에는 있고 여기엔 없던 것이다. 코어의 주소록을 그대로 쓴다 — 우리 파일을
// 따로 만들면 같은 지갑을 두 프로그램이 다르게 기억하게 되고, 그건 사고의 씨앗이다.

async function loadAddrBook() {
  try {
    const r = await invoke<any>("addr_book");
    const rows: any[] = r.rows || [];
    $("abk-sum").textContent = `${rows.length}개 · ${fmtQty(r.total || 0)} RVN`;
    $("abk-list").innerHTML = rows.length
      ? rows
          .map(
            (x) => `<div class="abkrow">
              <span class="nm ${x.label ? "" : "none"}">${
                x.label ? escapeHtml(x.label) : "이름 없음"
              }${x.change ? `<div class="chg">거스름돈</div>` : ""}</span>
              <span class="ad" title="${escapeHtml(x.address)}">${escapeHtml(x.address)}</span>
              <span class="bl">${fmtQty(x.balance || 0)}</span>
              <button class="ghost" data-copy="${escapeHtml(x.address)}">복사</button>
              <button class="ghost" data-name="${escapeHtml(x.address)}">이름</button>
            </div>`,
          )
          .join("")
      : emptyWithRaven("아직 이름 붙인 주소가 없습니다.<br />위에서 하나 만들어 보세요.", "hello");

    $("abk-list")
      .querySelectorAll<HTMLElement>("[data-copy]")
      .forEach((b) => {
        b.onclick = async () => {
          await navigator.clipboard.writeText(b.dataset.copy || "");
          b.textContent = "복사됨";
          setTimeout(() => (b.textContent = "복사"), 1400);
        };
      });
    $("abk-list")
      .querySelectorAll<HTMLElement>("[data-name]")
      .forEach((b) => {
        b.onclick = async () => {
          const addr = b.dataset.name || "";
          const name = await ask("이 주소의 이름", addr, { value: "" });
          if (name === null) return;
          try {
            await invoke("addr_label", { address: addr, label: name });
            await loadAddrBook();
          } catch (e) {
            $("abk-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
          }
        };
      });
  } catch (e) {
    $("abk-list").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  }
}

async function newAddrWithName() {
  const name = ($("abk-name") as HTMLInputElement).value.trim();
  $("abk-note").textContent = "만드는 중…";
  try {
    const r = await invoke<any>("addr_new", { label: name });
    ($("abk-name") as HTMLInputElement).value = "";
    // 만든 주소를 바로 보여 준다. 목록에서 찾게 하면 방금 만든 것이 어느
    // 줄인지 몰라 다시 만든다.
    $("abk-note").innerHTML =
      `만들었습니다 — <b>${escapeHtml(r.address)}</b>` +
      ` <button class="ghost" id="abk-cp" style="min-height:30px;padding:0 9px">복사</button>`;
    const cp = document.getElementById("abk-cp");
    if (cp)
      cp.onclick = async () => {
        await navigator.clipboard.writeText(r.address);
        cp.textContent = "복사됨";
      };
    await loadAddrBook();
  } catch (e) {
    $("abk-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  }
}

// ── 백업 ──────────────────────────────────────────────────────────────────
//
// 체인은 지갑을 복구해 주지 않는다. 자산은 체인에 있지만 그걸 움직일 열쇠는
// 이 파일 하나뿐이고, 잃으면 자산이 남아 있는 채로 영원히 못 만진다.

async function loadBackup() {
  try {
    const b = await invoke<any>("backup_survey");
    $("bk-list").innerHTML = (b.items || [])
      .map(
        (i: any) =>
          `<div class="kv"><b>${i.name}</b><span>${
            i.exists ? fmtBytes(i.size) : "<span class='warn'>없음</span>"
          } — ${i.why}</span></div>`
      )
      .join("");
  } catch {}
}

// ── 번 돈 금고로 옮기기 ────────────────────────────────────────────────────
//
// sweep_run 은 5분마다 돌고 있었지만 sweep_configure 를 부르는 자리가 없어서
// 설정이 빈 {} 였다. 즉 한 번도 발동한 적이 없다. 엔진만 있고 문이 없었다.

async function loadSweep() {
  try {
    const s = await invoke<any>("sweep_read");
    const on = !!s?.enabled && !!s?.to;
    if (on) {
      (($("sw-to") as HTMLInputElement).value ||= String(s.to || ""));
      (($("sw-above") as HTMLInputElement).value ||= String(s.above ?? ""));
      (($("sw-keep") as HTMLInputElement).value ||= String(s.keep ?? ""));
    }
    $("sw-state").innerHTML = on
      ? `켜져 있습니다 — <b>${fmtQty(Number(s.above))} RVN</b> 을 넘으면 ` +
        `<b>${fmtQty(Number(s.keep))} RVN</b> 만 남기고 금고로 보냅니다.`
      : "<span class='warn'>꺼져 있습니다.</span> 번 돈이 계속 이 컴퓨터에 쌓입니다.";
  } catch {
    $("sw-state").textContent = "";
  }
}

async function saveSweep(enabled: boolean) {
  const to = ($("sw-to") as HTMLInputElement).value.trim();
  const above = parseFloat(($("sw-above") as HTMLInputElement).value);
  const keep = parseFloat(($("sw-keep") as HTMLInputElement).value);
  $("sw-note").textContent = enabled ? "확인 중…" : "끄는 중…";
  try {
    // 끌 때는 주소를 검사하지 않는다 — 잘못 저장해 둔 주소 때문에 끌 수조차
    // 없게 되면, 사장님은 기능을 못 끄고 우리에게 전화한다.
    await invoke("sweep_configure", {
      toAddress: to,
      above: isFinite(above) ? above : 0,
      keep: isFinite(keep) ? keep : 0,
      enabled,
    });
    $("sw-note").textContent = enabled ? "켰습니다." : "껐습니다.";
    await loadSweep();
  } catch (e: any) {
    $("sw-note").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
  }
}

// 백업을 어디 둘지 — 이미 붙어 있는 클라우드와 꽂혀 있는 디스크를 찾아서 보여준다.
async function loadPlaces() {
  try {
    const [c, d] = await Promise.all([
      invoke<any>("cloud_folders").catch(() => ({ folders: [] })),
      invoke<any>("external_drives").catch(() => ({ drives: [] })),
    ]);
    const rows: string[] = [];
    for (const f of c.folders || [])
      rows.push(
        `<div class="kv place" data-dest="${escapeHtml(f.path)}"><b>${escapeHtml(f.name)}</b>
           <span>클라우드 — 눌러서 여기에 백업</span></div>`
      );
    for (const v of d.drives || [])
      rows.push(
        `<div class="kv place" ${v.writable ? `data-dest="${escapeHtml(v.path)}"` : ""}><b>${escapeHtml(v.name || v.path)}</b>
           <span>${v.writable ? "디스크 — 눌러서 여기에 백업" : "<span class='warn'>쓰기 불가</span>"}</span></div>`
      );
    const def = c.default || {};
    const defLabel = String(def.label || "내 서류함");
    const viaRaw = String(def.via || "").trim();
    const viaName: Record<string, string> = {
      OneDrive: "원드라이브",
      "OneDrive 회사": "회사 원드라이브",
      "Google Drive": "구글드라이브",
      "iCloud Drive": "아이클라우드",
      Dropbox: "드롭박스",
      Nextcloud: "넥스트클라우드",
    };
    const via = viaName[viaRaw] || viaRaw;
    const hint = via
      ? `이 폴더는 ${via}와 같이 갑니다.`
      : (c.folders || []).length
        ? "붙어 있는 클라우드에도 매일 자동으로 한 벌을 남깁니다."
        : "원드라이브·구글드라이브를 켜 두면 거기도 자동으로 남깁니다.";
    $("bk-places").innerHTML =
      (rows.length
        ? rows.join("")
        : `<div class="meta">붙어 있는 클라우드나 외장 디스크가 없습니다.</div>`) +
      `<div class="row" style="margin-top:12px">
         <button class="ghost" id="bk-pick">다른 폴더 고르기…</button>
         <span class="meta">아무것도 안 고르면 「${escapeHtml(defLabel)}」에 만듭니다. ${escapeHtml(hint)}</span>
       </div>`;

    // 목록의 줄을 직접 누르면 거기에 만든다. 여태 「여기에 백업 만들기」 버튼
    // 하나가 목록 아래에 있었는데, 어느 줄을 고르든 **바탕화면에 만들었다.**
    // 화면이 고를 수 있다고 말해 놓고 안 고르는 것은 그냥 거짓말이다.
    $("bk-places")
      .querySelectorAll<HTMLElement>("[data-dest]")
      .forEach((el) => {
        // 🔴 눌러도 **그 줄은 아무 변화가 없었다.** 안내는 저 아래 다른 자리에
        //    떠서, 사장은 눌린 건지도 모른 채 몇 번을 더 눌렀다. 누른 자리에서
        //    답해야 한다 — 사람은 자기가 만진 곳을 본다.
        el.onclick = async () => {
          if (el.dataset.busy) return; // 두 번 누르면 두 번 만든다
          el.dataset.busy = "1";
          const label = el.querySelector("span");
          const was = label?.textContent || "";
          el.style.opacity = "0.6";
          if (label) label.textContent = "백업 중… 잠시만요";
          try {
            const r = await doBackup(el.dataset.dest || "");
            el.style.opacity = "1";
            if (label)
              label.textContent = r
                ? `✅ 여기에 만들었습니다 — ${r}`
                : "✅ 여기에 만들었습니다";
            el.style.borderLeft = "3px solid var(--ok, #2f9e44)";
          } catch (e) {
            el.style.opacity = "1";
            if (label) label.textContent = `🔴 ${errText(e).slice(0, 60)}`;
            el.style.borderLeft = "3px solid var(--danger, #c92a2a)";
          } finally {
            delete el.dataset.busy;
            // 다음에 다시 누를 수 있게 잠시 뒤 원래 문구로.
            window.setTimeout(() => {
              if (label && !el.dataset.busy) label.textContent = was;
              el.style.borderLeft = "";
            }, 12_000);
          }
        };
      });

    const pick = document.getElementById("bk-pick");
    if (pick)
      pick.onclick = async () => {
        // 경로를 타이핑하게 하지 않는다. OS 가 고르게 한다.
        const dir = await pickFile({
          title: "백업을 둘 폴더를 고르세요",
          directory: true,
          multiple: false,
        }).catch(() => null);
        if (typeof dir === "string") void doBackup(dir);
      };
  } catch {
    $("bk-places").textContent = "";
  }
}

async function doBackup(destFolder = ""): Promise<string> {
  // 아무것도 묻지 않는다. 폴더 경로를 타이핑하게 하는 것은 백업을 안 하게 하는
  // 가장 확실한 방법이었다. 바탕화면에 파일 하나로 만들고, 어디 뒀는지 알려준다.
  const node: any = await invoke("node_identity").catch(() => ({}));
  // 날짜를 이름에 넣지 않는다. 넣으면 날마다 새 파일이 되어 회전이 안 걸리고
  // 폴더가 zip 으로 찬다. 언제 만든 백업인지는 zip 안 설명서에 적혀 있다.
  const label = node?.name || "";

  $("bk-note").textContent = "백업 중…";
  try {
    const r = await invoke<any>("backup_zip", { destFolder, label, includeWallet: true });
    // 🔴 **어디에 만들었는지 짐작해서 적지 않는다.** 「바탕화면에 있습니다」로
    //    박아 뒀는데 기본 폴더를 서류함으로 바꾸자 그 문장이 거짓말이 됐고,
    //    사장은 바탕화면을 뒤졌다. 러스트가 돌려준 **진짜 경로**를 읽는다.
    // 🔴 윈도우 경로는 백슬래시라 lastIndexOf("/") 가 빈 칸이 된다.
    //    어디서 만들었는지는 러스트가 돌려 준 pretty 를 쓴다.
    const pretty = String(r.pretty || "");
    const whereText = pretty ? `${pretty} 에 있습니다.` : "만들었습니다.";
    $("bk-result").innerHTML =
      `<div class="card" style="margin-top:11px">
         <h3>파일 하나로 만들었습니다</h3>
         <div class="kv"><b>${r.name}</b><span>${r.size_text}</span></div>
         <p class="meta">${escapeHtml(whereText)} 이 파일 하나만 USB나 다른 컴퓨터에 옮겨 두시면
           됩니다 — 가게 전부가 들어 있습니다.</p>
         ${(r.inside || []).map((i: any) => `<div class="kv"><b>${i.name}</b><span>${i.what}</span></div>`).join("")}
       </div>` +
      (r.warning
        ? `<div class="warnbox" style="margin-top:9px">${r.warning}</div>`
        : "");
    $("bk-note").textContent = "";
    // 누른 줄이 「무엇을」 만들었는지 말할 수 있게 이름을 돌려준다.
    return String(r.size_text || "");
  } catch (e) {
    $("bk-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
    $("bk-note").textContent = "";
    // 🔴 삼켜서 「됐다」로 보이게 하면 안 된다. 누른 줄이 빨갛게 되어야 한다.
    throw e;
  }
}

async function showSeed() {
  const pass = await ask(
    "지갑 암호",
    "복구 단어가 화면에 뜹니다. 주변에 사람이 없는지 먼저 보세요.",
    { password: true }
  );
  if (!pass) return;
  try {
    const r = await invoke<any>("reveal_seed", { passphrase: pass });
    $("sd-words").innerHTML =
      `<div class="seedgrid">` +
      (r.words || [])
        .map((w: string, i: number) => `<div class="seedword"><i>${i + 1}</i>${w}</div>`)
        .join("") +
      `</div>`;
    // 시드 뒤에 추가 암호가 걸려 있으면 단어만 적어 둔 사람은 나중에 못 연다.
    $("sd-extra").innerHTML = r.has_extra_passphrase
      ? `<span class="danger">이 지갑에는 단어 외에 추가 암호가 걸려 있습니다.
         그 암호도 함께 기억해야 복구됩니다.</span>`
      : "";
    $("seedsheet").classList.remove("hidden");
  } catch (e) {
    $("bk-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
  }
}



// ── 첫 실행 ───────────────────────────────────────────────────────────────
//
// 첫날의 목표는 티켓 한 장이다. 장부가 45 GB를 받는 동안, 지갑에 암호가 없는
// 채로, 체인에 가게를 등록하지 않은 채로 주문을 받을 수 있어야 한다. 그 순서를
// 뒤집으면 사람은 첫 주에 공책으로 돌아간다.

const ONBOARD_KEY = "playx-onboarded";
/// 폰 서버를 한 번이라도 켠 적이 있는가. 다음 실행에서 스스로 켤 근거다.
const PHONE_KEY = "playx-phone-on";
/** 손님 폰 서버가 왜 안 켜졌나. 「문제 알리기」에 같이 실려 나간다. */
let lastPhoneError = "";
let obRec: any = null;

/// 첫 실행의 단계들. 이름으로 부른다.
///
/// 번호였을 때, 중간에 화면 하나를 끼우면서 뒤 번호를 밀었는데 핸들러 세 곳을
/// 빠뜨렸다. 「다음」이 자기 자신을 다시 열었고, 화면은 멀쩡해 보였고, 눌러 본
/// 사람만 알 수 있었다. 이름은 밀리지 않는다.
type ObStep = "scan" | "use" | "verdict";

/// 첫 실행을 끝내고 본 화면으로 보낸다.
///
/// 이 프로그램이 처음 켜졌을 때 할 일은 이 컴퓨터를 얼마나 쓸지 정하는 것뿐이다.
/// 가게를 만드는 것은 [내 가게]를 누른 사람의 일이고, 그 화면이 이미 간판·메뉴·
/// 사진을 다 갖고 있다.
function obDone() {
  localStorage.setItem(ONBOARD_KEY, "1");
  $("onboard").classList.add("hidden");
  showPage("shop");
  // 가게가 아직 없으면 주문 탭은 빈 화면이다. 그 화면이 첫인상이면 사람은
  // 무엇을 해야 하는지 모른 채 앱을 닫는다. 가게를 만드는 탭으로 연다 —
  // 거기 맨 위가 "적으면 AI가 채우는" 칸이다.
  shopTab(($("sh-ko") as HTMLInputElement).value.trim() ? "orders" : "mine");
}

function obShow(step: ObStep) {
  const found = document.querySelectorAll<HTMLElement>(".ob-step");
  let hit = false;
  found.forEach((d) => {
    const on = d.dataset.ob === step;
    if (on) hit = true;
    d.classList.toggle("on", on);
  });
  // 없는 화면을 부르면 온보딩이 통째로 빈 화면이 된다. 조용히 지나가면 안 된다.
  if (!hit) console.error(`온보딩 단계 '${step}' 가 화면에 없습니다`);
}

async function startOnboard() {
  $("onboard").classList.remove("hidden");
  obShow("scan");

  // 살펴보는 티가 나야 한다. 즉시 결과가 나오면 아무것도 안 본 것처럼 보인다.
  await new Promise((r) => setTimeout(r, 1400));

  let m: any = null;
  let now: any = null;
  try {
    m = await invoke<any>("inspect_machine");
    now = await invoke<any>("disk_now");
  } catch {}

  // ── 이미 돌리고 계신 분에게는 묻지 않는다 ──────────────────────
  // 이 질문이 갈림길인 것은 장부가 아직 없을 때뿐이다. 45 GB를 이미 받아 둔
  // 컴퓨터에서 첫 화면 두 번째 칸이 "39 GB를 지웁니다"인 것은, 잘 돌아가던
  // 노드를 처음 보는 화면이 지우겠다고 나서는 것과 같다.
  //
  // 이미 있으면 설정 파일에 손대지 않고 지나간다. 장부 크기를 줄이고 싶으면
  // 그건 나중에 [이 컴퓨터] 안에서 고르면 되는 일이다.
  if (now && now.chain_gb >= 1) {
    obRec = null;
    // 🔴 **조용히 지나가면 안 된다.** 사장은 「내가 쓰던 레이븐 코어 자료를
    //    쓰는 건가, 34GB 를 또 받는 건가」를 알고 싶어 한다. 그게 몇 시간과
    //    하루가 갈리는 문제다. 그런데 여태 아무 말 없이 넘어갔다.
    //
    //    묻지는 않는다 — 이미 있는 것을 쓰는 게 유일하게 옳은 답이라 고르게
    //    할 이유가 없다. 다만 **무엇을 했는지 말한다.**
    let where = "";
    try {
      const d = await invoke<any>("datadir_status");
      where = String(d?.path || "");
    } catch {}
    const scan = $("ob-scanning");
    if (scan) {
      scan.innerHTML =
        `<b>레이븐 코어 자료를 찾았습니다 — ${now.chain_gb} GB.</b><br />` +
        "그대로 씁니다. 다시 받지 않습니다." +
        (where
          ? `<br /><span style="opacity:.7;font-size:13px">${escapeHtml(where)}</span>`
          : "");
    }
    // 읽을 틈을 준다. 바로 넘어가면 못 본다.
    await new Promise((r) => setTimeout(r, 2600));
    try {
      await invoke("open_shop");
    } catch {}
    obDone();
    return;
  }

  if (m) {
    const free = m.free_disk_gb ?? 0;
    // 47 GB 가 안 들어가는 컴퓨터에서 "가게 전용"은 고를 수 있는 답이 아니다.
    if (free < 90) {
      const only = $("ob-only") as HTMLButtonElement;
      only.disabled = true;
      only.style.opacity = "0.45";
      $("ob-only-gb").textContent = `빈 공간이 ${free} GB뿐이라 고를 수 없습니다`;
    }
    $("ob-usehint").textContent = m.laptop
      ? "노트북으로 보입니다. 이 컴퓨터로 다른 일도 하신다면 아래쪽을 고르세요."
      : "";
  }

  obShow("use");
}

/// 답을 받아 판정을 만든다. 여기서부터는 다시 기계가 정한다.
async function obChoose(shopOnly: boolean) {
  try {
    obRec = await invoke<any>("recommend_setup_for", { shopOnly });
  } catch {
    obRec = null;
  }
  if (!obRec) {
    // 기계를 못 읽어도 쓸 수는 있어야 한다. 설정은 [이 컴퓨터]에서 언제든 한다.
    obDone();
    return;
  }

  const prune = obRec.conf?.prune != null;
  $("ob-verdict").textContent = prune
    ? `장부는 최근 것만 남깁니다 — 약 ${obRec.disk_use_gb} GB`
    : `장부를 전부 보관합니다 — 약 ${obRec.disk_use_gb} GB`;
  $("ob-reasons").innerHTML = (obRec.reasons || [])
    .map((r: string) => `<div>${r}</div>`)
    .join("");

  // 되돌릴 수 없는 것만 문장을 치게 한다. 체크박스는 그냥 눌린다.
  // 지갑 복구 제약은 돈이 걸린 이야기라 여기서 같이 말한다 — 나중에 12단어로
  // 되살릴 때 옛 거래를 못 찾는다는 것을 그때 알면 늦는다.
  $("ob-irrev").innerHTML = obRec.irreversible
    ? `<div class="warnbox" style="margin-top:16px">
         오래된 장부를 지우는 것은 <b>되돌릴 수 없습니다.</b> 되돌리려면 45 GB를 처음부터
         다시 받아야 합니다.<br />
         그리고 이 상태에서는 <b>12단어로 지갑을 되살려도 옛 거래를 찾지 못합니다.</b>
         지금 쓰는 지갑은 그대로지만, 백업으로 복구할 때는 전부 보관 상태가 필요합니다.<br />
         아래 문장을 그대로 입력하세요.
         <pre class="conf" style="margin-top:9px">오래된 것만 남김</pre>
         <input id="ob-confirm" autocomplete="off" />
       </div>`
    : "";
  const go = $("ob-apply") as HTMLButtonElement;
  go.disabled = !!obRec.irreversible;
  if (obRec.irreversible) {
    $("ob-confirm").addEventListener("input", () => {
      go.disabled = ($("ob-confirm") as HTMLInputElement).value.trim() !== "오래된 것만 남김";
    });
  }

  // 아껴 쓰라고 판정했을 때만, 그리고 실제로 들어갈 때만 문을 연다.
  const ov = $("ob-override") as HTMLButtonElement;
  const fits = (obRec.machine?.free_disk_gb ?? 0) >= 90;
  ov.style.display = prune && fits ? "" : "none";
  ov.textContent = `그래도 전부 보관하기 — 약 47 GB를 씁니다`;

  // "무엇이 달라지나요"는 무엇이 *되는지*가 아니라 무엇이 *바뀌는지*여야 한다.
  // key = value 만 보여 주면 "그대로 되나요"라는 질문에 답을 못 한다.
  // 기본값은 레이븐 코어 소스 기준: dbcache 450 · maxconnections 125 · maxmempool 300.
  const DEFAULTS: Record<string, number> = { dbcache: 450, maxconnections: 125, maxmempool: 300, server: 0 };
  const WORDS: Record<string, string> = {
    dbcache: "메모리 사용",
    maxconnections: "다른 노드와 연결",
    maxmempool: "대기 중인 거래 보관",
    server: "이 앱이 노드에 말 걸기",
    prune: "장부 정리",
  };
  let cur: Record<string, number> = {};
  try {
    cur = ((await invoke<any>("conf_read")) || {}).values || {};
  } catch {}

  const rows = Object.entries(obRec.conf || {})
    .filter(([, v]) => v !== null)
    .map(([k, v]) => {
      const before = cur[k] ?? DEFAULTS[k] ?? 0;
      const set = k in cur;
      const same = Number(before) === Number(v);
      const name = WORDS[k] || k;
      if (same) return `<div>${name} — 지금과 같습니다 (${v})</div>`;
      return `<div>${name} — <b>${before}${set ? "" : " (기본값)"} → ${v}</b></div>`;
    });
  // 장부 크기는 숫자 두 개보다 이 한 줄이 정확하다.
  rows.unshift(
    obRec.conf?.prune != null
      ? `<div>장부 — <b>갖고 있는 것에서 옛 것을 지웁니다.</b> 다시 받지 않습니다.</div>`
      : `<div>장부 — <b>손대지 않습니다.</b> 지금 것 그대로 둡니다.</div>`
  );
  rows.push(`<div>사진 창고(IPFS) — 설정을 <b>${obRec.ipfs_profile}</b>로 맞춥니다.</div>`);
  rows.push(`<div style="margin-top:8px;color:var(--faint)">노드를 다시 켤 때 적용됩니다.</div>`);
  $("ob-nums").innerHTML = rows.join("");

  obShow("verdict");
}

async function obApply() {
  const btn = $("ob-apply") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "켜는 중…";
  try {
    await invoke("apply_setup", { conf: obRec.conf, ipfsProfile: obRec.ipfs_profile });
    // 장부와 사진 창고를 켠다. 바깥 주소와 지갑 암호는 아직 묻지 않는다.
    await invoke("open_shop").catch(() => {});
  } catch {}
  btn.textContent = "이대로 켜기";
  obDone();
}

// ── 이 컴퓨터: 능력 스위치 ────────────────────────────────────────────────
//
// 스위치는 "지금 돌고 있나"만 말한다. 켜지지도 않았는데 손잡이가 오른쪽으로
// 가면, 사람은 이미 켜진 줄 알고 저장을 안 누른다. 그래서 행을 누르면 설정이
// 열리고, 스위치는 실제로 켜진 뒤에만 움직인다.

type Switch = {
  id: string;
  title: string;
  desc: string;
  on: () => boolean;
  body?: string;
  apply: string;
  run: () => Promise<void>;
};

let swOpen = "";

/// 만들어 둔 QR.
///
/// 전에는 startPhone 이 화면에 직접 그렸는데, 바로 뒤에 refreshSwitchState 가
/// renderSwitches 를 불러 스위치 목록을 innerHTML 로 통째로 다시 그렸다. 그
/// 순간 QR 이 들어 있던 칸이 새로 만들어지며 사라진다 — 켜지긴 켜졌는데 화면엔
/// 아무것도 없는 상태가 그래서 나왔다.
///
/// 그리는 것은 상태에서 나와야 한다. 그래야 몇 번을 다시 그려도 남는다.
let phoneQr = "";

function switches(): Switch[] {
  return [
    {
      id: "phone",
      title: "손님 폰으로 받기",
      desc: "손님이 QR을 찍어 주문합니다. 같은 wifi 안에서 됩니다.",
      on: () => !!serverIp,
      body:
        `<div class="meta">켜면 QR 네 개가 나옵니다 — 사장님·직원·검표·손님.</div>` +
        `<div id="ph-qr" class="qrrow">${phoneQr}</div>`,
      apply: "지금 켜기",
      run: async () => { await startPhone(); },
    },
    {
      id: "tunnel",
      title: "바깥에서도 열리게",
      desc: "매장 밖에서도 주문·판매 링크가 열립니다. Cloudflare를 지나갑니다.",
      on: () => !!tunnelUrl,
      body: `<div class="meta" id="tn-detail"></div>`,
      apply: "지금 켜기",
      run: async () => { await toggleTunnel(); },
    },
    {
      // 터널을 켜는 것과, 가게 도구를 남에게 내주는 것은 다른 결정이다.
      // 하나로 묶으면 두 번째가 첫 번째를 하다가 사고로 결정된다.
      id: "remoteadmin",
      title: "바깥에서 계산대까지 열기",
      desc: "끄면 바깥 주소로는 손님 화면만 열립니다. 켜면 사장·직원 화면도 열립니다.",
      on: () => remoteAdmin,
      body: `<div class="meta" id="ra-detail"></div>`,
      apply: "지금 켜기",
      run: async () => { await toggleRemoteAdmin(); },
    },
    {
      id: "autostart",
      title: "정전 뒤 자동으로 켜기",
      desc: "전원이 돌아오면 노드가 저절로 켜집니다. 앱은 켜지지 않습니다.",
      on: () => autostartOn,
      body: `<div class="meta">노드만 켭니다. 앱까지 저절로 켜지면 아무도 없는 방에서 지갑이 열립니다.</div>`,
      apply: "지금 켜기",
      run: async () => { await toggleAutostart(); },
    },
    {
      id: "lowspec",
      title: "오래된 컴퓨터로 아끼기",
      desc: "디스크 45 GB → 5 GB, 메모리와 연결도 줄입니다.",
      on: () => lowspecOn,
      body: `<div class="warnbox" style="font-size:14px">
               <b>한 번 켜면 되돌릴 수 없습니다.</b> 끄려면 체인을 처음부터 다시 받아야 합니다(몇 시간).
             </div>`,
      apply: "저장하고 다시 켜기 안내",
      run: async () => { await applyLowspec(); },
    },
  ];
}

let autostartOn = false;
let lowspecOn = false;

function renderSwitches() {
  const list = switches();
  $("sw-list").innerHTML = list
    .map((s) => {
      const on = s.on();
      const open = swOpen === s.id;
      return `<div class="sw ${on ? "on" : ""} ${open ? "open" : ""}" data-sw="${s.id}">
        <div class="sw-head">
          <div class="sw-text">
            <div class="sw-title">${s.title}</div>
            <div class="sw-desc">${s.desc}</div>
          </div>
          <div class="sw-state ${on ? "on" : "off"}">${on ? "켜짐" : "꺼짐"}</div>
          <div class="sw-toggle"></div>
        </div>
        <div class="sw-body">
          ${s.body || ""}
          <button class="sw-apply" data-swrun="${s.id}">${on ? "지금 끄기" : s.apply}</button>
        </div>
      </div>`;
    })
    .join("");

  // 행 전체가 여는 버튼이다. 스위치는 표시일 뿐 눌러도 안 켜진다.
  $("sw-list")
    .querySelectorAll(".sw-head")
    .forEach((h) => {
      (h as HTMLElement).onclick = () => {
        const id = (h.parentElement as HTMLElement).dataset.sw!;
        swOpen = swOpen === id ? "" : id;
        renderSwitches();
        if (swOpen === "tunnel") refreshTunnel();
        if (swOpen === "remoteadmin") refreshRemoteAdmin();
        if (swOpen === "phone" && serverIp) startPhone();
      };
    });

  $("sw-list")
    .querySelectorAll("[data-swrun]")
    .forEach((b) => {
      (b as HTMLElement).onclick = async (e) => {
        e.stopPropagation();
        const btn = b as HTMLButtonElement;
        const s = list.find((x) => x.id === btn.dataset.swrun);
        if (!s) return;
        btn.disabled = true;
        const was = btn.textContent;
        btn.textContent = "…";
        try {
          await s.run();
        } catch (err) {
          say(t("안 됐습니다"), errText(err));
        }
        btn.textContent = was;
        btn.disabled = false;
        await refreshSwitchState();
      };
    });
}

async function refreshSwitchState() {
  try {
    const a = await invoke<any>("autostart_status");
    autostartOn = !!a.installed;
  } catch {}
  try {
    const c = await invoke<any>("conf_read");
    lowspecOn = !!(c.values && c.values.prune);
  } catch {}
  renderSwitches();
  checkHealth();
}

async function applyLowspec() {
  const on = lowspecOn;
  if (!on) {
    if (!(await sure("장부를 5 GB로 줄일까요?", "되돌리려면 체인을 처음부터 다시 받아야 합니다.", "줄입니다")))
      return;
  }
  const values = on
    ? { server: 1 }
    : { prune: 5000, dbcache: 300, maxconnections: 16, maxmempool: 100, server: 1 };
  await invoke("conf_write", { values });
  await invoke("ipfs_apply_profile", { name: on ? "default-networking" : "lowpower" }).catch(() => {});
  say(
    "저장했습니다",
    on
      ? "설정을 되돌렸습니다. 다만 이미 지워진 블록은 다시 받아야 합니다.\n노드를 다시 켜 주세요."
      : "노드를 다시 켜야 적용됩니다."
  );
}

// ── 지금 장사할 수 있나 ──────────────────────────────────────────────────
//
// 체인은 탈중앙이라 대표님 컴퓨터가 꺼져도 자산과 결제 기록은 남는다. 하지만
// 판매 페이지·주문·출입은 이 기계 하나가 한다. 그래서 "돈은 안 없어지고 가게만
// 닫힌다"가 정확한 표현이고, 화면은 그걸 그대로 말해야 한다.

async function checkHealth() {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  try {
    const h = await invoke<any>("service_health", {
      phoneOn: !!serverIp,
      tunnelOn: !!tunnelUrl,
    });
    const tone = { ok: "ok", down: "bad", catching_up: "warn" }[h.state as string] || "warn";
    $$("hz-card").className = `verdict ${tone}`;
    $$("hz-state").textContent =
      { ok: "지금 주문을 받을 수 있습니다", down: "주문을 받을 수 없습니다",
        catching_up: "노드가 따라잡는 중입니다", no_orders: "손님이 주문할 곳이 없습니다",
        no_photos: "사진이 손님에게 안 보입니다", local_only: "매장 안에서만 받습니다" }[
        h.state as string
      ] || String(h.state);
    $$("hz-why").textContent = h.why || "";
    $$("hz-fix").textContent = h.fix || "";

    // 포트 같은 사실은 평소에 숨긴다. 고장났을 때만 볼 이유가 있다.
    $$("hz-extra").innerHTML =
      h.state === "ok"
        ? ""
        : `<div class="meta" style="margin-top:10px">
             노드 ${h.node ? "켜짐" : "꺼짐"} · IPFS ${h.ipfs ? "켜짐" : "꺼짐"} ·
             폰 ${h.phone ? "켜짐" : "꺼짐"}${h.behind ? ` · ${h.behind} 블록 남음` : ""}
           </div>`;
  } catch {}
}

async function refreshAutostart() {
  try {
    const a = await invoke<any>("autostart_status");
    const btn = document.getElementById("as-toggle") as HTMLButtonElement | null;
    if (btn) btn.textContent = a.installed ? "자동 시작 끄기" : "자동 시작 켜기";
  } catch {}
}

async function toggleAutostart() {
  const a = await invoke<any>("autostart_status").catch(() => null);
  try {
    if (a?.installed) {
      await invoke("autostart_disable");
    } else {
      // 경로는 앱이 찾는다. 개발자 이름이 박힌 경로는 그 컴퓨터에서만 돈다.
      const p = await invoke<any>("default_paths");
      if (!p.ravend) {
        throw new Error(
          "ravend 를 찾지 못했습니다. 레이븐 노드를 어디에 설치하셨는지 확인해 주세요."
        );
      }
      await invoke("autostart_enable", { ravendPath: p.ravend, dataDir: p.data_dir });
    }
    await refreshAutostart();
  } catch (e) {
  }
}



// ── 바깥에서 열리게 ──────────────────────────────────────────────────────
//
// 매장 wifi 밖에서는 192.168.x.x 가 존재하지 않는다. 그래서 판매 링크를 X에
// 올려도 아무도 못 연다. 터널은 그걸 뚫는 유일한 현실적 방법이고, 동시에 이
// 앱에서 회사 하나가 사이에 끼는 유일한 지점이다. 둘 다 화면에 적는다.

let tunnelUrl = "";
let remoteAdmin = false;

async function refreshRemoteAdmin() {
  try {
    remoteAdmin = await invoke<boolean>("remote_admin_get");
  } catch {}
  // 터널이 꺼져 있으면 이 선택은 아무 효과가 없다. 그 사실을 말해 주지 않으면
  // 사장은 켜 놓고 왜 안 열리는지 찾는다.
  $$("ra-detail").innerHTML = !tunnelUrl
    ? `<span class="meta">바깥 주소가 아직 없습니다. 위의 「바깥에서도 열리게」를 먼저 켜세요.</span>`
    : remoteAdmin
      ? `<span class="warn">계산대·직원 화면이 인터넷에 열려 있습니다.</span>
         <span class="meta">주소를 아는 사람은 못 들어옵니다 — 열쇠는 QR 로 받은 토큰입니다.
         폰을 잃어버리면 「모든 폰 로그아웃」을 누르세요.</span>`
      : `<span class="meta">바깥에서는 손님 화면만 열립니다. 계산대와 직원 화면은 가게 안에서만 열립니다.</span>`;
}

async function toggleRemoteAdmin() {
  try {
    const r = await invoke<any>("remote_admin_set", { on: !remoteAdmin });
    remoteAdmin = !!r.on;
  } catch (e) {
    $$("ra-detail").innerHTML = `<span class="danger">${e}</span>`;
    return;
  }
  await refreshRemoteAdmin();
}

async function refreshTunnel() {
  try {
    const t = await invoke<any>("tunnel_status");
    tunnelUrl = t.url || "";

    if (!t.installed) {
      // 🔴 「터미널에서 brew install 하세요」는 안내가 아니라 **거절**이다.
      //    이 프로그램의 사장은 70대이고 터미널을 열어 본 적이 없다.
      //    우리가 받는다 — 단추 하나.
      $$("tn-detail").innerHTML =
        `<div class="card" style="margin-top:11px">
           <b>바깥에서 열려면 도구가 하나 필요합니다</b>
           <p class="meta" style="margin:6px 0 10px">
             Cloudflare 가 만든 것으로, 이 컴퓨터를 인터넷에 잠깐 이어 줍니다.
             <b>40MB 남짓</b>이고 한 번만 받으면 됩니다.
           </p>
           <button id="tn-get">지금 받기</button>
           <div class="meta" id="tn-getsay" style="margin-top:8px"></div>
         </div>`;
      $("tn-get").addEventListener("click", async () => {
        const say = $("tn-getsay");
        const btn = $("tn-get") as HTMLButtonElement;
        btn.disabled = true;
        // 40MB 다. 아무 말 없이 기다리게 하면 멈춘 줄 안다.
        // 화면 번역기가 DOM 을 훑으므로 여기서는 한국어 그대로 둔다.
          say.textContent = "받는 중… 인터넷이 느리면 몇 분 걸립니다.";
        try {
          await invoke("tunnel_install");
          say.innerHTML = `<span class="ok">다 받았습니다. 이제 켤 수 있습니다.</span>`;
          await refreshTunnel();
        } catch (e) {
          say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
          btn.disabled = false;
        }
      });
      return;
    }
    // 켜고 끄는 글자는 이제 스위치가 그린다.
    $$("tn-detail").innerHTML = t.running
      ? `<div class="card" style="margin-top:11px">
           <div class="kv"><b>바깥 주소</b><code class="addr">${t.url}</code></div>
           <p class="meta">
             이 주소는 <b>임시입니다.</b> 앱이나 터널을 다시 켜면 바뀌고,
             이미 올린 링크는 열리지 않습니다. 자주 파실 거면 고정 주소가 필요합니다.<br />
             그리고 이 통로는 <b>Cloudflare를 지나갑니다</b> — 결제는 여전히 손님 지갑이 서명하고
             체인이 정산하지만, 화면 자체는 그 회사를 거쳐 전달됩니다.
           </p>
         </div>`
      : "";
  } catch {}
}

async function toggleTunnel() {
  const btn = document.getElementById("tn-toggle") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    if (tunnelUrl) {
      await invoke("tunnel_stop");
    } else {
      $$("tn-detail").textContent = "주소를 받는 중… (몇 초 걸립니다)";
      await invoke("tunnel_start", { port: 8790 });
      // 이미 내놓은 것들의 링크가 옛 주소를 가리키고 있으므로 다시 게시한다.
      for (const o of offers) o.link = "";
    }
    await refreshTunnel();
    $$("tn-detail").textContent = "";
  } catch (e) {
    $$("tn-detail").innerHTML = `<span class="danger">${e}</span>`;
  }
  if (btn) btn.disabled = false;
}

// ── 폰 연결 ──
//
// Starting the server does two things at once, and they must stay in step: the
// customer page needs shop data published to it, or it serves an empty menu to
// whoever scans the QR.

async function startPhone() {
  phoneQr = `<div class="meta">여는 중…</div>`;
  renderSwitches();
  try {
    const r = await invoke<any>("start_phone_server");
    serverIp = r.ip;
    localStorage.setItem(PHONE_KEY, "1");
    // IP를 화면에서 되읽지 않고 그대로 넘긴다. 되읽으면 아직 "여는 중…"이라
    // 손님 폰이 사진을 못 받는다.
    await publishShop(r.ip);

    const [adminQr, staffQr, scanQr, custQr] = await Promise.all([
      invoke<string>("qr_svg", { text: r.admin_url }),
      invoke<string>("qr_svg", { text: r.staff_url }),
      invoke<string>("qr_svg", { text: r.scan_url }),
      invoke<string>("qr_svg", { text: r.customer_url }),
    ]);
    const oneLink = (url: string) =>
      `<code class="addr qrurl">${escapeHtml(url)}</code>`;
      // 🔴 **인쇄해서 문에 붙일 QR 이 없었다.**
      //
      //    손님 QR 은 `http://192.168.x.x:8790/` — **가게 와이파이에 붙은
      //    사람만** 열린다. 바깥에서 오는 길은 터널 주소인데 그건 **켤 때마다
      //    바뀐다.** 그래서 인쇄한 QR 이 내일 죽는다.
      //
      //    `rvn.ex.erci.se/s/{자산}` 은 **영원히 같다.** 체인에서 지금 터널
      //    주소를 찾아 넘겨주고, 가게가 꺼져 있으면 닫혔다고 말한다.
      //    ⚠️ 체인에 등록한 가게만 이 주소를 갖는다.
      const chainAsset =
        (document.getElementById("sh-registered") as HTMLInputElement | null)?.value || "";
      let foreverQr = "";
      if (chainAsset) {
        const foreverUrl = `https://rvn.ex.erci.se/s/${encodeURIComponent(chainAsset)}`;
        try {
          const svg = await invoke<string>("qr_svg", { text: foreverUrl });
          foreverQr =
            `<div class="qrbox">${svg}<div class="cap"><b>${t("문에 붙이는 QR")}</b>` +
            `${t("주소가 바뀌지 않습니다. 인쇄해서 붙이세요")}</div>${oneLink(foreverUrl)}</div>`;
        } catch {
          /* QR 을 못 만들어도 나머지는 보여 준다 */
        }
      }

    // 사장·직원·검표 QR에는 각각 다른 열쇠가 들어 있다. 손님 QR만 붙여도 된다.
    phoneQr = foreverQr +
      `<div class="qrbox">${adminQr}<div class="cap"><b>사장님만</b>돈·발행·설정 전부</div>${oneLink(r.admin_url)}</div>` +
      `<div class="qrbox">${staffQr}<div class="cap"><b>직원</b>주문·회원확인만</div>${oneLink(r.staff_url)}</div>` +
      `<div class="qrbox">${scanQr}<div class="cap"><b>검표 태블릿</b>문 앞에 두는 화면</div>${oneLink(r.scan_url)}</div>` +
      `<div class="qrbox">${custQr}<div class="cap"><b>손님</b>카운터에 붙이세요</div>${oneLink(r.customer_url)}</div>` +
      `<div class="meta" style="width:100%;margin-top:8px">${r.ip}:${r.port} · 폰을 같은 와이파이에 붙이고 찍으세요. QR 이 안 열리면 위 주소를 치세요.</div>` +
      // 손님 QR 에는 열쇠가 없어 붙여도 된다. 나머지 셋에는 열쇠가 들어 있어
      // 인쇄해 벽에 붙이면 그건 열쇠를 벽에 붙이는 것이다.
      `<div class="tblbox">
         <div class="meta"><b>손님 QR 만</b> 인쇄해서 붙일 수 있습니다 — 열쇠가 안 들어 있습니다.
           사장·직원·검표 QR 은 열쇠가 들어 있으니 <b>붙이지 마세요.</b></div>
         <div class="row" style="margin-top:9px">
           <input id="tbl-list" placeholder="1, 2, 3, 창가, 룸1" autocomplete="off"
                  style="flex:1" />
           <button class="ghost" id="tbl-print">테이블 QR 인쇄</button>
         </div>
         <div class="meta" id="tbl-note" style="margin-top:6px">
           비워 두고 누르면 손님 QR 한 장만 나옵니다. 테이블을 적으면
           <b>자리마다 다른 QR</b> 이 나오고, 주문에 «3번 테이블» 이 함께 뜹니다.
         </div>
       </div>`;
  } catch (e) {
    phoneQr = `<div class="warnbox" style="width:100%">${e}</div>`;
  }
  renderSwitches();
}

/// 붙여넣은 좌표를 읽는다.
///
/// 지오코딩은 하지 않는다 — 주소를 좌표로 바꾸는 것은 유료 API이거나 우리가
/// 서버를 돌리는 일이다. 대신 사장이 이미 쓰는 지도 앱에서 복사해 오게 한다.
let shopCoords: { lat: number; lon: number } | null = null;

async function readCoords() {
  const raw = ($("sh-coords") as HTMLInputElement).value;
  if (!raw.trim()) {
    shopCoords = null;
    $("sh-coordnote").innerHTML =
      "구글·애플 지도에서 가게를 길게 눌러 좌표를 복사한 뒤 여기 붙이세요. " +
      "넣으면 손님 화면에 <b>거리와 길찾기</b>가 생깁니다. 안 넣어도 가게는 보입니다.";
    return;
  }
  try {
    const r = await invoke<any>("parse_coords", { input: raw });
    if (r.ok) {
      shopCoords = { lat: r.lat, lon: r.lon };
      (window as any).__checkUrl = r.check_url;
      $("sh-coordnote").innerHTML =
        `<span class="ok">${r.lat}, ${r.lon}</span> — ` +
        `<b>지도에서 확인</b>을 눌러 정말 우리 가게인지 보세요. 잘못된 핀은 손님을 엉뚱한 데로 보냅니다.`;
    } else {
      shopCoords = null;
      $("sh-coordnote").innerHTML = `<span class="danger">${r.why || "좌표를 읽지 못했습니다"}</span>`;
    }
  } catch {}
}

/// 손님 화면이 보여줄 것을 서버에 넘긴다.
async function publishShop(ip?: string) {
  // DOM 에서 IP 를 읽어오던 자리다. 그 칸이 화면 개편에서 사라지면서 조용히
  // 127.0.0.1 로 떨어졌고, 그러면 손님 폰이 사진을 못 받는다. 변수를 본다.
  const host = ip || serverIp || "127.0.0.1";
  // 🔴 사진이 아직 문서 안에 통째로 들어 있으면 여기서 파일창고로 옮긴다.
  //    등록할 때만 고치면 **이미 등록된 가게는 영영 못 고친다** — 사장은
  //    등록 단추를 다시 누를 일이 없기 때문이다. 문을 열 때마다 지나가는
  //    길이 여기다. 파일창고가 켜져 있으면 그때 조용히 낫는다.
  await healIcon();
  // 🔴 메뉴도 파일창고에 올린다. 이걸 안 하면 가게를 끈 순간 손님은
  //    메뉴를 못 본다 — 지금까지 메뉴는 이 컴퓨터 밖으로 나간 적이 없다.
  await publishMenu(menuItems);
  const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
  let rate: number | null = null;
  const currency = ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
  if (currency !== "RVN") {
    try {
      // 🔴 시세는 바깥 거래소에 묻는 것이라 **안 돌아올 수 있다.** 여기서
      //    무한정 기다리면 이걸 부르는 쪽(손님 QR 창)이 「여는 중…」에서
      //    멈춘다 — 실제로 그렇게 멈췄다. 6초면 충분하고, 못 받아도
      //    메뉴는 보여야 한다. RVN 환산만 빠진다.
      const r = await Promise.race([
        invoke<any>("rvn_rate", { currency }),
        new Promise((_, no) => setTimeout(() => no(new Error("rate timeout")), 6000)),
      ]);
      rate = (r as any).rate;
    } catch {
      // 시세를 못 가져와도 메뉴는 보여야 한다.
    }
  }

  await invoke("publish_shop", {
    shop: {
      name: val("sh-ko") || val("sh-en"),
      description: val("sh-desc"),
      location: val("sh-loc"),
      phone: val("sh-phone"),
    order_url: val("sh-orderurl"),
      pickup: ($("sh-pickup") as HTMLInputElement)?.checked ?? true,
      delivery: ($("sh-delivery") as HTMLInputElement)?.checked ?? false,
      payment_address: shopAddress,
      lat: shopCoords?.lat ?? null,
      lon: shopCoords?.lon ?? null,
      // 🔴 여기서 주소를 **완성하지 않는다.**
      //
      //    예전에는 `http://192.168.0.x:8790/ipfs/…` 로 바꿔 실었다. 그건
      //    이 집 안에서만 통하는 주소다. 그 공지는 릴레이를 타고 **바깥
      //    손님**에게도 가는데, 바깥에서는 그 주소가 영원히 안 열린다.
      //    게다가 손님 화면은 `https` 만 통과시키므로 `http://` 는 그 전에
      //    걸러져 사진이 아예 안 나왔다.
      //
      //    날 주소(`Qm…/icon.jpg`)만 싣는다. 받는 쪽이 각자 자기 길을 붙인다:
      //      · 가게 안 손님 → 같은 자리(`/ipfs/…`)
      //      · 바깥 손님   → 서명으로 확인한 가게 주소 + `/ipfs/…`
      icon: shopIcon,
      // 가게 안 사진 여러 장. 이것도 안 실려 있어서 바깥 손님은 못 봤다.
      photos_cid: shopPhotosCid,
      // 메뉴 자체(공지 안)와 메뉴 주소(파일창고) 를 **둘 다** 싣는다.
      // 앞엣것은 가게 안 손님용이고, 뒤엣것은 가게가 꺼진 뒤에도 남는다.
      // 🔴 `shopkey.rs` 는 `menu_cid` 를 실어 나를 준비가 돼 있었는데
      //    값을 넣는 코드가 없었다 — 또 하나의 「적혀는 있는데 안 도는」 자리.
      menu_cid: shopMenuCid,
      menu: menuItems,
      currency,
      rate,
      // 손님 폰은 이 컴퓨터의 IPFS로 사진을 받는다.
      // 8790 = 우리 서버. 손님 폰도, 터널 밖 손님도 여기로 사진을 받는다.
      gateway: `http://${host}:8790`,
    },
    // 키가 없으면 빈 문자열 — 손님 화면에서 질문 상자가 아예 나타나지 않는다.
    aiProvider: aiProvider || "",
  });
}

/// 사이드바의 "가게"를 실제 상호로 바꾼다.
///
/// 한국어에는 카페·체육관·학원·공방을 한꺼번에 덮는 자연스러운 단어가 없다.
/// "가게"는 체육관에 안 쓰고 "매장"은 학원에 안 쓴다. 그래서 일반 명사를
/// 고르는 대신 사장이 적은 이름을 쓴다 — 자기 상호보다 자연스러운 말은 없다.
function labelShopNav() {
  const name =
    ($("sh-ko") as HTMLInputElement)?.value.trim() ||
    ($("sh-en") as HTMLInputElement)?.value.trim();
  const link = document.querySelector('nav a[data-page="shop"]');
  // 🔴 `textContent =` 는 **아이콘(svg)까지 지운다.** 그래서 메뉴에서
  //    「내 가게」만 아이콘이 없었다 — 가게 이름을 넣는 순간 사라진 것이다.
  //    글자가 든 <span> 만 갈아 끼운다.
  const label = link?.querySelector("span");
  if (label) label.textContent = name || "내 가게";
  else if (link) link.textContent = name || "내 가게";
  // 라비 화면의 인사말과 「아직 안 된 것」 줄도 같이 따라가야 한다.
  // 안 그러면 가게를 만들어 놓고도 첫 화면은 「가게부터 만들까요?」 그대로다.
  if (document.getElementById("ravi-tiles")) paintRavi();
  const title = document.querySelector("#page-shop .title");
  if (title) title.textContent = name || "내 가게";
  paintChainMark();
}

/**
 * 이 이름이 **체인에 있는가, 이 컴퓨터에만 있는가.**
 *
 * 🔴 여태 구별이 없었다. `shop.json` 에 이름만 적어 두면 왼쪽 메뉴에도, 첫
 * 화면 제목에도 그 이름이 떴다 — 체인 등록(500 RVN 소각)은 한 적이 없는데
 * **등록한 것처럼 보였다.** 실제로 「가게 자산을 안 만들었는데 만든 것처럼
 * 보인다」는 지적이 나왔다.
 *
 * 둘은 진짜로 다른 상태다:
 *   - 이 컴퓨터에만 있음 → 손님은 **QR 로만** 온다. 장터에서 못 찾는다.
 *   - 체인에 등록됨      → 전 세계 어느 노드에서도 이 가게가 보인다.
 *
 * 경고 상자로 만들지 않는다. 등록 안 한 것은 고장이 아니라 **정상적인 한
 * 단계**다 — 커피는 그 상태로도 다 팔린다. 조용한 표시 하나면 된다.
 */
function paintChainMark() {
  const el = document.getElementById("sh-chainmark");
  if (!el) return;
  const asset = ($("sh-registered") as HTMLInputElement)?.value.trim() || "";
  const name =
    ($("sh-ko") as HTMLInputElement)?.value.trim() ||
    ($("sh-en") as HTMLInputElement)?.value.trim();
  if (!name) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  // 등록한 가게만 알릴 것이 있다. 등록 전에는 손님 화면이 이 컴퓨터에서
  // 바로 나가므로 알릴 곳이 없다.
  const btn = document.getElementById("sh-refresh");
  if (btn) btn.style.display = asset ? "" : "none";
  el.className = asset ? "chainmark on" : "chainmark";
  el.textContent = asset ? `체인에 등록됨 · ${asset}` : t("이 컴퓨터에만 있습니다");
  el.title = asset
    ? ""
    : t("손님은 QR 로 옵니다. 장터에서 찾게 하려면 아래에서 등록하세요.");
}

// ── 문 (셸리) ──────────────────────────────────────────────────────────────
//
// 회원권 확인이 먼저 돌고, 통과해야 스위치에 신호가 간다. 회원권은 이 컴퓨터의
// 파일이라 인터넷이 끊겨도 확인되고, 스위치는 같은 공유기 안에 있다 — 그래서
// 바깥이 다 죽어도 문은 열린다.

/// digest 인증이 요구하는 클라이언트 난수. **요청마다 새로 만들어야 한다** —
/// 고정값을 쓰면 같은 응답이 반복되고, 그건 그대로 재생 공격 재료가 된다.
function newCnonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

let doorsShown = false;
/// 「입장」 버튼이 열 문. 문이 하나뿐인 가게가 대부분이라 고르게 하지 않는다.
let firstDoorId = "";

async function loadDoors() {
  try {
    const r: any = await invoke("door_list");
    const rows: any[] = r.doors || r || [];
    firstDoorId = rows.length ? String(rows[0].id) : "";
    $("dr-doorlist").innerHTML = rows.length
      ? rows.map((d) => `<div class="mrow" style="display:flex;gap:10px;align-items:center;margin-top:8px">
           <div class="listwrap">
             <div class="nm">${escapeHtml(d.name || "(이름 없음)")}</div>
             <div class="meta">${escapeHtml(d.ip)} · ${d.gen}세대 · 채널 ${d.channel} · ${d.seconds}초</div>
           </div>
           <button class="ghost" data-dopen="${escapeHtml(d.id)}">지금 열기</button>
           <button class="ghost" data-dprobe="${escapeHtml(d.id)}">확인</button>
           <button class="ghost" data-drm="${escapeHtml(d.id)}">지우기</button>
         </div>`).join("")
      : emptyWithRaven("아직 등록된 문이 없습니다.<br />아래에서 셸리 주소를 넣어 보세요.", "hello");

    $("dr-doorlist").querySelectorAll("[data-dopen]").forEach((b) => {
      (b as HTMLElement).onclick = () => openDoor((b as HTMLElement).dataset.dopen!, "사장이 직접 열었습니다");
    });
    $("dr-doorlist").querySelectorAll("[data-dprobe]").forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        $("dw-note").textContent = "확인 중…";
        try {
          const v: any = await invoke("door_probe", {
            id: (b as HTMLElement).dataset.dprobe, cnonce: newCnonce(),
          });
          // 확인은 문을 열지 않는다. 그 사실을 말해 주지 않으면 사장은
          // 열렸는지 안 열렸는지 문 앞에 가서 봐야 한다.
          $("dw-note").innerHTML = `<span class="ok">닿았습니다 — ${escapeHtml(JSON.stringify(v))}</span> (문은 열지 않았습니다)`;
        } catch (e) {
          $("dw-note").innerHTML = `<span class="danger">${e}</span>`;
        }
      };
    });
    $("dr-doorlist").querySelectorAll("[data-drm]").forEach((b) => {
      (b as HTMLElement).onclick = async () => {
        const id = (b as HTMLElement).dataset.drm!;
        const ok = await sure("이 문을 지울까요?", "설정만 지웁니다. 스위치는 그대로 있습니다.", "지웁니다");
        if (!ok) return;
        await invoke("door_remove", { id });
        loadDoors();
      };
    });
  } catch (e) {
    $("dr-doorlist").innerHTML = `<div class="warnbox">${e}</div>`;
  }
  loadDoorLog();
}

async function openDoor(doorId: string, reason: string) {
  $("dw-note").textContent = "여는 중…";
  try {
    const r: any = await invoke("door_open", {
      doorId, reason, nowUnix: Math.floor(Date.now() / 1000), cnonce: newCnonce(),
    });
    $("dw-note").innerHTML = `<span class="ok">${escapeHtml(r.name || "문")} 열렸습니다 — ${r.seconds ?? ""}초 뒤 닫힙니다</span>`;
  } catch (e) {
    $("dw-note").innerHTML = `<span class="danger">${e}</span>`;
  }
  loadDoorLog();
}

async function loadDoorLog() {
  try {
    const r: any = await invoke("door_log");
    const rows: any[] = r.log || r.entries || r || [];
    $("dr-doorlog").innerHTML = rows.length
      ? `<table><thead><tr><th>때</th><th>문</th><th>누구</th><th>결과</th></tr></thead><tbody>${
          rows.slice(0, 60).map((e) => `<tr>
            <td>${new Date((e.at || 0) * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</td>
            <td>${escapeHtml(e.door || "")}</td>
            <td>${escapeHtml(e.who || e.asset || "")}</td>
            <td class="${e.opened ? "ok" : "danger"}">${e.opened ? "열림" : escapeHtml(e.why || "거절")}</td>
          </tr>`).join("")}</tbody></table>`
      : emptyWithRaven("아직 드나든 기록이 없습니다.", "sleep");
  } catch { }
}

async function saveDoor() {
  const note = $("dw-note");
  note.textContent = "저장 중…";
  try {
    await invoke("door_save", {
      // 새 문이면 새 id. 같은 이름을 두 번 저장해도 덮어쓰지 않는다.
      id: ($("dw-name") as HTMLInputElement).value.trim() || `door-${Date.now()}`,
      name: ($("dw-name") as HTMLInputElement).value,
      ip: ($("dw-ip") as HTMLInputElement).value,
      gen: Number(($("dw-gen") as HTMLSelectElement).value) || 2,
      channel: Number(($("dw-ch") as HTMLInputElement).value) || 0,
      seconds: Number(($("dw-sec") as HTMLInputElement).value) || 5,
      user: ($("dw-user") as HTMLInputElement).value,
      password: ($("dw-pass") as HTMLInputElement).value,
    });
    note.innerHTML = `<span class="ok">저장했습니다.</span>`;
    ($("dw-pass") as HTMLInputElement).value = "";
    loadDoors();
  } catch (e) {
    note.innerHTML = `<span class="danger">${e}</span>`;
  }
}

// ── 영업시간 ───────────────────────────────────────────
//
// 노드는 새벽에도 돈다. 채굴하고 IPFS 를 붙들고 있어야 하니까. 그래서 "노드가
// 켜져 있다"와 "가게가 열려 있다"는 다른 말이고, 손님 화면이 그 둘을 구별하지
// 못하면 아무도 만들지 않을 커피가 결제된다.

/// 화면에는 월요일부터 보인다. 안쪽 번호는 일=0 — 유닉스 요일과 맞춰야
/// 서버와 같은 답이 나온다.
const WEEK: Array<[number, string]> = [
  [1, "월"], [2, "화"], [3, "수"], [4, "목"], [5, "금"], [6, "토"], [0, "일"],
];

function drawHours(hours: any) {
  const h = hours && typeof hours === "object" ? hours : {};
  $("sh-hours").innerHTML = WEEK.map(([d, ko]) => {
    const v = h[String(d)] || {};
    return `<div class="row hrrow" style="align-items:center; gap:8px; margin-top:6px">
      <span style="width:22px">${ko}</span>
      <input type="time" id="hr-o-${d}" value="${v.open || ""}" style="width:auto" />
      <span class="meta">–</span>
      <input type="time" id="hr-c-${d}" value="${v.close || ""}" style="width:auto" />
      <span class="hrsay" id="hr-s-${d}"></span>
    </div>`;
  }).join("");
  paintHours();
}

/* ══ 요일마다 지금 어떻게 저장되는지 ═══════════════════════════════════
   🔴 대표님: "월요일 시간 입력했는데 나머지에 종료시간이 입력이 안 되네
   — 아 색이 없으면 반영이 안 되는 거구나. 이걸 알려줘야 할 듯한데."

   맞다. 시간 칸이 비어 있으면 브라우저가 흐린 글자로 그려서, **적힌 것처럼
   보이는데 사실은 빈 칸**이다. 그리고 한쪽만 적힌 요일은 저장할 때 조용히
   버려진다(`readHours`) — 사장은 왜 그 요일이 안 열리는지 못 찾는다.

   그래서 요일마다 **저장되면 무엇이 되는지**를 옆에 적는다. */
function paintHours() {
  for (const [d] of WEEK) {
    const o = ($(`hr-o-${d}`) as HTMLInputElement)?.value || "";
    const c = ($(`hr-c-${d}`) as HTMLInputElement)?.value || "";
    const say = $(`hr-s-${d}`);
    if (!say) continue;
    if (o && c) {
      // 자정을 넘기는 것도 말해 준다 — 밤 6시 열고 새벽 2시 닫기.
      say.textContent = c <= o ? t("자정 넘겨 영업") : "";
      say.className = "hrsay ok";
    } else if (!o && !c) {
      say.textContent = t("쉬는 날");
      say.className = "hrsay";
    } else {
      // 🔴 반쪽짜리는 저장되지 않는다. 그 사실을 그 자리에서 말한다.
      say.textContent = t("한쪽만 적혀서 저장되지 않습니다");
      say.className = "hrsay warn";
    }
  }
}

function readHours(): Record<string, { open: string; close: string }> {
  const out: Record<string, { open: string; close: string }> = {};
  for (const [d] of WEEK) {
    const o = ($(`hr-o-${d}`) as HTMLInputElement)?.value || "";
    const c = ($(`hr-c-${d}`) as HTMLInputElement)?.value || "";
    // 한쪽만 적힌 요일은 시간표가 아니다. 반쪽짜리를 저장하면 서버가
    // 그 요일을 통째로 쉬는 날로 읽고, 사장은 왜 안 열리는지 못 찾는다.
    if (o && c) out[String(d)] = { open: o, close: c };
  }
  return out;
}

/// 시간표를 고치면 그 결과를 바로 말해 준다. 저장하고 손님 화면을 열어 봐야
/// 아는 것은 확인이 아니라 시험이다.
async function previewOpen() {
  try {
    const r = await invoke<any>("shop_open_now", {
      nowUnix: Math.floor(Date.now() / 1000),
      tzOffsetMin: tzMin(),
    });
    $("sh-openpreview").innerHTML = r.open
      ? `<b class="ok">지금 손님에게는 「영업 중」으로 보입니다.</b> ${r.say || ""}`
      : `<b class="warn">지금 손님에게는 「주문 받지 않음」으로 보입니다.</b> ${r.say || ""}`;
  } catch {}
}

function shopTab(which: string) {
  document.querySelectorAll("[data-shoptab]").forEach((b) => {
    (b as HTMLElement).classList.toggle("on", (b as HTMLElement).dataset.shoptab === which);
  });
  document.querySelectorAll(".shoptab").forEach((d) => {
    d.classList.toggle("on", d.id === `shoptab-${which}`);
  });
  if (which === "orders") {
    // 사장이 주문표를 열었다 = 봤다. 빨간 숫자와 알림 띠를 내린다.
    // 안 내리면 배지가 「봐도 안 없어지는 것」이 되고, 그건 곧 무시된다.
    주문봤다();
    loadOrders();
  }
  if (which === "sales") loadSales();
  if (which === "mine") {
    previewOpen();
    // 🔴 여태 `loadShop()` 은 **앱 켤 때 한 번**만 돌았다. 탭을 눌러도 다시
    //    읽지 않았다.
    //
    //    ⚠️ 그런데 이 파일은 **폰 관리자 화면(`/admin/publish`)도 덮어쓴다.**
    //       사장이 폰에서 가게 정보를 고치고 컴퓨터로 오면, 컴퓨터는 켤 때
    //       읽은 **옛 값**을 그대로 보여 준다. 그걸 저장하면 폰에서 한 일이
    //       **되돌아간다.**
    //
    //    ⚠️ `loadShop` 은 칸을 **덮어쓴다.** 그래도 되는 이유는 입력이
    //       600ms 뒤 자동 저장되기 때문이다 — 화면과 파일이 같다. 그리고
    //       탭을 옮기는 것은 사장이 의도한 행동이다.
    void loadShop().catch(() => {});
  }
}

// ── 매출 · 장부 ────────────────────────────────────────────────────────────
//
// 체인은 "이 코인이 옮겨졌다"까지만 증명한다. 그게 얼마짜리였는지는 말해 주지
// 못하고, 그게 세무서가 묻는 유일한 숫자다. 그 값을 결제 시점에 붙잡아 둔 것이
// 장부고, 이 화면은 그걸 기간으로 꺼내 보는 자리다.

/// 이 컴퓨터가 있는 곳의 시간대. 분 단위, 동쪽이 양수.
///
/// `getTimezoneOffset()` 은 부호가 반대다 — 한국이 -540 을 돌려준다. 뒤집지
/// 않으면 마감 매출이 다음 날로 밀려 일별 합계가 통째로 어긋난다.
const tzMin = () => -new Date().getTimezoneOffset();

/// YYYY-MM-DD → 20260820
const ymdInt = (s: string): number => Number(s.replace(/-/g, "")) || 0;

/// 20260820 → YYYY-MM-DD
const ymdStr = (n: number): string =>
  `${Math.floor(n / 10000)}-${String(Math.floor(n / 100) % 100).padStart(2, "0")}-${String(n % 100).padStart(2, "0")}`;

function todayYmd(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function setSalesRange(days: number) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const num = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  ($("sl-from") as HTMLInputElement).value = ymdStr(num(from));
  ($("sl-to") as HTMLInputElement).value = ymdStr(num(to));
}

async function loadSales() {
  const fromEl = $("sl-from") as HTMLInputElement;
  const toEl = $("sl-to") as HTMLInputElement;
  if (!fromEl.value || !toEl.value) setSalesRange(0);

  const from = ymdInt(fromEl.value) || todayYmd();
  const to = ymdInt(toEl.value) || todayYmd();

  let r: any;
  try {
    r = await invoke("ledger_range", { fromYmd: from, toYmd: to, tzOffsetMin: tzMin() });
  } catch (e) {
    $("sl-sum").innerHTML = `<p class="danger">장부를 읽지 못했습니다: ${e}</p>`;
    return;
  }

  const cur = r.currency || "";
  const money = (n: number) =>
    `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`;

  // 아직 결제되지 않은 주문. 매출에는 안 들어가지만, 안 보여 주면 사장은
  // "주문이 있었는데 장부에 없다" 를 고장으로 읽는다.
  let pending = 0;
  try {
    pending = (await invoke<any>("ledger_pending")).count || 0;
  } catch {}

  const warn: string[] = [];
  if (r.mixed_currency)
    warn.push("이 기간에 통화가 두 가지 이상 섞여 있어 합계가 정확하지 않습니다. 기간을 나눠서 보세요.");
  if (r.unstable_rows)
    warn.push(`${r.unstable_rows}건은 거래소끼리 시세가 크게 벌어진 때에 계산됐습니다.`);
  if (r.unreadable_rows)
    warn.push(`${r.unreadable_rows}줄을 읽지 못했습니다. 장부 파일이 손상됐을 수 있습니다.`);
  if (pending) warn.push(`아직 입금되지 않은 주문 ${pending}건은 매출에 넣지 않았습니다.`);

  // 🔴 대표님 화면: 「매출 0」인데 「들어온 주문」에는 결제된 주문이 있었다.
  //    기본 범위가 **오늘 하루**라 5일 전 매출은 여기서 0 으로 보인다.
  //
  //    범위를 넓히지는 않는다 — 사장이 매일 보는 것은 「오늘 얼마 벌었나」다.
  //    대신 **0 일 때 길을 알려준다.** 0 이 진짜 0 인지 못 찾은 것인지
  //    화면만 보고 알 수 없으면, 사장은 장부가 고장 났다고 생각한다.
  if (!(r.sales || 0) && from === to) {
    try {
      const wk = await invoke<any>("ledger_range", {
        fromYmd: ymdInt(ymdStr(Date.now() - 30 * 86400_000)) || from,
        toYmd: to,
        tzOffsetMin: tzMin(),
      });
      if (wk?.sales) {
        warn.push(
          `오늘은 아직 판매가 없습니다. <b>지난 30일에는 ${wk.sales}건</b> 있습니다 — 위 「30일」을 눌러 보세요.`,
        );
      }
    } catch {
      /* 못 읽으면 조용히 넘어간다. 없는 말을 지어내지 않는다. */
    }
  }

  $("sl-sum").innerHTML = `
    <div class="row" style="gap:26px; margin-top:16px; flex-wrap:wrap">
      <div><div class="meta">받은 금액</div>
           <div style="font-size:30px; font-weight:700">${money(r.total)}</div></div>
      <div><div class="meta">코인으로</div>
           <div style="font-size:18px">${fmtQty(r.total_rvn || 0)} RVN</div></div>
      <div><div class="meta">판매</div>
           <div style="font-size:18px">${r.sales || 0}건</div></div>
      <div><div class="meta">환불</div>
           <div style="font-size:18px">${r.refunds || 0}건</div></div>
    </div>
    ${warn.map((w) => `<p class="meta" style="color:var(--warn)">${w}</p>`).join("")}`;

  const items = (r.by_item || []) as any[];
  $("sl-items").innerHTML = items.length
    ? `<h3 style="margin-top:24px">무엇이 팔렸나</h3>
       <table><thead><tr><th>품목</th><th class="num">수량</th><th class="num">금액</th></tr></thead>
       <tbody>${items
         .map(
           (i) => `<tr><td>${escapeHtml(i.name)}</td>
             <td class="num">${fmtQty(i.qty)}</td>
             <td class="num">${money(i.amount)}</td></tr>`,
         )
         .join("")}</tbody></table>`
    : emptyWithRaven("이 기간에 팔린 것이 없습니다.<br />손님이 결제하면 여기 쌓입니다.", "sleep");

  // 한 건씩. 세무 담당자가 묻는 것은 합계지만, 사장이 확인하는 것은 그날 그 건이다.
  const rows = ((r.rows || []) as any[]).filter((x) => x.kind === "sale" || x.kind === "refund");
  $("sl-rows").innerHTML = rows.length
    ? `<h3 style="margin-top:24px">한 건씩</h3>
       <table><thead><tr><th>때</th><th>내용</th><th class="num">금액</th><th class="num">1RVN</th><th>근거</th></tr></thead>
       <tbody>${rows
         .map((x) => {
           const when = new Date((x.at || 0) * 1000).toLocaleString(undefined, {
             dateStyle: "short",
             timeStyle: "short",
           });
           const what =
             x.kind === "refund"
               ? `환불 · ${escapeHtml(x.reason || "")}`
               : ((x.items || []) as any[]).map((i) => escapeHtml(i.name || "")).join(" / ") || "판매";
           const how = x.rate_direct === false ? "달러경유" : "직접";
           const src = ((x.sources || []) as any[]).join(" · ");
           // txid 는 우리 말을 안 믿는 사람이 직접 확인하는 유일한 고리다.
           const tx = x.txid
             ? `<div class="meta" style="word-break:break-all">${escapeHtml(String(x.txid).slice(0, 16))}…</div>`
             : "";
           return `<tr>
             <td>${when}</td>
             <td>${what}${tx}</td>
             <td class="num ${x.kind === "refund" ? "danger" : "ok"}">${money(x.amount)}</td>
             <td class="num">${fmtQty(x.rate || 0)}</td>
             <td><div class="meta">${how}</div><div class="meta">${escapeHtml(src)}</div></td>
           </tr>`;
         })
         .join("")}</tbody></table>`
    : "";
}

async function exportSales() {
  const from = ymdInt(($("sl-from") as HTMLInputElement).value) || todayYmd();
  const to = ymdInt(($("sl-to") as HTMLInputElement).value) || todayYmd();
  const note = $("sl-csvnote");
  note.textContent = "만드는 중…";
  try {
    const r = await invoke<any>("ledger_export", {
      fromYmd: from,
      toYmd: to,
      tzOffsetMin: tzMin(),
    });
    note.textContent = `저장했습니다 — ${r.path}`;
  } catch (e) {
    note.textContent = `내보내지 못했습니다: ${e}`;
  }
}

async function checkShopName() {
  const raw = ($("sh-asset") as HTMLInputElement).value.trim();
  if (!raw) {
    $("sh-assetcheck").textContent = "";
    $("sh-cost").innerHTML = "";
    $("sh-confirmbox").style.display = "none";
    return;
  }
  const full = await invoke<string>("shop_asset_name", { input: raw });
  let free = true;
  try {
    free = await invoke<boolean>("shop_name_free", { name: raw });
  } catch {}

  $("sh-assetcheck").innerHTML = free
    ? `체인에 <code>${full}</code> 로 남습니다`
    : `<span style="color:var(--bad)">이미 등록된 이름입니다. 자산 이름은 영구적이라 다시 쓸 수 없습니다.</span>`;

  if (free) {
    $("sh-cost").innerHTML =
      `<div class="burn">${REGISTER_BURN} RVN 소각</div>
       <div class="meta">돌아오지 않습니다. 등록은 취소할 수 없습니다.</div>`;
    $("sh-confirmname").textContent = full;
    $("sh-confirmbox").style.display = "";
    // 🔴 여기에도 **정답을 칸 안에 적어 두고 있었다.** 발행 마법사에서
    // 고친 것과 같은 결함이다 — 이 게이트는 "이 이름이 맞다" 가 아니라
    // "베낄 줄 안다" 를 확인한다. 500 RVN 이 걸린 자리다.
    ($("sh-confirm") as HTMLInputElement).placeholder = "위에 적힌 이름을 직접 입력";
  } else {
    $("sh-cost").innerHTML = "";
    $("sh-confirmbox").style.display = "none";
  }
  gateShop();
}

function gateShop() {
  const full = $("sh-confirmname").textContent || "";
  const typed = ($("sh-confirm") as HTMLInputElement).value.trim();
  const named = ($("sh-ko") as HTMLInputElement).value.trim() ||
    ($("sh-en") as HTMLInputElement).value.trim();
  const go = $("sh-go") as HTMLButtonElement;
  go.disabled = !(typed === full && full && named && shopAddress);
  // 뿌리 자산은 500 RVN 이 소각되고 이름은 체인에 영구히 남는다. 그 사실을
  // 버튼 옆 설명이 아니라 버튼 안에 둔다.
  go.textContent = `가게 등록 · 500 RVN 소각`;
}

async function makeShopAddress() {
  try {
    shopAddress = await invoke<string>("new_address", { label: "shop" });
    ($("sh-addr") as HTMLInputElement).value = shopAddress;
    gateShop();
  } catch (e) {
    $("sh-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
}

async function registerShop() {
  // 가게 등록도 500 RVN 을 태운다. 잠긴 채로 누르면 IPFS 에 프로필만 올라가고
  // 발행이 조용히 실패한다 — 사장은 등록된 줄 알고 QR 을 붙인다.
  if (!(await ensureUnlocked("가게를 등록하려면 지갑을 열어야 합니다.")))
    return;

  // 발행 마법사와 같은 취소 창. 여기도 500 RVN 이고, 여기도 되돌릴 수 없다.
  // 「내 가게」 화면은 입력칸이 21개라 사장이 오래 채우고 마지막에 누른다 —
  // 그렇게 길게 채운 뒤일수록 손이 그냥 눌린다.
  {
    const full = $("sh-confirmname").textContent || "";
    const ok = await holdBeforeDoing(
      `「${full}」 로 가게를 등록합니다`,
      "500 RVN 이 타고, 이 이름은 영원히 바뀌지 않습니다",
    );
    if (!ok) return;
  }

  const btn = $("sh-go") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "등록 중…";
  const val = (id: string) => ($(id) as HTMLInputElement).value.trim();

  // 🔴 사진이 `data:` 로 남아 있으면 여기서 고친다.
  //
  //    실측(이 가게): `shop.json` 의 `icon` 이 17,379바이트짜리 `data:` 였다.
  //    사진을 고를 때 파일창고가 잠깐 안 돌아서 비상 경로로 떨어진 것이고,
  //    그 뒤로 **아무도 다시 시도하지 않았다.** 결과가 셋이었다:
  //      · 공지에서는 `data:` 가 걸러진다(32KB 상한) → 손님에게 안 간다
  //      · 체인에 올라간 프로필의 `icon` 은 `null` 이었다 → 손님에게 안 간다
  //      · 사장 화면에는 보인다 → **올라간 줄 안다**
  //    사진을 다시 고르라고 하지 않는다. 지금 파일창고가 돌면 지금 올린다.
  await healIcon();

  try {
    // Profile first: the asset must point at something that already exists,
    // and a failed upload before the burn costs nothing.
    const profile = await invoke<any>("build_shop_profile", {
      displayNames: { ko: val("sh-ko"), en: val("sh-en"), ja: val("sh-ja"), zh: val("sh-zh") },
      descriptions: { ko: val("sh-desc") },
      paymentAddress: shopAddress,
      location: val("sh-loc") || null,
      phone: val("sh-phone") || null,
      delivery: ($("sh-delivery") as HTMLInputElement).checked,
      pickup: ($("sh-pickup") as HTMLInputElement).checked,
      menuCid: null,
      icon: shopIcon,
      photos_cid: shopPhotosCid,
      // 🔴 좌표가 여기서 빠져 있었다. 서명에는 있는데 호출부에 없어서
      // Tauri 가 조용히 None 으로 채웠고, 체인에 올라간 프로필에는 좌표가
      // 없었다 — 가게 목록의 거리·길찾기가 영영 안 나오는 이유였다.
      lat: shopCoords?.lat ?? null,
      lon: shopCoords?.lon ?? null,
      // 손님이 밖에서 주문하러 갈 주소. 비워 두면 목록에 이름만 나온다.
      orderUrl: val("sh-orderurl") || null,
    });
    const up = await invoke<any>("ipfs_add_bundle", { files: [], metadata: profile });

    const asset = $("sh-confirmname").textContent!;
    const txid = await invoke<string>("issue_asset", {
      name: asset,
      // 🔴 여태 **1개·나눌 수 없음**으로 찍었다. 그러면 이 자산을 손님에게
      //    나눠 줄 수가 없고, 그래서 **팔로우가 성립하지 않는다.**
      //    레이븐코인의 `sendmessage` 는 「이 자산을 가진 사람 전원」에게
      //    가는데, 가진 사람이 사장 하나뿐이면 자기에게 보내는 셈이다.
      //
      //    가게 주인임을 증명하는 것은 `SHOP.무엇!`(소유권 토큰)이지 이 자산이
      //    아니다. 그러니 이 자산은 **처음부터 팔로우 토큰**으로 만든다.
      //    손님에게 0.00000001 씩 나눠 주면 그 사람들이 가게 공지를 받는다.
      //
      //    나중에 고치려면 재발행 100 RVN 이 든다. 그래서 **지금 맞게 찍는다.**
      qty: 21_000_000_000,
      units: 8,
      reissuable: true, // 프로필을 나중에 고치려면 재발행이 필요하다
      ipfsHash: up.cid,
      toAddress: null,
    });

    // 🔴 이 줄이 없으면 노드는 자기 가게의 체인 이름을 영영 모른다 — 터널을
    //    켜도 「누구의 주소인지」를 못 적어서 아무것도 공지하지 못한다.
    ($("sh-registered") as HTMLInputElement).value = asset;
    saveShop();
    labelShopNav();
    // 문이 이미 열려 있으면 지금 바로 알린다. 다음에 터널을 다시 켤 때까지
    // 기다리면, 방금 등록한 가게가 오늘 하루 종일 장터에서 안 보인다.
    try {
      const t: any = await invoke("tunnel_status");
      if (t?.url) await invoke("shop_announce", { asset, url: t.url });
    } catch {
      /* 공지가 실패해도 등록은 끝났다. 다음에 문 열 때 다시 올라간다. */
    }

    $("sh-result").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>가게가 등록되었습니다</h3>
       <div class="kv"><b>체인 이름</b><span>${asset}</span></div>
       <div class="kv"><b>프로필</b><code class="addr">${up.cid}</code></div>
       <div class="kv"><b>트랜잭션</b><code class="addr">${txid}</code></div>
       <p class="meta">확인되면 전 세계 어느 노드에서도 이 가게가 보입니다.</p></div>`;
    $("sh-confirmbox").style.display = "none";
  } catch (e) {
    $("sh-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
    btn.disabled = false;
  }
  btn.textContent = "가게 등록";
}

// ── 가게를 남기는 일 ────────────────────────────────────────────
// 이 화면의 값은 전부 자바스크립트 변수였다. 앱을 닫으면 가게 이름도 메뉴도
// 사라지고, 온보딩은 한 번만 도니까 다시 물어보지도 않는다. 사장은 아침에
// 빈 계산대를 보고 고장났다고 생각한다.

function shopSnapshot() {
  const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
  return {
    // 이름 칸은 sh-ko 다. 외국어 표기는 따로 있고, 그것도 사장이 직접 적은
    // 것이라 같이 남긴다 — 다시 적으라고 하면 안 적는다.
    name: val("sh-ko"),
    name_en: val("sh-en"),
    name_ja: val("sh-ja"),
    name_zh: val("sh-zh"),
    description: val("sh-desc"),
    location: val("sh-loc"),
    phone: val("sh-phone"),
    // 🔴 이 둘이 여태 저장 안 됐다. `loadShop` 은 읽는데 저장하는 쪽이 안
    //    담아서, 사장이 적어 넣은 바깥 주소가 앱을 끄면 사라졌다.
    //    `asset` 은 더 중요하다 — 노드가 **자기 가게의 체인 이름**을 알아야
    //    터널이 켜질 때 「SHOP.PLAYX 는 지금 여기서 주문받습니다」를 올린다.
    order_url: val("sh-orderurl"),
    // 사장이 치는 중인 이름과, **실제로 체인에 올라간 이름**은 다르다.
    asset: val("sh-asset"),
    chain_asset: val("sh-registered"),
    pickup: ($("sh-pickup") as HTMLInputElement)?.checked ?? true,
    delivery: ($("sh-delivery") as HTMLInputElement)?.checked ?? false,
    payment_address: shopAddress,
    lat: shopCoords?.lat ?? null,
    lon: shopCoords?.lon ?? null,
    icon: shopIcon,
    photos_cid: shopPhotosCid,
    currency: ($("mn-cur") as HTMLSelectElement)?.value || "KRW",
    hours: readHours(),
    closed_now: ($("sh-closednow") as HTMLInputElement)?.checked ?? false,
    closed_note: val("sh-closednote"),
    menu: menuItems,
  };
}

/**
 * 사진이 문서 안에 통째로 들어 있으면 파일창고로 옮기고 **주소만** 남긴다.
 *
 * 사진을 고를 때 파일창고가 안 돌면 비상으로 `data:` 를 들고 있는다. 그건
 * 사장 화면에서는 보이지만 **손님에게는 한 번도 안 간다** — 공지에서는
 * 32KB 상한 때문에 걸러지고, 체인 프로필에도 안 실린다.
 *
 * 그래서 올리기 직전에 한 번 더 해 본다. 파일창고는 대개 그 사이에 켜진다.
 * 실패하면 조용히 넘어가지 않고 그대로 둔다 — 사진 때문에 가게 등록 자체를
 * 막을 이유는 없지만, 안 된 것을 됐다고 하지도 않는다.
 */
/**
 * 메뉴를 파일창고에 올려 두고 주소만 들고 온다.
 *
 * 이걸 해야 **가게를 꺼도 손님이 메뉴를 본다.** 지금까지 메뉴는 이 컴퓨터
 * 밖으로 나간 적이 없어서, 문 닫은 가게를 누르면 아무것도 없었다.
 *
 * 바뀐 게 없으면 안 올린다 — 같은 내용은 같은 주소가 나오지만, 그래도
 * 문 열 때마다 파일창고를 두드릴 이유는 없다.
 */
let lastMenuJson = "";
async function publishMenu(items: unknown[]): Promise<void> {
  const json = JSON.stringify({ v: 1, menu: items });
  // 메뉴를 비운 가게는 주소도 비운다. 옛 메뉴가 남으면 없는 것을 파는 셈이다.
  if (!Array.isArray(items) || items.length === 0) {
    shopMenuCid = null;
    lastMenuJson = "";
    return;
  }
  if (json === lastMenuJson && shopMenuCid) return;
  try {
    const bytes = [...new TextEncoder().encode(json)];
    const up = await invoke<any>("ipfs_add_bundle", {
      files: [{ name: "menu.json", bytes }],
      metadata: null,
    });
    // 🔴 폴더 주소를 준다. 파일 이름까지 붙여야 손님이 메뉴를 읽는다 —
    //    이름 없이 폴더만 주면 목록이 온다(사진에서 두 번 겪은 함정).
    if (!up?.cid) throw new Error("파일창고가 주소를 주지 않았습니다.");
    shopMenuCid = `${up.cid}/menu.json`;
    lastMenuJson = json;
  } catch {
    // 🔴 조용히 넘어가되 **거짓말은 안 한다.** 못 올렸으면 주소를 비워 둔다.
    //    옛 주소를 남기면 손님이 어제 메뉴를 오늘 메뉴로 본다.
    shopMenuCid = null;
    lastMenuJson = "";
  }
}

async function healIcon(): Promise<void> {
  if (!shopIcon || !shopIcon.startsWith("data:")) return;
  const was = shopIcon;
  try {
    const bin = await (await fetch(was)).blob();
    const up = await invoke<any>("ipfs_add_bundle", {
      files: [{ name: "icon.jpg", bytes: [...new Uint8Array(await bin.arrayBuffer())] }],
      metadata: null,
    });
    // 폴더 주소를 준다. 파일 이름까지 붙여야 그림이 나온다.
    if (!up?.cid) throw new Error("파일창고가 주소를 주지 않았습니다.");
    shopIcon = `${up.cid}/icon.jpg`;
    const note = $("sh-picnote");
    if (note) note.textContent = t("사진을 파일창고에 올렸습니다.");
    void saveShop();
  } catch (e) {
    const note = $("sh-picnote");
    if (note) {
      // 괄호 안 작은 글씨로 적으면 사장은 그냥 넘어간다. 문제로 보이게 한다.
      note.innerHTML =
        `<b style="color:var(--warn)">사진을 파일창고에 못 올렸습니다.</b><br />` +
        `가게는 등록됩니다. 다만 <b>손님 화면에는 사진이 안 나옵니다.</b><br />` +
        `파일창고가 켜진 뒤 사진을 다시 고르시면 그때 올라갑니다. ` +
        `(${String((e as Error)?.message || e).slice(0, 80)})`;
    }
  }
}

// 글자 하나마다 파일을 쓰지는 않는다. 손을 멈추면 쓴다.
let shopSaveTimer: number | undefined;
function saveShop() {
  clearTimeout(shopSaveTimer);
  shopSaveTimer = setTimeout(() => {
    invoke("shop_save", { shop: shopSnapshot() }).catch(() => {});
    // 🔴 **손님 화면까지 같이 고친다.**
    //
    // 여태 `shop_save` 만 했다 — 그건 이 컴퓨터의 파일에만 적는 것이고,
    // 손님 폰이 보는 것은 서버가 들고 있는 사본이다. 그래서 사장이 값을
    // 고쳐도 손님은 **옛 값을 보고, 옛 값으로 결제**했다. 「메뉴판 올리기」를
    // 눌러야만 반영됐는데, 그건 IPFS 에 올리는 것이지 값을 고치는 것이
    // 아니다 — 사장이 그 둘을 구별할 이유가 없다.
    //
    // 서버가 안 켜져 있으면 조용히 아무 일도 안 한다.
    void pushShopLive();
  }, 600) as unknown as number;
}

/**
 * 지금 화면의 가게 정보를 **손님 화면에 바로 반영한다.**
 *
 * 값·이름·영업시간을 고치는 즉시 손님이 그것을 본다. IPFS 에 올리는 것
 * (「메뉴판 올리기」)과는 다른 일이다 — 그쪽은 체인·장터용 사본이고,
 * 이쪽은 지금 카운터 앞에 선 손님이 보는 화면이다.
 */
async function pushShopLive(): Promise<void> {
  if (!serverIp) return; // 폰 서버가 아직 안 켜졌다
  try {
    await publishShop(serverIp);
  } catch {
    /* 못 밀어도 파일에는 저장됐다. 다음에 켤 때 반영된다. */
  }
}

/**
 * 체인 이름이 비어 있을 때 **지갑에 물어서** 채운다.
 *
 * 사장에게 「체인 이름이 뭐였죠」라고 물으면 안 된다 — 답은 이 컴퓨터
 * 안에 이미 있다. 소유권 토큰(`SHOP.무엇!`)은 그 자산의 주인만 갖는다.
 *
 * 이게 비어 있으면 화면이 「체인에 가게를 등록하지 않았습니다」라고
 * **거짓말을 하고**, 어느 이름으로 알릴지 몰라 **릴레이 공지도 못 올린다.**
 * 가게를 켜 뒀는데 세상에서 안 보이던 이유 중 하나가 이것이었다.
 */
async function healChainAsset(): Promise<void> {
  try {
    const r = await invoke<any>("shop_detect_asset");
    if (!r?.asset) return;                    // 정말 없거나, 여러 개라 못 고른다
    const el = $("sh-registered") as HTMLInputElement | null;
    if (!el || el.value.trim()) return;       // 그 사이 사장이 적었으면 안 건드린다
    el.value = String(r.asset);
    await saveShop();
    // 조용히 고치지 않는다. 무엇이 달라졌는지 사장이 알아야 한다.
    const note = $("sh-registered-note");
    if (note) {
      note.textContent = `지갑에서 찾았습니다 — ${r.asset}. 이제 손님에게 알릴 수 있습니다.`;
    }
    // 이름을 알았으니 지금 바로 알린다. 다음에 문 열 때까지 기다릴 이유가 없다.
    void publishShop();
  } catch {
    // 노드가 아직 안 떴을 수 있다. 다음에 켤 때 또 해 본다.
  }
}

/**
 * 이미 체인에 올린 가게면 **이름 칸을 채우고 잠근다.**
 *
 * 🔴 대표님: "체인 등록 했으면 여기도 나와야 하는거 아냐? 왜 체인에 남은
 *    이름이 없는데."
 *
 *    맞다. 그런데 이건 「안 보인다」보다 훨씬 위험한 상태였다. **빈 칸은
 *    「아직 안 했구나」로 읽힌다.** 이미 `SHOP.PLAYX` 를 올린 사장이 빈 칸을
 *    보고 이름을 다시 적어 「가게 등록」을 누르면 — **500 RVN 이 또 탄다.**
 *    그리고 그 이름은 체인에 영원히 남는다. 되돌릴 수 없다.
 *
 *    체인 이름은 **한 번 정하면 못 바꾼다.** 못 바꾸는 칸은 고칠 수 있는
 *    것처럼 보이면 안 된다. 그래서 채우고, 잠그고, 왜 잠겼는지 적는다.
 */
function lockChainName() {
  const 이미 = ($("sh-registered") as HTMLInputElement | null)?.value.trim() || "";
  const box = $("sh-asset") as HTMLInputElement | null;
  if (!box) return;
  const note = document.getElementById("sh-assetlocked");
  if (!이미) {
    box.readOnly = false;
    if (note) note.remove();
    return;
  }
  // 손님에게 보이는 이름이 아니라 **체인에 박힌 이름**이다. `SHOP.` 은 관례
  // 접두사라 칸에는 그 뒤만 적어 왔다 — 되쓸 때도 같게 맞춘다.
  box.value = 이미.replace(/^SHOP\./, "");
  box.readOnly = true;
  if (!note) {
    const p = document.createElement("p");
    p.id = "sh-assetlocked";
    p.className = "meta";
    p.textContent = t(
      "이미 체인에 올린 이름입니다. 체인 이름은 바꿀 수 없어서 잠가 두었습니다 — 다시 등록하면 RVN 이 또 탑니다.",
    );
    box.insertAdjacentElement("afterend", p);
  }
}

async function loadShop() {
  let sh: any = null;
  try {
    sh = await invoke<any>("shop_load");
  } catch {}
  if (!sh || !Object.keys(sh).length) return;

  const set = (id: string, v: any) => {
    const el = $(id) as HTMLInputElement | null;
    if (el && v != null) el.value = String(v);
  };
  set("sh-ko", sh.name);
  set("sh-en", sh.name_en);
  set("sh-ja", sh.name_ja);
  set("sh-zh", sh.name_zh);
  set("sh-desc", sh.description);
  set("sh-loc", sh.location);
  set("sh-phone", sh.phone);
  set("sh-orderurl", sh.order_url);
  set("sh-asset", sh.asset);
  // 체인 이름. 이걸 되살려야 다음에 문을 열 때도 손님에게 알릴 수 있다.
  set("sh-registered", sh.chain_asset);
  // 🔴 비어 있으면 **지갑에 물어서 알아낸다.** 사장에게 「체인 이름이
  //    뭐였죠」라고 물으면 안 된다 — 답은 이 컴퓨터 안에 이미 있다.
  //
  //    실측(2026-08-25): 체인에 `SHOP.PLAYX` 가 멀쩡히 있고 지갑에
  //    소유권 토큰 `SHOP.PLAYX!` 도 있는데, `shop.json` 의 `chain_asset`
  //    만 비어 있었다(예전에 저장하는 쪽이 값을 안 담던 시절의 흔적).
  //    그래서 앱은 「체인에 가게를 등록하지 않았습니다」라고 말했고,
  //    **어느 이름으로 알릴지 몰라 릴레이 공지도 못 올렸다.**
  //    가게가 켜져 있는데도 세상에서 안 보이던 이유 중 하나다.
  if (!sh.chain_asset) void healChainAsset();
  lockChainName();
  set("mn-cur", sh.currency);
  const chk = (id: string, v: any) => {
    const el = $(id) as HTMLInputElement | null;
    if (el && v != null) el.checked = !!v;
  };
  chk("sh-pickup", sh.pickup);
  chk("sh-delivery", sh.delivery);
  chk("sh-closednow", sh.closed_now);
  paintOpenPick();
  set("sh-closednote", sh.closed_note);
  drawHours(sh.hours);

  if (sh.payment_address) {
    shopAddress = sh.payment_address;
    // 🔴 대표님: "가게 정보 기존에 눌러놓은거 있는데 다시 눌러보면 왜 지금
    //    입력되어 있는 내용이 없지?"
    //
    //    **지워진 게 아니었다.** 값은 파일에 멀쩡히 있었는데 **칸에 되쓰는
    //    코드가 없었다** — 변수에만 담고 화면에는 안 그렸다. 사장 눈에는
    //    「입력한 게 날아갔다」로 보인다. 그게 가장 불안한 화면이다.
    const el = $("sh-addr") as HTMLInputElement | null;
    if (el && !el.value.trim()) el.value = String(sh.payment_address);
  }
  if (sh.icon) {
    shopIcon = sh.icon;
    // 🔴 대표님(이전): "사진을 올리면 사진의 썸네일이 보여야 올렸는지 판단이
    //    되지 않나?"  맞다. 그런데 **다시 열면 사라졌다** — 변수에만 넣고
    //    그리지 않아서, 사장은 사진이 날아간 줄 알고 또 올린다.
    const box = document.getElementById("sh-picprev");
    if (box && !box.innerHTML.trim()) {
      const src = String(sh.icon).startsWith("data:")
        ? String(sh.icon)
        : `http://127.0.0.1:8080/ipfs/${sh.icon}`;
      // ⚠️ 파일창고가 꺼져 있으면 그림이 안 뜬다. 그때 **빈 자리**로 두면
      //    또 「없다」로 읽힌다. 무슨 일인지 말한다.
      box.innerHTML =
        `<img src="${escapeHtml(src)}" alt="" ` +
        `style="max-width:180px;border-radius:8px;margin-top:8px" ` +
        `onerror="this.replaceWith(Object.assign(document.createElement('p'),` +
        `{className:'meta',textContent:'사진은 올라가 있습니다. 파일창고가 꺼져 있어 지금은 못 보여 드립니다.'}))" />`;
    }
  }
  // 이미 올려 둔 가게 안 사진을 다시 보여 준다. 안 보여 주면 사장은
  // 「안 올라갔나」 하고 또 올린다.
  if (sh.photos_cid) {
    shopPhotosCid = String(sh.photos_cid);
    const box = document.getElementById("sh-picsprev");
    const note = document.getElementById("sh-picsnote");
    if (box) {
      box.innerHTML = Array.from({ length: 12 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return `<img src="http://127.0.0.1:8080/ipfs/${shopPhotosCid}/${n}.jpg" alt=""
                 onerror="this.remove()"
                 style="width:84px;height:84px;object-fit:cover;border-radius:8px" />`;
      }).join("");
    }
    if (note) note.textContent = "올려 두신 사진입니다. 다시 고르시면 통째로 바뀝니다.";
  }
  if (sh.lat != null && sh.lon != null) {
    shopCoords = { lat: sh.lat, lon: sh.lon };
    // 같은 이유로 좌표도 되쓴다.
    const el = $("sh-coords") as HTMLInputElement | null;
    if (el && !el.value.trim()) el.value = `${sh.lat}, ${sh.lon}`;
  }

  if (Array.isArray(sh.menu)) {
    menuItems.length = 0;
    sh.menu.forEach((m: any) => menuItems.push(m));
    renderMenu();
  }

  // 🔴 **읽었으면 화면을 다시 그린다.** 이 함수는 `await` 로 값을 채우는데,
  //    이 함수를 부르는 쪽은 기다리지 않는다. 그래서 첫 화면·왼쪽 메뉴·
  //    체인 등록 표시는 **칸이 비어 있던 순간의 판단**을 그대로 들고 있었다.
  //
  //    그 결과가 「가게가 있는데 「가게 만들기」가 뜬다」였다. 이름은 화면에
  //    들어와 있는데 아무도 다시 안 본 것이다.
  labelShopNav();
}

// ── 메뉴판 ──
function curLabel() {
  const c = ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
  return c === "KRW" ? "(원)" : c === "USD" ? "($)" : "(RVN)";
}

/** 자주 걸리는 시간. 직접 적을 수도 있다. */
const MINUTES: { label: string; v: number }[] = [
  { label: "15분", v: 15 },
  { label: "30분", v: 30 },
  { label: "1시간", v: 60 },
  { label: "1시간 30분", v: 90 },
  { label: "2시간", v: 120 },
  { label: "3시간", v: 180 },
];

/** 자주 파는 기간. 이걸 안 두면 「30」을 매번 손으로 친다. */
const SPANS: { label: string; months: number; days: number }[] = [
  { label: "하루", months: 0, days: 1 },
  { label: "2일", months: 0, days: 2 },
  { label: "1주", months: 0, days: 7 },
  { label: "1개월", months: 1, days: 0 },
  { label: "3개월", months: 3, days: 0 },
  { label: "6개월", months: 6, days: 0 },
  { label: "1년", months: 12, days: 0 },
];

/**
 * 품목 종류에 따라 나오는 칸.
 *
 * 🔴 커피 줄에는 아무것도 안 나온다. 모든 줄에 재고·기간 칸을 보여 주면
 * 그 칸들은 가게 품목 대부분에서 평생 비어 있고, 사장은 「내가 뭘 안 채웠나」
 * 를 계속 신경 쓰게 된다. 빈 칸은 할 일처럼 보인다.
 */
function extraFields(it: any, i: number): string {
  const months = Number(it.pass_months || 0);
  const days = Number(it.pass_days || 0);

  if (it.kind === "stock" || it.stock != null) {
    return `<div class="mnwide">
      <label>남은 개수 — 비우면 무제한</label>
      <input data-mn="stock" data-i="${i}" type="number" min="0" step="1"
             placeholder="무제한" value="${it.stock ?? ""}" style="max-width:180px" />
    </div>`;
  }

  if (it.kind === "book" || (it.minutes != null && it.minutes > 0)) {
    const mins = Number(it.minutes || 0);
    return `<div class="mnwide">
      <label>한 사람에 얼마나 걸리나요</label>
      <div class="spanrow">
        ${MINUTES.map(
          (s, k) =>
            `<button type="button" data-mins="${k}" data-i="${i}" class="${s.v === mins ? "on" : ""}">${s.label}</button>`
        ).join("")}
      </div>
      <div class="row" style="gap:8px;margin-top:8px;align-items:end">
        <div style="max-width:140px">
          <label>분</label>
          <input data-mn="minutes" data-i="${i}" type="number" min="0" step="5"
                 placeholder="0" value="${mins || ""}" />
        </div>
        <span class="meta">${
          mins > 0
            ? "손님이 이 시간만큼 자리를 잡습니다."
            : `<span class="needspan">얼마나 걸리는지 골라 주세요</span>`
        }</span>
      </div>
    </div>`;
  }

  if (it.kind === "pass" || months > 0 || days > 0) {
    const on = (s: (typeof SPANS)[number]) =>
      s.months === months && s.days === days ? " on" : "";
    return `<div class="mnwide">
      <label>얼마 동안 쓰는 표인가요</label>
      <div class="spanrow">
        ${SPANS.map(
          (s, k) =>
            `<button type="button" data-span="${k}" data-i="${i}" class="${on(s).trim()}">${s.label}</button>`
        ).join("")}
      </div>
      <div class="row" style="gap:8px;margin-top:8px;align-items:end">
        <div style="max-width:120px">
          <label>개월</label>
          <input data-mn="pass_months" data-i="${i}" type="number" min="0" step="1"
                 placeholder="0" value="${months || ""}" />
        </div>
        <div style="max-width:120px">
          <label>일</label>
          <input data-mn="pass_days" data-i="${i}" type="number" min="0" step="1"
                 placeholder="0" value="${days || ""}" />
        </div>
        <span class="meta" data-spansay="${i}"></span>
      </div>
    </div>`;
  }
  return "";
}

/**
 * 손님이 **실제로 보낼 수 있는** 제일 작은 값.
 *
 * 🔴 1사토시(0.00000001)가 아니다. 레이븐 노드는 `relayfee`(기본 0.01 RVN)
 * 보다 작은 거래를 아예 안 날라 준다. 그래서 1사토시짜리 커피는 주문은
 * 만들어지는데 손님 지갑이 보내려 하면 **거부당한다** — 그리고 화면은
 * 아무 말도 안 했다. 「결제가 안 돼」의 정체가 이것이었다.
 */
const MIN_RVN = 0.01;

/**
 * 가격이 체인에서 살아남는 값인가.
 *
 * 🔴 RVN 은 소수점 **여덟 자리**까지다. `0.0000000000001` 을 적으면 체인에
 * 올라갈 때 **0 이 되고, 그 물건은 공짜로 나간다.** 화면이 아무 말도 안 하면
 * 사장은 그걸 모른 채 하루를 판다.
 *
 * 원·달러로 파는 가게는 이 문제가 없다 — 주문할 때 그날 시세로 환산하고,
 * 그 결과가 1사토시보다 작을 일은 없다. 그래서 RVN 으로 값을 매긴 가게만
 * 본다.
 */
async function sayPrice(i: number) {
  const el = document.querySelector(`[data-pricesay="${i}"]`) as HTMLElement | null;
  if (!el) return;
  // 품목에 통화가 적혀 있으면 그것이 이긴다. 없으면 가게 통화.
  const cur =
    menuItems[i]?.currency || ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
  const v = Number(menuItems[i]?.price);
  if (!Number.isFinite(v) || v <= 0) {
    el.textContent = "";
    return;
  }
  // 🔴 원으로 매긴 가게에도 **RVN 으로 얼마인지** 적어 준다. 손님이 실제로
  //    보내는 것은 RVN 이고, 사장은 그 값을 한 번도 못 본 채 장사하게 된다.
  if (cur !== "RVN") {
    try {
      const r = await invoke<any>("rvn_rate", { currency: cur });
      const rvn = v / Number(r?.rate || 0);
      el.textContent = Number.isFinite(rvn) && rvn > 0
        ? `${t("지금 시세로")} ${rvn.toLocaleString(undefined, { maximumFractionDigits: 0 })} RVN`
        : "";
    } catch {
      el.textContent = "";
    }
    return;
  }
  if (v < MIN_RVN) {
    el.innerHTML =
      `<span class="needspan">${t("너무 작아 손님이 못 보냅니다 — 제일 작은 값은 0.01 RVN 입니다.")}</span>`;
    return;
  }
  // 🔴 **지금 시세로 얼마인지 적어 준다.** 사장은 「1286 RVN」이 얼마인지
  //    모른다 — 아는 값은 「4500원」이다. 이 한 줄이 없으면 값을 잘못 넣고도
  //    모르고, 실제로 10만 배 작은 값이 들어가 있었다.
  try {
    const r = await invoke<any>("rvn_rate", { currency: "KRW" });
    const won = v * Number(r?.rate || 0);
    if (won > 0) {
      el.textContent = `${t("지금 시세로")} ${Math.round(won).toLocaleString()}${t("원")}`;
      return;
    }
  } catch {
    /* 시세를 못 읽어도 값은 저장된다 */
  }
  // 여덟 자리를 넘는 자리는 체인에서 잘린다. 잘린다고 미리 말해 준다.
  const cut = Math.round(v * 1e8) / 1e8;
  el.textContent =
    cut !== v ? `${t("체인에는")} ${cut} RVN ${t("으로 올라갑니다")}` : "";
}

/** 「8월 23일에 사면 9월 22일까지」 — 사장이 카운터에서 할 말 그대로. */
async function saySpan(i: number) {
  const el = document.querySelector(`[data-spansay="${i}"]`) as HTMLElement | null;
  if (!el) return;
  const it = menuItems[i];
  const months = Number(it.pass_months || 0);
  const days = Number(it.pass_days || 0);
  if (months <= 0 && days <= 0) {
    el.innerHTML = `<span class="needspan">${t("기간을 골라 주세요")}</span>`;
    return;
  }
  try {
    const today = await invoke<number>("today_ymd", { nowUnix: Math.floor(Date.now() / 1000) });
    const p = await invoke<any>("period_end", {
      fromYmd: today,
      months,
      extraDays: months > 0 && days <= 0 ? 0 : days,
    });
    const fmt = (v: number) => `${Math.floor(v / 100) % 100}월 ${v % 100}일`;
    el.textContent = `${t("오늘 사면")} ${fmt(p.end)}${t("까지")} (${p.days}${t("일")})`;
  } catch {
    el.textContent = "";
  }
}

function renderMenu() {
  $("mn-items").innerHTML = menuItems
    .map(
      (it, i) => `<div class="mnitem">
        <div class="mnpic" data-mnpic="${i}" title="사진 ${it.image ? "바꾸기" : "올리기"}">
          ${
            it.image
              // 🔴 우리 서버(8790)를 거쳐 받는다. IPFS 게이트웨이(8080)를
              //    직접 부르면 그쪽이 잠깐 늦을 때마다 실패하고, 아래
              //    `onerror` 가 **그림 자리를 영구히 글자로 바꿔** 버렸다.
              //    다시 시도할 길이 없어서 사장 눈에는 「사진이 안 나온다」다.
              //
              //    8790 은 이미 켜져 있고 20초를 기다려 준다. 그리고 실패해도
              //    자리를 안 없앤다 — 다시 그리면 다시 시도한다.
              ? `<img src="http://127.0.0.1:8790/ipfs/${it.image}" alt="" loading="lazy"
                      onerror="this.style.display='none';this.parentElement.classList.add('nopic')" />`
              : "사진"
          }
        </div>
        <div><label>품목</label><input data-mn="name" data-i="${i}" value="${it.name || ""}" /></div>
        <div><label>가격</label>
          <div class="row" style="gap:6px">
            <input data-mn="price" data-i="${i}" type="number" step="any"
                   value="${it.price ?? ""}" style="flex:1;min-width:0" />
            <!-- 🔴 **품목마다 통화가 다를 수 있다.** 한 가게가 커피(원)와
                 음반(RVN)과 해외 굿즈(달러)를 같이 판다. 비워 두면 가게
                 통화를 쓰므로, 커피집은 이 칸을 볼 이유가 없다. -->
            <select data-mn="currency" data-i="${i}" style="flex:none;width:82px">
              <option value=""${!it.currency ? " selected" : ""}>${curLabel().replace(/[()]/g, "") || "가게값"}</option>
              <option value="KRW"${it.currency === "KRW" ? " selected" : ""}>원</option>
              <option value="RVN"${it.currency === "RVN" ? " selected" : ""}>RVN</option>
              <option value="USD"${it.currency === "USD" ? " selected" : ""}>USD</option>
              <option value="JPY"${it.currency === "JPY" ? " selected" : ""}>엔</option>
              <option value="EUR"${it.currency === "EUR" ? " selected" : ""}>유로</option>
            </select>
          </div>
          <div class="meta" data-pricesay="${i}"></div>
        </div>
        <div class="mnacts">
          <button class="ghost" data-mnpic="${i}">${it.image ? "사진 바꾸기" : "사진"}</button>
          <button class="ghost" data-mndel="${i}">삭제</button>
        </div>
        ${extraFields(it, i)}
      </div>`
    )
    .join("");

  $("mn-items")
    .querySelectorAll("[data-mn]")
    .forEach((el) => {
      // select 는 `input` 이 아니라 `change` 로 온다. `oninput` 만 걸면
      // 통화를 골라도 저장이 안 된다.
      const on = () => {
        const i = +(el as HTMLElement).dataset.i!;
        const k = (el as HTMLElement).dataset.mn!;
        const raw = (el as HTMLInputElement).value;
        if (k === "price") {
          menuItems[i][k] = parseFloat(raw);
          // 🔴 레이븐은 소수점 **여덟 자리**까지다(1사토시 = 0.00000001).
          //    그보다 작은 값은 체인에 존재하지 않는다. 화면이 안 막으니
          //    `0.0000000000001` 같은 값이 그대로 들어갔고, 그건 체인에서
          //    0 이 되어 **공짜로 팔린다.**
          void sayPrice(i);
        } else if (k === "stock" || k === "pass_months" || k === "pass_days" || k === "minutes") {
          // 🔴 빈 칸과 0 은 다르다. 재고를 비우면 **무제한**이고 0 은 품절이다.
          //    빈 칸을 0 으로 저장하면 사장이 아무것도 안 적은 품목이 전부
          //    품절로 뜬다. 러스트도 그렇게 읽는다(`stock.rs` `declared`).
          menuItems[i][k] = raw.trim() === "" ? null : Math.max(0, Math.floor(+raw) || 0);
          if (k === "pass_months" || k === "pass_days" || k === "minutes") {
            // 직접 적으면 기본 단추의 선택 표시를 다시 맞춘다.
            renderMenu();
            void saySpan(i);
          }
        } else {
          menuItems[i][k] = raw;
        }
        saveShop();
      };
      (el as HTMLInputElement).oninput = on;
      (el as HTMLSelectElement).onchange = on;
    });

  // 기본 기간 단추. 누르면 개월·일 칸이 같이 채워진다 — 단추만 바뀌고
  // 칸이 그대로면 무엇이 저장됐는지 알 수 없다.
  $("mn-items")
    .querySelectorAll("[data-span]")
    .forEach((el) => {
      (el as HTMLElement).onclick = () => {
        const i = +(el as HTMLElement).dataset.i!;
        const s = SPANS[+(el as HTMLElement).dataset.span!];
        menuItems[i].pass_months = s.months || null;
        menuItems[i].pass_days = s.days || null;
        menuItems[i].kind = "pass";
        saveShop();
        renderMenu();
        void saySpan(i);
      };
    });
  $("mn-items")
    .querySelectorAll("[data-mins]")
    .forEach((el) => {
      (el as HTMLElement).onclick = () => {
        const i = +(el as HTMLElement).dataset.i!;
        menuItems[i].minutes = MINUTES[+(el as HTMLElement).dataset.mins!].v;
        menuItems[i].kind = "book";
        saveShop();
        renderMenu();
      };
    });
  menuItems.forEach((_, i) => { void saySpan(i); void sayPrice(i); });
  $("mn-items")
    .querySelectorAll("[data-mndel]")
    .forEach((el) => {
      (el as HTMLElement).onclick = () => {
        menuItems.splice(+(el as HTMLElement).dataset.mndel!, 1);
        renderMenu();
        saveShop();
      };
    });
  $("mn-items")
    .querySelectorAll("[data-mnpic]")
    .forEach((el) => {
      (el as HTMLElement).onclick = () => pickImage(+(el as HTMLElement).dataset.mnpic!);
    });
  // 🔴 값 없는 품목은 손님 화면에 **안 나간다**(공짜로 나가는 것을 막는다).
  //    그런데 그걸 안 알려 주면 사장은 「왜 손님 화면에 커피가 없지」를
  //    영영 못 푼다. 조용히 빼는 것이 제일 나쁘다.
  void (async () => {
    const note = $("mn-note");
    const cur = ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
    let bad: string[] = [];
    try {
      bad = await invoke<string[]>("unsellable", { menu: menuItems });
    } catch {
      /* 못 물어봤으면 개수만 적는다 */
    }
    const count = menuItems.length ? `${t("품목")} ${menuItems.length}${t("개")}` : "";
    note.innerHTML = !bad.length
      ? count
      : `${count} · <span class="needspan">${t("값이 없어 손님에게 안 보이는 것")} ${bad.length}${t("개")}</span>
         <span class="meta">— ${escapeHtml(bad.slice(0, 4).join(", "))}${bad.length > 4 ? "…" : ""}</span>`;
    // 🔴 「원으로 하세요」라고 권하지 않는다. 어느 쪽이 맞는지는 사장이 무엇을
    //    지키고 싶은가에 달렸고, 그건 우리가 정할 일이 아니다.
    //
    //      RVN 으로 매기면 → 코인 수량이 일정. 시세가 오르면 손님이 더 낸다.
    //      원으로 매기면   → 원 가치가 일정. 시세가 오르면 코인을 덜 받는다.
    //
    //    RVN 을 모으는 것이 목적인 가게에는 RVN 이 맞다. 둘 다 사실만 적는다.
    if (menuItems.length) {
      note.innerHTML +=
        `<div class="meta" style="margin-top:6px">${
          cur === "RVN"
            ? t("값을 RVN 으로 매기고 계십니다 — 코인 수량이 일정하고, 시세가 오르면 손님이 내는 원 값이 같이 오릅니다.")
            : t("값을 원으로 매기고 계십니다 — 손님이 내는 원 값이 일정하고, RVN 수량은 그날 시세로 계산됩니다.")
        }</div>`;
    }
  })();
}

/// Shows the owner what the customer sees.
///
/// The customer page is served by this computer on port 8790 and designed for a
/// phone held in one hand. Showing it full-width on a desktop would be a
/// different screen than the one that exists, so it renders at phone width.
async function previewCustomer() {
  $("mn-prevnote").textContent = "여는 중…";
  try {
    if (!serverIp) await startPhone();
  } catch {}
  if (!serverIp) {
    $("mn-prevnote").innerHTML =
      `<span class="danger">손님 폰 서버가 꺼져 있습니다 — [이 컴퓨터]에서 켜 주세요.</span>`;
    return;
  }
  $("mn-prevnote").textContent = "";
  $("mn-prevbox").innerHTML =
    `<div class="card" style="margin-top:11px">
       <h3>손님이 보는 화면</h3>
       <iframe src="http://127.0.0.1:8790/" title="손님 화면"
               style="width:390px;max-width:100%;height:min(620px,60vh);border:1px solid var(--line);
                      border-radius:16px;background:#fff;display:block;margin-top:10px"></iframe>
       <p class="meta" style="margin-top:8px">폰 크기 그대로입니다.
         고친 메뉴를 보려면 <b>메뉴판 올리기</b>를 먼저 누르셔야 합니다.</p>
     </div>`;
}

function pickImage(index: number) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    $("mn-note").textContent = "사진 올리는 중…";
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const added = await invoke<any>("ipfs_add_file", { file: { name: file.name, bytes } });
      menuItems[index].image = added.cid;
      saveShop();
      renderMenu();
      // 🔴 `renderMenu()` 안에서 「값 없는 품목」 안내가 이 칸을 다시 쓴다.
      //    그래서 「올렸습니다」가 곧바로 지워졌고, 사장은 올라갔는지 몰랐다.
      //    그리기가 끝난 뒤에 적는다.
      setTimeout(() => {
        $("mn-note").innerHTML = `<span class="ok">사진을 올렸습니다</span>`;
      }, 80);
    } catch (e) {
      $("mn-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
    }
  };
  input.click();
}

async function saveMenu() {
  // 🔴 기간 없는 이용권은 **덜 채운 것이 아니라 고장난 상품**이다. 그대로
  //    올리면 한 달 값을 받고 하루짜리 표가 나가고, 손님은 다음 날 문 앞에서
  //    알게 된다. 여기서 막는 편이 그 자리에서 싸우는 것보다 낫다.
  const noSpan = menuItems
    .map((m, i) => ({ m, i }))
    .filter(
      ({ m }) =>
        (m.kind === "pass" && !Number(m.pass_months || 0) && !Number(m.pass_days || 0)) ||
        // 예약도 같다. 시간 없는 예약 품목은 손님이 골라도 자리를 안 잡는다.
        (m.kind === "book" && !Number(m.minutes || 0))
    );
  // 🔴 RVN 으로 값을 매긴 가게에서 1사토시보다 작은 값은 **체인에서 0** 이다.
  //    그대로 올리면 그 물건이 공짜로 나간다.
  const tooSmall =
    (($("mn-cur") as HTMLSelectElement)?.value || "KRW") === "RVN"
      ? menuItems.filter((m) => Number(m.price) > 0 && Number(m.price) < MIN_RVN)
      : [];
  if (tooSmall.length) {
    $("mn-result").innerHTML =
      `<div class="warnbox" style="margin-top:12px">
         <b>${escapeHtml(tooSmall.map((m) => m.name || "이름 없음").join(", "))}</b>
         의 값이 너무 작습니다.<br />
         레이븐이 <b>나를 수 있는</b> 제일 작은 값은 <b>0.01 RVN</b> 입니다.<br />
         그보다 작으면 손님이 QR 을 찍어도 <b>지갑이 보내기를 거부합니다</b> —
         주문은 만들어지는데 결제만 안 됩니다.</div>`;
    return;
  }
  if (noSpan.length) {
    const names = noSpan.map(({ m, i }) => m.name || `${i + 1}번`).join(", ");
    $("mn-result").innerHTML =
      `<div class="warnbox" style="margin-top:12px">
         <b>${escapeHtml(names)}</b> 의 기간이 비어 있습니다.<br />
         며칠짜리인지 골라 주세요 — 안 고르면 손님이 산 표가 언제까지인지
         아무도 모릅니다.</div>`;
    // 처음 걸린 줄로 데려간다. 어디를 고쳐야 하는지 찾게 하지 않는다.
    (
      document.querySelector(`[data-mn="pass_days"][data-i="${noSpan[0].i}"]`) as HTMLElement | null
    )?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (!menuItems.length) {
    $("mn-result").innerHTML = `<div class="warnbox" style="margin-top:12px">품목이 없습니다.</div>`;
    return;
  }
  try {
    const doc = await invoke<any>("build_menu", {
      items: menuItems,
      currency: ($("mn-cur") as HTMLSelectElement).value,
    });
    const up = await invoke<any>("ipfs_add_bundle", { files: [], metadata: doc });
    // 🔴 메뉴가 바뀌었다고 손님에게 알린다. 이게 없으면 사장은 새 메뉴판을
    //    올려 놓고 「손님 화면은 왜 그대로지」를 겪는다 — 다음 심장이 뛸
    //    때까지 45분이다. 체인은 안 건드리므로 **소각 0원**이다.
    try {
      await invoke("shop_refresh");
    } catch {
      /* 아직 체인에 등록 안 했으면 알릴 간판이 없다. 메뉴는 저장됐다. */
    }
    $("mn-result").innerHTML =
      // 올린 것을 볼 수 없으면 올렸는지 알 수 없다. 주소만 보여 주던 자리다.
      `<div class="card" style="margin-top:12px"><h3>메뉴판을 올렸습니다</h3>
       <iframe src="http://127.0.0.1:8080/ipfs/${up.cid}/" title="메뉴판 미리보기"
               style="width:100%;height:260px;border:1px solid var(--line);border-radius:10px;margin:10px 0;background:#fff"></iframe>
       <div class="row">
         <button class="ghost" data-openmenu="${up.cid}">브라우저에서 열기</button>
         <button class="ghost" data-copymenu="${up.cid}">주소 복사</button>
       </div>
       <div class="kv" style="margin-top:9px"><b>주소</b><code class="addr">${up.cid}</code></div>
       <p class="meta">손님이 보는 것과 같은 화면입니다. 가게 프로필을 갱신하면 손님 폰에도 나갑니다.
         이 컴퓨터가 켜져 있는 한 유지됩니다.</p></div>`;

    $("mn-result").querySelectorAll("[data-openmenu]").forEach((b) => {
      (b as HTMLElement).onclick = () =>
        invoke("open_share", {
          url: `http://127.0.0.1:8080/ipfs/${(b as HTMLElement).dataset.openmenu}/`,
        }).catch((e) => say(t("열지 못했습니다"), errText(e)));
    });
    $("mn-result").querySelectorAll("[data-copymenu]").forEach((b) => {
      (b as HTMLElement).onclick = () =>
        {
          const url = `http://127.0.0.1:8080/ipfs/${(b as HTMLElement).dataset.copymenu}/`;
          navigator.clipboard.writeText(url);
          (b as HTMLElement).textContent = "복사했습니다";
          setTimeout(() => ((b as HTMLElement).textContent = "주소 복사"), 1500);
        }
    });
  } catch (e) {
    $("mn-result").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
}

// ── 새 주문 알림 ───────────────────────────────────────────────────────────
//
// 🔴 대표님: "우리 프로그램에 돈 들어오거나 하면 알람 오지? 레이븐코어는
//    알림이 뜨던데 말야."
//
//    안 왔다. 돈이 들어와도 소리도, 숫자도, 아무 표시도 없었다. 주문이
//    들어온 것을 아는 유일한 길은 **「내 가게 → 들어온 주문」 탭을 열어 두고
//    30초마다 표가 바뀌는지 사장이 직접 보는 것**이었다. 카운터에서 손님을
//    응대하는 사람에게 그건 없는 기능이나 같다.
//
// ## 무엇으로 알리나 — 소리 + 화면 안 배지 + 띠
//
//    | 방법 | 썼나 | 왜 |
//    |---|---|---|
//    | 소리(Web Audio) | ✅ | 눈이 화면에 없어도 닿는 **유일한** 길 |
//    | 화면 안 배지 | ✅ | 자리를 비웠다 돌아온 사람에게 「몇 건 놓쳤나」 |
//    | 화면 안 띠 | ✅ | 소리를 듣고 화면을 봤을 때 **답이 거기 있어야** 한다 |
//    | 창 깜빡임 | ❌ | 권한이 없다(아래) |
//    | 창 앞으로 세우기 | ❌ | 알림이 아니라 사고다(아래) |
//
//    ⚠️ **창 깜빡임(`requestUserAttention`)은 못 쓴다.** 그건
//       `src-tauri/capabilities/default.json` 에
//       `core:window:allow-request-user-attention` 을 넣어야 열리는데,
//       지금 켜진 창 권한은 읽기 전용(`is-focused`, `title` …)과
//       위치 옮기기뿐이다. 권한 파일을 안 고치고 부르면 그 자리에서 막힌다.
//
//    ⚠️ **창을 앞으로 세우는 것(`set_focus`)은 권한이 있어도 안 한다.**
//       사장이 세금계산서를 치는 중에 창이 튀어나오면 글자가 엉뚱한 데
//       들어간다. 그건 알림이 아니라 사고다. 소리로 부르고, 언제 볼지는
//       사장이 정한다.
//
// ## 소리를 파일 없이 만드는 이유
//
//    mp3 를 넣으면 파일 하나와 그걸 옮길 빌드 설정이 따라온다. Web Audio 로
//    사인파 두 개를 겹치면 그게 다 필요 없고, 볼륨·길이·높이를 여기서 글로
//    설명할 수 있다.
//
//    40~70대가 쓴다. 그래서 **놀라게 하지 않는 소리**여야 하고, 동시에
//    **시끄러운 카운터에서 들려야** 한다. 둘은 반대말 같지만 아니다 —
//    사람을 놀래키는 것은 크기가 아니라 **갑자기 시작하는 것**(딱 소리)과
//    **날카로운 배음**이다. 그래서 사인파(배음 없음) + 20ms 에 걸쳐 천천히
//    올라오는 시작 + 종처럼 길게 남는 꼬리로 만든다. 낮은 도(미)에서
//    높은 라로 **올라가는** 두 음이다 — 올라가는 소리는 「무언가 왔다」로
//    들리고, 내려가는 소리는 「무언가 잘못됐다」로 들린다.

const 소리설정_KEY = "playx-raven-order-sound";

/// 알림이 켜져 있나. **기본은 켜짐** — 없는 값은 켜진 것으로 읽는다.
///
/// 장사하는 사람에게 소리 없는 주문은 놓친 주문이다. 「시끄러워서 껐다」는
/// 한 번 찾아 끄면 끝나지만, 「알림이 있는 줄도 몰랐다」는 영영 모른다.
function 알림켜짐(): boolean {
  try {
    return localStorage.getItem(소리설정_KEY) !== "0";
  } catch {
    // 저장소가 막힌 기계도 있다. 그때도 장사는 돌아가야 하니 켜진 쪽으로 둔다.
    return true;
  }
}

let 소리상자: AudioContext | null = null;

/// 소리 낼 준비. 없으면 만들고, 자고 있으면 깨운다.
///
/// ⚠️ 브라우저·웹뷰는 **사람이 한 번 누르기 전에는 소리를 못 내게** 막는다.
///    그래서 첫 손짓에 미리 만들어 둔다(아래 `소리깨우기`). 그걸 안 하면
///    첫 주문이 소리 없이 지나가고, 사장은 「역시 안 되네」로 판단한다.
function 소리준비(): AudioContext | null {
  try {
    if (!소리상자) {
      const 만들기 =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!만들기) return null;
      소리상자 = new 만들기() as AudioContext;
    }
    if (소리상자.state === "suspended") void 소리상자.resume();
    return 소리상자;
  } catch {
    return null;
  }
}

/// 종소리 한 음. 사인파 하나 + 소리 크기 곡선.
function 한음(ctx: AudioContext, 시작: number, 높이: number, 길이: number, 크기: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine"; // 배음이 없다 = 날카롭지 않다
  osc.frequency.setValueAtTime(높이, 시작);
  // 0 에서 시작하면 exponentialRamp 가 안 먹는다. 들리지 않는 값에서 올린다.
  gain.gain.setValueAtTime(0.0001, 시작);
  // 20ms 에 걸쳐 올린다. 곧바로 최대로 켜면 「딱」 하는 소리가 나고, 사람을
  // 놀래키는 것은 소리 크기가 아니라 바로 그 딱 소리다.
  gain.gain.exponentialRampToValueAtTime(크기, 시작 + 0.02);
  // 종처럼 길게 사라진다. 뚝 끊기면 기계음으로 들린다.
  gain.gain.exponentialRampToValueAtTime(0.0001, 시작 + 길이);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(시작);
  // 꼬리가 다 사라진 뒤에 끈다. 여기서 일찍 끊으면 그게 또 딱 소리다.
  osc.stop(시작 + 길이 + 0.05);
}

/// 「딩—동」. `번` 만큼 되풀이한다.
///
/// 크기 0.25 는 시스템 볼륨의 4분의 1쯤이다. 이 이상 올리면 조용한 사무실에서
/// 사람이 의자에서 튄다. 카운터가 시끄러워서 안 들리는 경우는 **되풀이**로
/// 푼다 — 한 번 크게보다 두 번 부르는 쪽이 놀라지 않고 더 잘 닿는다.
function 알림소리(번: number = 1) {
  const ctx = 소리준비();
  if (!ctx) return;
  try {
    const 처음 = ctx.currentTime + 0.02;
    for (let i = 0; i < 번; i++) {
      const t = 처음 + i * 0.95;
      한음(ctx, t, 659.25, 0.5, 0.22); // 미
      한음(ctx, t + 0.17, 880.0, 0.68, 0.25); // 라 — 올라간다
    }
  } catch {
    // 소리가 안 나도 배지와 띠는 남는다. 여기서 던지면 그것까지 죽는다.
  }
}

/// 사람이 처음 뭔가 누를 때 소리 상자를 미리 만들어 둔다.
/// `once: true` 라 한 번 하고 스스로 빠진다.
function 소리깨우기() {
  const 한번 = () => void 소리준비();
  document.addEventListener("pointerdown", 한번, { once: true, capture: true });
  document.addEventListener("keydown", 한번, { once: true, capture: true });
}

// ── 같은 주문에 두 번 울리지 않게 ──────────────────────────────────────────
//
// 30초마다 같은 목록을 다시 받는다. 기억이 없으면 **주문 하나가 30초마다
// 영원히 울린다.** 그건 알림이 아니라 고장이고, 사장은 하루 만에 끈다.
//
// 주문마다 주소가 다르다(`loadOrders` 첫 줄 참고). 그래서 주소가 곧 주문
// 번호다. 주소마다 「결제 확인까지 알렸나」를 같이 들고 있는다 — 주문이
//   ① 처음 보임(아직 확인 0)  → "새 주문"
//   ② 확인이 붙어 결제됨      → "입금 확인"
// 두 번 말할 값어치가 있는 순간이 둘이기 때문이다. 하지만 각각 한 번씩만이다.
const 아는주문 = new Map<string, boolean>();

/// ⚠️ **첫 조회는 조용히 지나간다.**
///
///    이걸 안 하면 앱을 켤 때마다 어제·지난주 주문이 통째로 「새 주문」이 되어
///    한꺼번에 울린다. 프로그램을 켜는 것은 주문이 아니다. 첫 목록은 「지금
///    여기까지가 이미 아는 것」으로 조용히 적어 두고, 그 다음부터 말한다.
let 첫목록읽었나 = false;

/// 사장이 주문표를 마지막으로 본 뒤 들어온 건수.
let 안본주문 = 0;

/// 지금 사장이 화면을 보고 있나.
///
/// `쉬는중()`(= `document.hidden`)은 **창을 최소화했을 때만** 참이다. 다른
/// 창에 가려 뒤에 있을 때는 거짓이라, 그것만으로는 「보고 있다」를 못 판단한다.
/// `document.hasFocus()` 를 같이 본다 — 이건 DOM 이 그냥 알려 주는 것이라
/// Tauri 권한이 필요 없다.
function 화면보는중(): boolean {
  try {
    return !쉬는중() && document.hasFocus();
  } catch {
    return false;
  }
}

/// 지금 눈이 **주문표에** 있나. 여기 있으면 배지·띠는 군더더기다 —
/// 새 줄이 표에 뜨는 것이 이미 답이다.
function 주문표보는중(): boolean {
  return (
    화면보는중() &&
    document.getElementById("page-shop")?.classList.contains("on") === true &&
    document.getElementById("shoptab-orders")?.classList.contains("on") === true
  );
}

function 배지그리기() {
  for (const id of ["or-badge", "nav-orderbadge"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = String(안본주문);
    el.hidden = 안본주문 <= 0;
  }
}

/// 사장이 주문표를 봤다 → 숫자와 띠를 내린다.
function 주문봤다() {
  안본주문 = 0;
  배지그리기();
  const 띠 = document.getElementById("neworder");
  if (띠) 띠.hidden = true;
}

function 띠띄우기(제목: string) {
  const 띠 = document.getElementById("neworder");
  if (!띠) return;
  const t = document.getElementById("no-title");
  if (t) t.textContent = 제목;
  띠.hidden = false;
}

/**
 * 새로 받은 주문 목록을 보고 **말할 것이 있으면 말한다.**
 *
 * 목록을 받는 자리가 둘이라(주문표 새로고침 · 아래 `주문지킴이`) 판단은
 * 여기 한 곳에만 둔다. 두 곳에 나눠 두면 한쪽만 고치는 날이 온다.
 */
function 주문살피기(list: any[]) {
  if (!Array.isArray(list)) return;

  let 새주문 = 0;
  let 새입금 = 0;

  for (const p of list) {
    const 키 = p?.address;
    if (!키) continue;
    // `settled` 는 확인이 다 붙은 것, `accept_now` 는 사장이 이 금액이면
    // 그냥 받겠다고 정해 둔 것. 카운터에서는 둘 다 「돈 들어왔다」다.
    const 돈됐나 = !!(p.settled || p.accept_now);

    if (!아는주문.has(키)) {
      아는주문.set(키, 돈됐나);
      if (첫목록읽었나) {
        if (돈됐나) 새입금++;
        else 새주문++;
      }
    } else if (돈됐나 && !아는주문.get(키)) {
      // 아까는 확인을 기다리던 주문이 방금 결제로 굳었다.
      아는주문.set(키, true);
      if (첫목록읽었나) 새입금++;
    }
  }

  // 표가 아주 길어지면 기억도 같이 커진다. 지금 목록에 없는 주소는 다시
  // 돌아오지 않으니(체인은 지워지지 않는다) 가끔 지금 것만 남기고 턴다.
  if (아는주문.size > 600) {
    const 지금 = new Map<string, boolean>();
    for (const p of list) {
      if (p?.address && 아는주문.has(p.address)) 지금.set(p.address, 아는주문.get(p.address)!);
    }
    아는주문.clear();
    for (const [k, v] of 지금) 아는주문.set(k, v);
  }

  if (!첫목록읽었나) {
    // 여기가 조용한 첫 바퀴다. 위에서 이미 다 적어 뒀다.
    첫목록읽었나 = true;
    return;
  }

  const 모두 = 새주문 + 새입금;
  if (모두 <= 0) return;
  if (!알림켜짐()) return; // 꺼 두셨으면 아무것도 안 한다

  // ⚠️ **창을 보고 있어도 소리는 낸다.**
  //    `쉬는중()` 으로 막고 싶어지는 자리지만, 그러면 이 기능이 없어진다.
  //    주문이 들어오는 바로 그 순간 사장의 눈은 손님에게 가 있다 — 창이
  //    앞에 떠 있는 것과 그걸 보고 있는 것은 다른 말이다.
  //
  //    대신 **안 보고 있을 때 한 번 더** 부른다. 곁눈으로도 안 잡히는
  //    상황이니 두 번 부르는 값이 있다.
  알림소리(화면보는중() ? 1 : 2);

  // 주문표를 열어 놓고 보는 중이면 배지도 띠도 안 올린다. 표에 새 줄이
  // 뜨는 것이 이미 답이고, 그 위에 「새 주문 1건」을 덮으면 표를 가린다.
  if (주문표보는중()) return;

  안본주문 += 모두;
  배지그리기();
  띠띄우기(
    새입금 > 0 && 새주문 > 0
      ? `새 주문 ${새주문}건 · 입금 ${새입금}건`
      : 새입금 > 0
        ? `입금 ${새입금}건 확인`
        : `새 주문 ${새주문}건`,
  );
}

/**
 * 주문표를 안 보고 있어도 도는 지킴이.
 *
 * 🔴 주문표의 「자동 확인 (30초)」는 **꺼진 채로 시작**하고, 켜도 그건
 *    화면을 다시 그리는 일이다. 알림이 그 스위치에 매달려 있으면
 *    「주문 탭을 열어 두고 스위치를 켠 사장」만 알림을 받는다 — 그 사장은
 *    애초에 알림이 필요 없는 사람이다.
 *
 *    그래서 알림은 **자기 시계**로 돈다. 알림을 끄면 물어보지도 않는다 —
 *    밤새 켜 두는 컴퓨터에서 노드를 30초마다 깨울 이유가 없다.
 *
 * ⚠️ 주문표가 이미 30초마다 돌고 있으면 여기서는 쉰다. 같은 것을 두 번
 *    물어봐 봐야 답이 같고, 느린 컴퓨터에서는 그 한 번이 아깝다.
 */
async function 주문지킴이() {
  if (!알림켜짐()) return;
  const 자동 = document.getElementById("or-auto") as HTMLInputElement | null;
  if (자동?.checked) return; // `loadOrders` 가 이미 살피고 있다
  try {
    const res = await quietly(() =>
      invoke<any>("incoming_payments", { address: "", minConf: 1 }),
    );
    주문살피기(res?.payments || []);
  } catch {
    // 노드가 아직 따라잡는 중일 수 있다. 조용히 다음 바퀴에 다시 본다 —
    // 여기서 사장에게 빨간 글씨를 보여 봐야 할 수 있는 일이 없다.
  }
}

/// 설정 스위치·소리 시험·알림 띠의 단추들을 잇고, 지킴이 시계를 켠다.
function 알림배선() {
  const sw = document.getElementById("snd-on") as HTMLInputElement | null;
  if (sw) {
    sw.checked = 알림켜짐();
    sw.addEventListener("change", () => {
      try {
        localStorage.setItem(소리설정_KEY, sw.checked ? "1" : "0");
      } catch {}
      const say = document.getElementById("snd-say");
      if (say)
        say.textContent = sw.checked
          ? "이제 주문이 들어오면 소리로 알려 드립니다."
          : "소리를 껐습니다. 주문은 그대로 들어옵니다.";
      // 껐으면 지금 떠 있는 것도 같이 내린다. 끄고 나서도 빨간 숫자가
      // 남아 있으면 꺼진 것인지 아닌지 알 수 없다.
      if (!sw.checked) 주문봤다();
    });
  }
  // 🔴 「소리 들어보기」는 예의가 아니라 **필수**다. 소리는 안 나 봐야
  //    안 나는 줄 안다 — 볼륨이 0 인지, 스피커가 없는지, 우리가 고장인지
  //    사장이 구분할 길이 여기밖에 없다. 그리고 이 단추를 누르는 행동이
  //    곧 웹뷰의 소리 잠금을 푸는 「사람의 손짓」이기도 하다.
  document.getElementById("snd-test")?.addEventListener("click", () => {
    알림소리(1);
    const say = document.getElementById("snd-say");
    if (say)
      say.textContent =
        "「딩—동」 소리가 안 들리면 컴퓨터 볼륨과 스피커를 확인해 주세요.";
  });

  document.getElementById("no-go")?.addEventListener("click", () => {
    주문봤다();
    showPage("shop");
    shopTab("orders");
  });
  document.getElementById("no-x")?.addEventListener("click", 주문봤다);
  document.getElementById("no-mute")?.addEventListener("click", () => {
    try {
      localStorage.setItem(소리설정_KEY, "0");
    } catch {}
    const sw2 = document.getElementById("snd-on") as HTMLInputElement | null;
    if (sw2) sw2.checked = false;
    주문봤다();
  });

  소리깨우기();

  // 켜자마자 한 번 — 이 첫 바퀴가 「이미 아는 주문」을 조용히 적는 자리다.
  // 3초 미루는 것은 노드가 아직 안 깼을 때 첫 물음이 그냥 실패하기 때문이다.
  setTimeout(() => void 주문지킴이(), 3000);
  setInterval(() => void 주문지킴이(), 30000);
}

/* ── 대화 알림 ────────────────────────────────────────────────────────
 *
 * ## 왜 있나
 *
 * 「이야기」 방은 **새 글이 와도 아무 표시가 없었다.** 그러니 이 화면을 두
 * 번째로 열 이유가 없다 — 열어 봐야 아까 본 글이 그대로 있을 뿐이고, 몇 번
 * 그러면 다시 안 연다. 만들어 놓고 안 이은 자리가 여기였다.
 *
 * ## 🔴 부품을 새로 만들지 않았다
 *
 * 소리 내는 장치(`소리준비`·`한음`)는 주문 알림이 이미 갖고 있다. 그것을
 * 그대로 쓴다. 두 벌을 만들면 볼륨·잠금해제·오류처리를 두 곳에서 고쳐야
 * 하고, 그러면 반드시 한쪽만 고치는 날이 온다.
 *
 * ## ⚠️ 그런데 **소리는 달라야 한다**
 *
 *   주문 = 「딩—동」  미(659) → 라(880) **올라가는 두 음**, 크게(0.25), 길게
 *   대화 = 「톡」      솔(392) **한 음**, 낮게, 작게(0.12), 짧게
 *
 * 돈과 말은 급한 정도가 다르다. 소리가 같으면 사장은 하던 일을 멈추고
 * 주문표를 여는데 거기 아무것도 없다. 두어 번 그러면 다음부터는 **진짜
 * 주문 소리에도 안 움직인다.** 그게 알림을 죽이는 길이다.
 *
 * 세 가지로 갈라 놨다 — **음 개수(2 vs 1)·높이(높다 vs 낮다)·크기.** 하나만
 * 다르면 시끄러운 카운터에서 헷갈린다.
 */

const 대화소리_KEY = "playx-raven-talk-sound";

/// 대화 알림이 켜져 있나. **주문 스위치와 완전히 따로다.**
///
/// 🔴 「주문은 켜고 대화는 끄고」가 보통이다. 하나로 묶으면 대화가 시끄러워서
///    끈 사람이 **주문 소리까지** 잃는다 — 이 프로그램에서 일어날 수 있는
///    제일 나쁜 결과다. 기본은 주문과 같이 켜짐이다(있는 줄 모르는 것이
///    시끄러운 것보다 나쁘다).
function 대화알림켜짐(): boolean {
  try {
    return localStorage.getItem(대화소리_KEY) !== "0";
  } catch {
    return true;
  }
}

/// 「톡」. 낮은 솔 한 음, 짧고 작게. 주문의 「딩—동」과 겹치지 않는다.
///
/// ⚠️ **되풀이하지 않는다.** 주문은 안 보고 있으면 두 번 부르지만, 대화는
///    한 번이다. 말은 나중에 읽어도 되고, 두 번 부르는 순간 이것도 「돈이
///    들어왔나」로 읽힌다. 못 들은 사람을 위해서는 소리 대신 **왼쪽 숫자**가
///    남는다 — 지나간 소리를 대신 들고 있는 자리다.
function 말소리() {
  const ctx = 소리준비();
  if (!ctx) return;
  try {
    // 392 = 낮은 솔. 주문의 659·880 보다 한참 아래라 곁눈으로도 갈린다.
    한음(ctx, ctx.currentTime + 0.02, 392.0, 0.34, 0.12);
  } catch {
    // 소리가 안 나도 왼쪽 숫자는 남는다. 여기서 던지면 그것까지 죽는다.
  }
}

// ── 같은 글에 두 번 울리지 않게 ───────────────────────────────────────
//
// 릴레이에서 같은 목록을 되풀이해 받는다. 기억이 없으면 **글 하나가 45초마다
// 영원히 울린다.** 그건 알림이 아니라 고장이다.
//
// 방마다 따로 센다. Nostr 의 글 id 는 내용의 지문이라 그대로 열쇠로 쓴다.
const 아는글 = new Map<string, Set<string>>();

/// ⚠️ **방마다 첫 조회는 조용히 지나간다.**
///
///    이걸 안 하면 앱을 켤 때마다 어제·지난주 글이 통째로 「새 글」이 되어
///    한꺼번에 울린다. 프로그램을 켜는 것은 새 글이 아니다. 주문 알림이
///    `첫목록읽었나` 로 피한 함정과 **같은 함정, 같은 방법**이다.
///    다른 점은 방이 여럿이라 「하나」가 아니라 **방마다** 있다는 것뿐이다.
const 첫바퀴읽은방 = new Set<string>();

/// 사장이 「이야기」를 마지막으로 연 뒤 들어온 글 수.
let 안본대화 = 0;

function 대화배지그리기() {
  const el = document.getElementById("nav-talkbadge");
  if (!el) return;
  el.textContent = String(안본대화);
  el.hidden = 안본대화 <= 0;
}

/// 사장이 이야기를 봤다 → 숫자를 내린다.
function 대화봤다() {
  안본대화 = 0;
  대화배지그리기();
}

/// 지금 눈이 **바로 그 방에** 있나.
///
/// 🔴 세 가지가 다 맞아야 한다. 창을 보고 있고(`화면보는중`), 이야기 화면이
///    열려 있고, **고른 방이 그 방**이어야 한다. 다른 방을 보고 있는데 이
///    방의 글을 안 알리면 그건 그냥 못 받은 것이다.
function 대화방보는중(room: string): boolean {
  return (
    화면보는중() &&
    document.getElementById("page-talk")?.classList.contains("on") === true &&
    String(tkRoom || "") === String(room || "")
  );
}

/**
 * 방 하나의 글 목록을 보고 **말할 것이 있으면 말한다.**
 *
 * 목록을 받는 자리가 둘이라(화면의 `talkPaint` · 아래 `대화지킴이`) 판단은
 * 여기 한 곳에만 둔다. 주문 알림의 `주문살피기` 와 같은 배치다.
 */
function 대화살피기(room: string, list: any[]) {
  if (!Array.isArray(list)) return;
  const 방 = String(room || "");
  let 본 = 아는글.get(방);
  if (!본) {
    본 = new Set<string>();
    아는글.set(방, 본);
  }

  const 처음 = !첫바퀴읽은방.has(방);
  let 새글 = 0;

  for (const e of list) {
    const id = String(e?.id || "");
    if (!id || 본.has(id)) continue;
    본.add(id);
    if (처음) continue; // 첫 바퀴는 **적기만** 한다
    const who = String(e?.pubkey || "");
    // ⚠️ 내가 쓴 글에는 안 울린다. 내 말이 릴레이를 돌아 다시 오는 것이라,
    //    막지 않으면 보내기를 누를 때마다 알림이 울린다.
    if (!who || who === tkMine) continue;
    // ⚠️ 안 보기 한 분의 글에도 안 울린다. 화면에서는 숨겨 놓고 소리는
    //    나면 그게 제일 이상하다 — 소리는 나는데 볼 글이 없다.
    if (tkMuted[who]) continue;
    새글++;
  }

  // 기억이 끝없이 자라지 않게. 지금 목록에 있는 것만 남긴다.
  if (본.size > 400) {
    아는글.set(방, new Set(list.map((e) => String(e?.id || "")).filter(Boolean)));
  }

  if (처음) {
    // 여기가 조용한 첫 바퀴다. 위에서 이미 다 적어 뒀다.
    첫바퀴읽은방.add(방);
    return;
  }
  if (새글 <= 0) return;
  // ⚠️ 내가 누구인지 아직 모르면 **아무것도 안 한다.** 모르는 채로 울리면
  //    내가 쓴 글에 내가 알림을 받는다. 다음 바퀴에 `talk_me` 가 답한다.
  if (!tkMine) return;
  if (!대화알림켜짐()) return;
  // ⚠️ 그 방을 보고 있으면 소리도 숫자도 없다. 눈앞에 글이 뜨는 것이 이미
  //    답이다. (주문은 여기서 반대로 판단한다 — 돈이 들어오는 순간 사장의
  //    눈은 손님에게 가 있어서, 창이 떠 있는 것과 보고 있는 것이 다르다.
  //    대화는 그렇지 않다. 읽으려고 연 화면이다.)
  if (대화방보는중(방)) {
    // 🔴 다만 **글은 올려 준다.** 이야기 화면에는 자동 새로고침이 없어서,
    //    여기서 안 그리면 사장은 새 글이 온 줄도 모르고 화면을 보고 앉아
    //    있게 된다. 「보고 있으니 알릴 필요 없다」는 보고 있는 화면이
    //    최신일 때만 맞는 말이다.
    //
    //    ⚠️ **맨 아래를 보고 있을 때만** 다시 그린다. 위로 올려 옛 글을
    //       읽는 중에 그리면 화면이 맨 아래로 튀어 읽던 자리를 잃는다.
    //    ⚠️ 되돌이는 안 생긴다 — 다시 그리면서 부르는 `대화살피기` 는
    //       이미 아는 글만 보므로 `새글` 이 0 이라 여기까지 못 온다.
    try {
      const box = document.getElementById("tk-list");
      const 맨아래 = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      if (맨아래) void talkPaint();
    } catch {
      // 못 그려도 다음 새로고침에 나온다. 여기서 던지면 지킴이가 죽는다.
    }
    return;
  }

  말소리();
  안본대화 += 새글;
  대화배지그리기();
}

/* ── 어느 방을 지켜볼까 ────────────────────────────────────────────────
 *
 * 🔴 **전부는 못 지킨다.** `talk_rooms` 는 세상에 있는 방을 최대 50개까지
 *    가져온다. 그걸 다 물어보면 한 바퀴에 릴레이 접속이 150번(방 50 × 릴레이
 *    3)이다. 하루 종일 켜 두는 프로그램에서 그건 알림이 아니라 공격이다.
 *
 * 그래서 **사장이 실제로 여는 방**만 지킨다:
 *   ① 「레이븐 이야기」(기본 방) — 늘
 *   ② 최근에 연 방 두 곳       — `localStorage` 에 남겨 다시 켜도 이어진다
 *
 * 한 번도 안 연 방은 안 지킨다. 열어 본 적 없는 방의 글은 사장에게 아직
 * 남의 이야기다 — 그걸 알리면 그게 광고다.
 */
const 대화보는방_KEY = "playx-raven-talk-watch";

function 지켜보는방(): string[] {
  const out = [""]; // 기본 방. 빈 문자열이 곧 「레이븐 이야기」다.
  try {
    const v = JSON.parse(localStorage.getItem(대화보는방_KEY) || "[]");
    if (Array.isArray(v))
      for (const r of v) {
        const id = String(r || "");
        if (id && !out.includes(id)) out.push(id);
      }
  } catch {
    // 저장소가 막힌 기계에서도 기본 방은 지켜진다.
  }
  // 지금 열어 둔 방은 저장 전이라도 지킨다.
  if (tkRoom && !out.includes(tkRoom)) out.push(tkRoom);
  return out.slice(0, 3);
}

/// 방을 열었다 → 지켜보는 명단 맨 앞에 둔다.
function 방지켜보기(room: string) {
  const id = String(room || "");
  if (!id) return; // 기본 방은 늘 지키므로 적을 것이 없다
  try {
    const v = JSON.parse(localStorage.getItem(대화보는방_KEY) || "[]");
    const list = (Array.isArray(v) ? v.map((r: any) => String(r || "")) : []).filter(
      (r) => r && r !== id,
    );
    list.unshift(id);
    localStorage.setItem(대화보는방_KEY, JSON.stringify(list.slice(0, 2)));
  } catch {
    // 못 적어도 이번 판은 `지켜보는방()` 의 `tkRoom` 가지가 잡아 준다.
  }
}

/// 겹쳐 돌지 않게. 릴레이가 느린 날 한 바퀴가 45초를 넘으면 같은 것을
/// 두 번 묻게 되고, 그러면 접속만 두 배가 된다.
let 대화지킴이도는중 = false;

/**
 * 이야기 화면을 안 보고 있어도 도는 지킴이.
 *
 * ⚠️ 이야기 화면에는 「자동 새로고침」이 없다. 그래서 이것이 유일한 눈이다 —
 *    화면을 열면 `talkPaint` 가 같은 곳(`대화살피기`)으로 결과를 보낸다.
 *
 * 45초다. 주문(30초)보다 느리게 둔다 — 말은 30초 늦게 알아도 아무 일도
 * 안 일어나고, 릴레이는 남의 서버라 덜 두드릴수록 좋다.
 */
async function 대화지킴이() {
  if (!대화알림켜짐()) return; // 꺼 두셨으면 묻지도 않는다
  if (대화지킴이도는중) return;
  대화지킴이도는중 = true;
  try {
    // 🔴 내가 누구인지부터. 이야기 화면을 한 번도 안 열었으면 `tkMine` 이
    //    비어 있고, 그 상태로는 **내 글에 내가 알림을 받는다.**
    if (!tkMine) {
      try {
        tkMine = String((await invoke<any>("talk_me"))?.pubkey || "");
      } catch {
        // 열쇠를 못 읽으면 이번 바퀴는 넘긴다. `대화살피기` 가 또 막는다.
      }
    }
    for (const 방 of 지켜보는방()) {
      try {
        // 30개면 45초 사이에 온 글을 놓칠 일이 없다. 화면(60개)보다 적게
        // 받는 것은 이건 읽으려는 것이 아니라 **세려는 것**이기 때문이다.
        const list: any[] = await invoke("talk_read", { room: 방 || null, limit: 30 });
        대화살피기(방, list);
      } catch {
        // 릴레이 한 곳이 죽어도 다음 방은 본다. 조용히 다음 바퀴에 다시 본다.
      }
    }
  } finally {
    대화지킴이도는중 = false;
  }
}

/// 대화 알림 스위치·소리 시험을 잇고, 지킴이 시계를 켠다.
function 대화알림배선() {
  const sw = document.getElementById("tk-snd-on") as HTMLInputElement | null;
  if (sw) {
    sw.checked = 대화알림켜짐();
    sw.addEventListener("change", () => {
      try {
        localStorage.setItem(대화소리_KEY, sw.checked ? "1" : "0");
      } catch {}
      const say = document.getElementById("tk-snd-say");
      if (say)
        say.textContent = sw.checked
          ? "이제 이야기에 새 글이 오면 소리로 알려 드립니다."
          : "대화 소리를 껐습니다. 주문 소리는 그대로입니다.";
      // 껐으면 지금 떠 있는 숫자도 같이 내린다. 꺼 놓고 숫자가 남아 있으면
      // 꺼진 것인지 아닌지 알 수 없다.
      if (!sw.checked) 대화봤다();
      // 🔴 다시 켤 때는 **처음부터 시작한다.** 꺼 둔 동안 지킴이가 안 돌아서
      //    기억이 그때 그대로다. 그냥 켜면 그 사이에 쌓인 글이 통째로 「새
      //    글」이 되어 켜자마자 「톡」 하고 숫자 40 이 뜬다 — 스위치를 켠 것은
      //    새 글이 아니다. 앱을 켤 때 첫 바퀴가 조용한 것과 같은 이유다.
      if (sw.checked) {
        아는글.clear();
        첫바퀴읽은방.clear();
        대화봤다();
      }
    });
  }
  // 🔴 「소리 들어보기」가 여기에도 있어야 한다. **주문 소리와 나란히 들어
  //    봐야** 두 소리가 다른 줄 안다 — 그게 이 단추의 진짜 쓸모다.
  document.getElementById("tk-snd-test")?.addEventListener("click", () => {
    말소리();
    const say = document.getElementById("tk-snd-say");
    if (say)
      say.textContent =
        "낮은 「톡」 소리입니다. 위 「새 주문 소리」와 번갈아 눌러 보세요 — 달라야 맞습니다.";
  });

  // 첫 바퀴가 「이미 아는 글」을 조용히 적는 자리다. 6초 미루는 것은
  // 주문 지킴이(3초)와 겹치지 않게 하기 위해서다 — 켜자마자 릴레이와 노드를
  // 동시에 두드리면 느린 컴퓨터에서 첫 화면이 멈춘 것처럼 보인다.
  setTimeout(() => void 대화지킴이(), 6000);
  setInterval(() => void 대화지킴이(), 45000);
}

// ── 주문 ──
async function loadOrders() {
  // 주문마다 주소가 다르므로 가게 주소 하나로는 못 찾는다. 빈 주소를 넘기면
  // 주문 라벨이 붙은 입금만 골라 온다 — 4년 전 채굴 기록이 오늘 주문 자리에
  // 앉는 일도 이걸로 막힌다.
  try {
    // 🔴 **받은 돈을 장부에 적는 일을 여기서도 한다.**
    //
    //    여태 장부에 줄을 쓰는 길은 「손님 폰이 물어볼 때」 하나뿐이었고,
    //    그 판단에 쓰는 표는 **메모리에만** 있었다. 앱을 껐다 켜면 표가 비고,
    //    체인에 돈이 들어와 있어도 장부에 닿지 못했다 — 손님은 이미 가서
    //    다시 물어보지 않는다. 그래서 대표님 화면에서 「결제됨」인 주문이
    //    「매출 0 · 입금 안 됨 1건」으로 동시에 보였다.
    //
    //    ⚠️ 실패해도 주문 목록은 그려야 한다. 정산이 안 됐다고 화면이
    //       비면 사장은 주문이 사라진 줄 안다.
    await invoke<any>("ledger_sweep", { minConf: 1 }).catch(() => null);

    const res = await invoke<any>("incoming_payments", { address: "", minConf: 1 });
    const list: any[] = res.payments || [];
    // 🔴 목록을 손에 쥔 김에 **여기서도 살핀다.** 주문표를 열어 두고 「자동
    //    확인」을 켜 놓은 사장에게는 이쪽이 30초마다 도는 시계다. 지킴이는
    //    그때 쉬므로, 이 한 줄이 없으면 그 사장만 알림을 못 받는다.
    주문살피기(list);
    // 상태를 같이 읽어 온다. 주문이 어디까지 왔는지가 카운터의 전부다.
    const st = await invoke<any>("order_states").catch(() => ({ orders: [] }));
    const byAddr = new Map<string, any>((st.orders || []).map((o: any) => [o.address, o]));

    $("or-list").innerHTML = list.length
      ? list
          .map((p) => {
            const o = byAddr.get(p.address) || { state: "paid" };
            const next = { paid: "making", making: "ready", ready: "done" }[o.state as string];
            const label = { paid: "만들기 시작", making: "나왔다고 알리기", ready: "전달 완료" }[
              o.state as string
            ];
            const shown = { paid: "결제됨", making: "만드는 중", ready: "나옴", done: "전달됨" }[
              o.state as string
            ];
            return `<tr>
              <td>${o.ticket ? `<b>${o.ticket}</b> · ` : ""}${p.time ? ago(p.time) : "—"}</td>
              <td><code class="addr">${(p.address || "").slice(0, 8)}…</code></td>
              <td class="num">${p.amount}${p.asset_name ? " " + p.asset_name : ""}</td>
              <td class="num">${
                p.settled
                  ? shown
                  : `<span style="color:var(--warn)">${p.confirmations} 대기</span>`
              }</td>
              <td class="act">${
                (p.settled || p.accept_now) && next
                  ? `<button data-state="${p.address}" data-to="${next}">${label}</button>`
                  : ""
              }${
                p.settled || p.accept_now
                  ? `<button class="ghost" data-refund="${p.address}" data-amt="${p.amount}">환불</button>`
                  : ""
              }</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5">${emptyWithRaven("조용하네요.<br />손님이 폰으로 주문하면 여기 바로 뜹니다.", "sleep")}</td></tr>`;
    $("or-note").textContent = `${list.length}건`;

    $("or-list")
      .querySelectorAll("[data-refund]")
      .forEach((b) => {
        (b as HTMLElement).onclick = () =>
          doRefund((b as HTMLElement).dataset.refund!, parseFloat((b as HTMLElement).dataset.amt!));
      });
    $("or-list")
      .querySelectorAll("[data-state]")
      .forEach((b) => {
        (b as HTMLElement).onclick = async () => {
          const el = b as HTMLElement;
          // 🔴 **카운터에서 제일 자주 누르는 단추인데 누른 티가 없었다**
          //    (자문 지적 2026-08-30). 눌리면 흐려지기만 하고, 그다음에
          //    표 전체가 통째로 다시 그려진다 — 그 사이가 「눌렸나?」다.
          //    줄 선 손님 앞에서 그 반 박자가 한 번 더 누르게 만든다.
          const 원래 = el.textContent || "";
          el.setAttribute("disabled", "true");
          el.textContent = t("보내는 중…");
          try {
            // "나왔다"를 누르는 순간 손님 폰이 울린다. 그래서 이 버튼은
            // 실수로 눌리면 안 되는 자리에 있어야 하고, 되돌릴 수 있어야 한다.
            await invoke("set_order_state", { address: el.dataset.state, newState: el.dataset.to });
            loadOrders();
          } catch (e) {
            $("or-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
            // 🔴 글자를 되돌린다. 「보내는 중…」인 채로 굳어 있으면
            //    사장은 아직 도는 줄 알고 하염없이 기다린다.
            el.textContent = 원래;
            el.removeAttribute("disabled");
          }
        };
      });
  } catch (e) {
    $("or-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
  }
}

// ── 가게 찾기 ──
window.addEventListener("DOMContentLoaded", async () => {
  loadHealth();
  let nameTimer: any;
  $("i-name").addEventListener("input", () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(checkIssueName, 350);
  });
  // 이름을 그대로 다시 치는 것이 확인이다. "이해했습니다" 체크는 그냥 눌린다.
  $("i-confirm").addEventListener("input", wizGate);
  $("i-upload").addEventListener("click", pickIssueFile);
  document.querySelectorAll("nav a").forEach((a) => {
    (a as HTMLElement).onclick = () => showPage((a as HTMLElement).dataset.page!);
  });
  $("w-newaddr").addEventListener("click", makeAddress);
  $("ask-yes").addEventListener("click", () =>
    askClose(($("ask-input") as HTMLInputElement).value)
  );
  $("ask-no").addEventListener("click", () => askClose(null));
  $("ask-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") askClose(($("ask-input") as HTMLInputElement).value);
  });
  document.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && askResolve) askClose(null);
  });
  $("nd-name").addEventListener("change", saveNode);
  $("rs-pick").addEventListener("click", doRestore);
  $("sp-fill").addEventListener("click", () => sampleFill(false));
  $("sp-clear").addEventListener("click", sampleClear);
  $("rs-card").addEventListener("click", showCard);
  $("rs-lost").addEventListener("click", phoneLost);
  $("w-refresh").addEventListener("click", () => { loadWallet(); checkForeign(); });
  $("w-send-asset").addEventListener("click", () => openSend("asset"));
  $("w-send-rvn").addEventListener("click", () => openSend("rvn"));
  $("s-cancel").addEventListener("click", closeSend);
  ["s-addr", "s-qty"].forEach((id) => $(id).addEventListener("input", composeChanged));
  $("s-review").addEventListener("click", reviewSend);
  $("s-back").addEventListener("click", () => {
    $("send-review").style.display = "none";
    $("send-compose").style.display = "";
  });
  ["s-tail", "s-pass"].forEach((id) => $(id).addEventListener("input", gateSend));
  $("s-go").addEventListener("click", doSend);

  document.querySelectorAll("[data-shoptab]").forEach((b) => {
    (b as HTMLElement).onclick = () => shopTab((b as HTMLElement).dataset.shoptab!);
  });
  document.querySelectorAll("[data-goto]").forEach((b) => {
    (b as HTMLElement).onclick = () => showPage((b as HTMLElement).dataset.goto!);
  });
  // 매출 · 장부
  document.querySelectorAll("#sl-range [data-days]").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      document
        .querySelectorAll("#sl-range [data-days]")
        .forEach((x) => x.classList.toggle("on", x === b));
      setSalesRange(Number((b as HTMLElement).dataset.days || 0));
      loadSales();
    };
  });
  // 날짜를 직접 고르면 기간 단추의 선택 표시를 지운다. 「오늘」이 눌린 채로
  // 지난달을 보고 있으면 화면이 거짓말을 하는 것이다.
  ["sl-from", "sl-to"].forEach((id) =>
    $(id).addEventListener("change", () => {
      document.querySelectorAll("#sl-range [data-days]").forEach((x) => x.classList.remove("on"));
      loadSales();
    }),
  );
  // 영업시간 — 고치면 즉시 결과를 말해 준다.
  $("sh-hours-all").addEventListener("click", () => {
    const o = ($("hr-o-1") as HTMLInputElement)?.value || "";
    const c = ($("hr-c-1") as HTMLInputElement)?.value || "";
    // 🔴 월요일이 반쪽이면 복사해 봐야 나머지도 반쪽이 된다. 그러면 이레가
    //    전부 저장 안 되는 상태가 되고, 사장은 눌렀는데 왜 안 됐는지 모른다.
    if (!o || !c) {
      say(t("월요일부터 채워 주세요"),
          t("여는 시각과 닫는 시각을 둘 다 넣으셔야 나머지 요일에 옮길 수 있습니다."));
      return;
    }
    for (const [d] of WEEK) {
      if (d === 1) continue;
      const oi = $(`hr-o-${d}`) as HTMLInputElement;
      const ci = $(`hr-c-${d}`) as HTMLInputElement;
      if (oi) oi.value = o;
      if (ci) ci.value = c;
    }
    paintHours();
    previewOpen();
  });
  // 시간 칸은 나중에 그려지므로 부모에서 받는다.
  $("sh-hours").addEventListener("change", paintHours);
  $("sh-hours").addEventListener("input", paintHours);
  ["sh-closednow", "sh-closednote", "sh-hours"].forEach((id) =>
    $(id).addEventListener("change", previewOpen),
  );

  // 문 (셸리)
  $("dr-doors").addEventListener("click", () => {
    doorsShown = !doorsShown;
    $("dr-doorpanel").style.display = doorsShown ? "" : "none";
    if (doorsShown) loadDoors();
  });
  $("dw-save").addEventListener("click", saveDoor);
  $("dw-probe").addEventListener("click", async () => {
    // 저장하기 전에 닿는지만 본다. 비밀번호를 틀린 채 저장해 두면
    // 회원이 문 앞에 섰을 때야 알게 된다.
    $("dw-note").textContent = "확인 중…";
    try {
      await invoke("door_save", {
        id: "__probe__",
        name: "확인용",
        ip: ($("dw-ip") as HTMLInputElement).value,
        gen: Number(($("dw-gen") as HTMLSelectElement).value) || 2,
        channel: Number(($("dw-ch") as HTMLInputElement).value) || 0,
        seconds: Number(($("dw-sec") as HTMLInputElement).value) || 5,
        user: ($("dw-user") as HTMLInputElement).value,
        password: ($("dw-pass") as HTMLInputElement).value,
      });
      const v: any = await invoke("door_probe", { id: "__probe__", cnonce: newCnonce() });
      $("dw-note").innerHTML = `<span class="ok">닿았습니다 — ${escapeHtml(JSON.stringify(v))}</span> (문은 열지 않았습니다)`;
    } catch (e) {
      $("dw-note").innerHTML = `<span class="danger">${e}</span>`;
    } finally {
      // 확인용 항목은 목록에 남기지 않는다.
      await invoke("door_remove", { id: "__probe__" }).catch(() => {});
      loadDoors();
    }
  });

  $("sl-csv").addEventListener("click", exportSales);

  $("door-back").addEventListener("click", () => showPage("shop"));
  $("msg-back").addEventListener("click", () => showPage("shop"));

  // 🔴 「지금 터널 주소 넣기」 단추는 없앴다. 임시 주소를 체인에 영구히
  //    적어 넣는 일이었고, 지금은 문을 열 때 릴레이에 자동으로 알린다.
  //    자세한 이유는 index.html 의 그 자리 주석에 적어 뒀다.
  $("sh-pic").addEventListener("click", pickShopPhoto);
  $("sh-pics").addEventListener("click", pickShopPhotos);
  $("dr-q").addEventListener("input", () => {
    clearTimeout(doorTimer);
    doorTimer = setTimeout(doorSearch, 200);
  });
  $("dr-new").addEventListener("click", () => openMember());
  $("dr-passes").addEventListener("click", () => void showPasses());
  $("dr-books").addEventListener("click", () => void showBookings());
  $("sh-refresh").addEventListener("click", async () => {
    const say = $("sh-refreshsay");
    say.textContent = t("알리는 중…");
    try {
      const r = await invoke<any>("shop_refresh");
      const n = (r?.ok || []).length;
      // 몇 곳이 받았는지 적는다. 「알렸습니다」만 뜨면 한 곳도 안 받았을 때와
      // 구별이 안 된다 — 릴레이는 늘 하나씩 죽는다.
      say.innerHTML = `<span class="ok">${t("알렸습니다")} — ${t("릴레이")} ${n}${t("곳")}</span>`;
    } catch (e) {
      say.innerHTML = `<span class="danger">${escapeHtml(errText(e))}</span>`;
    }
  });
  document.querySelectorAll("[data-mtab]").forEach((b) => {
    (b as HTMLElement).onclick = () => mtab((b as HTMLElement).dataset.mtab!);
  });
  $("nt-go").addEventListener("click", sendNotice);
  $("in-load").addEventListener("click", loadInbox);
  $("ps-go").addEventListener("click", sendDirect);
  loadChannels();
  $("dr-all").addEventListener("click", () => {
    $("dr-list").innerHTML = "<p class=\"muted\">불러오는 중…</p>";
    loadMembers();
  });
  $("ms-cancel").addEventListener("click", () => $("msheet").classList.add("hidden"));
  $("ms-kind").addEventListener("change", msKindChanged);
  $("ms-num").addEventListener("change", msNumChanged);
  $("ms-start").addEventListener("change", recalcPeriod);
  $("ms-months").addEventListener("change", recalcPeriod);
  $("ms-save").addEventListener("click", saveMember);
  $("key-save").addEventListener("click", saveKeys);
  $("ord-reset").addEventListener("click", resetOrder);
  loadOrder();
  $("ai-shop-go").addEventListener("click", aiFillShop);
  $("ai-issue-go").addEventListener("click", () => void aiPickIssue());
  wireRehearse();
  // 엔터로도 된다. 단추를 찾아 누르는 것보다 그 자리에서 치는 편이 빠르다.
  $("ai-issue").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void aiPickIssue();
  });
  $("ai-menu-go").addEventListener("click", aiFillMenu);
  refreshSwitchState();
  // 이벤트 객체가 목적지 인자로 넘어가지 않게 감싼다. 안 감쌌으면
  // destFolder 에 MouseEvent 가 들어갔을 것이다 — 타입 검사가 잡았다.
  $("bk-go").addEventListener("click", () => void doBackup());
  $("bk-seed").addEventListener("click", showSeed);
  $("sd-close").addEventListener("click", () => {
    // 화면에 남겨 두지 않는다. 자리를 비운 사이 누가 볼 수 있다.
    $("sd-words").innerHTML = "";
    $("seedsheet").classList.add("hidden");
  });
  void paintStatusDots();
  // 🔴 켤 때마다 본다.
  //
  //    여태 「나중에」를 한 번 누르면 **20시간 동안 확인 자체를 안 했다.**
  //    다시 켜도 안 봤다. 그래서 새 판이 나가도 화면에 아무 말이 없었고,
  //    대표님 맥이 여러 판 뒤처진 채로 남았다.
  //
  //    「나중에」가 막아야 하는 것은 **재시작**이지 **알림**이 아니다.
  //    설치는 여전히 사장이 누를 때만 한다 — 장사 중에 저절로 다시
  //    시작되면 손님 QR 이 먹통이 된다.
  setTimeout(() => void checkForUpdate(true), 8000);
  // 노드는 조용히 죽는다. 20초마다 다시 본다 — 죽은 걸 늦게 아는 것이
  // 카운터에서 제일 비싸다.
  setInterval(() => void quietly(paintStatusDots), 20_000);
  loadBackup();
  $("abk-new").addEventListener("click", () => void newAddrWithName());
  $("up-check").addEventListener("click", () => {
    // 직접 누른 것이니 결과를 말한다. 배경 확인은 조용히 넘어간다.
    $("up-box").style.display = "";
    $("up-box").innerHTML = `<div class="meta" id="up-note">확인 중…</div>`;
    void checkForUpdate(false);
  });
  $("rw-req").addEventListener("click", async () => {
    try {
      await invoke("reward_request", {
        asset: ($("rw-asset") as HTMLInputElement).value.trim(),
        height: Number(($("rw-height") as HTMLInputElement).value),
      });
      await loadRewardList();
      $("rw-now").textContent = "예약했습니다. 그 블록이 지나면 명단이 굳습니다.";
    } catch (e) {
      $("rw-now").innerHTML = `<span class="warn">${escapeHtml(errText(e))}</span>`;
    }
  });
  $("rw-mine").addEventListener("click", async () => {
    try {
      const b = await invoke<any>("addr_book");
      // 잔액이 있는 내 주소들. 배당을 나에게도 보내면 그만큼 헛돈다.
      const mine = (b.rows || [])
        .filter((x: any) => (x.balance || 0) > 0 || x.label)
        .map((x: any) => x.address)
        .slice(0, 20);
      ($("rw-skip") as HTMLInputElement).value = mine.join(", ");
    } catch (e) {
      $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(errText(e))}</div>`;
    }
  });
  $("rw-dry").addEventListener("click", () => void rewardDry());
  $("rw-go").addEventListener("click", () => void rewardGo());
  $("abk").addEventListener("toggle", () => {
    if (($("abk") as HTMLDetailsElement).open) void loadAddrBook();
  });
  $("sw-save").addEventListener("click", () => saveSweep(true));
  $("sw-off").addEventListener("click", () => saveSweep(false));
  loadSweep();
  loadPlaces();
  $("cf-save").addEventListener("click", saveConf);
  $("cf-reload").addEventListener("click", loadConf);
  loadConf();
  loadMining();
  $("mn-gpu").addEventListener("change", () => { calcMining(); showPowerCurve(); });
  $("mn-kwh").addEventListener("input", calcMining);
  ["mn-mh", "mn-watts"].forEach((id) => $(id).addEventListener("input", () => { calcMining(); showPowerCurve(); }));
  $("mn-power").addEventListener("input", () => { showPowerCurve(); calcMining(); renderMinerSetup(); });
  $("mn-run").addEventListener("click", startMiner);
  $("mn-halt").addEventListener("click", stopMiner);
  showMiners();
  refreshMiner();
  $("mn-addr").addEventListener("click", makeMiningAddress);
  ["mn-pool", "mn-worker"].forEach((id) => $(id).addEventListener("input", renderMinerSetup));
  $("mn-income").addEventListener("click", loadMiningIncome);
  loadIpfsConf();
  checkHealth();
  setInterval(() => void quietly(checkHealth), 30000);
  /* ── 말 고르는 자리 ────────────────────────────────────────────
     🔴 여태 이 프로그램은 **한국어뿐**이었다. 손님 화면은 네 나라 말인데
     사장 화면만 한국어라, 한국어를 못 읽는 사장은 아예 못 쓴다.

     자동 판정은 그대로 둔다(처음 켠 사람에게 말부터 고르라고 묻지 않는다).
     바꿀 길만 더한다 — 「문제 알리기」 바로 위, 늘 보이는 자리다. */
  (() => {
    const sel = document.createElement("select");
    sel.className = "langsw";
    sel.setAttribute("aria-label", "Language");
    (Object.keys(LANG_NAMES) as (keyof typeof LANG_NAMES)[]).forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = LANG_NAMES[k];
      if (k === lang) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => setLang(sel.value as typeof lang);
    const foot = document.querySelector(".navfoot");
    foot?.parentNode?.insertBefore(sel, foot);
  })();

  $("fee-send").addEventListener("click", () => void sendOwed());
  void paintFeePick();
  $("d-node-row").addEventListener("click", () => toggleDot("node"));
  $("d-mine-row").addEventListener("click", () => toggleDot("mine"));
  $("d-relay-row").addEventListener("click", () => toggleDot("relay"));
  $("d-out-row").addEventListener("click", () => toggleDot("out"));

  async function paintWalletDir() {
    const pathEl = document.getElementById("wd-path");
    const noteEl = document.getElementById("wd-note");
    if (!pathEl || !noteEl) return;
    try {
      const s = await invoke<any>("datadir_status");
      pathEl.textContent = s.path || "—";
      noteEl.textContent = s.note || "";
      noteEl.style.color = s.has_wallet ? "" : "var(--warn)";
    } catch (e) {
      noteEl.textContent = errText(e);
    }
  }
  document.getElementById("wd-pick")?.addEventListener("click", async () => {
    const noteEl = document.getElementById("wd-note");
    try {
      const dir = await pickFile({
        directory: true,
        title: t("레이븐 코어가 쓰는 폴더"),
      });
      if (!dir) return;
      await invoke("datadir_set", { path: dir });
      await paintWalletDir();
    } catch (e) {
      if (noteEl) noteEl.textContent = errText(e);
    }
  });
  void paintWalletDir();

  // 「이 컴퓨터」에서 언제든 바꾼다.
  for (const [id, pick] of [["mode-help", "help"], ["mode-shop", "shop"]] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("click", async () => {
      const say = document.getElementById("mode-say");
      try {
        await invoke("mode_set", { mode: pick });
        await applyMode();
        if (say) say.textContent = pick === "help"
          ? "돕기로 바꿨습니다. 가게 정보는 그대로 있습니다."
          : "장사로 바꿨습니다.";
      } catch (e) {
        if (say) say.textContent = errText(e);
      }
    });
  }

  // 첫 실행 갈림길. 고르면 그 자리에서 화면이 바뀐다.
  for (const [id, pick] of [["hello-help", "help"], ["hello-shop", "shop"]] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("click", async () => {
      const say = document.getElementById("hello-say");
      try {
        await invoke("mode_set", { mode: pick });
        await applyMode();
      } catch (e) {
        if (say) say.textContent = errText(e);
      }
    });
  }
  // 화면 안의 탭. 표시등을 안 거치고도 넷을 오갈 수 있어야 한다.
  document.querySelectorAll("[data-part]").forEach((b) => {
    (b as HTMLElement).onclick = () => toggleDot((b as HTMLElement).dataset.part as Part);
  });
  // 「설정 열기」. 상태만 보여 주고 끝내면 고칠 데를 못 찾는다.
  document.addEventListener("click", (e) => {
    const pg = (e.target as HTMLElement).closest?.("[data-part-go]") as HTMLElement | null;
    if (pg) {
      toggleDot(pg.dataset.partGo as Part);
      return;
    }
    const b = (e.target as HTMLElement).closest?.("[data-gopage]") as HTMLElement | null;
    if (b) showPage(b.dataset.gopage!);
  });
  $("d-ipfs-row").addEventListener("click", () => toggleDot("ipfs"));
  $("sh-open-btn").addEventListener("click", () => setOpenState(false));
  $("sh-close-btn").addEventListener("click", () => setOpenState(true));
  // 라비가 말로 닫거나, 저장한 값을 되읽을 때도 두 칸이 따라가야 한다.
  $("sh-closednow").addEventListener("change", paintOpenPick);
  paintOpenPick();
  $("qr-close").addEventListener("click", () => { $("qrwrap").style.display = "none"; });
  // 내 가게 화면에서 바로. 「이 컴퓨터」까지 들어가게 하지 않는다.
  $("sh-qrtab").addEventListener("click", () => void openQrSheet());
  $("qrwrap").addEventListener("click", (e) => {
    if (e.target === $("qrwrap")) $("qrwrap").style.display = "none";
  });
  $("rp-open").addEventListener("click", () => openReport());
  $("rp-cancel").addEventListener("click", () => { $("rpwrap").style.display = "none"; });
  $("rp-send").addEventListener("click", sendReport);
  // 지난번에 못 보낸 것을 조용히 다시 보낸다. 한 번 보내고 마는
  // 신고는 안 하느니만 못하다 — 사장은 보냈다고 여긴다.
  void invoke("report_flush").then(() => rpLabel()).catch(() => rpLabel());
  $("chat-open").addEventListener("click", () => {
    showPage("ravi");
    ($("chat-q") as HTMLInputElement)?.focus();
  });
  $("chat-go").addEventListener("click", chatSend);
  $("chat-mode")
    .querySelectorAll<HTMLElement>("[data-mode]")
    .forEach((b) => {
      b.onclick = () => setChatMode(b.dataset.mode as "fill" | "ask" | "debate");
    });
  $("chat-q").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") chatSend();
  });
  $("ai-pick").addEventListener("change", () => {
    aiProvider = ($("ai-pick") as HTMLSelectElement).value || null;
  });
  $("mn-cur").addEventListener("change", showRate);
  refreshKeys();
  showRate();
  let shopTimer: any;
  $("sh-asset").addEventListener("input", () => {
    clearTimeout(shopTimer);
    shopTimer = setTimeout(checkShopName, 350);
  });
  ["sh-ko", "sh-en", "sh-confirm"].forEach((id) => $(id).addEventListener("input", gateShop));
  ["sh-ko", "sh-en"].forEach((id) => $(id).addEventListener("input", labelShopNav));
  $("sh-mkaddr").addEventListener("click", makeShopAddress);
  $("sh-coords").addEventListener("input", readCoords);
  // 좌표가 없을 때 조용히 끝내면 버튼이 고장난 것처럼 보인다. 실제로 그랬다.
  // 좌표가 없으면 좌표를 *찾으러* 보내는 것이 이 버튼이 할 일이다 — 사장은
  // 자기 가게 좌표를 외우고 있지 않고, 어디서 복사하는지도 모른다.
  $("sh-checkmap").addEventListener("click", () => {
    const u = (window as any).__checkUrl;
    const open = (url: string, fallbackNote: string) =>
      invoke("open_share", { url }).catch(() => {
        navigator.clipboard.writeText(url);
        say("주소를 복사했습니다", fallbackNote + "\n\n" + url);
      });

    if (u) {
      // OSM 은 계정도 키도 없이 좌표를 보여준다. 확인용으로 충분하다.
      open(u, "주소를 복사했습니다. 브라우저에 붙여넣어 확인하세요.");
      return;
    }

    const addr = ($("sh-loc") as HTMLInputElement).value.trim();
    if (addr) {
      $("sh-coordnote").innerHTML =
        `지도가 열렸습니다. <b>가게를 찾아 길게 누르면</b> 좌표가 나옵니다. ` +
        `복사해서 위 칸에 붙여넣으세요.`;
      open(
        `https://www.openstreetmap.org/search?query=${encodeURIComponent(addr)}`,
        "지도 주소를 복사했습니다. 브라우저에 붙여넣으세요."
      );
      return;
    }

    $("sh-coordnote").innerHTML =
      `<span class="danger">먼저 좌표를 붙여넣거나 위에 주소를 적어 주세요.</span> ` +
      `구글·애플·네이버 지도에서 가게를 <b>길게 누르면</b> 좌표가 나옵니다.`;
    ($("sh-coords") as HTMLInputElement).focus();
  });
  $("sh-go").addEventListener("click", registerShop);
  $("mn-preview").addEventListener("click", previewCustomer);
  // 🔴 바로 빈 줄을 만들지 않는다. 무엇을 파는지 먼저 묻는다 — 그래야 그
  //    줄에 필요한 칸만 나오고, 커피 줄에 「며칠」 칸이 안 생긴다.
  $("mn-add").addEventListener("click", () => {
    $("mn-kindwrap").style.display = "";
    $("mn-kindwrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("mn-kindno").addEventListener("click", () => {
    $("mn-kindwrap").style.display = "none";
  });
  document.querySelectorAll("[data-kind]").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const kind = (b as HTMLElement).dataset.kind!;
      const row: any = { name: "", price: null, image: null, kind };
      // 예약도 기본값을 안 깔아 둔다. 이유는 기간권과 같다 — 안 고른 채
      // 넘어가면 15분짜리 커트가 두 시간을 잡거나 그 반대가 된다.
      // 🔴 기간을 **미리 채우지 않는다.** 하루로 깔아 두면, 이름만
      //    「한달권」으로 바꾸고 단추를 안 누른 사장이 **한 달 값을 받고
      //    하루짜리 표**를 내주게 된다. 손님이 다음 날 문 앞에서 알게 되고,
      //    그건 그 자리에서 싸움이다.
      //
      //    대신 안 고르면 아래 `saveMenu` 가 올리기를 막는다. 기간 없는
      //    이용권은 덜 채운 것이 아니라 **고장난 상품**이다.
      menuItems.push(row);
      $("mn-kindwrap").style.display = "none";
      renderMenu();
      // 방금 만든 줄의 이름 칸에 커서를 둔다. 다음에 할 일이 손가락 밑에 있다.
      const last = document.querySelector(
        `[data-mn="name"][data-i="${menuItems.length - 1}"]`
      ) as HTMLInputElement | null;
      last?.focus();
    };
  });
  $("mn-save").addEventListener("click", saveMenu);
  $("or-refresh").addEventListener("click", loadOrders);
  $("or-auto").addEventListener("change", () => {
    const on = ($("or-auto") as HTMLInputElement).checked;
    clearInterval(orderTimer);
    // Only while the shop is watching. A wallet that polls the chain forever in
    // the background is a wallet that keeps a slow computer busy for nothing.
    if (on) orderTimer = setInterval(() => void quietly(loadOrders), 30000);
  });
  // 🔴 돈이 들어오면 소리로 부른다. 이 한 줄이 없으면 사장은 주문표를
  //    붙들고 있어야 한다 — 위 「자동 확인」은 화면을 다시 그릴 뿐이다.
  알림배선();
  // 🔴 대화 알림도 여기서 켠다. 만들어 놓고 이 한 줄을 안 쓰면 이 저장소가
  //    여러 번 걸린 그 병 — 「러스트·화면은 다 됐는데 아무도 안 부른다」다.
  대화알림배선();
  // 주문하기 화면은 손님 폰으로 옮겼다.
  $("refresh").addEventListener("click", () => loadAssets(false));
  $("scan").addEventListener("click", startScan);
  $("pin-all").addEventListener("click", pinAll);
  document.querySelectorAll<HTMLElement>("[data-afilter]").forEach((b) => {
    b.onclick = () => {
      assetFilter = b.dataset.afilter as any;
      renderList();
    };
  });
  $("sh-sample").addEventListener("click", fillSample);
  $("w-enc").addEventListener("click", openEncrypt);
  $("enc-cancel").addEventListener("click", () => ($("encbox").style.display = "none"));
  ["enc-old", "enc-new", "enc-new2", "enc-confirm"].forEach((id) =>
    $(id).addEventListener("input", gateEnc)
  );
  $("enc-go").addEventListener("click", doEncrypt);
  $("w-lock-now").addEventListener("click", async () => {
    await invoke("lock_wallet").catch(() => {});
    loadWallet();
  });
  $("new-asset").addEventListener("click", openWizard);
  // 이야기. 🔴 러스트만 만들고 이 다섯 줄을 안 쓰면 오늘 하루 종일 고친
  //    그 병이 그대로 반복된다.
  $("tk-send").addEventListener("click", () => void talkSend());
  $("tk-reload").addEventListener("click", () => void talkPaint());
  $("tk-newroom").addEventListener("click", () => void talkNewRoom());
  $("tk-nmake").addEventListener("click", () => void talkMakeRoomGo());
  $("tk-ncancel").addEventListener("click", () => {
    $("tk-newbox").hidden = true;
  });
  // 🔴 **엔터로 끝난다.** 텔레그램처럼 쉬우려면 손이 마우스로 안 가야 한다.
  //    이름 칸에서 엔터 → 만들기. 설명 칸에서도 같다.
  for (const id of ["tk-nname", "tk-nabout"]) {
    $(id).addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        void talkMakeRoomGo();
      }
      if ((e as KeyboardEvent).key === "Escape") $("tk-newbox").hidden = true;
    });
  }
  $("tk-name").addEventListener("click", () => void talkSetName());
  // ── 접기·펴기 ────────────────────────────────────────────────────
  // 🔴 단추 다섯을 하나로 접었다. 접은 것은 **없앤 것이 아니다** — 여는
  //    법이 「더 보기」라고 글자로 적혀 있고, 안에 든 것도 다 글자다.
  $("tk-more").addEventListener("click", () => {
    const b = $("tk-morebox");
    b.hidden = !b.hidden;
    $("tk-more").setAttribute("aria-expanded", b.hidden ? "false" : "true");
  });
  $("tk-firstok").addEventListener("click", () => {
    $("tk-first").hidden = true;
    // 눌러서 닫은 것은 「읽었다」는 뜻이다. 세 번을 다 채운 것으로 본다.
    try {
      localStorage.setItem(TK_본횟수_KEY, String(TK_처음몇번));
    } catch {
      /* 저장 못 해도 이번 판은 닫힌다 */
    }
  });
  // 자동 번역 스위치. 켜면 그 자리에서 이미 그려진 글까지 옮긴다 —
  // 「켰는데 아무 일도 안 일어난다」가 제일 나쁘다.
  {
    const sw = $("tk-auto") as HTMLInputElement;
    sw.checked = tk자동옮김();
    sw.addEventListener("change", () => {
      try {
        localStorage.setItem(TK_자동옮김_KEY, sw.checked ? "1" : "0");
      } catch {
        /* 저장 못 해도 이번 판은 바뀐다 */
      }
      if (sw.checked) void tk옮길것찾기();
    });
  }
  // 사진. 🔴 러스트(`talk_photo_post`)는 진작 다 돼 있었고 **부르는 이 줄이
  //    없어서** 사진을 못 보냈다. 만들어 놓고 안 부르는 그 병이다.
  $("tk-photo").addEventListener("click", () => talkPickPhoto());
  $("tk-photocancel").addEventListener("click", () => tkClearPhoto());
  // 「이 컴퓨터를 끄면 상대가 사진을 못 볼 수 있습니다」는 읽고 닫는 말이다.
  $("tk-saidclose").addEventListener("click", () => {
    $("tk-said").hidden = true;
  });
  // 쪽지. 단추를 누르면 **먼저 무엇이 다른지 읽게** 하고, 그다음에 연다.
  $("tk-dm").addEventListener("click", () => {
    const b = $("tk-dmbox");
    b.hidden = !b.hidden;
    if (!b.hidden) $("tk-dmsay").textContent = "";
  });
  $("tk-dmclose").addEventListener("click", () => {
    $("tk-dmbox").hidden = true;
  });
  $("tk-dmgo").addEventListener("click", () => void talkOpenDm());
  // 안 보기. 🔴 러스트만 있고 여기가 비면 단추가 죽는다 — 이 앱이 여러 번
  //    걸린 병이다. 명단·전체 되돌리기·닫기 세 줄을 반드시 같이 묶는다.
  $("tk-muted").addEventListener("click", () => talkToggleMuted());
  $("tk-muteclose").addEventListener("click", () => {
    $("tk-mutebox").hidden = true;
    tkJustBack = [];
  });
  $("tk-muteall").addEventListener("click", () => {
    void (async () => {
      const n = Object.keys(tkMuted).length;
      if (!n) return;
      // 되돌리는 쪽이라 잃는 것은 없지만, 몇 명인지는 알고 눌러야 한다.
      if (!(await sure(t("모두 다시 보기"), `${n}${t("명의 글이 다시 보입니다.")}`, t("다시 보기")))) return;
      for (const pk of Object.keys(tkMuted)) talkUnmute(pk);
    })();
  });
  /* ── 팬클럽 (자산 화면) ────────────────────────────────────────────
     🔴 러스트가 다 돼 있어도 이 몇 줄이 없으면 화면은 영원히 빈 칸이다.
        이 저장소가 여러 번 걸린 병이라 한 자리에 모아 둔다. */
  {
    const box = document.getElementById("fanbox") as HTMLDetailsElement | null;
    // 🔴 **펼칠 때 읽는다.** 자산 화면을 열 때마다 읽으면, 팬클럽을 안 쓰는
    //    사장의 노드를 하루 종일 두드리게 된다. 접힌 칸은 안 쓰는 칸이다.
    box?.addEventListener("toggle", () => {
      if (box.open) void fanLoad();
    });
  }
  $("fan-reload").addEventListener("click", () => void fanLoad(true));
  $("fan-pickall").addEventListener("click", () => {
    // 방이 없는 자산은 안 고른다. 골라 봐야 실패 목록만 늘어난다.
    for (const g of fanGroups) if (!g.need_room) fanPicked.add(g.asset);
    fanPaintGroups();
  });
  $("fan-picknone").addEventListener("click", () => {
    fanPicked.clear();
    fanPaintGroups();
  });
  $("fan-send").addEventListener("click", () => void fanSend());

  /* ── 내 이름 (이 컴퓨터 화면) ──────────────────────────────────────── */
  $("id-reload").addEventListener("click", () => void idLoad());
  $("id-adopt").addEventListener("click", () => void idAdopt());
  $("id-legacy").addEventListener("click", () => void idLegacy());
  {
    // 경로표는 **펼칠 때** 읽는다. 매일 볼 표가 아니다.
    const p = document.getElementById("id-paths") as HTMLDetailsElement | null;
    p?.addEventListener("toggle", () => {
      if (p.open) void idPaths();
    });
  }

  // 끌어다 놓기. 🔴 이 셋을 안 묶으면 창에 파일을 떨어뜨려도 아무 일도
  //    안 일어난다 — 만들어 놓고 안 부르는 그 병이다.
  void listen("drop-enter", () => dropVeil(true));
  void listen("drop-leave", () => dropVeil(false));
  void listen<any>("drop-files", (e) => void onDropped(e.payload?.paths || []));
  // 엔터로 보낸다. 줄바꿈은 Shift+Enter — 대화창의 기본 약속이다.
  $("tk-text").addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey) {
      k.preventDefault();
      void talkSend();
    }
  });
  // 쓴 만큼 칸이 자란다. 한 줄로 고정하면 긴 글을 쓸 때 앞이 안 보인다.
  $("tk-text").addEventListener("input", () => {
    const el = $("tk-text") as HTMLTextAreaElement;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  });
  // 맞교환. 🔴 러스트에 다 만들어 놓고 **이 다섯 줄이 없으면** 오늘 하루
  //    종일 고친 그 병이 그대로 반복된다.
  $("sw-make").addEventListener("click", () => void swapMakeOffer());
  $("sw-lot").addEventListener("click", () => void swapMakeLot());
  $("sw-look").addEventListener("click", () => void swapLook());
  ["sw-asset", "sw-amt"].forEach((id) =>
    $(id).addEventListener("input", () => void swapReady())
  );
  $("wz-cancel").addEventListener("click", () => $("wiz").classList.add("hidden"));
  $("wz-back").addEventListener("click", () => wizGo(wizStep - 1));
  $("wz-next").addEventListener("click", wizNext);
  $("sl-cancel").addEventListener("click", () => $("sellsheet").classList.add("hidden"));
  $("sl-go").addEventListener("click", listOffer);
  $("sl-cur").addEventListener("change", sellRate);
  $("vd-auto").addEventListener("click", toggleAuto);
  $("p-close").addEventListener("click", () => select(selected!));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) select(selected); });
  // 처음 켠 사람에게 사이드바를 먼저 보이면, 한 번도 안 판 사람이 소각·암호·
  // 노드 앞에 서게 된다.
  // 저장된 가게를 먼저 되살린다. 온보딩을 띄울지 판단하기 전에 해야
  // 두 번째 실행에서 빈 화면이 스쳐 지나가지 않는다.
  // 🔴 `await` 한다. 안 기다리면 아래의 「가게가 있나?」 판단이 **칸이 비어
  //    있던 순간**을 보고, 가게가 있어도 없다고 읽는다 — 첫 화면에
  //    「가게 만들기」가 뜨고 손님 폰 서버도 안 켜졌다.
  await loadShop();

  // 손님 폰 서버를 스스로 켠다.
  //
  // 이 프로그램의 자리는 모니터 없는 맥미니다. 정전이나 업데이트로 앱이 다시
  // 뜨면 스위치는 꺼진 채 시작하는데, 켤 화면이 없다 — 손님도 사장도 접속하지
  // 못하고, 가게는 멈춘 줄도 모른 채 멈춘다.
  //
  // 전에 한 번 켠 적이 있으면 다시 켠다. 한 번도 안 켠 컴퓨터는 건드리지
  // 않는다 — 켠 적 없는 서버가 저절로 열리는 것은 다른 종류의 사고다.
  // 🔴 **가게가 있으면 켠다.** 「전에 켠 적이 있으면」만 보고 있었는데,
  //    그러면 가게를 막 만든 사장은 **손님이 주문할 곳이 없는 채**로 시작한다.
  //    화면에도 「손님이 주문할 곳이 없습니다」라고만 뜨고, 그걸 켜는 스위치는
  //    「이 컴퓨터」 안쪽에 있다. 대표님 지적 그대로다 — 손님 폰으로 받는 것은
  //    장사의 전부인데 꺼진 채로 숨어 있었다.
  //
  //    가게 이름을 적었다는 것은 팔겠다는 뜻이다. 그러면 받을 곳이 있어야 한다.
  //    가게가 없는 컴퓨터는 그대로 둔다 — 켠 적 없는 서버가 저절로 열리는 것은
  //    다른 종류의 사고다.
  // 🔴 화면 칸을 보고 판단하면 안 된다. 바로 위 `loadShop()` 은 `await` 없이
  //    불리므로, 이 줄이 도는 시점에 칸은 **아직 비어 있다.** 그래서 가게가
  //    있어도 「없음」으로 읽고 서버를 안 켰다 — 손님이 주문할 곳이 없는
  //    상태로 앱이 시작된다.
  //
  //    파일에 직접 묻는다. 화면이 다 그려졌는지와 상관없는 사실이다.
  void (async () => {
    let hasShop = false;
    try {
      const sh = await invoke<any>("shop_load");
      hasShop = !!(sh?.name || sh?.name_en);
    } catch {
      /* 못 읽었으면 켜지 않는다. 아래 저장된 선택은 그대로 본다. */
    }
    if (localStorage.getItem(PHONE_KEY) === "1" || hasShop) {
      // 🔴 **조용히 삼키지 않는다.** 여태 `.catch(() => {})` 였다. 서버가 안
      //    켜져도 아무 말이 없었고, 화면에는 「손님이 주문할 곳이 없습니다」만
      //    떴다. 왜 안 켜졌는지는 아무 데도 안 적혔다 — 나도 못 찾았다.
      //
      //    실패하면 이유를 적어 둔다. 「문제 알리기」가 이 값을 같이 보낸다.
      startPhone().catch((e) => {
        lastPhoneError = String(e);
        const box = document.getElementById("todaycard") || document.getElementById("ravi-sub");
        if (box) {
          const p = document.createElement("div");
          p.className = "warnbox";
          p.style.marginTop = "10px";
          p.textContent = `${t("손님 폰 서버를 켜지 못했습니다")} — ${t(lastPhoneError)}`;
          box.appendChild(p);
        }
      });
    }
  })();

  // 하루 한 벌, 조용히. 누르라고 하면 안 누른다.
  // 하루 한 벌, 조용히. 앱을 켤 때 한 번만 돌면 일주일 켜 둔 가게는 일주일 동안
  // 백업이 없다 — 계산대는 원래 안 끄는 물건이다. 그래서 여섯 시간마다 두드리고,
  // 오늘 것이 이미 있으면 아무 일도 하지 않는다.
  const backupTick = () =>
    invoke("backup_auto", { nowUnix: Math.floor(Date.now() / 1000) }).catch(() => {});
  backupTick();
  setInterval(backupTick, 6 * 60 * 60 * 1000);
  // 인터넷이 끊기는 것은 화면을 열어 볼 때가 아니라 장사 중에 일어난다.
  setInterval(() => void quietly(loadNet), 30_000);

  // 매출을 계산대에 쌓아 두지 않는 것이 이 프로그램의 보안 전제다. 그런데
  // sweep_run 을 부르는 곳이 없어서 한 번도 돌지 않았다 — 전제만 있고 실행이
  // 없었다. 자동 발송과 따로 돈다: 자산을 안 파는 가게도 매출은 옮겨야 한다.
  const sweepTick = () =>
    invoke<any>("sweep_run", { passphrase: null })
      .then((r) => {
        // 🔴 못 옮기고 있으면 **말한다.** 여태 `if (!r?.swept) return;` 이라
        // 조용히 끝났고, 사장은 번 돈이 금고로 가는 줄 알고 계산대를 두고
        // 나갔다 — 실제로는 한 푼도 안 옮겨진 채 그 컴퓨터에 쌓였다.
        if (!r?.swept) {
          if (r?.why === "locked") {
            // 스윕 화면에 붙인다. 5분마다 알림을 띄우면 끄고 싶어진다.
            const el = document.getElementById("sw-state");
            if (el)
              el.innerHTML =
                `<span class="warn">지금 못 옮기고 있습니다</span> — ${escapeHtml(r.say || "")}` +
                (r.would_move ? ` (${fmtQty(r.would_move)} RVN 대기)` : "");
          }
          return;
        }
        $("vd-result").innerHTML =
          `<div class="card" style="margin-top:12px"><h3>매출을 옮겼습니다</h3>
             <div class="kv"><b>${r.amount} RVN</b><span><code class="addr">${r.to}</code></span></div>
             <p class="meta">계산대에는 ${r.kept} RVN만 남겼습니다.</p></div>` + $("vd-result").innerHTML;
      })
      .catch(() => {});
  sweepTick();
  setInterval(sweepTick, 5 * 60 * 1000);
  ["sh-ko", "sh-en", "sh-ja", "sh-zh", "sh-desc", "sh-loc", "sh-phone", "mn-cur"].forEach((id) =>
    $(id)?.addEventListener("input", saveShop)
  );
  ["sh-pickup", "sh-delivery"].forEach((id) =>
    $(id)?.addEventListener("change", saveShop)
  );

  if (!localStorage.getItem(ONBOARD_KEY)) {
    startOnboard();
  }
  $("ob-only").addEventListener("click", () => obChoose(true));
  $("ob-also").addEventListener("click", () => obChoose(false));
  $("ob-override").addEventListener("click", () => obChoose(true));
  $("ob-apply").addEventListener("click", obApply);
  $("ob-detail").addEventListener("click", () => {
    const n = $("ob-nums");
    n.style.display = n.style.display === "none" ? "block" : "none";
  });

  labelShopNav();
  // 🔴 번역은 화면을 다 그린 **뒤에** 켠다. 먼저 켜면 아직 없는 글자를
  //    지나가고, 그 자리는 한국어로 남는다. 켠 뒤로는 화면이 바뀔
  //    때마다 저절로 따라간다.
  startI18n();
  // 🔴 `paintRavi()` 만 부르면 안 된다. 첫 화면이 HTML 에서 이미 켜져
  //    있어 `showPage` 를 안 지나가고, 그러면 떠 있는 단추를 숨기는
  //    처리도 안 돈다 — 대화창 위에 대화창으로 가는 단추가 떠 있었다.
  showPage("ravi");
  loadAssets();
  // 🔴 **맨 마지막**에 부른다. 이걸 먼저 부르면 아직 안 그려진 메뉴를
  //    숨기려 들고, 그러면 「돕기」로 골라도 가게 메뉴가 남는다.
  void applyMode();
  // 재색인이 끝났는데 앱이 꺼져 있었던 경우를 여기서 수습한다
  // (끝났으면 launchd 를 되돌리고 표시를 남긴다).
  void invoke("reindex_progress").catch(() => null);
  void reindexTick();
  window.setInterval(() => void reindexTick(), 60_000);
  // Status is cheap; the IPFS scan is not, and is deliberately not on a timer.
});

/* ══ 무엇으로 쓸 것인가 ══════════════════════════════════════════════
   돕기인가 장사인가. 안 골랐으면 첫 화면에서 묻는다. */

/** 고른 것에 맞춰 메뉴와 첫 화면을 맞춘다. */
async function applyMode(): Promise<void> {
  let m: any = null;
  try {
    m = await invoke<any>("mode_get");
  } catch {
    // 못 읽으면 아무것도 숨기지 않는다 — 숨기는 쪽으로 실패하면
    // 사장이 자기 가게를 못 찾는다.
    return;
  }
  const hello = document.getElementById("hello");
  if (!m?.chosen) {
    if (hello) hello.style.display = "";
    return;
  }
  if (hello) hello.style.display = "none";

  const help = m.mode === "help";
  const show = (page: string, on: boolean) => {
    const a = document.querySelector<HTMLElement>(`nav a[data-page="${page}"]`);
    if (a) a.style.display = on ? "" : "none";
  };
  show("helping", help);
  // 🔴 채굴 칸 둘은 **돕는 사람의 것**이다. 계산대 컴퓨터로 캐면 컴퓨터가
  //    느려지고 전기를 먹어서, 장사하는 사장에게는 권하지도 않는 기능이다.
  //    그런데 설정 화면 한가운데에 두 칸을 차지하고 있었다.
  //    모드 스위치가 이미 있는데 표시에 안 쓰고 있었다(페이블 지적).
  // 🔴 자동으로 나가게 만든 뒤에도 「개발비 보내기」 단추가 남아 있었다.
  //    자동인데 단추가 있으면 사장은 「안 눌러서 안 갔나」 하고 누른다 —
  //    할 일이 없는 단추다. 밀린 것이 있을 때만 보인다.
  void invoke<any>("fee_owed")
    .then((f) => {
      const btn = document.getElementById("fee-send");
      if (btn) btn.style.display = Number(f?.owed ?? 0) >= 0.01 ? "" : "none";
    })
    .catch(() => null);
  ["mine-net-box", "mine-run-box"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = help ? "" : "none";
  });
  for (const [id, pick] of [["mode-help", "help"], ["mode-shop", "shop"]] as const) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("on", m.mode === pick);
  }
  // 「돕기」에서 감추는 것은 **가게 하나뿐**이다. 자산·배당은 레이븐코인
  // 그 자체라 돕는 사람도 쓴다 — 장사 기능이 아니다.
  show("shop", !help);
  // `door` 는 큰 메뉴에서 내렸다(「내 가게」 안에 있다). 감출 것이 없다.

  if (help) {
    showPage("helping");
    void paintHelping();
    if (helpTimer === null) helpTimer = window.setInterval(() => void paintHelping(), 8000);
  } else if (helpTimer !== null) {
    // 🔴 장사 모드로 바꿔도 「돕기」 타이머가 계속 돌았다 — 끄는 코드가
    //    파일 어디에도 없었다. 8초마다 노드·릴레이·파일창고·채굴 넷을 부른다.
    clearInterval(helpTimer);
    helpTimer = null;
  }
}

let helpTimer: number | null = null;

/** 이 컴퓨터가 지금 무엇을 하고 있는지. */
async function paintHelping(): Promise<void> {
  if (쉬는중()) return; // 창을 안 보는 동안은 그리지 않는다

  const box = document.getElementById("hp-body");
  if (!box) return;
  const [node, relay, ipfs, mine] = await Promise.all([
    invoke<any>("node_status").catch(() => null),
    invoke<any>("relay_status").catch(() => null),
    invoke<any>("ipfs_status").catch(() => null),
    invoke<any>("miner_running").catch(() => null),
  ]);
  const on = (v: unknown) => (v ? t("하고 있습니다") : t("꺼져 있습니다"));
  box.innerHTML =
    card(
      [
        [
          t("체인 지키기"),
          node?.blocks
            ? `${t("블록")} ${Number(node.blocks).toLocaleString()} · ${t("이웃")} ${Number(node.peers ?? 0)}${t("곳")}`
            : on(false),
        ],
        [
          t("공지 나르기"),
          relay?.running
            ? `${Number(relay.events ?? 0).toLocaleString()}${t("개를 들고 있습니다")}`
            : on(false),
        ],
        [t("사진 나눠 갖기"), on(ipfs?.running)],
        [t("캐기"), on(mine?.running)],
      ],
      t("켜 두는 것만으로 이 그물이 촘촘해집니다. 가게가 늘수록 남의 릴레이가 끊겨도 서로 붙습니다.")
    ) +
    // 🔴 정직하게. 지금은 색인이 꺼져 있어서 이 노드가 남의 지갑을 돕지는
    //    못한다. 돕고 있다고 적으면 안 된다.
    `<div class="card"><b>${t("아직 못 하고 있는 것")}</b>
       <p class="meta" style="margin-top:8px">${t(
         "이 노드는 아직 남의 지갑 잔액을 대신 답해 주지 못합니다. 주소 색인이 꺼져 있기 때문입니다. 켜면 이 컴퓨터가 실제로 남을 돕게 됩니다."
       )}</p>
       <button data-part-go="node" style="margin-top:12px">${t("주소 색인 켜기")}</button>
     </div>`;
}

// 🔴 판 번호가 화면에 `v0.1` 로 **박혀** 있었다. 어느 판을 쓰는지 사장도
//    우리도 모른다 — 「그 문제 고쳤습니다」 하고 안 고쳐진 판을 보고 있을
//    수 있다. 무엇이 도는지 모르면 진단이 안 된다.
void (async () => {
  try {
    const v = await getVersion();
    const el = document.getElementById("appver");
    if (el && v) el.textContent = `v${v}`;
    // 🔴 늘 눌리게 한다. 새 버전이 없을 때도 「지금이 최신입니다」를
    //    들을 수 있어야 한다 — 아무 반응이 없으면 고장으로 읽힌다.
    el?.addEventListener("click", () => void checkNow());
  } catch {
    // 못 읽으면 적혀 있는 것을 그대로 둔다.
  }
})();
