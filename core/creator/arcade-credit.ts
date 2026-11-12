/*
 * 오락실 「한 판 넣기」(동전 넣고 하는 게임) 통로 — 게임 iframe ⇄ 지갑 화면 사이 postMessage 약속 v1. 순수 함수만(창·결제 없음). (2026-11-13, 대표 결정)
 *
 * 대표 결정: 오락실 게임은 오락실처럼 **한 판마다 RVN 을 넣는다.** 상품 문서 priceSats = 한 판 값(이미 그 뜻 — arcade-product.ts).
 *   · 미리 넣어 두는 돈(충전·잔액·크레딧 저장)은 없다. 한 판 = 사람이 확인한 결제 한 번 = 크레딧 한 개, 바로 그 판에 쓴다.
 *   · 자동 결제 없음. 「넣기」는 지갑 화면이 사람에게 묻고, 지갑이 원래 요구하는 인증(암호·지문)을 지난다.
 *   · 무료 게임(priceSats "0")은 묻지 않고 크레딧을 준다(빈도 제한은 같다).
 *
 * 메시지(모두 정확히 이 모양 — 다른 칸이 있거나 값이 틀리면 버린다):
 *   게임 → 지갑   { type:'rv-arcade', v:1, ask:'credit' }                                  한 판 넣어 주세요
 *                 { type:'rv-arcade', v:1, event:'over', playId:<32 hex>, score?:<유한 수> }   이 판 끝(점수는 선택)
 *   지갑 → 게임   { type:'rv-arcade', v:1, credit:true,  playId:<32 hex> }                 넣었어요 — 이 playId 로 한 판
 *                 { type:'rv-arcade', v:1, credit:false, reason:'declined'|'busy'|'failed'|'too-fast' }
 * 받는 쪽 확인(지갑): event.source === 그 게임 iframe 의 contentWindow 일 때만(sandbox 라 origin 은 'null'). 그 밖의 메시지는 조용히 무시.
 * 빈도: 묻는 중이면 둘째 ask 는 'busy', 마지막 ask 뒤 1.5초 안이면 'too-fast', 1분에 10번 넘으면 'too-fast'.
 */
export const ARCADE_MSG_TYPE = 'rv-arcade';
export const ARCADE_MSG_V = 1;
export const ASK_MIN_GAP_MS = 1500;
export const ASK_MAX_PER_MIN = 10;
const PLAY_ID = /^[a-f0-9]{32}$/;

export type GameMessage = { kind: 'ask' } | { kind: 'over'; playId: string; score: number | null };
export type DenyReason = 'declined' | 'busy' | 'failed' | 'too-fast';
export type HostMessage =
  | { type: typeof ARCADE_MSG_TYPE; v: typeof ARCADE_MSG_V; credit: true; playId: string }
  | { type: typeof ARCADE_MSG_TYPE; v: typeof ARCADE_MSG_V; credit: false; reason: DenyReason };

const plainObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const keysAre = (o: Record<string, unknown>, keys: string[]) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === [...keys].sort()[i]); };

/** 게임이 보낸 것 → 아는 모양이면 그 뜻, 아니면 null(무시). */
export function parseGameMessage(data: unknown): GameMessage | null {
  if (!plainObject(data) || data.type !== ARCADE_MSG_TYPE || data.v !== ARCADE_MSG_V) return null;
  if (data.ask === 'credit' && keysAre(data, ['type', 'v', 'ask'])) return { kind: 'ask' };
  if (data.event === 'over' && typeof data.playId === 'string' && PLAY_ID.test(data.playId)) {
    if (keysAre(data, ['type', 'v', 'event', 'playId'])) return { kind: 'over', playId: data.playId, score: null };
    if (keysAre(data, ['type', 'v', 'event', 'playId', 'score']) && typeof data.score === 'number' && Number.isFinite(data.score)) return { kind: 'over', playId: data.playId, score: data.score };
  }
  return null;
}

export const creditMessage = (playId: string): HostMessage => {
  if (!PLAY_ID.test(playId)) throw new Error('arcade-play-id');
  return { type: ARCADE_MSG_TYPE, v: ARCADE_MSG_V, credit: true, playId };
};
export const denyMessage = (reason: DenyReason): HostMessage => ({ type: ARCADE_MSG_TYPE, v: ARCADE_MSG_V, credit: false, reason });

/** 32자리 16진 playId. random = 바이트를 채우는 함수(crypto.getRandomValues). */
export function newPlayId(random: (n: number) => Uint8Array): string {
  const b = random(16);
  if (b.length !== 16) throw new Error('arcade-random');
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 한 게임 화면의 「넣기」 문지기 — 미리 넣은 돈을 들고 있지 않는다(열린 판 하나의 playId 만 기억).
 *   ask(now)  → 'ok'(물어도 된다) | 'busy' | 'too-fast'
 *   settle()  → 묻기가 끝남(넣었든 그만뒀든)
 *   grant(id) → 이 판 시작(열린 판 = id). over(id) → 그 판이면 닫는다(true), 아니면 무시(false).
 */
export function creditGate() {
  let asking = false, last = -Infinity, open: string | null = null;
  const recent: number[] = [];
  return {
    ask(now: number): 'ok' | 'busy' | 'too-fast' {
      if (asking) return 'busy';
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      if (now - last < ASK_MIN_GAP_MS || recent.length >= ASK_MAX_PER_MIN) return 'too-fast';
      asking = true; last = now; recent.push(now);
      return 'ok';
    },
    settle() { asking = false; },
    grant(playId: string) { open = playId; },
    over(playId: string): boolean { if (open !== playId) return false; open = null; return true; },
    get openPlay() { return open; },
    get asking() { return asking; },
  };
}
