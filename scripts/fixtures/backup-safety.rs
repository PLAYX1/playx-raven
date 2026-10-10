// Appended only to the standalone harness's copy of backup.rs. All paths/RPC
// are synthetic adapters; these tests cannot be compiled into the application.
#[cfg(test)]
mod safety_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn reset(mode: usize) -> PathBuf {
        let root = crate::paths::home();
        assert!(root.starts_with(env!("CARGO_MANIFEST_DIR")));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(app_dir()).unwrap();
        let dest = root.join("selected");
        std::fs::create_dir_all(&dest).unwrap();
        crate::raven::MODE.store(mode, Ordering::SeqCst);
        dest
    }

    fn tree(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p) } else { out.push((p.clone(), std::fs::read(&p).unwrap())) }
            }
        }
        out.sort();
        out
    }

    /// Old-name folders (every name an older app wrote) are never written; new
    /// backups and their receipts go to `RavenVault-Backup` and roundtrip.
    #[tokio::test]
    async fn new_name_backup_roundtrips_and_never_touches_old_name_folders() {
        let dest = reset(1);
        let old_auto = dest.join("PLAYXRaven-Backup").join("RavenVault Desktop 백업");
        std::fs::create_dir_all(&old_auto).unwrap();
        std::fs::write(old_auto.join("PLAYXRaven.zip.pxlock"), b"PXRLOCK1 synthetic old latest").unwrap();
        std::fs::write(old_auto.join("RavenVault-previous.zip.pxlock"), b"PXRLOCK1 synthetic old previous").unwrap();
        for folder_name in ["PLAY X Raven 백업", "RavenVault Desktop 백업", "PLAYXRaven-백업"] {
            std::fs::create_dir_all(dest.join(folder_name)).unwrap();
            std::fs::write(dest.join(folder_name).join("PLAYXRaven.zip.잠김"), b"PXRLOCK1 synthetic oldest").unwrap();
        }
        let old_before: Vec<_> = ["PLAYXRaven-Backup", "PLAY X Raven 백업", "RavenVault Desktop 백업", "PLAYXRaven-백업"]
            .iter().map(|n| tree(&dest.join(n))).collect();
        std::fs::write(app_dir().join("shop.json"), b"{}").unwrap();
        let first = backup_zip(dest.to_string_lossy().into(), "".into(), true).await.unwrap();
        let archive = PathBuf::from(first["path"].as_str().unwrap());
        assert_eq!(archive, dest.join("RavenVault-Backup").join("RavenVault.zip.pxlock"));
        assert!(matching_receipt(&archive).is_some(), "new-name backup must leave a matching receipt");
        let first_bytes = std::fs::read(&archive).unwrap();
        backup_zip(dest.to_string_lossy().into(), "".into(), true).await.unwrap();
        let previous = dest.join("RavenVault-Backup").join("RavenVault-previous.zip.pxlock");
        assert_eq!(std::fs::read(&previous).unwrap(), first_bytes);
        assert!(matching_receipt(&previous).is_some(), "the receipt moves with the rotated file");
        assert!(matching_receipt(&archive).is_some());
        let key = crate::lockbox::key_get_or_make().unwrap();
        let opened = dest.join("synthetic.zip");
        crate::lockbox::unlock_file(&archive, &opened, &key).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(opened).unwrap()).unwrap();
        let mut wallet = Vec::new();
        zip.by_name("wallet.dat").unwrap().read_to_end(&mut wallet).unwrap();
        assert_eq!(wallet, b"synthetic wallet bytes, never a real wallet");
        let old_after: Vec<_> = ["PLAYXRaven-Backup", "PLAY X Raven 백업", "RavenVault Desktop 백업", "PLAYXRaven-백업"]
            .iter().map(|n| tree(&dest.join(n))).collect();
        assert_eq!(old_after, old_before, "old-name backups must stay byte-identical");
    }

    #[tokio::test]
    async fn automatic_backup_writes_new_folder_beside_old_one() {
        let dest = reset(1);
        let old = dest.join("PLAYXRaven-Backup").join("RavenVault Desktop 백업");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("PLAYXRaven.zip.pxlock"), b"PXRLOCK1 synthetic old daily").unwrap();
        std::fs::write(old.join(".PLAYXRaven.zip.pxlock.complete.json"), b"{\"day\":\"2026-10-01\"}").unwrap();
        let before = tree(&dest.join("PLAYXRaven-Backup"));
        let drive = json!({"name":"fixture", "path":dest.to_string_lossy(), "writable":true});
        let result = auto_to(1_789_344_000, vec![drive], vec![]).await;
        assert_eq!(result["outside"][0]["ok"], true, "{result}");
        let latest = dest.join("RavenVault-Backup").join("RavenVault.zip.pxlock");
        assert_eq!(result["outside"][0]["path"], latest.to_string_lossy().as_ref());
        assert_eq!(matching_receipt(&latest).unwrap()["day"], day_name(1_789_344_000));
        assert_eq!(tree(&dest.join("PLAYXRaven-Backup")), before);
    }

    #[tokio::test]
    async fn unreadable_or_invalid_ledger_is_not_silently_omitted() {
        let dest = reset(1);
        std::fs::create_dir(app_dir().join("shop.json")).unwrap();
        assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
        std::fs::remove_dir(app_dir().join("shop.json")).unwrap();
        std::fs::write(app_dir().join("shop.json"), b"{unfinished").unwrap();
        assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
        assert!(!stamp_path().exists());
    }

    #[tokio::test]
    async fn completed_encrypted_backup_roundtrips_and_rotates_the_encrypted_file() {
        let dest = reset(1);
        for (name, path, _) in manifest() { std::fs::write(path, json!({"synthetic": name}).to_string()).unwrap(); }
        let first = backup_zip(dest.to_string_lossy().into(), "".into(), true).await.unwrap();
        assert_eq!(first["wallet_included"], true);
        assert_eq!(first["verified"], true);
        assert_eq!(first["locked"], true);
        // 앱 파일 전부(0.4.5부터 만든 기록 create_history.json 포함) + 지갑 하나
        assert_eq!(first["inside"].as_array().unwrap().len(), manifest().len() + 1);
        assert_eq!(manifest().len(), 10);
        assert!(first["inside"].to_string().contains("create_history.json"));
        let path = PathBuf::from(first["path"].as_str().unwrap());
        let first_bytes = std::fs::read(&path).unwrap();
        assert!(first_bytes.starts_with(b"PXRLOCK1"));
        assert_eq!(first["size"], first_bytes.len() as u64);
        assert!(!path.with_extension("").exists(), "No plaintext ZIP in the sync destination");
        let key = crate::lockbox::key_get_or_make().unwrap();
        let reopened = crate::paths::home().join("synthetic-reopened.zip");
        crate::lockbox::unlock_file(&path, &reopened, &key).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(reopened).unwrap()).unwrap();
        let mut wallet = Vec::new();
        zip.by_name("wallet.dat").unwrap().read_to_end(&mut wallet).unwrap();
        assert_eq!(wallet, b"synthetic wallet bytes, never a real wallet");
        let second = backup_zip(dest.to_string_lossy().into(), "".into(), true).await.unwrap();
        let previous = path.parent().unwrap().join("RavenVault-previous.zip.pxlock");
        assert_eq!(std::fs::read(previous).unwrap(), first_bytes);
        assert_eq!(second["path"], first["path"]);
        assert_ne!(std::fs::read(path).unwrap(), first_bytes);
    }

    #[tokio::test]
    async fn encryption_key_error_does_not_publish_or_stamp() {
        let dest = reset(1);
        std::fs::create_dir(app_dir().join("cloud-backup.key")).unwrap();
        assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
        assert!(!external_backup_dir(&dest).join("RavenVault.zip.pxlock").exists());
        assert!(!stamp_path().exists());
    }

    #[tokio::test]
    async fn shop_only_backup_is_explicit_and_does_not_count_as_wallet_backup() {
        let dest = reset(0);
        std::fs::write(app_dir().join("shop.json"), b"{}").unwrap();
        let result = backup_zip(dest.to_string_lossy().into(), "shop".into(), false).await.unwrap();
        assert_eq!(result["wallet_included"], false);
        assert_eq!(result["inside"].as_array().unwrap().len(), 1);
        assert!(!stamp_path().exists());
    }

    #[tokio::test]
    async fn failed_automatic_backup_retries_and_does_not_prune_good_generations() {
        reset(1);
        let day = 1_789_344_000;
        for i in 0..7 { assert_eq!(auto_to(day + i * 86400, vec![], vec![]).await["local_complete"], true); }
        let root = app_dir().join("backups");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 7);
        crate::raven::MODE.store(0, Ordering::SeqCst);
        assert!(auto_to(day + 7 * 86400, vec![], vec![]).await.get("error").is_some());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 7);
        crate::raven::MODE.store(1, Ordering::SeqCst);
        assert_eq!(auto_to(day + 7 * 86400, vec![], vec![]).await["local_complete"], true);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 7);
        assert!(!root.join(day_name(day)).exists());
    }

    #[tokio::test]
    async fn wallet_file_alone_is_not_a_complete_automatic_backup() {
        reset(1);
        let day = 1_789_344_000;
        let dir = app_dir().join("backups").join(day_name(day));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("wallet.dat"), b"synthetic incomplete old backup").unwrap();
        assert!(!complete_snapshot(&dir));
        assert_eq!(auto_to(day, vec![], vec![]).await["local_complete"], true);
        let completed = complete_day(dir.parent().unwrap(), &day_name(day)).unwrap();
        assert_ne!(completed, dir);
        assert_eq!(std::fs::read(dir.join("wallet.dat")).unwrap(), b"synthetic incomplete old backup");
        std::fs::write(completed.join("wallet.dat"), b"corruption").unwrap();
        assert!(!complete_snapshot(&completed));
        assert_eq!(auto_to(day, vec![], vec![]).await["local_complete"], true);
        assert!(complete_day(dir.parent().unwrap(), &day_name(day)).is_some());
        assert_eq!(std::fs::read(completed.join("wallet.dat")).unwrap(), b"corruption");
    }

    #[tokio::test]
    async fn failed_external_destination_is_not_reported_as_a_copy() {
        reset(1);
        let blocked = crate::paths::home().join("synthetic-unwritable-drive");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let drive = json!({"name":"fixture", "path":blocked.to_string_lossy(), "writable":true});
        let cloud = json!({"name":"fixture", "path":blocked.to_string_lossy()});
        let result = auto_to(1_789_344_000, vec![drive], vec![cloud]).await;
        assert_eq!(result["local_complete"], true);
        assert_eq!(result["outside"][0]["ok"], false);
        assert_eq!(result["cloud"][0]["ok"], false);
        assert!(!result["warning"].as_str().unwrap().is_empty());
        assert!(result["note"].as_str().unwrap().contains("백업만"));
    }

    #[tokio::test]
    async fn concurrent_manual_backup_is_refused_before_any_files_change() {
        let dest = reset(1);
        let _guard = backup_gate().unwrap();
        assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
        assert_eq!(std::fs::read_dir(dest).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn failed_folder_generation_never_mixes_with_previous_generation() {
        let dest = reset(1);
        std::fs::write(app_dir().join("shop.json"), b"{}").unwrap();
        let prepared = prepare_backup(true).await.unwrap();
        let prior = dest.join("prior");
        store_folder(&prepared, &prior).unwrap();
        let prior_wallet = std::fs::read(prior.join("wallet.dat")).unwrap();
        let prior_marker = std::fs::read(prior.join(COMPLETE_FILE)).unwrap();
        std::fs::remove_file(prepared.workspace.path().join("shop.json")).unwrap();
        let next = dest.join("next");
        assert!(store_folder(&prepared, &next).is_err());
        assert!(!next.exists());
        assert_eq!(std::fs::read(prior.join("wallet.dat")).unwrap(), prior_wallet);
        assert_eq!(std::fs::read(prior.join(COMPLETE_FILE)).unwrap(), prior_marker);
        assert!(complete_snapshot(&prior));
    }

    #[tokio::test]
    async fn same_day_external_retry_keeps_yesterdays_generation() {
        let dest = reset(1);
        let prepared = prepare_backup(true).await.unwrap();
        let first = publish_daily(&prepared, &dest, true, "2026-09-13").unwrap();
        let path = PathBuf::from(first["path"].as_str().unwrap());
        let yesterday = std::fs::read(&path).unwrap();
        publish_daily(&prepared, &dest, true, "2026-09-14").unwrap();
        let today = std::fs::read(&path).unwrap();
        let retried = publish_daily(&prepared, &dest, true, "2026-09-14").unwrap();
        assert_eq!(retried["skipped"], true);
        assert_eq!(std::fs::read(&path).unwrap(), today);
        assert_eq!(std::fs::read(path.parent().unwrap().join("RavenVault-previous.zip.pxlock")).unwrap(), yesterday);
    }

    #[tokio::test]
    async fn completed_destinations_do_not_require_a_live_node_on_same_day_retry() {
        let dest = reset(1);
        let drive = json!({"name":"fixture", "path":dest.to_string_lossy(), "writable":true});
        let first = auto_to(1_789_344_000, vec![drive.clone()], vec![]).await;
        assert_eq!(first["outside"][0]["ok"], true);
        crate::raven::MODE.store(0, Ordering::SeqCst);
        let next = auto_to(1_789_344_000, vec![drive], vec![]).await;
        assert!(next.get("error").is_none());
        assert!(next.get("skipped").is_some());
        assert_eq!(next["local_complete"], true);
    }

    #[test]
    fn failure_is_returned_even_if_status_file_cannot_be_written() {
        reset(0);
        std::fs::create_dir(app_dir().join("backup-auto-status.json")).unwrap();
        let result = remember_auto_result(json!({"error":"synthetic backup failed"}));
        assert_eq!(result["error"], "synthetic backup failed");
        assert!(!result["warning"].as_str().unwrap().is_empty());
    }

    #[tokio::test]
    async fn archive_write_or_integrity_failure_is_reported() {
        reset(1);
        let prepared = prepare_backup(true).await.unwrap();
        assert!(write_archive(&prepared, &crate::paths::home()).is_err());
        let archive = prepared.workspace.path().join("synthetic.zip");
        write_archive(&prepared, &archive).unwrap();
        std::fs::write(&archive, b"broken archive").unwrap();
        assert!(verify_archive(&prepared, &archive).is_err());
    }
}
