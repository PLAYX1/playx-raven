/**
 * 질문이 사용자 자신의 데이터(잔액·거래·매출·주문 …)를 필요로 하는가 — 순수 함수.
 * 「몇살이야?」 같은 일반 질문에는 정보 선택 동의 카드를 붙이지 않기 위한 판정이다.
 * 확실하지 않으면 false(카드 없음): 설정 카드로 언제든 바꿀 수 있다.
 */
const KEYWORDS: readonly string[] = [
  // ko
  "잔액", "잔고", "거래", "내역", "매출", "주문", "개발비", "얼마", "수입", "수익", "정산", "가게", "내 지갑", "내지갑", "내 코인", "얼마나 갖", "보유",
  // en
  "balance", "transaction", "my wallet", "my shop", "my store", "sales", "order", "revenue", "income", "earnings", "how much do i", "how many rvn do i",
  // ja
  "残高", "取引", "履歴", "売上", "注文", "収入", "お店", "いくら", "マイウォレット", "私のウォレット",
  // zh
  "余额", "餘額", "交易", "记录", "記錄", "销售", "銷售", "订单", "訂單", "收入", "店铺", "店鋪", "多少钱", "我的钱包",
  // it
  "saldo", "transazion", "vendite", "ordin", "negozio", "il mio portafoglio", "quanto ho", "entrate",
  // es
  "saldo", "transacci", "ventas", "pedido", "tienda", "mi billetera", "mi cartera", "cuánto tengo", "cuanto tengo", "ingresos",
  // fr
  "solde", "transaction", "ventes", "commande", "boutique", "magasin", "mon portefeuille", "combien ai-je", "combien j'ai", "revenus",
  // pt-BR
  "saldo", "transaç", "transac", "vendas", "pedido", "loja", "minha carteira", "quanto tenho", "receita",
  // de
  "kontostand", "guthaben", "transaktion", "umsatz", "verkäufe", "bestellung", "mein geschäft", "mein shop", "meine wallet", "wie viel habe ich", "einnahmen",
  // ru
  "баланс", "остаток", "транзакц", "операци", "продаж", "выручк", "заказ", "магазин", "мой кошел", "мой кошёл", "сколько у меня", "доход",
];

export function questionNeedsPersonalData(question: string): boolean {
  const q = String(question || "").normalize("NFKC").toLowerCase();
  if (!q.trim()) return false;
  return KEYWORDS.some(k => q.includes(k));
}
