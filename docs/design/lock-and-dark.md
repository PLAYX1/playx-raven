# 지갑 잠금 · 다크 돈 카드 (레이븐볼트 데스크탑 0.8.6)

대표 결정(2026-10-11): 「**(나) 잠금과 다크 카드를 먼저 구현해서 0.8.6 에 같이 넣는다**」. GPT-astra 토론 결과를 그대로 따른다.
창 모드 전체 설계는 `docs/design/window-modes.md`, 미니 창은 `docs/mini-window.md`.

## 1. 결정과 근거

| 결정 | 내용 | 근거 |
|---|---|---|
| ① 대기화면 진입 즉시 잠금 | 들어가는 순간 지갑 권한(서명·복구 단어·보내기·백업 내보내기·열쇠)을 **Rust 에서** 잠근다. 입금 표시는 읽기 전용으로 계속. | 대기화면은 손님이 보는 계산대 옆 화면이다. 「아무 키로 돌아감」만 있으면 지나가던 사람이 큰 창(보내기)에 닿는다. 화면만 덮는 것은 불충분 — IPC 가 실제로 거부되어야 한다. |
| 복귀는 인증 없이, 사용은 인증 | 대기화면을 끄면 **잠긴 기본 화면**으로 돌아간다. 지갑을 다시 쓰려면 지갑 암호(기존 `walletpassphrase` → 곧바로 `walletlock` 흐름). | 대기화면을 끄는 동작은 자주(하루 수십 번) — 거기서 암호를 물으면 대기화면을 안 쓴다. 돈을 쓸 때만 묻는다. |
| 시간 유예 없음 | 「n분 안에 돌아오면 그냥 열림」 같은 면제가 **없다**. 기본값에도 없다. | 유예는 「자리를 비운 사이」 를 그대로 열어 둔다. |
| 잠금 끄기 설정 없음 | 설정에 「대기화면 잠금 끄기」가 없다. | 끌 수 있으면 바쁜 가게는 끈다. |
| 매장용 읽기 전용 모드 | 설정 「표시 방식」에서 켠다. 같은 잠금 + 조회 화면(금액 가림 기본, 자산 이름도 가림, 거래 상세·주소·복구 단어·보내기 없음). 끌 때는 지갑 암호. | 하루 종일 조회 화면을 켜 두는 가게를 위한 대안(대기화면은 「아무 키로 끔」이 전제). |
| ② 다크 돈 카드 | 다크 테마에서 돈 화면(지갑 잔액·보내기 작성/검토)을 흰색으로 강제하던 규칙을 **폐지**. 정보 구조·강조 자리는 그대로, 어두운 표면·밝은 글자·경계 3:1·글자 4.5:1. 라이트는 흰 카드 그대로. | 흰 카드의 「안전 근거」(돈 화면이 눈에 띄어 실수가 준다)는 검증되지 않은 추정. 대신 「보내기 전 확인」·통화(RVN/자산)·주소·수수료·상태(「아직 보내지 않았어요」)를 **글자로** 적는다. |
| 복구 단어 = 별도 민감 화면 | 돈 카드와 묶지 않는다. 재인증(지갑 암호) 뒤에만 표시, **3분 자동 가림**(다시 보려면 재인증), 화면 캡처 보호 켬(기존), 단어 고르기·복사 막음 + 주의 문구, 윗줄 경고색 띠로 구별. | 복구 단어는 잔액과 위험 등급이 다르다 — 단어 = 지갑 전부. |
| 미니 창 항상 위 + 가장자리 | 「항상 위에」(기존) + 끌어 놓으면 가장자리 24px 안이면 붙음(기본 켬, 트레이에서 끔) + 트레이 「구석으로 보내기」 4곳. 새 플러그인 없음(`set_position` 만). | 도킹 바(작업 영역 예약)는 OS API 가 Tauri 밖이라 보류. |

## 2. 잠금 상태 기계 (`src-tauri/src/app_lock.rs`)

```
            standby_open / 트레이 「대기화면 켜기」          app_lock_now("store") (설정 단추)
 [열림] ─────────────────────────────────────▶ [잠김:standby] ◀──────────────▶ [잠김:store]
   ▲                                              │  standby_exit(인증 없음) → 잠긴 기본 화면(상태 그대로)
   │            app_unlock(지갑 암호 확인됨)       │  앱 종료·재시작 → 파일에서 읽어 그대로 잠김
   └──────────────────────────────────────────────┘  시간 경과 → 변화 없음(유예 없음)
```

