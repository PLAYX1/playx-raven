#!/usr/bin/env node
// 유럽어 6개 사전 만들기: ~/rv-i18n 병합 결과(packs/<lang>.json) + 이 폴더의 pack-extras.json → public/i18n/<lang>.json
//   node scripts/i18n/build-packs.mjs --rvi <rv-i18n 병합 폴더(packs/ 가 든 곳)> [--report docs/i18n-0.8.7-report.json]
// 규칙(대표 2026-10-11):
//   1) 교차검수 합의(agreed·verified)와 일반 UI 문구(machine-only)는 넣는다.
//   2) money_security·legal 범주는 합의(agreed·verified)가 없으면 넣지 않는다 → 그 언어에서는 영어로 내려간다. 목록은 보고서에 남긴다.
//   3) hold·flagged·machine-fail·missing 도 넣지 않는다(영어로 내려간다).
import fs from 'node:fs';
import path from 'node:path';
import { runtimeDict, root } from './runtime-keys.mjs';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const RVI = opt('rvi'); if (!RVI) { console.error('--rvi 필요'); process.exit(2); }
const REPORT = opt('report', path.join(root, 'docs/i18n-0.8.7-report.json'));
const LANGS = ['it', 'es', 'fr', 'pt-BR', 'de', 'ru'];
const SAFE = new Set(['agreed', 'verified']), OK = new Set(['agreed', 'verified', 'machine-only']);
const extras = JSON.parse(fs.readFileSync(path.join(root, 'scripts/i18n/pack-extras.json'), 'utf8'));
const DICT = await runtimeDict();
const runtimeKeys = Object.keys(DICT.en);
const outDir = path.join(root, 'public/i18n'); fs.mkdirSync(outDir, { recursive: true });
const report = { generated_for: 'desktop 0.8.7', runtime_keys: runtimeKeys.length, rule: '합의·일반 UI 는 포함 / money_security·legal 은 합의 없으면 영어 / hold·flagged 도 영어', langs: {}, english_fallbacks: {} };
for (const lang of LANGS) {
  const pack = JSON.parse(fs.readFileSync(path.join(RVI, 'packs', lang + '.json'), 'utf8'));
  const dict = {}, voice = {}, held = [], used = { agreed: 0, verified: 0, 'machine-only': 0, extras: 0 };
  for (const e of Object.values(pack.entries)) {
    if (e.surface !== 'desktop') continue;
    const target = e.store === 'DICT' || e.store.startsWith('DICT(') ? 'dict' : e.store === 'voiceCopy' ? 'voice' : null;
    if (!target) continue; // companionCopy·DROP_COPY: 그 화면이 아직 네 나라 말만 안다(보고서 참고)
    let reason = null;
    if (!e.text) reason = 'missing';
    else if (!OK.has(e.status)) reason = e.status;
    else if (['money_security', 'legal'].includes(e.category) && !SAFE.has(e.status)) reason = 'critical-no-consensus';
    if (reason) { held.push({ key: e.key, category: e.category, grade: e.grade, reason, status: e.status }); continue; }
    (target === 'dict' ? dict : voice)[e.key] = e.text; used[e.status]++;
  }
  for (const [k, v] of Object.entries(extras[lang] || {})) { dict[k] = v; used.extras++; }
  fs.writeFileSync(path.join(outDir, lang + '.json'), JSON.stringify({ version: 1, lang, ai_translation: true, glossary: pack._meta.glossary_version, dict, voice }));
  const missing = runtimeKeys.filter(k => !(k in dict));
  const heldKeys = new Set(held.map(h => h.key));
  report.langs[lang] = { rv_i18n_merged_at: pack._meta.generated_at, glossary_version: pack._meta.glossary_version, entries: Object.keys(dict).length, voice: Object.keys(voice).length, from: used, missing_runtime_keys: missing.length, english_fallback_total: missing.length, held_by_rule: held.length };
  report.english_fallbacks[lang] = {
    held_by_rule: held,
    not_in_catalog: missing.filter(k => !heldKeys.has(k)),
  };
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.langs, null, 1));
