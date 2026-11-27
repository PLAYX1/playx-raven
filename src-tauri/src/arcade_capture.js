/* 11-27 「라비가 다 해 줄게요」 붙잡기 도우미 — 미리보기 칸(127.0.0.1:8791, sandbox iframe) 안에서만 <head> 첫머리에 붙는다. 올리는 게임 파일에는 들어가지 않는다.
 * 부모(앱 화면)가 {type:'rv-capture', v:1, id, ask:'cover'|'preview'} 를 보내면 가장 큰 <canvas> 를 찾아
 *   cover   → JPEG(1200x675 안, 비율 유지, 품질 0.85) 바이트
 *   preview → MediaRecorder 약 6초(mp4 되면 mp4, 아니면 webm · 600kbps · 가로 480 이하) 바이트
 * 를 {type:'rv-capture', v:1, id, ok, kind, mime, bytes} 로 돌려준다. 캔버스가 없으면 ok:false reason:'no-canvas'. */
(function () {
  "use strict";
  if (window.__rvCapture) return;
  window.__rvCapture = 1;
  // 11-27 라비가 게임을 10초 돌리는 동안 소리를 끈다(키오스크 상담 화면 옆에서 올린다 — 페이블). 게임 시계는 그대로 가게
  //   AudioContext 를 멈추지 않고, 스피커(destination)로 가는 길에만 소리 0 인 마디를 끼운다. 영상·소리 요소는 play 때 음소거.
  try {
    var conn = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      if (typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode) {
        var ctx = dest.context, m = ctx.__rvMute;
        if (!m) { m = ctx.__rvMute = ctx.createGain(); m.gain.value = 0; conn.call(m, dest); }
        var args = Array.prototype.slice.call(arguments); args[0] = m;
        conn.apply(this, args);
        return dest;
      }
      return conn.apply(this, arguments);
    };
    var play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { try { this.muted = true; this.volume = 0; } catch (e) { /* 그대로 */ } return play.apply(this, arguments); };
  } catch (e) { /* 소리 장치가 없는 환경 */ }
  // 🔴 sandbox iframe 은 불투명 출처라 게임 자기 그림도 「남의 출처」가 된다 → 캔버스가 더럽혀져 표지·영상을 못 뜬다.
  //    미리보기 서버가 CORS(*)를 붙이고, 여기서 <img> 를 crossOrigin=anonymous 로 바꿔 깨끗하게 둔다(게임보다 먼저 — <head> 첫머리에 붙는다).
  try {
    var anon = function (i) { if (i && i.tagName === "IMG" && !i.hasAttribute("crossorigin")) i.crossOrigin = "anonymous"; };
    var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (d && d.set) Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { anon(this); d.set.call(this, v); } });
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) { if (String(n).toLowerCase() === "src") anon(this); return sa.call(this, n, v); };
    new MutationObserver(function (ms) {
      ms.forEach(function (m) { m.addedNodes.forEach(function (n) { anon(n); if (n.querySelectorAll) n.querySelectorAll("img").forEach(anon); }); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 옛 브라우저 — 그림 없는 게임은 그대로 된다 */ }
  var post = function (m, tr) { try { parent.postMessage(m, "*", tr || []); } catch (e) { /* 부모가 없다 */ } };
  function biggest() {
    var best = null, area = 0;
    var list = document.querySelectorAll("canvas");
    for (var i = 0; i < list.length; i++) {
      var c = list[i], r = c.getBoundingClientRect();
      var a = Math.max(c.width * c.height, r.width * r.height);
      if (c.width > 1 && c.height > 1 && r.width > 0 && r.height > 0 && a > area) { area = a; best = c; }
    }
    return best;
  }
  function fit(w, h, mw, mh) {
    var s = Math.min(1, mw / w, mh / h);
    return [Math.max(2, Math.round((w * s) / 2) * 2), Math.max(2, Math.round((h * s) / 2) * 2)];
  }
  /** 거의 한 색이면 true(WebGL 버퍼가 비어 보일 때). */
  function flat(g, w, h) {
    try {
      var d = g.getImageData(0, 0, w, h).data, step = Math.max(4, Math.floor(d.length / 4 / 400)) * 4;
      var r0 = d[0], g0 = d[1], b0 = d[2], far = 0, n = 0;
      for (var i = 0; i < d.length; i += step) { n++; if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 24) far++; }
      return far < n * 0.02;
    } catch (e) { return true; }
  }
  /** 캔버스 흐름을 보는 video(WebGL 도 프레임이 잡힌다). */
  function watch(c) {
    return new Promise(function (res) {
      var s;
      try { s = c.captureStream(30); } catch (e) { res(null); return; }
      var v = document.createElement("video"), done = false;
      v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = s;
      var fin = function () { if (done) return; done = true; res({ v: v, s: s }); };
      v.onloadeddata = function () { setTimeout(fin, 200); };
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      setTimeout(fin, 2000);
    });
  }
  var stop = function (w) { if (w && w.s) w.s.getTracks().forEach(function (t) { t.stop(); }); };
  function toBlob(o, type, q) { return new Promise(function (r) { o.toBlob(function (b) { r(b); }, type, q); }); }

  async function cover(c) {
    var sz = fit(c.width, c.height, 1200, 675), o = document.createElement("canvas");
    o.width = sz[0]; o.height = sz[1];
    var g = o.getContext("2d"), ok = false;
    try { g.drawImage(c, 0, 0, o.width, o.height); ok = !flat(g, o.width, o.height); } catch (e) { ok = false; }
    if (!ok) {
      var w = await watch(c);
      if (w && w.v.videoWidth) { try { g.drawImage(w.v, 0, 0, o.width, o.height); } catch (e) { /* 그대로 */ } }
      stop(w);
    }
    return toBlob(o, "image/jpeg", 0.85);
  }

  async function preview(c, ms) {
    if (typeof MediaRecorder === "undefined") throw new Error("no-recorder");
    var sz = fit(c.width, c.height, 480, 480), o = document.createElement("canvas");
    o.width = sz[0]; o.height = sz[1];
    var g = o.getContext("2d"), w = await watch(c), raf = 0, live = true;
    var draw = function () {
      if (!live) return;
      try { g.drawImage(w && w.v.videoWidth ? w.v : c, 0, 0, o.width, o.height); } catch (e) { /* 다음 판 */ }
      raf = requestAnimationFrame(draw);
    };
    draw();
    var types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    var type = "";
    for (var i = 0; i < types.length; i++) { if (MediaRecorder.isTypeSupported(types[i])) { type = types[i]; break; } }
    var stream = o.captureStream(30), chunks = [];
    var rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 600000 } : { videoBitsPerSecond: 600000 });
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var ended = new Promise(function (r) { rec.onstop = r; });
    rec.start(500);
    setTimeout(function () { try { rec.stop(); } catch (e) { /* 이미 멈춤 */ } }, ms);
    await ended;
    live = false; cancelAnimationFrame(raf); stop(w);
    stream.getTracks().forEach(function (t) { t.stop(); });
    var mime = (rec.mimeType || type || "video/webm").split(";")[0];
    return new Blob(chunks, { type: mime });
  }

  addEventListener("message", async function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.type !== "rv-capture" || m.v !== 1 || typeof m.id !== "string") return;
    if (m.ask !== "cover" && m.ask !== "preview") return;
    var c = biggest();
    if (!c) { post({ type: "rv-capture", v: 1, id: m.id, ok: false, kind: m.ask, reason: "no-canvas" }); return; }
    try {
      var ms = Math.min(8000, Math.max(2000, Number(m.ms) || 6000));
      var b = m.ask === "cover" ? await cover(c) : await preview(c, ms);
      if (!b || !b.size) throw new Error("empty");
      var buf = await b.arrayBuffer();
      post({ type: "rv-capture", v: 1, id: m.id, ok: true, kind: m.ask, mime: b.type, bytes: buf }, [buf]);
    } catch (err) {
      post({ type: "rv-capture", v: 1, id: m.id, ok: false, kind: m.ask, reason: String((err && err.message) || err).slice(0, 80) });
    }
  });
  var hello = function () { post({ type: "rv-capture", v: 1, ready: true }); };
  if (document.readyState === "complete") hello(); else addEventListener("load", hello);
})();
