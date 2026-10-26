/* 「체인 정보」 화면과 홈 한 줄 요약. 값은 Rust 명령(`chain_overview`·`chain_security`)에서만 온다.
 * 못 읽으면 가짜 값 대신 이유 문구를 보여 준다. 숫자 옆에는 출처와 기준 시각을 같이 둔다. */
import "./chain-info.css";
import { t, tf, lang } from "./i18n";
import { ageParts, overviewView, securityView, type OverviewRaw, type SecurityRaw } from "./chain-info";

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const nowSec = () => Math.floor(Date.now() / 1000);
const agoText = (asOf: number | null): string => {
  const p = ageParts(nowSec(), asOf);
  return !p ? "" : p.key === "방금" ? t(p.key) : tf(p.key, p.n);
};
const whenText = (asOf: number): string => new Date(asOf * 1000).toLocaleString(lang, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

export function renderChainPage(ov: OverviewRaw | null, sec: SecurityRaw | null, nodeError: boolean, now = nowSec()): string {
  const o = overviewView(ov, lang);
  const s = securityView(sec, now, lang);
  const nodeSrc = o.asOf !== null ? `<p class="ci-src">${esc(tf("출처: 내 노드 · {0}", agoText(o.asOf)))}</p>` : "";
  const nodeOff = `<p class="ci-note" data-tone="warn">${esc(t("내 노드를 읽지 못했어요. 노드가 켜져 있는지 확인해 주세요."))}</p>`;
  const syncing = o.state === "syncing"
    ? `<p class="ci-note" data-tone="warn">${esc(tf("내 노드가 아직 따라잡는 중이에요 ({0}%). 끝나면 숫자가 정확해져요.", o.syncPercent === null ? "?" : o.syncPercent.toLocaleString(lang)))}</p>` : "";
  const blockCard = `<section class="ci-card" data-card="blocks"><h2>${esc(t("블록 높이"))}</h2>
    <div class="ci-big">${o.blocks === null ? "–" : esc(o.blocks)}</div>${o.state === "none" ? (nodeError ? nodeOff : "") : syncing}${nodeSrc}</section>`;
  const extra = [o.difficulty !== null ? tf("난이도 {0}", o.difficulty) : null, o.mempool !== null ? tf("대기 거래 {0}건", o.mempool) : null, o.peers !== null ? tf("연결된 상대 {0}곳", o.peers) : null].filter(Boolean) as string[];
  const hashCard = `<section class="ci-card" data-card="hashrate"><h2>${esc(t("네트워크 해시율"))}</h2>
    <div class="ci-big">${o.hashrate === null ? "–" : esc(o.hashrate)}</div>
    <p class="ci-note">${esc(t(o.state === "syncing" ? "따라잡는 중에는 해시율을 말씀드리지 않아요." : "채굴 컴퓨터들의 힘이에요. 내 노드가 계산해요."))}</p>
    ${extra.length ? `<p class="ci-sub">${esc(extra.join(" · "))}</p>` : ""}${nodeSrc}</section>`;
  let secBody: string;
  if (s.state === "none") {
    secBody = `<div class="ci-big">–</div><p class="ci-note" data-tone="warn">${esc(t("보안 비용을 계산하는 외부 정보를 지금은 읽을 수 없어요."))}</p>`;
  } else {
    const asOf = s.asOf as number;
    const lines = [
      s.state === "stale" ? `<p class="ci-note" data-tone="warn">${esc(tf("{0} 기준 값이에요. 갱신이 늦어지고 있어서 지금과 다를 수 있어요.", whenText(asOf)))}</p>` : "",
      s.state === "very_stale" ? `<p class="ci-note" data-tone="warn">${esc(t("3일 넘게 갱신되지 않았어요. 숫자는 참고만 해 주세요."))}</p>` : "",
      s.refreshFailed ? `<p class="ci-note" data-tone="warn">${esc(t("새로 받지 못해서 마지막으로 받은 값을 보여 드려요."))}</p>` : "",
    ].join("");
    secBody = `<div class="ci-big" data-dim="${s.dim}">${esc(tf("{0} / 시간", s.cost))}</div>
      <p class="ci-note">${esc(t("다른 사람이 채굴 힘을 한 시간 빌려 체인을 흔드는 데 드는 값을 어림한 거예요."))}</p>
      ${s.rank ? `<p class="ci-sub">${esc(tf("목록 {1}개 코인 중 {0}위", s.rank.rank, s.rank.of))}</p>` : ""}
      ${s.ratio ? `<p class="ci-sub">${esc(tf("빌릴 수 있는 힘 대비 네트워크 힘 {0}", s.ratio))}</p>` : ""}${lines}
      <p class="ci-src">${esc(tf("출처: crypto51.app · 기준 {0}", whenText(asOf)))}</p>
      <p class="ci-warn">${esc(t("투자 조언이 아니에요. 어림값이라 실제와 다를 수 있어요."))}</p>`;
  }
  const secCard = `<section class="ci-card" data-card="security" data-state="${s.state}"><h2>${esc(t("보안 비용 (51% 공격)"))}</h2>${secBody}</section>`;
  return `<h1>${esc(t("체인 정보"))}</h1><p class="meta">${esc(t("내 노드와 공개 목록에서 읽은 값이에요. 숫자마다 출처와 기준 시각을 같이 보여 드려요."))}</p>
    <div class="ci-actions"><button id="ci-refresh" type="button">${esc(t("새로 읽기"))}</button><button id="ci-back" type="button" class="ghost">${esc(t("홈으로 돌아가기"))}</button></div>
    <div class="ci-grid">${blockCard}${hashCard}${secCard}</div>`;
}

/** 홈 한 줄 요약. 읽은 것만 잇고, 하나도 없으면 「열기」 문구. */
export function renderChainStrip(ov: OverviewRaw | null, sec: SecurityRaw | null, now = nowSec()): { text: string; state: string } {
  const o = overviewView(ov, lang);
  const s = securityView(sec, now, lang);
  const parts = [
    o.blocks !== null ? tf("블록 {0}", o.blocks) : null,
    o.hashrate !== null ? tf("해시율 {0}", o.hashrate) : null,
    s.cost !== null ? tf("보안 비용 {0}/시간", s.cost) : null,
  ].filter(Boolean) as string[];
  return { text: parts.length ? parts.join(" · ") : t("체인 정보 열기"), state: s.state === "none" ? o.state : s.state };
}

export function wireChainInfo(o: { invoke: Invoke; showPage: (id: string) => void }) {
  const page = document.getElementById("page-chain");
  const strip = document.getElementById("rv-home-chain") as HTMLButtonElement | null;
  const open = document.getElementById("rv-home-chain-open") as HTMLButtonElement | null;
  if (!page) return { enter() {}, paintHome() {} };
  let ov: OverviewRaw | null = null, sec: SecurityRaw | null = null, nodeError = false, readAt = 0, reading: Promise<void> | null = null;
  const paintStrip = () => {
    if (!strip) return;
    const v = renderChainStrip(ov, sec);
    strip.innerHTML = `<strong>${esc(t("체인 정보"))}</strong><span>${esc(v.text)}</span>`;
    strip.dataset.state = v.state;
  };
  const paintPage = () => { page.innerHTML = renderChainPage(ov, sec, nodeError); };
  const read = (): Promise<void> => (reading ??= (async () => {
    const [a, b] = await Promise.allSettled([o.invoke<OverviewRaw>("chain_overview"), o.invoke<SecurityRaw>("chain_security")]);
    nodeError = a.status !== "fulfilled";
    ov = a.status === "fulfilled" ? a.value : null;
    sec = b.status === "fulfilled" ? b.value : null;
    readAt = Date.now();
  })().finally(() => { reading = null; paintStrip(); if (page.classList.contains("on")) paintPage(); }));
  page.addEventListener("click", e => {
    const id = (e.target as HTMLElement).closest("button")?.id;
    if (id === "ci-refresh") { page.querySelector("#ci-refresh")?.setAttribute("disabled", ""); void read(); }
    if (id === "ci-back") o.showPage("home");
  });
  const go = () => o.showPage("chain");
  if (strip) strip.onclick = go;
  if (open) open.onclick = go;
  window.addEventListener("desktop-language-change", () => { paintStrip(); if (page.classList.contains("on")) paintPage(); });
  // 화면이 열려 있는 동안만 30초마다 다시 읽는다(닫히면 스스로 멈춘다).
  setInterval(() => { if (page.classList.contains("on") && !document.hidden) void read(); }, 30_000);
  paintStrip();
  return {
    enter() { paintPage(); void read(); },
    paintHome() { if (Date.now() - readAt > 30_000) void read(); },
  };
}
