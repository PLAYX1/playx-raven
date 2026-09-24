/* 지갑 화면 맨 위의 알림 줄(0.4.8-A).
 *
 * 두 줄뿐이다. 지갑 화면의 배치(잔액·받기·보내기)는 건드리지 않고, 제목 아래에
 * 칸 하나를 끼워 넣는다 — 이 파일이 그 칸만 쓴다.
 *
 *   · 「지갑이 준비됐어요」 — 「지갑으로 쓸래요」를 고르고 처음 들어왔을 때만.
 *     🔴 노드가 아직 장부를 여는 중이면 **그렇다고** 말한다. 준비 안 된 지갑을
 *        준비됐다고 하면 잔액 0 을 보고 돈이 사라진 줄 안다.
 *   · 「복구 단어를 아직 확인하지 않으셨어요 · 지금 확인」 — 확인하면 사라진다.
 */
import { copyHtml, setCopyText, t, tf } from "./i18n";
import { seedChecked } from "./seed-check";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type WalletNotesDeps = {
  invoke: Invoke;
  mode: () => string;
  openSeedCheck: () => void;
};

/** 이번에 켠 동안 「준비됐어요」를 말할 차례인가. 저장하지 않는다 — 첫 착지에만. */
let welcome = false;

/** 「지갑으로 쓸래요」를 고르고 지갑 화면에 처음 내려앉을 때 부른다. */
export function walletWelcome() {
  welcome = true;
}

function warming(e: unknown): boolean {
  return /Loading block index|Verifying|Rewinding|Activating|Loading wallet|warming up|-28/i.test(
    String((e as Error)?.message ?? e ?? ""),
  );
}

/** 칸을 찾거나 만든다 — 제목·설명 바로 아래. 지갑 화면의 HTML 은 안 고친다. */
function box(): HTMLElement | null {
  const found = document.getElementById("w-notes");
  if (found) return found;
  const page = document.getElementById("page-wallet");
  if (!page) return null;
  const el = document.createElement("div");
  el.id = "w-notes";
  el.className = "wnotes";
  const after = page.querySelector(":scope > .lede") || page.querySelector(":scope > h2");
  if (after) after.after(el);
  else page.prepend(el);
  return el;
}

export async function paintWalletNotes(deps: WalletNotesDeps): Promise<void> {
  const el = box();
  if (!el) return;
  const wallet = deps.mode() === "wallet";

  // ── 준비됐어요 ── (지갑을 고른 사람의 첫 착지에만)
  let ready = el.querySelector<HTMLElement>("#w-ready");
  if (wallet && welcome) {
    if (!ready) {
      ready = document.createElement("div");
      ready.id = "w-ready";
      ready.setAttribute("role", "status");
      el.prepend(ready);
    }
    const line = await readyLine(deps.invoke);
    ready.className = `wnote ${line.ok ? "ok" : "wait"}`;
    setCopyText(ready, () => line.say());
  } else if (ready) {
    ready.remove();
  }

  // ── 복구 단어 확인 ──
  let seed = el.querySelector<HTMLElement>("#w-seednote");
  if (seedChecked()) {
    seed?.remove();
    return;
  }
  if (!seed) {
    seed = document.createElement("div");
    seed.id = "w-seednote";
    seed.className = "wnote warn";
    seed.innerHTML =
      `<span>${copyHtml("복구 단어를 아직 확인하지 않으셨어요")}</span>` +
      `<button class="ghost" id="w-seedgo" type="button">${copyHtml("지금 확인")}</button>`;
    seed.querySelector("button")?.addEventListener("click", () => deps.openSeedCheck());
    el.append(seed);
  }
}

/** 지금 지갑이 쓸 수 있는 상태인가 — 노드에 **직접** 물어본 그대로. */
async function readyLine(invoke: Invoke): Promise<{ ok: boolean; say: () => string }> {
  let pct: number | null = null;
  try {
    const n = await invoke<any>("node_status");
    const p = Math.max(0, Math.min(1, Number(n?.progress ?? 0)));
    pct = p > 0.9999 ? null : Math.floor(p * 1000) / 10;
  } catch (e) {
    if (warming(e)) {
      return { ok: false, say: () => t("지갑을 여는 중이에요 — 장부를 여는 데 몇 분 걸릴 수 있어요. 열리면 이 줄이 바뀌어요.") };
    }
    return {
      ok: false,
      say: () => t("지갑이 아직 열리지 않았어요 — 레이븐 프로그램이 켜지는 중이거나 꺼져 있어요. 왼쪽 아래 연결 점을 눌러 보세요."),
    };
  }
  // 노드는 답하는데 지갑이 답을 못 하면 지갑을 여는 중이다.
  try {
    await invoke("wallet_balance");
  } catch {
    return { ok: false, say: () => t("지갑을 여는 중이에요 — 장부를 여는 데 몇 분 걸릴 수 있어요. 열리면 이 줄이 바뀌어요.") };
  }
  if (pct !== null) {
    const p = pct;
    return {
      ok: true,
      say: () => tf("지갑이 준비됐어요. 지금은 장부를 따라잡는 중({0}%)이라 잔액이 다 맞기까지 시간이 걸려요. 받을 주소는 지금 만들어도 돼요.", p),
    };
  }
  return { ok: true, say: () => t("지갑이 준비됐어요. 받기·보내기를 바로 쓰실 수 있어요.") };
}
