package server

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

// Exercises discovery/revalidation and intent preservation without a database.
type directoryDB struct {
	t                                       *testing.T
	locked, wrote, missingAfterLock, denied bool
	documents, children                     int64
	current                                 db.Directory
	updated                                 db.Directory
}

func (f *directoryDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	switch {
	case strings.Contains(sql, "-- name: LockPersistenceWorkspace"):
		f.locked = true
	case strings.Contains(sql, "-- name: LockPersistenceTodos"):
	case strings.Contains(sql, "-- name: DeleteDirectory"):
		if !f.locked {
			f.t.Fatal("deleted before workspace lock")
		}
		f.wrote = true
	default:
		f.t.Fatalf("unexpected exec: %s", sql)
	}
	return pgconn.CommandTag{}, nil
}

func (f *directoryDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if !strings.Contains(sql, "-- name: ListTodoDocumentDependencies") {
		f.t.Fatalf("unexpected query: %s", sql)
	}
	return &writerRows{}, nil
}

func (f *directoryDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	switch {
	case strings.Contains(sql, "-- name: GetWorkspaceMembership"):
		if f.denied {
			return writerRow{err: pgx.ErrNoRows}
		}
		return writerRow{value: db.WorkspaceUserRel{}}
	case strings.Contains(sql, "-- name: GetDirectory"):
		id := args[0].(int32)
		if id != f.current.ID {
			return writerRow{value: db.Directory{ID: id, WorkspaceID: f.current.WorkspaceID}}
		}
		if f.locked && f.missingAfterLock {
			return writerRow{err: pgx.ErrNoRows}
		}
		if !f.locked {
			return writerRow{value: db.Directory{ID: id, WorkspaceID: f.current.WorkspaceID, Name: "stale"}}
		}
		return writerRow{value: f.current}
	case strings.Contains(sql, "-- name: CountChildDirectories"):
		if !f.locked {
			f.t.Fatal("checked children before lock")
		}
		return writerRow{value: struct{ N int64 }{f.children}}
	case strings.Contains(sql, "-- name: CountDocumentsInDirectory"):
		if !f.locked {
			f.t.Fatal("checked documents before lock")
		}
		return writerRow{value: struct{ N int64 }{f.documents}}
	case strings.Contains(sql, "-- name: UpdateDirectory"):
		if !f.locked {
			f.t.Fatal("updated before lock")
		}
		f.wrote = true
		f.updated = f.current
		f.updated.Name = args[1].(string)
		f.updated.ParentID = args[2].(pgtype.Int4)
		return writerRow{value: f.updated}
	default:
		f.t.Fatalf("unexpected query row: %s", sql)
	}
	return writerRow{err: pgx.ErrNoRows}
}

func TestDirectoryPatchUsesLockedCurrentValues(t *testing.T) {
	name, root := "renamed", int64(0)
	for _, command := range []directoryCommand{
		{operation: "update", id: 1, patch: true, patchName: &name},
		{operation: "update", id: 1, patch: true, patchParent: &root},
	} {
		f := &directoryDB{t: t, current: db.Directory{ID: 1, WorkspaceID: 9, Name: "current", ParentID: pgtype.Int4{Int32: 2, Valid: true}}}
		result, err := (&Server{}).applyDirectoryCommand(context.Background(), db.New(f), 1, command)
		if err != nil {
			t.Fatal(err)
		}
		if command.patchName != nil && (result.Name != name || result.ParentID.Int32 != 2) {
			t.Fatalf("rename lost current placement: %+v", result)
		}
		if command.patchParent != nil && (result.Name != "current" || result.ParentID.Valid) {
			t.Fatalf("move lost current name or root presence: %+v", result)
		}
	}
}

func TestDirectoryDeleteRevalidatesTargetAndEmptiness(t *testing.T) {
	for _, test := range []struct {
		name                string
		missing, denied     bool
		documents, children int64
		code                connect.Code
	}{
		{"deleted during discovery", true, false, 0, 0, connect.CodeNotFound},
		{"document placed before lock", false, false, 1, 0, connect.CodeFailedPrecondition},
		{"child created before lock", false, false, 0, 1, connect.CodeFailedPrecondition},
		{"access denied", false, true, 0, 0, connect.CodePermissionDenied},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := &directoryDB{t: t, current: db.Directory{ID: 1, WorkspaceID: 9}, missingAfterLock: test.missing, denied: test.denied, documents: test.documents, children: test.children}
			_, err := (&Server{}).applyDirectoryCommand(context.Background(), db.New(f), 1, directoryCommand{operation: "delete", id: 1})
			if connect.CodeOf(err) != test.code || f.wrote {
				t.Fatalf("error=%v wrote=%v", err, f.wrote)
			}
		})
	}
}

func TestDirectoryRejectsIDsBeforeNarrowing(t *testing.T) {
	for _, command := range []directoryCommand{
		{operation: "create", workspace: 1<<32 + 1, name: "x"},
		{operation: "update", id: 1<<32 + 1, name: "x"},
		{operation: "create", workspace: 1, parent: -1, name: "x"},
		{operation: "update", id: 1, patch: true},
	} {
		if _, err := (&Server{}).mutateDirectory(context.Background(), 1, command); err == nil {
			t.Fatalf("accepted %+v", command)
		}
	}
}
