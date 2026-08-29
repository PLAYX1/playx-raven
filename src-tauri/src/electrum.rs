//! Optional ElectrumX support.
//!
//! ## What it fixes
//!
//! Ravencoin Core cannot answer "what does this address hold" unless it was
//! started with `-assetindex`, which requires a reindex measured in hours. This
//! app works around that by keeping a local member ledger — which works, and
//! which is also the single file whose loss locks thirty paying members out at
//! 7am.
//!
//! ElectrumX builds that index alongside the node and answers the question
//! directly. With it running, a door check reads the chain instead of a file,
//! and the ledger becomes a convenience rather than the source of truth.
//!
//! ## The larger thing it enables
//!
//! Light wallets speak the Electrum protocol. A shop running ElectrumX is not
//! just indexing for itself — it can serve any Ravencoin light wallet, which
//! is how a customer's phone gets to verify its own balance without trusting
//! this shop's word for it. That is the difference between "the shop says you
//! have a membership" and "the chain says so, and you checked".
//!
//! ## Why it stays optional
//!
//! It is a separate Python service with its own database and its own hours of
//! initial indexing. Making it a requirement would mean every café owner
//! installs a server before selling a coffee. So: detected if present, used if
//! detected, and the app works without it.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 50001;

/// Where to ask, when this shop does not run its own index.
///
/// ## Why a fallback exists at all
///
/// A customer's wallet needs to know what it owns before it can spend, and that
/// question needs an address index this node does not have. Requiring every
/// café to install ElectrumX first would mean nobody sells a coffee.
///
/// So: local index if present, otherwise a public one. The shop node relays —
/// the customer's phone never has to reach the internet itself, which is the
/// whole point of a wallet that works on shop wifi.
///
/// ## What trusting a public server does and does not cost
///
/// It can lie about balances and it can see which addresses are asked about.
/// It **cannot** take anything: the wallet signs in the browser and a wrong
/// balance produces a transaction the network rejects, not a stolen coin. So
/// this is a privacy and convenience trade, not a custody one — and the screen
/// says which server answered.
fn public_servers() -> Vec<(&'static str, u16)> {
    // 🔴 2026-08-29 실측: 여기 `("electrumx.raventag.com", 50002)` 가 적혀 있었고
    //    **한 번도 작동한 적이 없다.** 50002 는 TLS 포트인데 아래 `call_at` 은
    //    `TcpStream` 으로 **평문**을 보낸다. 붙기는 하지만 답이 오지 않아
    //    12초를 버리고 실패했다 — 그러면서 화면에는 「대비책이 있다」고 적혀 있었다.
    //
    //    ⚠️ TLS 를 붙여도 소용이 적다. 그 서버에게 이웃을 물어보니
    //       (`server.peers.subscribe`) **자기 하나뿐**이었다. RVN 의 공개
    //       ElectrumX 는 사실상 한 대라 늘릴 수가 없다.
    //
    //    그래서 같은 종류를 늘리는 대신 **다른 종류**를 뒤에 세웠다 —
    //    `publicbook.rs` 의 Blockbook(HTTP·정식 인증서·다른 운영자).
    //    여기는 **사장이 자기 것을 적어 넣는 자리**로 남긴다.
    vec![]
}

/// Talks to whichever index is reachable, nearest first.
fn call_any(method: &str, params: Value) -> Result<(Value, String), String> {
    if let Ok(v) = call(method, params.clone()) {
        return Ok((v, format!("{HOST}:{PORT}")));
    }
    for (host, port) in public_servers() {
        if let Ok(v) = call_at(host, port, method, params.clone()) {
            return Ok((v, format!("{host}:{port}")));
        }
    }
    Err("자산을 조회할 수 있는 서버가 없습니다. ElectrumX를 켜거나 인터넷을 확인하세요.".into())
}

fn call_at(host: &str, port: u16, method: &str, params: Value) -> Result<Value, String> {
    let mut stream = TcpStream::connect((host, port))
        .map_err(|e| format!("{host} 에 닿지 못했습니다: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .map_err(|e| e.to_string())?;
    let req = json!({ "id": 1, "method": method, "params": params });
    writeln!(stream, "{req}").map_err(|e| format!("보내지 못했습니다: {e}"))?;
    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&line).map_err(|e| format!("응답이 JSON이 아닙니다: {e}"))?;
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            return Err(format!("{method}: {err}"));
        }
    }
    parsed
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: 결과가 없습니다"))
}

