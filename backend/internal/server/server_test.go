package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/gen/secretary/v1/secretaryv1connect"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestRecordingsListAndGet(t *testing.T) {
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

	recordingID := insertRecording(t, ctx, pool)
	defer cleanupRecording(t, ctx, pool, recordingID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)
	token := login(t, ts.URL, email, password)

	// ListRecordings
	// ConnectRPC uses POST by default. URL: /<package>.<Service>/<Method>
	listURL := ts.URL + secretaryv1connect.RecordingsServiceListRecordingsProcedure
	resp, err := authPost(listURL, token, map[string]any{})
	if err != nil {
		t.Fatalf("list recordings: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list recordings status: %d", resp.StatusCode)
	}

	var listPayload secretaryv1.ListRecordingsResponse
	if err := json.NewDecoder(resp.Body).Decode(&listPayload); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	resp.Body.Close()
	found := false
	for _, rec := range listPayload.Recordings {
		if rec.Id == recordingID {
			found = true
			if rec.HasAudio {
				t.Fatalf("expected has_audio false for test recording")
			}
		}
	}
	if !found {
		t.Fatalf("expected recording id %d in list", recordingID)
	}

	// GetRecording
	getURL := ts.URL + secretaryv1connect.RecordingsServiceGetRecordingProcedure
	resp, err = authPost(getURL, token, map[string]any{"id": recordingID})
	if err != nil {
		t.Fatalf("get recording: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get recording status: %d", resp.StatusCode)
	}
	var getPayload secretaryv1.GetRecordingResponse
	if err := json.NewDecoder(resp.Body).Decode(&getPayload); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	resp.Body.Close()
	if getPayload.Recording.Id != recordingID {
		t.Fatalf("expected recording id %d, got %d", recordingID, getPayload.Recording.Id)
	}
}

func TestTodoLifecycle(t *testing.T) {
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

	userID, email, password := insertUser(t, ctx, pool)
	recordingID := insertRecording(t, ctx, pool)
	defer cleanupRecording(t, ctx, pool, recordingID)
	defer cleanupUser(t, ctx, pool, userID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	token := login(t, ts.URL, email, password)

	createReq := secretaryv1.CreateTodoRequest{
		Name:                 "Test todo",
		Desc:                 "Test desc",
		Status:               secretaryv1.TodoStatus_TODO_STATUS_TODO,
		UserId:               userID,
		CreatedAtRecordingId: recordingID,
		UpdatedAtRecordingId: recordingID,
	}
	todo := createTodo(t, ts.URL, token, createReq)
	defer cleanupTodo(t, ctx, pool, todo.Id)

	// ListTodos
	listURL := ts.URL + secretaryv1connect.TodosServiceListTodosProcedure
	listResp, err := authPost(listURL, token, map[string]any{"user_id": userID})
	if err != nil {
		t.Fatalf("list todos: %v", err)
	}
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list todos status: %d", listResp.StatusCode)
	}
	listResp.Body.Close()

	// UpdateTodo
	updateReq := secretaryv1.UpdateTodoRequest{
		Id:                   todo.Id,
		Name:                 "Test todo updated",
		Desc:                 "Updated desc",
		Status:               secretaryv1.TodoStatus_TODO_STATUS_DONE,
		UserId:               userID,
		UpdatedAtRecordingId: recordingID,
	}
	updateURL := ts.URL + secretaryv1connect.TodosServiceUpdateTodoProcedure
	updateResp, err := authPost(updateURL, token, updateReq)
	if err != nil {
		t.Fatalf("update todo: %v", err)
	}
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update todo status: %d", updateResp.StatusCode)
	}
	updateResp.Body.Close()

	// ListTodoHistory
	historyURL := ts.URL + secretaryv1connect.TodosServiceListTodoHistoryProcedure
	historyResp, err := authPost(historyURL, token, map[string]any{"todo_id": todo.Id})
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if historyResp.StatusCode != http.StatusOK {
		t.Fatalf("history status: %d", historyResp.StatusCode)
	}
	var historyPayload secretaryv1.ListTodoHistoryResponse
	if err := json.NewDecoder(historyResp.Body).Decode(&historyPayload); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	historyResp.Body.Close()
	if len(historyPayload.History) < 2 {
		t.Fatalf("expected at least 2 history rows, got %d", len(historyPayload.History))
	}

	// DeleteTodo
	deleteURL := ts.URL + secretaryv1connect.TodosServiceDeleteTodoProcedure
	deleteResp, err := authPost(deleteURL, token, map[string]any{"id": todo.Id})
	if err != nil {
		t.Fatalf("delete todo: %v", err)
	}
	if deleteResp.StatusCode != http.StatusOK { // Connect returns 200 OK for empty responses usually, not 204
		t.Fatalf("delete todo status: %d", deleteResp.StatusCode)
	}
	deleteResp.Body.Close()
}

