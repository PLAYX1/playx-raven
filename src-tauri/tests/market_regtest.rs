//! 0.9.17 릴레이 장터 — **regtest(가짜 사슬) 끝까지 시험.** 메인넷·실제 지갑·공개 릴레이 없음.
//!
//! ## 돌리는 법
//!
//! ```text
//! cd src-tauri
//! cargo test --features regtest-harness --test market_regtest -- --ignored --nocapture
//! # ravend·raven-cli 폴더를 바꾸려면: RV_REGTEST_BIN=~/RavencoinBuilds-4.8.0/macos-arm64 …
//! ```
//!
//! ## 무엇을 띄우나
//!
//! - ravend 두 대(파는 쪽 A·사는 쪽 B, 지갑 하나씩). 임시 폴더 · 임의 포트 · 127.0.0.1 끼리만 연결
//!   (A `-connect=0`, B `-connect=A`). 끝나면 **그 두 노드만** `stop`.
//! - 앱 안 릴레이(`relay::serve`)를 임의 포트에 하나. `RV_HARNESS_RELAY` 로 앱이 **그곳에만** 올리고 읽는다.
//! - 1% 개발비 주소는 메인넷 주소라 regtest 가 안 받는다 → `RV_HARNESS_FEE_ADDRESS` 로 A 지갑의 시험 주소.
//! - 누구로 부르나는 `PLAYX_RAVEN_HOME` 을 바꿔 정한다(그 폴더의 `raven-datadir.txt`·`talkkey.json`).
//!
//! ## 확인하는 것
//!
//! 1. 파는 쪽: swap_make_lot → (채굴) → swap_offer → market_publish_listing(30402 서명·릴레이 저장)
//! 2. 사는 쪽: 둘러보기 체인 확인 통과 → swap_take_listing 미리보기(안 보냄) → 방송 → 채굴 →
//!    산 사람이 자산 1개, 판 사람 pay 주소에 정확히 값, 개발비 1% 출력
//! 3. 위조: 값·pay·동전을 고친 글(다시 서명) → 한국어 이유로 거절 · 서명 깨진 글 거절 · 팔린 뒤 확인 실패
//! 4. 내리기: market_cancel_listing 이 그 동전을 새 내 주소로 옮김 → 옛 반쪽은 완성 불가
//! 5. 암호화 지갑: 내리기에 암호 필요 · 틀린 암호 거절 · 끝나면 다시 잠김

use playx_raven_lib::regtest_harness as h;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const ASSET: &str = "RVTESTGAME";
const PASS: &str = "synthetic-regtest-only-pass";
const SELLER_SK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const BUYER_SK: &str = "2222222222222222222222222222222222222222222222222222222222222222";
/// 0.9.18 폰에서 판매: 데스크탑 연결 열쇠·폰 연결 열쇠(시험 전용 고정값 — 폰은 서명만 흉내 낸다).
const DESK_LINK_SK: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const PHONE_LINK_SK: &str = "4444444444444444444444444444444444444444444444444444444444444444";

fn ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn sell_body(lid: &str, id: &str, amount: &str, price: &str) -> Value {
    let now = ms();
    json!({"v": 1, "linkId": lid, "id": id, "asset": ASSET, "amount": amount, "priceRvn": price, "title": format!("폰에서 판 게임 아이템 {amount}개"),
        "summary": "폰 판매 regtest", "category": "game", "created": now, "expires": now + 600_000})
}

/// 판매 일을 끝(published 등)까지 돌린다. lot 이면 한 블록 캔다. pending_human 이면 거기서 멈춘다.
async fn run_sell(net: &Net, id: &str, until: &[&str]) -> Value {
    for round in 0..12 {
        h::wl_tick(DESK_LINK_SK).await.expect("판매 일 돌리기");
        let j = h::wl_job(id).unwrap();
        let st = j["job"]["status"].as_str().unwrap_or("").to_string();
        println!("  판매 일 {round}: {st} {}", j["job"]["reason"]);
        if until.contains(&st.as_str()) {
            return j;
        }
        assert!(!["refused", "failed", "cancelled"].contains(&st.as_str()) || until.contains(&st.as_str()), "판매 일이 {st} 로 끝났다: {}", j["job"]["reason"]);
        if st == "lot" {
            net.mine(1);
        }
    }
    panic!("판매 일이 {until:?} 에 닿지 않았다");
}

