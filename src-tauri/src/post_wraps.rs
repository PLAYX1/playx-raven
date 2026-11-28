//! **우체국 겉봉 창고** — 남에게 온 kind 1059 겉봉(NIP-17)을 **디스크에** 두고, 메모리에는 찾기 표만 둔다.
//!
//! 11-28 대표: 「PLAY X 챗이 1만~2만 명에서도 빨라야 한다 · 데스크탑이 늘수록 안정적이어야 한다.」
//! 그 전(post_office.rs `Bag`)은 맡은 글을 **통째로 메모리에** 들고 컴퓨터 전체 2만 개까지였다 — 1만 명이면 한 사람에 2통.
//! 그래서 겉봉만 여기로 옮긴다(「나만·친구만」 글·열쇠 꾸러미는 수가 적어 post_office.rs 에 그대로).
//!
//! ## 모양
//!
//! - `post-wraps/w-<받은 시각의 시간 번호>.jsonl` — 한 시간에 한 파일, 겉봉 한 줄씩 덧붙인다(다시 쓰지 않는다).
//! - 메모리 찾기 표: id → (쓴 시각·받은 시각·파일·자리·길이·받는 사람 번호). 겉봉 하나에 약 150~200바이트.
//!   받는 사람(p)별 · 쓴 시각별 색인 — 물음·맞추기(NIP-77)가 맡은 수에 비례해 느려지지 않게.
//! - 지우기: 찾기 표에서만 뺀다. 파일은 그 안의 겉봉이 모두 기한이 지나거나 빠지면 통째로 지운다.
//! - 다시 켤 때: 파일을 읽어 찾기 표를 다시 만든다(받는 사람당 상한도 다시 건다 — 같은 결과).
//!
//! ## 🔴 지키는 것(post_office.rs 와 같다)
//!
//! - 암호문이다. 풀지 않는다(열쇠도 없다). 받는 사람(`p`)을 **하나** 적은 것만.
//! - 받은 때부터 30일 · 받는 사람마다 500통 · 컴퓨터 전체 상한(도우미/핵심 다르게 — post_office::caps).
//! - 디스크 여유가 10% 아래로 내려가면 스스로 줄인다(오래 맡은 것부터).
//! - 끄면 폴더째 지운다.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub type Id = [u8; 32];

#[derive(Clone, Copy, Debug)]
struct Meta {
    /// 겉봉에 적힌 시각(created_at, 초).
    at: u32,
    /// 받은 시각(초).
    got: u32,
    seg: u32,
    off: u64,
    len: u32,
    p: u32,
}

#[derive(Default)]
struct Seg {
    bytes: u64,
    ids: Vec<Id>,
    /// 아직 찾기 표에 남은 수 — 0 이 되면 파일을 지운다.
    live: usize,
}

#[derive(Default)]
struct Store {
    items: HashMap<Id, Meta>,
    by_p: HashMap<u32, BTreeSet<(u32, Id)>>,
    by_at: BTreeSet<(u32, Id)>,
    /// 받은 순(기한·넘칠 때 오래된 것부터).
    by_got: BTreeSet<(u32, Id)>,
    segs: BTreeMap<u32, Seg>,
    p_names: Vec<String>,
    p_index: HashMap<String, u32>,
    writer: Option<(u32, std::fs::File, u64)>,
    bytes: u64,
    loaded: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);
/// 디스크에 쓴 바이트(잠금 없이 읽는 사본) — 디스크 여유 판단(post_office::effective_wrap_bytes)이 읽는다.
static USED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn counts_cached_bytes() -> u64 {
    USED.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn dir() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join(format!("rv-test-post-wraps-{}", std::process::id()));
    }
    crate::paths::app_file("post-wraps")
}

fn seg_path(seg: u32) -> PathBuf {
    dir().join(format!("w-{seg}.jsonl"))
}

pub fn id_of(hex_id: &str) -> Option<Id> {
    if hex_id.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_id, &mut out).ok()?;
    Some(out)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn clamp_u32(v: i64) -> u32 {
    v.clamp(0, u32::MAX as i64) as u32
}

impl Store {
    fn intern(&mut self, p: &str) -> u32 {
        if let Some(i) = self.p_index.get(p) {
            return *i;
        }
        let i = self.p_names.len() as u32;
        self.p_names.push(p.to_string());
        self.p_index.insert(p.to_string(), i);
        i
    }

