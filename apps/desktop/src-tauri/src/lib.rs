//! The desktop app's Rust side: opens a workspace with docsync, decides
//! when to commit and sync, and answers the window's commands.

mod cloud;
mod commands;
mod database_pages;
mod databases;
mod devlog;
mod git;
mod github;
mod locations;
mod menu;
mod page_assets;
mod page_properties;
mod person;
mod search;
mod session;
mod tree;
mod updater;
mod worker;
mod workspaces;

use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Release builds only: see updater.rs.
    let updates = updater::configured(context.config());
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    if updates {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .register_asynchronous_uri_scheme_protocol(page_assets::PROTOCOL, page_assets::serve)
        .menu(menu::build)
        .manage(commands::AppState::default())
        .manage(updater::UpdateState::default())
        .setup(move |app| {
            if let Ok(dir) = app.path().app_log_dir()
                && let Err(e) = devlog::set_file(&dir.join("sawmill.log"))
            {
                eprintln!("Can't write the log file in {}: {e}", dir.display());
            }
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                devlog::error("app", format!("Crashed: {info}"));
                default_hook(info);
            }));
            let handle = app.handle().clone();
            devlog::set_sink(move |entry| {
                let _ = handle.emit("dev-log", entry);
            });
            devlog::info(
                "app",
                format!(
                    "Started {} {} ({})",
                    app.package_info().name,
                    app.package_info().version,
                    app.config().identifier
                ),
            );
            if updates {
                updater::start(app.handle());
            }
            if let Ok(dir) = app.path().resource_dir() {
                git::set_bundled_dir(dir.join("git"));
            }
            if let Ok(dir) = app.path().app_config_dir() {
                session::init_install_id(&dir);
            }
            commands::load_identity(app.handle());
            let handle = app.handle().clone();
            // Debug builds keep the sign-in in a file: see github::init.
            let dev_file = cfg!(debug_assertions)
                .then(|| app.path().app_config_dir().ok())
                .flatten()
                .map(|dir| dir.join("dev-sign-in.json"));
            github::init(&app.config().identifier, dev_file, move || {
                handle.state::<commands::AppState>().account_changed();
                let _ = handle.emit("account-changed", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                devlog::debug(
                    "app",
                    if *focused {
                        "Window focused"
                    } else {
                        "Window lost focus"
                    },
                );
                if *focused {
                    window.state::<commands::AppState>().window_focused();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::restore_workspace,
            commands::open_workspace,
            commands::clone_workspace,
            commands::create_workspace,
            commands::join_workspace,
            commands::show_workspace_folder,
            commands::workspace_info,
            commands::rename_workspace,
            commands::set_device_name,
            commands::set_person_name,
            commands::close_workspace,
            commands::list_workspaces,
            commands::forget_workspace,
            commands::locate_workspace,
            commands::move_workspace,
            commands::cloud_folders,
            commands::create_folder_workspace,
            commands::folder_remote_place,
            commands::folder_place,
            commands::workspaces_in_folder,
            commands::sync_through_folder,
            commands::locate_sync_folder,
            commands::move_out_of_cloud,
            commands::workspace_deletion_info,
            commands::delete_workspace,
            commands::set_remote,
            commands::github_account,
            commands::github_sign_in_mode,
            commands::github_sign_in_browser,
            commands::github_workspaces,
            commands::create_github_workspace,
            commands::github_sign_in_start,
            commands::github_sign_in_finish,
            commands::github_sign_in_cancel,
            commands::github_sign_out,
            commands::github_access,
            commands::github_create_repo,
            commands::sync_status,
            commands::sync_now,
            commands::list_pages,
            commands::read_page,
            commands::import_markdown,
            commands::search_text,
            commands::write_page,
            commands::create_page,
            commands::rename_page,
            commands::move_page,
            commands::set_page_display,
            commands::delete_page,
            commands::resolve_conflict,
            page_assets::add_page_asset,
            database_pages::create_database_page,
            database_pages::set_page_database,
            database_pages::set_page_view,
            page_properties::add_page_property,
            page_properties::update_page_property,
            page_properties::delete_page_property,
            page_properties::set_page_property_value,
            databases::list_databases,
            databases::read_database,
            databases::create_database,
            databases::rename_database,
            databases::delete_database,
            databases::add_column,
            databases::update_column,
            databases::delete_column,
            databases::add_row,
            databases::set_cell,
            databases::set_row_positions,
            databases::delete_row,
            commands::dev_info,
            commands::dev_log_entries,
            commands::dev_log_clear,
            commands::dev_log_add,
            commands::show_log_file,
            updater::update_ready,
            updater::restart_to_update,
        ])
        .run(context)
        .expect("error while running the app");
}
