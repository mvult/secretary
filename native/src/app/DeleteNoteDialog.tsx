interface DeleteNoteDialogProps {
  title: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteNoteDialog({ title, onCancel, onConfirm }: DeleteNoteDialogProps) {
  if (!title) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onCancel}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="Delete note confirmation" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Delete note</p>
        <h2 className="page-title settings-title">{title}</h2>
        <p className="settings-message">This deletes the note and its blocks.</p>
        <div className="confirm-actions">
          <button type="button" className="settings-button settings-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="settings-button settings-button-danger" onClick={onConfirm}>
            Delete Note
          </button>
        </div>
      </div>
    </div>
  );
}
