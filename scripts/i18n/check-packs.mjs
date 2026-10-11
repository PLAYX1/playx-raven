#!/usr/bin/env node
// public/i18n/<말>.json 검사 + 언어별 누락 키 표.   node scripts/i18n/check-packs.mjs [--table]
// ERROR(끝내 실패): JSON 깨짐 · 한글 남음 · 자리표시자({0} {name}) 집합이 한국어 원문과 다름 · HTML 태그 개수 다름 · 줄바꿈 개수 다름 · 숫자 값이 다름
// 누락 = 앱이 쓰는 한국어 열쇠인데 사전에 없음 → 그 언어에서는 영어로 나온다(영어도 없으면 한국어).
import fs from 'node:fs';
import path from 'node:path';
import { runtimeDict, root } from './runtime-keys.mjs';
const LANGS = ['it', 'es', 'fr', 'pt-BR', 'de', 'ru'];
const DICT = await runtimeDict();
const keys = Object.keys(DICT.en);
const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;
// 수료증 틀의 한국어 이름 자리표시자 {이름}·{과정} 은 영어 {name}·{course} 로 옮기는 것이 기존 사전(en·ja·zh)의 관례다.
const vars = s => [...s.replace(/\{이름\}/g, '{name}').replace(/\{과정\}/g, '{course}').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const tags = s => (s.match(/<\/?[a-z][^>]*>/gi) || []).length;
const nl = s => (s.match(/\n/g) || []).length;
const numList = (s, skipUnits) => ((skipUnits ? s.replace(/\d+(?:[.,]\d+)?(?=[월억만천조])/g, '') : s).replace(/\{\w+\}/g, '').match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace(',', '.'));
// 날짜(31.1.)처럼 점이 붙은 표기도 낱개로 센다. 한국어 원문의 숫자(「9월」「210억」처럼 한국어 단위가 붙은 것은 제외)가 번역에 모두 있어야 한다 — 값이 바뀌거나 빠지면 오류.
const numbersLost = (k, v) => { const have = [...numList(v, false), ...(v.match(/\d+/g) || [])]; return numList(k, true).some(n => { const i = have.indexOf(n); if (i < 0) return true; have.splice(i, 1); return false; }); };
let errors = 0; const rows = [];
for (const lang of LANGS) {
  const f = path.join(root, 'public/i18n', lang + '.json');
  let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`ERROR ${lang}: JSON ${e.message}`); errors++; continue; }
  const bad = { hangul: 0, vars: 0, tags: 0, newline: 0, numbers: 0, orphan: 0, empty: 0 };
  const first = {};
  const note = (kind, k, v) => { bad[kind]++; (first[kind] ||= []).length < 3 && first[kind].push(k.slice(0, 40) + ' → ' + String(v).slice(0, 40)); };
  for (const [k, v] of Object.entries(doc.dict)) {
    if (typeof v !== 'string' || !v.trim()) { note('empty', k, v); continue; }
    if (!(k in DICT.en)) bad.orphan++;
    if (hangul.test(v)) note('hangul', k, v);
    if (vars(k) !== vars(v)) note('vars', k, v);
    if (tags(k) !== tags(v)) note('tags', k, v);
    if (nl(k) !== nl(v)) note('newline', k, v);
    if (numbersLost(k, v)) note('numbers', k, v);
  }
  const own = keys.filter(k => doc.dict[k]);
  const missing = keys.filter(k => !doc.dict[k]);
  const enOnly = missing.filter(k => DICT.en[k]).length;
  const koOnly = missing.length - enOnly;
  const hard = bad.hangul + bad.vars + bad.tags + bad.newline + bad.numbers + bad.empty;
  errors += hard;
  rows.push({ lang, 번역됨: own.length, 누락_영어폴백: enOnly, 누락_영어도없음: koOnly, 음성: Object.keys(doc.voice).length, 고아키: bad.orphan, 오류: hard });
  if (hard) console.log(`ERROR ${lang}`, JSON.stringify(bad), JSON.stringify(first));
}
console.table(rows);
console.log(`런타임 열쇠 ${keys.length}개 · 오류 ${errors}`);
process.exit(errors ? 1 : 0);
