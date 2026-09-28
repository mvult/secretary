package server

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

// Scripted query boundary: verifies service intent/order, not database semantics.
type lifecycleDB struct {
	db.DBTX
	t           *testing.T
	current     db.GetTodoRow
	updated     db.Todo
	block       db.Block
	events      []string
	history     []any
	failHistory bool
	missing     bool
}

func (f *lifecycleDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	switch {
	case strings.Contains(sql, "-- name: GetTodo "):
		if f.missing {
			return writerRow{err: pgx.ErrNoRows}
		}
		return writerRow{value: f.current}
	case strings.Contains(sql, "-- name: UpdateInlineTodo "):
		f.events = append(f.events, "update")
		if len(args) != 3 || args[2] != f.current.ID {
			f.t.Fatalf("unexpected inline fields: %v", args)
		}
		f.updated.Name = args[0].(string)
		f.updated.Status = args[1].(pgtype.Text)
		return writerRow{value: f.updated}
	case strings.Contains(sql, "-- name: CreateCanonicalTodoForBlock "):
		f.events = append(f.events, "create")
		if args[4].(pgtype.Int4).Int32 != 3 || args[5].(pgtype.Int4).Int32 != 4 || args[6].(pgtype.Int4).Int32 != 5 {
			f.t.Fatalf("wrong creation placement: %v", args)
		}
		return writerRow{value: f.updated}
	case strings.Contains(sql, "-- name: UpdateBlock "):
		f.events = append(f.events, "link")
		if args[0] != f.block.ID || args[1] != f.block.DocumentID || args[2] != f.block.ParentBlockID || args[3] != f.block.SortOrder || args[4] != f.block.Text {
			f.t.Fatalf("link changed outline: %v", args)
		}
		block := f.block
		block.TodoID = args[5].(pgtype.Int4)
		return writerRow{value: block}
	default:
		f.t.Fatalf("unexpected query: %s", sql)
	}
	return writerRow{err: pgx.ErrNoRows}
}

func (f *lifecycleDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch {
	case strings.Contains(sql, "-- name: CreateTodoHistory "):
		f.events = append(f.events, "history")
		f.history = args
		if f.failHistory {
			return pgconn.CommandTag{}, errors.New("history unavailable")
		}
	case strings.Contains(sql, "-- name: DeleteTodo "):
		f.events = append(f.events, "delete")
	default:
		f.t.Fatalf("unexpected exec: %s", sql)
	}
	return pgconn.CommandTag{}, nil
}

func lifecycleFixture(t *testing.T) *lifecycleDB {
	return &lifecycleDB{t: t,
		current: db.GetTodoRow{ID: 7, Name: "Renamed through TODO UI", Status: pgtype.Text{String: "todo", Valid: true}},
		updated: db.Todo{ID: 7, Name: "Renamed through TODO UI", Desc: pgtype.Text{String: "Keep description", Valid: true},
			UserID: pgtype.Int4{Int32: 9, Valid: true}, GoalID: pgtype.Int4{Int32: 12, Valid: true}, PriorityRank: pgtype.Int4{Int32: 8, Valid: true}},
		block: db.Block{ID: 5, DocumentID: 4, Text: "Old inline text", SortOrder: 2, TodoID: pgtype.Int4{Int32: 7, Valid: true}},
	}
}

func TestInlineTodoLifecyclePreservesNameMetadataAndHistoryActor(t *testing.T) {
	f := lifecycleFixture(t)
	result, err := (&Server{}).reconcileBlockTodo(context.Background(), db.New(f), db.Document{ID: 4, WorkspaceID: 3}, f.block,
		&secretaryv1.Block{Text: f.block.Text, TodoStatus: "done"}, 1, &f.block)
	if err != nil {
		t.Fatal(err)
	}
	if result != f.block || f.updated.Name != f.current.Name {
		t.Fatal("status-only edit changed name or block identity")
	}
	if !reflect.DeepEqual(f.events, []string{"update", "history"}) {
		t.Fatal(f.events)
	}
	if f.history[1].(pgtype.Int4).Int32 != 1 || f.history[6].(pgtype.Int4).Int32 != 9 || f.history[4].(pgtype.Text).String != "Keep description" {
		t.Fatalf("history lost actor/owner/metadata: %v", f.history)
	}
}

func TestInlineTodoCreationLinksOnlyAfterHistory(t *testing.T) {
	for _, fail := range []bool{false, true} {
		f := lifecycleFixture(t)
		f.block.TodoID = pgtype.Int4{}
		f.failHistory = fail
		result, err := (&Server{}).reconcileBlockTodo(context.Background(), db.New(f), db.Document{ID: 4, WorkspaceID: 3}, f.block,
			&secretaryv1.Block{Text: f.block.Text, TodoStatus: "todo"}, 1, nil)
		if fail {
			if err == nil || !reflect.DeepEqual(f.events, []string{"create", "history"}) {
				t.Fatalf("linked after failed history: %v %v", f.events, err)
			}
		} else if err != nil || result.TodoID.Int32 != 7 || !reflect.DeepEqual(f.events, []string{"create", "history", "link"}) {
			t.Fatalf("creation: %v %v", result, err)
		}
	}
}

func TestInlineTodoRemovalAndNoOp(t *testing.T) {
	for _, fail := range []bool{false, true} {
		f := lifecycleFixture(t)
		f.failHistory = fail
		result, err := (&Server{}).reconcileBlockTodo(context.Background(), db.New(f), db.Document{}, f.block, &secretaryv1.Block{Text: f.block.Text}, 1, &f.block)
		if fail {
			if err == nil || !reflect.DeepEqual(f.events, []string{"history"}) {
				t.Fatal("deleted after failed history")
			}
		} else if err != nil || result.TodoID.Valid || !reflect.DeepEqual(f.events, []string{"history", "delete"}) {
			t.Fatal("failed to remove TODO")
		}
	}
	f := lifecycleFixture(t)
	_, err := (&Server{}).reconcileBlockTodo(context.Background(), db.New(f), db.Document{}, f.block, &secretaryv1.Block{Text: f.block.Text, TodoStatus: "todo"}, 1, &f.block)
	if err != nil || len(f.events) != 0 {
		t.Fatalf("no-op wrote history: %v %v", f.events, err)
	}
	f.missing = true
	_, err = (&Server{}).reconcileBlockTodo(context.Background(), db.New(f), db.Document{}, f.block, &secretaryv1.Block{Text: f.block.Text, TodoStatus: "todo"}, 1, &f.block)
	if err == nil || len(f.events) != 0 {
		t.Fatal("missing canonical TODO silently recreated")
	}
}
