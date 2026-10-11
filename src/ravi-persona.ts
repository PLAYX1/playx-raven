/* 라비 인물 설정 · 감정 대화 · 체인 정보 대답 — 데스크탑 로컬 응답 경로 (0.8.8, 2026-10-11).
 *
 * ## 왜 있나
 * 데스크탑 라비는 AI 열쇠가 없으면 「몇 살이야?」「생일이 언제야?」「누구야?」에 답이 없었다(안내 문구 검색만 있었다).
 * 지갑 쪽 정본(/Users/gimmusong/wt-rv-wallet-final6/core/ravi/persona.ts · docs/handoff-1006/ravi-canon.md)을
 * 10개 언어(ko en ja zh it es fr pt-BR de ru)로 이식하고, 감정 대화와 체인 정보 질문 분류를 더했다.
 * 문구는 ravi-persona-copy.ts (유럽어 6개는 AI 번역, 교차검수 전).
 *
 * ## 질문 인식 원칙 — 「전체 문장 인식」 (지갑 정본 주석과 같다)
 *  - 인물 설정·가벼운 대화는 **문장 전체가 알려진 질문일 때만** 답한다(공백·문장부호·악센트 무시, 앞의 호칭·추임새는 허용).
 *    그래서 「친구한테 5 RVN 보내줘」「생일 선물 보낼 주소」「잔액 얼마」처럼 지갑 요청에 이름·나이·생일 같은 낱말이
 *    들어 있어도 **가로채지 않는다.** (시험: scripts/ravi-persona.test.mjs 의 거짓 목록)
 *  - 감정·체인 정보는 문장 속 낱말로 찾지만, 돈·주소·백업·결제 같은 지갑 낱말이 하나라도 있으면 물러난다.
 *  - 위기 표현(자해 등)은 낱말로 찾고 **항상 먼저, 항상 로컬로** 답한다(AI 열쇠가 있어도).
 *
 * ## AI 열쇠와의 관계 (ko: 구조를 보고 내린 판단)
 *  main.ts chatSendExisting 은 이미 「AI 에게 맡기면 안 되는 것」(송금 부탁·부자 순위·주소 잔액)을 열쇠가 있어도
 *  정해 둔 답으로 먼저 처리한다. 같은 방식으로 여기서도:
 *   - 위기 안내 · 인물 설정(정본) · 가벼운 인사 · 체인 정보 「도구 없음」 → 열쇠가 있어도 **로컬이 먼저** 답한다.
 *     (정본은 사실이라 AI 가 고쳐 말할 이유가 없고, 비용·지연이 0이며, 체인 숫자는 AI 가 지어낼 위험이 있다.)
 *   - 감정 표현(위로·응원·심심함·기쁨 …) → 열쇠가 **없을 때만** 로컬. 열쇠가 있으면 AI(ravi_agent.rs SYSTEM)가 맥락을
 *     살려 답한다. 로컬은 「열쇠가 없어도 따뜻하게」를 보장하는 바닥이다.
 *
 * ## 체인 정보 — 함수 경계 (설계: ~/Desktop/레이븐볼트-체인정보-설계안.md)
 *  지금은 읽는 도구가 없어 `classifyChainQuestion()` 이 분류만 하고 `chainUnavailableText()` 가 「아직 읽는 도구가 없어요」
 *  라고 정직하게 답한다. 숫자·순위는 어디서도 만들지 않는다.
 *  도구가 생기면(1단계: 노드 RPC getnetworkhashps·getblockchaininfo / 대표 서버의 서명된 정적 JSON /
 *  crypto51 데이터) **분류 함수는 그대로 두고** main.ts 에서 `raviPersonaReply()` 가 돌려주는
 *  `{kind:"chain", topic}` 를 받아 topic → 도구 호출(ravi_agent.rs 의 읽기 도구 · 또는 새 invoke)로 잇는다:
 *     topic "hashrate"  → getnetworkhashps          (노드만으로 됨)
 *     topic "chain"     → getblockchaininfo/getmininginfo
 *     topic "security"  → crypto51 JSON             (서버 불필요)
 *     topic "richlist"·"holders" → 서명 JSON(2단계, 서버 계산) — 부자순위는 어떤 노드 기능으로도 안 나온다
 *     topic "price"     → 사용자가 직접 말한 값만 사용(ravi-chat.ts userStatedPrice)
 *  도구 호출이 실패하거나 서명 검증이 안 되면 지금의 「아직 읽는 도구가 없어요」 문구로 떨어진다(가짜 숫자 금지).
 *
 * ## 감정 시스템과의 연결
 *  ravi-emotion-rules.ts 의 이벤트에는 「위로/응원 받음」이 없다. 지금 연결한 것:
 *   - 고마움 → user_thanks(수줍음), 체인 정보 「아직 몰라요」 → ai_unknown(갸웃) — 둘 다 기존 이벤트.
 *   - 「기분이 어때?」는 지금 얼굴 상태(raviState: normal/sleep/thinking/worried …)를 읽어 말한다.
 *  새 이벤트(예: user_comfort → calm+서서히 fond)는 규칙표와 그 시험이 함께 바뀌어야 해서 이번에는 넣지 않았다(설계만).
 *
 * 순수 함수 파일이다 — DOM·네트워크·지갑·IPC 를 부르지 않는다.
 */
import type { Lang } from "./i18n-pack";
import {
  PERSONA_LANGS, CANON, AGE_BASE, AGE_LESS_THAN_MONTH, AGE_MONTHS, AGE_YEARS, AGE_TAIL,
  MOOD_ANSWER, CHAT, EMOTION, CRISIS, CHAIN_TOPIC_LABEL, CHAIN_ANSWER, CHAIN_PRICE_EXTRA,
  type EmotionKind, type ChainTopic, type T10,
} from "./ravi-persona-copy";

export type { EmotionKind, ChainTopic };

/** 라비가 만들어진 순간: 2026-08-20 04:32 KST (= 2026-08-19 19:32 UTC). 지갑 정본. */
export const RAVI_BORN_UTC_MS = Date.UTC(2026, 7, 19, 19, 32, 0);

/* ── 정규화 ─────────────────────────────────────────────────────────────── */
const strip = (s: string) => String(s ?? "").normalize("NFKC").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
/** 공백·문장부호·기호를 모두 없앤 한 줄 — 전체 문장 비교용. */
export const compactRavi = (s: string) => strip(s).replace(/[\s\p{P}\p{S}]/gu, "").replace(/[ㅠㅜㅋㅎ]+$/u, "");
/** 낱말 경계를 남긴 한 줄 — 낱말 찾기용(라틴·키릴). */
const spacedRavi = (s: string) => strip(s).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
const isCjk = (l: Lang) => l === "ko" || l === "ja" || l === "zh";
const idx = (l: Lang) => PERSONA_LANGS.indexOf(l);
const pick = (t: T10, l: Lang) => t[idx(l)];
const x = (stems: string[], ends: string[]) => stems.flatMap(s => ends.map(e => s + e));

