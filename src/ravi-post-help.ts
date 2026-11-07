/* 라비 글쓰기 돕기(11-08) — 이야기·피드 글쓰기 칸(tk-text) 옆 「라비」 단추.
   다듬기 · 짧게 · 그림 만들기. 라비가 고친 글은 칸에 들어가기만 하고, 「보내기」는 사람이 누른다(공개 글은 못 지운다).
   지갑 주소·잔액·전화번호·12단어·키처럼 보이는 글은 AI 로 보내지 않는다. 그림은 내 AI 키로 만들고 한 장마다 요금이 나간다고 먼저 묻는다. */
import { containsRaviSecret } from "./ravi-guide";

export type PostHelpDeps = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  provider: () => string | null;
  t: (s: string) => string;
  sure: (title: string, message?: string, ok?: string) => Promise<boolean>;
  errText: (e: unknown) => string;
  /** 만든 그림을 「보낼 사진」 자리에 세운다(보내기 전). */
  stagePhoto: (p: { name: string; size: number; bytes: number[]; preview: string }) => void;
};

const RVN_ADDRESS = /\b[Rr][1-9A-HJ-NP-Za-km-z]{33}\b/;
const PHONE = /(?:\+?82[- ]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/;
const MONEY_WORDS = /(잔액|잔고|balance|残高|余额)\s*[:=]?\s*\d/i;
/** AI 로 보내면 안 되는 글인가. */
export function postLooksPrivate(text: string): boolean {
  return containsRaviSecret(text) || RVN_ADDRESS.test(text) || PHONE.test(text) || MONEY_WORDS.test(text);
}
const CLAIMS = /(수익|투자|시세|오른다|오를|대박|보장|보증|확실|최고|guarantee|profit|invest|to the moon)/gi;
/** 라비가 돌려준 글을 받을지. 원래 글에 없던 과장·돈 낱말이 생기면 받지 않는다. */
export function acceptPostText(raw: unknown, original: string): { ok: true; text: string } | { ok: false; why: string } {
  const t = typeof raw === "string" ? raw.trim().replace(/^["“「『]([\s\S]*)["”」』]$/, "$1").trim() : "";
  if (!t) return { ok: false, why: "라비가 답하지 못했어요. 잠시 뒤 다시 눌러 주세요." };
  if ([...t].length > 1000) return { ok: false, why: "라비가 쓴 글이 너무 길어 넣지 않았어요." };
  if (postLooksPrivate(t)) return { ok: false, why: "라비가 쓴 글에 개인정보처럼 보이는 말이 있어 넣지 않았어요." };
  const had = new Set((original.match(CLAIMS) ?? []).map(w => w.toLowerCase()));
  if ((t.match(CLAIMS) ?? []).some(w => !had.has(w.toLowerCase()))) return { ok: false, why: "라비가 쓴 글에 과장되거나 돈과 이어지는 말이 생겨 넣지 않았어요. 내 글은 그대로예요." };
  if (t === original.trim()) return { ok: false, why: "고칠 곳이 거의 없어요. 지금 글 그대로 좋아요." };
  return { ok: true, text: t };
}

const AI_MARK = "· 라비가 그린 그림";

export function wirePostHelp(d: PostHelpDeps) {
  const input = document.getElementById("tk-text") as HTMLTextAreaElement | null;
  const composer = input?.closest(".composer");
  if (!input || !composer || document.getElementById("tk-ravi")) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "tk-ravi"; btn.className = "photobtn";
  btn.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.id = "tk-ravipanel"; panel.className = "rph"; panel.hidden = true;
  const say = (s: string) => d.t(s);
  const paint = () => {
    btn.textContent = say("라비");
    btn.setAttribute("aria-label", say(panel.hidden ? "라비 도움" : "라비 도움 닫기"));
    panel.innerHTML = "";
    const head = document.createElement("p"); head.className = "rph-note";
    head.textContent = say("라비는 글만 고쳐요. 보내기는 내가 직접 눌러요. 누르면 적은 글이 내가 연결한 AI 로 가요.");
    const row = document.createElement("div"); row.className = "rph-row";
    for (const [id, label] of [["polish", "다듬기"], ["short", "짧게"], ["image", "그림 만들기"]] as const) {
      const b = document.createElement("button"); b.type = "button"; b.className = "ghost"; b.dataset.rph = id; b.textContent = say(label);
      row.append(b);
    }
    const out = document.createElement("p"); out.className = "rph-out"; out.setAttribute("role", "status"); out.hidden = true;
    const undo = document.createElement("button"); undo.type = "button"; undo.className = "ghost rph-undo"; undo.hidden = true; undo.textContent = say("되돌리기");
    panel.append(head, row, out, undo);
  };
  paint();
  composer.querySelector(".photobtn")?.after(btn);
  composer.before(panel);

  let before: string | null = null, busy = false;
  const out = () => panel.querySelector<HTMLElement>(".rph-out")!;
  const undoBtn = () => panel.querySelector<HTMLButtonElement>(".rph-undo")!;
  const tell = (s: string, good = false) => { const o = out(); o.textContent = say(s); o.hidden = !s; o.classList.toggle("good", good); };
  const setBusy = (on: boolean, label = "") => {
    busy = on;
    panel.querySelectorAll<HTMLButtonElement>("[data-rph]").forEach(b => { b.disabled = on; });
    if (on) tell(label);
  };
  const put = (text: string) => { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); };

  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    btn.setAttribute("aria-expanded", String(!panel.hidden));
    btn.setAttribute("aria-label", say(panel.hidden ? "라비 도움" : "라비 도움 닫기"));
    btn.classList.toggle("on", !panel.hidden);
  });
  panel.addEventListener("click", async e => {
    const target = e.target as HTMLElement;
    if (target.closest(".rph-undo")) { if (before !== null) put(before); before = null; undoBtn().hidden = true; tell(""); return; }
    const kind = (target.closest("[data-rph]") as HTMLElement | null)?.dataset.rph;
    if (!kind || busy) return;
    const draft = input.value.trim();
    if (!draft) { tell("먼저 글을 조금 적어 주세요."); return; }
    const provider = d.provider();
    if (!provider) { tell("라비가 아직 AI 와 이어져 있지 않아요. 설정 › AI 열쇠에서 연결하면 쓸 수 있어요."); return; }
    if (postLooksPrivate(draft)) { tell("지갑 주소·잔액·전화번호·위치처럼 보이는 말이 있어 AI 에 보내지 않았어요. 그 부분을 빼고 다시 눌러 주세요."); return; }
    if (kind === "image") {
      const ok = await d.sure(say("이 글에 어울리는 그림을 만들까요?"), say("내 AI 키(구글 또는 OpenAI)로 만들고, 한 장마다 요금이 나갑니다. 만든 그림은 보내기 전에 보여 드려요."), say("만들기"));
      if (!ok) return;
      setBusy(true, "그림을 만드는 중…");
      try {
        const prompt = `A warm, simple illustration for this social post. No text, no letters, no logos, no real people's faces. Post: ${JSON.stringify(draft.slice(0, 600))}`;
        const r = await d.invoke<{ b64?: string; mime?: string }>("ai_image", { prompt, prefer: provider });
        const b64 = String(r?.b64 || "");
        if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error(say("그림을 받지 못했습니다."));
        const mime = ["image/png", "image/jpeg", "image/webp"].includes(String(r?.mime)) ? String(r.mime) : "image/png";
        const bin = atob(b64), bytes = new Array<number>(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const preview = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        d.stagePhoto({ name: `ravi-${Date.now()}.${mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"}`, size: bytes.length, bytes, preview });
        // 받는 사람이 진짜 사진으로 오해하지 않게 — 글 끝에 「라비가 그린 그림」 표시.
        if (!input.value.includes(say(AI_MARK))) put(`${input.value.trimEnd()}\n${say(AI_MARK)}`);
        tell("그림을 붙였어요. 마음에 들면 「보내기」를 눌러 주세요. 싫으면 사진 「취소」로 뺄 수 있어요.", true);
      } catch (err) { tell(d.errText(err)); }
      finally { setBusy(false); out().hidden = !out().textContent; }
      return;
    }
    setBusy(true, kind === "short" ? "줄이는 중…" : "다듬는 중…");
    try {
      const r = await d.invoke<{ text?: unknown }>("ai_fill", { provider, task: "post_help", input: JSON.stringify({ style: kind, post: draft.slice(0, 1000) }) });
      const a = acceptPostText(r?.text, draft);
      if (a.ok) { before = input.value; put(a.text); undoBtn().hidden = false; tell("라비가 고친 글을 넣었어요. 마음대로 고쳐도 돼요.", true); }
      else tell(a.why);
    } catch (err) { tell(d.errText(err)); }
    finally { setBusy(false); }
  });
  return { repaint: paint };
}
