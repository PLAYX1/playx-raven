/**
 * 11-11 라비 카드 — 데스크탑 홈 맨 위, 잔액 위에 최대 3장(라비 중심 홈 2단계 · 폰은 phone/screens/ravi-cards.ts).
 * 「오늘 무엇을 보면 되는지」를 이 컴퓨터가 이미 읽은 값만으로 고른다(새로 묻지 않는다 — 홈 주기가 모은 값을 다시 읽을 뿐).
 *
 * 지키는 규칙 (scripts/ravi-cards.test.mjs 가 강제):
 * 1. 어떤 카드도 돈·자산·쪽지를 남에게 보내지 않는다. 단추는 화면을 「여는」 것뿐(OPEN_TARGETS 안의 이름 하나).
 *    폰 요청 카드도 승인 화면을 열 뿐, 승인은 사람이 그 화면에서 한다.
 * 2. 쪽지·글은 개수만. 본문·보낸 사람 이름을 싣지 않는다.
 * 3. 카드마다 출처와 시각(「노드 기준 14:02」).
 * 4. 「라비 도움」 이름 금지, 돈을 떼어 가는 듯한 낱말 금지(CARD_BANNED_WORDS).
 * 5. 빈 상태 = 「오늘은 조용해요 · 노드 기준 HH:MM」. AI 열쇠를 넣으라는 말을 빈 상태로 쓰지 않는다.
 *
 * 순서: 1 들어오는 돈 · 2 새 주문 · 3 사람 확인을 기다리는 것(폰 요청) · 4 문제(백업·잠금·꺼진 매장·본점으로 못 보냄)
 * · 5 새 글 수 · 6 다음 할 일.
 */
import { t, tf, setCopyText } from "./i18n";
import { DICT } from "./dict";

export const OPEN_TARGETS = ["activity", "shop-orders", "phone-requests", "backup", "lock", "chain", "talk", "receive"] as const;
export type CardOpen = typeof OPEN_TARGETS[number];
export type CardKind = "money" | "order" | "prepared" | "problem" | "message" | "next";
export type CardSource = "node" | "shop" | "phone" | "device" | "chain" | "talk";
export type Card = { id: string; kind: CardKind; text: string; values: readonly (string | number)[]; source: CardSource; at: number | null; action: { label: string; opens: CardOpen } };

export const CARD_COPY = {
  money: "{0} 들어오는 중이에요. 블록에 들어가면 잔액에 더해져요.",
  order: "새 주문 {0}건",
  prepared: "폰에서 온 요청 {0}건 · 여기서 확인해 주세요",
  backup: "백업을 확인해 주세요",
  lockNone: "지갑에 잠금 암호가 없어요",
  storesOff: "매장 {0}곳 꺼짐 · 30분째 매출이 오지 않아요",
  headFail: "본점으로 매출을 보내지 못하고 있어요",
  message: "이야기에 새 글 {0}개",
  firstReceive: "아직 받은 돈이 없어요. 받기를 누르면 주소와 QR이 나와요.",
  empty: "오늘은 조용해요 · 노드 기준 {0}",
  emptyUnknown: "오늘은 조용해요 · 노드 확인 전",
} as const;
export const ACTION_COPY = {
  activity: "기록 보기", "shop-orders": "주문 보러 가기", "phone-requests": "요청 보기", backup: "백업 확인", lock: "잠금 설정",
  chain: "매장 보기", talk: "이야기 열기", receive: "받기 화면 열기",
} as const satisfies Record<CardOpen, string>;
export const SOURCE_COPY = {
  node: "노드 기준 {0}", shop: "가게 기준 {0}", phone: "폰 연결 기준 {0}", device: "이 컴퓨터 기준 {0}", chain: "체인 매장 기준 {0}", talk: "이야기 기준 {0}",
} as const satisfies Record<CardSource, string>;
export const CARD_BANNED_WORDS = ["라비 도움", "수수료", "중개료", "후원", "기부", "AI 열쇠"] as const;
export const MAX_CARDS = 3;

