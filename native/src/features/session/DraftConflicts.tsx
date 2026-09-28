import { useEffect, useRef, useState } from 'react';
import { BackendError, getDocument } from '../../lib/backend';
import type { DraftRecord } from '../../lib/draftStorage';
import { documentToOutlinePage } from '../outline/remote';
import type { OutlinePage } from '../outline/types';

function outlineText(page: OutlinePage) {
  return page.nodes.map((node) => `${node.todoStatus ? `[${node.todoStatus}] ` : ''}${node.text}`).join('\n');
}

export function DraftConflictReview({ record, backendUrl, token, onResolve }: {
  record: DraftRecord; backendUrl: string; token: string;
  onResolve: (id: string, resolution: 'reload' | 'copy' | 'save', reviewed?: OutlinePage) => Promise<void>;
}) {
  const [serverCopy, setServerCopy] = useState(record.serverCopy);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const comparisonEpoch = useRef(0);
  useEffect(() => {
    comparisonEpoch.current++;
    setServerCopy(record.serverCopy); setError(''); setBusy(false);
    return () => { comparisonEpoch.current++; };
  }, [record.serverCopy, backendUrl, token, record.page.id, record.page.workspaceId]);
  const serverId = record.serverCopy?.backendId ?? record.page.backendId;
  const compare = async () => {
    if (!serverId) { setError('Server identity is unknown. Retry workspace sync to locate the matching journal before making a copy.'); return; }
    setBusy(true);
    setError('');
    const epoch = ++comparisonEpoch.current;
    try {
      const doc = await getDocument(backendUrl, token, serverId);
      if (epoch !== comparisonEpoch.current) return;
      setServerCopy(documentToOutlinePage(doc));
    } catch (error) {
      if (epoch !== comparisonEpoch.current) return;
      if (error instanceof BackendError && error.status === 404) setServerCopy(null);
      setError(error instanceof Error ? error.message : 'Could not load server copy.');
    }
    finally { if (epoch === comparisonEpoch.current) setBusy(false); }
  };
  const resolve = async (action: 'reload' | 'copy' | 'save') => {
    setBusy(true);
    setError('');
    try { await onResolve(record.page.id, action, serverCopy ?? undefined); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not resolve conflict.'); }
    finally { setBusy(false); }
  };
  return <details className="settings-card" aria-label={`Conflict for ${record.page.title || record.page.date}`}>
    <summary>Review conflict</summary>
    <p>{record.conflict}</p>
    <h4>Local draft · {record.page.title || record.page.date}</h4>
    <pre style={{ whiteSpace: 'pre-wrap' }}>{outlineText(record.page).trim() ? outlineText(record.page) : '(Blank local draft)'}</pre>
    <h4>Server copy{serverCopy ? ` · ${serverCopy.title || serverCopy.date} · document ${serverCopy.backendId}` : ''}</h4>
    <pre style={{ whiteSpace: 'pre-wrap' }}>{serverCopy ? outlineText(serverCopy) || '(Blank server document)'
      : serverCopy === null ? 'Server document was not found during the last check.' : 'No server snapshot cached yet.'}</pre>
    <button type="button" className="sync-button" disabled={busy || !token} onClick={() => void compare()}>Refresh server copy</button>
    {error ? <p role="alert">{error}</p> : null}
    {serverCopy?.revision && serverCopy.revision !== '0' && !record.pending ?
      <button type="button" className="sync-button" disabled={busy || !token}
        onClick={() => void resolve('save')}>Save local using reviewed revision</button> : null}
    <button type="button" className="sync-button" disabled={busy || !token || !serverId}
      onClick={() => void resolve('reload')}>Use server copy and discard local draft</button>
    <button type="button" className="sync-button" disabled={busy || !token}
      onClick={() => void resolve('copy')}>Keep local content as a separate note</button>
  </details>;
}
