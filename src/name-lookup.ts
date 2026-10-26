/*
 * 체인 이름 조회(name_taken)의 답을 세 상태로 읽는다 — 있음(true) · 없음(false) · 확인 불가(null).
 *
 * 🔴 Rust 명령(issue.rs lookup_name)은 노드가 정상으로 「없다」고 답했을 때만 false 를 준다. 모르면 **오류**다.
 *    화면은 오류뿐 아니라 **불리언이 아닌 답**(빈 값·문자열 "false"·객체)도 확인 불가로 읽는다 — 「없음」으로 새지 않게.
 *    확인 불가(null)면 발행 계획(core/creator/publish.ts planIssue nameTaken: null)이 등록을 막는다.
 */
export type NameState = boolean | null;

/** invoke 결과 하나 → 있음/없음/확인 불가. 정확히 true·false 만 믿는다. */
export function nameTakenFrom(value: unknown): NameState {
  return value === true ? true : value === false ? false : null;
}

/** 정확한 불리언만 믿는다(그 밖은 null = 확인 불가). shop_name_free 처럼 뜻이 반대인 답에도 쓴다. */
export const strictBool = nameTakenFrom;

/** invoke('name_taken') 를 불러 세 상태로. 오류는 확인 불가. */
export async function askNameTaken(invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>, name: string): Promise<NameState> {
  try { return nameTakenFrom(await invoke<unknown>('name_taken', { name })); } catch { return null; }
}

/** Promise.allSettled 결과에서 읽기. */
export function nameTakenSettled(r: PromiseSettledResult<unknown>): NameState {
  return r.status === 'fulfilled' ? nameTakenFrom(r.value) : null;
}
