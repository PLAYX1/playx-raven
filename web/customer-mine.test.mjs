/**
 * 손님 화면 「내 예약」 순수 로직 시험 (RV7 §17·§18·§19·§23).
 *
 * wallet.test.mjs 와 같은 원칙: 소스를 베껴 적지 않는다. customer.html 의
 * `<script id="mine-logic">` 블록을 그때그때 떼어 node 에서 돌린다 — 화면 코드가
 * 바뀌면 시험도 같이 바뀐다. DOM·네트워크는 여기서 못 본다(실화면으로 본다).
 *
 * 도는 법:  node --test web/customer-mine.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "customer.html"), "utf8");
const m = HTML.match(/<script id="mine-logic">([\s\S]*?)<\/script>/);
assert.ok(m, "customer.html 에 mine-logic 블록이 없다");
const ctx = { URL, Date, JSON, Math, Object, Array, String, Number, encodeURIComponent };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const M = ctx.RVMine;

function mem() {
  const d = new Map();
  return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), d };
}

test("문구 표: 모든 줄이 4개 언어로 차 있다", () => {
  for (const [k, row] of Object.entries(M.T)) {
    assert.equal(row.length, 4, `${k} 는 4개 언어여야 한다`);
    row.forEach((s, i) => assert.ok(typeof s === "string" && s.trim(), `${k}[${M.LANGS[i]}] 가 비었다`));
    const holes = (row[0].match(/\{\d\}/g) || []).sort().join();
    row.forEach((s, i) => assert.equal((s.match(/\{\d\}/g) || []).sort().join(), holes, `${k}[${M.LANGS[i]}] 자리표시가 다르다`));
  }
  assert.equal(M.tr("ago_min", "ja", 5), "最終確認 5分前");
  assert.equal(M.tr("ago_min", "xx", 5), "마지막 확인 5분 전", "모르는 말은 한국어");
});

test("환불 문구: 가게 정책으로 적고 법률 확정 표현을 쓰지 않는다(§18.4)", () => {
  const ko = M.T.policy[0];
  assert.match(ko, /^가게 정책:/);
  assert.match(ko, /사장님이 직접/);
  for (const bad of ["법적으로", "법률상", "청약철회", "불가합니다", "절대"]) assert.ok(!ko.includes(bad), bad);
});

test("택배 조회 링크: 폰 앱 courier-links.ts 와 같은 주소 형식", () => {
  const cases = [
    ["CJ대한통운", "6012-3456-7890", "https://www.cjlogistics.com/ko/tool/parcel/tracking?gnbInvcNo=601234567890"],
    ["한진택배", "4123 4567 8901", "https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=412345678901"],
    ["롯데택배", "2345678901234", "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=2345678901234"],
    ["우체국", "6123456789012", "https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=6123456789012"],
    ["우체국택배", "6123456789012", "https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=6123456789012"],
    ["로젠택배", "12345678901", "https://www.ilogen.com/web/personal/trace/12345678901"],
  ];
  for (const [c, n, want] of cases) assert.equal(M.courierLink(c, n), want, c);
  assert.equal(M.courierLink("모르는택배", "123456789012"), "", "모르는 택배사는 버튼 없이 번호만");
  assert.equal(M.courierLink("CJ대한통운", "12ab567890"), "", "숫자 아닌 글자");
  assert.equal(M.courierLink("로젠택배", "123"), "", "자릿수");
  assert.equal(M.courierLink("CJ대한통운", "6012345678901234"), "", "너무 김");
});

test("저장은 이 가게 주소(host) 한정이고 같은 주문은 합쳐진다", () => {
  const s = mem();
  M.save(s, "a.example", [{ a: "Rabc", state: "waiting" }]);
  assert.equal(M.load(s, "b.example").length, 0, "다른 가게 주소에서는 안 보인다");
  let list = M.load(s, "a.example");
  list = M.upsert(list, { a: "Rabc", state: "paid" });
  list = M.upsert(list, { a: "Rdef", state: "waiting" });
  assert.equal(list.length, 2);
  assert.equal(list[0].state, "paid");
  const broken = { getItem: () => "{not json", setItem: () => { throw new Error("full"); } };
  assert.equal(M.load(broken, "x").length, 0, "깨진 저장은 빈 목록");
  assert.equal(M.save(broken, "x", list), false, "못 쓰면 false, 던지지 않는다");
  // 30줄까지만.
  const many = Array.from({ length: 40 }, (_, i) => ({ a: "R" + i }));
  M.save(s, "a.example", many);
  assert.equal(M.load(s, "a.example").length, 30);
});

test("상태 한 줄: 신청함 → 결제 확인 → 준비 중 → 발송함/나왔어요 → 전달됨", () => {
  const now = 2_000_000_000;
  const e = { a: "R1", state: "waiting", exp: now + 600 };
  assert.equal(M.stageOf(e, now).key, "st_unpaid");
  assert.equal(M.stageOf({ ...e }, now + 10_000).key, "st_unpaid_late", "견적이 지나면 안 낸 것으로");
  assert.equal(M.stageOf({ ...e, state: "paid" }, now).step, 1);
  assert.equal(M.stageOf({ ...e, state: "making" }, now).step, 2);
  assert.equal(M.stageOf({ ...e, state: "ready" }, now).key, "st_ready");
  const shipped = M.applyState(e, { state: "making", ship: { carrier: "롯데택배", number: "2345678901234", url: "https://evil.example" } }, 5);
  assert.equal(M.stageOf(shipped, now).key, "st_shipped", "송장이 들어오면 발송함");
  assert.equal(shipped.ship.url, undefined, "서버가 준 아무 주소나 저장하지 않는다 — 링크는 목록으로 만든다");
  assert.equal(shipped.checked, 5);
  assert.equal(M.stageOf({ ...shipped, state: "done" }, now).key, "st_done");
  assert.equal(M.stageOf({ ...e, state: "unknown" }, now).key, "st_lost");
  assert.deepEqual([...M.stepLabels(true, "ko")], ["신청함", "결제 확인", "준비 중", "발송함", "전달됨"]);
  assert.deepEqual([...M.stepLabels(false, "en")], ["Requested", "Paid", "Preparing", "Ready", "Delivered"]);
  // 응답이 이상하면 바꾸지 않는다(마지막 상태를 지킨다).
  assert.equal(M.applyState(shipped, null, 9), shipped);
});

test("결제한 진행 중 예약은 목록에서 뺄 수 없다(취소로 오해) · 끝난 것만", () => {
  const now = 2_000_000_000;
  for (const s of ["paid", "making", "ready", "short", "expired"]) assert.equal(M.removable({ a: "R", state: s }, now), false, s);
  assert.equal(M.removable({ a: "R", state: "done" }, now), true);
  assert.equal(M.removable({ a: "R", state: "unknown" }, now), true);
  assert.equal(M.live({ a: "R", state: "done" }, now), false, "끝난 것은 다시 묻지 않는다");
});

test("오래된 끝난 것만 치운다", () => {
  const nowMs = 2_000_000_000_000, day = 86_400_000;
  const list = [
    { a: "1", state: "done", made: nowMs - 31 * day },
    { a: "2", state: "done", made: nowMs - 2 * day },
    { a: "3", state: "paid", made: nowMs - 300 * day },
    { a: "4", state: "unknown", made: nowMs - 4 * day },
  ];
  assert.deepEqual(M.prune(list, nowMs).map((e) => e.a), ["2", "3"]);
});

test("마지막 확인 N분 전", () => {
  const t = 1_000_000_000_000;
  assert.equal(M.agoText(t, 0, "ko"), "");
  assert.equal(M.agoText(t + 20_000, t, "ko"), "마지막 확인 방금");
  assert.equal(M.agoText(t + 7 * 60_000, t, "ko"), "마지막 확인 7분 전");
  assert.equal(M.agoText(t + 3 * 3_600_000, t, "en"), "Last checked 3 h ago");
  assert.equal(M.agoText(t + 3 * 86_400_000, t, "zh"), "最后确认 3天前");
});

test("받는 날을 크게: 예약 시각 우선, 공동구매는 받는 날", () => {
  const w1 = M.whenOf({ pickup: ["2026-11-05"] }, "ko");
  assert.equal(w1.label, "받는 날");
  assert.match(w1.text, /11월 5일/);
  const w2 = M.whenOf({ slot: 1_793_000_000, pickup: ["2026-11-05"] }, "en");
  assert.equal(w2.label, "Reserved time");
  assert.equal(M.whenOf({}, "ko"), null);
  assert.equal(M.dayText("엉뚱", "ko"), "엉뚱");
});

test("환불 없음 확인은 공동구매·시각 예약에만", () => {
  const menu = [{ name: "샤인머스캣", group: { pickup: "2026-11-05" }, refund: "  수령 3일 전까지 날짜 변경 가능  " }, { name: "아메리카노" }];
  assert.equal(M.needsPolicy([{ name: "아메리카노", qty: 1 }], menu, "none"), false, "커피 한 잔에 환불 약속을 묻지 않는다");
  assert.equal(M.needsPolicy([{ name: "샤인머스캣", qty: 1 }], menu, "none"), true);
  assert.equal(M.needsPolicy([{ name: "아메리카노", qty: 1 }], menu, 1_793_000_000), true, "시각 예약");
  assert.deepEqual([...M.shopPolicyNotes([{ name: "샤인머스캣", qty: 1 }], menu)], ["수령 3일 전까지 날짜 변경 가능"]);
});

test("대기 신청: 못 물어봤다고 지우지 않는다", () => {
  assert.equal(M.waitFate(404), "gone");
  assert.equal(M.waitFate(200), "ok");
  assert.equal(M.waitFate(502), "unreachable");
  assert.equal(M.waitFate(530), "unreachable");
});

test("화면: 결제 전 약속이 주문 만들기보다 먼저, 환불·취소 신청 단추 없음, 꺼짐 안내", () => {
  const main = HTML.slice(HTML.indexOf('$("order").onclick'));
  const ask = main.indexOf("askPolicy(chosen)");
  const post = main.indexOf('fetch("/api/order"');
  assert.ok(ask > 0 && post > 0 && ask < post, "[확인했어요] 가 /api/order 보다 먼저여야 한다");
  for (const bad of ["환불 신청", "취소 신청", "data-refund"]) assert.ok(!HTML.includes(bad), `${bad} 단추가 있다`);
  assert.ok(HTML.includes("function showOffline"), "꺼짐 안내가 없다");
  assert.ok(/if \(!res\.ok\) throw/.test(HTML), "터널 오류(502·530)를 꺼짐으로 보지 않는다");
  assert.ok(!HTML.includes("rvn.ex.erci.se/og-raven.png"), "미리보기 그림이 남의 서버");
  assert.ok(HTML.includes("<!--og-->") && HTML.includes("<!--/og-->"), "미리보기 자리표시");
});
