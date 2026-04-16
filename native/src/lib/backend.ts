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

export interface BackendTodo {
  id: number;
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
}

function todoStatusToProto(status: BackendTodoStatus) {
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
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return 0;
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

function normalizeTodo(value: any): BackendTodo {
  return {
    id: toNumber(value?.id),
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

function normalizeDocument(value: any): BackendDocument {
  return {
    id: toNumber(value?.id),
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

async function readError(response: Response) {
  try {
    const payload = await response.json();
    if (typeof payload?.message === 'string') {
      return payload.message;
    }
    if (typeof payload?.error === 'string') {
      return payload.error;
    }
  } catch {
    // Ignore JSON parsing failures for error bodies.
  }

  return `${response.status} ${response.statusText}`;
}

async function postJson<TResponse>(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<TResponse>;
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
    },
    token,
  );
  if (!payload.todo) {
    throw new Error('Todo was not returned by the server.');
  }
  return normalizeTodo(payload.todo);
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
  const payload = await postJson<{ documents?: BackendDocument[]; directories?: BackendDirectory[] }>(
    baseUrl,
    '/secretary.v1.DocumentsService/ListDocuments',
    { workspaceId },
    token,
  );
  return {
    documents: Array.isArray(payload.documents) ? payload.documents.map(normalizeDocument) : [],
    directories: Array.isArray(payload.directories) ? payload.directories.map(normalizeDirectory) : [],
  } satisfies BackendDocumentIndex;
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
