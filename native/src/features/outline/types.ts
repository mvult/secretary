import type { BackendTodoStatus } from '../../lib/backend';

export type PageKind = 'journal' | 'note';

export type WorkspaceView = 'journals' | 'note' | 'search' | 'todos' | 'settings' | 'directory';

export interface OutlineNode {
  id: string;
  backendId?: number;
  parentId: string | null;
  text: string;
  todoStatus?: BackendTodoStatus | null;
  todoId?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OutlinePage {
  id: string;
  backendId?: number;
  workspaceId?: number;
  directoryId?: number | null;
  kind: PageKind;
  date: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  nodes: OutlineNode[];
}

export type EditorMode = 'normal' | 'insert';

export type CursorPlacement = 'start' | 'end' | number;

export interface YankBuffer {
  text: string;
  todoStatus?: BackendTodoStatus | null;
}

export interface OutlineState {
  pages: OutlinePage[];
  activePageId: string;
  activeView: WorkspaceView;
  focusedId: string;
  normalCursor: number;
  anchorId: string | null;
  editingId: string | null;
  draftText: string;
  editCursor: CursorPlacement;
  mode: EditorMode;
  yankBuffer: YankBuffer | null;
  history: OutlineSnapshot[];
}

export interface OutlineSnapshot {
  pages: OutlinePage[];
  activePageId: string;
  activeView: WorkspaceView;
  focusedId: string;
  normalCursor: number;
  anchorId: string | null;
  editingId: string | null;
  draftText: string;
  editCursor: CursorPlacement;
  mode: EditorMode;
  yankBuffer: YankBuffer | null;
}

export interface SelectedInfo {
  focusedNode: OutlineNode;
  selectedIds: string[];
}
