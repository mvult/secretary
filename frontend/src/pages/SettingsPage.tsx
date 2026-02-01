import { Container, Tabs, Title } from '@mantine/core';
import { UsersPage } from './UsersPage';
import { User } from 'lucide-react';

export function SettingsPage() {
  return (
    <Container size="lg">
      <Title order={2} mb="lg">Settings</Title>
      
      <Tabs defaultValue="users">
        <Tabs.List mb="md">
          <Tabs.Tab value="users" leftSection={<User size={16} />}>
            Users
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="users">
          <UsersPage />
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}