func TestWorkspaceDocumentPersistenceFlow(t *testing.T) {
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

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	token := login(t, ts.URL, email, password)

	workspaceURL := ts.URL + secretaryv1connect.WorkspacesServiceCreateWorkspaceProcedure
	workspaceResp, err := authPost(workspaceURL, token, secretaryv1.CreateWorkspaceRequest{Name: "Native Sync"})
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

	var linkedNoteID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO document (workspace_id, kind, title)
		VALUES ($1, 'note', $2)
		RETURNING id
	`, workspaceID, "Linked note").Scan(&linkedNoteID)
	if err != nil {
		t.Fatalf("insert linked note: %v", err)
	}

	var linkedJournalID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO document (workspace_id, kind, title, journal_date)
		VALUES ($1, 'journal', $2, $3)
		RETURNING id
	`, workspaceID, "Journal reference", "2026-03-24").Scan(&linkedJournalID)
	if err != nil {
		t.Fatalf("insert linked journal: %v", err)
	}

	var replacementLinkedNoteID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO document (workspace_id, kind, title)
		VALUES ($1, 'note', $2)
		RETURNING id
	`, workspaceID, "Replacement note").Scan(&replacementLinkedNoteID)
	if err != nil {
		t.Fatalf("insert replacement linked note: %v", err)
	}

	var directoryID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO directory (workspace_id, name, position)
		VALUES ($1, $2, $3)
		RETURNING id
	`, workspaceID, "Projects", 1).Scan(&directoryID)
	if err != nil {
		t.Fatalf("insert directory: %v", err)
	}

	saveURL := ts.URL + secretaryv1connect.DocumentsServiceSaveDocumentProcedure
	createResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{
		Document: &secretaryv1.Document{
			ClientKey:   "note-local-1",
			WorkspaceId: workspaceID,
			DirectoryId: directoryID,
			Kind:        "note",
			Title:       "Persistence flow",
			Blocks: []*secretaryv1.Block{
				{ClientKey: "block-a", SortOrder: 1, Text: fmt.Sprintf("Top level [[doc:%d|Linked note]] [[doc:%d|Journal reference]]", linkedNoteID, linkedJournalID)},
				{ClientKey: "block-b", ParentClientKey: "block-a", SortOrder: 2, Text: "Nested", TodoStatus: "todo"},
			},
		},
	})
	if err != nil {
		t.Fatalf("save document: %v", err)
	}
	if createResp.StatusCode != http.StatusOK {
		t.Fatalf("save document status: %d", createResp.StatusCode)
	}
	var createPayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(createResp.Body, &createPayload); err != nil {
		t.Fatalf("decode save document: %v", err)
	}
	createResp.Body.Close()
	if createPayload.Document == nil || createPayload.Document.Id == 0 {
		t.Fatalf("expected saved document id")
	}
	if createPayload.Document.DirectoryId != directoryID {
		t.Fatalf("expected saved directory %d, got %d", directoryID, createPayload.Document.DirectoryId)
	}
	if len(createPayload.Document.Blocks) != 2 {
		t.Fatalf("expected 2 saved blocks, got %d", len(createPayload.Document.Blocks))
	}
	if createPayload.Document.Blocks[1].ParentBlockId != createPayload.Document.Blocks[0].Id {
		t.Fatalf("expected nested block parent to be persisted")
	}
	if createPayload.Document.Blocks[0].TodoId != 0 {
		t.Fatalf("expected note block to have no todo, got %d", createPayload.Document.Blocks[0].TodoId)
	}
	var initialLinkedTargets []int64
	rows, err := pool.Query(ctx, `
		SELECT target_document_id
		FROM block_document_link
		WHERE block_id = $1
		ORDER BY target_document_id
	`, createPayload.Document.Blocks[0].Id)
	if err != nil {
		t.Fatalf("list initial block document links: %v", err)
	}
	for rows.Next() {
		var targetID int64
		if err := rows.Scan(&targetID); err != nil {
			rows.Close()
			t.Fatalf("scan initial block document link: %v", err)
		}
		initialLinkedTargets = append(initialLinkedTargets, targetID)
	}
	rows.Close()
	if len(initialLinkedTargets) != 2 || initialLinkedTargets[0] != linkedNoteID || initialLinkedTargets[1] != linkedJournalID {
		t.Fatalf("expected initial links [%d %d], got %v", linkedNoteID, linkedJournalID, initialLinkedTargets)
	}
	if createPayload.Document.Blocks[1].TodoId == 0 {
		t.Fatalf("expected task block to create canonical todo")
	}
	var sourceKind string
	var sourceDocumentID, sourceBlockID int64
	var todoStatus string
	err = pool.QueryRow(ctx, `
		SELECT source_kind, source_document_id, source_block_id, status
		FROM todo
		WHERE id = $1
	`, createPayload.Document.Blocks[1].TodoId).Scan(&sourceKind, &sourceDocumentID, &sourceBlockID, &todoStatus)
	if err != nil {
		t.Fatalf("load block todo: %v", err)
	}
	if sourceKind != "block" {
		t.Fatalf("expected block source kind, got %q", sourceKind)
	}
	if sourceDocumentID != createPayload.Document.Id {
		t.Fatalf("expected source document %d, got %d", createPayload.Document.Id, sourceDocumentID)
	}
	if sourceBlockID != createPayload.Document.Blocks[1].Id {
		t.Fatalf("expected source block %d, got %d", createPayload.Document.Blocks[1].Id, sourceBlockID)
	}
	if todoStatus != "todo" {
		t.Fatalf("expected new task todo status todo, got %q", todoStatus)
	}
	removedTodoID := createPayload.Document.Blocks[1].TodoId

	updatedResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{
		Document: &secretaryv1.Document{
			Id:          createPayload.Document.Id,
			ClientKey:   createPayload.Document.ClientKey,
			WorkspaceId: workspaceID,
			DirectoryId: directoryID,
			Kind:        "note",
			Title:       "Persistence flow updated",
			Blocks: []*secretaryv1.Block{
				{
					Id:         createPayload.Document.Blocks[0].Id,
					ClientKey:  createPayload.Document.Blocks[0].ClientKey,
					SortOrder:  1,
					Text:       fmt.Sprintf("Top level updated [[doc:%d|Replacement note]]", replacementLinkedNoteID),
					TodoStatus: "doing",
				},
				{
					ClientKey:  "block-c",
					SortOrder:  2,
					Text:       "Fresh second block",
					TodoStatus: "done",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("update document: %v", err)
	}
	if updatedResp.StatusCode != http.StatusOK {
		t.Fatalf("update document status: %d", updatedResp.StatusCode)
	}
	var updatedPayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(updatedResp.Body, &updatedPayload); err != nil {
		t.Fatalf("decode updated document: %v", err)
	}
	updatedResp.Body.Close()
	if len(updatedPayload.Document.Blocks) != 2 {
		t.Fatalf("expected 2 blocks after reconcile, got %d", len(updatedPayload.Document.Blocks))
	}
	if updatedPayload.Document.Blocks[0].Text != "Top level updated" {
		t.Fatalf("expected updated text, got %q", updatedPayload.Document.Blocks[0].Text)
	}
	if updatedPayload.Document.Blocks[0].TodoId == 0 || updatedPayload.Document.Blocks[1].TodoId == 0 {
		t.Fatalf("expected task blocks to own canonical todos after update")
	}
	var updatedLinkCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM block_document_link WHERE target_document_id = $1`, replacementLinkedNoteID).Scan(&updatedLinkCount)
	if err != nil {
		t.Fatalf("count updated block document links: %v", err)
	}
	if updatedLinkCount != 1 {
		t.Fatalf("expected replacement linked note to have 1 block link, found %d", updatedLinkCount)
	}
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM block_document_link WHERE target_document_id = $1`, linkedNoteID).Scan(&updatedLinkCount)
	if err != nil {
		t.Fatalf("count removed linked note references: %v", err)
	}
	if updatedLinkCount != 0 {
		t.Fatalf("expected linked note references to be removed, found %d", updatedLinkCount)
	}
	var removedTodoCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM todo WHERE id = $1`, removedTodoID).Scan(&removedTodoCount)
	if err != nil {
		t.Fatalf("count removed todo: %v", err)
	}
	if removedTodoCount != 0 {
		t.Fatalf("expected removed block todo to be deleted, found %d rows", removedTodoCount)
	}
	var topTodoStatus string
	err = pool.QueryRow(ctx, `SELECT status FROM todo WHERE id = $1`, updatedPayload.Document.Blocks[0].TodoId).Scan(&topTodoStatus)
	if err != nil {
		t.Fatalf("load updated top todo: %v", err)
	}
	if topTodoStatus != "doing" {
		t.Fatalf("expected doing block to map to doing, got %q", topTodoStatus)
	}
	topTodoID := updatedPayload.Document.Blocks[0].TodoId

	revertResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{
		Document: &secretaryv1.Document{
			Id:          updatedPayload.Document.Id,
			ClientKey:   updatedPayload.Document.ClientKey,
			WorkspaceId: workspaceID,
			DirectoryId: directoryID,
			Kind:        "note",
			Title:       "Persistence flow reverted",
			Blocks: []*secretaryv1.Block{
				{
					Id:        updatedPayload.Document.Blocks[0].Id,
					ClientKey: updatedPayload.Document.Blocks[0].ClientKey,
					SortOrder: 1,
					Text:      "Top level reverted to note",
				},
				{
					Id:         updatedPayload.Document.Blocks[1].Id,
					ClientKey:  updatedPayload.Document.Blocks[1].ClientKey,
					SortOrder:  2,
					Text:       "Fresh second block",
					TodoStatus: "done",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("revert document: %v", err)
	}
	if revertResp.StatusCode != http.StatusOK {
		t.Fatalf("revert document status: %d", revertResp.StatusCode)
	}
	var revertPayload secretaryv1.SaveDocumentResponse
	if err := decodeProtoBody(revertResp.Body, &revertPayload); err != nil {
		t.Fatalf("decode reverted document: %v", err)
	}
	revertResp.Body.Close()
	if revertPayload.Document.Blocks[0].TodoId != 0 {
		t.Fatalf("expected reverted note block to drop todo, got %d", revertPayload.Document.Blocks[0].TodoId)
	}
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM todo WHERE id = $1`, topTodoID).Scan(&removedTodoCount)
	if err != nil {
		t.Fatalf("count reverted todo: %v", err)
	}
	if removedTodoCount != 0 {
		t.Fatalf("expected reverted note todo to be deleted, found %d rows", removedTodoCount)
	}

	listURL := ts.URL + secretaryv1connect.DocumentsServiceListDocumentsProcedure
	listResp, err := authPost(listURL, token, secretaryv1.ListDocumentsRequest{WorkspaceId: workspaceID})
	if err != nil {
		t.Fatalf("list documents: %v", err)
	}
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list documents status: %d", listResp.StatusCode)
	}
	var listPayload secretaryv1.ListDocumentsResponse
	if err := decodeProtoBody(listResp.Body, &listPayload); err != nil {
		t.Fatalf("decode list documents: %v", err)
	}
	listResp.Body.Close()
	if len(listPayload.Documents) != 1 {
		t.Fatalf("expected 1 document, got %d", len(listPayload.Documents))
	}
	if len(listPayload.Directories) != 1 {
		t.Fatalf("expected 1 directory, got %d", len(listPayload.Directories))
	}
	if listPayload.Documents[0].Title != "Persistence flow reverted" {
		t.Fatalf("expected updated title, got %q", listPayload.Documents[0].Title)
	}
	if listPayload.Documents[0].DirectoryId != directoryID {
		t.Fatalf("expected list response directory %d, got %d", directoryID, listPayload.Documents[0].DirectoryId)
	}
	if len(listPayload.Documents[0].Blocks) != 2 {
		t.Fatalf("expected 2 blocks from list, got %d", len(listPayload.Documents[0].Blocks))
	}
	if listPayload.Documents[0].Blocks[0].TodoId != 0 {
		t.Fatalf("expected list response to reflect removed todo link")
	}

	deleteURL := ts.URL + secretaryv1connect.DocumentsServiceDeleteDocumentProcedure
	deleteResp, err := authPost(deleteURL, token, secretaryv1.DeleteDocumentRequest{Id: createPayload.Document.Id})
	if err != nil {
		t.Fatalf("delete document: %v", err)
	}
	if deleteResp.StatusCode != http.StatusOK {
		t.Fatalf("delete document status: %d", deleteResp.StatusCode)
	}
	deleteResp.Body.Close()

	var deletedDocumentCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM document WHERE id = $1`, createPayload.Document.Id).Scan(&deletedDocumentCount)
	if err != nil {
		t.Fatalf("count deleted document: %v", err)
	}
	if deletedDocumentCount != 0 {
		t.Fatalf("expected deleted document to be removed, found %d rows", deletedDocumentCount)
	}

	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM todo WHERE source_document_id = $1`, createPayload.Document.Id).Scan(&removedTodoCount)
	if err != nil {
		t.Fatalf("count deleted document todos: %v", err)
	}
	if removedTodoCount != 0 {
		t.Fatalf("expected deleted document todos to be removed, found %d rows", removedTodoCount)
	}

	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM block_document_link WHERE target_document_id = $1`, replacementLinkedNoteID).Scan(&updatedLinkCount)
	if err != nil {
		t.Fatalf("count deleted document links: %v", err)
	}
	if updatedLinkCount != 0 {
		t.Fatalf("expected deleted document links to be removed, found %d rows", updatedLinkCount)
	}
}

func TestDirectoryLifecycle(t *testing.T) {
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

	userID, email, password := insertUser(t, ctx, pool)
	defer cleanupUser(t, ctx, pool, userID)

	srv := New(pool, []byte("test-secret"), 24*time.Hour)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	token := login(t, ts.URL, email, password)
	workspaceURL := ts.URL + secretaryv1connect.WorkspacesServiceCreateWorkspaceProcedure
	workspaceResp, err := authPost(workspaceURL, token, secretaryv1.CreateWorkspaceRequest{Name: "Dirs"})
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

	createDirectoryURL := ts.URL + secretaryv1connect.DocumentsServiceCreateDirectoryProcedure
	createDirectoryResp, err := authPost(createDirectoryURL, token, &secretaryv1.CreateDirectoryRequest{
		WorkspaceId: workspaceID,
		Name:        "Projects",
	})
	if err != nil {
		t.Fatalf("create directory: %v", err)
	}
	if createDirectoryResp.StatusCode != http.StatusOK {
		t.Fatalf("create directory status: %d", createDirectoryResp.StatusCode)
	}
	var createDirectoryPayload secretaryv1.CreateDirectoryResponse
	if err := decodeProtoBody(createDirectoryResp.Body, &createDirectoryPayload); err != nil {
		t.Fatalf("decode directory: %v", err)
	}
	createDirectoryResp.Body.Close()
	if createDirectoryPayload.Directory == nil || createDirectoryPayload.Directory.Id == 0 {
		t.Fatalf("expected created directory id")
	}

	parentDirectoryResp, err := authPost(createDirectoryURL, token, &secretaryv1.CreateDirectoryRequest{
		WorkspaceId: workspaceID,
		Name:        "Archive",
	})
	if err != nil {
		t.Fatalf("create parent directory: %v", err)
	}
	if parentDirectoryResp.StatusCode != http.StatusOK {
		t.Fatalf("create parent directory status: %d", parentDirectoryResp.StatusCode)
	}
	var parentDirectoryPayload secretaryv1.CreateDirectoryResponse
	if err := decodeProtoBody(parentDirectoryResp.Body, &parentDirectoryPayload); err != nil {
		t.Fatalf("decode parent directory: %v", err)
	}
	parentDirectoryResp.Body.Close()

	renameDirectoryURL := ts.URL + secretaryv1connect.DocumentsServiceUpdateDirectoryProcedure
	renameDirectoryResp, err := authPost(renameDirectoryURL, token, &secretaryv1.UpdateDirectoryRequest{
		Id:       createDirectoryPayload.Directory.Id,
		Name:     "Projects renamed",
		ParentId: parentDirectoryPayload.Directory.Id,
	})
	if err != nil {
		t.Fatalf("rename directory: %v", err)
	}
	if renameDirectoryResp.StatusCode != http.StatusOK {
		t.Fatalf("rename directory status: %d", renameDirectoryResp.StatusCode)
	}
	var renameDirectoryPayload secretaryv1.UpdateDirectoryResponse
	if err := decodeProtoBody(renameDirectoryResp.Body, &renameDirectoryPayload); err != nil {
		t.Fatalf("decode renamed directory: %v", err)
	}
	renameDirectoryResp.Body.Close()
	if renameDirectoryPayload.Directory.Name != "Projects renamed" {
		t.Fatalf("expected renamed directory, got %q", renameDirectoryPayload.Directory.Name)
	}
	if renameDirectoryPayload.Directory.ParentId != parentDirectoryPayload.Directory.Id {
		t.Fatalf("expected moved directory parent %d, got %d", parentDirectoryPayload.Directory.Id, renameDirectoryPayload.Directory.ParentId)
	}

	saveURL := ts.URL + secretaryv1connect.DocumentsServiceSaveDocumentProcedure
	saveResp, err := authPost(saveURL, token, &secretaryv1.SaveDocumentRequest{Document: &secretaryv1.Document{
		WorkspaceId: workspaceID,
		DirectoryId: createDirectoryPayload.Directory.Id,
		Kind:        "note",
		Title:       "Inside dir",
		Blocks:      []*secretaryv1.Block{{ClientKey: "block-a", SortOrder: 1, Text: "hello"}},
	}})
	if err != nil {
		t.Fatalf("save document: %v", err)
	}
	if saveResp.StatusCode != http.StatusOK {
		t.Fatalf("save document status: %d", saveResp.StatusCode)
	}
	saveResp.Body.Close()

	deleteDirectoryURL := ts.URL + secretaryv1connect.DocumentsServiceDeleteDirectoryProcedure
	deleteNonEmptyResp, err := authPost(deleteDirectoryURL, token, &secretaryv1.DeleteDirectoryRequest{Id: createDirectoryPayload.Directory.Id})
	if err != nil {
		t.Fatalf("delete non-empty directory: %v", err)
	}
	if deleteNonEmptyResp.StatusCode == http.StatusOK {
		t.Fatalf("expected non-empty directory delete to fail")
	}
	deleteNonEmptyResp.Body.Close()

	var emptyDirectoryID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO directory (workspace_id, name, position)
		VALUES ($1, $2, $3)
		RETURNING id
	`, workspaceID, "Empty", 2).Scan(&emptyDirectoryID)
	if err != nil {
		t.Fatalf("insert empty directory: %v", err)
	}

	deleteEmptyResp, err := authPost(deleteDirectoryURL, token, &secretaryv1.DeleteDirectoryRequest{Id: emptyDirectoryID})
	if err != nil {
		t.Fatalf("delete empty directory: %v", err)
	}
	if deleteEmptyResp.StatusCode != http.StatusOK {
		t.Fatalf("delete empty directory status: %d", deleteEmptyResp.StatusCode)
	}
	deleteEmptyResp.Body.Close()

	var deletedCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM directory WHERE id = $1`, emptyDirectoryID).Scan(&deletedCount)
	if err != nil {
		t.Fatalf("count deleted directory: %v", err)
	}
	if deletedCount != 0 {
		t.Fatalf("expected empty directory to be deleted, found %d rows", deletedCount)
	}
}

func insertUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (int64, string, string) {
	t.Helper()
	var id int64
	email := "test-user-" + strconv.FormatInt(time.Now().UnixNano(), 10) + "@example.com"
	password := "test-password"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	_, _ = pool.Exec(ctx, `
    SELECT setval(
      pg_get_serial_sequence('"user"', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM "user"), 0), 1),
      true
    )
  `)
	err = pool.QueryRow(ctx, `
    INSERT INTO "user" (first_name, last_name, role, email, password_hash)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, "Test", "User", "tester", email, string(hash)).Scan(&id)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id, email, password
}

