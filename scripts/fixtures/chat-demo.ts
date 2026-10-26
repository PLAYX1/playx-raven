// 레이아웃 관문용 대화 부품 시연(합성 글). 실제 앱에는 들어가지 않는다.
import "../../src/layout-tokens.css";
import { createChatThread } from "../../src/chat-thread";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const css = dark
  ? "--bg:#0F1016;--panel:#15161D;--text:#ECEDF3;--muted:#A3A7B7;--line:#2A2D3A;--my-bubble:#E2702A;--my-text:#15161D;--brand:#E2702A;--on-brand:#15161D;--focus:#8ab4ff"
  : "--bg:#F7F6F3;--panel:#FFFFFF;--text:#15161D;--muted:#5B5E6B;--line:#E6E3DC;--my-bubble:#15161D;--my-text:#FFFFFF;--brand:#15161D;--on-brand:#FFFFFF;--focus:#1f5fd6";
const sheet = new CSSStyleSheet(); sheet.replaceSync(`:root{${css}} html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif} #host{height:100%;container-type:inline-size} button{font:inherit;background:var(--brand);color:var(--on-brand);border:1px solid var(--brand);border-radius:8px;padding:0 14px} button.ghost{background:transparent;color:var(--text);border-color:var(--line)}`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
const t = createChatThread({ label: "라비와 대화", placeholder: "라비에게 물어보세요", send: "보내기", jump: "새 글 ↓" });
document.getElementById("host")!.append(t.el);
const now = 1791500400;
t.set([
  { id: "1", me: false, at: now, text: "안녕하세요! 무엇을 도와드릴까요?" },
  { id: "2", me: true, at: now + 30, text: "이 주소로 받은 게 있나 봐 줘 RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB" },
  { id: "3", me: true, at: now + 35, text: "거래 번호는 9f2c4e8a1b7d3f60c5e2a9d8b1f4c7e03a6d9b2e5f8c1a4d7b0e3f6a9c2d5e8b1" },
  { id: "4", me: false, at: now + 90, text: "네, 그 주소로 확인 1번 된 입금이 하나 있어요. 금액은 큰 창에서 보여 드릴게요. 보내기는 언제나 큰 창의 확인 화면에서만 할 수 있어요." },
  { id: "5", me: true, at: now + 150, text: "고마워 👍" },
]);
(window as unknown as { __thread: typeof t }).__thread = t;
