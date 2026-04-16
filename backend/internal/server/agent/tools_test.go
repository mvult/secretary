package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func TestWorkspaceSkillsFromAIDirectory(t *testing.T) {
	ctx := context.Background()
	svc := newFakeServices()
	svc.directories = []db.Directory{
		{ID: 1, Name: agentDirectoryName},
		{ID: 2, Name: agentSkillsDirectory, ParentID: pgtype.Int4{Int32: 1, Valid: true}},
	}
	svc.documents = []db.Document{
		{ID: 10, Title: "Atlas migrations", Kind: "note", DirectoryID: pgtype.Int4{Int32: 2, Valid: true}},
		{ID: 11, Title: "Not a skill", Kind: "note", DirectoryID: pgtype.Int4{Int32: 1, Valid: true}},
	}
	svc.blocks[10] = []db.Block{{ID: 1, DocumentID: 10, SortOrder: 1, Text: "---\nname: atlas-migrations\ndescription: Atlas workflow for backend schema changes\nmetadata:\n  scope: backend\n---"}, {ID: 2, DocumentID: 10, SortOrder: 2, Text: "Use this whenever backend/sql/schema.sql changes."}}
	svc.blocks[11] = []db.Block{{ID: 3, DocumentID: 11, SortOrder: 1, Text: "plain note"}}

	s := &session{ctx: ctx, services: svc, workspaceID: 1, userID: 2, mode: "ask", runID: 1}
	if err := s.loadSkills(); err != nil {
		t.Fatalf("loadSkills: %v", err)
	}
	if len(s.skills) != 1 || s.skills[0].Name != "atlas-migrations" {
		t.Fatalf("unexpected skills: %#v", s.skills)
	}
	tools, err := s.buildToolbox()
	if err != nil {
		t.Fatalf("buildToolbox: %v", err)
	}
	if !tools.has("create_document") || !tools.has("insert_block") || !tools.has("move_block") {
		t.Fatalf("expected mutation tools to exist")
	}
	if tools.has("rewrite_document") || tools.has("append_document") {
		t.Fatalf("unexpected legacy tools exposed")
	}
	listOutput, err := tools.execute(ctx, "list_skills", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("list_skills: %v", err)
	}
	var listed listSkillsResponse
	if err := json.Unmarshal([]byte(listOutput), &listed); err != nil {
		t.Fatalf("decode list_skills: %v", err)
	}
	if len(listed.Skills) != 1 || listed.Skills[0].Name != "atlas-migrations" {
		t.Fatalf("unexpected listed skills: %#v", listed.Skills)
	}
	getOutput, err := tools.execute(ctx, "get_skill", json.RawMessage(`{"name":"atlas-migrations"}`))
	if err != nil {
		t.Fatalf("get_skill: %v", err)
	}
	var loaded getSkillResponse
	if err := json.Unmarshal([]byte(getOutput), &loaded); err != nil {
		t.Fatalf("decode get_skill: %v", err)
	}
	if loaded.Title != "Atlas migrations" || loaded.Metadata["scope"] != "backend" || !strings.Contains(loaded.Content, "backend/sql/schema.sql") {
		t.Fatalf("unexpected get_skill payload: %#v", loaded)
	}
}

