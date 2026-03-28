import { getPageDateLabel, getPageTitle } from '../outline/tree';
import type { OutlinePage } from '../outline/types';

interface SearchViewProps {
  searchQuery: string;
  searchScope: 'title' | 'fulltext';
  searchMode: 'insert' | 'select';
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  visibleMatches: { page: OutlinePage }[];
  activeSearchMatch: OutlinePage | null;
  lastSearchJPressRef: React.MutableRefObject<number | null>;
  onChangeQuery: (value: string) => void;
  onSetSearchScope: (scope: 'title' | 'fulltext') => void;
  onSetSearchMode: (mode: 'insert' | 'select') => void;
  onSetActiveSearchResultId: (id: string | null) => void;
  onMoveActiveSearchResult: (direction: 1 | -1) => void;
  onSubmitSearch: () => void;
  onOpenSearchResult: (pageId: string) => void;
}

export function SearchView({
  searchQuery,
  searchScope,
  searchMode,
  searchInputRef,
  visibleMatches,
  activeSearchMatch,
  lastSearchJPressRef,
  onChangeQuery,
  onSetSearchScope,
  onSetSearchMode,
  onSetActiveSearchResultId,
  onMoveActiveSearchResult,
  onSubmitSearch,
  onOpenSearchResult,
}: SearchViewProps) {
  return (
    <section className="search-shell">
      <header className="page-header search-header">
        <p className="page-date">New or existing note</p>
        <div className="page-heading-row page-heading-row-search">
          <span className="page-kind">{searchScope === 'title' ? 'Title' : 'Full text'}</span>
          <input
            ref={searchInputRef}
            className="page-title-input search-input"
            type="text"
            value={searchQuery}
            placeholder="Type a note title"
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={(event) => {
              const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey;

              if (event.key === 'Tab') {
                event.preventDefault();
                onSetSearchScope(searchScope === 'title' ? 'fulltext' : 'title');
                onSetActiveSearchResultId(null);
                return;
              }

              if (searchMode === 'select') {
                if (event.key === 'j' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  onMoveActiveSearchResult(1);
                  return;
                }

                if (event.key === 'k' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  onMoveActiveSearchResult(-1);
                  return;
                }

                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSubmitSearch();
                  return;
                }

                if (isPlainKey && event.key.length === 1) {
                  onSetSearchMode('insert');
                  onSetActiveSearchResultId(null);
                  lastSearchJPressRef.current = event.key === 'j' ? Date.now() : null;
                }

                return;
              }

              if (isPlainKey && event.key === 'j') {
                lastSearchJPressRef.current = Date.now();
              } else if (
                isPlainKey
                && event.key === 'k'
                && lastSearchJPressRef.current
                && Date.now() - lastSearchJPressRef.current <= 250
              ) {
                event.preventDefault();
                onChangeQuery(searchQuery.endsWith('j') ? searchQuery.slice(0, -1) : searchQuery);
                onSetSearchMode('select');
                onSetActiveSearchResultId(visibleMatches[0]?.page.id ?? null);
                lastSearchJPressRef.current = null;
                return;
              } else {
                lastSearchJPressRef.current = null;
              }

              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitSearch();
              }
            }}
          />
        </div>
      </header>

      <div className="search-results">
        {visibleMatches.length > 0 ? (
          visibleMatches.map(({ page: match }) => (
            <button
              key={match.id}
              type="button"
              className="search-result"
              data-active={activeSearchMatch?.id === match.id ? 'true' : 'false'}
              onClick={() => onOpenSearchResult(match.id)}
            >
              <span className="search-result-title">{getPageTitle(match)}</span>
              <span className="search-result-date">{getPageDateLabel(match)}</span>
            </button>
          ))
        ) : searchQuery.trim() && searchScope === 'title' ? (
          <button type="button" className="search-result search-result-create" data-active="true" onClick={onSubmitSearch}>
            <span className="search-result-title">Create "{searchQuery.trim()}"</span>
            <span className="search-result-date">Press Enter to make a new page</span>
          </button>
        ) : searchQuery.trim() ? (
          <div className="search-empty">No full text matches. Press Shift+Tab for title matches.</div>
        ) : (
          <div className="search-empty">No notes yet. Start typing to create a new one.</div>
        )}
      </div>
    </section>
  );
}
