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

/**
 * 지금 시세. 화면이 열릴 때 한 번만 가져와 둔다.
 *
 * ⚠️ **못 가져오면 0 이다.** 그러면 「이 물건 사기」가 안 그려진다 —
 * 틀린 금액이 미리 채워진 채로 지갑이 열리는 것이 제일 나쁘다.
 * 전화 단추는 그대로 나오므로 살 길이 아주 막히지는 않는다.
 */
const rates: Record<string, number> = {};

async function loadRate(cur: string): Promise<void> {
  if (rates[cur] !== undefined) return;
  try {
    const r = await fetch(`/api/rate?currency=${encodeURIComponent(cur)}`).then((x) => x.json());
    // 두 거래소가 크게 어긋나는 날은 값을 안 쓴다. 그런 날 물건을 사면
    // 어느 쪽 숫자로 샀는지 아무도 모른다.
    rates[cur] = r?.unstable || !r?.rate ? 0 : Number(r.rate);
  } catch {
    rates[cur] = 0;
  }
}

/** 원·달러를 RVN 으로. 시세를 모르면 0 — 부르는 쪽이 단추를 안 그린다. */
function rvnFor(amount: number, cur: string): number {
  const rate = rates[cur];
  if (!rate) return 0;
  // 소수 8자리가 RVN 의 끝이다. 더 잘게 적으면 노드가 조용히 반올림한다.
  return Math.round((amount / rate) * 1e8) / 1e8;
}

/**
 * 「이 물건 사기」.
 *
 * 🔴 파는 사람이 **받을 주소를 실어 뒀을 때만** 나온다. 없으면 그리지 않는다 —
 * 없는 단추를 그리면 눌러 보고 나서야 안 되는 걸 안다.
 *
 * 지갑으로 넘길 때 값을 RVN 으로 미리 바꿔 둔다. 원으로 넘기면 지갑이 시세를
 * 또 부르게 되고, 두 화면의 숫자가 어긋난다.
 *
 * ⚠️ 이 단추는 **에스크로가 아니다.** 누르면 진짜로 돈이 나가고 되돌릴 수 없다.
 * 그래서 아래에 "만나서, 물건을 보고" 를 같이 적는다.
 */
