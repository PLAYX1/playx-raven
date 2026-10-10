/* 라비 감정 규칙표 — 「상황 → 감정」 데이터만 있다. 판단 로직은 ravi-emotion.ts.
 *
 * 🔴 지키는 것
 *  - 이벤트에는 **값이 없다**(payload-less). 금액·주소·이름이 감정 엔진으로 들어올 길이 없다.
 *    그래서 「큰 입금이라 더 기뻐함」 같은 규칙은 만들 수조차 없다(금액 가림 누수 방지).
 *  - serious(돈·보안 경고) 규칙은 calm·worried·apologetic 만 쓰고, 반짝임·바운스·밝은 소리를 쓰지 않는다.
 *  - 돈이 **나가는** 일(보내기·구매)은 축하하지 않는다. 「잘 끝났어요」 안도까지만 — 감정으로 쓰기를 부추기지 않는다.
 *  - 이 파일은 상태만 다룬다. IPC·지갑·노드 명령을 부르지 않는다.
 */

/** 감정 이름. 기존 RaviMood 이름은 바꾸지 않고, 새 감정은 baseMood + overlay 로 그린다(ravi-face-emotion.ts). */
export type RaviEmotion =
  | "neutral" | "happy" | "celebrate" | "fond" | "surprised"
  | "focused" | "thinking" | "worried" | "calm" | "apologetic"
  | "sleepy" | "asleep" | "welcome" | "waiting" | "puzzled"
  | "shy" | "proud" | "relieved";

export const RAVI_EMOTIONS: readonly RaviEmotion[] = [
  "neutral", "happy", "celebrate", "fond", "surprised", "focused", "thinking", "worried", "calm",
  "apologetic", "sleepy", "asleep", "welcome", "waiting", "puzzled", "shy", "proud", "relieved",
];

/** 우선순위 등급: 경고 > 오류 > 돈 > 사람(관계) > 일상. 숫자가 클수록 이긴다. */
export const PRIORITY = { ambient: 0, social: 1, money: 2, error: 3, alert: 4 } as const;
export type PriorityClass = keyof typeof PRIORITY;

/** 소리 슬롯 — 파일은 없다. 호스트(큰 창·미니 창·컴패니언)가 슬롯 id 를 「라비 소리」에 이어 붙인다. */
export type SoundSlot = "ravi.soft" | "ravi.bright" | "ravi.attention" | "ravi.oops";

/**
 * 감정이 머무는 자리(slot). 한 자리에는 한 감정만. 화면에는 모든 자리 중 가장 급한 것 하나만 보인다.
 * 예) 노드가 끊긴 동안(node 자리 = worried) 입금이 확인돼도(money 자리 = happy) 얼굴은 걱정이 이긴다 —
 *     입금 소식은 미니 창 알림 띠·목록에 그대로 있으니 정보는 사라지지 않는다.
 */
export type Slot = "node" | "money" | "send" | "error" | "social" | "ai" | "key" | "idle" | "night" | "talk" | "wallet";

export type RaviEventName =
  | "deposit_seen" | "deposit_confirmed" | "deposit_dropped" | "order_received" | "sale_done"
  | "first_deposit" | "first_sale" | "sale_milestone"
  | "follower_new"
  | "node_syncing" | "node_synced" | "node_down" | "node_disconnected" | "node_stalled" | "node_recovered"
  | "confirm_delayed" | "awake_lost"
  | "send_review" | "send_invalid" | "risk_warning" | "send_closed" | "send_done" | "purchase_done"
  | "error_generic" | "error_network"
  | "idle_long" | "user_return" | "night_start" | "night_end"
  | "ai_thinking" | "ai_done" | "ai_unknown"
  | "key_missing" | "key_connected"
  | "user_thanks"
  | "backup_done" | "wallet_locked" | "wallet_unlocked";

export type Motion = "none" | "nod" | "bounce" | "sparkle" | "sway" | "droop" | "settle";

