import { PersistenceError } from './gen/secretary/v1/persistence_pb';

export type AuthFailure = { baseUrl: string; token?: string };
export interface RequestOptions {
  token?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onAuthFailure?: (failure: AuthFailure) => void;
}

export class BackendError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details: unknown[] = []) {
    super(message);
    this.name = 'BackendError';
  }

  persistenceDetails(): PersistenceError[] {
    return this.details.flatMap(detail => {
      if (!detail || typeof detail !== 'object') return [];
      const wire = detail as { type?: string; value?: string };
      if (wire.type !== PersistenceError.typeName || typeof wire.value !== 'string') return [];
      try { return [PersistenceError.fromBinary(Uint8Array.from(atob(wire.value), c => c.charCodeAt(0)))]; }
      catch { return []; }
    });
  }
}

export async function readError(response: Response, baseUrl: string, options: RequestOptions = {}): Promise<BackendError> {
  if (response.status === 401) options.onAuthFailure?.({ baseUrl, token: options.token });
  try {
    const payload = await response.json();
    return new BackendError(payload.message || payload.error || `${response.status} ${response.statusText}`,
      response.status, payload.code, Array.isArray(payload.details) ? payload.details : []);
  } catch { return new BackendError(`${response.status} ${response.statusText}`, response.status); }
}

/** Durable requests pass their original bytes here; never decode/reserialize them. */
export async function postJsonBody<T>(baseUrl: string, path: string, body: string, options: RequestOptions = {}): Promise<T> {
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.trim().replace(/\/$/, '')}${path}`, {
    method: 'POST', signal: options.signal,
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body,
  });
  if (!response.ok) throw await readError(response, baseUrl, options);
  return response.json() as Promise<T>;
}
