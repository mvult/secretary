import { useEffect, useState } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { hasRetainedTodoCommand, reconcileTodoStorageEvent, runTodoCommand, todoRecoveryEvent } from '../lib/todoCommandRecovery';

export function TodoCommandRecovery() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const update = () => {
      if (!active) return;
      try { setPending(hasRetainedTodoCommand()); }
      catch (err) { setError(String(err)); }
    };
    const recover = () => {
      update();
      void runTodoCommand(queryClient).then(() => { if (active) setError(''); }).catch((err) => {
        if (active && err.name !== 'TodoRecoveryBusy') setError(err.message);
      }).finally(update);
    };
    const storageChanged = async (event: StorageEvent) => {
      update();
      if (event.newValue !== null || !event.key?.startsWith('secretary:todo-command:v1:')) return;
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['todos'] }, { throwOnError: true }),
          queryClient.invalidateQueries({ queryKey: ['todoHistory'] }, { throwOnError: true }),
        ]);
        if (active) reconcileTodoStorageEvent(event);
      } catch (err) { if (active) setError(String(err)); }
    };
    recover();
    window.addEventListener('online', recover);
    window.addEventListener('storage', storageChanged);
    window.addEventListener(todoRecoveryEvent, update);
    return () => {
      active = false;
      window.removeEventListener('online', recover);
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener(todoRecoveryEvent, update);
    };
  }, [queryClient]);
  if (!pending && !error) return null;
  return <Alert mb="md" color="yellow" title="Retained TODO command">
    <Group justify="space-between">
      <Text size="sm">{error || 'The exact request is retained until server acknowledgment and live refresh complete.'}</Text>
      <Button size="xs" loading={busy} onClick={async () => {
        setBusy(true);
        try { await runTodoCommand(queryClient); setError(''); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
      }}>Retry / refresh</Button>
    </Group>
  </Alert>;
}
