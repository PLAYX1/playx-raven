// 라비 「키 없이 바로 답」 말 알아듣기 표 — 실행: npx tsx scripts/ravi-instant.test.ts
// 말 → 할 일(+칸). null = 짐작하지 않고 기존 길(정해 둔 안내 / 키 있으면 AI)로 보낸다.
import assert from "node:assert/strict";
import { raviSettingIntent } from "../src/ravi-settings";
import { raviFixedAddressIntent } from "../src/tailscale-fixed";
import { raviShopLinkTellIntent } from "../src/shop-link";
import { raviTalkIntent } from "../src/ravi-talk-intents";
import { raviInstantIntent, payeeExact, instantFallbackHtml, weekStartYmd, INSTANT_COPY_EN, instantCopy } from "../src/ravi-instant";

type Row = [string, Record<string, unknown> | null];
const B = { kind: "balance" }, R = { kind: "receive" }, O = { kind: "orders" }, M = { kind: "messages" };
const open = (page: string) => ({ kind: "open", page });
const sales = (period: "today" | "week") => ({ kind: "sales", period });
const send = (to: string, amount: number | null) => ({ kind: "send", to, amount });

const TABLE: Row[] = [
  // 잔액
  ["내 돈 얼마야", B], ["잔액", B], ["RVN 얼마 있어", B], ["잔액 얼마야?", B], ["내 잔액 알려줘", B],
  ["지갑에 얼마 있어?", B], ["코인 몇 개 있어", B], ["잔약 얼마", B], ["잔고 확인", B], ["라비야 내 돈 얼마 남았어", B],
  ["balance", B], ["what's my balance", B], ["how much rvn do i have", B], ["How much money do I have?", B],
  // 잔액 — 남의 것·시세는 아니다
  ["철수 잔액 얼마야", null], ["친구 지갑에 얼마 있어?", null], ["엄마 돈 얼마 있어", null], ["철수의 잔액 알려줘", null],
  ["john's balance", null], ["RVN 얼마야", null], ["RVN 시세 얼마야", null], ["제가 얼마 내야 해요?", null],
  // 매출
  ["오늘 매출", sales("today")], ["오늘 매출 얼마야", sales("today")], ["이번 주 매출", sales("week")], ["이번주 매출 알려줘", sales("week")],
  ["오늘 얼마 벌었어?", sales("today")], ["오늘 장사 어땠어", sales("today")], ["매츨", sales("today")], ["today's sales", sales("today")],
  ["sales this week", sales("week")], ["어제 매출", null], ["지난달 매출", null], ["매출 늘리는 방법", null], ["매출 엑셀로 내보내줘", null], ["옆가게 매출 얼마야", null],
  // 새 주문
  ["새 주문 있어?", O], ["주문 들어왔어?", O], ["주문 몇 개야", O], ["new orders", O], ["any orders?", O],
  ["주문 링크 알려줘", null], ["주문 취소해 줘", null], ["메뉴에 주문 추가", null],
  // 안 읽은 쪽지
  ["안 읽은 쪽지", M], ["쪽지 왔어?", M], ["새 메시지 있어", M], ["안읽은 쪽찌 몇 개야", M], ["unread messages", M],
  ["쪽지 써 줘", null], ["철수한테 쪽지 보내 줘", null],
  // 화면 열기
  ["장터 열어 줘", open("trade")], ["장터", open("trade")], ["게임", open("games")], ["게임 하고 싶어", open("games")],
  ["설정", open("settings")], ["설정 열어", open("settings")], ["설쩡 화면", open("settings")], ["백업", open("backup")],
  ["백업 화면 보여줘", open("backup")], ["지갑 열어 줘", open("wallet")], ["내 자산 보여 줘", open("assets")], ["open market", open("trade")],
  ["open settings", open("settings")], ["게임 만들기", null], ["백업 어떻게 해?", null], ["지갑 설정", null], ["장터 열지 마", null], ["장터에 올리고 싶어", null],
  // 받기 주소
  ["받기 주소 보여 줘", R], ["내 주소 알려줘", R], ["입금 주소", R], ["받기", R], ["show my receive address", R], ["my address", R],
  ["가게 주소 알려줘", null], ["고정 주소 만들어 줘", null], ["철수 받는 주소", null], ["새 주소 만들어 줘", null],
  // 보내기 — 준비만
  ["철수에게 10 RVN 보내 줘", send("철수", 10)], ["철수한테 10RVN 보내줘", send("철수", 10)], ["김 철수님께 2.5 rvn 송금해 줘", send("김 철수", 2.5)],
  ["영희에게 1,000 RVN 보내주세요", send("영희", 1000)], ["엄마한테 돈 보내 줘", send("엄마", null)], ["보내기 열어 줘", send("", null)],
  ["철수에게 10만 원 보내 줘", send("철수", null)], ["send 10 rvn to chulsoo", send("chulsoo", 10)], ["send money to Mike please", send("Mike", null)],
  ["철수2에게 5 RVN 보내줘", send("철수2", 5)], ["철수에게 보네줘", send("철수", null)],
  ["보내지 마", null], ["철수에게 보내지 마", null], ["보낼까 말까", null], ["철수한테 안 보내도 돼", null], ["돈 보내는 법", null],
  ["어제 철수에게 보낸 거 취소", null], ["철수가 나한테 10 RVN 보냈어", null], ["나한테 보내 줘", null], ["얼마 보냈어?", null],
  ["RHnoAgentAddressTestxxxxxxxxxxxxxx 에게 5 RVN 보내줘", null], ["don't send anything", null], ["how do i send rvn", null],
  // 모르는 말·겹침
  ["오늘 날씨 어때", null], ["안녕", null], ["잔액이랑 매출 둘 다", null], ["", null],
];

