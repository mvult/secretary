package server

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
)

func persistenceError(code connect.Code, reason secretaryv1.PersistenceErrorReason, message string, doc *db.Document) *connect.Error {
	err := connect.NewError(code, errors.New(message))
	detail := &secretaryv1.PersistenceError{Reason: reason}
	if doc != nil {
		detail.DocumentId, detail.CurrentRevision = int64(doc.ID), &doc.Revision
	}
	if encoded, e := connect.NewErrorDetail(detail); e == nil {
		err.AddDetail(encoded)
	}
	return err
}

func invalidIdentity(message string) error {
	return persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_IDENTITY, message, nil)
}

func validDatabaseID(id int64, optional bool) bool {
	return (id > 0 || (optional && id == 0)) && id <= math.MaxInt32
}

func validateMutationEnvelope(actor, workspace int64, version uint32, mutation string, expected *int64, creating bool) (pgtype.UUID, error) {
	if version != 1 {
		return pgtype.UUID{}, persistenceProtocolNotEnabled()
	}
	id, err := uuid.Parse(mutation)
	// Require one representation so a replay also echoes exactly the same UUID.
	if err != nil || id == uuid.Nil || id.String() != mutation {
		return pgtype.UUID{}, invalidIdentity("mutation_id must be a canonical nonzero UUID")
	}
	if !validDatabaseID(actor, false) || !validDatabaseID(workspace, false) {
		return pgtype.UUID{}, invalidIdentity("actor and workspace IDs must fit positive database integers")
	}
	if expected == nil || (creating && *expected != 0) || (!creating && *expected <= 0) {
		return pgtype.UUID{}, invalidIdentity("expected_revision must be present: zero for creation, positive for update/delete")
	}
	return pgtype.UUID{Bytes: id, Valid: true}, nil
}

// Fingerprint v1 intentionally uses explicit maps: encoding/json sorts map keys
// recursively. IDs/revisions are decimal strings; writable defaults are included.
// Do not change this representation when adding future protocol versions.
func mutationFingerprint(actor, workspace int64, operation string, expected int64, payload map[string]any) [32]byte {
	encoded, err := json.Marshal(map[string]any{
		"fingerprint_version": 1, "protocol_version": 1, "operation": operation,
		"actor_user_id": strconv.FormatInt(actor, 10), "scope_kind": "workspace",
		"scope_id": strconv.FormatInt(workspace, 10), "expected_revision": strconv.FormatInt(expected, 10), "payload": payload,
	})
	if err != nil {
		panic(err) // Only the fixed JSON-compatible values constructed below enter this function.
	}
	return sha256.Sum256(encoded)
}

func saveFingerprint(actor int64, req *secretaryv1.SaveDocumentRequest) [32]byte {
	d := req.Document
	blocks := make([]any, 0, len(d.Blocks))
	for _, b := range d.Blocks {
		blocks = append(blocks, map[string]any{
			"id": strconv.FormatInt(b.Id, 10), "client_key": b.ClientKey,
			"parent_block_id": strconv.FormatInt(b.ParentBlockId, 10), "parent_client_key": b.ParentClientKey,
			"sort_order": b.SortOrder, "text": b.Text, "todo_status": b.TodoStatus,
		})
	}
	return mutationFingerprint(actor, d.WorkspaceId, "document.save", *req.ExpectedRevision, map[string]any{
		"id": strconv.FormatInt(d.Id, 10), "client_key": d.ClientKey,
		"directory_id": strconv.FormatInt(d.DirectoryId, 10), "kind": d.Kind,
		"title": d.Title, "journal_date": d.JournalDate, "blocks": blocks,
	})
}

// Validate the submitted tree independently of database state, then check its
// immutable key/ID pairs against the locked snapshot. Parent-before-child does
// not require descendants to be contiguous in the visible outline.
func validateSnapshotIdentities(d *secretaryv1.Document, existing []db.Block) error {
	if !validDatabaseID(d.Id, true) || !validDatabaseID(d.DirectoryId, true) || strings.TrimSpace(d.ClientKey) == "" {
		return invalidIdentity("document identity or directory ID is invalid")
	}
	byID := make(map[int64]string, len(existing))
	byKey := make(map[string]int64, len(existing))
	for _, b := range existing {
		byID[int64(b.ID)], byKey[b.ClientKey] = b.ClientKey, int64(b.ID)
	}
	seenKeys := map[string]*secretaryv1.Block{}
	seenIDs := map[int64]*secretaryv1.Block{}
	var lastOrder int32
	treeError := func(message string) error {
		return persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_TREE, message, nil)
	}
	for _, b := range d.Blocks {
		if b == nil || !validDatabaseID(b.Id, true) || (d.Id == 0 && b.Id != 0) || !validDatabaseID(b.ParentBlockId, true) || strings.TrimSpace(b.ClientKey) == "" {
			return invalidIdentity("block identity is invalid")
		}
		if seenKeys[b.ClientKey] != nil || (b.Id != 0 && seenIDs[b.Id] != nil) {
			return invalidIdentity("duplicate block ID or client key")
		}
		if existing != nil {
			if (b.Id != 0 && byID[b.Id] != b.ClientKey) || (b.Id == 0 && byKey[b.ClientKey] != 0) {
				return invalidIdentity("block ID and immutable client key must identify the same existing row")
			}
		}
		if err := validateBlockMessage(b); err != nil {
			return treeError(err.Error())
		}
		// Reads order globally by sort_order, as do native snapshot saves. Accepting
		// sibling-only numbering could silently reorder the visible submitted rows.
		if b.SortOrder <= lastOrder {
			return treeError("sort_order must increase in submitted visible order")
		}
		lastOrder = b.SortOrder
		var parent *secretaryv1.Block
		if b.ParentBlockId != 0 {
			parent = seenIDs[b.ParentBlockId]
			if parent == nil || (b.ParentClientKey != "" && parent.ClientKey != b.ParentClientKey) {
				return treeError("parent ID/key must match a retained preceding block")
			}
		} else if b.ParentClientKey != "" {
			parent = seenKeys[b.ParentClientKey]
			if parent == nil {
				return treeError("parent key must identify a retained preceding block")
			}
		}
		seenKeys[b.ClientKey] = b
		if b.Id != 0 {
			seenIDs[b.Id] = b
		}
	}
	return nil
}
