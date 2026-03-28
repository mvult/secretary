import { useEffect, useMemo, useRef, useState } from 'react';
import { findMatchingNotes, getPageTitle } from '../outline/tree';
import type { OutlineState } from '../outline/types';
import { pageMatchesBody, pageMatchesTitle } from '../../app/format';

export function useSearchView(state: OutlineState) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'insert' | 'select'>('insert');
  const [searchScope, setSearchScope] = useState<'title' | 'fulltext'>('title');
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchJPressRef = useRef<number | null>(null);

  const matches = useMemo(() => findMatchingNotes(state, searchQuery), [searchQuery, state]);
  const titleMatches = useMemo(
    () => matches.filter(({ page }) => pageMatchesTitle(page, searchQuery)),
    [matches, searchQuery],
  );
  const fullTextMatches = useMemo(
    () => matches.filter(({ page }) => !pageMatchesTitle(page, searchQuery) && pageMatchesBody(page, searchQuery)),
    [matches, searchQuery],
  );
  const searchMatches = searchScope === 'fulltext' ? fullTextMatches : titleMatches;
  const visibleMatches = useMemo(() => searchMatches.slice(0, 8), [searchMatches]);
  const topMatch = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return searchMatches[0]?.page ?? null;
    }

    return searchMatches.find((entry) => getPageTitle(entry.page).trim().toLowerCase() === normalized)?.page
      ?? searchMatches[0]?.page
      ?? null;
  }, [searchMatches, searchQuery]);
  const activeSearchMatch = useMemo(() => {
    if (searchMode !== 'select') {
      return topMatch;
    }

    return visibleMatches.find((entry) => entry.page.id === activeSearchResultId)?.page ?? visibleMatches[0]?.page ?? null;
  }, [activeSearchResultId, searchMode, topMatch, visibleMatches]);

  useEffect(() => {
    if (state.activeView === 'search') {
      setSearchMode('insert');
      setSearchScope('title');
      setActiveSearchResultId(null);
      lastSearchJPressRef.current = null;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [state.activeView]);

  useEffect(() => {
    if (searchMode !== 'select') {
      if (activeSearchResultId !== null) {
        setActiveSearchResultId(null);
      }
      return;
    }

    if (visibleMatches.length === 0) {
      if (activeSearchResultId !== null) {
        setActiveSearchResultId(null);
      }
      return;
    }

    if (!activeSearchResultId || !visibleMatches.some((entry) => entry.page.id === activeSearchResultId)) {
      setActiveSearchResultId(visibleMatches[0].page.id);
    }
  }, [activeSearchResultId, searchMode, visibleMatches]);

  const resetSearch = () => {
    setSearchQuery('');
    setSearchMode('insert');
    setSearchScope('title');
    setActiveSearchResultId(null);
    lastSearchJPressRef.current = null;
  };

  const moveActiveSearchResult = (direction: 1 | -1) => {
    if (visibleMatches.length === 0) {
      return;
    }

    setSearchMode('select');
    setActiveSearchResultId((current) => {
      const currentIndex = current ? visibleMatches.findIndex((entry) => entry.page.id === current) : -1;
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = Math.max(0, Math.min(visibleMatches.length - 1, baseIndex + direction));
      return visibleMatches[nextIndex]?.page.id ?? visibleMatches[0].page.id;
    });
  };

  return {
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    searchScope,
    setSearchScope,
    activeSearchResultId,
    setActiveSearchResultId,
    searchInputRef,
    lastSearchJPressRef,
    visibleMatches,
    activeSearchMatch,
    resetSearch,
    moveActiveSearchResult,
  };
}
