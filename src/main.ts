import { invoke } from "@tauri-apps/api/core";
import { open as pickFile } from "@tauri-apps/plugin-dialog";

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
    const label = child ? a.name.slice(a.root.length).replace(/^[/#]/, "") : a.name;
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
      const head = `<tr class="grp" data-grp="${root}">
        <td class="name"><span class="tri ${open ? "open" : ""}"></span>${root}</td>
        <td class="num">${list.length}개</td>
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
  if (!(await sure("보존을 해제할까요?", "이 컴퓨터에서 사본이 사라집니다. 다른 곳에 사본이 없으면 되찾을 수 없습니다.", "해제합니다"))) return;
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
    filters: [{ name: "PLAY X Raven 백업", extensions: ["zip"] }],
    defaultPath: undefined,
  }).catch(() => null);
  if (!where || typeof where !== "string") return;
  $("rs-result").innerHTML = `<div class="meta" style="margin-top:9px">읽는 중…</div>`;
  try {
    const r: any = await invoke("restore_survey", { folder: where });
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
      const res: any = await invoke("restore_apply", { folder: where.trim(), keys });
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

function showPage(id: string) {
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === `page-${id}`));
  document.querySelectorAll("nav a").forEach((a) =>
    a.classList.toggle("on", (a as HTMLElement).dataset.page === id));
  if (id === "wallet") loadWallet();
  if (id === "settings") { loadNode(); loadNet(); }
  if (id === "reward") void loadReward();
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

/* ── 발행 ─────────────────────────────────────────────────────
   Nothing here is reversible, so the flow is built to slow the user down at the
   two places that matter: the name (permanent, global, unrepeatable) and the
   reissuable flag (the door that locks behind you).                         */

let issueCheck: any = null;
let wizStep = 1;
let wizKind: "root" | "sub" | "unique" = "root";
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
  $("i-qtyrow").style.display = unique ? "none" : "";
  $("i-uniquenote").style.display = unique ? "" : "none";
  if (unique) {
    ($("i-qty") as HTMLInputElement).value = "1";
    ($("i-units") as HTMLInputElement).value = "0";
  }

  if (wizStep === 5) renderSummary();
  const next = $("wz-next") as HTMLButtonElement;
  next.textContent = wizStep === 5 ? `${BURN[wizKind]} RVN 소각하고 발행` : "다음";
  wizGate();
}

function wizGate() {
  const next = $("wz-next") as HTMLButtonElement;
  if (wizStep === 1) next.disabled = !document.querySelector(".choice.on");
  else if (wizStep === 2) next.disabled = !issueCheck;
  else if (wizStep === 5) {
    const typed = ($("i-confirm") as HTMLInputElement).value.trim();
    next.disabled = !issueCheck || typed !== issueCheck.name;
  } else next.disabled = false;
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
  $("i-r-qty").innerHTML =
    wizKind === "unique"
      ? "1 (고유)"
      : `${qty.toLocaleString()} · 소수점 ${units}자리 · ` +
        (re ? "재발행 가능" : '<b class="danger">재발행 불가 — 되돌릴 수 없음</b>');
  $("i-r-file").textContent = cid || "없음";

  const need = BURN[wizKind];
  $("i-cost").innerHTML = `<div class="burn danger">${need} RVN 소각</div>
    <div class="meta">소각된 RVN은 돌아오지 않습니다. 네트워크 수수료는 별도입니다.</div>
    <div class="meta" id="i-have">지갑 확인 중…</div>`;
  ($("i-confirm") as HTMLInputElement).placeholder = issueCheck?.name || "";

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

async function doIssue() {
  if (!issueCheck) return;
  const btn = $("wz-next") as HTMLButtonElement;
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "발행 중…";
  try {
    const txid = await invoke<string>("issue_asset", {
      name: issueCheck.name,
      qty: wizKind === "unique" ? 1 : parseFloat(($("i-qty") as HTMLInputElement).value) || 1,
      units: wizKind === "unique" ? 0 : parseInt(($("i-units") as HTMLInputElement).value) || 0,
      reissuable: ($("i-reissuable") as HTMLInputElement).checked,
      ipfsHash: ($("i-ipfs") as HTMLInputElement).value.trim() || null,
      toAddress: null,
    });
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
    // 않고, 비교하지 않는 확인은 확인이 아니다. 끝 4자리는 강조한다.
    const a = String(sendPreview.address);
    const head = a.slice(0, -4).replace(/(.{4})/g, "$1 ");
    $("r-tailshow").innerHTML = `${escapeHtml(head)}<b>${escapeHtml(a.slice(-4))}</b>`;
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
    $("chat-open").style.display = have.length ? "" : "none";
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
        case "shop_flag": {
          const id = a.field === "delivery" ? "sh-delivery" : "sh-pickup";
          ($(id) as HTMLInputElement).checked = !!a.value;
          done.push(`${a.field === "delivery" ? "배달" : "매장·포장"} ${a.value ? "켬" : "끔"}`);
          break;
        }
        case "menu_add":
          menuItems.push({
            name: a.name || "",
            name_en: a.name_en || "",
            price: a.price ?? null,
            image: null,
          });
          done.push(`메뉴 추가: ${a.name}`);
          break;
        case "menu_set":
          if (menuItems[a.index]) {
            menuItems[a.index][a.field] = a.field === "price" ? Number(a.value) : a.value;
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
  if (m === "debate")
    chatHtml("ai", "서로 다른 두 곳에 같은 것을 묻습니다. <b>어긋나는 자리</b>가 사장님이 정하실 자리예요.");
  else if (m === "ask")
    chatSay("ai", "무엇이든 물어보세요. 화면은 건드리지 않습니다.");
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
    `아직 <b>API 키</b>가 없어요. 한 곳만 넣으면 바로 이야기할 수 있어요.<br />
     <span class="muted">키는 이 컴퓨터에만 저장됩니다(0600). 우리 서버로 가지 않아요.</span>
     ${rows}
     <button id="keyask-save" style="margin-top:8px">저장하고 이어가기</button>`,
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
      chatSay("ai", "됐어요. 이제 물어보세요.");
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
    menu: menuItems.map((m, i) => ({ index: i, name: m.name, price: m.price })),
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
function pickShopPhoto() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    $("sh-picnote").textContent = "줄이는 중…";
    try {
      // RIP-0014 carries the icon inline as a data URI, so a 4 MB phone photo
      // would make the profile itself 4 MB — every customer browsing the shop
      // list would download it. Downscale before storing.
      const bitmap = await createImageBitmap(file);
      const max = 512;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      shopIcon = canvas.toDataURL("image/jpeg", 0.82);

      $("sh-picprev").innerHTML = `<img src="${shopIcon}" alt="" style="max-width:180px;border-radius:8px;margin-top:8px" />`;
      $("sh-picnote").textContent = `${canvas.width}×${canvas.height}로 줄여 담았습니다`;
    } catch (e) {
      $("sh-picnote").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
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
    $("dr-list").innerHTML = list.length
      ? list.map((m) => memberCard(m, false)).join("")
      : emptyWithRaven("아직 등록된 회원이 없습니다.<br />「회원 등록」으로 첫 회원을 넣어 보세요.", "hello");
    bindMemberCards("dr-list");
    $("dr-note").textContent = `회원 ${list.length}명`;
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
    }
  } else {
    ["ms-name", "ms-phone", "ms-note"].forEach((id) => set(id, ""));
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
}

async function doEncrypt() {
  const btn = $("enc-go") as HTMLButtonElement;
  btn.disabled = true;
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  try {
    if (encMode === "new") {
      await invoke("encrypt_wallet", { passphrase: v("enc-new"), confirm: v("enc-new2") });
      $("enc-result").innerHTML =
        `<div class="warnbox" style="margin-top:12px"><b>암호를 걸었습니다. 노드가 꺼졌습니다.</b><br />
         레이븐 노드를 다시 켜야 가게가 다시 돕니다. 암호를 종이에 적어 안전한 곳에 두세요 —
         이 컴퓨터가 아닌 곳에.</div>`;
    } else {
      await invoke("change_passphrase", {
        old: v("enc-old"),
        new: v("enc-new"),
        confirm: v("enc-new2"),
      });
      $("enc-result").innerHTML = `<div class="card" style="margin-top:12px"><h3>바꿨습니다</h3></div>`;
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
    const solo = r.solo_days_per_block;

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
          solo > 36500 ? "100년 넘게" : solo > 365 ? `${(solo / 365).toFixed(0)}년` : `${solo.toFixed(0)}일`
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
    ($("rw-height") as HTMLInputElement).value ||= String(n.suggest);
    $("rw-now").textContent =
      `지금 ${n.height.toLocaleString()}번 블록입니다. ` +
      `${n.suggest.toLocaleString()}번이면 약 ${Math.round((n.suggest - n.height) * n.seconds_per_block / 60)}분 뒤입니다.`;
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
    $("bk-places").innerHTML =
      (rows.length
        ? rows.join("")
        : `<div class="meta">붙어 있는 클라우드나 외장 디스크가 없습니다.</div>`) +
      `<div class="row" style="margin-top:12px">
         <button class="ghost" id="bk-pick">다른 폴더 고르기…</button>
         <span class="meta">아무것도 안 고르면 바탕화면에 만듭니다.</span>
       </div>`;

    // 목록의 줄을 직접 누르면 거기에 만든다. 여태 「여기에 백업 만들기」 버튼
    // 하나가 목록 아래에 있었는데, 어느 줄을 고르든 **바탕화면에 만들었다.**
    // 화면이 고를 수 있다고 말해 놓고 안 고르는 것은 그냥 거짓말이다.
    $("bk-places")
      .querySelectorAll<HTMLElement>("[data-dest]")
      .forEach((el) => {
        el.onclick = () => void doBackup(el.dataset.dest || "");
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

async function doBackup(destFolder = "") {
  // 아무것도 묻지 않는다. 폴더 경로를 타이핑하게 하는 것은 백업을 안 하게 하는
  // 가장 확실한 방법이었다. 바탕화면에 파일 하나로 만들고, 어디 뒀는지 알려준다.
  const node: any = await invoke("node_identity").catch(() => ({}));
  const today = new Date().toISOString().slice(0, 10);
  const label = [node?.name, today].filter(Boolean).join("-");

  $("bk-note").textContent = "백업 중…";
  try {
    const r = await invoke<any>("backup_zip", { destFolder, label, includeWallet: true });
    $("bk-result").innerHTML =
      `<div class="card" style="margin-top:11px">
         <h3>파일 하나로 만들었습니다</h3>
         <div class="kv"><b>${r.name}</b><span>${r.size_text}</span></div>
         <p class="meta">바탕화면에 있습니다. 이 파일 하나만 USB나 다른 컴퓨터에 옮겨 두시면
           됩니다 — 가게 전부가 들어 있습니다.</p>
         ${(r.inside || []).map((i: any) => `<div class="kv"><b>${i.name}</b><span>${i.what}</span></div>`).join("")}
       </div>` +
      (r.warning
        ? `<div class="warnbox" style="margin-top:9px">${r.warning}</div>`
        : "");
  } catch (e) {
    $("bk-result").innerHTML = `<div class="warnbox" style="margin-top:11px">${e}</div>`;
  }
  $("bk-note").textContent = "";
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
      $$("tn-detail").innerHTML =
        `<span class="warn">cloudflared가 없습니다</span> — 터미널에서 <code>brew install cloudflared</code>`;
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
    // 사장·직원·검표 QR에는 각각 다른 열쇠가 들어 있다. 손님 QR만 붙여도 된다.
    phoneQr =
      `<div class="qrbox">${adminQr}<div class="cap"><b>사장님만</b>돈·발행·설정 전부</div></div>` +
      `<div class="qrbox">${staffQr}<div class="cap"><b>직원</b>주문·회원확인만</div></div>` +
      `<div class="qrbox">${scanQr}<div class="cap"><b>검표 태블릿</b>문 앞에 두는 화면</div></div>` +
      `<div class="qrbox">${custQr}<div class="cap"><b>손님</b>카운터에 붙이세요</div></div>` +
      `<div class="meta" style="width:100%;margin-top:8px">${r.ip}:${r.port} · 폰을 같은 와이파이에 붙이고 찍으세요</div>` +
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
  const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim() || "";
  let rate: number | null = null;
  const currency = ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
  if (currency !== "RVN") {
    try {
      const r = await invoke<any>("rvn_rate", { currency });
      rate = r.rate;
    } catch {
      // 시세를 못 가져와도 메뉴는 보여야 한다. RVN 환산만 빠진다.
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
      // 간판이 IPFS 해시면 손님 폰이 읽을 수 있는 주소로 바꿔 준다.
      icon:
        shopIcon && shopIcon.startsWith("Qm")
          ? `http://${host}:8790/ipfs/${shopIcon}`
          : shopIcon,
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
  if (link) link.textContent = name || "내 가게";
  const title = document.querySelector("#page-shop .title");
  if (title) title.textContent = name || "내 가게";
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
    return `<div class="row" style="align-items:center; gap:8px; margin-top:6px">
      <span style="width:22px">${ko}</span>
      <input type="time" id="hr-o-${d}" value="${v.open || ""}" style="width:auto" />
      <span class="meta">–</span>
      <input type="time" id="hr-c-${d}" value="${v.close || ""}" style="width:auto" />
    </div>`;
  }).join("");
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
    ($("sh-confirm") as HTMLInputElement).placeholder = full;
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
  const btn = $("sh-go") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "등록 중…";
  const val = (id: string) => ($(id) as HTMLInputElement).value.trim();

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
      qty: 1,
      units: 0,
      reissuable: true, // 프로필을 나중에 고치려면 재발행이 필요하다
      ipfsHash: up.cid,
      toAddress: null,
    });

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
    pickup: ($("sh-pickup") as HTMLInputElement)?.checked ?? true,
    delivery: ($("sh-delivery") as HTMLInputElement)?.checked ?? false,
    payment_address: shopAddress,
    lat: shopCoords?.lat ?? null,
    lon: shopCoords?.lon ?? null,
    icon: shopIcon,
    currency: ($("mn-cur") as HTMLSelectElement)?.value || "KRW",
    hours: readHours(),
    closed_now: ($("sh-closednow") as HTMLInputElement)?.checked ?? false,
    closed_note: val("sh-closednote"),
    menu: menuItems,
  };
}

