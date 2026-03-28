import { getPageDateLabel, getPageTitle } from '../outline/tree';
import type { OutlinePage } from '../outline/types';

interface DocumentLinkDialogProps {
  isOpen: boolean;
  query: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  matches: OutlinePage[];
  activeMatch: OutlinePage | null;
  onClose: () => void;
  onChangeQuery: (value: string) => void;
  onMove: (direction: 1 | -1) => void;
  onInsert: (page: OutlinePage | null) => void;
}

export function DocumentLinkDialog({ isOpen, query, inputRef, matches, activeMatch, onClose, onChangeQuery, onMove, onInsert }: DocumentLinkDialogProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div className="confirm-dialog document-link-dialog" role="dialog" aria-modal="true" aria-label="Insert document link" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Insert document link</p>
        <div className="page-heading-row page-heading-row-search">
          <h2 className="page-title settings-title">[[ target ]]</h2>
          <span className="page-kind">{matches.length}</span>
        </div>
        <input
          ref={inputRef}
          className="page-title-input search-input"
          type="text"
          value={query}
          placeholder="Find a note or journal"
          onChange={(event) => onChangeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'j') {
              event.preventDefault();
              onMove(1);
              return;
            }

            if (event.key === 'ArrowUp' || event.key === 'k') {
              event.preventDefault();
              onMove(-1);
              return;
            }

            if (event.key === 'Enter') {
              event.preventDefault();
              onInsert(activeMatch);
              return;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="search-results document-link-results">
          {matches.length > 0 ? (
            matches.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="search-result document-link-result"
                data-active={activeMatch?.id === entry.id ? 'true' : 'false'}
                data-kind={entry.kind}
                onClick={() => onInsert(entry)}
              >
                <span className="search-result-title">{getPageTitle(entry)}</span>
                <span className="search-result-date">{entry.kind === 'journal' ? 'Journal' : 'Note'} - {getPageDateLabel(entry)}</span>
              </button>
            ))
          ) : (
            <div className="search-empty">No matching documents.</div>
          )}
        </div>
      </div>
    </div>
  );
}