/// One request/response over the Electrum protocol.
///
/// The protocol is newline-delimited JSON-RPC over a plain socket, so this is a
/// short connection rather than a pooled client — a door check runs a few times
/// an hour, not a few times a second, and a live socket to hold open is one more
/// thing to fail.
fn call(method: &str, params: Value) -> Result<Value, String> {
    let mut stream = TcpStream::connect((HOST, PORT))
        .map_err(|_| "ElectrumX가 켜져 있지 않습니다.".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .map_err(|e| e.to_string())?;

    let req = json!({ "id": 1, "method": method, "params": params });
    writeln!(stream, "{req}").map_err(|e| format!("보내지 못했습니다: {e}"))?;

    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;

    let parsed: Value =
        serde_json::from_str(&line).map_err(|e| format!("응답이 JSON이 아닙니다: {e}"))?;
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            return Err(format!("{method}: {err}"));
        }
    }
    parsed
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: 결과가 없습니다"))
}

/// Is ElectrumX there, and what does it say about itself?
#[tauri::command]
pub fn electrum_status() -> Value {
    match call(
        "server.version",
        json!(["PLAY X Raven", ["1.4", "1.4.2"]]),
    ) {
        Ok(v) => json!({
            "running": true,
            "server": v,
            "what": "주소별 자산 조회가 됩니다. 출입 확인을 파일이 아니라 체인에서 합니다.",
        }),
        Err(e) => json!({
            "running": false,
            "why": e,
            "what": "없어도 다 돌아갑니다. 켜면 회원 확인이 체인에서 직접 되고, \
                     손님 폰의 경량 지갑도 이 노드에 붙을 수 있습니다.",
            "how": "https://github.com/ALENOC/electrumx-ravencoin",
        }),
    }
}

/// Ravencoin's scripthash: the SHA-256 of the output script, byte-reversed.
///
/// Electrum indexes by this rather than by address, so every lookup has to
/// convert first. Doing it here rather than trusting a caller-supplied hash
/// means a wrong address fails as "not found" instead of silently returning
/// somebody else's balance.
fn scripthash(address: &str) -> Result<String, String> {
    // The node already knows how to turn an address into its script; asking it
    // avoids reimplementing base58 and the asset-aware script rules here.
    let info = tauri::async_runtime::block_on(crate::raven::call_rpc(
        "validateaddress",
        json!([address]),
    ))?;
    if !info["isvalid"].as_bool().unwrap_or(false) {
        return Err("주소가 올바르지 않습니다.".into());
    }
    let spk = info
        .get("scriptPubKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "scriptPubKey를 얻지 못했습니다".to_string())?;

    let bytes = (0..spk.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&spk[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e| e.to_string())?;

    let digest = sha256(&bytes);
    Ok(digest.iter().rev().map(|b| format!("{b:02x}")).collect())
}

/// Minimal SHA-256. Vendored rather than pulled in as a dependency for one call.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);

            hh = g; g = f; f = e;
            e = d.wrapping_add(t1);
            d = c; c = b; b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].iter().enumerate() {
            h[i] = h[i].wrapping_add(*v);
        }
    }

    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// What assets an address holds, straight from the chain.
///
/// This is the query Core refuses without `-assetindex`. With it, a door check
/// stops depending on a local file: if the member still holds their number,
/// they are still a member, and losing our ledger costs names and dates rather
/// than access.
#[tauri::command]
pub fn address_assets(address: String) -> Result<Value, String> {
    let sh = scripthash(&address)?;
    let balances = call("blockchain.scripthash.get_asset_balance", json!([sh]))?;
    Ok(json!({ "address": address, "assets": balances }))
}

/// Does this address hold this specific asset right now?
#[tauri::command]
pub fn holds_asset(address: String, asset: String) -> Result<Value, String> {
    let r = address_assets(address.clone())?;
    let confirmed = r["assets"]
        .get("confirmed")
        .and_then(|c| c.get(&asset))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    Ok(json!({
        "address": address,
        "asset": asset,
        "amount": confirmed,
        "holds": confirmed > 0.0,
        // 파일이 아니라 체인이 답한 것이라, 우리 장부가 없어도 참이다.
        "source": "chain",
    }))
}

