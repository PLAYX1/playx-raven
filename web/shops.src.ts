//! 가게 목록 화면의 「물건」 탭.
//!
//! 가게는 체인에서, 물건은 Nostr 에서 온다. 손님에게는 둘 다 "여기서 살 수
//! 있는 것" 이므로 한 화면에 둔다 — 어디에 저장되는지는 우리 사정이다.

import { query, tag, KIND_LISTING, type NostrEvent } from "./nostr";

/**
 * geohash → 대략의 위도·경도.
 *
 * 매물 348건을 실측해 보니 **125건에 `g` 태그(geohash)** 가 실려 온다. 그게
 * 거리순을 가능하게 하는 유일한 값이다 — `location` 은 "United States" 같은
 * 자유 문장이라 거리를 못 잰다.
 *
 * 정밀도는 앞 글자 수로 정해진다. 5글자면 약 2.4km 인데, 동네 장터에는 그
 * 정도면 충분하고 오히려 파는 사람의 집을 정확히 찍지 않아서 낫다.
 */
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashToLatLon(gh: string): { lat: number; lon: number } | null {
  let evenBit = true;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  for (const ch of gh.toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        bit === 1 ? (lonMin = mid) : (lonMax = mid);
      } else {
        const mid = (latMin + latMax) / 2;
        bit === 1 ? (latMin = mid) : (latMax = mid);
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
}

/** 이 매물이 레이븐 사람들 것인가. 아직 0건이지만, 생기면 맨 위로 온다. */
function isRaven(e: NostrEvent): boolean {
  const price = e.tags.find((t) => t[0] === "price");
  if (price && price[2] && /rvn|raven/i.test(price[2])) return true;
  return e.tags.some((t) => t[0] === "t" && /^(rvn|ravencoin)$/i.test(t[1] || ""));
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** NIP-99 의 image 태그는 여러 개 올 수 있다. 첫 장만 쓴다. */
function firstImage(e: NostrEvent): string {
  const t = e.tags.find((x) => x[0] === "image" && x[1] && /^https?:\/\//i.test(x[1]));
  return t ? t[1] : "";
}

function priceText(e: NostrEvent): string {
  const t = e.tags.find((x) => x[0] === "price");
  if (!t || !t[1]) return "";
  const n = Number(t[1]);
  const amount = Number.isFinite(n) ? n.toLocaleString() : t[1];
  return `${amount} ${t[2] || ""}`.trim();
}

let loaded = false;
/** 손님 위치. 가게 탭이 이미 물어봤으면 그 값을 그대로 쓴다. */
let me: { lat: number; lon: number } | null = null;
let rows: Array<{ e: NostrEvent; dist: number | null; raven: boolean }> = [];

function myPlace(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      // 거절해도 목록은 보여 준다. 위치를 안 주면 거리만 안 보일 뿐이다.
      () => res(null),
      { timeout: 8000, maximumAge: 300000 },
    );
  });
}

function draw(): void {
  if (!rows.length) {
    $("items").innerHTML = `<div class="empty">
        <img src="/raven-head.png" alt="" width="150" style="display:block;margin:0 auto 12px;border-radius:14px" />
        지금 올라온 물건이 없습니다.<br />첫 번째가 되실 수 있습니다.
      </div>`;
    return;
  }
  // 릴레이에서 300건 넘게 온다. 전부 그리면 문서가 5만 픽셀이 되고, 그건
  // 목록이 아니라 벽이다. 한 번에 보여줄 만큼만 그리고 나머지는 눌러서 연다.
  const PAGE = 30;
  let shown = Math.min(PAGE, rows.length);

  const paint = () => {
  $("items").innerHTML = rows
    .slice(0, shown)
    .map((r, i) => {
      const e = r.e;
      const img = firstImage(e);
      const title = tag(e, "title") || "(제목 없음)";
      const price = priceText(e);
      const where = tag(e, "location");
      return `<div class="icard" data-i="${i}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : `<div style="width:74px;height:74px;border-radius:10px;background:var(--panel);flex:none"></div>`}
        <div style="min-width:0">
          <div class="nm">${esc(title)}</div>
          ${price ? `<div class="pr">${esc(price)}</div>` : ""}
          <div class="de">${esc(e.content).slice(0, 140)}</div>
          <div class="tags">
            ${r.raven ? `<span class="tag" style="border-color:var(--fg);color:var(--fg)">레이븐</span>` : ""}
            ${r.dist != null ? `<span class="tag">${fmtDist(r.dist)}</span>` : ""}
            ${where ? `<span class="tag">${esc(where)}</span>` : ""}
            <span class="tag">${new Date(e.created_at * 1000).toLocaleDateString("ko-KR")}</span>
          </div>
        </div>
      </div>`;
    })
    .join("") +
    (shown < rows.length
      ? `<button id="more" class="btn" style="width:100%;margin-top:16px">
           ${rows.length - shown}건 더 보기</button>`
      : "");

  // 눌러서 자세히. 목록에서는 두 줄로 잘라 두었는데, 자른 줄만 보고 살지
  // 말지 정하라는 것은 무리다.
  $("items").querySelectorAll<HTMLElement>("[data-i]").forEach((el) => {
    el.onclick = () => openItem(rows[Number(el.dataset.i)]);
  });
  const more = document.getElementById("more");
  if (more)
    more.onclick = () => {
      shown = Math.min(shown + PAGE, rows.length);
      paint();
    };
  };
  paint();
}