export type Rule = {
  emotion: RaviEmotion;
  priority: PriorityClass;
  slot: Slot | null;            // null = 아무 자리에도 남지 않고 clears 만 한다
  /** 표시 시간(ms). 0 = 풀어 주는 이벤트(clears)가 올 때까지 머문다. */
  holdMs: number;
  /** 같은 이벤트가 이 시간 안에 또 오면 새 감정을 만들지 않고 합친다(count++, 시간 연장). */
  mergeMs: number;
  /** 같은 이벤트를 다시 「표정으로」 보여 주기까지 쉬는 시간(합치기 창이 지난 뒤). */
  cooldownMs: number;
  /** 말풍선 문구(한국어 원문 = 번역 열쇠). null = 말풍선 없음. */
  copy: string | null;
  /** 여러 건이 합쳐졌을 때 문구. {0} = 건수(금액 아님). 가림 켬이면 쓰지 않는다. */
  copyMany?: string;
  sound: SoundSlot | null;
  motion: Motion;
  /** 돈·보안 경고 — 들뜬 감정·반짝임·밝은 소리 금지(불변식 시험이 지킨다). */
  serious?: boolean;
  /** 금액 가림이 켜져 있을 때 대신 쓸 감정·문구(기념일 같은 「크기」 단서를 지운다). */
  masked?: { emotion: RaviEmotion; copy: string | null; motion: Motion };
  clears?: Slot[];
};

const S = 1000, M = 60 * S;

