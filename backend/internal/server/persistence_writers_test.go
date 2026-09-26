package server

import (
	"context"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

// This fake exercises lock planning/revalidation without a database. It does
// not claim to simulate PostgreSQL's actual locking or rollback behavior.
type writerDB struct {
	t           *testing.T
	events      []string
	discoveries int
	changeAt    int
	denied      bool
}

func (f *writerDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch {
	case strings.Contains(sql, "-- name: LockPersistenceWorkspace"):
		f.events = append(f.events, fmt.Sprintf("workspace:%d", args[0]))
	case strings.Contains(sql, "-- name: LockPersistenceTodos"):
		f.events = append(f.events, fmt.Sprintf("todos:%v", args[0]))
	default:
		f.t.Fatalf("unexpected exec: %s", sql)
	}
	return pgconn.CommandTag{}, nil
}

func (f *writerDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	switch {
	case strings.Contains(sql, "-- name: GetTodo"):
		return writerRow{value: db.GetTodoRow{ID: 7, WorkspaceID: pgtype.Int4{Int32: 9, Valid: true}}}
	case strings.Contains(sql, "-- name: GetWorkspaceMembership"):
		if f.denied {
			return writerRow{err: pgx.ErrNoRows}
		}
		return writerRow{value: db.WorkspaceUserRel{}}
	case strings.Contains(sql, "-- name: LockDocumentForPersistence"):
		f.events = append(f.events, fmt.Sprintf("document:%d", args[1]))
		return writerRow{value: db.Document{ID: args[1].(int32), WorkspaceID: args[0].(int32), Revision: 5}}
	case strings.Contains(sql, "-- name: AdvanceDocumentRevision"):
		f.events = append(f.events, fmt.Sprintf("advance:%d:%d", args[1], args[2]))
		return writerRow{value: db.Document{ID: args[1].(int32), WorkspaceID: args[0].(int32), Revision: args[2].(int64) + 1}}
	default:
		f.t.Fatalf("unexpected query row: %s", sql)
	}
	return writerRow{err: pgx.ErrNoRows}
}

func (f *writerDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if !strings.Contains(sql, "-- name: ListTodoDocumentDependencies") {
		f.t.Fatalf("unexpected query: %s", sql)
	}
	f.discoveries++
	rows := []any{db.Document{ID: 10, WorkspaceID: 9, Revision: 2}, db.Document{ID: 20, WorkspaceID: 3, Revision: 2}}
	if f.changeAt != 0 && f.discoveries >= f.changeAt {
		rows = append(rows, db.Document{ID: 30, WorkspaceID: 11, Revision: 1})
	}
	return &writerRows{values: rows}, nil
}

type writerRow struct {
	value any
	err   error
}

func (r writerRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	v := reflect.ValueOf(r.value)
	if v.NumField() != len(dest) {
		return fmt.Errorf("scan shape mismatch: %d != %d", v.NumField(), len(dest))
	}
	for i, target := range dest {
		reflect.ValueOf(target).Elem().Set(v.Field(i))
	}
	return nil
}

type writerRows struct {
	pgx.Rows
	values []any
	index  int
}

func (r *writerRows) Next() bool {
	if r.index >= len(r.values) {
		return false
	}
	r.index++
	return true
}
func (r *writerRows) Scan(dest ...any) error {
	return (writerRow{value: r.values[r.index-1]}).Scan(dest...)
}
func (r *writerRows) Close()     {}
func (r *writerRows) Err() error { return nil }

func TestPersistenceWriterLockOrderAndRevisions(t *testing.T) {
	f := &writerDB{t: t}
	q := db.New(f)
	s := &Server{}
	deps, err := s.lockPersistenceWriter(context.Background(), q, 1, persistenceWriterScope{todo: 7})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"workspace:3", "workspace:9", "document:10", "document:20", "todos:[7]"}
	if !slices.Equal(f.events, want) {
		t.Fatalf("lock order = %v", f.events)
	}
	if deps.documents[0].Revision != 5 {
		t.Fatal("returned pre-lock revision")
	}
	effects, err := advanceMutationDocuments(context.Background(), q, deps.documents, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.UpdatedDocuments) != 1 || effects.UpdatedDocuments[0].DocumentId != 20 || effects.UpdatedDocuments[0].Revision != 6 {
		t.Fatalf("effects = %v", effects)
	}
	if f.events[len(f.events)-1] != "advance:20:5" {
		t.Fatalf("revision update = %v", f.events)
	}
}

