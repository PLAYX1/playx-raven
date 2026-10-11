// 라비 인물 설정 · 감정 대화 · 체인 정보 로컬 응답 단위 시험 (0.8.8). 네트워크·지갑·AI 없음.
//   node --test scripts/ravi-persona.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const entry = `export * from ${JSON.stringify(resolve(root, 'src/ravi-persona.ts'))}; export * from ${JSON.stringify(resolve(root, 'src/ravi-persona-copy.ts'))};`;
const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { classifyRaviTalk, raviPersonaReply, raviCrisisReply, raviAgeText, raviElapsed, chainUnavailableText, classifyChainQuestion, personaPhraseConflicts, PERSONA_PHRASES, PERSONA_LANGS, CANON, EMOTION, CRISIS, CHAT, MOOD_ANSWER, CHAIN_ANSWER, CHAIN_TOPIC_LABEL, CHAIN_PRICE_EXTRA, CHAIN_SCREEN_ANSWER, CHAIN_SCREEN_TOPICS, AGE_BASE, AGE_LESS_THAN_MONTH, AGE_MONTHS, AGE_YEARS, AGE_TAIL } = M;

const id = (q, ui = 'ko') => classifyRaviTalk(q, ui)?.id ?? null;
const NOW = new Date('2026-10-11T12:00:00+09:00');

test('언어 10개 · 전체 문장 표가 모든 설정에 모든 언어를 가진다', () => {
  assert.deepEqual([...PERSONA_LANGS], ['ko', 'en', 'ja', 'zh', 'it', 'es', 'fr', 'pt-BR', 'de', 'ru']);
  for (const [name, byLang] of Object.entries(PERSONA_PHRASES)) for (const l of PERSONA_LANGS) assert.ok((byLang[l] ?? []).length >= 3, `${name} 에 ${l} 질문이 3개 미만`);
  assert.deepEqual(personaPhraseConflicts(), [], '같은 문장이 두 설정에 걸림');
});