/** 홈 주기가 채우는 값(모르면 null — 모르는 것을 좋은 상태로 짐작하지 않는다). */
export type CardsInput = {
  /** 확인 전 들어오는 RVN(wallet_balance.unconfirmed). */
  incoming: number | null;
  confirmed: number | null;
  /** 최근 거래가 하나라도 있었나(첫 받기 안내용). null = 모름. */
  anyTx: boolean | null;
  nodeAt: number | null;
  newOrders: number; ordersAt: number | null;
  phoneWaiting: number; phoneAt: number | null;
  backupTone: "good" | "warn" | "bad" | null; lockNone: boolean; safetyAt: number | null;
  storesOff: number; headFail: boolean; chainAt: number | null;
  talkNew: number; talkAt: number | null;
  /** 금액 글(화면은 fmtRvn, 시험은 같은 꼴의 함수). */
  rvn: (n: number) => string;
};

const card = (id: string, kind: CardKind, text: string, values: readonly (string | number)[], source: CardSource, at: number | null, opens: CardOpen): Card =>
  ({ id, kind, text, values, source, at, action: { label: ACTION_COPY[opens], opens } });

export function allCards(i: CardsInput): Card[] {
  const out: Card[] = [];
  if (i.incoming !== null && Number.isFinite(i.incoming) && i.incoming > 0) out.push(card("money", "money", CARD_COPY.money, [i.rvn(i.incoming)], "node", i.nodeAt, "activity"));
  if (i.newOrders > 0) out.push(card("order", "order", CARD_COPY.order, [Math.floor(i.newOrders)], "shop", i.ordersAt, "shop-orders"));
  if (i.phoneWaiting > 0) out.push(card("prepared", "prepared", CARD_COPY.prepared, [Math.floor(i.phoneWaiting)], "phone", i.phoneAt, "phone-requests"));
  if (i.lockNone) out.push(card("lock", "problem", CARD_COPY.lockNone, [], "device", i.safetyAt, "lock"));
  if (i.backupTone === "bad") out.push(card("backup", "problem", CARD_COPY.backup, [], "device", i.safetyAt, "backup"));
  if (i.storesOff > 0) out.push(card("stores-off", "problem", CARD_COPY.storesOff, [Math.floor(i.storesOff)], "chain", i.chainAt, "chain"));
  if (i.headFail) out.push(card("head-fail", "problem", CARD_COPY.headFail, [], "chain", i.chainAt, "chain"));
  if (i.talkNew > 0) out.push(card("message", "message", CARD_COPY.message, [Math.floor(i.talkNew)], "talk", i.talkAt, "talk"));
  if (i.confirmed === 0 && i.anyTx === false && !(i.incoming && i.incoming > 0)) out.push(card("first-receive", "next", CARD_COPY.firstReceive, [], "node", i.nodeAt, "receive"));
  return out;
}
export const cards = (i: CardsInput): Card[] => allCards(i).slice(0, MAX_CARDS);

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** 영어·일본어·중국어(같은 한국어가 이미 사전에 있으면 그것이 이긴다). */
const COPY: Record<string, [string, string, string]> = {
  [CARD_COPY.money]: ["{0} is on its way. It joins your balance once it is in a block.", "{0} が入金中です。ブロックに入ると残高に加わります。", "{0} 正在到账。进入区块后会计入余额。"],
  [CARD_COPY.order]: ["{0} new orders", "新しい注文 {0}件", "新订单 {0} 个"],
  [CARD_COPY.prepared]: ["{0} requests from your phone · please check them here", "スマホからの要求 {0}件 · ここで確認してください", "来自手机的请求 {0} 个 · 请在这里确认"],
  [CARD_COPY.backup]: ["Please check your backup", "バックアップを確認してください", "请检查备份"],
  [CARD_COPY.lockNone]: ["Your wallet has no lock password", "ウォレットにロックのパスワードがありません", "钱包没有锁定密码"],
  [CARD_COPY.storesOff]: ["{0} stores offline · no sales for 30 minutes", "店舗 {0}か所がオフライン · 30分間売上が届いていません", "{0} 家门店离线 · 30 分钟没有收到营业额"],
  [CARD_COPY.headFail]: ["Sales are not reaching head office", "本店へ売上を送れていません", "营业额无法发送到总店"],
  [CARD_COPY.message]: ["{0} new posts in Talk", "トークに新しい投稿 {0}件", "聊天里有 {0} 条新消息"],
  [CARD_COPY.firstReceive]: ["No money received yet. Press Receive to see your address and QR.", "まだ受け取ったお金はありません。受け取るを押すとアドレスとQRが出ます。", "还没有收到钱。按“收款”会显示地址和二维码。"],
  [CARD_COPY.empty]: ["All quiet today · node at {0}", "今日は静かです · ノード基準 {0}", "今天很安静 · 节点 {0}"],
  [CARD_COPY.emptyUnknown]: ["All quiet today · node not checked yet", "今日は静かです · ノード確認前", "今天很安静 · 节点尚未确认"],
  "기록 보기": ["View history", "記録を見る", "查看记录"], "주문 보러 가기": ["Go to orders", "注文を見る", "查看订单"],
  "요청 보기": ["View requests", "要求を見る", "查看请求"], "백업 확인": ["Check backup", "バックアップ確認", "检查备份"],
  "잠금 설정": ["Set lock", "ロック設定", "设置锁定"], "매장 보기": ["View stores", "店舗を見る", "查看门店"],
  "이야기 열기": ["Open Talk", "トークを開く", "打开聊天"], "받기 화면 열기": ["Open Receive", "受け取る画面を開く", "打开收款"],
  "노드 기준 {0}": ["node at {0}", "ノード基準 {0}", "节点 {0}"], "가게 기준 {0}": ["shop at {0}", "お店基準 {0}", "店铺 {0}"],
  "폰 연결 기준 {0}": ["phone link at {0}", "スマホ連携基準 {0}", "手机连接 {0}"], "이 컴퓨터 기준 {0}": ["this computer at {0}", "このコンピューター基準 {0}", "本电脑 {0}"],
  "체인 매장 기준 {0}": ["chain stores at {0}", "チェーン店舗基準 {0}", "连锁门店 {0}"], "이야기 기준 {0}": ["Talk at {0}", "トーク基準 {0}", "聊天 {0}"],
  "오늘 볼 것": ["To look at today", "今日見るもの", "今天要看的"],
};
for (const [source, values] of Object.entries(COPY)) (["en", "ja", "zh"] as const).forEach((lang, n) => { (DICT[lang] ??= {})[source] ??= values[n]; });

