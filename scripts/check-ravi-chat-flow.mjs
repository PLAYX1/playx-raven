// 라비 대화 흐름(2026-10-11) — 실제 main.ts·ravi-agent.ts·ravi-chat.ts 코드를 VM 에서 돌린다.
// 합성 데이터만 쓴다. AI·노드·지갑·인터넷·키는 없다. 모든 invoke 는 기록되고, 송금 명령은 즉시 실패한다.
//   (a) 동의 미저장 + 일반 질문 → 답이 나오고 버려지지 않음
//   (b) 동의 저장 → 보류 질문 자동 재전송
//   (c) 지금은 취소 → 일반 대화 유지, 카드 다시 안 뜸
//   (d) 열쇠 1개 + 두 곳에 묻기 → 한 말풍선에 안내+답 하나
//   (e) 돈 보내줘 → 거절+안내+이동 단추, 송금·AI 명령 없음
//   (f) 공개 체인 질문 → 정직한 답, 시세 지어내기 없음
//   (g) 개인정보가 AI/공개 조회로 나가지 않음
//   (h) 비밀 노출 없음
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

const bundle = async entry => { const r = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }); const c = { module: { exports: {} }, exports: {}, navigator: { language: 'ko' }, localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: { lang: 'ko', setAttribute() {} } } }; vm.runInNewContext(r.outputFiles[0].text, c); return c.module.exports; };
const chat = await bundle('src/ravi-chat.ts');
const guide = await bundle('src/ravi-guide.ts');
const consentNeed = await bundle('src/ravi-consent-need.ts');
const persona = await bundle('src/ravi-persona.ts');
const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
let passed = 0; const ok = (name) => { passed++; console.log('PASS ' + name); };

/* ── (f) 부자 순위 · 시세 ─────────────────────────────────────────── */
const P = q => chat.parseRichQuestion(q);
assert.deepEqual({ ...P('380만개면 부자순위 몇위야?') }, { amount: 3_800_000, price: null });
assert.deepEqual({ ...P('380만 개면 부자 순위 몇 위?') }, { amount: 3_800_000, price: null });
assert.equal(P('3.8M RVN rich list rank?').amount, 3_800_000);
assert.equal(P('380万个 排名第几').amount, 3_800_000);
assert.equal(P('부자순위 알려줘'), null, '개수 없이는 계산할 것이 없다');
assert.equal(P('내일 비 와?'), null); assert.equal(P('5 RVN 보내줘'), null);
const priced = P('1 RVN = 30원이면 380만개 부자순위 몇위?');
assert.equal(priced.amount, 3_800_000); assert.deepEqual({ ...priced.price }, { value: 30, currency: 'KRW' });
assert.deepEqual({ ...P('$0.02 per RVN, 3.8m rvn what rank').price }, { value: 0.02, currency: 'USD' });
assert.equal(chat.userStatedPrice('380만개면 부자순위 몇위야?'), null, '말하지 않은 시세는 없다');
const honest = text(chat.raviRichAnswerHtml('380만개면 부자순위 몇위야?', P('380만개면 부자순위 몇위야?'), 'ko', true));
assert.match(honest, /공개된 부자 순위표를 찾지 못해 정확한 순위는 몰라요/);
assert.match(honest, /3,800,000 RVN의 돈 가치는 시세를 알아야/);
assert.ok(!/\d[\d,.]*\s*(원|달러|KRW|USD)/.test(honest), '시세를 지어내지 않는다: ' + honest);
assert.ok(!/위입니다|\d+\s*위/.test(honest), '순위를 지어내지 않는다');
assert.ok(!honest.includes('AI 열쇠를 넣으면'), '열쇠가 있으면 열쇠 안내 없음');
const pricedAnswer = text(chat.raviRichAnswerHtml('1 RVN = 30원이면 380만개 부자순위 몇위?', priced, 'ko', false));
assert.match(pricedAnswer, /말씀하신 시세\(1 RVN = 30원\)로 계산하면 3,800,000 RVN은 약 114,000,000원이에요/);
assert.match(pricedAnswer, /AI 열쇠를 넣으면 더 잘 답해요/, '열쇠 없으면 한 줄 안내');
for (const [q, lang] of [['3.8M RVN rich list rank?', 'en'], ['380万个 排名第几', 'zh']]) {
  const h = chat.raviRichAnswerHtml(q, P(q), 'ko', true);
  assert.match(h, new RegExp(`data-ravi-language="${lang}"`)); assert.ok(!/[가-힣]/.test(text(h)), lang + ' 한국어 섞임');
}
ok('(f) rich-list question: honest unknown rank, price only when user states it, 4-language copy');

