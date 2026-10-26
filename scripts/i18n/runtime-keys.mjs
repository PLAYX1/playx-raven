// 앱이 실제로 쓰는 한국어 원문 열쇠(DICT.en 합집합) — dict.ts + 감정 문구 모듈을 번들해서 읽는다. DOM 을 켜지 않는다.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function runtimeDict() {
  const built = await build({
    stdin: { contents: `export {DICT} from './src/dict.ts'; import './src/ravi-emotion-copy.ts';`, resolveDir: root, sourcefile: 'entry.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  return mod.DICT;
}
export { root };