    fn index(&mut self, id: Id, m: Meta) {
        self.by_p.entry(m.p).or_default().insert((m.got, id));
        self.by_at.insert((m.at, id));
        self.by_got.insert((m.got, id));
        let s = self.segs.entry(m.seg).or_default();
        s.ids.push(id);
        s.live += 1;
        self.items.insert(id, m);
    }

    /// 찾기 표에서만 뺀다. 파일에 남은 것이 없으면 파일을 지운다.
    fn unindex(&mut self, id: &Id) -> bool {
        let Some(m) = self.items.remove(id) else { return false };
        if let Some(set) = self.by_p.get_mut(&m.p) {
            set.remove(&(m.got, *id));
            if set.is_empty() {
                self.by_p.remove(&m.p);
            }
        }
        self.by_at.remove(&(m.at, *id));
        self.by_got.remove(&(m.got, *id));
        let empty = match self.segs.get_mut(&m.seg) {
            Some(s) => {
                s.live = s.live.saturating_sub(1);
                s.live == 0
            }
            None => false,
        };
        if empty {
            self.drop_seg(m.seg);
        }
        true
    }

    fn drop_seg(&mut self, seg: u32) {
        let Some(s) = self.segs.remove(&seg) else { return };
        for id in &s.ids {
            if let Some(m) = self.items.get(id) {
                if m.seg == seg {
                    let m = *m;
                    self.items.remove(id);
                    if let Some(set) = self.by_p.get_mut(&m.p) {
                        set.remove(&(m.got, *id));
                        if set.is_empty() {
                            self.by_p.remove(&m.p);
                        }
                    }
                    self.by_at.remove(&(m.at, *id));
                    self.by_got.remove(&(m.got, *id));
                }
            }
        }
        self.bytes = self.bytes.saturating_sub(s.bytes);
        if self.writer.as_ref().is_some_and(|w| w.0 == seg) {
            self.writer = None;
        }
        let _ = std::fs::remove_file(seg_path(seg));
    }

    fn sweep(&mut self, now: i64, keep: i64) {
        let cut = clamp_u32(now - keep);
        while let Some((got, id)) = self.by_got.iter().next().copied() {
            if got > cut {
                break;
            }
            self.unindex(&id);
        }
    }

    fn trim_p(&mut self, p: u32, cap: usize) {
        loop {
            let first = match self.by_p.get(&p) {
                Some(s) if s.len() > cap => s.iter().next().copied(),
                _ => None,
            };
            let Some((_, id)) = first else { break };
            self.unindex(&id);
        }
    }

    /// 전체 상한 — 오래 받은 것부터. 디스크 쪽은 파일째로 줄어든다(빠진 것도 파일이 남아 있으면 디스크를 쓴다).
    fn trim_total(&mut self, max_items: usize, max_bytes: u64) {
        while self.items.len() > max_items {
            let Some((_, id)) = self.by_got.iter().next().copied() else { break };
            self.unindex(&id);
        }
        while self.bytes > max_bytes && self.segs.len() > 1 {
            let Some(seg) = self.segs.keys().next().copied() else { break };
            self.drop_seg(seg);
        }
    }