/* ── 전체 문장 표 ──────────────────────────────────────────────────────── */
type Phrases = Partial<Record<Lang, string[]>>;
const KO_Q = ["", "이야", "이에요", "이니", "이세요", "인가요", "이죠", "알려줘", "알려주세요", "궁금해", "궁금해요", "뭐야", "뭐예요", "뭔가요"];
export const PERSONA_PHRASES: Record<string, Phrases> = {
  "ravi-age": {
    ko: [...x(["몇살", "나이", "나이가몇", "나이는몇", "만나이", "만나이는몇살", "만나이가몇", "한국나이", "나이가어떻게", "나이는어떻게"], [...KO_Q, "은", "는", "가", "돼", "되나요", "돼요"]),
      "몇개월이야", "몇개월이에요", "몇개월됐어", "몇달됐어", "몇달이야", "태어난지얼마나됐어", "태어난지몇달됐어", "태어난지얼마나됐어요", "얼마나살았어", "몇살인지알려줘", "몇살인지궁금해"],
    en: ["how old are you", "how old are u", "what is your age", "whats your age", "your age", "age", "how old are you ravi", "may i ask your age", "how many months old are you", "how long have you been alive", "what is your international age", "how old are you in months"],
    ja: [...x(["何歳", "何才", "おいくつ", "いくつ", "年はいくつ", "年齢", "満年齢", "満年齢は何歳"], ["", "です", "ですか", "なの", "なのですか", "は", "を教えて", "を教えてください", "教えて"]), "何か月", "何ヶ月ですか", "生まれてどれくらい", "生まれてどのくらい", "何歳か教えて", "何歳か教えてください"],
    zh: [...x(["几岁", "多大", "多少岁", "你的年龄", "年龄", "幾歲", "你的年纪", "年龄多大"], ["", "了", "呀", "啊", "呢", "是多少", "是多少呀"]), "你今年几岁", "你今年几岁了", "你今年多大", "你出生多久了", "你出生多久", "你满周岁了吗", "周岁几岁", "周岁多大"],
    it: ["quanti anni hai", "quanti anni ha", "che eta hai", "qual e la tua eta", "la tua eta", "quanti mesi hai", "quanti anni hai ravi", "quanto tempo hai", "eta"],
    es: ["cuantos anos tienes", "cuantos anos tiene", "que edad tienes", "cual es tu edad", "tu edad", "cuantos meses tienes", "edad", "cuanto tiempo tienes"],
    fr: ["quel age as tu", "tu as quel age", "quel est ton age", "ton age", "quel age avez vous", "tu as quel age ravi", "tu as quel age ravi", "ca fait combien de temps que tu es nee", "age"],
    "pt-BR": ["quantos anos voce tem", "quantos anos tu tens", "qual a sua idade", "qual e a sua idade", "qual a tua idade", "sua idade", "quantos meses voce tem", "idade", "voce tem quantos anos"],
    de: ["wie alt bist du", "wie alt sind sie", "wie alt bist du denn", "wie ist dein alter", "was ist dein alter", "dein alter", "wie viele monate bist du alt", "alter", "wie alt"],
    ru: ["сколько тебе лет", "сколько вам лет", "какои твои возраст", "твои возраст", "сколько тебе месяцев", "ты сколько лет", "возраст", "сколько лет"],
  },
  "ravi-name": {
    ko: ["누구야", "누구니", "누구세요", "누구예요", "누구에요", "누구냐", "누구야너", "누구인가요", "이름이뭐야", "이름이뭐니", "이름이뭐예요", "이름이뭐에요", "이름뭐야", "이름이뭔가요", "이름은", "이름은뭐야", "이름은뭐예요", "이름알려줘", "이름이뭐라고해", "뭐라고불러", "뭐라고불러야해", "자기소개", "자기소개해줘", "자기소개해주세요", "자기소개좀해줘", "너를소개해줘", "스스로소개해줘"],
    en: ["who are you", "who are you ravi", "what is your name", "whats your name", "introduce yourself", "tell me about yourself", "what should i call you", "your name", "who is this", "who r u"],
    ja: [...x(["誰", "だれ", "あなたは誰", "お名前は", "名前は", "名前は何", "お名前は何"], ["", "です", "ですか", "なの"]), "名前を教えて", "名前を教えてください", "自己紹介して", "自己紹介してください", "自己紹介", "何て呼べばいい", "なんて呼べばいい"],
    zh: ["你是谁", "你是谁呀", "你是谁啊", "你是谁呢", "你是誰", "你叫什么", "你叫什么名字", "叫什么名字", "你的名字", "你的名字是什么", "名字是什么", "介绍一下你自己", "介绍一下自己", "自我介绍", "自我介绍一下", "请自我介绍", "你叫什麼名字"],
    it: ["chi sei", "chi sei tu", "come ti chiami", "qual e il tuo nome", "il tuo nome", "presentati", "chi sei ravi", "dimmi di te"],
    es: ["quien eres", "quien eres tu", "como te llamas", "cual es tu nombre", "tu nombre", "presentate", "hablame de ti", "quien es"],
    fr: ["qui es tu", "qui es tu ravi", "tu es qui", "comment tu t appelles", "comment t appelles tu", "comment tu t appelle", "quel est ton nom", "ton nom", "presente toi", "parle moi de toi"],
    "pt-BR": ["quem e voce", "quem e voce ravi", "quem es tu", "qual e o seu nome", "qual o seu nome", "como voce se chama", "como te chamas", "se apresente", "apresente se", "fale de voce"],
    de: ["wer bist du", "wer bist du denn", "wer bist du ravi", "wie heisst du", "wie ist dein name", "dein name", "stell dich vor", "erzahl mir von dir"],
    ru: ["кто ты", "кто ты такая", "кто вы", "как тебя зовут", "как твое имя", "твое имя", "представься", "ты кто", "расскажи о себе"],
  },
  "ravi-identity": {
    ko: [...x(["사람", "ai", "인공지능", "로봇", "여자", "여자애", "남자", "사람아니", "진짜사람", "살아있는새", "진짜새"], ["이야", "이에요", "이니", "인가요", "야", "예요", "이세요"]),
      "사람이야ai야", "사람이야아니면ai야", "무슨새야", "무슨새예요", "무슨새니", "어떤새야", "정체가뭐야", "정체가뭐니", "정체뭐야", "정체가뭐예요", "뭐하는애야", "살아있어", "살아있어요", "사람이야아니야"],
    en: ["are you human", "are you a human", "are you a person", "are you real", "are you an ai", "are you ai", "are you a robot", "are you a bot", "are you a bird", "are you a girl", "are you a boy", "what are you", "are you alive", "are you a real bird", "are you a chatbot"],
    ja: ["人間なの", "人間ですか", "人間", "aiなの", "aiですか", "ロボットなの", "ロボットですか", "女の子なの", "女の子ですか", "男の子なの", "男の子ですか", "どんな鳥なの", "どんな鳥ですか", "何の鳥", "何の鳥ですか", "正体は", "正体は何", "何者", "何者ですか", "本物の鳥なの", "生きてるの"],
    zh: ["你是人吗", "你是人嗎", "你是真人吗", "你是ai吗", "你是机器人吗", "你是女孩吗", "你是女生吗", "你是男孩吗", "你是什么鸟", "你是什么鸟呀", "你是什么", "你是什么东西", "你是活的吗", "你是真的鸟吗"],
    it: ["sei una persona", "sei umano", "sei umana", "sei un umano", "sei un ai", "sei una ai", "sei un robot", "sei un uccello", "sei una ragazza", "sei un ragazzo", "che cosa sei", "cosa sei", "sei viva", "sei reale", "sei vera"],
    es: ["eres una persona", "eres humano", "eres humana", "eres una ia", "eres un robot", "eres un ave", "eres un pajaro", "eres una chica", "eres un chico", "que eres", "estas viva", "eres real"],
    fr: ["es tu humaine", "es tu humain", "es tu un humain", "es tu une humaine", "es tu une ia", "es tu un robot", "es tu un oiseau", "es tu une fille", "es tu un garcon", "tu es quoi", "qu es tu", "tu es une personne", "es tu vivante", "es tu reelle"],
    "pt-BR": ["voce e uma pessoa", "voce e humana", "voce e humano", "voce e uma ia", "voce e um robo", "voce e um passaro", "voce e uma ave", "voce e uma menina", "voce e um menino", "o que voce e", "voce e real", "voce esta viva"],
    de: ["bist du ein mensch", "bist du eine ki", "bist du ein roboter", "bist du ein vogel", "bist du ein madchen", "bist du ein junge", "was bist du", "bist du echt", "bist du lebendig", "bist du real"],
    ru: ["ты человек", "ты ии", "ты бот", "ты робот", "ты птица", "ты девочка", "ты мальчик", "что ты такое", "ты настоящая", "ты живая"],
  },
  "ravi-birthday": {
    ko: [...x(["생일이언제", "생일은언제", "생일언제", "생일은며칠", "생일이며칠", "생일며칠", "생일이몇월며칠", "생일몇월며칠", "언제태어났", "언제만들어졌", "언제생겼"], ["", "야", "니", "예요", "에요", "인가요", "이야", "어", "어요", "지"]), "생일", "생일알려줘", "생일이뭐야", "태어난날이언제야", "태어난날은", "몇월며칠에태어났어", "몇월며칠에태어났어요"],
    en: ["when is your birthday", "whens your birthday", "when were you born", "when were you created", "when were you made", "your birthday", "birthday", "what is your birthday", "what day were you born", "when is ravis birthday"],
    ja: [...x(["誕生日はいつ", "誕生日いつ", "いつ生まれた", "いつ作られた", "生まれた日はいつ"], ["", "の", "のですか", "ですか", "んですか"]), "誕生日は", "誕生日を教えて", "生まれた日は", "何月何日生まれ", "何月何日に生まれたの"],
    zh: ["你的生日是什么时候", "你的生日是哪天", "你生日是什么时候", "你生日是哪天", "生日是哪天", "生日是什么时候", "生日是几号", "你的生日是几号", "你什么时候出生的", "你是什么时候出生的", "你什么时候诞生的", "你是什么时候诞生的", "你什么时候被创造的", "你是什么时候被创造的", "你哪天出生的", "你的生日"],
    it: ["quando e il tuo compleanno", "quando compi gli anni", "quando sei nata", "quando sei nato", "quando sei stata creata", "il tuo compleanno", "compleanno", "quando e il compleanno di ravi"],
    es: ["cuando es tu cumpleanos", "cuando cumples anos", "cuando naciste", "cuando te crearon", "cuando fuiste creada", "tu cumpleanos", "cumpleanos"],
    fr: ["c est quand ton anniversaire", "quand est ton anniversaire", "quand es tu nee", "quand es tu nee ravi", "quand as tu ete creee", "ton anniversaire", "anniversaire", "tu es nee quand"],
    "pt-BR": ["quando e o seu aniversario", "quando e seu aniversario", "quando e o teu aniversario", "quando voce nasceu", "quando voce foi criada", "seu aniversario", "aniversario", "quando e o aniversario da ravi"],
    de: ["wann hast du geburtstag", "wann ist dein geburtstag", "wann wurdest du geboren", "wann wurdest du erschaffen", "dein geburtstag", "geburtstag", "wann bist du geboren"],
    ru: ["когда у тебя день рождения", "когда твои день рождения", "когда ты родилась", "когда тебя создали", "твои день рождения", "день рождения", "когда ты родилась ravi"],
  },
  "ravi-likes": {
    ko: ["뭘좋아해", "뭐좋아해", "뭘좋아해요", "뭐좋아해요", "뭘좋아하니", "뭐좋아하니", "좋아하는게뭐야", "좋아하는게뭐예요", "좋아하는거뭐야", "좋아하는거있어", "좋아하는것은뭐야", "좋아하는것이뭐야", "좋아하는것있어", "좋아하는것은", "취미가뭐야", "취미뭐야", "취미가뭐예요", "취미가뭐니", "취미는", "취미가있어", "취미있어", "뭐하는거좋아해", "뭐하는걸좋아해", "무엇을좋아해"],
    en: ["what do you like", "what are your hobbies", "what is your favorite thing", "whats your favorite thing", "do you have hobbies", "what do you like to do", "what do you love"],
    ja: ["何が好き", "何が好きですか", "好きなものは", "好きなものは何", "好きなものは何ですか", "好きなものはある", "好きなものありますか", "趣味は", "趣味は何", "趣味は何ですか", "趣味はある", "趣味ある", "何するのが好き"],
    zh: ["你喜欢什么", "你喜欢什么呀", "你喜欢啥", "你有什么爱好", "你的爱好是什么", "你有爱好吗", "你的爱好", "爱好是什么", "你有什么兴趣", "你喜欢做什么"],
    it: ["cosa ti piace", "che cosa ti piace", "quali sono i tuoi hobby", "hai degli hobby", "cosa ami fare", "cosa ti piace fare"],
    es: ["que te gusta", "cuales son tus pasatiempos", "tienes pasatiempos", "que te gusta hacer", "cuales son tus aficiones", "que cosas te gustan"],
    fr: ["qu est ce que tu aimes", "qu est ce que tu aimes ravi", "quels sont tes loisirs", "tu aimes quoi", "qu aimes tu", "tu as des loisirs", "qu est ce que tu aimes faire"],
    "pt-BR": ["do que voce gosta", "o que voce gosta", "o que voce gosta de fazer", "quais sao seus hobbies", "voce tem hobbies", "do que voce gosta de fazer"],
    de: ["was magst du", "was gefallt dir", "was sind deine hobbys", "hast du hobbys", "was machst du gern", "was machst du gerne"],
    ru: ["что ты любишь", "что тебе нравится", "какие у тебя хобби", "у тебя есть хобби", "что ты любишь делать"],
  },
  "ravi-family": {
    ko: x(["가족", "친구", "엄마", "아빠", "부모님", "형제", "동생", "언니", "오빠"], ["는", "가", "이", "은", "는누구야", "가누구야", "이누구야", "은누구야", "있어", "있니", "있어요", "가있어", "이있어", "은있어", "는있어", "있나요", "가있어요", "누구야", "누구니", "누구예요", "어떻게돼", "알려줘"]),
    en: ["do you have family", "do you have a family", "do you have friends", "do you have parents", "do you have siblings", "who are your parents", "who are your friends", "who is your family", "who is your mother", "who is your father", "do you have a mom", "do you have a dad"],
    ja: ["家族は", "家族はいる", "家族はいますか", "家族いる", "友達は", "友達はいる", "友達はいますか", "友達いる", "お母さんは", "お母さんは誰", "お母さんはいる", "お父さんは", "お父さんは誰", "お父さんはいる", "両親は", "両親は誰", "両親はいる", "兄弟は", "兄弟はいる", "きょうだいはいる", "家族は誰", "家族について"],
    zh: ["你有家人吗", "你有家庭吗", "你有朋友吗", "你有父母吗", "你的父母是谁", "你的家人是谁", "你的家人", "你有兄弟姐妹吗", "你有爸爸妈妈吗", "你的爸爸妈妈是谁", "你的朋友是谁", "你妈妈是谁", "你爸爸是谁"],
    it: ["hai una famiglia", "hai degli amici", "hai dei genitori", "chi sono i tuoi genitori", "hai fratelli", "chi e la tua famiglia", "hai amici", "hai fratelli o sorelle"],
    es: ["tienes familia", "tienes amigos", "tienes padres", "quienes son tus padres", "tienes hermanos", "quien es tu familia", "tienes una familia", "tienes mama y papa"],
    fr: ["tu as une famille", "as tu une famille", "tu as des amis", "tu as des parents", "qui sont tes parents", "tu as des freres et soeurs", "qui est ta famille", "as tu des amis"],
    "pt-BR": ["voce tem familia", "voce tem amigos", "voce tem pais", "quem sao seus pais", "voce tem irmaos", "quem e sua familia", "voce tem uma familia", "voce tem mae e pai"],
    de: ["hast du familie", "hast du eine familie", "hast du freunde", "hast du eltern", "wer sind deine eltern", "hast du geschwister", "wer ist deine familie", "hast du mama und papa"],
    ru: ["у тебя есть семья", "у тебя есть друзья", "у тебя есть родители", "кто твои родители", "у тебя есть братья", "кто твоя семья", "у тебя есть мама и папа", "есть ли у тебя семья"],
  },
  "ravi-home": {
    ko: ["어디살아", "어디사니", "어디살아요", "어디에살아", "어디에살아요", "어디에사니", "어디사는데", "사는곳이어디야", "사는곳은어디야", "사는곳어디야", "사는곳이어디예요", "사는곳이어디에요", "집이어디야", "집은어디야", "집어디야", "집이어디예요", "주소가뭐야", "주소가어디야", "어디서살아", "어디서왔어", "어디에있어"],
    en: ["where do you live", "where is your home", "where are you from", "wheres your home", "where is your house", "where do you stay"],
    ja: ["どこに住んでいるの", "どこに住んでいますか", "どこに住んでるの", "どこ住み", "どこに住んでる", "どこ住んでるの", "お家はどこ", "お家はどこですか", "家はどこ", "家はどこですか", "住所は", "住所は何", "住んでいるところは", "住んでる場所は", "どこから来たの"],
    zh: ["你住在哪里", "你住在哪儿", "你住哪儿", "你住哪里", "你住哪", "你的家在哪里", "你的家在哪儿", "你家在哪里", "你家在哪儿", "你的地址是什么", "你从哪里来"],
    it: ["dove vivi", "dove abiti", "dov e casa tua", "dove sta casa tua", "da dove vieni", "dove stai"],
    es: ["donde vives", "donde esta tu casa", "en donde vives", "de donde eres", "donde estas"],
    fr: ["tu habites ou", "ou habites tu", "ou vis tu", "ou est ta maison", "tu viens d ou", "d ou viens tu"],
    "pt-BR": ["onde voce mora", "onde voce vive", "onde fica sua casa", "onde e sua casa", "de onde voce e", "onde voce esta"],
    de: ["wo wohnst du", "wo lebst du", "wo ist dein zuhause", "wo ist dein zuhause", "woher kommst du", "wo bist du zu hause"],
    ru: ["где ты живешь", "где твои дом", "где ты живёшь", "где твое жилье", "откуда ты", "где ты обитаешь"],
  },
  "ravi-creator": {
    ko: ["누가만들었어", "누가만들었니", "누가만들었어요", "누가만들었나요", "누가만들었지", "누구가만들었어", "만든사람이누구야", "만든사람은누구야", "만든사람누구야", "만든분이누구야", "만든사람이누구예요", "만든분은누구야", "를누가만들었어", "누가널만들었어", "누가널만들었니", "누가널만들었어요", "누가라비를만들었어", "누가라비를만들었니", "gpu가만들었어", "gpu가만들었니", "빛틀이만들었어", "빛틀이만들었니", "빛틀이엄마야", "빛틀이부모야", "창조자가누구야"],
    en: ["who made you", "who created you", "who built you", "who is your creator", "did the gpu create you", "did the gpu make you", "who is your maker"],
    ja: ["誰が作ったの", "誰が作りましたか", "誰が作った", "誰に作られたの", "作った人は誰", "作った人は", "作ったのは誰", "作った人は誰ですか", "gpuが作ったの", "gpuが作りましたか", "光の織機が作ったの", "光の織機は親なの"],
    zh: ["谁创造了你", "谁制作了你", "谁做了你", "谁造了你", "谁创造的你", "谁制造了你", "你是谁做的", "你是谁创造的", "你是谁造的", "是谁创造了你", "gpu创造了你吗", "光织机创造了你吗", "谁是你的创造者", "创造你的人是谁"],
    it: ["chi ti ha creata", "chi ti ha creato", "chi ti ha fatta", "chi ti ha fatto", "chi ti ha costruita", "la gpu ti ha creata", "chi e il tuo creatore"],
    es: ["quien te creo", "quien te hizo", "la gpu te creo", "quien te ha creado", "quien es tu creador", "quien te construyo"],
    fr: ["qui t a creee", "qui t a cree", "qui t a faite", "qui t a fait", "qui t a construite", "le gpu t a cree", "qui est ton createur"],
    "pt-BR": ["quem te criou", "quem criou voce", "quem fez voce", "quem te fez", "a gpu te criou", "quem e seu criador", "quem construiu voce"],
    de: ["wer hat dich erschaffen", "wer hat dich gemacht", "wer hat dich erstellt", "hat die gpu dich erschaffen", "wer ist dein schopfer", "wer hat dich gebaut"],
    ru: ["кто тебя создал", "кто тебя сделал", "кто тебя придумал", "gpu тебя создал", "кто твои создатель", "кто тебя построил"],
  },
  "ravi-story": {
    ko: x(["라비스토리", "라비스토리는", "라비스토리가", "라비게임", "라비게임은", "라비게임이"], ["뭐야", "뭔가요", "소개해줘", "알려줘", "이야기해줘", "뭐예요"]).concat(["라비스토리", "게임에서는왜나이가달라", "게임에서는왜나이가달라요", "게임속라비는몇살이야", "게임속라비는몇살이에요", "게임에서라비는몇살이야", "게임에서는몇살이야"]),
    en: ["what is ravi story", "tell me about ravi story", "tell me about the ravi game", "how old is ravi in the game", "what is the ravi game", "ravi story"],
    ja: ["ラビストーリーって何", "ラビストーリーとは", "ラビストーリーを教えて", "ラビストーリーについて教えて", "ラビストーリーを紹介して", "ゲームのラビは何歳", "ゲームのラビは何歳ですか", "ゲームの中のラビは何歳", "ゲームではなぜ年齢が違うの"],
    zh: ["拉比故事是什么", "拉比故事是什么呀", "什么是拉比故事", "介绍一下拉比故事", "介绍一下拉比的游戏", "拉比的游戏是什么", "游戏里的拉比几岁", "游戏里的拉比多大", "游戏里拉比几岁", "为什么游戏里年龄不一样"],
    it: ["cos e ravi story", "che cos e ravi story", "parlami di ravi story", "quanti anni ha ravi nel gioco", "ravi story"],
    es: ["que es ravi story", "cuentame de ravi story", "hablame de ravi story", "cuantos anos tiene ravi en el juego", "ravi story"],
    fr: ["c est quoi ravi story", "qu est ce que ravi story", "parle moi de ravi story", "quel age a ravi dans le jeu", "ravi story"],
    "pt-BR": ["o que e ravi story", "fale sobre ravi story", "me fale de ravi story", "quantos anos ravi tem no jogo", "ravi story"],
    de: ["was ist ravi story", "erzahl mir von ravi story", "wie alt ist ravi im spiel", "ravi story"],
    ru: ["что такое ravi story", "расскажи про ravi story", "сколько лет рави в игре", "ravi story"],
  },
  "ravi-thanks": {
    ko: ["고마워", "고마워요", "고맙습니다", "감사해", "감사해요", "감사합니다", "고맙다", "땡큐", "감사", "고마워라비", "정말고마워", "진짜고마워", "너무고마워", "고마웡"],
    en: ["thanks", "thank you", "thank you so much", "thx", "ty", "thanks a lot", "many thanks", "thank u", "thanks ravi", "thank you ravi"],
    ja: ["ありがとう", "ありがとうございます", "ありがとうございました", "ありがとね", "ありがと", "サンキュー", "感謝します", "感謝", "どうもありがとう", "ありがとうラビ"],
    zh: ["谢谢", "谢谢你", "多谢", "多谢你", "非常感谢", "感谢", "谢啦", "谢了", "谢谢拉比", "感谢你", "太感谢了", "謝謝"],
    it: ["grazie", "grazie mille", "ti ringrazio", "grazie ravi", "mille grazie"],
    es: ["gracias", "muchas gracias", "te lo agradezco", "mil gracias", "gracias ravi"],
    fr: ["merci", "merci beaucoup", "je te remercie", "mille mercis", "merci ravi"],
    "pt-BR": ["obrigado", "obrigada", "muito obrigado", "muito obrigada", "valeu", "obrigadao", "obrigado ravi"],
    de: ["danke", "danke schon", "vielen dank", "dankeschon", "danke dir", "danke ravi"],
    ru: ["спасибо", "большое спасибо", "благодарю", "спасибо тебе", "спасибо рави"],
  },
  "ravi-bored": {
    ko: ["심심해", "심심해요", "놀아줘", "같이놀자", "심심한데", "할일없어", "할게없어", "뭐하고놀까", "너무심심해", "나심심해", "심심하다", "놀아줘요"],
    en: ["i m bored", "im bored", "i am bored", "bored", "play with me", "lets play", "entertain me", "i am so bored", "im so bored"],
    ja: ["暇だよ", "暇", "暇だな", "暇です", "退屈だよ", "退屈", "退屈だな", "遊ぼう", "遊んで", "遊んでよ", "一緒に遊ぼう", "ひまだよ", "ひま"],
    zh: ["好无聊", "我很无聊", "无聊", "好无聊啊", "我好无聊", "陪我玩", "陪我玩吧", "陪我聊天", "陪我聊聊", "我无聊", "无聊死了"],
    it: ["mi annoio", "sono annoiato", "sono annoiata", "giochiamo", "giochiamo insieme", "che noia", "mi annoio tanto"],
    es: ["me aburro", "estoy aburrido", "estoy aburrida", "juguemos", "juega conmigo", "que aburrimiento", "estoy muy aburrido", "estoy muy aburrida"],
    fr: ["je m ennuie", "je suis ennuye", "jouons", "joue avec moi", "quel ennui", "je m ennuie tellement"],
    "pt-BR": ["estou entediado", "estou entediada", "to entediado", "to entediada", "to com tedio", "vamos brincar", "brinca comigo", "que tedio", "estou com tedio"],
    de: ["mir ist langweilig", "ich langweile mich", "spiel mit mir", "lass uns spielen", "langweilig", "mir ist so langweilig"],
    ru: ["мне скучно", "скучно", "давай поиграем", "поиграи со мнои", "мне очень скучно"],
  },
  "ravi-hello": {
    ko: ["안녕", "안녕하세요", "안녕하십니까", "안녕라비", "하이", "헬로", "헬로우", "반가워", "반가워요", "만나서반가워", "만나서반가워요", "처음뵙겠습니다", "안뇽", "여보세요"],
    en: ["hello", "hi", "hey", "hello ravi", "hi ravi", "hey ravi", "good morning", "good evening", "nice to meet you", "greetings", "good afternoon"],
    ja: ["こんにちは", "こんにちはラビ", "こんばんは", "おはよう", "おはようございます", "はじめまして", "やあ", "ハロー", "どうも", "もしもし"],
    zh: ["你好", "您好", "你好呀", "你好啊", "嗨", "哈喽", "哈啰", "很高兴见到你", "初次见面", "大家好", "早上好", "晚上好", "午安"],
    it: ["ciao", "salve", "buongiorno", "buonasera", "ciao ravi", "piacere di conoscerti", "ehi"],
    es: ["hola", "buenos dias", "buenas tardes", "hola ravi", "mucho gusto", "encantada de conocerte", "que tal ravi"],
    fr: ["bonjour", "salut", "bonsoir", "coucou", "salut ravi", "bonjour ravi", "enchante", "enchantee"],
    "pt-BR": ["ola", "oi", "bom dia", "boa tarde", "ola ravi", "oi ravi", "prazer em conhecer", "muito prazer"],
    de: ["hallo", "guten morgen", "guten tag", "guten abend", "hallo ravi", "hi ravi", "moin", "servus"],
    ru: ["привет", "здравствуи", "здравствуите", "добрыи день", "доброе утро", "добрыи вечер", "привет рави", "приятно познакомиться"],
  },
  "ravi-goodnight": {
    ko: ["잘자", "잘자요", "잘자라비", "굿나잇", "굿밤", "좋은밤", "잘자고내일봐", "이만잘게", "나이제잘게", "나잘게", "나이제자러갈게", "이만자러갈게", "자러갈게", "잘게"],
    en: ["good night", "goodnight", "night night", "gn", "sleep well", "i m going to sleep", "im going to sleep", "good night ravi", "goodnight ravi"],
    ja: ["おやすみ", "おやすみなさい", "おやすみラビ", "おやすみね", "寝るね", "もう寝るね", "そろそろ寝るね"],
    zh: ["晚安", "晚安啦", "晚安拉比", "我去睡了", "我要睡了", "我先睡了", "该睡了", "睡觉了"],
    it: ["buonanotte", "notte", "buona notte", "vado a dormire", "buonanotte ravi", "a letto"],
    es: ["buenas noches", "que descanses", "me voy a dormir", "buenas noches ravi", "hasta manana"],
    fr: ["bonne nuit", "bonne nuit ravi", "je vais dormir", "je vais me coucher", "dors bien"],
    "pt-BR": ["boa noite", "boa noite ravi", "vou dormir", "bom descanso", "durma bem", "ate amanha"],
    de: ["gute nacht", "gute nacht ravi", "schlaf gut", "ich gehe schlafen", "ich geh schlafen", "nacht"],
    ru: ["спокоиною ночи", "спокоиной ночи", "спокоиночи", "споки ноки", "я пошел спать", "я пошла спать", "доброи ночи"],
  },
  "ravi-mood": {
    ko: ["기분어때", "기분이어때", "기분이어떠니", "기분은어때", "기분이어떠세요", "오늘기분어때", "오늘기분은어때", "오늘기분이어때", "지금기분어때", "지금기분은어때", "잘지냈어", "잘지내", "잘지내니", "잘지내요", "잘지내고있어", "잘있었어", "오늘어땠어", "오늘하루어땠어", "뭐해", "뭐하니", "뭐하고있어", "뭐하고있니", "뭐하세요", "어떻게지내", "잘지냈니"],
    en: ["how are you", "how are you doing", "how are you feeling", "hows it going", "how do you feel", "how was your day", "whats up", "what are you doing", "are you ok", "are you okay", "how are you today", "how r u", "how is your mood"],
    ja: ["元気", "元気ですか", "元気にしてる", "元気にしてた", "調子はどう", "調子はどうですか", "気分はどう", "気分はどうですか", "今日の気分は", "今の気分は", "何してるの", "何してる", "最近どう"],
    zh: ["你好吗", "你好吗呀", "你好嗎", "你怎么样", "你心情怎么样", "你心情如何", "你今天心情怎么样", "你今天怎么样", "今天心情怎么样", "你在干嘛", "你在做什么", "你在干什么", "最近好吗", "最近怎么样", "你过得好吗", "你还好吗"],
    it: ["come stai", "come va", "come ti senti", "come stai oggi", "che fai", "cosa fai", "tutto bene", "come stai ravi"],
    es: ["como estas", "como te sientes", "que tal", "como andas", "que haces", "como va todo", "como estas hoy", "como estas ravi"],
    fr: ["comment vas tu", "comment allez vous", "ca va", "comment tu te sens", "tu vas bien", "tu fais quoi", "que fais tu", "comment tu vas", "comment vas tu aujourd hui"],
    "pt-BR": ["como voce esta", "como vai voce", "tudo bem", "como voce se sente", "o que voce esta fazendo", "como vai", "como voce esta hoje", "tudo bem ravi"],
    de: ["wie gehts", "wie geht es dir", "wie geht s", "wie fuhlst du dich", "was machst du", "alles gut", "wie geht es dir heute"],
    ru: ["как дела", "как ты", "как у тебя дела", "как ты себя чувствуешь", "что делаешь", "как поживаешь", "как настроение", "как дела рави", "что ты делаешь"],
  },
  "ravi-kind": {
    ko: ["사랑해", "사랑해요", "사랑한다", "라비사랑해", "좋아해", "좋아해요", "너좋아해", "널좋아해", "너가좋아", "네가좋아", "라비좋아해", "귀여워", "귀여워요", "귀엽다", "너무귀여워", "예뻐", "예뻐요", "너무예뻐", "최고야", "너최고야", "똑똑하다", "너똑똑하다", "멋져", "멋지다"],
    en: ["i love you", "love you", "i like you", "you are cute", "youre cute", "you re cute", "youre the best", "you are the best", "youre adorable", "you are adorable", "you are smart", "youre smart", "i love you ravi"],
    ja: ["大好き", "大好きだよ", "好きだよ", "好き", "好きです", "かわいい", "可愛い", "かわいいね", "かわいいですね", "すごいね", "ラビ大好き", "あなたが好き", "君が好き"],
    zh: ["我爱你", "我喜欢你", "喜欢你", "爱你", "你真可爱", "你好可爱", "可爱", "你太可爱了", "你真棒", "你最棒", "你真聪明", "你好棒"],
    it: ["ti voglio bene", "ti amo", "mi piaci", "sei carina", "sei carino", "sei dolce", "sei la migliore", "sei bravissima", "sei intelligente"],
    es: ["te quiero", "te amo", "me gustas", "eres linda", "eres lindo", "eres adorable", "eres la mejor", "eres muy lista", "eres inteligente"],
    fr: ["je t aime", "je t adore", "tu es mignonne", "t es mignonne", "tu es adorable", "tu es la meilleure", "tu es intelligente", "t es la meilleure"],
    "pt-BR": ["eu te amo", "te amo", "gosto de voce", "voce e fofa", "voce e linda", "voce e a melhor", "eu gosto de voce", "voce e inteligente", "voce e fofinha"],
    de: ["ich hab dich lieb", "ich liebe dich", "ich mag dich", "du bist suss", "du bist die beste", "du bist niedlich", "du bist klug", "du bist toll"],
    ru: ["я тебя люблю", "люблю тебя", "ты мне нравишься", "ты милая", "ты лучшая", "ты очень милая", "ты умная", "ты классная"],
  },
};

