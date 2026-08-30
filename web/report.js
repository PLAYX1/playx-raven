/* 문제 알리기 — PLAY X Raven 웹(랜딩·지갑·장터).
 *
 * ## 왜 이걸 손으로 또 만드나
 *
 * 본체(playx)에는 이미 신고 장치가 있다(5손가락 → BugReportSheet → px_bug_reports).
 * 그런데 이 세 화면은 **React 가 아니다** — 의존성 0짜리 단일 HTML 이다.
 * 손님 폰과 가게 와이파이가 조건이라 그렇게 만들었고, 그 조건은 안 바뀐다.
 *
 * 그래서 **화면만** 손으로 만들고, **저장은 같은 상자**(`/api/bug-reports`)를 쓴다.
 * 상자가 둘이면 내가 두 곳을 봐야 하고, 그러면 한 곳은 반드시 안 보게 된다.
 *
 * ## 무엇을 자동으로 담나
 *
 * 사람은 "안 돼요" 라고만 적는다. 그것만으로는 못 고친다. 그래서 **묻지 않고**
 * 담는다 — 어느 화면인지, 창이 얼마나 큰지, 방금 무슨 오류가 났는지.
 *
 * 🔴 담지 않는 것: **지갑 12단어·개인키·열쇠.** 이 화면들의 localStorage 에는
 *    그것이 들어 있다. 신고 하나 편하자고 그걸 보낼 수는 없다.
 *    `localStorage` 는 통째로 담지 않고, **어떤 이름이 있는지도 보내지 않는다.**
 *
 * ⚠️ 화면 글자(`visible_text`)도 담지 않는다. 지갑 화면에는 주소와 잔액이
 *    떠 있어서, 그걸 담으면 "얼마 가진 사람이 무엇을 신고했는지" 가 남는다.
 *    본체(BugReportPanel)는 담지만 거기는 지갑 화면이 아니다.
 */
