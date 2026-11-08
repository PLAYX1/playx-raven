/* 지킴이 고마움 — 증서 나누기(§2) · 응원 보내기(§3). 규약 정본: docs/KEEPER-THANKS.md
 *
 * 🔴 지키는 것
 *  - 돈 보상이 아니다. 「보상·수익·이자·벌기」라는 말을 쓰지 않는다. 시세·투자 이야기도 없다.
 *  - 응원은 **사람끼리** 보내는 RVN 이다. 우리가 가져가는 몫은 없다. 새 보내기 길을 만들지 않는다 —
 *    기존 보내기 화면(main.ts openSend → 검토 → 보내기)을 받는 주소만 채워 연다. 확인·수수료·잠금 풀기는 그대로.
 *  - 받는 주소는 그 사람 이름표에 **서명으로 확인된** rvn_address(talk_profiles)일 때만. 없으면 단추도 없다.
 *  - 누가 얼마 보냈는지 공개하지 않는다. 「응원했다고 알리기」는 쪽지 초안만(금액 없음, 보내기는 내가 누른다).
 *  - 지갑 정보는 AI·서버로 보내지 않는다. 증서 주소에는 공개키(npub)만 실린다.
 *  - style="" 은 CSP 가 막는다 — 모양은 keeper-thanks.css.
 */
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./keeper-thanks.css";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const el = (id: string) => document.getElementById(id);
/** 메인넷 P2PKH 주소 모양(badges.rs valid_address 와 같은 검사). */
export const validRvnAddress = (a: string) => /^R[1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a);

/* ── §2 증서 나누기 ─────────────────────────────────────────────────── */

export type CertDeps = { invoke: Invoke; openFeedDraft: (text: string) => void };
let certUrl: string | null = null;

/** 내 소개 「기여 표시」 칸 아래에 붙인다. 칸을 다시 그릴 때마다 다시 부른다. */
export function mountCertShare(sec: HTMLElement, deps: CertDeps): void {
  sec.querySelector(".kt-cert")?.remove();
  const box = document.createElement("div");
  box.className = "kt-cert";
  box.innerHTML = `
    <p class="tk-badge-note">${copyHtml("내 표시를 증서 주소로 나눌 수 있어요. 그 주소는 열 때마다 체인 기록과 확인 서버 기록으로 다시 확인해 보여 줘요.")}</p>
    <div class="row kt-acts">
      <button type="button" class="ghost" data-kt="copy">${copyHtml("증서 나누기")}</button>
      <button type="button" class="ghost" data-kt="feed" hidden>${copyHtml("피드에 올리기")}</button>
    </div>
    <p class="meta kt-say" role="status"></p>`;
  sec.append(box);
  const say = box.querySelector<HTMLElement>(".kt-say")!;
  const feed = box.querySelector<HTMLButtonElement>('[data-kt="feed"]')!;
  const getUrl = async (): Promise<string | null> => {
    if (certUrl) return certUrl;
    try {
      const r = await deps.invoke<{ url?: string | null }>("keeper_cert_link");
      certUrl = typeof r?.url === "string" && r.url.startsWith("https://ravenvault.ex.erci.se/b/npub1") ? r.url : null;
    } catch { certUrl = null; }
    return certUrl;
  };
  box.querySelector<HTMLButtonElement>('[data-kt="copy"]')!.onclick = async () => {
    const url = await getUrl();
    if (!url) { setCopyText(say, () => t("이야기 이름(열쇠)이 아직 없어요. 이야기 화면을 한 번 열어 주세요.")); return; }
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch { /* 복사가 막혀도 주소는 보여 준다 */ }
    say.innerHTML = `${copyHtml(copied ? "증서 주소를 복사했어요." : "아래 주소를 직접 옮겨 적어 주세요.")}<br><code class="kt-url">${esc(url)}</code>`;
    feed.hidden = false;
  };
  feed.onclick = async () => {
    const url = await getUrl();
    if (url) deps.openFeedDraft(`${t("제 지킴이 증서예요. 누구나 확인할 수 있어요.")}\n${url}`);
  };
}

/* ── §3 응원 보내기 ─────────────────────────────────────────────────── */

export type TipDeps = {
  /** 기존 보내기 화면(RVN)을 연다 — 지갑 화면으로 옮기고 칸을 비운다. */
  openSendRvn: () => Promise<void>;
  /** 보내기 칸의 금액을 사토시로 채우고 다시 계산한다. */
  setQtySats: (sats: number) => void;
  /** 주소 칸을 바꾼 뒤 다시 계산한다. */
  composeChanged: () => void;
  /** 그 사람과 1:1 쪽지를 연다(보내기는 그 화면에서 내가 누른다). */
  openDm: (pubkey: string) => Promise<void>;
};

type Tip = { pubkey: string; name: string; address: string };
let tip: Tip | null = null;
let deps: TipDeps | null = null;

/** 사람 칸에 붙일 「응원 보내기」. 서명 확인된 주소가 없거나 나 자신이면 빈 칸. */
export function tipButtonHtml(pubkey: string, address: string, me: string): string {
  if (!validRvnAddress(address) || !/^[0-9a-f]{64}$/.test(pubkey) || pubkey === me) return "";
  return `<div class="kt-tip-open"><button type="button" class="ghost" data-kt-tip="${esc(pubkey)}">${copyHtml("응원 보내기")}</button>
    <p class="tk-badge-note">${copyHtml("고마운 마음을 RVN 으로 조금 전해요. 우리가 가져가는 몫은 없어요.")}</p></div>`;
}

