// bitcoinjs-lib·bip39·bs58check 은 모듈을 읽는 순간 전역 Buffer 를 만진다.
// 브라우저에는 그런 전역이 없어서, 없으면 번들이 실행되기도 전에 죽는다
// ("Buffer is not defined"). esbuild --inject 로 이 파일을 먼저 끼워 넣으면
// 자유 변수 Buffer 가 아래 번들된 구현으로 치환된다.
//
// 전역에 대입하는 방식(globalThis.Buffer = ...)으로는 못 고친다 — 라이브러리의
// 최상위 코드가 내 첫 줄보다 먼저 돌기 때문이다. 실측으로 확인했다.
import { Buffer } from "buffer";

export { Buffer };
