import { t, LANG_NAMES } from "./i18n";
import scene from "./assets/ravi-scene.svg?raw";
import { PROMO_CHANNELS, PROMO_LIMITS, limitPromo, promoLength, promoPriceWarnings, promoShop, templatePromo, type PromoChannel, type PromoDrafts, type PromoLang, type PromoShop } from "./ravi-promo";

interface PromoApi {
  load(): Promise<unknown>;
  keyed(): boolean;
  generate(language: PromoLang, request: string): Promise<PromoDrafts>;
  qr(url: string): Promise<string>;
  save(b64: string): Promise<boolean>;
}
const labels: Record<PromoChannel, string> = { x: "X", instagram: "인스타그램", kakao: "카카오톡", local: "당근 / 동네" };
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; return el;
}
function button(text: string) { const el = node("button", t(text)); el.type = "button"; return el; }
function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = () => reject(new Error("image"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
export async function promoPng(shop: PromoShop, tagline: string, qr: string): Promise<string> {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1080;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas");
  const [ravi, code] = await Promise.all([loadSvg(scene), loadSvg(qr)]);
  ctx.fillStyle = "#f7fafb"; ctx.fillRect(0, 0, 1080, 1080);
  ctx.fillStyle = "#1f224e";
  const fit = (text: string, y: number, size: number) => {
    ctx.font = `bold ${size}px sans-serif`;
    while (size > 20 && ctx.measureText(text).width > 960) ctx.font = `bold ${--size}px sans-serif`;
    const chars = Array.from(text);
    while (chars.length && ctx.measureText(chars.join("")).width > 960) chars.pop();
    ctx.fillText(chars.join(""), 60, y, 960);
  };
  fit(shop.name, 125, 64); fit(tagline, 215, 40);
  ctx.drawImage(ravi, 35, 290, 620, 650);
  // Integer modules with white quiet zone, no interpolation.
  const view = /viewBox="[^"]*?([\d.]+)\s+([\d.]+)"/.exec(qr);
  const units = Number(view?.[2]) || code.naturalWidth || 41;
  const size = Math.floor(330 / units) * units;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(685, 460, 350, 350);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(code, 695, 470, size, size);
  ctx.fillStyle = "#1f224e"; ctx.font = "30px sans-serif";
  ctx.fillText("ORDER / QR", 700, 855);
  ctx.font = "20px sans-serif";
  const host = new URL(shop.orderUrl).host; ctx.fillText(host, 60, 1020, 960);
  return canvas.toDataURL("image/png").split(",")[1];
}

/** A result lives in the shared, scrolling conversation, never over the page. */
export async function createPromoCard(host: HTMLElement, api: PromoApi, request = ""): Promise<void> {
  const card = node("section"); card.className = "ravi-promo-card";
  const title = node("h3", t("홍보 만들기")), language = node("select");
  language.setAttribute("aria-label", t("홍보 글 언어"));
  for (const [value, label] of Object.entries(LANG_NAMES)) { const option = node("option", label); option.value = value; language.append(option); }
  language.value = "ko";
  const toolbar = node("div"); toolbar.className = "promo-actions";
  const rewrite = button("다시 쓰기"); toolbar.append(language, rewrite);
  const source = node("p"), status = node("p"); status.setAttribute("role", "status");
  const tabs = node("div"); tabs.className = "promo-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("홍보 채널"));
  const panels = node("div"), footer = node("p", t("직접 복사하거나 저장해 올려 주세요."));
  const taglineLabel = node("label", t("이미지 한 줄")), tagline = node("input"); tagline.maxLength = 120; tagline.setAttribute("translate", "no"); taglineLabel.append(tagline);
  const preview = node("img"); preview.hidden = true; preview.alt = t("홍보 이미지");
  const imageActions = node("div"); imageActions.className = "promo-actions";
  const makeImage = button("공유 이미지 만들기"), saveImage = button("PNG 저장"); saveImage.disabled = true; imageActions.append(makeImage, saveImage);
  card.append(title, toolbar, source, status, tabs, panels, taglineLabel, imageActions, preview, footer); host.append(card);
  let shop: PromoShop = promoShop({}, "ko"), png = "", busy = false;
  const editors = {} as Record<PromoChannel, HTMLTextAreaElement>;
  const warningNodes = {} as Record<PromoChannel, HTMLElement>;
  const counts = {} as Record<PromoChannel, HTMLElement>;
  const tabButtons: HTMLButtonElement[] = [], panelNodes: HTMLElement[] = [];
  const id = `promo-${crypto.randomUUID()}`;
  function select(index: number) {
    tabButtons.forEach((b, i) => { b.setAttribute("aria-selected", String(i === index)); b.tabIndex = i === index ? 0 : -1; panelNodes[i].hidden = i !== index; });
  }
  function check(channel: PromoChannel) {
    const text = editors[channel].value, mismatches = promoPriceWarnings(text, shop);
    const warnings = [];
    if (mismatches.length) warnings.push(`${t("메뉴 가격과 다른 숫자를 확인해 주세요.")} ${mismatches.join(", ")}`);
    if (promoLength(text, channel) > PROMO_LIMITS[channel] || (channel === "kakao" && text.split("\n").length > 3) || (channel === "instagram" && (text.match(/#[^\s#]+/g) || []).length > 5)) warnings.push(t("채널 길이 제한을 확인해 주세요."));
    if (shop.orderUrl && !text.includes(shop.orderUrl)) warnings.push(t("주문 링크가 빠졌습니다."));
    warningNodes[channel].textContent = warnings.join(" ");
    counts[channel].textContent = `${promoLength(text, channel)} / ${PROMO_LIMITS[channel]}`;
  }
  for (const [index, channel] of PROMO_CHANNELS.entries()) {
    const tab = button(labels[channel]); tab.id = `${id}-tab-${channel}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `${id}-${channel}`);
    tab.onclick = () => select(index);
    tab.onkeydown = e => {
      const next = e.key === "ArrowRight" ? (index + 1) % 4 : e.key === "ArrowLeft" ? (index + 3) % 4 : e.key === "Home" ? 0 : e.key === "End" ? 3 : -1;
      if (next >= 0) { e.preventDefault(); select(next); tabButtons[next].focus(); }
    };
    const panel = node("div"); panel.id = `${id}-${channel}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id);
    const editor = node("textarea"); editor.setAttribute("aria-label", `${t(labels[channel])} ${t("홍보 글")}`); editor.setAttribute("translate", "no"); editor.rows = 7;
    editor.oninput = () => check(channel);
    const warning = node("p"); warning.className = "promo-warning"; warning.setAttribute("role", "status"); warning.setAttribute("translate", "no");
    const count = node("span"), copy = button("복사");
    copy.onclick = async () => {
      check(channel);
      try { await navigator.clipboard.writeText(editor.value); status.textContent = t("복사했습니다."); }
      catch { editor.focus(); editor.select(); status.textContent = t("복사하지 못했습니다. 글을 선택해 직접 복사해 주세요."); }
    };
    panel.append(editor, count, copy, warning); tabs.append(tab); panels.append(panel);
    tabButtons.push(tab); panelNodes.push(panel); editors[channel] = editor; warningNodes[channel] = warning; counts[channel] = count;
  }
  select(0);
  function invalidateImage() { png = ""; preview.hidden = true; saveImage.disabled = true; }
  tagline.oninput = invalidateImage;
  async function generate() {
    if (busy) return;
    busy = true; rewrite.disabled = language.disabled = makeImage.disabled = tagline.disabled = true;
    for (const editor of Object.values(editors)) editor.disabled = true;
    status.textContent = t("홍보 글을 준비하는 중…"); invalidateImage();
    try {
      const lang = language.value as PromoLang;
      shop = promoShop(await api.load(), lang);
      if (!shop.name) throw new Error("missing-shop");
      let drafts = templatePromo(shop, lang);
      source.textContent = t("AI 없이 만든 기본 글");
      if (api.keyed()) {
        try {
          const generated = await api.generate(lang, request);
          if (!PROMO_CHANNELS.every(c => typeof generated?.[c] === "string" && generated[c].trim())) throw new Error("shape");
          drafts = Object.fromEntries(PROMO_CHANNELS.map(c => [c, limitPromo(generated[c], c, shop.orderUrl)])) as PromoDrafts;
          source.textContent = t("AI로 만든 초안 · 사실과 가격을 확인해 주세요.");
        } catch { status.textContent = t("AI 초안을 받지 못해 기본 글을 만들었습니다."); }
      }
      for (const channel of PROMO_CHANNELS) { editors[channel].value = drafts[channel]; check(channel); }
      tagline.value = (shop.description || shop.menu[0]?.name || shop.name).slice(0, 120);
      if (!shop.orderUrl) status.textContent = t("가게 정보에 주문 링크를 넣으면 QR 이미지를 만들 수 있습니다.");
      else if (status.textContent === t("홍보 글을 준비하는 중…")) status.textContent = "";
    } catch {
      shop = promoShop({}, language.value as PromoLang);
      source.textContent = "";
      for (const channel of PROMO_CHANNELS) { editors[channel].value = ""; check(channel); }
      status.textContent = t("저장된 가게 정보를 읽지 못했습니다. 내 가게에서 이름을 저장해 주세요.");
    } finally {
      busy = false; rewrite.disabled = language.disabled = tagline.disabled = false;
      for (const editor of Object.values(editors)) editor.disabled = false;
      makeImage.disabled = !shop.name || !shop.orderUrl;
    }
  }
  rewrite.onclick = () => { void generate(); }; language.onchange = () => { void generate(); };
  makeImage.onclick = async () => {
    if (busy || !shop?.orderUrl) return;
    busy = true; makeImage.disabled = rewrite.disabled = language.disabled = tagline.disabled = true;
    invalidateImage();
    try { png = await promoPng(shop, tagline.value, await api.qr(shop.orderUrl)); preview.src = `data:image/png;base64,${png}`; preview.hidden = false; saveImage.disabled = false; }
    catch { status.textContent = t("이미지를 만들지 못했습니다. 다시 시도해 주세요."); }
    finally { busy = false; makeImage.disabled = rewrite.disabled = language.disabled = tagline.disabled = false; }
  };
  saveImage.onclick = async () => {
    if (!png || saveImage.disabled) return; saveImage.disabled = true;
    try { if (await api.save(png)) status.textContent = t("PNG를 저장했습니다."); }
    catch { status.textContent = t("PNG를 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { saveImage.disabled = !png; }
  };
  await generate();
}
