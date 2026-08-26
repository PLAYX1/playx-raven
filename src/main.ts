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
const TOUCH_WINDOW = 8000;
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
  const mine = Date.now() - lastTouch < TOUCH_WINDOW;
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
    return `<tr data-row="${a.name}" class="${selected === a.name ? "sel" : ""}${child ? " child" : ""}">
      <td class="name">${child ? '<span class="branch"></span>' : ""}${label}</td>
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
        <td class="name"><span class="tri ${open ? "open" : ""}"></span>${root}<span class="cnt">${list.length}종류</span></td>
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
    say("보존하지 못했습니다", String(e));
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
    say("해제하지 못했습니다", String(e));
  }
  renderList();
  if (selected) renderPanel();
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
    $("p-actions").innerHTML =
      `<button id="p-send">보내기</button>` +
      (a.amount > 0 ? `<button class="ghost" id="p-sell">팔기</button>` : "");
    const sb = document.getElementById("p-send");
    if (sb) sb.onclick = () => { showPage("wallet"); openSend("asset", a.name); };
    const lb = document.getElementById("p-sell");
    if (lb) lb.onclick = () => openSell(a);
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
    $("summary").textContent = String(e);
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
    $("nd-note").textContent = String(e);
  }
}

async function loadNet() {
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
        bpMsg.textContent = String(e);
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

async function paintStatusDots() {
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
  } catch {
    set("d-node", "d-node-t", false, "RVN 노드 꺼짐");
    setSyncBar(null);
    nodeUp = false;
  }
  // 노드 상태가 바뀌면 라비 얼굴도 따라 바뀐다.
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
    await sure(t("받지 못했습니다"), String(e), t("닫기"));
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
        $("up-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
      hi.textContent = "노드가 꺼져 있어요.";
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
    noteBox.innerHTML = todo.length
      ? `<b>${t("아직 안 된 것")}</b> ` +
        todo.map((x, i) =>
          `<button class="todochip" data-todo="${i}">${escapeHtml(x.label)} →</button>`).join("")
      : "";
    noteBox.style.display = todo.length ? "" : "none";
    noteBox.querySelectorAll<HTMLElement>("[data-todo]").forEach((b) => {
      b.onclick = () => todo[+b.dataset.todo!].go?.();
    });
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
    $("rp-what").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
      label: t("노드가 꺼져 있어요"),
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
       <div class="meta" style="margin-top:10px">${escapeHtml(String(e))}</div>`;
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
  partTimer = window.setInterval(() => void paintPart(), 5000);
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
        <p class="meta danger">${escapeHtml(String(e))}</p>
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
      box.innerHTML = `<p class="meta danger">${escapeHtml(String(e))}</p>`;
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
      say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
        t("그래야 적용됩니다. 몇 분 동안 결제 확인이 멈춥니다.")
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
      say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
      say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
        const warming = /Loading block index|Verifying|Rewinding|Activating|Loading wallet|warming up|-28/i.test(msg);
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
      // 속도는 두 번 재야 나온다. 처음엔 아직 모른다고 말한다.
      const st = await invoke<any>("sync_stalled").catch(() => null);
      const rate = Number(st?.rate ?? 0);
      const rateText =
        rate > 0 ? `${t("초당")} ${rate.toLocaleString()}${t("블록")}` : t("재는 중…");
      box.innerHTML =
        card(
          [
            [t("연결"), s?.peers != null ? `${s.peers}${t("곳")}` : t("확인 중")],
            [t("블록"), Number(s?.blocks ?? 0).toLocaleString()],
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
              : [
                  t("결제 확인"),
                  behind > 0
                    ? `${t("남은 블록")} ${behind.toLocaleString()}`
                    : t("지금 바로 됩니다"),
                ],
          ],
          behind > 0 && s?.behind_honest === false
            ? t(
                "다시 훑는 중입니다. 남은 양은 아직 알 수 없습니다 — 며칠 걸릴 수 있습니다. 「따라잡음 %」는 초반에 거의 안 움직이는 것이 정상입니다(옛 블록은 거래가 적어서입니다). 도는지 멈췄는지는 위 속도로 보십시오."
              )
            : behind > 0
              ? t("따라잡는 동안에는 방금 들어온 결제가 늦게 보입니다.")
              : t("이 컴퓨터가 체인을 통째로 들고 있습니다. 남에게 묻지 않습니다."),
        ) + (behind > 0 ? await stallCard() : "") +
        (behind > 0 ? await speedCard() : await restoreCard()) + (await indexCard()) +
        goto("settings", t("노드 설정 열기"));
      bindSpeed();
      bindRestore();
      bindRestart();
      bindLog();
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
          ) + goto("settings", t("파일창고 설정 열기"));
      bindTurnOn("ip-go", "services_start");
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
            say(String(e));
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
            alert(String(e));
          }
        };
      }
    }
    bindIndexCard();
  } catch (e) {
    box.innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
        say(String(e));
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
        say(String(e));
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
      note.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
    say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
  await paintOwed();
}


