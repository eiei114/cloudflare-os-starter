use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
pub const SERVICE: &str = "com.eisuke.pi-daemon";
pub fn state_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap()
            .join("Library/Application Support/eisuke-os-pi-daemon")
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().unwrap().join("CloudflareOSPiDaemon")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        dirs::state_dir().unwrap().join("eisuke-os-pi-daemon")
    }
}
fn json(path: &Path) -> Value {
    fs::metadata(path)
        .ok()
        .filter(|m| m.len() <= 4096)
        .and_then(|_| fs::read(path).ok())
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null)
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn label(dir: &Path, now: u64) -> (&'static str, bool) {
    let status = json(&dir.join("runtime-status.json"));
    if dir.join("receipt.json").exists() && !dir.join("daemon.lock").exists() {
        return ("要確認 — 自動再実行しません", false);
    }
    if !dir.join("daemon.lock").exists() {
        return ("停止中", false);
    }
    if dir.join("stop.request").exists() {
        return ("停止処理中", false);
    }
    let lock = json(&dir.join("daemon.lock"));
    if status["version"] != 1 || lock["pid"] != status["pid"] {
        return ("起動中／状態未確認", false);
    }
    let last = status["lastContactAt"].as_u64().unwrap_or(0);
    if last == 0 || last > now || now - last > 45_000 {
        return ("接続未確認／オフライン", false);
    }
    match status["phase"].as_str() {
        Some("running") => ("オンライン — 実行中", true),
        Some("stopping") => ("停止処理中", false),
        Some("attention") => ("要確認", false),
        _ => ("オンライン — 待機中", true),
    }
}
fn run(mut command: Command) -> io::Result<String> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            "サービス操作失敗。ログと端末登録を確認してください",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
#[cfg(target_os = "macos")]
fn launch(args: &[&str]) -> io::Result<String> {
    let mut c = Command::new("/bin/launchctl");
    c.args(args);
    run(c)
}
#[cfg(target_os = "macos")]
fn target() -> String {
    format!("gui/{}/{}", unsafe { libc::getuid() }, SERVICE)
}
#[cfg(target_os = "windows")]
fn powershell(script: &str) -> io::Result<String> {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("powershell.exe");
    c.creation_flags(0x08000000)
        .args(["-NoProfile", "-NonInteractive", "-Command", script]);
    run(c)
}
pub fn autostart() -> io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let text = launch(&[
            "print-disabled",
            &format!("gui/{}", unsafe { libc::getuid() }),
        ])?;
        Ok(!text
            .lines()
            .any(|l| l.contains(&format!("\"{SERVICE}\"")) && l.contains("disabled")))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(powershell("$ErrorActionPreference='Stop';(Get-ScheduledTask -TaskName 'com.eisuke.pi-daemon').Settings.Enabled")?.trim() == "True")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(io::Error::other("Mac/Windowsのみ対応"))
    }
}
pub fn set_autostart(enabled: bool) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        launch(&[if enabled { "enable" } else { "disable" }, &target()])?;
    }
    #[cfg(target_os = "windows")]
    {
        powershell(if enabled {
            "$ErrorActionPreference='Stop';Enable-ScheduledTask -TaskName 'com.eisuke.pi-daemon' | Out-Null"
        } else {
            "$ErrorActionPreference='Stop';Disable-ScheduledTask -TaskName 'com.eisuke.pi-daemon' | Out-Null"
        })?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err(io::Error::other("Mac/Windowsのみ対応"));
    }
    Ok(())
}
pub fn stop(dir: &Path) -> io::Result<()> {
    // Never delete locks, receipts, credentials or kill an arbitrary PID.
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(dir.join("stop.request")) {
        Ok(file) => file.sync_all(),
        Err(e)
            if e.kind() == io::ErrorKind::AlreadyExists
                && fs::symlink_metadata(dir.join("stop.request"))?.is_file() =>
        {
            Ok(())
        }
        Err(e) => Err(e),
    }
}
pub fn start(dir: &Path) -> io::Result<()> {
    if dir.join("daemon.lock").exists() {
        return Err(io::Error::other("既に稼働中、または停止未確認です"));
    }
    if dir.join("receipt.json").exists() {
        return Err(io::Error::other("中断記録あり。ローカル確認が必要です"));
    }
    let enabled = autostart()?;
    set_autostart(true)?;
    let result = (|| {
        match fs::remove_file(dir.join("stop.request")) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        #[cfg(target_os = "macos")]
        {
            // A disabled login service may not have been loaded in this GUI session.
            // Bootstrap only the preinstalled, fixed owner plist; never invent a command.
            if launch(&["print", &target()]).is_err() {
                let file = dirs::home_dir()
                    .unwrap()
                    .join("Library/LaunchAgents/com.eisuke.pi-daemon.plist");
                launch(&[
                    "bootstrap",
                    &format!("gui/{}", unsafe { libc::getuid() }),
                    file.to_str()
                        .ok_or_else(|| io::Error::other("Invalid service path"))?,
                ])?;
            }
            launch(&["kickstart", &target()])?;
        }
        #[cfg(target_os = "windows")]
        {
            powershell(
                "$ErrorActionPreference='Stop';Start-ScheduledTask -TaskName 'com.eisuke.pi-daemon'",
            )?;
        }
        Ok(())
    })();
    let restore = if !enabled {
        set_autostart(false)
    } else {
        Ok(())
    };
    result.and(restore)
}
pub fn restart(dir: &Path) -> io::Result<()> {
    stop(dir)?;
    for _ in 0..20 {
        if !dir.join("daemon.lock").exists() {
            return start(dir);
        }
        thread::sleep(Duration::from_secs(1));
    }
    Err(io::Error::other(
        "停止未確認。強制終了やlock削除は行いません",
    ))
}
pub fn open_board(dir: &Path) -> io::Result<()> {
    let s = json(&dir.join("runtime-status.json"));
    let origin = s["url"]
        .as_str()
        .filter(|u| valid_origin(u))
        .ok_or_else(|| io::Error::other("接続先未確認。まずデーモンを起動してください"))?;
    open(&format!(
        "{}/gatekeeper/custom/runner/#tasks",
        origin.trim_end_matches('/')
    ))
}
fn valid_origin(u: &str) -> bool {
    let Some(host) = u.strip_prefix("https://") else {
        return false;
    };
    !host.trim_end_matches('/').is_empty()
        && host
            .trim_end_matches('/')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}
