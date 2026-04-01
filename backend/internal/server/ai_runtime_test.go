package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	secretaryv1connect "github.com/mvult/secretary/backend/gen/secretary/v1/secretaryv1connect"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func TestWorkspaceSkillsFromAIDirectory(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)
	token := login(t, ts.URL, email, password)

	workspaceResp, err := authPost(ts.URL+secretaryv1connect.WorkspacesServiceCreateWorkspaceProcedure, token, &secretaryv1.CreateWorkspaceRequest{Name: "AI skills workspace"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if workspaceResp.StatusCode != http.StatusOK {
		t.Fatalf("create workspace status: %d", workspaceResp.StatusCode)
	}
	var workspacePayload secretaryv1.CreateWorkspaceResponse
	if err := decodeProtoBody(workspaceResp.Body, &workspacePayload); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	workspaceResp.Body.Close()
	workspaceID := workspacePayload.Workspace.Id
	defer cleanupWorkspace(t, ctx, pool, workspaceID)

	aiDirectory, err := srv.queries.CreateDirectory(ctx, dbCreateDirectoryParams(workspaceID, agentDirectoryName, 0))
	if err != nil {
		t.Fatalf("create AI directory: %v", err)
	}
	skillsDirectory, err := srv.queries.CreateDirectory(ctx, dbCreateDirectoryParams(workspaceID, agentSkillsDirectory, int64(aiDirectory.ID)))
	if err != nil {
		t.Fatalf("create skills directory: %v", err)
	}

	frontmatter := strings.Join([]string{
		"---",
		"name: atlas-migrations",
		"description: Atlas workflow for backend schema changes",
		"metadata:",
		"  scope: backend",
		"  tags:",
		"    - atlas",
		"    - postgres",
		"---",
	}, "\n")
	saveResp, err := authPost(ts.URL+secretaryv1connect.DocumentsServiceSaveDocumentProcedure, token, &secretaryv1.SaveDocumentRequest{Document: &secretaryv1.Document{
		ClientKey:   "skill-doc",
		WorkspaceId: workspaceID,
		DirectoryId: int64(skillsDirectory.ID),
		Kind:        "note",
		Title:       "Atlas migrations",
		Blocks: []*secretaryv1.Block{
			{ClientKey: "block-frontmatter", SortOrder: 0, Text: frontmatter},
			{ClientKey: "block-body", SortOrder: 1, Text: "Use this whenever backend/sql/schema.sql changes."},
		},
	}})
	if err != nil {
		t.Fatalf("save skill document: %v", err)
	}
	if saveResp.StatusCode != http.StatusOK {
		t.Fatalf("save skill document status: %d", saveResp.StatusCode)
	}
	var savePayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(saveResp.Body, &savePayload); err != nil {
		t.Fatalf("decode save skill document: %v", err)
	}
	saveResp.Body.Close()

	ignoredResp, err := authPost(ts.URL+secretaryv1connect.DocumentsServiceSaveDocumentProcedure, token, &secretaryv1.SaveDocumentRequest{Document: &secretaryv1.Document{
		ClientKey:   "ignored-doc",
		WorkspaceId: workspaceID,
		DirectoryId: int64(aiDirectory.ID),
		Kind:        "note",
		Title:       "Not a skill",
		Blocks:      []*secretaryv1.Block{{ClientKey: "ignored-block", SortOrder: 0, Text: "plain note"}},
	}})
	if err != nil {
		t.Fatalf("save ignored document: %v", err)
	}
	if ignoredResp.StatusCode != http.StatusOK {
		t.Fatalf("save ignored document status: %d", ignoredResp.StatusCode)
	}
	ignoredResp.Body.Close()

	env := &aiToolEnv{ctx: ctx, server: srv, workspaceID: int32(workspaceID), userID: int32(userID), runID: 1}
	skills, err := env.loadWorkspaceSkills()
	if err != nil {
		t.Fatalf("load workspace skills: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(skills))
	}
	if skills[0].DocumentID != savePayload.Document.Id {
		t.Fatalf("expected document-backed skill %d, got %d", savePayload.Document.Id, skills[0].DocumentID)
	}
	if skills[0].Name != "atlas-migrations" {
		t.Fatalf("unexpected skill name: %q", skills[0].Name)
	}
	if skills[0].Description != "Atlas workflow for backend schema changes" {
		t.Fatalf("unexpected skill description: %q", skills[0].Description)
	}
	if skills[0].Metadata["scope"] != "backend" {
		t.Fatalf("unexpected skill metadata: %#v", skills[0].Metadata)
	}
	if !strings.Contains(skills[0].Content, "Use this whenever backend/sql/schema.sql changes.") {
		t.Fatalf("expected full document content, got %q", skills[0].Content)
	}

	env.skills = skills
	toolsByName, _, err := env.buildTools()
	if err != nil {
		t.Fatalf("build tools: %v", err)
	}
	if _, ok := toolsByName["create_document"]; !ok {
		t.Fatalf("create_document should be exposed")
	}
	if _, ok := toolsByName["rewrite_document"]; ok {
		t.Fatalf("rewrite_document should not be exposed")
	}
	if _, ok := toolsByName["append_document"]; ok {
		t.Fatalf("append_document should not be exposed")
	}
	if _, ok := toolsByName["insert_block"]; !ok {
		t.Fatalf("insert_block should be exposed")
	}
	if _, ok := toolsByName["move_block"]; !ok {
		t.Fatalf("move_block should be exposed")
	}

	listOutput, err := toolsByName["list_skills"].Execute(ctx, json.RawMessage(`{}`))
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

	getOutput, err := toolsByName["get_skill"].Execute(ctx, json.RawMessage(`{"name":"atlas-migrations"}`))
	if err != nil {
		t.Fatalf("get_skill: %v", err)
	}
	var loaded getSkillResponse
	if err := json.Unmarshal([]byte(getOutput), &loaded); err != nil {
		t.Fatalf("decode get_skill: %v", err)
	}
	if loaded.DocumentID != savePayload.Document.Id {
		t.Fatalf("unexpected loaded document id: %d", loaded.DocumentID)
	}
	if !strings.Contains(loaded.Content, "Use this whenever backend/sql/schema.sql changes.") {
		t.Fatalf("expected get_skill to return full document content, got %q", loaded.Content)
	}
	if loaded.Metadata["scope"] != "backend" {
		t.Fatalf("unexpected loaded metadata: %#v", loaded.Metadata)
	}
	if loaded.Title != "Atlas migrations" {
		t.Fatalf("unexpected loaded title: %q", loaded.Title)
	}
}

func TestInsertAndMoveBlockTools(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)
	token := login(t, ts.URL, email, password)

	workspaceResp, err := authPost(ts.URL+secretaryv1connect.WorkspacesServiceCreateWorkspaceProcedure, token, &secretaryv1.CreateWorkspaceRequest{Name: "AI block tools workspace"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if workspaceResp.StatusCode != http.StatusOK {
		t.Fatalf("create workspace status: %d", workspaceResp.StatusCode)
	}
	var workspacePayload secretaryv1.CreateWorkspaceResponse
	if err := decodeProtoBody(workspaceResp.Body, &workspacePayload); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	workspaceResp.Body.Close()
	workspaceID := workspacePayload.Workspace.Id
	defer cleanupWorkspace(t, ctx, pool, workspaceID)

	saveResp, err := authPost(ts.URL+secretaryv1connect.DocumentsServiceSaveDocumentProcedure, token, &secretaryv1.SaveDocumentRequest{Document: &secretaryv1.Document{
		ClientKey:   "doc-1",
		WorkspaceId: workspaceID,
		Kind:        "note",
		Title:       "Mutable note",
		Blocks: []*secretaryv1.Block{
			{ClientKey: "root-1", SortOrder: 1, Text: "root one"},
			{ClientKey: "root-2", SortOrder: 2, Text: "root two"},
		},
	}})
	if err != nil {
		t.Fatalf("save document: %v", err)
	}
	if saveResp.StatusCode != http.StatusOK {
		t.Fatalf("save document status: %d", saveResp.StatusCode)
	}
	var savePayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(saveResp.Body, &savePayload); err != nil {
		t.Fatalf("decode save document: %v", err)
	}
	saveResp.Body.Close()
	doc := savePayload.Document

	env := &aiToolEnv{ctx: ctx, server: srv, workspaceID: int32(workspaceID), userID: int32(userID), runID: 1, mode: "ask"}
	created, err := env.createDocument(ctx, createDocumentRequest{Title: "Created by AI", Content: "first line\nsecond line"})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if !created.Applied || created.DocumentID == 0 {
		t.Fatalf("unexpected create document response: %#v", created)
	}
	createdDoc, createdBlocks, err := srv.loadAuthorizedDocument(ctx, int32(created.DocumentID), int32(userID))
	if err != nil {
		t.Fatalf("load created document: %v", err)
	}
	if createdDoc.Title != "Created by AI" || len(createdBlocks) != 2 {
		t.Fatalf("unexpected created document: title=%q blocks=%d", createdDoc.Title, len(createdBlocks))
	}

	inserted, err := env.insertBlock(ctx, insertBlockRequest{DocumentID: doc.Id, AfterBlockID: doc.Blocks[0].Id, Text: "inserted"})
	if err != nil {
		t.Fatalf("insert block: %v", err)
	}
	if !inserted.Applied || inserted.BlockID == 0 {
		t.Fatalf("unexpected insert response: %#v", inserted)
	}

	updatedDoc, updatedBlocks, err := srv.loadAuthorizedDocument(ctx, int32(doc.Id), int32(userID))
	if err != nil {
		t.Fatalf("reload document after insert: %v", err)
	}
	if updatedDoc.ID == 0 || len(updatedBlocks) != 3 {
		t.Fatalf("expected 3 blocks after insert, got %d", len(updatedBlocks))
	}
	ordered := renderDocumentOutline(updatedDoc, updatedBlocks)
	if !strings.Contains(ordered, "- root one\n- inserted\n- root two") {
		t.Fatalf("unexpected outline after insert: %q", ordered)
	}

	moved, err := env.moveBlock(ctx, moveBlockRequest{BlockID: inserted.BlockID, ParentBlockID: doc.Blocks[1].Id})
	if err != nil {
		t.Fatalf("move block: %v", err)
	}
	if !moved.Applied || moved.BlockID != inserted.BlockID {
		t.Fatalf("unexpected move response: %#v", moved)
	}

	finalDoc, finalBlocks, err := srv.loadAuthorizedDocument(ctx, int32(doc.Id), int32(userID))
	if err != nil {
		t.Fatalf("reload document after move: %v", err)
	}
	if len(finalBlocks) != 3 {
		t.Fatalf("expected 3 blocks after move, got %d", len(finalBlocks))
	}
	finalOutline := renderDocumentOutline(finalDoc, finalBlocks)
	if !strings.Contains(finalOutline, "- root one\n- root two\n  - inserted") {
		t.Fatalf("unexpected outline after move: %q", finalOutline)
	}
}

func dbCreateDirectoryParams(workspaceID int64, name string, parentID int64) db.CreateDirectoryParams {
	params := db.CreateDirectoryParams{WorkspaceID: int32(workspaceID), Name: name}
	if parentID > 0 {
		params.ParentID = pgtype.Int4{Int32: int32(parentID), Valid: true}
	}
	return params
}
