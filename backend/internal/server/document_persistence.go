package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
)

// Application-service entry points shared by public v1 RPCs and internal writers.
func (s *Server) saveDocumentMutation(ctx context.Context, actor int64, req *secretaryv1.SaveDocumentRequest) (*secretaryv1.SaveDocumentResponse, error) {
	if req == nil || req.Document == nil {
		return nil, invalidIdentity("document is required")
	}
	d := req.Document
	mutation, err := validateMutationEnvelope(actor, d.WorkspaceId, req.ProtocolVersion, req.MutationId, req.ExpectedRevision, d.Id == 0)
	if err != nil {
		return nil, err
	}
	if err := validateSnapshotIdentities(d, nil); err != nil {
		return nil, err
	}
	if !validDocumentKind(d.Kind) {
		return nil, invalidIdentity("invalid document kind")
	}
	date, err := parseJournalDate(d.Kind, d.JournalDate)
	if err != nil {
		return nil, invalidIdentity(err.Error())
	}
	response := &secretaryv1.SaveDocumentResponse{}
	op := documentMutation{actor: int32(actor), workspace: int32(d.WorkspaceId), id: int32(d.Id), expected: *req.ExpectedRevision,
		mutation: mutation, name: "document.save", hash: saveFingerprint(actor, req)}
	err = s.runDocumentMutation(ctx, op, response, func(tx pgx.Tx, q *db.Queries, docs []db.Document) (string, error) {
		response.MutationId = req.MutationId
		response.Outcome = secretaryv1.DocumentSaveOutcome_DOCUMENT_SAVE_OUTCOME_APPLIED
		if err := validateDocumentDirectory(ctx, q, op.workspace, d.Kind, toNullInt4(d.DirectoryId)); err != nil {
			if connect.CodeOf(err) == connect.CodeInvalidArgument {
				return "", persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_DESTINATION, err.Error(), nil)
			}
			return "", err
		}
		creationKey := ""
		var saved db.Document
		if d.Id == 0 {
			creationKey = d.ClientKey
			_, err := q.GetDocumentByClientKey(ctx, db.GetDocumentByClientKeyParams{WorkspaceID: op.workspace, ClientKey: d.ClientKey})
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return "", err
			}
			reserved, reserveErr := q.DocumentCreationKeyReserved(ctx, db.DocumentCreationKeyReservedParams{ScopeID: op.workspace, CreationKey: pgtype.Text{String: d.ClientKey, Valid: true}})
			if reserveErr != nil {
				return "", reserveErr
			}
			if err == nil || reserved {
				return "", persistenceError(connect.CodeAlreadyExists, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_CREATION_KEY_EXISTS, "document creation key already used", nil)
			}
			if d.Kind == "journal" {
				existing, err := findWorkspaceJournalByDate(ctx, q, op.workspace, date)
				if err != nil {
					return "", err
				}
				if existing != nil {
					response.Document, err = s.loadDocumentSnapshot(ctx, q, *existing, true)
					response.Outcome = secretaryv1.DocumentSaveOutcome_DOCUMENT_SAVE_OUTCOME_EXISTING_JOURNAL
					return creationKey, err
				}
			}
		} else {
			for _, doc := range docs {
				if doc.ID == op.id {
					saved = doc
				}
			}
			if saved.ClientKey != d.ClientKey {
				return "", invalidIdentity("document ID and client key do not identify the same row")
			}
		}
		title := d.Title
		if d.Kind == "journal" && strings.TrimSpace(title) == "" {
			title = d.JournalDate
		}
		if d.Id == 0 {
			saved, err = q.CreateDocumentWithClientKey(ctx, db.CreateDocumentWithClientKeyParams{
				WorkspaceID: op.workspace, DirectoryID: toNullInt4(d.DirectoryId), Kind: d.Kind, Title: title, JournalDate: date, ClientKey: d.ClientKey,
			})
		} else {
			if d.Kind == "journal" {
				existing, err := findWorkspaceJournalByDate(ctx, q, op.workspace, date)
				if err != nil {
					return "", err
				}
				if existing != nil && existing.ID != op.id {
					return "", invalidIdentity("another journal already owns this date")
				}
			}
			saved, err = q.UpdateDocument(ctx, db.UpdateDocumentParams{ID: op.id, DirectoryID: toNullInt4(d.DirectoryId), Kind: d.Kind, Title: title, JournalDate: date})
		}
		if err != nil {
			return "", err
		}
		response.Document, err = s.persistDocumentBlocks(ctx, tx, saved, d, actor, true)
		if err != nil {
			return "", err
		}
		response.Effects, err = advanceMutationDocuments(ctx, q, docs, 0)
		if err != nil {
			return "", err
		}
		if d.Id == 0 {
			response.Effects.UpdatedDocuments = append(response.Effects.UpdatedDocuments, &secretaryv1.DocumentRevision{DocumentId: int64(saved.ID), Revision: 1})
		}
		saved, err = q.GetDocument(ctx, saved.ID)
		if err == nil {
			// This body was materialized under the same locks and transaction;
			// advancing its revision cannot change its blocks or TODO statuses.
			response.Document.Revision = saved.Revision
			response.Document.UpdatedAt = formatTime(saved.UpdatedAt)
		}
		return creationKey, err
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (s *Server) deleteDocumentMutation(ctx context.Context, actor int64, req *secretaryv1.DeleteDocumentRequest) (*secretaryv1.DeleteDocumentResponse, error) {
	if req == nil || !validDatabaseID(req.Id, false) {
		return nil, invalidIdentity("document ID must fit a positive database integer")
	}
	mutation, err := validateMutationEnvelope(actor, req.WorkspaceId, req.ProtocolVersion, req.MutationId, req.ExpectedRevision, false)
	if err != nil {
		return nil, err
	}
	response := &secretaryv1.DeleteDocumentResponse{}
	op := documentMutation{actor: int32(actor), workspace: int32(req.WorkspaceId), id: int32(req.Id), expected: *req.ExpectedRevision,
		mutation: mutation, name: "document.delete", deleting: true,
		hash: mutationFingerprint(actor, req.WorkspaceId, "document.delete", *req.ExpectedRevision, map[string]any{"id": strconv.FormatInt(req.Id, 10)})}
	err = s.runDocumentMutation(ctx, op, response, func(_ pgx.Tx, q *db.Queries, docs []db.Document) (string, error) {
		for _, doc := range docs {
			if doc.ID == op.id && doc.Kind != "note" {
				return "", connect.NewError(connect.CodeFailedPrecondition, errors.New("only notes can be deleted"))
			}
		}
		if err := q.DeleteDocument(ctx, op.id); err != nil {
			return "", err
		}
		response.MutationId = req.MutationId
		response.Effects, err = advanceMutationDocuments(ctx, q, docs, op.id)
		if err != nil {
			return "", err
		}
		response.Effects.DeletedDocumentIds = []int64{req.Id}
		return "", err
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

type documentMutation struct {
	authorize            func(*db.Queries) error
	actor, workspace, id int32
	expected             int64
	mutation             pgtype.UUID
	name                 string
	hash                 [32]byte
	deleting             bool
	userScoped           bool   // TODO commands on owned, unlinked TODOs only.
	creationKey          string // Internal AI creation reserves its durable document identity.
}

var errMutationDependenciesChanged = errors.New("document mutation dependencies changed")

type documentMutationApply func(pgx.Tx, *db.Queries, []db.Document) (string, error)

func (s *Server) runDocumentMutation(ctx context.Context, op documentMutation, response proto.Message, apply documentMutationApply) error {
	for attempt := 0; attempt < 3; attempt++ {
		proto.Reset(response)
		err := s.documentMutationAttempt(ctx, op, response, apply)
		var pgErr *pgconn.PgError
		retry := errors.Is(err, errMutationDependenciesChanged) || (errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01"))
		if retry && attempt < 2 {
			continue
		}
		if retry {
			return connect.NewError(connect.CodeUnavailable, errors.New("mutation contention; retry the same request"))
		}
		if err != nil {
			var ce *connect.Error
			if errors.As(err, &ce) {
				if ce.Code() == connect.CodeInvalidArgument && len(ce.Details()) == 0 {
					return persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_INVALID_TREE, ce.Message(), nil)
				}
				return err
			}
			return connect.NewError(connect.CodeInternal, fmt.Errorf("document transaction failed: %w", err))
		}
		return nil
	}
	panic("unreachable")
}

func (s *Server) documentMutationAttempt(ctx context.Context, op documentMutation, response proto.Message, apply documentMutationApply) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if err := s.ensureWorkspaceAccessWithQueries(ctx, q, op.workspace, op.actor); err != nil {
		return err
	}
	key := fmt.Sprintf("%d:workspace:%d:%x", op.actor, op.workspace, op.mutation.Bytes)
	if err := q.LockPersistenceReceipt(ctx, key); err != nil {
		return err
	}
	receipt, err := q.GetMutationReceipt(ctx, db.GetMutationReceiptParams{ActorUserID: op.actor, ScopeKind: "workspace", ScopeID: op.workspace, MutationID: op.mutation})
	if err == nil {
		return replayDocumentReceipt(receipt, op, response)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Discovery never authorizes through a foreign target's dependencies.
	if op.id != 0 {
		doc, err := q.GetDocument(ctx, op.id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && doc.WorkspaceID != op.workspace) {
			return persistenceError(connect.CodeNotFound, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_DOCUMENT_DELETED, "document not found in workspace", nil)
		}
		if err != nil {
			return err
		}
	}
	docs, todos, workspaces, err := discoverDocumentMutation(ctx, q, op)
	if err != nil {
		return err
	}
	for _, workspace := range workspaces {
		if err := q.LockPersistenceWorkspace(ctx, workspace); err != nil {
			return err
		}
		if err := s.ensureWorkspaceAccessWithQueries(ctx, q, workspace, op.actor); err != nil {
			return err
		}
	}
	currentDocs, currentTodos, currentWorkspaces, err := discoverDocumentMutation(ctx, q, op)
	if err != nil {
		return err
	}
	if !slices.Equal(workspaces, currentWorkspaces) || !slices.Equal(todos, currentTodos) || !sameDocumentDependencies(docs, currentDocs) {
		return errMutationDependenciesChanged
	}
	docs = currentDocs
	found := op.id == 0
	for i, doc := range docs {
		docs[i], err = q.LockDocumentForPersistence(ctx, db.LockDocumentForPersistenceParams{WorkspaceID: doc.WorkspaceID, ID: doc.ID})
		if err != nil {
			return err
		}
		if doc.ID == op.id {
			found = true
			if docs[i].Revision != op.expected {
				return persistenceError(connect.CodeAborted, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_REVISION_CONFLICT, "document changed since the submitted baseline", &docs[i])
			}
		}
	}
	if !found {
		return persistenceError(connect.CodeNotFound, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_DOCUMENT_DELETED, "document no longer exists", nil)
	}
	if err := q.LockPersistenceTodos(ctx, todos); err != nil {
		return err
	}
	creationKey, err := apply(tx, q, docs)
	if err != nil {
		return err
	}
	payload, err := proto.Marshal(response)
	if err != nil {
		return err
	}
	targets := []int64{}
	var effects *secretaryv1.DocumentMutationEffects
	switch result := response.(type) {
	case *secretaryv1.SaveDocumentResponse:
		targets = append(targets, result.Document.Id)
		effects = result.Effects
	case *secretaryv1.DeleteDocumentResponse:
		targets = append(targets, result.Effects.DeletedDocumentIds...)
		effects = result.Effects
	}
	for _, updated := range effects.GetUpdatedDocuments() {
		targets = append(targets, updated.DocumentId)
	}
	slices.Sort(targets)
	targets = slices.Compact(targets)
	_, err = q.CreateMutationReceipt(ctx, db.CreateMutationReceiptParams{ActorUserID: op.actor, ScopeKind: "workspace", ScopeID: op.workspace,
		MutationID: op.mutation, ProtocolVersion: 1, Operation: op.name, PayloadSha256: op.hash[:], TargetIds: targets,
		CreationKey: pgtype.Text{String: creationKey, Valid: creationKey != ""}, ResultType: string(response.ProtoReflect().Descriptor().FullName()), ResultVersion: 1, ResultPayload: payload})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func replayDocumentReceipt(receipt db.MutationReceipt, op documentMutation, response proto.Message) error {
	if receipt.Operation != op.name || receipt.ProtocolVersion != 1 || !bytes.Equal(receipt.PayloadSha256, op.hash[:]) {
		return persistenceError(connect.CodeInvalidArgument, secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_MUTATION_ID_REUSED, "mutation ID already used for different input", nil)
	}
	if receipt.ResultVersion != 1 || receipt.ResultType != string(response.ProtoReflect().Descriptor().FullName()) {
		return persistenceProtocolNotEnabled()
	}
	return proto.Unmarshal(receipt.ResultPayload, response)
}

func discoverDocumentMutation(ctx context.Context, q *db.Queries, op documentMutation) ([]db.Document, []int32, []int32, error) {
	todos, err := q.ListDocumentMutationTodos(ctx, db.ListDocumentMutationTodosParams{DocumentID: op.id, Deleting: op.deleting})
	if err != nil {
		return nil, nil, nil, err
	}
	ids := make([]int32, 0, len(todos))
	workspaces := []int32{op.workspace}
	for _, todo := range todos {
		ids = append(ids, todo.ID)
		if todo.WorkspaceID.Valid {
			workspaces = append(workspaces, todo.WorkspaceID.Int32)
		}
	}
	docs, err := q.ListTodoDocumentDependencies(ctx, db.ListTodoDocumentDependenciesParams{DocumentID: op.id, TodoIds: ids})
	for _, doc := range docs {
		workspaces = append(workspaces, doc.WorkspaceID)
	}
	slices.Sort(workspaces)
	return docs, ids, slices.Compact(workspaces), err
}

func sameDocumentDependencies(a, b []db.Document) bool {
	return slices.EqualFunc(a, b, func(a, b db.Document) bool { return a.ID == b.ID && a.WorkspaceID == b.WorkspaceID })
}

func advanceMutationDocuments(ctx context.Context, q *db.Queries, docs []db.Document, deleted int32) (*secretaryv1.DocumentMutationEffects, error) {
	effects := &secretaryv1.DocumentMutationEffects{}
	for _, doc := range docs {
		if doc.ID == deleted {
			continue
		}
		updated, err := q.AdvanceDocumentRevision(ctx, db.AdvanceDocumentRevisionParams{WorkspaceID: doc.WorkspaceID, ID: doc.ID, ExpectedRevision: doc.Revision})
		if err != nil {
			return nil, err
		}
		effects.UpdatedDocuments = append(effects.UpdatedDocuments, &secretaryv1.DocumentRevision{DocumentId: int64(doc.ID), Revision: updated.Revision})
	}
	return effects, nil
}

func (s *Server) loadDocumentSnapshot(ctx context.Context, q *db.Queries, doc db.Document, versioned bool) (*secretaryv1.Document, error) {
	blocks, err := q.ListBlocksByDocument(ctx, doc.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load document blocks: %w", err))
	}
	statuses, err := s.loadBlockTodoStatuses(ctx, q, blocks)
	if err != nil {
		return nil, err
	}
	if versioned {
		return versionedDocumentToProto(doc, blocks, statuses), nil
	}
	return documentToProto(doc, blocks, statuses, nil), nil
}

func versionedDocumentToProto(doc db.Document, blocks []db.Block, statuses map[int32]string) *secretaryv1.Document {
	keys := make(map[int32]string, len(blocks))
	for _, block := range blocks {
		keys[block.ID] = block.ClientKey
	}
	result := documentToProto(doc, blocks, statuses, keys)
	result.ClientKey, result.Revision = doc.ClientKey, doc.Revision
	for _, block := range result.Blocks {
		block.ParentClientKey = keys[int32(block.ParentBlockId)]
	}
	return result
}
