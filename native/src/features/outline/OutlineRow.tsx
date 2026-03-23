import { useEffect, useRef } from 'react';
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
  onSplit: (selectionStart: number, selectionEnd: number) => void;
  onToggleStatus: (nodeId: string) => void;
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
  onSplit,
  onToggleStatus,
}: OutlineRowProps) {
  const isEditing = state.editingId === node.id;
  const page = getCurrentPage(state);
  const depth = getNodeDepth(page?.nodes ?? [], node.id);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastJPressRef = useRef<number | null>(null);
  const wasEditingRef = useRef(false);
  const normalCursor = Math.max(0, Math.min(state.normalCursor, node.text.length));
  const beforeCursor = node.text.slice(0, normalCursor);
  const atCursor = node.text.slice(normalCursor, normalCursor + 1);
  const afterCursor = node.text.slice(normalCursor + 1);

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
      data-has-status={node.status !== 'note'}
      data-focused={isFocused}
      data-selected={isSelected}
      data-editing={isEditing}
      style={{ paddingLeft: `${12 + depth * 24}px` }}
    >
      <span className="row-gutter" aria-hidden="true">
        •
      </span>

      {node.status === 'note' ? null : (
        <button
          type="button"
          className="status-chip status-chip-button"
          data-status={node.status}
          onClick={() => onToggleStatus(node.id)}
        >
          {node.status}
        </button>
      )}

      <span className="row-content">
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
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                onCycleStatus();
                return;
              }

              if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                const selectionStart = textareaRef.current?.selectionStart ?? state.draftText.length;
                const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
                onSplit(selectionStart, selectionEnd);
                return;
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
          <button
            ref={buttonRef}
            type="button"
            className="row-activator"
            onClick={() => onFocus(node.id)}
            onDoubleClick={() => {
              onFocus(node.id);
              onStartEditing();
            }}
          >
            <p className="row-text">
              {isFocused ? (
                <>
                  <span>{beforeCursor}</span>
                  <span className="row-caret">{atCursor || ' '}</span>
                  <span>{afterCursor}</span>
                </>
              ) : (
                node.text
              )}
            </p>
          </button>
        )}
      </span>
    </div>
  );
}
