import { deriveSalesAddress } from '../core/official-sales/xpub';
import { SALES_ACCOUNT_INDEX } from '../core/wallet-keys/sales-account';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type PublicAccount = { xpub: string; addresses: string[] };
export const SALES_TTL = 60_000;
/** No seeds/passwords retained. Epoch guards reject replies after hide/blur/navigation. */
export function salesDisclosure(now: () => number = Date.now) {
  let epoch = 0, expires = 0, account: PublicAccount | null = null;
  return {
    hide() { epoch++; expires = 0; account = null; },
    begin() { account = null; expires = 0; return ++epoch; },
    current(at: number) { return at === epoch; },
    publish(at: number, value: PublicAccount) {
      if (at !== epoch) return false;
      account = value; expires = now() + SALES_TTL; return true;
    },
    read() { if (now() >= expires) account = null; return account; },
  };
}
export function wireSalesAccount(deps: {
  invoke: Invoke; ask: () => Promise<string | null>; cancelAsk?: () => void; active: () => boolean;
}) {
  const element = (id: string) => document.getElementById(id)!;
  const state = salesDisclosure();
  let timer: ReturnType<typeof setTimeout> | undefined, busy = false, asking = false;
  const notice = (text: string) => { element('sales-notice').textContent = text; };
  const button = (id: string) => element(id) as HTMLButtonElement;
  function controls() {
    button('sales-reveal').disabled = busy || !!state.read();
    button('sales-refresh').disabled = busy || !state.read();
    button('sales-copy').disabled = !state.read();
  }
  function hide() {
    state.hide(); clearTimeout(timer);
    if (asking) { asking = false; deps.cancelAsk?.(); }
    element('sales-public').replaceChildren();
    element('sales-balance').textContent = '잔액 확인 전';
    controls();
  }
  function visible(at: number) { return state.current(at) && deps.active() && !document.hidden; }
  button('sales-reveal').onclick = async () => {
    if (busy) return;
    hide(); const at = state.begin(); busy = true; controls(); notice('');
    let password: string | null = null;
    try {
      asking = true;
      password = await deps.ask();
      asking = false;
      if (!password || !visible(at)) return;
      const pending = deps.invoke<string>('sales_account_reveal', { passphrase: password });
      password = null;
      const xpub = await pending;
      if (!visible(at)) return;
      const addresses = await Promise.all([0, 1, 2].map(i => deriveSalesAddress(xpub, SALES_ACCOUNT_INDEX, i)));
      const qr = await deps.invoke<string>('qr_svg', { text: xpub });
      if (!visible(at) || !state.publish(at, { xpub, addresses })) return;
      const number = document.createElement('p'); number.className = 'sales-number'; number.textContent = xpub;
      const image = document.createElement('img'); image.width = 196; image.height = 196;
      image.alt = '받기 전용 번호 QR 코드'; image.src = `data:image/svg+xml,${encodeURIComponent(qr)}`;
      const title = document.createElement('h3'); title.textContent = '처음 받는 주소 3개 · 게임 설정과 비교하세요';
      const rows = addresses.map((address, i) => { const p = document.createElement('p'); p.className = 'sales-number'; p.textContent = `${i}번 · ${address}`; return p; });
      element('sales-public').replaceChildren(number, image, title, ...rows);
      timer = setTimeout(() => { hide(); notice('1분이 지나 번호를 숨겼어요. 다시 보려면 인증해 주세요.'); }, SALES_TTL);
      notice('게임 설정과 믿을 수 있는 대표·관리자에게만 이 번호를 알려 주세요.');
    } catch { if (visible(at)) notice('판매 계정을 열지 못했어요. 암호가 설정된 12단어 지갑과 서버 상태를 확인해 주세요.'); }
    finally { password = null; busy = false; controls(); }
  };
  button('sales-hide').onclick = () => { hide(); notice('번호를 숨겼어요.'); };
  button('sales-copy').onclick = async () => {
    const shown = state.read(); if (!shown) { hide(); return; }
    try { await navigator.clipboard.writeText(shown.xpub); if (state.read()) notice('복사했어요. 게임 설정 칸에 붙여 넣으세요. 복사한 번호는 클립보드에 남을 수 있어요.'); }
    catch { if (state.read()) notice('복사하지 못했어요. 번호를 직접 선택해 복사해 주세요.'); }
  };
  button('sales-refresh').onclick = async () => {
    const shown = state.read(); if (!shown || busy) return;
    busy = true; controls(); element('sales-balance').textContent = '주소 100개 확인 중…';
    try {
      const addresses = await Promise.all(Array.from({ length: 100 }, (_, i) => deriveSalesAddress(shown.xpub, SALES_ACCOUNT_INDEX, i)));
      if (state.read() !== shown) return;
      const result = await deps.invoke<{ confirmedSats: string; checked: number }>('sales_account_balance', { addresses });
      if (state.read() !== shown) return;
      if (result.checked !== 100 || !/^\d+$/.test(result.confirmedSats)) throw Error();
      const sats = BigInt(result.confirmedSats);
      element('sales-balance').textContent = `${sats / 100000000n}.${(sats % 100000000n).toString().padStart(8, '0')} RVN · 확정 잔액 · 받는 주소 0~99번 (100개)`;
    } catch { if (state.read() === shown) element('sales-balance').textContent = '확인 실패 · 잔액 0이 아니에요. 메인넷 동기화와 주소 색인을 확인해 주세요.'; }
    finally { busy = false; controls(); }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  controls();
  return { hide };
}
