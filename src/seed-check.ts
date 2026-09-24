/* 복구 단어 적어 두기 — 한 창에서 끝나는 흐름(0.4.8-A2).
 *
 * 🔴 RV3 처음 쓰는 사람 과제 T02: 「이 컴퓨터 › 백업 › 복구 단어 보기」를 누르면
 *    「암호를 먼저 걸어 주세요」가 떴다. 지갑 화면으로 가서 암호를 걸면 노드가 꺼지고,
 *    다시 켠 뒤 백업 칸으로 돌아와야 단어가 보였다 — 누른 횟수 12. 그리고 폰·웹에는
 *    있는 「2·6·10번째 단어」 확인이 없어서, 적다가 틀린 줄을 아무도 몰랐다.
 *
 * 한 창에서 순서대로 간다.
 *   ① 암호가 없으면 **여기서** 만든다 — 노드가 꺼졌다 켜진다는 것을 먼저 말하고,
 *      다시 켜지면 저절로 ②로.
 *   ② 암호를 넣고 단어를 본다(찍지 말고 종이에 — 기존 안내 그대로).
 *   ③ 2·6·10번째를 묻는다. 맞으면 「적어 두셨어요」, 틀리면 단어를 다시 보여 준다.
 *
 * 🔴 암호 관문은 **그대로다.** `reveal_seed` 는 암호 건 지갑에서만 단어를 꺼낸다 —
 *    여기서는 그 관문 앞까지 가는 길을 한 줄로 폈을 뿐, 관문을 낮추지 않는다.
 * 🔴 단어는 **어디에도 남기지 않는다.** 이 창을 닫으면 배열을 비우고 칸을 지운다.
 *    남기는 것은 「확인했다」는 사실과 그 시각뿐이다(단어·암호·순번 없음).
 * 🔴 암호도 들고 있지 않는다. ①에서 친 암호를 ②에서 한 번 더 치게 한다 —
 *    방금 만든 암호를 기억하는지 보는 셈이기도 하다.
 */
import { copyHtml, setCopyText, t, tf } from "./i18n";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type SeedCheckDeps = {
  invoke: Invoke;
  /** 지금 고른 모드. 장사면 「그동안 가게도 멈춘다」를 먼저 말한다. */
  mode: () => string;
  /** 암호를 걸었거나 확인을 마쳤다 — 지갑 화면의 알림·잠금 칸을 다시 그린다. */
  changed: () => void;
};

type Step = "lock" | "restart" | "reveal" | "words" | "quiz" | "done";

/** 「확인했다」는 표시. 🔴 단어·암호는 여기 안 들어간다 — 시각 하나뿐이다. */
const CHECKED_KEY = "rv-seed-checked";
/** 첫 암호 걸기의 확인 문장. 지갑 화면의 암호 걸기와 같은 문장이다(같은 마찰). */
const PHRASE = "암호를 잊으면 되돌릴 수 없다";
/** 묻는 자리(사람이 세는 번호). 폰·웹과 같다. */
const ASK_AT = [2, 6, 10];

export function seedChecked(): boolean {
  try {
    return !!JSON.parse(localStorage.getItem(CHECKED_KEY) || "null")?.at;
  } catch {
    return false;
  }
}

