import { AppShell, Burger, NavLink, ActionIcon, Tooltip, Group, Text, Button } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Mic, CheckSquare, Settings, Menu } from 'lucide-react';
import { removeToken, removeUser } from '../lib/auth';

interface NavItemProps {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  desktopOpened: boolean;
}

function NavItem({ label, icon, active, onClick, desktopOpened }: NavItemProps) {
  return (
    <Tooltip label={label} position="right" disabled={desktopOpened} withArrow>
      <NavLink
        label={desktopOpened ? label : null}
        leftSection={icon}
        active={active}
        onClick={onClick}
        py="md"
        style={{ justifyContent: desktopOpened ? 'flex-start' : 'center' }}
      />
    </Tooltip>
  );
}

export function Layout() {
  const [opened, { toggle }] = useDisclosure();
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(true);
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: desktopOpened ? 300 : 80,
        breakpoint: 'sm',
        collapsed: { mobile: !opened, desktop: false },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <ActionIcon variant="subtle" color="gray" onClick={toggleDesktop} visibleFrom="sm">
              <Menu size={20} />
            </ActionIcon>
            <Text fw={700} size="lg">Secretary</Text>
          </Group>
          <Button variant="subtle" color="gray" onClick={handleLogout} leftSection={<LogOut size={16} />}>
            Logout
          </Button>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <NavItem
          label="Recordings"
          icon={<Mic size={16} />}
          active={location.pathname === '/'}
          onClick={() => { navigate('/'); toggle(); }}
          desktopOpened={desktopOpened}
        />
        <NavItem
          label="My Todos"
          icon={<CheckSquare size={16} />}
          active={location.pathname === '/todos'}
          onClick={() => { navigate('/todos'); toggle(); }}
          desktopOpened={desktopOpened}
        />
        <NavItem
          label="Settings"
          icon={<Settings size={16} />}
          active={location.pathname.startsWith('/settings')}
          onClick={() => { navigate('/settings'); toggle(); }}
          desktopOpened={desktopOpened}
        />
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
