/*
 * 오락실 게임 보관 — 화면 쪽. (2026-11-13 대표 방향: 게임은 판매자 자신의 레이븐볼트에 산다. 플랫폼은 남의 게임 창고가 아니다)
 *
 *   ① 「내 게임 보관」(판매자) — 러스트 arcade_keep.rs 가 앱이 켜져 있는 동안 30분마다 내 게임(문서+폴더)을 붙잡아 두고 바깥에 알린다.
 *      여기는 상태를 보여 주고 「내 컴퓨터가 꺼져 있으면 손님이 게임을 못 해요」를 숨기지 않는다.
 *   ② 「다른 판매자 게임 함께 보관하기 (돕기)」 — 누구에게나 기본 꺼짐(어떤 모드에서도 알아서 켜지 않는다).
 *      방식: 꺼짐 · 이 가게만 보관(확인 가게 이름 또는 판매자 주소) · 전부(확인 판매자 먼저). 용량은 사람이 고른다.
 *      켜져 있으면 10분마다: 러스트가 체인 목록+문서를 주고 → 여기서 **구매 화면과 같은 확인**(productsFromSources: 서명 · 문서의 assetName = 그 자산)
 *      → 통과한 문서 CID 만 러스트에 넘긴다. 러스트는 자기가 읽은 체인 목록으로 다시 닻을 보고 용량·상한을 지켜 붙잡는다.
 *      이미 지키는 게임은 다시 받지 않으므로 바퀴는 가볍다 — 새로 올라온 게임은 체인에 기록된 뒤 10분 안에 붙잡힌다.
 *      지갑 열쇠는 쓰지 않는다.
 */
import "./arcade-keep.css";
import { t, tf, copyHtml, setCopyText } from "./i18n";
import { mbText, shareCandidates, shareRows } from "./arcade-keep-core";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const SHARE_EVERY_MS = 10 * 60_000;
export const SHARE_FIRST_MS = 3 * 60_000;
export type ShareMode = "off" | "shops" | "all";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** 「PLAYX 게임 7개 보관 중 · 0.4 MB」 한 줄씩(가게별). 없으면 빈 목록. */
export function shareLines(v: unknown): string[] {
  return shareRows(v).map(([shop, n, mb]) => tf("{0} 게임 {1}개 보관 중 · {2}", shop, n, mb));
}

/** 「내 게임 N개 보관 중 · X MB」 — 못 붙잡은 게임이 있으면 그 수도. 아직 안 돌았으면 null. */
export function mineLine(v: any): string | null {
  if (!v || v.at == null) return null;
  if (v.error) return t("내 게임을 확인하지 못했어요. 노드와 파일창고가 켜져 있는지 봐 주세요.");
  const games = Array.isArray(v.games) ? v.games : [];
  if (!games.length) return t("아직 올린 게임이 없어요.");
  const bad = games.filter((g: any) => g?.problem).length;
  const line = tf("내 게임 {0}개 보관 중 · {1}", Number(v.kept) || 0, mbText(v.bytes));
  return bad ? `${line} · ${tf("{0}개는 보관하지 못했어요", bad)}` : line;
}

/** 돕기 한 바퀴. 꺼져 있으면 아무것도 안 한다(null). */
export async function shareRound(invoke: Invoke): Promise<any | null> {
  const st = await invoke<any>("arcade_share_get");
  if (!st || st.mode === "off") return null;
  const raw = await invoke<unknown>("arcade_share_sources");
  return invoke<any>("arcade_share_apply", { checked: shareCandidates(raw) });
}

let started = false;
let running = false;
/** 앱이 켜질 때 한 번. 꺼져 있는 동안은 설정만 읽고 끝난다. */
export function startArcadeShare(invoke: Invoke): void {
  if (started) return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await shareRound(invoke); } catch { /* 다음 바퀴에 */ } finally { running = false; }
  };
  setTimeout(() => { void tick(); setInterval(() => void tick(), SHARE_EVERY_MS); }, SHARE_FIRST_MS);
}

/** 「게임 올리기」 화면 위 — 내 게임 보관 상태 + 꺼짐 경고. */
export function paintMineKeep(box: HTMLElement, invoke: Invoke, errText: (e: unknown) => string): void {
  box.innerHTML =
    `<div class="card ar-keep"><b>${copyHtml("내 게임 보관")}</b>` +
    `<p class="meta" data-mk-line="1"></p>` +
    `<p class="ar-note">${copyHtml("게임은 내 컴퓨터에 있어요. 내 컴퓨터가 꺼져 있으면 손님이 게임을 못 해요. 손님이 많은 시간에는 켜 두세요.")}</p>` +
    `<div class="row"><button type="button" class="ghost" data-mk-now="1">${copyHtml("지금 확인")}</button></div></div>`;
  const line = box.querySelector<HTMLElement>("[data-mk-line]")!;
  const show = (v: any) => { const l = mineLine(v); if (l) line.textContent = l; else setCopyText(line, () => t("앱이 켜져 있는 동안 30분마다 내 게임을 붙잡아 두고 바깥에 알려요.")); };
  void invoke<any>("arcade_mine_state").then(show).catch(() => show(null));
  const btn = box.querySelector<HTMLButtonElement>("[data-mk-now]")!;
  btn.onclick = async () => {
    btn.disabled = true;
    setCopyText(line, () => t("내 게임을 확인하는 중…"));
    try { show(await invoke<any>("arcade_mine_round")); } catch (e) { line.textContent = errText(e); } finally { btn.disabled = false; }
  };
}