    fn load(&mut self) {
        self.loaded = true;
        let Ok(rd) = std::fs::read_dir(dir()) else { return };
        let mut segs: Vec<u32> = rd
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.strip_prefix("w-")?.strip_suffix(".jsonl")?.parse::<u32>().ok()
            })
            .collect();
        segs.sort_unstable();
        for seg in segs {
            let Ok(bytes) = std::fs::read(seg_path(seg)) else { continue };
            self.segs.entry(seg).or_default().bytes = bytes.len() as u64;
            self.bytes += bytes.len() as u64;
            let mut off = 0usize;
            for line in bytes.split(|b| *b == b'\n') {
                let here = off;
                off += line.len() + 1;
                if line.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
                let Some(id) = v.get("id").and_then(Value::as_str).and_then(id_of) else { continue };
                if self.items.contains_key(&id) {
                    continue;
                }
                let Some(p) = crate::post_office::wrap_recipient(&v) else { continue };
                let at = clamp_u32(v.get("created_at").and_then(Value::as_i64).unwrap_or(0));
                // 받은 시각은 줄마다 적지 않는다 — 시간 파일 번호(그 시간의 끝)로 잰다(기한을 짧게 재지 않게).
                let got = clamp_u32(seg as i64 * 3600 + 3599);
                let p = self.intern(&p);
                self.index(id, Meta { at, got, seg, off: here as u64, len: line.len() as u32, p });
            }
            if self.segs.get(&seg).is_some_and(|s| s.live == 0) {
                self.drop_seg(seg);
            }
        }
        let caps = crate::post_office::caps();
        let ps: Vec<u32> = self.by_p.iter().filter(|(_, s)| s.len() > caps.per_p).map(|(p, _)| *p).collect();
        for p in ps {
            self.trim_p(p, caps.per_p);
        }
        self.sweep(now_secs(), crate::post_office::WRAP_KEEP_SECS);
    }

    fn append(&mut self, seg: u32, line: &[u8]) -> Option<u64> {
        if self.writer.as_ref().map(|w| w.0) != Some(seg) {
            let _ = std::fs::create_dir_all(dir());
            let f = std::fs::OpenOptions::new().create(true).append(true).open(seg_path(seg)).ok()?;
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            self.writer = Some((seg, f, len));
        }
        let w = self.writer.as_mut()?;
        let off = w.2;
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line);
        buf.push(b'\n');
        if w.1.write_all(&buf).is_err() {
            self.writer = None;
            return None;
        }
        w.2 += buf.len() as u64;
        self.segs.entry(seg).or_default().bytes += buf.len() as u64;
        self.bytes += buf.len() as u64;
        Some(off)
    }
}

fn with<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let s = g.get_or_insert_with(Store::default);
    if !s.loaded {
        s.load();
    }
    let r = f(s);
    USED.store(s.bytes, std::sync::atomic::Ordering::Relaxed);
    r
}

/// 앱을 켤 때 미리 읽어 둔다(핵심 우체국은 수백만 통 — 첫 물음이 기다리지 않게).
pub fn warm() {
    with(|_| ());
}

/// 맡는다. `e` 는 서명이 덮는 일곱 칸만 남긴 겉봉(post_office::take 가 이미 검사했다).
/// 돌려주는 값: (받았나, 까닭) — 새로 맡았으면 까닭은 post_office::TOOK.
pub fn take(e: &Value, p: &str, now: i64) -> (bool, String) {
    let Some(id) = e.get("id").and_then(Value::as_str).and_then(id_of) else {
        return (false, "invalid: id".into());
    };
    let caps = crate::post_office::caps();
    let max_bytes = crate::post_office::effective_wrap_bytes();
    with(|s| {
        s.sweep(now, crate::post_office::WRAP_KEEP_SECS);
        if s.items.contains_key(&id) {
            return (true, "duplicate: 이미 맡았습니다".into());
        }
        let line = match serde_json::to_vec(e) {
            Ok(l) => l,
            Err(_) => return (false, "invalid: 글".into()),
        };
        // 디스크가 상한에 닿았는데 지금 시간 파일 하나뿐이면(더 줄일 옛 파일이 없다) 받지 않는다.
        let seg = clamp_u32(now / 3600);
        if s.bytes + line.len() as u64 > max_bytes {
            s.trim_total(caps.wrap_items, max_bytes.saturating_sub(line.len() as u64));
            if s.bytes + line.len() as u64 > max_bytes {
                return (false, "rate-limited: 우체국이 가득 찼습니다".into());
            }
        }
        let Some(off) = s.append(seg, &line) else {
            return (false, "error: 디스크에 쓰지 못했습니다".into());
        };
        let at = clamp_u32(e.get("created_at").and_then(Value::as_i64).unwrap_or(0));
        let pi = s.intern(p);
        s.index(id, Meta { at, got: clamp_u32(now), seg, off, len: line.len() as u32, p: pi });
        s.trim_p(pi, caps.per_p);
        s.trim_total(caps.wrap_items, max_bytes);
        (true, crate::post_office::TOOK.to_string())
    })
}

/// 자리만 모은 뒤(잠금 안) 파일은 잠금 밖에서 읽는다.
fn read_many(locs: Vec<(u32, u64, u32)>) -> Vec<Value> {
    let mut by_seg: BTreeMap<u32, Vec<(usize, u64, u32)>> = BTreeMap::new();
    for (i, (seg, off, len)) in locs.iter().enumerate() {
        by_seg.entry(*seg).or_default().push((i, *off, *len));
    }
    let mut out: Vec<Option<Value>> = vec![None; locs.len()];
    for (seg, list) in by_seg {
        let Ok(mut f) = std::fs::File::open(seg_path(seg)) else { continue };
        for (i, off, len) in list {
            if f.seek(SeekFrom::Start(off)).is_err() {
                continue;
            }
            let mut buf = vec![0u8; len as usize];
            if f.read_exact(&mut buf).is_ok() {
                out[i] = serde_json::from_slice(&buf).ok();
            }
        }
    }
    out.into_iter().flatten().collect()
}

