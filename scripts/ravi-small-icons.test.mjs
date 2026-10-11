// 라비 작은 얼굴(16~32px)·메뉴바 아이콘 시험 — 실제 Chrome + Pillow. 합성 데이터만, 앱 실행 없음.
//   ① 33px 이상 큰 얼굴은 변경 전(f584be9 사본)과 DOM·픽셀 모두 같다(회귀 방지)
//   ② 눈 지름 하한(16≥4·20≥5·22≥5·24≥6·32≥7)
//   ③ 표정 구별: 가장 헷갈리는 짝의 픽셀 차이가 전보다 2배 이상, 평상~걱정도 2배 이상
//   ④ 대비: 눈-얼굴 ≥7, 도형끼리(머리 테-배경·부리 테-얼굴·리본-머리·리본 테-배경·눈썹-얼굴) ≥3
//   ⑤ 메뉴바 템플릿: 2톤(알파 0/255), 알림 점 틈 ≥1px(18)·≥2px(36), 생성 스크립트 재실행 = 같은 바이트
//   ⑥ API: raviFace(mood,size) 그대로 — 작은 얼굴도 .ravi-face·aria-label·data-ravi-mood 유지
// 사용: node --test scripts/ravi-small-icons.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'rv-small-test-'));
const env = { ...process.env, RV_SMALL_OUT: join(work, 'out'), RV_TRAY_DIR: join(work, 'tray') };
let m;

test.after(() => rmSync(work, { recursive: true, force: true }));

test('갤러리 렌더 — 큰 얼굴 DOM·픽셀 불변(스크립트가 어긋나면 실패 코드)', { timeout: 240000 }, () => {
  execFileSync('python3', ['scripts/generate-ravi-tray-v2.py'], { cwd: root, env, stdio: 'pipe' });
  execFileSync('node', ['scripts/ravi-small-icons-gallery.mjs'], { cwd: root, env, stdio: 'pipe' });
  execFileSync('python3', ['scripts/ravi-small-icons-metrics.py'], { cwd: root, env, stdio: 'pipe' });
  m = JSON.parse(readFileSync(join(work, 'out/metrics.json'), 'utf8'));
  assert.equal(m.big_unchanged.dom_same, m.big_unchanged.of);
  assert.ok(m.big_unchanged.of >= 200);
  assert.equal(m.big_unchanged.pixel_same, true);
});

test('눈 지름 하한', () => {
  for (const [n, e] of Object.entries(m.eye_diameter_px)) {
    assert.ok(e.after >= e.floor, `${n}px 눈 ${e.after} < ${e.floor}`);
    assert.ok(e.after >= e.before_with_ring * 1.5, `${n}px 눈이 전보다 충분히 크지 않음`);
  }
});

test('표정 구별 — 전보다 2배 이상(라이트·다크)', () => {
  for (const theme of ['light', 'dark']) for (const [n, v] of Object.entries(m.mood_distinct_pct[theme])) {
    assert.ok(v.after.min_pct >= v.before.min_pct * 2, `${theme} ${n}px 최소 짝 ${v.before.min_pct} → ${v.after.min_pct}`);
    assert.ok(v.after['normal~worried'] >= v.before['normal~worried'] * 2, `${theme} ${n}px 평상~걱정`);
  }
});

test('대비 — 눈 ≥7, 도형 ≥3, 실제 렌더 눈 ≥7', () => {
  const c = m.contrast;
  assert.ok(c.eye_vs_face.after >= 7);
  for (const k of ['hair_edge_vs_bg', 'beak_edge_vs_face', 'beak_fill_vs_outline', 'ribbon_vs_hair', 'ribbon_edge_vs_bg', 'face_vs_hair', 'brow_vs_face'])
    assert.ok(c[k].after >= 3, `${k} ${c[k].after}`);
  for (const [n, v] of Object.entries(c.measured_eye_vs_face_1x)) assert.ok(v.after.ratio >= 7 && v.after.ratio > v.before.ratio, `${n}px 렌더 눈 대비 ${v.after.ratio}`);
});

test('메뉴바 템플릿 — 2톤·알림 틈·재실행 같은 바이트', () => {
  assert.equal(m.tray.two_tone_after, true);
  assert.ok(m.tray.alert_gap_px['18'] >= 1 && m.tray.alert_gap_px['36'] >= 2);
  const files = readdirSync(join(work, 'tray')).filter(f => f.startsWith('ravi-tray-v2-template-'));
  assert.equal(files.length, 12);
  for (const f of files) assert.deepEqual(readFileSync(join(work, 'tray', f)), readFileSync(join(root, 'src-tauri/icons', f)), `${f} 가 저장된 파일과 다름 — python3 scripts/generate-ravi-tray-v2.py 로 다시 만들 것`);
  for (const [n, size] of [[18, 18], [22, 22], [36, 36], [44, 44]]) assert.equal(readFileSync(join(root, `src-tauri/icons/ravi-tray-v2-template-${n}.rgba`)).length, size * size * 4);
  for (const n of [16, 32]) assert.equal(readFileSync(join(root, `src-tauri/icons/ravi-tray-v2-${n}.rgba`)).length, n * n * 4);
});

test('API 호환 — raviFace 작은 크기 경로가 같은 이름·라벨을 쓴다(정적 검사)', () => {
  const src = readFileSync(join(root, 'src/ravi-face.ts'), 'utf8');
  assert.match(src, /export function raviFace\(mood: RaviMood, size: number, options: \{ round\?: boolean \} = \{\}\): HTMLElement/);
  assert.match(src, /export function setMood\(el: HTMLElement, mood: RaviMood\): void/);
  assert.match(src, /const small = smallBucket\(size\);\n  if \(small\) return smallRaviFace/);
  const small = readFileSync(join(root, 'src/ravi-face-small.ts'), 'utf8');
  assert.match(small, /export const SMALL_MAX = 32;/);
  assert.doesNotMatch(small, /\p{Extended_Pictographic}/u, '이모지 금지');
});
