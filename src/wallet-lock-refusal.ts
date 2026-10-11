// 「지갑 암호 없음」 안내 — 시작 묶음(main)에 남는 작은 조각. (0.9.0 병합 때 wallet-file.ts 에서 떼어 냄)
//
// display-mode(대기화면·매장용 읽기 전용 켜기)와 트레이 메뉴 거절 이벤트가 시작 때부터 이것을 쓴다. 지갑 파일
// 화면 전체(wallet-file.ts, 압축 ≈38KB)는 main.ts 가 지연 로딩하고, 그 파일은 여기 것을 다시 내보낸다.
// 문구는 여기 한 곳에만 둔다 — wallet-file.ts 의 Copy 가 NEED_COPY 를 펼쳐 쓴다(중복 표 없음).
import { listen } from "@tauri-apps/api/event";
import { lang, coreLang } from "./i18n";

export const NEEDS_WALLET_PASS = "NEEDS_WALLET_PASS:";

export type NeedCopy = { blockedTitle: string; blockedBody: string; goWallet: string; close: string };
export const NEED_COPY: Record<"ko" | "en" | "ja" | "zh", NeedCopy> = {
  ko: {
    blockedTitle: "먼저 지갑 암호를 걸어 주세요",
    blockedBody: "지갑 암호가 아직 없어요. 암호가 없으면 잠가도 누구나 바로 풀 수 있고, 파일로 꺼낸 지갑은 그 파일을 주운 사람이 돈을 쓸 수 있어요. 지갑 화면에서 10글자 이상 암호를 정한 뒤 다시 해 주세요.",
    goWallet: "지갑 화면으로", close: "닫기",
  },
  en: {
    blockedTitle: "Set a wallet password first",
    blockedBody: "This wallet has no password yet. Without one, a lock can be opened by anyone, and anyone who finds an exported file can spend the money. Set a password of 10+ characters on the Wallet screen, then try again.",
    goWallet: "Go to Wallet", close: "Close",
  },
  ja: {
    blockedTitle: "先にウォレットのパスワードを設定してください",
    blockedBody: "ウォレットにまだパスワードがありません。パスワードがないと、ロックしても誰でも解除でき、書き出したファイルを拾った人がお金を使えます。ウォレット画面で10文字以上のパスワードを設定してから、もう一度お試しください。",
    goWallet: "ウォレット画面へ", close: "閉じる",
  },
  zh: {
    blockedTitle: "请先设置钱包密码",
    blockedBody: "此钱包还没有密码。没有密码时，加锁后任何人都能直接解锁，捡到导出文件的人也能花掉钱。请在钱包页面设置10个字符以上的密码，然后重试。",
    goWallet: "前往钱包页面", close: "关闭",
  },
};
const need = (): NeedCopy => NEED_COPY[coreLang(lang) as keyof typeof NEED_COPY] ?? NEED_COPY.ko;

type Child = Node | string | null | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { className?: string; style?: string } = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(e, rest);
  if (style) e.style.cssText = style; // CSSOM 으로 — 앱 CSP 가 style="" 속성을 막는다
  for (const k of kids) if (k) e.append(k);
  return e;
}
export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(NEEDS_WALLET_PASS, "");

function gotoWallet(): void {
  document.querySelector<HTMLElement>('nav a[data-page="wallet"]')?.click();
}

/** 지갑 암호가 없어 막혔다는 안내 상자(내보내기·대기화면·매장용 읽기 전용 공용). */
export function showNeedPass(): void {
  document.getElementById("wf-need-pass")?.remove();
  const t = need();
  const box = el("div", { id: "wf-need-pass", className: "card" },
    el("h3", { textContent: t.blockedTitle }),
    el("p", { className: "meta", textContent: t.blockedBody }),
    el("div", { className: "row" },
      Object.assign(el("button", { textContent: t.goWallet }), { onclick: () => { box.remove(); gotoWallet(); } }),
      Object.assign(el("button", { className: "ghost", textContent: t.close }), { onclick: () => box.remove() })));
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", t.blockedTitle);
  Object.assign(box.style, { position: "fixed", left: "50%", top: "20%", transform: "translateX(-50%)", zIndex: "9999", maxWidth: "min(92vw,520px)", boxShadow: "0 12px 40px rgba(0,0,0,.35)", borderColor: "var(--warn)" });
  document.body.append(box);
  box.querySelector("button")?.focus();
}

/** Rust 가 돌려준 오류가 「지갑 암호 없음」이면 안내 상자를 띄우고 true. */
export function handleLockRefusal(e: unknown): boolean {
  const msg = typeof e === "string" ? e : String((e as Error)?.message ?? "");
  if (!msg.startsWith(NEEDS_WALLET_PASS)) return false;
  showNeedPass();
  return true;
}

if (typeof document !== "undefined") {
  // 트레이 메뉴의 대기화면 켜기가 지갑 암호 없어서 거절되면 큰 창에 안내를 띄운다(Rust → app-lock-refused).
  const go = () => void listen<string>("app-lock-refused", (e) => { if (!handleLockRefusal(e.payload)) { /* 다른 이유는 조용히 */ } }).catch(() => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
}
