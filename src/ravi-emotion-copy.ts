/* 라비 감정 문구 — 열쇠는 한국어 원문(i18n.ts 방식). [영어, 일본어, 중국어].
 *
 * 말투: 라비(여자아이·1살 레이븐)의 해요체. 짧고 쉬운 말. 돈·보안 안내는 들뜨지 않게(느낌표 없음).
 * 금지: 구매·송금 재촉(「지금」「놓치」「서두르」), 죄책감(「외로웠어요」「왜 안 왔어요」), 금액·크기 단서.
 * 유럽어 확장: 문장을 한 줄 꽉 채우지 않는다(독일어·러시아어는 영어보다 30~40% 길다 — 말풍선은 두 줄까지 감싼다).
 *
 * 사전 연결: 이 파일을 불러오면 DICT 에 「없는 것만」 채운다(같은 한국어가 이미 있으면 기존 번역이 이긴다).
 * 그래서 dict.ts 는 고치지 않는다.
 */
import { DICT } from "./dict";
import { packText } from "./i18n-pack";

export const RAVI_EMOTION_COPY: Record<string, [string, string, string]> = {
  // 말풍선
  "들어오는 게 보여요. 확인되면 알려 드릴게요.": ["I can see something coming in. I’ll tell you once it’s confirmed.", "入金が見えます。確認できたらお知らせします。", "看到有款项进来了。确认后我会告诉你。"],
  "들어오는 게 {0}건 보여요. 확인되면 알려 드릴게요.": ["I can see {0} coming in. I’ll tell you once they’re confirmed.", "入金が{0}件見えます。確認できたらお知らせします。", "看到有 {0} 笔款项进来。确认后我会告诉你。"],
  "입금이 확인됐어요.": ["The deposit is confirmed.", "入金が確認されました。", "入账已确认。"],
  "입금 {0}건이 확인됐어요.": ["{0} deposits are confirmed.", "入金{0}件が確認されました。", "已确认 {0} 笔入账。"],
  "확인 전 입금이 사라졌어요. 상품을 보내기 전에 기록을 확인해 주세요.": ["An unconfirmed deposit disappeared. Please check the history before sending any goods.", "未確認の入金が消えました。商品を送る前に履歴を確認してください。", "一笔未确认的入账消失了。发货前请先查看记录。"],
  "새 주문이 들어왔어요.": ["A new order came in.", "新しい注文が入りました。", "来了一个新订单。"],
  "새 주문이 {0}건 들어왔어요.": ["{0} new orders came in.", "新しい注文が{0}件入りました。", "来了 {0} 个新订单。"],
  "판매가 확인됐어요.": ["The sale is confirmed.", "販売が確認されました。", "销售已确认。"],
  "판매 {0}건이 확인됐어요.": ["{0} sales are confirmed.", "販売{0}件が確認されました。", "已确认 {0} 笔销售。"],
  "첫 입금이 확인됐어요! 함께 시작해요.": ["Your first deposit is confirmed! Let’s get started together.", "初めての入金が確認されました！一緒に始めましょう。", "第一笔入账已确认！我们一起开始吧。"],
  "첫 판매예요! 축하해요.": ["Your first sale! Congratulations.", "初めての販売です！おめでとうございます。", "第一笔销售！恭喜你。"],
  "판매가 또 한 고개를 넘었어요. 축하해요!": ["Your sales passed another milestone. Congratulations!", "販売がまたひとつ節目を越えました。おめでとうございます！", "销售又迈过了一个里程碑。恭喜你！"],
  "좋은 소식이 확인됐어요.": ["Some good news is confirmed.", "うれしい知らせが確認されました。", "有好消息已确认。"],
  "가게를 아껴 주는 분이 생겼어요.": ["Someone new is following your shop.", "お店を気にかけてくれる人が増えました。", "有新朋友关注了你的店。"],
  "가게를 아껴 주는 분이 {0}명 생겼어요.": ["{0} new people are following your shop.", "お店を気にかけてくれる人が{0}人増えました。", "有 {0} 位新朋友关注了你的店。"],
  "헤헤, 저도 고마워요.": ["Hehe, thank you too.", "えへへ、わたしもありがとう。", "嘿嘿，我也谢谢你。"],
  "장부를 따라잡고 있어요.": ["I’m catching up with the ledger.", "台帳に追いついているところです。", "正在同步账本。"],
  "장부를 다 따라잡았어요.": ["I’ve caught up with the ledger.", "台帳に追いつきました。", "账本已同步完成。"],
  "노드가 응답하지 않아요. 입금 확인이 늦어질 수 있어요.": ["The node isn’t responding. Deposit checks may be delayed.", "ノードが応答していません。入金の確認が遅れることがあります。", "节点没有响应。入账确认可能会延迟。"],
  "네트워크 연결이 끊겼어요. 입금 확인이 늦어질 수 있어요.": ["The network connection dropped. Deposit checks may be delayed.", "ネットワーク接続が切れました。入金の確認が遅れることがあります。", "网络连接已断开。入账确认可能会延迟。"],
  "장부 따라잡기가 멈췄어요. 잠시 기다리거나 노드를 다시 켜 주세요.": ["Ledger sync has stopped. Please wait a moment or restart the node.", "台帳の同期が止まりました。少し待つか、ノードを再起動してください。", "账本同步已停止。请稍等，或重新启动节点。"],
  "확인이 평소보다 늦어요. 확인될 때까지 상품은 기다려 주세요.": ["Confirmation is slower than usual. Please hold the goods until it’s confirmed.", "確認がいつもより遅れています。確認されるまで商品はお待ちください。", "确认比平时慢。确认之前请先不要发货。"],
  "다시 정상이에요.": ["Everything is back to normal.", "正常に戻りました。", "已恢复正常。"],
  "컴퓨터가 잠들면 입금 확인이 멈춰요. 잠들지 않게 설정해 주세요.": ["If the computer sleeps, deposit checks stop. Please keep it from sleeping.", "パソコンがスリープすると入金の確認が止まります。スリープしないよう設定してください。", "电脑休眠时入账确认会停止。请设置为不休眠。"],
  "보내기 전에 주소와 금액을 한 번 더 확인해 주세요.": ["Before sending, please check the address and amount once more.", "送る前に、アドレスと金額をもう一度確認してください。", "发送前请再核对一次地址和金额。"],
  "이대로는 보낼 수 없어요. 표시된 칸을 확인해 주세요.": ["This can’t be sent as is. Please check the marked fields.", "このままでは送れません。表示された欄を確認してください。", "目前无法发送。请检查标出的栏位。"],
  "주소가 원본과 달라요. 보내지 마세요.": ["The address doesn’t match the original. Do not send.", "アドレスが元と違います。送らないでください。", "地址与原地址不一致。请不要发送。"],
  "보냈어요. 기록에서 확인할 수 있어요.": ["Sent. You can check it in the history.", "送りました。履歴で確認できます。", "已发送。可以在记录中查看。"],
  "구매를 마쳤어요. 라이브러리에서 볼 수 있어요.": ["Purchase complete. You can find it in your library.", "購入が完了しました。ライブラリで見られます。", "购买完成。可以在资料库中查看。"],
  "미안해요, 잘 안 됐어요. 잠시 뒤 다시 해 주세요.": ["Sorry, that didn’t work. Please try again in a moment.", "ごめんなさい、うまくいきませんでした。少ししてからもう一度お試しください。", "抱歉，没有成功。请稍后再试。"],
  "미안해요, 연결이 불안정해요. 인터넷을 확인한 뒤 다시 해 주세요.": ["Sorry, the connection is unstable. Please check your internet and try again.", "ごめんなさい、接続が不安定です。インターネットを確認してからもう一度お試しください。", "抱歉，连接不稳定。请检查网络后再试。"],
  "다시 만나서 반가워요.": ["Good to see you again.", "また会えてうれしいです。", "很高兴再见到你。"],
  "그건 잘 모르겠어요. 모르는 건 지어내지 않을게요.": ["I’m not sure about that. I won’t make things up.", "それはよくわかりません。わからないことは作り話しません。", "这个我不太清楚。不知道的我不会乱编。"],
  "AI 열쇠를 넣어 주시면 대화할 수 있어요.": ["Add an AI key and we can talk.", "AIキーを入れてくだされば、お話しできます。", "添加 AI 密钥后就可以聊天了。"],
  "연결됐어요! 무엇이든 물어보세요.": ["Connected! Ask me anything.", "つながりました！何でも聞いてください。", "连接好了！尽管问我吧。"],
  "백업을 마쳤어요. 백업 파일은 안전한 곳에 두세요.": ["Backup finished. Keep the backup file somewhere safe.", "バックアップが終わりました。バックアップファイルは安全な場所に保管してください。", "备份完成。请把备份文件放在安全的地方。"],
  "지갑을 잠갔어요.": ["The wallet is locked.", "ウォレットをロックしました。", "钱包已锁定。"],
  // 화면 낭독용 상태
  "라비가 기뻐해요": ["Ravi is happy", "ラビがうれしそうです", "拉比很开心"],
  "라비가 크게 기뻐해요": ["Ravi is overjoyed", "ラビがとても喜んでいます", "拉比非常开心"],
  "라비가 좋아해요": ["Ravi is delighted", "ラビが喜んでいます", "拉比很喜欢"],
  "라비가 눈을 크게 떴어요": ["Ravi’s eyes went wide", "ラビが目を丸くしています", "拉比睁大了眼睛"],
  "라비가 집중하고 있어요": ["Ravi is concentrating", "ラビが集中しています", "拉比正在专注"],
  "라비가 생각하고 있어요": ["Ravi is thinking", "ラビが考えています", "拉比正在思考"],
  "라비가 걱정해요": ["Ravi is concerned", "ラビが心配しています", "拉比有点担心"],
  "라비가 차분히 지켜봐요": ["Ravi is calmly watching", "ラビが落ち着いて見守っています", "拉比在冷静地看着"],
  "라비가 미안해해요": ["Ravi is sorry", "ラビが申し訳なさそうです", "拉比很抱歉"],
  "라비가 졸려요": ["Ravi is sleepy", "ラビが眠そうです", "拉比困了"],
  "라비가 자고 있어요": ["Ravi is asleep", "ラビが眠っています", "拉比睡着了"],
  "라비가 반가워해요": ["Ravi is glad to see you", "ラビが喜んで迎えています", "拉比很高兴见到你"],
  "라비가 기다리고 있어요": ["Ravi is waiting", "ラビが待っています", "拉比在等待"],
  "라비가 곤란해해요": ["Ravi is unsure", "ラビが困っています", "拉比有点为难"],
  "라비가 수줍어해요": ["Ravi is a little shy", "ラビが照れています", "拉比有点害羞"],
  "라비가 뿌듯해해요": ["Ravi is proud", "ラビが誇らしげです", "拉比很自豪"],
  "라비가 안심했어요": ["Ravi is relieved", "ラビがほっとしています", "拉比松了一口气"],
  "라비의 한마디": ["A word from Ravi", "ラビのひとこと", "拉比的一句话"],
};

// 없는 것만 채운다 — 기존 번역(예: 「라비」)을 덮지 않는다.
for (const [source, values] of Object.entries(RAVI_EMOTION_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language] ??= {}; DICT[language][source] ??= values[index]; });
}

const INDEX = { en: 0, ja: 1, zh: 2 } as const;

/** 언어 코드(ko·en·ja·zh·en-US…)로 한 마디를 옮긴다. 없으면 한국어 원문. {0} 은 건수. */
export function emotionText(source: string, locale: string, ...values: number[]): string {
  const code = locale.slice(0, 2).toLowerCase();
  const own = packText(locale === "pt" ? "pt-BR" : locale, source) ?? packText(code, source); // 유럽어 사전(지연 로드)
  const row = RAVI_EMOTION_COPY[source];
  // 사전에 없는 언어(독일어 등)는 한국어가 아니라 영어 — i18n.ts pick() 과 같은 이유.
  const translated = code === "ko" || !row ? source : own ?? row[(INDEX as Record<string, number>)[code] ?? 0];
  const template = values.every((_, i) => translated.includes(`{${i}}`)) ? translated : source;
  return template.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)] ?? ""));
}