/** 문장 앞뒤에 붙어도 되는 호칭·추임새(전체 문장 인식을 깨지 않는 것만). */
const LEADS = ["혹시", "근데", "그런데", "저기", "그럼", "참", "라비야", "라비", "너는", "넌", "너", "당신은", "있잖아", "ravi", "ラビ", "拉比", "рави", "あなたは", "きみは", "君は", "你", "您", "hey", "hello", "ok", "okay", "so", "well", "ciao", "ehi", "hola", "oye", "salut", "bonjour", "hallo", "oi", "ola", "привет", "ну", "скажи", "dime", "dis moi", "sag mal", "diz", "dimmi"].map(compactRavi);
const TAILS = ["라비야", "라비", "ravi", "ラビ", "拉比", "рави", "please", "por favor", "s il te plait", "bitte", "per favore", "пожалуиста", "부탁드립니다", "부탁해", "부탁해요", "ですか"].map(compactRavi).filter(Boolean);

const EXACT = new Map<string, { id: string; lang: Lang }[]>();
for (const [id, byLang] of Object.entries(PERSONA_PHRASES)) {
  for (const [lang, list] of Object.entries(byLang) as [Lang, string[]][]) {
    for (const p of list) {
      const key = compactRavi(p);
      if (!key) continue;
      const arr = EXACT.get(key) ?? [];
      if (!arr.some(a => a.id === id && a.lang === lang)) arr.push({ id, lang });
      EXACT.set(key, arr);
    }
  }
}
/** 시험용 — 같은 문장이 서로 다른 설정에 걸리면 안 된다. */
export function personaPhraseConflicts(): string[] {
  const out: string[] = [];
  for (const [key, arr] of EXACT) if (new Set(arr.map(a => a.id)).size > 1) out.push(`${key}: ${arr.map(a => a.id).join(",")}`);
  return out;
}

