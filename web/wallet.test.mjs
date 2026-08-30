/**
 * 손님 폰 지갑의 **순수 함수** 시험.
 *
 * ## 왜 생겼나
 *
 * 러스트에는 시험이 356개인데 **화면 쪽은 0개**였다. 그리고 2026-08-30
 * 하루에 화면을 두 번 망가뜨려 배포했다 — 단추 하나가 글자로 새어 나왔고,
 * 멀쩡한 사진을 죽은 주소로 덮어썼다. 둘 다 러스트 시험이 못 잡는 자리다.
 *
 * ## 🔴 소스를 **베껴 적지 않는다**
 *
 * 시험 파일에 함수를 복사해 두면, 진짜 코드가 바뀌어도 시험은 옛것을 계속
 * 통과시킨다. 그건 시험이 아니라 거짓말이다. 그래서 `wallet.src.ts` 에서
 * **함수 본문을 그때그때 떼어 내** 돌린다 — 소스가 바뀌면 시험도 같이 바뀐다.
 *
 * ⚠️ 떼어 낼 수 있는 것은 **밖을 안 만지는 함수**뿐이다. DOM·네트워크를
 *    쓰는 것은 여기서 못 한다. 그건 실화면으로 봐야 한다.
 *
 * 도는 법:  node --test web/wallet.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "wallet.src.ts"),
  "utf8",
);

/**
 * 이름으로 함수 하나를 떼어 낸다. 타입 표기는 지운다(자바스크립트로 돌리려고).
 *
 * 🔴 못 찾으면 **던진다.** 조용히 건너뛰면 「시험 통과」인데 아무것도 안
 *    본 것이 된다 — 이 저장소가 제일 자주 걸리는 병이다.
 */
function 떼어내기(이름) {
  const i = SRC.indexOf(`function ${이름}(`);
  assert.ok(i >= 0, `🔴 소스에서 ${이름} 를 못 찾았습니다 — 이름이 바뀌었나요?`);
  // 중괄호를 세어 함수 끝을 찾는다.
  let j = SRC.indexOf("{", i);
  let depth = 0;
  for (; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0) break;
  }
  const 본문 = SRC.slice(i, j + 1)
    .replace(/:\s*(string|number|boolean)(\[\])?/g, "")
    .replace(/\bconst\s+(\w+):\s*[^=]+=/g, "const $1 =");
  return 본문;
}

const 만들기 = (이름들) =>
  new Function(`${이름들.map(떼어내기).join("\n")}\nreturn { ${이름들.join(", ")} };`)();

test("가게 표는 사람 말로 읽힌다", () => {
  const { 소식표인가, 자산을사람말로 } = 만들기(["소식표인가", "자산을사람말로"]);
  // 🔴 `SHOP.PLAYX 0.00000001개` 는 40~70대에게 「이게 뭐야」다.
  assert.equal(자산을사람말로("SHOP.PLAYX"), "PLAYX 가게 소식");
  assert.equal(소식표인가("SHOP.PLAYX"), true);
  // 가게 표가 아닌 것은 **건드리지 않는다.** 이름을 지어내면 그게 거짓이다.
  assert.equal(자산을사람말로("PLAYX"), "PLAYX");
  assert.equal(자산을사람말로("PLAYX/MUSIC"), "PLAYX/MUSIC");
  assert.equal(소식표인가("PLAYX"), false);
  // 소문자로 찍힌 이름도 가게다.
  assert.equal(소식표인가("shop.abc"), true);
});

test("이름이 없으면 지어내지 않고 앞 8글자를 쓴다", () => {
  const src = 떼어내기("부를이름");
  const f = new Function(`const 이름표 = new Map(arguments[0]); ${src}; return 부를이름;`)([
    ["aaaa1111bbbb2222", { name: "플레이엑스", picture: "" }],
  ]);
  assert.equal(f("aaaa1111bbbb2222"), "플레이엑스");
  // 🔴 모르는 사람에게 이름을 붙이면 그건 사칭을 우리가 돕는 것이다.
  assert.equal(f("cccc3333dddd4444"), "cccc3333");
});

test("얼굴 주소는 https 만 받는다", () => {
  const { 안전한얼굴 } = 만들기(["안전한얼굴"]);
  assert.equal(안전한얼굴("https://a.com/x.jpg"), "https://a.com/x.jpg");
  // 🔴 남이 정하는 값이다. 이게 통과하면 우리가 공격을 뿌리는 셈이다.
  assert.equal(안전한얼굴("javascript:alert(1)"), "");
  assert.equal(안전한얼굴("http://a.com/x.jpg"), "");
  assert.equal(안전한얼굴('https://a.com/"onerror=x'), "");
  assert.equal(안전한얼굴(""), "");
});

test("색은 이름이 아니라 열쇠에서 나온다", () => {
  const { 열쇠색 } = 만들기(["열쇠색"]);
  const a = 열쇠색("aaaa1111");
  // 같은 열쇠 = 늘 같은 색. 안 그러면 화면을 다시 그릴 때마다 색이 바뀐다.
  assert.equal(a, 열쇠색("aaaa1111"));
  // 🔴 다른 열쇠는 다른 색이어야 한다 — 이름을 똑같이 베낀 사람을 가르는
  //    유일한 표시다.
  assert.notEqual(a, 열쇠색("bbbb2222"));
  assert.ok(a >= 0 && a < 360, "색상값은 0~359 여야 한다");
});
