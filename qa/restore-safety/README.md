# Desktop restore safety proof

This standalone crate compiles the production restore file functions and OS lock helper without the Tauri app, real RPC, node process, or user data paths. Its only data files are generated synthetic fixtures under `qa/restore-safety/fixtures/`. `lock-peer` is a separate OS process with an independent implementation of the Boost lock convention; it does not call the production guard.

Run from the repository:

```sh
cargo test --locked --manifest-path qa/restore-safety/Cargo.toml -- --test-threads=1
python3 qa/restore-safety/run.py --offline --verify-mutations
```

The first command is the release CI command on macOS, Linux, and Windows. `--offline` in the second command assumes Cargo dependencies are cached. The wrapper normalizes any failed test process to exit 1 and saves synthetic-only logs under `results/`. Its mutation suite additionally requires an actual failed assertion, so a compiler failure cannot pass the negative check.

## Local evidence

On this Mac, 23 tests passed. Five mutations each produced assertion failures and wrapper exit 1, followed by another normal 23/23 pass:

- Remove the compatible node lock.
- Move the current file away before copying the replacement, recreating the original restore failure.
- Delete the actual previous file captured at replacement.
- Report every moving restore as successful.
- Replace the final exchange with plain rename, which loses a late JSON writer.

`json_writer_at_final_replace_is_preserved_as_actual_previous` also failed on the initial plain-rename implementation before the fix. It injects the app's normal write-temporary-file → rename pattern at the last pre-syscall hook. The final exchange preserves that actual latest file. A separate test creates a previously absent destination at that same point and confirms the restore refuses to overwrite it.

Other checks cover an external node-style lock while fake RPC fails, exclusion until guard drop, same-process second-open prevention, a separate app session/scratch lock, preparation/previous-copy/readback/rename/flush failures, source identity and content changes, symlinks, directory/lock substitution, repeated previous copies, empty/missing/invalid records, exact partial success reporting, synthetic ZIP extraction, duplicate/traversal rejection, and complete/invalid/legacy backup listing.

No actual wallet database, node shutdown, or LAN move was tested by this harness. The later [0.4.1 release run](https://github.com/PLAYX1/playx-raven/actions/runs/34772777228) passed this harness on Windows (21 tests), Linux (23), and both Mac build runners (23 each). The Intel Mac binary was cross-built on an Apple Silicon runner, not executed on Intel hardware. All four installer builds and the publication push succeeded; the run's final public metadata check failed during a short-lived CDN cache delay. Subsequent public checks verified all seven file hashes, all four updater signatures, tamper rejection, and both update domains. See `BACKUP-UPGRADE-DELIVERY.md` for the separate browser UI evidence and the exact release source.

## Production behavior and limits

RPC failure is not evidence of shutdown. A responsive RPC conservatively refuses wallet restore; an unresponsive RPC still requires the selected node folder's `.lock`. The process keeps that lock through all wallet staging, verification, preservation, replacement, and final verification. The selected folder is captured before the RPC await and checked again afterwards. The guard also checks directory/lock identity and rejects wallet aliases of `.lock`.

Preparation copies the incoming file into a newly created private file, flushes it, and checks its SHA-256 against both source and readback. A unique verified previous copy must succeed before replacement. Existing fixed `.before-restore` copies are never overwritten. JSON must parse before any replacement; byte verification of a wallet is not validation of its Berkeley DB contents. The node performs wallet validation when it is started later.

For an existing destination, macOS uses `renamex_np(RENAME_SWAP)`, Linux uses `renameat2(RENAME_EXCHANGE)`, and Windows uses `ReplaceFileW` with a unique backup name. The file actually replaced is retained even if another JSON writer renames a new file between the earlier check and the final syscall. For an absent destination, creation does not overwrite a concurrent new file. Unsupported filesystem exchange operations fail closed.

On Unix, the actual previous file can retain the `.wallet.dat.restore-stage-*` or `.shop.json.restore-stage-*` name after exchange. It is returned as `previous`; **do not classify or delete it as abandoned staging**. The earlier verified `.before-restore-*` copy is also retained. A caller must display `previous` on both `done` and `failed` items. Failures after replacement have `changed: true`, `restart_app: true`, and an unsuccessful/partial overall status. They must not be displayed as completed restoration.

Windows `ReplaceFileW` documents a partial-failure state (`ERROR_UNABLE_TO_MOVE_REPLACEMENT_2`) where the original is already at the backup path. The implementation retains it, tries to restore the original destination name only when absent (without overwriting a new writer), and still reports failure. It does not claim power-loss transactionality; Windows has no supported `REPLACEFILE_WRITE_THROUGH` flag. The node must stay stopped after a changed failure until the reported previous file is checked.

The app uses its separate `.ravenvault-restore.lock` through extraction, the RPC await, installation, and cleanup. Its atomic in-process gate is released only after closing that lock descriptor. Startup cleanup takes the same lock, preventing another app process from erasing the shared decrypted scratch folder. Scratch sources are rejected before cleanup; failed extraction cleans only its newly created scratch. Private extracted files use mode 0600 and the scratch directory 0700 on Unix. As with the rest of the app, this is not protection against a malicious program running as the same OS account and deliberately replacing lock paths.

Backup listing hides staging/unrelated names and uses `complete_snapshot` from the coordinated `backup.rs` change for the completed marker. Marker-bearing corrupt snapshots are refused before restore. Marker-less older backups remain available with an explicit unverified legacy label. This restore worktree therefore must be integrated with root's `backup::complete_snapshot(&Path) -> bool` implementation.

LAN moving received only truthful partial-result reporting. Its earlier password/transfer protocol problem was intentionally not connected or redesigned in this patch, and a successful synthetic restore is not proof of a safe cross-computer move.

## Primary references inspected

- [Ravencoin init.cpp](https://github.com/RavenProject/Ravencoin/blob/master/src/init.cpp): `LockDataDirectory`, `AppInitLockDataDirectory`, `VerifyWallets`, `PrepareShutdown`, and `Shutdown`. Node startup takes `.lock` before opening wallets and retains it until exit; RPC stops earlier than wallet cleanup. [Daemon entry point](https://github.com/RavenProject/Ravencoin/blob/master/src/ravend.cpp) calls lock acquisition before main initialization.
- [Ravencoin Boost dependency](https://github.com/RavenProject/Ravencoin/blob/master/depends/packages/boost.mk) pins Boost 1.71. [That version's OS file functions](https://github.com/boostorg/interprocess/blob/boost-1.71.0/include/boost/interprocess/detail/os_file_functions.hpp) use `fcntl(F_SETLK, F_WRLCK, SEEK_SET, start=0, len=0)` on Unix and nonblocking exclusive `LockFileEx` from zero with both length words `u32::MAX` on Windows. Closing another descriptor for the same inode releases process-owned POSIX locks; the in-process gate must precede opening a lock file.
- [Rust File locking documentation](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock): the Unix standard-library primitive uses `flock`, a different convention. It is not used here.
- [Apple rename flags and declarations](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h), [Linux rename/renameat2 manual](https://man7.org/linux/man-pages/man2/rename.2.html), and [Microsoft ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) document the final replacement primitives and their limits.
