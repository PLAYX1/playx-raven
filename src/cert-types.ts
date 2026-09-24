/**
 * 증서 명단 — 한 번에 여러 장(표 올리기·붙여넣기·사진 짝짓기)에서 함께 쓰는 모양.
 *
 * 열은 PLAY X 인증 과정 수료증(Q1)의 입력 표와 맞춘다:
 *   받는 사람 · 과정 · 등급 · 발급일 · 번호  (+ 사진 파일명 · 비고)
 * 나중에 그 수료증도 이 발행기로 한 번에 찍을 수 있게.
 */

export type RosterField = "recipient" | "course" | "grade" | "date" | "number" | "photo" | "note";

/** 명단 한 줄. 빈 칸은 "". 날짜는 알아들었으면 YYYY-MM-DD, 못 알아들었으면 적힌 그대로. */
export type RosterRow = Record<RosterField, string>;

export const ROSTER_FIELDS: readonly RosterField[] = ["recipient", "course", "grade", "date", "number", "photo", "note"];

/** 표 머리글·확인 표에 쓰는 한국어 이름(번역은 i18n 이 원문으로 찾는다). */
export const ROSTER_LABELS: Record<RosterField, string> = {
  recipient: "받는 사람",
  course: "과정",
  grade: "등급",
  date: "발급일",
  number: "번호",
  photo: "사진 파일명",
  note: "비고",
};

/** 한 번에 받는 최대 줄 수. 넘으면 나눠서 올리게 한다. */
export const MAX_ROSTER_ROWS = 500;

/** 받는 사람 이름 글자 수 한도(증서에 들어가는 한도). */
export const MAX_RECIPIENT_CHARS = 40;
/** 과정·내용 글자 수 한도. */
export const MAX_COURSE_CHARS = 80;
/** 등급·번호 글자 수 한도 — 러스트(create_history clean_details)와 같다. 넘으면 발행 도중 한 묶음이 통째로 멈춘다. */
export const MAX_GRADE_CHARS = 30;
export const MAX_NUMBER_CHARS = 40;
/** 발급일로 받는 해 — 러스트 valid_ymd(2000~2200)와 날짜 읽기(~2199) 둘 다 받는 범위. */
export const MIN_ISSUE_YEAR = 2000;
export const MAX_ISSUE_YEAR = 2199;

/** 올린 표 원본 — 머리글 한 줄 + 나머지 줄(칸은 모두 글자). */
export type RawTable = { headers: string[]; rows: string[][] };

/** 머리글 → 열 번호. 못 찾은 칸은 -1. */
export type RosterMapping = Record<RosterField, number>;

/**
 * 줄마다의 문제.
 * - error: 그 줄은 발행에서 뺀다(고치면 다시 들어간다).
 * - warn: 발행은 되지만 사람이 한 번 보면 좋은 것.
 */
export type RowProblem = {
  field: RosterField | "row";
  level: "error" | "warn";
  code: "empty-name" | "too-long" | "duplicate" | "bad-date" | "date-range" | "no-photo" | "photo-not-found" | "long-name"
    /** 확인 표가 덧붙이는 것 — 이미 발행한 줄 · 라비가 확실히 못 읽은 줄 · 사진을 못 읽음 · 사진 칸이 빔. */
    | "issued" | "unsure" | "photo-bad" | "photo-missing";
  message: string;
};
