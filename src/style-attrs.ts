/**
 * HTML 의 `style="…"` 속성을 CSSOM 으로 되살린다.
 *
 * 🔴 왜 — Tauri 는 앱 CSP 의 style-src 에 nonce 를 덧붙인다(tauri-utils `html.rs`
 *    `inject_nonce_token`). nonce 가 있으면 브라우저는 `'unsafe-inline'` 을 무시하고,
 *    style **속성**에는 nonce 를 달 길이 없어 **전부 무시된다.** 0.4.5 부터 index.html 274곳 +
 *    화면 코드 약 312곳이 설계와 다르게 보였다 — `style="display:none"` 으로 숨긴 35개
 *    (보내기 확인 칸 · 「회원 한 명 지금 지우기」 · 첫 화면 덮개 등)가 **드러나 있었고**,
 *    8초 취소 창의 막대는 차오르지 않았다(RV2·RV3 에서 WebKit 으로 재현).
 *
 *    CSSOM(`el.style…`)은 CSP 가 막지 않는다. 그래서 속성 글자를 그대로 CSSOM 으로 옮긴다 —
 *    설계(개발 때 시험 화면은 CSP 가 없어 늘 이렇게 보였다) 그대로다. 스크립트는 건드리지
 *    않는다(script-src 의 nonce 는 그대로).
 *
 *    새 코드는 속성 대신 클래스나 `el.style.x = …` 를 쓴다. 이 파일은 옛 속성의 안전망.
 */

/** 속성과 CSSOM 이 이미 같으면(되살렸거나 코드가 `el.style` 로 넣은 것) 건드리지 않는다 — 되풀이 없음. */
function apply(el: Element): void {
  const text = el.getAttribute("style");
  const style = (el as HTMLElement | SVGElement).style as CSSStyleDeclaration | undefined;
  if (text === null || !style || style.cssText === text) return;
  style.cssText = text;
}

function applyTree(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (el.hasAttribute("style")) apply(el);
  el.querySelectorAll("[style]").forEach(apply);
}

let watching = false;

/** 지금 문서의 속성을 되살리고, 나중에 들어오는 것(innerHTML · setAttribute)도 따라간다. */
export function restoreStyleAttributes(): void {
  applyTree(document.documentElement);
  if (watching || typeof MutationObserver === "undefined") return;
  watching = true;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") apply(r.target as Element);
      else r.addedNodes.forEach(applyTree);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
}

restoreStyleAttributes();
