import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPanelTimestamp } from '../../app/format';
import type { BackendAISourceRef, BackendAIThread, BackendAIThreadDetail } from '../../lib/backend';

interface AIViewProps {
  pageTitle: string | null;
  authToken: string;
  workspaceId: number | null;
  aiThreads: BackendAIThread[];
  activeAIThread: BackendAIThread | null;
  aiThreadDetail: BackendAIThreadDetail | null;
  aiDraftMessage: string;
  isLoadingAIThreads: boolean;
  isLoadingAIThread: boolean;
  isSendingAIMessage: boolean;
  isUpdatingThreadTitle: boolean;
  pendingAIMessage: string;
  onSelectThread: (threadId: number) => void;
  onChangeDraft: (value: string) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: number, title: string) => void;
  onDeleteThread: (threadId: number) => void;
  onSendMessage: () => void;
}

interface DeleteAIThreadDialogProps {
  thread: BackendAIThread | null;
  onCancel: () => void;
  onConfirm: (threadId: number) => void;
}

function DeleteAIThreadDialog({ thread, onCancel, onConfirm }: DeleteAIThreadDialogProps) {
  if (!thread) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onCancel}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="Delete thread confirmation" onClick={(event) => event.stopPropagation()}>
        <p className="page-date">Delete thread</p>
        <h2 className="page-title settings-title">{thread.title || `Thread ${thread.id}`}</h2>
        <p className="settings-message">This deletes the thread and its persisted messages.</p>
        <div className="confirm-actions">
          <button type="button" className="settings-button settings-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="settings-button settings-button-danger" onClick={() => onConfirm(thread.id)}>
            Delete Thread
          </button>
        </div>
      </div>
    </div>
  );
}

interface AISourcesDialogProps {
  sources: BackendAISourceRef[];
  onClose: () => void;
}

