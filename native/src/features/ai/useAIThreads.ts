import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAIThread,
  deleteAIThread,
  getAIThread,
  listAIThreads,
  runAIThreadTurn,
  updateAIThread,
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

interface LoadAIThreadDetailOptions {
  silent?: boolean;
}

export function useAIThreads({ backendUrl, authToken, workspaceId, page, syncMessageSetter }: UseAIThreadsOptions) {
  const [aiThreads, setAIThreads] = useState<BackendAIThread[]>([]);
  const [activeAIThreadId, setActiveAIThreadId] = useState<number | null>(null);
  const [aiThreadDetail, setAIThreadDetail] = useState<BackendAIThreadDetail | null>(null);
  const [aiDraftMessage, setAIDraftMessage] = useState('');
  const [isLoadingAIThreads, setIsLoadingAIThreads] = useState(false);
  const [isLoadingAIThread, setIsLoadingAIThread] = useState(false);
  const [isSendingAIMessage, setIsSendingAIMessage] = useState(false);
  const [isUpdatingAIThreadTitle, setIsUpdatingAIThreadTitle] = useState(false);
  const [pendingAIMessage, setPendingAIMessage] = useState('');

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

  const loadAIThreadDetail = useCallback(async (threadId: number, tokenOverride?: string, options: LoadAIThreadDetailOptions = {}) => {
    const nextToken = tokenOverride ?? authToken;
    if (!backendUrl.trim() || !nextToken || !threadId) {
      setAIThreadDetail(null);
      return;
    }

    if (!options.silent) {
      setIsLoadingAIThread(true);
    }
    try {
      const detail = await getAIThread(backendUrl, nextToken, threadId);
      setAIThreadDetail((current) => {
        if (!current || current.thread?.id !== threadId) {
          return detail;
        }
        return {
          ...detail,
          messages: current.messages.length > detail.messages.length ? current.messages : detail.messages,
          runs: current.runs.length > detail.runs.length ? current.runs : detail.runs,
        };
      });
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread load failed.');
    } finally {
      if (!options.silent) {
        setIsLoadingAIThread(false);
      }
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
    setAIDraftMessage('');
    setPendingAIMessage(content);
    try {
      const threadId = await ensureActiveAIThread();
      const result = await runAIThreadTurn(backendUrl, authToken, threadId, content, 'ask');
      setAIThreadDetail((current) => {
        if (!current || current.thread?.id !== threadId) {
          return current;
        }
        return {
          ...current,
          messages: [
            ...current.messages,
            ...(result.userMessage ? [result.userMessage] : []),
            ...(result.assistantMessage ? [result.assistantMessage] : []),
          ],
          runs: result.run ? [...current.runs, result.run] : current.runs,
        };
      });
      await loadAIThreads();
      void loadAIThreadDetail(threadId, undefined, { silent: true });
    } catch (error) {
      setAIDraftMessage(content);
      syncMessageSetter(error instanceof Error ? error.message : 'AI message send failed.');
    } finally {
      setPendingAIMessage('');
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

  const renameAIThread = useCallback(async (threadId: number, title: string) => {
    if (!authToken || !threadId) {
      return;
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      syncMessageSetter('Thread title is required.');
      return;
    }
    setIsUpdatingAIThreadTitle(true);
    try {
      const updatedThread = await updateAIThread(backendUrl, authToken, threadId, nextTitle);
      setAIThreads((current) => current.map((thread) => (thread.id === threadId ? updatedThread : thread)));
      setAIThreadDetail((current) => {
        if (!current?.thread || current.thread.id !== threadId) {
          return current;
        }
        return {
          ...current,
          thread: updatedThread,
        };
      });
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread rename failed.');
    } finally {
      setIsUpdatingAIThreadTitle(false);
    }
  }, [authToken, backendUrl, syncMessageSetter]);

  const removeAIThread = useCallback(async (threadId: number) => {
    if (!authToken || !threadId) {
      return;
    }
    try {
      await deleteAIThread(backendUrl, authToken, threadId);
      const remainingThreads = aiThreads.filter((thread) => thread.id !== threadId);
      setAIThreads(remainingThreads);
      setAIThreadDetail((current) => (current?.thread?.id === threadId ? null : current));
      setActiveAIThreadId((current) => {
        if (current !== threadId) {
          return current;
        }
        return remainingThreads[0]?.id ?? null;
      });
    } catch (error) {
      syncMessageSetter(error instanceof Error ? error.message : 'AI thread delete failed.');
    }
  }, [aiThreads, authToken, backendUrl, syncMessageSetter]);

  const clearAI = useCallback(() => {
    setAIThreads([]);
    setActiveAIThreadId(null);
    setAIThreadDetail(null);
    setAIDraftMessage('');
  }, []);

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
    isUpdatingAIThreadTitle,
    pendingAIMessage,
    activeAIThread,
    loadAIThreads,
    loadAIThreadDetail,
    sendAIMessage,
    createAIThreadFromCurrentContext,
    renameAIThread,
    removeAIThread,
    clearAI,
  };
}