// ── Ravi 에게 묻기 ─────────────────────────────────────────────────────────
//
// 여기 있는 사람은 사장이 아니라 **손님**이다. 그래서 가게 노드의 손님용
// 응대(`/api/ask`)를 쓴다 — 가게가 올린 정보로만 답하고, 하루 200회·3초
// 간격 제한이 이미 걸려 있다.
//
// ⚠️ rvn.ex.erci.se 에서 열면 가게 노드가 없다. 그때는 물어볼 곳이 없으므로
// 버튼을 아예 숨긴다 — 눌러도 안 되는 버튼은 고장으로 읽힌다.
function wireRaviAsk(): void {
  const btn = document.getElementById("ravi-ask");
  if (!btn) return;
  // 가게 노드에서 열렸을 때만 보인다.
  const local = /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)$/.test(location.hostname)
    || location.hostname.endsWith(".local");
  if (!local) {
    btn.style.display = "none";
    return;
  }
  btn.onclick = () => {
    const box = $("sheet");
    box.innerHTML = `<div class="sheetin ravisheet">
        <button class="sheetx" id="sheet-close">닫기</button>
        <h2 style="margin:0 0 4px;font-size:19px">Ravi에게 물어보기</h2>
        <p class="sub" style="margin:0">이 가게에 대해 물어보세요.</p>
        <div class="qa">
          <input id="ravi-q" placeholder="견과류 들어간 메뉴 있나요?" autocomplete="off" />
          <button id="ravi-go" style="width:100%;margin-top:10px">묻기</button>
        </div>
        <div class="ans" id="ravi-a"></div>
        <p class="foot" style="margin-top:14px">
          가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.
        </p>
      </div>`;
    box.style.display = "";
    $("sheet-close").onclick = () => (box.style.display = "none");
    box.onclick = (ev) => {
      if (ev.target === box) box.style.display = "none";
    };
    const ask = async () => {
      const q = ($("ravi-q") as HTMLInputElement).value.trim();
      if (!q) return;
      $("ravi-a").innerHTML = `<span class="sub">생각하는 중…</span>`;
      try {
        const r = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q }),
        }).then((x) => x.json());
        $("ravi-a").innerHTML = r?.error
          ? `<span class="sub">${esc(r.error)}</span>`
          : `<img src="/raven-head.webp" alt="" /><span></span>`;
        const span = $("ravi-a").querySelector("span");
        if (span && !r?.error) span.textContent = r.answer || "";
      } catch {
        $("ravi-a").innerHTML = `<span class="sub">지금은 답할 수 없습니다.</span>`;
      }
    };
    ($("ravi-go") as HTMLElement).onclick = () => void ask();
    ($("ravi-q") as HTMLInputElement).onkeydown = (e) => {
      if (e.key === "Enter") void ask();
    };
  };
}

function openItem(r: { e: NostrEvent; dist: number | null }): void {
  const e = r.e;
  const img = firstImage(e);
  const price = priceText(e);
  const box = $("sheet");
  box.innerHTML = `<div class="sheetin">
      <button class="sheetx" id="sheet-close">닫기</button>
      ${img ? `<img src="${esc(img)}" alt="" style="width:100%;border-radius:12px;margin-bottom:12px" />` : ""}
      <h2 style="margin:0 0 6px;font-size:19px">${esc(tag(e, "title") || "(제목 없음)")}</h2>
      ${price ? `<div style="font-size:17px;font-weight:600;margin-bottom:8px">${esc(price)}</div>` : ""}
      <div style="white-space:pre-wrap;line-height:1.8;font-size:15px">${esc(e.content)}</div>
      <div class="tags" style="margin-top:12px">
        ${r.dist != null ? `<span class="tag">${fmtDist(r.dist)}</span>` : ""}
        ${tag(e, "location") ? `<span class="tag">${esc(tag(e, "location"))}</span>` : ""}
        <span class="tag">${new Date(e.created_at * 1000).toLocaleString("ko-KR")}</span>
      </div>
      <!-- 파는 사람에게 말을 걸 길이 아직 없다. 없는 버튼을 그리는 대신
           그 사실을 적는다. -->
      <p class="foot" style="margin-top:16px">
        파는 사람에게 묻는 기능은 아직 준비 중입니다.
        올린 사람: <code style="word-break:break-all">${esc(e.pubkey.slice(0, 16))}…</code>
      </p>
    </div>`;
  box.style.display = "";
  $("sheet-close").onclick = () => (box.style.display = "none");
  box.onclick = (ev) => {
    if (ev.target === box) box.style.display = "none";
  };
}

