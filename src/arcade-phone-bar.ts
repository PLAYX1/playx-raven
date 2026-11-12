// 폰에서 보낸 게임이 이 컴퓨터의 손을 기다릴 때 — 아래쪽 알림 띠(일꾼 = arcade-phone-upload.ts · 순수 규칙과 화면을 나눴다).
import { copyHtml } from "./i18n";
import "./arcade-market.css";
import type { PhoneJob } from "./arcade-phone-upload";

const BAR_ID = "rv-phone-up";
const opened = new Map<string, number>(); // 「확인하러 가기」를 누른 일감 — 5분 동안 띠를 다시 띄우지 않는다(화면에서 확인 중)
/**
 * 데스크탑 아래쪽 알림 띠 — 폰에서 보낸 게임이 이 컴퓨터의 손을 기다릴 때. 한 줄 글 + 단추 하나(글자만 · 줄바꿈 없음).
 *   locked → 「지갑 열기」(누르면 지갑 암호 → 다음 바퀴에 이어서 올린다) · shop → 「확인하러 가기」(게임 올리기 화면 · 소각액 확인 칸).
 */
export function paintPhoneBar(job: PhoneJob, why: "locked" | "shop", act: { unlock: () => void; openShop: (job: PhoneJob) => void }): void {
  if (why === "shop" && Date.now() - (opened.get(job.id) ?? 0) < 5 * 60_000) return;
  let bar = document.getElementById(BAR_ID);
  if (!bar) { bar = document.createElement("div"); bar.id = BAR_ID; bar.className = "ar-phone-bar"; bar.setAttribute("role", "status"); document.body.appendChild(bar); }
  if (bar.dataset.job === job.id && bar.dataset.why === why) return;
  bar.dataset.job = job.id; bar.dataset.why = why;
  const say = why === "shop" ? "폰에서 보낸 게임을 가게 이름으로 올리려면 여기서 소각액을 확인해 주세요." : "폰에서 보낸 게임이 기다려요. 지갑을 열면 바로 올려요.";
  bar.innerHTML = `<span>${copyHtml(say)}</span><button type="button" data-phone-go="1">${copyHtml(why === "shop" ? "확인하러 가기" : "지갑 열기")}</button>`;
  (bar.querySelector("[data-phone-go]") as HTMLButtonElement).onclick = () => { if (why === "shop") { opened.set(job.id, Date.now()); clearPhoneBar(); act.openShop(job); } else act.unlock(); };
}
export function clearPhoneBar(): void { document.getElementById(BAR_ID)?.remove(); }
