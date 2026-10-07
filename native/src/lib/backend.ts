import { rpcJson } from '@secretary/api';
import { BackendError, postJsonBody as sharedPostJsonBody, readError as sharedReadError } from '@secretary/api/transport';
import { safeInteger, decimalRevision } from '@secretary/api/identity';
export { BackendError, decimalRevision };

export interface BackendUser {
  id: number;
  firstName: string;
  lastName: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: BackendUser;
}

export type BackendTodoStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
export type BackendTodoBucket = 'inbox' | 'on_deck' | 'blocked' | 'done' | '';

export interface BackendTodo {
  id: number;
  workspaceId?: number;
  name: string;
  desc: string;
  status: BackendTodoStatus;
  userId: number;
  createdAtRecordingId: number;
  updatedAtRecordingId: number;
  createdAtRecordingName: string;
  createdAtRecordingDate: string;
  createdAt: string;
  updatedAt: string;
  sourceKind: string;
  sourceDocumentId: number;
  sourceBlockId: number;
  bucket: BackendTodoBucket;
  priorityRank: number;
  deadlineDate: string;
  goalId: number;
  goalName: string;
  currentDocumentId: number;
  currentBlockId: number;
  completedAt: string;
  completedDocumentId: number;
  completedBlockId: number;
}

