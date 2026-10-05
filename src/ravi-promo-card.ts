import { lang as currentLang } from "./i18n";
import { DICT } from "./dict";
import { raviQuestionLanguage } from "./ravi-intents";
import scene from "./assets/ravi-scene.svg?raw";
import { PROMO_CHANNELS, PROMO_LIMITS, PROMO_TARGETS, inferPromoTarget, promoImageUrl, promoTagline, preparePromo, combinePromo, promoFactWarnings, normalizeHashtags, HASHTAG_LIMITS, promoLength, promoPriceWarnings, promoShop, templatePromo, type PromoTarget, type PromoChannel, type PromoDrafts, type PromoLang, type PromoShop } from "./ravi-promo";

interface PromoApi {
  load(): Promise<unknown>;
  keyed(): boolean;
  generate(language: PromoLang, request: string, target: PromoTarget): Promise<PromoDrafts>;
  qr(url: string): Promise<string>;
  save(b64: string): Promise<boolean>;
}
const labels: Record<PromoChannel, string> = { x: "X", instagram: "인스타그램", kakao: "카카오톡", local: "당근 / 동네" };
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; return el;
}
function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = () => reject(new Error("image"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
export async function promoPng(shop: PromoShop, tagline: string, qr: string, target: PromoTarget = "shop"): Promise<string> {
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
  fit(target === "app" ? "RavenVault" : shop.name, 125, 64); fit(tagline, 215, 40);
  ctx.drawImage(ravi, 35, 290, 620, 650);
  // Integer modules with white quiet zone, no interpolation.
  const view = /viewBox="[^"]*?([\d.]+)\s+([\d.]+)"/.exec(qr);
  const units = Number(view?.[2]) || code.naturalWidth || 41;
  const size = Math.floor(330 / units) * units;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(685, 460, 350, 350);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(code, 695, 470, size, size);
  ctx.fillStyle = "#1f224e"; ctx.font = "30px sans-serif";
  ctx.fillText(target === "app" ? "RavenVault / QR" : "ORDER / QR", 700, 855);
  ctx.font = "20px sans-serif";
  const host = new URL(shop.orderUrl).host; ctx.fillText(host, 60, 1020, 960);
  return canvas.toDataURL("image/png").split(",")[1];
}

/** A result lives in the shared, scrolling conversation, never over the page. */
export async function createPromoCard(host: HTMLElement, api: PromoApi, request = ""): Promise<void> {
  const answerLanguage = raviQuestionLanguage(request, currentLang);
  const t = (source: string) => answerLanguage === "ko" ? source : DICT[answerLanguage]?.[source] || source;
  const button = (text: string) => { const el = node("button", t(text)); el.type = "button"; return el; };
  const card = node("section"); card.className = "ravi-promo-card";
  card.setAttribute("translate", "no"); card.setAttribute("data-ravi-language", answerLanguage);
  card.setAttribute("data-guide", "promo");
  const title = node("h3", t("홍보 만들기")), language = node("select");
  language.setAttribute("aria-label", t("홍보 글 언어"));
  for (const [value, label] of Object.entries({ ko: ["한국어", "Korean", "韓国語", "韩语"], en: ["영어", "English", "英語", "英语"], ja: ["일본어", "Japanese", "日本語", "日语"], zh: ["중국어", "Chinese", "中国語", "中文"] })) { const option = node("option", label[["ko", "en", "ja", "zh"].indexOf(answerLanguage)]); option.value = value; language.append(option); }
  language.value = answerLanguage;
  const toolbar = node("div"); toolbar.className = "promo-actions";
  const rewrite = button("다시 쓰기"); toolbar.append(language, rewrite);
  const source = node("p"), status = node("p"); status.setAttribute("role", "status");
  const tabs = node("div"); tabs.className = "promo-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("홍보 채널"));
  const panels = node("div"), footer = node("p", t("직접 복사하거나 저장해 올려 주세요."));
  const taglineLabel = node("label", t("이미지 한 줄")), tagline = node("input"); tagline.maxLength = 120; tagline.setAttribute("translate", "no"); taglineLabel.append(tagline);
  const preview = node("img"); preview.hidden = true; preview.alt = t("홍보 이미지");
  const imageActions = node("div"); imageActions.className = "promo-actions";
  const makeImage = button("공유 이미지 만들기"), saveImage = button("PNG 저장"); saveImage.disabled = true; imageActions.append(makeImage, saveImage);
  const targets = node("div"); targets.className = "promo-actions"; targets.setAttribute("aria-label", t("홍보 대상"));
  let target = inferPromoTarget(request);
  const targetLabels = { shop: "내 가게", app: "레이븐볼트 앱", custom: "직접 주제" };
  const targetButtons = PROMO_TARGETS.map(value => {
    const chip = button(targetLabels[value]); chip.setAttribute("aria-pressed", String(value === target));
    chip.onclick = () => { if (!busy) { target = value; void generate(); } }; targets.append(chip); return chip;
  });
  const imageReason = node("span"); imageReason.setAttribute("role", "status"); imageActions.append(imageReason);
  card.append(title, targets, toolbar, source, status, tabs, panels, taglineLabel, imageActions, preview, footer); host.append(card);
  let shop: PromoShop = promoShop({}, "ko"), png = "", busy = false;
  const editors = {} as Record<PromoChannel, HTMLTextAreaElement>;
  const tagEditors = {} as Record<PromoChannel, HTMLInputElement>;
  const warningNodes = {} as Record<PromoChannel, HTMLElement>;
  const counts = {} as Record<PromoChannel, HTMLElement>;
  const tabButtons: HTMLButtonElement[] = [], panelNodes: HTMLElement[] = [];
  const id = `promo-${crypto.randomUUID()}`;
  function select(index: number) {
    tabButtons.forEach((b, i) => { b.setAttribute("aria-selected", String(i === index)); b.tabIndex = i === index ? 0 : -1; panelNodes[i].hidden = i !== index; });
  }
  function check(channel: PromoChannel) {
    const text = combinePromo(editors[channel].value, tagEditors[channel].value), mismatches = target === "shop" ? promoPriceWarnings(text, shop) : [];
    const warnings = [];
    if (mismatches.length) warnings.push(`${t("메뉴 가격과 다른 숫자를 확인해 주세요.")} ${mismatches.join(", ")}`);
    if (target === "app" && promoFactWarnings(text).length) warnings.push(t("앱 사실표 밖 숫자나 약속을 확인해 주세요."));
    const tagCount = normalizeHashtags(tagEditors[channel].value).length;
    if (promoLength(text, channel) > PROMO_LIMITS[channel] || tagCount < HASHTAG_LIMITS[channel][0] || tagCount > HASHTAG_LIMITS[channel][1]) warnings.push(t("채널 길이 제한을 확인해 주세요."));
    const link = target === "shop" ? shop.orderUrl || shop.pageUrl : "";
    if (link && !text.includes(link)) warnings.push(t("주문 링크가 빠졌습니다."));
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
    const tagLabel = node("label", t("해시태그")), tags = node("input"); tags.setAttribute("translate", "no"); tags.setAttribute("aria-label", `${t(labels[channel])} ${t("해시태그")}`);
    tags.oninput = () => check(channel); tagLabel.append(tags); tagEditors[channel] = tags;
    const copyTags = button("태그만 복사");
    copyTags.onclick = async () => {
      try { await navigator.clipboard.writeText(normalizeHashtags(tags.value).join(" ")); status.textContent = t("복사했습니다."); }
      catch { tags.focus(); tags.select(); status.textContent = t("복사하지 못했습니다. 글을 선택해 직접 복사해 주세요."); }
    };
    const count = node("span"), copy = button("복사");
    copy.onclick = async () => {
      check(channel);
      try { await navigator.clipboard.writeText(combinePromo(editor.value, tags.value)); status.textContent = t("복사했습니다."); }
      catch { editor.focus(); editor.select(); status.textContent = t("복사하지 못했습니다. 글을 선택해 직접 복사해 주세요."); }
    };
    panel.append(editor, count, copy, tagLabel, copyTags, warning); tabs.append(tab); panels.append(panel);
    tabButtons.push(tab); panelNodes.push(panel); editors[channel] = editor; warningNodes[channel] = warning; counts[channel] = count;
  }
  select(0);
  function invalidateImage() { png = ""; preview.hidden = true; saveImage.disabled = true; }
  tagline.oninput = invalidateImage;
  async function generate() {
    if (busy) return;
    busy = true; rewrite.disabled = language.disabled = makeImage.disabled = tagline.disabled = true;
    for (const el of [...Object.values(editors), ...Object.values(tagEditors), ...targetButtons]) el.disabled = true;
    targetButtons.forEach((chip, i) => chip.setAttribute("aria-pressed", String(PROMO_TARGETS[i] === target)));
    status.textContent = t("홍보 글을 준비하는 중…"); invalidateImage();
    try {
      const lang = language.value as PromoLang;
      let saved: unknown = {};
      try { saved = await api.load(); } catch { status.textContent = t("저장된 가게 정보를 읽지 못했습니다. 내 가게에서 이름을 저장해 주세요."); }
      shop = promoShop(saved, lang);
      let drafts = templatePromo(shop, lang, target, request);
      source.textContent = t("AI 없이 만든 기본 글");
      if (api.keyed() && (target !== "shop" || (shop.name && shop.menu.length))) {
        try {
          const generated = await api.generate(lang, request, target);
          if (!PROMO_CHANNELS.every(c => typeof generated?.[c] === "string" && generated[c].trim())) throw new Error("shape");
          if (target === "app" && PROMO_CHANNELS.some(c => promoFactWarnings(generated[c]).length)) throw new Error("facts");
          drafts = generated;
          source.textContent = t("AI로 만든 초안 · 사실과 가격을 확인해 주세요.");
        } catch { status.textContent = t("AI 초안을 받지 못해 기본 글을 만들었습니다."); }
      }
      for (const channel of PROMO_CHANNELS) {
        const draft = preparePromo(drafts[channel], channel, shop, target, lang);
        editors[channel].value = draft.body; tagEditors[channel].value = draft.hashtags; check(channel);
      }
      tagline.value = promoTagline(shop, target, lang, request);
      if (target === "shop" && !shop.menu.length) status.textContent = t("메뉴를 먼저 등록하세요");
      else if (status.textContent === t("홍보 글을 준비하는 중…")) status.textContent = "";
    } catch {
      shop = promoShop({}, language.value as PromoLang);
      source.textContent = "";
      for (const channel of PROMO_CHANNELS) { editors[channel].value = ""; tagEditors[channel].value = ""; check(channel); }
      status.textContent = t("저장된 가게 정보를 읽지 못했습니다. 내 가게에서 이름을 저장해 주세요.");
    } finally {
      busy = false; rewrite.disabled = language.disabled = tagline.disabled = false;
      for (const el of [...Object.values(editors), ...Object.values(tagEditors), ...targetButtons]) el.disabled = false;
      makeImage.disabled = !promoImageUrl(shop, target, language.value as PromoLang);
      imageReason.textContent = makeImage.disabled ? t("QR 주소가 없습니다. 가게 주문 주소를 저장하거나 폰 연결을 켜 주세요.") : "";
    }
  }
  rewrite.onclick = () => { void generate(); }; language.onchange = () => { void generate(); };
  makeImage.onclick = async () => {
    const url = promoImageUrl(shop, target, language.value as PromoLang);
    if (busy || !url) return;
    busy = true; makeImage.disabled = rewrite.disabled = language.disabled = tagline.disabled = true;
    targetButtons.forEach(b => { b.disabled = true; });
    invalidateImage();
    try { png = await promoPng({ ...shop, name: target === "custom" ? request.slice(0, 100) : shop.name, orderUrl: url }, tagline.value, await api.qr(url), target); preview.src = `data:image/png;base64,${png}`; preview.hidden = false; saveImage.disabled = false; }
    catch { status.textContent = t("이미지를 만들지 못했습니다. 다시 시도해 주세요."); }
    finally { busy = false; makeImage.disabled = rewrite.disabled = language.disabled = tagline.disabled = false; targetButtons.forEach(b => { b.disabled = false; }); }
  };
  saveImage.onclick = async () => {
    if (!png || saveImage.disabled) return; saveImage.disabled = true;
    try { if (await api.save(png)) status.textContent = t("PNG를 저장했습니다."); }
    catch { status.textContent = t("PNG를 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { saveImage.disabled = !png; }
  };
  await generate();
}
