/* 「체인 정보」 화면·홈 요약(chain-info-card.ts)의 지연 묶음 이음매 (0.8.8 병합).
 *
 * 왜 지연인가: main 묶음이 메모리 예산 「가장 큰 묶음 ≤ 1000KB」(scripts/memory-budget.json)에 닿아 있어서
 * 화면 코드·스타일을 따로 묶는다(asset-keep-lazy 와 같은 방식). 홈을 그릴 때 처음 한 번 읽는다.
 * 읽는 동안 홈 단추는 index.html 의 정적 글자(「체인 정보」)만 보인다 — 숫자를 만들어 채우지 않는다.
 * 🔴 읽기에 실패해도 화면은 죽지 않는다: 경고만 남기고 다음 호출에서 다시 시도한다. 문구(chain-info-copy)는 dict.ts 가 main 에 둔다.
 */
import "./chain-info-home.css";

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
type ChainApi = { enter(): void; paintHome(): void };

export function wireChainInfoLazy(o: { invoke: Invoke; showPage: (id: string) => void }): ChainApi {
  let real: ChainApi | null = null;
  let loading: Promise<ChainApi | null> | null = null;
  const load = (): Promise<ChainApi | null> => {
    if (!loading) {
      loading = import("./chain-info-card")
        .then((m) => (real = m.wireChainInfo(o)))
        .catch((e) => { console.warn("chain-info load failed", e); loading = null; return null; });
    }
    return loading;
  };
  return {
    enter() { if (real) real.enter(); else void load().then((k) => k?.enter()); },
    paintHome() { if (real) real.paintHome(); else void load().then((k) => k?.paintHome()); },
  };
}
