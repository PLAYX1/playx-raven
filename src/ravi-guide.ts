/* 라비 안내 — AI 열쇠가 없을 때 자주 묻는 것에 **정해 둔 답**으로 답한다(0.4.8-B · RV3 🔴7).
 *
 * ## 🔴 왜 생겼나
 *
 * 열쇠(각자 AI 회사에서 받는 API 키)가 없으면 라비는 무엇을 물어도 「열쇠를 넣어 주세요」만
 * 했다(RV3 T11: 「보낼 때 수수료가 얼마예요?」 → 답 대신 열쇠 요구). 처음 쓰는 사람이 제일
 * 먼저 묻는 것은 받기·보내기·수수료·복구 단어 같은 **정해진 답이 있는 것**이다.
 *
 * 대표 결정(2026-09-25): 무료 서버 AI 는 만들지 않는다 — 각자 열쇠를 넣는 방식 유지.
 * 열쇠가 없을 때는 **내장 안내로 답하되 AI 라고 속이지 않는다.** 답 머리에 늘
 * 「라비 안내 · AI 아님」을 단다(0.4.6 「이 주소 내 거야?」가 AI 없이 노드에 묻고
 * 「이 컴퓨터의 노드에 바로 물어봤어요」라고 적는 것과 같은 원칙).
 *
 * ## 말 맞추기는 낱말 규칙뿐
 *
 * 뜻을 짐작하지 않는다. 위에서부터 낱말이 맞는 첫 주제 하나. 맞는 게 없으면 「준비한 안내에
 * 없는 질문」이라고 그대로 말하고 자주 묻는 것 목록과 열쇠 넣는 곳을 보여 준다.
 * 🔴 과장 금지 — 답에 숫자를 넣을 때는 코드에 있는 값만(수수료는 「노드가 정함」).
 */

/** 답 아래 단추가 데려가는 곳. 실제 이동은 main.ts 가 한다. */
export type GuideGo =
  | "receive" | "send" | "wallet" | "txs" | "backup" | "create" | "assets" | "node" | "key";

export type GuideTopic = {
  id: string;
  /** 자주 묻는 것 목록에 적는 짧은 이름 */
  name: string;
  /** 이 주제로 볼 낱말(한국어 원문 + 화면을 영·일·중으로 쓰는 사람의 말) */
  words: RegExp;
  /** 답 — 한 줄씩. 한국어 원문이 번역 열쇠다(desktop-copy.ts). */
  lines: string[];
  go: { label: string; to: GuideGo }[];
};

