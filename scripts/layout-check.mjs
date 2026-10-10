// 레이아웃 품질 관문 — 공용 측정 함수(페이지 안에서 돈다). layout-gate-browser.test.mjs 가 쓴다.
// 규칙 문서: docs/design/layout-tokens.md §관문. 한 곳에서만 고친다.

/** 페이지 안: 글자를 늘린다(원문은 기억해 두고 되돌릴 수 있다). variant: orig | p60 | p100 | de | ru */
export function applyVariant(variant) {
  // [data-fixed-text] 는 번역하지 않는 기호(크기 글자 S/M/L 등) — 늘리지 않는다.
  const DE = ['Wiederherstellungsschlüssel', 'Kontostandsübersicht', 'Bestätigungen', 'Einstellungen', 'Sicherungskopie', 'Empfangsadresse', 'Überweisung', 'Verkäufermodus'];
  const RU = ['Восстановление', 'Подтверждение', 'Настройки', 'Резервная копия', 'Адрес получения', 'Отправить', 'Синхронизируется', 'Режим продавца'];
  window.__rvOrig ??= new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && !/^(SCRIPT|STYLE|OPTION|TIME)$/.test(n.parentElement.tagName) && !n.parentElement.closest('[data-fixed-text]') && n.textContent.trim() ? 1 : 2) });
  let i = 0, changed = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!window.__rvOrig.has(n)) window.__rvOrig.set(n, n.textContent);
    const o = window.__rvOrig.get(n);
    const core = o.trim();
    // 숫자·기호만 있는 칸(금액·시각·••••)은 그대로 — 번역이 숫자를 늘리지 않는다.
    if (variant === 'orig' || !/\p{L}/u.test(core)) { if (n.textContent !== o) n.textContent = o; continue; }
    let s;
    if (variant === 'p60' || variant === 'p100') {
      const extra = Math.ceil([...core].length * (variant === 'p60' ? 0.6 : 1));
      s = core + [...core].join('').repeat(3).slice(0, extra);
    } else {
      const words = variant === 'de' ? DE : RU;
      const target = Math.max(6, Math.round([...core].length * 2.2));
      s = words[i++ % words.length];
      while (s.length < target) s += ' ' + words[i++ % words.length].toLowerCase();
    }
    n.textContent = o.replace(core, s); changed++;
  }
  return changed;
}

