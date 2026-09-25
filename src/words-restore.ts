/* 복구 단어(12단어)로 지갑 되살리기 — 0.4.9. 설계서 `docs/RV4-desktop-restore-design.md` 3절 화면 다섯 장.
 *
 *   ① 안내 — 단어를 받기 **전에** 이 컴퓨터부터 살핀다(되살릴 수 없는 컴퓨터에 단어를 치게 하지 않는다).
 *   ② 단어 — 12칸(24단어 전환 · 18단어는 붙여넣기로만) · 앱 자체 제안 · 목록에 없는 단어 표시 · 한/영 안내 ·
 *            붙여넣기 나누기 · 가리기 · 접힌 추가 암호. 체크섬은 러스트(`words_restore_check`)가 본다.
 *   ③ 확인 — 이 단어로 무엇이 열리는지(공개 주소로만 노드에 묻는다) · 지금 지갑을 옆에 둔다는 말 ·
 *            돈이 있는 지갑이면 문장 입력 · 가게면 「오늘 마감 뒤 찾기」가 기본.
 *   ④ 진행 — 줄마다 체크 · 옛 거래 찾기 막대(`debug.log` 진행률) · 그만 찾기.
 *   ⑤ 끝 — 잔액·자산·증서·거래 수 · 지갑 암호 강하게 권함 · 단어로 안 돌아오는 것 · 옛 지갑으로 되돌리기.
 *
 * 🔴 단어는 **어디에도 남기지 않는다.**
 *   - 이 시트가 열려 있는 동안 창 캡처를 막는다(content-guard.ts). 닫으면 푼다.
 *   - 칸의 글자는 [되살리기 시작]을 누르는 **그 순간** 비운다 — 09-25 사고: 가져오기 화면을 닫지 않고
 *     캡처했더니 제출한 뒤에도 입력 칸에 단어가 남아 찍혔다. 닫으면 칸째 지운다(replaceChildren).
 *   - localStorage·sessionStorage·주소창에 아무것도 두지 않는다. 클립보드를 **읽지 않는다**(붙여넣기
 *     이벤트의 글자만 쓴다). 앱이 단어를 클립보드로 내보내는 단추는 없다.
 *   - 오류 문장에 단어를 넣지 않는다 — 틀린 자리는 번호로만 말한다.
 *   - 입력 칸: `autocomplete/autocorrect/autocapitalize/spellcheck` 끔 · 가리기는 `type=password` 가 아니라
 *     CSS(`-webkit-text-security`) — 암호 관리자·키체인 저장 제안이 안 뜨게.
 */
import WORDLIST_TXT from "./bip39-english.txt?raw";
import { protectScreen } from "./content-guard";
import { copyHtml, setCopyText, t, tf } from "./i18n";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type WordsRestoreDeps = {
  invoke: Invoke;
  /** 지금 고른 모드. 장사면 옛 거래 찾기를 「오늘 마감 뒤」로 예약하는 것이 기본이다. */
  mode: () => string;
  /** 지갑이 바뀌었다 — 지갑 화면을 다시 그린다. */
  changed: () => void;
  /** 「백업 먼저 만들기」 — 이 시트를 닫고 백업 칸으로. */
  openBackup: () => void;
  /** 「지갑 암호 걸기」 — 이 시트를 닫고 지갑 잠금 칸으로. */
  openEncrypt: () => void;
  /** 「백업에서 되돌리기」 — 가게 자료(지갑 빼고)를 백업 파일에서. */
  openFileRestore: () => void;
};

/** 공개 BIP39 영어 목록(러스트 `words.rs` 와 같은 파일). */
export const WORDLIST: string[] = WORDLIST_TXT.trim().split("\n");
const IN_LIST = new Set(WORDLIST);
/** 지금 지갑에 돈이 있을 때 치는 문장 — 러스트 `PHRASE_ASIDE` 와 같다. */
export const PHRASE_ASIDE = "지금 지갑을 옆에 둡니다";

/** 앞 글자로 1~3개. 목록은 공개라 괜찮다. */
export function suggest(prefix: string, n = 3): string[] {
  const p = prefix.trim().toLowerCase();
  if (!p || !/^[a-z]+$/.test(p)) return [];
  const out: string[] = [];
  for (const w of WORDLIST) {
    if (w.startsWith(p)) out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

/** 목록에 없는 단어면 「혹시 이것?」 — 앞 네 글자(BIP39 는 네 글자면 하나로 정해진다), 없으면 세 글자. */
export function nearWord(typed: string): string | null {
  const w = typed.trim().toLowerCase();
  if (!w || IN_LIST.has(w)) return null;
  for (const n of [4, 3]) {
    if (w.length < n) continue;
    const hit = WORDLIST.find((x) => x.startsWith(w.slice(0, n)));
    if (hit) return hit;
  }
  return null;
}

/** 붙여 넣은 글: 대문자·여러 칸 띄움·줄바꿈·번호(「1. abandon」)를 맞춘다. 폰 `normalizePhrase` 와 같은 뜻. */
export function splitPhrase(text: string): string[] {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\d+[.)]/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
}

export const hasHangul = (s: string) => /[ㄱ-ㆎ가-힣]/.test(s);
/** 네 글자가 목록의 한 단어로만 이어지면 그 단어(스페이스로 채운다). */
function uniquePrefix(w: string): string | null {
  if (w.length < 4 || IN_LIST.has(w)) return null;
  const hits = suggest(w, 2);
  return hits.length === 1 ? hits[0] : null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: unknown, digits = 8) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : "0";
};

