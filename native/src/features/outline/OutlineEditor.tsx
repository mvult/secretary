import { useMemo, useRef } from 'react';
import type { Dispatch } from 'react';
import { OutlineRow } from './OutlineRow';
import type { OutlineAction } from './state';
import { getSelectedInfo } from './tree';
import type { OutlinePage, OutlineState } from './types';

async function writeSystemClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignore clipboard permission failures and keep internal yank buffer working.
  }
}

async function readSystemClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

interface OutlineEditorProps {
  page: OutlinePage;
  state: OutlineState;
  dispatch: Dispatch<OutlineAction>;
  onOpenDocumentLinkPicker: () => void;
  onFollowDocumentLink: () => void;
  onOpenDocumentLink: (targetDocumentId: number) => void;
}

export function OutlineEditor({ page, state, dispatch, onOpenDocumentLinkPicker, onFollowDocumentLink, onOpenDocumentLink }: OutlineEditorProps) {
  const lastDPressRef = useRef<number | null>(null);
  const lastGPressRef = useRef<number | null>(null);
  const lastBracketPressRef = useRef<number | null>(null);
  const lastYPressRef = useRef<number | null>(null);
  const { focusedNode, selectedIds } = useMemo(() => getSelectedInfo(state), [state]);

  return (
    <div
      className="outline-region"
      data-page-kind={page.kind}
      tabIndex={0}
      onKeyDown={(event) => {
        if (state.editingId) {
          return;
        }

        const rawKey = event.key;
        const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;

        if (rawKey === 'Escape' && state.mode === 'visual') {
          event.preventDefault();
          lastDPressRef.current = null;
          lastGPressRef.current = null;
          lastBracketPressRef.current = null;
          lastYPressRef.current = null;
          dispatch({ type: 'toggleVisualMode' });
          return;
        }

        if ((event.metaKey || event.ctrlKey) && key === 'Enter') {
          event.preventDefault();
          dispatch({ type: 'cycleStatuses' });
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.shiftKey && rawKey === 'ArrowDown') {
          event.preventDefault();
          dispatch({ type: 'moveSelection', direction: 1 });
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.shiftKey && rawKey === 'ArrowUp') {
          event.preventDefault();
          dispatch({ type: 'moveSelection', direction: -1 });
          return;
        }

        if (event.altKey && !event.shiftKey && key === 'j') {
          event.preventDefault();
          dispatch({ type: 'moveSelection', direction: 1 });
          return;
        }

        if (event.altKey && !event.shiftKey && key === 'k') {
          event.preventDefault();
          dispatch({ type: 'moveSelection', direction: -1 });
          return;
        }

        if (key === 'Tab') {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? 'outdent' : 'indent' });
          return;
        }

        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          if (key === 'u') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'undo' });
            return;
          }

          if (rawKey === 'Y') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            if (focusedNode) {
              void writeSystemClipboard(focusedNode.text);
            }
            dispatch({ type: 'yankLine' });
            return;
          }

          if (rawKey === 'G') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'jumpFocus', position: 'end' });
            return;
          }

          if (rawKey === 'I') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'startEditing', placement: 'start' });
            return;
          }

          if (rawKey === 'A') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'startEditing', placement: 'end' });
            return;
          }

          if (rawKey === 'O') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'openAbove' });
            return;
          }

          if (key === 'g') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;

            if (lastGPressRef.current && Date.now() - lastGPressRef.current <= 320) {
              dispatch({ type: 'jumpFocus', position: 'start' });
              lastGPressRef.current = null;
              return;
            }

            lastGPressRef.current = Date.now();
            return;
          }

          if (key === 'y') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;

            if (lastYPressRef.current && Date.now() - lastYPressRef.current <= 320) {
              if (focusedNode) {
                void writeSystemClipboard(focusedNode.text);
              }
              dispatch({ type: 'yankLine' });
              lastYPressRef.current = null;
              return;
            }

            lastYPressRef.current = Date.now();
            return;
          }

          if (key === 'i') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'startEditing', placement: 'current' });
            return;
          }

          if (key === 'v') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'toggleVisualMode' });
            return;
          }

          if (key === 'a') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'startEditing', placement: 'after' });
            return;
          }

          if (key === 'o') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'openBelow' });
            return;
          }

          if (rawKey === '[') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastYPressRef.current = null;

            if (lastBracketPressRef.current && Date.now() - lastBracketPressRef.current <= 320) {
              onOpenDocumentLinkPicker();
              lastBracketPressRef.current = null;
              return;
            }

            lastBracketPressRef.current = Date.now();
            return;
          }

            if (key === 'p') {
              event.preventDefault();
              lastDPressRef.current = null;
              lastGPressRef.current = null;
              lastBracketPressRef.current = null;
              lastYPressRef.current = null;
              void readSystemClipboard().then((text) => {
                dispatch({ type: 'pasteBelow', text: text || undefined, preferStructured: true });
              });
              return;
            }

          if (key === 'd') {
            event.preventDefault();

            if (lastGPressRef.current && Date.now() - lastGPressRef.current <= 320) {
              onFollowDocumentLink();
              lastDPressRef.current = null;
              lastGPressRef.current = null;
              lastBracketPressRef.current = null;
              lastYPressRef.current = null;
              return;
            }

            if (lastDPressRef.current && Date.now() - lastDPressRef.current <= 320) {
              if (focusedNode) {
                void writeSystemClipboard(focusedNode.text);
              }
              dispatch({ type: 'deleteSelection' });
              lastDPressRef.current = null;
              lastGPressRef.current = null;
              lastBracketPressRef.current = null;
              lastYPressRef.current = null;
              return;
            }

            lastDPressRef.current = Date.now();
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            return;
          }

          if (key === 'j' || rawKey === 'ArrowDown') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveFocus', direction: 1, extendSelection: event.shiftKey || state.mode === 'visual' });
            return;
          }

          if (key === 'k' || rawKey === 'ArrowUp') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveFocus', direction: -1, extendSelection: event.shiftKey || state.mode === 'visual' });
            return;
          }

          if (key === 'h') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'left' });
            return;
          }

          if (key === 'l') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'right' });
            return;
          }

          if (key === 'w') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'wordForward' });
            return;
          }

          if (key === 'b') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'wordBackward' });
            return;
          }

          if (key === 'e') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'wordEnd' });
            return;
          }

          if (key === '0') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'lineStart' });
            return;
          }

          if (rawKey === '$') {
            event.preventDefault();
            lastDPressRef.current = null;
            lastGPressRef.current = null;
            lastBracketPressRef.current = null;
            lastYPressRef.current = null;
            dispatch({ type: 'moveCaret', motion: 'lineEnd' });
            return;
          }
        }

        lastDPressRef.current = null;
        lastGPressRef.current = null;
        lastBracketPressRef.current = null;
        lastYPressRef.current = null;
      }}
    >
      <div className="rows">
        {page.nodes.map((node) => (
          <OutlineRow
            key={node.id}
            node={node}
            state={state}
            isFocused={state.focusedId === node.id}
            isSelected={selectedIds.includes(node.id)}
            onFocus={(nodeId) => dispatch({ type: 'focus', nodeId })}
            onStartEditing={() => dispatch({ type: 'startEditing', placement: 'end' })}
            onDraftChange={(text) => dispatch({ type: 'updateDraft', text })}
            onCommit={(text, cursor) => dispatch({ type: 'commitEdit', text, cursor })}
            onCycleStatus={() => dispatch({ type: 'cycleStatuses' })}
            onIndent={(direction) => dispatch({ type: direction })}
            onSplit={(selectionStart, selectionEnd) =>
              dispatch({ type: 'splitNodeAtCursor', selectionStart, selectionEnd })
            }
            onStructuredPaste={(text) => dispatch({ type: 'pasteStructured', text })}
            onToggleStatus={(nodeId) => dispatch({ type: 'toggleNodeStatus', nodeId })}
            onOpenDocumentLink={onOpenDocumentLink}
          />
        ))}
      </div>
    </div>
  );
}
