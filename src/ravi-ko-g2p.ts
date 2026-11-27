// 라비 작은 목소리(한국어 ko-v2) 앞단 — 글 → 읽는 말 → 음소 번호.
// 🔴 학습 쪽 ~/ravenvault-assets/ravi-tiny-tts/scripts/normalize_ko.py · ravi_g2p.py(ko) 를 한 줄씩 옮긴 것.
//    둘이 다르면 모델이 엉뚱하게 읽는다 → scripts/ravi-ko-g2p.test.mjs 가 학습 문장 전부를 파이썬 결과와 맞춰 본다.
//    번호 표 순서는 절대 바꾸지 않는다(학습과 앱 사이의 약속).

const SINO_DIGITS = "영일이삼사오육칠팔구";
const NATIVE_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const NATIVE_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
const NATIVE_COUNTERS = ["개", "명", "번", "살", "잔", "마리", "시간", "시", "장", "권", "곳", "가지", "판", "통", "분께", "대"];
const LATIN: Record<string, string> = {
  "RVN": "알브이엔", "QR": "큐알", "PIN": "핀", "AI": "에이아이", "PC": "피씨", "URL": "유알엘",
  "PLAY X": "플레이 엑스", "OK": "오케이", "SNS": "에스엔에스", "ID": "아이디", "NFT": "엔에프티",
  "KB": "킬로바이트", "MB": "메가바이트", "GB": "기가바이트", "Wi-Fi": "와이파이",
};
const LETTER_NAMES = ["에이 ", "비 ", "씨 ", "디 ", "이 ", "에프 ", "지 ", "에이치 ", "아이 ", "제이 ", "케이 ", "엘 ", "엠 ", "엔 ", "오 ", "피 ", "큐 ", "알 ", "에스 ", "티 ", "유 ", "브이 ", "더블유 ", "엑스 ", "와이 ", "제트 "];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
// 파이썬 sorted(key=len, reverse=True) 는 같은 길이끼리 원래 순서를 지킨다(안정 정렬) — JS sort 도 안정 정렬.
const byLenDesc = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length);

function sinoUnder10000(n: number): string {
  let s = "";
  for (const [size, name] of [[1000, "천"], [100, "백"], [10, "십"]] as const) {
    const d = Math.floor(n / size); n %= size;
    if (d) s += (d === 1 ? "" : SINO_DIGITS[d]) + name;
  }
  if (n) s += SINO_DIGITS[n];
  return s;
}
export function sino(n: number): string {
  if (n === 0) return "영";
  const out: string[] = [];
  for (const [size, name] of [[1e12, "조"], [1e8, "억"], [1e4, "만"]] as const) {
    if (n >= size) { const head = Math.floor(n / size); n %= size; out.push((head === 1 && name === "만" ? "" : sinoUnder10000(head)) + name); }
  }
  if (n) out.push(sinoUnder10000(n));
  return out.join(" ");
}
export function native(n: number, attributive = true): string {
  if (n <= 0 || n >= 100) return sino(n);
  const t = Math.floor(n / 10), o = n % 10;
  let tens = NATIVE_TENS[t];
  if (t === 2 && o === 0 && attributive) tens = "스무";
  let ones = NATIVE_ONES[o];
  if (!attributive && o) ones = ({ "한": "하나", "두": "둘", "세": "셋", "네": "넷" } as Record<string, string>)[ones] ?? ones;
  return tens + ones;
}
const digitsEach = (s: string) => [...s].map(c => c !== "0" ? SINO_DIGITS[+c] : "공").join(" ");
const num = (s: string) => parseInt(s.replace(/,/g, ""), 10);

/** 숫자·단위·영문 약어를 읽는 말로(학습 때와 똑같이). */
export function normalizeKo(text: string): string {
  let t = text;
  for (const k of byLenDesc(Object.keys(LATIN))) t = t.replace(new RegExp(`(?<![A-Za-z])${esc(k)}(?![A-Za-z])`, "g"), () => LATIN[k]);
  t = t.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => `${native(+h)} 시` + (m === "00" ? "" : ` ${sino(+m)} 분`));
  t = t.replace(/(\d{4})년/g, (_, y) => `${sino(+y)} 년`);
  t = t.replace(/(\d{1,2})월/g, (_, m) => (({ "6": "유", "10": "시" } as Record<string, string>)[m] ?? sino(+m)) + "월");
  t = t.replace(/(\d{1,2})일/g, (_, d) => `${sino(+d)} 일`);
  t = t.replace(/(\d[\d,]*)\.(\d+)/g, (_, a, b) => `${sino(num(a))} 점 ${[...b].map(c => SINO_DIGITS[+c]).join(" ")}`);
  t = t.replace(/(\d[\d,]*)\s*%/g, (_, a) => `${sino(num(a))} 퍼센트`);
  t = t.replace(/(\d+)\s*번째/g, (_, a) => (a === "1" ? "첫" : native(+a)) + " 번째");
  const cpat = byLenDesc(NATIVE_COUNTERS).map(esc).join("|");
  t = t.replace(new RegExp(`(\\d[\\d,]*)\\s*(${cpat})`, "g"), (_, a, c) => `${native(num(a))} ${c}`);
  t = t.replace(/\d{5,}(?![\d,])/g, m => digitsEach(m));
  t = t.replace(/\d[\d,]*/g, m => sino(num(m)));
  t = t.replace(/[A-Z]/g, m => LETTER_NAMES[m.charCodeAt(0) - 65]);
  t = t.replaceAll("~", " 에서 ").replaceAll("+", " 더하기 ");
  return t.replace(/\s+/g, " ").trim();
}

// 번호 표: 특수 8 · 문장부호 9 · 한글 자모(첫소리 19·가운데 21·끝소리 27). 다른 언어 기호는 그 뒤(여기선 안 씀).
const SPECIAL = ["_", "^", "$", " ", "<ko>", "<en>", "<ja>", "<zh>"];
const PUNCT = [",", ".", "!", "?", "…", "-", ":", ";", "~"];
const PUNCT_MAP: Record<string, string> = { "，": ",", "、": ",", "。": ".", "．": ".", "！": "!", "？": "?", "：": ":", "；": ";", "～": "~", "―": "-", "—": "-" };
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => String.fromCharCode(a + i));
const TABLE = [...SPECIAL, ...PUNCT, ...range(0x1100, 0x1113), ...range(0x1161, 0x1176), ...range(0x11a8, 0x11c3)];
const ID = new Map(TABLE.map((p, i) => [p, i]));
export const KO_PHONEME_COUNT = TABLE.length; // 84 — 시험이 phonemes.json 과 맞춰 본다

/** 읽는 말 → 음소 번호(학습 to_ids(text,"ko") 와 같다). */
export function koIds(spoken: string): number[] {
  const ph = ["<ko>"];
  for (const ch of spoken.normalize("NFD")) {
    if (ID.has(ch) && ch !== "^" && ch !== "$") ph.push(ch);
    else if (/\s/.test(ch)) ph.push(" ");
    else { const p = PUNCT_MAP[ch] ?? ch; if (ID.has(p)) ph.push(p); }
  }
  const ids = [ID.get("^")!, 0];
  for (const p of ph) ids.push(ID.get(p)!, 0);
  ids.push(ID.get("$")!);
  return ids;
}
export const textToKoIds = (text: string) => koIds(normalizeKo(text));
/** 한국어로 읽을 글인가: 한글이 있고 가나·한자가 없다(그런 글은 기존 목소리가 읽는다). */
export const isKoreanText = (text: string) => /[가-힣]/.test(text) && !/[぀-ヿ一-鿿]/.test(text);
