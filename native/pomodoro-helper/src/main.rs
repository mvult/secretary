use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

const DEFAULT_SOCKET_PATH: &str = "/tmp/secretary-pomodoro-helper.sock";
const HOSTS_FILE: &str = "/etc/hosts";
const TAG: &str = "#secretary-pomo";

#[derive(Deserialize)]
struct HelperRequest {
    #[serde(rename = "type")]
    kind: String,
    domains: Vec<String>,
}

#[derive(Serialize)]
struct HelperResponse {
    ok: bool,
    error: Option<String>,
    domains: Vec<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let socket_path = parse_socket_path();
    if Path::new(&socket_path).exists() {
        fs::remove_file(&socket_path).map_err(|error| format!("Remove stale socket: {error}"))?;
    }
    let listener =
        UnixListener::bind(&socket_path).map_err(|error| format!("Bind socket: {error}"))?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o666))
        .map_err(|error| format!("Chmod socket: {error}"))?;

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_stream(stream) {
                    eprintln!("helper request failed: {error}");
                }
            }
            Err(error) => eprintln!("accept failed: {error}"),
        }
    }

    Ok(())
}

fn parse_socket_path() -> String {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--socket" {
            if let Some(path) = args.next() {
                return path;
            }
        }
    }
    env::var("SECRETARY_POMODORO_HELPER_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET_PATH.to_string())
}

fn handle_stream(mut stream: UnixStream) -> Result<(), String> {
    let mut request_line = String::new();
    {
        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|error| format!("Clone stream: {error}"))?,
        );
        reader
            .read_line(&mut request_line)
            .map_err(|error| format!("Read request: {error}"))?;
    }
    let request: HelperRequest = serde_json::from_str(request_line.trim())
        .map_err(|error| format!("Parse request: {error}"))?;
    let response = match request.kind.as_str() {
        "apply_domains" => match apply_domains(&request.domains) {
            Ok(domains) => HelperResponse {
                ok: true,
                error: None,
                domains,
            },
            Err(error) => HelperResponse {
                ok: false,
                error: Some(error),
                domains: Vec::new(),
            },
        },
        _ => HelperResponse {
            ok: false,
            error: Some(format!("Unknown helper request type {}", request.kind)),
            domains: Vec::new(),
        },
    };
    let payload =
        serde_json::to_vec(&response).map_err(|error| format!("Encode response: {error}"))?;
    stream
        .write_all(&payload)
        .map_err(|error| format!("Write response: {error}"))?;
    stream
        .write_all(b"\n")
        .map_err(|error| format!("Write response delimiter: {error}"))
}

fn apply_domains(domains: &[String]) -> Result<Vec<String>, String> {
    let normalized = normalize_domains(domains);
    let existing =
        fs::read_to_string(HOSTS_FILE).map_err(|error| format!("Read hosts file: {error}"))?;
    let (current_managed, mut lines) = split_hosts_file(&existing);

    if current_managed == normalized {
        return Ok(normalized);
    }

    if !normalized.is_empty() {
        while matches!(lines.last(), Some(line) if line.trim().is_empty()) {
            lines.pop();
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(format!("# Secretary Pomodoro managed entries {TAG}"));
        for domain in &normalized {
            lines.push(format!("127.0.0.1\t{domain} {TAG}"));
            lines.push(format!("::1\t{domain} {TAG}"));
        }
    }

    let mut output = lines.join("\n");
    if !output.ends_with('\n') {
        output.push('\n');
    }

    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(HOSTS_FILE)
        .and_then(|mut file| file.write_all(output.as_bytes()))
        .map_err(|error| format!("Write hosts file: {error}"))?;

    flush_dns_cache()?;
    Ok(normalized)
}

fn split_hosts_file(contents: &str) -> (Vec<String>, Vec<String>) {
    let mut managed = Vec::new();
    let mut unmanaged = Vec::new();
    let mut pending_blank_lines = Vec::new();

    for raw_line in contents.lines() {
        let line = raw_line.to_string();
        if line.contains(TAG) {
            managed.extend(extract_tagged_domains(&line));
            pending_blank_lines.clear();
            continue;
        }
        if line.trim().is_empty() {
            pending_blank_lines.push(line);
            continue;
        }
        unmanaged.append(&mut pending_blank_lines);
        unmanaged.push(line);
    }

    if managed.is_empty() {
        unmanaged.append(&mut pending_blank_lines);
    }

    (normalize_domains(&managed), unmanaged)
}

fn extract_tagged_domains(line: &str) -> Vec<String> {
    line.split_whitespace()
        .filter(|part| *part != TAG)
        .filter(|part| *part != "127.0.0.1")
        .filter(|part| *part != "::1")
        .filter(|part| !part.starts_with('#'))
        .map(|part| part.to_string())
        .collect()
}

fn normalize_domains(domains: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = domains
        .iter()
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn flush_dns_cache() -> Result<(), String> {
    let flush = Command::new("dscacheutil")
        .arg("-flushcache")
        .status()
        .map_err(|error| format!("Run dscacheutil: {error}"))?;
    if !flush.success() {
        return Err("dscacheutil -flushcache failed".to_string());
    }

    let hup = Command::new("killall")
        .args(["-HUP", "mDNSResponder"])
        .status()
        .map_err(|error| format!("Signal mDNSResponder: {error}"))?;
    if !hup.success() {
        return Err("killall -HUP mDNSResponder failed".to_string());
    }

    Ok(())
}