func insertRecording(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
    INSERT INTO recording (created_at, name, summary, transcript, duration)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, time.Now().UTC(), "Test recording", "Summary", "Transcript", 120).Scan(&id)
	if err != nil {
		t.Fatalf("insert recording: %v", err)
	}
	return id
}

func cleanupTodo(t *testing.T, ctx context.Context, pool *pgxpool.Pool, todoID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM todo_history WHERE todo_id = $1`, todoID)
	_, _ = pool.Exec(ctx, `DELETE FROM todo WHERE id = $1`, todoID)
}

func cleanupRecording(t *testing.T, ctx context.Context, pool *pgxpool.Pool, recordingID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM recording WHERE id = $1`, recordingID)
}

func cleanupUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, userID)
}

func cleanupWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID int64) {
	t.Helper()
	_, _ = pool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, workspaceID)
}

func createTodo(t *testing.T, baseURL string, token string, req secretaryv1.CreateTodoRequest) *secretaryv1.Todo {
	t.Helper()
	createURL := baseURL + secretaryv1connect.TodosServiceCreateTodoProcedure
	resp, err := authPost(createURL, token, req)
	if err != nil {
		t.Fatalf("create todo: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create todo status: %d", resp.StatusCode)
	}
	var payload secretaryv1.CreateTodoResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	resp.Body.Close()
	return payload.Todo
}

func authPost(url string, token string, body any) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	return http.DefaultClient.Do(req)
}

func login(t *testing.T, baseURL, email, password string) string {
	t.Helper()
	body, _ := json.Marshal(LoginRequest{Email: email, Password: password})
	resp, err := http.Post(baseURL+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status: %d", resp.StatusCode)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	resp.Body.Close()
	if payload.Token == "" {
		t.Fatalf("missing token")
	}
	return payload.Token
}

func decodeProtoBody(body io.ReadCloser, target proto.Message) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	return protojson.Unmarshal(data, target)
}
