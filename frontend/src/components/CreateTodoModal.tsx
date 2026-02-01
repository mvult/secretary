import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, TextInput, Select, Textarea, Button, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { todosClient } from '../lib/client';
import { TODO_STATUS_OPTIONS } from '../lib/status';
import { TodoStatus } from '../gen/secretary/v1/todos_pb';

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

  const mutation = useMutation({
    mutationFn: async () => {
      await todosClient.createTodo({
        userId,
        name,
        desc,
        status: Number(status) as TodoStatus,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] });
      notifications.show({ title: 'Success', message: 'Todo created', color: 'green' });
      setName('');
      setDesc('');
      setStatus('2');
      onClose();
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
          placeholder="e.g. Review Q3 Report"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
          data-autofocus
        />
        
        <Select
          label="Status"
          data={TODO_STATUS_OPTIONS}
          value={status}
          onChange={(v) => setStatus(v || '2')}
          allowDeselect={false}
        />

        <Textarea
          label="Description"
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
