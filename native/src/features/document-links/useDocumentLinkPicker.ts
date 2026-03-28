import { useEffect, useMemo, useRef, useState } from 'react';
import { getPageTitle } from '../outline/tree';
import type { OutlineState } from '../outline/types';

export function useDocumentLinkPicker(state: OutlineState) {
  const [documentLinkQuery, setDocumentLinkQuery] = useState('');
  const [isDocumentLinkPickerOpen, setIsDocumentLinkPickerOpen] = useState(false);
  const [activeDocumentLinkResultId, setActiveDocumentLinkResultId] = useState<string | null>(null);
  const documentLinkInputRef = useRef<HTMLInputElement | null>(null);

  const documentLinkMatches = useMemo(() => {
    const normalized = documentLinkQuery.trim().toLowerCase();
    return state.pages
      .filter((entry) => {
        if (!normalized) {
          return true;
        }
        return getPageTitle(entry).toLowerCase().includes(normalized);
      })
      .sort((left, right) => {
        const kindOrder = left.kind === right.kind ? 0 : left.kind === 'note' ? -1 : 1;
        if (kindOrder !== 0) {
          return kindOrder;
        }
        return getPageTitle(left).localeCompare(getPageTitle(right)) || left.id.localeCompare(right.id);
      })
      .slice(0, 8);
  }, [documentLinkQuery, state.pages]);
  const activeDocumentLinkMatch = useMemo(
    () => documentLinkMatches.find((entry) => entry.id === activeDocumentLinkResultId) ?? documentLinkMatches[0] ?? null,
    [activeDocumentLinkResultId, documentLinkMatches],
  );

  useEffect(() => {
    if (!isDocumentLinkPickerOpen) {
      return;
    }
    documentLinkInputRef.current?.focus();
    documentLinkInputRef.current?.select();
  }, [isDocumentLinkPickerOpen]);

  useEffect(() => {
    if (!isDocumentLinkPickerOpen) {
      return;
    }

    if (documentLinkMatches.length === 0) {
      if (activeDocumentLinkResultId !== null) {
        setActiveDocumentLinkResultId(null);
      }
      return;
    }

    if (!activeDocumentLinkResultId || !documentLinkMatches.some((entry) => entry.id === activeDocumentLinkResultId)) {
      setActiveDocumentLinkResultId(documentLinkMatches[0].id);
    }
  }, [activeDocumentLinkResultId, documentLinkMatches, isDocumentLinkPickerOpen]);

  const openDocumentLinkPicker = () => {
    setDocumentLinkQuery('');
    setActiveDocumentLinkResultId(null);
    setIsDocumentLinkPickerOpen(true);
  };

  const closeDocumentLinkPicker = () => {
    setIsDocumentLinkPickerOpen(false);
    setDocumentLinkQuery('');
    setActiveDocumentLinkResultId(null);
  };

  const moveActiveDocumentLinkResult = (direction: 1 | -1) => {
    if (documentLinkMatches.length === 0) {
      return;
    }

    setActiveDocumentLinkResultId((current) => {
      const currentIndex = current ? documentLinkMatches.findIndex((entry) => entry.id === current) : -1;
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = Math.max(0, Math.min(documentLinkMatches.length - 1, baseIndex + direction));
      return documentLinkMatches[nextIndex]?.id ?? documentLinkMatches[0].id;
    });
  };

  return {
    documentLinkQuery,
    setDocumentLinkQuery,
    isDocumentLinkPickerOpen,
    setIsDocumentLinkPickerOpen,
    activeDocumentLinkResultId,
    setActiveDocumentLinkResultId,
    documentLinkInputRef,
    documentLinkMatches,
    activeDocumentLinkMatch,
    openDocumentLinkPicker,
    closeDocumentLinkPicker,
    moveActiveDocumentLinkResult,
  };
}
