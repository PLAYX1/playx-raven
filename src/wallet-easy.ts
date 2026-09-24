/* 지갑 화면을 「처음 쓰는 사람」 순서로 — 받기(0.4.8-B · RV3 🔴5).
 *
 * 여기는 **그리기**만 한다. 노드에 묻는 일(주소)은 main.ts 가 러스트(`receive.rs`)를 불러서 한다.
 */
type Copy = (source: string) => string;
type Esc = (value: unknown) => string;

/** 받기 칸. 주소는 노드가 「이 지갑 것」이라고 확인한 것만 들어온다(main.ts). */
export function receiveHtml(address: string, reused: boolean, copyHtml: Copy, esc: Esc): string {
  return `<section class="card wrecv" id="w-recv" aria-labelledby="w-recv-title">` +
    `<div class="wrecv-head"><h3 id="w-recv-title">${copyHtml("받을 주소")}</h3>` +
    `<button type="button" class="ghost" id="w-recv-close">${copyHtml("닫기")}</button></div>` +
    `<div class="wrecv-body">` +
    `<div class="shareqr wrecv-qr" id="w-qr" role="img" aria-label="받을 주소 QR">${copyHtml("QR 만드는 중…")}</div>` +
    `<div class="wrecv-side">` +
    `<code class="addr wrecv-addr" id="w-addr-text" translate="no">${esc(address)}</code>` +
    `<p class="meta">${copyHtml("이 컴퓨터의 노드가 확인한 내 지갑 주소예요. 레이븐코인(RVN)과 레이븐 자산만 받을 수 있어요.")}</p>` +
    `<div class="wrecv-btns">` +
    `<button type="button" id="w-copy">${copyHtml("주소 복사")}</button>` +
    `<button type="button" class="ghost" id="w-copymsg">${copyHtml("메시지로 복사")}</button>` +
    `<button type="button" class="ghost" id="w-qrsave">${copyHtml("QR 그림 저장")}</button>` +
    `</div>` +
    `<p class="meta" id="w-recv-note" aria-live="polite"></p>` +
    `<p class="meta">${copyHtml(reused
      ? "아직 받은 적 없는 주소라 다시 보여 드려요. 돈이 들어오면 다음에는 새 주소가 나와요."
      : "새로 만든 주소예요. 돈이 들어올 때까지 「받기」를 누르면 이 주소가 다시 나와요.")}</p>` +
    `<button type="button" class="ghost" id="w-newaddr">${copyHtml("새 주소 만들기")}</button>` +
    `</div></div></section>`;
}

/** 카톡 등에 붙여 넣을 한 줄. `tf` 로 사람이 고른 말로 만든다. */
export const RECEIVE_MESSAGE = "제 레이븐코인(RVN) 받는 주소예요: {0}";