- **단일 진실**: 메모리(`Mutex<State>`) + `app-lock.json`(0600, 원자적 쓰기). 화면(JS)은 `app_lock_state` 로 묻기만.
- 파일이 없으면 열림(처음 쓰는 사람). **망가졌거나 모르는 칸·모르는 이유·읽기 실패면 잠김**(안전한 쪽).
- `lock()` 은 이미 잠겨 있으면 이유만 바꾼다(더 풀어 주는 일은 없음). 저장이 실패해도 **메모리는 잠근다**. 동시에 노드 `walletlock`(암호 건 지갑이면 열려 있던 시간이 끝난다).
- `release()` 는 `app_unlock` 안에서만(시험이 개수를 센다).
- 대기화면 진입: `display_mode::open_standby` 맨 앞에서 `app_lock::lock("standby")` — 창을 만들거나 다시 쓰기 **전**(시험). 창 만들기가 실패해도 잠금은 남는다.
- 대기화면 끄기(`exit_standby`)는 잠금을 풀지 않는다(시험).

### 잠금 풀기 판단(`decide`, 순수 함수 · 시험)

| 노드에 물은 결과 | 백업 암호 봉투 | 결과 |
|---|---|---|
| 지갑 암호 있음 + 넣은 암호 맞음 | — | 풂(`verified_by: wallet`) |
| 지갑 암호 있음 + 틀림(-14) | — | 거절 + 연달아 틀림 수 증가(5번째부터 30·60·…·최대 900초 기다림) |
| 지갑 암호 **없음** | 있음 + 맞음 | 풂(`backup`) |
| 지갑 암호 없음 | 있음 + 틀림 | 거절 |
| 지갑 암호 없음 | 없음 | 풂(`none`) — 화면이 「이 지갑에는 암호가 없어 누구나 풀 수 있어요」를 말하고 단추가 「암호 없이 풀기」 ⚠️ 대표 결정 |
| 노드 응답 없음 | 있음 + 맞음 | 풂(`backup`) — 이 앱은 첫 암호를 걸 때 같은 암호로 봉투를 만든다 |
| 노드 응답 없음 | 없음/틀림 | 거절(「노드를 켠 뒤 다시」, 잠긴 화면에 「노드 켜기」 단추 = `services_start`) |

## 3. 화면

- **잠긴 기본 화면**(`src/app-lock.ts`·`app-lock.css`): 큰 창 전체를 덮는 `role=dialog aria-modal`. 덮개 밖은 전부 `inert`(잠긴 동안 새로 붙는 요소도 MutationObserver 로 즉시 inert). 라비 등장 규칙(`html[data-ravi-arriving]` 이 대화상자를 숨김)보다 이기게 했다. 내용: 제목·설명 · 「읽기 전용」 묶음(잔액·들어오는 중·최근 입금 3·노드 — `mini::snapshot` 가림 한 장, 주소·txid 없음) · 지갑 암호 칸 · 「대기화면 다시 켜기」.
- 잠기는 순간 정리: 모든 비밀번호 칸 비움, 복구 단어 창·12단어 되살리기 창 닫기, 열려 있던 보내기 검토 접기.
- 잠긴 채 켜진 창은 잠금을 푼 뒤 **한 번 다시 불러** 첫 준비(문지기에 막혔던 것)를 정상으로 돌린다.
- **매장용 읽기 전용**: 같은 덮개, 제목 「매장용 읽기 전용」. 금액·자산 이름은 Rust 가림이 꺼져 있어도 ••••(두 겹). 암호 칸은 「관리자: 잠금 풀기」 단추 뒤에 접혀 있다.
- **가림 끄기 막음**: 잠긴 동안 `mini_set` 이 금액 가리기·캡처 보호를 **끄는** 변경을 거절한다(켜는 것은 됨) — 미니 창·트레이 메뉴 둘 다 같은 함수.
- **다크 돈 카드**(`src/money-card.css`): `#w-balance`·`#send-compose`·`#send-review` 표면 #1a1c26, 경계 #6b7088(바깥 배경 대비 3.6~3.8:1), 흐린 글자 #b7bdd0. 입력 칸 경계도 같은 색. 라이트의 흰 카드 규칙(`ravi-home.css`)은 `:where()` 로 감싸 **옛 우선순위 그대로** 라이트에만 건다.
- **복구 단어 민감 화면**: `#sdw .sheet-box`·`#wrs .sheet-box` 다크 표면 #16171f + 윗줄 4px 경고색 띠. 「민감한 화면 — 복구 단어」 표시, 남은 시간 「화면 보호 켜짐 · N초 뒤에 단어를 저절로 가려요」, 복사·잘라내기·오른쪽 클릭·끌기 막음 + 「복사하지 마세요. 종이에 손으로 적어 주세요.」. 3분이 지나면 단어 배열을 비우고 암호 단계로(「시간이 지나 단어를 가렸어요」). 틀려서 다시 보여 줄 때는 다시 센다.
- 문구: 잠금 화면 한·영·일·중(`lockCopy`), 그 밖의 새 문구는 `dict.ts` en/ja/zh.

