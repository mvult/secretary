import type { ReactNode } from 'react';
import { resolveDocumentLinks } from './documentLinks';
import type { OutlinePage } from './types';

const INLINE_MARKDOWN_PATTERN = /(\*\*[^*\n][^\n]*?\*\*|\*[^*\n][^\n]*?\*)/g;

interface OutlineTextProps {
  text: string;
  cursor?: number;
  pagesByBackendId: Map<number, OutlinePage>;
  onOpenDocumentLink?: (targetDocumentId: number) => void;
}

function renderSegment(content: string, start: number, cursor: number | undefined, className?: string, tone?: string): ReactNode[] {
  if (!content) {
    return [];
  }

  const end = start + content.length;
  const props = className ? { className, 'data-link-kind': tone } : undefined;

  if (cursor == null || cursor < start || cursor >= end) {
    return [<span key={`${start}-${end}`} {...props}>{content}</span>];
  }

  const localCursor = cursor - start;
  const before = content.slice(0, localCursor);
  const atCursor = content.slice(localCursor, localCursor + 1) || ' ';
  const after = content.slice(localCursor + 1);

  return [
    before ? <span key={`${start}-${localCursor}-before`} {...props}>{before}</span> : null,
    <span key={`${start}-${localCursor}-caret`} className="row-caret">{atCursor}</span>,
    after ? <span key={`${start}-${localCursor}-after`} {...props}>{after}</span> : null,
  ].filter(Boolean);
}

function renderMarkdownSegment(content: string, start: number, cursor: number | undefined): ReactNode[] {
  const parts: ReactNode[] = [];
  let offset = 0;

  for (const match of content.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const token = match[0];
    const matchIndex = match.index ?? 0;
    const globalStart = start + matchIndex;

    parts.push(...renderSegment(content.slice(offset, matchIndex), start + offset, cursor));

    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      parts.push(...renderSegment(token.slice(2, -2), globalStart + 2, cursor, 'row-markdown-strong'));
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      parts.push(...renderSegment(token.slice(1, -1), globalStart + 1, cursor, 'row-markdown-emphasis'));
    } else {
      parts.push(...renderSegment(token, globalStart, cursor));
    }

    offset = matchIndex + token.length;
  }

  parts.push(...renderSegment(content.slice(offset), start + offset, cursor));
  return parts;
}

export function getMarkdownHeadingLevel(text: string) {
  if (text.startsWith('## ')) {
    return 2;
  }
  if (text.startsWith('# ')) {
    return 1;
  }
  return 0;
}

function renderLinkSegment(
  label: string,
  targetDocumentId: number,
  start: number,
  end: number,
  cursor: number | undefined,
  tone: string,
  onOpenDocumentLink?: (targetDocumentId: number) => void,
): ReactNode[] {
  const display = label || 'untitled';
  const isClickable = Boolean(onOpenDocumentLink && tone !== 'missing');
  const content = (
    <>
      <span className="row-link-sigil" aria-hidden="true">@</span>
      {display}
    </>
  );

  const element = isClickable ? (
    <span
      role="button"
      tabIndex={0}
      key={`${start}-${end}-link`}
      className="row-link row-link-button"
      data-link-kind={tone}
      onClick={(event) => {
        event.stopPropagation();
        onOpenDocumentLink?.(targetDocumentId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onOpenDocumentLink?.(targetDocumentId);
        }
      }}
    >
      {content}
    </span>
  ) : (
    <span key={`${start}-${end}-link`} className="row-link" data-link-kind={tone}>
      {content}
    </span>
  );

  if (cursor == null || cursor < start || cursor >= end) {
    return [element];
  }

  return [
    element,
    <span key={`${start}-${end}-caret`} className="row-caret"> </span>,
  ];
}

export function OutlineText({ text, cursor, pagesByBackendId, onOpenDocumentLink }: OutlineTextProps) {
  const links = resolveDocumentLinks(text, pagesByBackendId);
  const content: ReactNode[] = [];
  const headingLevel = getMarkdownHeadingLevel(text);
  const headingPrefixLength = headingLevel > 0 ? headingLevel + 1 : 0;
  const displayText = headingPrefixLength > 0 ? text.slice(headingPrefixLength) : text;
  let offset = 0;

  for (const link of links) {
    if (link.end <= headingPrefixLength) {
      offset = link.end;
      continue;
    }

    const segmentStart = Math.max(offset, headingPrefixLength);
    if (segmentStart < link.start) {
      content.push(...renderMarkdownSegment(text.slice(segmentStart, link.start), segmentStart, cursor));
    }
    content.push(...renderLinkSegment(
      link.label,
      link.targetDocumentId,
      link.start,
      link.end,
      cursor,
      link.targetKind,
      onOpenDocumentLink,
    ));
    offset = link.end;
  }

  const trailingStart = Math.max(offset, headingPrefixLength);
  content.push(...renderMarkdownSegment(text.slice(trailingStart), trailingStart, cursor));

  if (cursor === text.length) {
    content.push(<span key="cursor-end" className="row-caret"> </span>);
  }

  return <>{content.length > 0 ? content : (displayText.length === 0 && cursor != null ? <span className="row-caret"> </span> : null)}</>;
}
