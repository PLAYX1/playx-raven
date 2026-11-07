/*
 * 내 글 서랍 (11-07 대표: 「본인이 쓴 글과 이미지를 데스크탑에서 따로 보고 폴더나 태그별로 관리할 수 있냐?」)
 *
 * 「내 소개」의 옛 「내 글」(글자 30개)을 바꾼다.
 *   my_notes()                      → { me, notes: 이벤트[], folders: {id,name}[], assign: {글번호: 폴더번호}, status: relay_status }
 *   my_drawer_save({folders, assign}) → 정리된 { folders, assign }
 * 글은 이 컴퓨터 릴레이가 지켜 둔 「내 이름으로 서명된 글」(폰에서 쓴 글 포함, relay.rs 내 글 지키기).
 * 폴더는 이 컴퓨터에만 남는 나만의 분류. 태그는 글 안의 「#낱말」(글과 함께 이미 공개).
 * 아직 하나도 못 모았으면 바깥 릴레이에서 읽는 옛 길(talk_my_posts)로 보여 준다.
 */
import "./my-drawer.css";
import { t, tf, copyHtml } from "./i18n";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Note = { id: string; at: number; text: string; photos: string[]; tags: string[]; reply: boolean };
type Folder = { id: string; name: string };
type View = { kind: "all" } | { kind: "photos" } | { kind: "nofolder" } | { kind: "folder"; id: string } | { kind: "tag"; tag: string };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// 폰 core/talk/photo.ts 와 같은 규칙 — 공용 사진 서버 모양만 사진으로 본다.
const BLOSSOM = /^https:\/\/(?:(?:blossom|image|i|media)\.nostr\.build|npub1[02-9ac-hj-np-z]{58}\.blossom\.band)\/[a-f0-9]{64}(?:\.(?:jpg|jpeg|png|webp|gif))?$/;
const IPFS = /^https:\/\/(?:ipfs\.io|cloudflare-ipfs\.com|dweb\.link)\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;
const isPhoto = (u: string) => BLOSSOM.test(u) || IPFS.test(u);
// 「#낱말」 — 한글·영문·숫자·밑줄, 1~30자. 주소 안의 #은 보지 않는다(앞이 공백이거나 줄 처음일 때만).
const TAG = /(?:^|\s)#([\p{L}\p{N}\p{M}_]+)/gu;

export function noteOfEvent(e: any): Note | null {
  const id = String(e?.id ?? "");
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const tags: any[] = Array.isArray(e?.tags) ? e.tags : [];
  let text = String(e?.content ?? "");
  const urls = new Set<string>();
  for (const tg of tags) if (Array.isArray(tg) && tg[0] === "imeta") for (const part of tg.slice(1)) if (typeof part === "string" && part.startsWith("url ")) urls.add(part.slice(4).trim());
  for (const m of text.match(/https:\/\/\S+/g) ?? []) urls.add(m);
  const photos: string[] = [];
  for (const u of urls) if (isPhoto(u)) { photos.push(u); text = text.split(u).join(""); }
  text = text.replace(/[ \t]+\n/g, "\n").trim();
  const found = new Set<string>();
  for (const m of text.matchAll(TAG)) if ([...m[1]].length <= 30) found.add(m[1]);
  const reply = tags.some((tg) => Array.isArray(tg) && tg[0] === "e");
  if (!text && !photos.length) return null;
  return { id, at: Number(e?.created_at ?? 0), text, photos, tags: [...found], reply };
}

let state: { notes: Note[]; folders: Folder[]; assign: Record<string, string>; rev: number; drawerProblem: string; view: View; local: boolean; status: any; limit: number; confirmDelete: boolean } | null = null;
const PAGE = 100;
let seq = 0;
let saveQueue: Promise<void> = Promise.resolve();