pub fn open_logs(dir: &Path) -> io::Result<()> {
    // Open only service.log, never the config/credential files or entire private folder.
    let file = dir.join("service.log");
    open(
        file.to_str()
            .ok_or_else(|| io::Error::other("Invalid log path"))?,
    )
}
fn open(value: &str) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("/usr/bin/open");
        c.arg(value);
        run(c)?;
    }
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("explorer.exe");
        c.arg(value);
        run(c)?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut c = Command::new("xdg-open");
        c.arg(value);
        run(c)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_are_not_shell_or_file_urls() {
        assert!(valid_origin("https://os.example.com/"));
        for u in [
            "file:///secret",
            "http://os.example.com",
            "https://user@host",
            "https://host/exec",
            "https://host?x",
            "https://host\n",
        ] {
            assert!(!valid_origin(u));
        }
    }
    #[test]
    fn status_and_stop_preserve_interrupted_work() {
        let dir = std::env::temp_dir().join(format!("tray-test-{}", now_ms()));
        fs::create_dir(&dir).unwrap();
        assert_eq!(label(&dir, 10_000).0, "停止中");
        fs::write(dir.join("daemon.lock"), r#"{"pid":7}"#).unwrap();
        fs::write(
            dir.join("runtime-status.json"),
            r#"{"version":1,"pid":7,"phase":"idle","lastContactAt":1000}"#,
        )
        .unwrap();
        assert!(label(&dir, 10_000).1);
        assert!(!label(&dir, 50_000).1);
        fs::write(dir.join("receipt.json"), "unchanged").unwrap();
        stop(&dir).unwrap();
        assert_eq!(label(&dir, 10_000).0, "停止処理中");
        assert_eq!(
            fs::read_to_string(dir.join("receipt.json")).unwrap(),
            "unchanged"
        );
        fs::remove_file(dir.join("daemon.lock")).unwrap();
        assert_eq!(label(&dir, 10_000).0, "要確認 — 自動再実行しません");
        assert!(start(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