/** 지금 열려 있는 화면. 끌어다 놓기가 **자리마다 다르게** 굴려면 필요하다. */
let currentPage = "ravi";

function showPage(id: string) {
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
  if (id === "settings") {
    loadNode();
    loadNet();
    // 🔴 쉬운 설정이 **제일 먼저** 그려져야 한다. 고급 설정이 먼저 뜨면
    // 사장은 그걸 읽다가 지친다 — 그게 지금까지 일어난 일이다.
    void paintEasySetup();
    void paintSweepKrw();
    wireCloudKey();
  }
  if (id === "reward") void loadReward();
  // 간판 열쇠 옮기기. 이미 씨앗 열쇠면 이 안에서 스스로 숨는다.
  if (id === "shop") void paintKeyMove();
  // 🔴 화면을 열 때 부르지 않으면 빈 칸만 보인다. 만들어 놓고 안 부르는
  //    것이 이 저장소의 고질병이라 여기 한 줄을 꼭 남긴다.
  if (id === "talk") {
    void talkPaintMe();
    void talkPaintRooms();
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
    $("w-unconfirmed").textContent = String(e);
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
    $("w-lock-detail").textContent = String(e);
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
          ? new Date(t.time * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })
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
    say("주소를 만들지 못했습니다", String(e));
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
        title: t("글에 붙입니다"),
        why: t("자산으로 만드는 것이 아닙니다. 파일창고에 올리고 그 주소를 글에 넣습니다 — 값이 들지 않습니다."),
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

/** 사진인가. 영상은 **안 올린다** — 링크로 받는다. */
function looksLikeImage(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(path);
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
    } else if (currentPage === "talk") {
      const box = $("tk-text") as HTMLTextAreaElement;
      box.value = `${box.value}${box.value ? "\n" : ""}https://ipfs.io/ipfs/${cid}`;
      box.focus();
      $("tk-note").innerHTML = `<span class="ok">${t("사진을 붙였습니다")}</span>`;
    } else if (currentPage === "shop") {
      const el = document.getElementById("sh-icon") as HTMLInputElement | null;
      if (el) el.value = cid;
      $("sh-refreshsay").innerHTML =
        `<span class="ok">${t("가게 사진으로 넣었습니다. 「바뀐 것 손님에게 알리기」를 눌러 주세요.")}</span>`;
    }
  } catch (e) {
    await sure(t("올리지 못했습니다"), String(e), t("닫기"));
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
    $("km-note").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
}

/* ── 이야기 ───────────────────────────────────────────────────
   세계와 한 방에서. 🔴 여기는 **RVN 이 필요 없다** — 레이븐을 아직 안 쓰는
   사람이 이 프로그램을 켜 둘 이유가 여기서 생긴다.                      */

let tkRoom = "";
let tkMine = "";
/** 공개키 → 이름표. 없는 사람은 여기 없다 — **없는 이름을 지어내지 않는다.** */
const tkNames = new Map<string, any>();

