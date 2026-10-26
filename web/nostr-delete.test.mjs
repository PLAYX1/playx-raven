/** 지움 요청(kind 5)을 목록에서 거르는 규칙 시험. 소스에서 함수를 떼어 와 돌린다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "nostr.ts"), "utf8");
const i = SRC.indexOf("export function withoutDeleted(");
assert.ok(i >= 0, "🔴 withoutDeleted 를 못 찾았습니다");
const body = SRC.slice(i).replace("export function", "function")
  .replace(/\(listings: NostrEvent\[\], deletions: NostrEvent\[\]\): NostrEvent\[\]/, "(listings, deletions)")
  .replace(/new Set<string>\(\)/, "new Set()").replace(/new Map<string, number>\(\)/, "new Map()")
  .replace(/const \[k, pk\]/, "const [k, pk]");
const KIND_LISTING = 30402;
const withoutDeleted = new Function("KIND_LISTING", `${body}; return withoutDeleted;`)(KIND_LISTING);

const A = "a".repeat(64), B = "b".repeat(64);
const L = (id, pk, d, at) => ({ id, pubkey: pk, kind: 30402, created_at: at, tags: [["d", d]], content: "" });
const D = (pk, tags, at) => ({ id: "x" + at, pubkey: pk, kind: 5, created_at: at, tags, content: "" });

test("e 태그로 그 글 하나를 뺀다", () => {
  const r = withoutDeleted([L("1", A, "x", 10), L("2", A, "y", 11)], [D(A, [["e", "1"]], 20)]);
  assert.deepEqual(r.map((e) => e.id), ["2"]);
});
test("a 태그는 요청 시각까지의 모든 판을 뺀다, 이후에 다시 올린 글은 산다", () => {
  const dels = [D(A, [["a", `30402:${A}:x`]], 20)];
  const r = withoutDeleted([L("1", A, "x", 10), L("2", A, "x", 15), L("3", A, "x", 30)], dels);
  assert.deepEqual(r.map((e) => e.id), ["3"]);
});
test("남의 글을 지우는 요청은 무시한다", () => {
  const r = withoutDeleted([L("1", A, "x", 10)], [D(B, [["e", "1"], ["a", `30402:${A}:x`]], 20)]);
  assert.equal(r.length, 1);
});
test("지움 요청이 없으면 그대로", () => {
  assert.equal(withoutDeleted([L("1", A, "x", 10)], []).length, 1);
});
