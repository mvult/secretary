import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Container, Title, Loader, List, ThemeIcon, Alert, Text, Anchor } from '@mantine/core';
import { Mic, AlertCircle } from 'lucide-react';
import { recordingsClient } from '../lib/client';
import type { Recording, ListRecordingsResponse } from '../gen/secretary/v1/recordings_pb';

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['recordings'],
    queryFn: async () => {
      const response = await recordingsClient.listRecordings({});
      return (response as ListRecordingsResponse).recordings;
    },
  });

  return (
    <Container size="md">
      <Title order={2} mb="lg">Recordings</Title>
      
      {isLoading && <Loader />}
      
      {error && (
        <Alert icon={<AlertCircle size={16} />} title="Error" color="red">
          Failed to load recordings: {error.message}
        </Alert>
      )}

      {data && (
        <List spacing="sm" size="sm" center>
          {data.map((rec: Recording) => (
            <List.Item
              key={rec.id}
              icon={
                <ThemeIcon color="blue" size={24} radius="xl">
                  <Mic size={16} />
                </ThemeIcon>
              }
            >
              <Anchor component={Link} to={`/recordings/${rec.id}`} fw={500}>
                {rec.name || 'Untitled Meeting'}
              </Anchor>
              <Text size="xs" c="dimmed">{new Date(rec.createdAt).toLocaleString()}</Text>
            </List.Item>
          ))}
          {data.length === 0 && <Text c="dimmed">No recordings found.</Text>}
        </List>
      )}
    </Container>
  );
}
