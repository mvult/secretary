package server

import (
	"crypto/sha256"
	"math"
	"testing"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func fingerprintFixture() *secretaryv1.SaveDocumentRequest {
	return &secretaryv1.SaveDocumentRequest{ProtocolVersion: 1, MutationId: "07f6359a-9364-47fa-a07d-ef0b7b35c190", ExpectedRevision: proto.Int64(0),
		Document: &secretaryv1.Document{WorkspaceId: 4, ClientKey: "note-new", Kind: "note", Title: " Title ",
			Blocks: []*secretaryv1.Block{{ClientKey: "block-new", SortOrder: 1, Text: "  Café\n"}}}}
}

func TestSaveFingerprintV1Contract(t *testing.T) {
	req := fingerprintFixture()
	canonical := `{"actor_user_id":"7","expected_revision":"0","fingerprint_version":1,"operation":"document.save","payload":{"blocks":[{"client_key":"block-new","id":"0","parent_block_id":"0","parent_client_key":"","sort_order":1,"text":"  Café\n","todo_status":""}],"client_key":"note-new","directory_id":"0","id":"0","journal_date":"","kind":"note","title":" Title "},"protocol_version":1,"scope_id":"4","scope_kind":"workspace"}`
	want := sha256.Sum256([]byte(canonical))
	if got := saveFingerprint(7, req); got != want {
		t.Fatalf("fingerprint v1 drift: %x != %x", got, want)
	}
	var decoded secretaryv1.SaveDocumentRequest
	// Different JSON field order, explicit defaults, and server-owned fields.
	if err := protojson.Unmarshal([]byte(`{"document":{"title":" Title ","id":"0","kind":"note","clientKey":"note-new","workspaceId":4,"createdAt":"ignored","revision":"99","blocks":[{"text":"  Café\n","todoId":"42","documentId":"99","clientKey":"block-new","sortOrder":1,"todoStatus":"","parentBlockId":"0"}]},"mutationId":"another-id","expectedRevision":0,"protocolVersion":1}`), &decoded); err != nil {
		t.Fatal(err)
	}
	if saveFingerprint(7, &decoded) != want {
		t.Fatal("JSON order/defaults or server-owned fields changed the fingerprint")
	}
	for name, mutate := range map[string]func(*secretaryv1.SaveDocumentRequest){
		"text bytes":    func(r *secretaryv1.SaveDocumentRequest) { r.Document.Blocks[0].Text += " " },
		"Unicode bytes": func(r *secretaryv1.SaveDocumentRequest) { r.Document.Blocks[0].Text = "  Cafe\u0301\n" },
		"title":         func(r *secretaryv1.SaveDocumentRequest) { r.Document.Title += " " },
		"parent":        func(r *secretaryv1.SaveDocumentRequest) { r.Document.Blocks[0].ParentClientKey = "parent" },
		"scope":         func(r *secretaryv1.SaveDocumentRequest) { r.Document.WorkspaceId++ },
		"revision":      func(r *secretaryv1.SaveDocumentRequest) { r.ExpectedRevision = proto.Int64(9007199254740993) },
		"identity":      func(r *secretaryv1.SaveDocumentRequest) { r.Document.ClientKey += "-new" },
	} {
		t.Run(name, func(t *testing.T) {
			other := proto.Clone(req).(*secretaryv1.SaveDocumentRequest)
			mutate(other)
			if saveFingerprint(7, other) == want {
				t.Fatal("different writable input hashed identically")
			}
		})
	}
	if saveFingerprint(8, req) == want {
		t.Fatal("actor omitted")
	}
	req.ExpectedRevision = proto.Int64(9007199254740992)
	a := saveFingerprint(7, req)
	req.ExpectedRevision = proto.Int64(9007199254740993)
	if saveFingerprint(7, req) == a {
		t.Fatal("revision rounded to JavaScript precision")
	}
	req.Document.Blocks = append(req.Document.Blocks, &secretaryv1.Block{ClientKey: "second", SortOrder: 2})
	a = saveFingerprint(7, req)
	req.Document.Blocks[0], req.Document.Blocks[1] = req.Document.Blocks[1], req.Document.Blocks[0]
	if saveFingerprint(7, req) == a {
		t.Fatal("submitted order omitted")
	}
}

func TestSnapshotIdentityValidation(t *testing.T) {
	existing := []db.Block{{ID: 10, ClientKey: "parent"}, {ID: 11, ClientKey: "child"}}
	valid := &secretaryv1.Document{Id: 1, ClientKey: "doc", Blocks: []*secretaryv1.Block{
		{Id: 10, ClientKey: "parent", SortOrder: 1},
		{ClientKey: "new-root", SortOrder: 2},
		{Id: 11, ClientKey: "child", ParentBlockId: 10, ParentClientKey: "parent", SortOrder: 3},
	}}
	if err := validateSnapshotIdentities(valid, existing); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*secretaryv1.Document){
		"foreign block":           func(d *secretaryv1.Document) { d.Blocks[2].Id = 42 },
		"key mismatch":            func(d *secretaryv1.Document) { d.Blocks[2].ClientKey = "changed" },
		"key reused as create":    func(d *secretaryv1.Document) { d.Blocks[2].Id = 0 },
		"duplicate key":           func(d *secretaryv1.Document) { d.Blocks[1].ClientKey = "parent" },
		"duplicate ID":            func(d *secretaryv1.Document) { d.Blocks[1].Id = 10 },
		"overflow":                func(d *secretaryv1.Document) { d.Blocks[1].Id = math.MaxInt32 + 1 },
		"negative ID":             func(d *secretaryv1.Document) { d.Blocks[1].Id = -1 },
		"conflicting parent":      func(d *secretaryv1.Document) { d.Blocks[2].ParentClientKey = "new-root" },
		"missing retained parent": func(d *secretaryv1.Document) { d.Blocks = d.Blocks[1:] },
		"self parent":             func(d *secretaryv1.Document) { d.Blocks[1].ParentClientKey = "new-root" },
		"duplicate sibling order": func(d *secretaryv1.Document) { d.Blocks[1].SortOrder = 1 },
		"sibling-only numbering reorders visible rows": func(d *secretaryv1.Document) { d.Blocks[2].SortOrder = 1 },
		"child first": func(d *secretaryv1.Document) { d.Blocks[0], d.Blocks[2] = d.Blocks[2], d.Blocks[0] },
		"nil block":   func(d *secretaryv1.Document) { d.Blocks[0] = nil },
	} {
		t.Run(name, func(t *testing.T) {
			d := proto.Clone(valid).(*secretaryv1.Document)
			mutate(d)
			if err := validateSnapshotIdentities(d, existing); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("expected validation rejection, got %v", err)
			}
		})
	}
	if err := validateSnapshotIdentities(valid, []db.Block{}); err == nil {
		t.Fatal("nonexistent IDs allowed in an empty document")
	}
}