/// Everything a light wallet needs to know about one address.
///
/// Returns the source it got the answer from, because a customer standing in a
/// shop should be able to see whether the shop answered or a stranger did.
#[tauri::command]
pub fn wallet_view(address: String) -> Result<Value, String> {
    let script = address_to_scripthash(&address)?;

    let (unspent, source) = call_any("blockchain.scripthash.listunspent", json!([script]))?;
    let rows = unspent.as_array().cloned().unwrap_or_default();
    let sats: u64 = rows
        .iter()
        .filter_map(|u| u.get("value").and_then(Value::as_u64))
        .sum();

    Ok(json!({
        "address": address,
        "rvn": sats as f64 / 100_000_000.0,
        "utxos": rows,
        "source": source,
        // 어디서 온 답인지 화면이 말할 수 있어야 한다.
        "trusted": source.starts_with("127.0.0.1"),
    }))
}

/// Sends a transaction the browser already signed.
///
/// Goes to this shop's own node rather than to the index server. The node is
/// the thing we run, it validates before relaying, and it means a shop can
/// accept a payment even when no index is reachable at all.
#[tauri::command]
pub async fn wallet_send_signed(hex: String) -> Result<Value, String> {
    // 🔴 여기에는 대비책이 **아예 없었다.** 노드가 재색인 중이거나 꺼져 있으면
    //    손님이 **돈을 못 보냈다.** 잔액은 못 봐도 참을 수 있지만 보내지 못하는
    //    것은 지갑이 아니다.
    match crate::raven::call_rpc("sendrawtransaction", json!([hex.clone()])).await {
        Ok(txid) => Ok(json!({
            "txid": txid.as_str().unwrap_or_default(),
            "note": "이 가게 노드가 네트워크에 알렸습니다.",
        })),
        Err(e) => {
            // ⚠️ 여기 오는 것은 **이미 서명된 거래**다. 열쇠는 넘어가지 않는다.
            //    공개처가 할 수 있는 최악은 전달을 안 하는 것이고, 그러면
            //    거래는 그냥 안 일어난다 — 돈이 사라지지 않는다.
            let txid = crate::publicbook::broadcast(&hex)
                .await
                .map_err(|b| format!("{e} / {b}"))?;
            Ok(json!({
                "txid": txid,
                "note": "이 가게 노드가 답하지 않아 공개 조회처를 통해 알렸습니다.",
                "via_public": true,
            }))
        }
    }
}

/// Electrum indexes by script hash, not by address.
///
/// The hash is sha256 of the output script, byte-reversed. Getting the reversal
/// wrong returns an empty wallet rather than an error, which is the worst kind
/// of bug — it looks like "you have no money".
fn address_to_scripthash(address: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let decoded = base58check(address)?;
    if decoded.len() != 21 {
        return Err("주소 길이가 올바르지 않습니다.".into());
    }
    // P2PKH: OP_DUP OP_HASH160 <20> …20 bytes… OP_EQUALVERIFY OP_CHECKSIG
    let mut script = vec![0x76, 0xa9, 0x14];
    script.extend_from_slice(&decoded[1..]);
    script.extend_from_slice(&[0x88, 0xac]);

    let mut h = Sha256::new();
    h.update(&script);
    let mut digest = h.finalize().to_vec();
    digest.reverse();
    Ok(hex::encode(digest))
}

