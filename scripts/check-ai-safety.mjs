import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const read = p => readFileSync(p, 'utf8');
const server = read('src-tauri/src/server.rs');
const owner = server.slice(server.indexOf('async fn api_owner_ask('), server.indexOf('async fn api_ai_status('));
assert.ok(owner.includes('ai_ask_owner_limited('));
assert.ok(!owner.includes('ai_answer_any('));
assert.ok(owner.includes('"answer":') && owner.includes('"left":'));
const ai = read('src-tauri/src/ai.rs');
const osStore = ai.slice(ai.indexOf('impl KeyStore for OsStore'), ai.indexOf('struct FileStore'));
assert.equal((osStore.match(/map_err\(classify_keyring_error\)/g)||[]).length,3,'native get/set/delete preserve safe classifications');
const classifier=ai.slice(ai.indexOf('fn classify_keyring_error'),ai.indexOf('trait KeyStore'));
assert.ok(!/\.to_string\(|println!|eprintln!|dbg!|log::|tracing::|format!/.test(classifier),'native error payloads are never formatted or logged');
assert.ok(ai.includes('#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]\nstruct OsStore'), 'tests cannot reach native keychain');
const generations=ai.slice(ai.indexOf('struct GenerationStore'),ai.indexOf('fn remove_key('));
assert.ok(!generations.includes('key_path(')&&!generations.includes('key.as_bytes()'),'native recovery never writes a plaintext key or fallback');
assert.ok(generations.includes('current.delete()')&&generations.includes('self.next_generation('));
for(const name of ['save_api_key','api_key_status','delete_api_key','save_custom_provider'])assert.ok(ai.includes(`#[tauri::command(async)]\npub fn ${name}`),'keychain prompts run away from UI thread');
const ownerAI = ai.slice(ai.indexOf('pub(crate) async fn ai_ask_owner_limited('), ai.indexOf('fn owner_system('));
assert.ok(ownerAI.includes('try_order(&provider, false)'));
assert.ok(ownerAI.includes('owner_system(owner.as_ref())'));
console.log('PASS owner phone system instructions, provider order and answer/left contract');

// Run production action handlers with synthetic DOM and RPC. No network.
const { default: ts } = await import('typescript');
const { default: vm } = await import('node:vm');
const main = read('src/main.ts');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let calls = [], removed = false;
const save = {}, cancel = {}, note = {}, swatch = { style: {} };
const card = { style: {}, remove() { removed = true; }, querySelector(s) { return ({'[data-theme-save]':save,'[data-theme-cancel]':cancel,'[data-theme-note]':note,'[data-theme-swatch]':swatch})[s]; } };
const c = vm.createContext({ $, chatHtml() {}, copyHtml:s=>s, t:s=>s, tf:s=>s, errText:()=> 'synthetic error', setCopyText:(el,draw)=>el.textContent=draw(), invoke:async(cmd,args)=>{ calls.push({cmd,args}); } });
function $(id) { assert.equal(id,'chat-log'); return { lastElementChild:{querySelector:()=>card} }; }
vm.runInContext(compile(fn('previewRaviTheme')),c);
assert.equal(c.previewRaviTheme('112233','eef0ff'),true);
assert.equal(calls.length,0,'preview must not save');
cancel.onclick(); assert.equal(removed,true); assert.equal(calls.length,0);
c.previewRaviTheme('112233','eef0ff'); await save.onclick();
assert.equal(calls.length,1); assert.equal(calls[0].cmd,'theme_save'); assert.equal(calls[0].args.accent,'#112233');
assert.equal(c.previewRaviTheme('bad<script>','eef0ff'),false);
assert.ok(!fn('applyActions').includes('invoke("theme_save"'));
const html = read('web/admin.html');
const apply = html.slice(html.indexOf('      function apply(actions)'),html.indexOf('      // 손님은 주문하고'));
const menu = [{name:'fixture',price:10}]; let agreed=false, confirmations=0;
const admin = vm.createContext({menu, renderMenu(){}, confirm(){ confirmations++; return agreed; }, Number, $(){return {};} });
vm.runInContext(apply,admin);
admin.apply([{type:'menu_clear'}]); assert.equal(menu.length,1); assert.equal(confirmations,1);
agreed=true; admin.apply([{type:'menu_clear'}]); assert.equal(menu.length,0);
menu.push({name:'fixture',price:10});
for (const field of ['__proto__','constructor','image','unknown']) admin.apply([{type:'menu_set',index:0,field,value:'forbidden'}]);
assert.deepEqual(menu[0],{name:'fixture',price:10});
admin.apply([{type:'menu_set',index:0,field:'price',value:'not a number'}]); assert.equal(menu[0].price,10);
admin.apply([{type:'menu_set',index:0,field:'price',value:'12'}]); assert.equal(menu[0].price,12);
console.log('PASS theme preview/manual save, admin delete confirmation and menu field allowlist');

const customer = server.slice(server.indexOf('async fn api_ask('), server.indexOf('struct OrderBody'));
const adminAI = server.slice(server.indexOf('async fn admin_ai('), server.indexOf('struct IssueBody'));
assert.ok(customer.includes('Lane::Customer') && customer.includes('|| permit.charge()'));
assert.ok(owner.includes('Lane::Owner') && owner.includes('|| permit.charge()'));
assert.ok(adminAI.includes('Lane::Owner'));
assert.ok(adminAI.indexOf('permit.charge()') < adminAI.indexOf('ai_chat('));
const attempts = ai.slice(ai.indexOf('async fn run_attempts'),ai.indexOf('mod attempt_tests'));
assert.ok(attempts.indexOf('before_attempt()?') < attempts.indexOf('match request('));
console.log('PASS customer/owner/admin budget wiring and pre-dispatch fallback charge');

// Regression and secret-safety checks execute real production handlers with mocks.
const check = ai.slice(ai.indexOf('pub async fn ai_check_connection('), ai.indexOf('#[cfg(test)]\nmod connection_tests'));
const connection = ai.slice(ai.indexOf('// Only an allowlisted category'), ai.indexOf('#[cfg(test)]\nmod connection_tests'));
assert.ok(!/\.(text|json|bytes)\(|format!|println!|eprintln!|dbg!|log::|tracing::/.test(connection), 'connection errors never expose body, key, URL, or raw diagnostics');
assert.ok(check.includes('ConnectionError::new("storage")'));
for (const name of ['saveKeyCard','checkSavedKey']) {
  const handler=fn(name);
  assert.ok(!/console\.|errText\(|JSON\.stringify/.test(handler), 'key handlers never log or render arbitrary errors');
}
assert.ok(!fn('refreshKeys').includes('pendingKeyChecks.has'), 'pending is advisory');
assert.ok(fn('refreshKeys').includes('keyChecks.rejected.has'));
// api_key_status may expose only the exact final four characters of a stored key.
const suffixFn = ai.slice(ai.indexOf('fn last4('), ai.indexOf('fn last4_path('));
const keyStatus = ai.slice(ai.indexOf('fn key_status_locked('), ai.indexOf('fn custom_request_settings('));
const statusIPC = ai.slice(ai.indexOf('pub fn api_key_status('), ai.indexOf('/// Check credentials'));
assert.ok(keyStatus.includes('let suffix = key.as_deref().map(last4).unwrap_or_default();'));
assert.ok(keyStatus.includes('(has, suffix)'));
assert.ok(statusIPC.includes('key_status_with_error_locked(provider)') && statusIPC.includes('suffixes.insert(provider.into(), json!(suffix));'));
assert.ok(statusIPC.includes('"last4": suffixes'));
assert.ok(!/println!|eprintln!|dbg!|log::|tracing::/.test(suffixFn + keyStatus + statusIPC), 'key status never logs fragments');
assert.ok(!/json!\(key\)|"key"\s*:|"prefix"\s*:|"length"\s*:/.test(statusIPC), 'IPC has no raw key, prefix or length');
// Execute the actual Rust suffix function, independently of filesystem/socket fixtures.
const suffixFixture = mkdtempSync(join(tmpdir(), 'rv-last4-safety-'));
try {
  const source = join(suffixFixture, 'suffix.rs'), binary = join(suffixFixture, 'suffix');
  writeFileSync(source, suffixFn + `
fn main() {
    for key in ["", "a", "ab", "abc", "abcd", "abcde", "synthetic-status-key-AB12", "앞중간끝😀한글末"] {
        let chars: Vec<char> = key.chars().collect();
        let expected: String = if chars.len() < 4 { String::new() }
            else { chars[chars.len() - 4..].iter().collect() };
        let suffix = last4(key);
        assert_eq!(suffix, expected);
        assert!(suffix.is_empty() || suffix.chars().count() == 4);
    }
}
`);
  execFileSync('rustc', ['--edition=2021', source, '-o', binary], {stdio:'pipe'});
  execFileSync(binary, [], {stdio:'pipe'});
} finally { rmSync(suffixFixture, {recursive:true,force:true}); }
assert.ok(fn('renderKeyRows').includes('keyLast4(st.last4?.[p])') && fn('renderKeyRows').includes('keyLast4(st.last4?.custom)'));
assert.ok(fn('refreshKeys').includes('keyLast4(st.last4?.[aiProvider])'));
assert.ok(!/String\(st\.last4|escapeHtml\(st\.last4|\$\{st\.last4/.test(fn('renderKeyRows') + fn('refreshKeys')), 'raw IPC suffix never bypasses four-character validation');
console.log('PASS Rust suffix and status IPC wiring expose only the final four characters; both frontend displays validate suffixes');
assert.ok(!main.includes('data-kc-try'), 'saved keys need no explicit trial gate');
// Detect plausible live-key literals without printing any match.
for (const path of ['src/main.ts','src/ravi-key.ts','src/desktop-copy.ts','src-tauri/src/ai.rs','scripts/check-ravi-key.mjs']) {
  const contents=read(path);
  assert.ok(!/AIza[A-Za-z0-9_-]{35}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}|gsk_[A-Za-z0-9]{40,}/.test(contents), 'possible live-key literal in a key-fix file');
}
await import('./check-ravi-key.mjs');
console.log('PASS safe structured IPC, key/body/log guards and saved-key regression scenarios');
