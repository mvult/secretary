package server

import (
	"context"
	"errors"
	"slices"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

// These writers do not accept snapshot baselines or issue retry receipts. They
// still participate in the same workspace -> document -> TODO lock order and
// advance revisions atomically so a versioned snapshot cannot undo their work.
type persistenceWriterScope struct {
	workspace, document, todo int32
	journalDate               pgtype.Date
	pullOwner                 int32
}

type persistenceWriterDependencies struct {
	documents         []db.Document
	todos, workspaces []int32
}

func (s *Server) discoverPersistenceWriter(ctx context.Context, q *db.Queries, scope persistenceWriterScope, actor int32) (persistenceWriterDependencies, error) {
	var deps persistenceWriterDependencies
	if scope.document != 0 {
		doc, err := q.GetDocument(ctx, scope.document)
		if errors.Is(err, pgx.ErrNoRows) {
			return deps, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
		}
		if err != nil {
			return deps, err
		}
		if scope.workspace != 0 && scope.workspace != doc.WorkspaceID {
			return deps, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id cannot be changed"))
		}
		scope.workspace = doc.WorkspaceID
	}
	if scope.workspace != 0 {
		if err := s.ensureWorkspaceAccessWithQueries(ctx, q, scope.workspace, actor); err != nil {
			return deps, err
		}
		deps.workspaces = append(deps.workspaces, scope.workspace)
	}
	if scope.journalDate.Valid && scope.document == 0 {
		journal, err := findWorkspaceJournalByDate(ctx, q, scope.workspace, scope.journalDate)
		if err != nil {
			return deps, err
		}
		if journal != nil {
			scope.document = journal.ID
		}
	}
	if scope.document != 0 {
		todos, err := q.ListDocumentMutationTodos(ctx, db.ListDocumentMutationTodosParams{DocumentID: scope.document, Deleting: true})
		if err != nil {
			return deps, err
		}
		for _, todo := range todos {
			deps.todos = append(deps.todos, todo.ID)
			if todo.WorkspaceID.Valid {
				deps.workspaces = append(deps.workspaces, todo.WorkspaceID.Int32)
			}
		}
	}
	if scope.todo != 0 {
		todo, err := q.GetTodo(ctx, scope.todo)
		if errors.Is(err, pgx.ErrNoRows) {
			return deps, connect.NewError(connect.CodeNotFound, errors.New("todo not found"))
		}
		if err != nil {
			return deps, err
		}
		deps.todos = append(deps.todos, todo.ID)
		if todo.WorkspaceID.Valid {
			deps.workspaces = append(deps.workspaces, todo.WorkspaceID.Int32)
		}
	}
	if scope.pullOwner != 0 {
		todos, err := q.ListOnDeckTodosForPull(ctx, db.ListOnDeckTodosForPullParams{UserID: pgtype.Int4{Int32: scope.pullOwner, Valid: true}, WorkspaceID: pgtype.Int4{Int32: scope.workspace, Valid: true}})
		if err != nil {
			return deps, err
		}
		for _, todo := range todos {
			deps.todos = append(deps.todos, todo.ID)
		}
	}
	deps.todos = sortedPersistenceIDs(deps.todos)
	var err error
	deps.documents, err = q.ListTodoDocumentDependencies(ctx, db.ListTodoDocumentDependenciesParams{DocumentID: scope.document, TodoIds: deps.todos})
	if err != nil {
		return deps, err
	}
	for _, doc := range deps.documents {
		deps.workspaces = append(deps.workspaces, doc.WorkspaceID)
	}
	deps.workspaces = sortedPersistenceIDs(deps.workspaces)
	return deps, nil
}

func sortedPersistenceIDs(ids []int32) []int32 {
	slices.Sort(ids)
	return slices.Compact(ids)
}

func sameWriterDependencies(a, b persistenceWriterDependencies) bool {
	return slices.Equal(a.workspaces, b.workspaces) && slices.Equal(a.todos, b.todos) && sameDocumentDependencies(a.documents, b.documents)
}

// The caller owns the transaction and must roll it back on error. Re-discovery
// after TODO locks verifies that document references still match the locked
// set. Never acquire a newly discovered lock out of order.
func (s *Server) lockPersistenceWriter(ctx context.Context, q *db.Queries, actor int32, scope persistenceWriterScope) (*persistenceWriterDependencies, error) {
	deps, err := s.discoverPersistenceWriter(ctx, q, scope, actor)
	if err != nil {
		return nil, err
	}
	for _, workspace := range deps.workspaces {
		if err := s.ensureWorkspaceAccessWithQueries(ctx, q, workspace, actor); err != nil {
			return nil, err
		}
		if err := q.LockPersistenceWorkspace(ctx, workspace); err != nil {
			return nil, err
		}
		if err := s.ensureWorkspaceAccessWithQueries(ctx, q, workspace, actor); err != nil {
			return nil, err
		}
	}
	current, err := s.discoverPersistenceWriter(ctx, q, scope, actor)
	if err != nil {
		return nil, err
	}
	if !sameWriterDependencies(deps, current) {
		return nil, writerContention()
	}
	for i, doc := range current.documents {
		current.documents[i], err = q.LockDocumentForPersistence(ctx, db.LockDocumentForPersistenceParams{WorkspaceID: doc.WorkspaceID, ID: doc.ID})
		if err != nil {
			return nil, err
		}
	}
	if err := q.LockPersistenceTodos(ctx, current.todos); err != nil {
		return nil, err
	}
	checked, err := s.discoverPersistenceWriter(ctx, q, scope, actor)
	if err != nil {
		return nil, err
	}
	if !sameWriterDependencies(current, checked) {
		return nil, writerContention()
	}
	return &current, nil
}

func writerContention() error {
	return connect.NewError(connect.CodeUnavailable, errors.New("mutation dependencies changed; retry the operation"))
}