(function () {
  'use strict';

  /* 방금 난 오류를 모아 둔다. 신고할 때 물어보면 이미 지나간 뒤다.
     🔴 이 스크립트가 **제일 먼저** 실려야 잡힌다. 늦게 실리면 그 앞의
     오류를 못 본다 — 그래서 각 화면의 <head> 맨 위에 넣는다. */
  var ERRORS = [];
  function note(kind, msg, stack) {
    if (ERRORS.length >= 5) ERRORS.shift();
    ERRORS.push({
      kind: kind,
      msg: String(msg == null ? '' : msg).slice(0, 300),
      stack: String(stack || '').slice(0, 800),
      at: new Date().toISOString(),
    });
  }
  window.addEventListener('error', function (e) {
    note('error', e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    note('promise', r && r.message ? r.message : r, r && r.stack);
  });
  (function (orig) {
    console.error = function () {
      try { note('console', Array.prototype.join.call(arguments, ' '), ''); } catch (_) {}
      return orig.apply(console, arguments);
    };
  })(console.error);

  var CATS = [
    ['wallet-broken', '지갑이 안 열려요'],
    ['send-failed', '보내기가 안 돼요'],
    ['shop-order', '주문·계산이 안 돼요'],
    ['ravi-wrong', '라비가 틀리게 답해요'],
    ['install-run', '프로그램이 안 켜져요'],
    ['ui', '화면 문제'],
  ];

  /** 어느 화면인지. 화면이 스스로 밝힐 수 있으면 그 값을 쓴다. */
  function screenName() {
    if (window.RAVEN_SCREEN) return String(window.RAVEN_SCREEN).slice(0, 80);
    var p = location.pathname;
    if (p === '/' || p === '/index.html') return '첫 화면';
    if (p.indexOf('wallet') >= 0) return '지갑';
    if (p.indexOf('shops') >= 0) return '가게·물건';
    if (p.indexOf('buy') >= 0) return '사기';
    return p.slice(0, 80);
  }

  function context() {
    return {
      surface: 'web',
      screen: screenName(),
      pathname: location.pathname,
      host: location.host,
      /* 화면 안에서 무엇을 보고 있었나 — 탭·고른 것처럼 **글자가 아닌** 것만.
         지갑 주소·잔액은 담지 않는다. */
      state: (function () {
        try { return window.RAVEN_STATE ? window.RAVEN_STATE() : null; } catch (_) { return null; }
      })(),
      viewport: window.innerWidth + 'x' + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      lang: navigator.language,
      standalone: !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches),
      online: navigator.onLine,
      ua: String(navigator.userAgent).slice(0, 300),
      errors: ERRORS.slice(-5),
    };
  }

  var CSS =
    /* 🔴 두 번 옮겼다. 처음엔 왼쪽 아래에 **떠 있었고**, 하단 탭의
       「지갑」 글자를 그대로 덮었다(대표님 폰 실물). 다음엔 본문 끝으로
       내렸는데, 그건 끝까지 내려가야 보인다.
       지금은 **제목 줄 오른쪽 끝**이다. 화면마다 같은 자리이고,
       아무것도 안 덮고, 스크롤하지 않아도 보인다.
       떠 있는 단추는 40~70대가 제일 자주 잘못 누르는 것이기도 하다. */
    /* ⚠️ `width:auto` 를 못 박는다. 지갑 화면에는 `button{width:100%}` 이
       있어서, 그냥 두면 이 작은 단추가 **화면 폭 전체로 늘어난다**(실측 358px). */
    '.rphead{float:right;width:auto!important;margin:2px 0 0;min-height:44px;padding:0 14px;' +
    'border-radius:999px;border:1px solid rgba(128,128,128,.30);background:transparent;' +
    'color:#6b7280;font-size:15px;cursor:pointer;line-height:42px}' +
    '.rphead:hover{border-color:#e7731f;color:#e7731f}' +
    '@media(prefers-color-scheme:dark){.rphead{color:#9aa0ab}}' +
    /* 라비 시트 안에도 한 줄. 뭔가 안 되면 사람은 먼저 라비에게 말한다 —
       거기서 「문제 알리기」가 보여야 한 걸음이 준다. */
    '.rpinsheet{display:block;width:100%;margin-top:10px;min-height:44px;' +
    'border-radius:12px;border:1px solid rgba(128,128,128,.30);background:transparent;' +
    'color:inherit;font-size:15px;cursor:pointer}' +
    '.rpback{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.45);' +
    'display:flex;align-items:flex-end;justify-content:center}' +
    '@media(min-width:640px){.rpback{align-items:center}}' +
    '.rpcard{width:100%;max-width:560px;max-height:88vh;overflow:auto;background:#fff;color:#141518;' +
    'border-radius:18px 18px 0 0;padding:18px}' +
    '@media(min-width:640px){.rpcard{border-radius:18px}}' +
    '@media(prefers-color-scheme:dark){.rpcard{background:#17191d;color:#f2f3f5}}' +
    '.rpcard h3{margin:0 0 4px;font-size:19px}' +
    '.rpcard p.s{margin:0 0 14px;font-size:14px;opacity:.7;line-height:1.6}' +
    '.rpchips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}' +
    /* 🔴 44px. 이 화면을 여는 사람은 이미 뭔가 안 돼서 짜증이 나 있다. */
    '.rpchip{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid rgba(128,128,128,.35);' +
    'background:transparent;color:inherit;font-size:15px;cursor:pointer}' +
    '.rpchip.on{border-color:#e7731f;color:#e7731f;font-weight:600}' +
    /* 16px 미만이면 아이폰 사파리가 탭할 때마다 화면을 확대한다. */
    '.rpcard textarea,.rpcard input{width:100%;font-size:16px;padding:12px;border-radius:12px;' +
    'border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-family:inherit}' +
    '.rpcard textarea{min-height:110px;line-height:1.6;resize:vertical}' +
    '.rprow{display:flex;gap:8px;margin-top:12px}' +
    '.rprow button{flex:1;min-height:52px;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;' +
    'border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}' +
    '.rprow button.go{background:#e7731f;border-color:#e7731f;color:#fff}' +
    '.rpwhat{margin-top:12px;font-size:13px;opacity:.65;line-height:1.7}' +
    '.rpwhat code{font-size:12px;word-break:break-all}';

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var open = false;
  function openSheet(prefill) {
    if (open) return;
    open = true;
    var ctx = context();
    var back = el('div', 'rpback');
    var card = el('div', 'rpcard');
    card.innerHTML =
      '<h3>무엇이 잘못됐나요?</h3>' +
      '<p class="s">어느 화면인지·무슨 오류가 났는지는 <b>제가 알아서 같이 보냅니다.</b> ' +
      '겪으신 것만 적어 주세요.</p>' +
      '<div class="rpchips">' +
      CATS.map(function (c, i) {
        return '<button class="rpchip" data-c="' + i + '">' + esc(c[1]) + '</button>';
      }).join('') +
      '</div>' +
      '<textarea id="rp-t" placeholder="예: 보내기를 눌렀는데 아무 일도 없어요"></textarea>' +
      '<div class="rprow"><button id="rp-x">그만두기</button>' +
      '<button id="rp-go" class="go">보내기</button></div>' +
      '<div class="rpwhat">같이 보내는 것 — <b>' + esc(ctx.screen) + '</b> 화면 · ' +
      esc(ctx.viewport) + ' · ' + (ctx.errors.length ? ctx.errors.length + '건의 오류' : '오류 없음') +
      '<br />지갑 12단어와 열쇠는 <b>보내지 않습니다.</b> 화면에 뜬 주소·잔액도 담지 않습니다.</div>';
    back.appendChild(card);
    document.body.appendChild(back);

    var ta = card.querySelector('#rp-t');
    if (prefill) ta.value = prefill;
    var pick = null;
    card.querySelectorAll('.rpchip').forEach(function (b) {
      b.onclick = function () {
        card.querySelectorAll('.rpchip').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        pick = CATS[+b.dataset.c];
      };
    });
    function close() { open = false; back.remove(); }
    card.querySelector('#rp-x').onclick = close;
    back.onclick = function (e) { if (e.target === back) close(); };

    card.querySelector('#rp-go').onclick = function () {
      var text = (ta.value || '').trim();
      if (!text) { ta.focus(); return; }
      var btn = card.querySelector('#rp-go');
      btn.disabled = true;
      btn.textContent = '보내는 중…';
      fetch('/api/bug-reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          /* 제목은 사람이 또 적게 하지 않는다. 두 칸을 채우라 하면 안 적는다. */
          title: (pick ? pick[1] + ' — ' : '') + text.slice(0, 60),
          description: text,
          category: pick ? pick[0] : 'ui',
          page_url: location.href.slice(0, 2000),
          device_info: String(navigator.userAgent).slice(0, 2000),
          context: ctx,
        }),
      })
        .then(function (r) { return r.ok; })
        .then(function (ok) {
          card.innerHTML = ok
            ? '<h3>고맙습니다.</h3><p class="s">받았습니다. 어느 화면에서 무슨 일이 있었는지 같이 왔어요.<br />' +
              '고치면 이 자리가 조용히 바뀝니다 — 따로 답을 못 드릴 수도 있는데, 안 읽은 것은 아닙니다.</p>' +
              '<div class="rprow"><button id="rp-x2" class="go">닫기</button></div>'
            : '<h3>보내지 못했습니다.</h3><p class="s">인터넷이 끊겼거나 저희 쪽 문제입니다. ' +
              '잠시 뒤에 다시 해 주세요.</p><div class="rprow"><button id="rp-x2" class="go">닫기</button></div>';
          card.querySelector('#rp-x2').onclick = close;
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = '보내기';
        });
    };
    setTimeout(function () { ta.focus(); }, 60);
  }

  /* 다른 스크립트(라비)가 부를 수 있게 열어 둔다 —
     "이거 안 돼요" 라고 말한 사람에게 라비가 이 창을 띄운다. */
  window.RavenReport = { open: openSheet, context: context };

  function mount() {
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    /* ① 제목 줄 오른쪽 끝. 화면마다 같은 자리다.
       🔴 **보이는** 제목을 골라야 한다. 지갑은 화면 여럿을 한 파일에 넣고
       숨겨 두는 구조라, 그냥 첫 h1 을 잡으면 지금 안 보이는 화면에 붙는다
       (실측: 화면 위에서 279px 자리 = 스크롤해도 안 나오는 곳). */
    var h = null;
    var hs = document.querySelectorAll('h1');
    for (var i = 0; i < hs.length; i++) {
      var vis = hs[i].checkVisibility
        ? hs[i].checkVisibility()
        : !!(hs[i].offsetWidth || hs[i].offsetHeight);
      if (vis) { h = hs[i]; break; }
    }
    if (h) {
      var b = el('button', 'rphead', '문제 알리기');
      b.setAttribute('type', 'button');
      b.onclick = function () { openSheet(''); };
      h.parentNode.insertBefore(b, h);
    }

    /* ② 라비 시트 안에도 한 줄. 뭔가 안 되면 사람은 먼저 라비에게 말한다.
       시트는 나중에 열리므로 **열릴 때 한 번** 넣는다. */
    var put = function () {
      var sheet = document.querySelector('.ravisheet');
      if (!sheet || sheet.querySelector('.rpinsheet')) return;
      var r = el('button', 'rpinsheet', '문제 알리기');
      r.setAttribute('type', 'button');
      r.onclick = function () { openSheet(''); };
      sheet.appendChild(r);
    };
    put();
    if (window.MutationObserver) {
      new MutationObserver(put).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