/** 🔴 순서가 곧 우선순위다. 「보낸 거 취소 돼?」는 보내기가 아니라 취소, 「보낼 때 수수료」는 수수료. */
export const GUIDE: GuideTopic[] = [
  {
    id: "undo", name: "보낸 것 취소",
    words: /취소|되돌|돌려\s*받|잘못\s*보|환불|cancel|undo|revers|refund|取り消|キャンセル|撤销|撤回|取消|退回/i,
    lines: [
      "아니요. 한 번 보낸 것은 누구도 되돌릴 수 없어요 — 이 앱도, 레이븐코인도요.",
      "그래서 보내기 전에 확인 화면에서 받는 사람과 금액을 한 번 더 보여 드려요. 잘못 보냈다면 받은 분께 돌려 달라고 부탁하는 길뿐이에요.",
    ],
    go: [{ label: "최근 거래 보기", to: "txs" }],
  },
  {
    id: "fee", name: "수수료",
    words: /수수료|\bfees?\b|手数料|手续费|費用|费用/i,
    lines: [
      "보낼 때 수수료는 노드가 정해요 — 보통 0.01 RVN 안팎이에요.",
      "보내기 확인 화면에서 이번 수수료와 내 지갑에서 나가는 합계를 먼저 보여 드려요. 받는 분은 적은 금액을 그대로 받아요.",
    ],
    go: [{ label: "보내기 열기", to: "send" }],
  },
  {
    id: "seed", name: "복구 단어",
    words: /복구\s*단어|12\s*단어|열두\s*단어|시드|니모닉|\bseed\b|recovery\s*(word|phrase)|mnemonic|復元|シード|助记词|恢复词|种子/i,
    lines: [
      "복구 단어(12단어)는 이 지갑을 다른 컴퓨터에서 되살리는 열쇠예요. 가진 사람은 누구나 돈을 옮길 수 있어요.",
      "종이에 적어 안전한 곳에 두고, 사진이나 메시지로 남기지 마세요. 라비도, 누구도 복구 단어를 묻지 않아요.",
      "보는 곳: 이 컴퓨터 → 백업.",
    ],
    go: [{ label: "백업 열기", to: "backup" }],
  },
  {
    id: "backup", name: "백업",
    words: /백업|back\s*up|バックアップ|备份|備份/i,
    lines: [
      "이 컴퓨터 → 백업에서 지갑과 가게 자료를 잠근 파일 하나로 만들어요.",
      "그 파일은 USB나 다른 컴퓨터에 두세요. 이 컴퓨터가 고장 나면 그 파일로 되돌려요.",
    ],
    go: [{ label: "백업 열기", to: "backup" }],
  },
  {
    id: "cert", name: "증서 만들기·확인",
    words: /증서|증명서|수료증|자격증|certificate|証明書|证书|證書/i,
    lines: [
      "만들기: 자산 → 만들기 → 증명서에서 제목과 받는 사람을 적으면 돼요. 한 장에 5 RVN(수수료 조금 더), 이름을 처음 쓸 때만 이름 등록 500 RVN이 한 번 더 들어요.",
      "확인: 받은 증서는 자산 → 「받은 것」에서 눌러 봐요. 원본 파일 지문이 새겨진 증서는 「확인 페이지 열기」로 진짜인지 볼 수 있어요.",
    ],
    go: [{ label: "만들기 열기", to: "create" }, { label: "자산 열기", to: "assets" }],
  },
  {
    id: "balance", name: "잔액이 안 보여요",
    words: /잔액|잔고|안\s*(보여|보이|떠|뜨)|0\s*RVN|balance|残高|余额|餘額/i,
    lines: [
      "방금 받은 돈은 지갑 화면에 「들어오는 중」으로 따로 보여요. 네트워크에 기록되면(보통 몇 분) 「사용 가능」으로 옮겨져요.",
      "이 컴퓨터가 아직 레이븐코인 기록을 따라잡는 중이면 잔액이 늦게 보여요. 따라잡으면 저절로 맞춰져요.",
    ],
    go: [{ label: "지갑 열기", to: "wallet" }],
  },
  {
    id: "key", name: "라비 AI 열쇠 넣기",
    words: /열쇠|\bapi\b|키\s*(를|는|넣|받|어디)|\bkeys?\b|キー|密钥|密鑰/i,
    lines: [
      "AI 열쇠는 AI 회사(Anthropic·OpenAI·Google·xAI·Groq)에서 각자 받아요. 회사마다 가입하고 열쇠를 만들면 되고, 요금은 회사마다 달라요.",
      "아래 「AI 열쇠 넣기」에서 회사를 고르고 「어디서 받나요」로 받은 뒤 붙여 넣으세요. 열쇠는 이 컴퓨터에만 저장돼요.",
    ],
    go: [{ label: "AI 열쇠 넣기", to: "key" }],
  },
  {
    id: "sync", name: "노드 동기화",
    words: /동기화|싱크|따라잡|\bsync|노드|\bnode\b|同期|同步|ノード|节点|節點/i,
    lines: [
      "이 컴퓨터가 레이븐코인 기록을 받아 맞추는 중이에요(동기화). 처음엔 몇 시간에서 며칠 걸릴 수 있어요.",
      "켜 두기만 하면 돼요. 그동안에는 받은 돈이 늦게 보일 수 있어요.",
    ],
    go: [{ label: "노드 상태 보기", to: "node" }],
  },
  {
    id: "receive", name: "받기",
    words: /받(기|는\s*(법|방법|주소)|으려|을\s*수|고\s*싶)|입금|내\s*주소|주소\s*(알려|어디|복사)|receiv|deposit|my\s*address|受け取|入金|接收|收款|充值/i,
    lines: [
      "지갑 → 「받기」를 누르면 내 받는 주소와 QR이 바로 나와요.",
      "「주소 복사」나 「메시지로 복사」로 보내 줄 분께 전해 주세요. 레이븐코인(RVN)과 레이븐 자산만 받을 수 있어요.",
    ],
    go: [{ label: "받기 열기", to: "receive" }],
  },
  {
    id: "send", name: "보내기",
    words: /보내|송금|이체|\bsend|transfer|送金|送る|发送|轉帳|转账/i,
    lines: [
      "지갑 → 「보내기」에서 받는 주소와 금액을 넣고 「검토」를 눌러요.",
      "확인 화면에서 받는 사람·금액·수수료·합계를 보고 보내요. 처음 보내는 주소에 큰 금액이면 끝 네 글자를 한 번 더 물어요.",
    ],
    go: [{ label: "보내기 열기", to: "send" }],
  },
];

