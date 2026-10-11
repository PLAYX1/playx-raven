/* 이야기 방 운영 (0.9.0 레인 C) — 「방 설정」(만든 사람만: 이름·한 줄 설명 고치기)과 「이 방 숨기기」(내 화면만).
 *
 * main.ts 에는 **연결 줄만** 둔다(talkPaintRooms·paintInvite·talkPaintMe 끝에서 부름). 레인 A 가 고치는
 * 이야기 화면(이름 카드·내 글 이름)과 파일이 겹치지 않게 여기로 뗐다.
 *
 * 이 파일은 시작 묶음(main)에 들어간다 — 그래서 **작게** 둔다: 숨긴 방 저장·목록 거르기·단추 세 개.
 * 시트(이름 고치기·숨긴 방 목록·숨기기 확인)는 누를 때 읽는 지연 묶음 `talk-rooms-admin-sheet.ts` 다
 * (메모리 예산: 가장 큰 묶음 ≤ 1000KB, scripts/memory-budget.json — 0.8.9 기준 main 이 993KB).
 *
 * ## 🔴 「지우기」는 없다
 *
 * 공개 릴레이에 올라간 방은 우리가 지울 수 없다. 삭제 요청(kind 5)은 부탁일 뿐이라 「지웠습니다」라고
 * 말할 수 없다 — 그래서 단추는 **숨기기(이 컴퓨터만)** 와 **이름 바꾸기(만든 사람만)** 두 가지뿐이다.
 *
 * ## 숨긴 방은 어디에 — `localStorage`
 *
 * 「안 보기」 명단(`playx-raven-talk-mute`)과 같은 종류다. 돈도 열쇠도 아니고, 없어져도 방이 다시
 * 보일 뿐 잃는 것이 없다. **다른 사람 화면·다른 기기에는 아무 영향이 없다** — 화면이 그렇게 말한다.
 */
import "./talk-rooms-admin-core.css";
import { DICT } from "./dict";
import { t, tf, setCopyText } from "./i18n";

/** 화면이 받는 방 하나(`talk_rooms`). `pubkey` 는 러스트가 서명을 확인한 만든 사람(없으면 ""). */
export type TalkRoom = {
  id: string;
  name: string;
  about?: string;
  asset?: string;
  pubkey?: string;
  meta_at?: number | null;
  [k: string]: unknown;
};
export type HiddenRoom = { at: number; name: string };

export const HIDDEN_KEY = "playx-raven-talk-hidden-rooms";
/** main.ts 「어느 방을 지켜볼까」 의 저장 열쇠. 숨긴 방은 알림도 안 울리게 여기서 뺀다. */
const WATCH_KEY = "playx-raven-talk-watch";
/** 대표의 공식 방 번호. 회사 열쇠로 만들면 여기에 적는다(설계안 「대표가 정할 것 1번」). 지금은 비어 있다. */
export const OFFICIAL_ROOM_IDS: readonly string[] = [];
export const ROOM_NAME_MAX = 40;
export const ROOM_ABOUT_MAX = 80;

// 시작 묶음에 드는 문구는 이 셋뿐이다. 나머지는 시트 묶음(talk-rooms-admin-copy.ts)에 있다.
const CORE_COPY: Record<string, [string, string, string]> = {
  "방 설정": ["Room settings", "ルーム設定", "房间设置"],
  "이 방 숨기기": ["Hide this room", "このルームを非表示", "隐藏此房间"],
  "숨긴 방 {0}": ["Hidden rooms {0}", "非表示のルーム {0}", "已隐藏的房间 {0}"],
};
for (const [source, values] of Object.entries(CORE_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

/* ── 숨긴 방 저장 ─────────────────────────────────────────────────────── */

export function loadHidden(): Record<string, HiddenRoom> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "{}");
    // 깨진 값이 있어도 이야기 화면은 열려야 한다.
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, HiddenRoom>;
  } catch {
    /* 못 읽으면 아무것도 숨기지 않는다 — 방이 다시 보일 뿐 잃는 것은 없다 */
  }
  return {};
}

function saveHidden(h: Record<string, HiddenRoom>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(h));
  } catch {
    /* 저장을 못 해도 이번 판은 숨겨진다. 다음에 켜면 다시 보일 뿐이다 */
  }
}

