//! 오락실 판매자 게이트웨이 — 이 컴퓨터의 바깥 주소로 **내 게임만** 읽기 전용 /ipfs/ 로 내주고, 그 주소를 알림 쪽지 gw 태그로 알린다. (2026-11-26)
//!
//! 공개 게이트웨이(ipfs.io 429 · dweb.link 시간 초과)가 판매자 컴퓨터의 게임을 못 찾아 사이트(/g/ · /arcade/ipfs/)가 503 이었다.
//! 대표 원칙: 게임 파일은 판매자 자기 데스크탑에만 · 사이트에 특정 컴퓨터 주소를 적지 않는다 · 게이트웨이는 믿지 않는다(사이트가 다시 본다).
//!
//! - 내주는 것: `arcade_keep` 30분 바퀴가 붙잡은 내 게임의 문서·폴더 CID 만(`serves`). 바깥 요청은 server.rs `ipfs_relay` 가
//!   파일창고 API `cat` 을 **offline** 으로 부른다 — 이 컴퓨터에 없는 블록은 받으러 가지 않는다(Gateway.NoFetch 와 같은 효과, 남의 CID 프록시 없음).
//!   5001 API 는 바깥에 열지 않는다. 가게가 아닌 컴퓨터(키오스크)도 이 길만은 바깥에 연다(server.rs `arcade_gateway_path`).
//! - 알리는 주소: 테일스케일 고정 주소 → 사람이 적은 내 릴레이 주소의 호스트 → 임시 터널, 문(/api/relay)까지 실제로 닿는 첫 곳.
//! - 다시 알리기: 쪽지의 gw 가 지금 주소와 다르면 **같은 content(같은 안쪽 판매자 서명)** 를 겉봉투 열쇠로만 다시 싼다 —
//!   지갑 잠김과 상관없다(겉봉투 열쇠 = shopkey.json 에서 뽑은 값). 안쪽 서명 문구에 겉봉투 pubkey 가 들어 있어 판매자 R 주소와의 묶임은 그대로 증명된다.
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Mutex;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}


/// 바깥(터널·퍼널)에서 /ipfs/ 로 내줄 CID — 이 컴퓨터가 붙잡고 있는 **내 게임**의 문서·폴더만. 30분 바퀴가 다시 채운다.
static SERVING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 체인 쪽을 못 읽은 바퀴(`complete=false`)는 지난 목록의 체인 게임을 지우지 않게 합친다(잠깐의 노드 실패로 게임이 닫히지 않게).
pub(crate) fn set_serving(now_set: &HashSet<String>, complete: bool) {
    if let Ok(mut g) = SERVING.lock() {
        let next = if complete { now_set.clone() } else { g.as_ref().map(|old| old.union(now_set).cloned().collect()).unwrap_or_else(|| now_set.clone()) };
        *g = Some(next);
    }
}

/// 바깥 요청 `/ipfs/<root>[/…]` 의 root 가 내 게임 CID 인가.
pub fn serves(root: &str) -> bool {
    crate::arcade::cid_ok(root) && SERVING.lock().ok().and_then(|g| g.as_ref().map(|s| s.contains(root))).unwrap_or(false)
}
/// 시험끼리 전역 목록을 동시에 바꾸지 않게(server.rs 시험과 이 파일 시험).
#[cfg(test)]
pub(crate) static SERVING_TEST_LOCK: Mutex<()> = Mutex::new(());
#[cfg(test)]
pub(crate) fn set_serving_for_test(cids: &[&str]) {
    set_serving(&cids.iter().map(|c| c.to_string()).collect(), true);
}

/// 후보 순서: 바뀌지 않는 주소(테일스케일 고정 주소 → 사람이 적은 내 릴레이 주소의 호스트) → 지금 임시 터널. 모양 검사(core 와 같은 규칙)를 지난 것만.
pub(crate) fn origin_candidates(fixed: &str, own: Option<String>, tunnel: Option<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in [Some(fixed.trim().to_ascii_lowercase()), own.map(|s| s.to_ascii_lowercase()), tunnel.map(|s| s.trim().to_ascii_lowercase())].into_iter().flatten() {
        if let Some(o) = crate::arcade_listing::gateway_origin(&c) {
            if !out.contains(&o) { out.push(o); }
        }
    }
    out
}

/// 그 주소로 바깥에서 **내 게임 /ipfs/ 길**이 실제로 열리는가. 내주는 CID 가 있으면 그 문서를 받아 200 이어야 하고
/// (퍼널이 `/relay` 만 넘기는 등 /ipfs/ 가 이 컴퓨터로 안 오는 주소를 걸러낸다), 아직 없으면 문(/api/relay)이 404 아닌 500 미만으로 답해야 한다.
pub(crate) fn probe_ok(status: u16, probing_ipfs: bool) -> bool {
    if probing_ipfs { status == 200 } else { status < 500 && status != 404 }
}
async fn door_answers(origin: &str, probe: Option<&str>) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build() else { return false };
    let url = match probe { Some(cid) => format!("{origin}/ipfs/{cid}"), None => format!("{origin}/api/relay") };
    matches!(client.get(url).send().await, Ok(r) if probe_ok(r.status().as_u16(), probe.is_some()))
}