/** 다른 길로 보내기 화면을 열면 응원 안내를 걷는다(main.ts openSend·closeSend). */
export function endTip(): void {
  tip = null;
  el("kt-tip")?.remove();
}

export async function startTip(pubkey: string, name: string, address: string): Promise<void> {
  if (!deps || !validRvnAddress(address)) return;
  await deps.openSendRvn(); // 여기서 endTip 이 불린다
  const addr = el("s-addr") as HTMLInputElement | null;
  const compose = el("send-compose");
  if (!addr || !compose) return;
  addr.value = address;
  tip = { pubkey, name, address };
  const banner = document.createElement("div");
  banner.id = "kt-tip";
  banner.className = "kt-tip";
  banner.innerHTML = `
    <p class="kt-tip-h"><b>${esc(tf("{0}님께 응원 보내기", name))}</b></p>
    <p>${copyHtml("고마운 마음을 RVN 으로 조금 전해요. 우리가 가져가는 몫은 없어요.")}</p>
    <p class="meta">${copyHtml("받는 분 주소 끝 네 글자 — 그분 이름표에 서명으로 걸린 주소예요.")}</p>
    <p class="kt-tail" translate="no">${esc(address.slice(-4))}</p>
    <div class="row kt-amounts" role="group">
      ${[1, 5, 10].map((n) => `<button type="button" class="ghost" data-kt-amt="${n}">${n} RVN</button>`).join("")}
    </div>
    <p class="meta">${copyHtml("금액은 아래 칸에 직접 적어도 돼요. 네트워크 수수료와 확인 단계는 보통 보내기와 같아요.")}</p>`;
  const pick = el("s-pick");
  if (pick) compose.insertBefore(banner, pick); else compose.prepend(banner);
  banner.querySelectorAll<HTMLButtonElement>("[data-kt-amt]").forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.ktAmt);
      if (!(n > 0)) return;
      deps?.setQtySats(Math.round(n * 1e8));
      banner.querySelectorAll("[data-kt-amt]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    };
  });
  deps.composeChanged();
  // 주소를 고치면 더는 응원이 아니다 — 안내를 걷는다(보내기는 그대로 할 수 있다).
  addr.addEventListener("input", function off() {
    if (addr.value.trim() !== address) { endTip(); addr.removeEventListener("input", off); }
  });
}

/** 보낸 뒤 — 고른 사람에게 보낸 응원이면 「응원했다고 알리기」를 붙인다(선택). */
function afterSent(ev: Event) {
  const d = (ev as CustomEvent).detail || {};
  const sent = tip;
  if (!sent || d.what !== "RVN" || d.address !== sent.address) return;
  tip = null;
  // main.ts 가 보낸 결과(s-result)를 다 그린 뒤에 붙인다.
  setTimeout(() => {
    el("kt-tip")?.remove();
    const host = el("s-result");
    if (!host) return;
    const box = document.createElement("div");
    box.className = "kt-after";
    box.innerHTML = `<p>${esc(tf("{0}님께 응원을 보냈어요. 고마워요.", sent.name))}</p>
      <p class="meta">${copyHtml("누가 얼마를 보냈는지는 어디에도 올리지 않아요.")}</p>
      <button type="button" class="ghost" data-kt-dm>${copyHtml("응원했다고 알리기")}</button>
      <p class="meta kt-say" role="status"></p>`;
    host.append(box);
    const say = box.querySelector<HTMLElement>(".kt-say")!;
    box.querySelector<HTMLButtonElement>("[data-kt-dm]")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      // 🔴 금액은 넣지 않는다.
      const draft = t("작은 응원을 보냈어요. 모두를 위해 애써 주셔서 고마워요.");
      let copied = false;
      try { await navigator.clipboard.writeText(draft); copied = true; } catch { /* 복사가 막혀도 쪽지는 연다 */ }
      try {
        await deps?.openDm(sent.pubkey);
        say.innerHTML = copied
          ? copyHtml("쪽지 화면을 열었어요. 인사말을 복사해 두었으니 붙여 넣고 보내기를 눌러 주세요.")
          : `${copyHtml("쪽지 화면을 열었어요. 이렇게 적어 보내 보세요:")} <q>${esc(draft)}</q>`;
      } catch (err) {
        say.textContent = err instanceof Error ? err.message : String(err ?? "");
      } finally {
        btn.disabled = false;
      }
    };
  }, 0);
}

/** main.ts 가 한 번 부른다. 사람 칸의 「응원 보내기」 단추는 문서 전체에서 받는다(다시 그려도 그대로). */
export function wireKeeperThanks(d: TipDeps, nameOf: (pubkey: string) => { name: string; address: string }): void {
  deps = d;
  window.addEventListener("rv-sent", afterSent);
  document.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest?.("[data-kt-tip]") as HTMLElement | null;
    if (!b) return;
    const pk = String(b.dataset.ktTip || "");
    const who = nameOf(pk);
    if (validRvnAddress(who.address)) void startTip(pk, who.name, who.address);
  });
}