/** 페이지 안: scope 선택자 아래를 잰다. 실패 종류와 「안정된 열쇠」(글자 없이 위치로) 를 돌려준다. */
export function measureLayout({ scope, screen }) {
  const vw = document.documentElement.clientWidth;
  const roots = [...document.querySelectorAll(scope)];
  // checkVisibility: 닫힌 <details> 안(content-visibility:hidden)은 상자 크기가 남아 있어도 안 보인다 — 그걸 「보임」으로 세면 가짜 겹침이 쏟아진다.
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert],[aria-hidden="true"]') && (el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) : true); };
  const key = (el) => {
    const own = el.id ? `#${el.id}` : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    if (el.id) return own;
    let p = el.parentElement; while (p && !p.id) p = p.parentElement;
    return `${p ? `#${p.id}` : ''} ${own}`.trim();
  };
  const scrollable = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX + s.overflowY) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
  const out = [];
  const add = (check, el, detail) => out.push({ screen, check, key: key(el), detail, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) });
  const docOver = document.documentElement.scrollWidth - vw;
  if (docOver > 1) out.push({ screen, check: 'doc-overflow', key: 'document', detail: `+${docOver}px`, text: '' });
  const interactive = [];
  for (const r of roots) for (const el of [r, ...r.querySelectorAll('*')]) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el), rect = el.getBoundingClientRect();
    const hasText = [...el.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim());
    if (rect.right > vw + 1 && s.position !== 'fixed' && !scrollable(el)) add('offscreen', el, `right ${Math.round(rect.right)}/${vw}`);
    const clipX = /(hidden|clip)/.test(s.overflowX), clipY = /(hidden|clip)/.test(s.overflowY);
    if ((clipX || clipY) && el.textContent.trim()) {
      const wide = el.scrollWidth > el.clientWidth + 1, tall = el.scrollHeight > el.clientHeight + 1;
      const ellipsis = s.textOverflow === 'ellipsis' && s.whiteSpace.includes('nowrap');
      if (clipX && wide) add(ellipsis ? 'ellipsis' : 'clip', el, `${el.scrollWidth}>${el.clientWidth}`);
      else if (clipY && tall && !/(auto|scroll)/.test(s.overflowY) && !s.webkitLineClamp?.match?.(/\d/)) add('clip-y', el, `${el.scrollHeight}>${el.clientHeight}`);
    }
    if (hasText && el.clientWidth > 0 && el.clientWidth < 48 && el.textContent.trim().length >= 4) {
      const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      if (rect.height > lh * 3.2) add('narrow', el, `${el.clientWidth}px × ${Math.round(rect.height / lh)}줄`);
    }
    if (el.matches('button, a[href], a[data-page], input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], label:has(input)')) {
      if (!el.disabled) interactive.push(el);
      const small = Math.min(rect.width, rect.height);
      if (!el.disabled && el.matches(':not(input[type=checkbox]):not(input[type=radio])')) {
        if (small < 24) add('target-small', el, `${Math.round(rect.width)}×${Math.round(rect.height)}`);
        else if (small < 44) add('target-under-44', el, `${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
    if (el.matches('button, [role=button], a.btn') && el.textContent.trim()) {
      // 버튼 안 낱말이 두 줄로 쪼개졌나(「설 / 정」·「Einstellung / en」).
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      outer: for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        const re = /\S{2,}/gu; let m;
        while ((m = re.exec(t.textContent))) {
          const rg = document.createRange(); rg.setStart(t, m.index); rg.setEnd(t, m.index + m[0].length);
          const tops = new Set([...rg.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
          if (tops.size > 1) { add('word-split', el, m[0].slice(0, 20)); break outer; }
        }
      }
    }
  }
  // 겹침: 누를 수 있는 것끼리, **보이게 칠해진 부분**만(투명한 넓은 label 상자는 빼고 글자·테두리·배경이 있는 곳).
  const painted = (el) => {
    const cs = getComputedStyle(el);
    const solid = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 0 || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    if (solid) return [el.getBoundingClientRect()];
    const out = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) { if (!t.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(t); out.push(...[...rg.getClientRects()].filter((q) => q.width > 0)); }
    for (const g of el.querySelectorAll('svg, img, input, select, textarea')) out.push(g.getBoundingClientRect());
    // 넘친 글자가 잘려 안 보이는 부분(overflow hidden·말줄임)은 칠해지지 않은 것 — 자기 상자로 자른다.
    const box = el.getBoundingClientRect();
    return out.map((q) => ({ left: Math.max(q.left, box.left), right: Math.min(q.right, box.right), top: Math.max(q.top, box.top), bottom: Math.min(q.bottom, box.bottom) }));
  };
  const rects = interactive.map((el) => [el, painted(el)]);
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const [ea, ra] = rects[a], [eb, rb] = rects[b];
    if (ea.contains(eb) || eb.contains(ea)) continue;
    let hit = null;
    for (const p of ra) for (const q of rb) {
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w > 2 && h > 2) { hit = [w, h]; break; }
    }
    if (hit) add('overlap', ea, `${key(eb)} ${Math.round(hit[0])}×${Math.round(hit[1])}`);
  }
  return out;
}

/** 관문에서 실패로 치는 것(나머지는 표에만). */
export const GATING = new Set(['doc-overflow', 'offscreen', 'clip', 'clip-y', 'overlap', 'word-split', 'target-small', 'narrow']);
