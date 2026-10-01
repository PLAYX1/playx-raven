/* 「내 가게 → 지도에 올리기」 카드.
 *
 * 사장이 [올리기]를 누르면 이 컴퓨터가 서명한 이름표를 공개 릴레이에 올리고, 켜져 있는
 * 동안 5분마다 「영업 중」 신호를 보낸다(src-tauri/src/map.rs). 손님 폰 지도는 동네 칸
 * (geohash 5자리)으로 찾는다. 형식 정본은 폰 쪽 docs/MERCHANT-EVENT-FORMAT.md.
 *
 * 🔴 올리는 것은 이름·업종·5자리 동네·가게 링크·영업 신호뿐 — 화면에 한 줄로 적는다.
 *    정확한 주소·좌표는 이 카드 어디에도 없다(동네는 표에서 고르거나 5자리 코드만).
 * 🔴 라비는 **준비만** 한다(prepare). 게시는 사장이 [올리기]를 눌러야 한다.
 */
import { setCopyText, t, tf } from "./i18n";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 폰 `MERCHANT_CATEGORIES` 와 같은 값·순서. 이름은 한국어 원문(번역 열쇠). */
export const MAP_CATEGORIES: ReadonlyArray<{ key: string; name: string }> = [
  { key: "food", name: "음식" },
  { key: "grocery", name: "과일·채소" },
  { key: "cafe", name: "카페" },
  { key: "fitness", name: "운동·체육관" },
  { key: "living", name: "생활" },
  { key: "repair", name: "수리" },
  { key: "education", name: "배움" },
  { key: "other", name: "기타" },
];

/** 폰 `core/market/merchants/areas.ts` 25곳 그대로(좌표는 옮기지 않는다). map_format.rs `AREAS` 와 같다. */
export const MAP_AREAS: ReadonlyArray<{ name: string; group: string; area: string }> = [
  { name: "의왕시", group: "의왕", area: "wydk3" },
  { name: "의왕 내손동", group: "의왕", area: "wydk9" },
  { name: "의왕 부곡동", group: "의왕", area: "wydk2" },
  { name: "안양 만안구", group: "안양·군포·과천", area: "wydk8" },
  { name: "안양 동안구", group: "안양·군포·과천", area: "wydk8" },
  { name: "군포시", group: "안양·군포·과천", area: "wydk8" },
  { name: "과천시", group: "안양·군포·과천", area: "wydkc" },
  { name: "수원 장안구", group: "수원", area: "wydk4" },
  { name: "수원 권선구", group: "수원", area: "wyd7c" },
  { name: "수원 팔달구", group: "수원", area: "wydk4" },
  { name: "수원 영통구", group: "수원", area: "wyd7g" },
  { name: "성남 수정구", group: "성남", area: "wydmj" },
  { name: "성남 중원구", group: "성남", area: "wydkv" },
  { name: "성남 분당구", group: "성남", area: "wydks" },
  { name: "서울 강남구", group: "서울", area: "wydm7" },
  { name: "서울 서초구", group: "서울", area: "wydm4" },
  { name: "서울 송파구", group: "서울", area: "wydmk" },
  { name: "서울 관악구", group: "서울", area: "wydm0" },
  { name: "서울 동작구", group: "서울", area: "wydm2" },
  { name: "서울 영등포구", group: "서울", area: "wydjr" },
  { name: "서울 마포구", group: "서울", area: "wydjx" },
  { name: "서울 종로구", group: "서울", area: "wydmc" },
  { name: "서울 용산구", group: "서울", area: "wydm9" },
  { name: "서울 강서구", group: "서울", area: "wydjw" },
  { name: "서울 노원구", group: "서울", area: "wydq5" },
];

const AREA_PATTERN = /^[0-9b-hjkmnp-z]{5}$/;
export const isArea = (v: unknown): v is string => typeof v === "string" && AREA_PATTERN.test(v);

