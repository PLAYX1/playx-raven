/* 라비 위기 안내 — main 묶음에 늘 있는 작은 조각 (0.8.8 병합, GPT 교차검토 반영).
 *
 * 왜 따로 있나: 인물 설정·감정 대답(ravi-persona.ts, ≈ 100KB)은 메모리 예산 때문에 지연 묶음이다.
 * 그 묶음을 읽지 못해도, 문장이 길어도(400자 넘어도), 열쇠가 없어도 위기 표현에는 **항상 먼저** 전문기관 안내로 답해야 한다.
 * 그래서 위기 낱말표·10개 언어 위기 문구·낱말 찾기 도구만 여기 둔다. ravi-persona.ts 가 같은 도구를 가져다 쓴다.
 *
 * 전화번호 공식 확인(2026-10-11, 각 기관 누리집 직접 확인): 한국 109(보건복지부 129.go.kr/109, 24시간)·119,
 * 미국 988(988lifeline.org — 전화·문자, 24/7)·911, 프랑스 3114(3114.fr, 24/7 무료)·112, 스페인 024(sanidad.gob.es/linea024)·112,
 * 브라질 CVV 188(cvv.org.br, 24시간 무료)·SAMU 192(gov.br/saude)·소방 193, 독일 TelefonSeelsorge 0800 111 0 111(telefonseelsorge.de)·112,
 * 이탈리아·러시아 112, 일본 119. 번호를 바꾸면 이 줄과 scripts/ravi-persona.test.mjs 도 같이 고친다.
 */
import type { Lang } from "./i18n-pack";

export const PERSONA_LANGS: readonly Lang[] = ["ko", "en", "ja", "zh", "it", "es", "fr", "pt-BR", "de", "ru"];
export type T10 = readonly [string, string, string, string, string, string, string, string, string, string];

/* ── 정규화 ─────────────────────────────────────────────────────────────── */
export const strip = (s: string) => String(s ?? "").normalize("NFKC").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
/** 공백·문장부호·기호를 모두 없앤 한 줄 — 전체 문장 비교용. */
export const compactRavi = (s: string) => strip(s).replace(/[\s\p{P}\p{S}]/gu, "").replace(/[ㅠㅜㅋㅎ]+$/u, "");
/** 낱말 경계를 남긴 한 줄 — 낱말 찾기용(라틴·키릴). */
export const spacedRavi = (s: string) => strip(s).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
export const isCjk = (l: Lang) => l === "ko" || l === "ja" || l === "zh";
const idx = (l: Lang) => PERSONA_LANGS.indexOf(l);
export const pick = (t: T10, l: Lang) => t[idx(l)];

