import type { ReactNode } from 'react';
import { resolveDocumentLinks } from './documentLinks';
import type { OutlinePage } from './types';

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
  let offset = 0;

  for (const link of links) {
    content.push(...renderSegment(text.slice(offset, link.start), offset, cursor));
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

  content.push(...renderSegment(text.slice(offset), offset, cursor));

  if (cursor === text.length) {
    content.push(<span key="cursor-end" className="row-caret"> </span>);
  }

  return <>{content.length > 0 ? content : cursor != null ? <span className="row-caret"> </span> : null}</>;
}