/* ── (e) 송금 부탁 판정 ───────────────────────────────────────────── */
for (const q of ['돈 보내줘', '친구한테 5 RVN 보내줘', '송굼 하려면 어디로 가요?', 'send 5 rvn to my friend']) assert.equal(chat.isRaviSendRequest(q), true, q);
for (const q of ['사진 보내줘', '380만개면 부자순위 몇위야?', '내일 비 와?']) assert.equal(chat.isRaviSendRequest(q), false, q);
assert.equal(chat.isExplicitSendOrder('R111111111111111111111111111111111 1 RVN 보내줘'), true);
assert.equal(chat.isExplicitSendOrder('돈 보내줘'), false);
const refusal = chat.raviSendAnswerHtml('돈 보내줘', 'ko');
assert.match(text(refusal), /송금은 라비가 대신 하지 않아요/); assert.match(text(refusal), /아주 적은 금액으로 먼저/);
assert.match(refusal, /data-guide-go="send"/);
ok('(e) send-request detection and refusal copy with Send button');

/* ── 공개 조회 판정 ──────────────────────────────────────────────── */
const ADDR = 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB';
assert.equal(chat.publicAddressQuestion(`${ADDR} 잔액 얼마야?`), ADDR);
assert.equal(chat.publicAddressQuestion(`${ADDR} 로 5 RVN 보내줘`), null);
assert.equal(chat.publicAddressQuestion('잔액 얼마야?'), null);
const offer = chat.raviPublicOfferHtml(`${ADDR} 잔액 얼마야?`, ADDR, 'ko');
assert.match(text(offer), /blockbook\.ravencoin\.org/); assert.match(text(offer), /주문 메모·고객 이름은 보내지 않아요/);
assert.match(offer, new RegExp(`data-ravi-public="${ADDR}"`));
assert.ok(!chat.raviPublicOfferHtml('x', '"><img src=x>', 'ko').includes('<img'), '주소 칸 주입 차단');
assert.match(text(chat.raviPublicResultHtml({ status: 'ok', rvn: 42.5, assets_unknown: true }, 'ko')), /42\.5 RVN.*자산.*못 봐요/);
assert.match(text(chat.raviPublicResultHtml({ status: 'no_data' }, 'ko')), /주지 않았어요/);
ok('public lookup: only a typed address, disclosed before asking, numbers-only result');

