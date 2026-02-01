import { useQuery } from '@tanstack/react-query';
import { Container, Title, Loader, Alert, Table, Badge } from '@mantine/core';
import { AlertCircle } from 'lucide-react';
import { usersClient } from '../lib/client';
import type { ListUsersResponse, User } from '../gen/secretary/v1/users_pb';

export function UsersPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const response = await usersClient.listUsers({});
      return (response as ListUsersResponse).users;
    },
  });

  return (
    <Container size="md">
      <Title order={2} mb="lg">Team Members</Title>

      {isLoading && <Loader />}
      
      {error && (
        <Alert icon={<AlertCircle size={16} />} title="Error" color="red">
          Failed to load users: {error.message}
        </Alert>
      )}

      {data && (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Role</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map((user: User) => (
              <Table.Tr key={user.id}>
                <Table.Td>{user.firstName} {user.lastName}</Table.Td>
                <Table.Td>
                  {user.role ? (
                    <Badge variant="light" color="blue">{user.role}</Badge>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Container>
  );
}