/** 이름 일부로 찾기(공백 무시). 5자리 코드를 넣으면 그 칸 자체 — 폰 `findAreas` 와 같다. */
export function findAreas(query: string): { name: string; area: string; known: boolean }[] {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return [];
  if (isArea(q)) {
    const known = MAP_AREAS.filter((a) => a.area === q).map((a) => ({ name: a.name, area: a.area, known: true }));
    return known.length ? known : [{ name: q, area: q, known: false }];
  }
  return MAP_AREAS.filter((a) => a.name.replace(/\s+/g, "").toLowerCase().includes(q)).map((a) => ({ name: a.name, area: a.area, known: true }));
}

/** 라비용 — 표에 있는 칸(5자리) 또는 표의 동네 이름(공백 무시, 정확히)만. 아니면 null(거절). */
export function resolveKnownArea(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const q = v.replace(/\s+/g, "").toLowerCase();
  const hit = MAP_AREAS.find((a) => a.area === q || a.name.replace(/\s+/g, "") === q);
  return hit ? hit.area : null;
}

export function areaLabel(area: string): string {
  const names = MAP_AREAS.filter((a) => a.area === area).map((a) => t(a.name));
  return names.length ? names.join(" · ") : t("이름 없는 칸");
}


export type MapCard = {
  /** 처음 그리기·다시 읽기. */
  refresh(): Promise<void>;
  /** 라비 `map_register_prepare` — 칸만 채운다. 게시는 사장이 [올리기]. 실패면 이유(한국어 원문). */
  prepare(a: { name?: unknown; category?: unknown; area?: unknown }): { ok: boolean; message: string };
  /** 「영업 중」/「지금 닫기」를 바꾼 뒤 — 저장이 끝난 다음 신호를 바로 보낸다. */
  openChanged(): void;
};