function buyButton(e: NostrEvent): string {
  const to = tag(e, "pay").trim();
  if (!/^R[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(to)) return "";
  const price = e.tags.find((t) => t[0] === "price");
  const n = Number(price?.[1]);
  const cur = (price?.[2] || "").toUpperCase();
  if (!isFinite(n) || n <= 0) return "";
  // 원·달러면 시세로 바꾼다. 못 바꾸면 단추를 안 그린다 — 틀린 금액이
  // 미리 채워진 채로 지갑이 열리는 것이 제일 나쁘다.
  const rvn = cur === "RVN" ? n : rvnFor(n, cur);
  if (!rvn) return "";
  const what = tag(e, "title").slice(0, 60);
  const q = new URLSearchParams({ to, rvn: String(rvn), what });
  return `<a class="cbtn buy" href="/wallet#pay?${q.toString()}">
      이 물건 사기
      <span class="sub2">${esc(String(Math.round(rvn)))} RVN · 개발비 1% 포함</span>
    </a>`;
}

/**
 * 파는 사람에게 말을 거는 자리.
 *
 * 🔴 여기가 없어서 이건 장터가 아니라 **게시판**이었다. 올려도 안 팔리고
 * 봐도 못 산다. 화면에는 "준비 중입니다" 와 공개키 앞 16자리만 있었는데,
 * 40~70대에게 `3bf0c63fcb934634…` 는 아무것도 아니다.
 *
 * ## 왜 전화·문자인가
 *
 * Nostr 에 1:1 문의(NIP-17)가 있지만, 그걸 쓰려면 사는 사람도 지갑을 만들고
 * 열어 두어야 한다. **동네에서 자전거 한 대 사는 사람에게 그건 벽이다.**
 * 전화는 이미 모두가 쓴다.
 *
 * ⚠️ 대신 **번호가 전 세계에 공개된다.** 릴레이는 누구나 읽고, 봇도 읽는다.
 * 한 번 나간 번호는 지워도 회수되지 않는다. 그래서 올릴 때 그 사실을 먼저
 * 보여주고(웹 지갑 「내 물건 팔기」), 여기서는 **적은 사람 것만** 보여 준다.
 * 안 적었으면 없는 대로 정직하게 말한다 — 가짜 단추를 그리지 않는다.
 */
function contactBlock(e: NostrEvent): string {
  const raw = tag(e, "phone").trim();
  // 숫자·+·- 만 남긴다. 남의 글자가 `tel:` 뒤에 그대로 들어가면 안 된다.
  const tel = raw.replace(/[^0-9+\-]/g, "");
  if (!tel || tel.replace(/\D/g, "").length < 8) {
    return `<div class="contact">
      ${buyButton(e)}
      <a class="cbtn call" href="/wallet#talk?to=${esc(e.pubkey)}">
        문의하기 <span class="sub2">번호 없이 · 잠겨서 갑니다</span>
      </a>
      <p class="foot" style="margin-top:10px">
        이 글에는 전화번호가 없습니다. <b>문의하기로 말을 거실 수 있어요</b> —
        번호를 주고받지 않아도 됩니다.
      </p>
    </div>`;
  }
  return `<div class="contact">
      ${buyButton(e)}
      <!-- 🔴 번호 없이 말을 걸 길. 개인이 자전거 한 대 파는데 번호를
           전 세계에 거는 것은 큰 값이다. -->
      <a class="cbtn" href="/wallet#talk?to=${esc(e.pubkey)}">
        문의하기 <span class="sub2">번호 없이 · 잠겨서 갑니다</span>
      </a>
      <a class="cbtn call" href="tel:${esc(tel)}">전화 걸기</a>
      <a class="cbtn" href="sms:${esc(tel)}">문자 보내기</a>
      <p class="foot" style="margin-top:10px">
        ${esc(raw)} · 파는 분이 직접 적은 번호입니다.
        <b>돈은 만나서, 물건을 보고 보내세요.</b>
      </p>
    </div>`;
}

/** 이 매물이 레이븐 사람들 것인가. 아직 0건이지만, 생기면 맨 위로 온다. */
function isRaven(e: NostrEvent): boolean {
  const price = e.tags.find((t) => t[0] === "price");
  if (price && price[2] && /rvn|raven/i.test(price[2])) return true;
  // 🔴 `playx` 가 빠져 있었다. `sellPublish` 는 우리 글에 `["t","playx"]` 를
  // 붙이는데 여기서 안 봐서, **우리 손으로 올린 물건이 맨 위로 못 왔다.**
  return e.tags.some((t) => t[0] === "t" && /^(rvn|ravencoin|playx)$/i.test(t[1] || ""));
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


// ── 찜·찾기 ─────────────────────────────────────────────────────────────
//
// 🔴 찜은 **이 폰에만** 저장한다. 서버에 두면 "누가 무엇을 눈여겨보는지" 를
// 우리가 갖게 되고, 그건 이 프로그램이 안 갖기로 한 종류의 정보다.
// 폰을 바꾸면 사라진다 — 그게 값이고, 화면에서 그렇게 말한다.

const FAV_KEY = "playx-fav";

function favs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function toggleFav(id: string): boolean {
  const f = favs();
  const on = !f.has(id);
  if (on) f.add(id);
  else f.delete(id);
  localStorage.setItem(FAV_KEY, JSON.stringify([...f]));
  return on;
}

/** 지금 화면에 걸린 찾는 말. */
let itemQuery = "";
/** 찜한 것만 볼 것인가. */
let favOnly = false;

/** 제목·설명·동네에서 찾는다. 띄어쓰기로 나눠 **전부 들어간** 것만. */
function matches(r: { title: string; body: string; where: string }, q: string): boolean {
  if (!q) return true;
  const hay = `${r.title} ${r.body} ${r.where}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function draw(): void {
  // 🔴 여기 검사가 **찜·찾기보다 먼저** 걸린다. 찜한 것이 없어서 빈 것인데
  // "지금 올라온 물건이 없습니다" 가 떴다 — 사람은 릴레이가 비었다고 읽는다.
  // 조건을 걸어 둔 상태면 아래 `paint` 가 맞는 말을 한다.
  if (!rows.length && !favOnly && !itemQuery) {
    // 🔴 `raven-head` 는 **얼굴만 잘라 둔 그림**이다(360x275). 빈 화면처럼
    // 큰 자리에 쓰면 아래가 없어 보인다 — 대표님이 "GPU 가 안 보인다" 고
    // 하신 것이 이것이다. 온전한 그림은 `raven-hello`(420x481) 이고,
    // 거기 GPU 가 들어 있다.
    $("items").innerHTML = `<div class="ravibox">
        <img src="/raven-hello.webp" alt="" />
        <div class="rt">지금 올라온 물건이 없습니다</div>
        <div class="rs">첫 번째가 되실 수 있습니다.<br />
          위 <b>내 물건 올리기</b> 를 눌러 보세요 — 공짜입니다.</div>
      </div>`;
    return;
  }
  // 릴레이에서 300건 넘게 온다. 전부 그리면 문서가 5만 픽셀이 되고, 그건
  // 목록이 아니라 벽이다. 한 번에 보여줄 만큼만 그리고 나머지는 눌러서 연다.
  const PAGE = 30;
  let shown = Math.min(PAGE, rows.length);

  const paint = () => {
  // 찾는 말과 찜 조건을 여기서 건다. 릴레이에 다시 묻지 않는다 —
  // 이미 받아 둔 것에서 고르는 일이라 즉시 반응해야 한다.
  const f = favs();
  const view = rows.filter(
    (r) =>
      (!favOnly || f.has(r.e.id)) &&
      matches(
        {
          title: tag(r.e, "title"),
          body: r.e.content || "",
          where: tag(r.e, "location"),
        },
        itemQuery,
      ),
  );
  shown = Math.min(shown, Math.max(view.length, PAGE));

  if (!view.length) {
    $("items").innerHTML = `<div class="ravibox">
        <img src="/raven-wait.webp" alt="" />
        <div class="rt">${favOnly ? "찜한 물건이 없습니다" : "찾으시는 것이 없습니다"}</div>
        <div class="rs">${
          favOnly
            ? "물건 옆 하트를 누르면 여기 모입니다."
            : "다른 말로 찾아보시거나, 위 X 를 눌러 전부 보세요."
        }</div>
      </div>`;
    return;
  }

  $("items").innerHTML = view
    .slice(0, shown)
    .map((r, i) => {
      const e = r.e;
      const img = firstImage(e);
      const title = tag(e, "title") || "(제목 없음)";
      const price = priceText(e);
      const where = tag(e, "location");
      // 🔴 하트는 카드 밖에 둔다. 안에 두면 물건을 열려다 찜이 눌린다.
      const faved = f.has(e.id);
      return `<div class="icard" data-i="${i}">
        <button class="fav ${faved ? "on" : ""}" data-fav="${esc(e.id)}"
                aria-label="${faved ? "찜 해제" : "찜하기"}">${faved ? "♥" : "♡"}</button>
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
    (shown < view.length
      ? `<button id="more" class="btn" style="width:100%;margin-top:16px">
           ${view.length - shown}건 더 보기</button>`
      : "");

  // 눌러서 자세히. 목록에서는 두 줄로 잘라 두었는데, 자른 줄만 보고 살지
  // 말지 정하라는 것은 무리다.
  $("items").querySelectorAll<HTMLElement>("[data-i]").forEach((el) => {
    el.onclick = (ev) => {
      // 🔴 하트를 눌렀는데 물건이 열리면 안 된다.
      if ((ev.target as HTMLElement)?.closest("[data-fav]")) return;
      openItem(view[Number(el.dataset.i)]);
    };
  });
  // 찜. 목록 전체를 다시 그리지 않고 그 하트만 바꾼다 — 다시 그리면
  // 스크롤이 맨 위로 튄다.
  $("items").querySelectorAll<HTMLElement>("[data-fav]").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const on = toggleFav(b.dataset.fav!);
      b.textContent = on ? "♥" : "♡";
      b.classList.toggle("on", on);
      b.setAttribute("aria-label", on ? "찜 해제" : "찜하기");
      // 찜한 것만 보는 중이면 그 자리에서 사라져야 말이 된다.
      if (favOnly && !on) paint();
    };
  });
  const more = document.getElementById("more");
  if (more)
    more.onclick = () => {
      shown = Math.min(shown + PAGE, view.length);
      paint();
    };
  };
  // 찾기·찜 단추가 이걸 부른다. 릴레이에 다시 묻지 않고 화면만 다시 그린다.
  repaintItems = paint;
  paint();
}

