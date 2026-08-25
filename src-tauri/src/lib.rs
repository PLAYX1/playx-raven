mod ai;
mod auto;
mod awake;
mod backup;
mod classes;
mod conf;
mod door;
mod peers;
mod sample;
mod recover;
mod electrum;
mod health;
mod ipfs;
mod ipfsconf;
mod mining;
mod msg;
mod pass;
mod place;
mod price;
mod refund;
mod issue;
mod ledger;
mod issue2;
mod raven;
mod report;
mod roles;
mod send;
mod setup;
mod addrbook;
mod rewards;
mod stock;
mod booking;
mod trade;
mod walletx;
mod knowledge;
mod nostrpub;
mod paths;
mod sweep;
mod autostart;
mod mode;
mod reindex;
mod reindex_run;
mod tunnel;
mod vending;
mod wallet;
mod server;
mod services;
mod shop;
mod shopkey;
mod devfee;
mod ticket;
mod relay;
mod upload;
mod spec;
mod lockbox;
mod rehearse;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The owner token is minted once per run and lives only in memory.
        .manage(server::ServerState::default())
        .invoke_handler(tauri::generate_handler![
            raven::node_status,
            raven::network_state,
            raven::list_assets,
            raven::new_address,
            raven::wallet_balance,
            raven::recent_transactions,
            raven::received_by_address,
            raven::wallet_lock_state,
            ipfs::ipfs_status,
            ipfs::check_alive,
            ipfs::pin_add,
            ipfs::pin_remove,
            ipfs::pin_list,
            ipfs::repo_size,
            ipfs::ipfs_set_storage_max,
            ipfs::content_kind,
            ipfs::read_metadata,
            ipfs::open_external,
            issue::validate_name,
            issue::name_taken,
            issue::issue_asset,
            issue2::asset_kinds,
            issue2::reissue,
            issue2::issue_many_unique,
            issue2::issue_qualifier,
            issue2::tag_address,
            issue2::issue_restricted,
            issue2::addresses_with_tag,
            issue2::address_restrictions,
            issue2::freeze,
            issue2::unfreeze,
            issue2::untag_address,
            issue2::tags_for_address,
            issue2::can_receive,
            send::check_address,
            send::address_history,
            send::preview_send,
            send::send_asset,
            send::transfer_ownership,
            send::send_rvn,
            upload::ipfs_add_file,
            upload::ipfs_add_bundle,
            upload::build_metadata,
            shop::list_shops,
            shop::shop_name_free,
            shop::shop_asset_name,
            shop::shop_history,
            shop::build_shop_profile,
            shop::build_menu,
            shop::counter_confirmations,
            shop::shop_load,
            shop::unsellable,
            shop::shop_save,
            shop::shop_open_now,
            shop::incoming_payments,
            shop::split_payment,
            spec::suggest_setup,
            upload::ipfs_keep_url,
            report::report_send,
            report::report_flush,
            report::report_parked,
            rehearse::rehearse_start,
            rehearse::rehearse_stop,
            rehearse::rehearse_reset,
            rehearse::rehearse_fund,
            rehearse::rehearse_confirm,
            rehearse::rehearse_status,
            rehearse::rehearse_issue,
            addrbook::addr_book,
            addrbook::watch_add,
            addrbook::recv_qr,
            walletx::sign_message,
            walletx::verify_message,
            walletx::abandon_tx,
            walletx::tx_detail,
            walletx::fee_rate_set,
            walletx::fee_rate_get,
            walletx::keypool_fill,
            walletx::send_from,
            walletx::channels_mine,
            walletx::channel_leave,
            nostrpub::nostr_publish,
            shopkey::shop_pubkey,
            devfee::fee_owed,
            ticket::ticket_find,
            ticket::ticket_use,
            ticket::ticket_list,
            ticket::ticket_to_member,
            relay::relay_status,
            devfee::fee_pay,
            shopkey::shop_announce,
            shopkey::shop_refresh,
            stock::stock_left,
            booking::booking_slots,
            booking::booking_list,
            booking::booking_cancel,
            trade::trade_list,
            trade::trade_get,
            rewards::reward_ready,
            rewards::reward_now,
            rewards::reward_request,
            rewards::reward_requests,
            rewards::reward_cancel,
            rewards::reward_snapshot,
            rewards::reward_distribute,
            rewards::reward_status,
            addrbook::addr_new,
            addrbook::addr_label,
            shop::theme_read,
            shop::theme_save,
            shop::fee_read,
            shop::pay_order,
            shop::broadcast_message,
            ai::save_api_key,
            ai::delete_api_key,
            ai::api_key_status,
            ai::ai_order_read,
            ai::ai_debate,
            ai::ai_ask_owner,
            ai::ai_order_save,
            ai::ai_fill,
            ai::ai_answer,
            ai::ai_answer_any,
            ai::ai_chat,
            ai::save_custom_provider,
            ai::model_settings,
            ai::save_model,
            wallet::encryption_state,
            wallet::encrypt_wallet,
            wallet::change_passphrase,
            wallet::unlock_for,
            wallet::lock_wallet,
            vending::sellable_assets,
            vending::pending_sales,
            vending::fulfil_sale,
            auto::auto_fulfil,
            auto::auto_usage,
            auto::auto_enable,
            auto::auto_disable,
            auto::exposure,
            auto::owner_tokens,
            auto::confirmation_policy,
            auto::rebuild_delivered,
            msg::my_channels,
            msg::broadcast,
            msg::inbox,
            msg::subscribe,
            msg::pubsub_ready,
            msg::pubsub_send,
            pass::today_ymd,
            pass::member_number,
            pass::save_member,
            pass::list_members,
            pass::check_in_lookup,
            pass::check_in,
            door::door_list,
            door::door_save,
            door::door_remove,
            door::door_probe,
            door::door_open,
            door::door_log,
            door::open_for_member,
            pass::set_frozen,
            pass::extend,
            pass::add_months,
            pass::period_end,
            pass::add_visits,
            pass::rebuild_members,
            pass::unclaimed_numbers,
            pass::remove_member,
            refund::refund,
            refund::staff_refund,
            ledger::ledger_range,
            ledger::ledger_csv,
            ledger::ledger_export,
            ledger::ledger_pending,
            refund::staff_refund_limits,
            refund::foreign_spends,
            refund::note_our_tx,
            backup::backup_survey,
            backup::backup_now,
            backup::backup_auto,
            backup::backup_zip,
            backup::usb_lock_read,
            backup::usb_lock_set,
            lockbox::cloud_key_show,
            lockbox::backup_pass_set,
            lockbox::backup_pass_state,
            lockbox::cloud_unlock,
            backup::external_drives,
            backup::cloud_folders,
            sample::sample_check,
            sample::sample_fill,
            sample::sample_clear,
            peers::peer_list,
            peers::peer_add,
            peers::peer_remove,
            peers::pin_my_assets,
            recover::node_identity,
            recover::node_rename,
            recover::restore_survey,
            recover::restore_apply,
            recover::recovery_card,
            recover::recovery_card_print,
            recover::phone_lost_plan,
            recover::backup_folders,
            backup::exclusive_check,
            backup::address_pool,
            backup::reveal_seed,
            mining::mining_reality,
            mining::mining_address,
            mining::mining_income,
            mining::miner_command,
            mining::mining_status,
            mining::miner_start,
            mining::miner_stop,
            mining::miner_running,
            mining::gpu_presets,
            mining::known_pools,
            mining::power_curve,
            mining::detect_gpu,
            mining::mac_miners,
            electrum::electrum_status,
            electrum::wallet_view,
            electrum::chain_address,
            electrum::wallet_send_signed,
            electrum::address_assets,
            electrum::holds_asset,
            ipfsconf::ipfs_options,
            ipfsconf::ipfs_config_read,
            ipfsconf::ipfs_config_write,
            ipfsconf::ipfs_apply_profile,
            ipfsconf::chain_ipfs_link,
            classes::session_save,
            classes::session_list,
            classes::session_book,
            classes::session_cancel,
            classes::session_remove,
            services::services_status,
            services::services_start,
            services::services_stop,
            services::open_shop,
            setup::inspect_machine,
            setup::recommend_setup,
            setup::recommend_setup_for,
            setup::disk_now,
            setup::apply_setup,
            conf::conf_options,
            conf::conf_templates,
            conf::conf_read,
            conf::conf_write,
            paths::datadir_status,
            paths::datadir_set,
            health::default_paths,
            health::autostart_status,
            health::autostart_enable,
            health::autostart_disable,
            health::service_health,
            place::parse_coords,
            place::distance_m,
            place::directions_links,
            price::rvn_rate,
            price::quote_price,
            server::start_phone_server,
            server::publish_shop,
            reindex::reindex_window,
            reindex_run::reindex_state,
            reindex_run::reindex_arm,
            reindex_run::reindex_start,
            reindex_run::reindex_progress,
            mode::mode_get,
            mode::mode_set,
            awake::awake_status,
            autostart::autostart_get,
            autostart::autostart_set,
            tunnel::tunnel_status,
            tunnel::tunnel_install,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::public_base,
            tunnel::open_share,
            tunnel::share_targets,
            server::qr_svg,
            server::rotate_role_token,
            server::logout_all_phones,
            server::remote_admin_get,
            server::remote_admin_set,
            server::table_qr_sheet,
            server::address_check,
            server::now_ip,
            server::all_local_ips,
            sweep::sweep_configure,
            sweep::sweep_read,
            sweep::sweep_run,
            sweep::sweep_hold,
            sweep::hours_save,
            sweep::is_open,
            sweep::set_manual,
            roles::role_catalogue,
            roles::role_limits,
            server::publish_offer,
            server::withdraw_offer,
            server::pending_claims,
            server::mark_sent,
            server::load_orders,
            server::order_states,
            server::set_order_state,
        ])
        .setup(|app| {
            // 🔴 「장사」면 이 컴퓨터가 잠들지 않게 붙잡는다. 노드를 앱에서
            //    떼어 놓는 것만으로는 부족하다 — 컴퓨터가 자면 노드도 멈추고,
            //    밤새 들어온 입금이 아침까지 확인되지 않는다.
            //    「돕기」인 사람의 노트북은 건드리지 않는다(배터리는 그 사람 것).
            awake::sync_with_mode();
            // ── 창을 닫아도 가게는 계속 돈다 ────────────────────────────
            //
            // 🔴 X 를 누르면 앱이 통째로 끝나고 있었다. 그러면 **손님 폰
            // 서버(8790)가 같이 죽는다** — QR 을 찍어도 아무 화면이 안 뜨고,
            // 결제한 손님의 주문 상태가 안 바뀌고, 자동 발송과 채굴이 멈춘다.
            // `ravend` 는 별도 데몬이라 살아남지만, 가게는 이미 멈춘 뒤다.
            //
            // 계산대 컴퓨터는 원래 안 끄는 물건이다. X 는 **창을 치우는 것**이고,
            // 진짜로 끄는 것은 메뉴 막대에서 따로 고른다.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            use tauri::Manager;

            let open = MenuItem::with_id(app, "open", "PLAY X Raven 열기", true, None::<&str>)?;
            // "종료" 라고만 쓰면 창 닫기와 같은 것으로 읽힌다. 무엇이 멈추는지 쓴다.
            let quit = MenuItem::with_id(
                app,
                "quit",
                "완전히 끄기 (손님 주문도 멈춥니다)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("아이콘 없음")?)
                .tooltip("PLAY X Raven — 가게가 돌고 있습니다")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 아이콘을 그냥 누르면 창을 다시 연다. 메뉴를 열어야만
                    // 돌아올 수 있으면 아무도 못 찾는다.
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("main") {
                let h = app.handle().clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        // 끄지 않고 감춘다. 가게는 계속 돈다.
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            // 창 JS가 늦게 뜨거나 안 떠도 손님·직원 화면은 열려 있어야 한다.
            // 계산대는 화면이 아니라 포트다.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<server::ServerState>();
                    if let Err(e) = server::start_phone_server(state).await {
                        eprintln!("[phone] 자동 시작 실패: {e}");
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 🔴 Dock 아이콘을 눌러도 창이 안 나왔다.
            //
            // X 를 누르면 끄지 않고 **감춘다**(가게는 계속 돌아야 하니까).
            // 그런데 감춘 창을 다시 부르는 길이 메뉴막대 아이콘 하나뿐이었다.
            // macOS 는 Dock 아이콘을 누르면 `Reopen` 을 보내는데 아무도 듣지
            // 않아서, 사장은 프로그램이 사라진 줄 알고 다시 실행하려 했다.
            //
            // ⚠️ `has_visible_windows` 가 참이면 이미 보이는 창이 있다는 뜻이라
            //    그때 또 부르면 남의 창을 앞으로 끌어온다.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    // `Manager` 를 여기서 들인다 — 파일 위쪽에 두면 이 블록이
                    // 없는 다른 OS 빌드에서 "안 쓰는 import" 경고가 난다.
                    use tauri::Manager as _;
                    if let Some(w) = _app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                return;
            }
            // 앱이 끝나면 채굴기도 끝난다. 이게 없으면 창을 닫은 뒤에도
            // 채굴기가 살아남아 전기를 계속 먹는데, 화면에는 아무것도 없어서
            // 사장은 자기 돈이 나가는 줄 모른다.
            if matches!(event, tauri::RunEvent::Exit) {
                crate::mining::stop_on_exit();
            }
        });
}
