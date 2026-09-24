// 증서 사진 검사 — 명단↔사진 짝짓기(노드) + 증명사진 자르기·줄이기(진짜 헤드리스 크롬).
//
// 🔴 맥 Finder 는 한글 파일명을 NFD 로 준다. 엑셀 칸(NFC)과 짝이 안 맞으면 수백 명이 「사진 없음」이 된다 —
//    그래서 NFD 파일명이 NFC 칸과 짝지어지는지를 제일 먼저 본다.
// 사진 쪽은 테스트 그림을 페이지 안 캔버스로 만들어서 쓴다(파일·네트워크 없음). EXIF 회전은
// 캔버스 JPEG 에 Orientation=6 조각을 직접 끼워 넣어, createImageBitmap 길과 <img> 대체 길을 둘 다 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = new URL('..', import.meta.url).pathname;
const entry = path.join(root, 'src/cert-photos.ts');
let failed = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack || e}`); }
};

// ── 1. 순수 함수(노드) ─────────────────────────────────────────────
const esm = (await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text;
const m = await import('data:text/javascript;base64,' + Buffer.from(esm).toString('base64'));

await ok('photoKey: NFD 파일명 = NFC 칸, 경로·확장자 하나·대소문자·공백', () => {
  const nfd = '홍길동'.normalize('NFD') + '.JPG';
  assert.notEqual(nfd.normalize('NFC'), nfd, '테스트 이름이 정말 NFD 여야 한다');
  assert.equal(m.photoKey(nfd), '홍길동');
  assert.equal(m.photoKey(nfd), m.photoKey('홍길동'));
  assert.equal(m.photoKey('C:\\사진\\홍길동.jpeg'), '홍길동');
  assert.equal(m.photoKey('반/1기/Kim_Chul-Su.PNG'), 'kim_chul-su');
  assert.equal(m.photoKey('홍길동.jpg.jpg'), '홍길동.jpg');
  assert.equal(m.photoKey('  홍  길동  '), '홍 길동');
  assert.equal(m.photoKey('홍길동 .jpg'), '홍길동');
  assert.equal(m.photoKey('보고서.pdf'), '보고서.pdf');
  assert.equal(m.photoKey(''), '');
});

await ok('isImageName: 받는 확장자만', () => {
  for (const n of ['a.JPG', 'a.jpeg', 'a.png', 'a.webp', 'a.HEIC', 'a.heif', 'a.gif', 'a.bmp', 'a.tif', 'a.TIFF'])
    assert.equal(m.isImageName(n), true, n);
  for (const n of ['a.pdf', 'jpg', 'a.jpg.txt', '명단.xlsx', '.DS_Store', ''])
    assert.equal(m.isImageName(n), false, n);
});

await ok('matchPhotos: 칸 이름·받는 사람 대체·헷갈림·재사용·사진 아닌 파일·남는 사진', () => {
  const files = [
    '홍길동'.normalize('NFD') + '.JPG', // 0 맥 NFD
    '김철수.png',                        // 1 두 줄이 같이 씀
    '이영희.jpg',                        // 2 ┐ 같은 이름표
    '이영희.jpeg',                       // 3 ┘
    '명단.xlsx',                         // 4 사진 아님 → 무시
    '남는사진.jpg',                      // 5 짝 없음
    '공용.png',                          // 6 두 줄이 같이 씀
    '.DS_Store',                         // 7 숨김 → 무시
    '._김철수.png',                      // 8 맥 AppleDouble → 무시
    '박민수.heic',                       // 9
    'photos/Park Ji-Sung.JPG',           // 10
    '최 지 우.jpg',                      // 11
  ].map(name => ({ name }));
  const rows = [
    { recipient: '홍길동', photo: '' },               // 0 → 0 (받는 사람으로, NFD↔NFC)
    { recipient: '아무개', photo: '김철수' },         // 1 → 1 (확장자 없는 칸)
    { recipient: '김철수', photo: '김철수.PNG' },     // 2 → 1 (확장자 있는 칸, 대소문자)
    { recipient: '이영희', photo: '' },               // 3 → 헷갈림
    { recipient: '갑', photo: '공용.png' },           // 4 → 6
    { recipient: '을', photo: '공용' },               // 5 → 6
    { recipient: '없는사람', photo: '' },             // 6 → -1 (헷갈림 아님)
    { recipient: '정', photo: '이영희.jpeg' },        // 7 → 3 (확장자까지 똑같은 하나)
    { recipient: '박민수', photo: '' },               // 8 → 9
    { recipient: '무', photo: '  PARK   JI-SUNG  ' }, // 9 → 10
    { recipient: '최  지 우 ', photo: '' },           // 10 → 11 (공백 모음)
    { recipient: '명단', photo: '' },                 // 11 → -1 (xlsx 는 사진 아님)
    { recipient: '홍길동', photo: '없는파일.jpg' },   // 12 → -1 (칸이 있으면 이름으로 대체하지 않는다)
  ];
  const r = m.matchPhotos(rows, files);
  assert.deepEqual(r.fileOfRow, [0, 1, 1, -1, 6, 6, -1, 3, 9, 10, 11, -1, -1]);
  assert.deepEqual(r.ambiguousRows, [3]);
  assert.deepEqual(r.rowsOfFile[1], [1, 2]);
  assert.deepEqual(r.rowsOfFile[6], [4, 5]);
  assert.deepEqual(r.rowsOfFile[3], [7]);
  assert.deepEqual(r.rowsOfFile[4], []);
  assert.equal(r.rowsOfFile.length, files.length);
  assert.deepEqual(r.unmatchedFiles, [2, 5], '남는 사진은 이영희.jpg·남는사진.jpg 만(xlsx·숨김 파일은 안 알린다)');
});

await ok('matchPhotos: 같은 이름 파일 두 개(다른 폴더)는 헷갈림, 빈 명단·빈 파일', () => {
  const r = m.matchPhotos([{ recipient: '홍길동', photo: '홍길동.jpg' }], [{ name: 'a/홍길동.jpg' }, { name: 'b/홍길동.jpg' }]);
  assert.deepEqual(r.fileOfRow, [-1]);
  assert.deepEqual(r.ambiguousRows, [0]);
  assert.deepEqual(r.unmatchedFiles, [0, 1]);
  assert.deepEqual(m.matchPhotos([], []), { fileOfRow: [], rowsOfFile: [], unmatchedFiles: [], ambiguousRows: [] });
  assert.deepEqual(m.matchPhotos([{ recipient: '', photo: '' }], [{ name: '.jpg' }]).fileOfRow, [-1]);
});

await ok('pickedFiles: 사진만·자연 정렬(사진2 < 사진10)·폴더의 숨김/__MACOSX 제외', () => {
  const list = [
    { name: '사진10.jpg', webkitRelativePath: '1반/사진10.jpg' },
    { name: '사진2.jpg', webkitRelativePath: '1반/사진2.jpg' },
    { name: '사진1.JPG', webkitRelativePath: '1반/사진1.JPG' },
    { name: '메모.txt', webkitRelativePath: '1반/메모.txt' },
    { name: '.DS_Store', webkitRelativePath: '1반/.DS_Store' },
    { name: 'a.jpg', webkitRelativePath: '1반/__MACOSX/a.jpg' },
    { name: '._사진3.jpg', webkitRelativePath: '1반/._사진3.jpg' },
    { name: '사진3.jpg', webkitRelativePath: '1반/.숨김/사진3.jpg' },
    { name: '가.png', webkitRelativePath: '.고른폴더/가.png' }, // 고른 폴더 이름 자체는 따지지 않는다
  ];
  assert.deepEqual(m.pickedFiles(list).map(f => f.name), ['가.png', '사진1.JPG', '사진2.jpg', '사진10.jpg']);
  // 끌어다 놓기(경로 없음)도 같은 순서.
  const dropped = [{ name: '사진10.png' }, { name: '사진9.png' }, { name: '사진 1.png' }, { name: 'x.pdf' }];
  assert.deepEqual(m.pickedFiles(dropped).map(f => f.name), ['사진 1.png', '사진9.png', '사진10.png']);
});

// ── 2. preparePhoto(진짜 크롬) ───────────────────────────────────────
const iife = (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'CP', target: 'es2020' })).outputFiles[0].text;

// 페이지 안 도우미: 그림 만들기·결과 픽셀 읽기·EXIF 끼우기.
const helpers = `
window.T = {
  async make(w, h, type, draw) {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    draw(x, w, h);
    return c.convertToBlob({ type, quality: 0.92 });
  },
  async reader(dataUrl) {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, bmp.width, bmp.height).data, w = bmp.width;
    return (px, py) => { const i = (py * w + px) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  },
  // JPEG SOI 바로 뒤에 APP1(Exif, Orientation=6 → 시계 방향 90°) 조각을 끼운다.
  async withOrientation6(jpegBlob) {
    const src = new Uint8Array(await jpegBlob.arrayBuffer());
    const tiff = [0x4d,0x4d,0x00,0x2a, 0,0,0,8, 0,1, 0x01,0x12, 0,3, 0,0,0,1, 0,6,0,0, 0,0,0,0];
    const body = [0x45,0x78,0x69,0x66,0,0, ...tiff];
    const len = body.length + 2;
    const app1 = [0xff,0xe1, len >> 8, len & 255, ...body];
    return new Blob([src.slice(0, 2), new Uint8Array(app1), src.slice(2)], { type: 'image/jpeg' });
  },
  is: {
    red: p => p[0] > 180 && p[1] < 80 && p[2] < 80,
    blue: p => p[2] > 180 && p[0] < 80 && p[1] < 80,
    green: p => p[1] > 150 && p[0] < 80 && p[2] < 80,
    yellow: p => p[0] > 200 && p[1] > 200 && p[2] < 80,
    magenta: p => p[0] > 180 && p[2] > 180 && p[1] < 80,
    gray: p => Math.abs(p[0] - 136) < 20 && Math.abs(p[1] - 136) < 20 && Math.abs(p[2] - 136) < 20,
    white: p => p[0] > 245 && p[1] > 245 && p[2] > 245,
    black: p => p[0] < 40 && p[1] < 40 && p[2] < 40,
  },
};`;

const MAX_BYTES = 250 * 1024;
function common(r, w, h) {
  assert.equal(r.width, w, `너비 ${r.width} ≠ ${w}`);
  assert.equal(r.height, h, `높이 ${r.height} ≠ ${h}`);
  assert.ok(Math.abs(r.width - r.height * 3 / 4) <= 1, `3:4 가 아니다: ${r.width}×${r.height}`);
  assert.match(r.head, /^data:image\/jpeg;base64,/, `JPEG 가 아니다: ${r.head}`);
  assert.ok(r.bytes > 0 && r.bytes < MAX_BYTES, `너무 크다: ${r.bytes} bytes`);
  assert.equal(r.decodedW, r.width, '결과 JPEG 를 다시 읽은 너비가 다르다');
  assert.equal(r.decodedH, r.height, '결과 JPEG 를 다시 읽은 높이가 다르다');
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cert-photos-chrome-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
try {
  const tab = await browser.newPage();
  const net = [];
  tab.on('request', q => { if (!/^(data|blob|about):/.test(q.url())) net.push(q.url()); });
  const pageErrors = [];
  tab.on('pageerror', e => pageErrors.push(e.message));
  await tab.goto('about:blank');
  await tab.addScriptTag({ content: iife });
  await tab.addScriptTag({ content: helpers });

  // 페이지 안에서 그림을 만들고 preparePhoto 를 돌려, 크기·머리·바이트와 표본 픽셀 판정을 돌려받는다.
  async function run(makeBody, checksBody, opts = {}, before = '') {
    return tab.evaluate(async (makeBody, checksBody, opts, before) => {
      const make = new Function('T', `return (async () => { ${makeBody} })()`);
      const blob = await make(T);
      if (before) new Function('T', before)(T);
      const r = await CP.preparePhoto(blob, opts);
      const px = await T.reader(r.dataUrl);
      const bmp = await createImageBitmap(await (await fetch(r.dataUrl)).blob());
      const checks = checksBody ? new Function('px', 'T', 'r', `return (${checksBody})`)(px, T, r) : {};
      return { width: r.width, height: r.height, bytes: r.bytes, faceCentered: r.faceCentered, head: r.dataUrl.slice(0, 30), decodedW: bmp.width, decodedH: bmp.height, checks };
    }, makeBody, checksBody, opts, before);
  }
  const allTrue = checks => { for (const [k, v] of Object.entries(checks)) assert.equal(v, true, `표본 실패: ${k} → ${JSON.stringify(checks)}`); };

  const LANDSCAPE = `return T.make(1200, 900, 'image/jpeg', (x, w, h) => {
    x.fillStyle = '#888'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#00f'; x.fillRect(0, 0, 100, h);       // 왼쪽 끝(잘려 나가야 한다)
    x.fillStyle = '#0c0'; x.fillRect(1100, 0, 100, h);    // 오른쪽 끝(잘려 나가야 한다)
    x.fillStyle = '#f00'; x.fillRect(580, 0, 40, h);      // 가운데 띠
  });`;

  await ok('가로 1200×900 JPEG → 600×800, 가로 가운데 유지(가운데 빨간 띠가 x≈300), 양 끝은 잘림', async () => {
    const r = await run(LANDSCAPE, `(() => {
      let first = -1, last = -1;
      for (let x = 0; x < r.width; x++) if (T.is.red(px(x, 400))) { if (first < 0) first = x; last = x; }
      return { stripeCenter: Math.abs((first + last) / 2 - 300) <= 3, stripeWidth: last - first >= 30 && last - first <= 40,
        leftGray: T.is.gray(px(5, 400)), rightGray: T.is.gray(px(r.width - 5, 400)) };
    })()`);
    common(r, 600, 800);
    assert.equal(r.faceCentered, false);
    allTrue(r.checks);
  });

  await ok('투명 PNG 500×500 → 375×500(키우지 않음), 투명 부분은 흰 바탕, JPEG', async () => {
    const r = await run(`return T.make(500, 500, 'image/png', (x, w, h) => {
      x.clearRect(0, 0, w, h);
      x.fillStyle = '#0c0'; x.beginPath(); x.arc(250, 250, 100, 0, Math.PI * 2); x.fill();
    });`, `({ cornerWhite: T.is.white(px(2, 2)), bottomWhite: T.is.white(px(370, 497)), centerGreen: T.is.green(px(187, 250)) })`);
    common(r, 375, 500);
    allTrue(r.checks);
  });

  await ok('세로 3000×4000 → 600×800, 250KB 아래', async () => {
    const r = await run(`return T.make(3000, 4000, 'image/jpeg', (x, w, h) => {
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#fde'); g.addColorStop(1, '#345');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) { x.fillStyle = 'hsl(' + (i * 37 % 360) + ',60%,50%)'; x.beginPath(); x.arc((i * 733) % w, (i * 1291) % h, 60 + (i * 17) % 200, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = '#f00'; x.fillRect(1480, 0, 40, h);
    });`, `({ centerRed: T.is.red(px(300, 400)) })`);
    common(r, 600, 800);
    allTrue(r.checks);
  });

  await ok('세로로 긴 1000×2000 → 위 15% 어림: 맨 위 파란 띠는 잘리고 y=110~150 노란 띠가 위쪽에, 아래 검은 띠는 잘림', async () => {
    const r = await run(`return T.make(1000, 2000, 'image/jpeg', (x, w, h) => {
      x.fillStyle = '#888'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#00f'; x.fillRect(0, 0, w, 90);
      x.fillStyle = '#ff0'; x.fillRect(0, 110, w, 40);
      x.fillStyle = '#000'; x.fillRect(0, 1440, w, 560);
    });`, `({ topYellow: T.is.yellow(px(300, 18)), topNotBlue: !T.is.blue(px(300, 1)), bottomGray: T.is.gray(px(300, 795)) })`);
    common(r, 600, 800);
    assert.equal(r.faceCentered, false);
    allTrue(r.checks);
  });

  await ok('longSide 400 → 300×400', async () => {
    const r = await run(LANDSCAPE, null, { longSide: 400 });
    common(r, 300, 400);
  });

  const EXIF = `${LANDSCAPE.replace(/^return /, 'const b = await ')} return T.withOrientation6(b);`;
  const EXIF_CHECKS = `({ midRowRed: T.is.red(px(50, 400)) && T.is.red(px(550, 400)), notVertical: T.is.gray(px(300, 200)),
    topBlue: T.is.blue(px(300, 20)), bottomGreen: T.is.green(px(300, 780)) })`;
  await ok('EXIF Orientation=6(폰 세로 사진) → 돌려서 900×1200 으로 읽고 600×800, 방향도 맞음(createImageBitmap 길)', async () => {
    const r = await run(EXIF, EXIF_CHECKS);
    common(r, 600, 800);
    allTrue(r.checks);
  });

  await ok('createImageBitmap 옵션이 없는 엔진 흉내 → <img> 대체 길도 EXIF 회전·크기 같음', async () => {
    const r = await run(EXIF, EXIF_CHECKS, {}, `window.__cib = window.createImageBitmap; window.createImageBitmap = function (src, opts) {
      if (opts && opts.imageOrientation) throw new TypeError('synthetic: option not supported');
      return window.__cib.apply(this, arguments);
    };`);
    await tab.evaluate(() => { window.createImageBitmap = window.__cib; });
    common(r, 600, 800);
    allTrue(r.checks);
  });

  await ok('얼굴 찾기(가짜 FaceDetector) 세로: 얼굴 가운데가 결과 세로 40%·가로 가운데', async () => {
    const r = await run(`return T.make(1000, 2000, 'image/jpeg', (x, w, h) => {
      x.fillStyle = '#888'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#f0f'; x.fillRect(450, 950, 100, 100);
    });`, `({ faceAt40: T.is.magenta(px(300, 320)), faceNotAtHeuristic: T.is.gray(px(300, 540)) })`, {},
    `window.FaceDetector = class { async detect() { return [{ boundingBox: { x: 10, y: 10, width: 20, height: 20 } }, { boundingBox: { x: 450, y: 950, width: 100, height: 100 } }]; } };`);
    await tab.evaluate(() => { delete window.FaceDetector; });
    common(r, 600, 800);
    assert.equal(r.faceCentered, true);
    allTrue(r.checks);
  });

  await ok('얼굴 찾기(가짜) 가로 2000×1000: 오른쪽 얼굴 쪽으로 잘라 얼굴이 가로 가운데', async () => {
    const r = await run(`return T.make(2000, 1000, 'image/jpeg', (x, w, h) => {
      x.fillStyle = '#888'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#f0f'; x.fillRect(1550, 450, 100, 100);
    });`, `({ faceCenter: T.is.magenta(px(300, 400)) })`, {},
    `window.FaceDetector = class { async detect() { return [{ boundingBox: { x: 1550, y: 450, width: 100, height: 100 } }]; } };`);
    await tab.evaluate(() => { delete window.FaceDetector; });
    common(r, 600, 800);
    assert.equal(r.faceCentered, true);
    allTrue(r.checks);
  });

  await ok('FaceDetector 가 던지면 조용히 어림 자르기(faceCentered=false)', async () => {
    const r = await run(LANDSCAPE, `({ stripe: T.is.red(px(300, 400)) })`, {},
      `window.FaceDetector = class { constructor() { throw new Error('synthetic: not allowed'); } };`);
    await tab.evaluate(() => { delete window.FaceDetector; });
    common(r, 600, 800);
    assert.equal(r.faceCentered, false);
    allTrue(r.checks);
  });

  await ok('읽을 수 없는 사진(가짜 HEIC) → 한국어 오류', async () => {
    const msg = await tab.evaluate(() => CP.preparePhoto(new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])], { type: 'image/heic' }))
      .then(() => 'resolved', e => String(e && e.message)));
    assert.equal(msg, '이 사진 형식을 읽지 못했어요(HEIC 는 JPG 로 바꿔 주세요)');
  });

  await ok('사진이 기기 밖으로 나가지 않는다(네트워크 요청 0)·페이지 오류 0', async () => {
    assert.deepEqual(net, []);
    assert.deepEqual(pageErrors, []);
  });

  const native = await tab.evaluate(() => typeof window.FaceDetector);
  console.log(`INFO 이 크롬의 진짜 FaceDetector: ${native === 'function' ? '있음' : '없음(어림 자르기로 동작)'}`);
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'cert photos: all passed');
process.exitCode = failed ? 1 : 0;