/** 찾기·찜이 누를 다시그리기. 목록을 그린 뒤에만 있다. */
let repaintItems: (() => void) | null = null;

// ── Ravi 에게 묻기 ─────────────────────────────────────────────────────────
//
// 여기 있는 사람은 사장이 아니라 **손님**이다. 그래서 가게 노드의 손님용
// 응대(`/api/ask`)를 쓴다 — 가게가 올린 정보로만 답하고, 하루 200회·3초
// 간격 제한이 이미 걸려 있다.
//
// ⚠️ rvn.ex.erci.se 에서 열면 가게 노드가 없다. 그때는 물어볼 곳이 없으므로
// 버튼을 아예 숨긴다 — 눌러도 안 되는 버튼은 고장으로 읽힌다.
/** 손님이 자기 AI 열쇠를 넣는 칸. **우리 몫이 떨어졌을 때만** 나타난다. */
function showKeyBox(): void {
  if (document.getElementById("ravi-key")) return;
  const box = document.getElementById("ravi-a");
  if (!box) return;
  const d = document.createElement("div");
  d.className = "keybox";
  // 🔴 여태 Groq 한 곳만 적어 뒀다. 이미 Grok 이나 Claude 열쇠를 가진
  // 사람이 "왜 Groq 만 있냐" 를 물었다. 다섯 곳 다 받는다 —
  // 어느 것을 넣든 **앞글자로 알아본다.**
  const WHERE: [string, string, string][] = [
    ["xAI (Grok)", "xai-", "https://console.x.ai/"],
    ["Anthropic (Claude)", "sk-ant-", "https://console.anthropic.com/settings/keys"],
    ["Google (Gemini)", "AIza", "https://aistudio.google.com/apikey"],
    ["OpenAI (ChatGPT)", "sk-", "https://platform.openai.com/api-keys"],
    ["Groq", "gsk_", "https://console.groq.com/keys"],
  ];
  d.innerHTML = `
    <div class="sub" style="margin-bottom:10px">
      <b>내 열쇠로 쓰기</b><br />
      아래 어느 곳이든 열쇠를 받아 넣으시면 한도 없이 물어보실 수 있어요.
      <b>Groq 은 공짜</b>이고, 나머지는 쓴 만큼 그 회사에 내십니다.
    </div>
    <div class="wherelist">
      ${WHERE.map(([name, pre, u]) =>
        `<a class="wrow" href="${u}" target="_blank" rel="noopener">
           <span class="wn">${esc(name)}</span>
           <span class="wp"><code>${esc(pre)}…</code></span>
           <span class="wg">받기 →</span>
         </a>`).join("")}
    </div>
    <p class="sub" style="margin:10px 0 0">
      받은 글자를 그대로 아래에 붙여 넣으세요. 어느 회사 것인지는
      <b>앞글자로 알아서 알아봅니다.</b>
    </p>
    <input id="ravi-key" type="password" autocomplete="off" spellcheck="false"
           placeholder="xai- · sk-ant- · AIza · sk- · gsk_ 로 시작하는 열쇠" />
    <button id="ravi-key-save" style="width:100%;margin-top:8px">저장하고 이어가기</button>
    <p class="foot" style="margin-top:10px">
      열쇠는 <b>이 브라우저에만</b> 저장됩니다. 우리 서버는 물어볼 때 잠깐 쓰고
      저장하지 않아요.<br />
      다만 이 화면은 지갑과 같은 곳에 있으니, <b>남의 컴퓨터에서는 넣지 마세요.</b>
    </p>`;
  box.appendChild(d);
  const inp = document.getElementById("ravi-key") as HTMLInputElement;
  inp.value = localStorage.getItem("ravi-key") || "";
  (document.getElementById("ravi-key-save") as HTMLElement).onclick = () => {
    const v = inp.value.trim();
    if (!v) {
      localStorage.removeItem("ravi-key");
      return;
    }
    localStorage.setItem("ravi-key", v);
    d.remove();
    // 깨어난 것을 **바로 보여 준다.** 단추가 그대로면 넣은 줄 모른다.
    const b = document.getElementById("ravi-ask");
    if (b) {
      b.classList.remove("asleep");
      const i = b.querySelector("img") as HTMLImageElement | null;
      if (i) i.src = "/raven-head.webp";
      const l = b.querySelector("span");
      if (l) l.textContent = "Ravi에게 물어보기";
    }
    // 넣자마자 다시 물어 준다. "저장했습니다" 만 뜨면 또 눌러야 한다.
    (document.getElementById("ravi-go") as HTMLElement)?.click();
  };
}


