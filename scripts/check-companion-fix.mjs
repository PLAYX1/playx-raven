// Fixed copy and production presentation contracts; no live wallet/network calls.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import vm from 'node:vm';
const result=await build({entryPoints:['src/companion-copy.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const ctx={module:{exports:{}},exports:{}};vm.runInNewContext(result.outputFiles[0].text,ctx);
const {copy,companionCopy}=ctx.module.exports;
for(const [key,values] of Object.entries(companionCopy)){
  assert.equal(values.length,4);for(const lang of ['ko','en','ja','zh'])assert.ok(copy(key,lang).trim().length>0);
}
const read=p=>readFileSync(p,'utf8');
const css=read('src/ravi-companion.css'),ui=read('src/ravi-companion.ts'),native=read('src-tauri/src/ravi_companion.rs');
assert.match(css,/min-width:288px/);assert.doesNotMatch(css,/#bubble\{[^}]*min-width:0/);
assert.match(css,/background:transparent!important/);assert.match(css,/#companion:has/);
assert.doesNotMatch(css,/body\.opaque[^}]*background/);
assert.match(ui,/character.style.opacity='1'/);assert.match(ui,/assets\/ravi-scene.svg/);
assert.match(ui,/visibility\(config.visible\)/);
assert.match(native,/always_visible: false/);assert.match(native,/\.visible\(false\)/);
assert.match(native,/from_secs\(12\)/);assert.match(native,/value.alert_count = prior.alert_count/);
assert.match(native,/value.muted_day = prior.muted_day/);
assert.match(native,/set_icon_as_template\(false\)/);
assert.match(read('src-tauri/src/server.rs'),/ravi_companion::notify\("order"\)/);
assert.match(read('src-tauri/src/backup.rs'),/ravi_companion::notify\("backup"\)/);
assert.doesNotMatch(read('companion.html'),/id="preferences"/);
console.log(`PASS companion fix: ${Object.keys(companionCopy).length} × 4 localized strings, transparent shared SVG, readable bubble contracts, default-off/hidden initialization, native timeout and persistent notification limits`);
