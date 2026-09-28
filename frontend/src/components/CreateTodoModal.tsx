import { useState, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, Select, Textarea, Button, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { hasRetainedTodoCommand, runTodoCommand, todoRecoveredEvent } from '../lib/todoCommandRecovery';
import { TODO_STATUS_OPTIONS } from '../lib/status';
import { TodoStatus, CreateTodoRequest } from '@secretary/api/gen/todos_pb';

interface CreateTodoModalProps {
  opened: boolean;
  onClose: () => void;
  userId: bigint;
}

export function CreateTodoModal({ opened, onClose, userId }: CreateTodoModalProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState<string>('2'); // Default In Progress
  const submitted = useRef<{ id: string; form: string } | null>(null);
  const form = JSON.stringify([String(userId), name, desc, status]);
  useEffect(() => {
    const recovered = (event: Event) => {
      if (!submitted.current || (event as CustomEvent).detail.mutationId !== submitted.current.id) return;
      if (submitted.current.form === form) {
        setName(''); setDesc(''); setStatus('2'); onClose();
      }
      submitted.current = null;
    };
    window.addEventListener(todoRecoveredEvent, recovered);
    return () => window.removeEventListener(todoRecoveredEvent, recovered);
  }, [form, onClose]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (hasRetainedTodoCommand()) throw new Error('Recover the retained TODO command first.');
      const mutationId = crypto.randomUUID();
      submitted.current = { id: mutationId, form };
      await runTodoCommand(queryClient, { operation: 'create', request: new CreateTodoRequest({
        protocolVersion: 1, mutationId,
        userId,
        name,
        desc,
        status: Number(status) as TodoStatus,
      }) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] });
      notifications.show({ title: 'Success', message: 'Todo created', color: 'green' });
    },
    onError: (err: any) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' });
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Create New Task">
      <Stack>
        <TextInput
          label="Task Name"
          disabled={mutation.isPending}
          placeholder="e.g. Review Q3 Report"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
          data-autofocus
        />
        
        <Select
          label="Status"
          disabled={mutation.isPending}
          data={TODO_STATUS_OPTIONS}
          value={status}
          onChange={(v) => setStatus(v || '2')}
          allowDeselect={false}
        />

        <Textarea
          label="Description"
          disabled={mutation.isPending}
          placeholder="Optional details..."
          minRows={3}
          value={desc}
          onChange={(e) => setDesc(e.currentTarget.value)}
        />

        <Button 
          fullWidth 
          onClick={() => mutation.mutate()} 
          loading={mutation.isPending}
          disabled={!name.trim()}
        >
          Create Task
        </Button>
      </Stack>
    </Modal>
  );
}
