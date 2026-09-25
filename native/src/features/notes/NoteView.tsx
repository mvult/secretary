import type { ReactNode } from 'react';
import { OutlineEditor } from '../outline/OutlineEditor';
import type { OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { getPageDateLabel } from '../outline/tree';

interface NoteViewProps {
  page: OutlinePage;
  state: OutlineState;
  dispatch: React.Dispatch<OutlineAction>;
  pagesByBackendId: Map<number, OutlinePage>;
  activeNoteDirectoryPath: { name: string }[];
  activePageSaveMessage: string;
  conflictReview?: ReactNode;
  onOpenDocumentLinkPicker: () => void;
  onFollowDocumentLink: () => void;
  onOpenDocumentLink: (targetDocumentId: number) => void;
}

export function NoteView({
  page,
  state,
  dispatch,
  pagesByBackendId,
  activeNoteDirectoryPath,
  activePageSaveMessage,
  conflictReview,
  onOpenDocumentLinkPicker,
  onFollowDocumentLink,
  onOpenDocumentLink,
}: NoteViewProps) {
  return (
    <>
      <header className="page-header note-header-sticky">
        {page.kind === 'note' ? <p className="page-date">{getPageDateLabel(page)}</p> : null}
        <div className="page-heading-row">
          <input
            className="page-title-input"
            type="text"
            value={page.title}
            placeholder="Untitled note"
            onChange={(event) => dispatch({ type: 'updatePageTitle', title: event.target.value })}
          />
          {activeNoteDirectoryPath.length > 0 ? (
            <span className="page-kind page-save-status" title={activePageSaveMessage || activeNoteDirectoryPath.map((entry) => entry.name).join(' / ')}>{activePageSaveMessage || activeNoteDirectoryPath.map((entry) => entry.name).join(' / ')}</span>
          ) : null}
          {activeNoteDirectoryPath.length === 0 && activePageSaveMessage ? (
            <span className="page-kind page-save-status" title={activePageSaveMessage}>{activePageSaveMessage}</span>
          ) : null}
        </div>
      </header>

      {conflictReview}

      <OutlineEditor
        page={page}
        state={state}
        dispatch={dispatch}
        pagesByBackendId={pagesByBackendId}
        onOpenDocumentLinkPicker={onOpenDocumentLinkPicker}
        onFollowDocumentLink={onFollowDocumentLink}
        onOpenDocumentLink={onOpenDocumentLink}
      />
    </>
  );
}
