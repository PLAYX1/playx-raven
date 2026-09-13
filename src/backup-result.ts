export type WalletBackupResult = {
  name: string;
  size_text: string;
  pretty: string;
  warning: string;
  inside: { name: string; what: string }[];
};

/** A native response with omitted or unverified wallet data is never success. */
export function requireWalletBackup(value: unknown): WalletBackupResult {
  const result = value as Record<string, unknown> | null;
  const entries = result && Array.isArray(result.inside) ? result.inside : [];
  if (!result || result.wallet_included !== true || result.locked !== true || result.verified !== true ||
      !entries.some(entry => entry?.name === "wallet.dat" && Number(entry.size) > 0)) {
    throw new Error("지갑이 포함된 백업을 확인하지 못했습니다. 노드 연결을 확인한 뒤 다시 백업하세요.");
  }
  return {
    name: String(result.name || ""), size_text: String(result.size_text || ""),
    pretty: String(result.pretty || ""), warning: String(result.warning || ""),
    inside: entries.map(entry => ({ name: String(entry?.name || ""), what: String(entry?.what || "") })),
  };
}

export function restoreIsComplete(value: unknown): boolean {
  const result = value as Record<string, unknown> | null;
  return !!result && result.ok === true && result.status === "complete" &&
    Array.isArray(result.done) && result.done.length > 0 &&
    Array.isArray(result.failed) && result.failed.length === 0;
}
