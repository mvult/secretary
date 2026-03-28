import { useEffect } from 'react';
import { cycleTodoStatus } from './format';
import { TODO_STATUS_ORDER, type DirectoryEntry } from './types';
import type { BackendAIThread, BackendTodo } from '../lib/backend';
import type { OutlineState } from '../features/outline/types';

interface UseGlobalHotkeysOptions {
  state: OutlineState;
  isToolbarMenuOpen: boolean;
  setIsToolbarMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pendingDeleteNoteId: string | null;
  setPendingDeleteNoteId: React.Dispatch<React.SetStateAction<string | null>>;
  isDocumentLinkPickerOpen: boolean;
  closeDocumentLinkPicker: () => void;
  resetSearchView: () => void;
  directoryPrompt: { kind: string } | null;
  setDirectoryPrompt: React.Dispatch<React.SetStateAction<any>>;
  setDirectoryPromptValue: React.Dispatch<React.SetStateAction<string>>;
  submitDirectoryPrompt: () => Promise<void>;
  activeDirectoryEntry: DirectoryEntry | null;
  directoryEntries: DirectoryEntry[];
  currentDirectory: { parentId: number } | null;
  enterDirectory: (directoryId: number | null) => void;
  openCreateDirectoryPrompt: () => void;
  renameDirectoryEntry: () => Promise<void>;
  pasteClipboardHere: () => Promise<void>;
  clearPendingDirectoryMove: () => void;
  lastDirectoryDPressRef: React.MutableRefObject<number | null>;
  pendingDirectoryMoveTimerRef: React.MutableRefObject<number | null>;
  moveSelectedDirectoryToClipboard: () => void;
  deleteSelectedDirectory: () => Promise<void>;
  cutSelectedNoteToClipboard: () => void;
  copySelectedDirectoryToClipboard: () => void;
  setActiveDirectoryEntryKey: React.Dispatch<React.SetStateAction<string | null>>;
  openDirectoryEntry: (entry: DirectoryEntry | null) => void;
  filteredTodos: BackendTodo[];
  activeTodo: BackendTodo | null;
  setActiveTodoId: React.Dispatch<React.SetStateAction<number | null>>;
  lastTodoGPressRef: React.MutableRefObject<number | null>;
  openTodoSource: (todo: BackendTodo) => void;
  handleTodoStatusChange: (todo: BackendTodo, nextStatus: BackendTodo['status']) => Promise<void>;
  updatingTodoId: number | null;
  aiThreads: BackendAIThread[];
  activeAIThread: BackendAIThread | null;
  setActiveAIThreadId: React.Dispatch<React.SetStateAction<number | null>>;
  jumpBack: () => void;
  jumpForward: () => void;
  dispatchAfterFlush: (action: any) => void;
  openDirectoryBrowser: () => void;
}

