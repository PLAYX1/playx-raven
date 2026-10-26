/*
 * 옛 자산 이름 규칙 「RV.<종류>.<이름>」 읽기 전용 해석 (대표 결정 2026-10-13: 새로 만들기는 중단, 이미 쓰는 사용자를 위해 읽기는 계속).
 * 🔴 결과는 표시용 힌트일 뿐 신원 증명이 아니다: 이름 모양만 보고 만든 값이라 누가 발행했는지·가게/상품 문서의 서명 정체와 아무 관계가 없다.
 *    (그래서 입력은 이름 문자열 하나뿐이고, 결과에는 키·지문·서명 칸이 없으며 identityProof 는 항상 false.)
 * 의존성 없음. creator/asset-name.ts 의 읽기·검사 함수는 건드리지 않는다.
 */
export const LEGACY_ASSET_PREFIX_TEXT = 'RV.';
export type LegacyKind = 'music' | 'game' | 'book' | 'ticket' | 'digital' | 'shop';
/** 종류 글자 표: M음악 G게임 B책 T티켓 X기타 S가게. (S 는 asset-name.ts 표에는 없고 읽을 때만 인식한다.) */
export const LEGACY_KIND_BY_LETTER: Readonly<Record<string, LegacyKind>> = Object.freeze({ M: 'music', G: 'game', B: 'book', T: 'ticket', X: 'digital', S: 'shop' });
export const LEGACY_KIND_LABEL_KO: Readonly<Record<LegacyKind, string>> = Object.freeze({ music: '음악', game: '게임', book: '책', ticket: '티켓', digital: '기타 디지털', shop: '가게' });

export type LegacyAssetInfo = Readonly<{
  legacy: true;
  name: string;
  kindLetter: string;
  kind: LegacyKind;
  kindLabelKo: string;
  work: string;
  /** 항상 true: 이 해석은 표시용 힌트다. */
  displayHintOnly: true;
  /** 항상 false: 자산 이름은 신원 증명이 아니다. 발행자 확인은 서명 문서(키 지문)로만. */
  identityProof: false;
  label: string;
}>;

/** 옛 규칙 이름이면 표시 정보, 아니면 null(대문자·숫자·점·밑줄 이외, 모르는 종류 글자, 빈 작품 이름 포함). */
export function parseLegacyAssetName(name: string): LegacyAssetInfo | null {
  if (typeof name !== 'string' || name.length > 30 || !name.startsWith(LEGACY_ASSET_PREFIX_TEXT)) return null;
  const m = /^([A-Z0-9])\.([A-Z0-9._]+)$/.exec(name.slice(LEGACY_ASSET_PREFIX_TEXT.length));
  if (!m) return null;
  const kind = LEGACY_KIND_BY_LETTER[m[1]];
  if (!kind || /[._]{2,}/.test(m[2]) || /^[._]|[._]$/.test(m[2])) return null;
  const kindLabelKo = LEGACY_KIND_LABEL_KO[kind];
  return Object.freeze({ legacy: true, name, kindLetter: m[1], kind, kindLabelKo, work: m[2], displayHintOnly: true, identityProof: false, label: `옛 규칙 자산 · ${kindLabelKo} · ${m[2]}` } as const);
}
export const isLegacyAssetName = (name: string): boolean => parseLegacyAssetName(name) !== null;

/**
 * 새 발행 가드: 옛 규칙 이름으로 새로 발행하려 하면 막는다. 연결: creator/publish.ts precheck·planIssue, creator/publish-route.ts(§31 ⓑ).
 * 우회 칸은 없다(시험의 옛 매니페스트 재현은 creator/legacy-manifest-fixture.ts — 시험 전용).
 */
export function legacyIssueGuard(name: string): { allowed: boolean; say: string } {
  return isLegacyAssetName(name) ? { allowed: false, say: '옛 이름 규칙(RV.)으로는 더 이상 새로 만들 수 없어요. 이미 있는 자산은 그대로 보여 드려요.' } : { allowed: true, say: '' };
}