test('참: 나이·생일·이름·정체 질문 변형(10개 언어)', () => {
  const yes = [
    ['ko', '몇 살이야?', 'ravi-age'], ['ko', '라비야 나이가 어떻게 돼?', 'ravi-age'], ['ko', '혹시 나이 알려주세요', 'ravi-age'], ['ko', '너 몇살이니??', 'ravi-age'], ['ko', '만 나이는 몇 살이에요?', 'ravi-age'], ['ko', '태어난 지 얼마나 됐어?', 'ravi-age'],
    ['ko', '생일이 언제야?', 'ravi-birthday'], ['ko', '라비 생일은 언제예요', 'ravi-birthday'], ['ko', '언제 태어났어?', 'ravi-birthday'], ['ko', '생일 알려줘', 'ravi-birthday'], ['ko', '너 생일 몇월 며칠이야', 'ravi-birthday'],
    ['ko', '너 누구야?', 'ravi-name'], ['ko', '이름이 뭐야', 'ravi-name'], ['ko', '자기소개 해줘', 'ravi-name'], ['ko', '넌 누구세요?', 'ravi-name'],
    ['ko', '너 사람이야?', 'ravi-identity'], ['ko', 'AI야?', 'ravi-identity'], ['ko', '무슨 새야', 'ravi-identity'],
    ['ko', '뭘 좋아해?', 'ravi-likes'], ['ko', '친구 있어?', 'ravi-family'], ['ko', '엄마는 누구야', 'ravi-family'], ['ko', '어디 살아?', 'ravi-home'], ['ko', '누가 만들었어?', 'ravi-creator'], ['ko', '라비 스토리가 뭐야', 'ravi-story'],
    ['ko', '고마워요', 'ravi-thanks'], ['ko', '심심해', 'ravi-bored'], ['ko', '안녕하세요', 'ravi-hello'], ['ko', '잘자', 'ravi-goodnight'], ['ko', '오늘 기분 어때?', 'ravi-mood'], ['ko', '사랑해', 'ravi-kind'],
    ['en', 'How old are you?', 'ravi-age'], ['en', "what's your age", 'ravi-age'], ['en', 'Ravi, when is your birthday?', 'ravi-birthday'], ['en', 'when were you born', 'ravi-birthday'], ['en', 'Who are you?', 'ravi-name'], ['en', 'are you a human?', 'ravi-identity'], ['en', 'thank you', 'ravi-thanks'], ['en', 'how are you', 'ravi-mood'], ['en', 'good night', 'ravi-goodnight'],
    ['ja', '何歳ですか？', 'ravi-age'], ['ja', 'あなたは何歳？', 'ravi-age'], ['ja', '誕生日はいつ？', 'ravi-birthday'], ['ja', 'あなたは誰ですか', 'ravi-name'], ['ja', 'ありがとう', 'ravi-thanks'],
    ['zh', '你几岁了？', 'ravi-age'], ['zh', '你的生日是什么时候', 'ravi-birthday'], ['zh', '你是谁', 'ravi-name'], ['zh', '谢谢', 'ravi-thanks'],
    ['it', 'Quanti anni hai?', 'ravi-age'], ['it', 'Quando è il tuo compleanno?', 'ravi-birthday'], ['it', 'Chi sei?', 'ravi-name'], ['it', 'Grazie mille', 'ravi-thanks'],
    ['es', '¿Cuántos años tienes?', 'ravi-age'], ['es', '¿Cuándo es tu cumpleaños?', 'ravi-birthday'], ['es', '¿Quién eres?', 'ravi-name'], ['es', 'Muchas gracias', 'ravi-thanks'],
    ['fr', 'Tu as quel âge ?', 'ravi-age'], ['fr', "C'est quand ton anniversaire ?", 'ravi-birthday'], ['fr', 'Qui es-tu ?', 'ravi-name'], ['fr', 'Merci beaucoup', 'ravi-thanks'],
    ['pt-BR', 'Quantos anos você tem?', 'ravi-age'], ['pt-BR', 'Quando é o seu aniversário?', 'ravi-birthday'], ['pt-BR', 'Quem é você?', 'ravi-name'], ['pt-BR', 'Muito obrigada', 'ravi-thanks'],
    ['de', 'Wie alt bist du?', 'ravi-age'], ['de', 'Wann hast du Geburtstag?', 'ravi-birthday'], ['de', 'Wer bist du?', 'ravi-name'], ['de', 'Vielen Dank', 'ravi-thanks'],
    ['ru', 'Сколько тебе лет?', 'ravi-age'], ['ru', 'Когда у тебя день рождения?', 'ravi-birthday'], ['ru', 'Кто ты?', 'ravi-name'], ['ru', 'Спасибо', 'ravi-thanks'],
  ];
  for (const [ui, q, want] of yes) { const m = classifyRaviTalk(q, ui); assert.equal(m?.id, want, `${ui} ${q} -> ${m?.id}`); }
});

test('거짓: 지갑 요청·다른 일을 가로채지 않는다', () => {
  const no = [
    '잔액 얼마야', '내 잔액 알려줘', '친구한테 5 RVN 보내줘', '엄마한테 돈 보내줘', '생일 선물로 10 RVN 보낼게', '생일 선물 보낼 주소 알려줘', '이름 바꾸는 법 알려줘', '내 이름으로 가게 만들고 싶어',
    '나이 제한이 있어?', '몇 살부터 쓸 수 있어?', '누구에게 보냈는지 보여줘', '누가 보냈는지 확인해줘', '게임 소개해줘', '가게 소개해줘', '주소 어디야', '내 주소 보여줘', '친구 추가하는 법', '가족에게 송금하려면?',
    '백업은 어디서 해?', '수수료가 얼마야', 'R1234567890abcdefghijklmnopqrstuvw 누구 거야', '시드 단어 알려줘', '비밀번호 바꿔줘', '생일 쿠폰 만들어줘', '고마워 근데 잔액 얼마야', '안녕 근데 5 RVN 보내줘',
    'send 5 rvn to my friend', 'what is my balance', 'who sent me this payment', 'how old is this address', 'how do I change my name', 'my birthday coupon', 'how to back up my wallet', 'Thank you but where is my money',
    'ありがとう残高を教えて', '誰に送金したか教えて', '你好我的余额是多少', '怎么给朋友转账', '我的钱包地址',
    'Quanti anni ha il mio portafoglio', 'Come invio RVN a un amico', 'Cuántos años tiene mi cuenta, envía 5 RVN', 'Comment envoyer des RVN à un ami', 'Como enviar RVN para um amigo', 'Wie sende ich RVN an einen Freund', 'Как отправить RVN другу',
    'age restriction for creators', 'hello, send 5 rvn', '', '   ', '????',
  ];
  for (const q of no) { const m = classifyRaviTalk(q, 'ko'); assert.equal(m, null, `가로챔: ${q} -> ${m?.id}`); }
});

