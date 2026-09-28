package server

import (
	"connectrpc.com/connect"
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestTodoPatchPresenceAndIntent(t *testing.T) {
	req := &secretaryv1.UpdateTodoRequest{Id: 7, Patch: &secretaryv1.TodoPatch{Desc: proto.String("")}}
	payload, err := todoPatchPayload(req)
	if err != nil {
		t.Fatal(err)
	}
	first := mutationFingerprint(1, 2, "todo.update", 0, payload)
	req.Patch = &secretaryv1.TodoPatch{GoalId: proto.Int64(0)}
	payload, err = todoPatchPayload(req)
	if err != nil {
		t.Fatal(err)
	}
	if first == mutationFingerprint(1, 2, "todo.update", 0, payload) {
		t.Fatal("explicit clears aliased")
	}
	if mutationFingerprint(1, 2, "todo.update", 0, payload) == scopedMutationFingerprint(1, "user", 2, "todo.update", 0, payload) {
		t.Fatal("receipt scopes aliased")
	}
	for _, patch := range []*secretaryv1.TodoPatch{nil, {}, {Name: proto.String(" ")}, {Status: secretaryv1.TodoStatus(99).Enum()}, {GoalId: proto.Int64(-1)}, {PriorityRank: proto.Int64(1 << 32)}, {DeadlineDate: proto.String("2026-02-30")}} {
		req.Patch = patch
		if _, err := todoPatchPayload(req); err == nil {
			t.Fatalf("accepted invalid patch: %v", patch)
		}
	}
}

func TestTodoPatchMergesLockedMetadata(t *testing.T) {
	row := db.GetTodoRow{ID: 7, Name: "Fresh inline name", Desc: pgtype.Text{String: "Keep", Valid: true}, Status: pgtype.Text{String: "todo", Valid: true}, Bucket: pgtype.Text{String: "on_deck", Valid: true}, GoalID: pgtype.Int4{Int32: 3, Valid: true}, PriorityRank: pgtype.Int4{Int32: 4, Valid: true}}
	updated := applyTodoPatch(row, &secretaryv1.TodoPatch{Status: secretaryv1.TodoStatus_TODO_STATUS_DONE.Enum()})
	if updated.Name != row.Name || updated.Desc != row.Desc || updated.GoalID != row.GoalID || updated.PriorityRank != row.PriorityRank || updated.Bucket.String != "done" {
		t.Fatalf("lost metadata: %+v", updated)
	}
	row.Status.String, row.Bucket.String = "done", "done"
	updated = applyTodoPatch(row, &secretaryv1.TodoPatch{Status: secretaryv1.TodoStatus_TODO_STATUS_TODO.Enum()})
	if updated.Bucket.Valid {
		t.Fatal("reopening retained done bucket")
	}
	updated = applyTodoPatch(row, &secretaryv1.TodoPatch{Desc: proto.String(""), GoalId: proto.Int64(0)})
	if updated.Desc.Valid || updated.GoalID.Valid || updated.Status != row.Status || updated.Bucket != row.Bucket {
		t.Fatal("clear overwrote omitted values")
	}
}

func TestVersionedTodoUpdateCannotFallThrough(t *testing.T) {
	s := &Server{}
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	for _, req := range []*secretaryv1.UpdateTodoRequest{{}, {ProtocolVersion: 2}, {MutationId: commandTestID}, {WorkspaceId: 1}, {Patch: &secretaryv1.TodoPatch{}}} {
		_, err := s.UpdateTodo(ctx, connect.NewRequest(req))
		if connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatalf("expected gate: %v", err)
		}
	}
}
