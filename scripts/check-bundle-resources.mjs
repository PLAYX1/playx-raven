// 설치 파일에 라비 목소리 모델이 안 들어가는지 **번들 목록**으로 확인한다(실제 빌드 없이).
//  - tauri.conf.json bundle.resources 의 ravi-voice 항목은 작은 파일(LICENSE·manifest.json)만
//  - 그 항목이 가리키는 파일 합이 작다(수십 KB), .onnx 는 하나도 없다
//  - CI(desktop-win-linux-build.yml·release.yml)가 모델 받기(fetch-ravi-voice)를 부르지 않고, resources 를 크게 덮어쓰지 않는다
// 기대: 설치 파일 ≈ 0.9.4 수준(약 54MB) + 수십 KB. 모델(약 383MB)은 앱이 동의 후 받는다.
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const res = conf.bundle.resources;
const voice = (Array.isArray(res) ? res : Object.keys(res)).filter(r => r.includes('ravi-voice'));
assert.deepEqual(voice.sort(), ['resources/ravi-voice/LICENSE', 'resources/ravi-voice/manifest.json'], '번들에는 라이선스·목록만');
let total = 0;
for (const r of voice) { assert.ok(!/[*?]/.test(r), '글로브 금지(모델이 딸려 들어온다): ' + r); const f = resolve(root, 'src-tauri', r); assert.ok(existsSync(f), r + ' 있음'); const n = statSync(f).size; assert.ok(n < 100_000, r + ' 작다'); total += n; }
assert.ok(total < 100_000, '번들 속 라비 목소리 파일 합 ' + total + ' 바이트');
for (const w of ['desktop-win-linux-build.yml', 'release.yml']) {
  const y = readFileSync(resolve(root, '.github/workflows', w), 'utf8');
  assert.ok(!/node scripts\/fetch-ravi-voice\.mjs/.test(y), w + ': CI 에서 모델을 받지 않는다');
  assert.ok(!/ravi-voice\/\*\*/.test(y), w + ': 모델 글로브 없음');
  assert.ok(/resources\/ravi-voice\/LICENSE/.test(y) && /resources\/ravi-voice\/manifest\.json/.test(y), w + ': 작은 파일만 등록');
}
// 번들 대상 폴더 안에서 큰 파일이 글로브 없이도 딸려 들어올 길이 없음을 한 번 더: 어떤 resources 항목도 onnx 를 가리키지 않는다.
assert.ok(![...(Array.isArray(res) ? res : Object.keys(res))].some(r => /onnx|\*\*/.test(r) && r.includes('ravi')), 'onnx/글로브 항목 없음');
const MB = 1 / 1_048_576;
console.log(`통과: 번들 속 라비 목소리 파일 ${voice.length}개, 합 ${(total / 1024).toFixed(1)}KB (모델 ${(statSync(resolve(root, 'src-tauri/resources/ravi-voice/manifest.json')).size * MB).toFixed(3)}MB 목록만) — 설치 파일은 0.9.4 수준(약 54MB)`);