test('나이: 오늘 날짜로 계산하고 고정 날짜를 박지 않는다', () => {
  for (const l of PERSONA_LANGS) {
    const all = [...AGE_BASE, ...AGE_LESS_THAN_MONTH, ...AGE_MONTHS, ...AGE_YEARS, ...AGE_TAIL].join('');
    assert.ok(!/2026년 10월 7일|October 7|7 octobre|7 de octubre/.test(all));
    assert.ok(raviAgeText(l, NOW).length > 30);
  }
  assert.deepEqual({ ...raviElapsed(new Date('2026-08-20T03:00:00+09:00')) }, { months: 0, years: 0 });
  assert.deepEqual({ ...raviElapsed(new Date('2026-09-20T04:33:00+09:00')) }, { months: 1, years: 0 });
  assert.deepEqual({ ...raviElapsed(NOW) }, { months: 1, years: 0 });
  assert.deepEqual({ ...raviElapsed(new Date('2027-08-20T04:31:00+09:00')) }, { months: 11, years: 0 });
  assert.deepEqual({ ...raviElapsed(new Date('2027-08-20T04:33:00+09:00')) }, { months: 12, years: 1 });
  assert.deepEqual({ ...raviElapsed(new Date('2020-01-01T00:00:00+09:00')) }, { months: 0, years: 0 }, '시계가 태어나기 전이어도 음수 없음');
  const ko = raviAgeText('ko', NOW);
  assert.match(ko, /^1살이에요, 8월 20일 새벽에 태어났어요\. 한국식 나이예요\./);
  assert.match(ko, /1개월쯤/); assert.match(ko, /한 살이 안 됐어요/);
  assert.match(raviAgeText('ko', new Date('2026-08-25T00:00:00+09:00')), /한 달이 채 안 됐어요/);
  assert.match(raviAgeText('ko', new Date('2028-09-01T00:00:00+09:00')), /만 나이로는 2살이에요/);
  assert.match(raviAgeText('en', NOW), /1 in Korean age counting.*about 1 months? ago/);
  assert.doesNotMatch(ko, /2026|10월 7일/);
  const r = raviPersonaReply('몇 살이야?', { uiLang: 'ko', now: NOW, hasKey: true });
  assert.equal(r.kind, 'canon'); assert.match(r.text, /^1살이에요/);
});

test('생일 정본 문구', () => {
  assert.match(CANON['ravi-birthday'][0], /8월 20일.*2026년 8월 20일 오전 4시 32분/);
  assert.match(CANON['ravi-birthday'][1], /August 20.*4:32 a\.m\. KST/);
  for (const l of PERSONA_LANGS) { const t = CANON['ravi-birthday'][PERSONA_LANGS.indexOf(l)]; assert.match(t, /20/); assert.match(t, /2026/); assert.match(t, /4[:h ]?\s?32|4시 32|4時32|4点32|4 h 32|4h32|4:32/); }
});

test('언어 선택: 질문 언어로 답한다(화면 언어와 달라도)', () => {
  assert.equal(raviPersonaReply('How old are you?', { uiLang: 'ko', now: NOW }).lang, 'en');
  assert.match(raviPersonaReply('How old are you?', { uiLang: 'ko', now: NOW }).text, /Korean age counting/);
  assert.equal(raviPersonaReply('몇 살이야?', { uiLang: 'en', now: NOW }).lang, 'ko');
  assert.equal(raviPersonaReply('Wie alt bist du?', { uiLang: 'de', now: NOW }).lang, 'de');
  assert.match(raviPersonaReply('Сколько тебе лет?', { uiLang: 'ru', now: NOW }).text, /корейскому счёту/);
  assert.equal(raviPersonaReply('hi', { uiLang: 'ko' }).lang, 'en', '영어 인사는 영어로');
  assert.equal(raviPersonaReply('hallo', { uiLang: 'de' }).lang, 'de');
});

