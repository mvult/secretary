import { useEffect, useMemo, useRef, useState } from 'react';
import { findMatchingNotes, getPageTitle } from '../outline/tree';
import type { OutlineState } from '../outline/types';
import { pageMatchesBody, pageMatchesTitle } from '../../app/format';
import { readDocumentIndex, indexPage } from '../session/documentIndex';
import type { DocumentMetadata, listDocumentIndex } from '../../lib/backend';
import type { OutlinePage } from '../outline/types';

export function useSearchView(state: OutlineState, session?: { backendUrl: string; authToken: string; workspaceId: number | null; syncEnabled: boolean; pagesForPersistence: OutlinePage[]; fetchIndex?: typeof listDocumentIndex }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'insert' | 'select'>('insert');
  const [searchScope, setSearchScope] = useState<'title' | 'fulltext'>('title');
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchJPressRef = useRef<number | null>(null);
  const [remoteSearch, setRemoteSearch] = useState<{ key: string; entries: DocumentMetadata[]; status: string }>({ key: '', entries: [], status: '' });
  const { backendUrl = '', authToken = '', workspaceId = null, syncEnabled = false, fetchIndex } = session ?? {};
  const searchKey = JSON.stringify([backendUrl, authToken, workspaceId, searchQuery.trim()]);
  useEffect(() => {
    let active = true;
    if (state.activeView !== 'search' || !searchQuery.trim() || !syncEnabled || !workspaceId) return;
    const timer = window.setTimeout(() => {
      setRemoteSearch({ key: searchKey, entries: [], status: 'Searching workspace…' });
      void readDocumentIndex(backendUrl, authToken, workspaceId, () => active, searchQuery.trim(), fetchIndex).then(result => {
        if (active) setRemoteSearch({ key: searchKey, entries: result.entries, status: '' });
      }).catch(() => { if (active) setRemoteSearch({ key: searchKey, entries: [], status: 'Workspace search unavailable; cached matches only.' }); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [state.activeView, searchKey, backendUrl, authToken, workspaceId, syncEnabled, searchQuery, fetchIndex]);
  const remote = remoteSearch.key === searchKey && syncEnabled ? remoteSearch.entries : [];

  const matches = useMemo(() => findMatchingNotes(state.pages, searchQuery), [searchQuery, state.pages]);
  const titleMatches = useMemo(
    () => matches.filter(({ page }) => pageMatchesTitle(page, searchQuery)),
    [matches, searchQuery],
  );
  const fullTextMatches = useMemo(() => {
    const local = matches.filter(({ page }) => !pageMatchesTitle(page, searchQuery) && pageMatchesBody(page, searchQuery));
    const loaded = new Set((session?.pagesForPersistence ?? state.pages).map(page => page.backendId));
    return [...local, ...remote.filter(entry => entry.kind === 'note' && entry.snippet && !loaded.has(entry.id))
      .map(entry => ({ page: indexPage(entry), rank: 110, snippet: entry.snippet }))
      .filter(({ page }) => !pageMatchesTitle(page, searchQuery))];
  }, [matches, searchQuery, remote, session?.pagesForPersistence, state.pages]);
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
    searchStatus: !syncEnabled ? 'Cached bodies only while offline.' : remoteSearch.key === searchKey ? remoteSearch.status : searchQuery.trim() ? 'Searching workspace…' : '',
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
