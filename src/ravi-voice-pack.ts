// 라비 목소리 받기 — 설정 「라비와 AI」 카드와 라비 말풍선 옆 안내가 같은 상태를 보여 준다.
// 모델(약 380MB)은 설치 파일에 없다. 사용자가 「받기」를 누르면 앱(Rust)이 한 번 받아 앱 자료 폴더에 둔다.
// 받기 전·실패·지움에서는 기존처럼 기기 목소리로 말한다(폴백은 ravi-tts / ravi-voice 가 이미 한다).
// 시험: scripts/ravi-voice-pack.test.mjs (가짜 invoke)
import { t, tf } from "./i18n";

export interface PackStatus { installed?: boolean; removable?: boolean; downloading?: boolean; done?: number; total?: number; last?: { ok?: boolean; reason?: string; needMb?: number; haveMb?: number } | null }
export interface PackDeps {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 받기를 끝냈거나 지웠을 때: 화면의 합성 엔진을 새로 만들게 한다(「못 씀」으로 굳은 상태를 푼다). */
  reset(): void;
  /** 받기를 끝냈을 때 「라비 목소리」를 쓰도록 맞춘다. */
  useRavi(): void;
  later: { get(): boolean; set(v: boolean): void };
  pollMs?: number;
}
const MB = 1_048_576;
export const SIZE_MB = 380;

export function reasonText(last: NonNullable<PackStatus["last"]>): string {
  switch (last.reason) {
    case "nospace": return tf("저장 공간이 모자라 시작하지 않았어요. 약 {0}MB가 필요한데 지금 {1}MB 남아 있어요. 공간을 비운 뒤 다시 눌러 주세요. 그동안은 기기 목소리로 말해요.", last.needMb ?? SIZE_MB * 1.5, last.haveMb ?? 0);
    case "cancelled": return t("받기를 멈췄어요. 그동안은 기기 목소리로 말해요.");
    case "mismatch": return t("받은 파일이 맞지 않아 지웠어요. 다시 받아 보세요. 그동안은 기기 목소리로 말해요.");
    case "insecure": return t("안전한 연결이 아니라서 받지 않았어요. 그동안은 기기 목소리로 말해요.");
    case "io": return t("파일을 저장하지 못했어요. 저장 공간을 확인한 뒤 다시 눌러 주세요. 그동안은 기기 목소리로 말해요.");
    case "busy": return t("이미 받고 있어요.");
    default: return t("인터넷이 끊겼거나 받는 곳에 닿지 못했어요. 나중에 다시 눌러 주세요. 그동안은 기기 목소리로 말해요.");
  }
}

