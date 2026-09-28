package server

import (
	"context"
	"math"
	"testing"
	"time"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

const commandTestID = "07f6359a-9364-47fa-a07d-ef0b7b35c190"

func TestTodoCommandContextGuards(t *testing.T) {
	s := &Server{}
	_, err := s.GetTodoCommandContext(context.Background(), connect.NewRequest(&secretaryv1.GetTodoCommandContextRequest{WorkspaceId: 1}))
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected authentication rejection: %v", err)
	}
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	for _, id := range []int64{0, -1, math.MaxInt32 + 1} {
		_, err := s.GetTodoCommandContext(ctx, connect.NewRequest(&secretaryv1.GetTodoCommandContextRequest{WorkspaceId: id}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("invalid workspace reached database: %v", err)
		}
	}
}

func TestTodoCommandPublicGates(t *testing.T) {
	s := &Server{} // Unsupported or partial envelopes must not reach the database.
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	check := func(err error) {
		t.Helper()
		if connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatalf("expected protocol gate, got %v", err)
		}
		detail, e := err.(*connect.Error).Details()[0].Value()
		if e != nil || detail.(*secretaryv1.PersistenceError).Reason != secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_PROTOCOL_UPGRADE_REQUIRED {
			t.Fatalf("wrong typed detail: %v", detail)
		}
	}
	for _, req := range []*secretaryv1.MoveDocumentTodosToRepositoryRequest{{}, {ProtocolVersion: 2}, {MutationId: commandTestID}, {WorkspaceId: 1}} {
		_, err := s.MoveDocumentTodosToRepository(ctx, connect.NewRequest(req))
		check(err)
	}
	for _, req := range []*secretaryv1.PullOnDeckTodosToTodayRequest{{}, {ProtocolVersion: 2}, {MutationId: commandTestID}, {JournalDate: "2026-09-26"}} {
		_, err := s.PullOnDeckTodosToToday(ctx, connect.NewRequest(req))
		check(err)
	}
	for _, id := range []int64{0, -1, math.MaxInt32 + 1} {
		_, err := s.MoveDocumentTodosToRepository(ctx, connect.NewRequest(&secretaryv1.MoveDocumentTodosToRepositoryRequest{ProtocolVersion: 1, DocumentId: id}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("move ID validation: %v", err)
		}
		_, err = s.PullOnDeckTodosToToday(ctx, connect.NewRequest(&secretaryv1.PullOnDeckTodosToTodayRequest{ProtocolVersion: 1, WorkspaceId: id, JournalDate: "2026-09-28"}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("pull ID validation: %v", err)
		}
	}
}

func TestCommandEnvelopeAndFingerprint(t *testing.T) {
	makeOp := func(actor, workspace int64, name, date string) documentMutation {
		t.Helper()
		op, err := commandEnvelope(actor, workspace, 1, commandTestID, name, map[string]any{"journal_date": date})
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	first := makeOp(1, 2, "todo.pull_on_deck", "2026-09-26")
	if again := makeOp(1, 2, "todo.pull_on_deck", "2026-09-26"); first.hash != again.hash || first.mutation != again.mutation {
		t.Fatal("unstable command identity")
	}
	for _, changed := range []documentMutation{makeOp(2, 2, "todo.pull_on_deck", "2026-09-26"), makeOp(1, 3, "todo.pull_on_deck", "2026-09-26"), makeOp(1, 2, "todo.move_to_repository", "2026-09-26"), makeOp(1, 2, "todo.pull_on_deck", "2026-09-27")} {
		if first.hash == changed.hash {
			t.Fatal("fingerprint ignored command scope/intent")
		}
	}
	for _, id := range []string{"", "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		if _, err := commandEnvelope(1, 2, 1, id, "todo.pull_on_deck", nil); err == nil {
			t.Fatalf("accepted mutation ID %q", id)
		}
	}
	if _, err := commandEnvelope(1, 2, 0, commandTestID, "todo.pull_on_deck", nil); err == nil {
		t.Fatal("partial legacy envelope accepted")
	}
}

func TestPullCommandDateIsRetainedAcrossMidnight(t *testing.T) {
	before := time.Date(2026, 9, 26, 23, 59, 0, 0, time.FixedZone("owner", -7*3600))
	req := &secretaryv1.PullOnDeckTodosToTodayRequest{ProtocolVersion: 1, MutationId: commandTestID, JournalDate: "2026-09-26"}
	for _, now := range []time.Time{before, before.Add(48 * time.Hour)} {
		date, err := pullCommandDate(req, now)
		if err != nil || date.Format(time.DateOnly) != req.JournalDate {
			t.Fatalf("pull changed date on replay: %v", err)
		}
	}
	for _, date := range []string{"", "2026-02-30", "2026-9-26", "2026-09-26T00:00:00Z", "0000-01-01"} {
		req.JournalDate = date
		if _, err := pullCommandDate(req, before); err == nil {
			t.Fatalf("accepted noncanonical date %q", date)
		}
	}
	date, err := pullCommandDate(&secretaryv1.PullOnDeckTodosToTodayRequest{}, before)
	if err != nil || date.Format(time.DateOnly) != "2026-09-26" {
		t.Fatal("legacy server-local today changed")
	}
}

func TestCommandReceiptReplaysHistoricalResultAndRejectsDifferentIntent(t *testing.T) {
	op, err := commandEnvelope(1, 2, 1, commandTestID, "todo.move_to_repository", map[string]any{"document_id": "3"})
	if err != nil {
		t.Fatal(err)
	}
	original := &secretaryv1.MoveDocumentTodosToRepositoryResponse{MovedCount: 7, MutationId: commandTestID,
		Effects: &secretaryv1.DocumentMutationEffects{UpdatedDocuments: []*secretaryv1.DocumentRevision{{DocumentId: 3, Revision: 9007199254740993}}}}
	payload, err := proto.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	receipt := db.MutationReceipt{Operation: op.name, ProtocolVersion: 1, PayloadSha256: op.hash[:], ResultType: string(original.ProtoReflect().Descriptor().FullName()), ResultVersion: 1, ResultPayload: payload}
	result := &secretaryv1.MoveDocumentTodosToRepositoryResponse{}
	if err := replayDocumentReceipt(receipt, op, result); err != nil || !proto.Equal(original, result) {
		t.Fatalf("historical result changed: %v", err)
	}
	changed, _ := commandEnvelope(1, 2, 1, commandTestID, op.name, map[string]any{"document_id": "4"})
	if err := replayDocumentReceipt(receipt, changed, result); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("different intent reused receipt: %v", err)
	}
	if err := replayDocumentReceipt(receipt, op, &secretaryv1.PullOnDeckTodosToTodayResponse{}); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("wrong response type accepted: %v", err)
	}
}