/** 16진수 64자 대신 보여 줄 것. 이름이 있으면 이름, 없으면 앞자리. */
function tkWho(pk: string): string {
  const p = tkNames.get(pk);
  if (p?.name) return escapeHtml(String(p.name));
  return `<span class="meta">${escapeHtml(pk.slice(0, 10))}…</span>`;
}

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
    $("tk-me").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
  box.innerHTML =
    `<button class="room${tkRoom ? "" : " on"}" data-room="">${t("레이븐 이야기")}</button>` +
    rooms
      .map(
        (r) =>
          `<button class="room${tkRoom === String(r.id) ? " on" : ""}" data-room="${escapeHtml(String(r.id))}"
             title="${escapeHtml(String(r.about || ""))}">${escapeHtml(String(r.name))}</button>`
      )
      .join("");
  box.querySelectorAll("[data-room]").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      tkRoom = String((b as HTMLElement).dataset.room || "");
      $("tk-title").textContent = tkRoom
        ? tkRoomNames.get(tkRoom) || t("방")
        : t("레이븐 이야기");
      void talkPaintRooms();
      void talkPaint();
    };
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
  box.innerHTML = `<div class="meta" style="margin:auto">${t("세계 릴레이에서 읽는 중…")}</div>`;
  try {
    const list: any[] = await invoke("talk_read", { room: tkRoom || null, limit: 60 });
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
    const asc = [...list].reverse();
    let prev = "";
    box.innerHTML = asc
      .map((e) => {
        const who = String(e.pubkey || "");
        const mine = who === tkMine;
        const id = String(e.id || "");
        const when = new Date(Number(e.created_at || 0) * 1000).toLocaleString();
        // 같은 사람이 이어서 쓰면 이름을 다시 안 적는다. 촘촘해 보인다.
        const head = who === prev ? "" : `<div class="who">${mine ? `<b>${t("나")}</b>` : tkWho(who)}</div>`;
        prev = who;
        return (
          head +
          `<div class="bub${mine ? " me" : ""}" data-say="${id}">${escapeHtml(String(e.content || ""))}</div>
           <div class="bubacts${mine ? " r" : ""}">
             <button data-tr="${id}">${t("내 말로")}</button>
             <button data-keep="${id}">${t("간직")}</button>
             <span class="meta" data-note="${id}"></span>
           </div>
           <div class="when"${mine ? ' style="text-align:right"' : ""}>${escapeHtml(when)}</div>`
        );
      })
      .join("");
    // 새 글이 아래에 있으므로 맨 아래로 내린다. 안 하면 옛날 글만 보인다.
    box.scrollTop = box.scrollHeight;
    box.querySelectorAll("[data-tr]").forEach((b) => {
      (b as HTMLElement).onclick = () => void talkTranslate(String((b as HTMLElement).dataset.tr), list);
    });
    box.querySelectorAll("[data-keep]").forEach((b) => {
      (b as HTMLElement).onclick = () => void talkKeep(String((b as HTMLElement).dataset.keep), list);
    });
  } catch (e) {
    box.innerHTML = `<p class="meta danger">${escapeHtml(String(e))}</p>`;
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
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="tr" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);color:var(--muted)">${escapeHtml(String(j.translation))}</div>`
    );
    note.textContent = "";
  } catch (e) {
    note.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
}

/** 지우기 싫은 글을 파일창고에 굳힌다. 여기서부터가 우리만 하는 일이다. */
async function talkKeep(id: string, list: any[]) {
  const note = document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
  const ev = list.find((e) => String(e.id) === id);
  if (!note || !ev) return;
  note.textContent = t("굳히는 중…");
  try {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(ev)));
    const added = await invoke<any>("ipfs_add_file", {
      file: { name: `talk-${id.slice(0, 12)}.json`, bytes },
    });
    note.innerHTML =
      `<span class="ok">${t("굳혔습니다")} — <code class="addr">${escapeHtml(String(added.cid))}</code></span>`;
  } catch (e) {
    note.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
}

