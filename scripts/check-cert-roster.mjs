// 증서 명단 읽기 — 엑셀·CSV·붙여넣기 → 명단 줄 → 확인 표 문제 표시 (src/cert-roster.ts).
// 날짜는 시간대에 따라 하루 밀릴 수 있어서, 끝에서 미국·키리바시 시간대로 한 번 더 돌린다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
const bundle = await build({ entryPoints: [new URL('../src/cert-roster.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
// SheetJS 까지 묶으면 1MB 가 넘는다 — data: 주소로 부르면 실패할 때 스택에 그 전부가 찍혀서 임시 파일로.
const tmp = mkdtempSync(join(tmpdir(), 'cert-roster-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(join(tmp, 'cert-roster.mjs'), bundle.outputFiles[0].text);
const m = await import(pathToFileURL(join(tmp, 'cert-roster.mjs')).href);
const TZ_CHILD = process.env.CERT_ROSTER_TZ_CHILD === '1';
let passed = 0;
const pass = label => { passed++; if (!TZ_CHILD) console.log(`PASS cert-roster: ${label}`); };

const enc = s => new TextEncoder().encode(s);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const LABELS = ['받는 사람', '과정', '등급', '발급일', '번호', '사진 파일명', '비고'];
const IDENTITY = { recipient: 0, course: 1, grade: 2, date: 3, number: 4, photo: 5, note: 6 };
const row = (o = {}) => ({ recipient: '', course: '', grade: '', date: '', number: '', photo: '', note: '', ...o });
const roundTrip = (name, bytes) => { const t = m.readRosterFile(name, bytes); return { t, rows: m.applyMapping(t, m.guessMapping(t.headers)) }; };
const sheetBytes = (sheets, bookType = 'xlsx') => {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
};

// ── CSV: BOM · CP949 · 따옴표 ──
{
  const t = m.readRosterFile('명단.csv', cat(BOM, enc('받는 사람,과정\r\n홍길동 , 필라테스\r\n\r\n')));
  assert.deepEqual(t, { headers: ['받는 사람', '과정'], rows: [['홍길동', '필라테스']] });
  // ArrayBuffer 로 줘도 같다.
  assert.deepEqual(m.readRosterFile('명단.CSV', cat(BOM, enc('이름\r\n홍길동\r\n')).buffer), { headers: ['이름'], rows: [['홍길동']] });
  pass('UTF-8 BOM CSV');
}
{
  const cp949 = new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7, 0x0d, 0x0a, 0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf, 0x0d, 0x0a]);
  assert.equal(new TextDecoder('euc-kr').decode(cp949), '이름\r\n홍길동\r\n'); // 바이트가 맞는지 먼저
  const { t, rows } = roundTrip('명단.csv', cp949);
  assert.deepEqual(t, { headers: ['이름'], rows: [['홍길동']] });
  assert.equal(rows[0].recipient, '홍길동');
  pass('CP949(한국어 엑셀 CSV)');
}
{
  const csv = '이름,과정,비고\r\n"Doe, Jane","필라테스 ""A"" 과정","첫 줄\r\n둘째 줄"\r\n김철수,,\r\n';
  const t = m.readRosterFile('q.csv', enc(csv));
  assert.deepEqual(t.rows, [['Doe, Jane', '필라테스 "A" 과정', '첫 줄\r\n둘째 줄'], ['김철수', '', '']]);
  const rows = m.applyMapping(t, m.guessMapping(t.headers));
  assert.equal(rows[0].recipient, 'Doe, Jane');
  assert.equal(rows[0].note, '첫 줄\r\n둘째 줄'); // 비고는 줄바꿈을 지킨다
  // 탭 구분 .tsv / .txt, UTF-16LE(엑셀 「유니코드 텍스트」)
  assert.deepEqual(m.readRosterFile('a.tsv', enc('이름\t과정\n홍길동\t요가, 명상\n')).rows, [['홍길동', '요가, 명상']]);
  const u16 = Buffer.from('\ufeff이름\t과정\r\n홍길동\t요가\r\n', 'utf16le');
  assert.deepEqual(m.readRosterFile('a.txt', u16), { headers: ['이름', '과정'], rows: [['홍길동', '요가']] });
  // 닫히지 않은 따옴표는 글자로 본다(뒤 줄을 삼키지 않는다).
  assert.deepEqual(m.readRosterFile('b.csv', enc('이름\n"홍길동\n김철수\n')).rows, [['"홍길동'], ['김철수']]);
  pass('따옴표 CSV(쉼표·줄바꿈·"") · TSV · UTF-16');
}

// ── 샘플 파일 왕복 ──
{
  assert.equal(m.SAMPLE_FILE_BASE, '증서_명단_샘플');
  const sample = m.sampleRows();
  assert.equal(sample.length, 3);
  assert.ok(sample.some(r => /^[A-Za-z ]+$/.test(r.recipient)));
  sample[0].recipient = 'x';
  assert.notEqual(m.sampleRows()[0].recipient, 'x'); // 매번 새 사본
  const csv = m.sampleCsv();
  assert.deepEqual([...csv.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(csv.slice(3));
  const lines = text.split('\r\n');
  assert.equal(lines[0], LABELS.join(','));
  assert.ok(lines[1].startsWith('※'));
  assert.ok(!/(^|[^\r])\n/.test(text)); // 줄바꿈은 모두 CRLF
  const a = roundTrip('증서_명단_샘플.csv', csv);
  assert.deepEqual(a.t.headers, LABELS);
  assert.deepEqual(a.rows, m.sampleRows());
  const b = roundTrip('증서_명단_샘플.xlsx', m.sampleXlsx());
  assert.deepEqual(b.t.headers, LABELS);
  assert.deepEqual(b.rows, m.sampleRows());
  const wb = XLSX.read(m.sampleXlsx(), { type: 'array', cellStyles: true });
  assert.deepEqual(wb.SheetNames, ['명단']);
  assert.equal(wb.Sheets['명단']['!cols'].length, 7);
  pass('샘플 CSV·XLSX → 읽기 → 연결 = sampleRows (※ 설명 줄 건너뜀)');
}

// ── 엑셀: 시트 고르기 · 날짜 칸 · 숫자 · xls ──
{
  const ws = XLSX.utils.aoa_to_sheet([['※ 위에 둔 설명'], [], ['이름', '발급일', '번호', '큰수', '소수', '등급', '한글날짜']]);
  XLSX.utils.sheet_add_aoa(ws, [['홍길동', 0, 0, 0, 0, 0, 0]], { origin: 'A4' });
  ws.B4 = { t: 'n', v: 46289, z: 'yyyy-mm-dd' };
  ws.C4 = { t: 'n', v: 7, z: '000' };
  ws.D4 = { t: 'n', v: 1e21 };
  ws.E4 = { t: 'n', v: 0.1 + 0.2 };
  ws.F4 = { t: 'n', v: 12 };
  ws.G4 = { t: 'n', v: 46289.99, z: 'yyyy"년" m"월" d"일"' };
  const guide = XLSX.utils.aoa_to_sheet([['이 시트는 안내']]);
  for (const bookType of ['xlsx', 'biff8']) {
    const t = m.readRosterFile(bookType === 'xlsx' ? 'a.xlsx' : 'a.xls', sheetBytes([['안내', guide], ['명단', ws]], bookType));
    assert.deepEqual(t.headers, ['이름', '발급일', '번호', '큰수', '소수', '등급', '한글날짜']);
    assert.deepEqual(t.rows, [['홍길동', '2026-09-24', '007', '1000000000000000000000', '0.3', '12', '2026-09-24']], bookType);
  }
  // 「명단」이 없으면 첫 시트
  assert.deepEqual(m.readRosterFile('b.xlsx', sheetBytes([['Sheet1', XLSX.utils.aoa_to_sheet([['성명'], ['김철수']])]])).rows, [['김철수']]);
  // 빈 머리글 칸은 "열N"
  assert.deepEqual(m.readRosterFile('c.xlsx', sheetBytes([['S', XLSX.utils.aoa_to_sheet([['이름', '', '비고'], ['a', 'b', 'c']])]])).headers, ['이름', '열2', '비고']);
  pass(`엑셀 날짜 칸(TZ=${process.env.TZ || '기본'}) · 서식 숫자 001 · 1e21 · 0.1+0.2 · 명단 시트 · .xls`);
}

// ── 머리글 짐작 ──
{
  assert.deepEqual(m.guessMapping(LABELS), IDENTITY);
  assert.deepEqual(m.guessMapping(['받는 사람', '과정(선택)', '등급 (선택)', '발급일(선택)', '번호（선택）', '사진 파일명 [선택]', '비고(선택)']), IDENTITY);
  assert.deepEqual(m.guessMapping(['Full Name', 'Course', 'Grade', 'Issue Date', 'Cert No.', 'Image', 'Remark']), IDENTITY);
  assert.deepEqual(m.guessMapping(['*이름', '교육과정명', '레벨', '수료일자', '자격번호', '사진파일이름', '메모']), IDENTITY);
  assert.deepEqual(m.guessMapping(['name', 'program', 'level', 'date', 'id', 'photo', 'notes']), IDENTITY);
  // 맥 NFD 머리글
  assert.deepEqual(m.guessMapping(LABELS.map(h => h.normalize('NFD'))), IDENTITY);
  // 구체적인 말이 이긴다 · 한 열·한 칸에 하나씩
  const g = m.guessMapping(['No', '이름', '받는 사람', '증서번호', '파일', '사진 파일명']);
  assert.equal(g.number, 3); assert.equal(g.recipient, 2); assert.equal(g.photo, 5);
  assert.equal(Object.values(g).filter(v => v === 0).length, 0);
  // 전화번호·생년월일은 번호·날짜가 아니다 · 모르는 머리글은 -1
  const h = m.guessMapping(['이름', '전화번호', '생년월일', '소속']);
  assert.deepEqual(h, { recipient: 0, course: -1, grade: -1, date: -1, number: -1, photo: -1, note: -1 });
  // 한 열뿐이면 그 열이 받는 사람
  assert.equal(m.guessMapping(['참석자 명단']).recipient, 0);
  assert.equal(m.guessMapping(['foo', 'bar']).recipient, -1);
  pass('머리글 짐작(동의어·영문·(선택)·NFD·우선순위·전화번호 제외·한 열)');
}

// ── 붙여넣기 ──
{
  const one = m.parsePasted('홍길동\r\n김철수\n\nJane  Doe\n');
  assert.deepEqual(one, { headers: ['열1'], rows: [['홍길동'], ['김철수'], ['Jane  Doe']] });
  const oneRows = m.applyMapping(one, m.guessMapping(one.headers));
  assert.deepEqual(oneRows.map(r => r.recipient), ['홍길동', '김철수', 'Jane Doe']); // 이름 속 공백은 하나로
  const withHead = m.parsePasted('이름\t과정\t발급일\n홍길동\t필라테스\t2026.9.24\n김철수\t요가\t\n');
  assert.deepEqual(withHead.headers, ['이름', '과정', '발급일']);
  const r = m.applyMapping(withHead, m.guessMapping(withHead.headers));
  assert.deepEqual(r[0], row({ recipient: '홍길동', course: '필라테스', date: '2026-09-24' }));
  assert.deepEqual(r[1], row({ recipient: '김철수', course: '요가' }));
  // 머리글 없는 여러 열 — 「과정」이 든 과정 이름을 머리글로 오해하면 안 된다
  const bare = m.parsePasted('홍길동\t필라테스 지도자 과정\n김철수\t요가\n');
  assert.deepEqual(bare, { headers: ['열1', '열2'], rows: [['홍길동', '필라테스 지도자 과정'], ['김철수', '요가']] });
  // 엑셀이 줄바꿈 든 칸을 따옴표로 감싼 것
  assert.deepEqual(m.parsePasted('이름\t비고\n홍길동\t"첫 줄\n둘째 줄"\n').rows, [['홍길동', '첫 줄\n둘째 줄']]);
  assert.deepEqual(m.parsePasted('  \n'), { headers: [], rows: [] });
  pass('붙여넣기(한 열 · 머리글 있는 표 · 머리글 없는 표 · 따옴표 칸)');
}

// ── 날짜 ──
{
  const ok = ['2026-09-24', '2026.9.24', '2026. 9. 24.', '2026/9/24', '2026/09/24', '20260924', '2026년 9월 24일', '2026년9월24일', '2026년 9월 24일 (목)',
    '2026-09-24 13:05:00', '2026-09-24T00:00:00Z', '46289', '46289.75', ' 2026.09.24 '];
  for (const s of ok) assert.equal(m.normalizeDate(s), '2026-09-24', s);
  assert.equal(m.normalizeDate('2024.2.29'), '2024-02-29');
  for (const s of ['2026-02-30', '2025.2.29', '26.9.24', '9/24/2026', '2026-13-01', '0226-09-24', '12345', '99999', '내일', '2026년 9월'])
    assert.equal(m.normalizeDate(s), s.trim(), s);
  assert.equal(m.normalizeDate(''), '');
  assert.equal(m.isIsoDate('2026-09-24'), true);
  assert.equal(m.isIsoDate('2026-9-24'), false);
  // 연결할 때 날짜 칸만 일련번호로 본다(번호 칸의 46289 는 그대로).
  const t = { headers: ['이름', '발급일', '번호'], rows: [['a', '46289', '46289'], ['b', '2026.02.30', '']] };
  const rows = m.applyMapping(t, m.guessMapping(t.headers));
  assert.equal(rows[0].date, '2026-09-24'); assert.equal(rows[0].number, '46289');
  assert.equal(rows[1].date, '2026.02.30');
  assert.deepEqual(m.checkRows(rows).map(p => p.map(x => x.code)), [[], ['bad-date']]);
  pass('날짜(점·빗금·8자리·한글·요일·시각·엑셀 일련번호 · 없는 날 → bad-date)');
}

// ── 확인 표 ──
{
  const long21 = '가'.repeat(21), long41 = '가'.repeat(41);
  const rows = [
    row({ recipient: '' }),
    row({ recipient: long41 }),
    row({ recipient: long21 }),
    row({ recipient: '😀'.repeat(21) }), // 코드 포인트 21 (UTF-16 으로는 42) → 너무 김이 아니라 긴 이름
    row({ recipient: '김하늘', course: 'ㄱ'.repeat(81) }),
    row({ recipient: '김하늘', course: '필라테스', date: '2026-09-24' }),
    row({ recipient: '김하늘', course: '필라테스', date: '2026.9.24' }),
    row({ recipient: 'Jane Doe', course: 'Yoga' }),
    row({ recipient: 'jane  doe', course: 'yoga' }),
    row({ recipient: '박서준', date: '어제' }),
    row({ recipient: '사진없음' }),
    row({ recipient: '사진있음', photo: '김하늘.JPG' }),
    row({ recipient: '사진틀림', photo: '없는사진.jpg' }),
    row({ recipient: '맥사진', photo: 'photos/김하늘.jpeg'.normalize('NFD') }),
  ];
  const codes = p => p.map(x => `${x.level}:${x.code}`);
  const base = m.checkRows(rows);
  assert.deepEqual(codes(base[0]), ['error:empty-name']);
  assert.equal(base[0][0].message, '받는 사람이 비어 있어요');
  assert.deepEqual(codes(base[1]), ['error:too-long']);
  assert.deepEqual(codes(base[2]), ['warn:long-name']);
  assert.match(base[2][0].message, /글자가 작아져요/);
  assert.deepEqual(codes(base[3]), ['warn:long-name']);
  assert.deepEqual(codes(base[4]), ['error:too-long']); assert.equal(base[4][0].field, 'course');
  assert.deepEqual(codes(base[5]), []);
  assert.deepEqual(codes(base[6]), ['warn:duplicate']); assert.match(base[6][0].message, /6번째 줄/);
  assert.deepEqual(codes(base[8]), ['warn:duplicate']); assert.match(base[8][0].message, /8번째 줄/);
  assert.deepEqual(codes(base[9]), ['error:bad-date']);
  assert.deepEqual(codes(base[10]), []); // 사진 칸을 요구하지 않으면 빈 사진은 괜찮다
  assert.deepEqual(codes(base[12]), []); // 올린 사진 목록을 모르면 못 찾음도 없다
  const photoKeys = new Set(['김하늘']);
  const withPhotos = m.checkRows(rows, { photoKeys, requirePhoto: true });
  assert.deepEqual(codes(withPhotos[10]), ['error:no-photo']);
  assert.deepEqual(codes(withPhotos[11]), []);
  assert.deepEqual(codes(withPhotos[12]), ['warn:photo-not-found']);
  assert.deepEqual(codes(withPhotos[13]), []); // NFD·경로·확장자 달라도 같은 사진
  // 짝짓기 이름표를 바꿔 끼울 수 있다
  assert.deepEqual(codes(m.checkRows([row({ recipient: 'a', photo: 'X-1' })], { photoKeys: new Set(['x-1!']), photoKey: s => s.toLowerCase() + '!' })[0]), []);
  assert.equal(m.photoKey(' C:\\사진\\김하늘.JPG '), '김하늘');
  // 러스트(create_history)와 같은 한도 — 여기서 못 거르면 발행 도중 50장 묶음이 통째로 멈춘다(검수 09-24).
  const limits = m.checkRows([
    row({ recipient: '가', grade: 'ㄱ'.repeat(30), number: 'N'.repeat(40), date: '2000-01-01' }),
    row({ recipient: '나', grade: 'ㄱ'.repeat(31) }),
    row({ recipient: '다', number: 'N'.repeat(41) }),
    row({ recipient: '라', date: '1999-12-31' }),
    row({ recipient: '마', date: '2199-12-31' }),
    row({ recipient: '바', date: '2201-01-01' }),
  ]);
  assert.deepEqual(limits.map(codes), [[], ['error:too-long'], ['error:too-long'], ['error:date-range'], [], ['error:bad-date']]);
  assert.equal(limits[1][0].field, 'grade'); assert.equal(limits[2][0].field, 'number');
  pass('확인 표(empty-name · too-long · long-name · duplicate · bad-date · date-range · no-photo · photo-not-found)');
}

// ── 한도·오류 ──
{
  const names = n => enc('이름\r\n' + Array.from({ length: n }, (_, i) => `사람${i + 1}`).join('\r\n') + '\r\n');
  assert.equal(m.readRosterFile('ok.csv', names(500)).rows.length, 500);
  assert.throws(() => m.readRosterFile('big.csv', names(501)), /501줄.*500줄까지.*나눠서/);
  assert.throws(() => m.parsePasted(Array.from({ length: 501 }, (_, i) => `p${i}`).join('\n')), /501줄/);
  assert.throws(() => m.readRosterFile('명단.pdf', enc('x')), /읽을 수 없어요\(\.pdf\)/);
  assert.throws(() => m.readRosterFile('명단', enc('x')), /확장자 없음/);
  assert.throws(() => m.readRosterFile('빈.csv', new Uint8Array()), /비어 있어요/);
  assert.throws(() => m.readRosterFile('빈줄.csv', enc('\r\n ,, \r\n')), /비어 있어요/);
  assert.throws(() => m.readRosterFile('머리만.csv', enc('이름,과정\r\n※ 설명\r\n')), /명단이 없어요/);
  assert.throws(() => m.readRosterFile('깨짐.xlsx', enc('PK\x03\x04 not really a zip')), /읽지 못했어요/);
  pass('500줄 한도 · 지원 안 하는 확장자 · 빈 파일 · 머리글만 · 깨진 파일');
}

// ── 발행 목록 표 ──
{
  const issued = [
    { recipient: '김하늘', course: '필라테스 지도자 과정', grade: '2급', date: '2026-09-24', number: 'PLNE-2026-001', asset: 'PLNE#PILATES260924-1', txid: 'ab'.repeat(32), verifyUrl: 'https://ravenvault.ex.erci.se/verify/?a=PLNE%23PILATES260924-1' },
    { recipient: 'Doe, "Jane"', course: '', grade: '', date: '', number: '', asset: 'PLNE#PILATES260924-2', txid: 'cd'.repeat(32), verifyUrl: 'https://ravenvault.ex.erci.se/verify/?a=PLNE%23PILATES260924-2' },
  ];
  const head = ['받는 사람', '과정', '등급', '발급일', '번호', '체인 이름', '거래 번호', '확인 주소'];
  const wb = XLSX.read(m.resultXlsx(issued), { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['발행 목록']);
  const ws = wb.Sheets['발행 목록'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  assert.deepEqual(aoa[0], head);
  assert.deepEqual(aoa[2], ['Doe, "Jane"', '', '', '', '', 'PLNE#PILATES260924-2', 'cd'.repeat(32), issued[1].verifyUrl]);
  assert.equal(ws.H2.l?.Target, issued[0].verifyUrl);
  const csv = m.resultCsv(issued);
  assert.deepEqual([...csv.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(csv.slice(3)).split('\r\n');
  assert.equal(lines[0], head.join(','));
  assert.ok(lines[2].startsWith('"Doe, ""Jane""",,,,,PLNE#'));
  // 우리 CSV 는 우리가 다시 읽을 수 있다
  assert.deepEqual(m.readRosterFile('r.csv', csv).rows[1][0], 'Doe, "Jane"');
  // 수식으로 실행될 칸은 글자로(' 를 앞에) — xlsx 는 칸이 원래 글자다.
  const evil = [{ ...issued[0], recipient: '=HYPERLINK("https://x.example","a")', course: '+1', grade: '-2', number: '@SUM(A1)' }];
  const evilLine = new TextDecoder().decode(m.resultCsv(evil).slice(3)).split('\r\n')[1];
  assert.ok(evilLine.startsWith(`"'=HYPERLINK(""https://x.example"",""a"")",'+1,'-2,2026-09-24,'@SUM(A1),`), evilLine);
  assert.equal(XLSX.read(m.resultXlsx(evil), { type: 'array' }).Sheets['발행 목록'].A2.t, 's');
  pass('발행 목록 XLSX(시트 「발행 목록」·확인 주소 링크) · CSV(BOM·따옴표·수식 막기)');
}

if (!TZ_CHILD) {
  // SheetJS 날짜는 UTC 기준 — 로컬로 읽으면 이 시간대들에서 하루 밀린다.
  for (const TZ of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ, CERT_ROSTER_TZ_CHILD: '1' }, encoding: 'utf8' });
    if (r.status !== 0) { console.error(`FAIL cert-roster: TZ=${TZ}\n${r.stdout}${r.stderr}`); process.exit(1); }
    console.log(`PASS cert-roster: 시간대 ${TZ} 에서도 같은 답`);
    passed++;
  }
  console.log(`PASS cert-roster: ${passed}개 묶음 모두 통과`);
}
