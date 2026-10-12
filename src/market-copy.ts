/*
 * 열린 장터 새 문구 한 곳(0.9.2). 시험이 이 파일의 모든 문장을 읽어 금지어를 찾는다.
 *
 * 쓰는 원칙(대표 결정 전이라 모두 중립 문구):
 *   · 「구매」「소장」으로 부풀리지 않는다 — 이 결제가 실제로 하는 일을 그대로 쓴다: 판매자에게 RVN 을 보내고, 체인에 기록(메모)이 남는다.
 *   · 구매자는 자산을 받지 않는다. 파일은 공개 IPFS 라 주소(CID)를 아는 누구나 받을 수 있다 — 열람 권한은 생기지 않는다.
 *   · 환불·권리·법적 효력은 약속하지 않는다. 신고 처리 기한·기준은 정해지는 중이다(자리표시).
 */
export const MARKET_FACTS: readonly string[] = Object.freeze([
  '이 결제는 판매자 받는 주소로 RVN 을 보내고, 체인에 「이 계정이 이 상품 값을 냈다」는 기록(메모)을 남겨요.',
  '상품 등록증(자산)은 판매자 지갑에 그대로 있어요. 내 지갑으로 오지 않고, 내 지갑에 새 자산이 생기지 않아요.',
  '상품 파일은 공개 IPFS 에 있어요. 주소(CID)를 아는 사람은 누구나 받을 수 있어서, 이 결제가 파일을 볼 수 있는 권한을 만들어 주지는 않아요.',
  '보낸 돈은 되돌릴 수 없어요. 레이븐볼트는 돈을 맡지 않아서 대신 돌려줄 수 없고, 환불은 판매자와 직접 정해야 해요.',
  '이 화면은 시험 단계예요. 이 결제가 어떤 권리나 효력을 주는지는 아직 정해지지 않았어요.',
]);

export const BUTTON_DETAIL = '결제 내용 보기';
export const BUTTON_APPROVE = '승인하고 보내기';
export const BUTTON_CANCEL = '취소';
export const CONFIRM_TITLE = '결제 확인';
export const PURCHASES_TITLE = '내 결제 기록';
export const PURCHASES_EMPTY = '아직 결제한 기록이 없어요.';
export const PREPARING = '거래를 만들어 확인하는 중이에요… (아직 돈은 나가지 않았어요)';
export const PREPARED_NOTE = '아래 받는 곳과 금액을 확인하세요. 「승인하고 보내기」를 누르기 전에는 돈이 나가지 않아요.';
export const PAID_SAY = '보냈어요. 아래 결제 기록에 넣었어요. 체인에 올라가려면 몇 분 걸려요.';
export const SENT_UNKNOWN_SAY = '보냈는지 확인하지 못했어요. 같은 결제를 다시 하지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.';

/** 1단계 제한(검증됨 전용). */
export const VERIFIED_ONLY_EMPTY = '지금은 레이븐볼트가 서명한 허용 목록에 있는 상품만 결제할 수 있어요. 허용 목록이 비어 있어서 아직 결제할 수 있는 상품이 없어요.';
export const VERIFIED_ONLY_NOT_LISTED = '지금은 레이븐볼트가 서명한 허용 목록에 있는 상품만 결제할 수 있어요. 이 상품은 목록에 없어요.';

/** 신고·숨김(처리 정책은 대표 결정 전 — 자리표시). */
export const REPORT_CONTACT = 'playx@ex.erci.se';
export const REPORT_LABEL = '이 상품 신고하기';
export const REPORT_NOTE = '신고는 메일로 접수돼요. 접수 뒤 처리 기한과 기준은 정해지는 중이라 지금은 약속할 수 없어요. 체인에 올라간 기록 자체는 지울 수 없고, 이 앱의 목록에서 숨기는 것만 할 수 있어요.';
export const REPORT_OPENED = '메일 작성 창을 열었어요. 보내기 전에 내용을 확인해 주세요.';
export const REPORT_COPIED = '메일 앱을 열지 못해서 신고 내용을 복사했어요. 아래 주소로 보내 주세요.';
export const REPORT_FAILED = '메일 앱도 복사도 되지 않았어요. 아래 주소와 상품 이름을 적어 보내 주세요.';
export const HIDE_LABEL = '이 상품 내 목록에서 숨기기';
export const HIDE_NOTE = '내 컴퓨터의 목록에서만 숨겨요. 다른 사람에게는 그대로 보이고, 체인의 기록은 바뀌지 않아요.';
export const HIDDEN_SAY = (n: number) => `내가 숨긴 상품 ${n}개`;
export const UNHIDE_ALL = '숨긴 상품 다시 보기';

/** 시험이 금지어를 찾는 문장 전부(함수 문구는 예시 값으로). */
export function allMarketCopy(): string[] {
  return [...MARKET_FACTS, BUTTON_DETAIL, BUTTON_APPROVE, BUTTON_CANCEL, CONFIRM_TITLE, PURCHASES_TITLE, PURCHASES_EMPTY, PREPARING, PREPARED_NOTE, PAID_SAY,
    SENT_UNKNOWN_SAY, VERIFIED_ONLY_EMPTY, VERIFIED_ONLY_NOT_LISTED, REPORT_LABEL, REPORT_NOTE, REPORT_OPENED, REPORT_COPIED, REPORT_FAILED, HIDE_LABEL, HIDE_NOTE, HIDDEN_SAY(2), UNHIDE_ALL];
}
