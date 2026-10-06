/** Paste cleanup and safe IPC error copy. Never render arbitrary provider errors. */
export function normalizeApiKey(value: string): string {
  let key = value.replace(/[\r\n]/g, "").trim();
  for (;;) {
    const previous = key;
    key = key.replace(/^[\s'"‘’“”]+|[\s'"‘’“”]+$/g, "").replace(/^(?:Bearer\s+|key=)\s*/i, "").trim();
    if (key === previous) return key;
  }
}

export function keyConnectionFailure(error: unknown): { phrase: string; status?: number; rejected: boolean } {
  const e = error as { kind?: unknown; status?: unknown } | null;
  const status = typeof e?.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
  // Numeric status takes precedence; a malformed IPC error cannot permit a rejected key.
  const kind = status !== undefined ? ([400, 401, 403].includes(status) ? "rejected" : status === 429 ? "quota" : status >= 500 ? "server" : "http") : typeof e?.kind === "string" ? e.kind : undefined;
  const phrases: Record<string, string> = {
    rejected: "키가 거절됐어요. 회사가 맞는지, 키를 처음부터 다시 복사했는지 확인하고 다시 넣어 주세요.",
    quota: "AI 사용 한도를 넘었어요. 회사의 사용 한도와 결제 설정을 확인하거나 잠시 뒤 다시 눌러 주세요.",
    server: "AI 회사 서버에 문제가 있어요. 잠시 뒤 다시 눌러 주세요.",
    network: "AI 회사에 연결하지 못했어요. 인터넷 연결과 VPN·방화벽을 확인하고 다시 눌러 주세요.",
    timeout: "연결 확인 시간이 초과됐어요. 인터넷 연결과 VPN·방화벽을 확인하고 다시 눌러 주세요.",
    format: "키 형식이 고른 회사와 맞지 않아요. 키를 발급한 회사를 다시 골라 주세요.",
    storage: "저장된 키를 읽지 못했어요. OS 보안 저장소 권한을 확인하고 키를 다시 저장해 주세요.",
    setup: "AI 연결을 준비하지 못했어요. 회사 설정을 확인하고 앱을 다시 열어 주세요.",
  };
  return { phrase: kind && Object.prototype.hasOwnProperty.call(phrases, kind) ? phrases[kind] : "AI 연결을 확인하지 못했어요. 회사 설정을 확인하고 다시 눌러 주세요.", status,
    rejected: status !== undefined && [400, 401, 403].includes(status) };
}

// save_api_key returns these app-owned errors only. Unknown strings (which may
// contain a key, an OS path or an HTTP body) never reach the screen.
const storageErrors = new Set([
  "AI 설정 폴더를 열지 못했습니다.", "AI 키 잠금 파일을 열지 못했습니다.", "AI 키 잠금을 얻지 못했습니다.",
  "OS 보안 저장소를 열지 못했습니다.", "API 키를 보안 저장소에 저장하지 못했습니다.",
  "AI 설정을 저장하지 못했습니다. 설정 폴더 권한과 여유 공간을 확인하세요.",
  "AI 키 파일을 지우지 못했습니다. 설정 폴더 권한을 확인하세요.",
  "키는 저장됐지만 삭제 표식을 정리하지 못했습니다. 다시 저장해 주세요.",
  "API 키를 줄바꿈 없이 다시 입력하세요.", "키가 비어 있어요", "키가 너무 짧아요",
  "키 형식이 고른 회사와 맞지 않아요. 키를 발급한 회사를 다시 골라 주세요.",
]);
export function keyStorageError(error: unknown): string {
  return typeof error === "string" && storageErrors.has(error) ? error : "키를 저장하지 못했어요. OS 보안 저장소 권한과 설정 폴더를 확인해 주세요.";
}

export type SafeConnectionError = { kind: string; status?: number };
const connectionKinds = new Set(["rejected", "quota", "server", "network", "timeout", "format", "storage", "setup", "http"]);
export function safeConnectionError(error: unknown): SafeConnectionError {
  const failure = keyConnectionFailure(error);
  const kind = (error as { kind?: unknown } | null)?.kind;
  return { kind: typeof kind === "string" && connectionKinds.has(kind) ? kind : "http", status: failure.status };
}

/** Pending checks are session-only and never determine whether Ravi wakes. */
export class SavedKeyChecks {
  readonly pending = new Set<string>();
  readonly checked = new Set<string>();
  readonly results = new Map<string, SafeConnectionError | null>();
  readonly rejected = new Map<string, number>();
  private versions = new Map<string, number>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    // Migration: old pending records could permanently put a saved key to sleep.
    // Run once at app initialization, even if the old JSON is malformed.
    try { storage.removeItem("rv-ai-pending-checks"); } catch { /* storage may be disabled */ }
    try {
      const saved = JSON.parse(storage.getItem("rv-ai-rejected-keys") || "{}");
      for (const provider of ["google", "openai", "anthropic", "groq", "xai", "custom"]) {
        const status = saved?.[provider];
        if ([400, 401, 403].includes(status)) {
          this.rejected.set(provider, status);
          this.results.set(provider, { kind: "rejected", status });
        }
      }
    } catch { /* ignore corrupt state; saved keys still wake Ravi */ }
  }
  private persist(): void {
    try { this.storage.setItem("rv-ai-rejected-keys", JSON.stringify(Object.fromEntries(this.rejected))); }
    catch { /* localStorage is advisory, never a key-storage failure */ }
  }
  forget(provider: string): void {
    this.versions.set(provider, (this.versions.get(provider) || 0) + 1);
    this.pending.delete(provider);
    this.checked.delete(provider);
    this.results.delete(provider);
    this.rejected.delete(provider);
    this.persist();
  }
  begin(provider: string, force = false): number | null {
    if (this.pending.has(provider) || !force && this.checked.has(provider)) return null;
    const version = (this.versions.get(provider) || 0) + 1;
    this.versions.set(provider, version);
    this.pending.add(provider);
    this.checked.add(provider);
    return version;
  }
  finish(provider: string, version: number, error?: unknown): boolean {
    if (this.versions.get(provider) !== version) return false; // deleted/replaced key
    this.pending.delete(provider);
    const result = error === undefined ? null : safeConnectionError(error);
    if (result === null) this.rejected.delete(provider);
    else if (keyConnectionFailure(result).rejected) this.rejected.set(provider, result.status!);
    // A retry timeout cannot erase a previous explicit rejection of the same key.
    const rejected = this.rejected.get(provider);
    this.results.set(provider, rejected ? { kind: "rejected", status: rejected } : result);
    this.persist();
    return true;
  }
}
