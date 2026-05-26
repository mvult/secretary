mod pomodoro;

pub fn run() {
    tauri::Builder::default()
        .manage(pomodoro::PomodoroShared::default())
        .setup(|app| {
            pomodoro::start_background_enforcer(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pomodoro::pomodoro_status,
            pomodoro::pomodoro_unlock,
            pomodoro::pomodoro_lock,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
