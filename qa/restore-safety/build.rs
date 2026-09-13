use std::{env, fs, path::PathBuf};
fn section(source: &str, begin: &str, end: &str) -> String {
    let from = source.find(begin).expect("production start marker");
    let to = source[from..].find(end).expect("production end marker") + from;
    source[from..to].to_string()
}
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let source = root.join("src-tauri/src/recover.rs");
    let moving = root.join("src-tauri/src/moving.rs");
    let locks = root.join("src-tauri/src/restore_lock.rs");
    for path in [&source, &moving, &locks] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-env-changed=RESTORE_SAFETY_MUTANT");
    let mut module = section(
        &fs::read_to_string(source).unwrap(),
        "// BEGIN RESTORE FILE SAFETY",
        "// END RESTORE FILE SAFETY",
    );
    let status = section(
        &fs::read_to_string(moving).unwrap(),
        "// BEGIN MOVE RESTORE STATUS",
        "// END MOVE RESTORE STATUS",
    );
    let mut lock = fs::read_to_string(locks).unwrap();
    match env::var("RESTORE_SAFETY_MUTANT").as_deref() {
        Ok("no-node-lock") => {
            assert!(lock.contains("lock(&file).map_err(lock_error)?;"));
            lock = lock.replace(
                "lock(&file).map_err(lock_error)?;",
                "// MUTANT: RPC failure treated as stopped; OS guard removed.",
            );
        }
        Ok("move-original-first") => {
            let marker = "let (stage, expected) =";
            assert!(module.contains(marker));
            module = module.replace(marker, "if dest.exists() { fs::rename(&dest, dest.with_extension(\"dat.before-restore\")).unwrap(); }\n        let (stage, expected) =");
        }
        Ok("drop-previous") => {
            assert!(module.contains("*previous = Some(stage.to_path_buf());"));
            module = module
                .replace(
                    "*previous = Some(stage.to_path_buf());",
                    "fs::remove_file(stage).unwrap(); *previous = Some(stage.to_path_buf());",
                )
                .replace(
                    "*previous = Some(backup.clone());",
                    "fs::remove_file(&backup).unwrap(); *previous = Some(backup.clone());",
                );
        }
        Ok("plain-rename") => {
            let start = module.find("    fn replace(").unwrap();
            let end = module[start..].find("    pub(super) fn install(").unwrap() + start;
            module.replace_range(start..end, "    fn replace(stage: &Path, destination: &Path, _: bool, _: &mut Option<PathBuf>, changed: &mut bool) -> io::Result<()> { fs::rename(stage, destination)?; *changed = true; Ok(()) }\n");
        }
        Ok("move-always-success") => {
            let status = "fn restore_complete(_: &serde_json::Value) -> bool { true }";
            fs::write(out.join("moving_status.rs"), status).unwrap();
        }
        Ok(other) => panic!("unknown mutant {other}"),
        Err(_) => {}
    }
    fs::write(out.join("restore_files.rs"), module).unwrap();
    fs::write(out.join("restore_lock.rs"), lock).unwrap();
    fs::write(
        out.join("compiled.rs"),
        format!(
            "#[path = {:?}] mod restore_lock;\ninclude!({:?});\ninclude!({:?});\n",
            out.join("restore_lock.rs"),
            out.join("restore_files.rs"),
            out.join("moving_status.rs")
        ),
    )
    .unwrap();
    if env::var("RESTORE_SAFETY_MUTANT").as_deref() != Ok("move-always-success") {
        fs::write(out.join("moving_status.rs"), status).unwrap();
    }
}
