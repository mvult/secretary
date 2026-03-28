import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAIMessage,
  createAIThread,
  deleteAIThread,
  getAIThread,
  listAIThreads,
  type BackendAIThread,
  type BackendAIThreadDetail,
} from '../../lib/backend';
import { getPageTitle } from '../outline/tree';
import type { OutlinePage } from '../outline/types';

interface UseAIThreadsOptions {
  backendUrl: string;
  authToken: string;
  workspaceId: number | null;
  page: OutlinePage | null;
  syncMessageSetter: (message: string) => void;
}

export function useAIThreads({ backendUrl, authToken, workspaceId, page, syncMessageSetter }: UseAIThreadsOptions) {
  const [aiThreads, setAIThreads] = useState<BackendAIThread[]>([]);
  const [activeAIThreadId, setActiveAIThreadId] = useState<number | null>(null);
  const [aiThreadDetail, setAIThreadDetail] = useState<BackendAIThreadDetail | null>(null);
  const [aiDraftMessage, setAIDraftMessage] = useState('');
  const [isLoadingAIThreads, setIsLoadingAIThreads] = useState(false);
  const [isLoadingAIThread, setIsLoadingAIThread] = useState(false);
  const [isSendingAIMessage, setIsSendingAIMessage] = useState(false);

  const activeAIThread = useMemo(
    () => (activeAIThreadId ? aiThreads.find((thread) => thread.id === activeAIThreadId) ?? null : null),
    [activeAIThreadId, aiThreads],
  );

  const loadAIThreads = useCallback(async (tokenOverride?: string, workspaceOverride?: number | null) => {
    const nextToken = tokenOverride ?? authToken;
    const nextWorkspaceId = workspaceOverride ?? workspaceId;
    if (!backendUrl.trim() || !nextToken || !nextWorkspaceId) {
      setAIThreads([]);
      setAIThreadDetail(null);
      setActiveAIThreadId(null);
      return;
    }

    setIsLoadingAIThreads(true);
    try {
      const threads = await listAIThreads(backendUrl, nextToken, nextWorkspaceId);
      setAIThreads(threads);
      setActiveAIThreadId((current) => (current && threads.some((thread) => thread.id === current) ? current : (threads[0]?.id ?? null)));
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread refresh failed.');
    } finally {
      setIsLoadingAIThreads(false);
    }
  }, [authToken, backendUrl, syncMessageSetter, workspaceId]);

  const loadAIThreadDetail = useCallback(async (threadId: number, tokenOverride?: string) => {
    const nextToken = tokenOverride ?? authToken;
    if (!backendUrl.trim() || !nextToken || !threadId) {
      setAIThreadDetail(null);
      return;
    }

    setIsLoadingAIThread(true);
    try {
      setAIThreadDetail(await getAIThread(backendUrl, nextToken, threadId));
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread load failed.');
    } finally {
      setIsLoadingAIThread(false);
    }
  }, [authToken, backendUrl, syncMessageSetter]);

  useEffect(() => {
    if (!activeAIThreadId) {
      setAIThreadDetail(null);
      return;
    }
    void loadAIThreadDetail(activeAIThreadId);
  }, [activeAIThreadId, loadAIThreadDetail]);

  const ensureActiveAIThread = useCallback(async () => {
    if (!authToken || !workspaceId) {
      throw new Error('Log in and sync a workspace first.');
    }
    if (activeAIThreadId) {
      return activeAIThreadId;
    }

    const threadTitle = page ? `${getPageTitle(page)} chat` : 'Workspace chat';
    const documentId = page?.backendId ?? 0;
    const thread = await createAIThread(backendUrl, authToken, workspaceId, documentId, threadTitle);
    setAIThreads((current) => [thread, ...current.filter((entry) => entry.id !== thread.id)]);
    setActiveAIThreadId(thread.id);
    return thread.id;
  }, [activeAIThreadId, authToken, backendUrl, page, workspaceId]);

  const sendAIMessage = useCallback(async () => {
    const content = aiDraftMessage.trim();
    if (!content) {
      return;
    }

    setIsSendingAIMessage(true);
    try {
      const threadId = await ensureActiveAIThread();
      const message = await createAIMessage(backendUrl, authToken, threadId, 'user', content);
      setAIDraftMessage('');
      setAIThreadDetail((current) => {
        if (!current || current.thread?.id !== threadId) {
          return current;
        }
        return {
          ...current,
          messages: [...current.messages, message],
        };
      });
      await loadAIThreads();
      await loadAIThreadDetail(threadId);
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI message send failed.');
    } finally {
      setIsSendingAIMessage(false);
    }
  }, [aiDraftMessage, authToken, backendUrl, ensureActiveAIThread, loadAIThreadDetail, loadAIThreads, syncMessageSetter]);

  const createAIThreadFromCurrentContext = useCallback(async () => {
    if (!authToken || !workspaceId) {
      syncMessageSetter('Log in and sync a workspace first.');
      return;
    }
    try {
      const threadTitle = page ? `${getPageTitle(page)} chat` : 'Workspace chat';
      const documentId = page?.backendId ?? 0;
      const thread = await createAIThread(backendUrl, authToken, workspaceId, documentId, threadTitle);
      setAIThreads((current) => [thread, ...current.filter((entry) => entry.id !== thread.id)]);
      setActiveAIThreadId(thread.id);
      await loadAIThreadDetail(thread.id);
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread create failed.');
    }
  }, [authToken, backendUrl, loadAIThreadDetail, page, syncMessageSetter, workspaceId]);

  const removeActiveAIThread = useCallback(async () => {
    if (!authToken || !activeAIThreadId) {
      return;
    }
    try {
      await deleteAIThread(backendUrl, authToken, activeAIThreadId);
      setAIThreads((current) => current.filter((thread) => thread.id !== activeAIThreadId));
      setAIThreadDetail((current) => (current?.thread?.id === activeAIThreadId ? null : current));
      setActiveAIThreadId((current) => (current === activeAIThreadId ? null : current));
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread delete failed.');
    }
  }, [activeAIThreadId, authToken, backendUrl, syncMessageSetter]);

  const clearAI = () => {
    setAIThreads([]);
    setActiveAIThreadId(null);
    setAIThreadDetail(null);
    setAIDraftMessage('');
  };

  return {
    aiThreads,
    activeAIThreadId,
    setActiveAIThreadId,
    aiThreadDetail,
    aiDraftMessage,
    setAIDraftMessage,
    isLoadingAIThreads,
    isLoadingAIThread,
    isSendingAIMessage,
    activeAIThread,
    loadAIThreads,
    loadAIThreadDetail,
    sendAIMessage,
    createAIThreadFromCurrentContext,
    removeActiveAIThread,
    clearAI,
  };
}
