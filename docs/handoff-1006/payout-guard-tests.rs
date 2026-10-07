#[path = "../../src-tauri/src/payout_guard.rs"] mod payout_guard;
use payout_guard::*;
fn root() -> std::path::PathBuf {
 let p=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docs/handoff-1006/guard-test");
 let _=std::fs::remove_dir_all(&p); std::fs::create_dir_all(&p).unwrap(); p
}
#[test] fn lost_response_restart_concurrency_and_write_failures_fail_closed() {
 let p=root(); let pending=begin(&p,"send","order1",b"synthetic intent").unwrap();
 assert!(begin(&p,"send","order2",b"different intent").is_err());
 drop(pending); // crash / lost RPC response: no Drop-based removal
 assert!(begin(&p,"send","order1",b"synthetic intent").is_err());
 std::fs::remove_file(p.join("send.pending")).unwrap(); // isolated operator reconciliation
 let Begin::New(g)=begin(&p,"send","order1",b"synthetic intent").unwrap() else {panic!()};
 g.complete(&"a".repeat(64)).unwrap();
 assert!(matches!(begin(&p,"send","order1",b"synthetic intent"),Ok(Begin::Done(_))));
 assert!(begin(&p,"send","order1",b"changed intent").is_err());
 let Begin::New(g)=begin(&p,"fee","settlement1",b"fee").unwrap() else {panic!()};
 std::fs::create_dir(p.join("fee-settlement1.done")).unwrap();
 assert!(g.complete(&"b".repeat(64)).is_err());
 assert!(begin(&p,"fee","settlement2",b"fee").is_err());
 std::fs::write(p.join("blocked"),b"file").unwrap();
 assert!(begin(&p.join("blocked"),"send","id",b"intent").is_err());
 let target=p.join("atomic.json"); atomic_write(&target,b"old").unwrap();
 atomic_write(&target,b"new").unwrap(); assert_eq!(std::fs::read(&target).unwrap(),b"new");
 #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,0o600); }
 let Begin::New(g)=begin(&p,"ui","confirmed-before-crash",b"ui intent").unwrap() else {panic!()};
 g.complete_waiting_ack(&"c".repeat(64)).unwrap(); drop(g);
 assert!(begin(&p,"ui","new-after-restart",b"ui intent").is_err());
 assert!(matches!(begin(&p,"ui","confirmed-before-crash",b"ui intent"),Ok(Begin::Done(_))));
 assert!(acknowledge(&p,"ui","other-id").is_err());
 acknowledge(&p,"ui","confirmed-before-crash").unwrap();
 acknowledge(&p,"ui","confirmed-before-crash").unwrap();
 assert!(matches!(begin(&p,"ui","next",b"another intent"),Ok(Begin::New(_))));
 std::fs::remove_dir_all(p).unwrap();
}