export async function paintMyDrawer(host: HTMLElement, deps: { invoke: Invoke; errText: (e: unknown) => string; statusLine: (r: any) => string }, openFeed: () => void): Promise<void> {
  const my = ++seq;
  host.innerHTML = `<p class="meta">${copyHtml("내 글 가져오는 중…")}</p>`;
  let notes: Note[] = [], folders: Folder[] = [], assign: Record<string, string> = {}, local = true, status: any = null, rev = 0, drawerProblem = "";
  try {
    const r = await deps.invoke<any>("my_notes");
    notes = (Array.isArray(r?.notes) ? r.notes : []).map(noteOfEvent).filter(Boolean) as Note[];
    folders = Array.isArray(r?.folders) ? r.folders : [];
    assign = r?.assign && typeof r.assign === "object" ? r.assign : {};
    status = r?.status ?? null;
    rev = Number(r?.rev ?? 0);
    drawerProblem = typeof r?.drawer_problem === "string" ? r.drawer_problem : "";
    if (!notes.length && !r?.collected) {
      // 아직 이 컴퓨터가 한 번도 끝까지 모으기 전 — 바깥 릴레이에서 읽는 옛 길로 보여 준다.
      // 내가 지운 글은 여기서도 빼고 보여 준다(GPT P2 — 지운 글이 되살아나 보였다).
      const gone = new Set<string>(Array.isArray(r?.deleted) ? r.deleted : []);
      const old = await deps.invoke<any>("talk_my_posts", { limit: 200 }).catch(() => []);
      notes = (Array.isArray(old) ? old : []).map(noteOfEvent).filter((n): n is Note => !!n && !gone.has(n.id));
      local = false;
    }
  } catch (e) {
    if (my !== seq) return;
    host.innerHTML = `<p class="meta danger">${copyHtml("내 글을 읽지 못했어요.")} ${esc(deps.errText(e))}</p>`;
    return;
  }
  if (my !== seq) return;
  notes.sort((a, b) => b.at - a.at);
  state = { notes, folders, assign, rev, drawerProblem, view: state?.view ?? { kind: "all" }, local, status, limit: PAGE, confirmDelete: false };
  render(host, deps, openFeed);
}

function shown(): Note[] {
  const s = state!;
  const v = s.view;
  if (v.kind === "photos") return s.notes.filter((n) => n.photos.length);
  if (v.kind === "nofolder") return s.notes.filter((n) => !s.assign[n.id]);
  if (v.kind === "folder") return s.notes.filter((n) => s.assign[n.id] === v.id);
  if (v.kind === "tag") return s.notes.filter((n) => n.tags.includes(v.tag));
  return s.notes;
}

function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function chip(label: string, view: View, count: number, raw = false): string {
  const on = sameView(state!.view, view);
  return `<button type="button" class="md-chip${on ? " on" : ""}" aria-pressed="${on}" data-view='${esc(JSON.stringify(view))}'>${raw ? `<span translate="no">${esc(label)}</span>` : copyHtml(label)} <small>${count}</small></button>`;
}