/** 카드 칸을 그린다. 같은 카드 묶음이면 다시 그리지 않는다(깜빡임·읽기 위치 지키기). */
export function paintCards(host: HTMLElement, input: CardsInput, open: (target: CardOpen) => void): void {
  const list = cards(input);
  const key = JSON.stringify(list.map(c => [c.id, c.values, c.at])) + "|" + input.nodeAt;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren();
  if (!list.length) {
    const p = document.createElement("p"); p.className = "rv-cards-empty";
    setCopyText(p, () => input.nodeAt ? tf(CARD_COPY.empty, hhmm(input.nodeAt)) : t(CARD_COPY.emptyUnknown));
    host.append(p); return;
  }
  for (const c of list) {
    const box = document.createElement("div"); box.className = "rv-card"; box.dataset.kind = c.kind; box.dataset.id = c.id;
    const text = document.createElement("b"); setCopyText(text, () => tf(c.text, ...c.values));
    const foot = document.createElement("div"); foot.className = "rv-card-foot";
    const src = document.createElement("span"); src.className = "rv-card-src";
    setCopyText(src, () => c.at ? tf(SOURCE_COPY[c.source], hhmm(c.at)) : "");
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "ghost";
    setCopyText(btn, () => t(c.action.label) + " ›");
    btn.onclick = () => open(c.action.opens);
    foot.append(src, btn); box.append(text, foot); host.append(box);
  }
}
