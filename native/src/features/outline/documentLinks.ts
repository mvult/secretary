import type { OutlinePage, PageKind } from './types';

export interface ParsedDocumentLink {
  targetDocumentId: number;
  label: string;
  raw: string;
  start: number;
  end: number;
}

export interface ResolvedDocumentLink extends ParsedDocumentLink {
  targetKind: PageKind | 'missing';
}

const DOCUMENT_LINK_PATTERN = /\[\[doc:(\d+)\|([^\]]+)\]\]/g;

export function parseDocumentLinks(text: string): ParsedDocumentLink[] {
  const links: ParsedDocumentLink[] = [];

  for (const match of text.matchAll(DOCUMENT_LINK_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? -1;
    const targetDocumentId = Number(match[1]);
    if (start < 0 || !Number.isFinite(targetDocumentId) || targetDocumentId <= 0) {
      continue;
    }

    links.push({
      targetDocumentId,
      label: match[2],
      raw,
      start,
      end: start + raw.length,
    });
  }

  return links;
}

export function findDocumentLinkAtCursor(text: string, cursor: number): ParsedDocumentLink | null {
  return parseDocumentLinks(text).find((link) => cursor >= link.start && cursor < link.end) ?? null;
}

export function resolveDocumentLinks(text: string, pagesByBackendId: Map<number, OutlinePage>): ResolvedDocumentLink[] {
  return parseDocumentLinks(text).map((link) => ({
    ...link,
    targetKind: pagesByBackendId.get(link.targetDocumentId)?.kind ?? 'missing',
  }));
}
