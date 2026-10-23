//! 받은 윈도우 설치 파일(NSIS `.exe`)에서 **실행하지 않고** 버전을 읽는다.
//!
//! ## 왜 읽나
//! 서명된 진술(`update_policy::Release`)은 「이 바이트(sha256)가 이 버전이다」라고 말한다.
//! 그런데 서명하는 쪽이 실수로 옛 설치 파일에 새 버전을 적으면 앱은 그걸 못 잡는다.
//! 그래서 맥은 `Info.plist`, 윈도우는 이 파일의 **VS_VERSIONINFO 리소스**를 직접 열어
//! 진술의 버전과 맞대어 본다(`ProductVersion` 문자열 + 숫자 `FILEVERSION` 교차 확인).
//!
//! ## 방어 (악성 입력은 전부 Err, 패닉 없음)
//! - 모든 읽기는 `get()` 한 곳을 지난다: 범위 밖·오버플로(`checked_*`)는 Err.
//! - 상한: PE 머리 위치 1MiB 이내, 구역 96개, 리소스 디렉터리 깊이 3(종류→이름→언어),
//!   디렉터리당 항목 512, 전체 방문 항목 2048, 버전 자료 64KiB, 문자열 128자, 블록 깊이 3.
//! - 깊이가 3 으로 고정이라 순환 디렉터리는 구조적으로 불가능(3단 아래 하위 디렉터리는 Err).
//! - RVA→파일 위치는 구역의 **원본 크기 안**에서만 변환한다.
//! - 파일을 실행·압축해제하지 않는다. 읽기만 한다.

const MAX_LFANEW: usize = 1 << 20;
const MAX_SECTIONS: usize = 96;
const MAX_DIR_ENTRIES: usize = 512;
const MAX_VISITED: usize = 2048;
const MAX_VERSION_BLOCK: usize = 64 * 1024;
const MAX_STRING_CHARS: usize = 128;
const MAX_CHILDREN: usize = 64;
const RT_VERSION: u32 = 16;
const ERR: &str = "윈도우 설치 파일 형식 오류";