export interface BackendTodoGoal {
  id: number;
  userId: number;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type TodoPatch = Partial<Pick<BackendTodo, 'name' | 'desc' | 'status' | 'bucket' | 'priorityRank' | 'deadlineDate' | 'goalId'>>;

export function todoStatusToProto(status: BackendTodoStatus) {
  switch (status) {
    case 'done':
      return 'TODO_STATUS_DONE';
    case 'blocked':
      return 'TODO_STATUS_BLOCKED';
    case 'skipped':
      return 'TODO_STATUS_SKIPPED';
    case 'doing':
      return 'TODO_STATUS_DOING';
    case 'todo':
    default:
      return 'TODO_STATUS_TODO';
  }
}

export interface BackendWorkspace {
  id: number;
  name: string;
  createdAt: string;
}

export interface BackendDirectory {
  id: number;
  workspaceId: number;
  parentId: number;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface BackendAIThread {
  id: number;
  workspaceId: number;
  documentId: number;
  title: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface BackendAIMessage {
  id: number;
  threadId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdByUserId: number;
  runId: number;
  createdAt: string;
}

export interface BackendAIRun {
  id: number;
  triggerMessageId: number;
  status: string;
  mode: string;
  provider: string;
  model: string;
  requestJson: Record<string, unknown> | null;
  responseJson: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errorMessage: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export interface BackendAIArtifact {
  id: number;
  runId: number;
  kind: string;
  title: string;
  contentJson: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string;
  appliedByUserId: number;
  supersededByArtifactId: number;
}

export interface BackendAISourceRef {
  id: number;
  runId: number;
  artifactId: number;
  sourceKind: string;
  sourceId: number;
  label: string;
  quoteText: string;
  rank: number;
  createdAt: string;
}

export interface BackendAIThreadDetail {
  thread: BackendAIThread | null;
  messages: BackendAIMessage[];
  runs: BackendAIRun[];
  artifacts: BackendAIArtifact[];
  sourceRefs: BackendAISourceRef[];
}

export interface BackendAIRunTurnResult {
  userMessage: BackendAIMessage | null;
  assistantMessage: BackendAIMessage | null;
  run: BackendAIRun | null;
}

export interface PomodoroUnlockApproval {
  decision: 'approve' | 'deny';
  time: number;
  reason: string;
}

export interface WhatsAppStatus {
  library_update?: { current: string; latest: string; available: boolean };
  connected: boolean;
  logged_in: boolean;
  jid: string;
  pairing: boolean;
  has_qr: boolean;
  last_error: string;
  session_db: string;
  last_event: string;
  last_event_at: string;
}

export interface WhatsAppSettings {
  importanceInstructions: string;
  defaultImportanceInstructions: string;
}

export interface WhatsAppMessageNotification {
  id: number;
  chatJid: string;
  messageId: string;
  senderJid: string;
  senderName: string;
  text: string;
  classificationReason: string;
  receivedAt: string;
}

export interface BackendBlock {
  id: number;
  clientKey: string;
  documentId: number;
  parentBlockId: number;
  parentClientKey: string;
  sortOrder: number;
  text: string;
  todoStatus?: BackendTodoStatus | null;
  todoId: number;
  createdAt: string;
  updatedAt: string;
}

export interface BackendDocument {
  id: number;
  revision?: string;
  clientKey: string;
  workspaceId: number;
  directoryId: number;
  kind: 'journal' | 'note';
  title: string;
  journalDate: string;
  createdAt: string;
  updatedAt: string;
  blocks: BackendBlock[];
}

export interface BackendDocumentIndex {
  documents: BackendDocument[];
  directories: BackendDirectory[];
  persistenceProtocolVersion?: number;
}

export interface BackendDocumentHistoryEntry {
  id: number;
  documentId: number;
  captureReason: 'day_start' | 'periodic' | string;
  contentHash: string;
  snapshotJson: string;
  capturedAt: string;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/$/, '');
}

function toNumber(value: unknown) {
  return safeInteger(value);
}

function normalizeWorkspace(value: any): BackendWorkspace {
  return {
    id: toNumber(value?.id),
    name: typeof value?.name === 'string' ? value.name : '',
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
  };
}

function normalizeDirectory(value: any): BackendDirectory {
  return {
    id: toNumber(value?.id),
    workspaceId: toNumber(value?.workspaceId),
    parentId: toNumber(value?.parentId),
    name: typeof value?.name === 'string' ? value.name : '',
    position: toNumber(value?.position),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeAIThread(value: any): BackendAIThread {
  return {
    id: toNumber(value?.id),
    workspaceId: toNumber(value?.workspaceId),
    documentId: toNumber(value?.documentId),
    title: typeof value?.title === 'string' ? value.title : '',
    createdByUserId: toNumber(value?.createdByUserId),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function normalizeAIMessage(value: any): BackendAIMessage {
  const role = value?.role === 'assistant' || value?.role === 'system' ? value.role : 'user';
  return {
    id: toNumber(value?.id),
    threadId: toNumber(value?.threadId),
    role,
    content: typeof value?.content === 'string' ? value.content : '',
    createdByUserId: toNumber(value?.createdByUserId),
    runId: toNumber(value?.runId),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
  };
}

function normalizeAIRun(value: any): BackendAIRun {
  return {
    id: toNumber(value?.id),
    triggerMessageId: toNumber(value?.triggerMessageId),
    status: typeof value?.status === 'string' ? value.status : '',
    mode: typeof value?.mode === 'string' ? value.mode : '',
    provider: typeof value?.provider === 'string' ? value.provider : '',
    model: typeof value?.model === 'string' ? value.model : '',
    requestJson: normalizeJsonObject(value?.requestJson),
    responseJson: normalizeJsonObject(value?.responseJson),
    inputTokens: toNumber(value?.inputTokens),
    outputTokens: toNumber(value?.outputTokens),
    latencyMs: toNumber(value?.latencyMs),
    errorMessage: typeof value?.errorMessage === 'string' ? value.errorMessage : '',
    startedAt: typeof value?.startedAt === 'string' ? value.startedAt : '',
    completedAt: typeof value?.completedAt === 'string' ? value.completedAt : '',
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
  };
}

function normalizeAIArtifact(value: any): BackendAIArtifact {
  return {
    id: toNumber(value?.id),
    runId: toNumber(value?.runId),
    kind: typeof value?.kind === 'string' ? value.kind : '',
    title: typeof value?.title === 'string' ? value.title : '',
    contentJson: normalizeJsonObject(value?.contentJson),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    appliedAt: typeof value?.appliedAt === 'string' ? value.appliedAt : '',
    appliedByUserId: toNumber(value?.appliedByUserId),
    supersededByArtifactId: toNumber(value?.supersededByArtifactId),
  };
}

function normalizeAISourceRef(value: any): BackendAISourceRef {
  return {
    id: toNumber(value?.id),
    runId: toNumber(value?.runId),
    artifactId: toNumber(value?.artifactId),
    sourceKind: typeof value?.sourceKind === 'string' ? value.sourceKind : '',
    sourceId: toNumber(value?.sourceId),
    label: typeof value?.label === 'string' ? value.label : '',
    quoteText: typeof value?.quoteText === 'string' ? value.quoteText : '',
    rank: toNumber(value?.rank),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
  };
}

function normalizeDocumentHistoryEntry(value: any): BackendDocumentHistoryEntry {
  return {
    id: toNumber(value?.id),
    documentId: toNumber(value?.documentId),
    captureReason: typeof value?.captureReason === 'string' ? value.captureReason : '',
    contentHash: typeof value?.contentHash === 'string' ? value.contentHash : '',
    snapshotJson: typeof value?.snapshotJson === 'string' ? value.snapshotJson : '',
    capturedAt: typeof value?.capturedAt === 'string' ? value.capturedAt : '',
  };
}

function normalizeTodoStatus(value: unknown): BackendTodoStatus {
  switch (value) {
    case 'TODO_STATUS_DONE':
    case 'done':
    case 3:
      return 'done';
    case 'TODO_STATUS_BLOCKED':
    case 'blocked':
    case 4:
      return 'blocked';
    case 'TODO_STATUS_SKIPPED':
    case 'skipped':
    case 5:
      return 'skipped';
    case 'TODO_STATUS_DOING':
    case 'doing':
    case 2:
      return 'doing';
    case 'TODO_STATUS_TODO':
    case 'todo':
    case 1:
    default:
      return 'todo';
  }
}

function normalizeBlockTodoStatus(value: unknown): BackendTodoStatus | null {
  if (value === '' || value == null) {
    return null;
  }
  return normalizeTodoStatus(value);
}

export function normalizeTodo(value: any): BackendTodo {
  const bucket = value?.bucket === 'inbox' || value?.bucket === 'on_deck' || value?.bucket === 'blocked' || value?.bucket === 'done' ? value.bucket : '';
  return {
    id: toNumber(value?.id),
    workspaceId: toNumber(value?.workspaceId),
    name: typeof value?.name === 'string' ? value.name : '',
    desc: typeof value?.desc === 'string' ? value.desc : '',
    status: normalizeTodoStatus(value?.status),
    userId: toNumber(value?.userId),
    createdAtRecordingId: toNumber(value?.createdAtRecordingId),
    updatedAtRecordingId: toNumber(value?.updatedAtRecordingId),
    createdAtRecordingName: typeof value?.createdAtRecordingName === 'string' ? value.createdAtRecordingName : '',
    createdAtRecordingDate: typeof value?.createdAtRecordingDate === 'string' ? value.createdAtRecordingDate : '',
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
    sourceKind: typeof value?.sourceKind === 'string' ? value.sourceKind : '',
    sourceDocumentId: toNumber(value?.sourceDocumentId),
    sourceBlockId: toNumber(value?.sourceBlockId),
    bucket,
    priorityRank: toNumber(value?.priorityRank),
    deadlineDate: typeof value?.deadlineDate === 'string' ? value.deadlineDate : '',
    goalId: toNumber(value?.goalId),
    goalName: typeof value?.goalName === 'string' ? value.goalName : '',
    currentDocumentId: toNumber(value?.currentDocumentId),
    currentBlockId: toNumber(value?.currentBlockId),
    completedAt: typeof value?.completedAt === 'string' ? value.completedAt : '',
    completedDocumentId: toNumber(value?.completedDocumentId),
    completedBlockId: toNumber(value?.completedBlockId),
  };
}

function normalizeTodoGoal(value: any): BackendTodoGoal {
  return {
    id: toNumber(value?.id),
    userId: toNumber(value?.userId),
    name: typeof value?.name === 'string' ? value.name : '',
    description: typeof value?.description === 'string' ? value.description : '',
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function normalizeBlock(value: any): BackendBlock {
  return {
    id: toNumber(value?.id),
    clientKey: typeof value?.clientKey === 'string' ? value.clientKey : '',
    documentId: toNumber(value?.documentId),
    parentBlockId: toNumber(value?.parentBlockId),
    parentClientKey: typeof value?.parentClientKey === 'string' ? value.parentClientKey : '',
    sortOrder: toNumber(value?.sortOrder),
    text: typeof value?.text === 'string' ? value.text : '',
    todoStatus: normalizeBlockTodoStatus(value?.todoStatus),
    todoId: toNumber(value?.todoId),
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
  };
}

export function normalizeDocument(value: any): BackendDocument {
  return {
    id: toNumber(value?.id),
    revision: value?.revision == null ? undefined : decimalRevision(value.revision),
    clientKey: typeof value?.clientKey === 'string' ? value.clientKey : '',
    workspaceId: toNumber(value?.workspaceId),
    directoryId: toNumber(value?.directoryId),
    kind: value?.kind === 'journal' ? 'journal' : 'note',
    title: typeof value?.title === 'string' ? value.title : '',
    journalDate: typeof value?.journalDate === 'string' ? value.journalDate : '',
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
    blocks: Array.isArray(value?.blocks) ? value.blocks.map(normalizeBlock) : [],
  };
}

type AuthFailure = { baseUrl: string; token?: string };
const authFailureListeners = new Set<(failure: AuthFailure) => void>();
export function onAuthFailure(listener: (failure: AuthFailure) => void) {
  authFailureListeners.add(listener);
  return () => { authFailureListeners.delete(listener); };
}

async function readError(response: Response, baseUrl: string, token?: string) {
  return sharedReadError(response, baseUrl, { token, onAuthFailure: notifyAuthFailure });
}

function notifyAuthFailure(failure: AuthFailure) {
  for (const listener of authFailureListeners) listener(failure);
}

async function postJson<TResponse>(baseUrl: string, path: string, body: unknown, token?: string) {
  if (path.startsWith('/secretary.v1.')) return rpcJson<TResponse>(baseUrl, path, body, { token, onAuthFailure: notifyAuthFailure });
  return postJsonBody<TResponse>(baseUrl, path, JSON.stringify(body), token);
}

// Replay the retained serialized request, rather than reconstructing it from
// the latest editor draft. Authentication remains outside the durable payload.
export async function postJsonBody<TResponse>(baseUrl: string, path: string, body: string, token?: string, signal?: AbortSignal) {
  return sharedPostJsonBody<TResponse>(baseUrl, path, body, { token, signal, onAuthFailure: notifyAuthFailure });
}

async function getJson<TResponse>(baseUrl: string, path: string, token?: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw await readError(response, baseUrl, token);
  }
  return response.json() as Promise<TResponse>;
}

async function putJson<TResponse>(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await readError(response, baseUrl, token);
  }
  return response.json() as Promise<TResponse>;
}

function normalizeWhatsAppStatus(value: any): WhatsAppStatus {
  return {
    library_update: typeof value?.library_update?.current === 'string' && typeof value?.library_update?.latest === 'string'
      ? { current: value.library_update.current, latest: value.library_update.latest, available: value.library_update.available === true }
      : undefined,
    connected: Boolean(value?.connected),
    logged_in: Boolean(value?.logged_in),
    jid: typeof value?.jid === 'string' ? value.jid : '',
    pairing: Boolean(value?.pairing),
    has_qr: Boolean(value?.has_qr),
    last_error: typeof value?.last_error === 'string' ? value.last_error : '',
    session_db: typeof value?.session_db === 'string' ? value.session_db : '',
    last_event: typeof value?.last_event === 'string' ? value.last_event : '',
    last_event_at: typeof value?.last_event_at === 'string' ? value.last_event_at : '',
  };
}

function normalizeWhatsAppNotification(value: any): WhatsAppMessageNotification {
  return {
    id: toNumber(value?.id),
    chatJid: typeof value?.chat_jid === 'string' ? value.chat_jid : '',
    messageId: typeof value?.message_id === 'string' ? value.message_id : '',
    senderJid: typeof value?.sender_jid === 'string' ? value.sender_jid : '',
    senderName: typeof value?.sender_name === 'string' ? value.sender_name : '',
    text: typeof value?.text === 'string' ? value.text : '',
    classificationReason: typeof value?.classification_reason === 'string' ? value.classification_reason : '',
    receivedAt: typeof value?.received_at === 'string' ? value.received_at : '',
  };
}

export function login(baseUrl: string, email: string, password: string) {
  return postJson<LoginResponse>(baseUrl, '/api/login', { email, password });
}

export async function listTodos(baseUrl: string, token: string, userId: number) {
  const payload = await postJson<{ todos?: BackendTodo[] }>(
    baseUrl,
    '/secretary.v1.TodosService/ListTodos',
    { userId },
    token,
  );
  return Array.isArray(payload.todos) ? payload.todos.map(normalizeTodo) : [];
}

export async function updateTodo(baseUrl: string, token: string, todo: BackendTodo) {
  const payload = await postJson<{ todo?: BackendTodo }>(
    baseUrl,
    '/secretary.v1.TodosService/UpdateTodo',
    {
      id: todo.id,
      name: todo.name,
      desc: todo.desc,
      status: todoStatusToProto(todo.status),
      userId: todo.userId,
      updatedAtRecordingId: todo.updatedAtRecordingId,
      bucket: todo.bucket,
      priorityRank: todo.priorityRank,
      deadlineDate: todo.deadlineDate,
      goalId: todo.goalId,
    },
    token,
  );
  if (!payload.todo) {
    throw new Error('Todo was not returned by the server.');
  }
  return normalizeTodo(payload.todo);
}

export async function listTodoGoals(baseUrl: string, token: string, userId: number) {
  const payload = await postJson<{ goals?: BackendTodoGoal[] }>(
    baseUrl,
    '/secretary.v1.TodosService/ListTodoGoals',
    { userId },
    token,
  );
  return Array.isArray(payload.goals) ? payload.goals.map(normalizeTodoGoal) : [];
}

export async function moveDocumentTodosToRepository(baseUrl: string, token: string, documentId: number) {
  const payload = await postJson<{ movedCount?: number }>(
    baseUrl,
    '/secretary.v1.TodosService/MoveDocumentTodosToRepository',
    { documentId },
    token,
  );
  return toNumber(payload.movedCount);
}

export async function pullOnDeckTodosToToday(baseUrl: string, token: string, workspaceId: number) {
  const payload = await postJson<{ pulledCount?: number; documentId?: number }>(
    baseUrl,
    '/secretary.v1.TodosService/PullOnDeckTodosToToday',
    { workspaceId },
    token,
  );
  return {
    pulledCount: toNumber(payload.pulledCount),
    documentId: toNumber(payload.documentId),
  };
}

export async function listWorkspaces(baseUrl: string, token: string) {
  const payload = await postJson<{ workspaces?: BackendWorkspace[] }>(
    baseUrl,
    '/secretary.v1.WorkspacesService/ListWorkspaces',
    {},
    token,
  );
  return Array.isArray(payload.workspaces) ? payload.workspaces.map(normalizeWorkspace) : [];
}

export async function createWorkspace(baseUrl: string, token: string, name: string) {
  const payload = await postJson<{ workspace?: BackendWorkspace }>(
    baseUrl,
    '/secretary.v1.WorkspacesService/CreateWorkspace',
    { name },
    token,
  );
  if (!payload.workspace) {
    throw new Error('Workspace was not returned by the server.');
  }
  return normalizeWorkspace(payload.workspace);
}

export async function listDocuments(baseUrl: string, token: string, workspaceId: number) {
  const payload = await postJson<{ documents?: BackendDocument[]; directories?: BackendDirectory[]; persistenceProtocolVersion?: number }>(
    baseUrl,
    '/secretary.v1.DocumentsService/ListDocuments',
    { workspaceId },
    token,
  );
  return {
    documents: Array.isArray(payload.documents) ? payload.documents.map(normalizeDocument) : [],
    directories: Array.isArray(payload.directories) ? payload.directories.map(normalizeDirectory) : [],
    persistenceProtocolVersion: payload.persistenceProtocolVersion ?? 0,
  } satisfies BackendDocumentIndex;
}

export type DocumentMetadata = Omit<BackendDocument, 'blocks'> & { snippet?: string };

export async function listDocumentIndex(baseUrl: string, token: string, workspaceId: number, beforeId = 0, query = '') {
  const payload = await postJson<{ entries?: DocumentMetadata[]; directories?: BackendDirectory[]; nextBeforeId?: string; persistenceProtocolVersion?: number }>(
    baseUrl, '/secretary.v1.DocumentsService/ListDocumentIndex', { workspaceId, beforeId, pageSize: 100, query }, token);
  return {
    entries: (payload.entries ?? []).map(value => {
      const { blocks: _, ...metadata } = normalizeDocument(value);
      return { ...metadata, snippet: value.snippet ?? '' };
    }),
    directories: (payload.directories ?? []).map(normalizeDirectory),
    nextBeforeId: safeInteger(payload.nextBeforeId),
    persistenceProtocolVersion: payload.persistenceProtocolVersion ?? 0,
  };
}

export async function getDocument(baseUrl: string, token: string, id: number) {
  const payload = await postJson<{ document?: BackendDocument }>(
    baseUrl,
    '/secretary.v1.DocumentsService/GetDocument',
    { id },
    token,
  );
  if (!payload.document) {
    throw new Error('Document was not returned by the server.');
  }
  return normalizeDocument(payload.document);
}

export async function saveDocument(baseUrl: string, token: string, document: BackendDocument) {
  const payload = await postJson<{ document?: BackendDocument }>(
    baseUrl,
    '/secretary.v1.DocumentsService/SaveDocument',
    { document },
    token,
  );
  if (!payload.document) {
    throw new Error('Document was not returned by the server.');
  }
  return normalizeDocument(payload.document);
}

export async function deleteDocument(baseUrl: string, token: string, id: number) {
  await postJson(
    baseUrl,
    '/secretary.v1.DocumentsService/DeleteDocument',
    { id },
    token,
  );
}

export async function listDocumentHistory(baseUrl: string, token: string, documentId: number) {
  const payload = await postJson<{ history?: BackendDocumentHistoryEntry[] }>(
    baseUrl,
    '/secretary.v1.DocumentsService/ListDocumentHistory',
    { documentId },
    token,
  );
  return Array.isArray(payload.history) ? payload.history.map(normalizeDocumentHistoryEntry) : [];
}

export async function getDocumentHistoryEntry(baseUrl: string, token: string, id: number) {
  const payload = await postJson<{ history?: BackendDocumentHistoryEntry }>(
    baseUrl,
    '/secretary.v1.DocumentsService/GetDocumentHistoryEntry',
    { id },
    token,
  );
  if (!payload.history) {
    throw new Error('Document history entry was not returned by the server.');
  }
  return normalizeDocumentHistoryEntry(payload.history);
}

export async function createDirectory(baseUrl: string, token: string, workspaceId: number, parentId: number, name: string) {
  const payload = await postJson<{ directory?: BackendDirectory }>(
    baseUrl,
    '/secretary.v1.DocumentsService/CreateDirectory',
    { workspaceId, parentId, name },
    token,
  );
  if (!payload.directory) {
    throw new Error('Directory was not returned by the server.');
  }
  return normalizeDirectory(payload.directory);
}

export async function updateDirectory(baseUrl: string, token: string, id: number, name: string, parentId = 0) {
  const payload = await postJson<{ directory?: BackendDirectory }>(
    baseUrl,
    '/secretary.v1.DocumentsService/UpdateDirectory',
    { id, name, parentId },
    token,
  );
  if (!payload.directory) {
    throw new Error('Directory was not returned by the server.');
  }
  return normalizeDirectory(payload.directory);
}

export async function patchDirectory(baseUrl: string, token: string, id: number, patch: { name?: string; parentId?: number }) {
  const payload = await postJson<{ directory?: BackendDirectory }>(
    baseUrl,
    '/secretary.v1.DocumentsService/UpdateDirectory',
    { id, patch },
    token,
  );
  if (!payload.directory) throw new Error('Directory was not returned by the server.');
  return normalizeDirectory(payload.directory);
}

export async function deleteDirectory(baseUrl: string, token: string, id: number) {
  await postJson(
    baseUrl,
    '/secretary.v1.DocumentsService/DeleteDirectory',
    { id },
    token,
  );
}

export async function listAIThreads(baseUrl: string, token: string, workspaceId: number) {
  const payload = await postJson<{ threads?: BackendAIThread[] }>(
    baseUrl,
    '/secretary.v1.AIService/ListAIThreads',
    { workspaceId },
    token,
  );
  return Array.isArray(payload.threads) ? payload.threads.map(normalizeAIThread) : [];
}

export async function getAIThread(baseUrl: string, token: string, id: number) {
  const payload = await postJson<{
    thread?: BackendAIThread;
    messages?: BackendAIMessage[];
    runs?: BackendAIRun[];
    artifacts?: BackendAIArtifact[];
    sourceRefs?: BackendAISourceRef[];
  }>(
    baseUrl,
    '/secretary.v1.AIService/GetAIThread',
    { id },
    token,
  );
  return {
    thread: payload.thread ? normalizeAIThread(payload.thread) : null,
    messages: Array.isArray(payload.messages) ? payload.messages.map(normalizeAIMessage) : [],
    runs: Array.isArray(payload.runs) ? payload.runs.map(normalizeAIRun) : [],
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.map(normalizeAIArtifact) : [],
    sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs.map(normalizeAISourceRef) : [],
  } satisfies BackendAIThreadDetail;
}

export async function createAIThread(baseUrl: string, token: string, workspaceId: number, documentId: number, title: string) {
  const payload = await postJson<{ thread?: BackendAIThread }>(
    baseUrl,
    '/secretary.v1.AIService/CreateAIThread',
    { workspaceId, documentId, title },
    token,
  );
  if (!payload.thread) {
    throw new Error('AI thread was not returned by the server.');
  }
  return normalizeAIThread(payload.thread);
}

export async function updateAIThread(baseUrl: string, token: string, id: number, title: string) {
  const payload = await postJson<{ thread?: BackendAIThread }>(
    baseUrl,
    '/secretary.v1.AIService/UpdateAIThread',
    { id, title },
    token,
  );
  if (!payload.thread) {
    throw new Error('Updated AI thread was not returned by the server.');
  }
  return normalizeAIThread(payload.thread);
}

export async function deleteAIThread(baseUrl: string, token: string, id: number) {
  await postJson(
    baseUrl,
    '/secretary.v1.AIService/DeleteAIThread',
    { id },
    token,
  );
}

export async function createAIMessage(baseUrl: string, token: string, threadId: number, role: BackendAIMessage['role'], content: string, runId = 0) {
  const payload = await postJson<{ message?: BackendAIMessage }>(
    baseUrl,
    '/secretary.v1.AIService/CreateAIMessage',
    { threadId, role, content, runId },
    token,
  );
  if (!payload.message) {
    throw new Error('AI message was not returned by the server.');
  }
  return normalizeAIMessage(payload.message);
}

export async function runAIThreadTurn(baseUrl: string, token: string, threadId: number, content: string, mode: string) {
  const payload = await postJson<{ userMessage?: BackendAIMessage; assistantMessage?: BackendAIMessage; run?: BackendAIRun }>(
    baseUrl,
    '/secretary.v1.AIService/RunAIThreadTurn',
    { threadId, content, mode },
    token,
  );
  return {
    userMessage: payload.userMessage ? normalizeAIMessage(payload.userMessage) : null,
    assistantMessage: payload.assistantMessage ? normalizeAIMessage(payload.assistantMessage) : null,
    run: payload.run ? normalizeAIRun(payload.run) : null,
  } satisfies BackendAIRunTurnResult;
}

export async function approvePomodoroUnlock(baseUrl: string, token: string, alias: string, rationale: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/pomodoro/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ alias, rationale }),
  });
  if (!response.ok) {
    throw await readError(response, baseUrl, token);
  }
  const payload = await response.json() as Partial<PomodoroUnlockApproval>;
  return {
    decision: payload.decision === 'approve' ? 'approve' : 'deny',
    time: typeof payload.time === 'number' ? payload.time : 0,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
  } satisfies PomodoroUnlockApproval;
}

export async function getWhatsAppStatus(baseUrl: string, token: string) {
  const payload = await getJson<{ enabled?: boolean; status?: unknown }>(baseUrl, '/api/whatsapp/status', token);
  return {
    enabled: Boolean(payload.enabled),
    status: normalizeWhatsAppStatus(payload.status),
  };
}

export async function getWhatsAppQR(baseUrl: string, token: string) {
  const payload = await getJson<{ qr?: string; status?: unknown }>(baseUrl, '/api/whatsapp/qr', token);
  return {
    qr: typeof payload.qr === 'string' ? payload.qr : '',
    status: normalizeWhatsAppStatus(payload.status),
  };
}

export async function reconnectWhatsApp(baseUrl: string, token: string) {
  const payload = await postJson<{ status?: unknown }>(baseUrl, '/api/whatsapp/reconnect', {}, token);
  return normalizeWhatsAppStatus(payload.status);
}

export async function logoutWhatsApp(baseUrl: string, token: string) {
  const payload = await postJson<{ status?: unknown }>(baseUrl, '/api/whatsapp/logout', {}, token);
  return normalizeWhatsAppStatus(payload.status);
}

export async function getWhatsAppSettings(baseUrl: string, token: string): Promise<WhatsAppSettings> {
  const payload = await getJson<{ importance_instructions?: string; default_importance_instructions?: string }>(baseUrl, '/api/whatsapp/settings', token);
  return {
    importanceInstructions: typeof payload.importance_instructions === 'string' ? payload.importance_instructions : '',
    defaultImportanceInstructions: typeof payload.default_importance_instructions === 'string' ? payload.default_importance_instructions : '',
  };
}

export async function saveWhatsAppSettings(baseUrl: string, token: string, importanceInstructions: string): Promise<WhatsAppSettings> {
  const payload = await putJson<{ importance_instructions?: string; default_importance_instructions?: string }>(
    baseUrl,
    '/api/whatsapp/settings',
    { importance_instructions: importanceInstructions },
    token,
  );
  return {
    importanceInstructions: typeof payload.importance_instructions === 'string' ? payload.importance_instructions : '',
    defaultImportanceInstructions: typeof payload.default_importance_instructions === 'string' ? payload.default_importance_instructions : '',
  };
}

export async function listPendingWhatsAppNotifications(baseUrl: string, token: string) {
  const payload = await getJson<{ messages?: unknown[] }>(baseUrl, '/api/whatsapp/notifications/pending', token);
  return Array.isArray(payload.messages) ? payload.messages.map(normalizeWhatsAppNotification) : [];
}

export async function markWhatsAppNotificationsNotified(baseUrl: string, token: string, ids: number[]) {
  if (ids.length === 0) {
    return [];
  }
  const payload = await postJson<{ messages?: unknown[] }>(baseUrl, '/api/whatsapp/notifications/mark-notified', { ids }, token);
  return Array.isArray(payload.messages) ? payload.messages.map(normalizeWhatsAppNotification) : [];
}