export function hideRoom(id: string, name: string): void {
  if (!id) return; // 「레이븐 이야기」(전체 글)는 방이 아니라 숨길 수 없다
  const h = loadHidden();
  h[id] = { at: Date.now(), name: String(name || "") };
  saveHidden(h);
  // 숨긴 방은 지켜보지 않는다 — 숨겨 놓고 알림이 울리면 그게 제일 이상하다.
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
    if (Array.isArray(v)) localStorage.setItem(WATCH_KEY, JSON.stringify(v.filter((r) => String(r || "") !== id)));
  } catch {
    /* 못 지워도 숨기기는 된다 */
  }
}

export function unhideRoom(id: string): void {
  const h = loadHidden();
  if (!h[id]) return;
  delete h[id];
  saveHidden(h);
}

/** 공식 방인가. 번호가 정해지기 전에는 이름으로도 본다(숨기기 전 한 번 더 묻는 데만 쓴다 — 표시용 아님). */
export function isOfficialRoom(room: { id?: string; name?: string } | undefined): boolean {
  if (!room) return false;
  if (room.id && OFFICIAL_ROOM_IDS.includes(room.id)) return true;
  const n = String(room.name || "").toLowerCase().replace(/\s+/g, "");
  return n.includes("ravenvault") || n.includes("레이븐볼트");
}

/** 내가 만든 방인가 — 러스트가 서명을 확인한 만든 사람과 내 이야기 공개키가 같을 때만. */
export function canEditRoom(room: TalkRoom | undefined, me: string): boolean {
  return !!(room && room.id && me && room.pubkey && room.pubkey === me);
}

/* ── 연결 ─────────────────────────────────────────────────────────────── */

export interface AdminDeps {
  /** 공통 경고 상자를 붙이지 않는 invoke — 잠김 안내는 시트 안에서 한다. */
  call<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  me(): string;
  current(): string;
  sure(title: string, message: string, ok: string): Promise<boolean>;
  /** 기존 「지갑 열기」(ensureUnlocked). 새 암호 입력 경로를 만들지 않는다. */
  unlock(why: string): Promise<boolean>;
  errText(e: unknown): string;
  reload(): unknown;
  /** 지금 보던 방을 숨겼을 때 「레이븐 이야기」로 돌아간다. */
  leave(): void;
}

/** 시트 묶음에 넘기는 것. */
export interface AdminCore {
  deps: AdminDeps;
  room(id: string): TalkRoom | undefined;
  /** 방금 바꾼 이름을 릴레이가 아직 안 돌려줘도 목록에 바로 보이게. */
  setOverride(id: string, name: string, about: string): void;
  paint(): void;
}

export interface AdminApi {
  /** 방 목록을 받아 기억하고, 숨긴 방을 뺀 목록을 돌려준다(방금 바꾼 이름도 반영). */
  rooms(list: TalkRoom[]): TalkRoom[];
  /** 머리줄 「방 설정」·더 보기 「이 방 숨기기」·목록 아래 「숨긴 방 N」을 지금 방에 맞춘다. */
  paint(): void;
}

type Sheet = import("./talk-rooms-admin-sheet").Sheet;

