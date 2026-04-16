package agent

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

var documentLinkPattern = regexp.MustCompile(`\[\[doc:(\d+)\|([^\]]+)\]\]`)

type systemDocumentInfo struct {
	DocumentID int64
	Title      string
	Content    string
}

func (s *session) searchDocuments(req documentSearchRequest) (documentSearchResponse, error) {
	rows, err := s.services.ListWorkspaceDocuments(s.ctx, s.workspaceID)
	if err != nil {
		return documentSearchResponse{}, err
	}
	query := strings.ToLower(strings.TrimSpace(req.Query))
	limit := req.Limit
	if limit <= 0 || limit > defaultSearchDocs {
		limit = defaultSearchDocs
	}
	results := make([]documentSearchResult, 0, limit)
	for _, doc := range rows {
		blocks, err := s.services.ListDocumentBlocks(s.ctx, doc.ID)
		if err != nil {
			return documentSearchResponse{}, err
		}
		outline := renderDocumentOutline(doc, blocks)
		if query != "" && !strings.Contains(strings.ToLower(doc.Title+"\n"+outline), query) {
			continue
		}
		results = append(results, documentSearchResult{DocumentID: int64(doc.ID), Title: doc.Title, Kind: doc.Kind, Snippet: snippetForQuery(outline, query), UpdatedAt: formatTime(doc.UpdatedAt)})
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].UpdatedAt > results[j].UpdatedAt })
	if len(results) > limit {
		results = results[:limit]
	}
	return documentSearchResponse{Results: results}, nil
}

func (s *session) getDocument(req getDocumentRequest) (getDocumentResponse, error) {
	doc, blocks, err := s.services.LoadAuthorizedDocument(s.ctx, int32(req.DocumentID), s.userID)
	if err != nil {
		return getDocumentResponse{}, err
	}
	content := renderDocumentOutline(doc, blocks)
	_ = s.addSourceRef("document", int64(doc.ID), doc.Title, firstNonEmptyDocumentText(blocks))
	return getDocumentResponse{DocumentID: int64(doc.ID), Title: doc.Title, Kind: doc.Kind, Locked: isLockedSystemDocument(doc), Content: content}, nil
}

func (s *session) getLinkedDocuments(req getDocumentRequest) (documentSearchResponse, error) {
	_, blocks, err := s.services.LoadAuthorizedDocument(s.ctx, int32(req.DocumentID), s.userID)
	if err != nil {
		return documentSearchResponse{}, err
	}
	seen := map[int32]struct{}{}
	results := make([]documentSearchResult, 0, 8)
	for _, block := range blocks {
		for _, match := range documentLinkPattern.FindAllStringSubmatch(block.Text, -1) {
			linkedID, err := parseInt32(match[1])
			if err != nil {
				continue
			}
			if _, ok := seen[linkedID]; ok {
				continue
			}
			seen[linkedID] = struct{}{}
			linkedDoc, linkedBlocks, err := s.services.LoadAuthorizedDocument(s.ctx, linkedID, s.userID)
			if err != nil {
				continue
			}
			results = append(results, documentSearchResult{DocumentID: int64(linkedDoc.ID), Title: linkedDoc.Title, Kind: linkedDoc.Kind, Snippet: snippetForQuery(renderDocumentOutline(linkedDoc, linkedBlocks), ""), UpdatedAt: formatTime(linkedDoc.UpdatedAt)})
			_ = s.addSourceRef("document", int64(linkedDoc.ID), linkedDoc.Title, firstNonEmptyDocumentText(linkedBlocks))
		}
	}
	return documentSearchResponse{Results: results}, nil
}