## 4. IPC 문지기 — 전수 표

`lib.rs` invoke_handler: 라비 작은 창 → 미니 창 → 대기화면 → **잠금** 순으로 명령 처리 **전에** 검사.
잠긴 동안은 **허용 목록(`LOCKED_ALLOWED`) 방식** — 목록에 없으면 거부, 새로 생기는 명령도 기본 거부.
등록 명령 507 개 중 허용 84 · **거부 423**(2026-10-11 기준, `scripts` 없이 lib.rs 에서 다시 셀 수 있음).

**허용(잠긴 동안)의 성격**: 잠금 자체(`app_lock_*`·`app_unlock`) · 읽기 전용 입금 표시(`mini_*`·`standby_*`·`display_mode_get`) · 라비 얼굴 움직임(설정 저장·받아쓰기 제외) · 종료 흐름(종료 전 지갑 잠금) · 상태 읽기(잔액·최근 거래·노드·모드 등 값만) · 노드 켜기(`services_start` — 암호 확인의 전제) · 힘을 줄이는 것(`lock_wallet`·`auto_disable`).

**반드시 거부(시험 `MUST_DENY`, 잠김 → 거부 / 풀림 → 통과)**: 보내기·서명(`send_rvn` `send_asset` `transfer_ownership` `move_owner_token` `send_from` `wallet_send_signed` `sign_message` `phone_transaction_*` `abandon_tx` `fee_pay` `pay_order` `refund*` `staff_refund` `reward_distribute` `swap_*` `fulfil_sale` `deliver_remote_sale` `auto_fulfil` `auto_deliver_web` `auto_enable` `sweep_run` `sweep_configure` `ledger_sweep` …) · 발행(`issue_*` `create_issue` `reissue` `tag/untag` `freeze/unfreeze`) · 지갑 암호·복구 단어·열쇠(`unlock_for` `encrypt_wallet` `change_passphrase` `reveal_seed` `sales_account_reveal` `cloud_key_show` `cloud_unlock` `backup_pass_set` `identity_*_key` `shop_key_move*` `words_restore_*`(상태 읽기 제외) `restore_apply`) · 백업 내보내기(`backup_now` `backup_zip` `backup_auto` `recovery_card_print` `ledger_export` `ledger_csv`) · 기기·권한·설정(`pairing_approve` `rotate_role_token` `start_phone_server` `install_update` `conf_*` `mode_set` `display_mode_set` `save_api_key` … `door_open`) · 라비 도구·AI·대화(`ravi_tool` `ravi_agent_chat` `ai_*` `voice_transcribe` `talk_post` …) · 새 주소(`new_address` `receive_address` `addr_new` `keypool_fill`).

**창 IPC 밖의 길(따로 막음)**: 폰·직원 HTTP `admin_issue`·`admin_backup`·`staff_refund_route` 는 인증 뒤 잠금이면 **423**(`REMOTE_LOCKED`), RV6 폰 승인 보내기(`pairing/net.rs send_rvn`)도 거절(시험 `phone_and_staff_money_paths_check_the_lock_first`).

### 모듈별 전수 표(lib.rs 등록 명령 507 개)

