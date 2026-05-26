use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const WORK_HOUR_START_MINUTE: u32 = 8 * 60;
const WORK_HOUR_END_MINUTE: u32 = 20 * 60;
const DEFAULT_UNLOCK_MINUTES: u32 = 10;
const MAX_UNLOCK_MINUTES: u32 = 60;
const HELPER_SOCKET_PATH: &str = "/tmp/secretary-pomodoro-helper.sock";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum TargetKind {
    Site,
    App,
}

#[derive(Clone, Copy)]
struct PomodoroTarget {
    alias: &'static str,
    display_name: &'static str,
    dangerous: bool,
    kind: TargetKind,
    site_domains: &'static [&'static str],
    process_match: Option<&'static str>,
}

const TARGETS: [PomodoroTarget; 10] = [
    PomodoroTarget {
        alias: "youtube",
        display_name: "YouTube",
        dangerous: true,
        kind: TargetKind::Site,
        site_domains: &[
            "youtube.com",
            "www.youtube.com",
            "youtu.be",
            "googlevideo.com",
            "youtube-nocookie.com",
            "youtube.googleapis.com",
            "youtubei.googleapis.com",
            "ytimg.com",
            "ytimg.l.google.com",
        ],
        process_match: None,
    },
    PomodoroTarget {
        alias: "reddit",
        display_name: "Reddit",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["reddit.com", "www.reddit.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "twitter",
        display_name: "Twitter / X",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["x.com", "www.x.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "metacritic",
        display_name: "Metacritic",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["www.metacritic.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "vox",
        display_name: "Vox",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["www.vox.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "nytimes",
        display_name: "New York Times",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["www.nytimes.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "realclearpolitics",
        display_name: "RealClearPolitics",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["www.realclearpolitics.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "breitbart",
        display_name: "Breitbart",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["breitbart.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "disqus",
        display_name: "Disqus",
        dangerous: false,
        kind: TargetKind::Site,
        site_domains: &["disqus.com"],
        process_match: None,
    },
    PomodoroTarget {
        alias: "whatsapp",
        display_name: "WhatsApp",
        dangerous: false,
        kind: TargetKind::App,
        site_domains: &[],
        process_match: Some("/Applications/WhatsApp.app/Contents/MacOS/WhatsApp"),
    },
];

const TARGET_ALIASES: [(&str, &str); 1] = [("wa", "whatsapp")];

#[derive(Default)]
pub struct PomodoroShared {
    last_helper_error: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedPomodoroState {
    unlocks: Vec<PersistedUnlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedUnlock {
    alias: String,
    unlocked_until_unix_ms: i64,
    rationale: Option<String>,
}

#[derive(Serialize)]
pub struct PomodoroStatus {
    now_unix_ms: i64,
    in_work_hours: bool,
    work_hours_label: String,
    helper_socket_path: String,
    helper_reachable: bool,
    helper_error: Option<String>,
    targets: Vec<PomodoroTargetStatus>,
    blocked_aliases: Vec<String>,
}

#[derive(Serialize)]
struct PomodoroTargetStatus {
    alias: String,
    display_name: String,
    dangerous: bool,
    kind: TargetKind,
    unlocked_until_unix_ms: Option<i64>,
    currently_unlocked: bool,
    currently_blocked: bool,
    rationale: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct HelperRequest {
    #[serde(rename = "type")]
    kind: String,
    domains: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct HelperResponse {
    ok: bool,
    error: Option<String>,
    domains: Vec<String>,
}

#[derive(Deserialize)]
pub struct UnlockCommand {
    alias: String,
    minutes: Option<u32>,
    rationale: Option<String>,
}

#[tauri::command]
pub fn pomodoro_status(shared: State<'_, PomodoroShared>) -> Result<PomodoroStatus, String> {
    let mut state = load_state()?;
    apply_policy(&mut state, &shared)
}

#[tauri::command]
pub fn pomodoro_unlock(
    command: UnlockCommand,
    shared: State<'_, PomodoroShared>,
) -> Result<PomodoroStatus, String> {
    let alias = command.alias.trim().to_lowercase();
    if find_target(&alias).is_none() {
        return Err(format!("Unknown target \"{}\".", command.alias.trim()));
    }
    let minutes = command
        .minutes
        .unwrap_or(DEFAULT_UNLOCK_MINUTES)
        .clamp(1, MAX_UNLOCK_MINUTES);
    let until = now_unix_ms() + i64::from(minutes) * 60_000;

    let mut state = load_state()?;
    state.unlocks.retain(|entry| entry.alias != alias);
    state.unlocks.push(PersistedUnlock {
        alias,
        unlocked_until_unix_ms: until,
        rationale: clean_optional_text(command.rationale),
    });
    save_state(&state)?;
    apply_policy(&mut state, &shared)
}

#[tauri::command]
pub fn pomodoro_lock(
    alias: String,
    shared: State<'_, PomodoroShared>,
) -> Result<PomodoroStatus, String> {
    let normalized = alias.trim().to_lowercase();
    let mut state = load_state()?;
    state.unlocks.retain(|entry| entry.alias != normalized);
    save_state(&state)?;
    apply_policy(&mut state, &shared)
}

pub fn start_background_enforcer(app: AppHandle) {
    let shared = PomodoroSharedHandle::from_state(app.state::<PomodoroShared>().inner());
    thread::spawn(move || loop {
        if let Ok(mut state) = load_state() {
            let _ = apply_policy_with_handle(&mut state, &shared);
        }
        thread::sleep(Duration::from_secs(120));
    });
}

#[derive(Clone, Default)]
struct PomodoroSharedHandle {
    last_helper_error: Arc<Mutex<Option<String>>>,
}

impl PomodoroSharedHandle {
    fn from_state(shared: &PomodoroShared) -> Self {
        Self {
            last_helper_error: Arc::clone(&shared.last_helper_error),
        }
    }

    fn set_helper_error(&self, value: Option<String>) {
        if let Ok(mut guard) = self.last_helper_error.lock() {
            *guard = value;
        }
    }
}

fn apply_policy(
    state: &mut PersistedPomodoroState,
    shared: &PomodoroShared,
) -> Result<PomodoroStatus, String> {
    let handle = PomodoroSharedHandle::from_state(shared);
    apply_policy_with_handle(state, &handle)
}

fn apply_policy_with_handle(
    state: &mut PersistedPomodoroState,
    shared: &PomodoroSharedHandle,
) -> Result<PomodoroStatus, String> {
    prune_state(state);
    save_state(state)?;

    let now = Local::now();
    let now_unix_ms = now_unix_ms();
    let in_work_hours = is_work_hours(now);
    let active_unlocks = active_unlock_map(state, now_unix_ms);
    let mut blocked_sites = Vec::new();
    let mut blocked_apps = Vec::new();
    let mut blocked_aliases = Vec::new();
    let mut statuses = Vec::with_capacity(TARGETS.len());

    for target in TARGETS {
        let unlock = active_unlocks.get(target.alias).cloned();
        let currently_unlocked = !in_work_hours || unlock.is_some();
        let currently_blocked = in_work_hours && !currently_unlocked;
        if currently_blocked {
            blocked_aliases.push(target.alias.to_string());
            blocked_sites.extend(target.site_domains.iter().map(|entry| (*entry).to_string()));
            if let Some(process_match) = target.process_match {
                blocked_apps.push(process_match.to_string());
            }
        }
        statuses.push(PomodoroTargetStatus {
            alias: target.alias.to_string(),
            display_name: target.display_name.to_string(),
            dangerous: target.dangerous,
            kind: target.kind,
            unlocked_until_unix_ms: unlock.as_ref().map(|entry| entry.unlocked_until_unix_ms),
            currently_unlocked,
            currently_blocked,
            rationale: unlock.and_then(|entry| entry.rationale),
        });
    }

    let helper_error = match sync_helper(&blocked_sites) {
        Ok(()) => {
            shared.set_helper_error(None);
            None
        }
        Err(error) => {
            shared.set_helper_error(Some(error.clone()));
            Some(error)
        }
    };

    if in_work_hours {
        for process_match in blocked_apps {
            let _ = Command::new("pkill").arg("-f").arg(process_match).status();
        }
    }

    Ok(PomodoroStatus {
        now_unix_ms,
        in_work_hours,
        work_hours_label: "Weekdays 8:00am-8:00pm (local time)".to_string(),
        helper_socket_path: helper_socket_path(),
        helper_reachable: helper_error.is_none(),
        helper_error,
        targets: statuses,
        blocked_aliases,
    })
}

fn load_state() -> Result<PersistedPomodoroState, String> {
    let path = state_file_path()?;
    if !path.exists() {
        return Ok(PersistedPomodoroState::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("Read pomodoro state: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("Parse pomodoro state: {error}"))
}

fn save_state(state: &PersistedPomodoroState) -> Result<(), String> {
    let path = state_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Create pomodoro state directory: {error}"))?;
    }
    let payload = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Encode pomodoro state: {error}"))?;
    fs::write(path, payload).map_err(|error| format!("Write pomodoro state: {error}"))
}

fn state_file_path() -> Result<PathBuf, String> {
    let home = env::var("HOME").map_err(|_| "HOME is not set.".to_string())?;
    Ok(Path::new(&home)
        .join("Library")
        .join("Application Support")
        .join("Secretary Outline")
        .join("pomodoro-state.json"))
}

fn prune_state(state: &mut PersistedPomodoroState) {
    let known_aliases: HashSet<&'static str> = TARGETS.iter().map(|entry| entry.alias).collect();
    let now = now_unix_ms();
    state.unlocks.retain(|entry| {
        known_aliases.contains(entry.alias.as_str()) && entry.unlocked_until_unix_ms > now
    });
    state
        .unlocks
        .sort_by(|left, right| left.alias.cmp(&right.alias));
}

fn active_unlock_map(
    state: &PersistedPomodoroState,
    now_unix_ms: i64,
) -> HashMap<String, PersistedUnlock> {
    state
        .unlocks
        .iter()
        .filter(|entry| entry.unlocked_until_unix_ms > now_unix_ms)
        .map(|entry| (entry.alias.clone(), entry.clone()))
        .collect()
}

fn is_work_hours(now: chrono::DateTime<Local>) -> bool {
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) {
        return false;
    }
    let minute = now.hour() * 60 + now.minute();
    minute >= WORK_HOUR_START_MINUTE && minute < WORK_HOUR_END_MINUTE
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn helper_socket_path() -> String {
    env::var("SECRETARY_POMODORO_HELPER_SOCKET").unwrap_or_else(|_| HELPER_SOCKET_PATH.to_string())
}

fn sync_helper(domains: &[String]) -> Result<(), String> {
    let socket_path = helper_socket_path();
    let mut stream = UnixStream::connect(&socket_path)
        .map_err(|error| format!("Connect helper at {}: {error}", socket_path))?;
    let request = HelperRequest {
        kind: "apply_domains".to_string(),
        domains: domains.to_vec(),
    };
    let payload =
        serde_json::to_vec(&request).map_err(|error| format!("Encode helper request: {error}"))?;
    stream
        .write_all(&payload)
        .map_err(|error| format!("Write helper request: {error}"))?;
    stream
        .write_all(b"\n")
        .map_err(|error| format!("Write helper delimiter: {error}"))?;
    let mut response_line = String::new();
    let mut reader = BufReader::new(stream);
    reader
        .read_line(&mut response_line)
        .map_err(|error| format!("Read helper response: {error}"))?;
    let response: HelperResponse = serde_json::from_str(response_line.trim())
        .map_err(|error| format!("Parse helper response: {error}"))?;
    if response.ok {
        Ok(())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Pomodoro helper failed.".to_string()))
    }
}

fn find_target(alias: &str) -> Option<PomodoroTarget> {
    let canonical_alias = TARGET_ALIASES
        .iter()
        .find_map(|(alternate, canonical)| (*alternate == alias).then_some(*canonical))
        .unwrap_or(alias);
    TARGETS
        .iter()
        .copied()
        .find(|entry| entry.alias == canonical_alias)
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}