func TestListDirectoriesTool(t *testing.T) {
	ctx := context.Background()
	now := timestamptz(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	svc := newFakeServices()
	svc.directories = []db.Directory{
		{ID: 1, Name: "Projects", UpdatedAt: now},
		{ID: 2, Name: "Alpha", ParentID: pgtype.Int4{Int32: 1, Valid: true}, UpdatedAt: now},
	}
	svc.documents = []db.Document{
		{ID: 10, Title: "Root note", Kind: "note", UpdatedAt: now},
		{ID: 11, Title: "Roadmap", Kind: "note", DirectoryID: pgtype.Int4{Int32: 2, Valid: true}, UpdatedAt: now},
		{ID: 12, Title: "Daily journal", Kind: "journal", JournalDate: date(2026, 4, 7), UpdatedAt: now},
	}
	s := &session{ctx: ctx, services: svc, workspaceID: 1, userID: 2, mode: "ask"}
	tools, err := s.buildToolbox()
	if err != nil {
		t.Fatalf("buildToolbox: %v", err)
	}
	rootOutput, err := tools.execute(ctx, "list_directories", json.RawMessage(`{"path":"/"}`))
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	var root listDirectoriesResponse
	if err := json.Unmarshal([]byte(rootOutput), &root); err != nil {
		t.Fatalf("decode root: %v", err)
	}
	assertDirectoryEntry(t, root.Entries, "directory", "Projects")
	assertDirectoryEntry(t, root.Entries, "document", "Root note")
	assertDirectoryEntry(t, root.Entries, "document", "Daily journal")
	nestedOutput, err := tools.execute(ctx, "list_directories", json.RawMessage(`{"path":"Projects/Alpha"}`))
	if err != nil {
		t.Fatalf("list nested: %v", err)
	}
	var nested listDirectoriesResponse
	if err := json.Unmarshal([]byte(nestedOutput), &nested); err != nil {
		t.Fatalf("decode nested: %v", err)
	}
	if nested.Path != "/Projects/Alpha" || nested.ParentPath != "/Projects" {
		t.Fatalf("unexpected nested paths: %#v", nested)
	}
	assertDirectoryEntry(t, nested.Entries, "document", "Roadmap")
	if _, err := tools.execute(ctx, "list_directories", json.RawMessage(`{"path":"/missing"}`)); err == nil {
		t.Fatalf("expected missing path error")
	}
}

func TestMutationTools(t *testing.T) {
	ctx := context.Background()
	svc := newFakeServices()
	s := &session{ctx: ctx, services: svc, workspaceID: 7, userID: 9, mode: "ask"}
	tools, err := s.buildToolbox()
	if err != nil {
		t.Fatalf("buildToolbox: %v", err)
	}
	createdOutput, err := tools.execute(ctx, "create_document", json.RawMessage(`{"title":"Created by AI","content":"first line\nsecond line"}`))
	if err != nil {
		t.Fatalf("create_document: %v", err)
	}
	var created mutateBlockResponse
	if err := json.Unmarshal([]byte(createdOutput), &created); err != nil {
		t.Fatalf("decode create_document: %v", err)
	}
	if !created.Applied || created.DocumentID == 0 || svc.createdDocumentTitle != "Created by AI" {
		t.Fatalf("unexpected create_document result: %#v", created)
	}
	insertOutput, err := tools.execute(ctx, "insert_block", json.RawMessage([]byte(`{"document_id":42,"after_block_id":5,"text":"inserted"}`)))
	if err != nil {
		t.Fatalf("insert_block: %v", err)
	}
	var inserted mutateBlockResponse
	if err := json.Unmarshal([]byte(insertOutput), &inserted); err != nil {
		t.Fatalf("decode insert_block: %v", err)
	}
	if inserted.DocumentID != 42 || inserted.BlockID == 0 || svc.insertText != "inserted" {
		t.Fatalf("unexpected insert_block result: %#v", inserted)
	}
	moveOutput, err := tools.execute(ctx, "move_block", json.RawMessage([]byte(`{"block_id":`+strconv.FormatInt(inserted.BlockID, 10)+`,"parent_block_id":6}`)))
	if err != nil {
		t.Fatalf("move_block: %v", err)
	}
	var moved mutateBlockResponse
	if err := json.Unmarshal([]byte(moveOutput), &moved); err != nil {
		t.Fatalf("decode move_block: %v", err)
	}
	if moved.BlockID != inserted.BlockID || svc.movedBlockID != inserted.BlockID {
		t.Fatalf("unexpected move_block result: %#v", moved)
	}
}

type fakeServices struct {
	directories          []db.Directory
	documents            []db.Document
	blocks               map[int32][]db.Block
	threadMessages       []db.AiMessage
	todos                []Todo
	recordings           []Recording
	recordingByID        map[int64]Recording
	createdDocumentTitle string
	createdContent       string
	insertText           string
	movedBlockID         int64
	nextDocumentID       int64
	nextBlockID          int64
}

func newFakeServices() *fakeServices {
	return &fakeServices{blocks: map[int32][]db.Block{}, recordingByID: map[int64]Recording{}, nextDocumentID: 100, nextBlockID: 200}
}

func (s *fakeServices) ListThreadMessages(context.Context, int64) ([]db.AiMessage, error) {
	return s.threadMessages, nil
}
func (s *fakeServices) ListWorkspaceDocuments(context.Context, int32) ([]db.Document, error) {
	return s.documents, nil
}
func (s *fakeServices) ListWorkspaceDirectories(context.Context, int32) ([]db.Directory, error) {
	return s.directories, nil
}
func (s *fakeServices) ListDocumentBlocks(_ context.Context, documentID int32) ([]db.Block, error) {
	return append([]db.Block(nil), s.blocks[documentID]...), nil
}
func (s *fakeServices) LoadAuthorizedDocument(_ context.Context, documentID int32, userID int32) (db.Document, []db.Block, error) {
	_ = userID
	for _, doc := range s.documents {
		if doc.ID == documentID {
			return doc, append([]db.Block(nil), s.blocks[documentID]...), nil
		}
	}
	return db.Document{}, nil, errors.New("document not found")
}
func (s *fakeServices) ListTodos(context.Context, int32) ([]Todo, error)    { return s.todos, nil }
func (s *fakeServices) ListRecordings(context.Context) ([]Recording, error) { return s.recordings, nil }
func (s *fakeServices) GetRecording(context.Context, int64) (Recording, error) {
	return Recording{}, errors.New("not found")
}
func (s *fakeServices) CreateSourceRef(context.Context, int64, string, int64, string, string) error {
	return nil
}
func (s *fakeServices) CreateDocument(_ context.Context, _ int32, title string, content string) (int64, error) {
	s.nextDocumentID++
	s.createdDocumentTitle = title
	s.createdContent = content
	return s.nextDocumentID, nil
}
func (s *fakeServices) InsertBlock(_ context.Context, _ int32, documentID int64, _ int64, _ int64, text string) (int64, int64, error) {
	s.nextBlockID++
	s.insertText = text
	return documentID, s.nextBlockID, nil
}
func (s *fakeServices) MoveBlock(_ context.Context, _ int32, blockID int64, _ int64, _ int64) (int64, int64, error) {
	s.movedBlockID = blockID
	return 42, blockID, nil
}

func assertDirectoryEntry(t *testing.T, entries []directoryEntry, entryType string, name string) {
	t.Helper()
	for _, entry := range entries {
		if entry.EntryType == entryType && entry.Name == name {
			return
		}
	}
	t.Fatalf("expected %s entry %q in %#v", entryType, name, entries)
}

func timestamptz(ts time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: ts, Valid: true}
}

func date(year int, month time.Month, day int) pgtype.Date {
	return pgtype.Date{Time: time.Date(year, month, day, 0, 0, 0, 0, time.UTC), Valid: true}
}
