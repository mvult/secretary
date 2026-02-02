import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Drawer, Select, Textarea, Button, Group, Stack, Timeline, Text, Loader, ActionIcon, Menu, Collapse, Anchor } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Trash, MoreVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { todosClient, usersClient } from '../lib/client';
import { getUser } from '../lib/auth';
import { getStatusConfig, TODO_STATUS_OPTIONS } from '../lib/status';
import { Todo, TodoStatus, ListTodoHistoryResponse } from '../gen/secretary/v1/todos_pb';
import { ListUsersResponse } from '../gen/secretary/v1/users_pb';

interface EditTodoDrawerProps {
  opened: boolean;
  onClose: () => void;
  todo: Todo | null;
}

export function EditTodoDrawer({ opened, onClose, todo }: EditTodoDrawerProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState<string>('1');
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const user = getUser();

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Reset form when todo changes
  useEffect(() => {
    if (todo) {
      setName(todo.name);
      setDesc(todo.desc);
      setStatus(String(todo.status));
      setExpandedItems({});
    }
  }, [todo]);

  // Fetch Users
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await usersClient.listUsers({});
      return (res as ListUsersResponse).users;
    },
    enabled: opened,
  });

  const userMap = useMemo(() => {
    const map = new Map<bigint, string>();
    users?.forEach(u => map.set(u.id, `${u.firstName} ${u.lastName}`));
    return map;
  }, [users]);

  // Fetch History
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['todoHistory', todo ? String(todo.id) : null],
    queryFn: async () => {
      if (!todo) return [];
      const res = await todosClient.listTodoHistory({ todoId: todo.id });
      return (res as ListTodoHistoryResponse).history;
    },
    enabled: !!todo && opened,
  });

  // Update Mutation
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!todo) return;
      await todosClient.updateTodo({
        id: todo.id,
        userId: todo.userId, // Required by backend
        name,
        desc,
        status: Number(status) as TodoStatus,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] });
      queryClient.invalidateQueries({ queryKey: ['todoHistory'] });
      notifications.show({ title: 'Success', message: 'Todo updated', color: 'green' });
      onClose();
    },
    onError: (err: any) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' });
    },
  });

  // Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!todo) return;
      await todosClient.deleteTodo({ id: todo.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] });
      notifications.show({ title: 'Deleted', message: 'Todo deleted', color: 'blue' });
      onClose();
    },
    onError: (err: any) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' });
    },
  });

  if (!todo) return null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={<Text fw={700} size="lg">Edit Todo</Text>}
      position="right"
      size="md"
    >
      <Stack gap="lg">
        <Group justify="flex-end">
           <Menu shadow="md" width={200}>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray"><MoreVertical size={16} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {user?.role === 'admin' && (
                <Menu.Item
                  color="red"
                  leftSection={<Trash size={14} />}
                  onClick={() => {
                    if (confirm('Are you sure you want to delete this todo?')) {
                      deleteMutation.mutate();
                    }
                  }}
                >
                  Delete Todo
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Textarea
          label="Task Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
          autosize
          minRows={2}
        />
        
        <Select
          label="Status"
          data={TODO_STATUS_OPTIONS}
          value={status}
          onChange={(v) => setStatus(v || '1')}
          allowDeselect={false}
        />

        <Textarea
          label="Description"
          autosize
          minRows={12}
          value={desc}
          onChange={(e) => setDesc(e.currentTarget.value)}
        />

        <Button 
          fullWidth 
          onClick={() => updateMutation.mutate()} 
          loading={updateMutation.isPending}
        >
          Save Changes
        </Button>

        <Text fw={700} size="sm" mt="md" c="dimmed">History</Text>
        {historyLoading && <Loader size="sm" />}
        
        {history && (
          <Timeline active={-1} bulletSize={12} lineWidth={2}>
            {history.map((h, index) => {
              const prev = history[index + 1];
              const isCreate = h.changeType === 'create' || !prev;
              const actorName = h.actorUserId ? userMap.get(h.actorUserId) || 'Unknown' : 'Unknown';
              const isExpanded = expandedItems[String(h.id)];

              return (
                <Timeline.Item 
                  key={String(h.id)} 
                  bullet={<div style={{ backgroundColor: getStatusConfig(h.status).color, width: 8, height: 8, borderRadius: '50%' }} />}
                  title={
                    <Text size="xs">
                      <Text span fw={500}>{h.changeType.toUpperCase()}</Text> by {actorName}
                    </Text>
                  }
                >
                   <Text size="xs" c="dimmed" mb={4}>
                      {new Date(h.changedAt).toLocaleString()}
                   </Text>
                  
                  {!isCreate && (
                    <>
                      <Anchor component="button" size="xs" onClick={() => toggleExpand(String(h.id))} display="flex" style={{ alignItems: 'center', gap: 4 }}>
                        {isExpanded ? 'Hide changes' : 'Show changes'}
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </Anchor>
                      
                      <Collapse in={isExpanded}>
                        <Stack gap={4} mt="xs" p="xs" bg="dark.8" style={{ borderRadius: 4 }}>
                           {prev && h.status !== prev.status && (
                              <Text size="xs">
                                 <Text span fw={500} c="dimmed">Status:</Text> {getStatusConfig(prev.status).label} → {getStatusConfig(h.status).label}
                              </Text>
                           )}
                           {prev && h.name !== prev.name && (
                              <Stack gap={2}>
                                <Text size="xs" fw={500} c="dimmed">Name changed:</Text>
                                <Text size="xs" c="red.4" style={{ textDecoration: 'line-through' }}>{prev.name}</Text>
                                <Text size="xs" c="green.4">{h.name}</Text>
                              </Stack>
                           )}
                           {prev && h.desc !== prev.desc && (
                              <Stack gap={2}>
                                <Text size="xs" fw={500} c="dimmed">Description changed:</Text>
                                <Text size="xs" c="dimmed" lineClamp={3}>Old: {prev.desc}</Text>
                                <Text size="xs" lineClamp={3}>New: {h.desc}</Text>
                              </Stack>
                           )}
                           {prev && h.status === prev.status && h.name === prev.name && h.desc === prev.desc && (
                             <Text size="xs" c="dimmed">No changes detected (metadata update)</Text>
                           )}
                        </Stack>
                      </Collapse>
                    </>
                  )}
                  {isCreate && (
                     <Text size="xs" c="dimmed">
                       Initial creation
                     </Text>
                  )}
                </Timeline.Item>
              );
            })}
          </Timeline>
        )}
      </Stack>
    </Drawer>
  );
}