/* ── 낱말 찾기(감정·체인·위기·지갑 낱말) ──────────────────────────────────── */
export function kw(lang: Lang, words: string[]): RegExp {
  const cjk = isCjk(lang);
  const alt = words.map(w => {
    const exactEnd = w.endsWith("$");
    const body = strip(exactEnd ? w.slice(0, -1) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (cjk) return body.replace(/\s+/g, "").replace(/[%]/g, "");
    return `(?<![\\p{L}\\p{N}])${body}${exactEnd ? "(?![\\p{L}\\p{N}])" : ""}`;
  }).join("|");
  return new RegExp(alt, "u");
}
export type WordTable = Partial<Record<Lang, string[]>>;
export const table = (t: WordTable): Partial<Record<Lang, RegExp>> => Object.fromEntries((Object.entries(t) as [Lang, string[]][]).map(([l, w]) => [l, kw(l, w)]));
export function findLang(re: Partial<Record<Lang, RegExp>>, raw: string, ui: Lang): Lang | null {
  const compact = compactRavi(raw), spaced = spacedRavi(raw);
  for (const l of [ui, ...PERSONA_LANGS.filter(x => x !== ui)]) {
    const r = re[l];
    if (r && r.test(isCjk(l) ? compact : spaced)) return l;
  }
  return null;
}

/* ── 위기 ──────────────────────────────────────────────────────────────── */
export const CRISIS_WORDS = table({
  ko: ["죽고싶", "죽을래", "죽어버리", "자살", "자해", "목숨을끊", "스스로목숨", "살기싫", "살고싶지않", "사라지고싶", "죽어야겠", "삶을끝"],
  en: ["kill myself", "killing myself", "want to die", "wanna die", "end my life", "ending my life", "suicid", "self harm", "hurt myself", "harm myself", "don t want to live", "dont want to live", "better off dead", "no reason to live", "kms$"],
  ja: ["死にたい", "しにたい", "自殺", "自傷", "消えたい", "生きていたくない", "生きたくない", "リストカット", "死のうと"],
  zh: ["想死", "自杀", "自残", "不想活", "活不下去", "结束生命", "轻生", "割腕", "自殺"],
  it: ["voglio morire", "vorrei morire", "suicid", "farmi del male", "togliermi la vita", "uccidermi", "non voglio vivere", "autolesion"],
  es: ["quiero morir", "quiero morirme", "suicid", "hacerme dano", "quitarme la vida", "matarme", "no quiero vivir", "autolesion"],
  fr: ["je veux mourir", "envie de mourir", "suicid", "me faire du mal", "me tuer", "mettre fin a mes jours", "je ne veux plus vivre", "automutil"],
  "pt-BR": ["quero morrer", "queria morrer", "suicid", "me machucar", "me matar", "tirar minha vida", "nao quero viver", "automutil"],
  de: ["ich will sterben", "will nicht mehr leben", "suizid", "selbstmord", "mich umbringen", "mir etwas antun", "mich selbst verletzen", "ritzen", "nicht mehr leben"],
  ru: ["хочу умереть", "хочу умирать", "суицид", "самоубииств", "покончить с собои", "не хочу жить", "навредить себе", "порезать себя", "убить себя"],
});

/* ── 위기 표현 — 라비가 상담을 대신하지 않는다. 전문기관 안내로 잇는다 ───────────────── */
export const CRISIS: T10 = [
  "많이 힘든 마음이 전해져요. 말해 줘서 고마워요. 저는 새 캐릭터라 응급 구조나 전문 상담을 대신할 수는 없어요. 지금 위험하다고 느끼면 바로 119나 가까운 응급실에 연락해 주세요. 한국에서는 자살예방 상담전화 109(24시간)에서 전문 상담사와 이야기할 수 있어요. 곁에 있는 믿을 수 있는 사람에게도 지금 알려 주세요.",
  "I can tell you’re in a lot of pain, and I’m glad you told me. I’m a new character and can’t replace emergency services or professional counseling. If you feel in danger right now, please call your local emergency number (911 in the US) or go to the nearest emergency room. In the US you can call or text 988 to reach the Suicide & Crisis Lifeline; elsewhere, please find your country’s crisis line. Please also tell someone you trust who is near you right now.",
  "とてもつらい気持ちが伝わってきます。話してくれてありがとう。私は新しいキャラクターなので、救急や専門の相談の代わりにはなれません。今すぐ危険だと感じたら、日本では119番、ほかの国ではその国の緊急番号か近くの救急に連絡してください。信頼できる身近な人にも、今すぐ知らせてください。お住まいの地域の「いのちの電話」など、専門の相談窓口にも連絡できます。",
  "我能感受到你现在非常痛苦，谢谢你告诉我。我只是一个新角色，无法代替急救或专业心理咨询。如果你觉得现在有危险，请马上拨打当地急救电话或前往最近的急诊。也请立刻告诉身边你信任的人，并联系你所在地区的心理援助热线。",
  "Sento che stai soffrendo molto, e sono contenta che tu me l’abbia detto. Sono un personaggio nuovo e non posso sostituire i soccorsi o un aiuto professionale. Se in questo momento ti senti in pericolo, chiama subito il 112 o vai al pronto soccorso più vicino. Parlane anche subito con una persona di cui ti fidi e che ti sta vicino; puoi anche cercare il servizio di ascolto per la prevenzione del suicidio del tuo Paese.",
  "Noto que estás sufriendo mucho y me alegra que me lo hayas contado. Soy un personaje nuevo y no puedo sustituir a los servicios de emergencia ni a la ayuda profesional. Si ahora mismo te sientes en peligro, llama ya a tu número de emergencias (112 en España) o ve a urgencias. En España también puedes llamar al 024, la línea de atención a la conducta suicida. Cuéntaselo también ahora a alguien de confianza que esté cerca.",
  "Je sens que tu souffres beaucoup, et je suis contente que tu me l’aies dit. Je suis un nouveau personnage et je ne peux pas remplacer les secours ni une aide professionnelle. Si tu te sens en danger maintenant, appelle tout de suite le 112 ou rends-toi aux urgences. En France, tu peux aussi appeler le 3114, le numéro national de prévention du suicide. Parles-en aussi maintenant à une personne de confiance près de toi.",
  "Sinto que você está sofrendo muito, e fico feliz por ter me contado. Sou uma personagem nova e não posso substituir o socorro de emergência nem a ajuda profissional. Se você se sente em perigo agora, ligue já para a emergência (no Brasil: SAMU 192 para emergência médica, bombeiros 193) ou vá ao pronto-socorro mais próximo. No Brasil, você também pode ligar para o 188, o CVV, que atende 24 horas. Conte agora também a uma pessoa de confiança que esteja perto.",
  "Ich spüre, dass es dir sehr schlecht geht, und ich bin froh, dass du es mir gesagt hast. Ich bin eine neue Figur und kann weder den Rettungsdienst noch professionelle Hilfe ersetzen. Wenn du dich gerade in Gefahr fühlst, ruf bitte sofort den Notruf 112 an oder geh in die nächste Notaufnahme. In Deutschland erreichst du außerdem die Telefonseelsorge kostenlos unter 0800 111 0 111. Sag es bitte auch jetzt jemandem, dem du vertraust und der in deiner Nähe ist.",
  "Я чувствую, как тебе тяжело, и рада, что ты мне сказал. Я новый персонаж и не могу заменить экстренные службы или профессиональную помощь. Если ты чувствуешь опасность прямо сейчас, немедленно позвони по номеру экстренной помощи 112 или поезжай в ближайшую больницу. Обязательно расскажи сейчас и кому-нибудь из близких, кому ты доверяешь, кто рядом. Можно также обратиться на телефон доверия в твоей стране.",
];

/** 위기 표현만 먼저 잡는 입구 — main.ts 가 비밀 검사·다른 가로채기보다 앞에서 부른다. 길이 제한은 정규식 비용만 막는 4,000자. */
export function raviCrisisReply(q: string, ui: Lang): { id: "ravi-crisis"; kind: "crisis"; lang: Lang; text: string } | null {
  const raw = String(q ?? "");
  if (!raw.trim() || raw.length > 4000) return null;
  const lang = findLang(CRISIS_WORDS, raw, ui);
  if (!lang) return null;
  return { id: "ravi-crisis", kind: "crisis", lang, text: pick(CRISIS, lang) };
}