function AISourcesDialog({ sources, onClose }: AISourcesDialogProps) {
  if (!sources.length) {
    return null;
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div className="confirm-dialog ai-sources-dialog" role="dialog" aria-modal="true" aria-label="Thread sources" onClick={(event) => event.stopPropagation()}>
        <div className="page-heading-row page-heading-row-directory">
          <div>
            <p className="page-date">Sources</p>
            <h2 className="page-title settings-title">Loaded context</h2>
          </div>
          <span className="page-kind">{sources.length}</span>
        </div>
        <div className="ai-sources-list">
          {sources.map((source) => (
            <article key={source.id} className="ai-source-card">
              <div className="ai-message-header">
                <span className="page-kind">{source.sourceKind}</span>
                <span className="settings-message">#{source.sourceId}</span>
              </div>
              <p className="ai-source-label">{source.label || 'Untitled source'}</p>
              {source.quoteText ? <p className="ai-source-quote">{source.quoteText}</p> : null}
            </article>
          ))}
        </div>
        <div className="confirm-actions">
          <button type="button" className="settings-button settings-button-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function AIView({
  pageTitle,
  authToken,
  workspaceId,
  aiThreads,
  activeAIThread,
  aiThreadDetail,
  aiDraftMessage,
  isLoadingAIThreads,
  isLoadingAIThread,
  isSendingAIMessage,
  isUpdatingThreadTitle,
  pendingAIMessage,
  onSelectThread,
  onChangeDraft,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
  onSendMessage,
}: AIViewProps) {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [menuThreadId, setMenuThreadId] = useState<number | null>(null);
  const [threadPendingDelete, setThreadPendingDelete] = useState<BackendAIThread | null>(null);
  const [isSourcesOpen, setIsSourcesOpen] = useState(false);
  const uniqueSources = useMemo(() => {
    const deduped = new Map<string, BackendAISourceRef>();
    for (const source of aiThreadDetail?.sourceRefs ?? []) {
      const key = `${source.sourceKind}:${source.sourceId}`;
      if (!deduped.has(key)) {
        deduped.set(key, source);
      }
    }
    return Array.from(deduped.values());
  }, [aiThreadDetail?.sourceRefs]);

  useEffect(() => {
    setTitleDraft(activeAIThread?.title ?? '');
    setMenuThreadId(null);
    setIsSourcesOpen(false);
  }, [activeAIThread?.id, activeAIThread?.title]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [aiThreadDetail?.messages, isLoadingAIThread, isSendingAIMessage, pendingAIMessage]);

  const submitTitle = () => {
    if (!activeAIThread) {
      return;
    }
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === activeAIThread.title) {
      setTitleDraft(activeAIThread.title);
      return;
    }
    onRenameThread(activeAIThread.id, nextTitle);
  };

  return (
    <>
      <section className="ai-shell">
        <div className="ai-layout">
          <aside className="ai-sidebar">
            <div className="settings-actions ai-sidebar-actions">
              <button type="button" className="sync-button ai-new-thread-button" onClick={onCreateThread} disabled={!authToken || !workspaceId} aria-label="New thread">
                +
              </button>
            </div>

            <div className="search-results ai-thread-results">
              {!authToken || !workspaceId ? (
                <div className="search-empty">Log in and sync to persist threads.</div>
              ) : isLoadingAIThreads ? (
                <div className="search-empty">Loading threads...</div>
              ) : aiThreads.length === 0 ? (
                <div className="search-empty">No threads yet. Start one for the current note or the whole workspace.</div>
              ) : (
                aiThreads.map((thread) => (
                  <div
                    key={thread.id}
                    className="search-result ai-thread-result"
                    data-active={activeAIThread?.id === thread.id ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="ai-thread-select"
                      onClick={() => onSelectThread(thread.id)}
                    >
                      <span className="search-result-title">{thread.title || `Thread ${thread.id}`}</span>
                      <span className="search-result-date">
                        {formatPanelTimestamp(thread.updatedAt || thread.createdAt)}
                      </span>
                    </button>
                    <div className="ai-thread-menu-shell">
                      <button
                        type="button"
                        className="settings-trigger ai-thread-menu-trigger"
                        aria-label={`Thread actions for ${thread.title || `Thread ${thread.id}`}`}
                        aria-expanded={menuThreadId === thread.id}
                        onClick={() => setMenuThreadId((current) => (current === thread.id ? null : thread.id))}
                      >
                        <span />
                        <span />
                        <span />
                      </button>
                      {menuThreadId === thread.id ? (
                        <div className="toolbar-menu-dropdown ai-thread-menu-dropdown" role="menu" aria-label="Thread actions">
                          <button
                            type="button"
                            className="toolbar-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setMenuThreadId(null);
                              setThreadPendingDelete(thread);
                            }}
                          >
                            Delete thread
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>

          <div className="ai-main">
            <div className="settings-card ai-thread-card">
              {activeAIThread ? (
                <div className="ai-thread-title-editor-row">
                  <input
                    id="ai-thread-title-input"
                    className="settings-input ai-thread-title-input"
                    type="text"
                    placeholder="Thread title"
                    value={titleDraft}
                    disabled={isUpdatingThreadTitle}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={submitTitle}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        submitTitle();
                      }
                    }}
                  />
                </div>
              ) : null}

              <div className="ai-thread-meta-row">
                <span className="settings-message">Messages: {aiThreadDetail?.messages.length ?? 0}</span>
                <span className="settings-message">Runs: {aiThreadDetail?.runs.length ?? 0}</span>
                <span className="settings-message">Artifacts: {aiThreadDetail?.artifacts.length ?? 0}</span>
                {pageTitle ? <span className="settings-message">Attached note: {pageTitle}</span> : null}
                <button
                  type="button"
                  className="ai-meta-button"
                  disabled={!uniqueSources.length}
                  onClick={() => setIsSourcesOpen(true)}
                >
                  Sources: {uniqueSources.length}
                </button>
              </div>

              <div className="ai-message-list" ref={messageListRef}>
                {isLoadingAIThread ? (
                  <div className="search-empty">Loading thread...</div>
                ) : aiThreadDetail?.messages.length || pendingAIMessage || isSendingAIMessage ? (
                  <>
                    {aiThreadDetail?.messages.map((message) => (
                      <article key={message.id} className="ai-message-card" data-role={message.role}>
                        <p className="ai-message-content">{message.content}</p>
                      </article>
                    ))}
                    {pendingAIMessage ? (
                      <article className="ai-message-card" data-role="user" data-pending="true">
                        <p className="ai-message-content">{pendingAIMessage}</p>
                      </article>
                    ) : null}
                    {isSendingAIMessage ? (
                      <article className="ai-message-card ai-message-loading" data-role="assistant" aria-label="Assistant is thinking">
                        <div className="ai-loading-dots" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </div>
                      </article>
                    ) : null}
                  </>
                ) : (
                  <div className="search-empty">No persisted messages yet.</div>
                )}
              </div>
            </div>

            <div className="ai-composer-card">
              <textarea
                id="ai-draft-message"
                className="settings-input ai-composer-input"
                value={aiDraftMessage}
                placeholder="Ask about this note, queue up a draft, or just start capturing chat history..."
                onChange={(event) => onChangeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !isSendingAIMessage && authToken && workspaceId) {
                    event.preventDefault();
                    onSendMessage();
                  }
                }}
              />
              {isSendingAIMessage ? <p className="settings-message">Running...</p> : null}
            </div>
          </div>
        </div>
      </section>
      <DeleteAIThreadDialog
        thread={threadPendingDelete}
        onCancel={() => setThreadPendingDelete(null)}
        onConfirm={(threadId) => {
          onDeleteThread(threadId);
          setThreadPendingDelete(null);
        }}
      />
      {isSourcesOpen ? (
        <AISourcesDialog
          sources={uniqueSources}
          onClose={() => setIsSourcesOpen(false)}
        />
      ) : null}
    </>
  );
}