type Step = "guide" | "words" | "confirm" | "progress" | "done";
const STAGES = ["stopping", "set_aside", "creating", "created", "restarting", "rescanning"];
const STAGE_SAY = [
  "노드 멈추는 중",
  "지금 지갑을 옆에 두는 중",
  "단어로 새 지갑 만드는 중",
  "단어가 제대로 들어갔는지 확인",
  "노드 다시 켜는 중 — 여기서부터 노드는 단어를 모릅니다",
  "옛 거래 찾는 중",
];

export function wireWordsRestore(deps: WordsRestoreDeps) {
  const sheet = document.getElementById("wrs") as HTMLElement | null;
  const body = document.getElementById("wrs-body") as HTMLElement | null;
  const bar = document.getElementById("wrs-steps") as HTMLElement | null;
  /** 칸 개수 — 12 기본 · 24 전환 · 18 은 붙여넣기로만. */
  let count = 12;
  let masked = false;
  /** 파이프가 안 읽혀(윈도우) 사람이 「임시 파일로 건네기」를 고른 뒤의 한 번. */
  let fileChannel = false;
  let pruneReindex = false;
  let survey: any = null;
  let run = 0;
  let poll: number | null = null;

  const stopPoll = () => {
    if (poll !== null) window.clearTimeout(poll);
    poll = null;
  };
  const cells = () => [...(body?.querySelectorAll<HTMLInputElement>("[data-wrs-at]") || [])];
  /** 칸의 글자를 지운다. 🔴 [되살리기 시작]을 누르면 가장 먼저 부른다. */
  const wipeInputs = () => {
    cells().forEach((i) => (i.value = ""));
    const p = document.getElementById("wrs-pass") as HTMLInputElement | null;
    if (p) p.value = "";
  };
  const close = () => {
    run++;
    stopPoll();
    wipeInputs();
    if (body) body.replaceChildren();
    count = 12;
    fileChannel = false;
    sheet?.classList.add("hidden");
    void protectScreen(false);
  };
  document.getElementById("wrs-close")?.addEventListener("click", close);

  const show = (step: Step, html: string) => {
    if (!body) return;
    const at = { guide: 0, words: 1, confirm: 2, progress: 3, done: 4 }[step];
    bar?.querySelectorAll("i").forEach((i, n) => i.classList.toggle("on", n <= at));
    body.dataset.step = step;
    body.innerHTML = html;
  };
  const errBox = (e: unknown) =>
    `<div class="warnbox sdw-gap">${esc(t(String((e as Error)?.message ?? e ?? "").replace(/^PIPE_UNREAD: /, "").trim()))}</div>`;
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);

  /* ── ① 안내 ─────────────────────────────────────────────────── */
  async function paintGuide() {
    const mine = ++run;
    show("guide", `<p class="meta">${copyHtml("이 컴퓨터를 살펴보는 중…")}</p>`);
    let sv: any;
    try {
      sv = await deps.invoke<any>("words_restore_preflight");
    } catch (e) {
      if (mine === run) show("guide", errBox(e));
      return;
    }
    if (mine !== run) return;
    survey = sv;
    const st = sv?.state;
    // 이어 하기가 먼저다 — 지갑 자리가 비어 있으면 노드를 못 켠다.
    if (sv?.busy || sv?.rescanning || (st && ["stopping", "set_aside", "creating", "undoing", "created", "restarting", "rescanning", "rescan_wait", "rescan_stopped", "reindexing", "done"].includes(st.stage))) {
      if (sv?.busy || sv?.rescanning || ["rescanning", "rescan_wait", "rescan_stopped", "reindexing", "done", "created", "restarting"].includes(st?.stage)) {
        return void paintProgress();
      }
      return paintResume(st?.why);
    }
    if (sv?.blocked) {
      show("guide", `${errBox(sv.blocked)}<button id="wrs-x">${copyHtml("닫기")}</button>`);
      on("wrs-x", close);
      return;
    }
    const w = sv?.wallet;
    const lines: string[] = [`<p>${copyHtml("단어를 넣기 전에 이 컴퓨터부터 살펴봅니다.")}</p>`];
    if (!w) lines.push(`<p class="meta sdw-gap">${copyHtml("지금 이 컴퓨터에는 지갑이 없습니다. 되살린 지갑이 이 컴퓨터의 첫 지갑이 됩니다.")}</p>`);
    else if (!sv.has_value) lines.push(`<p class="meta sdw-gap">${esc(tf("지금 이 컴퓨터 지갑: 거래 {0}건 · 잔액 {1} RVN", w.txcount, num(w.balance)))}</p>`);
    const branch = sv?.branch;
    if (branch === "new") lines.push(`<p class="meta">${copyHtml("장부를 아직 거의 받지 않은 컴퓨터입니다. 되살린 뒤 옛 거래 찾기는 몇 분이면 끝나고, 나머지는 장부를 받으면서 저절로 찾습니다(처음이면 하루~며칠).")}</p>`);
    if (branch === "full") lines.push(`<p class="meta">${copyHtml("장부를 전부 가진 컴퓨터입니다. 되살린 뒤 옛 거래를 찾는 데 30분~2시간쯤(이 컴퓨터 기준 추정) 걸리고, 그동안 입금 확인이 멈춥니다.")}</p>`);
    if (branch === "prune") {
      lines.push(`<div class="warnbox sdw-gap"><b>${copyHtml("이 컴퓨터는 장부를 아껴 쓰고 있어 옛 거래를 찾을 수 없습니다.")}</b><br />
        ${copyHtml("되살리려면 장부 전체를 처음부터 다시 받습니다. 몇 시간에서 며칠 걸리고, 그동안 입금 확인이 멈춥니다. 받으면서 옛 거래를 찾고, 끝나면 다시 장부를 아껴 씁니다.")}</div>
        <div class="row sdw-gap"><button id="wrs-prune">${copyHtml("장부를 처음부터 다시 받으며 되살리기 — 며칠")}</button>
        <button class="ghost" id="wrs-x">${copyHtml("그만두기")}</button></div>`);
      show("guide", lines.join(""));
      on("wrs-prune", () => { pruneReindex = true; paintWords(); });
      on("wrs-x", close);
      return;
    }
    if (sv?.has_value) {
      // 🔴 기본은 멈추고 「백업 먼저」(지시서). 계속하려면 ③에서 문장을 한 번 더 친다(두 번 확인).
      lines.push(`<div class="warnbox sdw-gap"><b>${esc(tf("이 지갑에는 {0} RVN · 자산 {1}종 · 거래 {2}건이 있습니다.", num(Number(w.balance) + Number(w.unconfirmed || 0)), w.assets, w.txcount))}</b><br />
        ${copyHtml("되살리면 이 지갑은 옆에 보관되고 화면에서 사라집니다(지워지지 않습니다).")}<br />
        ${w.bip44 === false ? `<b>${copyHtml("이 지갑에는 12단어가 없습니다. 옆에 둔 파일이 이 지갑의 유일한 열쇠입니다.")}</b><br />` : ""}
        ${copyHtml("먼저 지금 지갑의 백업을 만들어 두세요.")}</div>
        <div class="row sdw-gap"><button id="wrs-backup">${copyHtml("백업 먼저 만들기")}</button>
        <button class="ghost" id="wrs-go">${copyHtml("백업을 만들었어요 — 계속")}</button></div>`);
      show("guide", lines.join(""));
      on("wrs-backup", () => { close(); deps.openBackup(); });
      on("wrs-go", () => paintWords());
      return;
    }
    lines.push(`<button class="sdw-gap" id="wrs-go">${copyHtml("단어 넣기")}</button>`);
    show("guide", lines.join(""));
    on("wrs-go", () => paintWords());
  }

  function paintResume(why?: string) {
    show(
      "guide",
      `<div class="warnbox"><b>${copyHtml("되살리기가 중간에 멈췄습니다.")}</b><br />
         ${copyHtml("옛 지갑은 옆에 그대로 있습니다. 노드는 켜지 않고 기다리고 있습니다 — 지금 켜면 빈 지갑이 새로 생기기 때문입니다.")}</div>
       ${why ? errBox(why) : ""}
       <div class="row sdw-gap"><button id="wrs-again">${copyHtml("단어 다시 넣고 이어 하기")}</button>
       <button class="ghost" id="wrs-undo">${copyHtml("옛 지갑으로 되돌리기")}</button></div>`,
    );
    on("wrs-again", () => paintWords());
    on("wrs-undo", () => paintUndo());
  }

  /* ── ② 단어 ─────────────────────────────────────────────────── */
  function cellHtml(n: number, value = "") {
    return `<label class="wrs-cell"><i>${n}</i><input data-wrs-at="${n}" type="text" value="${esc(value)}"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" lang="en" inputmode="text"
      aria-label="${esc(tf("{0}번째 단어", n))}" /></label>`;
  }

  function paintWords(keep: string[] = []) {
    const vals = keep.slice(0, count);
    show(
      "words",
      `<p>${copyHtml("종이에 적어 둔 복구 단어를 순서대로 넣어 주세요. 영어 단어입니다.")}</p>
       ${fileChannel ? `<div class="warnbox sdw-gap">${copyHtml("이번에는 단어를 임시 파일로 건넵니다. 노드가 읽은 뒤 바로 지우지만, 저장 장치에 흔적이 남을 수 있습니다.")}</div>` : ""}
       <div class="wrs-grid${masked ? " wrs-masked" : ""}" id="wrs-grid" translate="no">${Array.from({ length: count }, (_, i) => cellHtml(i + 1, vals[i] || "")).join("")}</div>
       <div class="wrs-sug" id="wrs-sug" translate="no"></div>
       <p class="meta" id="wrs-hint" role="status" aria-live="polite"></p>
       <div class="row">
         <button type="button" class="ghost" id="wrs-24">${copyHtml(count === 12 ? "24단어예요" : "12단어예요")}</button>
         <button type="button" class="ghost" id="wrs-hide">${copyHtml(masked ? "보이기" : "가리기")}</button>
       </div>
       <div class="wnote wait sdw-gap" id="wrs-clip" hidden><span>${copyHtml("붙여 넣은 단어는 이 컴퓨터 클립보드에 아직 남아 있습니다.")}</span>
         <button type="button" class="ghost" id="wrs-clipclear">${copyHtml("클립보드 비우기")}</button></div>
       <details class="wrs-extra sdw-gap"><summary>${copyHtml("추가 암호를 걸어 두셨나요? (대부분 아닙니다)")}</summary>
         <p class="meta">${copyHtml("걸어 둔 적이 없으면 비워 두세요. 틀리면 빈 지갑이 열립니다.")}</p>
         <label>${copyHtml("추가 암호")}<input id="wrs-pass" class="wrs-secret" type="text" autocomplete="off" autocorrect="off"
           autocapitalize="off" spellcheck="false" /></label>
         <button type="button" class="ghost" id="wrs-passshow">${copyHtml("보기")}</button>
       </details>
       <div id="wrs-out"></div>
       <button class="sdw-gap" id="wrs-check">${copyHtml("확인")}</button>`,
    );
    const inputs = cells();
    const hint = document.getElementById("wrs-hint")!;
    const sug = document.getElementById("wrs-sug")!;
    const say = (s: string) => setCopyText(hint, () => s);
    const focusAt = (i: number) => inputs[Math.min(i, inputs.length - 1)]?.focus();
    const mark = (el: HTMLInputElement) => {
      const v = el.value.trim().toLowerCase();
      const bad = !!v && !IN_LIST.has(v);
      el.classList.toggle("bad", bad);
      return bad;
    };
    const paintSug = (el: HTMLInputElement) => {
      const v = el.value.trim().toLowerCase();
      const list = IN_LIST.has(v) ? [] : suggest(v);
      sug.innerHTML = list.map((w) => `<button type="button" class="ghost" data-wrs-pick="${esc(w)}">${esc(w)}</button>`).join("");
      sug.dataset.for = el.dataset.wrsAt || "";
    };
    const explain = (el: HTMLInputElement) => {
      const n = Number(el.dataset.wrsAt);
      const v = el.value;
      if (hasHangul(v)) return say(t("한/영 키를 눌러 영어로 바꿔 주세요."));
      if (mark(el)) {
        const near = nearWord(v);
        return say(near ? tf("{0}번째 단어가 목록에 없습니다. 혹시 {1}?", n, near) : tf("{0}번째 단어가 목록에 없습니다. 철자를 확인해 주세요.", n));
      }
      hint.textContent = "";
    };
    /** 여러 단어를 i번째 칸부터 나눠 넣는다(붙여넣기·스페이스). */
    const spread = (from: number, words: string[]) => {
      words.forEach((w, k) => {
        const el = inputs[from + k];
        if (el) { el.value = w; mark(el); }
      });
      focusAt(from + words.length);
    };
    inputs.forEach((el, i) => {
      el.addEventListener("input", () => {
        const v = el.value;
        if (/\s/.test(v.trim())) {
          // 칸 안에 여러 단어를 쳤다 — 나눠 넣는다.
          const words = splitPhrase(v);
          el.value = "";
          spread(i, words);
          return;
        }
        if (/\s$/.test(v)) {
          const w = v.trim().toLowerCase();
          el.value = uniquePrefix(w) || w;
          explain(el);
          if (!el.classList.contains("bad")) focusAt(i + 1);
          return;
        }
        paintSug(el);
        if (hasHangul(v)) say(t("한/영 키를 눌러 영어로 바꿔 주세요."));
        else if (!el.classList.contains("bad")) hint.textContent = "";
      });
      el.addEventListener("focus", () => paintSug(el));
      el.addEventListener("blur", () => { el.value = el.value.trim().toLowerCase(); explain(el); });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const w = el.value.trim().toLowerCase();
          el.value = uniquePrefix(w) || w;
          explain(el);
          if (i === inputs.length - 1 && e.key === "Enter") return void check();
          focusAt(i + 1);
        }
      });
      // 🔴 붙여넣기: 이벤트에 실린 글자만 쓴다(클립보드를 따로 읽지 않는다).
      el.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text") || "";
        const words = splitPhrase(text);
        if (words.length < 2) return;
        e.preventDefault();
        document.getElementById("wrs-clip")!.hidden = false;
        if ([12, 18, 24].includes(words.length) && words.length !== count) {
          // 18단어는 여기서만 받는다(흔치 않음 — 칸 전환 단추는 12·24 뿐).
          count = words.length;
          paintWords(words);
          document.getElementById("wrs-clip")!.hidden = false;
          return;
        }
        spread([12, 18, 24].includes(words.length) ? 0 : i, words);
      });
    });
    sug.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-wrs-pick]");
      if (!b) return;
      const n = Number(sug.dataset.for || 0);
      const el = inputs[n - 1];
      if (el) { el.value = b.dataset.wrsPick || ""; mark(el); hint.textContent = ""; }
      sug.innerHTML = "";
      focusAt(n);
    });
    on("wrs-24", () => {
      const kept = inputs.map((i) => i.value);
      count = count === 12 ? 24 : 12;
      paintWords(kept);
    });
    on("wrs-hide", () => {
      masked = !masked;
      document.getElementById("wrs-grid")?.classList.toggle("wrs-masked", masked);
      const b = document.getElementById("wrs-hide");
      if (b) b.innerHTML = copyHtml(masked ? "보이기" : "가리기");
    });
    on("wrs-passshow", () => document.getElementById("wrs-pass")?.classList.toggle("wrs-shown"));
    on("wrs-clipclear", async () => {
      const box = document.getElementById("wrs-clip")!;
      try {
        await navigator.clipboard.writeText("");
        box.innerHTML = `<span>${copyHtml("클립보드를 비웠습니다. (다른 기기로 건너간 사본·클립보드 기록은 앱이 지우지 못합니다.)")}</span>`;
      } catch {
        box.innerHTML = `<span>${copyHtml("클립보드를 비우지 못했습니다. 아무 글자나 한 번 복사해 덮어 주세요.")}</span>`;
      }
    });
    on("wrs-check", () => void check());
    focusAt(keep.findIndex((v) => !v) >= 0 ? keep.findIndex((v) => !v) : 0);

    async function check() {
      const out = document.getElementById("wrs-out")!;
      out.innerHTML = "";
      const words = inputs.map((i) => i.value.trim().toLowerCase());
      const empty = words.map((w, k) => (w ? 0 : k + 1)).filter(Boolean);
      if (empty.length) return say(tf("{0}번째 칸이 비어 있습니다.", empty.join("·")));
      const bad = inputs.filter((el) => mark(el)).map((el) => Number(el.dataset.wrsAt));
      if (bad.length) return say(tf("{0}번째 단어가 목록에 없습니다. 철자를 확인해 주세요.", bad.join("·")));
      const pass = (document.getElementById("wrs-pass") as HTMLInputElement | null)?.value ?? "";
      const go = document.getElementById("wrs-check") as HTMLButtonElement;
      go.disabled = true;
      const mine = run;
      let r: any;
      try {
        r = await deps.invoke<any>("words_restore_check", { words: words.join(" "), passphrase: pass });
      } catch (e) {
        go.disabled = false;
        out.innerHTML = errBox(e);
        return;
      }
      if (mine !== run) return;
      go.disabled = false;
      if (!r?.ok) {
        const why =
          r?.kind === "checksum" ? t("단어 하나가 틀렸거나 순서가 바뀌었습니다. 어느 것인지는 계산으로 알 수 없습니다 — 종이에서 흐린 글자, 비슷한 단어(예: sun·sunny)를 봐 주세요.")
          : r?.kind === "unknown" ? tf("{0}번째 단어가 목록에 없습니다. 철자를 확인해 주세요.", (r.at || []).join("·"))
          : r?.kind === "count" ? tf("복구 단어는 12개(또는 24개)여야 합니다. 지금 {0}개입니다.", r.count)
          : t(String(r?.message || ""));
        out.innerHTML = `<div class="warnbox sdw-gap">${esc(why)}</div>`;
        return;
      }
      paintConfirm(r);
    }
  }

  /* ── ③ 확인 ─────────────────────────────────────────────────── */
  function paintConfirm(r: any) {
    const sv = survey || {};
    const shop = deps.mode() === "shop";
    const lines: string[] = [`<p>${copyHtml("이 단어로 무엇이 열리는지 먼저 봅니다.")}</p>`];
    if (r.same_wallet === true) {
      show(
        "confirm",
        `${lines.join("")}<p class="okline sdw-gap"><b>${copyHtml("이미 이 컴퓨터의 지갑입니다. 되살릴 것이 없습니다.")}</b></p>
         <p class="meta">${copyHtml("옛 거래가 안 보이면 다시 찾기만 하면 됩니다. 그동안 입금 확인이 멈춥니다.")}</p>
         <div class="row sdw-gap"><button id="wrs-rescan">${copyHtml("옛 거래 다시 찾기")}</button>
         <button class="ghost" id="wrs-x">${copyHtml("닫기")}</button></div>`,
      );
      wipeInputs();
      on("wrs-rescan", () => void startRescan());
      on("wrs-x", close);
      return;
    }
    if (r.history === "found") lines.push(`<p class="okline sdw-gap">${copyHtml("이 단어의 주소에서 거래 기록을 찾았습니다.")}</p>`);
    else if (r.history === "none") lines.push(`<div class="warnbox sdw-gap">${copyHtml("이 단어의 주소에서 기록을 못 찾았습니다 — 단어나 추가 암호가 다르면 빈 지갑이 열립니다. 새로 만든 지갑이라 아직 거래가 없을 수도 있습니다.")}</div>
      <button type="button" class="ghost" id="wrs-back">${copyHtml("단어 다시 보기")}</button>`);
    else lines.push(`<p class="meta sdw-gap">${copyHtml("미리 확인할 수 없는 컴퓨터입니다. 되살린 뒤 확인합니다.")}</p>`);
    if (sv.wallet_file) lines.push(`<p class="sdw-gap">${copyHtml("지금 지갑은 지우지 않고 옆에 둡니다(wallet.dat.before-words-날짜). 언제든 되돌릴 수 있습니다.")}</p>`);
    if (sv.need_confirm) {
      lines.push(`<div class="confirmbox"><div>${copyHtml("지금 지갑에 돈·거래·자산이 있습니다. 아래 문장을 그대로 입력하세요.")}</div>
        <pre class="conf">${copyHtml(PHRASE_ASIDE)}</pre><input id="wrs-confirm" autocomplete="off" spellcheck="false" /></div>`);
    }
    if (sv.branch === "full" || sv.branch === "new") {
      lines.push(`<fieldset class="wrs-when sdw-gap"><legend>${copyHtml("옛 거래는 언제 찾을까요?")}</legend>
        <label><input type="radio" name="wrs-when" value="after_close" ${shop ? "checked" : ""} /> ${copyHtml("오늘 마감 뒤에 찾기 (가게가 한가할 때 알아서)")}</label>
        <label><input type="radio" name="wrs-when" value="now" ${shop ? "" : "checked"} /> ${copyHtml("지금 바로 찾기")}</label></fieldset>`);
    }
    lines.push(`<p class="meta sdw-gap">${copyHtml("노드가 몇 분 꺼졌다 켜집니다. 단어는 디스크·기록·명령줄에 남기지 않고 노드에 한 번만 건넵니다.")}</p>
      <div id="wrs-out"></div><button class="sdw-gap" id="wrs-start">${copyHtml("되살리기 시작")}</button>`);
    // 단어는 아직 ②의 칸에 있다 — ③을 그리면 ②가 사라지므로 먼저 모아 둔다(시작하면 바로 지운다).
    const words = cells().map((i) => i.value.trim().toLowerCase()).join(" ");
    const pass = (document.getElementById("wrs-pass") as HTMLInputElement | null)?.value ?? "";
    // ② 화면을 숨겨 둔 채로 남긴다 — 「단어 다시 보기」가 되돌아갈 곳. 닫거나 시작하면 지운다.
    const kept = document.createElement("div");
    kept.hidden = true;
    kept.id = "wrs-kept";
    kept.append(...Array.from(body!.childNodes));
    show("confirm", lines.join(""));
    body!.append(kept);
    on("wrs-back", () => {
      const k = document.getElementById("wrs-kept");
      if (!k || !body) return;
      body.replaceChildren(...Array.from(k.childNodes));
      body.dataset.step = "words";
      bar?.querySelectorAll("i").forEach((i, n) => i.classList.toggle("on", n <= 1));
    });
    const startBtn = document.getElementById("wrs-start") as HTMLButtonElement;
    const gate = () => {
      const c = (document.getElementById("wrs-confirm") as HTMLInputElement | null)?.value.trim() ?? "";
      startBtn.disabled = !!sv.need_confirm && c !== PHRASE_ASIDE && c !== t(PHRASE_ASIDE);
    };
    document.getElementById("wrs-confirm")?.addEventListener("input", gate);
    gate();
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      const when = (document.querySelector<HTMLInputElement>('input[name="wrs-when"]:checked')?.value) || "now";
      const confirm = (document.getElementById("wrs-confirm") as HTMLInputElement | null)?.value.trim() === t(PHRASE_ASIDE) ? PHRASE_ASIDE
        : (document.getElementById("wrs-confirm") as HTMLInputElement | null)?.value.trim() ?? "";
      // 🔴 칸을 **먼저** 비운다. 부르는 동안 화면이 찍혀도 단어가 없다.
      wipeInputs();
      document.getElementById("wrs-kept")?.remove();
      const args = { words, passphrase: pass, confirm, rescan: when, pruneReindex, channel: fileChannel ? "file" : "pipe" };
      try {
        await deps.invoke("words_restore_start", args);
      } catch (e) {
        const out = document.getElementById("wrs-out");
        if (out) out.innerHTML = errBox(e);
        return;
      } finally {
        args.words = "";
        args.passphrase = "";
      }
      fileChannel = false;
      paintProgress();
    });
  }

  /* ── ④ 진행 ─────────────────────────────────────────────────── */
  function paintProgress() {
    const mine = ++run;
    show("progress", `<ol class="wrs-list" id="wrs-list"></ol><div id="wrs-now"></div>`);
    const tick = async () => {
      if (mine !== run) return;
      let s: any;
      try {
        s = await deps.invoke<any>("words_restore_status");
      } catch {
        poll = window.setTimeout(tick, 3000);
        return;
      }
      if (mine !== run) return;
      const st = s?.state || {};
      const stage = String(st.stage || "");
      if (!s?.busy && (stage === "done" || stage === "closed")) return paintDone(st);
      if (!s?.busy && stage === "undone") return paintUndone();
      if (!s?.busy && ["set_aside", "creating", "undoing"].includes(stage)) {
        const why = String(st.why || s?.error || "");
        if (why.startsWith("PIPE_UNREAD")) return paintPipeUnread();
        return paintResume(why);
      }
      if (!s?.busy && !stage && s?.error) {
        // 옆에 두기 전에 멈췄다 — 아무것도 안 바뀌었다.
        show("progress", `${errBox(s.error)}<p class="meta">${copyHtml("지금 지갑은 그대로입니다.")}</p>
          <div class="row sdw-gap"><button id="wrs-again">${copyHtml("처음부터 다시")}</button><button class="ghost" id="wrs-x">${copyHtml("닫기")}</button></div>`);
        on("wrs-again", () => void paintGuide());
        on("wrs-x", close);
        return;
      }
      const at = Math.max(0, STAGES.indexOf(stage === "rescan_wait" || stage === "rescan_stopped" || stage === "reindexing" ? "rescanning" : stage));
      const list = document.getElementById("wrs-list");
      if (list) {
        list.innerHTML = STAGE_SAY.map((say, i) => `<li class="${i < at ? "did" : i === at ? "now" : ""}">${copyHtml(say)}</li>`).join("");
      }
      const now = document.getElementById("wrs-now");
      if (now) {
        if (stage === "rescanning") {
          const p = s?.progress;
          now.innerHTML = `<div class="wrs-bar"><i id="wrs-fill"></i></div>
            <p class="meta">${p ? esc(tf("블록 {0} / {1}", Number(p.height).toLocaleString(), Number(p.tip || 0).toLocaleString())) + (p.eta_min != null ? " · " + esc(tf("대략 {0}분 남음", p.eta_min)) : "") : copyHtml("찾기 시작했습니다. 1분쯤 뒤부터 얼마나 왔는지 보입니다.")}</p>
            <p class="meta sdw-gap">${copyHtml("이 창은 닫아도 됩니다. 프로그램 끝내기는 하지 마세요. 끝나면 알려 드립니다. 그동안 새 입금 확인이 멈춥니다.")}</p>
            <button class="ghost sdw-gap" id="wrs-abort">${copyHtml("그만 찾기")}</button>`;
          const fill = document.getElementById("wrs-fill");
          if (fill) fill.style.width = `${Math.min(100, Math.max(2, Number(p?.pct || 0)))}%`;
          on("wrs-abort", async () => {
            await deps.invoke("words_restore_abort").catch(() => null);
          });
        } else if (stage === "rescan_wait") {
          now.innerHTML = `<p class="okline sdw-gap"><b>${copyHtml("지갑을 되살렸습니다.")}</b></p>
            <p>${copyHtml("오늘 마감 뒤에 옛 거래를 찾습니다. 가게가 한가해지면 알아서 시작합니다. 그때까지 옛 잔액은 안 보일 수 있습니다.")}</p>
            <div class="row sdw-gap"><button id="wrs-rescan">${copyHtml("지금 바로 찾기")}</button><button class="ghost" id="wrs-x">${copyHtml("닫기")}</button></div>`;
          on("wrs-rescan", () => void startRescan());
          on("wrs-x", close);
          return;
        } else if (stage === "rescan_stopped") {
          now.innerHTML = `<p class="okline sdw-gap"><b>${copyHtml("지갑은 되살아나 있습니다.")}</b></p>
            <p>${copyHtml("옛 거래 찾기가 멈췄습니다. 이어서 찾으면 처음부터 다시 훑습니다(몇 번 해도 같습니다).")}</p>
            <div class="row sdw-gap"><button id="wrs-rescan">${copyHtml("이어 찾기")}</button><button class="ghost" id="wrs-x">${copyHtml("닫기")}</button></div>`;
          on("wrs-rescan", () => void startRescan());
          on("wrs-x", close);
          return;
        } else if (stage === "reindexing") {
          const p = s?.progress;
          now.innerHTML = `<div class="wrs-bar"><i id="wrs-fill"></i></div>
            <p class="meta">${esc(tf("장부를 처음부터 다시 받는 중입니다 ({0}%). 받으면서 옛 거래를 찾습니다. 며칠 걸릴 수 있습니다.", p?.pct ?? 0))}</p>
            <p class="meta sdw-gap">${copyHtml("이 창은 닫아도 됩니다. 컴퓨터를 켜 두시면 됩니다.")}</p>`;
          const fill = document.getElementById("wrs-fill");
          if (fill) fill.style.width = `${Math.min(100, Math.max(2, Number(p?.pct || 0)))}%`;
        } else {
          now.innerHTML = `<p class="meta sdw-gap">${copyHtml("몇 분 걸립니다. 이 창을 닫아도 뒤에서 계속합니다.")}</p>`;
        }
      }
      poll = window.setTimeout(tick, 2500);
    };
    void tick();
  }

  function paintPipeUnread() {
    show(
      "progress",
      `<div class="warnbox"><b>${copyHtml("이 컴퓨터에서는 디스크에 흔적 없이 단어를 건네지 못했습니다.")}</b><br />
         ${copyHtml("지금 지갑과 단어는 그대로이고, 옛 지갑은 옆에 있습니다. 임시 파일로 건네면 노드가 읽은 뒤 바로 0 으로 덮고 지우지만, 저장 장치(SSD)에 흔적이 남을 수 있습니다.")}</div>
       <div class="row sdw-gap"><button id="wrs-file">${copyHtml("임시 파일로 건네기 — 단어를 한 번 더 넣습니다")}</button>
       <button class="ghost" id="wrs-undo">${copyHtml("옛 지갑으로 되돌리기")}</button></div>`,
    );
    on("wrs-file", () => { fileChannel = true; paintWords(); });
    on("wrs-undo", () => paintUndo());
  }

  async function startRescan() {
    try {
      await deps.invoke("words_restore_rescan");
    } catch (e) {
      const out = document.getElementById("wrs-now") || body;
      if (out) out.insertAdjacentHTML("beforeend", errBox(e));
      return;
    }
    paintProgress();
  }

  /* ── ⑤ 끝 ───────────────────────────────────────────────────── */
  function paintDone(st: any) {
    stopPoll();
    const r = st?.result || {};
    const empty = Number(r.txcount || 0) === 0;
    const lines: string[] = [
      `<p class="okline"><b>${esc(tf("되살렸습니다 — 잔액 {0} RVN · 자산 {1}종 · 증서 {2}장 · 거래 {3}건", num(r.balance), r.assets ?? 0, r.certs ?? 0, r.txcount ?? 0))}</b></p>`,
    ];
    if (empty && st?.branch === "new") {
      lines.push(`<p class="meta">${copyHtml("이 컴퓨터가 장부를 따라잡으면 잔액과 거래가 저절로 보입니다. 처음이면 하루~며칠 걸릴 수 있습니다.")}</p>`);
    } else if (empty) {
      lines.push(`<div class="warnbox sdw-gap"><b>${copyHtml("돈이 사라진 것이 아닙니다.")}</b><br />
        ${copyHtml("넣으신 단어·추가 암호로 열리는 지갑에는 거래가 한 번도 없습니다. 단어 하나나 추가 암호가 다르면 전혀 다른 빈 지갑이 열립니다.")}</div>
        <div class="row sdw-gap"><button id="wrs-again">${copyHtml("단어·추가 암호 다시 넣기")}</button>
        <button class="ghost" id="wrs-undo">${copyHtml("옛 지갑으로 되돌리기")}</button></div>`);
    }
    if (!r.encrypted) {
      lines.push(`<div class="warnbox sdw-gap"><b>${copyHtml("이 지갑에는 아직 지갑 암호가 없습니다.")}</b><br />
        ${copyHtml("지금 거는 것을 강하게 권합니다 — 되살린 지갑 파일에는 복구 단어가 암호 없이 들어 있습니다. 노드가 잠깐 꺼졌다 켜집니다.")}</div>
        <button class="sdw-gap" id="wrs-enc">${copyHtml("지갑 암호 걸기")}</button>`);
    }
    lines.push(`<p class="meta sdw-gap">${copyHtml("단어로 돌아오지 않는 것: 가게 메뉴·회원·예약·가게 간판 열쇠. 백업 파일이 있으면 「백업에서 되돌리기」로 가져오세요(지갑은 빼고).")}</p>
      <button type="button" class="ghost" id="wrs-file-restore">${copyHtml("백업에서 되돌리기")}</button>`);
    if (st?.aside) {
      lines.push(`<p class="meta sdw-gap">${copyHtml("옆에 둔 옛 지갑")}: <code translate="no">${esc(st.aside)}</code></p>
        ${empty ? "" : `<button type="button" class="ghost" id="wrs-undo">${copyHtml("옛 지갑으로 되돌리기")}</button>`}`);
    }
    lines.push(`<button class="sdw-gap" id="wrs-finish">${copyHtml("닫기")}</button>`);
    show("done", lines.join(""));
    deps.changed();
    on("wrs-again", () => void paintGuide());
    on("wrs-undo", () => paintUndo());
    on("wrs-enc", () => { void finish(); deps.openEncrypt(); });
    on("wrs-file-restore", () => { void finish(); deps.openFileRestore(); });
    on("wrs-finish", () => void finish());
  }

  async function finish() {
    await deps.invoke("words_restore_close").catch(() => null);
    close();
  }

  function paintUndo() {
    show(
      "done",
      `<p><b>${copyHtml("옛 지갑으로 되돌릴까요?")}</b></p>
       <p class="meta">${copyHtml("되살린 지갑도 지우지 않고 옆에 둡니다. 노드가 잠깐 꺼졌다 켜집니다.")}</p>
       <div id="wrs-out"></div>
       <div class="row sdw-gap"><button id="wrs-undo-go">${copyHtml("되돌리기")}</button><button class="ghost" id="wrs-x">${copyHtml("그만두기")}</button></div>`,
    );
    on("wrs-x", close);
    on("wrs-undo-go", async () => {
      const b = document.getElementById("wrs-undo-go") as HTMLButtonElement;
      b.disabled = true;
      const out = document.getElementById("wrs-out")!;
      setCopyText(out, () => t("되돌리는 중…"));
      try {
        await deps.invoke("words_restore_undo");
        paintUndone();
      } catch (e) {
        b.disabled = false;
        out.innerHTML = errBox(e);
      }
    });
  }

  function paintUndone() {
    stopPoll();
    show(
      "done",
      `<p class="okline"><b>${copyHtml("옛 지갑으로 되돌렸습니다.")}</b></p>
       <p class="meta">${copyHtml("되살린 지갑도 지우지 않고 옆에 두었습니다(wallet.dat.from-words-날짜).")}</p>
       <button class="sdw-gap" id="wrs-finish">${copyHtml("닫기")}</button>`,
    );
    deps.changed();
    on("wrs-finish", () => void finish());
  }

  async function open() {
    stopPoll();
    wipeInputs();
    count = 12;
    pruneReindex = false;
    sheet?.classList.remove("hidden");
    void protectScreen(true); // 단어 칸이 뜨기 전에 가린다(content-guard.ts)
    await paintGuide();
  }

  /** 켤 때 한 번 — 되살리기가 중간에 멈춰 있으면(노드를 못 켜는 상태) 먼저 알린다. */
  async function checkOnStart() {
    const s = await deps.invoke<any>("words_restore_status").catch(() => null);
    const stage = String(s?.state?.stage || "");
    if (!s?.busy && ["set_aside", "creating", "undoing"].includes(stage)) void open();
    else if (!s?.busy && stage === "rescanning" && !s?.rescanning) void open();
  }

  /** 1분마다 — 「오늘 마감 뒤 찾기」 예약이면 가게가 한가할 때 시작한다(reindexTick 과 같은 창 계산). */
  async function tick() {
    try {
      const s = await deps.invoke<any>("words_restore_status");
      if (s?.busy || s?.state?.stage !== "rescan_wait") return;
      const w = await deps.invoke<any>("reindex_window", {
        nowUnix: Math.floor(Date.now() / 1000),
        tzOffsetMin: -new Date().getTimezoneOffset(),
      });
      if (w?.kind === "window" && Number(w.starts_in_min) === 0 && !w.tight) await deps.invoke("words_restore_rescan");
    } catch {
      // 다음 분에 다시 본다.
    }
  }

  return { open: () => void open(), checkOnStart: () => void checkOnStart(), tick: () => void tick() };
}