fn base58check(s: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut num: Vec<u8> = vec![0];
    for c in s.bytes() {
        let Some(idx) = ALPHABET.iter().position(|&a| a == c) else {
            return Err("주소에 쓸 수 없는 글자가 있습니다.".into());
        };
        let mut carry = idx;
        for b in num.iter_mut().rev() {
            carry += (*b as usize) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            num.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // 앞자리 '1' 하나가 0x00 한 바이트다.
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0u8; zeros];
    let start = num.iter().position(|&b| b != 0).unwrap_or(num.len());
    out.extend_from_slice(&num[start..]);

    if out.len() < 5 {
        return Err("주소가 너무 짧습니다.".into());
    }
    let (body, check) = out.split_at(out.len() - 4);
    use sha2::{Digest, Sha256};
    let d1 = Sha256::digest(body);
    let d2 = Sha256::digest(d1);
    if &d2[..4] != check {
        return Err("주소 검사값이 맞지 않습니다. 잘못 옮겨 적으신 것 같습니다.".into());
    }
    Ok(body.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrong_address_is_caught_not_emptied() {
        // 체크섬이 틀린 주소는 "잔액 0"이 아니라 오류여야 한다. 0을 보여 주면
        // 사람은 돈이 사라졌다고 생각한다.
        assert!(base58check("RXissueRestrictedXXXXXXXXXXXXWdRhFX").is_err());
        assert!(address_to_scripthash("정상아님").is_err());
    }

    #[test]
    fn a_real_address_decodes_to_21_bytes() {
        // 레이븐 P2PKH 는 버전 1바이트 + 해시 20바이트.
        let d = base58check("RESQ7wtHvqcSzy8Vb8nhGq82RDXMjpafxZ").expect("디코드 실패");
        assert_eq!(d.len(), 21);
        assert_eq!(d[0], 0x3c, "레이븐 주소 버전 바이트가 아닙니다");
    }
}

/// The chain, as much of it as a customer's wallet is allowed to see.
///
/// ## Why this exists instead of handing out the node's RPC
///
/// A light wallet needs three things: what do I own, what are my unspent
/// outputs, and please relay this signed transaction. The node answers all
/// three — and also answers "send everything to this address", because RPC is
/// one door with no rooms. Pointing a customer's browser at it would put the
/// shop's wallet behind a URL on a stranger's phone.
///
/// So this is the subset, and only the subset.
///
/// ## Where the answer comes from, in order
///
/// 1. **This node**, if it was started with `-addressindex`. Local, instant,
///    and nobody else learns which addresses were asked about.
/// 2. **A local ElectrumX**, if the shop runs one.
/// 3. **A public ElectrumX**, relayed by us so the customer's phone never needs
///    the internet — only the shop does.
///
/// The answer says which one replied, because a customer should be able to see
/// whether the shop answered or a stranger did.
#[tauri::command]
pub async fn chain_address(address: String) -> Result<Value, String> {
    // ① 이 노드에 주소 색인이 있으면 그게 가장 빠르고 가장 조용하다.
    if let Ok(v) = crate::raven::call_rpc(
        "getaddressutxos",
        json!([{ "addresses": [address.clone()] }]),
    )
    .await
    {
        let rows = v.as_array().cloned().unwrap_or_default();

        // 🔴 `getaddressutxos` 는 **자산 UTXO 도 같이** 준다. 여태 전부 더해서
        // `rvn` 이라고 불렀는데, 자산의 `satoshis` 는 그 자산의 수량이지
        // RVN 이 아니다. 회원권 1장을 가진 사람은 그 1이 RVN 으로 세어졌다.
        //
        // 화면에 틀린 잔액이 뜨는 것은 지갑이 할 수 있는 가장 나쁜 거짓말이다.
        let is_rvn = |u: &Value| {
            u.get("assetName")
                .and_then(Value::as_str)
                .map(|n| n.eq_ignore_ascii_case("RVN"))
                .unwrap_or(true)
        };
        let sats: u64 = rows
            .iter()
            .filter(|u| is_rvn(u))
            .filter_map(|u| u.get("satoshis").and_then(Value::as_u64))
            .sum();

        // 자산은 이름별로 묶어 따로 준다. 손님이 회원권을 샀는데 지갑에
        // 안 보이면, 산 사람은 안 왔다고 여긴다.
        let mut assets: std::collections::BTreeMap<String, u64> = Default::default();
        for u in rows.iter().filter(|u| !is_rvn(u)) {
            let Some(n) = u.get("assetName").and_then(Value::as_str) else { continue };
            *assets.entry(n.to_string()).or_insert(0) +=
                u.get("satoshis").and_then(Value::as_u64).unwrap_or(0);
        }
        let assets: serde_json::Map<String, Value> = assets
            .into_iter()
            // 자산 수량도 8자리로 온다. 나누기 전에는 1장이 100000000 이다.
            .map(|(k, v)| (k, json!(v as f64 / 100_000_000.0)))
            .collect();

        return Ok(json!({
            "address": address,
            "rvn": sats as f64 / 100_000_000.0,
            "assets": assets,
            "utxos": rows,
            "source": "이 가게 노드",
            "trusted": true,
        }));
    }

    // ②·③ 색인이 없으면 Electrum 에 묻는다. 로컬 → 공개 순.
    match wallet_view(address.clone()) {
        Ok(v) => Ok(v),
        // ④ 그것마저 없으면 **다른 종류**에 묻는다. 여기까지 와야
        //    「우리가 다 죽어도 손님은 자기 돈을 본다」가 참이 된다.
        Err(e) => crate::publicbook::address(&address)
            .await
            .map_err(|b| format!("{e} / {b}")),
    }
}