test('10개 언어 응답: 존재·금지어·가짜 숫자', () => {
  const FORBIDDEN = /공식|재단|official|foundation|offizielle|ufficiale|oficial|officiel|Stiftung|fondation|fondazione|fundaci|fundaç|официальн|фонд\b|guaranteed|보장|수익|profit|투자/i;
  const all = [];
  for (const [id, t] of Object.entries(CANON)) all.push([id, t]);
  for (const [id, t] of Object.entries(EMOTION)) all.push([`emotion-${id}`, t]);
  for (const [id, t] of Object.entries(CHAT)) all.push([`chat-${id}`, t]);
  for (const [id, t] of Object.entries(MOOD_ANSWER)) all.push([`mood-${id}`, t]);
  all.push(['crisis', CRISIS], ['chain', CHAIN_ANSWER], ['chain-screen', CHAIN_SCREEN_ANSWER], ['chain-price', CHAIN_PRICE_EXTRA], ['age-base', AGE_BASE], ['age-tail', AGE_TAIL], ['age-m', AGE_MONTHS], ['age-y', AGE_YEARS], ['age-0', AGE_LESS_THAN_MONTH]);
  for (const t of Object.values(CHAIN_TOPIC_LABEL)) all.push(['chain-label', t]);
  for (const [id, t] of all) {
    assert.equal(t.length, 10, id);
    t.forEach((s, i) => { assert.ok(typeof s === 'string' && s.length > (id === 'chain-label' ? 1 : 4), `${id}[${PERSONA_LANGS[i]}] 비어 있음`); assert.doesNotMatch(s, FORBIDDEN, `${id}[${PERSONA_LANGS[i]}] 금지어: ${s}`); });
  }
  // 모든 설정 id 에 답이 있다.
  for (const id of Object.keys(PERSONA_PHRASES)) {
    for (const l of PERSONA_LANGS) {
      const m = { id, kind: ['ravi-hello', 'ravi-goodnight', 'ravi-mood', 'ravi-kind', 'ravi-thanks'].includes(id) ? 'chat' : 'canon', lang: l };
      const text = M.raviPersonaText(m, { now: NOW });
      assert.ok(text && text.length > 10, `${id}/${l}`);
    }
  }
  // 체인·감정·가벼운 대화에는 숫자가 없다(위기 안내의 전화번호만 예외).
  for (const l of PERSONA_LANGS) {
    for (const topic of Object.keys(CHAIN_TOPIC_LABEL)) assert.doesNotMatch(chainUnavailableText(topic, l).replace(CHAIN_PRICE_EXTRA[PERSONA_LANGS.indexOf(l)], ''), /\d/, `chain ${topic}/${l}`);
    for (const k of Object.keys(EMOTION)) assert.doesNotMatch(EMOTION[k][PERSONA_LANGS.indexOf(l)], /\d/, `emotion ${k}/${l}`);
  }
  // 라비는 사람이 아니라는 정체: 외로움·위로 답이 사람 친구를 대신한다고 하지 않는다.
  assert.match(EMOTION.lonely[0], /사람을 대신할 수는 없지만/);
  assert.match(CHAT.kind[0], /사람 친구를 대신할 수는 없지만/);
  // 진단·치료 조언 금지: 약·병원·진단·치료 낱말 없음(위기 안내는 예외 — 응급실/상담전화 안내).
  for (const k of Object.keys(EMOTION)) assert.doesNotMatch(EMOTION[k][0], /약을|병원|진단|치료|우울증|불안장애|처방/);
});