func (s *session) listDirectories(req listDirectoriesRequest) (listDirectoriesResponse, error) {
	normalizedPath := normalizeWorkspacePath(req.Path)
	directories, err := s.services.ListWorkspaceDirectories(s.ctx, s.workspaceID)
	if err != nil {
		return listDirectoriesResponse{}, err
	}
	documents, err := s.services.ListWorkspaceDocuments(s.ctx, s.workspaceID)
	if err != nil {
		return listDirectoriesResponse{}, err
	}
	targetDirectory, err := resolveDirectoryPath(directories, normalizedPath)
	if err != nil {
		return listDirectoriesResponse{}, err
	}
	entries := make([]directoryEntry, 0)
	for _, directory := range directories {
		if !directoryHasParent(directory, targetDirectory) {
			continue
		}
		entries = append(entries, directoryEntry{EntryType: "directory", Name: directory.Name, Path: joinDirectoryPath(normalizedPath, directory.Name), DirectoryID: int64(directory.ID), UpdatedAt: formatTime(directory.UpdatedAt)})
	}
	for _, document := range documents {
		if !documentBelongsToDirectory(document, targetDirectory) {
			continue
		}
		name := displayDocumentName(document)
		entries = append(entries, directoryEntry{EntryType: "document", Name: name, Path: joinDirectoryPath(normalizedPath, name), DocumentID: int64(document.ID), Kind: document.Kind, JournalDate: journalDateString(document), UpdatedAt: formatTime(document.UpdatedAt)})
	}
	response := listDirectoriesResponse{Path: normalizedPath, Entries: entries}
	if normalizedPath != "/" {
		response.ParentPath = parentDirectoryPath(normalizedPath)
	}
	return response, nil
}

func (s *session) loadSystemDocument() (*systemDocumentInfo, error) {
	docs, err := s.services.ListWorkspaceDocuments(s.ctx, s.workspaceID)
	if err != nil {
		return nil, err
	}
	for _, doc := range docs {
		if doc.Kind != "note" || doc.Title != lockedSystemDocument {
			continue
		}
		blocks, err := s.services.ListDocumentBlocks(s.ctx, doc.ID)
		if err != nil {
			return nil, err
		}
		return &systemDocumentInfo{DocumentID: int64(doc.ID), Title: doc.Title, Content: renderDocumentOutline(doc, blocks)}, nil
	}
	return nil, nil
}

func normalizeWorkspacePath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "/"
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	cleaned := path.Clean(trimmed)
	if cleaned == "." || cleaned == "" {
		return "/"
	}
	return cleaned
}

func resolveDirectoryPath(directories []db.Directory, normalizedPath string) (*db.Directory, error) {
	if normalizedPath == "/" {
		return nil, nil
	}
	segments := strings.Split(strings.TrimPrefix(normalizedPath, "/"), "/")
	parentID := int32(0)
	var current *db.Directory
	for _, segment := range segments {
		if segment == "" {
			continue
		}
		current = findDirectoryByName(directories, segment, parentID)
		if current == nil {
			return nil, fmt.Errorf("directory not found: %s", normalizedPath)
		}
		parentID = current.ID
	}
	return current, nil
}

func directoryHasParent(directory db.Directory, parent *db.Directory) bool {
	if parent == nil {
		return !directory.ParentID.Valid
	}
	return directory.ParentID.Valid && directory.ParentID.Int32 == parent.ID
}

func documentBelongsToDirectory(document db.Document, directory *db.Directory) bool {
	if directory == nil {
		return !document.DirectoryID.Valid
	}
	return document.DirectoryID.Valid && document.DirectoryID.Int32 == directory.ID
}

func displayDocumentName(document db.Document) string {
	if title := strings.TrimSpace(document.Title); title != "" {
		return title
	}
	if journalDate := journalDateString(document); journalDate != "" {
		return journalDate
	}
	return fmt.Sprintf("%s-%d", document.Kind, document.ID)
}

func journalDateString(document db.Document) string {
	if !document.JournalDate.Valid {
		return ""
	}
	return document.JournalDate.Time.Format("2006-01-02")
}

func joinDirectoryPath(basePath string, name string) string {
	if basePath == "/" {
		return "/" + name
	}
	return basePath + "/" + name
}

func parentDirectoryPath(currentPath string) string {
	if currentPath == "/" {
		return ""
	}
	parent := path.Dir(currentPath)
	if parent == "." || parent == "" {
		return "/"
	}
	return parent
}

func isLockedSystemDocument(doc db.Document) bool {
	return strings.EqualFold(strings.TrimSpace(doc.Title), lockedSystemDocument)
}

func parseInt32(value string) (int32, error) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 32)
	if err != nil {
		return 0, err
	}
	return int32(parsed), nil
}
