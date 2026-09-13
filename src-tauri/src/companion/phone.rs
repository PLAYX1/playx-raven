//! No keys or wallet RPC. Parsing/review cannot call the relay action.
use super::*;

const BAD: &str =
    "거래 코드의 형식·버전·길이를 확인하세요. 폰에서 서명한 거래 코드를 다시 복사하세요.";
const NODE: &str = "노드에 연결하지 못했습니다. 이 컴퓨터에서 노드 상태를 확인하세요.";
const MAINNET: &str = "메인넷 노드와 메인넷 받는 주소만 사용할 수 있습니다.";
struct Signed {
    hex: String,
    inputs: Vec<(String, u32)>,
    outputs: Vec<(u64, Vec<u8>)>,
}
// The web parser allows compact script lengths up to the overall 100 KB cap.
fn compact(r: &mut Reader<'_>) -> Result<usize, &'static str> {
    let mark = r.take(1).map_err(|_| BAD)?[0];
    let n = match mark {
        0..=252 => mark as usize,
        253 => u16::from_le_bytes(r.take(2).map_err(|_| BAD)?.try_into().unwrap()) as usize,
        254 => u32::from_le_bytes(r.take(4).map_err(|_| BAD)?.try_into().unwrap()) as usize,
        _ => return Err(BAD),
    };
    if (mark == 253 && n < 253) || (mark == 254 && n <= 65535) || n > 100_000 {
        return Err(BAD);
    }
    Ok(n)
}
fn parse(code: &str) -> Result<Signed, &'static str> {
    if code.len() > 200_100 {
        return Err(BAD);
    }
    let url = reqwest::Url::parse(code.trim()).map_err(|_| BAD)?;
    let pairs: Vec<_> = url.query_pairs().collect();
    if url.scheme() != "ravenvault"
        || url.host_str() != Some("transaction")
        || !url.path().is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || pairs.len() != 2
        || pairs.iter().filter(|(k, v)| k == "v" && v == "1").count() != 1
        || pairs.iter().filter(|(k, _)| k == "hex").count() != 1
    {
        return Err(BAD);
    }
    let raw = pairs
        .iter()
        .find(|(k, _)| k == "hex")
        .unwrap()
        .1
        .to_lowercase();
    if raw.is_empty() || raw.len() > 200_000 || raw.len() % 2 != 0 {
        return Err(BAD);
    }
    let bytes = hex::decode(&raw).map_err(|_| BAD)?;
    let mut r = Reader {
        bytes: &bytes,
        at: 0,
    };
    let version = u32::from_le_bytes(r.take(4).map_err(|_| BAD)?.try_into().unwrap());
    if version != 1 && version != 2 {
        return Err(BAD);
    }
    let count = compact(&mut r)?;
    if !(1..=1000).contains(&count) {
        return Err(BAD);
    }
    let mut inputs = Vec::new();
    let mut unique = HashSet::new();
    for _ in 0..count {
        let mut hash = r.take(32).map_err(|_| BAD)?.to_vec();
        hash.reverse();
        let vout = u32::from_le_bytes(r.take(4).map_err(|_| BAD)?.try_into().unwrap());
        let size = compact(&mut r)?;
        if size == 0 {
            return Err(BAD);
        }
        r.take(size).map_err(|_| BAD)?;
        r.take(4).map_err(|_| BAD)?;
        let input = (hex::encode(hash), vout);
        if !unique.insert(input.clone()) {
            return Err(BAD);
        }
        inputs.push(input);
    }
    let count = compact(&mut r)?;
    if !(1..=1000).contains(&count) {
        return Err(BAD);
    }
    let mut out = Vec::new();
    for _ in 0..count {
        let sats = u64::from_le_bytes(r.take(8).map_err(|_| BAD)?.try_into().unwrap());
        if sats > MAX_SAFE {
            return Err(BAD);
        }
        let size = compact(&mut r)?;
        out.push((sats, r.take(size).map_err(|_| BAD)?.to_vec()));
    }
    r.take(4).map_err(|_| BAD)?;
    if r.at != bytes.len() {
        return Err(BAD);
    }
    Ok(Signed {
        hex: raw,
        inputs,
        outputs: out,
    })
}
fn main_address(s: &str) -> bool {
    (26..=35).contains(&s.len())
        && crate::electrum::base58check(s)
            .is_ok_and(|v| v.len() == 21 && [0x3c, 0x7a].contains(&v[0]))
}
fn amount(sats: u64) -> String {
    format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000)
}
// Preserve all eight decimals even for asset quantities above JS's safe integer range.
fn displayed_asset(script: &[u8]) -> Result<Option<Value>, &'static str> {
    if script.len() == 23 && script[..2] == [0xa9, 0x14] && script[22] == 0x87 {
        return Ok(None);
    }
    let Some((name, _)) = script_asset(script)? else {
        return Ok(None);
    };
    let body_at = if script[26] == 0x4c { 28 } else { 27 };
    let body = &script[body_at..script.len() - 1];
    let units = if &body[..4] == b"rvno" {
        100_000_000
    } else {
        let at = 5 + name.len();
        u64::from_le_bytes(body[at..at + 8].try_into().unwrap())
    };
    Ok(Some(json!({"name":name,"quantity":amount(units)})))
}
pub(super) fn relay_error(e: &crate::raven::RpcFailure) -> &'static str {
    if e.message.contains("txn-already-in-mempool") || e.message.contains("already in block chain")
    {
        return "이미 네트워크에 알려진 거래입니다. 거래 ID로 확인하세요.";
    }
    match e.code {
        Some(-27) => "이미 네트워크에 알려진 거래입니다. 거래 ID로 확인하세요.",
        Some(-25) => {
            "입력을 찾을 수 없습니다. 이미 사용했거나 아직 노드가 확인하지 못한 입력입니다."
        }
        Some(-26) => "노드가 거래를 거부했습니다. 서명·잔액·수수료를 폰에서 다시 확인하세요.",
        Some(-22) => BAD,
        _ => "전파 결과를 확인 못 했습니다. 다시 보내기 전에 거래 ID로 확인하세요.",
    }
}
async fn review(r: &impl ChainRpc, code: &str) -> Answer {
    let signed = parse(code)?;
    let expected = txid(&signed.hex).map_err(|_| BAD)?;
    let info = r
        .call("getblockchaininfo", json!([]))
        .await
        .map_err(|_| NODE)?;
    if info["chain"] != "main" {
        return Err(MAINNET);
    }
    if info["initialblockdownload"] != false {
        return Err("노드가 동기화 중입니다. 완료한 뒤 다시 확인하세요.");
    }
    let decoded = r
        .call("decoderawtransaction", json!([signed.hex]))
        .await
        .map_err(|_| BAD)?;
    let rows = decoded["vout"].as_array().ok_or(BAD)?;
    if decoded["txid"] != expected || rows.len() != signed.outputs.len() {
        return Err(BAD);
    }
    let mut outputs = Vec::new();
    for (n, (sats, script)) in signed.outputs.iter().enumerate() {
        let row = &rows[n]["scriptPubKey"];
        if row["hex"] != hex::encode(script) {
            return Err(BAD);
        }
        let addresses = row["addresses"].as_array().cloned().unwrap_or_default();
        if addresses
            .iter()
            .any(|a| !a.as_str().is_some_and(main_address))
        {
            return Err(MAINNET);
        }
        // The node decodes address scripts; raw bytes supply amounts. Asset
        // payload parsing is reused from the companion's previous-output proof.
        let asset = displayed_asset(script);
        outputs.push(json!({"index":n,"addresses":addresses,"rvn":amount(*sats),
            "assetKnown":asset.is_ok(),"asset":asset.ok().flatten()}));
    }
    match r.call("getrawtransaction", json!([expected, true])).await {
        Ok(v) if !v.is_null() => {
            return Err("이미 네트워크에 알려진 거래입니다. 거래 ID로 확인하세요.")
        }
        Err(e) if e.code != Some(-5) => return Err(NODE),
        _ => (),
    }
    // Optional fee: bounded read-only UTXO lookups; an unavailable/spent input
    // is unknown, not a zero fee or proof that a transaction is fake.
    let fee = tokio::time::timeout(std::time::Duration::from_secs(3), fee(r, &signed))
        .await
        .ok()
        .flatten();
    Ok(json!({"hex":signed.hex,"txid":expected,"outputs":outputs,"fee":fee}))
}
async fn fee(r: &impl ChainRpc, signed: &Signed) -> Option<String> {
    if signed.inputs.len() > 20 {
        return None;
    }
    let mut total = 0u64;
    for (hash, n) in &signed.inputs {
        let out = r.call("gettxout", json!([hash, n, true])).await.ok()?;
        let value = out["value"].as_f64()? * 100_000_000.0;
        if !value.is_finite()
            || value < 0.0
            || value > MAX_SAFE as f64
            || (value - value.round()).abs() > 0.01
        {
            return None;
        }
        total = total.checked_add(value.round() as u64)?;
    }
    let spent = signed
        .outputs
        .iter()
        .try_fold(0u64, |sum, (n, _)| sum.checked_add(*n))?;
    total.checked_sub(spent).map(amount)
}
async fn send(r: &impl ChainRpc, code: &str, expected: &str, confirmed: bool) -> Answer {
    if !confirmed {
        return Err("거래 내용을 확인한 뒤 보내기 단추를 눌러 주세요.");
    }
    let signed = parse(code)?;
    if txid(&signed.hex).map_err(|_| BAD)? != expected {
        return Err(BAD);
    }
    broadcast(r, &signed.hex).await
}
pub(crate) async fn phone_transaction_review(code: String) -> Result<Value, String> {
    tokio::time::timeout(std::time::Duration::from_secs(18), review(&Local, &code))
        .await
        .map_err(|_| NODE.to_string())?
        .map_err(str::to_string)
}
pub(crate) async fn phone_transaction_send(
    code: String,
    expected_txid: String,
    confirmed: bool,
) -> Result<Value, String> {
    send(&Local, &code, &expected_txid, confirmed)
        .await
        .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};
    type Row = (&'static str, Value, Result<Value, crate::raven::RpcFailure>);
    struct Fake(Mutex<VecDeque<Row>>);
    impl Fake {
        fn new(rows: Vec<Row>) -> Self {
            Self(Mutex::new(rows.into()))
        }
        fn done(&self) {
            assert!(self.0.lock().unwrap().is_empty());
        }
    }
    impl ChainRpc for Fake {
        fn call<'a>(&'a self, method: &'a str, args: Value) -> RpcFuture<'a> {
            Box::pin(async move {
                let (m, a, v) = self
                    .0
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("Unexpected RPC: never contact a real node");
                assert_eq!(m, method);
                assert_eq!(a, args);
                v
            })
        }
    }
    fn raw() -> String {
        include_str!("phone-fixture.hex").trim().to_string()
    }
    fn code() -> String {
        format!("ravenvault://transaction?v=1&hex={}", raw())
    }
    fn chain() -> Value {
        json!({"chain":"main","initialblockdownload":false,"blocks":1000,"bestblockhash":"a".repeat(64)})
    }
    fn decoded() -> Value {
        let signed = parse(&code()).unwrap();
        json!({"txid":txid(&raw()).unwrap(),"vout":signed.outputs.iter().map(|(_,s)|json!({"scriptPubKey":{"hex":hex::encode(s),"addresses":[base58_address(&s[3..23])]}})).collect::<Vec<_>>()})
    }
    fn review_rows() -> Vec<Row> {
        vec![
            ("getblockchaininfo", json!([]), Ok(chain())),
            ("decoderawtransaction", json!([raw()]), Ok(decoded())),
            (
                "getrawtransaction",
                json!([txid(&raw()).unwrap(), true]),
                Err(crate::raven::RpcFailure {
                    code: Some(-5),
                    message: "Synthetic unknown transaction".into(),
                }),
            ),
            (
                "gettxout",
                json!(["11".repeat(32), 3, true]),
                Ok(json!({"value":0.01})),
            ),
        ]
    }
    #[test]
    fn phone_parser_accepts_web_fixture_and_rejects_corruption_versions_sizes() {
        let parsed = parse(&code()).unwrap();
        assert_eq!(parsed.inputs, vec![("11".repeat(32), 3)]);
        assert_eq!(
            parsed.outputs.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            vec![500000, 490000]
        );
        for bad in [
            code().replace("hex=0", "hex=g"),
            code().replace("v=1", "v=2"),
            code() + "&hex=00",
            code() + "&network=test",
            code().replace("transaction?", "transaction/?"),
            code().replace("transaction?", "transaction.evil?"),
            format!("{}00", code()),
            code()[..code().len() - 2].to_string(),
            format!("ravenvault://transaction?v=1&hex={}", "00".repeat(100001)),
        ] {
            assert!(parse(&bad).is_err());
        }
        let mut bad = raw();
        bad.replace_range(0..2, "03");
        assert!(parse(&format!("ravenvault://transaction?v=1&hex={bad}")).is_err());
        let p2pkh = base58_address(&[42; 20]);
        assert!(main_address(&p2pkh));
        assert!(!main_address(&(p2pkh + "0")));
        assert!(!main_address("1111111111111111111114oLvT2"));
        // Mainnet P2SH (0x7a), independently checksum encoded for this test.
        fn addr(version: u8) -> String {
            let mut b = vec![version];
            b.extend([42; 20]);
            let hash = Sha256::digest(Sha256::digest(&b));
            b.extend(&hash[..4]);
            let mut digits = vec![0u8];
            for byte in b {
                let mut carry = byte as u32;
                for d in &mut digits {
                    carry += *d as u32 * 256;
                    *d = (carry % 58) as u8;
                    carry /= 58;
                }
                while carry > 0 {
                    digits.push((carry % 58) as u8);
                    carry /= 58;
                }
            }
            digits
                .iter()
                .rev()
                .map(|n| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[*n as usize]
                        as char
                })
                .collect()
        }
        assert!(main_address(&addr(0x7a)));
        assert!(!main_address(&addr(0x6f)));
        assert!(!main_address(&addr(0xc4)));
    }
    #[tokio::test]
    async fn phone_review_never_broadcasts_and_requires_explicit_confirmation() {
        let f = Fake::new(review_rows());
        let v = review(&f, &code()).await.unwrap();
        f.done();
        assert_eq!(v["fee"], "0.00010000");
        assert_eq!(v["outputs"][0]["rvn"], "0.00500000");
        assert_eq!(v["outputs"][1]["rvn"], "0.00490000");
        let f = Fake::new(vec![]);
        assert!(send(&f, &code(), v["txid"].as_str().unwrap(), false)
            .await
            .is_err());
        f.done();
        assert!(send(&f, &code(), &"a".repeat(64), true).await.is_err());
        f.done();
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), Ok(chain())),
            ("sendrawtransaction", json!([raw()]), Ok(v["txid"].clone())),
        ]);
        assert_eq!(
            send(&f, &code(), v["txid"].as_str().unwrap(), true)
                .await
                .unwrap()["txid"],
            v["txid"]
        );
        f.done();
    }
    #[tokio::test]
    async fn phone_wrong_network_and_already_known_are_not_sendable() {
        let mut info = chain();
        info["chain"] = json!("test");
        let f = Fake::new(vec![("getblockchaininfo", json!([]), Ok(info))]);
        assert_eq!(review(&f, &code()).await.unwrap_err(), MAINNET);
        f.done();
        let mut wrong = decoded();
        wrong["vout"][0]["scriptPubKey"]["addresses"] = json!(["1111111111111111111114oLvT2"]);
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), Ok(chain())),
            ("decoderawtransaction", json!([raw()]), Ok(wrong)),
        ]);
        assert_eq!(review(&f, &code()).await.unwrap_err(), MAINNET);
        f.done();
        let mut rows = review_rows();
        rows.truncate(3);
        rows[2].2 = Ok(json!({"txid":txid(&raw()).unwrap()}));
        let f = Fake::new(rows);
        assert!(review(&f, &code()).await.unwrap_err().contains("이미"));
        f.done();
    }
    #[tokio::test]
    async fn phone_missing_fee_is_unknown_and_rejections_are_human() {
        let mut rows = review_rows();
        rows[3].2 = Ok(Value::Null);
        let f = Fake::new(rows);
        assert!(review(&f, &code()).await.unwrap()["fee"].is_null());
        f.done();
        for (code_num, phrase) in [(-27, "이미"), (-26, "거부"), (-25, "입력"), (-22, "형식")]
        {
            let f = Fake::new(vec![
                ("getblockchaininfo", json!([]), Ok(chain())),
                (
                    "sendrawtransaction",
                    json!([raw()]),
                    Err(crate::raven::RpcFailure {
                        code: Some(code_num),
                        message: "Synthetic".into(),
                    }),
                ),
            ]);
            assert!(send(&f, &code(), &txid(&raw()).unwrap(), true)
                .await
                .unwrap_err()
                .contains(phrase));
            f.done();
        }
    }
    #[test]
    fn phone_asset_quantities_are_exact_and_unknown_scripts_stay_unknown() {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend([42; 20]);
        script.extend([0x88, 0xac]);
        let mut body = b"rvnt\x04TEST".to_vec();
        body.extend(9_007_199_254_740_993u64.to_le_bytes());
        script.extend([0xc0, body.len() as u8]);
        script.extend(body);
        script.push(0x75);
        let asset = displayed_asset(&script).unwrap().unwrap();
        assert_eq!(asset["name"], "TEST");
        assert_eq!(asset["quantity"], "90071992.54740993");
        assert!(displayed_asset(&[0x6a, 0x00]).is_err());
        let mut p2sh = vec![0xa9, 0x14];
        p2sh.extend([42; 20]);
        p2sh.push(0x87);
        assert_eq!(displayed_asset(&p2sh).unwrap(), None);
    }
}
