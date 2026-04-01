import { useEffect, useMemo, useRef } from 'react';
import { getMarkdownHeadingLevel, OutlineText } from './OutlineText';
import { ESCAPE_SEQUENCE_MS } from './keymap';
import { getCurrentPage, getNodeDepth } from './tree';
import type { OutlineNode, OutlineState } from './types';

interface OutlineRowProps {
  node: OutlineNode;
  state: OutlineState;
  isFocused: boolean;
  isSelected: boolean;
  onFocus: (nodeId: string) => void;
  onStartEditing: () => void;
  onDraftChange: (text: string) => void;
  onCommit: (text?: string, cursor?: number) => void;
  onCycleStatus: () => void;
  onIndent: (direction: 'indent' | 'outdent') => void;
  onSplit: (selectionStart: number, selectionEnd: number) => void;
  onMergeWithPrevious: () => void;
  onStructuredPaste: (text: string) => void;
  onToggleStatus: (nodeId: string) => void;
  onOpenDocumentLink: (targetDocumentId: number) => void;
}

function looksLikeStructuredPaste(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
  return lines.length > 1 && lines.every((line) => /^\s*[-*+]\s+/.test(line));
}

function formatTodoStatus(status: string) {
  switch (status) {
    case 'todo':
      return '☐';
    case 'doing':
      return 'DOING';
    case 'done':
      return '☑';
    default:
      return status;
  }
}

export function OutlineRow({
  node,
  state,
  isFocused,
  isSelected,
  onFocus,
  onStartEditing,
  onDraftChange,
  onCommit,
  onCycleStatus,
  onIndent,
  onSplit,
  onMergeWithPrevious,
  onStructuredPaste,
  onToggleStatus,
  onOpenDocumentLink,
}: OutlineRowProps) {
  const isEditing = state.editingId === node.id;
  const page = getCurrentPage(state);
  const depth = getNodeDepth(page?.nodes ?? [], node.id);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastJPressRef = useRef<number | null>(null);
  const wasEditingRef = useRef(false);
  const normalCursor = Math.max(0, Math.min(state.normalCursor, node.text.length));
  const headingLevel = getMarkdownHeadingLevel(node.text);
  const pagesByBackendId = useMemo(
    () => new Map(state.pages.filter((entry) => entry.backendId).map((entry) => [entry.backendId!, entry])),
    [state.pages],
  );

  useEffect(() => {
    if (isEditing) {
      if (!wasEditingRef.current) {
        textareaRef.current?.focus();
        const length = state.draftText.length;
        const cursor = typeof state.editCursor === 'number'
          ? Math.max(0, Math.min(state.editCursor, length))
          : state.editCursor === 'end'
            ? length
            : 0;
        textareaRef.current?.setSelectionRange(cursor, cursor);
      }
      wasEditingRef.current = true;
      return;
    }

    wasEditingRef.current = false;

    if (isFocused) {
      buttonRef.current?.focus();
    }
  }, [isEditing, isFocused, state.draftText, state.editCursor]);

  return (
    <div
      className="row"
      data-node-id={node.id}
      data-has-status={Boolean(node.todoStatus)}
      data-focused={isFocused}
      data-selected={isSelected}
      data-editing={isEditing}
      style={{ paddingLeft: `${12 + depth * 24}px` }}
    >
      <span className="row-gutter" aria-hidden="true">
        •
      </span>

      {node.todoStatus ? (
        <span
          role="button"
          tabIndex={-1}
          className="status-chip status-chip-button"
          data-status={node.todoStatus}
          onClick={() => onToggleStatus(node.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggleStatus(node.id);
            }
          }}
        >
          {formatTodoStatus(node.todoStatus)}
        </span>
      ) : null}

      <div className="row-content">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="editor-input"
            value={state.draftText}
            rows={Math.max(3, state.draftText.split('\n').length)}
            onChange={(event) => onDraftChange(event.target.value)}
            onBlur={() => {
              const value = textareaRef.current?.value ?? state.draftText;
              const cursor = textareaRef.current?.selectionStart ?? value.length;
              onCommit(value, cursor);
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text/plain');
              if (!looksLikeStructuredPaste(text)) {
                return;
              }

              event.preventDefault();
              onStructuredPaste(text);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                onCycleStatus();
                return;
              }

              if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                lastJPressRef.current = null;
                onIndent(event.shiftKey ? 'outdent' : 'indent');
                return;
              }

              if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                const selectionStart = textareaRef.current?.selectionStart ?? state.draftText.length;
                const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
                onSplit(selectionStart, selectionEnd);
                return;
              }

              if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                const selectionStart = textareaRef.current?.selectionStart ?? state.draftText.length;
                const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;

                if (selectionStart === 0 && selectionEnd === 0) {
                  event.preventDefault();
                  onMergeWithPrevious();
                  return;
                }
              }

              if (event.key === 'j' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                lastJPressRef.current = Date.now();
                return;
              }

              if (
                event.key === 'k' &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                lastJPressRef.current &&
                Date.now() - lastJPressRef.current <= ESCAPE_SEQUENCE_MS
              ) {
                event.preventDefault();
                const currentValue = textareaRef.current?.value ?? state.draftText;
                const caret = textareaRef.current?.selectionStart ?? currentValue.length;
                const escapedValue = currentValue.slice(caret - 1, caret) === 'j'
                  ? `${currentValue.slice(0, caret - 1)}${currentValue.slice(caret)}`
                  : currentValue;
                const nextCaret = Math.max(0, caret - (escapedValue === currentValue ? 0 : 1));
                onCommit(escapedValue, nextCaret);
                lastJPressRef.current = null;
                return;
              }

              lastJPressRef.current = null;
            }}
          />
        ) : (
          <div
            ref={buttonRef}
            className="row-activator"
            tabIndex={-1}
            onClick={() => onFocus(node.id)}
            onDoubleClick={() => {
              onFocus(node.id);
              onStartEditing();
            }}
          >
            <p className="row-text" data-status={node.todoStatus ?? 'none'} data-heading-level={headingLevel || undefined}>
              <OutlineText
                text={node.text}
                cursor={isFocused ? normalCursor : undefined}
                pagesByBackendId={pagesByBackendId}
                onOpenDocumentLink={onOpenDocumentLink}
              />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
