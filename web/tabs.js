/* 하단 탭 — 밀어서도 옮긴다.
 *
 * ## 왜
 *
 * 대표님 지적: *"메뉴가 아쉽다. 노인도 가능한 디자인이어야 하고, 메뉴 이동이
 * 좌우 슬라이드로 가능하면 어때?"*
 *
 * 작은 탭을 **정확히 겨냥해 누르는 것**은 손이 떨리면 어렵다. 미는 것은
 * 겨냥이 필요 없다 — 화면 아무 데나 잡고 밀면 된다.
 *
 * 🔴 다만 **누르는 길을 없애지 않는다.** 미는 것은 배워야 알고, 안 배운
 * 사람에게는 없는 기능이다. 미는 길을 **더할** 뿐이다.
 *
 * ## ⚠️ 아이폰 뒤로가기와 겹친다
 *
 * 사파리는 **왼쪽 가장자리에서 오른쪽으로 미는 것**을 뒤로가기로 가져간다.
 * 거기서 시작한 손짓은 우리가 건드리지 않는다 — 뺏으면 뒤로가기가 죽고,
 * 그건 우리가 만든 것보다 훨씬 중요한 길이다.
 *
 * ## 세로 스크롤과도 겹친다
 *
 * 목록을 훑는 손짓이 탭 이동으로 읽히면 화면이 제멋대로 바뀐다.
 * 가로로 **세로의 두 배 이상** 움직였을 때만 탭으로 친다.
 */
