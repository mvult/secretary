import { useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Container, Title, Text, Loader, Alert, Tabs, Paper, Group, Badge, Breadcrumbs, Anchor, Card, Stack, Switch, Button } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertCircle, Calendar, Clock, Trash } from 'lucide-react';
import { recordingsClient, todosClient, usersClient } from '../lib/client';
import { getUser } from '../lib/auth';
import { getStatusConfig } from '../lib/status';
import type { GetRecordingResponse, Recording } from '../gen/secretary/v1/recordings_pb';
import type { ListTodosResponse, Todo } from '../gen/secretary/v1/todos_pb';
import type { ListUsersResponse } from '../gen/secretary/v1/users_pb';
import { EditTodoDrawer } from '../components/EditTodoDrawer';

export function RecordingDetailPage() {
  const { id } = useParams();
  const recordingId = id ? BigInt(id) : undefined;
  const [activeTab, setActiveTab] = useState<string | null>('summary');
  const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
  const [selectedTodo, setSelectedTodo] = useState<Todo | null>(null);
  const [showMyTodosOnly, setShowMyTodosOnly] = useState(false);
  const currentUser = getUser();
  const navigate = useNavigate();
  // const queryClient = useQueryClient();

  const deleteRecordingMutation = useMutation({
    mutationFn: async () => {
      if (!recordingId) return;
      await recordingsClient.deleteRecording({ id: recordingId });
    },
    onSuccess: () => {
      notifications.show({ title: 'Success', message: 'Recording deleted', color: 'blue' });
      navigate('/');
    },
    onError: (err: any) => {
      notifications.show({ title: 'Error', message: err.message, color: 'red' });
    }
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['recording', id],
    queryFn: async () => {
      if (!recordingId) throw new Error('Invalid ID');
      const response = await recordingsClient.getRecording({ id: recordingId });
      return (response as GetRecordingResponse).recording;
    },
    enabled: !!recordingId,
  });

  const { data: todos } = useQuery({
    queryKey: ['todos', 'recording', id],
    queryFn: async () => {
      if (!recordingId) return [];
      const res = await todosClient.listTodos({ recordingId });
      return (res as ListTodosResponse).todos;
    },
    enabled: !!recordingId,
  });

  // Fetch Users for Owner display
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await usersClient.listUsers({});
      return (res as ListUsersResponse).users;
    },
  });

  const userMap = useMemo(() => {
    const map = new Map<bigint, string>();
    users?.forEach(u => map.set(u.id, `${u.firstName} ${u.lastName}`));
    return map;
  }, [users]);

  const filteredTodos = useMemo(() => {
    if (!todos) return [];
    if (!showMyTodosOnly || !currentUser) return todos;
    return todos.filter(t => t.userId === BigInt(currentUser.id));
  }, [todos, showMyTodosOnly, currentUser]);

  const rec = data as Recording | undefined;

  // Calculate word counts per speaker from transcript
  const speakerStats = useMemo(() => {
    if (!rec?.transcript) return { total: 0, bySpeaker: new Map<string, number>() };
    
    const stats = new Map<string, number>();
    let totalWords = 0;
    
    // Split by newlines to handle "Speaker: Text" format
    const lines = rec.transcript.split('\n');
    
    for (const line of lines) {
      // Match "Speaker 1: " or "SPEAKER_01: " or just "Speaker 1:"
      // Capturing group 1 is the ID
      const matchId = line.match(/^(?:Speaker|SPEAKER_)\s*0*(\d+):\s+(.+)$/i);
      if (matchId) {
        const speakerId = parseInt(matchId[1], 10);
        const text = matchId[2];
        const wordCount = text.trim().split(/\s+/).length;
        
        const key = `id_${speakerId}`;
        stats.set(key, (stats.get(key) || 0) + wordCount);
        totalWords += wordCount;
        continue;
      }

      // Fallback: Match "Name: "
      const matchName = line.match(/^([^:]+):\s+(.+)$/);
      if (matchName) {
        const name = matchName[1].trim().toLowerCase();
        const text = matchName[2];
        const wordCount = text.trim().split(/\s+/).length;

        const key = `name_${name}`;
        stats.set(key, (stats.get(key) || 0) + wordCount);
        totalWords += wordCount;
      }
    }
    
    return { total: totalWords, bySpeaker: stats };
  }, [rec?.transcript]);

  const getSpeakerPercentage = (user: { firstName: string; lastName: string; speakerId?: number }) => {
    if (speakerStats.total === 0) return 0;
    
    let count: number | undefined;

    // 1. Try Lookup by speaker_ID
    if (user.speakerId !== undefined) {
       count = speakerStats.bySpeaker.get(`id_${user.speakerId}`);
    }

    // 2. Fallback: Lookup by Name
    if (count === undefined) {
       const fullName = `${user.firstName} ${user.lastName}`.trim().toLowerCase();
       count = speakerStats.bySpeaker.get(`name_${fullName}`);
    }
    
    if (count === undefined) {
       const firstName = user.firstName.trim().toLowerCase();
       count = speakerStats.bySpeaker.get(`name_${firstName}`);
    }

    if (count === undefined) return 0;
    return Math.round((count / speakerStats.total) * 100);
  };

  const handleTodoClick = (todo: Todo) => {
    setSelectedTodo(todo);
    openDrawer();
  };

  if (isLoading) return <Container><Loader /></Container>;
  
  if (error || !rec) {
    return (
      <Container>
         <Alert icon={<AlertCircle size={16} />} title="Error" color="red">
          {error?.message || 'Recording not found'}
        </Alert>
        <Link to="/">Back to recordings</Link>
      </Container>
    );
  }

  return (
    <Container size="lg">
      <Group mb="md" justify="space-between">
        <Group>
            <Breadcrumbs>
            <Anchor component={Link} to="/">Recordings</Anchor>
            <Text>{rec.name}</Text>
            </Breadcrumbs>
        </Group>
        {currentUser?.role === 'admin' && (
            <Button 
                color="red" 
                variant="light" 
                size="xs"
                leftSection={<Trash size={14} />}
                onClick={() => {
                    if (confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
                        deleteRecordingMutation.mutate();
                    }
                }}
                loading={deleteRecordingMutation.isPending}
            >
                Delete Recording
            </Button>
        )}
      </Group>

      <Title order={2} mb="xs">{rec.name || 'Untitled Meeting'}</Title>
      
      <Group mb="xl" c="dimmed" gap="lg">
        <Group gap="xs">
          <Calendar size={16} />
          <Text size="sm">{new Date(rec.createdAt).toLocaleString()}</Text>
        </Group>
        {rec.duration > 0 && (
           <Group gap="xs">
            <Clock size={16} />
            <Text size="sm">{Math.floor(rec.duration / 60)} min {rec.duration % 60} sec</Text>
          </Group>
        )}
      </Group>

      {rec.participants && rec.participants.length > 0 && (
        <Group mb="xl">
          {rec.participants.map((p) => {
             const pct = getSpeakerPercentage(p);
             return (
               <Badge key={p.id} variant="outline" color="gray" size="lg" py="sm" pr="lg" tt="none">
                 <Group gap="sm">
                   <Text>{p.firstName} {p.lastName}</Text>
                   {pct > 0 && (
                     <Badge size="sm" variant="filled" color="gray">
                       {pct}%
                     </Badge>
                   )}
                 </Group>
               </Badge>
             );
          })}
        </Group>
      )}

      {rec.hasAudio && rec.audioUrl ? (
        <Card withBorder shadow="sm" p="md" mb="xl" radius="md">
          <Text fw={500} mb="sm">Audio Recording</Text>
          <audio controls style={{ width: '100%' }}>
            <source src={rec.audioUrl} type="audio/mpeg" />
            Your browser does not support the audio element.
          </audio>
        </Card>
      ) : (
        <Alert icon={<AlertCircle size={16} />} title="Audio Missing" color="blue" mb="xl">
          Ask Miguel for the recording if you need it.
        </Alert>
      )}

      <Paper withBorder p="md" radius="md">
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="summary">Summary</Tabs.Tab>
            <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
            <Tabs.Tab value="todos">
              <Group gap={6}>
                <Text>Todos</Text>
                {todos && todos.length > 0 && (
                   <Badge size="xs" circle color="gray">{todos.length}</Badge>
                )}
              </Group>
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="summary" pt="xl">
            {rec.summary ? (
              <Text style={{ whiteSpace: 'pre-wrap' }}>{rec.summary}</Text>
            ) : (
              <Text c="dimmed">No summary available.</Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="transcript" pt="xl">
            {rec.transcript ? (
              <Text style={{ whiteSpace: 'pre-wrap' }}>{rec.transcript}</Text>
            ) : (
               <Text c="dimmed">No transcript available.</Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="todos" pt="xl">
            <Group mb="md" justify="space-between">
              <Text c="dimmed" size="sm">
                {filteredTodos.length} task{filteredTodos.length !== 1 ? 's' : ''}
              </Text>
              <Switch
                label="Only show my tasks"
                checked={showMyTodosOnly}
                onChange={(event) => setShowMyTodosOnly(event.currentTarget.checked)}
              />
            </Group>
             {filteredTodos.length > 0 ? (
               <Stack gap="sm">
                   {filteredTodos.map((todo) => {
                     const statusConfig = getStatusConfig(todo.status);
                     return (
                       <Card 
                          key={todo.id} 
                          withBorder 
                          shadow="sm" 
                          radius="md" 
                          padding="md"
                          onClick={() => handleTodoClick(todo)}
                          style={{ cursor: 'pointer' }}
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
                              <Group mt={8} gap={6}>
                                <Text size="xs" c="dimmed" fw={500}>Owner:</Text>
                                <Badge variant="outline" color="gray" size="sm">
                                  {userMap.get(todo.userId) || 'Unknown'}
                                </Badge>
                              </Group>
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
             ) : (
                <Text c="dimmed">
                  {showMyTodosOnly ? "You don't have any tasks in this meeting." : "No tasks created during this meeting."}
                </Text>
             )}
          </Tabs.Panel>
        </Tabs>
      </Paper>
      
      <EditTodoDrawer 
        opened={drawerOpened} 
        onClose={closeDrawer} 
        todo={selectedTodo} 
      />
    </Container>
  );
}
