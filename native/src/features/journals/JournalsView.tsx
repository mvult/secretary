import { useMemo, type ReactNode } from 'react';
import { OutlineEditor } from '../outline/OutlineEditor';
import { OutlineText } from '../outline/OutlineText';
import { getMarkdownHeadingLevel } from '../outline/OutlineText';
import { getNodeDepths, getPageDateLabel } from '../outline/tree';
import type { OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { formatInlineTodoStatus } from '../../app/format';
import { useJournalPreviews } from './useJournalPreviews';

interface JournalsViewProps {
  journals: OutlinePage[];
  journalPage: OutlinePage | null;
  state: OutlineState;
  dispatch: React.Dispatch<OutlineAction>;
  pagesByBackendId: Map<number, OutlinePage>;
  activePageSaveMessage: string;
  renderConflict?: (page: OutlinePage) => ReactNode;
  onSelectJournalPage: (pageId: string) => void;
  online?: boolean;
  loadJournal?: (pageId: string) => Promise<OutlinePage>;
  onOpenDocumentLinkPicker: () => void;
  onFollowDocumentLink: () => void;
  onOpenDocumentLink: (targetDocumentId: number) => void;
}

export function JournalsView({
  journals,
  journalPage,
  state,
  dispatch,
  pagesByBackendId,
  activePageSaveMessage,
  renderConflict,
  onSelectJournalPage,
  online = false,
  loadJournal,
  onOpenDocumentLinkPicker,
  onFollowDocumentLink,
  onOpenDocumentLink,
}: JournalsViewProps) {
  const { stackRef, errors } = useJournalPreviews(journals, online, loadJournal);
  const journalNodeDepths = useMemo(
    () => new Map(
      journals
        .filter((journal) => journal.id !== state.activePageId)
        .map((journal) => [journal.id, getNodeDepths(journal.nodes)]),
    ),
    [journals, state.activePageId],
  );

  return (
    <>
      <header className="page-header page-header-stacked">
        <div className="page-heading-row">
          <h2 className="page-title journal-stack-title">Journals</h2>
        </div>
      </header>

      <div className="journal-stack" ref={stackRef}>
        {journals.map((journal) => {
          const isActive = state.activePageId === journal.id;

          return (
            <article key={journal.id} className="journal-card" data-active={isActive} data-journal-id={journal.id} data-uncached={Boolean(journal.metadataOnly)}>
              <button
                type="button"
                className="journal-card-header"
                onClick={() => onSelectJournalPage(journal.id)}
              >
                <div className="journal-card-heading">
                  <h3 className="page-title">{getPageDateLabel(journal)}</h3>
                  {isActive && activePageSaveMessage ? (
                    <span className="page-kind page-save-status" title={activePageSaveMessage}>{activePageSaveMessage}</span>
                  ) : journalPage?.id === journal.id ? (
                    <span className="page-kind page-save-status" title="Today">Today</span>
                  ) : null}
                </div>
              </button>

              {renderConflict?.(journal)}

               {journal.metadataOnly ? <div className="journal-preview">{!online ? 'Not cached offline' : errors[journal.id] ? 'Could not load journal. Select its date to retry.' : 'Loading…'}</div> : isActive ? (
                <OutlineEditor
                  page={journal}
                  state={state}
                  dispatch={dispatch}
                  pagesByBackendId={pagesByBackendId}
                  onOpenDocumentLinkPicker={onOpenDocumentLinkPicker}
                  onFollowDocumentLink={onFollowDocumentLink}
                  onOpenDocumentLink={onOpenDocumentLink}
                />
              ) : (
                <div className="journal-preview">
                  {journal.nodes.map((node) => (
                    <div
                      key={node.id}
                      className="row journal-preview-row"
                      data-has-status={Boolean(node.todoStatus)}
                      data-focused="false"
                      data-selected="false"
                      data-editing="false"
                      style={{ paddingLeft: `${12 + (journalNodeDepths.get(journal.id)?.get(node.id) ?? 0) * 24}px` }}
                    >
                      <span className="row-gutter" aria-hidden="true">•</span>
                      {node.todoStatus ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          className="status-chip status-chip-button"
                          data-status={node.todoStatus}
                          onClick={() => dispatch({ type: 'toggleNodeStatus', nodeId: node.id })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              dispatch({ type: 'toggleNodeStatus', nodeId: node.id });
                            }
                          }}
                        >
                          {formatInlineTodoStatus(node.todoStatus)}
                        </span>
                      ) : null}
                      <div className="row-content journal-preview-content">
                        <p className="row-text" data-status={node.todoStatus ?? 'none'} data-heading-level={getMarkdownHeadingLevel(node.text) || undefined}>
                          <OutlineText text={node.text} pagesByBackendId={pagesByBackendId} onOpenDocumentLink={onOpenDocumentLink} />
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
