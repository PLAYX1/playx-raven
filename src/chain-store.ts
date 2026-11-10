/* 체인 POS ① — 「이 컴퓨터 → 가게」 안의 「체인 매장」 카드 (docs/CHAIN-POS.md). 카드가 화면에 처음 보일 때 읽는 지연 묶음.
 *
 *  - 본점(12단어 있는 PC): 「매장 열쇠 만들기」(매장 번호·이름·사업자등록번호·종사업장 번호(선택))
 *    → 설치 암호 6단어를 크게 + 꾸러미 복사·파일로 저장 → 매장 목록에서 「이 매장 끊기」(확인 창).
 *  - 매장 PC: 「본점에서 받은 꾸러미 열기」 → 꾸러미 붙여 넣기(또는 파일) + 6단어 → 끝.
 *
 * 🔴 지키는 것
 *  - 12단어는 화면에 오지 않는다. 러스트가 노드에서 받아 열쇠만 뽑고 지운다. 잠김이면 [SEED_LOCKED] → 기존 「지갑 열기」.
 *  - 설치 암호는 이 화면에 **한 번만** 보인다(저장하지 않는다). 다른 화면으로 가면 지운다.
 *  - 사용자가 적은 매장 이름은 번역하지 않는다(translate="no").
 */
import "./chain-store.css";
import { DICT } from "./dict";
import { t, tf, setCopyText } from "./i18n";
import { seedErrorKind, seedUnlockButton } from "./seed-recovery";
import { CHAIN_STORE_COPY } from "./chain-store-copy";
import { mountChainSales } from "./chain-sales";

for (const [source, values] of Object.entries(CHAIN_STORE_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
export interface ChainStoreDeps {
  invoke: Invoke;
  sure(title: string, message: string, ok: string): Promise<boolean>;
  ensureUnlocked(why: string): Promise<boolean>;
  errText(e: unknown): string;
  pickSave(name: string): Promise<string | null>;
  pickOpen(): Promise<string | null>;
}

type Row = { serial: number; store: number; name: string; storeKey: string; biz: { no: string; sub?: string }; issuedAt: number; notAfter: number; revoked: boolean };
type Status = { role: "none" | "owner" | "store"; name?: string; store?: number; serial?: number; notAfter?: number; revoked?: boolean; stores?: number; active?: number };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", copy?: () => string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (copy) setCopyText(e, copy);
  return e;
};
const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement, hint?: string): HTMLLabelElement => {
  const l = el("label", "cs-field");
  l.append(el("span", "", () => t(label)), input);
  if (hint) l.append(el("span", "cs-hint", () => t(hint)));
  return l;
};
const input = (id: string, opts: Partial<HTMLInputElement> = {}): HTMLInputElement => Object.assign(document.createElement("input"), { id, autocomplete: "off", spellcheck: false, ...opts });
const button = (label: () => string, ghost = false): HTMLButtonElement => {
  const b = el("button", ghost ? "ghost" : "", label);
  b.type = "button";
  return b;
};
const day = (ms: number) => new Date(ms).toLocaleDateString();
const bizText = (b: Row["biz"]) => (b?.no ? `${b.no.slice(0, 3)}-${b.no.slice(3, 5)}-${b.no.slice(5)}` : "") + (b?.sub ? ` · ${b.sub}` : "");

