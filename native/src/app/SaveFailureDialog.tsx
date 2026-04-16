interface SaveFailureDialogProps {
  pageTitle: string | null;
  message: string;
  onClose: () => void;
}

export function SaveFailureDialog({ pageTitle, message, onClose }: SaveFailureDialogProps) {
  if (!pageTitle) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div className="confirm-dialog confirm-dialog-danger save-failure-dialog" role="alertdialog" aria-modal="true" aria-label="Save failed" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Save failed</p>
        <h2 className="page-title settings-title">{pageTitle}</h2>
        <p className="settings-message save-failure-message">
          Secretary was not able to persist your latest edits for this document.
        </p>
        <p className="settings-message save-failure-detail">{message}</p>
        <div className="confirm-actions">
          <button type="button" className="settings-button settings-button-danger" onClick={onClose}>
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}
