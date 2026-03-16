mod cli;
mod constants;
#[cfg(target_os = "linux")]
pub mod linux_display;
#[cfg(target_os = "linux")]
pub mod linux_windowing;
mod logging;
mod markdown;
mod os;
mod server;
mod window_customizer;
mod windows;

use crate::cli::CommandChild;
use futures::FutureExt;
use std::{
    net::TcpListener,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager, RunEvent, State, ipc::Channel};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_specta::Event;
use tokio::{
    sync::{oneshot, watch},
    time::{sleep, timeout},
};

use crate::cli::{sqlite_migration::SqliteMigrationProgress, sync_cli};
use crate::constants::*;
use crate::windows::{LoadingWindow, MainWindow};

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
struct ServerReadyData {
    url: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Clone, Copy, serde::Serialize, specta::Type, Debug)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum InitStep {
    ServerWaiting,
    SqliteWaiting,
    Done,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
enum WslPathMode {
    Windows,
    Linux,
}

struct InitState {
    current: watch::Receiver<InitStep>,
}

struct ServerState {
    child: Arc<Mutex<Option<CommandChild>>>,
}

/// Resolves with sidecar credentials as soon as the sidecar is spawned (before health check).
struct SidecarReady(futures::future::Shared<oneshot::Receiver<ServerReadyData>>);

#[tauri::command]
#[specta::specta]
fn kill_sidecar(app: AppHandle) {
    let Some(server_state) = app.try_state::<ServerState>() else {
        tracing::info!("Server not running");
        return;
    };

    let Some(server_state) = server_state
        .child
        .lock()
        .expect("Failed to acquire mutex lock")
        .take()
    else {
        tracing::info!("Server state missing");
        return;
    };

    let _ = server_state.kill();

    tracing::info!("Killed server");
}

#[tauri::command]
#[specta::specta]
async fn await_initialization(
    state: State<'_, SidecarReady>,
    init_state: State<'_, InitState>,
    events: Channel<InitStep>,
) -> Result<ServerReadyData, String> {
    let mut current = init_state.current.clone();

    loop {
        let step = *current.borrow();
        let _ = events.send(step);

        if matches!(step, InitStep::Done) {
            break;
        }

        if current.changed().await.is_err() {
            break;
        }
    }

    state
        .0
        .clone()
        .await
        .map_err(|_| "Initialization failed".to_string())
}

#[tauri::command]
#[specta::specta]
fn check_app_exists(app_id: String) -> bool {
    os::check_app_exists(&app_id)
}

#[tauri::command]
#[specta::specta]
fn wsl_path(path: String, mode: WslPathMode) -> Result<String, String> {
    let mut cmd = Command::new("wsl");
    match mode {
        WslPathMode::Windows => {
            cmd.args(["wslpath", "-w", &path]);
        }
        WslPathMode::Linux => {
            cmd.args(["wslpath", "-u", &path]);
        }
    }

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
#[specta::specta]
fn resolve_app_path(app: AppHandle, app_id: String) -> Option<String> {
    os::resolve_app_path(&app, &app_id)
}

#[tauri::command]
#[specta::specta]
fn open_path(path: String) -> Result<(), String> {
    os::open_path(&path)
}

#[tauri::command]
#[specta::specta]
fn get_display_backend() -> String {
    #[cfg(target_os = "linux")]
    return linux_display::get_display_backend().to_string();

    #[cfg(not(target_os = "linux"))]
    return "unknown".to_string();
}

#[tauri::command]
#[specta::specta]
fn set_display_backend(backend: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux_display::set_display_backend(&backend);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = backend;
        return Err("Not supported".to_string());
    }
}

#[derive(tauri_specta::Event, serde::Serialize, Clone, Copy)]
struct LoadingWindowComplete;

async fn initialize(app: AppHandle) {
    let (tx, rx) = oneshot::channel();
    let (init_tx, init_rx) = watch::channel(InitStep::ServerWaiting);
    app.manage(SidecarReady(rx.shared()));
    app.manage(InitState { current: init_rx });

    let server_child = Arc::new(Mutex::new(None));
    app.manage(ServerState {
        child: server_child.clone(),
    });

    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind to a random port");
        listener
            .local_addr()
            .expect("Failed to get local address")
            .port()
    };
    let password = uuid::Uuid::new_v4().to_string();

    let (child, mut terminated) = cli::serve(&app, "127.0.0.1", port as u32, &password);
    *server_child.lock().unwrap() = Some(child);

    let url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();

    loop {
        tokio::select! {
            _ = terminated.as_mut() => {
                tracing::error!("Sidecar terminated unexpectedly during initialization");
                return;
            }
            res = client.get(format!("{url}/health")).send() => {
                if res.is_ok_and(|r| r.status().is_success()) {
                    break;
                }
            }
            _ = sleep(Duration::from_millis(100)) => {}
        }
    }

    let _ = init_tx.send(InitStep::SqliteWaiting);
    // Sync CLI after server is healthy so we can use its config
    let _ = sync_cli(app.clone()).await;

    let _ = tx.send(ServerReadyData {
        url,
        username: Some("opencode".to_string()),
        password: Some(password),
    });

    let _ = init_tx.send(InitStep::Done);

    let _ = LoadingWindowComplete.emit(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = make_specta_builder();

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let _ = std::process::Command::new("killall")
        .arg("opencode-cli")
        .output();

    let mut builder = tauri::Builder::default();

    #[cfg(not(target_os = "android"))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // Focus existing window when another instance is launched
                if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
            }))
            .plugin(tauri_plugin_deep_link::init());
    }

    builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::init(|builder| {
            builder
                .with_state_flags(window_state_flags())
                .with_denylist(&[LoadingWindow::LABEL])
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(crate::window_customizer::PinchZoomDisablePlugin);

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_decorum::init());
    }

    let mut builder = builder
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            let log_dir = app
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");
            // Hold the guard in managed state so it lives for the app's lifetime,
            // ensuring all buffered logs are flushed on shutdown.
            handle.manage(logging::init(&log_dir));

            specta_builder.mount_events(app);
            tauri::async_runtime::spawn(initialize(handle));

            Ok(())
        });

    if UPDATER_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                tracing::info!("Received Exit");

                kill_sidecar(app.clone());
            }
        });
}

fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Then register them (separated by a comma)
        .commands(tauri_specta::collect_commands![
            kill_sidecar,
            cli::install_cli,
            await_initialization,
            server::get_default_server_url,
            server::set_default_server_url,
            server::get_wsl_config,
            server::set_wsl_config,
            get_display_backend,
            set_display_backend,
            markdown::parse_markdown_command,
            check_app_exists,
            wsl_path,
            resolve_app_path,
            open_path
        ])
        .events(tauri_specta::collect_events![
            LoadingWindowComplete,
            SqliteMigrationProgress
        ])
}
