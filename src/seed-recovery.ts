/** Machine markers carry no RPC text or secrets. Translate the sentence only. */
export function seedErrorKind(error: unknown): string | undefined {
  return /^\[SEED_(LOCKED|UNAVAILABLE|NOT_MNEMONIC|OTHER)\] /.exec(String(error))?.[1];
}
export function seedErrorMessage(error: unknown): string {
  return String(error).replace(/^\[SEED_(?:LOCKED|UNAVAILABLE|NOT_MNEMONIC|OTHER)\] /, "");
}
/** Shared inline recovery, including status responses that did not throw. */
export function seedUnlockButton(host: HTMLElement, error: unknown,
  unlock: () => Promise<boolean>, retry: () => Promise<unknown>, label: string): void {
  if (seedErrorKind(error) !== "LOCKED") return;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = "btn";
  host.append(button);
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { if (await unlock()) await retry(); }
    finally { button.disabled = false; }
  };
}
