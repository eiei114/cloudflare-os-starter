#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod control;
use fs2::FileExt;
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tao::{
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::{
    Icon, TrayIconBuilder,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};

fn icon(online: bool) -> Icon {
    let mut bytes = vec![0; 20 * 20 * 4];
    for y in 0..20 {
        for x in 0..20 {
            if (x as i32 - 10).pow(2) + (y as i32 - 10).pow(2) <= 64 {
                let i = (y * 20 + x) * 4;
                bytes[i..i + 4].copy_from_slice(if online {
                    &[25, 155, 80, 255]
                } else {
                    &[128, 128, 128, 255]
                });
            }
        }
    }
    Icon::from_rgba(bytes, 20, 20).unwrap()
}
fn main() {
    // CLI is useful for diagnostics without printing credentials or requiring a window.
    let dir = control::state_dir();
    if let Some(action) = std::env::args().nth(1) {
        let result = match action.as_str() {
            "--status" => {
                println!("{}", control::label(&dir, control::now_ms()).0);
                return;
            }
            "--start" => control::start(&dir),
            "--stop" => control::stop(&dir),
            "--restart" => control::restart(&dir),
            "--autostart-on" => control::set_autostart(true),
            "--autostart-off" => control::set_autostart(false),
            _ => Err(std::io::Error::other("Unknown action")),
        };
        if let Err(e) = result {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    // OS-held file lock: process exit releases it; no stale PID lock deletion/replay.
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let instance = options
        .open(dir.join("tray-instance.lock"))
        .expect("Install/pair the Pi daemon first");
    if instance.try_lock_exclusive().is_err() {
        return;
    }
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<()>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let menu = Menu::new();
    let status = MenuItem::new("Cloudflare OS — 確認中", false, None);
    let start = MenuItem::new("起動", true, None);
    let stop = MenuItem::new("停止", true, None);
    let restart = MenuItem::new("再起動", true, None);
    let auto = CheckMenuItem::new(
        "デーモンをログイン時に自動起動",
        true,
        control::autostart().unwrap_or(false),
        None,
    );
    let board = MenuItem::new("タスクボードを開く", true, None);
    let logs = MenuItem::new("ログを開く", true, None);
    let quit = MenuItem::new("操作アプリを終了（実行は継続）", true, None);
    menu.append_items(&[
        &status,
        &PredefinedMenuItem::separator(),
        &start,
        &stop,
        &restart,
        &auto,
        &PredefinedMenuItem::separator(),
        &board,
        &logs,
        &PredefinedMenuItem::separator(),
        &quit,
    ])
    .unwrap();
    let mut tray = None;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let mut busy = false;
    let mut last_tick = Instant::now() - Duration::from_secs(3);
    let mut error: Option<String> = None;
    event_loop.run(move |event, _, flow| {
        let _keep_instance_lock = &instance;
        *flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        if matches!(event, Event::NewEvents(_)) && tray.is_none() {
            tray = Some(
                TrayIconBuilder::new()
                    .with_menu(Box::new(menu.clone()))
                    .with_icon(icon(false))
                    .with_title("Pi")
                    .with_autosave_name("com.eisuke.pi-tray.status")
                    .with_tooltip("Cloudflare OS Pi control")
                    .build()
                    .expect("Tray unavailable"),
            );
            #[cfg(target_os = "macos")]
            if let Some(rl) = objc2_core_foundation::CFRunLoop::main() {
                objc2_core_foundation::CFRunLoop::wake_up(&rl);
            }
        }
        if let Ok(result) = rx.try_recv() {
            busy = false;
            error = result.err();
            auto.set_checked(control::autostart().unwrap_or(false));
            last_tick = Instant::now() - Duration::from_secs(3);
        }
        if last_tick.elapsed() >= Duration::from_secs(2) {
            let (text, online) = control::label(&dir, control::now_ms());
            status.set_text(format!(
                "Cloudflare OS — {}",
                error.as_deref().unwrap_or(text)
            ));
            if let Some(t) = &tray {
                let _ = t.set_icon(Some(icon(online)));
            }
            start.set_enabled(!busy && !dir.join("daemon.lock").exists());
            stop.set_enabled(!busy && dir.join("daemon.lock").exists());
            restart.set_enabled(!busy);
            auto.set_enabled(!busy);
            last_tick = Instant::now();
        }
        while let Ok(e) = MenuEvent::receiver().try_recv() {
            if e.id == *quit.id() {
                *flow = ControlFlow::Exit;
                return;
            }
            if busy {
                continue;
            }
            let id = e.id;
            let dir = dir.clone();
            let tx = tx.clone();
            let action = if id == *start.id() {
                0
            } else if id == *stop.id() {
                1
            } else if id == *restart.id() {
                2
            } else if id == *auto.id() {
                3
            } else if id == *board.id() {
                4
            } else if id == *logs.id() {
                5
            } else {
                continue;
            };
            let enabled = auto.is_checked();
            busy = true;
            error = None;
            thread::spawn(move || {
                let r = match action {
                    0 => control::start(&dir),
                    1 => control::stop(&dir),
                    2 => control::restart(&dir),
                    3 => control::set_autostart(enabled),
                    4 => control::open_board(&dir),
                    _ => control::open_logs(&dir),
                };
                let _ = tx.send(r.map_err(|e| e.to_string()));
            });
        }
    });
}
