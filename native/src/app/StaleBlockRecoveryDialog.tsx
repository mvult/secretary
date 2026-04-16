interface StaleBlockRecoveryDialogProps {
  pageTitle: string | null;
  blockId: number | null;
  onKeepLocal: () => void;
  onRepairThisNote: () => void;
  onReloadServerCopy: () => void;
}

export function StaleBlockRecoveryDialog({
  pageTitle,
  blockId,
  onKeepLocal,
  onRepairThisNote,
  onReloadServerCopy,
}: StaleBlockRecoveryDialogProps) {
  if (!pageTitle || !blockId) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onKeepLocal}>
      <div className="confirm-dialog confirm-dialog-danger stale-block-dialog" role="alertdialog" aria-modal="true" aria-label="Save recovery" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Save recovery needed</p>
        <h2 className="page-title settings-title">{pageTitle}</h2>
        <p className="settings-message save-failure-message">
          Secretary paused autosave because block <span className="stale-block-code">#{blockId}</span> no longer exists on the server.
        </p>
        <p className="settings-message">
          Your local edits are still here. Edit the note or repair this missing block in place to resume autosave.
        </p>
        <div className="confirm-actions stale-block-actions">
          <button type="button" className="settings-button settings-button-secondary" onClick={onKeepLocal}>
            Keep Local Copy
          </button>
          <button type="button" className="settings-button settings-button-danger" onClick={onRepairThisNote}>
            Repair This Note
          </button>
          <button type="button" className="settings-button settings-button-secondary" onClick={onReloadServerCopy}>
            Reload Server Copy
          </button>
        </div>
      </div>
    </div>
  );
}