func TestReceiptReplayIsTypedAndImmutable(t *testing.T) {
	op := documentMutation{name: "document.save", hash: saveFingerprint(7, fingerprintFixture())}
	want := &secretaryv1.SaveDocumentResponse{Document: &secretaryv1.Document{Id: 42, Revision: 9, ClientKey: "saved-key"}, MutationId: "original"}
	payload, err := proto.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	receipt := db.MutationReceipt{Operation: op.name, ProtocolVersion: 1, PayloadSha256: op.hash[:], ResultType: "secretary.v1.SaveDocumentResponse", ResultVersion: 1, ResultPayload: payload}
	got := &secretaryv1.SaveDocumentResponse{}
	if err := replayDocumentReceipt(receipt, op, got); err != nil || !proto.Equal(want, got) {
		t.Fatalf("replay changed acknowledgment: %v", err)
	}
	changed := op
	changed.hash[0] ^= 1
	if err := replayDocumentReceipt(receipt, changed, got); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("accepted changed payload: %v", err)
	}
	changed = op
	changed.name = "document.delete"
	if err := replayDocumentReceipt(receipt, changed, got); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("accepted changed operation: %v", err)
	}
	receipt.ResultVersion++
	if err := replayDocumentReceipt(receipt, op, got); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("decoded unknown receipt version: %v", err)
	}
}

func TestMutationEnvelopeRejectsTruncationAndMissingPreconditions(t *testing.T) {
	id := fingerprintFixture().MutationId
	for _, expected := range []*int64{nil, proto.Int64(-1), proto.Int64(0)} {
		if _, err := validateMutationEnvelope(7, 4, 1, id, expected, false); err == nil {
			t.Fatal("accepted missing/nonpositive update precondition")
		}
	}
	for _, workspace := range []int64{-1, 0, math.MaxInt32 + 1} {
		if _, err := validateMutationEnvelope(7, workspace, 1, id, proto.Int64(0), true); err == nil {
			t.Fatal("accepted invalid scope")
		}
	}
	if _, err := validateMutationEnvelope(7, 4, 1, id, proto.Int64(0), true); err != nil {
		t.Fatal(err)
	}
}
