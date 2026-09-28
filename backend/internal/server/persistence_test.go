package server

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestLegacyDocumentRequestsCannotBypassVersionedWrites(t *testing.T) {
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	s := &Server{} // No DB: rejection must precede any reads/writes.
	assertRejected := func(t *testing.T, err error) {
		t.Helper()
		var rpcErr *connect.Error
		if !errors.As(err, &rpcErr) || rpcErr.Code() != connect.CodeFailedPrecondition || len(rpcErr.Details()) != 1 {
			t.Fatalf("expected typed protocol rejection, got %v", err)
		}
		value, err := rpcErr.Details()[0].Value()
		if err != nil {
			t.Fatal(err)
		}
		detail, ok := value.(*secretaryv1.PersistenceError)
		if !ok || detail.Reason != secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_PROTOCOL_UPGRADE_REQUIRED {
			t.Fatalf("unexpected error detail: %v", value)
		}
	}
	for name, request := range map[string]*secretaryv1.SaveDocumentRequest{
		"legacy":                   {},
		"version":                  {ProtocolVersion: 2},
		"mutation":                 {MutationId: "07f6359a-9364-47fa-a07d-ef0b7b35c190"},
		"create revision presence": {ExpectedRevision: proto.Int64(0)},
		"update revision":          {ExpectedRevision: proto.Int64(9)},
		"versioned snapshot":       {Document: &secretaryv1.Document{Revision: 9}},
	} {
		t.Run("save/"+name, func(t *testing.T) {
			_, err := s.SaveDocument(ctx, connect.NewRequest(request))
			assertRejected(t, err)
		})
	}
	for name, request := range map[string]*secretaryv1.DeleteDocumentRequest{
		"legacy":            {},
		"version":           {ProtocolVersion: 2},
		"mutation":          {MutationId: "07f6359a-9364-47fa-a07d-ef0b7b35c190"},
		"revision presence": {ExpectedRevision: proto.Int64(0)},
		"scope":             {WorkspaceId: 4},
	} {
		t.Run("delete/"+name, func(t *testing.T) {
			_, err := s.DeleteDocument(ctx, connect.NewRequest(request))
			assertRejected(t, err)
		})
	}
	// V1 requests now reach the service's validation, never a legacy fallback.
	_, err := s.SaveDocument(ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{ProtocolVersion: 1}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("v1 save not activated: %v", err)
	}
	_, err = s.DeleteDocument(ctx, connect.NewRequest(&secretaryv1.DeleteDocumentRequest{ProtocolVersion: 1}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("v1 delete not activated: %v", err)
	}
	_, err = s.UpdateTodo(ctx, connect.NewRequest(&secretaryv1.UpdateTodoRequest{ProtocolVersion: 1}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("v1 TODO update not activated: %v", err)
	}
}

func TestExpectedRevisionJSONPresenceAndPrecision(t *testing.T) {
	for _, input := range []string{`{}`, `{"expectedRevision":"0"}`, `{"expectedRevision":"9007199254740993"}`} {
		var request secretaryv1.SaveDocumentRequest
		if err := protojson.Unmarshal([]byte(input), &request); err != nil {
			t.Fatal(err)
		}
		if (request.ExpectedRevision == nil) != (input == `{}`) {
			t.Fatalf("lost optional revision presence: %s", input)
		}
		encoded, err := protojson.Marshal(&request)
		if err != nil {
			t.Fatal(err)
		}
		var roundTrip secretaryv1.SaveDocumentRequest
		if err := protojson.Unmarshal(encoded, &roundTrip); err != nil || !proto.Equal(&request, &roundTrip) {
			t.Fatalf("revision did not round-trip: %s, %v", encoded, err)
		}
		if input == `{"expectedRevision":"9007199254740993"}` && request.GetExpectedRevision() != 9007199254740993 {
			t.Fatal("revision lost precision")
		}
	}
}