function markChecked() {
  try {
    localStorage.setItem(CHECKED_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    /* 저장이 막혀도 이번 확인은 끝났다 — 다음에 한 번 더 물을 뿐이다 */
  }
}

/** 12단어면 2·6·10번째. 짧은 지갑이 오면 처음·가운데·끝. */
export function askPositions(count: number): number[] {
  if (count >= 10) return ASK_AT;
  if (count <= 0) return [];
  return [...new Set([1, Math.ceil(count / 2), count])];
}

/** 적은 것과 맞나 — 앞뒤 공백·대소문자·전각은 봐준다. 철자는 안 봐준다. */
export function sameWord(typed: string, word: string): boolean {
  const norm = (s: string) => String(s ?? "").normalize("NFKC").trim().toLowerCase();
  return norm(typed) !== "" && norm(typed) === norm(word);
}

/** 노드가 「아직 여는 중」이라고 답했나(main.ts `isWarming` 과 같은 판별). */
function warming(e: unknown): boolean {
  return /Loading block index|Verifying|Rewinding|Activating|Loading wallet|warming up|-28/i.test(
    String((e as Error)?.message ?? e ?? ""),
  );
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function wireSeedCheck(deps: SeedCheckDeps): { open: () => void } {
  const sheet = document.getElementById("sdw") as HTMLElement | null;
  const body = document.getElementById("sdw-body") as HTMLElement | null;
  const bar = document.getElementById("sdw-steps") as HTMLElement | null;
  /** 🔴 단어는 이 창이 열려 있는 동안 여기에만 있다. 닫으면 비운다. */
  let words: string[] = [];
  let extra = false;
  /** 창을 닫았는데 뒤에서 노드를 기다리던 것이 화면을 다시 그리지 않게. */
  let run = 0;

  const forget = () => {
    words.fill("");
    words = [];
    extra = false;
  };

  const close = () => {
    run++;
    forget();
    if (body) body.replaceChildren();
    sheet?.classList.add("hidden");
  };
  document.getElementById("sdw-close")?.addEventListener("click", close);

  const progress = (step: Step) => {
    if (!bar) return;
    const at = step === "lock" || step === "restart" ? 0 : step === "reveal" || step === "words" ? 1 : 2;
    bar.querySelectorAll("i").forEach((i, n) => i.classList.toggle("on", n <= at));
  };

  const show = (step: Step, html: string) => {
    if (!body) return;
    progress(step);
    body.dataset.step = step;
    body.innerHTML = html;
  };

  const errBox = (e: unknown) =>
    `<div class="warnbox sdw-gap">${esc(t(String((e as Error)?.message ?? e ?? "").trim()))}</div>`;

  /* ── ① 암호 만들기 ─────────────────────────────────────────── */
  function paintLock() {
    const shop = deps.mode() === "shop";
    show(
      "lock",
      `<p>${copyHtml("복구 단어는 암호를 건 지갑에서만 꺼낼 수 있어요. 먼저 지갑 암호를 만들어요.")}</p>
       <div class="warnbox">
         <b>${copyHtml("이 암호를 잊으면 돈과 자산은 영원히 사라집니다.")}</b><br />
         ${copyHtml("이 앱도, 레이븐코인도, 누구도 되돌릴 수 없습니다. 복구 방법이 없습니다.")}
       </div>
       <p class="meta sdw-gap">${copyHtml("암호를 걸면 지갑 프로그램(노드)이 잠깐 꺼졌다가 저절로 다시 켜져요. 1~2분쯤 걸리고, 켜지면 바로 다음 단계로 넘어가요.")}</p>
       ${shop ? `<div class="warnbox sdw-gap">${copyHtml("그동안 가게의 결제 확인도 멈춰요. 영업 중이면 나중에 하세요.")}</div>` : ""}
       <label class="sdw-gap">${copyHtml("새 암호 (10자 이상)")}<input id="sdw-new" type="password" autocomplete="new-password" /></label>
       <label>${copyHtml("한 번 더")}<input id="sdw-new2" type="password" autocomplete="new-password" /></label>
       <p id="sdw-why" class="meta"></p>
       <div class="confirmbox">
         <div>${copyHtml("아래 문장을 그대로 입력하세요.")}</div>
         <pre class="conf">${copyHtml(PHRASE)}</pre>
         <input id="sdw-confirm" autocomplete="off" spellcheck="false" />
         <button id="sdw-lock-go" disabled>${copyHtml("암호 걸고 계속")}</button>
       </div>
       <div id="sdw-lock-out"></div>`,
    );
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
    const go = document.getElementById("sdw-lock-go") as HTMLButtonElement;
    const gate = () => {
      const a = v("sdw-new"), b = v("sdw-new2"), typed = v("sdw-confirm").trim();
      const phraseOk = typed === PHRASE || typed === t(PHRASE);
      go.disabled = !(a.length >= 10 && a === b && phraseOk);
      // 🔴 단추만 안 눌리면 고장인 줄 안다. 왜 안 되는지 적는다(지갑 화면과 같은 말).
      const why = document.getElementById("sdw-why");
      if (!why) return;
      if (a && a.length < 10) setCopyText(why, () => tf("암호가 짧습니다. {0}글자 더 필요합니다.", 10 - a.length));
      else if (b && a !== b) setCopyText(why, () => t("두 번 넣은 암호가 다릅니다."));
      else if (a && a === b && !phraseOk) setCopyText(why, () => t("아래 문장을 그대로 입력하시면 됩니다."));
      else why.textContent = "";
    };
    ["sdw-new", "sdw-new2", "sdw-confirm"].forEach((id) => document.getElementById(id)?.addEventListener("input", gate));
    go.addEventListener("click", () => void lockAndRestart(v("sdw-new"), v("sdw-new2")));
  }

  async function lockAndRestart(pass: string, again: string) {
    const mine = ++run;
    const go = document.getElementById("sdw-lock-go") as HTMLButtonElement | null;
    const out = document.getElementById("sdw-lock-out");
    if (go) go.disabled = true;
    let sure = true;
    try {
      const r = await deps.invoke<any>("encrypt_wallet", { passphrase: pass, confirm: again });
      sure = r?.sure !== false;
      // 🔴 지갑 화면의 암호 걸기와 같게: 이 암호 하나로 백업도 열리게 해 둔다.
      //    암호를 손에 쥔 때가 지금뿐이다(우리는 암호를 저장하지 않는다).
      await deps.invoke("backup_pass_set", { pass, walletPass: pass }).catch(() => null);
    } catch (e) {
      if (mine !== run) return;
      if (out) out.innerHTML = errBox(e);
      if (go) go.disabled = false;
      return;
    }
    // 칸을 비운다. 암호를 화면에 남겨 두지 않는다.
    ["sdw-new", "sdw-new2", "sdw-confirm"].forEach((id) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = "";
    });
    deps.changed();
    if (mine !== run) return;
    await restart(mine, sure);
  }

  /* ── 노드를 다시 켜고 기다린다 ─────────────────────────────────
     암호를 걸면 노드가 스스로 꺼진다(비트코인에서 물려받은 동작). 사람에게
     「노드를 다시 켜세요」라고 시키지 않고 여기서 켠다 — **노드만.** */
  async function restart(mine: number, sure: boolean) {
    show(
      "restart",
      `<p><b>${copyHtml("암호를 걸었어요.")}</b> ${copyHtml("암호를 종이에 적어 이 컴퓨터가 아닌 곳에 두세요.")}</p>
       <p class="meta sdw-gap" id="sdw-wait" role="status" aria-live="polite"></p>`,
    );
    const say = (s: string) => {
      const el = document.getElementById("sdw-wait");
      if (el && mine === run) setCopyText(el, () => t(s));
    };
    say("지갑 프로그램(노드)이 꺼지기를 기다리는 중…");
    // ① 꺼질 때까지(최대 90초 — 장부를 디스크에 내리느라 늦게 꺼지는 컴퓨터가 있다).
    //    꺼지기 전에 켜라고 하면 「이미 켜져 있다」로 끝나고, 곧 꺼진다.
    let down = false;
    for (const t0 = Date.now(); Date.now() - t0 < 90_000; ) {
      if (mine !== run) return;
      try {
        await deps.invoke("wallet_lock_state");
      } catch (e) {
        if (!warming(e)) {
          down = true;
          break;
        }
      }
      await sleep(1000);
    }
    // 잠금 파일이 풀릴 틈을 준다. 바로 켜면 「이미 쓰는 중」으로 죽는다.
    if (down) await sleep(2000);
    say("지갑 프로그램(노드)을 다시 켜는 중…");
    let lastStart = 0;
    const start = async () => {
      lastStart = Date.now();
      await deps.invoke("services_start", { only: "node" }).catch(() => null);
    };
    await start();
    // ② 지갑이 답할 때까지(최대 5분). 장부를 여는 중이면 그렇다고 말한다.
    for (const t0 = Date.now(); Date.now() - t0 < 300_000; ) {
      if (mine !== run) return;
      try {
        const l = await deps.invoke<any>("wallet_lock_state");
        if (l?.encrypted) {
          deps.changed();
          paintReveal(true);
          return;
        }
        if (l && !l.encrypted) {
          // 🔴 떴는데 암호가 없다 — 걸리지 않은 것이다. 「걸었다」고 말하지 않는다.
          if (!sure || Date.now() - t0 > 20_000) {
            paintLock();
            const out = document.getElementById("sdw-lock-out");
            if (out) out.innerHTML = errBox(t("암호가 걸리지 않았어요. 다시 해 주세요."));
            return;
          }
        }
      } catch (e) {
        if (warming(e)) say("장부를 여는 중이에요. 몇 분 걸릴 수 있어요…");
        else if (Date.now() - lastStart > 15_000) {
          // 켜라고 했는데 아직 꺼져 있다 — 꺼지던 중에 불렀을 수 있다. 한 번 더.
          say("지갑 프로그램(노드)을 다시 켜는 중…");
          await start();
        }
      }
      await sleep(2000);
    }
    if (mine !== run) return;
    const el = document.getElementById("sdw-wait");
    if (el) {
      el.className = "warnbox sdw-gap";
      setCopyText(el, () => t("지갑 프로그램이 아직 안 켜졌어요. 왼쪽 아래 연결 점을 눌러 켠 뒤, 이 창을 다시 열어 주세요 — 암호는 이미 걸려 있어요."));
    }
  }

  /* ── ② 암호 넣고 단어 보기 ─────────────────────────────────── */
  function paintReveal(justLocked: boolean) {
    show(
      "reveal",
      `${justLocked ? `<p class="okline">${copyHtml("지갑이 다시 열렸어요. 방금 만든 암호를 한 번 더 넣어 주세요.")}</p>` : ""}
       <p>${copyHtml("지갑 암호를 넣으면 복구 단어가 보여요. 주변에 사람이 없는지 먼저 보세요.")}</p>
       <label class="sdw-gap">${copyHtml("지갑 암호")}<input id="sdw-pass" type="password" autocomplete="current-password" /></label>
       <button id="sdw-show">${copyHtml("단어 보기")}</button>
       <div id="sdw-out"></div>`,
    );
    const pass = document.getElementById("sdw-pass") as HTMLInputElement;
    const go = document.getElementById("sdw-show") as HTMLButtonElement;
    pass.focus();
    const reveal = async () => {
      const mine = run;
      if (!pass.value) return;
      go.disabled = true;
      try {
        const r = await deps.invoke<any>("reveal_seed", { passphrase: pass.value });
        pass.value = "";
        if (mine !== run) return;
        words = (r?.words || []).map(String);
        extra = !!r?.has_extra_passphrase;
        if (!words.length) throw new Error(t("이 지갑에는 복구 단어가 없습니다."));
        paintWords("");
      } catch (e) {
        pass.value = "";
        if (mine !== run) return;
        go.disabled = false;
        const out = document.getElementById("sdw-out");
        if (out) out.innerHTML = errBox(e);
      }
    };
    go.addEventListener("click", () => void reveal());
    pass.addEventListener("keydown", (e) => { if (e.key === "Enter") void reveal(); });
  }

  /* ── 단어 ─────────────────────────────────────────────────── */
  function paintWords(again: string) {
    show(
      "words",
      `${again ? `<div class="warnbox">${esc(again)}</div>` : ""}
       <div class="warnbox sdw-gap">
         <b>${copyHtml("이 단어를 아는 사람은 지갑 전부를 가져갈 수 있습니다.")}</b><br />
         ${copyHtml("사진 찍지 마세요. 메모 앱에 적지 마세요. 남에게 보여주지 마세요.")}<br />
         ${copyHtml("종이에 적어 이 컴퓨터가 아닌 곳에 두세요.")}
       </div>
       <div class="seedgrid sdw-words" translate="no">${words
         .map((w, i) => `<div class="seedword"><i>${i + 1}</i>${esc(w)}</div>`)
         .join("")}</div>
       ${extra ? `<p class="danger">${copyHtml("이 지갑에는 단어 외에 추가 암호가 걸려 있습니다. 그 암호도 함께 기억해야 복구됩니다.")}</p>` : ""}
       <p class="meta">${copyHtml("다 적으셨으면 아래를 누르세요. 적은 종이를 보고 2·6·10번째 단어를 여쭤볼게요.")}</p>
       <button id="sdw-written">${copyHtml("다 적었어요")}</button>`,
    );
    document.getElementById("sdw-written")?.addEventListener("click", paintQuiz);
  }

  /* ── ③ 2·6·10번째 ──────────────────────────────────────────── */
  function paintQuiz() {
    const at = askPositions(words.length);
    show(
      "quiz",
      `<p>${copyHtml("적어 두신 종이를 보고 답해 주세요. 단어는 이제 화면에 없어요.")}</p>
       ${at
         .map(
           (n) => `<label class="sdw-gap">${esc(tf("{0}번째 단어", n))}<input data-sdw-at="${n}" autocomplete="off"
               autocapitalize="off" autocorrect="off" spellcheck="false" /></label>`,
         )
         .join("")}
       <button id="sdw-check">${copyHtml("확인")}</button>`,
    );
    const inputs = [...(body?.querySelectorAll<HTMLInputElement>("[data-sdw-at]") || [])];
    inputs[0]?.focus();
    const check = () => {
      const wrong = inputs.filter((i) => !sameWord(i.value, words[Number(i.dataset.sdwAt) - 1] || ""))
        .map((i) => Number(i.dataset.sdwAt));
      inputs.forEach((i) => (i.value = ""));
      if (wrong.length) {
        // 🔴 틀리면 다시 보여 준다. 종이에 잘못 적힌 줄은 지금 고쳐야 한다 —
        //    되살리는 날에는 고칠 수 없다.
        paintWords(tf("{0}번째 단어가 종이와 달라요. 적은 것을 하나씩 맞춰 보고 고쳐 주세요.", wrong.join("·")));
        return;
      }
      markChecked();
      forget();
      deps.changed();
      show(
        "done",
        `<p class="okline"><b>${copyHtml("적어 두셨어요.")}</b></p>
         <p>${copyHtml("그 종이가 이 지갑의 열쇠예요. 이 컴퓨터가 고장 나도 그 단어가 있으면 되살릴 수 있어요.")}</p>
         <p class="meta">${copyHtml("종이는 이 컴퓨터와 다른 곳에 두세요. 사진으로 찍어 두지 마세요.")}</p>
         <button id="sdw-done">${copyHtml("닫기")}</button>`,
      );
      document.getElementById("sdw-done")?.addEventListener("click", close);
    };
    document.getElementById("sdw-check")?.addEventListener("click", check);
    inputs.forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); }));
  }

  /** 여는 곳은 둘 — 지갑 화면의 알림 줄, 「이 컴퓨터 › 백업」의 단추. */
  async function open() {
    run++;
    forget();
    sheet?.classList.remove("hidden");
    show("reveal", `<p class="meta">${copyHtml("지갑을 확인하는 중…")}</p>`);
    const mine = run;
    let encrypted: boolean | null = null;
    try {
      encrypted = !!(await deps.invoke<any>("wallet_lock_state"))?.encrypted;
    } catch (e) {
      if (mine !== run) return;
      // 노드가 답을 못 하면 아무 단계도 못 간다. 이유를 말한다.
      show("reveal", `${errBox(warming(e) ? t("장부를 여는 중이에요. 몇 분 뒤에 다시 열어 주세요.") : e)}`);
      return;
    }
    if (mine !== run) return;
    if (encrypted) paintReveal(false);
    else paintLock();
  }

  return { open: () => void open() };
}
