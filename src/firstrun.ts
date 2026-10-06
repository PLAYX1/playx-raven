/** One landing barrier for user requests and essential recovery warnings. */
let landed = false;
const waiting: Array<() => void> = [];
export function afterRaviLanding(run: () => void): void {
  if (landed) run(); else waiting.push(run);
}
export function deferUntilRaviLanding(run: () => void): boolean {
  if (landed) return false;
  waiting.push(run);
  return true;
}
export function finishRaviLanding(): void {
  if (landed) return;
  landed = true;
  document.documentElement.removeAttribute('data-ravi-arriving');
  for (const run of waiting.splice(0)) queueMicrotask(run);
}
export function installFirstRunBarrier(): void {
  document.documentElement.setAttribute('data-ravi-arriving', 'true');
  // Capture before handlers (including native file/microphone dialogs) can run.
  // Keep only the target/action, never a form value or typed secret.
  const deferClick = (event: MouseEvent) => {
    if (landed || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>('button, a, summary, [role="button"]');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    afterRaviLanding(() => { if (target.isConnected) target.click(); });
  };
  document.addEventListener('click', deferClick, true);
  document.addEventListener('dblclick', event => {
    if (landed || !(event.target instanceof HTMLElement)) return;
    const target = event.target;
    event.preventDefault(); event.stopImmediatePropagation();
    afterRaviLanding(() => { if (target.isConnected) target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  }, true);
  document.addEventListener('keydown', event => {
    if (landed || event.isComposing || event.shiftKey || !['Enter', ' '].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (event.key === ' ' && !target.matches('button, a, summary, [role="button"]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const key = event.key;
    afterRaviLanding(() => {
      if (!target.isConnected) return;
      if (target.matches('button, a, summary, [role="button"]')) target.click();
      else target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }, true);
}