| 모듈 | 잠긴 동안 허용 | 잠긴 동안 **거부** |
|---|---|---|
| addrbook | — | `addr_book` `watch_add` `recv_qr` `addr_new` `addr_label` |
| ai | `api_key_status` `ai_order_read` `model_settings` | `save_api_key` `save_device_api_key` `move_api_key_to_keychain` `delete_api_key` `ai_check_connection` `ai_debate` `ai_ask_owner` `ai_order_save` `ai_fill` `ai_read_image` `ai_answer` `ai_answer_any` `ai_chat` `ai_promo` `save_custom_provider` `ai_models_refresh` `ai_image` `image_save` `save_model` |
| app_lock | `app_lock_state` `app_unlock` `app_lock_now` | — |
| artist | — | `artist_pubkey` `artist_check` `artist_profile_get` `artist_profile_set` |
| auto | `auto_disable` `owner_tokens` | `auto_fulfil` `auto_usage` `auto_enable` `auto_deliver_web` `exposure` `confirmation_policy` `rebuild_delivered` |
| autostart | — | `autostart_get` `autostart_audit` `autostart_tidy` `autostart_set` |
| awake | `awake_status` | — |
| backup | `backup_survey` | `backup_now` `backup_auto` `backup_zip` `usb_lock_read` `usb_lock_set` `external_drives` `cloud_folders` `exclusive_check` `address_pool` `reveal_seed` |
| booking | — | `booking_slots` `booking_list` `booking_cancel` |
| boot | `boot_report` | — |
| cert_assets | — | `certificate_font_css` `certificate_marks` `certificate_mark_save` `certificate_mark_clear` `create_photos_save` `create_dropped_read` `create_dropped_read_in` |
| certificate | — | `create_print` `create_print_many` `certificate_file_save` `certificate_sample_open` `create_certificate_preview` |
| classes | — | `session_save` `session_list` `session_book` `session_cancel` `session_remove` |
| companion | — | `phone_transaction_review` `phone_transaction_send` |
| conf | — | `conf_options` `conf_templates` `conf_read` `conf_write` `dbcache_suggest` `dbcache_boost` `dbcache_restore` |
| create | — | `create_status` `create_names_taken` `create_issue` `create_tx_state` `create_dropped_fingerprint` |
| create_history | `create_fingerprints` `create_history_list` | `create_history_begin` `create_history_details` `create_history_get` `create_history_forget` `create_history_restart` `create_resolve` `create_unresolved` `create_resolve_not_sent` |
| devfee | `fee_owed` | `fee_pay` |
| display_mode | `display_mode_get` `standby_open` `standby_state` `standby_exit` | `display_mode_set` |
| door | — | `door_list` `door_save` `door_remove` `door_probe` `door_open` `door_log` `open_for_member` |
| drop_publish | — | `creator_dropped_list` `creator_dropped_read` `creator_cid_read` |
| electrum | `electrum_status` | `wallet_view` `chain_address` `wallet_send_signed` `address_assets` `holds_asset` |
| fanclub | — | `fan_rooms` `fan_announce` `fan_holders` |
| groupbuy | — | `gb_overview` `gb_window_set` `gb_wait_cancel` `gb_refund_mark` `gb_ship_set` |
| health | `autostart_status` `service_health` `money_status` | `default_paths` `autostart_enable` `autostart_disable` |
| helping | — | `help_round` |
| identity | — | `identity_paths` `identity_status` `identity_adopt_person_key` `identity_restore_legacy_key` |
| ipfs | `ipfs_status` `pin_list` | `check_alive` `pin_add` `pin_remove` `repo_size` `ipfs_set_storage_max` `content_kind` `read_metadata` `open_external` |
| ipfsconf | — | `ipfs_options` `ipfs_config_read` `ipfs_config_write` `ipfs_apply_profile` `chain_ipfs_link` |
| issue | — | `validate_name` `name_taken` `issue_asset` |
| issue2 | — | `asset_kinds` `reissue` `issue_many_unique` `issue_qualifier` `tag_address` `issue_restricted` `addresses_with_tag` `address_restrictions` `freeze` `unfreeze` `untag_address` `tags_for_address` `can_receive` |
| issue_unknown | — | `issue_unknown_mark` `issue_unknown_clear` `issue_unknown_check` |
| ledger | `ledger_range` `ledger_pending` | `ledger_csv` `ledger_export` `ledger_sweep` |
| lockbox | `backup_pass_state` | `cloud_key_show` `backup_pass_set` `cloud_unlock` |
| map | `map_load` `map_status` | `map_check` `map_publish` `map_unpublish` `map_presence_now` |
| member_privacy | — | `member_privacy_get` `member_privacy_state` `member_privacy_set` `member_groups_get` `member_groups_set` |
| mini | `mini_state` `mini_set` `mini_show` `mini_open_main` `mini_seen` | — |
| mining | `mining_status` `miner_running` `mac_miners` | `mining_reality` `mining_address` `mining_income` `miner_command` `miner_start` `miner_stop` `gpu_presets` `known_pools` `power_curve` `detect_gpu` |
| mode | `mode_get` | `mode_set` |
| moving | — | `move_offer` `move_cancel` `move_fetch` |
| msg | `my_channels` | `broadcast` `inbox` `subscribe` `pubsub_ready` `pubsub_send` |
| nodever | `node_version` | — |
| nostrpub | — | `nostr_publish` |
| pairing | — | `pairing_state` `pairing_show_qr` `pairing_cancel_qr` `pairing_approve` `pairing_reject` `pairing_unpair` `pairing_request_open` `pairing_request_done` `pairing_request_decline` `pairing_set_public_backup` `pairing_waiting` |
| pass | `today_ymd` | `member_groups_assign` `member_number` `member_save` `member_save_precheck` `list_members` `check_in_lookup` `check_in` `set_frozen` `extend` `add_months` `period_end` `add_visits` `rebuild_members` `unclaimed_numbers` `remove_member` `member_memo_add` `member_memo_delete` |
| paths | `datadir_status` | `datadir_set` |
| peers | — | `peer_list` `peer_add` `peer_remove` `pin_my_assets` `cid_alive` `peer_help` |
| place | — | `parse_coords` `distance_m` `directions_links` |
| prep | — | `pc_prepare` |
| price | `rvn_rate` | `quote_price` |
| raven | `node_status` `network_state` `list_assets` `wallet_balance` `recent_transactions` `wallet_since` `wallet_lock_state` | `new_address` `received_by_address` |
| ravi_agent | `ravi_consent` | `ravi_agent_chat` `ravi_consent_save` `ravi_audit` `ravi_tool_registry` `ravi_tool` `ravi_today` `ravi_greeting` `ravi_public_address` |
| ravi_companion | `companion_settings` `companion_open_main` `companion_show` `companion_bubble` `companion_sample` `companion_move` `companion_signal` `companion_click` `companion_dismiss` `companion_hold` | `companion_save` |
| ravi_lifecycle | `ravi_lifecycle_status` `ravi_take_close_request` `ravi_prepare_quit` `ravi_finish_quit` `ravi_cancel_quit` `ravi_hide_main` | — |
| ravi_voice | `voice_cancel` | `voice_open_microphone_settings` `voice_consent` `voice_set_consent` `voice_transcribe` |
| receive | — | `receive_address` `receive_qr_save` |
| recover | `node_identity` | `node_rename` `restore_survey` `restore_apply` `recovery_card` `recovery_card_print` `phone_lost_plan` `backup_folders` |
| refund | — | `refund` `refund_payer` `staff_refund` `staff_refund_limits` `foreign_spends` `note_our_tx` |
| rehearse | — | `rehearse_start` `rehearse_stop` `rehearse_reset` `rehearse_fund` `rehearse_confirm` `rehearse_status` `rehearse_issue` |
| reindex | — | `reindex_window` |
| reindex_run | `reindex_state` `reindex_progress` `sync_stalled` | `reindex_arm` `reindex_start` `node_log_tail` `chain_broken` `chain_heal` |
| relay | `relay_status` | — |
| remote_sales | — | `deliver_remote_sale` `retry_remote_completions` |
| report | — | `report_send` `report_flush` `report_parked` |
| rewards | — | `reward_ready` `reward_now` `reward_request` `reward_requests` `reward_cancel` `reward_snapshot` `reward_distribute` `reward_status` |
| roles | — | `role_catalogue` `role_limits` |
| sales_account | — | `sales_account_reveal` `sales_account_balance` |
| sample | — | `sample_check` `sample_fill` `sample_clear` |
| secure_update | `check_update` | `install_update` |
| send | — | `check_address` `address_history` `preview_send` `send_asset` `transfer_ownership` `send_rvn` `send_ack` `move_owner_token` |
| sendfee | — | `send_fee` |
| server | `qr_svg` | `start_phone_server` `publish_shop` `rotate_role_token` `logout_all_phones` `remote_admin_get` `remote_admin_set` `shop_seal_state` `shop_seal_block_set` `table_qr_sheet` `address_check` `now_ip` `all_local_ips` `publish_offer` `withdraw_offer` `pending_claims` `mark_sent` `load_orders` `order_states` `set_order_state` |
| services | `services_status` `services_start` | `services_stop` `open_shop` |
| setup | — | `inspect_machine` `recommend_setup` `recommend_setup_for` `disk_now` `apply_setup` |
| setupflow | — | `shop_setup` |
| shop | `shop_load` `fee_read` | `list_shops` `shop_name_free` `shop_asset_name` `shop_history` `build_shop_profile` `build_menu` `counter_confirmations` `unsellable` `shop_save` `shop_open_now` `incoming_payments` `split_payment` `theme_read` `theme_save` `pay_order` `broadcast_message` `shop_detect_asset` |
| shopkey | — | `shop_pubkey` `shop_announce` `shop_refresh` `shopkey_origin` |
| shopmove | — | `shop_key_move_plan` `shop_key_move` |
| spec | — | `suggest_setup` |
| stock | — | `stock_left` |
| swap | — | `swap_ready` `swap_make_lot` `swap_offer` `swap_check` `swap_take` |
| sweep | `sweep_read` | `sweep_configure` `sweep_run` `sweep_hold` `hours_save` `is_open` `set_manual` |
| talk | — | `talk_me` `talk_post` `talk_photo_post` `talk_read` `talk_rooms` `talk_replies` `talk_translate` `talk_make_room` `talk_my_assets` `talk_delete_request` `talk_profile_set` `talk_profiles` `recovery_status` |
| ticket | — | `ticket_find` `ticket_use` `ticket_list` `ticket_to_member` |
| trade | — | `trade_list` `trade_get` |
| tunnel | `tunnel_status` | `tunnel_install` `tunnel_start` `tunnel_stop` `public_base` `open_share` `share_targets` |
| upload | — | `ipfs_add_file` `ipfs_add_bundle` `build_metadata` `ipfs_keep_url` `ipfs_add_dropped` |
| vending | — | `sellable_assets` `pending_sales` `fulfil_sale` |
| wallet | `encryption_state` `lock_wallet` | `encrypt_wallet` `change_passphrase` `unlock_for` |
| walletx | — | `sign_message` `verify_message` `abandon_tx` `tx_detail` `fee_rate_set` `fee_rate_get` `keypool_fill` `send_from` `channels_mine` `channel_leave` |
| whose | — | `addr_whose` `owner_tokens_where` `owner_pin_ready` |
| words_restore | `words_restore_status` | `words_restore_preflight` `words_restore_check` `words_restore_start` `words_restore_rescan` `words_restore_abort` `words_restore_undo` `words_restore_close` |

