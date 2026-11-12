/**
 * 11-12 왼쪽 줄 연결 표시 — 한 줄에 「점 + 짧은 이름」 하나(대표: 「RVN / 노드 / 켜짐」 세 줄로 접혀 읽을 수 없었다).
 *
 *  - 이름은 짧게: 노드 · 채굴 · IPFS · 릴레이 · 바깥 연결 · 지도. 켜짐·꺼짐은 **점 색**이 말한다(초록 켜짐 · 회색 꺼짐 · 주황 따라잡는 중 · 빨강 노드 꺼짐).
 *  - 따라잡는 동안만 「노드 87%」처럼 숫자를 붙인다(끝이 보여야 기다린다).
 *  - 색만으로 말하지 않는다 — 자세한 말(「장부 다 받음 · 결제 확인 바로 됨」)은 title 과 aria-label 에 늘 있다.
 * 순수 함수라 DOM 없이 시험한다(scripts/rail-status.test.mjs).
 */
import "./rail-status.css";

export type RailTone = "ok" | "quiet" | "warn" | "bad";
export type RailLine = {
  /** 줄에 보이는 짧은 이름(한국어 열쇠). pct 가 있으면 "노드 {0}%" 틀이다. */
  label: string;
  pct?: string;
  /** 켜짐/꺼짐과 뜻을 담은 긴 말(한국어 열쇠) — title·aria-label. */
  detail: string;
  /** 사람에게 덧붙일 이유(한국어 열쇠, 없으면 ""). */
  why: string;
  on: boolean;
  tone: RailTone;
};

export type NodeState = { kind: "ok" } | { kind: "sync"; pct: number } | { kind: "warm" } | { kind: "down" };

export function nodeLine(s: NodeState): RailLine {
  if (s.kind === "ok") return { label: "노드", detail: "RVN 노드 켜짐", why: "장부 다 받음 · 결제 확인 바로 됨", on: true, tone: "ok" };
  if (s.kind === "sync") {
    // 99.96% 를 반올림해 「100%」로 적으면 다 된 줄 안다 — 내림으로 적는다.
    const pct = String(Math.max(0, Math.min(99, Math.floor(s.pct))));
    return { label: "노드 {0}%", pct, detail: "RVN 노드 따라잡는 중", why: "따라잡는 중이에요. 방금 들어온 돈이 늦게 보일 수 있어요.", on: true, tone: "warn" };
  }
  if (s.kind === "warm") return { label: "노드", detail: "RVN 노드 여는 중", why: "장부를 여는 중이에요. 처음이면 몇 분 걸려요.", on: true, tone: "warn" };
  return { label: "노드 꺼짐", detail: "RVN 노드 꺼짐 · 눌러서 켜기", why: "노드가 꺼져 있어 잔액·입금 확인·보내기가 멈춰 있어요.", on: false, tone: "bad" };
}

type Simple = "mine" | "ipfs" | "relay" | "out" | "map";
const SIMPLE: Record<Simple, { label: string; on: string; off: string }> = {
  mine: { label: "채굴", on: "채굴 켜짐", off: "채굴 꺼짐" },
  ipfs: { label: "IPFS", on: "IPFS 켜짐", off: "IPFS 꺼짐" },
  relay: { label: "릴레이", on: "릴레이 켜짐", off: "릴레이 꺼짐" },
  out: { label: "바깥 연결", on: "바깥 연결 켜짐", off: "바깥 연결 꺼짐" },
  map: { label: "지도", on: "지도: 올림", off: "지도: 안 올림" },
};
export function simpleLine(kind: Simple, on: boolean): RailLine {
  const s = SIMPLE[kind];
  return { label: s.label, detail: on ? s.on : s.off, why: "", on, tone: on ? "ok" : "quiet" };
}