fn time_ok(m: &Meta, f: &Value) -> bool {
    let at = m.at as i64;
    if f.get("since").and_then(Value::as_i64).is_some_and(|s| at < s) {
        return false;
    }
    if f.get("until").and_then(Value::as_i64).is_some_and(|u| at > u) {
        return false;
    }
    true
}

/// `#p` 를 적은 물음에 맞는 겉봉 — 받은 순으로 새것부터 `cap` 개까지(필터 전체 검사는 relay::filter_matches).
pub fn answer_for(ps: &[String], f: &Value, cap: usize) -> Vec<Value> {
    if cap == 0 || ps.is_empty() {
        return vec![];
    }
    let locs: Vec<(u32, u64, u32)> = with(|s| {
        s.sweep(now_secs(), crate::post_office::WRAP_KEEP_SECS);
        let mut v: Vec<(u32, u32, u64, u32)> = Vec::new();
        for p in ps {
            let Some(pi) = s.p_index.get(p) else { continue };
            let Some(set) = s.by_p.get(pi) else { continue };
            for (_, id) in set.iter().rev() {
                let Some(m) = s.items.get(id) else { continue };
                if time_ok(m, f) {
                    v.push((m.at, m.seg, m.off, m.len));
                }
            }
        }
        v.sort_unstable_by_key(|x| std::cmp::Reverse(x.0));
        // ids·태그 조건은 읽은 뒤에 거르므로 넉넉히(두 배) 읽는다.
        v.truncate(cap.saturating_mul(2).max(cap));
        v.into_iter().map(|(_, s, o, l)| (s, o, l)).collect()
    });
    let mut out: Vec<Value> = read_many(locs).into_iter().filter(|e| crate::relay::filter_matches(e, f)).collect();
    out.truncate(cap);
    out
}

/// 핵심 우체국끼리(인증한 상대만): `ids` 로 바로 찾기.
pub fn by_ids(ids: &[Id]) -> Vec<Value> {
    let locs: Vec<(u32, u64, u32)> = with(|s| ids.iter().filter_map(|id| s.items.get(id)).map(|m| (m.seg, m.off, m.len)).collect());
    read_many(locs)
}

/// 핵심 우체국끼리(인증한 상대만): 쓴 시각 범위의 겉봉, 새것부터 `cap` 개.
pub fn by_time(since: i64, until: i64, cap: usize) -> Vec<Value> {
    let locs: Vec<(u32, u64, u32)> = with(|s| {
        let lo = (clamp_u32(since), [0u8; 32]);
        let hi = (clamp_u32(until), [0xffu8; 32]);
        s.by_at.range(lo..=hi).rev().take(cap).filter_map(|(_, id)| s.items.get(id)).map(|m| (m.seg, m.off, m.len)).collect()
    });
    read_many(locs)
}

/// NIP-77 맞추기 재료: (쓴 시각, id). `ps` 가 있으면 그 사람들 것만, 없으면(핵심끼리) 전부. since·until 은 쓴 시각.
pub fn neg_items(ps: Option<&[String]>, since: i64, until: i64, max: usize) -> Result<Vec<(u64, Id)>, usize> {
    with(|s| {
        s.sweep(now_secs(), crate::post_office::WRAP_KEEP_SECS);
        let mut out: Vec<(u64, Id)> = Vec::new();
        let ok = |m: &Meta| (m.at as i64) >= since && (m.at as i64) <= until;
        match ps {
            Some(ps) => {
                for p in ps {
                    let Some(pi) = s.p_index.get(p) else { continue };
                    let Some(set) = s.by_p.get(pi) else { continue };
                    for (_, id) in set {
                        if let Some(m) = s.items.get(id) {
                            if ok(m) {
                                out.push((m.at as u64, *id));
                            }
                        }
                    }
                }
            }
            None => {
                let lo = (clamp_u32(since), [0u8; 32]);
                let hi = (clamp_u32(until), [0xffu8; 32]);
                for (at, id) in s.by_at.range(lo..=hi) {
                    out.push((*at as u64, *id));
                }
            }
        }
        if out.len() > max {
            return Err(out.len());
        }
        Ok(out)
    })
}