export function mountVoicePack(d: PackDeps) {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const ids = ["ravi-pack-card", "ravi-pack-get", "ravi-pack-later", "ravi-pack-cancel", "ravi-pack-remove", "ravi-pack-bar", "ravi-pack-note", "ravi-pack-nudge", "ravi-pack-nudge-get", "ravi-pack-nudge-later", "ravi-pack-nudge-text"];
  if (ids.some(i => !document.getElementById(i))) return undefined;
  const get = $("ravi-pack-get") as HTMLButtonElement, laterBtn = $("ravi-pack-later") as HTMLButtonElement, cancel = $("ravi-pack-cancel") as HTMLButtonElement, remove = $("ravi-pack-remove") as HTMLButtonElement;
  const bar = $("ravi-pack-bar") as HTMLProgressElement, note = $("ravi-pack-note"), nudge = $("ravi-pack-nudge"), nGet = $("ravi-pack-nudge-get") as HTMLButtonElement, nLater = $("ravi-pack-nudge-later") as HTMLButtonElement, nText = $("ravi-pack-nudge-text");
  let st: PackStatus = {}, timer = 0, confirmRemove = false, message = "", startedByUser = false, wantRavi = () => true;
  const sleep = (ms: number) => new Promise<void>(r => { timer = window.setTimeout(r, ms); });

  function render() {
    const downloading = !!st.downloading, installed = !!st.installed && !downloading;
    const pct = st.total ? Math.min(100, Math.floor(((st.done ?? 0) / st.total) * 100)) : 0;
    const showGet = !installed && !downloading;
    get.hidden = !showGet; laterBtn.hidden = !showGet; cancel.hidden = !downloading; remove.hidden = !(installed && st.removable) || false;
    get.textContent = message && st.last && !st.last.ok && !downloading ? t("다시 받기") : t("받기");
    laterBtn.textContent = t("나중에");
    cancel.textContent = t("취소");
    remove.textContent = t(confirmRemove ? "정말 지울까요? 한 번 더 누르면 지워요" : "지우기");
    bar.hidden = !downloading; bar.max = 100; bar.value = pct;
    bar.setAttribute("aria-label", t("라비 목소리 받는 중"));
    note.textContent = downloading ? tf("받는 중 {0}% ({1}MB / {2}MB)", pct, Math.floor((st.done ?? 0) / MB), Math.floor((st.total ?? 0) / MB))
      : message || (installed ? t("받았어요. 이 컴퓨터 안에서 AI 음성으로 말해요. 인터넷으로 보내지 않아요.") : "");
    // 말풍선 옆 안내: 라비 목소리를 쓰려는데 아직 없고, 「나중에」를 안 눌렀을 때만(받는 중에는 진행만).
    const showNudge = downloading || (!installed && wantRavi() && !d.later.get());
    nudge.hidden = !showNudge;
    nText.textContent = downloading ? tf("라비 목소리 받는 중 {0}%", pct) : t("라비 목소리를 받으면 라비가 AI 음성으로 읽어 줘요(약 380MB, 한 번만). 와이파이에서 받는 걸 권해요.");
    nGet.hidden = downloading; nLater.hidden = downloading; nGet.textContent = t("받기"); nLater.textContent = t("나중에");
  }

  async function refresh() { try { st = (await d.invoke("ravi_voice_pack_status") as PackStatus) ?? {}; } catch { st = {}; } render(); return st; }

  async function follow() {
    // 화면이 다시 열려도 이어서 따라간다(받기는 Rust 가 계속 한다).
    for (;;) {
      await refresh();
      if (!st.downloading) break;
      await sleep(d.pollMs ?? 500);
    }
    const last = st.last;
    if (st.installed) {
      message = ""; d.reset();
      if (startedByUser) d.useRavi();
      startedByUser = false;
    } else if (last && last.ok === false) message = reasonText(last);
    render();
  }

  async function start() {
    message = ""; confirmRemove = false; startedByUser = true;
    let r: { ok?: boolean; reason?: string; needMb?: number; haveMb?: number; already?: boolean } | null = null;
    try { r = await d.invoke("ravi_voice_download") as typeof r; } catch { r = { ok: false, reason: "network" }; }
    if (!r?.ok) { message = reasonText({ ok: false, ...(r ?? { reason: "network" }) }); st = { ...st, last: { ok: false, reason: r?.reason } }; startedByUser = false; await refresh(); message = reasonText({ ok: false, ...(r ?? {}) }); render(); return; }
    await follow();
  }

  get.onclick = nGet.onclick = () => { void start(); };
  laterBtn.onclick = nLater.onclick = () => { d.later.set(true); message = t("나중에 받고 싶으면 여기서 「받기」를 눌러 주세요."); render(); };
  cancel.onclick = () => { void d.invoke("ravi_voice_cancel").catch(() => {}); };
  remove.onclick = async () => {
    if (!confirmRemove) { confirmRemove = true; render(); return; }
    confirmRemove = false; d.reset();
    let ok = false; try { ok = !!((await d.invoke("ravi_voice_remove")) as { ok?: boolean } | null)?.ok; } catch { ok = false; }
    message = ok ? t("지웠어요. 지금부터는 기기 목소리로 말해요. 다시 받을 수 있어요.") : t("지우지 못했어요. 받는 중이면 끝난 뒤에 다시 눌러 주세요.");
    d.later.set(false); await refresh(); render();
  };
  return {
    refresh: async (want?: () => boolean) => { if (want) wantRavi = want; await refresh(); if (st.downloading) void follow(); },
    /** 「라비 목소리」 ↔ 「기기 목소리」 선택이 바뀌면 안내를 다시 그린다. */
    setWant(fn: () => boolean) { wantRavi = fn; render(); },
    get status() { return st; },
    dispose() { clearTimeout(timer); },
  };
}
