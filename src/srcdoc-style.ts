/**
 * srcdoc 미리보기에 그 문서의 <style> 을 「생성 스타일시트」로 다시 붙인다.
 *
 * 🔴 왜 필요한가: 앱 CSP 의 style-src 는 `'self' 'unsafe-inline'` 이지만, Tauri 가 실행 중에
 *    style-src 에 nonce·해시를 덧붙인다. 목록에 nonce 가 있으면 브라우저는 'unsafe-inline' 을
 *    무시한다. srcdoc 문서는 부모의 CSP 를 물려받으므로 그 안의 <style> 이 통째로 막혔다
 *    — 0.4.5 증서 미리보기가 기본 명조체로 왼쪽 위에 쏠린 원인(대표 09-24 캡처).
 *    생성 스타일시트(CSSOM)는 CSP 의 인라인 규칙 밖이라 **같은 CSS 글자**를 그대로 쓸 수 있다.
 *    그래서 미리보기와 인쇄 파일이 같은 render() 결과·같은 CSS 를 쓴다.
 */

const latest = new WeakMap<HTMLIFrameElement, string>();

/** 문서 안의 <style>…</style> 글자를 모두 이어 붙인다. */
export function styleText(html: string): string {
  let css = "";
  for (const m of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)) css += m[1] + "\n";
  return css;
}

/** 이미 불러온 srcdoc 문서에 그 HTML 의 스타일을 붙인다. 옛 웹뷰면 조용히 넘긴다(미리보기는 덤). */
export function adoptSrcdocStyles(frame: HTMLIFrameElement, html: string): boolean {
  const w = frame.contentWindow as (Window & typeof globalThis) | null;
  const d = frame.contentDocument;
  const css = styleText(html);
  if (!w || !d || !css) return false;
  try {
    const sheet = new w.CSSStyleSheet();
    sheet.replaceSync(css);
    d.adoptedStyleSheets = [sheet];
    return true;
  } catch {
    return false;
  }
}

/** srcdoc 을 바꾸고, 문서가 뜨면 스타일을 붙인다. 같은 틀에 몇 번을 불러도 듣는 것은 하나. */
export function setStyledSrcdoc(frame: HTMLIFrameElement, html: string): void {
  if (!latest.has(frame)) {
    frame.addEventListener("load", () => {
      adoptSrcdocStyles(frame, latest.get(frame) || "");
    });
  }
  latest.set(frame, html);
  frame.srcdoc = html;
}
