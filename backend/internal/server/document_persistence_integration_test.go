package server

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

// Explicitly opt into a disposable, already-migrated DB. Never falls back to the
// application DATABASE_URL and never applies migrations. CI can require execution.
func persistenceTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("PERSISTENCE_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("REQUIRE_PERSISTENCE_DB_TESTS") == "1" {
			t.Fatal("PERSISTENCE_TEST_DATABASE_URL is required")
		}
		t.Skip("dedicated PERSISTENCE_TEST_DATABASE_URL not configured")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal("invalid persistence test database configuration")
	}
	if app := os.Getenv("DATABASE_URL"); app != "" {
		other, err := pgxpool.ParseConfig(app)
		if err != nil {
			t.Fatal("invalid application database configuration")
		}
		if cfg.ConnConfig.Host == other.ConnConfig.Host && cfg.ConnConfig.Port == other.ConnConfig.Port && cfg.ConnConfig.Database == other.ConnConfig.Database {
			t.Fatal("persistence tests require a separate database from DATABASE_URL")
		}
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("cannot open persistence test database")
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestDocumentPersistenceIntegration(t *testing.T) {
	pool := persistenceTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	s := New(pool, []byte("test-secret"), time.Hour)
	var actor int64
	if err := pool.QueryRow(ctx, `INSERT INTO "user" (first_name,last_name,role,email,password_hash) VALUES ('Persistence','Test','tester',$1,'unused') RETURNING id`, uuid.NewString()+"@example.com").Scan(&actor); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.queries.CreateWorkspace(ctx, "Persistence transaction tests")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.queries.AddWorkspaceUser(ctx, db.AddWorkspaceUserParams{WorkspaceID: workspace.ID, UserID: int32(actor)}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		for _, command := range []struct {
			sql string
			id  any
		}{
			{`DELETE FROM mutation_receipt WHERE scope_kind='workspace' AND scope_id=$1`, workspace.ID},
			{`DELETE FROM workspace WHERE id=$1`, workspace.ID},
			{`DELETE FROM "user" WHERE id=$1`, actor},
		} {
			if _, err := pool.Exec(cleanupCtx, command.sql, command.id); err != nil {
				t.Errorf("fixture cleanup: %v", err)
			}
		}
	})
	newRequest := func() *secretaryv1.SaveDocumentRequest {
		return &secretaryv1.SaveDocumentRequest{ProtocolVersion: 1, MutationId: uuid.NewString(), ExpectedRevision: proto.Int64(0), Document: &secretaryv1.Document{
			WorkspaceId: int64(workspace.ID), ClientKey: uuid.NewString(), Kind: "note", Title: "Original",
			Blocks: []*secretaryv1.Block{{ClientKey: uuid.NewString(), SortOrder: 1, Text: "Parent"}, {ClientKey: uuid.NewString(), SortOrder: 2, Text: "Task", TodoStatus: "todo"}},
		}}
	}
	save := func(t *testing.T, req *secretaryv1.SaveDocumentRequest) *secretaryv1.SaveDocumentResponse {
		t.Helper()
		result, err := s.saveDocumentMutation(ctx, actor, req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	updateRequest := func(doc *secretaryv1.Document) *secretaryv1.SaveDocumentRequest {
		return &secretaryv1.SaveDocumentRequest{ProtocolVersion: 1, MutationId: uuid.NewString(), ExpectedRevision: proto.Int64(doc.Revision), Document: proto.Clone(doc).(*secretaryv1.Document)}
	}
	assertReason := func(t *testing.T, err error, reason secretaryv1.PersistenceErrorReason) {
		t.Helper()
		var ce *connect.Error
		if !errors.As(err, &ce) || len(ce.Details()) != 1 {
			t.Fatalf("expected typed rejection, got %v", err)
		}
		detail, e := ce.Details()[0].Value()
		if e != nil || detail.(*secretaryv1.PersistenceError).Reason != reason {
			t.Fatalf("unexpected error detail: %v, %v", detail, e)
		}
	}
	t.Run("replay revisions deletion and reserved creation keys", func(t *testing.T) {
		req := newRequest()
		req.Document.Blocks[1].ParentClientKey = req.Document.Blocks[0].ClientKey
		first := save(t, req)
		if first.Document.Revision != 1 || first.Document.ClientKey != req.Document.ClientKey || first.Document.Blocks[1].ParentBlockId != first.Document.Blocks[0].Id {
			t.Fatal("incorrect create identities/revision")
		}
		if replay := save(t, req); !proto.Equal(first, replay) {
			t.Fatal("lost-response retry changed acknowledgment")
		}
		edit := updateRequest(first.Document)
		edit.Document.Title = "Edited"
		second := save(t, edit)
		if second.Document.Revision != 2 {
			t.Fatal("update must advance revision once")
		}
		_, err := s.saveDocumentMutation(ctx, actor, updateRequest(first.Document))
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_REVISION_CONFLICT)
		changed := proto.Clone(req).(*secretaryv1.SaveDocumentRequest)
		changed.Document.Title = "Different payload"
		_, err = s.saveDocumentMutation(ctx, actor, changed)
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_MUTATION_ID_REUSED)
		deletion := &secretaryv1.DeleteDocumentRequest{Id: second.Document.Id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(), ExpectedRevision: proto.Int64(2)}
		deleted, err := s.deleteDocumentMutation(ctx, actor, deletion)
		if err != nil {
			t.Fatal(err)
		}
		replayedDelete, err := s.deleteDocumentMutation(ctx, actor, deletion)
		if err != nil || !proto.Equal(deleted, replayedDelete) {
			t.Fatalf("delete replay: %v", err)
		}
		if replay := save(t, req); !proto.Equal(first, replay) {
			t.Fatal("replay after deletion changed old acknowledgment")
		}
		if _, err := s.queries.GetDocument(ctx, int32(first.Document.Id)); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("replay resurrected document")
		}
		req.MutationId = uuid.NewString()
		_, err = s.saveDocumentMutation(ctx, actor, req)
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_CREATION_KEY_EXISTS)
		_, err = s.saveDocumentMutation(ctx, actor, updateRequest(second.Document))
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_DOCUMENT_DELETED)
	})
	t.Run("concurrent exact retries and stale saves", func(t *testing.T) {
		req := newRequest()
		results := make([]*secretaryv1.SaveDocumentResponse, 2)
		errs := make([]error, 2)
		run := func(requests []*secretaryv1.SaveDocumentRequest) {
			var wg sync.WaitGroup
			start := make(chan struct{})
			for i := range requests {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					results[i], errs[i] = s.saveDocumentMutation(ctx, actor, requests[i])
				}(i)
			}
			close(start)
			wg.Wait()
		}
		run([]*secretaryv1.SaveDocumentRequest{req, proto.Clone(req).(*secretaryv1.SaveDocumentRequest)})
		if errs[0] != nil || errs[1] != nil || !proto.Equal(results[0], results[1]) {
			t.Fatalf("concurrent receipt replay: %v", errs)
		}
		a, b := updateRequest(results[0].Document), updateRequest(results[0].Document)
		a.Document.Title, b.Document.Title = "A", "B"
		run([]*secretaryv1.SaveDocumentRequest{a, b})
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Fatalf("expected exactly one stale-write rejection: %v", errs)
		}
		for _, err := range errs {
			if err != nil {
				assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_REVISION_CONFLICT)
			}
		}
	})
	t.Run("journal create never replaces existing content", func(t *testing.T) {
		a, b := newRequest(), newRequest()
		a.Document.Kind, b.Document.Kind = "journal", "journal"
		a.Document.JournalDate, b.Document.JournalDate = "2026-09-24", "2026-09-24"
		first := save(t, a)
		b.Document.Blocks[0].Text = "Must not overwrite"
		existing := save(t, b)
		if existing.Outcome != secretaryv1.DocumentSaveOutcome_DOCUMENT_SAVE_OUTCOME_EXISTING_JOURNAL || !proto.Equal(first.Document, existing.Document) {
			t.Fatal("create replaced an existing journal")
		}
		if !proto.Equal(existing, save(t, b)) {
			t.Fatal("existing-journal receipt changed")
		}
	})
	t.Run("partial block TODO and link writes roll back", func(t *testing.T) {
		original := save(t, newRequest())
		bad := updateRequest(original.Document)
		bad.Document.Title = "Must roll back"
		bad.Document.Blocks[1].Text = "Changed task [[doc:2147483647|missing]]"
		if _, err := s.saveDocumentMutation(ctx, actor, bad); err == nil {
			t.Fatal("invalid document link was accepted")
		}
		row, err := s.queries.GetDocument(ctx, int32(original.Document.Id))
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err := s.loadDocumentSnapshot(ctx, s.queries, row, true)
		if err != nil || !proto.Equal(original.Document, snapshot) {
			t.Fatalf("failed transaction leaked content/revision changes: %v", err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM mutation_receipt WHERE actor_user_id=$1 AND mutation_id=$2::uuid`, actor, bad.MutationId).Scan(&count); err != nil || count != 0 {
			t.Fatalf("failed transaction left receipt: %d %v", count, err)
		}
		todo, err := s.queries.GetTodo(ctx, int32(original.Document.Blocks[1].TodoId))
		if err != nil || todo.Name != "Task" {
			t.Fatalf("failed transaction changed TODO: %v", err)
		}
		// A snapshot cannot delete a shared canonical TODO through one row and
		// silently recreate it (losing its metadata) through another retained row.
		if _, err := pool.Exec(ctx, `UPDATE block SET todo_id=$1 WHERE id=$2`, todo.ID, original.Document.Blocks[0].Id); err != nil {
			t.Fatal(err)
		}
		snapshot, err = s.loadDocumentSnapshot(ctx, s.queries, row, true)
		if err != nil {
			t.Fatal(err)
		}
		ambiguous := updateRequest(snapshot)
		ambiguous.Document.Blocks[0].TodoStatus = ""
		_, err = s.saveDocumentMutation(ctx, actor, ambiguous)
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_TREE)
		if _, err := s.queries.GetTodo(ctx, todo.ID); err != nil {
			t.Fatalf("rejected snapshot deleted canonical TODO: %v", err)
		}
	})
	t.Run("TODO metadata survives unrelated snapshot edits", func(t *testing.T) {
		original := save(t, newRequest())
		todoID := original.Document.Blocks[1].TodoId
		if _, err := pool.Exec(ctx, `UPDATE todo SET name='Standalone rename', "desc"='Keep description', user_id=NULL, bucket='on_deck', priority_rank=123 WHERE id=$1`, todoID); err != nil {
			t.Fatal(err)
		}
		edit := updateRequest(original.Document)
		edit.Document.Title = "Unrelated title edit"
		updated := save(t, edit)
		todo, err := s.queries.GetTodo(ctx, int32(todoID))
		if err != nil || todo.Name != "Standalone rename" || todo.Desc.String != "Keep description" || todo.UserID.Valid || todo.Bucket.String != "on_deck" {
			t.Fatalf("TODO-owned fields overwritten: %v", err)
		}
		edit = updateRequest(updated.Document)
		edit.Document.Blocks[1].Text = "Explicit inline rename"
		edit.Document.Blocks[1].TodoStatus = "done"
		save(t, edit)
		todo, err = s.queries.GetTodo(ctx, int32(todoID))
		if err != nil || todo.Name != "Explicit inline rename" || todo.Desc.String != "Keep description" || todo.UserID.Valid || !todo.CompletedAt.Valid {
			t.Fatalf("inline update lost metadata/completion: %v", err)
		}
	})
	t.Run("source deletion advances surviving linked document", func(t *testing.T) {
		source := save(t, newRequest())
		destination := save(t, newRequest())
		todoID := source.Document.Blocks[1].TodoId
		if _, err := pool.Exec(ctx, `UPDATE block SET todo_id=$1 WHERE id=$2`, todoID, destination.Document.Blocks[0].Id); err != nil {
			t.Fatal(err)
		}
		deletion := &secretaryv1.DeleteDocumentRequest{Id: source.Document.Id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(), ExpectedRevision: proto.Int64(source.Document.Revision)}
		result, err := s.deleteDocumentMutation(ctx, actor, deletion)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, effect := range result.Effects.UpdatedDocuments {
			if effect.DocumentId == destination.Document.Id && effect.Revision == 2 {
				found = true
			}
		}
		if !found {
			t.Fatal("cascade did not advance surviving document")
		}
		_, err = s.saveDocumentMutation(ctx, actor, updateRequest(destination.Document))
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_REVISION_CONFLICT)
	})
	t.Run("receipt insertion failure rolls back domain writes", func(t *testing.T) {
		reserved := newRequest()
		save(t, reserved)
		key := uuid.NewString()
		id := uuid.New()
		op := documentMutation{actor: int32(actor), workspace: workspace.ID, mutation: pgtype.UUID{Bytes: id, Valid: true}, name: "document.save"}
		response := &secretaryv1.SaveDocumentResponse{}
		err := s.runDocumentMutation(ctx, op, response, func(_ pgx.Tx, q *db.Queries, _ []db.Document) (string, error) {
			doc, err := q.CreateDocumentWithClientKey(ctx, db.CreateDocumentWithClientKeyParams{WorkspaceID: workspace.ID, Kind: "note", Title: "Must roll back", ClientKey: key})
			response.Document = &secretaryv1.Document{Id: int64(doc.ID)}
			// Deliberately collide with a retained receipt after the domain insert.
			return reserved.Document.ClientKey, err
		})
		if err == nil {
			t.Fatal("expected receipt uniqueness failure")
		}
		if _, err := s.queries.GetDocumentByClientKey(ctx, db.GetDocumentByClientKeyParams{WorkspaceID: workspace.ID, ClientKey: key}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("failed receipt left a committed document")
		}
	})
	t.Run("repeatable read keeps body and revision coherent", func(t *testing.T) {
		original := save(t, newRequest())
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		q := s.queries.WithTx(tx)
		doc, err := q.GetDocument(ctx, int32(original.Document.Id))
		if err != nil {
			t.Fatal(err)
		}
		edit := updateRequest(original.Document)
		edit.Document.Blocks[1].TodoStatus = "done"
		save(t, edit)
		snapshot, err := s.loadDocumentSnapshot(ctx, q, doc, true)
		if err != nil || !proto.Equal(snapshot, original.Document) {
			t.Fatalf("read mixed old revision with new body/TODO state: %v", err)
		}
	})
	t.Run("concurrent journal creates resolve to one unchanged body", func(t *testing.T) {
		a, b := newRequest(), newRequest()
		for _, req := range []*secretaryv1.SaveDocumentRequest{a, b} {
			req.Document.Kind, req.Document.JournalDate = "journal", "2026-09-25"
		}
		b.Document.Blocks[0].Text = "Other user's draft"
		results := make(chan *secretaryv1.SaveDocumentResponse, 2)
		errs := make(chan error, 2)
		start := make(chan struct{})
		for _, req := range []*secretaryv1.SaveDocumentRequest{a, b} {
			go func() {
				<-start
				result, err := s.saveDocumentMutation(ctx, actor, req)
				results <- result
				errs <- err
			}()
		}
		close(start)
		first, second := <-results, <-results
		for range 2 {
			if err := <-errs; err != nil {
				t.Fatal(err)
			}
		}
		if !proto.Equal(first.Document, second.Document) || first.Outcome == second.Outcome {
			t.Fatal("journal creation did not resolve atomically")
		}
	})
	t.Run("completed new TODO has completion context", func(t *testing.T) {
		req := newRequest()
		req.Document.Blocks[1].TodoStatus = "done"
		result := save(t, req)
		todo, err := s.queries.GetTodo(ctx, int32(result.Document.Blocks[1].TodoId))
		if err != nil || !todo.CompletedAt.Valid || todo.CompletedDocumentID.Int32 != int32(result.Document.Id) || todo.CompletedBlockID.Int32 != int32(result.Document.Blocks[1].Id) {
			t.Fatalf("missing initial completion context: %v", err)
		}
	})
	t.Run("replay requires current scope access", func(t *testing.T) {
		authCtx := context.WithValue(ctx, userIdKey, actor)
		contextReq := connect.NewRequest(&secretaryv1.GetTodoCommandContextRequest{WorkspaceId: int64(workspace.ID)})
		before := time.Now().Format(time.DateOnly)
		commandContext, err := s.GetTodoCommandContext(authCtx, contextReq)
		if err != nil {
			t.Fatal(err)
		}
		if date := commandContext.Msg.JournalDate; date != before && date != time.Now().Format(time.DateOnly) {
			t.Fatalf("context date is not server-local today: %s", date)
		}
		req := newRequest()
		saved := save(t, req)
		command := &secretaryv1.MoveDocumentTodosToRepositoryRequest{DocumentId: saved.Document.Id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString()}
		if _, err := s.moveDocumentTodosCommand(ctx, actor, command); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM workspace_user_rel WHERE workspace_id=$1 AND user_id=$2`, workspace.ID, actor); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := s.queries.AddWorkspaceUser(ctx, db.AddWorkspaceUserParams{WorkspaceID: workspace.ID, UserID: int32(actor)}); err != nil {
				t.Error(err)
			}
		}()
		_, err = s.saveDocumentMutation(ctx, actor, req)
		if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("receipt exposed after membership removal: %v", err)
		}
		if _, err := s.moveDocumentTodosCommand(ctx, actor, command); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("command receipt exposed after membership removal: %v", err)
		}
		if _, err := s.GetTodoCommandContext(authCtx, contextReq); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("command context exposed after membership removal: %v", err)
		}
	})

	t.Run("TODO patches merge current fields and duplicate retries advance once", func(t *testing.T) {
		saved := save(t, newRequest())
		id := saved.Document.Blocks[1].TodoId
		metadata := &secretaryv1.UpdateTodoRequest{Id: id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(),
			Patch: &secretaryv1.TodoPatch{Name: proto.String("Latest inline name"), Desc: proto.String("Preserve me"), PriorityRank: proto.Int64(8)}}
		if _, err := s.updateTodoCommand(ctx, actor, metadata); err != nil {
			t.Fatal(err)
		}
		req := &secretaryv1.UpdateTodoRequest{Id: id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(),
			Patch: &secretaryv1.TodoPatch{Status: secretaryv1.TodoStatus_TODO_STATUS_DONE.Enum()}}
		results := make(chan *secretaryv1.UpdateTodoResponse, 2)
		errs := make(chan error, 2)
		for i := 0; i < 2; i++ {
			go func() { result, err := s.updateTodoCommand(ctx, actor, req); results <- result; errs <- err }()
		}
		first, second := <-results, <-results
		for i := 0; i < 2; i++ {
			if err := <-errs; err != nil {
				t.Fatal(err)
			}
		}
		if !proto.Equal(first, second) || first.Todo.Name != "Latest inline name" || first.Todo.Desc != "Preserve me" || first.Todo.PriorityRank != 8 || first.Todo.Bucket != "done" {
			t.Fatalf("incorrect merged/replayed result: %v", first)
		}
		doc, err := s.queries.GetDocument(ctx, int32(saved.Document.Id))
		if err != nil {
			t.Fatal(err)
		}
		if doc.Revision != saved.Document.Revision+2 {
			t.Fatalf("duplicate revision bump: %d", doc.Revision)
		}
		history, err := s.queries.ListTodoHistory(ctx, int32(id))
		if err != nil {
			t.Fatal(err)
		}
		updates := 0
		for _, entry := range history {
			if entry.ChangeType == "update" {
				updates++
			}
		}
		if updates != 2 {
			t.Fatalf("duplicate history: %d", updates)
		}
		metadata.MutationId = uuid.NewString()
		metadata.Patch = &secretaryv1.TodoPatch{Desc: proto.String("")}
		cleared, err := s.updateTodoCommand(ctx, actor, metadata)
		if err != nil {
			t.Fatal(err)
		}
		if cleared.Todo.Desc != "" || cleared.Todo.CompletedAt != first.Todo.CompletedAt || cleared.Todo.CompletedBlockId != first.Todo.CompletedBlockId {
			t.Fatal("metadata patch changed completion state")
		}
		replay, err := s.updateTodoCommand(ctx, actor, req)
		if err != nil || !proto.Equal(replay, first) {
			t.Fatalf("receipt not historical: %v", err)
		}
		if _, err := s.updateTodoCommand(ctx, actor, &secretaryv1.UpdateTodoRequest{Id: id, ProtocolVersion: 1, MutationId: uuid.NewString(), Patch: req.Patch}); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("user scope accepted linked TODO: %v", err)
		}
	})

	t.Run("unlinked TODO update receipts use actor scope", func(t *testing.T) {
		row, err := s.queries.CreateTodo(ctx, db.CreateTodoParams{Name: "Unlinked", UserID: pgtype.Int4{Int32: int32(actor), Valid: true}, Status: pgtype.Text{String: "todo", Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = pool.Exec(ctx, `DELETE FROM mutation_receipt WHERE actor_user_id=$1 AND scope_kind='user'`, actor)
			_ = s.queries.DeleteTodo(ctx, row.ID)
		}()
		req := &secretaryv1.UpdateTodoRequest{Id: int64(row.ID), ProtocolVersion: 1, MutationId: uuid.NewString(), Patch: &secretaryv1.TodoPatch{Desc: proto.String("Owned update")}}
		first, err := s.updateTodoCommand(ctx, actor, req)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.queries.DeleteTodo(ctx, row.ID); err != nil {
			t.Fatal(err)
		}
		replay, err := s.updateTodoCommand(ctx, actor, req)
		if err != nil || !proto.Equal(first, replay) {
			t.Fatalf("deleted TODO receipt replay: %v", err)
		}
	})

	t.Run("concurrent repository retry advances once and replays after deletion", func(t *testing.T) {
		saved := save(t, newRequest())
		req := &secretaryv1.MoveDocumentTodosToRepositoryRequest{DocumentId: saved.Document.Id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString()}
		results := make(chan *secretaryv1.MoveDocumentTodosToRepositoryResponse, 2)
		errs := make(chan error, 2)
		start := make(chan struct{})
		for range 2 {
			go func() {
				<-start
				result, err := s.moveDocumentTodosCommand(ctx, actor, req)
				results <- result
				errs <- err
			}()
		}
		close(start)
		first, second := <-results, <-results
		for range 2 {
			if err := <-errs; err != nil {
				t.Fatal(err)
			}
		}
		if first.MovedCount != 1 || !proto.Equal(first, second) {
			t.Fatal("duplicate move did not replay the original result")
		}
		doc, err := s.queries.GetDocument(ctx, int32(saved.Document.Id))
		if err != nil || doc.Revision != saved.Document.Revision+1 {
			t.Fatalf("move bumped revision more than once: %v", err)
		}
		_, err = s.saveDocumentMutation(ctx, actor, updateRequest(saved.Document))
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_REVISION_CONFLICT)
		_, err = s.deleteDocumentMutation(ctx, actor, &secretaryv1.DeleteDocumentRequest{Id: saved.Document.Id, WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(), ExpectedRevision: proto.Int64(doc.Revision)})
		if err != nil {
			t.Fatal(err)
		}
		replay, err := s.moveDocumentTodosCommand(ctx, actor, req)
		if err != nil || !proto.Equal(first, replay) {
			t.Fatalf("move did not replay after deletion: %v", err)
		}
		changed := proto.Clone(req).(*secretaryv1.MoveDocumentTodosToRepositoryRequest)
		changed.DocumentId++
		_, err = s.moveDocumentTodosCommand(ctx, actor, changed)
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_MUTATION_ID_REUSED)
	})

	t.Run("pull replay does not consume newly eligible todos or recreate a deleted journal", func(t *testing.T) {
		req := &secretaryv1.PullOnDeckTodosToTodayRequest{WorkspaceId: int64(workspace.ID), ProtocolVersion: 1, MutationId: uuid.NewString(), JournalDate: "2029-01-02"}
		first, err := s.pullOnDeckTodosCommand(ctx, actor, req)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, effect := range first.Effects.UpdatedDocuments {
			if effect.DocumentId == first.DocumentId && effect.Revision == 1 {
				found = true
			}
		}
		if !found {
			t.Fatal("new journal revision missing from effects")
		}
		later := save(t, newRequest())
		todoID := later.Document.Blocks[1].TodoId
		if _, err := s.moveDocumentTodosCommand(ctx, actor, &secretaryv1.MoveDocumentTodosToRepositoryRequest{DocumentId: later.Document.Id}); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE todo SET bucket='on_deck' WHERE id=$1`, todoID); err != nil {
			t.Fatal(err)
		}
		replay, err := s.pullOnDeckTodosCommand(ctx, actor, req)
		if err != nil || !proto.Equal(first, replay) {
			t.Fatalf("pull result changed on retry: %v", err)
		}
		todo, err := s.queries.GetTodo(ctx, int32(todoID))
		if err != nil || todo.CurrentBlockID.Valid {
			t.Fatalf("replay consumed a later todo: %v", err)
		}
		changed := proto.Clone(req).(*secretaryv1.PullOnDeckTodosToTodayRequest)
		changed.JournalDate = "2029-01-03"
		_, err = s.pullOnDeckTodosCommand(ctx, actor, changed)
		assertReason(t, err, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_MUTATION_ID_REUSED)
		// Simulate external deletion; the normal note-delete API rejects journals.
		if err := s.queries.DeleteDocument(ctx, int32(first.DocumentId)); err != nil {
			t.Fatal(err)
		}
		replay, err = s.pullOnDeckTodosCommand(ctx, actor, req)
		if err != nil || !proto.Equal(first, replay) {
			t.Fatalf("historical pull replay failed: %v", err)
		}
		if _, err := s.queries.GetDocument(ctx, int32(first.DocumentId)); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("receipt resurrected deleted journal")
		}
	})

	t.Run("command receipt failure rolls back domain writes", func(t *testing.T) {
		op, err := commandEnvelope(actor, int64(workspace.ID), 1, uuid.NewString(), "todo.move_to_repository", map[string]any{"document_id": "0"})
		if err != nil {
			t.Fatal(err)
		}
		key := uuid.NewString()
		// Empty protobuf result deliberately violates receipt result_payload CHECK.
		err = s.runTodoCommand(ctx, op, &secretaryv1.MoveDocumentTodosToRepositoryResponse{}, func(q *db.Queries) error {
			_, err := q.CreateDocumentWithClientKey(ctx, db.CreateDocumentWithClientKeyParams{WorkspaceID: workspace.ID, Kind: "note", Title: "Must roll back", ClientKey: key})
			return err
		})
		if err == nil {
			t.Fatal("expected receipt insertion failure")
		}
		if _, err := s.queries.GetDocumentByClientKey(ctx, db.GetDocumentByClientKeyParams{WorkspaceID: workspace.ID, ClientKey: key}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("failed command receipt committed domain data")
		}
	})
}
