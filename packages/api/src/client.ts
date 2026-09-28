import { createClient, ConnectError, Code, type Transport } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import type { JsonValue, ServiceType, MethodInfo } from '@bufbuild/protobuf';
import { AIService } from './gen/secretary/v1/ai_connect';
import { ActivitiesService } from './gen/secretary/v1/activities_connect';
import { DocumentsService } from './gen/secretary/v1/documents_connect';
import { WorkspacesService } from './gen/secretary/v1/workspaces_connect';
import { TodosService } from './gen/secretary/v1/todos_connect';
import { UsersService } from './gen/secretary/v1/users_connect';
import { RecordingsService } from './gen/secretary/v1/recordings_connect';
import { BackendError, postJsonBody, readError, type RequestOptions } from './transport';

export { BackendError } from './transport';
export function createAPI(options: { baseUrl: string; getToken?: () => string | null; fetch?: typeof globalThis.fetch; onAuthFailure?: RequestOptions['onAuthFailure'] }) {
  const wireTransport = createConnectTransport({
    baseUrl: options.baseUrl,
    useBinaryFormat: false,
    fetch: options.fetch,
    interceptors: [(next) => async (req) => {
      const token = options.getToken?.() ?? undefined;
      if (token) req.header.set('Authorization', `Bearer ${token}`);
      try { return await next(req); }
      catch (error) {
        if (!(error instanceof ConnectError)) throw error;
        if (error.code === Code.Unauthenticated) options.onAuthFailure?.({ baseUrl: options.baseUrl, token });
        throw error;
      }
    }],
  });
  // Convert outside Connect's call runner, which otherwise wraps custom errors.
  const transport: Transport = { ...wireTransport, unary: async (service, method, signal, timeout, headers, input, context) => {
    try { return await wireTransport.unary(service, method, signal, timeout, headers, input, context); }
    catch (error) {
      if (!(error instanceof ConnectError)) throw error;
      const status = ({ [Code.Unauthenticated]: 401, [Code.PermissionDenied]: 403, [Code.NotFound]: 404,
        [Code.InvalidArgument]: 400, [Code.FailedPrecondition]: 400, [Code.Aborted]: 409, [Code.Unavailable]: 503 } as Record<number, number>)[error.code] ?? 500;
      throw new BackendError(error.rawMessage, status, Code[error.code].replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`),
        error.details.map(detail => 'type' in detail ? { type: detail.type, value: btoa(String.fromCharCode(...detail.value)) } : detail));
    }
  } };
  return {
    documents: createClient(DocumentsService, transport), workspaces: createClient(WorkspacesService, transport),
    todos: createClient(TodosService, transport), users: createClient(UsersService, transport),
    recordings: createClient(RecordingsService, transport), activities: createClient(ActivitiesService, transport),
    ai: createClient(AIService, transport),
  };
}

const services: ServiceType[] = [AIService, ActivitiesService, DocumentsService, WorkspacesService, TodosService, UsersService, RecordingsService];
const methods = new Map<string, MethodInfo>(services.flatMap(service => Object.values(service.methods).map(method => [`/${service.typeName}/${method.name}`, method] as const)));

/** Incremental native adapter: generated schemas own the wire, app owns domain models. */
export async function rpcJson<T>(baseUrl: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const method = methods.get(path);
  if (!method) throw new Error(`Unknown RPC: ${path}`);
  const request = method.I.fromJson(body as JsonValue);
  const result = await postJsonBody<JsonValue>(baseUrl, path, request.toJsonString(), options);
  return method.O.fromJson(result, { ignoreUnknownFields: true }).toJson() as T;
}

export { readError };