/** 돕는 중 화면 — 「다른 판매자 게임 함께 보관하기 (돕기)」. */
export function paintShareCard(box: HTMLElement, invoke: Invoke, errText: (e: unknown) => string): void {
  const draw = (v: any) => {
    const mode: ShareMode = v?.mode === "shops" || v?.mode === "all" ? v.mode : "off";
    const picks: string[] = Array.isArray(v?.picks) ? v.picks : [];
    const choices: number[] = Array.isArray(v?.choicesMb) ? v.choicesMb : [256, 512, 1024, 2048, 5120];
    const lines = shareLines(v);
    const opt = (m: ShareMode, label: string) =>
      `<label class="ar-opt"><input type="radio" name="as-mode" value="${m}"${mode === m ? " checked" : ""}/> <span>${copyHtml(label)}</span></label>`;
    box.innerHTML =
      `<div class="card ar-keep"><b>${copyHtml("다른 판매자 게임 함께 보관하기 (돕기)")}</b>` +
      `<p class="meta" style="margin-top:8px">${copyHtml("판매자 컴퓨터가 꺼져 있어도 손님이 게임을 할 수 있게 이 컴퓨터가 함께 들고 있어요. 서명이 맞고 공개 장부가 가리키는 게임만, 고른 용량 안에서만 받아요. 지갑 열쇠는 쓰지 않아요.")}</p>` +
      `<div class="ar-opts" role="radiogroup">${opt("off", "안 하기")}${opt("shops", "이 가게만 보관")}${opt("all", "모든 게임(확인 판매자 먼저)")}</div>` +
      `<div data-as-picks="1"${mode === "shops" ? "" : " hidden"}>` +
      `<input type="text" class="ar-search" data-as-input="1" maxlength="1200" autocomplete="off" spellcheck="false" value="${esc(picks.join(", "))}" placeholder="${esc(t("가게 이름 또는 판매자 주소 (쉼표로 여럿)"))}" aria-label="${esc(t("가게 이름 또는 판매자 주소 (쉼표로 여럿)"))}" />` +
      `</div>` +
      `<label class="meta">${copyHtml("쓸 용량")} <select data-as-budget="1">${choices.map((mb) => `<option value="${mb}"${Number(v?.budgetMb) === mb ? " selected" : ""}>${mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>`).join("")}</select></label>` +
      `<div class="row"><button type="button" data-as-save="1">${copyHtml("저장")}</button>${mode === "off" ? "" : `<button type="button" class="ghost" data-as-now="1">${copyHtml("지금 한 바퀴")}</button>`}</div>` +
      `<div class="meta" data-as-out="1">${mode === "off" ? copyHtml("꺼져 있어요.") : lines.length ? lines.map(esc).join("<br>") : copyHtml("아직 보관한 게임이 없어요.")}</div>` +
      `</div>`;
    const $ = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
    box.querySelectorAll<HTMLInputElement>('input[name="as-mode"]').forEach((r) => {
      r.onchange = () => { $("[data-as-picks]").hidden = r.value !== "shops" || !r.checked; };
    });
    const out = $("[data-as-out]");
    $<HTMLButtonElement>("[data-as-save]").onclick = async () => {
      const m = box.querySelector<HTMLInputElement>('input[name="as-mode"]:checked')?.value ?? "off";
      const list = $<HTMLInputElement>("[data-as-input]").value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (m === "shops" && !list.length) { setCopyText(out, () => t("보관할 가게 이름을 적어 주세요.")); return; }
      try { draw(await invoke<any>("arcade_share_set", { mode: m, picks: list, budgetMb: Number($<HTMLSelectElement>("[data-as-budget]").value) })); }
      catch (e) { out.textContent = errText(e); }
    };
    box.querySelector<HTMLButtonElement>("[data-as-now]")?.addEventListener("click", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      setCopyText(out, () => t("게임을 확인하고 붙잡는 중…"));
      try { const r = await shareRound(invoke); draw(r ?? await invoke<any>("arcade_share_get")); } catch (err) { out.textContent = errText(err); b.disabled = false; }
    });
  };
  void invoke<any>("arcade_share_get").then(draw).catch((e) => { box.textContent = errText(e); });
}