// 글자 하나마다 파일을 쓰지는 않는다. 손을 멈추면 쓴다.
let shopSaveTimer: number | undefined;
function saveShop() {
  clearTimeout(shopSaveTimer);
  shopSaveTimer = setTimeout(() => {
    invoke("shop_save", { shop: shopSnapshot() }).catch(() => {});
  }, 600) as unknown as number;
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
  set("mn-cur", sh.currency);
  const chk = (id: string, v: any) => {
    const el = $(id) as HTMLInputElement | null;
    if (el && v != null) el.checked = !!v;
  };
  chk("sh-pickup", sh.pickup);
  chk("sh-delivery", sh.delivery);
  chk("sh-closednow", sh.closed_now);
  set("sh-closednote", sh.closed_note);
  drawHours(sh.hours);

  if (sh.payment_address) shopAddress = sh.payment_address;
  if (sh.icon) shopIcon = sh.icon;
  if (sh.lat != null && sh.lon != null) shopCoords = { lat: sh.lat, lon: sh.lon };

  if (Array.isArray(sh.menu)) {
    menuItems.length = 0;
    sh.menu.forEach((m: any) => menuItems.push(m));
    renderMenu();
  }
}

// ── 메뉴판 ──
function curLabel() {
  const c = ($("mn-cur") as HTMLSelectElement)?.value || "KRW";
  return c === "KRW" ? "(원)" : c === "USD" ? "($)" : "(RVN)";
}

