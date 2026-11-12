/**
 * 11-10 라비가 화면 설정을 바로 바꾼다(라비+ 없이) — 글자 크기·밝기·알림 소리·언어. 대표·페이블 합의.
 *
 *  - 되돌릴 수 있는 것(글자·밝기·소리)은 **바로 바꾸고** 카드에 [되돌리기] [좋아요]. 확인 카드는 돈 보내기 같은 무게라 쓰지 않는다.
 *  - 언어만 먼저 묻는다(바꾼 뒤엔 못 읽을 수 있다) — 지금 언어로 묻고, 바꾼 뒤 [되돌리기 / Undo] 처럼 두 언어로.
 *  - 어르신은 명령보다 **불편**을 말한다: 「안 보여」「너무 작아」「눈 아파」 → 크게, 「눈부셔」 → 어둡게.
 *  - 언어는 이름을 콕 집어 말했을 때만 바꾼다.
 *  - 11-12 「한눈에 보이게 해 줘」「글자 작게」「화면 촘촘하게」 → 한 번에 「한눈에 많이」(dir: compact). 「너무 커」·zoom out 은 한 단계만 작게.
 */
export type RaviSetting =
  | { kind: "text"; dir: "up" | "down" | "compact" }
  | { kind: "theme"; to: "dark" | "light" }
  | { kind: "sound"; on: boolean }
  | { kind: "lang"; to: LangCode };
export type LangCode = "ko" | "en" | "ja" | "zh" | "it" | "es" | "fr" | "pt-BR" | "de" | "ru";

const norm = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();
const TEXT_UP = /(글자|글씨|화면|폰트).{0,6}(크게|키워|키우|확대|크면)|^(글자가?\s?|글씨가?\s?)?(잘\s?)?안\s?보(여|여요|입니다)?\s?$|(글자|글씨).{0,4}안\s?보|^(글자가?\s?|글씨가?\s?)?너무\s?작아|작아서\s?안\s?보|^눈이?\s?아파|돋보기|bigger text|larger text|text bigger|zoom in|文字を大きく|文字.{0,3}大きく|字.{0,2}大一点|放大/;
const TEXT_DOWN = /너무\s?커|zoom out|缩小/;
// 한눈에 많이 — 「잔액 한눈에 보여 줘」 같은 다른 질문은 건드리지 않게 화면·글자 말이거나 문장 처음일 때만.
const COMPACT = /(글자|글씨|화면|폰트).{0,6}(작게|줄여|줄이|축소)|(화면|글자|글씨|단추|버튼).{0,6}(촘촘|빽빽|조밀|오밀조밀)|^(화면\s?을?\s?|다\s?)?촘촘하게|^(화면\s?(을|이)?\s?|다\s?|전부\s?|모두\s?)?한눈에\s?(다\s?|많이\s?|전부\s?)?(보이게|보여|보고|볼\s?수)|한눈에\s?많이|smaller text|text smaller|文字を小さく|字.{0,2}小一点|(see|fit|show) more (at once|on (the )?screen)|compact (view|mode|layout)|コンパクト|紧凑|一屏/;
const DARK = /어둡게|다크\s?모드|눈이?\s?부셔|눈부셔|dark mode|darker|暗く|ダークモード|深色|暗一点/;
const LIGHT = /밝게|환하게|라이트\s?모드|light mode|brighter|明るく|浅色|亮一点/;
const SOUND = /(알림|이야기|대화|톡)\s?소리|소리\s?알림|notification sound|通知音|提示音/;
const OFF = /꺼|끄|없애|안\s?나게|멈춰|off|mute|オフ|消し|关/;
const ON = /켜|틀어|나게|들리게|on\b|オン|つけ|开/;
const LANGS: [LangCode, RegExp][] = [
  ["ko", /한국어|korean|韓国語|韩语/], ["en", /영어|english|英語|英语/], ["ja", /일본어|japanese|日本語|日语/], ["zh", /중국어|chinese|中国語|中文|汉语/],
  ["it", /이탈리아어|italian/], ["es", /스페인어|spanish/], ["fr", /프랑스어|french/], ["pt-BR", /포르투갈어|portuguese/], ["de", /독일어|german/], ["ru", /러시아어|russian/],
];
const LANG_ASK = /로\s?(바꿔|바꾸|해\s?줘|보여|설정)|(switch|change).{0,12}(to|into)|in (english|korean|japanese|chinese)|に(して|変え)|切换|改成/;

/** 설정을 바꾸라는 말인가. 아니면 null(다른 라비 길로). */
export function raviSettingIntent(q: string): RaviSetting | null {
  const s = norm(q);
  if (!s || s.length > 60) return null;
  if (SOUND.test(s)) { if (OFF.test(s)) return { kind: "sound", on: false }; if (ON.test(s)) return { kind: "sound", on: true }; }
  if (TEXT_UP.test(s)) return { kind: "text", dir: "up" };
  if (COMPACT.test(s)) return { kind: "text", dir: "compact" };
  if (TEXT_DOWN.test(s)) return { kind: "text", dir: "down" };
  if (DARK.test(s)) return { kind: "theme", to: "dark" };
  if (LIGHT.test(s)) return { kind: "theme", to: "light" };
  if (LANG_ASK.test(s)) {
    const hit = LANGS.filter(([, re]) => re.test(s));
    if (hit.length === 1) return { kind: "lang", to: hit[0][0] };
  }
  return null;
}
