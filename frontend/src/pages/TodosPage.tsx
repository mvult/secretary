import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Container, Title, Loader, Alert, Group, Select, Button, Card, Text, Badge, Stack, Divider } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { AlertCircle, Plus, Filter } from 'lucide-react';
import { todosClient, usersClient } from '../lib/client';
import { getUser } from '../lib/auth';
import { getStatusConfig } from '../lib/status';
import type { ListTodosResponse, Todo } from '../gen/secretary/v1/todos_pb';
import type { ListUsersResponse } from '../gen/secretary/v1/users_pb';
import { CreateTodoModal } from '../components/CreateTodoModal';
import { EditTodoDrawer } from '../components/EditTodoDrawer';

export function TodosPage() {
  const currentUser = getUser();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(currentUser ? String(currentUser.id) : null);
  
  const [createOpened, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
  const [selectedTodo, setSelectedTodo] = useState<Todo | null>(null);

  // Fetch Users for Selector
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await usersClient.listUsers({});
      return (res as ListUsersResponse).users;
    },
  });

  const userOptions = users?.map(u => ({ value: String(u.id), label: `${u.firstName} ${u.lastName}` })) || [];

  // Fetch Todos for Selected User
  const { data: todos, isLoading, error } = useQuery({
    queryKey: ['todos', selectedUserId],
    queryFn: async () => {
      if (!selectedUserId) return [];
      const res = await todosClient.listTodos({ userId: BigInt(selectedUserId) });
      return (res as ListTodosResponse).todos;
    },
    enabled: !!selectedUserId,
  });

  const groupedTodos = useMemo(() => {
      if (!todos) return {};
      const groups: Record<string, Todo[]> = {};
      
      // Sort todos by ID desc first (already returned by API usually, but safe to assume)
      // Then group them.
      todos.forEach(todo => {
          let key = 'TODOs not from meetings';
          if (todo.createdAtRecordingName) {
              const dateStr = todo.createdAtRecordingDate 
                  ? new Date(todo.createdAtRecordingDate).toLocaleDateString() 
                  : '';
              key = `${todo.createdAtRecordingName} (${dateStr})`;
          }
          if (!groups[key]) groups[key] = [];
          groups[key].push(todo);
      });
      return groups;
  }, [todos]);

  const handleTodoClick = (todo: Todo) => {
    setSelectedTodo(todo);
    openDrawer();
  };

  return (
    <Container size="md">
      <Group justify="space-between" mb="lg">
        <Title order={2}>Todos</Title>
        <Button leftSection={<Plus size={16} />} onClick={openCreate} disabled={!selectedUserId}>
          New Task
        </Button>
      </Group>

      <Group mb="xl">
        <Select
          label="Viewing Todos For"
          placeholder="Select a user"
          data={userOptions}
          value={selectedUserId}
          onChange={setSelectedUserId}
          leftSection={<Filter size={16} />}
          searchable
          w={300}
        />
      </Group>

      {isLoading && <Loader />}
      
      {error && (
        <Alert icon={<AlertCircle size={16} />} title="Error" color="red">
          Failed to load todos: {error.message}
        </Alert>
      )}

      {!selectedUserId && (
        <Alert title="Select a User" color="blue">
          Please select a user to view their tasks.
        </Alert>
      )}

      {todos && (
        <Stack gap="xl">
          {Object.entries(groupedTodos).length === 0 && <Text c="dimmed" ta="center" py="xl">No tasks found.</Text>}
          
          {Object.entries(groupedTodos).map(([groupName, groupTodos]) => (
            <div key={groupName}>
                <Divider label={groupName} labelPosition="center" mb="md" color="dimmed" />
                <Stack gap="sm">
                    {groupTodos.map((todo) => {
                        const statusConfig = getStatusConfig(todo.status);
                        return (
                        <Card 
                            key={todo.id} 
                            withBorder 
                            shadow="sm" 
                            radius="md" 
                            padding="md"
                            style={{ cursor: 'pointer' }}
                            onClick={() => handleTodoClick(todo)}
                            className="hover:bg-zinc-800 transition-colors"
                        >
                            <Group justify="space-between" align="start" wrap="nowrap">
                            <div style={{ flex: 1 }}>
                                <Text fw={500}>{todo.name}</Text>
                                {todo.desc && (
                                <Text size="sm" c="dimmed" lineClamp={2}>
                                    {todo.desc}
                                </Text>
                                )}
                            </div>
                            <div style={{ width: 140, display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                              <Badge color={statusConfig.color} variant="light" fullWidth>
                                  {statusConfig.label}
                              </Badge>
                            </div>
                            </Group>
                        </Card>
                        );
                    })}
                </Stack>
            </div>
          ))}
        </Stack>
      )}

      {selectedUserId && (
        <CreateTodoModal 
          opened={createOpened} 
          onClose={closeCreate} 
          userId={BigInt(selectedUserId)} 
        />
      )}

      <EditTodoDrawer 
        opened={drawerOpened} 
        onClose={closeDrawer} 
        todo={selectedTodo} 
      />
    </Container>
  );
}