export const RULES: Record<RaviEventName, Rule> = {
  // ── 돈이 들어옴 ─────────────────────────────────────────────
  // 확인 전 입금은 사라질 수 있다 → 축하하지 않고 「보인다」까지만.
  deposit_seen:      { emotion: "surprised", priority: "money", slot: "money", holdMs: 4 * S, mergeMs: 20 * S, cooldownMs: 10 * S, copy: "들어오는 게 보여요. 확인되면 알려 드릴게요.", copyMany: "들어오는 게 {0}건 보여요. 확인되면 알려 드릴게요.", sound: "ravi.soft", motion: "nod" },
  deposit_confirmed: { emotion: "happy", priority: "money", slot: "money", holdMs: 5 * S, mergeMs: 20 * S, cooldownMs: 10 * S, copy: "입금이 확인됐어요.", copyMany: "입금 {0}건이 확인됐어요.", sound: "ravi.soft", motion: "bounce" },
  deposit_dropped:   { emotion: "worried", priority: "alert", slot: "money", holdMs: 12 * S, mergeMs: 30 * S, cooldownMs: 30 * S, copy: "확인 전 입금이 사라졌어요. 상품을 보내기 전에 기록을 확인해 주세요.", sound: "ravi.attention", motion: "none", serious: true },
  order_received:    { emotion: "happy", priority: "money", slot: "money", holdMs: 5 * S, mergeMs: 20 * S, cooldownMs: 10 * S, copy: "새 주문이 들어왔어요.", copyMany: "새 주문이 {0}건 들어왔어요.", sound: "ravi.soft", motion: "nod" },
  sale_done:         { emotion: "happy", priority: "money", slot: "money", holdMs: 5 * S, mergeMs: 20 * S, cooldownMs: 10 * S, copy: "판매가 확인됐어요.", copyMany: "판매 {0}건이 확인됐어요.", sound: "ravi.soft", motion: "bounce" },
  // 기념일 — 크게 기뻐하지만 한 번만(반짝 1회). 가림 켬이면 「몇 번째」 단서를 지운다.
  first_deposit:     { emotion: "celebrate", priority: "money", slot: "money", holdMs: 7 * S, mergeMs: 0, cooldownMs: 24 * 60 * M, copy: "첫 입금이 확인됐어요! 함께 시작해요.", sound: "ravi.bright", motion: "sparkle", masked: { emotion: "happy", copy: "좋은 소식이 확인됐어요.", motion: "bounce" } },
  first_sale:        { emotion: "celebrate", priority: "money", slot: "money", holdMs: 7 * S, mergeMs: 0, cooldownMs: 24 * 60 * M, copy: "첫 판매예요! 축하해요.", sound: "ravi.bright", motion: "sparkle", masked: { emotion: "happy", copy: "좋은 소식이 확인됐어요.", motion: "bounce" } },
  sale_milestone:    { emotion: "celebrate", priority: "money", slot: "money", holdMs: 7 * S, mergeMs: 0, cooldownMs: 60 * M, copy: "판매가 또 한 고개를 넘었어요. 축하해요!", sound: "ravi.bright", motion: "sparkle", masked: { emotion: "happy", copy: "좋은 소식이 확인됐어요.", motion: "bounce" } },

  // ── 사람(관계) ──────────────────────────────────────────────
  follower_new:      { emotion: "fond", priority: "social", slot: "social", holdMs: 4 * S, mergeMs: 60 * S, cooldownMs: 5 * M, copy: "가게를 아껴 주는 분이 생겼어요.", copyMany: "가게를 아껴 주는 분이 {0}명 생겼어요.", sound: null, motion: "nod" },
  user_thanks:       { emotion: "shy", priority: "social", slot: "talk", holdMs: 3 * S, mergeMs: 10 * S, cooldownMs: 30 * S, copy: "헤헤, 저도 고마워요.", sound: null, motion: "sway" },

  // ── 노드·장부 ───────────────────────────────────────────────
  node_syncing:      { emotion: "focused", priority: "ambient", slot: "node", holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: "장부를 따라잡고 있어요.", sound: null, motion: "none" },
  node_synced:       { emotion: "relieved", priority: "ambient", slot: "node", holdMs: 3 * S, mergeMs: 0, cooldownMs: 5 * M, copy: "장부를 다 따라잡았어요.", sound: null, motion: "settle" },
  node_down:         { emotion: "worried", priority: "alert", slot: "node", holdMs: 0, mergeMs: 0, cooldownMs: 2 * M, copy: "노드가 응답하지 않아요. 입금 확인이 늦어질 수 있어요.", sound: "ravi.attention", motion: "none", serious: true },
  node_disconnected: { emotion: "worried", priority: "alert", slot: "node", holdMs: 0, mergeMs: 0, cooldownMs: 2 * M, copy: "네트워크 연결이 끊겼어요. 입금 확인이 늦어질 수 있어요.", sound: "ravi.attention", motion: "none", serious: true },
  node_stalled:      { emotion: "worried", priority: "alert", slot: "node", holdMs: 0, mergeMs: 0, cooldownMs: 2 * M, copy: "장부 따라잡기가 멈췄어요. 잠시 기다리거나 노드를 다시 켜 주세요.", sound: "ravi.attention", motion: "none", serious: true },
  confirm_delayed:   { emotion: "worried", priority: "alert", slot: "money", holdMs: 10 * S, mergeMs: 60 * S, cooldownMs: 10 * M, copy: "확인이 평소보다 늦어요. 확인될 때까지 상품은 기다려 주세요.", sound: null, motion: "none", serious: true },
  node_recovered:    { emotion: "relieved", priority: "ambient", slot: "node", holdMs: 3 * S, mergeMs: 0, cooldownMs: 30 * S, copy: "다시 정상이에요.", sound: "ravi.soft", motion: "settle" },
  awake_lost:        { emotion: "worried", priority: "alert", slot: "node", holdMs: 0, mergeMs: 0, cooldownMs: 5 * M, copy: "컴퓨터가 잠들면 입금 확인이 멈춰요. 잠들지 않게 설정해 주세요.", sound: "ravi.attention", motion: "none", serious: true },

  // ── 보내기·구매 (돈이 나감) — 차분·진지. 축하 금지. ───────────
  send_review:       { emotion: "calm", priority: "alert", slot: "send", holdMs: 60 * S, mergeMs: 0, cooldownMs: 2 * M, copy: "보내기 전에 주소와 금액을 한 번 더 확인해 주세요.", sound: null, motion: "none", serious: true },
  send_invalid:      { emotion: "calm", priority: "alert", slot: "send", holdMs: 8 * S, mergeMs: 5 * S, cooldownMs: 0, copy: "이대로는 보낼 수 없어요. 표시된 칸을 확인해 주세요.", sound: null, motion: "none", serious: true },
  risk_warning:      { emotion: "calm", priority: "alert", slot: "send", holdMs: 30 * S, mergeMs: 0, cooldownMs: 0, copy: "주소가 원본과 달라요. 보내지 마세요.", sound: "ravi.attention", motion: "none", serious: true },
  send_closed:       { emotion: "neutral", priority: "ambient", slot: null, holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none", clears: ["send"] },
  send_done:         { emotion: "relieved", priority: "money", slot: "send", holdMs: 3 * S, mergeMs: 0, cooldownMs: 0, copy: "보냈어요. 기록에서 확인할 수 있어요.", sound: null, motion: "settle", serious: true },
  purchase_done:     { emotion: "relieved", priority: "money", slot: "send", holdMs: 3 * S, mergeMs: 0, cooldownMs: 0, copy: "구매를 마쳤어요. 라이브러리에서 볼 수 있어요.", sound: null, motion: "settle", serious: true },

  // ── 오류 — 미안해함 + 해결 안내 ─────────────────────────────
  error_generic:     { emotion: "apologetic", priority: "error", slot: "error", holdMs: 8 * S, mergeMs: 10 * S, cooldownMs: 20 * S, copy: "미안해요, 잘 안 됐어요. 잠시 뒤 다시 해 주세요.", sound: "ravi.oops", motion: "droop" },
  error_network:     { emotion: "apologetic", priority: "error", slot: "error", holdMs: 8 * S, mergeMs: 10 * S, cooldownMs: 20 * S, copy: "미안해요, 연결이 불안정해요. 인터넷을 확인한 뒤 다시 해 주세요.", sound: "ravi.oops", motion: "droop" },

  // ── 일상 ───────────────────────────────────────────────────
  idle_long:         { emotion: "sleepy", priority: "ambient", slot: "idle", holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none" },
  user_return:       { emotion: "welcome", priority: "ambient", slot: "idle", holdMs: 3 * S, mergeMs: 0, cooldownMs: 10 * M, copy: "다시 만나서 반가워요.", sound: null, motion: "nod", clears: ["idle"] },
  night_start:       { emotion: "sleepy", priority: "ambient", slot: "night", holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none" },
  night_end:         { emotion: "neutral", priority: "ambient", slot: null, holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none", clears: ["night"] },
  ai_thinking:       { emotion: "thinking", priority: "ambient", slot: "ai", holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none" },
  ai_done:           { emotion: "neutral", priority: "ambient", slot: null, holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none", clears: ["ai"] },
  ai_unknown:        { emotion: "puzzled", priority: "social", slot: "talk", holdMs: 5 * S, mergeMs: 0, cooldownMs: 0, copy: "그건 잘 모르겠어요. 모르는 건 지어내지 않을게요.", sound: null, motion: "sway", clears: ["ai"] },
  key_missing:       { emotion: "waiting", priority: "ambient", slot: "key", holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: "AI 열쇠를 넣어 주시면 대화할 수 있어요.", sound: null, motion: "none" },
  key_connected:     { emotion: "happy", priority: "social", slot: "talk", holdMs: 4 * S, mergeMs: 0, cooldownMs: 30 * S, copy: "연결됐어요! 무엇이든 물어보세요.", sound: "ravi.soft", motion: "bounce", clears: ["key"] },
  backup_done:       { emotion: "proud", priority: "social", slot: "wallet", holdMs: 5 * S, mergeMs: 0, cooldownMs: 60 * S, copy: "백업을 마쳤어요. 백업 파일은 안전한 곳에 두세요.", sound: "ravi.soft", motion: "nod" },
  wallet_locked:     { emotion: "calm", priority: "ambient", slot: "wallet", holdMs: 3 * S, mergeMs: 0, cooldownMs: 0, copy: "지갑을 잠갔어요.", sound: null, motion: "none", serious: true },
  wallet_unlocked:   { emotion: "neutral", priority: "ambient", slot: null, holdMs: 0, mergeMs: 0, cooldownMs: 0, copy: null, sound: null, motion: "none", clears: ["wallet"] },
};

export const RAVI_EVENT_NAMES = Object.keys(RULES) as RaviEventName[];

/** 들뜬(밝은) 감정 — serious 규칙에서 금지. */
export const UPBEAT: readonly RaviEmotion[] = ["happy", "celebrate", "fond", "shy", "proud", "welcome", "surprised"];
/** serious 에서 허용하는 감정. */
export const SERIOUS_OK: readonly RaviEmotion[] = ["calm", "worried", "apologetic", "relieved"];

/** 감정마다 얼굴의 「톤」 — 점 색·배경 기운. 색만으로 뜻을 전하지 않게 모양(glyph)도 함께 준다. */
export type Tone = "warm" | "calm" | "alert" | "rest" | "neutral";
export const TONE: Record<RaviEmotion, Tone> = {
  neutral: "neutral", happy: "warm", celebrate: "warm", fond: "warm", surprised: "warm", shy: "warm", proud: "warm", welcome: "warm",
  focused: "calm", thinking: "calm", calm: "calm", relieved: "calm", waiting: "calm", puzzled: "calm",
  worried: "alert", apologetic: "alert",
  sleepy: "rest", asleep: "rest",
};

/** 화면 낭독용 짧은 상태(과하지 않게 — 말풍선이 없을 때만 쓴다). */
export const EMOTION_LABEL: Record<RaviEmotion, string> = {
  neutral: "라비", happy: "라비가 기뻐해요", celebrate: "라비가 크게 기뻐해요", fond: "라비가 좋아해요",
  surprised: "라비가 눈을 크게 떴어요", focused: "라비가 집중하고 있어요", thinking: "라비가 생각하고 있어요",
  worried: "라비가 걱정해요", calm: "라비가 차분히 지켜봐요", apologetic: "라비가 미안해해요",
  sleepy: "라비가 졸려요", asleep: "라비가 자고 있어요", welcome: "라비가 반가워해요", waiting: "라비가 기다리고 있어요",
  puzzled: "라비가 곤란해해요", shy: "라비가 수줍어해요", proud: "라비가 뿌듯해해요", relieved: "라비가 안심했어요",
};