(function () {
  'use strict';

  var bar = document.querySelector('.tabbar');
  if (!bar) return;

  var tabs = [].slice.call(bar.querySelectorAll('a'));
  if (tabs.length < 2) return;

  /* 지금 몇 번째인가. `aria-current` 나 `.on` 으로 표시돼 있다. */
  var here = tabs.findIndex(function (a) {
    return a.classList.contains('on') || a.getAttribute('aria-current') === 'page';
  });
  if (here < 0) here = 0;

  /* ── 노인 기준으로 키운다 ────────────────────────────────────────
     실측(2026-08-22): 글자 12.5px · 아이콘 22px · 높이 56px 이었다.
     [[playx-first-user]] 기준은 본문 15px 이상, 터치 48px 이상이다.
     12.5px 는 읽을 문구에 쓰면 안 되는 크기다. */
  var s = document.createElement('style');
  s.textContent =
    '.tabbar a{min-height:64px!important;font-size:15px!important;gap:3px!important}' +
    '.tabbar a svg{width:26px!important;height:26px!important}' +
    /* 지금 어디인지가 색만으로 표시되면 색약인 사람은 못 본다. 밑줄을 같이 준다. */
    '.tabbar a.on{box-shadow:inset 0 3px 0 var(--ravi,#e7731f)}' +
    /* 바가 커진 만큼 본문 끝도 더 비워야 마지막 줄이 안 가린다. */
    'body{padding-bottom:calc(74px + env(safe-area-inset-bottom,0px))!important}' +
    /* 미는 중이라는 것을 손끝에 알린다. 아무 반응이 없으면 안 되는 줄 안다. */
    '.tabslide{transition:transform .18s ease}' +
    '@media(prefers-reduced-motion:reduce){.tabslide{transition:none}}';
  document.head.appendChild(s);

  /* 어느 쪽으로 갈 수 있는지 화면에 적어 둔다 — 미는 길은 배워야 안다.
     한 번 보고 나면 다시 안 띄운다(매번 뜨면 잔소리다). */
  try {
    if (!localStorage.getItem('rvn-swipe-told')) {
      var hint = document.createElement('div');
      hint.textContent = '← 좌우로 밀어도 옮겨집니다 →';
      hint.style.cssText =
        'position:fixed;left:0;right:0;bottom:calc(78px + env(safe-area-inset-bottom,0px));' +
        'z-index:60;text-align:center;font-size:14px;color:#fff;pointer-events:none;' +
        'background:rgba(24,26,32,.82);padding:10px;transition:opacity .4s';
      document.addEventListener('DOMContentLoaded', function () {
        // 🔴 바가 감춰진 화면(12단어 적는 중 등)에서는 안내도 안 띄운다.
        //    「밀면 옮겨집니다」를 그 자리에서 읽으면 밀어 보게 되는데,
        //    거기서는 밀어도 안 옮겨진다 — 안 되는 것을 권하는 셈이다.
        //    그때는 「봤다」 표시도 안 남긴다. 다음에 제대로 보여 준다.
        if (!지금옮겨도되나()) return;
        document.body.appendChild(hint);
        setTimeout(function () { hint.style.opacity = '0'; }, 3600);
        setTimeout(function () { hint.remove(); }, 4200);
        try { localStorage.setItem('rvn-swipe-told', '1'); } catch (_) {}
      });
    }
  } catch (_) { /* localStorage 가 막혀 있어도 미는 건 된다 */ }

  var x0 = 0, y0 = 0, tracking = false;
  var EDGE = 28;      // 아이폰 뒤로가기 자리. 여기서 시작한 손짓은 안 건드린다.
  var NEED = 64;      // 이만큼은 밀어야 뜻이 있다고 본다. 손 떨림과 구별한다.

  /**
   * 🔴 **바가 안 보이면 밀어도 안 옮긴다.**
   *
   * 지갑은 12단어를 적는 동안 이 바를 감춘다. 그때 12단어는 아직 어디에도
   * 안 적혀 있고 화면 안에만 있어서, **한 번 옮겨 가면 그 지갑은 영영 못
   * 연다**(2026-08-30 에 실제로 뚫려 있던 구멍이다).
   *
   * 바를 감춘 화면은 「지금 나가면 안 된다」고 이미 말한 것이다. 미는 길이
   * 그 말을 무시하면, 누르는 길만 막고 미는 길로 잃는 꼴이 된다.
   *
   * 화면마다 조건을 적지 않는다 — **바가 보이나 안 보이나** 하나만 본다.
   * 그러면 나중에 다른 화면이 바를 감춰도 여기는 저절로 따라간다.
   */
  function 지금옮겨도되나() {
    // `offsetParent` 가 없으면 `display:none` 이다(고정 위치 요소가 아니면).
    return bar.offsetParent !== null || bar.getClientRects().length > 0;
  }

  document.addEventListener(
    'touchstart',
    function (e) {
      if (e.touches.length !== 1) return;          // 두 손가락은 확대다
      var t = e.touches[0];
      // 🔴 왼쪽 가장자리는 사파리 뒤로가기 자리다. 뺏지 않는다.
      if (t.clientX < EDGE) return;
      // 가로로 스스로 스크롤하는 것(사진 줄 등) 위에서는 안 잡는다.
      if (e.target && e.target.closest && e.target.closest('.noswipe, input, textarea, select')) return;
      x0 = t.clientX;
      y0 = t.clientY;
      tracking = true;
    },
    { passive: true },
  );

  document.addEventListener(
    'touchend',
    function (e) {
      if (!tracking) return;
      tracking = false;
      // 🔴 바가 감춰진 화면에서는 아무 데도 안 간다. 위 설명을 볼 것.
      if (!지금옮겨도되나()) return;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - x0;
      var dy = t.clientY - y0;
      // 세로로 훑는 손짓을 탭 이동으로 읽으면 화면이 제멋대로 바뀐다.
      if (Math.abs(dx) < NEED || Math.abs(dx) < Math.abs(dy) * 2) return;
      var next = dx < 0 ? here + 1 : here - 1;
      if (next < 0 || next >= tabs.length) return;   // 끝에서는 아무 일도 없다
      var href = tabs[next].getAttribute('href');
      if (!href) return;
      // 미는 방향으로 살짝 따라가고 넘어간다. 아무 반응 없이 바뀌면
      // 무슨 일이 났는지 모른다.
      document.body.classList.add('tabslide');
      document.body.style.transform = 'translateX(' + (dx < 0 ? -18 : 18) + 'px)';
      setTimeout(function () { location.href = href; }, 120);
    },
    { passive: true },
  );
})();
