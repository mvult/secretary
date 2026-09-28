package server

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

// Presence is intent: an omitted field is never reconstructed from a stale UI row.
func todoPatchPayload(req *secretaryv1.UpdateTodoRequest) (map[string]any, error) {
	if req == nil || !validDatabaseID(req.Id, false) || req.Patch == nil {
		return nil, invalidIdentity("todo ID and patch are required")
	}
	if req.Name != "" || req.Desc != "" || req.Status != 0 || req.UserId != 0 || req.UpdatedAtRecordingId != 0 || req.Bucket != "" || req.PriorityRank != 0 || req.DeadlineDate != "" || req.GoalId != 0 {
		return nil, invalidIdentity("legacy fields cannot accompany a TODO patch")
	}
	p := req.Patch
	fields := map[string]any{}
	if p.Name != nil {
		if strings.TrimSpace(*p.Name) == "" {
			return nil, invalidIdentity("name is required")
		}
		fields["name"] = *p.Name
	}
	if p.Desc != nil {
		fields["desc"] = *p.Desc
	}
	if p.Status != nil {
		if *p.Status < secretaryv1.TodoStatus_TODO_STATUS_TODO || *p.Status > secretaryv1.TodoStatus_TODO_STATUS_SKIPPED {
			return nil, invalidIdentity("invalid status")
		}
		fields["status"] = int32(*p.Status)
	}
	if p.Bucket != nil {
		if _, err := normalizeTodoBucket(*p.Bucket, "todo"); err != nil {
			return nil, invalidIdentity("invalid bucket")
		}
		fields["bucket"] = *p.Bucket
	}
	if p.PriorityRank != nil {
		if !validDatabaseID(*p.PriorityRank, true) {
			return nil, invalidIdentity("invalid priority rank")
		}
		fields["priority_rank"] = strconv.FormatInt(*p.PriorityRank, 10)
	}
	if p.GoalId != nil {
		if !validDatabaseID(*p.GoalId, true) {
			return nil, invalidIdentity("invalid goal ID")
		}
		fields["goal_id"] = strconv.FormatInt(*p.GoalId, 10)
	}
	if p.DeadlineDate != nil {
		if _, err := parseDateOnly(*p.DeadlineDate); err != nil {
			return nil, invalidIdentity("invalid deadline date")
		}
		fields["deadline_date"] = *p.DeadlineDate
	}
	if len(fields) == 0 {
		return nil, invalidIdentity("empty TODO patch")
	}
	return map[string]any{"todo_id": strconv.FormatInt(req.Id, 10), "patch": fields}, nil
}

func applyTodoPatch(row db.GetTodoRow, p *secretaryv1.TodoPatch) db.PatchTodoParams {
	arg := db.PatchTodoParams{ID: row.ID, Name: row.Name, Desc: row.Desc, Status: row.Status, Bucket: row.Bucket,
		PriorityRank: row.PriorityRank, DeadlineDate: row.DeadlineDate, GoalID: row.GoalID}
	if p.Name != nil {
		arg.Name = *p.Name
	}
	if p.Desc != nil {
		arg.Desc = pgtype.Text{String: *p.Desc, Valid: *p.Desc != ""}
	}
	if p.Status != nil {
		arg.Status = pgtype.Text{String: mapStatusToString(*p.Status), Valid: true}
		if p.Bucket == nil {
			switch arg.Status.String {
			case "done", "blocked":
				arg.Bucket = pgtype.Text{String: arg.Status.String, Valid: true}
			default:
				if row.Bucket.String == "done" || row.Bucket.String == "blocked" {
					arg.Bucket = pgtype.Text{}
				}
			}
		}
	}
	if p.Bucket != nil {
		bucket, _ := normalizeTodoBucket(*p.Bucket, arg.Status.String)
		arg.Bucket = pgtype.Text{String: bucket, Valid: bucket != ""}
	}
	if p.PriorityRank != nil {
		arg.PriorityRank = pgtype.Int4{Int32: int32(*p.PriorityRank), Valid: *p.PriorityRank != 0}
	}
	if p.GoalId != nil {
		arg.GoalID = pgtype.Int4{Int32: int32(*p.GoalId), Valid: *p.GoalId != 0}
	}
	if p.DeadlineDate != nil {
		arg.DeadlineDate, _ = parseDateOnly(*p.DeadlineDate)
	}
	return arg
}

func (s *Server) updateTodoCommand(ctx context.Context, actor int64, req *secretaryv1.UpdateTodoRequest) (*secretaryv1.UpdateTodoResponse, error) {
	payload, err := todoPatchPayload(req)
	if err != nil {
		return nil, err
	}
	if req.ProtocolVersion == 0 {
		return nil, persistenceProtocolNotEnabled()
	}
	scope := req.WorkspaceId
	userScoped := scope == 0
	if userScoped {
		scope = actor
	}
	op, err := commandEnvelope(actor, scope, req.ProtocolVersion, req.MutationId, "todo.update", payload)
	if err != nil {
		return nil, err
	}
	op.userScoped = userScoped
	if userScoped {
		op.hash = scopedMutationFingerprint(actor, "user", actor, op.name, 0, payload)
	}
	response := &secretaryv1.UpdateTodoResponse{}
	err = s.runTodoCommand(ctx, op, response, func(q *db.Queries) error {
		deps, err := s.lockPersistenceWriter(ctx, q, op.actor, persistenceWriterScope{todo: int32(req.Id)})
		if err != nil {
			return err
		}
		row, err := q.GetTodo(ctx, int32(req.Id))
		if err != nil {
			return err
		}
		// Rechecked after the TODO lock: an unlinked command cannot follow a TODO
		// into a document/workspace, and a workspace command cannot cross scopes.
		if userScoped {
			if row.WorkspaceID.Valid || len(deps.documents) != 0 || !row.UserID.Valid || row.UserID.Int32 != op.actor {
				return connect.NewError(connect.CodePermissionDenied, errors.New("TODO is not an owned unlinked TODO"))
			}
		} else if !row.WorkspaceID.Valid || row.WorkspaceID.Int32 != op.workspace {
			return connect.NewError(connect.CodePermissionDenied, errors.New("TODO does not belong to the command workspace"))
		}
		arg := applyTodoPatch(row, req.Patch)
		if req.Patch.GoalId != nil && arg.GoalID.Valid {
			goals, err := q.ListTodoGoalsByUser(ctx, row.UserID.Int32)
			if err != nil {
				return err
			}
			found := false
			for _, goal := range goals {
				if goal.ID == arg.GoalID.Int32 {
					found = true
					break
				}
			}
			if !found {
				return invalidIdentity("goal must belong to the TODO owner")
			}
		}
		updated, err := q.PatchTodo(ctx, arg)
		if err != nil {
			return err
		}
		if err := createTodoHistoryEntry(ctx, q, updated.ID, actor, "update", updated.Name, updated.Desc, updated.Status, updated.UserID, updated.CreatedAtRecordingID, updated.UpdatedAtRecordingID); err != nil {
			return err
		}
		effects, err := advanceMutationDocuments(ctx, q, deps.documents, 0)
		if err != nil {
			return err
		}
		// Read joined metadata under the same transaction for a complete receipt.
		current, err := q.GetTodo(ctx, updated.ID)
		if err != nil {
			return err
		}
		proto.Merge(response, &secretaryv1.UpdateTodoResponse{Todo: getTodoRowToProto(current), MutationId: req.MutationId, Effects: effects})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}
