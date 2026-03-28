import { OutlineEditor } from '../outline/OutlineEditor';
import { OutlineText } from '../outline/OutlineText';
import { getMarkdownHeadingLevel } from '../outline/OutlineText';
import { getNodeDepth, getPageDateLabel } from '../outline/tree';
import type { OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import { formatInlineTodoStatus } from '../../app/format';

interface JournalsViewProps {
  journals: OutlinePage[];
  journalPage: OutlinePage | null;
  state: OutlineState;
  dispatch: React.Dispatch<OutlineAction>;
  pagesByBackendId: Map<number, OutlinePage>;
  activePageSaveMessage: string;
  onSelectJournalPage: (pageId: string) => void;
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
  onSelectJournalPage,
  onOpenDocumentLinkPicker,
  onFollowDocumentLink,
  onOpenDocumentLink,
}: JournalsViewProps) {
  return (
    <>
      <header className="page-header page-header-stacked">
        <div className="page-heading-row">
          <h2 className="page-title journal-stack-title">Journals</h2>
        </div>
      </header>

      <div className="journal-stack">
        {journals.map((journal) => {
          const isActive = state.activePageId === journal.id;

          return (
            <article key={journal.id} className="journal-card" data-active={isActive}>
              <button
                type="button"
                className="journal-card-header"
                onClick={() => onSelectJournalPage(journal.id)}
              >
                <div className="journal-card-heading">
                  <h3 className="page-title">{getPageDateLabel(journal)}</h3>
                  {isActive && activePageSaveMessage ? (
                    <span className="page-kind">{activePageSaveMessage}</span>
                  ) : journalPage?.id === journal.id ? (
                    <span className="page-kind">Today</span>
                  ) : null}
                </div>
              </button>

              {isActive ? (
                <OutlineEditor
                  page={journal}
                  state={state}
                  dispatch={dispatch}
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
                      style={{ paddingLeft: `${12 + getNodeDepth(journal.nodes, node.id) * 24}px` }}
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