/** 찾기 칸과 찜 단추. 릴레이에 다시 묻지 않고 화면만 다시 그린다. */
function wireItemBar(): void {
  const q = document.getElementById("iq") as HTMLInputElement | null;
  const fo = document.getElementById("favonly");
  if (q) {
    // ⚠️ 한 글자마다 다시 그리면 긴 목록에서 버벅인다. 잠깐 기다렸다 한다.
    let t: number | undefined;
    q.oninput = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        itemQuery = q.value.trim();
        repaintItems?.();
      }, 180);
    };
  }
  if (fo) {
    fo.onclick = () => {
      favOnly = !favOnly;
      fo.setAttribute("aria-pressed", String(favOnly));
      fo.textContent = favOnly ? "♥ 찜" : "♡ 찜";
      repaintItems?.();
    };
  }
}

function wireRaviAsk(): void {
  const btn = document.getElementById("ravi-ask");
  if (!btn) return;
  // 🔴 여태 가게 노드 밖에서는 이 단추를 **숨겼다.** 그런데 배포된 옛
  // 번들에서는 보이기만 하고 눌러도 아무 일이 없었다 — 대표님이 겪은 것이
  // 그것이다.
  //
  // 이제 웹에도 라비가 있다(`rvn.ex.erci.se/api/ask`). 다만 **자세가 다르다**:
  // 가게 노드의 라비는 그 가게 직원이라 메뉴·영업시간을 답하고, 웹의 라비는
  // 가게가 없으므로 레이븐코인과 이 프로그램을 안내한다. 그래서 물어보라고
  // 적는 문구도 달라야 한다 — 웹에서 "이 가게에 대해 물어보세요" 라고 하면
  // 있지도 않은 가게 이야기를 기대하게 만든다.
  const local = /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)$/.test(location.hostname)
    || location.hostname.endsWith(".local");

  // 🔴 단추가 **자는지 깨어 있는지** 눌러 보기 전에 보여야 한다.
  // 물어볼 수 있는 자리가 있으면 깨어 있고, 없으면 자고 있다.
  // 자는 얼굴을 눌러도 열린다 — 거기서 열쇠를 넣으면 그 자리에서 깨어난다.
  void (async () => {
    const img = btn.querySelector("img") as HTMLImageElement | null;
    const lbl = btn.querySelector("span");
    const awake = await fetch("/api/ai-status")
      .then((r) => r.json())
      .then((j) => !!j?.awake)
      .catch(() => false)
      // 내 열쇠를 넣어 뒀으면 우리 몫과 상관없이 깨어 있다.
      .then((ok) => ok || !!localStorage.getItem("ravi-key"));
    btn.classList.toggle("asleep", !awake);
    if (img) img.src = awake ? "/raven-head.webp" : "/raven-sleep.webp";
    if (lbl) lbl.textContent = awake ? "Ravi에게 물어보기" : "Ravi 깨우기";
  })();

  btn.onclick = () => {
    const box = $("sheet");
    box.innerHTML = `<div class="sheetin ravisheet">
        <button class="sheetx" id="sheet-close">닫기</button>
        <h2 style="margin:0 0 4px;font-size:19px">Ravi에게 물어보기</h2>
        <p class="sub" style="margin:0">${local
          ? "이 가게에 대해 물어보세요."
          : "레이븐코인이든 이 프로그램이든 편하게 물어보세요."}</p>
        <!-- 🔴 화면 글자는 이미 네 나라 말인데(i18n.js) 라비만 한국어로
             답했다. 영어 화면을 보던 사람이 갑자기 한글을 만나면 고장으로 읽힌다. -->
        <div class="langpick">
          <label class="sub" for="ravi-lang">답할 말</label>
          <select id="ravi-lang">
            <option value="ko">한국어</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="zh">中文</option>
          </select>
        </div>
        <div class="qa">
          <input id="ravi-q" autocomplete="off" enterkeyhint="send"
                 placeholder="${local ? "견과류 들어간 메뉴 있나요?" : "레이븐코인이 뭔가요?"}" />
          <button id="ravi-go" style="width:100%;margin-top:10px">묻기</button>
        </div>
        <div class="ans" id="ravi-a"></div>
        <p class="foot" style="margin-top:10px">
          <a href="#" id="ravi-mykey">내 열쇠로 쓰기 →</a>
          <span class="sub">Groq 에서 공짜로 받으실 수 있어요</span>
        </p>
        <p class="foot" style="margin-top:14px">
          ${local
            ? "가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요."
            : "값이 오를지 내릴지는 답하지 않습니다. 그리고 지갑 12단어는 누구에게도 알려주지 마세요 — 저도 묻지 않습니다."}
        </p>
      </div>`;
    box.style.display = "";
    $("sheet-close").onclick = () => (box.style.display = "none");
    box.onclick = (ev) => {
      if (ev.target === box) box.style.display = "none";
    };
    // 화면이 이미 어느 말인지 안다. 라비도 거기서 시작한다.
    {
      const sel = $("ravi-lang") as HTMLSelectElement | null;
      const cur = localStorage.getItem("playx-lang")
        || (navigator.language || "ko").slice(0, 2);
      if (sel && ["ko", "en", "ja", "zh"].includes(cur)) sel.value = cur;
    }

    const ask = async () => {
      const q = ($("ravi-q") as HTMLInputElement).value.trim();
      if (!q) return;
      $("ravi-a").innerHTML = `<span class="sub">생각하는 중…</span>`;
      try {
        // 손님이 자기 열쇠를 넣어 뒀으면 같이 보낸다. 우리 몫이 다 떨어져도
        // 라비가 계속 깨어 있게 하는 길이다. 서버는 저장하지 않는다.
        const mine = localStorage.getItem("ravi-key") || "";
        const r = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: q,
            lang: (($("ravi-lang") as HTMLSelectElement | null)?.value) || "ko",
            ...(mine ? { key: mine } : {}),
          }),
        }).then((x) => x.json());
        $("ravi-a").innerHTML = r?.error
          ? `<span class="sub">${esc(r.error)}</span>`
          : `<img src="/raven-head.webp" alt="" /><span></span>`;
        const span = $("ravi-a").querySelector("span");
        if (span && !r?.error) span.textContent = r.answer || "";
        // 우리 몫이 떨어졌거나 열쇠가 안 먹었을 때만 열쇠 칸을 낸다.
        // 평소에 보이면 "이걸 넣어야 쓸 수 있나" 로 읽혀서 아무도 안 묻는다.
        if (r?.own) showKeyBox();
      } catch {
        $("ravi-a").innerHTML = `<span class="sub">지금은 답할 수 없습니다.</span>`;
      }
    };
    // 🔴 열쇠 칸을 **한도가 찼을 때만** 냈더니 "AI 설정이 어디냐" 를 세 번
    // 들었다. 못 찾는 설정은 없는 설정이다. 늘 보이되 작게 둔다 —
    // 평소에는 안 넣어도 되니까.
    const my = document.getElementById("ravi-mykey");
    if (my) {
      my.onclick = (ev) => {
        ev.preventDefault();
        showKeyBox();
      };
    }

    // 🔴 **자고 있으면 열쇠 칸을 바로 펼친다.** 자는 라비를 눌렀는데 또
    // 「내 열쇠로 쓰기」를 찾아 눌러야 하면, 그건 깨우는 길이 두 걸음인 것이다.
    // 자는 것을 눌렀다는 건 이미 "깨우고 싶다" 는 뜻이다.
    if (btn.classList.contains("asleep")) {
      $("ravi-a").innerHTML =
        `<div class="wakeline">라비가 자고 있어요. 열쇠를 넣으면 깨어납니다.</div>`;
      showKeyBox();
    }
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
      ${contactBlock(e)}
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
    // 값을 RVN 으로 바꿔야 「이 물건 사기」가 그려진다. 목록과 같이 가져온다.
    await Promise.all([loadRate("KRW"), loadRate("USD")]);
    const evs = await query({ kinds: [KIND_LISTING], limit: 200 }, { ms: 8000 });

    // 🔴 여태 **공개 릴레이의 모든 글**을 그대로 보여 줬다. 화면이 남의
    // 나라 자전거와 `180,000 sats`(비트코인 단위)로 가득했다 — 40~70대에게는
    // 못 읽고 못 사는 목록이고, 우리 지갑으로는 살 수도 없다.
    //
    // 남의 글로 활기를 연출하면 가짜 장터가 더 그럴듯해질 뿐이다. 우리 것이
    // 0개면 **0개라고 말하고 첫 사람을 부르는 편**이 낫다.
    //
    // `isRaven` 이 보는 것: 값이 RVN 이거나, `t` 태그가 rvn·ravencoin·playx.
    rows = evs
      .filter((e) => tag(e, "status") !== "sold")
      .filter(isRaven)
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