fn sell_result<'a>(j: &'a Value, id: &str, status: &str) -> &'a Value {
    j["results"].as_array().unwrap().iter().find(|r| r["body"]["id"] == id && r["body"]["status"] == status)
        .unwrap_or_else(|| panic!("{id} 의 {status} 결과가 없다: {}", j["results"]))
}

fn bin() -> PathBuf {
    std::env::var("RV_REGTEST_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/Applications/Raven-Qt.app/Contents/MacOS"))
}

struct Node {
    dir: PathBuf,
    home: PathBuf,
    rpc: u16,
    p2p: u16,
    connect: Option<u16>,
}

impl Node {
    fn args(&self) -> Vec<String> {
        vec!["-regtest".into(), format!("-datadir={}", self.dir.display()), format!("-rpcport={}", self.rpc)]
    }
    fn start(&self) {
        let mut a = self.args();
        a.extend(
            [
                "-server", "-listen=1", "-bind=127.0.0.1", "-dnsseed=0", "-discover=0", "-upnp=0",
                "-fallbackfee=0.01", "-printtoconsole=0", "-daemon",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        a.push(format!("-port={}", self.p2p));
        a.push(match self.connect {
            Some(p) => format!("-connect=127.0.0.1:{p}"),
            None => "-connect=0".into(),
        });
        let st = Command::new(bin().join("ravend")).args(&a).status().expect("ravend 실행");
        assert!(st.success(), "ravend 가 뜨지 않음");
        let t = Instant::now();
        while self.try_cli(&["getblockcount"]).is_err() {
            assert!(t.elapsed() < Duration::from_secs(90), "ravend RPC 가 90초 안에 안 열림");
            std::thread::sleep(Duration::from_millis(300));
        }
        // 앱이 이 노드를 보게: 폴더(쿠키) + rpcport.
        let net = self.dir.join("regtest");
        std::fs::write(net.join("raven.conf"), format!("rpcport={}\n", self.rpc)).unwrap();
        std::fs::create_dir_all(&self.home).unwrap();
        std::fs::write(self.home.join("raven-datadir.txt"), net.display().to_string()).unwrap();
    }
    fn try_cli(&self, args: &[&str]) -> Result<Value, String> {
        let mut a = self.args();
        a.extend(args.iter().map(|s| s.to_string()));
        let out = Command::new(bin().join("raven-cli")).args(&a).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return Ok(Value::Null); // gettxout 이 「쓰인 동전」에 답하는 모양
        }
        Ok(serde_json::from_str(&s).unwrap_or(Value::String(s)))
    }
    fn cli(&self, args: &[&str]) -> Value {
        self.try_cli(args).unwrap_or_else(|e| panic!("raven-cli {args:?} 실패: {e}"))
    }
    fn stop(&self) {
        let _ = self.try_cli(&["stop"]);
        let t = Instant::now();
        while self.try_cli(&["getblockcount"]).is_ok() && t.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(300));
        }
        // 잠금 파일이 풀릴 때까지 조금 더.
        std::thread::sleep(Duration::from_millis(1500));
    }
}

