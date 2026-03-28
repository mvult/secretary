import type { DirectoryEntry, DirectoryPrompt } from '../../app/types';
import { getPageTitle } from '../outline/tree';

interface DirectoryViewProps {
  directoryPath: { name: string }[];
  directoryEntries: DirectoryEntry[];
  activeDirectoryEntry: DirectoryEntry | null;
  directoryPrompt: DirectoryPrompt | null;
  directoryPromptValue: string;
  directoryPromptInputRef: React.RefObject<HTMLInputElement | null>;
  directoryClipboardPage: { title: string } | null;
  directoryClipboardDirectory: { name: string } | null;
  directoryClipboardMode: 'move' | 'copy' | null;
  onChangePromptValue: (value: string) => void;
  onSubmitPrompt: () => void;
  onSelectEntry: (entry: DirectoryEntry) => void;
  onOpenEntry: (entry: DirectoryEntry | null) => void;
}

export function DirectoryView({
  directoryPath,
  directoryEntries,
  activeDirectoryEntry,
  directoryPrompt,
  directoryPromptValue,
  directoryPromptInputRef,
  directoryClipboardPage,
  directoryClipboardDirectory,
  directoryClipboardMode,
  onChangePromptValue,
  onSubmitPrompt,
  onSelectEntry,
  onOpenEntry,
}: DirectoryViewProps) {
  return (
    <section className="directory-shell">
      <header className="page-header">
        <p className="page-date">Open note</p>
        <div className="page-heading-row page-heading-row-directory">
          <div>
            <h2 className="page-title settings-title">Directories</h2>
            <p className="directory-breadcrumb">
              Root{directoryPath.length > 0 ? ` / ${directoryPath.map((entry) => entry.name).join(' / ')}` : ''}
            </p>
          </div>
          <span className="page-kind">{directoryEntries.length}</span>
        </div>
      </header>

      <div className="directory-panel">
        {directoryPrompt ? (
          <div className="settings-card directory-inline-form">
            <label className="settings-label" htmlFor="directory-prompt-input">
              {directoryPrompt.kind === 'create-directory'
                ? 'New directory'
                : directoryPrompt.kind === 'rename-directory'
                  ? 'Rename directory'
                  : 'Rename note'}
            </label>
            <input
              id="directory-prompt-input"
              ref={directoryPromptInputRef}
              className="settings-input"
              type="text"
              value={directoryPromptValue}
              onChange={(event) => onChangePromptValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  onSubmitPrompt();
                }
              }}
            />
          </div>
        ) : null}

        <div className="directory-toolbar">
          {directoryClipboardPage ? <span className="settings-message">Move note: {directoryClipboardPage.title}</span> : null}
          {directoryClipboardDirectory && directoryClipboardMode === 'move' ? <span className="settings-message">Move dir: {directoryClipboardDirectory.name}</span> : null}
          {directoryClipboardDirectory && directoryClipboardMode === 'copy' ? <span className="settings-message">Copy dir: {directoryClipboardDirectory.name}</span> : null}
        </div>

        <div className="search-results">
          {directoryEntries.length > 0 ? directoryEntries.map((entry, index) => {
            const isActive = activeDirectoryEntry?.key === entry.key;
            const previousEntry = index > 0 ? directoryEntries[index - 1] : null;
            const startsNoteGroup = entry.kind === 'note' && previousEntry?.kind === 'directory';
            return (
              <button
                key={entry.key}
                type="button"
                className="search-result directory-result"
                data-active={isActive ? 'true' : 'false'}
                data-kind={entry.kind}
                data-starts-note-group={startsNoteGroup ? 'true' : 'false'}
                onClick={() => {
                  onSelectEntry(entry);
                  onOpenEntry(entry);
                }}
              >
                <span className="directory-result-icon" data-kind={entry.kind} aria-hidden="true">
                  <span className="directory-result-icon-shape" />
                </span>
                <span className="search-result-title">{entry.kind === 'directory' ? entry.directory?.name : getPageTitle(entry.page!)}</span>
                <span className="search-result-date">{entry.kind === 'directory' ? 'Directory' : 'Note'}</span>
              </button>
            );
          }) : (
            <div className="search-empty">Nothing here yet. Root-level notes still show up outside any directory.</div>
          )}
        </div>
      </div>
    </section>
  );
}
