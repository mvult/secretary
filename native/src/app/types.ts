import type { OutlinePage } from '../features/outline/types';
import type { BackendDirectory, BackendTodo } from '../lib/backend';

export type TodoFilter = 'all' | 'open' | 'done' | 'blocked' | 'skipped';

export interface StoredSettings {
  backendUrl?: string;
  email?: string;
  token?: string;
  userId?: number;
  workspaceId?: number;
  centerColumn?: boolean;
}

export type PageSaveIndicator = {
  status: 'saving' | 'saved' | 'failed';
  message: string;
  hash?: string;
};

export interface DirectoryEntry {
  key: string;
  kind: 'directory' | 'note';
  directory?: BackendDirectory;
  page?: OutlinePage;
}

export type DirectoryPrompt =
  | { kind: 'create-directory' }
  | { kind: 'rename-directory'; directoryId: number }
  | { kind: 'rename-note'; pageId: string };

export type DirectoryClipboard =
  | { kind: 'note'; pageId: string; mode: 'move' }
  | { kind: 'directory'; directoryId: number; mode: 'move' | 'copy' };

export interface JumpLocation {
  pageId: string;
  focusedId: string;
}

export const TODO_STATUS_ORDER: BackendTodo['status'][] = ['todo', 'doing', 'done', 'blocked', 'skipped'];

export const SETTINGS_STORAGE_KEY = 'secretary-native-settings';

export const JUMPLIST_LIMIT = 10;
