import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import {
  createDirectory,
  deleteDirectory,
  saveDocument,
  updateDirectory,
  type BackendDirectory,
} from '../../lib/backend';
import { outlinePageToDocument, documentToOutlinePage } from '../outline/remote';
import { getPageTitle } from '../outline/tree';
import type { OutlineAction } from '../outline/state';
import type { OutlinePage, OutlineState } from '../outline/types';
import type { DirectoryClipboard, DirectoryEntry, DirectoryPrompt } from '../../app/types';

interface UseDirectoryBrowserOptions {
  state: OutlineState;
  stateRef: React.MutableRefObject<OutlineState>;
  dispatch: Dispatch<OutlineAction>;
  backendUrl: string;
  authToken: string;
  workspaceId: number | null;
  syncEnabled: boolean;
  directories: BackendDirectory[];
  setDirectories: Dispatch<React.SetStateAction<BackendDirectory[]>>;
  setSyncMessage: Dispatch<React.SetStateAction<string>>;
}

export function useDirectoryBrowser({
  state,
  stateRef,
  dispatch,
  backendUrl,
  authToken,
  workspaceId,
  syncEnabled,
  directories,
  setDirectories,
  setSyncMessage,
}: UseDirectoryBrowserOptions) {
  const [activeDirectoryId, setActiveDirectoryId] = useState<number | null>(null);
  const [activeDirectoryEntryKey, setActiveDirectoryEntryKey] = useState<string | null>(null);
  const [directoryClipboard, setDirectoryClipboard] = useState<DirectoryClipboard | null>(null);
  const [directoryPrompt, setDirectoryPrompt] = useState<DirectoryPrompt | null>(null);
  const [directoryPromptValue, setDirectoryPromptValue] = useState('');
  const [isSubmittingDirectoryPrompt, setIsSubmittingDirectoryPrompt] = useState(false);
  const directoryPromptInputRef = useRef<HTMLInputElement | null>(null);
  const lastDirectoryDPressRef = useRef<number | null>(null);
  const pendingDirectoryMoveTimerRef = useRef<number | null>(null);

  const notes = useMemo(() => state.pages.filter((entry) => entry.kind === 'note'), [state.pages]);
  const directoryMap = useMemo(() => new Map(directories.map((directory) => [directory.id, directory])), [directories]);
  const currentDirectory = activeDirectoryId ? directoryMap.get(activeDirectoryId) ?? null : null;
  const directoryPath = useMemo(() => {
    const path: BackendDirectory[] = [];
    let cursor = currentDirectory;
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? directoryMap.get(cursor.parentId) ?? null : null;
    }
    return path;
  }, [currentDirectory, directoryMap]);

  const activePage = useMemo(
    () => state.pages.find((entry) => entry.id === state.activePageId) ?? null,
    [state.activePageId, state.pages],
  );
  const activeNoteDirectoryPath = useMemo(() => {
    if (!activePage || activePage.kind !== 'note' || !activePage.directoryId) {
      return [] as BackendDirectory[];
    }

    const path: BackendDirectory[] = [];
    let cursor = directoryMap.get(activePage.directoryId) ?? null;
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentId ? directoryMap.get(cursor.parentId) ?? null : null;
    }
    return path;
  }, [activePage, directoryMap]);

  const directoryEntries = useMemo<DirectoryEntry[]>(() => {
    const childDirectories = directories
      .filter((directory) => (directory.parentId || 0) === (activeDirectoryId || 0))
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name) || left.id - right.id)
      .map((directory) => ({ key: `directory-${directory.id}`, kind: 'directory' as const, directory }));
    const childNotes = notes
      .filter((entry) => (entry.directoryId ?? 0) === (activeDirectoryId || 0))
      .sort((left, right) => getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id))
      .map((entry) => ({ key: `note-${entry.id}`, kind: 'note' as const, page: entry }));
    return [...childDirectories, ...childNotes];
  }, [activeDirectoryId, directories, notes]);

  const activeDirectoryEntry = useMemo(() => {
    if (directoryEntries.length === 0) {
      return null;
    }
    if (activeDirectoryEntryKey) {
      return directoryEntries.find((entry) => entry.key === activeDirectoryEntryKey) ?? directoryEntries[0];
    }
    return directoryEntries[0];
  }, [activeDirectoryEntryKey, directoryEntries]);

  const directoryClipboardPage = useMemo(
    () => directoryClipboard?.kind === 'note'
      ? state.pages.find((entry) => entry.id === directoryClipboard.pageId && entry.kind === 'note') ?? null
      : null,
    [directoryClipboard, state.pages],
  );
  const directoryClipboardDirectory = useMemo(
    () => directoryClipboard?.kind === 'directory'
      ? directories.find((entry) => entry.id === directoryClipboard.directoryId) ?? null
      : null,
    [directories, directoryClipboard],
  );

  useEffect(() => {
    if (activeDirectoryId != null && !directories.some((directory) => directory.id === activeDirectoryId)) {
      setActiveDirectoryId(null);
    }
  }, [activeDirectoryId, directories]);

  useEffect(() => {
    if (directoryEntries.length === 0) {
      if (activeDirectoryEntryKey !== null) {
        setActiveDirectoryEntryKey(null);
      }
      return;
    }
    if (!activeDirectoryEntryKey || !directoryEntries.some((entry) => entry.key === activeDirectoryEntryKey)) {
      setActiveDirectoryEntryKey(directoryEntries[0].key);
    }
  }, [activeDirectoryEntryKey, directoryEntries]);

  useEffect(() => {
    if (!directoryPrompt) {
      return;
    }
    directoryPromptInputRef.current?.focus();
    directoryPromptInputRef.current?.select();
  }, [directoryPrompt]);

  useEffect(() => () => {
    if (pendingDirectoryMoveTimerRef.current) {
      window.clearTimeout(pendingDirectoryMoveTimerRef.current);
    }
  }, []);

  const enterDirectory = useCallback((directoryId: number | null) => {
    setActiveDirectoryId(directoryId);
    setActiveDirectoryEntryKey(null);
  }, []);

  const openCreateDirectoryPrompt = useCallback(() => {
    setDirectoryPrompt({ kind: 'create-directory' });
    setDirectoryPromptValue('');
  }, []);

  const openRenameDirectoryPrompt = useCallback((directory: BackendDirectory) => {
    setDirectoryPrompt({ kind: 'rename-directory', directoryId: directory.id });
    setDirectoryPromptValue(directory.name);
  }, []);

  const openRenameNotePrompt = useCallback((entryPage: OutlinePage) => {
    setDirectoryPrompt({ kind: 'rename-note', pageId: entryPage.id });
    setDirectoryPromptValue(entryPage.title);
  }, []);

  const upsertDirectory = useCallback((directory: BackendDirectory) => {
    setDirectories((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === directory.id);
      if (existingIndex === -1) {
        return [...current, directory];
      }
      return current.map((entry, index) => (index === existingIndex ? directory : entry));
    });
  }, [setDirectories]);

  const renameDirectoryEntry = useCallback(async () => {
    if (!activeDirectoryEntry) {
      return;
    }
    if (activeDirectoryEntry.kind === 'directory') {
      if (activeDirectoryEntry.directory) {
        openRenameDirectoryPrompt(activeDirectoryEntry.directory);
      }
      return;
    }

    if (!activeDirectoryEntry.page) {
      return;
    }
    openRenameNotePrompt(activeDirectoryEntry.page);
  }, [activeDirectoryEntry, openRenameDirectoryPrompt, openRenameNotePrompt]);

  const clearPendingDirectoryMove = useCallback(() => {
    if (pendingDirectoryMoveTimerRef.current) {
      window.clearTimeout(pendingDirectoryMoveTimerRef.current);
      pendingDirectoryMoveTimerRef.current = null;
    }
    lastDirectoryDPressRef.current = null;
  }, []);

  const createDirectoryHere = useCallback(async () => {
    if (isSubmittingDirectoryPrompt) {
      return;
    }
    const name = directoryPromptValue.trim();
    if (!name) {
      return;
    }
    if (!authToken || !workspaceId) {
      setSyncMessage('Log in first to create directories.');
      return;
    }
    setIsSubmittingDirectoryPrompt(true);
    try {
      const savedDirectory = await createDirectory(backendUrl, authToken, workspaceId, activeDirectoryId ?? 0, name);
      upsertDirectory(savedDirectory);
      setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
      setDirectoryPrompt(null);
      setDirectoryPromptValue('');
      setSyncMessage(`Created ${savedDirectory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory create failed.');
    } finally {
      setIsSubmittingDirectoryPrompt(false);
    }
  }, [activeDirectoryId, authToken, backendUrl, directoryPromptValue, isSubmittingDirectoryPrompt, setSyncMessage, upsertDirectory, workspaceId]);

  const submitDirectoryPrompt = useCallback(async () => {
    if (!directoryPrompt || isSubmittingDirectoryPrompt) {
      return;
    }
    if (directoryPrompt.kind === 'create-directory') {
      await createDirectoryHere();
      return;
    }
    if (directoryPrompt.kind === 'rename-directory') {
      const nextName = directoryPromptValue.trim();
      const target = directories.find((entry) => entry.id === directoryPrompt.directoryId);
      if (!target || !nextName || nextName === target.name) {
        setDirectoryPrompt(null);
        return;
      }
      if (!authToken) {
        setSyncMessage('Log in first to rename directories.');
        return;
      }
      setIsSubmittingDirectoryPrompt(true);
      try {
        const savedDirectory = await updateDirectory(backendUrl, authToken, target.id, nextName, target.parentId);
        upsertDirectory(savedDirectory);
        setDirectoryPrompt(null);
        setDirectoryPromptValue('');
        setSyncMessage(`Renamed directory to ${savedDirectory.name}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Directory rename failed.');
      } finally {
        setIsSubmittingDirectoryPrompt(false);
      }
      return;
    }
    const nextTitle = directoryPromptValue.trim();
    const pageToRename = stateRef.current.pages.find((entry) => entry.id === directoryPrompt.pageId && entry.kind === 'note');
    if (!pageToRename || !nextTitle || nextTitle === pageToRename.title) {
      setDirectoryPrompt(null);
      return;
    }
    const renamedPage = { ...pageToRename, title: nextTitle };
    dispatch({ type: 'mergeRemotePage', page: renamedPage, previousPageId: pageToRename.id });
    setIsSubmittingDirectoryPrompt(true);
    try {
      if (syncEnabled) {
        const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(renamedPage, workspaceId!));
        dispatch({ type: 'mergeRemotePage', page: documentToOutlinePage(savedDocument), previousPageId: pageToRename.id });
      }
      setDirectoryPrompt(null);
      setDirectoryPromptValue('');
      setSyncMessage(`Renamed note to ${nextTitle}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Note rename failed.');
    } finally {
      setIsSubmittingDirectoryPrompt(false);
    }
  }, [authToken, backendUrl, createDirectoryHere, directories, directoryPrompt, directoryPromptValue, dispatch, isSubmittingDirectoryPrompt, setSyncMessage, stateRef, syncEnabled, upsertDirectory, workspaceId]);

  const deleteSelectedDirectory = useCallback(async () => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      return;
    }
    if (!authToken) {
      setSyncMessage('Log in first to delete directories.');
      return;
    }
    try {
      await deleteDirectory(backendUrl, authToken, activeDirectoryEntry.directory.id);
      setDirectories((current) => current.filter((entry) => entry.id !== activeDirectoryEntry.directory?.id));
      setActiveDirectoryEntryKey(null);
      setSyncMessage(`Deleted ${activeDirectoryEntry.directory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory delete failed.');
    }
  }, [activeDirectoryEntry, authToken, backendUrl, setDirectories, setSyncMessage]);

  const duplicateNoteIntoDirectory = useCallback(async (sourcePage: OutlinePage, targetDirectoryId: number | null) => {
    if (!authToken || !workspaceId) {
      throw new Error('Log in first to copy directories.');
    }

    const nodeIdMap = new Map<string, string>();
    for (const node of sourcePage.nodes) {
      nodeIdMap.set(node.id, `node-${crypto.randomUUID()}`);
    }

    const duplicatedPage: OutlinePage = {
      ...sourcePage,
      id: `note-${crypto.randomUUID()}`,
      backendId: undefined,
      workspaceId,
      directoryId: targetDirectoryId,
      createdAt: undefined,
      updatedAt: undefined,
      nodes: sourcePage.nodes.map((node) => ({
        ...node,
        id: nodeIdMap.get(node.id) ?? `node-${crypto.randomUUID()}`,
        backendId: undefined,
        todoId: null,
        createdAt: undefined,
        updatedAt: undefined,
        parentId: node.parentId ? (nodeIdMap.get(node.parentId) ?? null) : null,
      })),
    };

    const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(duplicatedPage, workspaceId));
    const savedPage = documentToOutlinePage(savedDocument);
    dispatch({ type: 'mergeRemotePage', page: savedPage });
    return savedPage;
  }, [authToken, backendUrl, dispatch, workspaceId]);

  const duplicateDirectoryIntoParent = useCallback(async (sourceDirectory: BackendDirectory, targetParentId: number | null): Promise<BackendDirectory> => {
    if (!authToken || !workspaceId) {
      throw new Error('Log in first to copy directories.');
    }

    const savedDirectory = await createDirectory(backendUrl, authToken, workspaceId, targetParentId ?? 0, sourceDirectory.name);
    upsertDirectory(savedDirectory);

    const childNotes = stateRef.current.pages
      .filter((entry) => entry.kind === 'note' && (entry.directoryId ?? 0) === sourceDirectory.id)
      .sort((left, right) => getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id));
    for (const childNote of childNotes) {
      await duplicateNoteIntoDirectory(childNote, savedDirectory.id);
    }

    const childDirectories = directories
      .filter((entry) => (entry.parentId || 0) === sourceDirectory.id)
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name) || left.id - right.id);
    for (const childDirectory of childDirectories) {
      await duplicateDirectoryIntoParent(childDirectory, savedDirectory.id);
    }

    return savedDirectory;
  }, [authToken, backendUrl, directories, duplicateNoteIntoDirectory, stateRef, upsertDirectory, workspaceId]);

  const pasteClipboardHere = useCallback(async () => {
    if (!directoryClipboard) {
      setSyncMessage('Clipboard is empty. Use d on a note or directory, or y on a directory first.');
      return;
    }

    if (directoryClipboard.kind === 'note') {
      const clipboardPage = stateRef.current.pages.find((entry) => entry.id === directoryClipboard.pageId && entry.kind === 'note');
      if (!clipboardPage) {
        setSyncMessage('Clipboard note is no longer available.');
        return;
      }
      const movedPage = { ...clipboardPage, directoryId: activeDirectoryId ?? null };
      dispatch({ type: 'mergeRemotePage', page: movedPage, previousPageId: clipboardPage.id });
      try {
        if (syncEnabled) {
          const savedDocument = await saveDocument(backendUrl, authToken, outlinePageToDocument(movedPage, workspaceId!));
          dispatch({ type: 'mergeRemotePage', page: documentToOutlinePage(savedDocument), previousPageId: clipboardPage.id });
        }
        setActiveDirectoryEntryKey(`note-${movedPage.id}`);
        setDirectoryClipboard(null);
        setSyncMessage(`Moved ${getPageTitle(movedPage)}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Move failed.');
      }
      return;
    }

    const sourceDirectory = directories.find((entry) => entry.id === directoryClipboard.directoryId);
    if (!sourceDirectory) {
      setSyncMessage('Clipboard directory is no longer available.');
      return;
    }

    if (directoryClipboard.mode === 'move') {
      if (!authToken) {
        setSyncMessage('Log in first to move directories.');
        return;
      }
      try {
        const savedDirectory = await updateDirectory(
          backendUrl,
          authToken,
          sourceDirectory.id,
          sourceDirectory.name,
          activeDirectoryId ?? 0,
        );
        upsertDirectory(savedDirectory);
        setDirectoryClipboard(null);
        setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
        setSyncMessage(`Moved ${savedDirectory.name}.`);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : 'Directory move failed.');
      }
      return;
    }

    try {
      const savedDirectory = await duplicateDirectoryIntoParent(sourceDirectory, activeDirectoryId ?? null);
      setActiveDirectoryEntryKey(`directory-${savedDirectory.id}`);
      setSyncMessage(`Copied ${sourceDirectory.name}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Directory copy failed.');
    }
  }, [activeDirectoryId, authToken, backendUrl, directories, directoryClipboard, dispatch, duplicateDirectoryIntoParent, setSyncMessage, stateRef, syncEnabled, upsertDirectory, workspaceId]);

  const cutSelectedNoteToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'note' || !activeDirectoryEntry.page) {
      setSyncMessage('Select a note to move.');
      return;
    }
    setDirectoryClipboard({ kind: 'note', pageId: activeDirectoryEntry.page.id, mode: 'move' });
    setSyncMessage(`Ready to move ${getPageTitle(activeDirectoryEntry.page)}. Press p in the destination directory.`);
  }, [activeDirectoryEntry, setSyncMessage]);

  const copySelectedDirectoryToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      setSyncMessage('Select a directory to copy.');
      return;
    }
    clearPendingDirectoryMove();
    setDirectoryClipboard({ kind: 'directory', directoryId: activeDirectoryEntry.directory.id, mode: 'copy' });
    setSyncMessage(`Ready to copy ${activeDirectoryEntry.directory.name}. Press p in the destination directory.`);
  }, [activeDirectoryEntry, clearPendingDirectoryMove, setSyncMessage]);

  const moveSelectedDirectoryToClipboard = useCallback(() => {
    if (!activeDirectoryEntry || activeDirectoryEntry.kind !== 'directory' || !activeDirectoryEntry.directory) {
      setSyncMessage('Select a directory to move.');
      return;
    }
    clearPendingDirectoryMove();
    setDirectoryClipboard({ kind: 'directory', directoryId: activeDirectoryEntry.directory.id, mode: 'move' });
    setSyncMessage(`Ready to move ${activeDirectoryEntry.directory.name}. Press p in the destination directory.`);
  }, [activeDirectoryEntry, clearPendingDirectoryMove, setSyncMessage]);

  return {
    activeDirectoryId,
    setActiveDirectoryId,
    activeDirectoryEntryKey,
    setActiveDirectoryEntryKey,
    currentDirectory,
    directoryPath,
    activeNoteDirectoryPath,
    directoryEntries,
    activeDirectoryEntry,
    directoryClipboard,
    directoryClipboardPage,
    directoryClipboardDirectory,
    directoryPrompt,
    setDirectoryPrompt,
    directoryPromptValue,
    setDirectoryPromptValue,
    isSubmittingDirectoryPrompt,
    directoryPromptInputRef,
    lastDirectoryDPressRef,
    pendingDirectoryMoveTimerRef,
    enterDirectory,
    openCreateDirectoryPrompt,
    renameDirectoryEntry,
    clearPendingDirectoryMove,
    submitDirectoryPrompt,
    deleteSelectedDirectory,
    pasteClipboardHere,
    cutSelectedNoteToClipboard,
    copySelectedDirectoryToClipboard,
    moveSelectedDirectoryToClipboard,
  };
}
