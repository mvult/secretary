import { useEffect, useMemo, useRef, useState } from 'react';
import type { PomodoroStatus } from '../../lib/pomodoroNative';
import { isDangerousDuringWorkHours, normalizeAlias } from './usePomodoro';

interface PomodoroViewProps {
  status: PomodoroStatus | null;
  isLoading: boolean;
  isSubmitting: boolean;
  errorMessage: string;
  onRefresh: () => void;
  onSubmitUnlock: (alias: string, rationale: string) => void;
  onLock: (alias: string) => void;
}

function formatRemaining(nowUnixMs: number, unlockedUntilUnixMs: number | null) {
  if (!unlockedUntilUnixMs || unlockedUntilUnixMs <= nowUnixMs) {
    return '';
  }
  const totalSeconds = Math.max(0, Math.ceil((unlockedUntilUnixMs - nowUnixMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function PomodoroView({ status, isLoading, isSubmitting, errorMessage, onRefresh, onSubmitUnlock, onLock }: PomodoroViewProps) {
  const [alias, setAlias] = useState('');
  const [rationale, setRationale] = useState('');
  const [showOptionalRationale, setShowOptionalRationale] = useState(false);
  const aliasInputRef = useRef<HTMLInputElement | null>(null);
  const rationaleInputRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedTarget = useMemo(
    () => status?.targets.find((entry) => entry.alias === normalizeAlias(alias)) ?? null,
    [alias, status],
  );

  const showRationale = isDangerousDuringWorkHours(selectedTarget, status) || showOptionalRationale;
  const unlockedTargets = status?.targets.filter((entry) => entry.currentlyUnlocked && entry.unlockedUntilUnixMs) ?? [];

  useEffect(() => {
    setRationale('');
    setShowOptionalRationale(false);
  }, [selectedTarget?.alias]);

  useEffect(() => {
    aliasInputRef.current?.focus();
    aliasInputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    if (showRationale && !rationale.trim()) {
      rationaleInputRef.current?.focus();
      return;
    }
    void onSubmitUnlock(alias, rationale);
  };

  return (
    <section className="pomodoro-shell">
      <header className="page-header page-header-stacked">
        <p className="page-date">Focus</p>
        <div className="page-heading-row">
          <h2 className="page-title journal-stack-title">Pomodoro</h2>
        </div>
        <p className="settings-message">
          {status?.inWorkHours ? 'Work hours are active.' : 'Outside work hours.'} {status?.workHoursLabel ?? ''}
        </p>
      </header>

      <div className="pomodoro-grid">
        <section className="settings-card pomodoro-card">
          <div className="pomodoro-status-row">
            <div>
              <span className="settings-label">Enforcement</span>
              <p className="settings-message">
                {status?.helperReachable ? 'Helper connected.' : 'Helper unavailable.'}
              </p>
              {status?.helperSocketPath ? <p className="settings-message">Socket: <code>{status.helperSocketPath}</code></p> : null}
              {status?.helperError ? <p className="pomodoro-warning">{status.helperError}</p> : null}
              {errorMessage ? <p className="pomodoro-warning">{errorMessage}</p> : null}
            </div>
            <button type="button" className="sync-button" onClick={onRefresh} disabled={isLoading || isSubmitting}>
              Refresh
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <label className="settings-label" htmlFor="pomodoro-alias">Unlock app/site</label>
            <input
              id="pomodoro-alias"
              ref={aliasInputRef}
              className="settings-input"
              type="text"
              value={alias}
              placeholder="youtube, reddit, whatsapp, wa"
              onChange={(event) => {
                setAlias(event.target.value);
                setRationale('');
                setShowOptionalRationale(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault();
                  setShowOptionalRationale(true);
                  requestAnimationFrame(() => {
                    rationaleInputRef.current?.focus();
                  });
                }
              }}
            />
            <p className="settings-message">Known aliases: {status?.targets.map((entry) => entry.alias).join(', ') || 'loading...'}</p>

            {showRationale ? (
              <>
                <label className="settings-label" htmlFor="pomodoro-rationale">Rationale</label>
                <textarea
                  id="pomodoro-rationale"
                  ref={rationaleInputRef}
                  className="pomodoro-textarea"
                  value={rationale}
                  placeholder="Why do you need this right now?"
                  onChange={(event) => setRationale(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Tab' && event.shiftKey) {
                      event.preventDefault();
                      aliasInputRef.current?.focus();
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
                <p className="settings-message">Unlocks with a rationale during work hours are sent to the backend approval model.</p>
              </>
            ) : null}

            <div className="settings-actions">
              <button
                type="submit"
                className="sync-button"
                disabled={isLoading || isSubmitting}
              >
                {isSubmitting ? 'Working...' : 'Unlock'}
              </button>
            </div>
          </form>
        </section>

        <section className="settings-card pomodoro-card">
          <span className="settings-label">Currently unlocked</span>
          {unlockedTargets.length === 0 ? (
            <p className="settings-message">No active work-hours unlocks.</p>
          ) : (
            <div className="pomodoro-target-list">
              {unlockedTargets.map((target) => (
                <article key={target.alias} className="pomodoro-target-row">
                  <div>
                    <div className="pomodoro-target-title">{target.displayName}</div>
                    <p className="settings-message">{formatRemaining(status?.nowUnixMs ?? Date.now(), target.unlockedUntilUnixMs)}</p>
                  </div>
                  <button type="button" className="sync-button" onClick={() => void onLock(target.alias)} disabled={isSubmitting}>
                    Lock now
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
