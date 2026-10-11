/* 「체인 정보」(0.8.8a) 문구 — [영어, 일본어, 중국어]. 열쇠는 한국어 원문 그대로(i18n.ts 와 같은 방식).
 * 이미 사전에 있는 같은 한국어는 덮지 않는다(dict.ts 에서 ??= 로 넣는다).
 * 유럽어 여섯은 이 파일에 없다 → 영어로 내려간다. 새 문구 목록: docs/i18n-0.8.8a-chain-newstrings.json */
export const CHAIN_INFO_COPY: Record<string, [string, string, string]> = {
  "체인 정보": ["Chain info", "チェーン情報", "链信息"],
  "내 노드와 공개 목록에서 읽은 값이에요. 숫자마다 출처와 기준 시각을 같이 보여 드려요.": [
    "Values read from your own node and a public list. Every number shows its source and time.",
    "ご自身のノードと公開リストから読み取った値です。数字ごとに出典と基準時刻を表示します。",
    "这些数值来自你自己的节点和公开列表。每个数字都会显示来源和时间。"],
  "홈으로 돌아가기": ["Back to Home", "ホームに戻る", "返回首页"],
  "새로 읽기": ["Refresh", "再読み込み", "重新读取"],
  "블록 높이": ["Block height", "ブロック高", "区块高度"],
  "블록 {0}": ["Block {0}", "ブロック {0}", "区块 {0}"],
  "해시율 {0}": ["Hashrate {0}", "ハッシュレート {0}", "算力 {0}"],
  "보안 비용 {0}/시간": ["Security cost {0}/h", "セキュリティコスト {0}/時間", "安全成本 {0}/小时"],
  "네트워크 해시율": ["Network hashrate", "ネットワークのハッシュレート", "全网算力"],
  "채굴 컴퓨터들의 힘이에요. 내 노드가 계산해요.": [
    "The combined power of the mining computers. Your node calculates it.",
    "マイニングコンピュータ全体の力です。ご自身のノードが計算します。",
    "这是所有挖矿电脑的总算力，由你的节点计算。"],
  "난이도 {0}": ["Difficulty {0}", "難易度 {0}", "难度 {0}"],
  "대기 거래 {0}건": ["{0} pending transactions", "待機中の取引 {0}件", "待处理交易 {0} 笔"],
  "연결된 상대 {0}곳": ["{0} connected peers", "接続中のピア {0}件", "已连接节点 {0} 个"],
  "출처: 내 노드 · {0}": ["Source: your node · {0}", "出典: ご自身のノード · {0}", "来源：你的节点 · {0}"],
  "내 노드를 읽지 못했어요. 노드가 켜져 있는지 확인해 주세요.": [
    "Could not read your node. Please check that the node is running.",
    "ノードを読み取れませんでした。ノードが起動しているか確認してください。",
    "无法读取你的节点。请确认节点正在运行。"],
  "내 노드가 아직 따라잡는 중이에요 ({0}%). 끝나면 숫자가 정확해져요.": [
    "Your node is still catching up ({0}%). Numbers become accurate when it finishes.",
    "ノードはまだ追いついている途中です ({0}%)。完了すると数字が正確になります。",
    "你的节点仍在同步中（{0}%）。完成后数字才会准确。"],
  "따라잡는 중에는 해시율을 말씀드리지 않아요.": [
    "While the node is catching up, no hashrate is shown.",
    "追いついている間はハッシュレートを表示しません。",
    "节点同步期间不显示算力。"],
  "보안 비용 (51% 공격)": ["Security cost (51% attack)", "セキュリティコスト（51%攻撃）", "安全成本（51% 攻击）"],
  "{0} / 시간": ["{0} / hour", "{0} / 時間", "{0} / 小时"],
  "다른 사람이 채굴 힘을 한 시간 빌려 체인을 흔드는 데 드는 값을 어림한 거예요.": [
    "A rough estimate of what it would cost someone to rent mining power for one hour to disturb the chain.",
    "誰かがマイニングパワーを1時間借りてチェーンを揺さぶるのにかかる費用の目安です。",
    "这是他人租用一小时挖矿算力来扰乱链所需费用的粗略估算。"],
  "투자 조언이 아니에요. 어림값이라 실제와 다를 수 있어요.": [
    "This is not investment advice. It is an estimate and may differ from reality.",
    "投資のアドバイスではありません。目安の値で、実際とは異なる場合があります。",
    "这不是投资建议。这只是估算值，可能与实际不同。"],
  "목록 {1}개 코인 중 {0}위": ["{0} of {1} coins in the list", "リスト{1}コイン中 {0}位", "列表 {1} 个币种中第 {0} 名"],
  "빌릴 수 있는 힘 대비 네트워크 힘 {0}": ["Network power vs. rentable power: {0}", "レンタル可能な力に対するネットワークの力 {0}", "全网算力相对可租用算力：{0}"],
  "출처: crypto51.app · 기준 {0}": ["Source: crypto51.app · as of {0}", "出典: crypto51.app · 基準 {0}", "来源：crypto51.app · 截至 {0}"],
  "{0} 기준 값이에요. 갱신이 늦어지고 있어서 지금과 다를 수 있어요.": [
    "This value is as of {0}. Updates are late, so it may differ now.",
    "{0}時点の値です。更新が遅れているため、現在とは異なる場合があります。",
    "这是 {0} 的数值。更新有延迟，现在可能已经不同。"],
  "3일 넘게 갱신되지 않았어요. 숫자는 참고만 해 주세요.": [
    "Not updated for more than 3 days. Please treat the number as a reference only.",
    "3日以上更新されていません。数字は参考程度にしてください。",
    "已超过3天没有更新。数字仅供参考。"],
  "새로 받지 못해서 마지막으로 받은 값을 보여 드려요.": [
    "Could not refresh, so the last value received is shown.",
    "新しく取得できなかったため、最後に受け取った値を表示しています。",
    "未能刷新，因此显示的是最后收到的数值。"],
  "보안 비용을 계산하는 외부 정보를 지금은 읽을 수 없어요.": [
    "The outside information used to work out the security cost cannot be read right now.",
    "セキュリティコストを計算する外部情報を今は読み取れません。",
    "目前无法读取用于计算安全成本的外部信息。"],
  "방금": ["just now", "たった今", "刚刚"],
  "{0}일 전": ["{0} d ago", "{0}日前", "{0}天前"],
  "체인 정보 열기": ["Open chain info", "チェーン情報を開く", "打开链信息"],
  "읽는 중…": ["Reading…", "読み込み中…", "读取中…"],
};