/** 주소의 해시(`#items`)에 맞는 탭을 켠다. 이미 그 탭이면 아무 일도 안 한다. */
function tabFromHash(): void {
  const want = location.hash === "#items" ? "items" : "shops";
  const b = document.querySelector<HTMLElement>(`[data-tab="${want}"]`);
  if (b && !b.classList.contains("on")) b.click();
}

function tabs(): void {
  // 아래 탭 바에서 「물건」으로 들어오면 그 탭이 열려 있어야 한다.
  // 바를 눌렀는데 가게 목록이 뜨면 사람은 바가 고장 났다고 읽는다.
  setTimeout(tabFromHash, 0);

  // 🔴 여기가 고장이었다. 하단 「물건」은 `/shops#items` 로 간다. **이미
  // `/shops` 에 있으면** 브라우저는 페이지를 다시 열지 않고 해시만 바꾼다 —
  // 위 검사는 처음 한 번만 도니까 아무 일도 일어나지 않았다. 대표님이 겪은
  // "물건 눌러도 안 눌러진다" 가 이것이다.
  //
  // 뒤로가기도 같은 길이다. `#items` 에서 뒤로 누르면 해시만 빠지므로,
  // 이 줄이 없으면 주소는 가게인데 화면은 물건인 채로 남는다.
  window.addEventListener("hashchange", tabFromHash);

  wireRaviAsk();
  wireItemBar();

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
      // 찾기·찜 줄도 물건 탭에서만. 가게 탭에는 이미 「가게 이름」 칸이 있다.
      const bar = document.getElementById("itembar");
      if (bar) bar.style.display = isShops ? "none" : "flex";
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
