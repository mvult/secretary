// mod pomodoro;
//
// pub fn run() {
//     tauri::Builder::default()
//         .manage(pomodoro::PomodoroShared::default())
//         .setup(|app| {
//             pomodoro::start_background_enforcer(app.handle().clone());
//             Ok(())
//         })
//         .invoke_handler(tauri::generate_handler![
//             pomodoro::pomodoro_status,
//             pomodoro::pomodoro_unlock,
//             pomodoro::pomodoro_lock,
//         ])
//         .run(tauri::generate_context!())
//         .expect("error while running tauri application");
// }
mod pomodoro;

// 1. Bring the ActivationPolicy enum into scope
use tauri::ActivationPolicy;

pub fn run() {
    tauri::Builder::default()
        .manage(pomodoro::PomodoroShared::default())
        .setup(|app| {
            // 2. Force macOS to register this process in the Dock and App Switcher
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(ActivationPolicy::Regular);
            }

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
