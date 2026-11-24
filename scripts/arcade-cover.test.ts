// 표지 그림 규칙 — 실행: npx tsx scripts/arcade-cover.test.ts
import assert from "node:assert/strict";
import { coverUrl, ARCADE_LINK_BASE } from "../src/arcade-model";
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const doc = (paths: string[], lock: string[] = []) => ({ files: paths.map((path) => ({ path, sha256: "0".repeat(64), size: 1 })), ...(lock.length ? { lock: { paths: lock } } : {}) }) as any;
assert.equal(coverUrl({ docCid: cid, doc: doc(["cover.png", "index.html"]) }), `${ARCADE_LINK_BASE}${cid}/cover.png`);
assert.equal(coverUrl({ docCid: cid, doc: doc(["cover.webp", "index.html"]) }), `${ARCADE_LINK_BASE}${cid}/cover.webp`);
assert.equal(coverUrl({ docCid: cid, doc: doc(["index.html"]) }), null, "그림 없으면 null");
assert.equal(coverUrl({ docCid: cid, doc: doc(["art/cover.png"]) }), null, "맨 위 폴더만");
assert.equal(coverUrl({ docCid: cid, doc: doc(["cover.png"], ["cover.png"]) }), null, "잠긴 파일은 안 보인다");
assert.equal(coverUrl({ docCid: "../x", doc: doc(["cover.png"]) }), null, "이상한 CID");
assert.equal(coverUrl({ docCid: cid, doc: {} as any }), null, "파일 목록 없음");
console.log("arcade-cover: 7 통과");
