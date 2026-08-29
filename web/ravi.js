/**
 * 폰에서의 라비 — 자고 있는지 깨어 있는지 **누르기 전에** 안다.
 *
 * 🔴 대표 질문: "노드를 운영하는 가게 사장은 노드에 api 넣으면 눈을 뜨는데
 * 사장화면에 또 api 를 넣어야 하나?"
 *
 * **아니다.** 열쇠는 가게 컴퓨터 한 곳에만 둔다. 이유는 편해서가 아니라 안전해서다:
 *
 * - 폰에 키를 넣으면 그 키가 **폰의 localStorage** 에 남는다. 폰은 잃어버리고,
 *   빌려주고, 손님에게 넘겨 보여준다. 컴퓨터의 0600 파일과는 위험이 다르다.
 * - 사장이 폰 세 대를 쓰면 키를 세 번 넣어야 하고, 바꿀 때 세 번 바꿔야 한다.
 *   한 대를 잊으면 그 폰만 옛 키로 돈다 — 어느 폰인지 알 방법이 없다.
 * - 직원 폰에 키가 들어가면 그건 이미 사장의 키가 아니다.
 *
 * 그래서 폰은 **묻기만 한다.** 답은 가게 컴퓨터가 자기 키로 만들어서 돌려준다.
 * 사장 폰·직원 폰·손님 폰 전부 같은 구조라 예외가 없다.
 *
 * ## 자고 있을 때 무엇을 보여주나 — 보는 사람마다 다르다
 *
 * | 보는 사람 | 자고 있으면 |
 * |---|---|
 * | 사장·직원 | 자는 얼굴 + **깨우는 방법**(가게 컴퓨터에서). 키 칸은 없다 |
 * | 손님 | 버튼을 **아예 안 보여준다.** 눌러서 안 되는 것보다 없는 편이 낫다 |
 *
 * 손님에게 "이 가게는 자동 응대를 켜지 않았습니다" 를 보여줄 이유가 없다.
 * 그건 가게 사정이지 손님이 알 일이 아니고, 알아 봐야 할 수 있는 게 없다.
 */
(() => {
  /** 노드에 물어본 결과를 담아 둔다. 화면마다 다시 묻지 않게. */
  let state = null;

  /** 자는 얼굴 · 깬 얼굴. 노드 안에 있는 그림이라 인터넷이 없어도 뜬다. */
  const FACE_SLEEP = '/raven-sleep.webp';
  const FACE_HELLO = '/raven-hello.webp';

  /**
   * 노드에게 "라비 깨어 있나요" 를 묻는다.
   *
   * 못 물어본 경우(노드가 껐거나 와이파이가 끊김)는 **자는 것으로 친다.**
   * 반대로 깬 것으로 치면 버튼이 보이고, 누르면 오류가 난다 — 그게 더 나쁘다.
   */
  async function status() {
    if (state) return state;
    try {
      const r = await fetch('/api/ai-status', { cache: 'no-store' });
      state = r.ok ? await r.json() : { awake: false };
    } catch {
      state = { awake: false };
    }
    return state;
  }

  /**
   * 자고 있는 라비 한 덩이. 사장·직원 화면에서만 쓴다.
   *
   * 깨우는 방법을 **그 자리에 적는다.** "설정에서 켜세요" 는 어디인지 모르면
   * 안내가 아니다. 컴퓨터로 가야 한다는 것까지 말해야 한다.
   */
  function sleepingBox(t) {
    const say = t || ((s) => s);
    return `
      <div class="ravibox sm ravi-asleep">
        <img src="${FACE_SLEEP}" alt="" />
        <div class="rt">${say('라비가 자고 있어요')}</div>
        <div class="rs">
          ${say('라비는 가게 컴퓨터의 열쇠로 깨어납니다.')}<br />
          <b>${say('가게 컴퓨터 → PLAY X Raven → 설정 → AI')}</b><br />
          ${say('거기서 한 번만 넣으면 이 폰에서도 깨어납니다.')}
        </div>
      </div>`;
  }

  /**
   * 라비 자리를 채운다.
   *
   * @param {Element} host   여기에 그린다
   * @param {'owner'|'guest'} who  보는 사람
   * @param {() => void} awake  깨어 있을 때 원래 그리던 것
   */
  async function mount(host, who, awake) {
    if (!host) return;
    const st = await status();
    if (st.awake) {
      host.hidden = false;
      awake && awake();
      return;
    }
    if (who === 'owner') {
      host.hidden = false;
      host.innerHTML = sleepingBox(window.t);
    } else {
      // 손님에게는 없는 기능이다. 자리도 남기지 않는다 — 빈 네모가 남으면
      // 고장으로 읽힌다.
      host.hidden = true;
    }
  }

  window.Ravi = { status, mount, sleepingBox, FACE_SLEEP, FACE_HELLO };
})();