func TestPersistenceWriterRejectsChangedDependencies(t *testing.T) {
	for _, stage := range []int{2, 3} {
		t.Run(fmt.Sprint(stage), func(t *testing.T) {
			f := &writerDB{t: t, changeAt: stage}
			_, err := (&Server{}).lockPersistenceWriter(context.Background(), db.New(f), 1, persistenceWriterScope{todo: 7})
			if connect.CodeOf(err) != connect.CodeUnavailable {
				t.Fatalf("error = %v", err)
			}
			if slices.Contains(f.events, "workspace:11") || slices.Contains(f.events, "document:30") {
				t.Fatalf("acquired new dependency out of order: %v", f.events)
			}
			if stage == 2 && slices.Contains(f.events, "document:10") {
				t.Fatal("continued after workspace discovery changed")
			}
		})
	}
}

func TestPersistenceWriterAuthorizesBeforeLocks(t *testing.T) {
	f := &writerDB{t: t, denied: true}
	_, err := (&Server{}).lockPersistenceWriter(context.Background(), db.New(f), 1, persistenceWriterScope{todo: 7})
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("error = %v", err)
	}
	if len(f.events) != 0 {
		t.Fatalf("locked unauthorized dependencies: %v", f.events)
	}
}

func TestAIPlacementPreservesVisibleOrderAndSubtree(t *testing.T) {
	parent := func(id int32) pgtype.Int4 { return pgtype.Int4{Int32: id, Valid: true} }
	// Valid visible order need not group all descendants contiguously.
	blocks := []db.Block{{ID: 1}, {ID: 2}, {ID: 3, ParentBlockID: parent(1)}, {ID: 4, ParentBlockID: parent(3)}, {ID: 5}}
	for _, tc := range []struct {
		name   string
		target db.Block
		parent pgtype.Int4
		after  int32
		want   []int32
	}{
		{"new root", db.Block{ID: 6, Text: "New"}, pgtype.Int4{}, 0, []int32{6, 1, 2, 3, 4, 5}},
		{"new child", db.Block{ID: 6}, parent(1), 0, []int32{1, 6, 2, 3, 4, 5}},
		{"after subtree", db.Block{ID: 6}, pgtype.Int4{}, 1, []int32{1, 2, 3, 4, 6, 5}},
		{"move subtree", blocks[2], parent(2), 0, []int32{1, 2, 3, 4, 5}},
		{"move root", blocks[0], pgtype.Int4{}, 5, []int32{2, 5, 1, 3, 4}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := placeDocumentBlock(blocks, tc.target, tc.parent, tc.after)
			ids := []int32{}
			seen := map[int32]bool{}
			for _, block := range result {
				if seen[block.ID] || (block.ParentBlockID.Valid && !seen[block.ParentBlockID.Int32]) {
					t.Fatalf("invalid tree/order: %v", result)
				}
				seen[block.ID] = true
				ids = append(ids, block.ID)
				if block.ID == tc.target.ID && block.ParentBlockID != tc.parent {
					t.Fatal("target parent not updated")
				}
			}
			if !slices.Equal(ids, tc.want) {
				t.Fatalf("order = %v, want %v", ids, tc.want)
			}
			if blocks[2].ParentBlockID != parent(1) {
				t.Fatal("input snapshot was mutated")
			}
		})
	}
}

func TestAIPlainTextUsesVersionedOrdering(t *testing.T) {
	blocks := blocksFromPlainText("Root\n  Child\nNext", 0)
	for i, block := range blocks {
		if block.SortOrder != int32(i+1) {
			t.Fatalf("sort order = %d", block.SortOrder)
		}
	}
	if blocks[1].ParentClientKey != blocks[0].ClientKey {
		t.Fatal("lost child identity")
	}
}
