//! Nostr — 물건 하나하나가 사는 곳.
//!
//! ## 왜 체인이 아니라 여기인가
//!
//! 가게는 체인에 있어야 한다. 이름이 영구히 남아야 하고, 500 RVN 소각이
//! 진입장벽이자 진지함의 증거다. 하지만 **물건 하나는 다르다** — 자전거 한
//! 대를 올릴 때마다 RVN 이 타면 아무도 안 쓴다. 팔리면 사라져도 되고, 하루에
//! 열 번 고쳐도 되는 것이다. 그런 것을 체인에 쓰는 것은 낭비가 아니라 오용이다.
//!
//! 그래서 셋으로 나눈다:
//!   체인   — 가게의 신원과 돈
//!   Nostr  — 물건, 문의
//!   IPFS   — 사진
//!
//! ## 우리가 처음 여는 판이 아니다
//!
//! NIP-99(kind 30402, 물건 올리기)는 이미 도는 표준이고, 실측으로 공개 릴레이
//! 세 곳에서 매물이 나오는 것을 확인했다. 우리 물건도 그 릴레이들에 올라가고,
//! 다른 Nostr 앱에서도 보인다. 우리 앱 안에서만 도는 장터였다면 그건 그냥
//! 우리 서버를 파일 대신 릴레이로 부르는 것뿐이었을 것이다.
//!
//! ## 릴레이는 우체국이지 창고가 아니다
//!
//! 여러 곳에 같이 보낸다. 한 곳이 막아도 나머지로 간다. 우리 노드도 나중에
//! 릴레이 하나를 돌릴 수 있지만, 그때도 **공개 릴레이를 함께 쓴다** — 우리만
//! 쓰면 우리가 문을 닫을 때 장터도 같이 닫힌다.

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/** 물건 올리기. NIP-99. */
export const KIND_LISTING = 30402;
/** 1:1 문의. NIP-17 의 안쪽 봉투. */
export const KIND_DM = 14;

/** 기본 릴레이. 실측으로 매물이 나오는 것을 확인한 곳들이다. */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/** 서명 전의 알맹이. */
export type Draft = Omit<NostrEvent, "id" | "pubkey" | "sig">;

/**
 * 이벤트 id — 정해진 순서로 배열을 만들어 sha256.
 *
 * 순서와 공백이 한 글자만 달라도 다른 id 가 나오고, 그러면 릴레이가 서명이
 * 틀렸다며 조용히 버린다. JSON.stringify 의 기본 동작이 이 규격과 같아서
 * 그대로 쓰되, 배열 순서는 절대 바꾸지 않는다.
 */
export function eventId(pubkey: string, d: Draft): string {
  const serial = JSON.stringify([0, pubkey, d.created_at, d.kind, d.tags, d.content]);
  return bytesToHex(sha256(utf8ToBytes(serial)));
}

/** 32바이트 비밀키에서 공개키(x좌표 32바이트). */
export function pubkeyOf(sec: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sec));
}

export function signEvent(sec: Uint8Array, d: Draft): NostrEvent {
  const pubkey = pubkeyOf(sec);
  const id = eventId(pubkey, d);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sec));
  return { ...d, id, pubkey, sig };
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (eventId(e.pubkey, e) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

/** 태그에서 값 하나 꺼내기. 없으면 빈 문자열. */
export function tag(e: NostrEvent, name: string): string {
  const t = e.tags.find((x) => x[0] === name);
  return t && t[1] ? t[1] : "";
}

/**
 * 여러 릴레이에 같은 질문을 던지고 답을 합친다.
 *
 * 한 곳이 느리거나 막혀도 나머지가 답한다 — 그게 릴레이를 여러 개 쓰는
 * 이유다. 같은 이벤트가 여러 곳에서 오므로 id 로 걸러 낸다.
 */
export function query(
  filter: Record<string, unknown>,
  opts: { relays?: string[]; ms?: number } = {},
): Promise<NostrEvent[]> {
  const relays = opts.relays || DEFAULT_RELAYS;
  const ms = opts.ms ?? 6000;
  const seen = new Map<string, NostrEvent>();

  return new Promise((resolve) => {
    let left = relays.length;
    const done = () => {
      if (--left <= 0) finish();
    };
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      // 최신 것이 위로. 장터에서 오래된 매물이 먼저 보이면 죽은 장터로 읽힌다.
      resolve([...seen.values()].sort((a, b) => b.created_at - a.created_at));
    };
    const timer = setTimeout(finish, ms);

    for (const url of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        done();
        continue;
      }
      const sub = "q" + Math.random().toString(36).slice(2, 9);
      const close = () => {
        try { ws.close(); } catch { }
        done();
      };
      ws.onopen = () => ws.send(JSON.stringify(["REQ", sub, filter]));
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data));
          if (msg[0] === "EVENT" && msg[1] === sub) {
            const e = msg[2] as NostrEvent;
            // 릴레이를 믿지 않는다. 서명을 우리가 확인한다 — 안 하면 릴레이가
            // 아무 이름으로나 매물을 지어낼 수 있다.
            if (verifyEvent(e)) seen.set(e.id, e);
          } else if (msg[0] === "EOSE" && msg[1] === sub) {
            close();
          }
        } catch { }
      };
      ws.onerror = close;
      ws.onclose = () => done();
    }

    // 타이머가 이미 걸려 있으니, 전부 실패해도 ms 뒤에는 반드시 끝난다.
    void timer;
  });
}

/** 여러 릴레이에 같이 보낸다. 한 곳이라도 받으면 성공이다. */
export function publish(
  e: NostrEvent,
  opts: { relays?: string[]; ms?: number } = {},
): Promise<{ ok: string[]; failed: string[] }> {
  const relays = opts.relays || DEFAULT_RELAYS;
  const ms = opts.ms ?? 8000;
  const ok: string[] = [];
  const failed: string[] = [];

  return new Promise((resolve) => {
    let left = relays.length;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      resolve({ ok, failed });
    };
    const done = () => {
      if (--left <= 0) finish();
    };
    setTimeout(finish, ms);

    for (const url of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        failed.push(url);
        done();
        continue;
      }
      ws.onopen = () => ws.send(JSON.stringify(["EVENT", e]));
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data));
          if (msg[0] === "OK" && msg[1] === e.id) {
            // 릴레이가 거절한 이유를 그대로 들고 온다. "실패" 만 보여 주면
            // 사장은 다시 눌러 보고, 같은 매물이 두 번 올라간다.
            (msg[2] ? ok : failed).push(msg[2] ? url : `${url}: ${msg[3] || "거절"}`);
            try { ws.close(); } catch { }
            done();
          }
        } catch { }
      };
      ws.onerror = () => {
        failed.push(url);
        try { ws.close(); } catch { }
        done();
      };
    }
  });
}
