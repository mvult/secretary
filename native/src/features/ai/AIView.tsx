import { formatPanelTimestamp } from '../../app/format';
import type { BackendAIThread, BackendAIThreadDetail } from '../../lib/backend';

interface AIViewProps {
  pageTitle: string | null;
  authToken: string;
  workspaceId: number | null;
  aiThreads: BackendAIThread[];
  activeAIThread: BackendAIThread | null;
  activeAIThreadId: number | null;
  aiThreadDetail: BackendAIThreadDetail | null;
  aiDraftMessage: string;
  isLoadingAIThreads: boolean;
  isLoadingAIThread: boolean;
  isSendingAIMessage: boolean;
  onSelectThread: (threadId: number) => void;
  onChangeDraft: (value: string) => void;
  onCreateThread: () => void;
  onDeleteThread: () => void;
  onSendMessage: () => void;
}

export function AIView({
  pageTitle,
  authToken,
  workspaceId,
  aiThreads,
  activeAIThread,
  activeAIThreadId,
  aiThreadDetail,
  aiDraftMessage,
  isLoadingAIThreads,
  isLoadingAIThread,
  isSendingAIMessage,
  onSelectThread,
  onChangeDraft,
  onCreateThread,
  onDeleteThread,
  onSendMessage,
}: AIViewProps) {
  return (
    <section className="ai-shell">
      <header className="page-header">
        <p className="page-date">Workspace memory</p>
        <div className="page-heading-row page-heading-row-directory">
          <div>
            <h2 className="page-title settings-title">AI Threads</h2>
            <p className="directory-breadcrumb">
              {pageTitle ? `Current note context: ${pageTitle}` : 'Workspace-scoped chat persistence'}
            </p>
          </div>
          <span className="page-kind">{aiThreads.length}</span>
        </div>
      </header>

      <div className="ai-layout">
        <aside className="ai-sidebar">
          <div className="settings-actions ai-sidebar-actions">
            <button type="button" className="sync-button" onClick={onCreateThread} disabled={!authToken || !workspaceId}>
              New thread
            </button>
            <button type="button" className="sync-button" onClick={onDeleteThread} disabled={!activeAIThreadId}>
              Delete
            </button>
          </div>

          <div className="search-results ai-thread-results">
            {!authToken || !workspaceId ? (
              <div className="search-empty">Log in and sync to persist AI threads.</div>
            ) : isLoadingAIThreads ? (
              <div className="search-empty">Loading AI threads...</div>
            ) : aiThreads.length === 0 ? (
              <div className="search-empty">No threads yet. Start one for the current note or the whole workspace.</div>
            ) : (
              aiThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="search-result ai-thread-result"
                  data-active={activeAIThread?.id === thread.id ? 'true' : 'false'}
                  onClick={() => onSelectThread(thread.id)}
                >
                  <span className="search-result-title">{thread.title || `Thread ${thread.id}`}</span>
                  <span className="search-result-date">
                    {thread.documentId ? `Doc ${thread.documentId}` : 'Workspace'} - {formatPanelTimestamp(thread.updatedAt || thread.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="ai-main">
          <div className="settings-card ai-thread-card">
            <div className="page-heading-row page-heading-row-directory">
              <div>
                <p className="page-date">Thread</p>
                <h3 className="page-title ai-thread-title">{activeAIThread?.title || 'Start a thread'}</h3>
              </div>
              {activeAIThread ? <span className="page-kind">#{activeAIThread.id}</span> : null}
            </div>

            <div className="ai-thread-meta-row">
              <span className="settings-message">Messages: {aiThreadDetail?.messages.length ?? 0}</span>
              <span className="settings-message">Runs: {aiThreadDetail?.runs.length ?? 0}</span>
              <span className="settings-message">Artifacts: {aiThreadDetail?.artifacts.length ?? 0}</span>
              <span className="settings-message">Sources: {aiThreadDetail?.sourceRefs.length ?? 0}</span>
            </div>

            <div className="ai-message-list">
              {isLoadingAIThread ? (
                <div className="search-empty">Loading thread...</div>
              ) : aiThreadDetail?.messages.length ? (
                aiThreadDetail.messages.map((message) => (
                  <article key={message.id} className="ai-message-card" data-role={message.role}>
                    <div className="ai-message-header">
                      <span className="page-kind">{message.role}</span>
                      <span className="settings-message">{formatPanelTimestamp(message.createdAt)}</span>
                    </div>
                    <p className="ai-message-content">{message.content}</p>
                  </article>
                ))
              ) : (
                <div className="search-empty">No persisted messages yet.</div>
              )}
            </div>
          </div>

          <div className="settings-card ai-composer-card">
            <label className="settings-label" htmlFor="ai-draft-message">Message</label>
            <textarea
              id="ai-draft-message"
              className="settings-input ai-composer-input"
              value={aiDraftMessage}
              placeholder="Ask about this note, queue up a draft, or just start capturing chat history..."
              onChange={(event) => onChangeDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  onSendMessage();
                }
              }}
            />
            <div className="settings-actions">
              <button type="button" className="sync-button" onClick={onSendMessage} disabled={isSendingAIMessage || !authToken || !workspaceId}>
                {isSendingAIMessage ? 'Saving...' : 'Save message'}
              </button>
            </div>
            <p className="settings-message">This first pass only persists threads, messages, runs, artifacts, and citations. Model execution comes next.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