/* ── 실제 main.ts 대화 함수 ─────────────────────────────────────── */
const mainSource = readFileSync('src/main.ts', 'utf8'), ast = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
const fn = name => { const n = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name); assert.ok(n, name); return n.getText(ast); };
const constText = name => ast.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations[0].name.getText(ast) === name).getText(ast);
const SPEND = /^(send_rvn|send_asset|send_many|wallet_send|sign_and_send|phone_transaction_send|broadcast)$/;
function harness({ consent = { reviewed: false, balance: false, transactions: false, shop: false }, usable = 1, mode = 'fill', reply = '합성 AI 답', personaLoad = async () => persona } = {}) {
  const messages = [], calls = [], offers = [], events = []; let held = null, declined = false, savedConsent = { ...consent };
  const input = { value: '' };
  const ui = {
    async consentState() { return { ...savedConsent }; },
    offerConsent(saved) { if (declined || savedConsent.reviewed) return false; offers.push(1); held = saved; return true; },
  };
  const ctx = vm.createContext({
    ...chat, ...guide, ...consentNeed, ...persona, loadRaviPersona: personaLoad, raviState: 'normal', emitRaviEvent: name => events.push(name), lang: 'ko', aiProvider: 'synthetic', chatMode: mode, aiUsableCount: usable, raviRequestPending: false, raviHeldQuestion: '',
    DEBATE_ONE_NOTE: 'AI가 하나만 연결돼 있어 바로 답할게요.', TOOL_LABELS: {}, raviAgentUI: ui,
    raviHome: { sent() {}, thinking() {}, finish() {}, open() {} }, setTimeout,
    $: id => id === 'chat-q' ? input : { append() {}, lastElementChild: null },
    document: { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }) },
    Channel: class { },
    tzMin: () => 540, copyHtml: s => s, t: s => s, escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    errText: e => String(e), setAllRaviMood() {}, chatPopThinking() { if (/data-thinking/.test(messages.at(-1)?.html || '')) messages.pop(); }, applyActions: () => [], raviOpenScreen() {}, openRaviPromo: async () => {},
    whoseQuestion: () => null, raviWhose() {}, isPromoRequest: () => false,
    chatSay: (who, t) => messages.push({ who, text: t }), chatHtml: (who, html) => messages.push({ who, html, text: text(html) }),
    invoke: async (command, args) => {
      calls.push({ command, args: Object.fromEntries(Object.entries(args || {}).filter(([k]) => k !== 'progress')), keys: Object.keys(args || {}).sort() });
      if (SPEND.test(command)) throw Error('Forbidden spend ' + command);
      if (command === 'ai_debate') throw '두 곳 이상의 API 키가 있어야 합니다. 설정에서 하나 더 넣어 주세요.';
      if (command === 'ravi_agent_chat') return { reply: typeof reply === 'function' ? reply(args) : reply, prepared: [] };
      throw Error('Unexpected command ' + command);
    },
  });
  const src = ['chatSend', 'chatSendExisting', 'chatAgent', 'chatAsk', 'resendHeldQuestion', 'chatDebate', 'raviGuide', 'raviPersonaSay'].map(fn).join('\n');
  vm.runInContext(ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return {
    ctx, messages, calls, offers, events,
    async send(q) { input.value = q; const n = messages.length; await ctx.chatSend(); return messages.slice(n); },
    async save(next = { reviewed: true, balance: true, transactions: false, shop: false }) { savedConsent = next; const n = messages.length; held(); for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); return messages.slice(n); },
    cancel() { declined = true; },
  };
}

// (a) 동의 미저장 + 일반 질문
let h = harness();
let said = await h.send('레이븐코인은 언제 만들어졌어?');
assert.deepEqual(said.map(m => m.who), ['me', 'ai']); assert.equal(said[1].text, '합성 AI 답');
assert.ok(!said.some(m => /보내지 않았어요/.test(m.text)));
assert.equal(h.calls.filter(c => c.command === 'ravi_agent_chat').length, 1);
assert.equal(h.offers.length, 0, '일반 질문에는 동의 카드를 붙이지 않는다');
said = await h.send('금이 왜 비싸?'); assert.equal(h.offers.length, 0, '일반 질문에 카드 없음');
said = await h.send('내 잔액 얼마야?'); assert.equal(h.offers.length, 1, '내 정보 질문에는 답 아래 카드를 한 번 제안');
said = await h.send('내 거래 내역 알려줘');
assert.equal(said[1].text, '합성 AI 답', '카드가 떠 있어도 다음 질문은 막히지 않는다');
ok('(a) unsaved consent: general answer, nothing dropped, next question not blocked');

