package server

import (
	"context"
	"testing"

	db "github.com/mvult/secretary/backend/internal/db/gen"
	"github.com/mvult/secretary/backend/internal/server/agent"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

func TestAICallIdentityAndRetainedBytes(t *testing.T) {
	call := agent.MutationCall{RunID: 100, UserID: 1, WorkspaceID: 2, CallID: "call_abc", Name: "insert_block", Arguments: "{\n\"document_id\":7,\"text\":\"  raw text  \"}"}
	first, err := aiCallEnvelope(call, "apply")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := aiCallEnvelope(call, "apply")
	if first.mutation != again.mutation || first.hash != again.hash {
		t.Fatal("call identity changed on retry")
	}
	prepared, _ := aiCallEnvelope(call, "prepare")
	if first.mutation == prepared.mutation {
		t.Fatal("intent and domain receipts collide")
	}
	for _, change := range []func(*agent.MutationCall){
		func(c *agent.MutationCall) { c.Arguments += " " },
		func(c *agent.MutationCall) { c.Name = "move_block" },
	} {
		changed := call
		change(&changed)
		op, _ := aiCallEnvelope(changed, "apply")
		if op.mutation != first.mutation || op.hash == first.hash {
			t.Fatal("changed intent did not reuse identity with different fingerprint")
		}
	}
	for _, change := range []func(*agent.MutationCall){
		func(c *agent.MutationCall) { c.RunID++ },
		func(c *agent.MutationCall) { c.CallID += "2" },
	} {
		changed := call
		change(&changed)
		op, _ := aiCallEnvelope(changed, "apply")
		if op.mutation == first.mutation {
			t.Fatal("independent calls collide")
		}
	}
	retained, _ := structpb.NewStruct(map[string]any{"arguments": call.Arguments})
	encoded, _ := proto.Marshal(retained)
	receipt := db.MutationReceipt{ProtocolVersion: 1, Operation: prepared.name, PayloadSha256: prepared.hash[:], ResultType: "google.protobuf.Struct", ResultVersion: 1, ResultPayload: encoded}
	response := &structpb.Struct{}
	if err := replayDocumentReceipt(receipt, prepared, response); err != nil {
		t.Fatal(err)
	}
	if response.Fields["arguments"].GetStringValue() != call.Arguments {
		t.Fatal("retained arguments were normalized")
	}
	changed := call
	changed.Arguments += " "
	op, _ := aiCallEnvelope(changed, "prepare")
	if err := replayDocumentReceipt(receipt, op, response); err == nil {
		t.Fatal("reused provider ID accepted different bytes")
	}
}

func TestAIMutationRejectsMissingIdentityBeforeStorage(t *testing.T) {
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	for _, call := range []agent.MutationCall{
		{}, {RunID: 1, UserID: 2, WorkspaceID: 1, CallID: "a"},
		{RunID: 1, UserID: 1, WorkspaceID: 1, CallID: " "},
		{RunID: 1, UserID: 1, WorkspaceID: 1, CallID: "a", Name: "other", Arguments: `{}`},
	} {
		if _, err := (&Server{}).executeAIMutationCall(ctx, call); err == nil {
			t.Fatalf("accepted incomplete call: %+v", call)
		}
	}
}

func TestAIMutationArgumentValidation(t *testing.T) {
	for _, call := range []agent.MutationCall{
		{Name: "insert_block", Arguments: `{"document_id":4294967297,"text":"x"}`},
		{Name: "insert_block", Arguments: `{"document_id":1,"text":" "}`},
		{Name: "move_block", Arguments: `{"block_id":1,"parent_block_id":-1}`},
		{Name: "move_block", Arguments: `{"block_id":1} {}`},
		{Name: "create_document", Arguments: `{"title":" System "}`},
		{Name: "create_document", Arguments: `{"title":"OK","unexpected":true}`},
	} {
		if _, err := parseAIMutation(call); err == nil {
			t.Fatalf("accepted invalid arguments: %+v", call)
		}
	}
	call := agent.MutationCall{RunID: 1, UserID: 1, WorkspaceID: 1, CallID: "create", Name: "create_document", Arguments: `{"title":"Note","content":"a\n  b"}`}
	if _, err := parseAIMutation(call); err != nil {
		t.Fatal(err)
	}
	op, err := aiCallEnvelope(call, "apply")
	if err != nil || op.name != "document.save" {
		t.Fatalf("creation must reserve document identity: %v %v", op, err)
	}
}