export function useGlobalHotkeys({
  state,
  isToolbarMenuOpen,
  setIsToolbarMenuOpen,
  pendingDeleteNoteId,
  setPendingDeleteNoteId,
  isDocumentLinkPickerOpen,
  closeDocumentLinkPicker,
  resetSearchView,
  directoryPrompt,
  setDirectoryPrompt,
  setDirectoryPromptValue,
  submitDirectoryPrompt,
  activeDirectoryEntry,
  directoryEntries,
  currentDirectory,
  enterDirectory,
  openCreateDirectoryPrompt,
  renameDirectoryEntry,
  pasteClipboardHere,
  clearPendingDirectoryMove,
  lastDirectoryDPressRef,
  pendingDirectoryMoveTimerRef,
  moveSelectedDirectoryToClipboard,
  deleteSelectedDirectory,
  cutSelectedNoteToClipboard,
  copySelectedDirectoryToClipboard,
  setActiveDirectoryEntryKey,
  openDirectoryEntry,
  filteredTodos,
  activeTodo,
  setActiveTodoId,
  lastTodoGPressRef,
  openTodoSource,
  handleTodoStatusChange,
  updatingTodoId,
  aiThreads,
  activeAIThread,
  setActiveAIThreadId,
  jumpBack,
  jumpForward,
  dispatchAfterFlush,
  openDirectoryBrowser,
}: UseGlobalHotkeysOptions) {
  useEffect(() => {
    const handleEscapeCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleEscapeCapture, true);
    return () => window.removeEventListener('keydown', handleEscapeCapture, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormTarget = target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
      );

      if (event.key === 'Escape' && isToolbarMenuOpen) {
        event.preventDefault();
        setIsToolbarMenuOpen(false);
        return;
      }

      if (event.key === 'Escape' && pendingDeleteNoteId) {
        event.preventDefault();
        setPendingDeleteNoteId(null);
        return;
      }

      if (event.key === 'Escape' && isDocumentLinkPickerOpen) {
        event.preventDefault();
        closeDocumentLinkPicker();
        return;
      }

      if (event.key === 'Escape' && (state.activeView === 'search' || state.activeView === 'settings' || state.activeView === 'todos' || state.activeView === 'directory' || state.activeView === 'ai')) {
        event.preventDefault();
        setDirectoryPrompt(null);
        lastTodoGPressRef.current = null;
        resetSearchView();
        dispatchAfterFlush({ type: 'selectJournal' });
        return;
      }

      if (state.activeView === 'directory' && directoryPrompt && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setDirectoryPrompt(null);
          setDirectoryPromptValue('');
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void submitDirectoryPrompt();
          return;
        }
      }

      if (state.activeView === 'directory' && !event.metaKey && !event.ctrlKey && !event.altKey && !isFormTarget) {
        const currentIndex = activeDirectoryEntry ? directoryEntries.findIndex((entry) => entry.key === activeDirectoryEntry.key) : -1;
        const lowerKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        const moveSelection = (direction: 1 | -1) => {
          if (directoryEntries.length === 0) {
            return;
          }
          const nextIndex = currentIndex === -1 ? 0 : Math.max(0, Math.min(directoryEntries.length - 1, currentIndex + direction));
          setActiveDirectoryEntryKey(directoryEntries[nextIndex]?.key ?? null);
        };

        if (lowerKey === 'a') {
          event.preventDefault();
          openCreateDirectoryPrompt();
          return;
        }
        if (lowerKey === 'r') {
          event.preventDefault();
          void renameDirectoryEntry();
          return;
        }
        if (lowerKey === 'p') {
          event.preventDefault();
          clearPendingDirectoryMove();
          void pasteClipboardHere();
          return;
        }
        if (lowerKey === 'd') {
          event.preventDefault();
          if (activeDirectoryEntry?.kind === 'directory') {
            if (lastDirectoryDPressRef.current && Date.now() - lastDirectoryDPressRef.current <= 320) {
              clearPendingDirectoryMove();
              void deleteSelectedDirectory();
              return;
            }
            clearPendingDirectoryMove();
            lastDirectoryDPressRef.current = Date.now();
            pendingDirectoryMoveTimerRef.current = window.setTimeout(() => {
              moveSelectedDirectoryToClipboard();
              pendingDirectoryMoveTimerRef.current = null;
              lastDirectoryDPressRef.current = null;
            }, 320);
            return;
          }
          clearPendingDirectoryMove();
          cutSelectedNoteToClipboard();
          return;
        }
        if (lowerKey === 'y') {
          event.preventDefault();
          clearPendingDirectoryMove();
          copySelectedDirectoryToClipboard();
          return;
        }

        clearPendingDirectoryMove();

        if (event.key === 'j' || event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection(1);
          return;
        }
        if (event.key === 'k' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(-1);
          return;
        }
        if (event.key === 'h' || event.key === 'ArrowLeft') {
          if (!currentDirectory) {
            return;
          }
          event.preventDefault();
          enterDirectory(currentDirectory.parentId || null);
          return;
        }
        if (event.key === 'l' || event.key === 'ArrowRight') {
          if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory') {
            return;
          }
          event.preventDefault();
          openDirectoryEntry(activeDirectoryEntry);
          return;
        }
        if (event.key === 'Enter') {
          if (!activeDirectoryEntry) {
            return;
          }
          event.preventDefault();
          openDirectoryEntry(activeDirectoryEntry);
          return;
        }
      }

      if (state.activeView === 'todos' && !event.metaKey && !event.ctrlKey && !event.altKey && !isFormTarget) {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key === 'g') {
          event.preventDefault();
          if (lastTodoGPressRef.current && Date.now() - lastTodoGPressRef.current <= 320) {
            if (filteredTodos.length > 0) {
              setActiveTodoId(filteredTodos[0].id);
            }
            lastTodoGPressRef.current = null;
            return;
          }
          lastTodoGPressRef.current = Date.now();
          return;
        }
        lastTodoGPressRef.current = null;
        if (event.key === 'j' || event.key === 'ArrowDown') {
          if (filteredTodos.length === 0) {
            return;
          }
          event.preventDefault();
          const currentIndex = activeTodo ? filteredTodos.findIndex((todo) => todo.id === activeTodo.id) : -1;
          const nextTodo = filteredTodos[Math.min(filteredTodos.length - 1, currentIndex + 1)] ?? filteredTodos[0];
          setActiveTodoId(nextTodo.id);
          return;
        }
        if (event.key === 'k' || event.key === 'ArrowUp') {
          if (filteredTodos.length === 0) {
            return;
          }
          event.preventDefault();
          const currentIndex = activeTodo ? filteredTodos.findIndex((todo) => todo.id === activeTodo.id) : filteredTodos.length;
          const nextTodo = filteredTodos[Math.max(0, currentIndex - 1)] ?? filteredTodos[0];
          setActiveTodoId(nextTodo.id);
          return;
        }
        if (event.key === 'Enter' && activeTodo) {
          event.preventDefault();
          openTodoSource(activeTodo);
          return;
        }
      } else {
        lastTodoGPressRef.current = null;
      }

      if (state.activeView === 'todos' && (event.metaKey || event.ctrlKey) && event.shiftKey && !isFormTarget) {
        if (event.key === 'ArrowDown' && activeTodo && updatingTodoId !== activeTodo.id) {
          event.preventDefault();
          void handleTodoStatusChange(activeTodo, cycleTodoStatus(activeTodo.status, 1, TODO_STATUS_ORDER));
          return;
        }
        if (event.key === 'ArrowUp' && activeTodo && updatingTodoId !== activeTodo.id) {
          event.preventDefault();
          void handleTodoStatusChange(activeTodo, cycleTodoStatus(activeTodo.status, -1, TODO_STATUS_ORDER));
          return;
        }
      }

      if (state.activeView === 'ai' && !event.metaKey && !event.ctrlKey && !event.altKey && !isFormTarget) {
        const currentIndex = activeAIThread ? aiThreads.findIndex((thread) => thread.id === activeAIThread.id) : -1;
        if (event.key === 'j' || event.key === 'ArrowDown') {
          if (aiThreads.length === 0) {
            return;
          }
          event.preventDefault();
          const nextIndex = Math.min(aiThreads.length - 1, currentIndex + 1);
          setActiveAIThreadId(aiThreads[nextIndex]?.id ?? aiThreads[0]?.id ?? null);
          return;
        }
        if (event.key === 'k' || event.key === 'ArrowUp') {
          if (aiThreads.length === 0) {
            return;
          }
          event.preventDefault();
          const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
          setActiveAIThreadId(aiThreads[nextIndex]?.id ?? aiThreads[0]?.id ?? null);
          return;
        }
      }

      if (!event.metaKey && event.ctrlKey && !event.altKey && !isFormTarget) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === 'o') {
          event.preventDefault();
          jumpBack();
          return;
        }
        if (lowerKey === 'i' || event.key === 'Tab') {
          event.preventDefault();
          jumpForward();
          return;
        }
      }

      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'selectJournal' });
        return;
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        resetSearchView();
        dispatchAfterFlush({ type: 'openSearch' });
        return;
      }
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openDirectoryBrowser();
        return;
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'openTodos' });
        return;
      }
      if (event.key === ',') {
        event.preventDefault();
        dispatchAfterFlush({ type: 'openSettings' });
        return;
      }
      if (event.key.toLowerCase() === 'a' && event.shiftKey) {
        event.preventDefault();
        dispatchAfterFlush({ type: 'openAI' });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeAIThread,
    activeDirectoryEntry,
    activeTodo,
    aiThreads,
    clearPendingDirectoryMove,
    closeDocumentLinkPicker,
    copySelectedDirectoryToClipboard,
    currentDirectory,
    enterDirectory,
    cutSelectedNoteToClipboard,
    deleteSelectedDirectory,
    directoryEntries,
    directoryPrompt,
    dispatchAfterFlush,
    filteredTodos,
    handleTodoStatusChange,
    isDocumentLinkPickerOpen,
    isToolbarMenuOpen,
    jumpBack,
    jumpForward,
    lastDirectoryDPressRef,
    lastTodoGPressRef,
    moveSelectedDirectoryToClipboard,
    openCreateDirectoryPrompt,
    openDirectoryBrowser,
    openDirectoryEntry,
    openTodoSource,
    pasteClipboardHere,
    pendingDeleteNoteId,
    pendingDirectoryMoveTimerRef,
    renameDirectoryEntry,
    resetSearchView,
    setActiveDirectoryEntryKey,
    setActiveTodoId,
    setActiveAIThreadId,
    setDirectoryPrompt,
    setDirectoryPromptValue,
    setIsToolbarMenuOpen,
    setPendingDeleteNoteId,
    state.activeView,
    submitDirectoryPrompt,
    updatingTodoId,
  ]);
}
