import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as read} from 'node:fs';
const source=p=>read(p,'utf8');
test('F03 automatic remote delivery uses durable order path, never direct transfer',()=>{
 const s=source('src-tauri/src/auto.rs').split('pub async fn auto_deliver_web(')[1].split('#[tauri::command]')[0];
 assert.ok(!s.includes('call_rpc("transfer"'), 'unguarded automatic transfer');
 assert.ok(s.includes('remote_sales::deliver'));
});
test('F03 manual remote delivery and retry queue live in Rust',()=>{
 const s=source('src/main.ts').split('async function 웹주문보내기(')[1].split('async function autoRound')[0];
 assert.ok(s.includes('deliver_remote_sale'));assert.ok(!s.includes('method: "POST"'));
 assert.ok(source('src/main.ts').includes('retry_remote_completions'));
});
test('F06 installation uses checked bytes through version policy',()=>{
 assert.ok(source('src-tauri/src/lib.rs').includes('secure_update::install_update'));
});