export function wireMapCard(deps: { invoke: Invoke; showShop: () => void }): MapCard {
  const $ = (id: string) => document.getElementById(id);
  const card = $("mp-card");
  const nameEl = $("mp-name") as HTMLInputElement | null;
  const urlEl = $("mp-url") as HTMLInputElement | null;
  const codeEl = $("mp-areacode") as HTMLInputElement | null;
  const queryEl = $("mp-areaq") as HTMLInputElement | null;
  let category = "";
  let area = "";
  let registered = false;
  let tunnelUrl = "";
  let checkTimer: number | undefined;

  const say = (id: string, render: () => string, cls = "") => {
    const el = $(id);
    if (!el) return;
    el.className = `meta ${cls}`.trim();
    setCopyText(el, render);
  };

  function chip(label: string, pressed: boolean, onClick: () => void, title = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("aria-pressed", String(pressed));
    b.textContent = label; // 한국어 원문 — 화면 번역기가 옮긴다
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function paintCategories() {
    const box = $("mp-cats");
    box?.replaceChildren(...MAP_CATEGORIES.map((c) => chip(c.name, c.key === category, () => { category = c.key; paintCategories(); schedule(); })));
  }

  function paintAreas() {
    const box = $("mp-areas");
    if (!box) return;
    const q = queryEl?.value || "";
    const list = q.trim() ? findAreas(q) : MAP_AREAS.map((a) => ({ name: a.name, area: a.area, known: true }));
    if (!list.length) {
      const p = document.createElement("span");
      p.className = "meta";
      setCopyText(p, () => t("표에 없는 동네예요. 아래 「지역 코드 직접 넣기」를 써 주세요."));
      box.replaceChildren(p);
      return;
    }
    box.replaceChildren(
      ...list.map((a) => chip(a.known ? a.name : a.area, a.area === area, () => { area = a.area; if (codeEl) codeEl.value = ""; paintAreas(); schedule(); }, a.area)),
    );
  }

  const draft = () => ({
    name: nameEl?.value ?? "",
    category,
    area,
    shop_url: urlEl?.value ?? "",
  });

  function schedule() {
    clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => void check(), 250);
  }

  async function check() {
    let r: any;
    try {
      r = await deps.invoke("map_check", { draft: draft() });
    } catch (e) {
      say("mp-problems", () => String((e as Error)?.message ?? e), "bad");
      return;
    }
    const problems: string[] = Array.isArray(r?.problems) ? r.problems : [];
    // 아직 안 고른 칸은 「문제」가 아니라 「할 일」이다 — 처음부터 빨간 줄을 띄우지 않는다.
    const shown = problems.filter((p) => !(p === "업종을 골라 주세요." && !category) && !(p.startsWith("동네는") && !area) && !(p.startsWith("가게 이름") && !draft().name));
    say("mp-problems", () => shown.map((p) => t(p)).join(" "), shown.length ? "bad" : "");
    const go = $("mp-go") as HTMLButtonElement | null;
    if (go) go.disabled = problems.length > 0;
    paintPreview(r?.preview ?? {});
    const url = String(r?.preview?.shopUrl ?? "");
    if (r?.temporary_url) {
      say("mp-urlnote", () => t("임시 주소예요 — 재시작마다 바뀌어 지도에서 열리지 않아요. 켜져 있는 동안은 바뀐 주소로 다시 올리지만, 그 사이 손님은 헛걸음해요. 고정 이름 터널(내 도메인)을 쓰세요."), "warn");
      ($("mp-fixed") as HTMLElement | null)?.removeAttribute("hidden");
    } else if (!url) {
      say("mp-urlnote", () => t("가게 링크가 없으면 지도에는 보이지만 손님이 가게를 열 수 없어요. 「바깥 연결」을 켜거나 고정 주소를 넣어 주세요."), "warn");
      ($("mp-fixed") as HTMLElement | null)?.removeAttribute("hidden");
    } else {
      say("mp-urlnote", () => t("고정 주소예요. 손님 지도의 [가게 열기]가 이 주소를 엽니다."));
      ($("mp-fixed") as HTMLElement | null)?.setAttribute("hidden", "");
    }
    const useTunnel = $("mp-usetunnel") as HTMLButtonElement | null;
    if (useTunnel) useTunnel.hidden = !tunnelUrl || tunnelUrl === url;
  }

  function paintPreview(p: any) {
    const box = $("mp-preview");
    if (!box) return;
    const row = (label: string, value: string, userText = false) => {
      const d = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = label;
      const v = document.createElement("span");
      v.textContent = value;
      if (userText) v.setAttribute("translate", "no"); // 사장이 적은 글은 옮기지 않는다
      d.append(b, " ", v);
      return d;
    };
    const cat = MAP_CATEGORIES.find((c) => c.key === p.category);
    box.replaceChildren(
      row("가게 이름", p.name || "—", true),
      row("업종", cat ? cat.name : "—"),
      row("동네", isArea(p.area) ? `${areaLabel(p.area)} (${p.area}) · ${t("약 5km 칸")}` : "—"),
      row("가게 링크", p.shopUrl || t("없음"), true),
      row("영업 신호", t("이 컴퓨터가 켜져 있는 동안 5분마다")),
    );
  }

  async function paintState() {
    let s: any;
    try {
      s = await deps.invoke("map_status");
    } catch {
      return;
    }
    registered = !!s?.registered;
    const down = $("mp-down") as HTMLButtonElement | null;
    if (down) down.hidden = !registered;
    const go = $("mp-go");
    if (go) setCopyText(go, () => t(registered ? "고친 내용 다시 올리기" : "올리기"));
    const ago = (sec: number) => {
      const m = Math.max(1, Math.floor((Date.now() / 1000 - sec) / 60));
      return m < 60 ? tf("{0}분 전", m) : tf("{0}시간 전", Math.floor(m / 60));
    };
    if (!registered) return say("mp-state", () => t("지도: 안 올림"));
    if (s.closed) return say("mp-state", () => t("지도: 올림 · 지금 닫음 — 손님 지도에는 「쉬는 중」으로 보여요"), "warn");
    if (s.beat_ok_at > 0) return say("mp-state", () => tf("지도: 올림 · 영업 중 신호 {0} 보냄", ago(s.beat_ok_at)), "good");
    say("mp-state", () => t("지도: 올림 · 아직 신호를 못 보냈어요 — 5분마다 조용히 다시 해요"), s.last_error ? "warn" : "");
  }

  async function refresh() {
    let r: any;
    try {
      r = await deps.invoke("map_load");
    } catch {
      return;
    }
    tunnelUrl = String(r?.tunnel_url ?? "");
    if (nameEl && !nameEl.value) nameEl.value = String(r?.name ?? "");
    if (!category) category = String(r?.category ?? "");
    if (!area) area = String(r?.area ?? "");
    if (urlEl && !urlEl.value) urlEl.value = String(r?.shop_url ?? "");
    const who = $("mp-issuer");
    if (who) {
      who.textContent = r?.issuer ? String(r.issuer) : "";
      who.setAttribute("translate", "no");
    }
    paintCategories();
    paintAreas();
    await check();
    await paintState();
  }

  if (card) {
    nameEl?.addEventListener("input", schedule);
    urlEl?.addEventListener("input", schedule);
    queryEl?.addEventListener("input", paintAreas);
    codeEl?.addEventListener("input", () => {
      const v = codeEl.value.trim().toLowerCase();
      if (isArea(v)) {
        area = v;
        paintAreas();
        schedule();
      } else if (v) {
        say("mp-problems", () => t("동네는 5자리 지역 코드만 쓸 수 있어요. 정확한 위치는 받지 않아요."), "bad");
      }
    });
    $("mp-usetunnel")?.addEventListener("click", () => {
      if (urlEl && tunnelUrl) urlEl.value = tunnelUrl;
      schedule();
    });
    $("mp-go")?.addEventListener("click", async () => {
      try {
        await deps.invoke("map_publish", { draft: draft() });
        say("mp-state", () => t("올렸어요. 손님 지도에 곧 보입니다 — 이 컴퓨터가 켜져 있는 동안 「영업 중」으로 떠요."), "good");
        setTimeout(() => void paintState(), 8000);
        window.dispatchEvent(new Event("rv-map-changed"));
      } catch (e) {
        say("mp-problems", () => t(String((e as Error)?.message ?? e)), "bad");
      }
    });
    $("mp-down")?.addEventListener("click", async () => {
      if (!confirm(t("지도에서 내릴까요? 손님 지도에서 가게와 「영업 중」 표시가 사라집니다."))) return;
      try {
        await deps.invoke("map_unpublish");
        say("mp-state", () => t("지도에서 내렸어요."));
        window.dispatchEvent(new Event("rv-map-changed"));
        await paintState();
      } catch (e) {
        say("mp-problems", () => t(String((e as Error)?.message ?? e)), "bad");
      }
    });
    // 5분마다 상태 줄만 다시 그린다(신호는 노드가 보낸다).
    setInterval(() => { if (!document.hidden) void paintState(); }, 60_000);
  }

  return {
    refresh,
    prepare(a) {
      const name = typeof a.name === "string" ? a.name.trim().slice(0, 40) : "";
      const cat = MAP_CATEGORIES.find((c) => c.key === a.category);
      const known = resolveKnownArea(a.area);
      if (!cat) return { ok: false, message: "지도 올리기 준비를 못 했습니다 — 업종을 다시 말씀해 주세요" };
      if (!known) return { ok: false, message: "지도 올리기 준비를 못 했습니다 — 동네 표에 없는 동네입니다. 화면에서 직접 골라 주세요" };
      deps.showShop();
      if (nameEl && name) nameEl.value = name;
      category = cat.key;
      area = known;
      if (codeEl) codeEl.value = "";
      if (queryEl) queryEl.value = "";
      paintCategories();
      paintAreas();
      void refresh();
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      $("mp-go")?.classList.add("flash");
      setTimeout(() => $("mp-go")?.classList.remove("flash"), 4000);
      return { ok: true, message: "지도에 올릴 내용을 채웠습니다 — 확인하고 [올리기]는 사장님이 누릅니다" };
    },
    openChanged() {
      // 「지금 닫기」 저장(0.6초 묶음) 뒤에 보내야 노드가 바뀐 값을 읽는다.
      setTimeout(() => {
        void deps.invoke("map_presence_now").catch(() => {});
        setTimeout(() => void paintState(), 9000);
      }, 1500);
    },
  };
}
