/* 이야기 「신고」 — 말풍선 메뉴(src/talk-desk.ts)에서 연다. 방 글·쪽지 둘 다.
 *
 * 🔴 새 서버를 만들지 않는다. 「문제 알리기」와 같은 길(report_send → rvn.ex.erci.se/api/bug-reports → px_bug_reports)로
 *    category "counterparty"(「거래 상대 문제」 — 서버 허용 목록에 이미 있는 값)를 단다. 인터넷이 안 되면 러스트가
 *    이 컴퓨터에 넣어 두고 다음에 켤 때 보낸다(report.rs park/flush).
 * 🔴 글 내용은 「이 글 함께 보내기」를 체크했을 때만 싣는다(기본 꺼짐). 쪽지는 두 사람만 읽는 글이라 더 그렇다.
 *    늘 싣는 것: 사유 · 방/쪽지 구분 · 글쓴이 공개 열쇠(이름표와 같은 공개 값) · 글 id · (공개 방이면) 방 id.
 * 신고하면 그 사람 글은 이 화면에서 곧바로 숨긴다(「안 보기」와 같은 명단 — 언제든 되돌릴 수 있다).
 */
import { copyHtml, t, tf } from "./i18n";

export type ReportDeps = {
  invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  nameOf: (pk: string) => string;
  /** 확인 창 없이 「안 보기」 명단에 넣는다(이 창이 확인이다). */
  hide: (pk: string) => void;
  room: () => string;
  dmActive: () => boolean;
  /** 쪽지를 신고했으면 그 대화를 닫는다. */
  closeDm: () => void;
  say: (msg: string) => void;
  escapeHtml: (s: unknown) => string;
};

const REASONS: [string, string][] = [["spam", "스팸"], ["scam", "사기·돈 요구"], ["abuse", "괴롭힘"], ["other", "기타"]];

let wrap: HTMLElement | null = null;

export function reportOpen(): boolean { return !!wrap && !wrap.hidden; }
export function reportClose() { if (wrap) wrap.hidden = true; }

export function openReport(d: ReportDeps, bub: HTMLElement, text: string) {
  const author = String(bub.dataset.author || "");
  const msgId = String(bub.dataset.say || bub.dataset.dm || "");
  if (!author) return;
  const dm = d.dmActive();
  const room = dm ? "" : d.room();
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "tk-repwrap"; wrap.id = "tk-report"; wrap.hidden = true;
    wrap.addEventListener("mousedown", (ev) => { if (ev.target === wrap) reportClose(); });
    document.body.append(wrap);
  }
  const esc = d.escapeHtml;
  wrap.innerHTML =
    `<div class="tk-rep" role="dialog" aria-modal="true" aria-labelledby="tk-rep-h">` +
    `<h3 id="tk-rep-h">${copyHtml("신고하기")}</h3>` +
    `<p class="tk-rep-who" translate="no">${esc(d.nameOf(author))} · …${esc(author.slice(-6))}</p>` +
    `<div class="tk-rep-chips" role="group" aria-label="${esc(t("신고 이유"))}">${REASONS.map(([k, label]) => `<button type="button" data-rep="${k}" aria-pressed="false">${copyHtml(label)}</button>`).join("")}</div>` +
    `<textarea id="tk-rep-more" maxlength="300" placeholder="${esc(t("더 적을 말 (없어도 됩니다)"))}" hidden></textarea>` +
    `<label class="tk-rep-incl"><input type="checkbox" id="tk-rep-incl" /> <span>${copyHtml("이 글 함께 보내기")}</span></label>` +
    `<p class="tk-rep-note">${copyHtml(dm ? "체크하지 않으면 쪽지 내용은 보내지 않아요. 신고하면 이 사람의 쪽지와 글이 내 화면에서 숨겨져요." : "체크하지 않으면 글 내용은 보내지 않아요. 신고하면 이 사람의 글이 내 화면에서 숨겨져요.")}</p>` +
    `<div class="tk-rep-acts"><button type="button" class="ghost" id="tk-rep-no">${copyHtml("취소")}</button><button type="button" id="tk-rep-go" disabled>${copyHtml("신고하기")}</button></div>` +
    `<p class="tk-rep-say" role="status"></p></div>`;
  let reason = "";
  const go = wrap.querySelector<HTMLButtonElement>("#tk-rep-go")!;
  const more = wrap.querySelector<HTMLTextAreaElement>("#tk-rep-more")!;
  wrap.querySelectorAll<HTMLButtonElement>("[data-rep]").forEach((b) => {
    b.onclick = () => {
      reason = String(b.dataset.rep);
      wrap!.querySelectorAll("[data-rep]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      more.hidden = reason !== "other";
      go.disabled = false;
    };
  });
  wrap.querySelector<HTMLElement>("#tk-rep-no")!.onclick = reportClose;
  go.onclick = async () => {
    if (!reason) return;
    const incl = wrap!.querySelector<HTMLInputElement>("#tk-rep-incl")!.checked;
    const label = REASONS.find(([k]) => k === reason)?.[1] || reason;
    const extra = more.value.trim();
    go.disabled = true;
    const sayEl = wrap!.querySelector<HTMLElement>(".tk-rep-say")!;
    sayEl.textContent = t("보내는 중…");
    try {
      const r = await d.invoke<any>("report_send", {
        title: `[이야기 신고] ${label}`,
        description: `[이야기 신고] ${label} · ${dm ? "쪽지" : "방"}${extra ? ` — ${extra}` : ""}`,
        category: "counterparty",
        screen: "talk",
        context: {
          kind: "talk-report", reason, where: dm ? "dm" : "room", author, message_id: msgId,
          ...(room ? { room } : {}),
          ...(incl ? { content: text.slice(0, 2000) } : {}),
          lang: document.documentElement.lang || "",
        },
        attachLog: false,
      });
      d.hide(author);
      reportClose();
      if (dm) d.closeDm();
      d.say(r?.sent ? t("신고했어요. 이 사람의 글은 이제 안 보여요.") : t("지금 인터넷이 안 닿아 이 컴퓨터에 넣어 뒀어요. 다음에 켤 때 저절로 가요. 이 사람의 글은 이제 안 보여요."));
    } catch (e) {
      go.disabled = false;
      sayEl.textContent = tf("못 보냈어요: {0}", String((e as any)?.message || e));
    }
  };
  wrap.hidden = false;
  wrap.querySelector<HTMLElement>("[data-rep]")?.focus();
}