async function talkSend() {
  const box = $("tk-text") as HTMLTextAreaElement;
  const text = box.value.trim();
  if (!text) return;
  $("tk-note").textContent = t("올리는 중…");
  try {
    await invoke("talk_post", { text, room: tkRoom || null });
    box.value = "";
    box.style.height = "auto";
    // 「올렸습니다」를 남겨 두지 않는다 — 대화창에 붙어 있는 알림은 짐이다.
    $("tk-note").textContent = "";
    setTimeout(() => void talkPaint(), 1200);
  } catch (e) {
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
}

async function talkNewRoom() {
  const name = await ask(t("방 이름"), t("무엇을 이야기하는 방인가요?"));
  if (!name) return;
  const about = (await ask(t("한 줄 설명"), t("비워 두셔도 됩니다."))) || "";
  try {
    await invoke("talk_make_room", { name, about });
    await talkPaintRooms();
    $("tk-note").innerHTML = `<span class="ok">${t("방을 만들었습니다")}</span>`;
  } catch (e) {
    $("tk-note").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
  }
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
    note.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
    $("sw-ready").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
    box.innerHTML = `<p class="meta danger">${escapeHtml(String(e))}</p>`;
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
    box.innerHTML = `<p class="meta danger">${escapeHtml(String(e))}</p>`;
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
    $("sw-note").innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
        : `<p class="meta">${file.name} · 올렸습니다</p>`;
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
    await sure("지갑을 열지 못했습니다", String(e), "닫기");
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
    const qty = wizKind === "unique" ? 1 : parseFloat(($("i-qty") as HTMLInputElement).value) || 1;
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
    $("ord-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
    $("ord-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
          await sure("브라우저를 열지 못했습니다", String(e), "닫기");
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
    $("chat-open").style.display = "";
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
        ? "노드가 꺼져 있어요"
        : have.length
          ? "Ravi에게 물어보기"
          // 키가 없어도 라비는 깨어 있다. 다만 할 수 있는 일이 적다.
          : "Ravi에게 물어보기";
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

function applyActions(actions: any[]): string[] {
  const done: string[] = [];
  for (const a of actions || []) {
    try {
      switch (a.type) {
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
    chatHtml("ai", `<span class="warn">${escapeHtml(String(e))}</span>`);
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
    chatHtml("ai", `<span class="warn">${escapeHtml(String(e))}</span>`);
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
          chatHtml("ai", `<span class="warn">${escapeHtml(String(e))}</span>`);
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
    chatSay("ai", String(e));
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
    note.innerHTML = `<span style="color:var(--bad)">${escapeHtml(String(e))}</span>`;
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
      note.textContent = `${out.length}${t("장 올렸습니다. 바꾸셔도 소각은 없습니다.")}`;
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
      $("sh-picnote").innerHTML = `<span style="color:var(--bad)">${escapeHtml(String(e))}</span>`;
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
          box.innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
          return;
        }
        void showBookings();
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(String(e))}</div>`;
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
    box.innerHTML = `<div class="warnbox" style="margin-top:12px">${escapeHtml(String(e))}</div>`;
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
        $("dr-note").innerHTML = `<span class="danger">${e}</span>`;
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
          invoke("open_share", { url: (b as HTMLElement).dataset.share }).catch((e) => say("열지 못했습니다", String(e)));
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

async function doRefund(_payAddress: string, suggested: number) {
  const amount = await ask(
    "얼마를 돌려드릴까요? (RVN)",
    `받은 금액은 ${suggested} RVN입니다.\n일부만 돌려주려면 더 적게 넣으세요.`,
    { value: String(suggested), numeric: true }
  );
  if (!amount) return;
  const to = await ask(
    "어느 주소로 돌려드릴까요?",
    "체인은 누가 보냈는지 기록하지 않습니다. 손님에게 받을 주소를 물어보셔야 합니다."
  );
  if (!to) return;
  const reason =
    (await ask("사유", "내 지갑에만 남습니다. 손님은 못 봅니다.", { value: "주문 취소" })) || "";

  const lock = await invoke<any>("wallet_lock_state").catch(() => null);
  const pass =
        lock?.encrypted && !lock?.unlocked
          ? await ask("지갑 암호", "", { password: true })
          : null;

  try {
    const r = await invoke<any>("refund", {
      toAddress: to.trim(),
      amount: parseFloat(amount),
      reason,
      passphrase: pass,
    });
    $("or-refund").innerHTML =
      `<div class="card" style="margin-top:12px"><h3>환불했습니다</h3>
       <div class="kv"><b>금액</b><span>${r.amount} RVN</span></div>
       <div class="kv"><b>트랜잭션</b><code class="addr">${r.txid}</code></div></div>`;
    loadWallet();
  } catch (e) {
    $("or-refund").innerHTML = `<div class="warnbox" style="margin-top:12px">${e}</div>`;
  }
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
    $("rw-gate").innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
            $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
    $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
    $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
            $("abk-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
          }
        };
      });
  } catch (e) {
    $("abk-list").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
    $("abk-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
    $("sw-note").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
            if (label) label.textContent = `🔴 ${String(e).slice(0, 60)}`;
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
          say("안 됐습니다", String(err));
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
          say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
    // 사장·직원·검표 QR에는 각각 다른 열쇠가 들어 있다. 손님 QR만 붙여도 된다.
    phoneQr =
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
            <td>${new Date((e.at || 0) * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</td>
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
  if (which === "orders") loadOrders();
  if (which === "sales") loadSales();
  if (which === "mine") previewOpen();
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
           const when = new Date((x.at || 0) * 1000).toLocaleString("ko-KR", {
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

  if (sh.payment_address) shopAddress = sh.payment_address;
  if (sh.icon) shopIcon = sh.icon;
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
  if (sh.lat != null && sh.lon != null) shopCoords = { lat: sh.lat, lon: sh.lon };

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
               style="width:390px;max-width:100%;height:620px;border:1px solid var(--line);
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
        }).catch((e) => say("열지 못했습니다", String(e)));
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

// ── 주문 ──
async function loadOrders() {
  // 주문마다 주소가 다르므로 가게 주소 하나로는 못 찾는다. 빈 주소를 넘기면
  // 주문 라벨이 붙은 입금만 골라 온다 — 4년 전 채굴 기록이 오늘 주문 자리에
  // 앉는 일도 이걸로 막힌다.
  try {
    const res = await invoke<any>("incoming_payments", { address: "", minConf: 1 });
    const list: any[] = res.payments || [];
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
          el.setAttribute("disabled", "true");
          try {
            // "나왔다"를 누르는 순간 손님 폰이 울린다. 그래서 이 버튼은
            // 실수로 눌리면 안 되는 자리에 있어야 하고, 되돌릴 수 있어야 한다.
            await invoke("set_order_state", { address: el.dataset.state, newState: el.dataset.to });
            loadOrders();
          } catch (e) {
            $("or-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
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
      say.innerHTML = `<span class="danger">${escapeHtml(String(e))}</span>`;
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
  setInterval(() => void paintStatusDots(), 20_000);
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
      $("rw-now").innerHTML = `<span class="warn">${escapeHtml(String(e))}</span>`;
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
      $("rw-out").innerHTML = `<div class="warnbox">${escapeHtml(String(e))}</div>`;
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
  setInterval(checkHealth, 30000);
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
      noteEl.textContent = String(e);
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
      if (noteEl) noteEl.textContent = String(e);
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
        if (say) say.textContent = String(e);
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
        if (say) say.textContent = String(e);
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
    if (on) orderTimer = setInterval(loadOrders, 30000);
  });
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
  $("tk-name").addEventListener("click", () => void talkSetName());
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
          p.textContent = `손님 폰 서버를 켜지 못했습니다 — ${lastPhoneError}`;
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
  setInterval(loadNet, 30_000);

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
  show("door", !help);

  if (help) {
    showPage("helping");
    void paintHelping();
    if (helpTimer === null) helpTimer = window.setInterval(() => void paintHelping(), 8000);
  }
}

let helpTimer: number | null = null;

/** 이 컴퓨터가 지금 무엇을 하고 있는지. */
async function paintHelping(): Promise<void> {
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