// (a2) 0.8.8 — 인물 설정·위기·체인 「도구 없음」은 열쇠가 있어도 로컬이 먼저(AI 호출 없음), 감정은 열쇠가 있으면 AI 로
const h2 = harness();
const beforeCalls = h2.calls.length;
let s2 = await h2.send('몇살이야?');
assert.deepEqual(s2.map(m => m.who), ['me', 'ai']); assert.match(s2[1].html, /^<div translate="no">1살이에요, 8월 20일 새벽에 태어났어요/);
s2 = await h2.send('죽고 싶어'); assert.match(s2[1].text, /109/);
s2 = await h2.send('부자순위 알려줘'); assert.match(s2[1].text, /읽는 도구가 아직 없어요/); assert.ok(h2.events.includes('ai_unknown'));
s2 = await h2.send('고마워'); assert.ok(h2.events.includes('user_thanks'));
assert.equal(h2.calls.length, beforeCalls, '정본·위기·부자 순위 질문은 AI/RPC 를 부르지 않는다');
s2 = await h2.send('해시율 알려줘'); assert.equal(h2.calls.filter(c => c.command === 'ravi_agent_chat').length, 1, '0.8.8 병합: 열쇠가 있으면 해시율은 AI 가 chain_overview 로 읽는다');
s2 = await h2.send('너무 우울해'); assert.equal(h2.calls.filter(c => c.command === 'ravi_agent_chat').length, 2, '열쇠가 있으면 감정 표현은 AI 로');
s2 = await h2.send('친구한테 5 RVN 보내줘'); assert.ok(!/1살이에요/.test(s2.map(m => m.text).join('')), '지갑 요청을 가로채지 않는다');
ok('(a2) persona/crisis/chain answered locally even with a key; emotion goes to AI; wallet requests untouched');

// (a3) 0.8.8 병합 — 지연 묶음(ravi-persona-lazy) 읽기가 실패해도 대화는 죽지 않고 기존 AI 경로로 간다.
const h3 = harness({ personaLoad: async () => null });
let s3 = await h3.send('몇살이야?');
assert.deepEqual(s3.map(m => m.who), ['me', 'ai']); assert.equal(s3[1].text, '합성 AI 답');
assert.equal(h3.calls.filter(c => c.command === 'ravi_agent_chat').length, 1, '읽기 실패 → AI 로(SYSTEM 정본·위기 규칙이 받는다)');
ok('(a3) persona chunk load failure falls back to the AI path without throwing');

// (b) 저장 → 보류한 마지막 질문을 다시 보낸다
said = await h.save();
const agentCalls = h.calls.filter(c => c.command === 'ravi_agent_chat');
assert.equal(agentCalls.length, 5); assert.equal(agentCalls[4].args.message, '내 거래 내역 알려줘');
assert.match(said[0].text, /저장했어요. 방금 질문을/); assert.equal(said.at(-1).text, '합성 AI 답');
assert.equal(h.offers.length, 2, '저장 뒤에는 다시 제안하지 않는다(재전송 답 뒤 카드 없음)');
ok('(b) saving consent automatically re-sends the held question once');

// (c) 지금은 취소 → 일반 대화 유지
h = harness(); await h.send('내 잔액 알려줘'); h.cancel();
said = await h.send('내 거래 내역 알려줘');
assert.equal(said[1].text, '합성 AI 답'); assert.equal(h.offers.length, 1, '취소 뒤 카드는 다시 안 뜬다');
ok('(c) "not now" keeps general chat working without re-offering');

// (d) 열쇠 1개 + 두 곳에 묻기 → 한 말풍선
for (const usable of [1, 2]) {
  h = harness({ mode: 'debate', usable });
  said = await h.send('커피값을 올릴까?');
  const ai = said.filter(m => m.who === 'ai');
  assert.equal(ai.length, 1, `usable=${usable}: 답 말풍선 하나`);
  assert.match(ai[0].text, /AI가 하나만 연결돼 있어 바로 답할게요\. 합성 AI 답/);
  assert.ok(!/회사의 열쇠/.test(ai[0].text));
}
ok('(d) debate mode with one key: one bubble with a one-line note and the answer');

