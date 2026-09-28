package server

import (
	"context"
	"errors"
	"strconv"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

func (s *Server) CreateTodo(ctx context.Context, req *connect.Request[secretaryv1.CreateTodoRequest]) (*connect.Response[secretaryv1.CreateTodoResponse], error) {
	actor, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.createTodoCommand(ctx, actor, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(result), nil
}

func (s *Server) DeleteTodo(ctx context.Context, req *connect.Request[secretaryv1.DeleteTodoRequest]) (*connect.Response[secretaryv1.DeleteTodoResponse], error) {
	actor, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.deleteTodoCommand(ctx, actor, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(result), nil
}

func standaloneTodoEnvelope(actor, workspace int64, version uint32, mutation, operation string, payload map[string]any) (documentMutation, error) {
	if version != 1 {
		return documentMutation{}, persistenceProtocolNotEnabled()
	}
	scope := workspace
	if scope == 0 {
		scope = actor
	}
	op, err := commandEnvelope(actor, scope, version, mutation, operation, payload)
	if err != nil {
		return op, err
	}
	if workspace == 0 {
		op.userScoped = true
		op.hash = scopedMutationFingerprint(actor, "user", actor, operation, 0, payload)
	}
	return op, nil
}

func createTodoPayload(req *secretaryv1.CreateTodoRequest) map[string]any {
	return map[string]any{"name": req.Name, "desc": req.Desc, "status": int32(req.Status),
		"user_id": strconv.FormatInt(req.UserId, 10), "created_at_recording_id": strconv.FormatInt(req.CreatedAtRecordingId, 10),
		"updated_at_recording_id": strconv.FormatInt(req.UpdatedAtRecordingId, 10), "bucket": req.Bucket,
		"priority_rank": strconv.FormatInt(req.PriorityRank, 10), "deadline_date": req.DeadlineDate, "goal_id": strconv.FormatInt(req.GoalId, 10)}
}

func (s *Server) createTodoCommand(ctx context.Context, actor int64, req *secretaryv1.CreateTodoRequest) (*secretaryv1.CreateTodoResponse, error) {
	op, err := standaloneTodoEnvelope(actor, 0, req.ProtocolVersion, req.MutationId, "todo.create", createTodoPayload(req))
	if err != nil {
		return nil, err
	}
	response := &secretaryv1.CreateTodoResponse{}
	err = s.runTodoCommand(ctx, op, response, func(q *db.Queries) error {
		result, err := s.applyCreateTodo(ctx, q, actor, req)
		if err == nil {
			proto.Merge(response, result)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (s *Server) deleteTodoCommand(ctx context.Context, actor int64, req *secretaryv1.DeleteTodoRequest) (*secretaryv1.DeleteTodoResponse, error) {
	op, err := standaloneTodoEnvelope(actor, req.WorkspaceId, req.ProtocolVersion, req.MutationId, "todo.delete", map[string]any{"todo_id": strconv.FormatInt(req.Id, 10)})
	if err != nil {
		return nil, err
	}
	if !validDatabaseID(req.Id, false) {
		return nil, invalidIdentity("invalid TODO ID")
	}
	// Replay still requires the current admin role, even if the TODO is gone.
	op.authorize = func(q *db.Queries) error {
		return authorizeTodoDeletion(ctx, q, int32(actor))
	}
	response := &secretaryv1.DeleteTodoResponse{}
	err = s.runTodoCommand(ctx, op, response, func(q *db.Queries) error {
		result, err := s.applyDeleteTodo(ctx, q, actor, req)
		if err == nil {
			proto.Merge(response, result)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func authorizeTodoDeletion(ctx context.Context, q *db.Queries, actor int32) error {
	user, err := q.GetUser(ctx, actor)
	if err != nil {
		return err
	}
	if user.Role.String != "admin" {
		return connect.NewError(connect.CodePermissionDenied, errors.New("only admins can delete todos"))
	}
	return nil
}
