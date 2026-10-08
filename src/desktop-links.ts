/** Single phone onboarding entry. This opens the website, not the node wallet.
 * Public entry points only: never put wallet, API, or session data in these URLs. */
export const RAVENVAULT_WALLET = "https://ravenvault.ex.erci.se/wallet/";
// Legacy DM/payment uses an independent browser wallet at its existing origin.
export const LEGACY_LOCAL_WALLET = "http://127.0.0.1:8790/wallet";

export async function openRavenVaultWallet(open: (url: string) => Promise<unknown>): Promise<void> {
  await open(RAVENVAULT_WALLET);
}

/** Tauri OS opener is the Desktop equivalent of shell.openExternal. */
export const RAVI_STORY_URL = "https://ravenvault.ex.erci.se/game/ravi-story";
export async function openRaviStory(shell: { openExternal: (url: string) => Promise<unknown> }): Promise<void> {
  await shell.openExternal(RAVI_STORY_URL);
}