// (e) 돈 보내줘 → 거절+안내+단추, 송금·AI 명령 없음
h = harness({ consent: { reviewed: true, balance: true, transactions: true, shop: true } });
said = await h.send('돈 보내줘');
assert.equal(said.length, 2); assert.match(said[1].text, /송금은 라비가 대신 하지 않아요/); assert.match(said[1].html, /data-guide-go="send"/);
assert.deepEqual(h.calls, [], 'IPC 호출 없음(송금·AI 모두)');
h.ctx.aiProvider = null; said = await h.send('돈 보내줘');
assert.match(said[1].text, /송금은 라비가 대신 하지 않아요/, '열쇠 없어도 같은 안내'); assert.deepEqual(h.calls, []);
ok('(e) "send money" is refused with guidance and a Send button; zero IPC calls');

// (f) 대표 시나리오: 부자순위 두 번 — 열쇠 있든 없든 AI 로 안 보내고 정직한 답
for (const provider of ['synthetic', null]) {
  h = harness(); h.ctx.aiProvider = provider;
  for (let i = 0; i < 2; i++) {
    said = await h.send('380만개면 부자순위 몇위야?');
    assert.equal(said.filter(m => m.who === 'ai').length, 1);
    assert.match(said[1].text, /정확한 순위는 몰라요/);
    assert.equal(/AI 열쇠를 넣으면/.test(said[1].text), !provider);
  }
  assert.deepEqual(h.calls, []);
}
ok('(f) the owner\'s question twice: two honest answers, no AI call, key hint only without key');

// (g) 개인정보: AI 로 가는 인자는 질문·제공자·시간대·진행 채널뿐, 공개 조회는 단추 전엔 안 간다
h = harness(); await h.send('채굴 난이도가 뭐야?');
for (const c of h.calls.filter(c => c.command === 'ravi_agent_chat')) assert.deepEqual(c.keys, ['message', 'progress', 'provider', 'tz']);
said = await h.send(`${ADDR} 잔액 얼마야?`);
assert.deepEqual(h.calls.map(c => c.command), ['ravi_agent_chat'], '공개 조회는 사용자가 단추를 누르기 전엔 부르지 않는다');
assert.match(said[1].html, /data-ravi-public/);
const publicFn = fn('raviPublicLookup');
assert.match(publicFn, /invoke<PublicAddress>\("ravi_public_address", \{ address \}\)/, '공개 조회 인자는 주소 하나');
ok('(g) AI payload is question/provider/tz only; public lookup needs a click and sends one address');

// (h) 비밀: AI 답에 키가 섞이면 숨김, 입력 비밀은 보내지 않음
h = harness({ reply: '여기 sk-ant-abcdefghijklmnopqrstu 키' });
said = await h.send('일반 질문');
assert.ok(!said.some(m => /sk-ant-abc/.test(m.text))); assert.match(said[1].text, /민감한 정보가 있어 표시하지 않았어요/);
const before = h.calls.length; said = await h.send('api_key=sk-ant-abcdefghijklmnopqrstu');
assert.equal(h.calls.length, before); assert.ok(!said.some(m => /sk-ant-abc/.test(m.text || '')));
ok('(h) secrets in replies are hidden; secrets in input are never sent');