/// (맡은 겉봉 수, 디스크 바이트).
pub fn counts() -> (usize, u64) {
    with(|s| {
        s.sweep(now_secs(), crate::post_office::WRAP_KEEP_SECS);
        (s.items.len(), s.bytes)
    })
}

/// 한 받는 사람 칸의 수(시험용).
#[cfg(test)]
pub fn count_for(p: &str) -> usize {
    with(|s| s.p_index.get(p).and_then(|i| s.by_p.get(i)).map(|x| x.len()).unwrap_or(0))
}

/// 기한을 `now` 기준으로 지운다(시험용).
#[cfg(test)]
pub fn sweep_at(now: i64) {
    with(|s| s.sweep(now, crate::post_office::WRAP_KEEP_SECS));
}

/// 상한이 바뀌었을 때(디스크가 모자람 등) 바로 줄인다.
pub fn enforce() {
    let caps = crate::post_office::caps();
    let max_bytes = crate::post_office::effective_wrap_bytes();
    with(|s| s.trim_total(caps.wrap_items, max_bytes));
}

/// 모두 지운다(우체국 끄기). 폴더째.
pub fn clear() {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    *g = Some(Store { loaded: true, ..Store::default() });
    USED.store(0, std::sync::atomic::Ordering::Relaxed);
    let _ = std::fs::remove_dir_all(dir());
}

/// 시험: 다시 켠 것처럼 디스크에서 다시 읽게.
#[cfg(test)]
pub fn forget_memory() {
    *STORE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
pub fn reset() {
    clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap(once: u8, to: &str, body: &str, at: i64) -> Value {
        crate::shopkey::sign_with(&[once; 32], 1059, json!([["p", to]]), body, at).unwrap()
    }

    #[test]
    fn disk_store_survives_restart_and_answers_by_p_and_time() {
        let _g = crate::post_office::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let q = crate::shopkey::pubkey_of(&[5u8; 32]).unwrap();
        let now = now_secs();
        let a = wrap(9, &p, "a", now - 50);
        let b = wrap(10, &p, "b", now - 10);
        let c = wrap(11, &q, "c", now - 5);
        for (e, to) in [(&a, &p), (&b, &p), (&c, &q)] {
            assert_eq!(take(e, to, now).1, crate::post_office::TOOK);
        }
        assert_eq!(take(&a, &p, now).1, "duplicate: 이미 맡았습니다");
        assert_eq!(counts().0, 3);
        forget_memory();
        assert_eq!(counts().0, 3, "다시 켜도 디스크에서 다시 읽는다");
        let got = answer_for(&[p.clone()], &json!({ "#p": [p], "kinds": [1059] }), 10);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["id"], b["id"], "새것부터");
        let since = answer_for(&[p.clone()], &json!({ "#p": [p], "since": now - 20 }), 10);
        assert_eq!(since.len(), 1);
        let ids = by_ids(&[id_of(c["id"].as_str().unwrap()).unwrap()]);
        assert_eq!(ids[0]["id"], c["id"]);
        assert_eq!(by_time(now - 60, now, 10).len(), 3);
        let all = neg_items(None, 0, i64::MAX, 100).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(neg_items(Some(&[q.clone()]), 0, i64::MAX, 100).unwrap().len(), 1);
        assert!(neg_items(None, 0, i64::MAX, 2).is_err(), "너무 많으면 거절");
        clear();
        assert_eq!(counts(), (0, 0));
        assert!(!dir().exists(), "끄면 폴더째 지운다");
    }

    #[test]
    fn expiry_drops_files_when_everything_in_them_is_gone() {
        let _g = crate::post_office::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let now = now_secs();
        take(&wrap(9, &p, "old", now - 3600 * 5), &p, now - 3600 * 5);
        take(&wrap(10, &p, "new", now), &p, now);
        let files = || std::fs::read_dir(dir()).map(|r| r.count()).unwrap_or(0);
        assert_eq!(files(), 2);
        sweep_at(now - 3600 * 5 + crate::post_office::WRAP_KEEP_SECS + 10);
        assert_eq!(counts().0, 1);
        assert_eq!(files(), 1, "빈 시간 파일은 지운다");
        reset();
    }
}
