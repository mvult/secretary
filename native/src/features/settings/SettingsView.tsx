interface SettingsViewProps {
  backendUrl: string;
  email: string;
  password: string;
  centerColumn: boolean;
  authToken: string;
  workspaceId: number | null;
  isSyncing: boolean;
  syncMessage: string;
  showCenterColumnToggle?: boolean;
  showLogout?: boolean;
  onChangeBackendUrl: (value: string) => void;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onChangeCenterColumn: (value: boolean) => void;
  onLogin: () => void;
  onSync: () => void;
  onLogout?: () => void;
}

export function SettingsView({
  backendUrl,
  email,
  password,
  centerColumn,
  authToken,
  workspaceId,
  isSyncing,
  syncMessage,
  showCenterColumnToggle = true,
  showLogout = true,
  onChangeBackendUrl,
  onChangeEmail,
  onChangePassword,
  onChangeCenterColumn,
  onLogin,
  onSync,
  onLogout,
}: SettingsViewProps) {
  return (
    <section className="settings-shell">
      <header className="page-header">
        <p className="page-date">Settings</p>
        <div className="page-heading-row">
          <h2 className="page-title settings-title">Sync</h2>
        </div>
      </header>

      <div className="settings-card">
        <label className="settings-label" htmlFor="backend-url">Backend URL</label>
        <input id="backend-url" className="settings-input" type="text" value={backendUrl} placeholder="http://localhost:8080" onChange={(event) => onChangeBackendUrl(event.target.value)} />

        <label className="settings-label" htmlFor="sync-email">Email</label>
        <input id="sync-email" className="settings-input" type="email" value={email} placeholder="you@example.com" onChange={(event) => onChangeEmail(event.target.value)} />

        <label className="settings-label" htmlFor="sync-password">Password</label>
        <input id="sync-password" className="settings-input" type="password" value={password} placeholder="Password" onChange={(event) => onChangePassword(event.target.value)} />

        {showCenterColumnToggle ? (
          <label className="settings-toggle" htmlFor="center-column">
            <span className="settings-toggle-copy">
              <span className="settings-label">Center column view</span>
              <span className="settings-message">Keep the editor in a narrower centered column.</span>
            </span>
            <input id="center-column" type="checkbox" checked={centerColumn} onChange={(event) => onChangeCenterColumn(event.target.checked)} />
          </label>
        ) : null}

        {showCenterColumnToggle ? (
          <div className="settings-hotkeys">
            <span className="settings-label">Hotkeys</span>
            <p className="settings-message">`Cmd+J` journals. `Cmd+K` note search. `Cmd+O` directories. `Cmd+T` todos. `Cmd+Shift+A` AI threads. `Cmd+,` settings. `v` enters row selection. `[[` inserts a doc link. `gd` follows it. `Ctrl+O` / `Ctrl+I` move through jumps.</p>
          </div>
        ) : null}

        <div className="settings-actions">
          <button type="button" className="sync-button" onClick={onLogin} disabled={isSyncing}>
            {authToken ? 'Refresh login' : 'Log in'}
          </button>
          <button type="button" className="sync-button" onClick={onSync} disabled={isSyncing || !authToken}>
            Sync now
          </button>
          {showLogout && onLogout ? (
            <button type="button" className="sync-button" onClick={onLogout} disabled={isSyncing || !authToken}>
              Log out
            </button>
          ) : null}
        </div>

        <div className="settings-hotkeys">
          <span className="settings-label">Status</span>
          <p className="settings-message">
            {isSyncing ? 'Working...' : authToken ? `Connected${workspaceId ? ` to workspace ${workspaceId}` : ''}.` : 'Not connected.'}
          </p>
          {syncMessage ? <p className="settings-message">{syncMessage}</p> : null}
        </div>
      </div>
    </section>
  );
}