/* ── 정적 불변식 ─────────────────────────────────────────────────── */
assert.ok(!mainSource.includes('정보 선택을 저장하지 않아 질문을 AI에 보내지 않았어요'), '질문을 버리는 문구가 남아 있지 않다');
assert.ok(!mainSource.includes('서로 다른 회사의 열쇠가 둘'), '옛 두 문장 안내 제거');
assert.ok(!/invoke\([^\n]*(?:send_rvn|send_asset|walletpassphrase)/.test(fn('chatAgent') + fn('chatSendExisting') + fn('raviPublicLookup')), '대화 함수에 송금 명령 없음');
assert.match(fn('paintDebateAvailability'), /aiUsableCount < 2/);
const agentSrc = readFileSync('src/ravi-agent.ts', 'utf8');
assert.ok(!/ensureConsent\(\)\s*:/.test(agentSrc), '질문을 붙잡는 옛 동의 함수 제거');
assert.ok(constText('DEBATE_ONE_NOTE').includes('하나만'));
// 번역: 질문 언어 답의 새 문구는 capabilities copy 에 모두 있다
const caps = JSON.parse(readFileSync('src/ravi-capabilities.json', 'utf8'));
for (const line of caps.guides.find(g => g.id === 'send').lines) assert.equal(caps.copy[line]?.length, 3, line);
for (const lang of ['en', 'ja', 'zh']) {
  for (const q of ['돈 보내줘']) { const h2 = chat.raviSendAnswerHtml(q, lang); assert.ok(h2.includes('data-ravi-language="ko"')); }
}
const { DICT } = await bundle('src/dict.ts');
const { RAVI_CHAT_COPY } = await bundle('src/ravi-chat-copy.ts');
for (const source of Object.keys(RAVI_CHAT_COPY)) for (const lang of ['en', 'ja', 'zh']) assert.ok(DICT[lang][source], `${lang} 번역 없음: ${source}`);
ok(`static invariants and translations (${Object.keys(RAVI_CHAT_COPY).length} UI strings × 3 languages)`);
/* ── 열쇠를 넣은 뒤(대표 확정 10-11) ─────────────────────────────── */
const rust = readFileSync('src-tauri/src/ravi_agent.rs', 'utf8');
for (const name of ['AI_KEY_REJECTED', 'AI_BUSY', 'AI_OFFLINE']) {
  const m = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(rust); assert.ok(m, name);
  assert.equal(chat[name], m[1], `${name} 문구가 앞뒤로 같다`);
  assert.ok(RAVI_CHAT_COPY[m[1]], `${name} 번역`);
}
assert.match(chat.raviFailureNextHtml(chat.AI_KEY_REJECTED, 'q', s => s), /data-guide-go="key"/);
assert.match(chat.raviFailureNextHtml(chat.AI_BUSY, '채굴"<', s => s), /data-ravi-ask="채굴&quot;&lt;"/);
assert.equal(chat.raviFailureNextHtml('라비 요청을 마치지 못했어요.', 'q', s => s), '');
assert.match(chat.raviConnectedHtml(s => s), /연결됐어요 · 한 번 물어볼까요\?/);
assert.ok(!/잔액|주소|거래|가게/.test(chat.RAVI_TEST_QUESTION), '시험 질문에 개인정보 없음');
// 열쇠 있음 + 동의 미저장: 첫 질문은 관문 없이 답까지(일반 대화), 두 곳에 묻기도 막지 않는다
h = harness({ mode: 'debate', usable: 1 }); said = await h.send(chat.RAVI_TEST_QUESTION);
assert.equal(said.filter(m => m.who === 'ai').length, 1); assert.match(said[1].text, /합성 AI 답/);
// 실패 문구는 고정 문구 + 단추, 원문은 버린다
h = harness(); h.ctx.invoke = async () => { throw chat.AI_KEY_REJECTED; }; said = await h.send('일반 질문');
assert.match(said[1].html, /data-guide-go="key"/); assert.match(said[1].text, /AI 열쇠가 맞지 않아요/);
h = harness(); h.ctx.invoke = async () => { throw '제공자 오류: invalid x-api-key sk-ant-api03-LEAKLEAKLEAKLEAK'; }; said = await h.send('일반 질문');
assert.ok(!said.some(m => /LEAK/.test(m.text || '')), '열쇠 조각이 섞인 원문은 표시하지 않는다');
ok('key flow: fixed failure copy matches Rust, next-action buttons, connected prompt, first question not gated');
console.log(`PASS ravi chat flow: ${passed} groups`);
