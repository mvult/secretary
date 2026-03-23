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

export interface BackendWorkspace {
  id: number;
  name: string;
  createdAt: string;
}

export interface BackendBlock {
  id: number;
  clientKey: string;
  documentId: number;
  parentBlockId: number;
  parentClientKey: string;
  sortOrder: number;
  text: string;
  status: 'note' | 'todo' | 'doing' | 'done';
  todoId: number;
  createdAt: string;
  updatedAt: string;
}

export interface BackendDocument {
  id: number;
  clientKey: string;
  workspaceId: number;
  kind: 'journal' | 'note';
  title: string;
  journalDate: string;
  createdAt: string;
  updatedAt: string;
  blocks: BackendBlock[];
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

function normalizeBlock(value: any): BackendBlock {
  return {
    id: toNumber(value?.id),
    clientKey: typeof value?.clientKey === 'string' ? value.clientKey : '',
    documentId: toNumber(value?.documentId),
    parentBlockId: toNumber(value?.parentBlockId),
    parentClientKey: typeof value?.parentClientKey === 'string' ? value.parentClientKey : '',
    sortOrder: toNumber(value?.sortOrder),
    text: typeof value?.text === 'string' ? value.text : '',
    status: value?.status === 'todo' || value?.status === 'doing' || value?.status === 'done' ? value.status : 'note',
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
  const payload = await postJson<{ documents?: BackendDocument[] }>(
    baseUrl,
    '/secretary.v1.DocumentsService/ListDocuments',
    { workspaceId },
    token,
  );
  return Array.isArray(payload.documents) ? payload.documents.map(normalizeDocument) : [];
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
