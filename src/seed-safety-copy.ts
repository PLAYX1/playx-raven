/* 0.9.60 복구 단어 안전 — 보내기 전 유출 경고 · 받는 쪽 한 줄 · 지갑 「만든 곳」 줄.
 * 열쇠는 한국어 원문, 값은 [영어, 일본어, 중국어]. 유럽어 여섯은 보안 문구라 검수 합의 전까지 영어로 내려간다
 * (scripts/i18n/build-packs.mjs 규칙 2). 폰·웹(~/wt-rv-060-site)과 같은 뜻의 문장이다. */
export const SEED_SAFETY_COPY: Record<string, [string, string, string]> = {
  "복구 단어처럼 보여요": ["This looks like recovery words", "復元ワードのように見えます", "这看起来像恢复词"],
  "레이븐볼트는 누구에게도 복구 단어를 묻지 않습니다. 그래도 보낼까요?": [
    "RavenVault never asks anyone for recovery words. Send it anyway?",
    "RavenVaultが復元ワードを誰かに尋ねることはありません。それでも送りますか？",
    "RavenVault 从不向任何人索要恢复词。仍要发送吗？",
  ],
  "라비에게 보낸 글은 AI 회사로 나갈 수 있어요. 복구 단어를 아는 사람은 지갑의 돈을 모두 가져갈 수 있어요.": [
    "What you send to Ravi can go to an AI company. Anyone who knows your recovery words can take all the money in your wallet.",
    "ラビに送った文はAI企業に送られることがあります。復元ワードを知っている人は、ウォレットのお金をすべて持ち出せます。",
    "发给拉比的内容可能会传到 AI 公司。知道你恢复词的人可以拿走钱包里的全部钱。",
  ],
  "보내지 않기": ["Don't send", "送らない", "不发送"],
  "그래도 보내기": ["Send anyway", "それでも送る", "仍然发送"],
  "그래도 보내기 ({0})": ["Send anyway ({0})", "それでも送る（{0}）", "仍然发送（{0}）"],
  "레이븐볼트는 복구 단어나 비밀번호를 절대 묻지 않습니다": [
    "RavenVault will never ask for your recovery words or password",
    "RavenVaultが復元ワードやパスワードを尋ねることは絶対にありません",
    "RavenVault 绝不会索要你的恢复词或密码",
  ],
  "만든 곳: 이 컴퓨터 노드 v{0} · 앱 {1} · {2}": [
    "Made on: this computer's node v{0} · app {1} · {2}",
    "作成元：このパソコンのノード v{0} · アプリ {1} · {2}",
    "创建于：本电脑节点 v{0} · 应用 {1} · {2}",
  ],
  "만든 곳: 이 컴퓨터 노드 · 앱 {0} · {1}": [
    "Made on: this computer's node · app {0} · {1}",
    "作成元：このパソコンのノード · アプリ {0} · {1}",
    "创建于：本电脑节点 · 应用 {0} · {1}",
  ],
  "만든 곳: 복구 단어로 되살림 · 앱 {0} · {1}": [
    "Made on: restored from recovery words · app {0} · {1}",
    "作成元：復元ワードから復元 · アプリ {0} · {1}",
    "创建于：用恢复词恢复 · 应用 {0} · {1}",
  ],
  "만든 곳: 기록 없음 · 이 기능 전부터 있던 지갑": [
    "Made on: no record · this wallet existed before this feature",
    "作成元：記録なし · この機能より前からあるウォレット",
    "创建于：无记录 · 此功能之前就有的钱包",
  ],
};
