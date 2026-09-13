//! No app paths, node process, RPC endpoint, or real wallet is reachable here.
//! Production pure functions are extracted at build time; test paths are private
//! synthetic fixtures below this harness, never the user's home or temp folder.
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};
include!(concat!(env!("OUT_DIR"), "/compiled.rs"));

struct Fixture(PathBuf);
impl Fixture {
    fn new(name: &str) -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("{}-{name}", std::process::id()));
        assert!(!path.exists(), "fixture must be new");
        fs::create_dir(&path).unwrap();
        for dir in ["source", "app", "node", "opened"] {
            fs::create_dir(path.join(dir)).unwrap();
        }
        Self(path)
    }
    fn path(&self, path: &str) -> PathBuf {
        self.0.join(path)
    }
    fn seed_wallets(&self) {
        fs::write(
            self.path("node/wallet.dat"),
            b"SYNTHETIC OLD WALLET - NOT A KEY",
        )
        .unwrap();
        fs::write(
            self.path("source/wallet.dat"),
            b"SYNTHETIC NEW WALLET - NOT A KEY",
        )
        .unwrap();
    }
    fn apply(&self, keys: &[&str], fake_rpc_responding: bool) -> Value {
        restore_files::apply(
            &self.path("source"),
            &self.path("app"),
            &self.path("node"),
            &keys.iter().map(|key| key.to_string()).collect::<Vec<_>>(),
            fake_rpc_responding,
        )
    }
    fn install(
        &self,
        hook: &mut dyn FnMut(&str, &Path) -> io::Result<()>,
    ) -> Result<Option<PathBuf>, restore_files::RestoreError> {
        restore_files::install(
            &self.path("source/wallet.dat"),
            &self.path("node/wallet.dat"),
            false,
            &mut || Ok(()),
            hook,
        )
    }
    fn old_unchanged(&self) {
        assert_eq!(
            fs::read(self.path("node/wallet.dat")).unwrap(),
            b"SYNTHETIC OLD WALLET - NOT A KEY"
        );
        assert_eq!(
            fs::read(self.path("source/wallet.dat")).unwrap(),
            b"SYNTHETIC NEW WALLET - NOT A KEY"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Peer(Child);
impl Peer {
    fn hold(path: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lock-peer"))
            .arg("hold")
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "LOCKED\n");
        Self(child)
    }
    fn probe(path: &Path) -> i32 {
        Command::new(env!("CARGO_BIN_EXE_lock-peer"))
            .arg("probe")
            .arg(path)
            .status()
            .unwrap()
            .code()
            .unwrap()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        if let Some(mut input) = self.0.stdin.take() {
            let _ = input.write_all(b"x");
        }
        self.0.wait().unwrap();
    }
}

#[test]
fn boost_style_other_process_excludes_restore_during_rpc_failure_or_shutdown() {
    let f = Fixture::new("node-held");
    f.seed_wallets();
    let peer = Peer::hold(&f.path("node/.lock"));
    let result = f.apply(&["wallet"], false); // fake connection refused / timeout / shutdown
    assert_eq!(result["ok"], false);
    assert_eq!(result["failed"].as_array().unwrap().len(), 1);
    assert!(!result["failed"][0]["changed"].as_bool().unwrap());
    f.old_unchanged();
    drop(peer);
    assert_eq!(f.apply(&["wallet"], false)["ok"], true);
}

#[test]
fn restore_lock_blocks_node_start_until_drop_and_reentrant_attempt_does_not_unlock() {
    let f = Fixture::new("restore-held");
    let guard = restore_lock::DataDirGuard::acquire(&f.path("node")).unwrap();
    assert_eq!(Peer::probe(&f.path("node/.lock")), 73);
    assert!(restore_lock::DataDirGuard::acquire(&f.path("node")).is_err());
    guard.check().unwrap();
    assert_eq!(
        Peer::probe(&f.path("node/.lock")),
        73,
        "same-process second open/close must not release POSIX lock"
    );
    drop(guard);
    assert_eq!(Peer::probe(&f.path("node/.lock")), 0);
    assert!(f.path("node/.lock").exists(), "never unlink node lock");
}

#[test]
fn successful_fake_rpc_refuses_even_when_node_lock_is_available() {
    let f = Fixture::new("rpc-up");
    f.seed_wallets();
    let result = f.apply(&["wallet"], true);
    assert_eq!(result["status"], "failed");
    f.old_unchanged();
    assert!(!f.path("node/.lock").exists());
}

#[test]
fn stopped_node_restore_preserves_unique_previous_and_existing_fixed_backup() {
    let f = Fixture::new("restore-success");
    f.seed_wallets();
    fs::write(
        f.path("node/wallet.dat.before-restore"),
        b"EARLIER SYNTHETIC GOOD COPY",
    )
    .unwrap();
    let result = f.apply(&["wallet"], false);
    assert_eq!(result["ok"], true);
    assert_eq!(result["restart_app"], true);
    let previous = result["done"][0]["previous"].as_str().unwrap();
    assert_eq!(
        fs::read(previous).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
    assert_eq!(
        fs::read(f.path("node/wallet.dat")).unwrap(),
        fs::read(f.path("source/wallet.dat")).unwrap()
    );
    assert_eq!(
        fs::read(f.path("node/wallet.dat.before-restore")).unwrap(),
        b"EARLIER SYNTHETIC GOOD COPY"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(previous).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn stage_disk_failure_never_moves_or_truncates_current_wallet() {
    let f = Fixture::new("stage-fail");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "restore-stage" {
                Err(io::Error::other("synthetic disk full"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(!error.changed);
    f.old_unchanged();
    assert_eq!(fs::read_dir(f.path("node")).unwrap().count(), 1);
}

#[test]
fn previous_copy_failure_stops_before_replacement() {
    let f = Fixture::new("previous-fail");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "before-restore" {
                Err(io::Error::other("synthetic write denied"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(!error.changed);
    f.old_unchanged();
}

#[test]
fn readback_corruption_stops_before_current_file_is_touched() {
    let f = Fixture::new("readback-corrupt");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, path| {
            if phase == "verify-copy" && path.to_string_lossy().contains("restore-stage") {
                fs::write(path, b"SYNTHETIC CORRUPTION")?;
            }
            Ok(())
        })
        .unwrap_err();
    assert!(!error.changed);
    f.old_unchanged();
}

#[test]
fn rename_failure_keeps_current_and_verified_previous() {
    let f = Fixture::new("rename-fail");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "replace" {
                Err(io::Error::other("synthetic rename denied"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(!error.changed);
    f.old_unchanged();
    assert_eq!(
        fs::read(error.previous.unwrap()).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
}

#[test]
fn post_rename_failure_reports_changed_and_retains_previous() {
    let f = Fixture::new("post-rename-fail");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "after-replace" {
                Err(io::Error::other("synthetic flush error"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(error.changed);
    assert_eq!(
        fs::read(error.previous.unwrap()).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
    assert_eq!(
        fs::read(f.path("source/wallet.dat")).unwrap(),
        b"SYNTHETIC NEW WALLET - NOT A KEY"
    );
}

#[test]
fn repeated_restore_keeps_each_previous_good_copy() {
    let f = Fixture::new("repeated");
    f.seed_wallets();
    let first = f.install(&mut |_, _| Ok(())).unwrap().unwrap();
    fs::write(f.path("source/wallet.dat"), b"SYNTHETIC THIRD").unwrap();
    let second = f.install(&mut |_, _| Ok(())).unwrap().unwrap();
    assert_ne!(first, second);
    assert_eq!(
        fs::read(first).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
    assert_eq!(
        fs::read(second).unwrap(),
        b"SYNTHETIC NEW WALLET - NOT A KEY"
    );
}

#[test]
fn source_and_destination_same_path_or_hard_link_are_refused() {
    let f = Fixture::new("same-file");
    f.seed_wallets();
    let path = f.path("node/wallet.dat");
    assert!(
        restore_files::install(&path, &path, false, &mut || Ok(()), &mut |_, _| Ok(())).is_err()
    );
    fs::remove_file(f.path("source/wallet.dat")).unwrap();
    fs::hard_link(&path, f.path("source/wallet.dat")).unwrap();
    assert!(f.install(&mut |_, _| Ok(())).is_err());
    assert_eq!(fs::read(path).unwrap(), b"SYNTHETIC OLD WALLET - NOT A KEY");
}

#[test]
fn changing_source_or_current_file_during_prepare_is_refused() {
    let f = Fixture::new("source-change");
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "before-replace" {
                fs::write(f.path("source/wallet.dat"), b"SYNTHETIC CHANGED SOURCE")?;
            }
            Ok(())
        })
        .unwrap_err();
    assert!(!error.changed);
    assert_eq!(
        fs::read(f.path("node/wallet.dat")).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
    f.seed_wallets();
    let error = f
        .install(&mut |phase, _| {
            if phase == "before-replace" {
                fs::write(f.path("node/wallet.dat"), b"SYNTHETIC CURRENT EDIT")?;
            }
            Ok(())
        })
        .unwrap_err();
    assert!(!error.changed);
    assert_eq!(
        fs::read(f.path("node/wallet.dat")).unwrap(),
        b"SYNTHETIC CURRENT EDIT"
    );
    assert_eq!(
        fs::read(error.previous.unwrap()).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
}

#[cfg(unix)]
#[test]
fn symlink_source_destination_and_lock_are_refused_without_following_them() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("symlinks");
    f.seed_wallets();
    fs::remove_file(f.path("source/wallet.dat")).unwrap();
    symlink(f.path("node/wallet.dat"), f.path("source/wallet.dat")).unwrap();
    assert!(f.install(&mut |_, _| Ok(())).is_err());
    symlink(f.path("node/wallet.dat"), f.path("node/.lock")).unwrap();
    assert!(restore_lock::DataDirGuard::acquire(&f.path("node")).is_err());
    assert_eq!(
        fs::read(f.path("node/wallet.dat")).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
}

#[cfg(unix)]
#[test]
fn substituted_lock_inode_and_data_directory_are_detected_before_commit() {
    let f = Fixture::new("lock-substitution");
    f.seed_wallets();
    let guard = restore_lock::DataDirGuard::acquire(&f.path("node")).unwrap();
    fs::rename(f.path("node/.lock"), f.path("node/.previous-lock")).unwrap();
    fs::write(f.path("node/.lock"), b"").unwrap();
    assert!(guard.check().is_err());
    drop(guard);
    let guard = restore_lock::DataDirGuard::acquire(&f.path("node")).unwrap();
    let error = restore_files::install(
        &f.path("source/wallet.dat"),
        &f.path("node/wallet.dat"),
        false,
        &mut || guard.check(),
        &mut |phase, _| {
            if phase == "before-replace" {
                fs::rename(f.path("node"), f.path("original-node"))?;
                fs::create_dir(f.path("node"))?;
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(!error.changed);
    assert_eq!(
        fs::read(f.path("original-node/wallet.dat")).unwrap(),
        b"SYNTHETIC OLD WALLET - NOT A KEY"
    );
}

#[test]
fn missing_and_empty_selected_files_are_not_success() {
    let f = Fixture::new("missing");
    assert_eq!(f.apply(&["wallet"], false)["ok"], false);
    assert_eq!(
        f.apply(&["passes"], false)["failed"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::write(f.path("source/wallet.dat"), b"").unwrap();
    assert_eq!(f.apply(&["wallet"], false)["ok"], false);
    assert_eq!(f.apply(&[], false)["ok"], false);
}

#[test]
fn invalid_json_never_overwrites_current_records() {
    let f = Fixture::new("bad-json");
    fs::write(f.path("app/passes.json"), b"{\"passes\":[]}").unwrap();
    fs::write(f.path("source/passes.json"), b"{broken synthetic json").unwrap();
    assert_eq!(f.apply(&["passes"], false)["ok"], false);
    assert_eq!(
        fs::read(f.path("app/passes.json")).unwrap(),
        b"{\"passes\":[]}"
    );
}

#[test]
fn json_writer_at_final_replace_is_preserved_as_actual_previous() {
    let f = Fixture::new("late-writer");
    fs::write(f.path("source/shop.json"), b"{\"synthetic\":\"backup\"}").unwrap();
    fs::write(f.path("app/shop.json"), b"{\"synthetic\":\"before\"}").unwrap();
    let saved = restore_files::install(
        &f.path("source/shop.json"),
        &f.path("app/shop.json"),
        true,
        &mut || Ok(()),
        &mut |phase, _| {
            if phase == "replace" {
                fs::write(
                    f.path("app/shop.json.tmp"),
                    b"{\"synthetic\":\"late writer\"}",
                )?;
                fs::rename(f.path("app/shop.json.tmp"), f.path("app/shop.json"))?;
            }
            Ok(())
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(fs::read(saved).unwrap(), b"{\"synthetic\":\"late writer\"}");
    assert_eq!(
        fs::read(f.path("app/shop.json")).unwrap(),
        b"{\"synthetic\":\"backup\"}"
    );
}

#[test]
fn new_destination_created_at_last_moment_is_never_overwritten() {
    let f = Fixture::new("late-create");
    fs::write(f.path("source/passes.json"), b"{\"synthetic\":\"backup\"}").unwrap();
    let error = restore_files::install(
        &f.path("source/passes.json"),
        &f.path("app/passes.json"),
        true,
        &mut || Ok(()),
        &mut |phase, _| {
            if phase == "replace" {
                fs::write(
                    f.path("app/passes.json"),
                    b"{\"synthetic\":\"new current\"}",
                )?;
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(!error.changed);
    assert_eq!(
        fs::read(f.path("app/passes.json")).unwrap(),
        b"{\"synthetic\":\"new current\"}"
    );
}

#[test]
fn other_app_process_cannot_replace_or_clean_shared_restore_scratch() {
    let f = Fixture::new("app-session");
    let peer = Peer::hold(&f.path("app/.ravenvault-restore.lock"));
    assert!(restore_lock::RestoreSessionGuard::acquire(&f.path("app")).is_err());
    drop(peer);
    let session = restore_lock::RestoreSessionGuard::acquire(&f.path("app")).unwrap();
    session.check().unwrap();
    assert_eq!(Peer::probe(&f.path("app/.ravenvault-restore.lock")), 73);
    // This is a separate inode, so a held app session still allows a node guard.
    let node = restore_lock::DataDirGuard::acquire(&f.path("node")).unwrap();
    assert_eq!(Peer::probe(&f.path("node/.lock")), 73);
    drop(node);
    drop(session);
    assert_eq!(Peer::probe(&f.path("app/.ravenvault-restore.lock")), 0);
}

#[test]
fn backup_listing_hides_stages_and_separates_legacy_invalid_and_verified() {
    let f = Fixture::new("listing");
    for name in [
        ".rv-backup-stage",
        "misc",
        "2026-09-10",
        "2026-09-11",
        "2026-09-12-retry-ab12",
    ] {
        fs::create_dir(f.path(name)).unwrap();
        fs::write(
            f.path(&format!("{name}/wallet.dat")),
            b"SYNTHETIC PRESENCE IS NOT COMPLETENESS",
        )
        .unwrap();
    }
    for name in ["2026-09-11", "2026-09-12-retry-ab12"] {
        fs::write(
            f.path(&format!("{name}/.backup-complete.json")),
            b"{\"synthetic\":true}",
        )
        .unwrap();
    }
    let output = restore_files::backup_list(&f.0, &|path| path.ends_with("2026-09-12-retry-ab12"));
    let rows = output["folders"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["verification"], "complete");
    assert_eq!(rows[1]["verification"], "invalid");
    assert_eq!(rows[2]["verification"], "legacy");
    assert!(rows[2]["wallet"].as_bool().unwrap());
    assert!(!rows[2]["complete"].as_bool().unwrap());
}

#[test]
fn actual_partial_restore_is_never_reported_as_completed_move() {
    let f = Fixture::new("partial");
    f.seed_wallets();
    fs::write(f.path("source/passes.json"), b"{\"passes\":[]}").unwrap();
    let result = f.apply(&["wallet", "passes"], true);
    assert_eq!(result["done"].as_array().unwrap().len(), 1);
    assert_eq!(result["failed"].as_array().unwrap().len(), 1);
    assert_eq!(result["status"], "partial");
    assert_eq!(result["ok"], false);
    assert!(!restore_complete(&result));
    f.old_unchanged();
    assert!(restore_complete(
        &json!({"done":[{"what":"synthetic"}],"failed":[]})
    ));
    assert!(!restore_complete(&json!({"done":[],"failed":[]})));
    assert!(!restore_complete(&json!({"done":[1]})));
}

fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn synthetic_zip_extract_then_restore_preserves_input_archive() {
    let f = Fixture::new("zip-roundtrip");
    zip_fixture(
        &f.path("synthetic.zip"),
        &[(
            "snapshot/passes.json",
            b"{\"passes\":[{\"synthetic\":true}]}",
        )],
    );
    let before = fs::read(f.path("synthetic.zip")).unwrap();
    restore_files::extract_archive(&f.path("synthetic.zip"), &f.path("opened")).unwrap();
    let result = restore_files::apply(
        &f.path("opened"),
        &f.path("app"),
        &f.path("node"),
        &["passes".into()],
        false,
    );
    assert_eq!(result["ok"], true);
    assert_eq!(fs::read(f.path("synthetic.zip")).unwrap(), before);
    assert_eq!(
        fs::read(f.path("app/passes.json")).unwrap(),
        b"{\"passes\":[{\"synthetic\":true}]}"
    );
}

#[test]
fn duplicate_zip_basenames_and_traversal_are_refused() {
    let f = Fixture::new("zip-invalid");
    zip_fixture(
        &f.path("duplicate.zip"),
        &[
            ("one/passes.json", b"{}"),
            ("two/passes.json", b"{\"different\":true}"),
        ],
    );
    assert!(restore_files::extract_archive(&f.path("duplicate.zip"), &f.path("opened")).is_err());
    assert_eq!(fs::read(f.path("opened/passes.json")).unwrap(), b"{}");
    zip_fixture(&f.path("traversal.zip"), &[("../outside.json", b"{}")]);
    assert!(restore_files::extract_archive(&f.path("traversal.zip"), &f.path("opened")).is_err());
    assert!(!f.path("outside.json").exists());
}
