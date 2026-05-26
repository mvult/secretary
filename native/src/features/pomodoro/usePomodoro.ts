import { useCallback, useEffect, useMemo, useState } from 'react';
import { approvePomodoroUnlock } from '../../lib/backend';
import { getPomodoroStatus, lockPomodoroTarget, unlockPomodoroTarget, type PomodoroStatus, type PomodoroTargetStatus } from '../../lib/pomodoroNative';

interface UsePomodoroOptions {
  backendUrl: string;
  authToken: string;
}

const TARGET_ALIASES: Record<string, string> = {
  wa: 'whatsapp',
};

function normalizeAlias(rawAlias: string) {
  const alias = rawAlias.trim().toLowerCase();
  return TARGET_ALIASES[alias] ?? alias;
}

export function usePomodoro({ backendUrl, authToken }: UsePomodoroOptions) {
  const [status, setStatus] = useState<PomodoroStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await getPomodoroStatus();
      setStatus(nextStatus);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Pomodoro status failed.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const aliases = useMemo(() => status?.targets.map((entry) => entry.alias) ?? [], [status]);

  const submitUnlock = useCallback(async (rawAlias: string, rationale: string) => {
    const alias = normalizeAlias(rawAlias);
    const trimmedRationale = rationale.trim();
    if (!alias) {
      setErrorMessage('Enter an app or site alias.');
      return;
    }
    const target = status?.targets.find((entry) => entry.alias === alias) ?? null;
    if (!target) {
      setErrorMessage(`Unknown alias ${alias}. Known aliases: ${aliases.join(', ')}.`);
      return;
    }

    setIsSubmitting(true);
    try {
      let minutes = 10;
      if (status?.inWorkHours && (target.dangerous || Boolean(trimmedRationale))) {
        if (!authToken || !backendUrl.trim()) {
          throw new Error('Unlock approvals require a synced backend session.');
        }
        if (!trimmedRationale) {
          throw new Error('Unlock approvals require a rationale.');
        }
        const approval = await approvePomodoroUnlock(backendUrl, authToken, alias, trimmedRationale);
        if (approval.decision !== 'approve') {
          throw new Error(approval.reason || `${target.displayName} was denied.`);
        }
        minutes = approval.time;
      }
      const nextStatus = await unlockPomodoroTarget(alias, minutes, trimmedRationale || undefined);
      setStatus(nextStatus);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unlock failed.');
    } finally {
      setIsSubmitting(false);
    }
  }, [aliases, authToken, backendUrl, status]);

  const lock = useCallback(async (alias: string) => {
    setIsSubmitting(true);
    try {
      const nextStatus = await lockPomodoroTarget(alias);
      setStatus(nextStatus);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Lock failed.');
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  return {
    status,
    isLoading,
    isSubmitting,
    errorMessage,
    refresh,
    submitUnlock,
    lock,
  };
}

export function isDangerousDuringWorkHours(target: PomodoroTargetStatus | null, status: PomodoroStatus | null) {
  return Boolean(target?.dangerous && status?.inWorkHours);
}

export { normalizeAlias };