struct Net {
    a: Node,
    b: Node,
    root: PathBuf,
    miner: String,
}
impl Drop for Net {
    fn drop(&mut self) {
        self.b.stop();
        self.a.stop();
        if std::env::var("RV_REGTEST_KEEP").is_err() {
            let _ = std::fs::remove_dir_all(&self.root);
        } else {
            eprintln!("자료 남김: {}", self.root.display());
        }
    }
}
impl Net {
    fn height(n: &Node) -> u64 {
        n.cli(&["getblockcount"]).as_u64().unwrap()
    }
    fn sync(&self) {
        let t = Instant::now();
        loop {
            let (ha, hb) = (Self::height(&self.a), Self::height(&self.b));
            if ha == hb && self.a.cli(&["getbestblockhash"]) == self.b.cli(&["getbestblockhash"]) {
                return;
            }
            assert!(t.elapsed() < Duration::from_secs(90), "두 노드가 안 맞춰짐 A={ha} B={hb}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    /// A 의 mempool 에 그 거래가 들어올 때까지 기다린다(B 에서 보낸 것).
    fn wait_mempool(&self, txid: &str) {
        let t = Instant::now();
        loop {
            let m = self.a.cli(&["getrawmempool"]);
            if m.as_array().unwrap().iter().any(|x| x.as_str() == Some(txid)) {
                return;
            }
            assert!(t.elapsed() < Duration::from_secs(60), "거래 {txid} 가 A mempool 에 안 옴");
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    fn mine(&self, n: u32) {
        self.a.cli(&["generatetoaddress", &n.to_string(), &self.miner]);
        self.sync();
    }
}

fn as_actor(n: &Node) {
    std::env::set_var("PLAYX_RAVEN_HOME", &n.home);
}

fn write_key(home: &Path, sk: &str) {
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(home.join("talkkey.json"), json!({ "sk": sk, "from": "random", "path": "" }).to_string()).unwrap();
}

fn tag_set(ev: &Value, name: &str, idx: usize, val: &str) -> Value {
    let mut e = ev.clone();
    for t in e["tags"].as_array_mut().unwrap() {
        if t[0] == name {
            t[idx] = json!(val);
        }
    }
    e
}

fn korean(s: &str) -> bool {
    s.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c))
}

fn expect_err(what: &str, r: Result<impl std::fmt::Debug, String>, needle: &str) -> String {
    match r {
        Ok(v) => panic!("{what}: 실패해야 하는데 통과했다: {v:?}"),
        Err(e) => {
            println!("  ✔ {what} → 거절: {e}");
            assert!(korean(&e), "{what}: 이유가 한국어가 아니다: {e}");
            assert!(e.contains(needle), "{what}: 이유에 「{needle}」 가 없다: {e}");
            e
        }
    }
}

fn find_view<'a>(list: &'a Value, d: &str) -> Option<&'a Value> {
    list.as_array().unwrap().iter().find(|v| v["d"] == d)
}

fn asset_balance(n: &Node, asset: &str) -> f64 {
    n.cli(&["listmyassets", asset]).get(asset).and_then(Value::as_f64).unwrap_or(0.0)
}

fn sats(x: f64) -> i64 {
    (x * 1e8).round() as i64
}

/// 자기가 할 일을 다 해 둔 판매 글 하나(lot → mine → offer → publish). (d, offer, publish 결과)
async fn list_one(net: &Net, price: f64, pass: Option<&str>) -> (String, Value, Value) {
    as_actor(&net.a);
    let lot = h::swap_make_lot(ASSET.into(), 1.0, pass.map(str::to_string)).await.expect("swap_make_lot");
    println!("  묶음: {lot}");
    if lot["already"] != true {
        net.mine(1);
    }
    let offer = h::swap_offer(ASSET.into(), 1.0, price, pass.map(str::to_string)).await.expect("swap_offer");
    let publ = h::market_publish_listing(
        offer["hex"].as_str().unwrap().into(),
        format!("시험 게임 아이템 {price}"),
        "regtest 가짜 사슬 시험 물건".into(),
        "game".into(),
    )
    .await
    .expect("market_publish_listing");
    let d = publ["d"].as_str().unwrap().to_string();
    (d, offer, publ)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "ravend regtest 두 대를 띄운다 — --features regtest-harness --ignored 로만"]
async fn market_listing_end_to_end_on_regtest() {
    let root = std::env::temp_dir().join(format!("rv-market-regtest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let base = 20000 + (std::process::id() % 15000) as u16;
    let mk = |name: &str, rpc: u16, p2p: u16, connect: Option<u16>| Node {
        dir: root.join(format!("node-{name}")),
        home: root.join(format!("home-{name}")),
        rpc,
        p2p,
        connect,
    };
    let a = mk("seller", base, base + 1, None);
    let b = mk("buyer", base + 2, base + 3, Some(base + 1));
    std::fs::create_dir_all(&a.dir).unwrap();
    std::fs::create_dir_all(&b.dir).unwrap();
    a.start();
    b.start();
    write_key(&a.home, SELLER_SK);
    write_key(&b.home, BUYER_SK);
    let miner = a.cli(&["getnewaddress"]).as_str().unwrap().to_string();
    let net = Net { a, b, root: root.clone(), miner };
    println!("노드: {}", net.a.cli(&["getnetworkinfo"])["subversion"]);

    // ── 자산이 켜질 때까지 채굴(regtest BIP9 ≈ 500블록) ──────────────────
    for _ in 0..12 {
        net.a.cli(&["generatetoaddress", "100", &net.miner]);
        let bci = net.a.cli(&["getblockchaininfo"]);
        if bci["bip9_softforks"]["assets"]["status"] == "active" {
            break;
        }
    }
    net.mine(5);
    let buyer_addr = net.b.cli(&["getnewaddress"]).as_str().unwrap().to_string();
    net.a.cli(&["sendtoaddress", &buyer_addr, "2000"]);
    net.a.cli(&["issue", ASSET, "10"]);
    net.mine(2);
    assert_eq!(asset_balance(&net.a, ASSET), 10.0);
    assert!(net.b.cli(&["getbalance"]).as_f64().unwrap() >= 2000.0);

    let relay = h::start_relay().await;
    std::env::set_var("RV_HARNESS_RELAY", &relay);
    let fee_addr = net.a.cli(&["getnewaddress", "dev-fee"]).as_str().unwrap().to_string();
    std::env::set_var("RV_HARNESS_FEE_ADDRESS", &fee_addr);
    let seller_pk = h::pubkey_of(SELLER_SK).unwrap();
    println!("릴레이 {relay} · 개발비 주소 {fee_addr}");

    // ═══ 1. 파는 쪽: 묶음 → 제안 → 글 ═════════════════════════════════
    println!("\n[1] 파는 쪽 올리기");
    let price = 50.0;
    let (d, offer, publ) = list_one(&net, price, None).await;
    println!("  글 {} · d={d}", publ["eventId"]);
    let pay = offer["pay_to"].as_str().unwrap().to_string();
    let lot_txid = offer["txid"].as_str().unwrap().to_string();
    let lot_vout = offer["vout"].as_u64().unwrap();
    assert_eq!(publ["listing"]["check"]["ok"], true);
    let evs = h::listing_events(&seller_pk).await.expect("릴레이 읽기");
    let ev = evs.iter().find(|e| e["tags"].as_array().unwrap().iter().any(|t| t[0] == "d" && t[1] == d.as_str())).expect("릴레이에 글이 있어야 한다").clone();
    assert_eq!(ev["kind"], 30402);
    println!("  릴레이 저장 확인 · 태그 {}", ev["tags"]);

    // ═══ 3a. 위조 (사기 전) ═══════════════════════════════════════════
    println!("\n[3] 위조 글 거절");
    h::check_event(&ev).await.expect("원본 글은 체인 확인을 통과해야 한다");
    println!("  ✔ 원본 글 체인 확인 통과");
    let fake_price = h::resign(SELLER_SK, &tag_set(&ev, "price", 1, "5.00000000")).unwrap();
    expect_err("값을 고친 글", h::check_event(&fake_price).await, "RVN");
    let fake_pay = h::resign(SELLER_SK, &tag_set(&ev, "pay", 1, &buyer_addr)).unwrap();
    expect_err("pay 를 고친 글", h::check_event(&fake_pay).await, "주소");
    let other_vout = if lot_vout == 0 { 1 } else { 0 };
    let fake_op = tag_set(&tag_set(&ev, "outpoint", 2, &other_vout.to_string()), "d", 1, &format!("rvswap:{lot_txid}:{other_vout}"));
    let fake_op = h::resign(SELLER_SK, &fake_op).unwrap();
    expect_err("동전을 고친 글", h::check_event(&fake_op).await, "동전");
    let fake_amt = h::resign(SELLER_SK, &tag_set(&ev, "asset", 2, "5")).unwrap();
    expect_err("수량을 고친 글", h::check_event(&fake_amt).await, "개");
    let unsigned = tag_set(&ev, "price", 1, "5.00000000");
    expect_err("서명 안 맞는 글", h::check_event(&unsigned).await, "서명");
    as_actor(&net.b);
    expect_err("사기: 값을 고친 글(서명 맞음)", h::swap_take_listing(fake_price.clone(), false, None).await, "RVN");
    expect_err("사기: 서명 안 맞는 글", h::swap_take_listing(unsigned.clone(), false, None).await, "서명");

    // ═══ 2. 사는 쪽 ═══════════════════════════════════════════════════
    println!("\n[2] 사는 쪽");
    as_actor(&net.b);
    let browse = h::market_browse(None).await.expect("둘러보기");
    let view = find_view(&browse, &d).expect("둘러보기에 물건이 있어야 한다").clone();
    println!("  둘러보기: check={} mine={}", view["check"], view["mine"]);
    assert_eq!(view["check"]["ok"], true, "체인 확인이 통과해야 한다");
    assert_eq!(view["mine"], false);
    let mut fake_view = view.clone();
    fake_view["priceRvn"] = json!(5.0);
    expect_err("사기: 화면 값을 고친 view", h::swap_take_listing(fake_view, false, None).await, "RVN");
    // 파는 사람 자신은 못 산다.
    as_actor(&net.a);
    expect_err("파는 사람이 자기 물건 사기", h::swap_take_listing(ev.clone(), false, None).await, "내가 올린");
    as_actor(&net.b);

    let pre = h::swap_take_listing(view.clone(), false, None).await.expect("미리보기");
    assert_eq!(pre["sent"], false);
    let pre_hex = pre["take"]["hex"].as_str().unwrap().to_string();
    let dec = net.b.cli(&["decoderawtransaction", &pre_hex]);
    let vout = dec["vout"].as_array().unwrap();
    assert_eq!(sats(vout[0]["value"].as_f64().unwrap()), sats(price), "0번 출력 = 값");
    assert_eq!(vout[0]["scriptPubKey"]["addresses"][0], pay.as_str(), "0번 출력 = pay 주소");
    let fee_out: Vec<&Value> = vout.iter().filter(|o| o["scriptPubKey"]["addresses"][0] == fee_addr.as_str()).collect();
    assert_eq!(fee_out.len(), 1, "개발비 출력 하나");
    assert_eq!(sats(fee_out[0]["value"].as_f64().unwrap()), sats(price * 0.01), "개발비 1%");
    println!("  미리보기: 출력 {} 개 · 0번 {} RVN → {pay} · 개발비 {} RVN", vout.len(), vout[0]["value"], fee_out[0]["value"]);
    assert!(!net.a.cli(&["gettxout", &lot_txid, &lot_vout.to_string()]).is_null(), "미리보기는 안 보냈어야 한다");

    let seller_recv_before = net.a.cli(&["getreceivedbyaddress", &pay, "0"]).as_f64().unwrap();
    let buy = h::swap_take_listing(view.clone(), true, None).await.expect("사기(방송)");
    assert_eq!(buy["sent"], true);
    let buy_txid = buy["txid"].as_str().unwrap().to_string();
    println!("  산 거래 {buy_txid}");
    net.wait_mempool(&buy_txid);
    net.mine(1);
    assert_eq!(asset_balance(&net.b, ASSET), 1.0, "산 사람이 자산 1개");
    let seller_recv = net.a.cli(&["getreceivedbyaddress", &pay, "1"]).as_f64().unwrap();
    assert_eq!(sats(seller_recv - seller_recv_before), sats(price), "판 사람이 정확히 값을 받음");
    assert_eq!(sats(net.a.cli(&["getreceivedbyaddress", &fee_addr, "1"]).as_f64().unwrap()), sats(price * 0.01), "개발비 주소 1%");
    let raw = net.b.cli(&["gettransaction", &buy_txid])["hex"].as_str().unwrap().to_string();
    let bdec = net.b.cli(&["decoderawtransaction", &raw]);
    assert_eq!(bdec["vin"][0]["txid"], lot_txid.as_str());
    println!("  ✔ 산 사람 {ASSET}=1 · 판 사람 +{seller_recv} RVN · 개발비 +{} RVN", price * 0.01);
    assert_eq!(asset_balance(&net.a, ASSET), 9.0);

    // ═══ 3b. 팔린 뒤 ═══════════════════════════════════════════════════
    expect_err("팔린 뒤 원본 글 확인", h::check_event(&ev).await, "이미 팔렸거나");
    let browse2 = h::market_browse(None).await.unwrap();
    let v2 = find_view(&browse2, &d).expect("팔린 물건도 흐리게 돌려준다");
    assert_eq!(v2["check"]["ok"], false);
    println!("  ✔ 팔린 뒤 둘러보기 check={}", v2["check"]);
    expect_err("팔린 뒤 다시 사기", h::swap_take_listing(view.clone(), false, None).await, "이미 팔렸거나");

    // ═══ 4. 내리기 ═════════════════════════════════════════════════════
    println!("\n[4] 내리기");
    let (d2, offer2, _) = list_one(&net, 30.0, None).await;
    let hex2 = offer2["hex"].as_str().unwrap().to_string();
    let (t2, v2n) = (offer2["txid"].as_str().unwrap().to_string(), offer2["vout"].as_u64().unwrap());
    as_actor(&net.b);
    let pre2 = h::swap_take(hex2.clone(), false, None).await.expect("내리기 전 미리보기 완성본");
    let pre2_hex = pre2["hex"].as_str().unwrap().to_string();
    as_actor(&net.a);
    let c = h::market_cancel_listing(d2.clone(), None).await.expect("내리기");
    println!("  내리기 결과 {c}");
    assert_eq!(c["alreadySpent"], false);
    assert!(c["warn"].is_null(), "경고 없이 끝나야 한다: {}", c["warn"]);
    let ctx = c["txid"].as_str().unwrap().to_string();
    net.mine(1);
    let ctx_info = net.a.cli(&["gettransaction", &ctx]);
    println!("  내리기 거래 확인 수 {} · 옛 동전 {t2}:{v2n}", ctx_info["confirmations"]);
    assert!(net.a.cli(&["gettxout", &t2, &v2n.to_string()]).is_null(), "옛 동전이 쓰였어야 한다");
    let outs = net.a.cli(&["listmyassets", ASSET, "true"])[ASSET]["outpoints"].clone();
    let moved = outs.as_array().unwrap().iter().find(|o| o["txid"] == ctx.as_str()).expect("옮긴 묶음이 내 지갑에");
    assert_eq!(moved["amount"].as_f64(), Some(1.0), "딱 그 수량");
    assert_eq!(asset_balance(&net.a, ASSET), 9.0, "자산이 하나도 안 샘");
    let cdec = net.a.cli(&["decoderawtransaction", net.a.cli(&["gettransaction", &ctx])["hex"].as_str().unwrap()]);
    for o in cdec["vout"].as_array().unwrap() {
        let addr = o["scriptPubKey"]["addresses"][0].as_str().unwrap();
        assert_eq!(net.a.cli(&["validateaddress", addr])["ismine"], true, "내리기 출력은 전부 내 주소");
    }
    as_actor(&net.b);
    expect_err("내린 뒤 옛 반쪽 swap_take", h::swap_take(hex2.clone(), false, None).await, "이미 팔렸거나");
    let r = net.b.try_cli(&["sendrawtransaction", &pre2_hex]);
    assert!(r.is_err(), "내리기 전에 만든 완성본도 못 보낸다");
    println!("  ✔ 내리기 전 완성본 방송 거절: {}", r.unwrap_err());
    let b3 = h::market_browse(None).await.unwrap();
    assert!(find_view(&b3, &d2).is_none(), "내린 물건은 둘러보기에 없다");
    as_actor(&net.a);
    let mine = h::market_my_listings().await.unwrap();
    let m2 = find_view(&mine, &d2).expect("내 목록에 남는다");
    assert_eq!(m2["status"], "cancelled");
    let m1 = find_view(&mine, &d).expect("팔린 것도 내 목록에");
    println!("  ✔ 내 목록: 내린 것 status={} · 팔린 것 status={} check={}", m2["status"], m1["status"], m1["check"]);

    // ═══ 6. 폰에서 판매(0.9.18) ═══════════════════════════════════════
    println!("\n[6] 폰에서 판매");
    as_actor(&net.a);
    let (lid, desk_key) = h::wl_link_phone(DESK_LINK_SK, PHONE_LINK_SK, 3).expect("시험 폰 연결");
    let before = asset_balance(&net.a, ASSET);
    // 6a. 2개를 40 RVN 에: 딱 맞는 묶음이 없어 새로 만든다 → 1블록 → 제안 → 글.
    let sid = "61".repeat(32);
    let s1 = h::wl_phone_sign(PHONE_LINK_SK, "sell", sell_body(&lid, &sid, "2", "40.00000000")).unwrap();
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "sell", &s1).unwrap();
    let j = run_sell(&net, &sid, &["published"]).await;
    let pd = j["job"]["d"].as_str().unwrap().to_string();
    let (pt, pv) = (j["job"]["outpoint"][0].as_str().unwrap().to_string(), j["job"]["outpoint"][1].as_u64().unwrap());
    let r = sell_result(&j, &sid, "published");
    assert!(h::wl_verify("sellresult", r, &desk_key), "판매 결과는 데스크탑 연결 열쇠 서명");
    assert_eq!(r["body"]["d"], pd.as_str());
    println!("  ✔ 폰 판매 글 {pd} · 결과 {}", r["body"]);
    let evs = h::listing_events(&seller_pk).await.unwrap();
    let pev = evs.iter().filter(|e| e["tags"].as_array().unwrap().iter().any(|t| t[0] == "d" && t[1] == pd.as_str())).max_by_key(|e| e["created_at"].as_i64()).unwrap().clone();
    h::check_event(&pev).await.expect("폰이 올린 글도 사는 쪽 체인 확인을 통과");
    // 같은 「팔아 줘」가 또 와도 다시 하지 않는다.
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "sell", &s1).unwrap();
    assert_eq!(h::wl_job(&sid).unwrap()["job"]["status"], "published");
    // 주인 토큰은 거절.
    let own = "62".repeat(32);
    let mut ob = sell_body(&lid, &own, "1", "10.00000000");
    ob["asset"] = json!(format!("{ASSET}!"));
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "sell", &h::wl_phone_sign(PHONE_LINK_SK, "sell", ob).unwrap()).unwrap();
    assert_eq!(h::wl_job(&own).unwrap()["job"]["reason"], "owner-token");
    // 6b. 사는 쪽이 산다 → 팔렸음(파는 쪽이 저절로, 글만).
    as_actor(&net.b);
    let browse = h::market_browse(None).await.unwrap();
    let pview = find_view(&browse, &pd).expect("폰 판매 글이 둘러보기에").clone();
    assert_eq!(pview["check"]["ok"], true);
    let bought = h::swap_take_listing(pview, true, None).await.expect("폰 판매 글 사기");
    net.wait_mempool(bought["txid"].as_str().unwrap());
    net.mine(1);
    as_actor(&net.a);
    assert!(net.a.cli(&["gettxout", &pt, &pv.to_string()]).is_null());
    h::wl_recheck_now(&sid).unwrap();
    let j = run_sell(&net, &sid, &["sold"]).await;
    assert!(h::wl_verify("sellresult", sell_result(&j, &sid, "sold"), &desk_key));
    let mine = h::market_my_listings().await.unwrap();
    assert_eq!(find_view(&mine, &pd).unwrap()["status"], "sold", "내 판매 글에 팔렸음");
    assert_eq!(asset_balance(&net.a, ASSET), before - 2.0);
    println!("  ✔ 팔렸음 글·폰 결과 sold");
    // 6c. 폰의 내리기.
    let sid2 = "63".repeat(32);
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "sell", &h::wl_phone_sign(PHONE_LINK_SK, "sell", sell_body(&lid, &sid2, "1", "30.00000000")).unwrap()).unwrap();
    let j2 = run_sell(&net, &sid2, &["published"]).await;
    let d2p = j2["job"]["d"].as_str().unwrap().to_string();
    let (t2p, v2p) = (j2["job"]["outpoint"][0].as_str().unwrap().to_string(), j2["job"]["outpoint"][1].as_u64().unwrap());
    let uid = "64".repeat(32);
    let now = ms();
    let un = h::wl_phone_sign(PHONE_LINK_SK, "unsell", json!({"v": 1, "linkId": lid, "id": uid, "d": d2p, "created": now, "expires": now + 600_000})).unwrap();
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "unsell", &un).unwrap();
    let j2 = run_sell(&net, &sid2, &["cancelled"]).await;
    assert!(h::wl_verify("sellresult", sell_result(&j2, &uid, "cancelled"), &desk_key));
    net.mine(1);
    assert!(net.a.cli(&["gettxout", &t2p, &v2p.to_string()]).is_null(), "내린 동전은 옮겨졌다");
    assert_eq!(asset_balance(&net.a, ASSET), before - 2.0, "자산이 하나도 안 샘");
    println!("  ✔ 폰 내리기 → 동전 옮김·결과 cancelled");

    // ═══ 5. 암호화 지갑 ═══════════════════════════════════════════════
    println!("\n[5] 암호화 지갑");
    let _ = net.a.try_cli(&["encryptwallet", PASS]);
    net.a.stop();
    net.a.start();
    let _ = net.b.try_cli(&["addnode", &format!("127.0.0.1:{}", net.a.p2p), "onetry"]);
    net.sync();
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "잠겨 있어야 한다");
    as_actor(&net.a);
    expect_err("잠긴 지갑 swap_offer 암호 없이", h::swap_offer(ASSET.into(), 1.0, 20.0, None).await, "암호");
    let (d3, offer3, _) = list_one(&net, 20.0, Some(PASS)).await;
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "제안 뒤 다시 잠김");
    let (t3, v3) = (offer3["txid"].as_str().unwrap().to_string(), offer3["vout"].as_u64().unwrap());
    expect_err("잠긴 지갑 내리기 암호 없이", h::market_cancel_listing(d3.clone(), None).await, "암호");
    let wrong = h::market_cancel_listing(d3.clone(), Some("wrong-pass".into())).await;
    assert!(wrong.is_err(), "틀린 암호는 거절");
    println!("  ✔ 틀린 암호 거절: {}", wrong.unwrap_err());
    assert!(!net.a.cli(&["gettxout", &t3, &v3.to_string()]).is_null(), "실패한 내리기는 동전을 안 건드림");
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "실패 뒤에도 잠김");
    let c3 = h::market_cancel_listing(d3.clone(), Some(PASS.into())).await.expect("암호로 내리기");
    println!("  내리기 결과 {c3}");
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "내리기 뒤 다시 잠김");
    net.mine(1);
    assert!(net.a.cli(&["gettxout", &t3, &v3.to_string()]).is_null());
    assert_eq!(asset_balance(&net.a, ASSET), 7.0);
    // ═══ 5b. 잠긴 지갑의 폰 판매: 사람 대기 → 암호로 이어 가기(두 번: 묶음·제안) ═══
    println!("\n[5b] 잠긴 지갑 폰 판매");
    let sid3 = "65".repeat(32);
    h::wl_deliver(DESK_LINK_SK, PHONE_LINK_SK, "sell", &h::wl_phone_sign(PHONE_LINK_SK, "sell", sell_body(&lid, &sid3, "3", "20.00000000")).unwrap()).unwrap();
    let j3 = run_sell(&net, &sid3, &["pending_human"]).await;
    assert_eq!(j3["job"]["resume"], "queued");
    assert!(h::wl_verify("sellresult", sell_result(&j3, &sid3, "pending_human"), &desk_key));
    assert!(h::wl_continue(DESK_LINK_SK, &sid3, "wrong-pass").await.is_err(), "틀린 암호");
    assert_eq!(h::wl_job(&sid3).unwrap()["job"]["status"], "pending_human");
    h::wl_continue(DESK_LINK_SK, &sid3, PASS).await.expect("암호로 묶음 만들기");
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "다시 잠김");
    net.mine(1);
    let j3 = run_sell(&net, &sid3, &["pending_human", "published"]).await;
    if j3["job"]["status"] == "pending_human" {
        assert_eq!(j3["job"]["resume"], "lot_ready");
        h::wl_continue(DESK_LINK_SK, &sid3, PASS).await.expect("암호로 제안 서명");
    }
    assert_eq!(h::wl_job(&sid3).unwrap()["job"]["status"], "published");
    assert_eq!(net.a.cli(&["getwalletinfo"])["unlocked_until"], 0, "다시 잠김");
    let state = std::fs::read_to_string(net.a.home.join("wallet-link/state.json")).unwrap();
    assert!(!state.contains(PASS), "암호는 기록에 없다");
    println!("  ✔ 잠긴 지갑: 사람 대기 → 암호 → 올림 · 다시 잠김");
    println!("\n모두 통과");
}