fn get(b: &[u8], off: usize, len: usize) -> Result<&[u8], String> {
    let end = off.checked_add(len).ok_or(ERR)?;
    b.get(off..end).ok_or_else(|| ERR.to_string())
}
fn u16le(b: &[u8], off: usize) -> Result<u16, String> {
    let s = get(b, off, 2)?;
    Ok(u16::from_le_bytes([s[0], s[1]]))
}
fn u32le(b: &[u8], off: usize) -> Result<u32, String> {
    let s = get(b, off, 4)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

struct Section {
    va: u32,
    limit: u32,
    raw: u32,
}

/// RVA 한 점(+`len` 바이트)을 파일 위치로. 구역 원본 크기 밖이면 Err.
fn rva_to_off(secs: &[Section], rva: u32, len: u32, file_len: usize) -> Result<usize, String> {
    for s in secs {
        if rva >= s.va {
            let d = rva - s.va;
            let end = d.checked_add(len).ok_or(ERR)?;
            if end <= s.limit {
                let off = (s.raw as usize).checked_add(d as usize).ok_or(ERR)?;
                let off_end = off.checked_add(len as usize).ok_or(ERR)?;
                if off_end <= file_len {
                    return Ok(off);
                }
                return Err(ERR.into());
            }
        }
    }
    Err(ERR.into())
}

/// NSIS 설치 파일(PE)의 ProductVersion 문자열. 숫자 FILEVERSION 과 안 맞으면 Err.
pub fn product_version(b: &[u8]) -> Result<String, String> {
    if get(b, 0, 2)? != b"MZ" {
        return Err(ERR.into());
    }
    let lfanew = u32le(b, 0x3c)? as usize;
    if !(0x40..=MAX_LFANEW).contains(&lfanew) || get(b, lfanew, 4)? != b"PE\0\0" {
        return Err(ERR.into());
    }
    let coff = lfanew + 4;
    let nsec = u16le(b, coff + 2)? as usize;
    let opt_size = u16le(b, coff + 16)? as usize;
    if nsec == 0 || nsec > MAX_SECTIONS {
        return Err(ERR.into());
    }
    let opt = coff + 20;
    let (dd_count_off, dd_off) = match u16le(b, opt)? {
        0x10b => (opt + 92, opt + 96),
        0x20b => (opt + 108, opt + 112),
        _ => return Err(ERR.into()),
    };
    // 데이터 디렉터리 2번(리소스) 항목이 선택 머리 안에 있어야 한다.
    let entry2 = dd_off + 2 * 8;
    if entry2 + 8 > opt.checked_add(opt_size).ok_or(ERR)? || u32le(b, dd_count_off)? < 3 {
        return Err("버전 정보 없음".into());
    }
    let rsrc_rva = u32le(b, entry2)?;
    let rsrc_size = u32le(b, entry2 + 4)?;
    if rsrc_rva == 0 || rsrc_size == 0 {
        return Err("버전 정보 없음".into());
    }
    // 구역 표
    let sec_tab = opt.checked_add(opt_size).ok_or(ERR)?;
    let mut secs = Vec::new();
    for i in 0..nsec {
        let o = sec_tab + i * 40;
        let vsize = u32le(b, o + 8)?;
        let va = u32le(b, o + 12)?;
        let raw_size = u32le(b, o + 16)?;
        let raw = u32le(b, o + 20)?;
        let limit = if vsize == 0 { raw_size } else { vsize.min(raw_size) };
        // 구역 자체가 파일 안에 있어야 한다.
        get(b, raw as usize, limit as usize)?;
        secs.push(Section { va, limit, raw });
    }
    let base = rva_to_off(&secs, rsrc_rva, rsrc_size, b.len())?;
    let rs = get(b, base, rsrc_size as usize)?; // 리소스 영역(이 안에서만 읽는다)

    // 디렉터리 읽기: (id_or_name, is_dir, target)
    fn entries(rs: &[u8], off: usize, visited: &mut usize) -> Result<Vec<(u32, bool, usize)>, String> {
        let named = u16le(rs, off + 12)? as usize;
        let ids = u16le(rs, off + 14)? as usize;
        let n = named + ids;
        if n > MAX_DIR_ENTRIES {
            return Err(ERR.into());
        }
        *visited += n;
        if *visited > MAX_VISITED {
            return Err(ERR.into());
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let e = off + 16 + i * 8;
            let name = u32le(rs, e)?;
            let to = u32le(rs, e + 4)?;
            out.push((name, to & 0x8000_0000 != 0, (to & 0x7fff_ffff) as usize));
        }
        Ok(out)
    }
    let mut visited = 0usize;
    let mut versions: Vec<String> = Vec::new();
    for (ty, ty_dir, ty_off) in entries(rs, 0, &mut visited)? {
        // 이름 붙은 종류(최상위 비트)는 버전이 아니다.
        if ty & 0x8000_0000 != 0 || ty != RT_VERSION {
            continue;
        }
        if !ty_dir {
            return Err(ERR.into());
        }
        for (_name, name_dir, name_off) in entries(rs, ty_off, &mut visited)? {
            if !name_dir {
                return Err(ERR.into());
            }
            for (_lang, lang_dir, data_off) in entries(rs, name_off, &mut visited)? {
                // 3단째는 반드시 잎이다. 하위 디렉터리(순환 포함)는 거부.
                if lang_dir {
                    return Err(ERR.into());
                }
                let rva = u32le(rs, data_off)?;
                let size = u32le(rs, data_off + 4)? as usize;
                if size == 0 || size > MAX_VERSION_BLOCK {
                    return Err(ERR.into());
                }
                let at = rva_to_off(&secs, rva, size as u32, b.len())?;
                versions.push(parse_version_info(get(b, at, size)?)?);
                if versions.len() > 16 {
                    return Err(ERR.into());
                }
            }
        }
    }
    let first = versions.first().ok_or("버전 정보 없음")?;
    // 언어별 자료가 여럿이면 전부 같아야 한다.
    if versions.iter().any(|v| v != first) {
        return Err("윈도우 설치 파일 버전 정보 불일치".into());
    }
    Ok(first.clone())
}

struct Block {
    key: String,
    value: usize, // 값 시작
    vlen: usize,  // wValueLength
    wtype: u16,
    end: usize, // 이 블록의 끝(절대)
}

fn align4(x: usize) -> Result<usize, String> {
    x.checked_add(3).map(|v| v & !3).ok_or_else(|| ERR.to_string())
}

/// `data[off..limit]` 에서 VS_VERSIONINFO 계열 블록 머리 하나.
fn block(data: &[u8], off: usize, limit: usize) -> Result<Block, String> {
    if limit > data.len() {
        return Err(ERR.into());
    }
    let w_len = u16le(data, off)? as usize;
    let vlen = u16le(data, off + 2)? as usize;
    let wtype = u16le(data, off + 4)?;
    let end = off.checked_add(w_len).ok_or(ERR)?;
    if w_len < 8 || end > limit {
        return Err(ERR.into());
    }
    let mut key = Vec::new();
    let mut p = off + 6;
    loop {
        if p + 2 > end || key.len() >= 64 {
            return Err(ERR.into());
        }
        let c = u16le(data, p)?;
        p += 2;
        if c == 0 {
            break;
        }
        key.push(c);
    }
    Ok(Block {
        key: String::from_utf16(&key).map_err(|_| ERR.to_string())?,
        value: align4(p)?,
        vlen,
        wtype,
        end,
    })
}

fn parse_version_info(data: &[u8]) -> Result<String, String> {
    let root = block(data, 0, data.len())?;
    if root.key != "VS_VERSION_INFO" || root.vlen != 52 {
        return Err("버전 정보 형식 오류".into());
    }
    // 고정 파일 정보(숫자 버전)
    let fixed = get(data, root.value, 52)?;
    if root.value + 52 > root.end || u32le(fixed, 0)? != 0xFEEF_04BD {
        return Err("버전 정보 형식 오류".into());
    }
    let ms = u32le(fixed, 16)?; // dwProductVersionMS
    let numeric = ((ms >> 16) as u64, (ms & 0xffff) as u64, (u32le(fixed, 20)? >> 16) as u64);

    let mut found: Option<String> = None;
    let mut pos = align4(root.value + 52)?;
    let mut n = 0;
    while pos < root.end {
        n += 1;
        if n > MAX_CHILDREN {
            return Err(ERR.into());
        }
        let child = block(data, pos, root.end)?;
        if child.key == "StringFileInfo" {
            let mut tpos = child.value;
            let mut tn = 0;
            while tpos < child.end {
                tn += 1;
                if tn > MAX_CHILDREN {
                    return Err(ERR.into());
                }
                let table = block(data, tpos, child.end)?;
                let mut spos = table.value;
                let mut sn = 0;
                while spos < table.end {
                    sn += 1;
                    if sn > MAX_CHILDREN {
                        return Err(ERR.into());
                    }
                    let s = block(data, spos, table.end)?;
                    if s.key == "ProductVersion" {
                        if s.wtype != 1 || s.vlen == 0 || s.vlen > MAX_STRING_CHARS {
                            return Err(ERR.into());
                        }
                        let raw = get(data, s.value, s.vlen * 2)?;
                        if s.value + s.vlen * 2 > s.end {
                            return Err(ERR.into());
                        }
                        let units: Vec<u16> = raw
                            .chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .take_while(|&c| c != 0)
                            .collect();
                        let text = String::from_utf16(&units).map_err(|_| ERR.to_string())?;
                        if found.replace(text.clone()).is_some_and(|prev| prev != text) {
                            return Err("윈도우 설치 파일 버전 정보 불일치".into());
                        }
                    }
                    spos = align4(s.end)?;
                }
                tpos = align4(table.end)?;
            }
        }
        pos = align4(child.end)?;
    }
    let text = found.ok_or("버전 정보 없음")?;
    // 숫자 FILEVERSION 과 문자열의 major.minor.patch 가 같아야 한다.
    let v = semver::Version::parse(&text).map_err(|_| "윈도우 설치 파일 버전 형식 오류")?;
    if (v.major, v.minor, v.patch) != numeric {
        return Err("윈도우 설치 파일 버전 숫자 불일치".into());
    }
    Ok(text)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn u16s(s: &str) -> Vec<u8> {
        s.encode_utf16().chain([0]).flat_map(|c| c.to_le_bytes()).collect()
    }
    fn pad4(v: &mut Vec<u8>) {
        while v.len() % 4 != 0 {
            v.push(0);
        }
    }
    /// 블록 하나: 머리(wLength 는 나중에 채움) + 키 + 값 + 자식들.
    fn blk(key: &str, vlen: u16, wtype: u16, value: &[u8], children: &[Vec<u8>]) -> Vec<u8> {
        let mut v = vec![0, 0];
        v.extend(vlen.to_le_bytes());
        v.extend(wtype.to_le_bytes());
        v.extend(u16s(key));
        pad4(&mut v);
        v.extend(value);
        for c in children {
            pad4(&mut v);
            v.extend(c);
        }
        let l = v.len() as u16;
        v[0..2].copy_from_slice(&l.to_le_bytes());
        v
    }
    fn fixed(maj: u32, min: u32, pat: u32) -> Vec<u8> {
        let mut f = Vec::new();
        for w in [0xFEEF_04BDu32, 0x10000, (maj << 16) | min, pat << 16, (maj << 16) | min, pat << 16] {
            f.extend(w.to_le_bytes());
        }
        f.resize(52, 0);
        f
    }
    pub(crate) fn version_info(string_ver: &str, num: (u32, u32, u32)) -> Vec<u8> {
        let s = blk("ProductVersion", (string_ver.len() + 1) as u16, 1, &u16s(string_ver), &[]);
        let t = blk("040904b0", 0, 1, &[], &[s]);
        let sfi = blk("StringFileInfo", 0, 1, &[], &[t]);
        blk("VS_VERSION_INFO", 52, 0, &fixed(num.0, num.1, num.2), &[sfi])
    }
    /// 합성 PE: 구역 하나(.rsrc) 에 리소스 트리 + 버전 자료.
    pub(crate) fn pe_with(version_block: Option<&[u8]>) -> Vec<u8> {
        let rsrc_va = 0x1000u32;
        // 리소스 트리: root(1 id=16) -> type dir(1) -> name dir(1) -> data entry
        let mut rs = Vec::new();
        let mk = |ids: &[(u32, u32)]| {
            let mut d = vec![0u8; 12];
            d.extend(0u16.to_le_bytes());
            d.extend((ids.len() as u16).to_le_bytes());
            for (id, to) in ids {
                d.extend(id.to_le_bytes());
                d.extend(to.to_le_bytes());
            }
            d
        };
        rs.extend(mk(&[(RT_VERSION, 0x8000_0018)])); // 0x00..0x18
        rs.extend(mk(&[(1, 0x8000_0030)])); // 0x18..0x30
        rs.extend(mk(&[(0x409, 0x48)])); // 0x30..0x48 (잎)
        let data_off = 0x58usize;
        rs.extend(((rsrc_va as usize + data_off) as u32).to_le_bytes()); // 0x48 RVA
        let vb = version_block.map(|x| x.to_vec()).unwrap_or_default();
        rs.extend((vb.len() as u32).to_le_bytes());
        rs.extend([0u8; 8]);
        assert_eq!(rs.len(), data_off);
        rs.extend(&vb);
        let raw_ptr = 0x200usize;
        let mut f = vec![0u8; raw_ptr];
        f[0..2].copy_from_slice(b"MZ");
        f[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        f[0x80..0x84].copy_from_slice(b"PE\0\0");
        f[0x84 + 2..0x84 + 4].copy_from_slice(&1u16.to_le_bytes()); // 구역 1
        f[0x84 + 16..0x84 + 18].copy_from_slice(&0xe0u16.to_le_bytes()); // 선택 머리 크기
        let opt = 0x98;
        f[opt..opt + 2].copy_from_slice(&0x10bu16.to_le_bytes());
        f[opt + 92..opt + 96].copy_from_slice(&16u32.to_le_bytes());
        f[opt + 96 + 16..opt + 96 + 20].copy_from_slice(&rsrc_va.to_le_bytes());
        f[opt + 96 + 20..opt + 96 + 24].copy_from_slice(&(rs.len() as u32).to_le_bytes());
        let sec = opt + 0xe0;
        f[sec..sec + 6].copy_from_slice(b".rsrc\0");
        f[sec + 8..sec + 12].copy_from_slice(&(rs.len() as u32).to_le_bytes());
        f[sec + 12..sec + 16].copy_from_slice(&rsrc_va.to_le_bytes());
        f[sec + 16..sec + 20].copy_from_slice(&(rs.len() as u32).to_le_bytes());
        f[sec + 20..sec + 24].copy_from_slice(&(raw_ptr as u32).to_le_bytes());
        f.extend(rs);
        f
    }

    /// 다른 모듈 시험이 쓰는 합성 NSIS 설치 파일(버전 문자열·숫자 일치).
    pub(crate) fn synthetic_installer(v: &str) -> Vec<u8> {
        let s = semver::Version::parse(v).unwrap();
        pe_with(Some(&version_info(v, (s.major as u32, s.minor as u32, s.patch as u32))))
    }

    #[test]
    fn reads_product_version_from_synthetic_pe() {
        let pe = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        assert_eq!(product_version(&pe).unwrap(), "0.9.5");
        let pe = pe_with(Some(&version_info("1.2.3-beta.1", (1, 2, 3))));
        assert_eq!(product_version(&pe).unwrap(), "1.2.3-beta.1");
    }
    #[test]
    fn numeric_and_string_mismatch_is_rejected() {
        let pe = pe_with(Some(&version_info("0.9.5", (0, 9, 4))));
        assert!(product_version(&pe).is_err());
    }
    #[test]
    fn missing_version_resource_is_rejected() {
        // 버전 자료가 비어 있음
        assert!(product_version(&pe_with(None)).is_err());
        // ProductVersion 키가 없는 버전 자료
        let t = blk("040904b0", 0, 1, &[], &[]);
        let sfi = blk("StringFileInfo", 0, 1, &[], &[t]);
        let vi = blk("VS_VERSION_INFO", 52, 0, &fixed(0, 9, 5), &[sfi]);
        assert!(product_version(&pe_with(Some(&vi))).is_err());
    }
    #[test]
    fn truncated_files_never_panic() {
        let pe = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        for n in 0..pe.len() {
            assert!(product_version(&pe[..n]).is_err(), "len {n}");
        }
        assert!(product_version(b"").is_err());
        assert!(product_version(b"MZ").is_err());
        assert!(product_version(b"PK\x03\x04 not a pe").is_err());
    }
    #[test]
    fn out_of_range_offsets_are_rejected() {
        let good = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        // 데이터 항목 RVA 를 구역 밖으로
        let mut p = good.clone();
        let data_entry = 0x200 + 0x48;
        p[data_entry..data_entry + 4].copy_from_slice(&0x00ff_0000u32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 데이터 크기를 구역보다 크게
        let mut p = good.clone();
        p[data_entry + 4..data_entry + 8].copy_from_slice(&0x7fff_ffffu32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 데이터 RVA+크기 u32 오버플로
        let mut p = good.clone();
        p[data_entry..data_entry + 4].copy_from_slice(&0xffff_fff0u32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 하위 디렉터리 오프셋이 리소스 밖
        let mut p = good.clone();
        // (헤더 12바이트 + 개수 4 → 첫 항목 id@16,to@20)
        let e = 0x200 + 16 + 4;
        p[e..e + 4].copy_from_slice(&0x8000_ff00u32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 구역 원본 위치가 파일 밖
        let mut p = good.clone();
        let sec = 0x98 + 0xe0;
        p[sec + 20..sec + 24].copy_from_slice(&0x0fff_0000u32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // e_lfanew 가 파일 밖 / 0xffffffff
        let mut p = good.clone();
        p[0x3c..0x40].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 구역 개수 0 / 과다
        let mut p = good.clone();
        p[0x86..0x88].copy_from_slice(&0u16.to_le_bytes());
        assert!(product_version(&p).is_err());
        p[0x86..0x88].copy_from_slice(&5000u16.to_le_bytes());
        assert!(product_version(&p).is_err());
    }
    #[test]
    fn cyclic_resource_directory_is_rejected() {
        let mut p = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        // 3단째(언어) 항목이 루트 디렉터리를 가리킨다 → 하위 디렉터리 표지 + 오프셋 0
        let lang_entry_to = 0x200 + 0x30 + 16 + 4;
        p[lang_entry_to..lang_entry_to + 4].copy_from_slice(&0x8000_0000u32.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 2단째가 자기 자신을 가리킨다
        let mut p = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        let name_entry_to = 0x200 + 0x18 + 16 + 4;
        p[name_entry_to..name_entry_to + 4].copy_from_slice(&0x8000_0018u32.to_le_bytes());
        assert!(product_version(&p).is_err());
    }
    #[test]
    fn huge_values_are_rejected() {
        // 항목 개수 65535
        let mut p = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        p[0x200 + 14..0x200 + 16].copy_from_slice(&0xffffu16.to_le_bytes());
        assert!(product_version(&p).is_err());
        // 버전 자료 크기 64KiB 초과
        let mut p = pe_with(Some(&version_info("0.9.5", (0, 9, 5))));
        let data_entry = 0x200 + 0x48;
        p[data_entry + 4..data_entry + 8].copy_from_slice(&(70_000u32).to_le_bytes());
        assert!(product_version(&p).is_err());
        // 문자열 길이 값이 과대
        let long = "1".repeat(300);
        let pe = pe_with(Some(&version_info(&long, (1, 0, 0))));
        assert!(product_version(&pe).is_err());
        // 블록 wLength 가 0xffff
        let mut vi = version_info("0.9.5", (0, 9, 5));
        vi[0..2].copy_from_slice(&0xffffu16.to_le_bytes());
        assert!(product_version(&pe_with(Some(&vi))).is_err());
    }

    /// 파일이 있을 때만 도는 실제 NSIS 설치 파일 시험(없으면 건너뜀).
    #[test]
    fn real_nsis_installer_reports_0_9_5_if_present() {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(_) => return,
        };
        let p = std::path::Path::new(&home).join("Downloads/rv-095b-win/ravenvault-desktop-windows-unsigned-6c6ff5de1e7c3f41eda754e93a3f9ba9e6e485cd/RavenVault Desktop_0.9.5_x64-setup.exe");
        let Ok(bytes) = std::fs::read(&p) else {
            eprintln!("실제 NSIS 파일 없음: 건너뜀");
            return;
        };
        assert_eq!(product_version(&bytes).unwrap(), "0.9.5");
        // 꼬리 바이트를 잘라도(= 변조) 패닉 없이 결과를 낸다.
        for cut in [1usize, 100, 4096, bytes.len() / 2] {
            let _ = product_version(&bytes[..bytes.len() - cut]);
        }
    }
}
