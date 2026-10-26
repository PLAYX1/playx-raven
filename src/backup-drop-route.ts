// 끌어다 놓은 파일 중 레이븐볼트 백업(.pxlock · .rvwallet)을 **자산 드롭보다 먼저** 가른다. (0.9.0)
//
// 🔴 main.ts 의 onDropped 맨 앞에서 한 줄로 부른다. 백업 파일이 하나라도 섞여 있으면 여기서 끝낸다 —
//    지갑 백업이 「상품 만들기」·「새 자산」·증명서 같은 자산 드롭 흐름으로 흘러가면 안 된다.
// 🔴 이름(확장자)으로 먼저 가르고, 머리(PXRLOCK1)는 Rust(`restore_drop_inspect`)가 다시 본다.
// 🔴 확인 창과 문구는 무거우니 놓았을 때만 불러온다(지연 로딩 — 메인 묶음 1000KB 예산).
// 같은 규칙: src-tauri/src/restore_drop.rs `kind_of_name`.

export type BackupDropKind = "full" | "wallet";

/** 이름으로 고른다: `.rvwallet` → 지갑만, `.pxlock`(옛 `.잠김`) → 가게 전체 백업. 대소문자 무시. */
export function backupDropKind(path: string): BackupDropKind | null {
  const name = (String(path).split(/[\\/]/).pop() || "").toLowerCase();
  if (name.endsWith(".rvwallet")) return "wallet";
  if (name.endsWith(".pxlock") || name.endsWith(".잠김")) return "full";
  return null;
}

/** 놓은 것 중 백업 파일들. */
export function backupDropPaths(paths: string[]): string[] {
  return (paths || []).filter((p) => backupDropKind(p) !== null);
}

/** 백업 파일이 섞여 있으면 확인 창을 열고 true(자산 드롭으로 넘기지 않는다). 아니면 false. */
export function routeBackupDrop(paths: string[]): boolean {
  const found = backupDropPaths(paths);
  if (!found.length) return false;
  void import("./backup-extra").then((m) => m.openRestoreDialog(found, paths.length)).catch(() => {});
  return true;
}
