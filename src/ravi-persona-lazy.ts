/* 라비 인물 설정·감정·위기·체인 대답(ravi-persona.ts)의 지연 묶음 이음매 (0.8.8 병합).
 *
 * 왜 지연인가: 10개 언어 문구·낱말표(≈ 130KB)를 main 묶음에 넣으면 메모리 예산의 「가장 큰 묶음 ≤ 1000KB」
 * (scripts/memory-budget.json)를 넘는다. 대화 입력칸에 처음 들어가거나 첫 질문을 보낼 때 한 번 읽는다(asset-keep-lazy 와 같은 방식).
 *
 * 🔴 읽기에 실패해도 대화는 죽지 않는다(dynamic 조각 실패 = 페이지 사망 사고 이력): null 을 돌려주고 기존 경로(안내 검색·AI)로 간다.
 *    위기 표현은 그때도 AI 쪽 SYSTEM(ravi_agent.rs)의 위기 규칙이 받는다. 실패한 읽기는 다음 질문에서 다시 시도한다.
 */
export type RaviPersonaModule = typeof import("./ravi-persona");

let loading: Promise<RaviPersonaModule | null> | null = null;

export function loadRaviPersona(): Promise<RaviPersonaModule | null> {
  if (!loading) {
    loading = import("./ravi-persona").catch((e) => {
      console.warn("ravi-persona load failed", e);
      loading = null;
      return null;
    });
  }
  return loading;
}
