/*
 * 확인 수 이원화 — 시험망 실측 반영(대표 승인 10-14), 근거 docs/testnet-measure/README.md (6).
 *   FINAL   = 되돌릴 수 없는 전달(매장 수령·「확정」 영수증·파일 열쇠·티켓 확정)의 최소 확인 수.
 *   DISPLAY = 화면 표시용(「확인 대기 → 확인 중」). 0 확인은 어느 쪽에서도 통과가 아니다(pending/거절).
 * 6 확인도 더 긴 사슬이 나오면 뒤집힌다(regtest 7블록 경쟁 사슬로 확인) — 메인넷 관찰 전 낮추지 않는다.
 */
export const DISPLAY_MIN_CONFIRMATIONS = 1;
export const FINAL_MIN_CONFIRMATIONS = 6;

/** 영수증·기록 파라미터 — 대표 결정 전 숫자는 여기 한 곳. */
export const RECEIPT_PARAMS = {
  /** 1 RVN = 1e8 sats */
  satsPerRvn: 100_000_000n,
  /** 시세 조회 결과를 영수증에 박을 수 있는 최대 나이(ms). 이보다 오래된 시세는 「환산 없음」. 근거: 결제 순간 조회가 원칙. */
  maxQuoteAgeMs: 10 * 60 * 1000,
  /** 한국 표준시 고정 오프셋(분) — CSV 일시 표기용 */
  csvUtcOffsetMinutes: 9 * 60,
  /**
   * 쓰는 판. 2 = AAD 에 키 파생 버전·생성 시각을 묶은 판(배포 전이라 1 은 읽지 않는다).
   * 3 = 2 와 같은 암호 구조 + 판 2 영수증(orderHash·docHash·nonce·ticketId·skeletonOnly·rateKrwE4)을 담을 수 있다.
   * 4 = 3 과 같은 암호 구조 + 판 3 영수증(feeTrackId·appliedFeeBps·feeKind, 25라운드 §36)을 담을 수 있다.
   * 규칙: 파일 판 v 는 영수증 판 v − 1 까지만 담는다(옛 앱이 모르는 칸을 조용히 버리지 않게 — 옛 판 파일에 새 칸이 있으면 거절).
   */
  backupVersion: 4,
  /** 읽을 수 있는 판. 판 2 파일은 판 1 영수증만, 판 3 파일은 판 2 까지만 담아야 한다(옛 앱이 만든 파일 그대로). */
  backupReadableVersions: [2, 3, 4] as readonly number[],
  /** 백업 키 파생 info — 바꾸면 기존 백업이 안 열린다 */
  backupKeyInfo: 'rv-receipts-backup-v1',
  /** 키 파생(HKDF-SHA256) 방식 버전 — AAD 에 들어간다. 시드 → 키 규칙을 바꾸면 올린다. */
  backupKdfVersion: 1,
  /**
   * 백업 키 재료 최소 길이(바이트). HKDF 는 비밀번호용 KDF 가 아니다 — BIP39 시드(64바이트) 또는 그것에서 파생한 32바이트 키만 넘긴다.
   * PIN·비밀번호·니모닉 글자를 그대로 넘기면 거절(길이·서로 다른 바이트 수·인쇄 가능 ASCII 만으로 된 값 검사).
   */
  backupMinSeedBytes: 32,
  /** 영수증을 「확정」으로 만드는 최소 확인 수 = FINAL(6). 그 미만(1 확인 포함)은 pending(표시용). 시험망 실측 반영(대표 승인 10-14). */
  minConfirmations: FINAL_MIN_CONFIRMATIONS,
} as const;

export const CSV_NOTICE = '거래 사실의 요약이며 세무 신고 자료가 아닙니다. 과세 여부·세율·신고는 판매자 책임입니다.';
export const CSV_ADDRESS_NOTICE = '상대 주소는 체인에 공개된 주소이며, 파일을 남에게 보내면 주소와 상품의 연결이 함께 노출됩니다.';
export const CSV_TOTALS_NOTICE = '합계는 이 파일에 담긴 영수증의 RVN 을 더한 값입니다. 세액은 계산하지 않았으니 세무 전문가와 확인하세요.';
