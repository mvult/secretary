import { formatInlineTodoStatus, formatPanelTimestamp } from '../../app/format';
import type { BackendDocumentHistoryEntry } from '../../lib/backend';

interface SnapshotNode {
  parent_index?: number;
  text?: string;
  todo_status?: string;
}

interface SnapshotPayload {
  title?: string;
  nodes?: SnapshotNode[];
}

interface RenderedSnapshotNode {
  text: string;
  todoStatus: string | null;
  depth: number;
}

function parseSnapshot(snapshotJson: string): { title: string; nodes: RenderedSnapshotNode[] } {
  try {
    const parsed = JSON.parse(snapshotJson) as SnapshotPayload;
    const sourceNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const depths = sourceNodes.map(() => 0);

    for (let index = 0; index < sourceNodes.length; index += 1) {
      const parentIndex = typeof sourceNodes[index]?.parent_index === 'number' ? sourceNodes[index].parent_index! : -1;
      depths[index] = parentIndex >= 0 && parentIndex < index ? depths[parentIndex] + 1 : 0;
    }

    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      nodes: sourceNodes.map((node, index) => ({
        text: typeof node?.text === 'string' ? node.text : '',
        todoStatus: typeof node?.todo_status === 'string' && node.todo_status ? node.todo_status : null,
        depth: depths[index] ?? 0,
      })),
    };
  } catch {
    return { title: '', nodes: [] };
  }
}

interface NoteHistoryDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  isLoadingEntry: boolean;
  noteTitle: string;
  entries: BackendDocumentHistoryEntry[];
  activeEntryId: number | null;
  activeEntry: BackendDocumentHistoryEntry | null;
  errorMessage: string;
  onClose: () => void;
  onSelectEntry: (id: number) => void;
}

export function NoteHistoryDialog({
  isOpen,
  isLoading,
  isLoadingEntry,
  noteTitle,
  entries,
  activeEntryId,
  activeEntry,
  errorMessage,
  onClose,
  onSelectEntry,
}: NoteHistoryDialogProps) {
  if (!isOpen) {
    return null;
  }

  const snapshot = activeEntry ? parseSnapshot(activeEntry.snapshotJson) : { title: '', nodes: [] };

  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div className="confirm-dialog history-dialog" role="dialog" aria-modal="true" aria-label="Note history" onClick={(event) => event.stopPropagation()}>
        <div className="page-heading-row page-heading-row-directory">
          <div>
            <p className="page-date">Note history</p>
            <h2 className="page-title settings-title">{noteTitle}</h2>
          </div>
          <button type="button" className="settings-button settings-button-secondary" onClick={onClose}>Close</button>
        </div>

        <div className="history-layout">
          <aside className="history-sidebar search-results">
            {isLoading ? (
              <div className="search-empty">Loading history...</div>
            ) : entries.length === 0 ? (
              <div className="search-empty">No history yet. Wait for a save snapshot to be captured.</div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="search-result history-result"
                  data-active={activeEntryId === entry.id ? 'true' : 'false'}
                  onClick={() => onSelectEntry(entry.id)}
                >
                  <span className="search-result-title">{formatPanelTimestamp(entry.capturedAt)}</span>
                  <span className="search-result-date">{entry.captureReason === 'day_start' ? 'Start of day' : 'Periodic snapshot'}</span>
                </button>
              ))
            )}
          </aside>

          <section className="settings-card history-detail-card">
            {errorMessage ? <p className="settings-message">{errorMessage}</p> : null}
            {isLoadingEntry ? (
              <div className="search-empty">Loading snapshot...</div>
            ) : !activeEntry ? (
              <div className="search-empty">Choose a snapshot.</div>
            ) : (
              <>
                <div className="page-heading-row page-heading-row-directory">
                  <div>
                    <p className="page-date">Snapshot</p>
                    <h3 className="page-title history-snapshot-title">{snapshot.title || noteTitle}</h3>
                  </div>
                  <span className="page-kind">{formatPanelTimestamp(activeEntry.capturedAt)}</span>
                </div>
                <div className="history-node-list">
                  {snapshot.nodes.length > 0 ? snapshot.nodes.map((node, index) => (
                    <div key={`${activeEntry.id}-${index}`} className="row history-node-row" style={{ paddingLeft: `${12 + node.depth * 24}px` }}>
                      <span className="row-gutter" aria-hidden="true">•</span>
                      {node.todoStatus ? (
                        <span className="status-chip" data-status={node.todoStatus}>{formatInlineTodoStatus(node.todoStatus)}</span>
                      ) : null}
                      <div className="row-content history-node-content">
                        <p className="row-text" data-status={node.todoStatus ?? 'none'}>{node.text || ' '}</p>
                      </div>
                    </div>
                  )) : (
                    <div className="search-empty">This snapshot is empty.</div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
