/**
 * 「이게 뭐예요?」 — **눌러서 물어보는** 설명.
 *
 * 🔴 대표님: "각 버튼들 마다 기능들을 디테일하게 설명해 주는 기능도 있으면 해.
 *    **주루룩 나열하지 말고** 말야."
 *
 * ## 왜 도움말 페이지를 안 만드나
 *
 * 이미 있다. `guide.html`(20KB, 「무엇을 할 수 있나」). 그런데 **어느 화면도
 * 거기로 안 보낸다** — 아무도 안 읽으니 아무도 안 링크했고, 안 링크하니
 * 더 안 읽힌다. 스무 개를 한 줄로 늘어놓은 글은 **지금 눈앞의 이 단추**가
 * 무엇인지는 끝내 안 알려 준다.
 *
 * ## 대신 하는 것
 *
 * 위쪽 「?」를 누르면 **설명 보기**로 바뀐다. 그 상태에서는 —
 *
 * - 아무 단추나 누르면 **그 하나만** 설명이 뜬다.
 * - **누른 것은 실행되지 않는다.** 이게 핵심이다. 40~70대가 설명을 못 읽는
 *   진짜 이유는 글이 어려워서가 아니라 **눌러 보기가 무서워서**다. 돈이
 *   걸린 화면에서는 더하다. 안 돌아가는 것이 보장돼야 눌러 본다.
 * - 다 보면 「그만 보기」. 원래대로 돌아온다.
 *
 * 나열이 아니라 **가리키는 것**이다. 배우는 자리와 쓰는 자리가 같다.
 *
 * ## 쓰는 법 — 두 가지
 *
 * ① **선택자 표**(권함). 화면에서 이렇게 적어 둔다:
 *
 *     window.PLAYX_HELP = {
 *       '#q': ['가게 이름을 적으면 …', '지금 보이는 목록 안에서만 …'],
 *     };
 *
 * ② 붙박이 요소라면 `data-help="…"` · `data-help-more="…"` 를 직접 단다.
 *
 * 🔴 **①을 기본으로 쓴다.** 처음엔 ②만 만들었는데, 화면을 JS 가 다시
 *    그리는 자리(탭 단추 같은 것)에서는 **다시 그리는 순간 속성이 통째로
 *    날아갔다.** 실측으로 파일에 여덟 개가 있는데 화면에는 여섯 개만
 *    남았다. 눌러도 「설명이 없습니다」가 뜨는데, 우리는 분명히 적어
 *    두었으니 원인을 찾기가 어렵다 — 조용히 없어지는 종류다.
 *
 *    선택자 표는 **누르는 순간 맞춰 보므로** 다시 그려도 안 죽는다.
 *
 * ⚠️ 설명이 없는 것을 누르면 **「설명이 아직 없습니다」라고 말한다.** 조용히
 *    아무 일도 안 나면 사람은 화면이 고장난 줄 안다.
 *
 * ⚠️ 의존성 0. 손님 폰은 가게 와이파이에서 열고, 오래된 안드로이드일 수
 *    있다. 라이브러리를 부르지 않는다.
 */