function render(host: HTMLElement, deps: { invoke: Invoke; errText: (e: unknown) => string; statusLine: (r: any) => string }, openFeed: () => void) {
  const s = state!;
  const tagCount = new Map<string, number>();
  for (const n of s.notes) for (const tg of n.tags) tagCount.set(tg, (tagCount.get(tg) ?? 0) + 1);
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const photoCount = s.notes.filter((n) => n.photos.length).length;
  const list = shown();
  const v = s.view;
  const folderOf = (id: string) => s.folders.find((f) => f.id === id);

  const head =
    `<p class="meta">${esc(s.local ? tf("내가 쓴 글 {0}개 — 이 컴퓨터가 지켜 두었어요. 폰에서 쓴 글도 모여요.", String(s.notes.length)) : t("이 컴퓨터가 아직 내 글을 모으기 전이에요. 지금은 바깥 릴레이에서 읽어 보여 드려요."))}</p>` +
    // 지키기에 문제가 있을 때만(이름이 폰과 다름·못 모음) 한 줄 더 — 평소에는 위 한 줄로 충분하다.
    (s.status && (s.status.my_same_as_wallet === false || s.status.my_backup_problem) ? `<p class="meta danger">${esc(deps.statusLine(s.status))}</p>` : "");

  const chips =
    `<div class="md-chips" role="group" aria-label="${esc(t("보기"))}">` +
    chip("전체", { kind: "all" }, s.notes.length) +
    chip("사진만", { kind: "photos" }, photoCount) +
    chip("폴더 없음", { kind: "nofolder" }, s.notes.filter((n) => !s.assign[n.id]).length) +
    `</div>` +
    `<div class="md-chips" role="group" aria-label="${esc(t("폴더 · 나만 봐요"))}"><span class="md-label">${copyHtml("폴더 · 나만 봐요")}</span>` +
    s.folders.map((f) => chip(f.name, { kind: "folder", id: f.id }, s.notes.filter((n) => s.assign[n.id] === f.id).length, true)).join("") +
    `<button type="button" class="ghost md-add" id="md-newfolder">${copyHtml("+ 폴더 만들기")}</button></div>` +
    (topTags.length
      ? `<div class="md-chips" role="group" aria-label="${esc(t("태그"))}"><span class="md-label">${copyHtml("태그 · 글에 #낱말을 쓰면 생겨요")}</span>` +
        topTags.map(([tg, n]) => chip("#" + tg, { kind: "tag", tag: tg }, n, true)).join("") + `</div>`
      : `<p class="meta">${copyHtml("태그는 글에 「#운동」처럼 쓰면 생겨요.")}</p>`);

  const locked = !!s.drawerProblem;
  const folderTools = v.kind === "folder" && folderOf(v.id) && !locked
    ? (s.confirmDelete
      // 되돌릴 수 없는 일 — 따로 뜨는 확인 칸, 「그만두기」가 먼저·「지우기」는 1초 뒤에 눌린다(두 번 누름으로 지워지지 않게).
      ? `<div class="md-confirm" role="alertdialog" aria-labelledby="md-confirm-t"><b id="md-confirm-t">${esc(tf("「{0}」 폴더를 지울까요?", folderOf(v.id)!.name))}</b>` +
        `<span class="meta">${copyHtml("폴더를 지워도 글은 지워지지 않아요.")}</span>` +
        `<div class="md-tools"><button type="button" id="md-del-no">${copyHtml("그만두기")}</button><button type="button" class="ghost danger" id="md-del-yes" disabled>${copyHtml("지우기")}</button></div></div>`
      : `<div class="md-tools"><button type="button" class="ghost" id="md-rename">${copyHtml("폴더 이름 바꾸기")}</button><button type="button" class="ghost" id="md-delete">${copyHtml("폴더 지우기")}</button></div>`)
    : "";

  const editor = `<div class="md-editor" id="md-editor" hidden><input id="md-fname" maxlength="30" placeholder="${esc(t("폴더 이름"))}" /><button type="button" id="md-fok">${copyHtml("저장")}</button><button type="button" class="ghost" id="md-fcancel">${copyHtml("취소")}</button><span class="meta danger" id="md-fsay" role="status"></span></div>`;

  let body: string;
  if (!s.notes.length) body = `<p class="meta">${copyHtml("아직 올린 글이 없어요.")}</p>`;
  else if (!list.length) body = `<p class="meta">${copyHtml("여기에 맞는 글이 없어요.")}</p>`;
  else if (v.kind === "photos")
    body = `<div class="md-grid">` + list.flatMap((n) => n.photos.map((u) => ({ n, u }))).slice(0, s.limit).map(({ n, u }) => `<figure><img src="${esc(u)}" alt="${esc(t("내가 올린 사진"))}" loading="lazy" referrerpolicy="no-referrer" /><figcaption class="meta">${esc(new Date(n.at * 1000).toLocaleDateString())}</figcaption></figure>`).join("") + `</div>`;
  else
    body = `<ul class="md-list">` + list.slice(0, s.limit).map((n) => {
      const sel = locked ? "" : `<select data-assign="${esc(n.id)}" aria-label="${esc(t("폴더에 넣기"))}"><option value="">${esc(t("폴더 없음"))}</option>` +
        s.folders.map((f) => `<option value="${esc(f.id)}" translate="no"${s.assign[n.id] === f.id ? " selected" : ""}>${esc(f.name)}</option>`).join("") + `</select>`;
      const pics = n.photos.length ? `<div class="md-pics">${n.photos.slice(0, 4).map((u) => `<img src="${esc(u)}" alt="${esc(t("내가 올린 사진"))}" loading="lazy" referrerpolicy="no-referrer" />`).join("")}</div>` : "";
      return `<li><div class="md-row"><time class="meta">${esc(new Date(n.at * 1000).toLocaleString())}${n.reply ? " · " + esc(t("답글")) : ""}</time>${sel}</div>` +
        (n.text ? `<p translate="no">${esc(n.text)}</p>` : "") + pics + `</li>`;
    }).join("") + `</ul>`;
  const total = v.kind === "photos" ? list.reduce((a, n) => a + n.photos.length, 0) : list.length;
  // 앞의 몇 개만 그린다 — 「더 보기」로 끝까지 갈 수 있다(GPT P2).
  const more = total > s.limit ? `<div class="row"><button type="button" class="ghost" id="md-more">${esc(tf("더 보기 ({0}개 남음)", String(total - s.limit)))}</button></div>` : "";

  const problemLine = locked ? `<p class="meta danger" role="status">${esc(t(s.drawerProblem))}</p>` : "";
  host.innerHTML = head + problemLine + chips + folderTools + editor + body + more +
    `<div class="row"><button type="button" class="ghost" id="md-feed">${copyHtml("피드에서 보기")}</button></div>`;

  host.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => {
    b.onclick = () => { try { s.view = JSON.parse(b.dataset.view || "{}"); } catch { s.view = { kind: "all" }; } s.limit = PAGE; s.confirmDelete = false; render(host, deps, openFeed); };
  });
  host.querySelector<HTMLButtonElement>("#md-feed")!.onclick = openFeed;
  const moreBtn = host.querySelector<HTMLButtonElement>("#md-more");
  if (moreBtn) moreBtn.onclick = () => { s.limit += PAGE; render(host, deps, openFeed); };
  if (locked) { host.querySelectorAll<HTMLButtonElement>("#md-newfolder").forEach((b) => { b.disabled = true; }); }

  // 저장은 줄 세워 하나씩 — 각 저장은 **바로 앞 저장이 끝난 최신 상태**에서 바꿀 것을 만든다(GPT P1).
  const save = (change: (folders: Folder[], assign: Record<string, string>) => { folders: Folder[]; assign: Record<string, string> }): Promise<string> => {
    const run = async (): Promise<string> => {
      const next = change(s.folders, s.assign);
      try {
        const r = await deps.invoke<any>("my_drawer_save", { folders: next.folders, assign: next.assign, rev: s.rev });
        s.folders = Array.isArray(r?.folders) ? r.folders : next.folders;
        s.assign = r?.assign && typeof r.assign === "object" ? r.assign : next.assign;
        s.rev = Number(r?.rev ?? s.rev + 1);
        return "";
      } catch (e) { return deps.errText(e); }
    };
    const p = saveQueue.then(run, run);
    saveQueue = p.then(() => undefined, () => undefined);
    return p;
  };

  host.querySelectorAll<HTMLSelectElement>("select[data-assign]").forEach((sel) => {
    sel.onchange = async () => {
      const id = sel.dataset.assign || "", want = sel.value;
      sel.disabled = true;
      const problem = await save((folders, assign) => { const next = { ...assign }; if (want) next[id] = want; else delete next[id]; return { folders, assign: next }; });
      sel.disabled = false;
      if (problem) { sel.value = s.assign[id] ?? ""; alertInline(host, problem); return; }
      render(host, deps, openFeed);
    };
  });

  const editorBox = host.querySelector<HTMLElement>("#md-editor")!;
  const nameIn = host.querySelector<HTMLInputElement>("#md-fname")!;
  const say = host.querySelector<HTMLElement>("#md-fsay")!;
  let editing: "new" | string = "new";
  const openEditor = (mode: "new" | string, value: string) => { editing = mode; editorBox.hidden = false; nameIn.value = value; say.textContent = ""; nameIn.focus(); };
  host.querySelector<HTMLButtonElement>("#md-newfolder")!.onclick = () => openEditor("new", "");
  host.querySelector<HTMLButtonElement>("#md-fcancel")!.onclick = () => { editorBox.hidden = true; };
  host.querySelector<HTMLButtonElement>("#md-fok")!.onclick = async () => {
    const name = nameIn.value.trim();
    if (!name) { say.textContent = t("폴더 이름을 적어 주세요."); return; }
    const newId = ("f" + Date.now().toString(36).slice(-8) + Math.random().toString(36).slice(2, 6)).replace(/[^0-9a-z]/g, "").slice(0, 16);
    const target = editing;
    const problem = await save((folders, assign) => ({
      folders: target === "new" ? [...folders, { id: newId, name }] : folders.map((f) => (f.id === target ? { ...f, name } : f)),
      assign,
    }));
    if (problem) { say.textContent = problem; return; }
    if (target === "new") s.view = { kind: "folder", id: newId };
    render(host, deps, openFeed);
  };
  nameIn.onkeydown = (e) => { if (e.key === "Enter") host.querySelector<HTMLButtonElement>("#md-fok")!.click(); };
  const rename = host.querySelector<HTMLButtonElement>("#md-rename");
  if (rename && v.kind === "folder") rename.onclick = () => openEditor(v.id, folderOf(v.id)?.name ?? "");
  const del = host.querySelector<HTMLButtonElement>("#md-delete");
  if (del) del.onclick = () => { s.confirmDelete = true; render(host, deps, openFeed); };
  const no = host.querySelector<HTMLButtonElement>("#md-del-no");
  const yes = host.querySelector<HTMLButtonElement>("#md-del-yes");
  if (no) { no.onclick = () => { s.confirmDelete = false; render(host, deps, openFeed); }; no.focus(); }
  if (yes && v.kind === "folder") {
    setTimeout(() => { yes.disabled = false; }, 1000);
    yes.onclick = async () => {
      yes.disabled = true;
      const problem = await save((folders, assign) => ({ folders: folders.filter((f) => f.id !== v.id), assign: Object.fromEntries(Object.entries(assign).filter(([, f]) => f !== v.id)) }));
      if (problem) { alertInline(host, problem); yes.disabled = false; return; }
      s.view = { kind: "all" }; s.confirmDelete = false;
      render(host, deps, openFeed);
    };
  }
}

function alertInline(host: HTMLElement, text: string) {
  let p = host.querySelector<HTMLElement>(".md-problem");
  if (!p) { p = document.createElement("p"); p.className = "meta danger md-problem"; p.setAttribute("role", "status"); host.prepend(p); }
  p.textContent = text;
}
