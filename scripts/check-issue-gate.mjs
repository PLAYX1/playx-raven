// 마법사 게이트 진리표 — 소스에서 조건을 그대로 떼어 와 모든 경우를 돌린다.
import fs from 'fs';
const src = fs.readFileSync(new URL('../src/main.ts', import.meta.url),'utf8');

// 소스에 실제로 있는 두 줄을 그대로 쓴다(베끼면 시험이 거짓이 된다).
const m1 = src.match(/const 파일_영영_못붙임 = (.+);/);
const m2 = src.match(/const 표지가_뜻있는_종류 = (.+);/);
if(!m1||!m2){ console.log('🔴 조건을 소스에서 못 찾음'); process.exit(1); }

const 판정 = (wizKind, cid, re) =>
  eval(m1[1]) && eval(m2[1]);

const KINDS=['root','sub','unique','reissue','bulk','qualifier','restricted'];
let bad=0;
const 기대 = {
  // [종류, 파일있나, 재발행켬] -> 인정상자가 떠야 하나
  '막아야 함': [
    ['sub',   false, false],  // 어제 곡 셋이 이 경우
    ['root',  false, false],
    ['sub',   false, false],  // 같은 경우 한 번 더 (기본값 경로)
  ],
  '통과해야 함': [
    ['sub',      true,  false], // 표지 붙였다
    ['sub',      false, true ], // 나중에 붙일 수 있다
    ['root',     true,  true ],
    ['qualifier',false, false], // 자격 증명은 그림이 필요 없다
    ['restricted',false,false], // 제한 자산도
    ['reissue',  false, false], // 빈 칸 = 기존 것 유지
    ['reissue',  false, true ],
    ['unique',   false, false], // 체인이 재발행을 강제로 끈다 — 늘 뜨면 벽지가 된다
    ['bulk',     false, false], // 같은 이유
  ],
};
for(const [라벨, 목록] of Object.entries(기대)){
  const 켜져야 = 라벨==='막아야 함';
  for(const [k,c,r] of 목록){
    const got = 판정(k, c ? 'Qm123' : '', r);
    const ok = got === 켜져야;
    if(!ok) bad++;
    console.log(`  ${ok?'✅':'🔴'} ${라벨.padEnd(8)} ${k.padEnd(11)} 파일=${c?'있음':'없음'} 재발행=${r?'켬':'끔'} → 인정상자 ${got?'뜸':'안뜸'}`);
  }
}

// ── 「노래」 프리셋: 인정 상자가 아니라 **벽**이어야 한다 ────────────────
const m3 = src.match(/const 표지필수_안붙임 = (.+);/);
const m4 = src.match(/const 표지없음_인정필요 = (.+);/);
if(!m3||!m4){ console.log('🔴 프리셋 조건을 소스에서 못 찾음'); process.exit(1); }
const 프리셋판정 = (wizPreset, cid, wizKind, re) => {
  const 파일_영영_못붙임 = !cid && (wizKind === "unique" || !re);
  const 표지가_뜻있는_종류 = ["root","sub"].includes(wizKind);
  const 표지필수_안붙임 = eval(m3[1]);
  const 표지없음_인정필요 = eval(m4[1]);
  return { 벽: 표지필수_안붙임, 상자: 표지없음_인정필요 };
};
const 노래 = { cover_required: true, kind: 'sub' };
console.log('');
const 프리셋기대 = [
  ['노래 · 표지 없음',  노래, '',      'sub', false, true,  false], // 벽만
  ['노래 · 표지 있음',  노래, 'Qm1',   'sub', false, false, false], // 둘 다 아님
  ['직접 sub · 표지없음', null, '',     'sub', false, false, true ], // 상자만
];
for(const [라벨,ps,cid,k,re,벽기대,상자기대] of 프리셋기대){
  const r = 프리셋판정(ps, cid, k, re);
  const okk = r.벽===벽기대 && r.상자===상자기대;
  if(!okk) bad++;
  console.log(`  ${okk?'✅':'🔴'} ${라벨.padEnd(20)} 벽=${r.벽?'예':'아니오'} 상자=${r.상자?'예':'아니오'}`);
}

console.log(bad ? `\n🔴 ${bad}건 틀림` : '\n✅ 전부 맞음 — 막을 것은 막고 통과할 것은 통과');
process.exit(bad?1:0);
