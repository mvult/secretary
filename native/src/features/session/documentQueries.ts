import { QueryClient } from '@tanstack/react-query';
import { backendIdentity, type DraftScope } from '../../lib/draftStorage';
import { getDocument, listDocumentIndex, listWorkspaces, listTodos, listTodoGoals } from '../../lib/backend';
import { CLEAN_BODY_LIMIT } from './bodyCache';

/** Live server results only. Each read family has a separate bounded idle cache.
 * Durable requests and editable drafts never live here. */
export class DocumentQueries {
  private client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 5 * 60_000 } } });

  private async read<T>(queryKey: readonly unknown[], queryFn: () => Promise<T>) {
    try {
      return await this.client.fetchQuery({ queryKey, queryFn });
    } finally {
      const idle = this.client.getQueryCache().getAll().filter(query => query.state.fetchStatus === 'idle' && query.queryKey[0] === queryKey[0])
        .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
      for (const query of idle.slice(CLEAN_BODY_LIMIT)) this.client.removeQueries({ queryKey: query.queryKey, exact: true });
    }
  }

  get(scope: DraftScope, token: string, id: number) {
    return this.read(['document', ...scope, id], () => getDocument(backendIdentity(scope[0]), token, id));
  }

  index(scope: DraftScope, token: string, before = 0, query = '') {
    return this.read(['index', ...scope, query, before],
      () => listDocumentIndex(backendIdentity(scope[0]), token, Number(scope[2]), before, query));
  }

  workspaces(base: string, token: string, userId: number | null) {
    return this.read(['workspaces', backendIdentity(base), userId], () => listWorkspaces(base, token));
  }

  todos(base: string, token: string, userId: number) {
    return this.read(['todos', backendIdentity(base), userId], () => listTodos(base, token, userId));
  }

  goals(base: string, token: string, userId: number) {
    return this.read(['goals', backendIdentity(base), userId], () => listTodoGoals(base, token, userId));
  }

  clearLists() { this.client.removeQueries({ predicate: query => query.queryKey[0] !== 'document' }); }

  clear() { this.client.clear(); }
}