export function wireTalkRoomsAdmin(deps: AdminDeps): AdminApi {
  const all = new Map<string, TalkRoom>();
  const overrides = new Map<string, { name: string; about: string; at: number }>();
  let sheet: Sheet | null = null;
  let loading: Promise<Sheet | null> | null = null;
  let shownFor = "";

  const core: AdminCore = {
    deps,
    room: (id) => {
      const r = all.get(id);
      const o = overrides.get(id);
      return r && o ? { ...r, name: o.name, about: o.about } : r;
    },
    setOverride: (id, name, about) => overrides.set(id, { name, about, at: Math.floor(Date.now() / 1000) }),
    paint: () => paint(),
  };

  // 🔴 읽기에 실패해도 이야기 화면은 죽지 않는다(지연 조각 실패 = 페이지 사망 사고 이력). 다음 누름에 다시 시도.
  const load = (): Promise<Sheet | null> => {
    if (!loading) {
      loading = import("./talk-rooms-admin-sheet")
        .then((m) => (sheet = m.createSheet(core)))
        .catch((e) => { console.warn("talk-rooms-admin load failed", e); loading = null; return null; });
    }
    return loading;
  };

  const button = (id: string, host: Element | null, after: Element | null, label: () => string): HTMLButtonElement | null => {
    let b = document.getElementById(id) as HTMLButtonElement | null;
    if (b || !host) return b;
    b = document.createElement("button");
    b.type = "button";
    b.className = "ghost";
    b.id = id;
    setCopyText(b, label);
    if (after && after.parentElement === host) after.after(b);
    else host.append(b);
    return b;
  };

  function paint(): void {
    const cur = deps.current();
    const room = cur ? core.room(cur) : undefined;
    const mine = canEditRoom(room, deps.me());

    // ① 머리줄 「방 설정」 — **내가 만든 방에서만.** 남의 방에서 눌러 봐야 할 수 있는 일이 없다.
    //    자리는 시안(talk.html)대로 「초대하기」 바로 뒤, id 도 시안의 infobtn.
    const head = document.querySelector("#page-talk .chathead");
    const info = button("infobtn", head, document.getElementById("tk-invite"), () => t("방 설정"));
    if (info && !info.dataset.wired) {
      info.dataset.wired = "1";
      info.setAttribute("aria-haspopup", "dialog");
      info.setAttribute("aria-controls", "info");
      info.setAttribute("aria-expanded", "false");
      info.addEventListener("click", () => {
        if (sheet?.isOpen()) sheet.close();
        else void load().then((s) => s?.openSettings());
      });
    }
    if (info) info.hidden = !mine;

    // ② 「더 보기」 안 「이 방 숨기기」 — 누가 만든 방이든. 「레이븐 이야기」는 방이 아니라 없다.
    const hide = button("tk-hideroom", document.querySelector("#tk-morebox .tkmorerow"), null, () => t("이 방 숨기기"));
    if (hide && !hide.dataset.wired) {
      hide.dataset.wired = "1";
      hide.addEventListener("click", () => void load().then((s) => s?.hideCurrent()));
    }
    if (hide) hide.hidden = !cur;

    // ③ 방 목록 아래 「숨긴 방 N」 — 숨긴 방이 있을 때만. 되돌리는 길이 안 보이면 숨긴 방은 사라진 방이다.
    const n = Object.keys(loadHidden()).length;
    const list = document.getElementById("tk-rooms");
    const hiddenBtn = button("tk-hiddenrooms", list?.parentElement ?? null, list, () => tf("숨긴 방 {0}", Object.keys(loadHidden()).length));
    if (hiddenBtn && !hiddenBtn.dataset.wired) {
      hiddenBtn.dataset.wired = "1";
      hiddenBtn.classList.add("tk-hiddenrooms");
      hiddenBtn.addEventListener("click", () => void load().then((s) => s?.toggleHidden()));
    }
    if (hiddenBtn) {
      setCopyText(hiddenBtn, () => tf("숨긴 방 {0}", Object.keys(loadHidden()).length));
      hiddenBtn.hidden = n === 0;
    }

    // 방을 바꾸면 열려 있던 시트는 닫는다 — 다른 방의 이름을 고치는 일이 없게.
    if (shownFor !== cur) {
      shownFor = cur;
      sheet?.close();
    } else if (sheet?.isOpen()) {
      if (mine) sheet.refresh();
      else sheet.close();
    }
    sheet?.paintHidden();
  }

  return {
    rooms(list) {
      const cur = deps.current();
      const hidden = loadHidden();
      for (const r of list) all.set(String(r.id), r);
      return list
        .map((r) => {
          const o = overrides.get(String(r.id));
          // 릴레이가 새 이름(같은 때 이후의 수정 글)을 돌려주면 내 임시 표시는 내려놓는다.
          if (o && Number(r.meta_at || 0) >= o.at) overrides.delete(String(r.id));
          return overrides.has(String(r.id)) ? { ...r, name: o!.name, about: o!.about } : r;
        })
        // 지금 보고 있는 방(예: 초대 링크로 연 방)은 숨겨 둔 방이어도 목록에 남긴다 — 어디 있는지 모르게 되면 안 된다.
        .filter((r) => !hidden[String(r.id)] || String(r.id) === cur);
    },
    paint,
  };
}