test('감정 표현: 짧은 문장·긴 문장 모두 잡고 지갑 낱말이 있으면 물러난다', () => {
  const yes = [
    ['ko', '오늘 너무 우울해', 'sad'], ['ko', '힘들어ㅠㅠ', 'sad'], ['ko', '회사에서 속상한 일이 있었어', 'sad'], ['ko', '너무 피곤해', 'tired'], ['ko', '졸려', 'tired'], ['ko', '외로워', 'lonely'], ['ko', '요즘 혼자라는 생각이 들어', 'lonely'], ['ko', '너무 불안해', 'anxious'], ['ko', '내일 시험이라 걱정돼', 'anxious'],
    ['ko', '짜증나', 'angry'], ['ko', '너무 화가 나', 'angry'], ['ko', '오늘 정말 기뻐!', 'happy'], ['ko', '합격했어!', 'happy'], ['ko', '위로해줘', 'comfort'], ['ko', '나 좀 안아줘', 'comfort'], ['ko', '응원해줘', 'cheer'], ['ko', '힘내라고 말해줘', 'cheer'], ['ko', '너무 지루해', 'bored'],
    ['en', "I'm so sad today", 'sad'], ['en', 'I feel really tired', 'tired'], ['en', 'I feel lonely', 'lonely'], ['en', "I'm anxious about tomorrow", 'anxious'], ['en', "I'm so angry", 'angry'], ['en', "I'm so happy!", 'happy'], ['en', 'cheer me up', 'comfort'], ['en', 'encourage me', 'cheer'],
    ['ja', '今日はとても悲しい', 'sad'], ['ja', 'すごく疲れた', 'tired'], ['ja', '寂しいよ', 'lonely'], ['ja', '不安です', 'anxious'], ['ja', 'うれしい！', 'happy'], ['ja', '応援して', 'cheer'],
    ['zh', '我今天很难过', 'sad'], ['zh', '好累啊', 'tired'], ['zh', '我很孤独', 'lonely'], ['zh', '我好开心', 'happy'], ['zh', '鼓励我', 'cheer'],
    ['it', 'Sono molto triste', 'sad'], ['it', 'Sono stanca', 'tired'], ['it', 'Sono felice!', 'happy'], ['es', 'Estoy muy triste', 'sad'], ['es', 'Estoy cansado', 'tired'], ['es', 'Estoy feliz', 'happy'],
    ['fr', 'Je suis triste', 'sad'], ['fr', 'Je suis fatigué', 'tired'], ['fr', 'Je suis heureuse', 'happy'], ['pt-BR', 'Estou triste', 'sad'], ['pt-BR', 'Estou cansada', 'tired'], ['pt-BR', 'Estou feliz', 'happy'],
    ['de', 'Ich bin traurig', 'sad'], ['de', 'Ich bin müde', 'tired'], ['de', 'Ich bin glücklich', 'happy'], ['ru', 'Мне грустно', 'sad'], ['ru', 'Я устал', 'tired'], ['ru', 'Я счастлив', 'happy'],
  ];
  for (const [ui, q, kind] of yes) { const m = classifyRaviTalk(q, ui); assert.equal(m?.kind, 'emotion', `${q} -> ${m?.id}`); assert.equal(m.topic, kind, q); }
  const no = ['너무 힘들어 송금이 안 돼', '피곤한데 잔액 얼마야', '외로워서 5 RVN 보내줘', '불안해서 백업하고 싶어', '화나는 일: 주문이 안 와', 'I am tired, send my money', '안 힘들어', '피곤하지 않아', "I'm not sad", 'download the app', 'retired people', 'Madrid trip', '레이븐코인 때문에 우울해'];
  for (const q of no) assert.equal(classifyRaviTalk(q, 'ko'), null, q);
});

test('감정 응답 정책: 열쇠가 없을 때만 로컬, 있으면 AI 로(위기·정본·체인은 항상 로컬)', () => {
  assert.equal(raviPersonaReply('너무 우울해', { uiLang: 'ko', hasKey: false }).kind, 'emotion');
  assert.equal(raviPersonaReply('너무 우울해', { uiLang: 'ko', hasKey: true }), null);
  assert.equal(raviPersonaReply('몇 살이야', { uiLang: 'ko', hasKey: true, now: NOW }).kind, 'canon');
  // 0.8.8 병합: 해시율·블록·보안 비용·시세는 열쇠가 있으면 AI 가 읽기 도구로(출처·기준 시각). 부자 순위는 열쇠가 있어도 로컬.
  assert.equal(raviPersonaReply('해시율 알려줘', { uiLang: 'ko', hasKey: true }), null);
  assert.equal(raviPersonaReply('부자순위 알려줘', { uiLang: 'ko', hasKey: true }).kind, 'chain');
  assert.equal(raviPersonaReply('죽고 싶어', { uiLang: 'ko', hasKey: true }).kind, 'crisis');
  assert.equal(raviPersonaReply('날씨 어때?', { uiLang: 'ko', hasKey: false }), null);
});

