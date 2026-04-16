interface DirtyDocumentSummary {
  pageId: string;
  title: string;
  kind: 'note' | 'journal';
}

interface SyncConfirmDialogProps {
  reason: 'startup' | 'login' | 'manual' | null;
  dirtyPages: DirtyDocumentSummary[];
  onCancel: () => void;
  onConfirm: () => void;
}

function reasonLabel(reason: SyncConfirmDialogProps['reason']) {
  switch (reason) {
    case 'startup':
      return 'Opening the app will pull the latest server copy.';
    case 'login':
      return 'Logging in will pull the latest server copy.';
    case 'manual':
      return 'Manual sync will pull the latest server copy.';
    default:
      return '';
  }
}

export function SyncConfirmDialog({ reason, dirtyPages, onCancel, onConfirm }: SyncConfirmDialogProps) {
  if (!reason) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onCancel}>
      <div className="confirm-dialog sync-confirm-dialog" role="alertdialog" aria-modal="true" aria-label="Confirm sync" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Confirm sync</p>
        <h2 className="page-title settings-title">Refresh from server?</h2>
        <p className="settings-message">{reasonLabel(reason)}</p>
        <p className="settings-message">
          Any dirty local documents listed here could be overwritten if their latest edits are not already persisted.
        </p>
        <div className="sync-confirm-list">
          {dirtyPages.length === 0 ? (
            <p className="search-empty">No dirty local documents detected.</p>
          ) : (
            dirtyPages.map((page) => (
              <div key={page.pageId} className="sync-confirm-item">
                <span className="sync-confirm-title">{page.title}</span>
                <span className="sync-confirm-kind">{page.kind === 'journal' ? 'Journal' : 'Note'}</span>
              </div>
            ))
          )}
        </div>
        <div className="confirm-actions">
          <button type="button" className="settings-button settings-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="settings-button settings-button-danger" onClick={onConfirm}>
            Sync Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
