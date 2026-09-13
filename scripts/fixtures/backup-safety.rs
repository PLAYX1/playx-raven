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

    #[tokio::test]
    async fn wallet_failure_preserves_both_previous_files_and_completion_time() {
        for mode in [0, 2, 3] {
            let dest = reset(mode);
            let folder = dest.join("PLAY X Raven 백업");
            std::fs::create_dir_all(&folder).unwrap();
            let latest = folder.join("PLAYXRaven.zip.pxlock");
            let previous = folder.join("PLAYXRaven-이전.zip.pxlock");
            std::fs::write(&latest, b"synthetic last complete ciphertext").unwrap();
            std::fs::write(&previous, b"synthetic earlier complete ciphertext").unwrap();
            std::fs::write(stamp_path(), b"previous completion time").unwrap();
            assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
            assert_eq!(std::fs::read(&latest).unwrap(), b"synthetic last complete ciphertext");
            assert_eq!(std::fs::read(&previous).unwrap(), b"synthetic earlier complete ciphertext");
            assert_eq!(std::fs::read(stamp_path()).unwrap(), b"previous completion time");
        }
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
        assert_eq!(first["inside"].as_array().unwrap().len(), 10);
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
        let previous = path.parent().unwrap().join("PLAYXRaven-이전.zip.pxlock");
        assert_eq!(std::fs::read(previous).unwrap(), first_bytes);
        assert_eq!(second["path"], first["path"]);
        assert_ne!(std::fs::read(path).unwrap(), first_bytes);
    }

    #[tokio::test]
    async fn encryption_key_error_does_not_publish_or_stamp() {
        let dest = reset(1);
        std::fs::create_dir(app_dir().join("cloud-backup.key")).unwrap();
        assert!(backup_zip(dest.to_string_lossy().into(), "".into(), true).await.is_err());
        assert!(!dest.join("PLAY X Raven 백업/PLAYXRaven.zip.pxlock").exists());
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
        assert_eq!(std::fs::read(path.parent().unwrap().join("PLAYXRaven-이전.zip.pxlock")).unwrap(), yesterday);
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
