import type { BackendTodoStatus } from '../../lib/backend';

export type PageKind = 'journal' | 'note';

export type WorkspaceView = 'journals' | 'note' | 'search' | 'todos' | 'settings' | 'directory' | 'ai' | 'pomodoro';

export interface OutlineNode {
  id: string;
  backendId?: number;
  // Echoed by SaveDocument to map newly allocated server IDs without using position.
  clientKey?: string;
  parentId: string | null;
  text: string;
  todoStatus?: BackendTodoStatus | null;
  todoId?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OutlinePage {
  // Navigation projection only; never an editable body or persistence baseline.
  metadataOnly?: true;
  id: string;
  clientKey?: string;
  // Decimal int64; transport metadata is never an editor-owned baseline.
  revision?: string;
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

export type EditorMode = 'normal' | 'insert' | 'visual';

export type CursorPlacement = 'start' | 'end' | number;

export interface YankedOutlineNode {
  depth: number;
  text: string;
  todoStatus?: BackendTodoStatus | null;
}

export interface YankBuffer {
  plainText: string;
  nodes: YankedOutlineNode[];
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
  documentHistory?: Record<string, DocumentUndo[]>;
  documentCursors?: Record<string, { focusedId: string; normalCursor: number }>;
  blockIdentities?: Record<string, Record<string, Pick<OutlineNode, 'backendId' | 'clientKey' | 'todoId' | 'createdAt' | 'updatedAt'>>>;
  collapsedNodeIds?: string[];
}

export interface DocumentUndo {
  title: string;
  nodes: Pick<OutlineNode, 'id' | 'parentId' | 'text' | 'todoStatus'>[];
  focusedId: string;
  normalCursor: number;
}

export interface SelectedInfo {
  focusedNode: OutlineNode;
  selectedIds: string[];
}
