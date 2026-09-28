package server

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

// Shared by editor snapshots and AI mutations. The caller owns the transaction
// and writer locks; inline edits own only name/status, never standalone metadata.
func (s *Server) reconcileBlockTodo(ctx context.Context, qtx *db.Queries, doc db.Document, block db.Block, msg *secretaryv1.Block, userID int64, previous *db.Block) (db.Block, error) {
	status := strings.ToLower(strings.TrimSpace(msg.TodoStatus))
	if status == "" {
		if block.TodoID.Valid {
			if err := deleteTodoWithHistory(ctx, qtx, block.TodoID.Int32, userID); err != nil {
				return db.Block{}, err
			}
			block.TodoID = pgtype.Int4{}
		}
		return block, nil
	}
	name := strings.TrimSpace(msg.Text)
	if err := validateTodoInput(name, status); err != nil {
		return db.Block{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("task block %q is invalid: %w", msg.ClientKey, err))
	}
	statusValue := pgtype.Text{String: status, Valid: true}
	if block.TodoID.Valid {
		current, err := qtx.GetTodo(ctx, block.TodoID.Int32)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Block{}, persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_TREE, "snapshot both removes and updates the same linked TODO", nil)
		}
		if err != nil {
			return db.Block{}, err
		}
		if previous != nil && previous.Text == msg.Text {
			name = current.Name
		}
		if name == current.Name && status == current.Status.String {
			return block, nil
		}
		updated, err := qtx.UpdateInlineTodo(ctx, db.UpdateInlineTodoParams{ID: current.ID, Name: name, Status: statusValue})
		if err != nil {
			return db.Block{}, err
		}
		if err := createTodoHistoryEntry(ctx, qtx, updated.ID, userID, "update", updated.Name, updated.Desc, updated.Status, updated.UserID, updated.CreatedAtRecordingID, updated.UpdatedAtRecordingID); err != nil {
			return db.Block{}, err
		}
		return block, nil
	}
	todo, err := qtx.CreateCanonicalTodoForBlock(ctx, db.CreateCanonicalTodoForBlockParams{
		Name: name, Status: statusValue, UserID: pgtype.Int4{Int32: int32(userID), Valid: true},
		WorkspaceID:      pgtype.Int4{Int32: doc.WorkspaceID, Valid: true},
		SourceDocumentID: pgtype.Int4{Int32: doc.ID, Valid: true}, SourceBlockID: pgtype.Int4{Int32: block.ID, Valid: true},
	})
	if err != nil {
		return db.Block{}, err
	}
	if err := createTodoHistoryEntry(ctx, qtx, todo.ID, userID, "create", todo.Name, todo.Desc, todo.Status, todo.UserID, todo.CreatedAtRecordingID, todo.UpdatedAtRecordingID); err != nil {
		return db.Block{}, err
	}
	return qtx.UpdateBlock(ctx, db.UpdateBlockParams{ID: block.ID, DocumentID: block.DocumentID,
		ParentBlockID: block.ParentBlockID, SortOrder: block.SortOrder, Text: block.Text, TodoID: pgtype.Int4{Int32: todo.ID, Valid: true}})
}

func deleteTodoWithHistory(ctx context.Context, qtx *db.Queries, todoID int32, userID int64) error {
	todo, err := qtx.GetTodo(ctx, todoID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := createTodoHistoryEntry(ctx, qtx, todo.ID, userID, "delete", todo.Name, todo.Desc, todo.Status, todo.UserID, todo.CreatedAtRecordingID, todo.UpdatedAtRecordingID); err != nil {
		return err
	}
	return qtx.DeleteTodo(ctx, todoID)
}

func createTodoHistoryEntry(ctx context.Context, qtx *db.Queries, todoID int32, actorUserID int64, changeType string, name string, desc pgtype.Text, status pgtype.Text, userID pgtype.Int4, createdAtRecordingID pgtype.Int4, updatedAtRecordingID pgtype.Int4) error {
	return qtx.CreateTodoHistory(ctx, db.CreateTodoHistoryParams{
		TodoID: todoID, ActorUserID: pgtype.Int4{Int32: int32(actorUserID), Valid: actorUserID > 0}, ChangeType: changeType,
		Name: pgtype.Text{String: name, Valid: strings.TrimSpace(name) != ""}, Desc: desc, Status: status, UserID: userID,
		CreatedAtRecordingID: createdAtRecordingID, UpdatedAtRecordingID: updatedAtRecordingID,
	})
}