## 5. 위험(확신도)

| 위험 | 확신도 | 메모 |
|---|---|---|
| 잠긴 동안 **자동 발송·매출 옮기기(sweep)·자동 백업이 멈춘다**(`auto_fulfil`·`auto_deliver_web`·`sweep_run`·`backup_auto` 거부). 주문은 대기열(pending_claims·웹 배송 목록)에 남아 풀린 뒤 보내진다고 **코드상** 판단 — 실제 가게 흐름으로는 미확인. | 중간 | 결정 ①의 문자 그대로(서명 잠금). 가게가 매장 모드를 하루 종일 켜면 자동 발송이 하루 늦어진다 → 대표 결정. |
| **지갑 암호도 백업 암호도 없는 지갑**은 인증 없이 풀린다(확인할 비밀이 없음). | 높음(사실) | 화면이 그렇다고 말한다. 대안: 암호 없는 지갑은 대기화면을 거절 / 잠금 해제용 별도 PIN — 대표 결정. |
| **노드가 고장 나고 백업 암호 봉투도 없으면** 잠금을 풀 수 없다(재시작해도 잠김). 노드 켜기는 되지만 노드 고치기(재색인 등)는 잠긴 동안 막힌다. | 중간 | 빠져나갈 길: 노드가 다시 켜지면 풀림. 최후 수단은 `app-lock.json` 삭제(파일 접근 = 이미 wallet.dat 접근). 사장에게는 어려움 — 대표 결정(재색인 허용 여부). |
| 잠긴 채 켜진 창은 풀린 뒤 한 번 새로고침 — 라비 등장이 한 번 더 나온다. | 높음 | 잠긴 동안 적은 것이 없어 잃는 것은 없다. |
| 허용 목록의 「상태 읽기」(잔액·최근 거래·주소록 아님)는 웹뷰 안 스크립트가 잠긴 동안에도 읽을 수 있다. | 중간 | 돈을 움직이지 못한다(읽기만). 매장 모드 화면은 이 값을 그리지 않는다. 더 좁히려면 `wallet_balance`·`recent_transactions` 를 빼면 된다(큰 창 뒤 화면이 「확인 중」으로 남음). |
| `walletlock` 은 잠그는 순간 한 번(비동기) — 그 사이 이미 시작된 송금 RPC 는 막지 못한다. | 중간 | 문지기는 즉시 막는다. 진행 중이던 한 건만 예외. |
| 캡처 보호(`content_protected`)가 맥 15+ ScreenCaptureKit 에서도 먹는지 | 낮음 | 기존 기능 그대로(창 모드 설계서 §10). |
| 앱 실행·실제 OS 창으로 확인하지 않았다(지시: 앱 실행 금지). 미니 창 자석(300ms 뒤 `set_position`)·구석 보내기는 순수 함수 시험만. | — | 첫 실행 확인 필요. |