/// 바깥 문 시험에 쓸 **문서** CID 들. 폴더 CID 는 맨몸(`/ipfs/<폴더>`)으로 부르면 404 라(시작 파일 경로가 있어야 한다) 시험에 쓰면 안 된다.
/// 🔴 11-27: 예전엔 SERVING(문서+폴더) 중 가장 작은 CID 를 골랐다 — 폴더가 골라지면 문이 늘 「안 닿음」이 되어
///    gw 태그 없이 올라가고 다시 알리기도 멈췄다(키오스크 일반 판매자 게임 5종이 사이트에서 503, 표지도 안 보임).
static PROBE_DOCS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
pub(crate) fn set_probe_docs(docs: &HashSet<String>, complete: bool) {
    if let Ok(mut g) = PROBE_DOCS.lock() {
        let next = if complete { docs.clone() } else { g.as_ref().map(|old| old.union(docs).cloned().collect()).unwrap_or_else(|| docs.clone()) };
        *g = Some(next);
    }
}

/// 시험해 볼 내 게임 문서 CID 하나(지금도 내주는 것만).
fn probe_cid() -> Option<String> {
    let docs = PROBE_DOCS.lock().ok()?.as_ref()?.clone();
    docs.into_iter().filter(|c| serves(c)).min()
}

/// 알림에 적을 이 컴퓨터의 바깥 주소 — 후보 중 실제로 닿는 첫 곳. 없으면 None(그때는 gw 를 적지 않는다 · 다시 싸지도 않는다).
pub async fn outside_origin_for_listing() -> Option<String> {
    let tunnel = crate::tunnel::tunnel_status()["url"].as_str().map(str::to_string).filter(|s| !s.is_empty());
    let probe = probe_cid();
    for o in origin_candidates(&crate::map::fixed_target(), crate::relay_share::own_https_origin(), tunnel) {
        if door_answers(&o, probe.as_deref()).await { return Some(o); }
    }
    None
}

/// 내 open 쪽지 중 gw 가 지금 주소와 다른 것만 다시 싸 올린다(지갑 서명 없음 · 겉봉투 열쇠만). 올린 수.
pub(crate) async fn reannounce(events: &[Value], my_pk: &str, origin: &str) -> usize {
    let Ok(sk) = crate::arcade_listing::nostr_key() else { return 0 };
    let mut n = 0;
    for e in crate::arcade_listing::my_latest_open_events(events, my_pk) {
        if crate::arcade_listing::gateway_of(e).as_deref() == Some(origin) { continue; }
        let Ok(ev) = crate::arcade_listing::rewrap_event(&sk, e, origin, now()) else { continue };
        if n > 0 { tokio::time::sleep(std::time::Duration::from_millis(1500)).await; } // 공개 릴레이에 몰아 보내지 않는다
        if crate::nostrpub::nostr_publish(ev).await.is_ok() { n += 1; }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 문_시험은_폴더가_아니라_문서_cid_로() {
        let _g = SERVING_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 폴더(QmA…)가 문서(QmZ…)보다 작아도 문서를 고른다 — 맨몸 폴더 주소는 404 라 문이 늘 실패했다(11-27 키오스크).
        let folder = "QmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string();
        let doc = "QmZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ".to_string();
        set_serving(&[folder.clone(), doc.clone()].into_iter().collect(), true);
        set_probe_docs(&[doc.clone()].into_iter().collect(), true);
        assert_eq!(probe_cid().as_deref(), Some(doc.as_str()));
        // 더는 내주지 않는 문서는 고르지 않는다
        set_serving(&[folder].into_iter().collect(), true);
        assert_eq!(probe_cid(), None);
        set_serving(&HashSet::new(), true); set_probe_docs(&HashSet::new(), true);
    }

    #[test]
    fn 주소_후보는_고정_먼저_모양이_맞는_것만_겹침없이() {
        assert_eq!(
            origin_candidates("https://Kiosk.tail1234.ts.net", Some("https://kiosk.tail1234.ts.net".into()), Some("https://a-b.trycloudflare.com".into())),
            vec!["https://kiosk.tail1234.ts.net".to_string(), "https://a-b.trycloudflare.com".to_string()]
        );
        assert_eq!(origin_candidates("", None, Some("https://a-b.trycloudflare.com".into())), vec!["https://a-b.trycloudflare.com".to_string()]);
        assert!(origin_candidates("http://192.168.0.5:8790", Some("https://localhost".into()), Some("https://x.trycloudflare.com:8443".into())).is_empty());
    }

    #[test]
    fn 주소_확인은_ipfs_길이면_200_만() {
        assert!(probe_ok(200, true));
        assert!(!probe_ok(404, true), "퍼널이 /ipfs/ 를 이 컴퓨터로 안 넘긴다");
        assert!(!probe_ok(503, true));
        assert!(probe_ok(400, false) && probe_ok(426, false));
        assert!(!probe_ok(404, false) && !probe_ok(502, false) && !probe_ok(530, false));
    }

    #[test]
    fn 내주는_목록은_내_게임만_체인_실패_바퀴는_합친다() {
        let _g = SERVING_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let a = format!("Qm{}", "A".repeat(44));
        let b = format!("Qm{}", "B".repeat(44));
        set_serving(&[a.clone()].into_iter().collect(), true);
        assert!(serves(&a) && !serves(&b) && !serves("../etc"));
        set_serving(&[b.clone()].into_iter().collect(), false);
        assert!(serves(&a) && serves(&b), "체인을 못 읽은 바퀴는 지난 것을 지우지 않는다");
        set_serving(&[b.clone()].into_iter().collect(), true);
        assert!(!serves(&a) && serves(&b));
        set_serving(&HashSet::new(), true);
    }

    #[test]
    fn 다시_알리기는_지갑_서명을_부르지_않는다() {
        let src = include_str!("arcade_gw.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for word in ["signmessage", "sign_message", "walletx", "taile277f6"] {
            assert!(!body.contains(word), "{word}");
        }
    }
}
