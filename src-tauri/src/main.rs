// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the sidecar child process handle for cleanup on exit.
struct SidecarState(Mutex<Option<CommandChild>>);

const DEFAULT_PORT: u16 = 9876;
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// In dev mode (no custom-protocol feature), the user runs the Python backend
/// manually via `python app.py --dev`. In production, we spawn it as a sidecar.
fn is_production() -> bool {
    cfg!(feature = "custom-protocol")
}

/// Parse --port from CLI args, falling back to DEFAULT_PORT.
fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--port" {
            if let Some(p) = args.get(i + 1) {
                if let Ok(port) = p.parse::<u16>() {
                    return port;
                }
            }
        }
    }
    DEFAULT_PORT
}

fn main() {
    let port = parse_port();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            if is_production() {
                // Production: spawn the Python sidecar (FastAPI backend)
                let sidecar_cmd = app
                    .shell()
                    .sidecar("synced-server")
                    .expect("failed to create sidecar command")
                    .args(["--port", &port.to_string()]);

                let (mut rx, child) = sidecar_cmd
                    .spawn()
                    .expect("failed to spawn synced-server sidecar");

                // Store child handle for cleanup
                app.manage(SidecarState(Mutex::new(Some(child))));

                // Log sidecar output in background
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let text = String::from_utf8_lossy(&line);
                                eprintln!("[sidecar] {}", text.trim());
                            }
                            CommandEvent::Stderr(line) => {
                                let text = String::from_utf8_lossy(&line);
                                eprintln!("[sidecar:err] {}", text.trim());
                            }
                            CommandEvent::Terminated(payload) => {
                                eprintln!(
                                    "[sidecar] terminated with code {:?}, signal {:?}",
                                    payload.code, payload.signal
                                );
                            }
                            _ => {}
                        }
                    }
                });
            } else {
                // Dev mode: no sidecar — user runs `python app.py --dev` separately
                eprintln!("[tauri:dev] Expecting backend already running on port {}", port);
                app.manage(SidecarState(Mutex::new(None)));
            }

            // Poll until the backend is ready in a background task to avoid blocking the main thread
            tauri::async_runtime::spawn(async move {
                let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
                let deadline = Instant::now() + SIDECAR_TIMEOUT;
                let mut ready = false;

                while Instant::now() < deadline {
                    if TcpStream::connect_timeout(&addr, POLL_INTERVAL).is_ok() {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }

                if !ready {
                    eprintln!("ERROR: backend not reachable on port {} within {:?}", port, SIDECAR_TIMEOUT);
                    return;
                }

                // In production, navigate to the backend (devUrl handles this in dev mode)
                if is_production() {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let url: tauri::Url = format!("http://localhost:{}", port).parse().unwrap();
                        let _ = window.navigate(url);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill sidecar when the window is destroyed (no-op in dev mode)
                if let Some(state) = window.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                            eprintln!("[tauri] sidecar killed on window close");
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