function candidates(c: string): string[] {
  const seen = new Set<string>([c]);
  let frontier = [c];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const lead of LEADS) if (lead && t.startsWith(lead) && t.length > lead.length) { const r = t.slice(lead.length); if (!seen.has(r)) { seen.add(r); next.push(r); } }
      for (const tail of TAILS) if (t.endsWith(tail) && t.length > tail.length) { const r = t.slice(0, -tail.length); if (!seen.has(r)) { seen.add(r); next.push(r); } }
    }
    frontier = next;
  }
  return [...seen];
}

/* ── 낱말 찾기(감정·체인·위기·지갑 낱말) ──────────────────────────────────── */
function kw(lang: Lang, words: string[]): RegExp {
  const cjk = isCjk(lang);
  const alt = words.map(w => {
    const exactEnd = w.endsWith("$");
    const body = strip(exactEnd ? w.slice(0, -1) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (cjk) return body.replace(/\s+/g, "").replace(/[%]/g, "");
    return `(?<![\\p{L}\\p{N}])${body}${exactEnd ? "(?![\\p{L}\\p{N}])" : ""}`;
  }).join("|");
  return new RegExp(alt, "u");
}
type WordTable = Partial<Record<Lang, string[]>>;
const table = (t: WordTable): Partial<Record<Lang, RegExp>> => Object.fromEntries((Object.entries(t) as [Lang, string[]][]).map(([l, w]) => [l, kw(l, w)]));
function findLang(re: Partial<Record<Lang, RegExp>>, raw: string, ui: Lang): Lang | null {
  const compact = compactRavi(raw), spaced = spacedRavi(raw);
  for (const l of [ui, ...PERSONA_LANGS.filter(x => x !== ui)]) {
    const r = re[l];
    if (r && r.test(isCjk(l) ? compact : spaced)) return l;
  }
  return null;
}

/** 지갑 일(돈·주소·백업·결제 …) 낱말 — 하나라도 있으면 감정·체인 분류는 물러난다. */
const WALLET_WORDS = table({
  ko: ["송금", "보내줘", "보내기", "보낼", "입금", "출금", "잔액", "수수료", "주소", "지갑", "백업", "시드", "복구단어", "비밀번호", "결제", "주문", "매출", "환불", "열쇠", "니모닉", "비밀키"],
  en: ["send$", "sending", "balance", "fee$", "fees$", "address", "wallet", "backup", "seed", "recovery", "password", "payment", "order$", "orders$", "refund", "private key", "mnemonic"],
  ja: ["送金", "送って", "入金", "残高", "手数料", "アドレス", "ウォレット", "バックアップ", "シード", "パスワード", "支払い", "注文", "返金"],
  zh: ["转账", "汇款", "发送", "入账", "余额", "手续费", "地址", "钱包", "备份", "助记词", "密码", "支付", "订单", "退款", "私钥"],
  it: ["inviare", "invia$", "invio", "saldo", "commissione", "commissioni", "indirizzo", "portafoglio", "backup", "seed", "password", "pagamento", "ordine", "rimborso"],
  es: ["enviar", "envia$", "saldo", "comision", "comisiones", "direccion", "billetera", "cartera", "copia de seguridad", "backup", "frase semilla", "contrasena", "pago$", "pedido", "reembolso"],
  fr: ["envoyer", "envoie$", "solde", "frais$", "adresse", "portefeuille", "sauvegarde", "backup", "phrase de recuperation", "mot de passe", "paiement", "commande", "remboursement"],
  "pt-BR": ["enviar", "envia$", "saldo", "taxa$", "taxas$", "endereco", "carteira", "backup", "frase semente", "senha", "pagamento", "pedido", "reembolso"],
  de: ["senden", "sende$", "uberweisen", "guthaben", "kontostand", "gebuhr", "gebuhren", "adresse", "wallet", "backup", "seed", "passwort", "zahlung", "bestellung", "ruckerstattung"],
  ru: ["отправ", "перевест", "перевод", "баланс", "комисси", "адрес", "кошел", "бэкап", "резервн", "пароль", "платеж", "оплат", "заказ", "возврат", "сид"],
});
/** 감정 대화에서만 더 거르는 코인·앱 낱말(체인 질문은 코인 이름이 들어 있어야 하므로 여기에 안 쓴다). */
const COIN_WORDS = table({
  ko: ["rvn", "레이븐코인", "레이븐볼트", "코인", "채굴"], en: ["rvn", "ravencoin", "ravenvault", "mining$"], ja: ["rvn", "レイヴンコイン", "レイヴンヴォルト", "マイニング"],
  zh: ["rvn", "渡鸦币", "挖矿"], it: ["rvn", "ravencoin", "mining$"], es: ["rvn", "ravencoin", "mineria"], fr: ["rvn", "ravencoin", "minage"],
  "pt-BR": ["rvn", "ravencoin", "mineracao"], de: ["rvn", "ravencoin", "mining$"], ru: ["rvn", "ravencoin", "майнинг"],
});

/* ── 위기 ──────────────────────────────────────────────────────────────── */
const CRISIS_WORDS = table({
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

/* ── 감정 낱말 ─────────────────────────────────────────────────────────── */
const EMOTION_ORDER: EmotionKind[] = ["comfort", "cheer", "lonely", "anxious", "angry", "sad", "tired", "bored", "happy"];
const EMOTION_WORDS: Record<EmotionKind, Partial<Record<Lang, RegExp>>> = {
  comfort: table({
    ko: ["위로해", "위로가필요", "위로좀", "토닥", "안아줘", "괜찮다고말해", "힘이되는말", "기운나게", "기분전환"],
    en: ["comfort me", "cheer me up", "console me", "i need comfort", "i need a hug", "hug me", "say something nice", "make me feel better"],
    ja: ["慰めて", "なぐさめて", "元気づけて", "癒して", "ハグして"], zh: ["安慰我", "哄哄我", "抱抱我", "让我开心"],
    it: ["consolami", "confortami", "tirami su", "abbracciami", "fammi sentire meglio", "ho bisogno di conforto"],
    es: ["consuelame", "animame", "abrazame", "hazme sentir mejor", "necesito consuelo"],
    fr: ["console moi", "reconforte moi", "fais moi un calin", "remonte moi le moral", "je veux un calin", "fais moi sentir mieux"],
    "pt-BR": ["me consola", "me conforta", "me da um abraco", "me abraca", "me anima", "faz eu me sentir melhor", "preciso de conforto"],
    de: ["trost mich", "troste mich", "umarm mich", "munter mich auf", "bau mich auf", "ich brauche trost"],
    ru: ["утеши меня", "поддержи меня", "обними меня", "подбодри меня", "мне нужно утешение", "мне нужна поддержка"],
  }),
  cheer: table({
    ko: ["응원해", "응원이필요", "힘내라고", "파이팅해", "화이팅해", "힘을줘", "힘좀줘", "용기를줘", "격려해", "동기부여"],
    en: ["encourage me", "cheer for me", "motivate me", "root for me", "i need encouragement", "give me strength", "i need motivation", "say something motivating"],
    ja: ["応援して", "励まして", "元気をちょうだい", "元気をください", "頑張れって言って", "がんばれって言って"], zh: ["鼓励我", "给我加油", "为我加油", "给我力量", "鼓励一下", "帮我加油"],
    it: ["incoraggiami", "fammi il tifo", "motivami", "dammi forza", "ho bisogno di incoraggiamento"],
    es: ["dame animos", "apoyame", "motivame", "dame fuerzas", "necesito animos", "necesito motivacion"],
    fr: ["encourage moi", "motive moi", "donne moi de la force", "j ai besoin d encouragements", "soutiens moi"],
    "pt-BR": ["me incentiva", "torce por mim", "me motiva", "me da forca", "preciso de incentivo", "preciso de motivacao"],
    de: ["ermutige mich", "motiviere mich", "feuer mich an", "gib mir kraft", "ich brauche ermutigung", "ich brauche motivation"],
    ru: ["вдохнови меня", "мотивируи меня", "дай мне сил", "поддержи", "мне нужна мотивация", "подбодри"],
  }),
  lonely: table({
    ko: ["외로", "쓸쓸", "혼자인것같", "혼자라", "혼자있", "아무도없", "허전", "고독", "친구가없"],
    en: ["lonely", "so alone", "i m alone", "i am alone", "no friends", "isolated", "nobody cares", "feel alone"],
    ja: ["寂しい", "さみしい", "孤独", "ひとりぼっち", "一人ぼっち", "友達がいない"], zh: ["孤独", "孤单", "寂寞", "没人陪", "没有朋友"],
    it: ["mi sento solo", "mi sento sola", "solitudine", "nessuno mi", "non ho amici"], es: ["me siento solo", "me siento sola", "soledad", "nadie me", "sin amigos", "me siento aislad"],
    fr: ["je me sens seul", "solitude", "personne ne", "pas d amis", "isole"], "pt-BR": ["solitari", "solidao", "me sinto sozinh", "ninguem se importa", "ninguem me", "sem amigos"],
    de: ["einsam", "einsamkeit", "ganz allein", "keine freunde", "niemand mag mich"], ru: ["одинок", "одиночеств", "нет друзеи", "никому не нужен", "никому не нужна"],
  }),
  anxious: table({
    ko: ["불안", "걱정", "초조", "떨려", "긴장", "무서워", "무섭", "두려", "겁나"],
    en: ["anxious", "anxiety", "worried", "nervous", "scared", "afraid", "panic", "on edge", "uneasy"],
    ja: ["不安", "心配", "緊張", "怖い", "こわい"], zh: ["焦虑", "担心", "紧张", "害怕", "不安", "好慌"],
    it: ["ansios", "ansia", "preoccupat", "nervos", "ho paura", "spaventat", "agitat"], es: ["ansios", "ansiedad", "preocupad", "nervios", "tengo miedo", "asustad", "panico", "inquiet"],
    fr: ["anxieu", "angoisse", "inquiet", "nerveu", "j ai peur", "effraye", "panique"], "pt-BR": ["ansios", "ansiedade", "preocupad", "nervos", "com medo", "assustad", "panico"],
    de: ["angst", "angstlich", "besorgt", "nervos", "beunruhigt", "panik", "unruhig"], ru: ["тревож", "беспокоюс", "нервнича", "страшно", "боюсь", "паник"],
  }),
  angry: table({
    ko: ["화나", "화가나", "화났", "짜증", "열받", "분하", "억울", "빡치", "분노"],
    en: ["angry", "mad at", "furious", "annoyed", "irritated", "pissed", "frustrated"],
    ja: ["怒って", "腹が立", "むかつく", "イライラ", "いらいら", "ムカつく"], zh: ["生气", "愤怒", "气死", "烦死", "火大", "恼火"],
    it: ["arrabbiat", "furios", "incavolat", "irritat", "frustrat"], es: ["enojad", "enfadad", "furios", "molest", "cabread", "frustrad"],
    fr: ["en colere", "furieu", "enerve", "agace", "frustre", "fache"], "pt-BR": ["com raiva", "raiva", "bravo", "brava", "furios", "irritad", "chatead", "frustrad"],
    de: ["wutend", "sauer$", "argerlich", "genervt", "verargert", "frustriert", "zornig"], ru: ["злюсь", "злой", "злая", "сержусь", "раздражен", "бесит", "в бешенстве"],
  }),
  sad: table({
    ko: ["우울", "슬퍼", "슬프", "슬픈", "속상", "서러", "눈물", "울고싶", "울었", "마음이아", "마음아파", "상처", "허탈", "힘들", "힘든", "괴로", "무기력", "스트레스", "좌절", "실망"],
    en: ["sad$", "sadness", "depressed", "down$", "unhappy", "heartbroken", "crying", "cry$", "upset", "miserable", "feeling low", "hard day", "rough day", "tough day", "struggling", "stressed", "overwhelmed"],
    ja: ["悲しい", "かなしい", "つらい", "辛い", "落ち込", "憂鬱", "泣き", "泣いて", "しんどい", "凹んで", "ストレス"], zh: ["难过", "伤心", "悲伤", "难受", "郁闷", "沮丧", "想哭", "哭了", "心情不好", "心情很差", "压力大", "崩溃", "委屈", "失落"],
    it: ["triste", "tristezza", "giu di morale", "depress", "a pezzi", "ho pianto", "voglio piangere", "giornata pesante", "giornata difficile", "stressat", "sopraffatt"],
    es: ["triste", "tristeza", "deprimid", "decaid", "hecho polvo", "llorar", "he llorado", "dia dificil", "dia duro", "mal dia", "estresad", "agobiad"],
    fr: ["triste", "tristesse", "deprime", "abattu", "j ai pleure", "envie de pleurer", "journee difficile", "mauvaise journee", "stresse", "submerge"],
    "pt-BR": ["triste", "tristeza", "deprimid", "desanimad", "chorei", "vontade de chorar", "dia dificil", "dia ruim", "estressad", "sobrecarregad", "pra baixo", "para baixo"],
    de: ["traurig", "niedergeschlagen", "deprimiert", "bedruckt", "ich habe geweint", "zum weinen", "schwerer tag", "harter tag", "schlechter tag", "gestresst", "uberfordert"],
    ru: ["грустн", "груст", "печаль", "расстроен", "подавлен", "плакал", "хочется плакать", "тяжелыи день", "плохои день", "стресс", "переживаю", "тяжело"],
  }),
  tired: table({
    ko: ["피곤", "피로", "졸려", "졸리", "잠와", "지쳤", "지친", "지쳐", "기운이없", "탈진", "번아웃", "기력이없"],
    en: ["tired", "exhausted", "sleepy", "worn out", "burned out", "burnt out", "drained", "no energy", "fatigued"],
    ja: ["疲れ", "眠い", "ねむい", "だるい", "へとへと", "ぐったり"], zh: ["累了", "好累", "很累", "疲惫", "疲倦", "困了", "好困", "没精神", "没力气"],
    it: ["stanc", "stremat", "esaust", "ho sonno", "senza energie"], es: ["cansad", "agotad", "exhaust", "tengo sueno", "sin energia", "sin fuerzas"],
    fr: ["fatigue", "epuise", "creve", "j ai sommeil", "sans energie", "lessive"], "pt-BR": ["cansad", "exaust", "estou com sono", "sem energia", "esgotad"],
    de: ["mude", "erschopft", "schlafrig", "keine energie", "ausgelaugt", "fix und fertig"], ru: ["устал", "измотан", "вымотан", "хочу спать", "нет сил", "нет энергии", "выдохся", "выдохлась"],
  }),
  bored: table({
    ko: ["심심", "지루", "할일없", "할게없"], en: ["bored$", "nothing to do"], ja: ["暇", "ひま", "退屈"], zh: ["无聊", "好闲"],
    it: ["annoi", "che noia"], es: ["aburr"], fr: ["ennui", "m ennuie"], "pt-BR": ["entedi", "tedio"], de: ["langweil"], ru: ["скучно", "скука"],
  }),
  happy: table({
    ko: ["기뻐", "기쁘", "기쁜", "행복", "신나", "좋은일", "설레", "뿌듯", "감동", "즐거", "기분좋", "합격했", "성공했", "승진"],
    en: ["happy$", "so glad", "excited", "great news", "good news", "thrilled", "proud of myself", "joyful", "overjoyed", "feeling great", "delighted"],
    ja: ["うれしい", "嬉しい", "楽しい", "幸せ", "やった", "わくわく", "ワクワク"], zh: ["开心", "高兴", "快乐", "幸福", "太好了", "兴奋", "激动", "好消息"],
    it: ["felice", "contento", "contenta", "emozionat", "che bello", "buone notizie", "settimo cielo", "entusiast"], es: ["feliz", "contento", "contenta", "emocionad", "buenas noticias", "que alegria", "ilusionad"],
    fr: ["heureu", "content", "excite", "bonne nouvelle", "super content", "enthousiaste"], "pt-BR": ["feliz", "contente", "empolgad", "boas noticias", "que alegria"],
    de: ["gluck", "froh", "freue mich", "freut mich", "aufgeregt", "gute nachrichten", "begeistert"], ru: ["счастлив", "рад$", "рада$", "радуюсь", "хорошие новости", "в восторге", "ура$"],
  }),
};
/** 부정(「안 힘들어」)은 감정으로 읽지 않는다 — 한국어·일본어·중국어·영어만. */
const NEGATED = /안(?:힘들|우울|슬프|피곤|외롭|불안|무섭|화나|졸리)|(?:힘들|우울|피곤|외롭|불안|무섭|슬프)(?:하)?지(?:도)?않|(?:辛く|悲しく|寂しく|疲れて)(?:ない|ません)|不(?:难过|伤心|累|孤单|害怕)|没(?:有)?(?:难过|伤心|很累)/u;
const NEGATED_EN = /(?:^| )(?:not|never|no longer|don t feel|dont feel|didn t feel) (?:\p{L}+ )?(?:sad|tired|lonely|anxious|angry|worried|scared|bored|happy|stressed)(?: |$)/u;

/* ── 체인 정보 낱말 ────────────────────────────────────────────────────── */
const CHAIN_ORDER: ChainTopic[] = ["richlist", "holders", "security", "hashrate", "price", "chain"];
const CHAIN_WORDS: Record<ChainTopic, Partial<Record<Lang, RegExp>>> = {
  richlist: table({
    ko: ["부자순위", "부자랭킹", "리치리스트", "보유량순위", "큰손", "고래순위", "부자몇위"], en: ["rich list", "richlist", "richest", "top holders", "whale$", "whales$", "wealth rank"],
    ja: ["長者番付", "保有者ランキング", "富豪ランキング", "リッチリスト", "クジラ"], zh: ["持币排行", "持币排名", "富豪榜", "巨鲸", "富豪排名", "持币大户"],
    it: ["classifica dei ricchi", "lista dei ricchi", "piu ricchi"], es: ["lista de ricos", "clasificacion de ricos", "mas ricos", "ballenas"],
    fr: ["classement des plus riches", "liste des plus riches", "plus riches", "baleines"], "pt-BR": ["ranking dos mais ricos", "lista dos mais ricos", "mais ricos", "baleias"],
    de: ["reichenliste", "reichsten", "wale$"], ru: ["список богатых", "богатеиш", "рейтинг богатых", "киты$"],
  }),
  holders: table({
    ko: ["보유자", "홀더", "몇명이가지고", "몇명이들고"], en: ["holders", "how many people own", "how many own", "number of owners"], ja: ["保有者数", "保有者は何人", "ホルダー"], zh: ["持币人数", "持币地址数", "持有者", "持币者"],
    it: ["detentori", "quante persone possiedono"], es: ["poseedores", "tenedores", "cuantas personas tienen"], fr: ["detenteurs", "combien de personnes possedent"],
    "pt-BR": ["detentores", "quantas pessoas possuem"], de: ["halter$", "wie viele besitzen", "inhaber"], ru: ["держател", "холдер", "сколько людеи владеют", "владельцев"],
  }),
  security: table({
    ko: ["보안순위", "보안랭킹", "51공격", "51퍼센트", "공격비용", "네트워크보안", "얼마나안전"], en: ["51 attack", "51 percent", "attack cost", "security rank", "network security", "how secure"],
    ja: ["セキュリティ順位", "セキュリティランキング", "51攻撃", "攻撃コスト", "ネットワークの安全"], zh: ["安全排名", "51攻击", "攻击成本", "攻击费用", "网络安全排名"],
    it: ["attacco 51", "costo dell attacco", "classifica di sicurezza", "sicurezza della rete"], es: ["ataque 51", "costo del ataque", "clasificacion de seguridad", "seguridad de la red"],
    fr: ["attaque 51", "cout de l attaque", "classement de securite", "securite du reseau"], "pt-BR": ["ataque 51", "custo do ataque", "ranking de seguranca", "seguranca da rede"],
    de: ["51 angriff", "51 prozent", "angriffskosten", "sicherheitsranking", "netzwerksicherheit"], ru: ["атака 51", "атака на 51", "стоимость атаки", "рейтинг безопасности", "безопасность сети"],
  }),
  hashrate: table({
    ko: ["해시율", "해시레이트", "해시파워"], en: ["hash rate", "hashrate", "hash power", "hashes per second"], ja: ["ハッシュレート", "ハッシュパワー", "ハッシュ率"], zh: ["哈希率", "算力", "哈希算力", "全网算力"],
    it: ["hashrate", "tasso di hash", "potenza di hash"], es: ["hashrate", "tasa de hash", "poder de hash", "potencia de hash"], fr: ["hashrate", "taux de hachage", "puissance de hachage"],
    "pt-BR": ["hashrate", "taxa de hash", "poder de hash"], de: ["hashrate", "hash rate", "hash leistung"], ru: ["хешреит", "хэшреит", "хеш реит"],
  }),
  price: table({
    ko: ["시세", "rvn가격", "코인가격", "레이븐코인가격", "rvn얼마"], en: ["rvn price", "price of rvn", "coin price", "price of ravencoin", "ravencoin price", "exchange rate", "how much is 1 rvn", "how much is rvn", "rvn worth"],
    ja: ["rvnの価格", "rvnの相場", "相場", "コインの価格", "レイヴンコインの価格"], zh: ["rvn价格", "币价", "rvn行情", "rvn多少钱", "行情"],
    it: ["prezzo di rvn", "prezzo rvn", "prezzo di ravencoin", "prezzo della moneta", "quanto vale rvn"], es: ["precio de rvn", "precio rvn", "precio de ravencoin", "cuanto vale rvn", "cotizacion"],
    fr: ["prix du rvn", "prix rvn", "cours du rvn", "cours rvn", "combien vaut le rvn"], "pt-BR": ["preco do rvn", "preco rvn", "preco do ravencoin", "quanto vale rvn", "cotacao"],
    de: ["rvn preis", "preis von rvn", "kurs von rvn", "rvn kurs", "wie viel ist rvn wert"], ru: ["цена rvn", "курс rvn", "стоимость rvn", "сколько стоит rvn"],
  }),
  chain: table({
    ko: ["블록높이", "채굴난이도", "네트워크난이도", "멤풀", "블록타임", "체인상태"], en: ["block height", "mining difficulty", "network difficulty", "mempool", "block time", "chain info"],
    ja: ["ブロック高", "ブロックの高さ", "採掘難易度", "マイニング難易度", "メンプール"], zh: ["区块高度", "区块高", "挖矿难度", "全网难度", "网络难度", "内存池", "出块时间"],
    it: ["altezza del blocco", "difficolta di mining", "difficolta della rete", "mempool"], es: ["altura de bloque", "dificultad de mineria", "dificultad de la red", "mempool"],
    fr: ["hauteur de bloc", "difficulte de minage", "difficulte du reseau", "mempool"], "pt-BR": ["altura do bloco", "dificuldade de mineracao", "dificuldade da rede", "mempool"],
    de: ["blockhohe", "mining schwierigkeit", "netzwerk schwierigkeit", "mempool"], ru: ["высота блока", "сложность майнинга", "сложность сети", "мемпул"],
  }),
};

/* ── 공개 함수 ─────────────────────────────────────────────────────────── */
export type PersonaKind = "canon" | "chat" | "emotion" | "crisis" | "chain";
export type PersonaMatch = { id: string; kind: PersonaKind; lang: Lang; topic?: ChainTopic | EmotionKind };

/**
 * 체인 정보 질문 분류(도구 연결점 — 파일 머리 주석 「체인 정보 — 함수 경계」 참고).
 * 지갑 낱말(잔액·보내기·주소 …)이 있으면 null — 지갑 일은 지갑 경로가 맡는다.
 */
export function classifyChainQuestion(q: string, ui: Lang = "ko"): { topic: ChainTopic; lang: Lang } | null {
  if (spacedRavi(q).length > 120 || findLang(WALLET_WORDS, q, ui)) return null;
  for (const topic of CHAIN_ORDER) {
    const lang = findLang(CHAIN_WORDS[topic], q, ui);
    if (lang) return { topic, lang };
  }
  return null;
}

/** 질문 하나를 분류한다. 인물 설정·인사는 전체 문장, 위기·체인·감정은 낱말. 해당 없음 → null. */
export function classifyRaviTalk(q: string, ui: Lang = "ko"): PersonaMatch | null {
  const raw = String(q ?? "");
  if (!raw.trim() || raw.length > 400) return null;
  // 1) 위기 — 항상 먼저.
  const crisis = findLang(CRISIS_WORDS, raw, ui);
  if (crisis) return { id: "ravi-crisis", kind: "crisis", lang: crisis };
  // 2) 전체 문장 인식 — 지갑 요청에 낱말이 섞여 있어도 가로채지 않는다.
  for (const cand of candidates(compactRavi(raw))) {
    const hit = EXACT.get(cand);
    if (hit?.length) {
      const m = hit.find(h => h.lang === ui) ?? hit[0];
      return { id: m.id, kind: m.id === "ravi-hello" || m.id === "ravi-goodnight" || m.id === "ravi-mood" || m.id === "ravi-kind" || m.id === "ravi-thanks" ? "chat" : "canon", lang: m.lang };
    }
  }
  // 3) 체인 정보(도구 없음).
  const chain = classifyChainQuestion(raw, ui);
  if (chain) return { id: `ravi-chain-${chain.topic}`, kind: "chain", lang: chain.lang, topic: chain.topic };
  // 4) 감정 — 지갑·코인 낱말이 있으면 물러난다.
  const spaced = spacedRavi(raw);
  if (spaced.length > 160 || findLang(WALLET_WORDS, raw, ui) || findLang(COIN_WORDS, raw, ui)) return null;
  if (NEGATED.test(compactRavi(raw)) || NEGATED_EN.test(spaced)) return null;
  for (const kind of EMOTION_ORDER) {
    const lang = findLang(EMOTION_WORDS[kind], raw, ui);
    if (lang) return { id: `ravi-emotion-${kind}`, kind: "emotion", lang, topic: kind };
  }
  return null;
}

/** 오늘 날짜 기준 경과(KST 달력). 고정 문구에 날짜를 박지 않으려고 코드가 계산한다. */
export function raviElapsed(now: Date): { months: number; years: number } {
  const birth = new Date(RAVI_BORN_UTC_MS + 9 * 3600e3), cur = new Date(Math.max(now.getTime(), RAVI_BORN_UTC_MS) + 9 * 3600e3);
  let months = (cur.getUTCFullYear() - birth.getUTCFullYear()) * 12 + (cur.getUTCMonth() - birth.getUTCMonth());
  const dayMs = (d: Date) => ((d.getUTCDate() * 24 + d.getUTCHours()) * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds();
  if (dayMs(cur) < dayMs(birth)) months -= 1;
  months = Math.max(0, months);
  return { months, years: Math.floor(months / 12) };
}

export function raviAgeText(lang: Lang, now: Date): string {
  const { months, years } = raviElapsed(now);
  const part = years >= 1 ? pick(AGE_YEARS, lang).replace("{0}", String(years))
    : months < 1 ? pick(AGE_LESS_THAN_MONTH, lang)
    : pick(AGE_MONTHS, lang).replace("{0}", String(months));
  return `${pick(AGE_BASE, lang)} ${part} ${pick(AGE_TAIL, lang)}`;
}

export function chainUnavailableText(topic: ChainTopic, lang: Lang): string {
  const base = pick(CHAIN_ANSWER, lang).replace("{0}", pick(CHAIN_TOPIC_LABEL[topic], lang));
  return topic === "price" ? `${base} ${pick(CHAIN_PRICE_EXTRA, lang)}` : base;
}

const moodGroup = (mood?: string): keyof typeof MOOD_ANSWER =>
  mood === "sleep" || mood === "sleepy" ? "sleepy" : mood === "thinking" || mood === "focused" || mood === "working" ? "busy" : mood === "worried" ? "worried" : "good";

export type PersonaReply = PersonaMatch & { text: string; event?: "user_thanks" | "ai_unknown" };
export type PersonaContext = { uiLang: Lang; now?: Date; mood?: string; hasKey?: boolean };

/** 문장 정리: 같은 말 뒤에 마침표·공백이 겹치지 않게. */
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** 위기 표현만 먼저 잡는 입구 — main.ts 가 다른 가로채기(도움말·홍보·송금·순위)보다 앞에서 부른다. */
export function raviCrisisReply(q: string, ui: Lang): PersonaReply | null {
  const raw = String(q ?? "");
  if (!raw.trim() || raw.length > 400) return null;
  const lang = findLang(CRISIS_WORDS, raw, ui);
  if (!lang) return null;
  const m: PersonaMatch = { id: "ravi-crisis", kind: "crisis", lang };
  return { ...m, text: raviPersonaText(m) };
}

export function raviPersonaText(m: PersonaMatch, ctx: { now?: Date; mood?: string } = {}): string {
  const lang = m.lang;
  if (m.kind === "crisis") return pick(CRISIS, lang);
  if (m.kind === "chain") return chainUnavailableText(m.topic as ChainTopic, lang);
  if (m.kind === "emotion") return pick(EMOTION[m.topic as EmotionKind], lang);
  switch (m.id) {
    case "ravi-age": return tidy(raviAgeText(lang, ctx.now ?? new Date()));
    case "ravi-hello": return pick(CHAT.hello, lang);
    case "ravi-goodnight": return pick(CHAT.goodnight, lang);
    case "ravi-kind": return pick(CHAT.kind, lang);
    case "ravi-mood": return pick(MOOD_ANSWER[moodGroup(ctx.mood)], lang);
    default: return pick(CANON[m.id], lang);
  }
}

/**
 * 로컬 응답 한 번. null 이면 호출자가 기존 경로(안내 검색 / AI)로 보낸다.
 * 정책: 위기·인물 설정·인사·체인 「도구 없음」은 AI 열쇠가 있어도 로컬. 감정은 열쇠가 **없을 때만** 로컬.
 */
/** 「해시율이 뭐야?」「explain the hashrate」 같은 **개념 질문**은 AI 열쇠가 있으면 AI 가 일반 지식으로 답한다(현재 값만 도구가 없다). */
const CONCEPT_QUESTION = /뭐야|뭔가요|뭐예요|뭐니|무슨뜻|의미|설명|원리|이란|とは|って何|意味|説明|仕組み|什么是|是什么意思|解释|原理|为什么|explain|meaning|howdoes|definition|whatdoes|spiega|explica|explique|erklar|объясни/;

export function raviPersonaReply(q: string, ctx: PersonaContext): PersonaReply | null {
  const m = classifyRaviTalk(q, ctx.uiLang);
  if (!m) return null;
  if (m.kind === "emotion" && ctx.hasKey) return null;
  if (m.kind === "chain" && ctx.hasKey && CONCEPT_QUESTION.test(compactRavi(q))) return null;
  const text = raviPersonaText(m, ctx);
  const event = m.id === "ravi-thanks" ? "user_thanks" : m.kind === "chain" ? "ai_unknown" : undefined;
  return { ...m, text, event };
}
