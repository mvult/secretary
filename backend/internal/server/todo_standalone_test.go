package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

func TestStandaloneTodoActivation(t *testing.T) {
	s := &Server{}
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	for _, version := range []uint32{0, 2} {
		_, err := s.CreateTodo(ctx, connect.NewRequest(&secretaryv1.CreateTodoRequest{ProtocolVersion: version}))
		if connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal(err)
		}
		_, err = s.DeleteTodo(ctx, connect.NewRequest(&secretaryv1.DeleteTodoRequest{ProtocolVersion: version}))
		if connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal(err)
		}
	}
	_, err := s.CreateTodo(ctx, connect.NewRequest(&secretaryv1.CreateTodoRequest{ProtocolVersion: 1}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("v1 did not reach envelope validation: %v", err)
	}
	_, err = s.DeleteTodo(ctx, connect.NewRequest(&secretaryv1.DeleteTodoRequest{ProtocolVersion: 1}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("v1 did not reach envelope validation: %v", err)
	}
}

func TestStandaloneTodoFingerprintsPreserveAllCreateIntent(t *testing.T) {
	req := &secretaryv1.CreateTodoRequest{Name: "Task", UserId: 1, Status: secretaryv1.TodoStatus_TODO_STATUS_TODO}
	fingerprint := func(r *secretaryv1.CreateTodoRequest) [32]byte {
		op, err := standaloneTodoEnvelope(1, 0, 1, commandTestID, "todo.create", createTodoPayload(r))
		if err != nil {
			t.Fatal(err)
		}
		if !op.userScoped || op.workspace != 1 {
			t.Fatal("creation not actor scoped")
		}
		return op.hash
	}
	original := fingerprint(req)
	for _, change := range []func(*secretaryv1.CreateTodoRequest){
		func(r *secretaryv1.CreateTodoRequest) { r.Name += " " },
		func(r *secretaryv1.CreateTodoRequest) { r.Desc = "new" },
		func(r *secretaryv1.CreateTodoRequest) { r.Status = secretaryv1.TodoStatus_TODO_STATUS_DONE },
		func(r *secretaryv1.CreateTodoRequest) { r.UserId++ },
		func(r *secretaryv1.CreateTodoRequest) { r.CreatedAtRecordingId++ },
		func(r *secretaryv1.CreateTodoRequest) { r.UpdatedAtRecordingId++ },
		func(r *secretaryv1.CreateTodoRequest) { r.Bucket = "on_deck" },
		func(r *secretaryv1.CreateTodoRequest) { r.PriorityRank++ },
		func(r *secretaryv1.CreateTodoRequest) { r.DeadlineDate = "2026-09-28" },
		func(r *secretaryv1.CreateTodoRequest) { r.GoalId++ },
	} {
		copy := proto.Clone(req).(*secretaryv1.CreateTodoRequest)
		change(copy)
		if fingerprint(copy) == original {
			t.Fatal("changed intent aliased")
		}
	}
	user, _ := standaloneTodoEnvelope(1, 0, 1, commandTestID, "todo.delete", map[string]any{"todo_id": "7"})
	workspace, _ := standaloneTodoEnvelope(1, 1, 1, commandTestID, "todo.delete", map[string]any{"todo_id": "7"})
	if user.hash == workspace.hash {
		t.Fatal("user and workspace scopes aliased")
	}
}

type todoAdminDB struct {
	db.DBTX
	role string
}

func (f todoAdminDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return writerRow{value: db.GetUserRow{ID: 1, Role: pgtype.Text{String: f.role, Valid: true}}}
}

func TestTodoDeleteRechecksCurrentAdminRole(t *testing.T) {
	for _, role := range []string{"admin", "user", ""} {
		err := authorizeTodoDeletion(context.Background(), db.New(todoAdminDB{role: role}), 1)
		if (err == nil) != (role == "admin") {
			t.Fatalf("role=%q error=%v", role, err)
		}
	}
}