/** 물은 말에 맞는 주제 하나. 없으면 null — 짐작하지 않는다. */
export function matchGuide(question: string): GuideTopic | null {
  const q = String(question ?? "").normalize("NFC");
  if (!q.trim()) return null;
  return GUIDE.find((g) => g.words.test(q)) ?? null;
}

export function guideById(id: string): GuideTopic | null {
  return GUIDE.find((g) => g.id === id) ?? null;
}

type Copy = (source: string) => string;

/** 모든 안내 말풍선의 머리. 🔴 빼지 않는다 — AI 가 아닌 것을 AI 처럼 보이게 하지 않는다. */
export const GUIDE_BADGE = "라비 안내 · AI 아님";

/** 맞는 주제가 있을 때의 답. 글자는 전부 앱 문구라 `copyHtml` 로 넣는다(언어를 바꾸면 따라 바뀐다). */
export function guideHtml(topic: GuideTopic, copyHtml: Copy): string {
  return `<div class="guide" data-guide="${topic.id}">` +
    `<div class="guidebadge">${copyHtml(GUIDE_BADGE)}</div>` +
    topic.lines.map((line) => `<p>${copyHtml(line)}</p>`).join("") +
    `<div class="guidego">` +
    topic.go.map((g) => `<button type="button" class="ghost" data-guide-go="${g.to}">${copyHtml(g.label)}</button>`).join("") +
    (topic.go.some((g) => g.to === "key") ? "" :
      `<button type="button" class="ghost" data-guide-go="key">${copyHtml("AI 열쇠 넣기")}</button>`) +
    `</div></div>`;
}

/** 맞는 주제가 없을 때. 모른다고 말하고, 자주 묻는 것과 열쇠 넣는 곳을 보여 준다. */
export function guideMissHtml(copyHtml: Copy): string {
  return `<div class="guide" data-guide="miss">` +
    `<div class="guidebadge">${copyHtml(GUIDE_BADGE)}</div>` +
    `<p>${copyHtml("제가 미리 준비한 안내에는 없는 질문이에요. 지금은 AI 열쇠가 없어서 자유롭게 답하지 못해요.")}</p>` +
    `<p class="meta">${copyHtml("자주 묻는 것")}</p>` +
    `<div class="guidego">` +
    // 열쇠 넣기는 바로 아래 큰 단추가 있으니 목록에서는 뺀다(같은 단추가 둘이면 어느 것인지 망설인다).
    GUIDE.filter((g) => g.id !== "key").map((g) => `<button type="button" class="ghost" data-guide-topic="${g.id}">${copyHtml(g.name)}</button>`).join("") +
    `</div>` +
    `<div class="guidego"><button type="button" data-guide-go="key">${copyHtml("AI 열쇠 넣기")}</button></div>` +
    `</div>`;
}

/** 붙여 넣은 열쇠의 앞머리로 어느 회사 것인지 알아본다. 모르면 null — 고른 것을 그대로 둔다. */
export function providerOfKey(key: string): string | null {
  const k = String(key ?? "").trim();
  if (/^sk-ant-/.test(k)) return "anthropic";
  if (/^xai-/.test(k)) return "xai";
  if (/^AIza/.test(k)) return "google";
  if (/^gsk_/.test(k)) return "groq";
  if (/^sk-/.test(k)) return "openai";
  return null;
}
