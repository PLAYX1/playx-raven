/* 11-13 「이름표 그림」 — 라비 이모티콘 16종 또는 내 사진(정사각 512 JPEG → 공용 사진 서버 Blossom). 폰 이름표 화면과 같은 규칙.
 *  · 고른 것에 테두리+체크(무엇이 골라졌는지 한눈에) · 맨 위에 내 이름표가 실제로 보일 모양(미리보기).
 *  · 올리기 = kind 0 이름표(talk_profile_set — 러스트가 주소를 한 번 더 본다: 라비 이모티콘·Blossom 만).
 *  · 사진은 공용 서버에 올라가 주소를 아는 누구나 볼 수 있다고 적는다.
 * 🔴 글자는 textContent 로만. 사진 주소는 talk-media.ts 규칙을 통과한 것만 그린다.
 */
import { copyHtml, t } from "./i18n";
import { BLOSSOM, STICKERS, personPictureSrc, pickAndUploadPhoto, setAvatarPicture, stickerCodeOf, stickerUrl } from "./talk-media";
import { saveTalkName } from "./talk-identity";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type PictureDeps = {
  invoke: Invoke;
  me: () => { pubkey: string; name: string; about: string; picture: string };
  hue: (pk: string) => number;
  onSaved: (picture: string) => void;
};

let wrap: HTMLElement | null = null;
export const pictureEditorOpen = () => !!wrap && !wrap.hidden;
export function closePictureEditor() { if (wrap) wrap.hidden = true; }

export function openPictureEditor(d: PictureDeps): void {
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "tk-lsheet-wrap"; wrap.id = "tk-picsheet"; wrap.hidden = true;
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) closePictureEditor(); });
    wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePictureEditor(); } });
    document.body.append(wrap);
  }
  const me = d.me();
  const start = stickerCodeOf(me.picture) || BLOSSOM.test(me.picture) ? me.picture : "";
  let chosen = start;
  let photo = BLOSSOM.test(start) ? start : ""; // 지금 쓰는(또는 방금 올린) 내 사진
  const name = me.name.trim() || t("나");
  wrap.innerHTML =
    `<div class="tk-lsheet tk-picsheet" role="dialog" aria-modal="true" aria-labelledby="tk-pic-h">` +
    `<h3 id="tk-pic-h">${copyHtml("이름표 그림")}</h3><p class="tk-ls-body">${copyHtml("라비 이모티콘이나 내 사진을 골라요.")}</p>` +
    `<div class="tk-pic-preview"><span class="rv-avatar tk-pic-av" aria-hidden="true"></span><b class="tk-pic-name" translate="no"></b></div>` +
    `<div class="tk-pic-grid" role="radiogroup" aria-label="${copyHtml("이름표 그림")}"></div>` +
    `<div class="tk-ls-acts tk-pic-acts"><button type="button" class="ghost" data-pic="photo">${copyHtml("사진 고르기")}</button><button type="button" class="ghost" data-pic="none">${copyHtml("그림 빼기")}</button></div>` +
    `<p class="tk-ls-tip">${copyHtml("사진은 공용 사진 서버에 올라가 주소를 아는 누구나 볼 수 있어요.")}</p><p class="tk-ls-say" role="status"></p>` +
    `<div class="tk-ls-acts"><button type="button" class="ghost" data-pic="close">${copyHtml("닫기")}</button><button type="button" data-pic="save">${copyHtml("이름표 올리기")}</button></div></div>`;
  const w = wrap;
  const av = w.querySelector<HTMLElement>(".tk-pic-av")!;
  av.dataset.initial = Array.from(name)[0] || "나";
  av.style.setProperty("--h", String(d.hue(me.pubkey || "me")));
  w.querySelector<HTMLElement>(".tk-pic-name")!.textContent = name;
  const grid = w.querySelector<HTMLElement>(".tk-pic-grid")!;
  const say = w.querySelector<HTMLElement>(".tk-ls-say")!;
  const tile = (value: string, src: string, label: string) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tk-pic-cell"; b.setAttribute("role", "radio"); b.dataset.value = value; b.title = label; b.setAttribute("aria-label", label);
    const img = document.createElement("img"); img.src = src; img.alt = ""; img.draggable = false; b.append(img);
    const tick = document.createElement("span"); tick.className = "tk-pic-tick"; tick.setAttribute("aria-hidden", "true"); tick.textContent = "✓"; b.append(tick);
    b.onclick = () => { chosen = value; paint(); };
    return b;
  };
  function paint() {
    grid.replaceChildren(
      ...(photo ? [tile(photo, photo, t("사진 고르기"))] : []),
      ...STICKERS.map((code) => tile(stickerUrl(code), `/ravi-stickers/${code}.webp`, code)),
    );
    grid.querySelectorAll<HTMLElement>(".tk-pic-cell").forEach((b) => { const on = b.dataset.value === chosen; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
    setAvatarPicture(av, personPictureSrc(chosen));
    w.querySelector<HTMLElement>('[data-pic="none"]')!.hidden = !chosen;
  }
  paint();
  const busy = (on: boolean) => w.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = on; });
  w.querySelector<HTMLElement>('[data-pic="close"]')!.onclick = closePictureEditor;
  w.querySelector<HTMLElement>('[data-pic="none"]')!.onclick = () => { chosen = ""; paint(); };
  w.querySelector<HTMLElement>('[data-pic="photo"]')!.onclick = async () => {
    busy(true); say.textContent = t("사진을 올리는 중…");
    try { const url = await pickAndUploadPhoto(); if (url) { photo = url; chosen = url; paint(); } say.textContent = ""; }
    catch (e) { say.textContent = String((e as any)?.message || e); }
    finally { busy(false); }
  };
  w.querySelector<HTMLElement>('[data-pic="save"]')!.onclick = async () => {
    busy(true); say.textContent = t("올리는 중…");
    const now = d.me();
    const r = await saveTalkName(d.invoke, now.name, now.about, chosen);
    busy(false);
    if (!r.ok) { say.textContent = String(r.error); return; }
    say.textContent = t("이름표 그림을 바꿨어요.");
    d.onSaved(chosen);
    setTimeout(closePictureEditor, 700);
  };
  w.hidden = false;
  w.querySelector<HTMLElement>(".tk-pic-cell.on, .tk-pic-cell")?.focus();
}
