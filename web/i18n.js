/* 손님 화면 4개 국어.
 *
 * 🔴 왜 손님 화면부터인가 — 사장은 한국 사람이지만 **손님은 아닐 수 있다.**
 * 관광지 카페에 들어온 사람이 한국어 화면을 보면 그냥 나간다. 사장 화면은
 * 그 사장이 읽으면 되고, 그건 나중 일이다.
 *
 * 라이브러리를 쓰지 않는다. 이 화면들의 조건은 **외부 스크립트 0개**다.
 * 사전 하나와 함수 하나면 된다.
 *
 * ⚠️ 가게가 올린 글(메뉴 이름·설명)은 번역하지 않는다. 우리가 번역하면
 *   「제육볶음」이 「stir-fried pork」가 되고, 손님이 카운터에서 그 말을 하면
 *   아무도 못 알아듣는다. 가게가 직접 적은 4개 국어만 쓴다.
 */
(function () {
  var DICT = {
    ko: {},
    en: {
      "지금 영업 중": "Open now",
      "지금은 주문을 받지 않습니다": "Not taking orders right now",
      "메뉴를 불러오는 중…": "Loading menu…",
      "메뉴를 준비하고 있어요": "The menu is being prepared",
      "품절": "Sold out",
      "주문하기": "Order",
      "궁금한 것 물어보기": "Ask a question",
      "묻기": "Ask",
      "닫기": "Close",
      "지갑 열기": "Open wallet",
      "주문번호": "Order number",
      "입금을 기다립니다": "Waiting for payment",
      "결제하시면 이 화면이 저절로 바뀝니다": "This screen changes by itself once you pay",
      "결제 확인됨": "Payment confirmed",
      "가게가 곧 시작합니다": "The shop will start soon",
      "만드는 중": "Being made",
      "조금만 기다려 주세요": "Just a moment please",
      "나왔습니다": "Ready",
      "카운터에서 받아 가세요": "Please collect it at the counter",
      "전달됨": "Handed over",
      "감사합니다": "Thank you",
      "금액이 모자랍니다": "The amount is short",
      "같은 QR로 나머지를 마저 보내 주세요": "Please send the rest using the same QR",
      "시간이 지난 뒤 도착했습니다": "It arrived after the quote expired",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "The money did arrive — please show this at the counter",
      "결제": "Paid",
      "나왔어요": "Ready",
      "매장·포장": "Dine in / takeaway",
      "배달": "Delivery",
      "지갑이 없으신가요?": "No wallet yet?",
      "1분이면 만듭니다": "It takes a minute",
      "개 남음": " left",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "The amount is filled in when the wallet opens. Just send it.",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "The assistant answers only from what this shop uploaded. When in doubt, ask the shop.",
    },
    ja: {
      "지금 영업 중": "営業中",
      "지금은 주문을 받지 않습니다": "ただいま注文を受け付けていません",
      "메뉴를 불러오는 중…": "メニューを読み込み中…",
      "메뉴를 준비하고 있어요": "メニューを準備しています",
      "품절": "売り切れ",
      "주문하기": "注文する",
      "궁금한 것 물어보기": "質問する",
      "묻기": "聞く",
      "닫기": "閉じる",
      "지갑 열기": "ウォレットを開く",
      "주문번호": "注文番号",
      "입금을 기다립니다": "お支払いをお待ちしています",
      "결제하시면 이 화면이 저절로 바뀝니다": "お支払いいただくとこの画面が自動で変わります",
      "결제 확인됨": "支払いを確認しました",
      "가게가 곧 시작합니다": "まもなく準備を始めます",
      "만드는 중": "準備中",
      "조금만 기다려 주세요": "少々お待ちください",
      "나왔습니다": "できあがりました",
      "카운터에서 받아 가세요": "カウンターでお受け取りください",
      "전달됨": "お渡し済み",
      "감사합니다": "ありがとうございました",
      "금액이 모자랍니다": "金額が足りません",
      "같은 QR로 나머지를 마저 보내 주세요": "同じQRで残りをお送りください",
      "시간이 지난 뒤 도착했습니다": "期限を過ぎてから届きました",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "入金は届いています。カウンターでお見せください",
      "결제": "支払い",
      "나왔어요": "完成",
      "매장·포장": "店内・お持ち帰り",
      "배달": "配達",
      "지갑이 없으신가요?": "ウォレットをお持ちでない方",
      "1분이면 만듭니다": "1分で作れます",
      "개 남음": "個 残り",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "ウォレットが開くと金額が入力されています。そのまま送ってください。",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "店舗が登録した情報のみで回答します。不明な点は店舗にご確認ください。",
    },
    zh: {
      "지금 영업 중": "营业中",
      "지금은 주문을 받지 않습니다": "暂不接单",
      "메뉴를 불러오는 중…": "正在加载菜单…",
      "메뉴를 준비하고 있어요": "菜单准备中",
      "품절": "售罄",
      "주문하기": "下单",
      "궁금한 것 물어보기": "有问题？问一问",
      "묻기": "提问",
      "닫기": "关闭",
      "지갑 열기": "打开钱包",
      "주문번호": "取餐号",
      "입금을 기다립니다": "等待付款",
      "결제하시면 이 화면이 저절로 바뀝니다": "付款后本页面会自动更新",
      "결제 확인됨": "已确认付款",
      "가게가 곧 시작합니다": "店家马上开始制作",
      "만드는 중": "制作中",
      "조금만 기다려 주세요": "请稍候",
      "나왔습니다": "已完成",
      "카운터에서 받아 가세요": "请到柜台领取",
      "전달됨": "已交付",
      "감사합니다": "谢谢",
      "금액이 모자랍니다": "金额不足",
      "같은 QR로 나머지를 마저 보내 주세요": "请用同一个二维码补足余额",
      "시간이 지난 뒤 도착했습니다": "超时后才收到",
      "돈은 들어왔습니다. 카운터에 보여 주세요": "款项已收到，请在柜台出示",
      "결제": "付款",
      "나왔어요": "完成",
      "매장·포장": "堂食・外带",
      "배달": "配送",
      "지갑이 없으신가요?": "还没有钱包？",
      "1분이면 만듭니다": "一分钟就能创建",
      "개 남음": "件剩余",
      "지갑이 열리면 금액이 채워져 있습니다. 그대로 보내세요.":
        "打开钱包后金额已填好，直接发送即可。",
      "AI가 가게가 올린 정보로만 답합니다. 확실하지 않으면 가게에 직접 확인하세요.":
        "仅根据店家上传的信息回答。不确定时请直接询问店家。",
    },
  };

  // 손님 폰이 정한 말을 따른다. 고르라고 묻지 않는다 — 폰은 이미 알고 있고,
  // 처음 보는 화면에서 언어부터 고르라는 것은 한 걸음 더 늘리는 일이다.
  var want = (navigator.language || "ko").slice(0, 2).toLowerCase();
  // 저장해 둔 선택이 있으면 그게 이긴다.
  try {
    var saved = localStorage.getItem("playx-raven-lang");
    if (saved) want = saved;
  } catch (e) {}
  var lang = DICT[want] ? want : "ko";

  window.PXLANG = lang;
  window.t = function (s) {
    if (lang === "ko") return s;
    var d = DICT[lang];
    return (d && d[s]) || s; // 없으면 한국어 그대로. 빈 화면보다 낫다.
  };

  // 화면에 이미 박힌 글자를 바꾼다. `data-t` 를 일일이 달지 않는 이유는
  // 그걸 빠뜨린 자리가 반드시 생기고, 그 자리만 한국어로 남기 때문이다.
  window.translateDom = function (root) {
    if (lang === "ko") return;
    var d = DICT[lang];
    var w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      var k = n.nodeValue.trim();
      if (k && d[k]) n.nodeValue = n.nodeValue.replace(k, d[k]);
    }
    var ph = (root || document).querySelectorAll("[placeholder]");
    for (var i = 0; i < ph.length; i++) {
      var p = ph[i].getAttribute("placeholder");
      if (d[p]) ph[i].setAttribute("placeholder", d[p]);
    }
    document.documentElement.lang = lang;
  };

  window.setLang = function (l) {
    try {
      localStorage.setItem("playx-raven-lang", l);
    } catch (e) {}
    location.reload();
  };
})();