function renderMenu() {
  $("mn-items").innerHTML = menuItems
    .map(
      (it, i) => `<div class="mnitem">
        <div class="mnpic" data-mnpic="${i}" title="사진 ${it.image ? "바꾸기" : "올리기"}">
          ${
            it.image
              ? `<img src="http://127.0.0.1:8080/ipfs/${it.image}" alt=""
                      onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'못 읽음'}))" />`
              : "사진"
          }
        </div>
        <div><label>품목</label><input data-mn="name" data-i="${i}" value="${it.name || ""}" /></div>
        <div><label>가격 ${curLabel()}</label><input data-mn="price" data-i="${i}" type="number" step="any" value="${it.price ?? ""}" /></div>
        <div class="mnacts">
          <button class="ghost" data-mnpic="${i}">${it.image ? "사진 바꾸기" : "사진"}</button>
          <button class="ghost" data-mndel="${i}">삭제</button>
        </div>
      </div>`
    )
    .join("");

  $("mn-items")
    .querySelectorAll("[data-mn]")
    .forEach((el) => {
      (el as HTMLInputElement).oninput = () => {
        const i = +(el as HTMLElement).dataset.i!;
        const k = (el as HTMLElement).dataset.mn!;
        menuItems[i][k] = k === "price" ? parseFloat((el as HTMLInputElement).value) : (el as HTMLInputElement).value;
        saveShop();
      };
    });
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
  $("mn-note").textContent = menuItems.length ? `품목 ${menuItems.length}개` : "";
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
      $("mn-note").textContent = "올렸습니다";
    } catch (e) {
      $("mn-note").innerHTML = `<span style="color:var(--bad)">${e}</span>`;
    }
  };
  input.click();
}

async function saveMenu() {
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
                p.settled && next
                  ? `<button data-state="${p.address}" data-to="${next}">${label}</button>`
                  : ""
              }${
                p.settled
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
            await invoke("set_order_state", { address: el.dataset.state, state: el.dataset.to });
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
window.addEventListener("DOMContentLoaded", () => {
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
    for (const [d] of WEEK) {
      if (d === 1) continue;
      const oi = $(`hr-o-${d}`) as HTMLInputElement;
      const ci = $(`hr-c-${d}`) as HTMLInputElement;
      if (oi) oi.value = o;
      if (ci) ci.value = c;
    }
    previewOpen();
  });
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
  $("tbl-print").addEventListener("click", async () => {
    const note = $("tbl-note");
    const raw = ($("tbl-list") as HTMLInputElement).value.trim();
    // 쉼표·띄어쓰기·줄바꿈 아무거나 받는다. 사장이 형식을 외우게 하지 않는다.
    const tables = raw ? raw.split(/[,\s]+/).filter(Boolean) : ["카운터"];
    note.textContent = "만드는 중…";
    try {
      const r = await invoke<any>("table_qr_sheet", { ip: serverIp || "127.0.0.1", tables });
      note.innerHTML = `<span class="ok">${escapeHtml(r.say)}</span> (${escapeHtml(r.path)})`;
    } catch (e) {
      note.innerHTML = `<span class="danger">${e}</span>`;
    }
  });

  $("sh-usetunnel").addEventListener("click", async () => {
    const note = $("sh-orderurlnote");
    try {
      const t: any = await invoke("tunnel_status");
      if (!t.url) {
        note.innerHTML = `<span class="warn">바깥 주소가 아직 없습니다. 「이 컴퓨터 → 바깥에서도 열리게」를 먼저 켜세요.</span>`;
        return;
      }
      ($("sh-orderurl") as HTMLInputElement).value = t.url;
      note.innerHTML = `<span class="warn">넣었습니다. 이 주소는 <b>임시입니다</b> — 터널을 다시 켜면 바뀌고, 그때는 재발행해야 고쳐집니다.</span>`;
    } catch (e) {
      note.innerHTML = `<span class="danger">${e}</span>`;
    }
  });
  $("sh-pic").addEventListener("click", pickShopPhoto);
  $("dr-q").addEventListener("input", () => {
    clearTimeout(doorTimer);
    doorTimer = setTimeout(doorSearch, 200);
  });
  $("dr-new").addEventListener("click", () => openMember());
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
  loadBackup();
  $("abk-new").addEventListener("click", () => void newAddrWithName());
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
  $("chat-open").addEventListener("click", () => $("chat").classList.remove("hidden"));
  $("chat-close").addEventListener("click", () => $("chat").classList.add("hidden"));
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
  $("mn-add").addEventListener("click", () => {
    menuItems.push({ name: "", price: null, image: null });
    renderMenu();
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
  loadShop();

  // 손님 폰 서버를 스스로 켠다.
  //
  // 이 프로그램의 자리는 모니터 없는 맥미니다. 정전이나 업데이트로 앱이 다시
  // 뜨면 스위치는 꺼진 채 시작하는데, 켤 화면이 없다 — 손님도 사장도 접속하지
  // 못하고, 가게는 멈춘 줄도 모른 채 멈춘다.
  //
  // 전에 한 번 켠 적이 있으면 다시 켠다. 한 번도 안 켠 컴퓨터는 건드리지
  // 않는다 — 켠 적 없는 서버가 저절로 열리는 것은 다른 종류의 사고다.
  if (localStorage.getItem(PHONE_KEY) === "1") {
    startPhone().catch(() => {});
  }

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
        if (!r?.swept) return;
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
  loadAssets();
  // Status is cheap; the IPFS scan is not, and is deliberately not on a timer.
});
