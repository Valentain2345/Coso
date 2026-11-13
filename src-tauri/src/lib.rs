use tauri::Manager;

/// Keep the window fully visible on small laptops: shrink to the monitor and
/// centre it instead of letting the title bar or player run off-screen.
/// Desktop-only: mobile WebviewWindows have no monitor/window-manager APIs.
#[cfg(desktop)]
fn fit_window(window: &tauri::WebviewWindow) {  let Ok(Some(monitor)) = window.current_monitor() else {
    return;
  };
  let scale = monitor.scale_factor();
  let screen = monitor.size().to_logical::<f64>(scale);
  let Ok(size) = window.inner_size() else {
    return;
  };
  let current = size.to_logical::<f64>(scale);

  // Room for the title bar and the taskbar/dock.
  let max_width = (screen.width - 40.0).max(760.0);
  let max_height = (screen.height - 120.0).max(560.0);
  let width = current.width.min(max_width);
  let height = current.height.min(max_height);

  if width < current.width || height < current.height {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
  }
  let _ = window.center();
}

/// Repair Windows shortcuts left pointing at a folder that no longer exists
/// (for example after the user moves or renames the install directory).
/// Windows shortcuts store an absolute target path, so moving the app breaks
/// them; this repoints any existing shortcut whose target is missing at the
/// running executable. Shortcuts that are gone entirely are left alone: the
/// installer creates them, and a user who deleted one did it on purpose.
///
/// Runs detached so a slow COM call never delays startup. Failures are
/// silently ignored — a stale shortcut is cosmetic, never fatal.
#[cfg(windows)]
fn fix_shortcuts() {
  use std::os::windows::process::CommandExt;
  use std::process::{Command, Stdio};

  let exe = match std::env::current_exe() {
    Ok(path) => match path.into_os_string().into_string() {
      Ok(path) => path,
      Err(_) => return,
    },
    Err(_) => return,
  };

  // The script reads the executable path from the environment so the source
  // contains no user-specific paths or quoting hazards.
  let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$exe = $env:COSO_EXE
if (-not $exe) { exit 0 }
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path $env:USERPROFILE 'Desktop\Coso.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Coso.lnk')
)
foreach ($lnk in $targets) {
  if (-not (Test-Path -LiteralPath $lnk)) { continue }
  $sc = $shell.CreateShortcut($lnk)
  $target = $sc.TargetPath
  if ($target -and (Test-Path -LiteralPath $target)) { continue }
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = Split-Path -Parent $exe
  $sc.IconLocation = "$exe,0"
  $sc.Save()
}
"#;

  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  // "powershell" is not guaranteed to be on PATH; resolve it absolutely and
  // fall back to PowerShell 7 when Windows PowerShell is absent.
  let windows_powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  let shell = if std::path::Path::new(windows_powershell).exists() {
    windows_powershell
  } else {
    "pwsh.exe"
  };
  let spawn = Command::new(shell)
    .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
    .env("COSO_EXE", &exe)
    .creation_flags(CREATE_NO_WINDOW)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn();

  // Fully detach: the app must not wait on the repair when closing.
  if let Ok(child) = spawn {
    std::thread::spawn(move || {
      let mut child = child;
      let _ = child.wait();
    });
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![uninstall_app])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        fit_window(&window);
      }
      #[cfg(all(desktop, windows))]
      fix_shortcuts();
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

/// Erase every recording and transcript, then launch the uninstaller.
///
/// Desktop (Windows) only: the app data folder holds the WebView profile with
/// the IndexedDB database, so removing it erases all user data. The NSIS
/// uninstaller then runs silently (it also removes the Start-menu and desktop
/// shortcuts) and the process exits immediately.
#[cfg(windows)]
#[tauri::command]
fn uninstall_app(app: tauri::AppHandle) -> Result<(), String> {
  use std::process::Command;
  use tauri::Manager;

  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("cannot resolve app data folder: {error}"))?;
  // Remove contents but keep the folder: WebView2 recreates it cleanly.
  if data_dir.exists() {
    std::fs::remove_dir_all(&data_dir)
      .map_err(|error| format!("could not erase app data: {error}"))?;
  }

  let exe = std::env::current_exe().map_err(|error| error.to_string())?;
  let install_dir = exe
    .parent()
    .ok_or_else(|| "could not resolve the install folder".to_string())?;
  let uninstaller = install_dir.join("uninstall.exe");
  Command::new(&uninstaller)
    .arg("/S")
    .spawn()
    .map_err(|error| format!("could not start the uninstaller: {error}"))?;
  std::process::exit(0);
}

#[cfg(not(windows))]
#[tauri::command]
fn uninstall_app() -> Result<(), String> {
  Err("Uninstalling from inside the app is only supported on Windows.".into())
}