export function mountChainStore(host: HTMLElement, deps: ChainStoreDeps): { refresh(): Promise<void> } {
  const body = el("div", "cs-body");
  const note = el("p", "cs-msg");
  note.setAttribute("role", "status");
  host.replaceChildren(el("h3", "", () => t("체인 매장")),
    el("p", "meta", () => t("매장이 여러 곳이면 본점 컴퓨터 한 대에서 매장마다 열쇠를 만들어 나눠 줍니다. 매장 컴퓨터에는 12단어를 넣지 않아요.")),
    body, note);
  const say = (text: string, bad = false) => { note.textContent = text; note.classList.toggle("cs-bad", bad); };

  /** 잠김이면 「지갑 열기」 단추를 메시지 아래에 붙이고 다시 시도한다. */
  const fail = (e: unknown, retry: () => Promise<unknown>) => {
    say(deps.errText(e), true);
    if (seedErrorKind(e) === "LOCKED") seedUnlockButton(note, e, () => deps.ensureUnlocked(t("지갑을 열면 매장 열쇠 일을 다시 시도합니다.")), retry, t("지갑 열기"));
  };

  // ── 본점: 만들기 ──
  function issueForm(): HTMLElement {
    const box = el("div", "cs-part");
    box.append(el("h4", "", () => t("매장 열쇠 만들기")));
    const n = input("cs-n", { inputMode: "numeric", placeholder: "1" });
    const name = input("cs-name", { placeholder: t("예: 강남점") });
    const biz = input("cs-biz", { inputMode: "numeric", placeholder: "123-45-67890" });
    const sub = input("cs-sub", { inputMode: "numeric", placeholder: "0001" });
    const go = button(() => t("매장 열쇠 만들기"));
    const out = el("div", "cs-out");
    out.hidden = true;
    box.append(field("매장 번호 (1~9999)", n), field("매장 이름", name), field("사업자등록번호", biz, "매장마다 사업자가 따로면 그 매장 번호를 적어요."),
      field("종사업장 번호 (없으면 비워 두세요)", sub, "한 사업자 아래 종된 사업장이면 4자리 번호를 적어요."), go, out);
    const run = async (): Promise<void> => {
      say("");
      const num = Number(n.value.trim());
      if (!Number.isInteger(num) || num < 1 || num > 9999) { say(t("매장 번호는 1부터 9999 사이의 숫자로 적어 주세요."), true); n.focus(); return; }
      go.disabled = true;
      setCopyText(go, () => t("만드는 중…"));
      try {
        const r = await deps.invoke<{ bundle_text: string; install_words: string; serial: number }>("chain_store_issue",
          { n: num, name: name.value, bizNo: biz.value, bizSub: sub.value.trim() || null });
        showIssued(out, r, name.value.trim());
        n.value = name.value = biz.value = sub.value = "";
        void paintList();
      } catch (e) {
        fail(e, run);
      } finally {
        go.disabled = false;
        setCopyText(go, () => t("매장 열쇠 만들기"));
      }
    };
    go.onclick = () => void run();
    return box;
  }

  function showIssued(out: HTMLElement, r: { bundle_text: string; install_words: string; serial: number }, name: string) {
    const words = el("div", "cs-words");
    words.setAttribute("translate", "no");
    r.install_words.split(" ").forEach((w, i) => { const s = el("span", "cs-word"); s.textContent = `${i + 1}. ${w}`; words.append(s); });
    const code = el("textarea", "cs-bundle wl-mono") as HTMLTextAreaElement;
    code.readOnly = true;
    code.value = r.bundle_text;
    code.setAttribute("translate", "no");
    const copy = button(() => t("꾸러미 복사"), true);
    copy.onclick = async () => { try { await navigator.clipboard.writeText(r.bundle_text); say(t("꾸러미를 복사했어요. 매장 컴퓨터에 붙여 넣어 주세요.")); } catch { code.select(); say(t("복사하지 못했어요. 글자 칸을 직접 골라 복사해 주세요."), true); } };
    const save = button(() => t("파일로 저장"), true);
    save.onclick = async () => {
      try {
        const path = await deps.pickSave(`store-${r.serial}.rvchain.txt`);
        if (!path) return;
        await deps.invoke("chain_store_bundle_save", { path, bundleText: r.bundle_text });
        say(t("꾸러미 파일을 저장했어요. USB 등으로 매장 컴퓨터에 옮겨 주세요."));
      } catch (e) { say(deps.errText(e), true); }
    };
    const done = button(() => t("다 옮겼어요 — 설치 암호 지우기"), true);
    done.onclick = () => { out.replaceChildren(); out.hidden = true; say(""); r.install_words = ""; code.value = ""; };
    const acts = el("div", "cs-acts");
    acts.append(copy, save, done);
    const lead = el("p", "cs-q");
    setCopyText(lead, () => tf("「{0}」 매장 열쇠를 만들었어요. 아래 설치 암호 6단어를 매장 컴퓨터에서 순서대로 적어 주세요.", name));
    out.replaceChildren(lead, words,
      el("p", "cs-warn", () => t("설치 암호는 지금 한 번만 보여요. 종이에 적어 매장에 직접 전해 주세요. 꾸러미와 같은 곳(같은 쪽지·같은 문자)에 보내지 마세요.")),
      el("p", "meta", () => t("꾸러미 (매장 컴퓨터에 붙여 넣을 글자)")), code, acts);
    out.hidden = false;
    out.scrollIntoView({ block: "nearest" });
  }

  // ── 본점: 목록 ──
  const list = el("div", "cs-list");
  async function paintList(): Promise<void> {
    let rows: Row[] = [];
    try { rows = (await deps.invoke<{ stores: Row[] }>("chain_store_list")).stores || []; } catch (e) { say(deps.errText(e), true); return; }
    list.replaceChildren(el("h4", "", () => t("만든 매장")));
    if (!rows.length) { list.append(el("p", "meta", () => t("아직 만든 매장 열쇠가 없어요."))); return; }
    for (const r of rows) {
      const row = el("div", "cs-row");
      const txt = el("div", "cs-rowtxt");
      const title = el("b");
      title.setAttribute("translate", "no");
      title.textContent = `${r.store}. ${r.name}`;
      const d = el("span", "cs-d");
      setCopyText(d, () => tf("사업자 {0} · {1}까지", bizText(r.biz), day(r.notAfter)));
      txt.append(title, d);
      row.append(txt);
      if (r.revoked) row.append(el("span", "cs-cut", () => t("끊김")));
      else {
        const cut = button(() => t("이 매장 끊기"), true);
        cut.onclick = () => void revoke(r, cut);
        row.append(cut);
      }
      list.append(row);
    }
  }
  async function revoke(r: Row, b: HTMLButtonElement): Promise<void> {
    const ok = await deps.sure(t("이 매장을 끊을까요?"),
      tf("「{0}」 매장 컴퓨터의 열쇠를 더는 믿지 않게 됩니다. 컴퓨터를 잃어버렸거나 도난당했을 때 쓰세요. 되돌릴 수 없고, 다시 쓰려면 새 열쇠를 만들어야 해요.", r.name), t("끊기"));
    if (!ok) return;
    b.disabled = true;
    const go = async (): Promise<void> => {
      try {
        const res = await deps.invoke<{ published: { revocations: boolean; roster: boolean } }>("chain_store_revoke", { serial: r.serial });
        say(res.published?.revocations ? t("매장을 끊었어요. 끊기 목록을 릴레이에도 올렸어요.")
          : t("매장을 끊었어요(이 컴퓨터에 저장). 릴레이에는 아직 못 올렸어요 — 다음에 다시 올라가요."), !res.published?.revocations);
        void paintList();
      } catch (e) { b.disabled = false; fail(e, go); }
    };
    await go();
  }

  // ── 매장 PC: 꾸러미 열기 ──
  function joinForm(): HTMLElement {
    const box = el("details", "cs-part") as HTMLDetailsElement;
    const sum = el("summary", "", () => t("본점에서 받은 꾸러미 열기"));
    const code = el("textarea", "cs-bundle wl-mono") as HTMLTextAreaElement;
    code.id = "cs-join-bundle";
    code.spellcheck = false;
    code.setAttribute("translate", "no");
    code.placeholder = "rvchain1-…";
    const fromFile = button(() => t("파일에서 불러오기"), true);
    fromFile.onclick = async () => {
      try { const p = await deps.pickOpen(); if (p) code.value = await deps.invoke<string>("chain_store_bundle_read", { path: p }); }
      catch (e) { say(deps.errText(e), true); }
    };
    const words = input("cs-join-words", { placeholder: t("본점 화면에 보인 6단어") });
    words.setAttribute("translate", "no");
    const go = button(() => t("이 컴퓨터를 매장으로 연결"));
    go.onclick = async () => {
      say("");
      go.disabled = true;
      try {
        const r = await deps.invoke<{ name: string; store: number }>("chain_store_join", { bundleText: code.value, installWords: words.value });
        code.value = words.value = "";
        say(tf("다 됐어요. 이 컴퓨터는 이제 「{0}」({1}번 매장)이에요. 12단어 없이 쓰시면 됩니다.", r.name, r.store));
        void refresh();
      } catch (e) { say(deps.errText(e), true); }
      finally { go.disabled = false; }
    };
    box.append(sum, el("p", "meta", () => t("매장 컴퓨터에서 하세요. 본점에서 받은 꾸러미 글자를 붙여 넣고, 설치 암호 6단어를 적으면 끝나요.")),
      field("꾸러미", code), fromFile, field("설치 암호 (6단어)", words), go);
    return box;
  }

  /** ④ 새 본점 컴퓨터: 맡은 매장에서 저장해 온 본점 백업 파일 → 12단어로 연다. */
  function restoreForm(): HTMLElement {
    const box = el("details", "cs-part");
    const go = button(() => t("본점 백업 되살리기"), true);
    const run = async (): Promise<void> => {
      say("");
      try {
        const p = await deps.pickOpen();
        if (!p) return;
        go.disabled = true;
        // 먼저 만든 때를 보여 주고 확인받는다(옛 백업을 내밀어도 사장이 날짜로 알아본다).
        const pv = await deps.invoke<{ at: number; stores: number }>("chain_backup_preview", { path: p });
        const okay = await deps.sure(t("본점 백업 되살리기"),
          tf("이 백업은 {0}에 만든 것이에요(매장 {1}곳). 그 뒤의 일은 빠져 있어요. 되살릴까요?", new Date(pv.at).toLocaleString(), pv.stores), t("되살리기"));
        if (!okay) return;
        const r = await deps.invoke<{ stores: number; revocationsStale?: boolean }>("chain_backup_restore", { path: p, confirmAt: pv.at });
        say(tf("본점 기록을 되살렸어요(매장 {0}곳). 매장 컴퓨터마다 이 컴퓨터의 새 본점 주소를 적어 주세요.", r.stores)
          + (r.revocationsStale ? " " + t("끊기 목록은 릴레이에서 못 받았어요") : ""), !!r.revocationsStale);
        void refresh();
      } catch (e) { fail(e, run); }
      finally { go.disabled = false; }
    };
    go.onclick = () => void run();
    box.append(el("summary", "", () => t("본점 컴퓨터를 바꿨나요?")),
      el("p", "meta", () => t("12단어로 지갑을 되살린 뒤, 백업을 맡은 매장에서 저장해 온 본점 백업 파일을 골라요. 12단어로만 열려요.")), go);
    return box;
  }

  async function refresh(): Promise<void> {
    let s: Status;
    try { s = await deps.invoke<Status>("chain_store_status"); } catch (e) { say(deps.errText(e), true); return; }
    body.replaceChildren();
    if (s.role === "store") {
      const v = el("div", s.revoked ? "verdict bad" : "verdict ok");
      const st = el("div", "v-state");
      setCopyText(st, () => s.revoked ? tf("「{0}」 매장 — 본점이 끊었어요", s.name || "") : tf("이 컴퓨터는 「{0}」({1}번 매장)이에요", s.name || "", s.store ?? ""));
      v.append(st, el("div", "v-why", () => s.revoked ? t("본점에 연락해 새 매장 열쇠를 받아 주세요.") : tf("매장 증서는 {0}까지 쓸 수 있어요.", day(s.notAfter || 0))));
      const sales = el("div", "cs-part cs-sales");
      body.append(v, sales, joinForm());
      mountChainSales(sales, "store", { invoke: deps.invoke, errText: deps.errText, fail, pickSave: deps.pickSave });
      return;
    }
    if (s.role === "owner") {
      // ③ 매장 매출 합계·꺼짐 알림을 맨 위에(매일 보는 것).
      const sales = el("div", "cs-part cs-sales");
      body.append(sales);
      mountChainSales(sales, "owner", { invoke: deps.invoke, errText: deps.errText, fail, pickSave: deps.pickSave });
    }
    if (s.role === "none") body.append(restoreForm());
    body.append(issueForm());
    if (s.role === "owner") { body.append(list); await paintList(); }
    body.append(joinForm());
  }

  void refresh();
  return { refresh };
}
