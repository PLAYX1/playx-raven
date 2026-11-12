/* 테일스케일 퍼널로 「바뀌지 않는 가게 주소」 만들기 — 화면 단추와 라비가 같이 쓴다(src-tauri/src/tailscale.rs).
 *
 * 🔴 지키는 것
 *  - 한 번 부를 때 한 걸음(`tailscale_fixed_setup`). 사람이 할 일(깔기·로그인·허락)이 나오면 그 말을 하고,
 *    5초마다 조용히 다시 물어 **되면 이어서** 한다. 10분 넘게 안 되면 멈춘다.
 *  - 로그인·암호는 사람이 한다. 우리는 테일스케일이 준 창을 열어 줄 뿐 — 아무 글도 대신 넣지 않는다.
 *  - 주소는 사람·라비가 적은 글이 아니다. 이 컴퓨터의 테일스케일 이름에서 만들고, 실제로 대답한 다음에만 쓴다.
 *  - 보통 테일스케일 주소(100.x · 내 기기끼리만)는 손님에게 안 열린다 — 퍼널 주소(https://….ts.net)만 고정 주소로 친다.
 */

export type TsState =
  | "not_installed" | "not_running" | "starting" | "stopped" | "needs_login" | "needs_login_app"
  | "needs_machine_auth" | "no_name" | "needs_funnel" | "not_answering" | "ready" | "failed";
export type TsResult = { state: TsState; url?: string; published?: boolean; detail?: string };
export type TsOpen = "download" | "app" | "login" | "approve" | "machines" | "dns";

/** 걸음마다 할 말(한국어 원문 — 화면에서 t() 로 옮긴다)과, 사람이 누를 단추. */
export const TS_STEP: Record<TsState, { say: string; open?: { target: TsOpen; label: string }; wait?: boolean }> = {
  not_installed: { say: "이 컴퓨터에 테일스케일이 아직 없어요. [테일스케일 받기]를 눌러 깔아 주세요. 다 깔면 제가 이어서 할게요.", open: { target: "download", label: "테일스케일 받기" }, wait: true },
  not_running: { say: "테일스케일이 꺼져 있어요. [테일스케일 켜기]를 눌러 켜 주세요. 켜지면 제가 이어서 할게요.", open: { target: "app", label: "테일스케일 켜기" }, wait: true },
  starting: { say: "테일스케일이 켜지는 중이에요. 잠깐만 기다려 주세요.", wait: true },
  stopped: { say: "테일스케일이 쉬고 있어요. 테일스케일 앱에서 「연결(Connect)」을 눌러 주세요.", open: { target: "app", label: "테일스케일 켜기" }, wait: true },
  needs_login: { say: "테일스케일 로그인 창을 열었어요. 사장님 계정으로 직접 로그인해 주세요. 암호는 저에게 알려 주지 마세요. 로그인하면 제가 이어서 할게요.", open: { target: "login", label: "로그인 창 열기" }, wait: true },
  needs_login_app: { say: "테일스케일 앱에서 직접 로그인해 주세요. 로그인하면 제가 이어서 할게요.", open: { target: "app", label: "테일스케일 켜기" }, wait: true },
  needs_machine_auth: { say: "테일스케일 관리 화면에서 이 컴퓨터를 「승인」해 주세요. 승인하면 제가 이어서 할게요.", open: { target: "machines", label: "관리 화면 열기" }, wait: true },
  no_name: { say: "테일스케일 관리 화면의 DNS 에서 「MagicDNS」를 켜 주세요. 켜면 제가 이어서 할게요.", open: { target: "dns", label: "관리 화면 열기" }, wait: true },
  needs_funnel: { say: "가게 문을 바깥에 여는 것을 한 번만 허락해 주세요. 열린 창에서 「Enable」을 누르면 돼요. 누르면 제가 이어서 할게요.", open: { target: "approve", label: "허락 창 열기" }, wait: true },
  not_answering: { say: "주소는 만들었는데 가게 문이 아직 대답하지 않아요. 1분쯤 뒤에 다시 눌러 주세요." },
  ready: { say: "바뀌지 않는 가게 주소를 만들었어요. 앱이나 컴퓨터를 다시 켜도 그대로예요." },
  failed: { say: "테일스케일이 안 된다고 했어요. 잠시 뒤 다시 해 보시고, 그래도 안 되면 「문제 알리기」로 알려 주세요." },
};
export const TS_TIMEOUT_SAY = "기다리다 멈췄어요. 준비되면 다시 눌러 주세요.";
export const TS_OFF_SAY = "테일스케일 가게 문을 닫았어요. 이제 이 주소로는 손님이 못 들어와요 — 「가게 링크」를 바꿔 주세요.";
export const TS_PUBLISHED_SAY = "지도에도 새 주소로 다시 올렸어요.";
export const TS_FILLED_SAY = "「가게 링크」에 넣었어요. [올리기]를 누르면 손님 지도에 올라가요.";
export const TS_START_SAY = "바뀌지 않는 가게 주소를 만들어 볼게요. 사장님이 직접 누르실 곳이 나오면 말씀드릴게요.";
export const TS_BUSY_SAY = "이미 만드는 중이에요. 조금만 기다려 주세요.";
export const TS_SUGGEST_TITLE = "가게 링크가 임시 주소예요";
export const TS_SUGGEST_BODY = "앱을 다시 켜면 주소가 바뀌어 손님이 헛걸음해요. 바뀌지 않는 주소로 바꿔 드릴까요?";
export const TS_SUGGEST_YES = "바꿔 줘";
export const TS_SUGGEST_NO = "괜찮아요";