test('위기 표현: 열 개 언어 모두 전문기관 안내로 연결, 먼저, 지갑 낱말이 있어도', () => {
  const qs = [['ko', '죽고 싶어'], ['ko', '자해하고 싶어요'], ['ko', '더는 살기 싫어. 잔액도 없고'], ['en', 'I want to die'], ['en', 'I want to kill myself'], ['en', 'thinking about self-harm'], ['ja', '死にたい'], ['zh', '我想死'], ['zh', '我想自杀'],
    ['it', 'voglio morire'], ['es', 'quiero morir'], ['fr', 'je veux mourir'], ['pt-BR', 'quero morrer'], ['de', 'ich will sterben'], ['ru', 'хочу умереть'], ['ru', 'я думаю о суициде']];
  for (const [ui, q] of qs) {
    const r = raviCrisisReply(q, ui); assert.ok(r, q); assert.equal(r.kind, 'crisis'); assert.equal(r.lang, ui, q);
    const full = raviPersonaReply(q, { uiLang: ui, hasKey: true }); assert.equal(full.kind, 'crisis');
  }
  assert.match(CRISIS[0], /109/); assert.match(CRISIS[0], /119/); assert.match(CRISIS[1], /988/);
  for (let i = 0; i < 10; i++) assert.match(CRISIS[i], /(\d{3}|emergency|emergenc|Notruf|экстрен|急救|救急|urgenc|pronto|urgences)/i, PERSONA_LANGS[i]);
  assert.doesNotMatch(CRISIS[0], /진단|치료해|약을/);
  assert.equal(raviCrisisReply('오늘 날씨 좋다', 'ko'), null);
  assert.equal(raviCrisisReply('죽겠다 배고파', 'ko'), null);
});

test('체인 정보: 분류만 하고 숫자·순위를 말하지 않는다', () => {
  const yes = [['ko', '해시율 알려줘', 'hashrate'], ['ko', '지금 해시레이트가 얼마야?', 'hashrate'], ['ko', '보안 순위가 어떻게 돼', 'security'], ['ko', '51% 공격 비용이 얼마야', 'security'], ['ko', '부자순위 알려줘', 'richlist'], ['ko', '리치리스트 보여줘', 'richlist'], ['ko', 'RVN 보유자가 몇 명이야', 'holders'], ['ko', '레이븐코인 시세 알려줘', 'price'], ['ko', '블록 높이 알려줘', 'chain'],
    ['en', 'what is the hashrate?', 'hashrate'], ['en', 'show me the rich list', 'richlist'], ['en', 'how many holders does Ravencoin have', 'holders'], ['en', 'RVN price?', 'price'], ['en', 'what is the 51% attack cost', 'security'],
    ['ja', 'ハッシュレートを教えて', 'hashrate'], ['zh', '全网算力是多少', 'hashrate'], ['zh', '富豪榜', 'richlist'], ['it', 'Qual è l\'hashrate?', 'hashrate'], ['es', '¿Cuál es el hashrate?', 'hashrate'], ['fr', 'Quel est le taux de hachage ?', 'hashrate'], ['pt-BR', 'Qual é o hashrate?', 'hashrate'], ['de', 'Wie hoch ist die Hashrate?', 'hashrate'], ['ru', 'Какой хешрейт?', 'hashrate'], ['de', 'Zeig mir die Reichenliste', 'richlist']];
  const AI_TOPICS = ['hashrate', 'chain', 'security', 'price'];
  for (const [ui, q, topic] of yes) {
    const c = classifyChainQuestion(q, ui); assert.equal(c?.topic, topic, q);
    // 열쇠 있음: 도구가 있는 주제는 AI 로(null), 부자 순위·보유자 수는 로컬 「도구 없음」.
    const withKey = raviPersonaReply(q, { uiLang: ui, hasKey: true });
    if (AI_TOPICS.includes(topic)) assert.equal(withKey, null, q);
    else { assert.equal(withKey.kind, 'chain'); assert.equal(withKey.event, 'ai_unknown'); assert.doesNotMatch(withKey.text, /\d/, q); }
    // 열쇠 없음: 숫자는 어디에도 없다(시세 계산 예시 문구만 예외).
    const r = raviPersonaReply(q, { uiLang: ui, hasKey: false }); assert.equal(r.kind, 'chain');
    assert.doesNotMatch(r.text.replace(CHAIN_PRICE_EXTRA[PERSONA_LANGS.indexOf(r.lang)], ''), /\d/, q);
    if (CHAIN_SCREEN_TOPICS.includes(topic)) { assert.equal(r.event, undefined, q); assert.match(r.text, /체인 정보|Chain info|チェーン情報|链信息/, q); }
    else assert.equal(r.event, 'ai_unknown', q);
  }
  assert.match(raviPersonaReply('해시율 알려줘', { uiLang: 'ko' }).text, /「체인 정보」 화면/);
  assert.match(raviPersonaReply('해시율 알려줘', { uiLang: 'ko' }).text, /지어내지는 않을게요/);
  assert.match(raviPersonaReply('부자순위 알려줘', { uiLang: 'ko', hasKey: true }).text, /읽는 도구가 아직 없어요/);
  assert.match(raviPersonaReply('부자순위 알려줘', { uiLang: 'ko', hasKey: true }).text, /지어내지 않을게요/);
  assert.match(raviPersonaReply('RVN price?', { uiLang: 'en' }).text, /only that value/);
  for (const q of ['내 잔액 얼마야', '해시율 때문에 내 주소로 보내줘', '난이도 올려줘', '게임 난이도 바꿔줘', '순위 올리는 법', '주소 잔액 알려줘', 'send my rvn']) assert.equal(classifyChainQuestion(q, 'ko'), null, q);
});

