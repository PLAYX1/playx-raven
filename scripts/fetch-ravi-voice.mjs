#!/usr/bin/env node
// [개발·시험 전용] 라비 목소리 모델(약 380MB)을 src-tauri/resources/ravi-voice/onnx/ 에 채운다.
// 🔴 CI·릴리스에서는 부르지 않는다 — 모델은 설치 파일에 넣지 않고, 앱이 사용자 동의 후 앱 자료 폴더로 받는다(ravi_voice_pack.rs).
// 화면 시험(check-ravi-tts-browser)이 진짜 모델로 합성해 볼 때 쓴다.
// 저장소에는 큰 .onnx 네 개를 넣지 않는다(.gitignore). 크기·sha256 은 같은 폴더의 manifest.json 과 맞춘다 — 하나라도 다르면 실패.
//   node scripts/fetch-ravi-voice.mjs                 이미 맞으면 아무것도 안 함, 없으면 내려받기(네트워크 필요 = 빌드 머신에서만)
//   node scripts/fetch-ravi-voice.mjs --from <폴더>   내려받지 않고 로컬 supertonic-3 폴더(onnx/ 가 있는 곳)에서 복사
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, copyFileSync, createWriteStream, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const root = resolve(import.meta.dirname, '..', 'src-tauri/resources/ravi-voice');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const need = manifest.files.filter(f => /^onnx\/.*\.onnx$/.test(f.path) || ['LICENSE', 'onnx/tts.json', 'onnx/unicode_indexer.json', 'voice_styles/F1.json'].includes(f.path));
const from = process.argv.includes('--from') ? resolve(process.argv[process.argv.indexOf('--from') + 1]) : null;
const sha = p => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(p).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no); });
let bad = 0;
for (const f of need) {
  const dest = resolve(root, f.path); mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && await sha(dest) === f.sha256) { console.log('ok     ', f.path); continue; }
  if (from) copyFileSync(resolve(from, f.path), dest);
  else {
    const url = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${manifest.sourceRevision}/${f.path}`;
    const res = await fetch(url); if (!res.ok) throw new Error(`${f.path}: ${res.status}`);
    const tmp = dest + '.part'; await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp)); renameSync(tmp, dest);
  }
  if (await sha(dest) !== f.sha256) { console.error('FAIL   ', f.path, '(sha256 불일치)'); rmSync(dest); bad++; } else console.log('fetched', f.path);
}
if (bad) process.exit(1);
console.log('라비 목소리 모델 준비 끝');
