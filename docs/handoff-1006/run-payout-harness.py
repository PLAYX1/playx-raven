from pathlib import Path
import subprocess
root=Path.cwd(); out=root/'docs/handoff-1006/payout-harness';(out/'src').mkdir(parents=True,exist_ok=True)
def fun(file,name):
 s=Path(file).read_text();start=s.index('pub async fn '+name+'(');end=s.index('\n}\n',start)+3;return s[start:end]
send='\n'.join(fun('src-tauri/src/send.rs',n) for n in ['send_rvn','send_asset'])
fee=fun('src-tauri/src/devfee.rs','fee_pay');sale=fun('src-tauri/src/vending.rs','fulfil_sale')
(out/'Cargo.toml').write_text('[package]\nname="secfix-payout-harness"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="1"\nrand="0.8"\ntokio={version="1",features=["macros","rt-multi-thread"]}\n')
code=r'''
#![allow(dead_code)]
use serde_json::{json,Value};
use std::sync::atomic::{AtomicUsize,AtomicBool,Ordering};
#[path="GUARD_PATH"] mod payout_guard;
static CALLS:AtomicUsize=AtomicUsize::new(0);
static UNKNOWN:AtomicBool=AtomicBool::new(false);
static FAIL_WRITE:AtomicBool=AtomicBool::new(false);
mod paths {pub fn app_file(n:&str)->std::path::PathBuf{std::path::PathBuf::from("FIXTURE_PATH").join(n)}}
mod raven {
 use super::*;
 pub async fn call_rpc(method:&str,_args:Value)->Result<Value,String>{match method{
 "validateaddress"=>Ok(json!({"isvalid":true})),
 "getwalletinfo"=>Ok(json!({"unlocked_until":123})),
 "getreceivedbyaddress"=>Ok(json!(2.0)),
 "gettransaction"=>Ok(json!({"confirmations":2,"details":[{"category":"receive","address":"synthetic-deposit","vout":0,"amount":2.0}]})),
 "sendtoaddress"|"transfer"=>{CALLS.fetch_add(1,Ordering::SeqCst);if UNKNOWN.load(Ordering::SeqCst){Err("synthetic accepted response lost".into())}else if method=="transfer"{Ok(json!(["a".repeat(64)]))}else{Ok(json!("a".repeat(64)))}},
 _=>Err("unexpected synthetic RPC".into())}}
}
mod refund{pub fn remember_ours(_: &str){}}
mod swap{pub const MIN_DEV_FEE:f64=0.0001;}
mod shop{pub fn fee_config()->(f64,String){(0.01,"synthetic-receiver".into())}}
mod send {
 use super::*;use crate::raven::call_rpc;
 pub async fn check_address(_:String)->Result<Value,String>{Ok(json!({"valid":true}))}
 pub(crate) async fn with_unlocked<F,Fut>(_:Option<String>,f:F)->Result<String,String>where F:FnOnce()->Fut,Fut:std::future::Future<Output=Result<String,String>>{f().await}
 SEND_FUNCTIONS
}
mod devfee {
 use super::*;
 static LEDGER_LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
 struct PayGuard;impl PayGuard{fn take()->Option<Self>{Some(Self)}}
 fn round8(n:f64)->f64{(n*1e8).round()/1e8}
 fn looks_like_address(_: &str)->bool{true}
 fn now()->u64{0}
 fn read_checked()->Result<Value,String>{Ok(json!({"owed":2.0,"sent_total":0.0,"history":[]}))}
 fn write(_: &Value)->Result<(),String>{if FAIL_WRITE.load(Ordering::SeqCst){Err("synthetic disk full".into())}else{Ok(())}}
 pub async fn accrue(_: &str,_:f64){}
 FEE_FUNCTION
}
mod vending {use super::*;use crate::raven::call_rpc; SALE_FUNCTION}
fn reset(){let p=paths::app_file("");let _=std::fs::remove_dir_all(p);CALLS.store(0,Ordering::SeqCst);UNKNOWN.store(false,Ordering::SeqCst);FAIL_WRITE.store(false,Ordering::SeqCst);}
#[tokio::test] async fn actual_handlers_fail_closed(){
 reset();UNKNOWN.store(true,Ordering::SeqCst);
 assert!(send::send_rvn("synthetic".into(),1.0,None,None,Some("first".into())).await.is_err());
 assert!(send::send_rvn("synthetic".into(),1.0,None,None,Some("after-restart".into())).await.is_err());
 assert_eq!(CALLS.load(Ordering::SeqCst),1);
 reset();
 assert!(send::send_rvn("synthetic".into(),1.0,None,None,Some("first".into())).await.is_ok());
 assert!(send::send_rvn("synthetic".into(),1.0,None,None,Some("first".into())).await.is_ok());
 assert_eq!(CALLS.load(Ordering::SeqCst),1);
 reset();FAIL_WRITE.store(true,Ordering::SeqCst);
 assert!(devfee::fee_pay().await.is_err());FAIL_WRITE.store(false,Ordering::SeqCst);
 assert!(devfee::fee_pay().await.is_err());assert_eq!(CALLS.load(Ordering::SeqCst),1);
 reset();UNKNOWN.store(true,Ordering::SeqCst);assert!(devfee::fee_pay().await.is_err());assert!(devfee::fee_pay().await.is_err());assert_eq!(CALLS.load(Ordering::SeqCst),1);
 reset();
 assert!(vending::fulfil_sale("SYNTHETIC".into(),1.0,"recipient".into(),None,None,None,None,None).await.is_err());assert_eq!(CALLS.load(Ordering::SeqCst),0);
 for _ in 0..2{assert!(vending::fulfil_sale("SYNTHETIC".into(),1.0,"recipient".into(),None,Some(2.0),Some("synthetic-deposit".into()),Some("b".repeat(64)),Some(0)).await.is_ok());}
 assert_eq!(CALLS.load(Ordering::SeqCst),1);
 assert!(vending::fulfil_sale("SYNTHETIC".into(),1.0,"changed".into(),None,Some(2.0),Some("synthetic-deposit".into()),Some("b".repeat(64)),Some(0)).await.is_err());assert_eq!(CALLS.load(Ordering::SeqCst),1);
 reset();
}
'''.replace('GUARD_PATH',str(root/'src-tauri/src/payout_guard.rs')).replace('FIXTURE_PATH',str(root/'docs/handoff-1006/handler-fixture')).replace('SEND_FUNCTIONS',send).replace('FEE_FUNCTION',fee).replace('SALE_FUNCTION',sale)
(out/'src/lib.rs').write_text(code)
p=subprocess.run(['cargo','test','--offline','--manifest-path',str(out/'Cargo.toml')],capture_output=True,text=True)
# Only status/case count; no assertion values, fixture keys or request data.
lines=[x for x in (p.stdout+p.stderr).splitlines() if 'test result:' in x or x.startswith('error[')]
(root/'docs/handoff-1006/payout-harness-results.txt').write_text('exit='+str(p.returncode)+'\n'+'\n'.join(lines)+'\n')
print('payout harness exit',p.returncode);print('\n'.join(lines))
raise SystemExit(p.returncode)