## 6. 외부 보안 검토가 필요한 곳

1. `LOCKED_ALLOWED` 84 개가 정말 돈·열쇠와 무관한지(특히 `services_start`·`ravi_prepare_quit`·`check_update`·`map_load`·`shop_load`).
2. 창 IPC 밖 경로 전수: 폰·직원 HTTP 라우트 중 돈·열쇠를 건드리는 곳이 위 4개뿐인지(`server.rs` 6,000줄 — 이번에는 grep 으로 찾은 것만 막았다).
3. 잠금 풀기 백오프(메모리에만 — 앱을 다시 켜면 0)와 지갑 암호 무차별 대입 비용(노드 25,000 회 SHA-512 / 봉투 Argon2 기본값).
4. `app-lock.json` 을 같은 사용자 권한의 다른 프로그램이 지우면 풀린다 — 위협 모델상 그 프로그램은 wallet.dat 도 읽는다고 보았다. 확인 필요.

## 7. 되돌리는 법

- 잠금 전체: `lib.rs` 의 `app_lock::command_allowed` 검사 4줄 + `display_mode::open_standby` 의 `app_lock::lock("standby")` 1줄을 지우면 이전과 같다. 화면은 `main.ts` 의 `import "./app-lock";` 한 줄. 남아 있는 `app-lock.json` 은 지워도 된다.
- 폰·직원 HTTP 막음: `server.rs` 3곳·`pairing/net.rs` 1곳의 `crate::app_lock::is_locked()` 블록.
- 다크 돈 카드: `money-card.css` 의 다크 규칙을 지우고 `ravi-home.css` 의 라이트 두 줄을 옛 한 줄(조건 없는 흰색 강제)로 되돌린다.
- 복구 단어 자동 가림: `seed-check.ts` 의 `startTimer()` 두 곳.
- 미니 창 자석: 트레이 「가장자리에 붙이기」를 끄면 즉시 멈춤(설정 `snap`). 코드는 `mini.rs` `snap_after_drag` 호출 1줄.

## 8. 시험

| 무엇 | 명령 |
|---|---|
| Rust 잠금(허용 목록 전수·MUST_DENY 거부/통과·대기화면 진입 잠금 순서·끄기는 안 풂·유예/끄기 설정 없음·망가진 파일=잠김·재시작 유지·풀기 판단·백오프·폰/직원 경로) | `cargo test --lib -- app_lock` (11) |
| Rust 미니(잠긴 동안 가림·캡처 보호 못 끔 · 자석 · 구석) | `cargo test --lib -- mini` |
| 화면 규칙(4개 국어·오류 말·흰색 강제 라이트 전용·자동 가림 3분) | `node --test scripts/lock-dark.test.mjs` (5) |
| 실제 Chrome(잠긴 화면·inert·허용 밖 명령 거절·틀린/맞는 암호·대기화면 복귀·매장 모드·다크/라이트 돈 카드 대비·복구 단어 재인증·캡처 보호·복사 막음·자동 가림) | `node --test scripts/lock-dark-browser.test.mjs` (8) |
| 묶음 | `npm run test:lock` |
