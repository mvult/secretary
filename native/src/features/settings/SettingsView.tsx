import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  getWhatsAppQR,
  getWhatsAppSettings,
  getWhatsAppStatus,
  logoutWhatsApp,
  reconnectWhatsApp,
  saveWhatsAppSettings,
  type WhatsAppStatus,
} from '../../lib/backend';

interface SettingsViewProps {
  backendUrl: string;
  email: string;
  password: string;
  centerColumn: boolean;
  editorFontScale: number;
  authToken: string;
  workspaceId: number | null;
  isSyncing: boolean;
  syncMessage: string;
  sessionStatus: string;
  loadTimingMessage?: string;
  showCenterColumnToggle?: boolean;
  showLogout?: boolean;
  onChangeBackendUrl: (value: string) => void;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onChangeCenterColumn: (value: boolean) => void;
  onChangeEditorFontScale: (value: number) => void;
  onLogin: () => void;
  onSync: () => void;
  onLogout?: () => void;
}

export function SettingsView({
  backendUrl,
  email,
  password,
  centerColumn,
  editorFontScale,
  authToken,
  workspaceId,
  isSyncing,
  syncMessage,
  sessionStatus,
  loadTimingMessage,
  showCenterColumnToggle = true,
  showLogout = true,
  onChangeBackendUrl,
  onChangeEmail,
  onChangePassword,
  onChangeCenterColumn,
  onChangeEditorFontScale,
  onLogin,
  onSync,
  onLogout,
}: SettingsViewProps) {
  const [backendDraft, setBackendDraft] = useState(backendUrl);
  useEffect(() => setBackendDraft(backendUrl), [backendUrl]);
  const [whatsAppStatus, setWhatsAppStatus] = useState<WhatsAppStatus | null>(null);
  const [whatsAppQR, setWhatsAppQR] = useState('');
  const [importanceInstructions, setImportanceInstructions] = useState('');
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [pairingError, setPairingError] = useState('');
  const [isWhatsAppLoading, setIsWhatsAppLoading] = useState(false);

  const loadWhatsApp = useCallback(async () => {
    if (!authToken || !backendUrl.trim()) {
      setWhatsAppStatus(null);
      setWhatsAppQR('');
      return;
    }
    setIsWhatsAppLoading(true);
    try {
      const [statusPayload, settingsPayload] = await Promise.all([
        getWhatsAppStatus(backendUrl, authToken),
        getWhatsAppSettings(backendUrl, authToken),
      ]);
      setWhatsAppStatus(statusPayload.status);
      setImportanceInstructions(settingsPayload.importanceInstructions || settingsPayload.defaultImportanceInstructions);
      if (statusPayload.status.has_qr || statusPayload.status.pairing || !statusPayload.status.logged_in) {
        const qrPayload = await getWhatsAppQR(backendUrl, authToken);
        setWhatsAppQR(qrPayload.status.logged_in ? '' : qrPayload.qr);
        setPairingError('');
        setWhatsAppStatus(qrPayload.status);
      } else {
        setWhatsAppQR('');
      }
      setWhatsAppMessage('');
    } catch (error) {
      setWhatsAppMessage(error instanceof Error ? error.message : 'WhatsApp status failed.');
    } finally {
      setIsWhatsAppLoading(false);
    }
  }, [authToken, backendUrl]);

  useEffect(() => {
    void loadWhatsApp();
  }, [loadWhatsApp]);

  useEffect(() => {
    if (!authToken || !backendUrl.trim() || whatsAppStatus?.logged_in || isWhatsAppLoading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshPairing() {
      try {
        const payload = await getWhatsAppQR(backendUrl, authToken);
        if (cancelled) return;
        setWhatsAppStatus(payload.status);
        setWhatsAppQR(payload.status.logged_in ? '' : payload.qr);
        setPairingError('');
        if (payload.status.logged_in) return;
      } catch (error) {
        // Do not leave an expired code on screen when the backend is unreachable.
        if (!cancelled) {
          setWhatsAppQR('');
          setPairingError(error instanceof Error ? error.message : 'Could not fetch pairing QR.');
        }
      }
      if (!cancelled) timer = setTimeout(() => void refreshPairing(), 3000);
    }
    timer = setTimeout(() => void refreshPairing(), 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [authToken, backendUrl, whatsAppStatus?.logged_in, isWhatsAppLoading]);

  async function handleSaveWhatsAppSettings() {
    if (!authToken) {
      return;
    }
    setIsWhatsAppLoading(true);
    try {
      const saved = await saveWhatsAppSettings(backendUrl, authToken, importanceInstructions);
      setImportanceInstructions(saved.importanceInstructions || saved.defaultImportanceInstructions);
      setWhatsAppMessage('WhatsApp importance instructions saved.');
    } catch (error) {
      setWhatsAppMessage(error instanceof Error ? error.message : 'Failed to save WhatsApp settings.');
    } finally {
      setIsWhatsAppLoading(false);
    }
  }

  async function handleWhatsAppReconnect() {
    if (!authToken) {
      return;
    }
    setIsWhatsAppLoading(true);
    setWhatsAppQR('');
    setPairingError('');
    try {
      const status = await reconnectWhatsApp(backendUrl, authToken);
      setWhatsAppStatus(status);
      setWhatsAppMessage('WhatsApp reconnect requested.');
      await loadWhatsApp();
    } catch (error) {
      setWhatsAppMessage(error instanceof Error ? error.message : 'WhatsApp reconnect failed.');
    } finally {
      setIsWhatsAppLoading(false);
    }
  }

  async function handleWhatsAppLogout() {
    if (!authToken) {
      return;
    }
    setIsWhatsAppLoading(true);
    try {
      const status = await logoutWhatsApp(backendUrl, authToken);
      setWhatsAppStatus(status);
      setWhatsAppQR('');
      setWhatsAppMessage('WhatsApp logged out.');
    } catch (error) {
      setWhatsAppMessage(error instanceof Error ? error.message : 'WhatsApp logout failed.');
    } finally {
      setIsWhatsAppLoading(false);
    }
  }

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
        <input id="backend-url" className="settings-input" type="text" value={backendDraft} placeholder="http://localhost:8091"
          onChange={(event) => setBackendDraft(event.target.value)} onBlur={() => onChangeBackendUrl(backendDraft)} />

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
          <label className="settings-range" htmlFor="editor-font-scale">
            <span className="settings-toggle-copy">
              <span className="settings-label">Editor font size</span>
              <span className="settings-message">Scale note and journal body text.</span>
            </span>
            <span className="settings-range-control">
              <input id="editor-font-scale" type="range" min="0.75" max="1.5" step="0.05" value={editorFontScale} onChange={(event) => onChangeEditorFontScale(Number(event.target.value))} />
              <span className="settings-range-value">{Math.round(editorFontScale * 100)}%</span>
            </span>
          </label>
        ) : null}

        {showCenterColumnToggle ? (
          <div className="settings-hotkeys">
            <span className="settings-label">Hotkeys</span>
            <p className="settings-message">`Cmd+J` journals. `Cmd+K` note search. `Cmd+O` directories. `Cmd+P` pomodoro. `Cmd+T` todos. `Cmd+Shift+A` AI threads. `Cmd+,` settings. `v` enters row selection. `[[` inserts a doc link. `gd` follows it. `Ctrl+O` / `Ctrl+I` move through jumps.</p>
          </div>
        ) : null}

        <div className="settings-actions">
          <button type="button" className="sync-button" onClick={onLogin} disabled={isSyncing || backendDraft !== backendUrl}>
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
            {sessionStatus}{workspaceId ? ` · workspace ${workspaceId}` : ''}
          </p>
          {syncMessage ? <p className="settings-message">{syncMessage}</p> : null}
          {loadTimingMessage ? <p className="settings-message">Load timings · {loadTimingMessage}</p> : null}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-hotkeys">
          <span className="settings-label">WhatsApp</span>
          <p className="settings-message">
            {!authToken ? 'Log in to configure WhatsApp.' : whatsAppStatus?.logged_in ? `Paired${whatsAppStatus.jid ? ` as ${whatsAppStatus.jid}` : ''}.` : whatsAppStatus?.pairing || whatsAppStatus?.has_qr ? 'Waiting for WhatsApp pairing.' : 'Not paired.'}
          </p>
          {whatsAppStatus?.connected ? <p className="settings-message">Connected to WhatsApp.</p> : null}
          {whatsAppStatus?.last_error ? <p className="settings-message">Error: {whatsAppStatus.last_error}</p> : null}
          {pairingError ? <p className="settings-message" role="status">{pairingError}</p> : null}
          {authToken && !whatsAppStatus?.logged_in && !whatsAppQR && !pairingError ? (
            <p className="settings-message">{whatsAppStatus?.pairing ? 'Waiting for a QR code from the backend…' : 'Choose Generate QR to start pairing.'}</p>
          ) : null}
          {authToken && whatsAppQR && !whatsAppStatus?.logged_in ? (
            <div>
              <QRCodeSVG value={whatsAppQR} size={256} marginSize={4}
                bgColor="#ffffff" fgColor="#000000" title="WhatsApp pairing QR code"
                style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
              <p className="settings-message">WhatsApp → Linked devices → Link a device. Scan this code.</p>
            </div>
          ) : null}
        </div>

        <label className="settings-label" htmlFor="whatsapp-importance">Importance classifier instructions</label>
        <textarea
          id="whatsapp-importance"
          className="settings-input"
          rows={8}
          value={importanceInstructions}
          onChange={(event) => setImportanceInstructions(event.target.value)}
          disabled={!authToken || isWhatsAppLoading}
        />

        <div className="settings-actions">
          <button type="button" className="sync-button" onClick={() => void loadWhatsApp()} disabled={!authToken || isWhatsAppLoading}>
            Refresh status
          </button>
          <button type="button" className="sync-button" onClick={() => void handleSaveWhatsAppSettings()} disabled={!authToken || isWhatsAppLoading}>
            Save instructions
          </button>
          <button type="button" className="sync-button" onClick={() => void handleWhatsAppReconnect()} disabled={!authToken || isWhatsAppLoading}>
            {whatsAppStatus?.logged_in ? 'Reconnect' : 'Generate QR'}
          </button>
          <button type="button" className="sync-button" onClick={() => void handleWhatsAppLogout()} disabled={!authToken || isWhatsAppLoading}>
            Logout WhatsApp
          </button>
        </div>
        {whatsAppMessage ? <p className="settings-message">{whatsAppMessage}</p> : null}
      </div>
    </section>
  );
}