/** 테일스케일 퍼널 주소인가(`https://이름.….ts.net`). 100.x·http 는 아니다. */
export function isFixedTsUrl(u: unknown): boolean {
  return typeof u === "string" && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\/?$/i.test(u.trim());
}

/** 「임시 주소예요…」 경고를 띄울 주소인가 — map_format.rs `is_temporary_url` 과 같은 판단. */
export function isTemporaryUrl(u: unknown): boolean {
  return typeof u === "string" && u.toLowerCase().includes(".trycloudflare.com") && !isFixedTsUrl(u);
}

const ASK_ON = /고정\s?(주소|링크|이름)|(주소|링크)(가|는|이)?\s?(안|안\s?바뀌|그대로|바뀌지\s?않|안\s?변하|고정)|(주소|링크).{0,8}(안\s?바뀌|바뀌지\s?않|그대로\s?(두|있|되)|고정)|테일\s?스케일|tailscale|funnel|퍼널|fixed (address|link|url)|permanent (address|link|url)|固定(アドレス|リンク|地址|链接)/;
const ASK_OFF = /(테일\s?스케일|tailscale|퍼널|funnel|고정\s?주소).{0,10}(꺼|끄|닫아|닫|멈춰|그만|해제|off)|(turn|switch) off (tailscale|funnel)/;
const ASK_HOW = /(뭐야|뭔가요|뭐예요|무엇|설명|what is|어떤 거)/;

/** 라비가 「고정 주소 만들어 줘」를 알아듣나. "on" = 만들기, "off" = 끄기, 아니면 null. */
export function raviFixedAddressIntent(q: string): "on" | "off" | null {
  const s = q.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s.length > 60) return null;
  if (ASK_OFF.test(s)) return "off";
  if (!ASK_ON.test(s)) return null;
  // 지갑·받는 주소 이야기는 가게 링크가 아니다.
  if (/지갑|받는\s?주소|보내는\s?주소|rvn|코인|wallet/.test(s)) return null;
  // 「테일스케일이 뭐야?」 같은 물음은 설명 길로 보낸다(만들기를 시작하지 않는다).
  if (ASK_HOW.test(s) && !/(만들|해\s?줘|해줘|연결|켜|바꿔|되게|해\s?주세요|부탁)/.test(s)) return null;
  return "on";
}

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let running = false;
export const fixedAddressRunning = () => running;

/**
 * 끝(ready·not_answering·failed)까지, 또는 사람이 10분 넘게 안 할 때까지 걸음을 이어 간다.
 * 사람이 할 일이 처음 나오면 그 창을 **한 번만** 열어 준다(같은 걸음이 다시 나오면 다시 열지 않는다).
 * 이미 돌고 있으면 null(두 번 누른 것).
 */
export async function runFixedAddress(
  invoke: Invoke,
  onStep: (r: TsResult) => void,
  opt: { pollMs?: number; maxMs?: number; autoOpen?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TsResult | "timeout" | null> {
  if (running) return null;
  running = true;
  const pollMs = opt.pollMs ?? 5000, maxMs = opt.maxMs ?? 10 * 60_000;
  const sleep = opt.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const started = Date.now();
  let last = "";
  try {
    for (;;) {
      let r: TsResult;
      try {
        r = await invoke<TsResult>("tailscale_fixed_setup");
      } catch (e) {
        r = { state: "failed", detail: String((e as Error)?.message ?? e) };
      }
      if (!r || !(r.state in TS_STEP)) r = { state: "failed" };
      if (r.state !== last) {
        onStep(r);
        const open = TS_STEP[r.state].open;
        // 「켜는 중」·「켜기」는 저절로 열지 않는다 — 깔기·로그인·허락 창만.
        if (opt.autoOpen !== false && open && open.target !== "app") void invoke("tailscale_open", { target: open.target }).catch(() => {});
        last = r.state;
      }
      if (!TS_STEP[r.state].wait) return r;
      if (Date.now() - started > maxMs) return "timeout";
      await sleep(pollMs);
    }
  } finally {
    running = false;
  }
}
