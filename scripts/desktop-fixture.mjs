// Shared synthetic desktop fixture for real-Chrome harnesses (home, contrast, sales mode).
// Serialized into the page before ANY production code runs. Only public synthetic
// metadata, never mnemonic/private-key/password/account-public-key material.
export function installFixture({theme, sales, seller = false}) {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('ravenvault-theme', theme);
  localStorage.setItem('playx-raven-lang', 'ko');
  localStorage.setItem('rv-ravi-start-off', '1');
  localStorage.setItem('rv-companion-page', 'home');
  if (seller) localStorage.setItem('rv-seller-mode', '1');
  const calls = [], unavailable = [], forbidden = [], callbacks = new Map(); let callbackId = 1;
  window.__homeFixture = {calls, unavailable, forbidden};
  const txs = Array.from({length:8}, (_, i) => ({
    txid: `public-home-fixture-${i}`, time:1791500400 - i * 3600,
    category:i % 3 === 1 ? 'send' : 'receive', amount:i % 3 === 1 ? -1.25 : 3.5 + i,
    confirmations:i ? 18 + i : 2, asset_name:i === 2 ? 'HOMEFIT/COFFEE' : '',
  }));
  const shop = sales ? {name:'동네 가게', chain_asset:'HOMEFIT/SHOP', currency:'KRW', hours:[], items:[]} : {};
  const data = {
    node_status:{progress:1, blocks:4000000, headers:4000000, connections:8, chain:'regtest'},
    wallet_balance:{confirmed:42.125, unconfirmed:3.5, immature:0, total:45.625},
    wallet_lock_state:{encrypted:true, unlocked:true},
    backup_survey:{automatic:{local_complete:true}, items:[]}, backup_auto:{skipped:true},
    recent_transactions:txs, wallet_since:{transactions:txs, lastblock:'public-fixture-block'},
    list_assets:['COFFEE','TICKET','ART'].map((name,i) => ({name:`HOMEFIT/${name}`, root:'HOMEFIT', amount:i + 2, mine:false, units:0, reissuable:false, ipfs_hash:null})),
    api_key_status:{platform:'macos', available:{openai:true}, has_key:{openai:true}, storage:{openai:'keychain'}},
    model_settings:{}, ai_order_read:{customer:{order:['openai']}, owner:{order:['openai']}},
    ravi_consent:{reviewed:true, balance:false, transactions:false, shop:false},
    ravi_lifecycle_status:{lock:'open', active:0, tray:true}, ravi_take_close_request:false,
    companion_settings:{saved:true, settings:{greeting:false, notice_seen:true, enabled:true, size:160, locale:'ko', timezone:-540, battery:false}},
    shop_load:shop, ledger_range:{total:32500, currency:'KRW', sales:4, mixed_currency:false, unreadable_rows:0},
    ledger_pending:{count:2}, mode_get:{chosen:true, mode:'shop'},
    talk_rooms:[{name:'동네 소식', about:'오늘의 이야기'}], talk_read:[], talk_me:{pubkey:'public-home-fixture'}, talk_profiles:{},
    pin_list:[], owner_tokens:[], create_fingerprints:[], create_history_list:[], my_channels:{channels:[]},
    words_restore_status:null, reindex_progress:null, fee_owed:{owed:0},
    sweep_run:{swept:false, why:'disabled'}, sweep_read:{enabled:false},
    ipfs_status:{online:true, peers:3}, relay_status:{running:true}, tunnel_status:{running:false},
    map_status:{published:false}, map_load:{}, map_check:{ok:false, errors:[]},
    service_health:{state:'ok', node:true, ipfs:true, phone:true},
    services_status:{node:true, ipfs:true}, autostart_status:{enabled:false},
    miner_running:{running:false}, mac_miners:[], mining_status:{enabled:false},
    report_queue:[], report_pending:[], report_count:0, report_flush:null,
    ai_models_refresh:null, companion_signal:null, companion_save:null, voice_cancel:null,
    rvn_rate:{krw:25, price:25}, fee_read:{percent:1},
    member_groups:[], member_groups_list:[], member_privacy_get:{}, shop_seal_block_get:false,
    addr_book:[], backup_places:[], conf_read:{}, ipfs_config:{},
    datadir_status:{path:'/public-fixture', exists:true},
    node_identity:{name:'홈 배치 확인', id:'public-home-fixture'},
    money_status:{}, backup_pass_state:{configured:true},
    start_phone_server:{ip:'127.0.0.1', admin_url:'http://127.0.0.1:8790/admin', staff_url:'http://127.0.0.1:8790/staff', scan_url:'http://127.0.0.1:8790/scan', customer_url:'http://127.0.0.1:8790/'},
    // Existing startup may request shop publication. These are inert IPC stubs;
    // no native code, key derivation, HTTP or chain RPC is ever invoked.
    publish_shop:null, shop_announce:null, qr_svg:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>',
  };
  const invoke = async (command) => {
    calls.push(command); // Deliberately never retain arguments.
    if (/reveal|unlock|passphrase|send_rvn|send_asset|broadcast|sign_transaction|^sales_account_/.test(command)) {
      forbidden.push(command); throw Error('home fixture: forbidden command');
    }
    if (command === 'plugin:event|listen') return callbackId++;
    if (['plugin:event|unlisten','plugin:event|emit','plugin:event|emit_to'].includes(command)) return null;
    if (command === 'plugin:window|is_focused') return true;
    if (command === 'plugin:app|version') return '0.8.4';
    if (command === 'plugin:app|name') return 'RavenVault Desktop';
    if (command === 'plugin:updater|check') return null;
    if (Object.hasOwn(data, command)) return structuredClone(data[command]);
    unavailable.push(command);
    throw Error(`home fixture: unavailable ${command}`); // Unknown data never becomes a false success.
  };
  window.__TAURI_INTERNALS__ = {
    invoke, metadata:{currentWindow:{label:'main'}, currentWebview:{label:'main'}},
    transformCallback(fn, once = false) { const id=callbackId++; callbacks.set(id, value => {fn?.(value); if(once)callbacks.delete(id);}); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, value) { callbacks.get(id)?.(value); },
    convertFileSrc() { return 'data:,'; },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
  window.__TAURI__ = {core:{invoke}, event:{listen:async()=>()=>{}}};
  window.isTauri = true;
  window.WebSocket = class {constructor(){throw Error('home fixture: external socket blocked');}};
  window.WebTransport = class {constructor(){throw Error('home fixture: external transport blocked');}};
}