let pass = 0;
const fails: string[] = [];
for (const [q, want] of TABLE) {
  const got = raviInstantIntent(q);
  try { assert.deepEqual(got === null ? null : JSON.parse(JSON.stringify(got)), want); pass++; }
  catch { fails.push(`${JSON.stringify(q)} → ${JSON.stringify(got)} (기대 ${JSON.stringify(want)})`); }
}
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
assert.ok(TABLE.length >= 40);
// main.ts 순서: 설정 → 고정 주소 → 가게 링크 → 이야기 → **바로 답**. 앞 길이 가로채지 않는지.
for (const [q, want] of TABLE) if (want) {
  assert.equal(raviSettingIntent(q), null, `설정이 가로챔: ${q}`);
  assert.equal(raviFixedAddressIntent(q), null, `고정 주소가 가로챔: ${q}`);
  assert.equal(raviShopLinkTellIntent(q), false, `가게 링크가 가로챔: ${q}`);
  assert.equal(raviTalkIntent(q), null, `이야기가 가로챔: ${q}`);
}

// 받을 사람은 글자가 **똑같을** 때만 — 비슷한 이름·같은 이름 두 주소는 비운다.
const book = [
  { address: "RAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "철수" },
  { address: "RBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "김 영희" },
  { address: "RCcccccccccccccccccccccccccccccccc", name: "민수" },
  { address: "RDdddddddddddddddddddddddddddddddd", name: "민수" },
];
assert.equal(payeeExact("철수", book)?.address, book[0].address);
assert.equal(payeeExact("김 철수", book)?.address, book[0].address, "뒤 낱말이 똑같으면");
assert.equal(payeeExact("김영희", book)?.address, book[1].address, "띄어쓰기만 다르면 같다");
assert.equal(payeeExact("철", book), null, "일부만 같으면 아니다");
assert.equal(payeeExact("철수씨", book), null);
assert.equal(payeeExact("민수", book), null, "같은 이름이 두 주소면 사람이 고른다");
assert.equal(payeeExact("", book), null);

// 모르는 말 → 바로 할 수 있는 일 5개 칩 + AI 키 한 줄(재촉 없이 한 줄).
const fb = instantFallbackHtml("오늘 날씨 어때", true);
assert.equal((fb.match(/data-ravi-ask=/g) || []).length, 5);
assert.ok(fb.includes("AI 키를 넣으면") && fb.includes('data-ravi-ask="오늘 매출 얼마야"'));
for (const m of fb.matchAll(/data-ravi-ask="([^"]+)"/g)) assert.ok(raviInstantIntent(m[1]), `칩 말도 바로 답한다: ${m[1]}`);
const fbEn = instantFallbackHtml("what is love", false);
assert.ok(fbEn.includes('data-ravi-language="en"') && fbEn.includes("With an AI key"));
for (const m of fbEn.matchAll(/data-ravi-ask="([^"]+)"/g)) assert.ok(raviInstantIntent(m[1]), `영어 칩: ${m[1]}`);
// 영어 문구 빠짐 없음 + escape.
assert.equal(instantCopy("ko")("「{0}」은(는) 내 받을 사람 목록에 없어 주소 칸을 비워 뒀어요.", "<b>"), "「&lt;b&gt;」은(는) 내 받을 사람 목록에 없어 주소 칸을 비워 뒀어요.");
assert.ok(Object.values(INSTANT_COPY_EN).every((v) => v && !/[가-힣]/.test(v)));
assert.equal(weekStartYmd(new Date(2026, 10, 25)), 20261123); // 수요일 → 그 주 월요일
assert.equal(weekStartYmd(new Date(2026, 10, 23)), 20261123);
assert.equal(weekStartYmd(new Date(2026, 10, 29)), 20261123); // 일요일
console.log(`ravi-instant: 말 ${pass}/${TABLE.length} 통과 · 받을 사람·칩·문구 통과`);
