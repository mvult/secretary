import type { DraftRecord } from '../../lib/draftStorage';
import { isDraftDirty } from './draftReconciliation';

export const CLEAN_BODY_LIMIT = 100;

/** Unknown/legacy baselines are recovery state, not disposable cache. */
export function boundCleanBodies(records: DraftRecord[], pinned: ReadonlySet<string>, limit = CLEAN_BODY_LIMIT) {
  const candidates = records.filter(record => !pinned.has(record.page.id)
    && record.page.backendId && record.baseline?.backendId === record.page.backendId
    && record.baseline?.workspaceId && record.baseline.clientKey && /^[1-9][0-9]*$/.test(record.baseline.revision ?? '')
    && !isDraftDirty(record) && !record.retry && !record.needsRefresh && !record.serverCopy);
  candidates.sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0) || a.page.id.localeCompare(b.page.id));
  const evicted = new Set(candidates.slice(limit).map(record => record.page.id));
  return { records: records.filter(record => !evicted.has(record.page.id)), evicted };
}
