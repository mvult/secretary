import { invoke } from '@tauri-apps/api/core';

export type PomodoroTargetKind = 'site' | 'app';

export interface PomodoroTargetStatus {
  alias: string;
  displayName: string;
  dangerous: boolean;
  kind: PomodoroTargetKind;
  unlockedUntilUnixMs: number | null;
  currentlyUnlocked: boolean;
  currentlyBlocked: boolean;
  rationale: string | null;
}

export interface PomodoroStatus {
  nowUnixMs: number;
  inWorkHours: boolean;
  workHoursLabel: string;
  helperSocketPath: string;
  helperReachable: boolean;
  helperError: string | null;
  targets: PomodoroTargetStatus[];
  blockedAliases: string[];
}

function normalizeTarget(value: any): PomodoroTargetStatus {
  return {
    alias: typeof value?.alias === 'string' ? value.alias : '',
    displayName: typeof value?.display_name === 'string' ? value.display_name : typeof value?.displayName === 'string' ? value.displayName : '',
    dangerous: Boolean(value?.dangerous),
    kind: value?.kind === 'app' ? 'app' : 'site',
    unlockedUntilUnixMs: typeof value?.unlocked_until_unix_ms === 'number' ? value.unlocked_until_unix_ms : typeof value?.unlockedUntilUnixMs === 'number' ? value.unlockedUntilUnixMs : null,
    currentlyUnlocked: Boolean(value?.currently_unlocked ?? value?.currentlyUnlocked),
    currentlyBlocked: Boolean(value?.currently_blocked ?? value?.currentlyBlocked),
    rationale: typeof value?.rationale === 'string' ? value.rationale : null,
  };
}

function normalizeStatus(value: any): PomodoroStatus {
  return {
    nowUnixMs: typeof value?.now_unix_ms === 'number' ? value.now_unix_ms : typeof value?.nowUnixMs === 'number' ? value.nowUnixMs : Date.now(),
    inWorkHours: Boolean(value?.in_work_hours ?? value?.inWorkHours),
    workHoursLabel: typeof value?.work_hours_label === 'string' ? value.work_hours_label : typeof value?.workHoursLabel === 'string' ? value.workHoursLabel : '',
    helperSocketPath: typeof value?.helper_socket_path === 'string' ? value.helper_socket_path : typeof value?.helperSocketPath === 'string' ? value.helperSocketPath : '',
    helperReachable: Boolean(value?.helper_reachable ?? value?.helperReachable),
    helperError: typeof value?.helper_error === 'string' ? value.helper_error : typeof value?.helperError === 'string' ? value.helperError : null,
    targets: Array.isArray(value?.targets) ? value.targets.map(normalizeTarget) : [],
    blockedAliases: Array.isArray(value?.blocked_aliases) ? value.blocked_aliases.filter((entry: unknown): entry is string => typeof entry === 'string') : Array.isArray(value?.blockedAliases) ? value.blockedAliases.filter((entry: unknown): entry is string => typeof entry === 'string') : [],
  };
}

export async function getPomodoroStatus() {
  return normalizeStatus(await invoke('pomodoro_status'));
}

export async function unlockPomodoroTarget(alias: string, minutes = 10, rationale?: string) {
  return normalizeStatus(await invoke('pomodoro_unlock', { command: { alias, minutes, rationale } }));
}

export async function lockPomodoroTarget(alias: string) {
  return normalizeStatus(await invoke('pomodoro_lock', { alias }));
}