async function loadItems(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    // 위치를 먼저 묻고 목록을 가져온다. 순서를 바꾸면 거리 없는 목록이 한 번
    // 그려졌다가 다시 그려져, 손가락 밑에서 줄이 움직인다.
    me = await myPlace();
    const evs = await query({ kinds: [KIND_LISTING], limit: 200 }, { ms: 8000 });

    rows = evs
      .filter((e) => tag(e, "status") !== "sold")
      .map((e) => {
        const gh = tag(e, "g");
        const at = gh ? geohashToLatLon(gh) : null;
        return {
          e,
          dist: me && at ? distanceM(me, at) : null,
          raven: isRaven(e),
        };
      });

    // 레이븐 사람들 것이 먼저, 그 다음 가까운 순, 좌표 없는 것은 뒤로.
    // 좌표가 없다고 0m 로 두면 맨 위로 올라와 "가까운 순" 이 거짓말이 된다.
    rows.sort((a, b) => {
      if (a.raven !== b.raven) return a.raven ? -1 : 1;
      const da = a.dist ?? Infinity, db = b.dist ?? Infinity;
      if (da !== db) return da - db;
      return b.e.created_at - a.e.created_at;
    });

    const near = rows.filter((r) => r.dist != null).length;
    $("count").textContent = me
      ? `${rows.length}개 · 거리를 아는 것 ${near}개`
      : `${rows.length}개 · 위치를 켜면 가까운 순으로 보여 드립니다`;
    draw();
  } catch (e) {
    // 파서 오류를 그대로 보여 주지 않는다. "Unexpected token '<'" 는 사람이
    // 할 수 있는 일이 하나도 없는 문장이다.
    $("items").innerHTML = `<div class="empty">
        물건을 불러오지 못했습니다.<br />잠시 뒤에 다시 열어 주세요.
      </div>`;
    loaded = false;
  }
}

function tabs(): void {
  // 아래 탭 바에서 「물건」으로 들어오면 그 탭이 열려 있어야 한다.
  // 바를 눌렀는데 가게 목록이 뜨면 사람은 바가 고장 났다고 읽는다.
  if (location.hash === "#items") {
    const b = document.querySelector<HTMLElement>('[data-tab="items"]');
    if (b) setTimeout(() => b.click(), 0);
  }

  wireRaviAsk();

  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => {
    b.onclick = () => {
      const which = b.dataset.tab!;
      document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      const isShops = which === "shops";
      $("list").style.display = isShops ? "" : "none";
      $("items").style.display = isShops ? "none" : "";
      // 개인이 파는 자리는 물건 탭에만. 목록 밖에 두는 이유는 render() 가
      // #items 를 통째로 갈아 끼우기 때문이다 — 안에 두면 매번 지워졌다.
      const cta = document.getElementById("sellcta");
      if (cta) cta.style.display = isShops ? "none" : "block";
      // 가게 탭에만 있는 것들을 물건 탭에서 치운다. 안 그러면 "가까운 순으로"
      // 가 물건 목록 위에 남아, 눌러도 아무 일이 안 일어난다.
      for (const id of ["q", "near", "locnote", "count"]) {
        const el = document.getElementById(id);
        if (el) (el.closest(".search, .row") || el).setAttribute(
          "style", isShops ? "" : "display:none",
        );
      }
      $("pagetitle").textContent = isShops ? "가게 찾기" : "물건 찾기";
      // 주소를 맞춰 둔다. 안 그러면 뒤로가기가 엉뚱한 탭으로 돌아온다.
      history.replaceState(null, "", isShops ? location.pathname : "#items");
      document.querySelectorAll(".tabbar a").forEach((a) => {
        const href = (a as HTMLAnchorElement).getAttribute("href") || "";
        a.classList.toggle("on", isShops ? href === "/shops" : href === "/shops#items");
      });
      if (!isShops) void loadItems();
    };
  });
}

tabs();
