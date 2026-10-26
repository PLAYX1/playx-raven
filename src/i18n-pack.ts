/* 유럽어 여섯(it · es · fr · pt-BR · de · ru)의 지연 로드 사전. DOM·DICT 에 기대지 않는다(시험에서 그대로 번들된다).
 *
 * 사전은 코드에 넣지 않고 public/i18n/<말>.json 으로 둔다 — 그 말을 고른 사람만 읽는다.
 * (번들·CSS 예산을 건드리지 않고, 고르지 않은 말의 글자 수만큼 메모리도 안 쓴다.)
 * 열쇠 = 한국어 원문(DICT 와 같다). 사전에 없는 문구는 영어로 내려간다 — 합의 못 받은 돈·보안·법적 문구가 여기 해당한다.
 */
export type CoreLang = "ko" | "en" | "ja" | "zh";
export type PackLang = "it" | "es" | "fr" | "pt-BR" | "de" | "ru";
export type Lang = CoreLang | PackLang;
/** 앱 언어 선택 목록(순서 = 화면 순서). */
export const LANGS: readonly Lang[] = ["ko", "en", "ja", "zh", "it", "es", "fr", "pt-BR", "de", "ru"];
export const PACK_LANGS: readonly PackLang[] = ["it", "es", "fr", "pt-BR", "de", "ru"];
export const isPackLang = (l: unknown): l is PackLang => typeof l === "string" && (PACK_LANGS as readonly string[]).includes(l);
/** 자기 사전이 따로 있는 곳(라비 대화·홍보·인쇄 등 네 나라 말만 아는 곳)에 넘길 말. 유럽어는 영어로 내려간다. */
export const coreLang = (l: string): CoreLang => (l === "ko" || l === "en" || l === "ja" || l === "zh" ? l : "en");

type Pack = { dict: Record<string, string>; voice: Record<string, string> };
const packs: Partial<Record<PackLang, Pack>> = {};
const packLoading: Partial<Record<PackLang, Promise<boolean>>> = {};

/** 사전 파일을 읽는다. 읽기 전에는 영어로 나오고, 읽지 못하면 false. */
export function loadPack(l: string): Promise<boolean> {
  if (!isPackLang(l)) return Promise.resolve(true);
  if (packs[l]) return Promise.resolve(true);
  return (packLoading[l] ??= fetch(`/i18n/${l}.json`, { cache: "force-cache" })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: Pack) => {
      if (!j || typeof j.dict !== "object") throw new Error("bad pack");
      packs[l] = { dict: j.dict, voice: j.voice || {} };
      return true;
    })
    .catch(() => { delete packLoading[l]; return false; }));
}
/**
 * 켤 때만 쓰는 동기 읽기. 이 앱의 첫 화면은 켜지는 순간 한 번 그리는 글자가 많고(잔액 칩·요약) 시작 코드가 DOMContentLoaded 에 걸려 있어서,
 * 사전을 비동기로 기다리면 영어로 굳거나 시작이 어긋난다. 같은 앱 안의 파일(CSP 'self')이라 수 ms 이고, 유럽어를 저장해 둔 사람만 한 번 읽는다.
 */
export function loadPackSync(l: string): boolean {
  if (!isPackLang(l)) return true;
  if (packs[l]) return true;
  try {
    const x = new XMLHttpRequest();
    x.open("GET", `/i18n/${l}.json`, false);
    x.send();
    if (x.status !== 200 && x.status !== 0) return false;
    const j = JSON.parse(x.responseText) as Pack;
    if (!j || typeof j.dict !== "object") return false;
    packs[l] = { dict: j.dict, voice: j.voice || {} };
    return true;
  } catch {
    return false;
  }
}
export const packLoaded = (l: string): boolean => isPackLang(l) && !!packs[l];
/** 유럽어 사전의 번역(없으면 undefined → 부르는 쪽이 영어로 내린다). 유럽어가 아니면 undefined. */
export function packText(l: string, s: string): string | undefined {
  return isPackLang(l) ? packs[l]?.dict[s] : undefined;
}
/** 라비 음성 받아쓰기 문구(ravi-voice-copy). */
export function packVoice(l: string, key: string): string | undefined {
  return isPackLang(l) ? packs[l]?.voice[key] : undefined;
}
/** 시험용: 사전 객체를 직접 심는다. */
export function __setPackForTest(l: PackLang, dict: Record<string, string>, voice: Record<string, string> = {}) { packs[l] = { dict, voice }; }