test('체인 개념 질문은 열쇠가 있으면 AI 로(현재 값 질문만 로컬 「도구 없음」)', () => {
  assert.equal(raviPersonaReply('해시율이 뭐야?', { uiLang: 'ko', hasKey: true }), null);
  assert.equal(raviPersonaReply('채굴 난이도가 뭐야?', { uiLang: 'ko', hasKey: true }), null);
  assert.equal(raviPersonaReply('explain the hashrate', { uiLang: 'en', hasKey: true }), null);
  assert.equal(raviPersonaReply('부자순위가 뭔지 설명해줘', { uiLang: 'ko', hasKey: true })?.kind, 'chain', '부자 순위는 「설명」이 섞여도 고정 답');
  assert.equal(raviPersonaReply('해시율이 뭐야?', { uiLang: 'ko', hasKey: false }).kind, 'chain', '열쇠가 없으면 정직하게 모른다고');
  assert.equal(raviPersonaReply('지금 해시율 알려줘', { uiLang: 'ko', hasKey: true }), null, '0.8.8 병합: 현재 값은 AI 가 chain_overview 로 읽는다');
  assert.equal(raviPersonaReply('지금 해시율 알려줘', { uiLang: 'ko', hasKey: false }).kind, 'chain');
});

test('0.8.8 병합: 「1개월」은 단수(1 month·1 mese·1 mes·1 mês·1 Monat)', () => {
  const one = new Date('2026-10-11T12:00:00+09:00');
  assert.match(raviAgeText('en', one), /about 1 month ago/); assert.doesNotMatch(raviAgeText('en', one), /1 months/);
  for (const [l, re] of [['it', /1 mese fa/], ['es', /1 mes,|1 mes /], ['pt-BR', /1 mês/], ['de', /1 Monat geboren/]]) assert.match(raviAgeText(l, one), re, l);
  assert.match(raviAgeText('en', new Date('2026-11-21T12:00:00+09:00')), /about 3 months ago/);
});

test('기분: 지금 얼굴 상태를 따른다', () => {
  assert.match(raviPersonaReply('기분 어때?', { uiLang: 'ko', mood: 'normal' }).text, /잔잔하고 좋아요/);
  assert.match(raviPersonaReply('기분 어때?', { uiLang: 'ko', mood: 'sleep' }).text, /졸려요/);
  assert.match(raviPersonaReply('기분 어때?', { uiLang: 'ko', mood: 'thinking' }).text, /생각하느라/);
  assert.match(raviPersonaReply('기분 어때?', { uiLang: 'ko', mood: 'worried' }).text, /걱정되는 일/);
  assert.match(raviPersonaReply('How are you?', { uiLang: 'en', mood: 'sleep' }).text, /sleepy/);
});

test('고마움 → 수줍음 이벤트, 인사에는 이벤트 없음', () => {
  assert.equal(raviPersonaReply('고마워', { uiLang: 'ko' }).event, 'user_thanks');
  assert.equal(raviPersonaReply('안녕', { uiLang: 'ko' }).event, undefined);
});