(() => {
  if (window.__playxHelp) return;
  window.__playxHelp = true;

  let on = false;

  const css = `
    .hlp-btn{position:fixed;right:12px;top:calc(env(safe-area-inset-top,0px) + 12px);
      z-index:60;width:44px;height:44px;border-radius:50%;border:1px solid var(--line,#dcdfe6);
      background:var(--bg,#fff);color:var(--fg,#111);font:700 19px/1 system-ui;cursor:pointer;
      box-shadow:0 1px 4px rgba(0,0,0,.12)}
    .hlp-btn.on{background:#384192;color:#fff;border-color:#384192}
    /* 설명 보기 중임을 **늘 보이게** 한다. 모드에 들어간 줄 모르면
       「단추가 안 먹는다」로 읽힌다 — 그게 제일 나쁜 오해다. */
    .hlp-bar{position:fixed;left:0;right:0;top:0;z-index:59;background:#384192;color:#fff;
      padding:calc(env(safe-area-inset-top,0px) + 10px) 64px 10px 14px;
      font:600 15px/1.45 system-ui}
    .hlp-bar b{display:block;font-size:14px;font-weight:400;opacity:.9;margin-top:2px}
    .hlp-pad{height:0}
    body.hlp-on .hlp-pad{height:76px}
    /* 설명 보기 중에는 무엇이 눌리는지 눈에 보여야 한다. */
    body.hlp-on .hlp-mark{outline:2px dashed rgba(56,65,146,.55);outline-offset:2px;
      border-radius:8px}
    .hlp-sheet{position:fixed;inset:0;z-index:61;background:rgba(0,0,0,.45);
      display:flex;align-items:flex-end}
    .hlp-card{background:var(--bg,#fff);color:var(--fg,#111);width:100%;
      border-radius:18px 18px 0 0;padding:20px 18px calc(env(safe-area-inset-bottom,0px) + 18px)}
    .hlp-card h3{margin:0 0 8px;font-size:19px}
    .hlp-card p{margin:0 0 10px;font-size:16px;line-height:1.65}
    .hlp-card .more{color:var(--muted,#5b616e);font-size:15px}
    .hlp-card button{width:100%;min-height:52px;border-radius:13px;border:0;
      background:#384192;color:#fff;font:600 17px system-ui;margin-top:6px;cursor:pointer}
    @media (prefers-color-scheme:dark){
      .hlp-btn{background:#15171c;color:#e8eaee;border-color:#2c3038}
      .hlp-card{background:#15171c;color:#e8eaee}
    }`;

  function style() {
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  /** 이 요소의 이름. 설명 제목으로 쓴다. */
  function nameOf(el) {
    const t = (el.getAttribute("aria-label") || el.textContent || "").trim();
    return t.slice(0, 40) || "이 자리";
  }

  /**
   * 이 요소의 설명을 찾는다. 붙은 속성 → 선택자 표 순서.
   *
   * 표는 **누를 때마다** 맞춰 본다. 미리 속성으로 심어 두면 화면을 다시
   * 그리는 순간 같이 지워진다(위 주석의 실측).
   */
  function findHelp(el) {
    const a = el.getAttribute("data-help");
    if (a) return [a, el.getAttribute("data-help-more")];
    const map = window.PLAYX_HELP;
    if (!map) return null;
    // 🔴 **가장 가까운 것이 이긴다** — 적어 둔 순서가 아니라.
    //
    //    처음엔 표를 위에서부터 훑어 처음 걸리는 것을 썼다. 그랬더니
    //    `a[href^="/wallet"]` 이 그 아래 있던 「내 물건 올리기」
    //    (`/wallet#sell`)까지 삼켰다 — **제목은 「내 물건 올리기」인데
    //    설명은 지갑 것**이 떴다. 적는 사람이 순서를 늘 옳게 지킬 거라고
    //    믿으면 안 된다. 그건 다음 사람이 밟을 덫이다.
    //
    //    그래서 여기서 정한다: 눌린 것에서 위로 올라가며 **몇 걸음 만에
    //    걸리는가**를 재고, 제일 가까운 것을 쓴다. 같은 요소에 둘이 걸리면
    //    먼저 적은 쪽이 이긴다.
    //    ⚠️ 깊이만으로는 못 가른다. `#sellcta` 와 `a[href^="/wallet"]` 은
    //       **같은 요소**를 가리킨다(둘 다 0걸음). 그래서 같은 깊이면
    //       **더 좁게 적은 쪽**을 쓴다 — CSS 가 쓰는 것과 같은 셈법이다.
    let best = null;
    let bestKey = [Infinity, 0, 0];
    for (const sel of Object.keys(map)) {
      let hit = null;
      try {
        hit = el.closest(sel);
      } catch (_) {
        continue; // 선택자가 틀렸으면 그것만 건너뛴다. 나머지는 살린다.
      }
      if (!hit) continue;
      let depth = 0;
      for (let n = el; n && n !== hit; n = n.parentElement) depth++;
      // id 100 · 속성/클래스 10 · 태그 1. 그래도 같으면 긴 쪽
      // (`…/wallet#rooms` 가 `…/wallet` 보다 좁다).
      const spec =
        (sel.match(/#[\w-]+/g) || []).length * 100 +
        (sel.match(/\[[^\]]*\]|\.[\w-]+/g) || []).length * 10 +
        (sel.match(/^[a-z]+/) ? 1 : 0);
      const key = [depth, -spec, -sel.length];
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        bestKey = key;
        best = map[sel];
      }
    }
    if (!best) return null;
    return Array.isArray(best) ? [best[0], best[1]] : [best, null];
  }

  function show(el) {
    const found = findHelp(el) || [null, null];
    const one = found[0];
    const more = found[1];
    const box = document.createElement("div");
    box.className = "hlp-sheet";
    box.innerHTML =
      `<div class="hlp-card">` +
      `<h3>${esc(nameOf(el))}</h3>` +
      (one
        ? `<p>${esc(one)}</p>` + (more ? `<p class="more">${esc(more)}</p>` : "")
        : // 🔴 조용히 넘어가지 않는다. 아무 일도 안 나면 고장으로 읽힌다.
          `<p>이 자리는 아직 설명이 없습니다.</p>` +
          `<p class="more">아래 「문제 알리기」로 알려 주시면 채워 넣겠습니다.</p>`) +
      `<button type="button">알겠습니다</button></div>`;
    const close = () => box.remove();
    box.querySelector("button").addEventListener("click", close);
    box.addEventListener("click", (e) => {
      if (e.target === box) close();
    });
    document.body.appendChild(box);
  }

  /**
   * 🔴 **잡되 실행은 막는다.**
   *
   * `capture` 로 잡고 `stopPropagation` + `preventDefault` 를 둘 다 한다.
   * 하나만 하면 링크는 여전히 이동하고, 그러면 「안 돌아간다」는 약속이
   * 거짓말이 된다. 약속이 한 번 깨지면 아무도 다시 안 누른다.
   */
  function guard(e) {
    if (!on) return;
    const el = e.target.closest("[data-help], a, button, input, select, textarea, [data-tab]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    show(el);
  }

  /**
   * 설명이 있는 자리에 점선을 친다.
   *
   * 🔴 CSS 로 `[data-help]` 만 칠하면 **선택자 표로 적은 것은 안 칠해진다.**
   *    그러면 사장 눈에는 「설명 있는 곳」이 절반만 보이고, 나머지는 눌러
   *    봐야만 안다. 그건 안내가 아니다.
   */
  function mark() {
    document.querySelectorAll(".hlp-mark").forEach((n) => n.classList.remove("hlp-mark"));
    if (!on) return;
    const sels = ["[data-help]"].concat(Object.keys(window.PLAYX_HELP || {}));
    for (const sel of sels) {
      try {
        document.querySelectorAll(sel).forEach((n) => n.classList.add("hlp-mark"));
      } catch (_) {
        /* 틀린 선택자 하나가 나머지를 막지 않게 한다. */
      }
    }
  }

  function toggle(btn, bar) {
    on = !on;
    document.body.classList.toggle("hlp-on", on);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    bar.style.display = on ? "" : "none";
    if (!on) document.querySelectorAll(".hlp-sheet").forEach((n) => n.remove());
    mark();
  }

  function boot() {
    style();

    const bar = document.createElement("div");
    bar.className = "hlp-bar";
    bar.style.display = "none";
    bar.innerHTML =
      "설명을 보는 중입니다 — 아무 곳이나 눌러 보세요." +
      "<b>누른 것은 실행되지 않습니다. 오른쪽 위 「?」로 그만 봅니다.</b>";

    // 배너가 화면 위를 덮으므로 그만큼 밀어 준다. 안 밀면 제목이 가린다.
    const pad = document.createElement("div");
    pad.className = "hlp-pad";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hlp-btn";
    btn.textContent = "?";
    btn.setAttribute("aria-label", "설명 보기");
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(btn, bar);
    });

    document.body.insertBefore(pad, document.body.firstChild);
    document.body.appendChild(bar);
    document.body.appendChild(btn);
    // capture 단계에서 잡아야 화면의 제 손잡이보다 먼저 온다.
    document.addEventListener("click", guard, true);
    // 🔴 화면을 다시 그리면 점선 클래스가 같이 사라진다. 그때 다시 칠한다.
    //    끄고 있을 때는 아무 일도 안 한다(`mark` 가 바로 돌아온다).
    let pending = 0;
    new MutationObserver(() => {
      if (!on || pending) return;
      pending = window.setTimeout(() => {
        pending = 0;
        mark();
      }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
