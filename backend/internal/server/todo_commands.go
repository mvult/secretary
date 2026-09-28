package server

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

func (s *Server) GetTodoCommandContext(ctx context.Context, req *connect.Request[secretaryv1.GetTodoCommandContextRequest]) (*connect.Response[secretaryv1.GetTodoCommandContextResponse], error) {
	actor, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if !validDatabaseID(actor, false) || !validDatabaseID(req.Msg.WorkspaceId, false) {
		return nil, invalidIdentity("invalid actor or workspace ID")
	}
	if err := s.ensureWorkspaceAccessWithQueries(ctx, s.queries, int32(req.Msg.WorkspaceId), int32(actor)); err != nil {
		return nil, err
	}
	return connect.NewResponse(&secretaryv1.GetTodoCommandContextResponse{JournalDate: time.Now().Format(time.DateOnly)}), nil
}

// Commands act on current state under writer locks, not a submitted snapshot.
// They use the same receipt namespace as saves/deletes so mutation IDs cannot
// be reused across operations. Public entry points require v1 envelopes.
func commandEnvelope(actor, workspace int64, version uint32, mutation, name string, payload map[string]any) (documentMutation, error) {
	if !validDatabaseID(actor, false) || !validDatabaseID(workspace, false) {
		return documentMutation{}, invalidIdentity("invalid actor or workspace ID")
	}
	if version == 0 && mutation == "" {
		return documentMutation{actor: int32(actor), workspace: int32(workspace), name: name}, nil
	}
	zero := int64(0) // Commands have no client expected_revision; fingerprint v1 uses zero.
	id, err := validateMutationEnvelope(actor, workspace, version, mutation, &zero, true)
	if err != nil {
		return documentMutation{}, err
	}
	return documentMutation{actor: int32(actor), workspace: int32(workspace), mutation: id, name: name,
		hash: mutationFingerprint(actor, workspace, name, 0, payload)}, nil
}

func pullCommandDate(req *secretaryv1.PullOnDeckTodosToTodayRequest, now time.Time) (time.Time, error) {
	if req.ProtocolVersion == 0 && req.MutationId == "" && req.JournalDate == "" {
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()), nil
	}
	date, err := time.Parse(time.DateOnly, req.JournalDate)
	if err != nil || date.Year() < 1 || date.Format(time.DateOnly) != req.JournalDate {
		return time.Time{}, invalidIdentity("journal_date must be an explicit YYYY-MM-DD date for a versioned pull")
	}
	if req.ProtocolVersion == 0 {
		return time.Time{}, persistenceProtocolNotEnabled()
	}
	return date, nil
}

func (s *Server) moveDocumentTodosCommand(ctx context.Context, actor int64, req *secretaryv1.MoveDocumentTodosToRepositoryRequest) (*secretaryv1.MoveDocumentTodosToRepositoryResponse, error) {
	if req == nil || !validDatabaseID(actor, false) || !validDatabaseID(req.DocumentId, false) {
		return nil, invalidIdentity("invalid actor or document ID")
	}
	workspace := req.WorkspaceId
	legacy := req.ProtocolVersion == 0 && req.MutationId == "" && workspace == 0
	// Legacy requests predate workspace envelopes. The document's workspace is
	// resolved only for that path; v1 replay must work even after target deletion.
	if legacy {
		doc, err := s.queries.GetDocument(ctx, int32(req.DocumentId))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
		}
		if err != nil {
			return nil, err
		}
		workspace = int64(doc.WorkspaceID)
	} else if req.ProtocolVersion == 0 {
		return nil, persistenceProtocolNotEnabled()
	}
	op, err := commandEnvelope(actor, workspace, req.ProtocolVersion, req.MutationId, "todo.move_to_repository", map[string]any{"document_id": strconv.FormatInt(req.DocumentId, 10)})
	if err != nil {
		return nil, err
	}
	op.id = int32(req.DocumentId)
	response := &secretaryv1.MoveDocumentTodosToRepositoryResponse{}
	err = s.runTodoCommand(ctx, op, response, func(q *db.Queries) error {
		result, err := s.applyRepositoryMove(ctx, q, actor, req)
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

func (s *Server) pullOnDeckTodosCommand(ctx context.Context, actor int64, req *secretaryv1.PullOnDeckTodosToTodayRequest) (*secretaryv1.PullOnDeckTodosToTodayResponse, error) {
	if req == nil {
		return nil, invalidIdentity("pull request is required")
	}
	date, err := pullCommandDate(req, time.Now())
	if err != nil {
		return nil, err
	}
	op, err := commandEnvelope(actor, req.WorkspaceId, req.ProtocolVersion, req.MutationId, "todo.pull_on_deck", map[string]any{"journal_date": date.Format(time.DateOnly)})
	if err != nil {
		return nil, err
	}
	response := &secretaryv1.PullOnDeckTodosToTodayResponse{}
	err = s.runTodoCommand(ctx, op, response, func(q *db.Queries) error {
		result, err := s.applyOnDeckPull(ctx, q, actor, req, date)
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

type todoCommandResult interface {
	proto.Message
	GetEffects() *secretaryv1.DocumentMutationEffects
}

func (s *Server) runTodoCommand(ctx context.Context, op documentMutation, response todoCommandResult, apply func(*db.Queries) error) error {
	return s.runReceiptedCommand(ctx, op, response, func(_ pgx.Tx, q *db.Queries) error { return apply(q) })
}

func (s *Server) runReceiptedCommand(ctx context.Context, op documentMutation, response proto.Message, apply func(pgx.Tx, *db.Queries) error) error {
	for attempt := 0; attempt < 3; attempt++ {
		proto.Reset(response)
		err := s.todoCommandAttempt(ctx, op, response, apply)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01") {
			if attempt < 2 {
				continue
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("command contention; retry the same request"))
		}
		if err != nil {
			var ce *connect.Error
			if errors.As(err, &ce) {
				return err
			}
			return connect.NewError(connect.CodeInternal, fmt.Errorf("command transaction failed: %w", err))
		}
		return nil
	}
	panic("unreachable")
}

func (s *Server) todoCommandAttempt(ctx context.Context, op documentMutation, response proto.Message, apply func(pgx.Tx, *db.Queries) error) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if op.authorize != nil {
		if err := op.authorize(q); err != nil {
			return err
		}
	}
	scopeKind := "workspace"
	if op.userScoped {
		scopeKind = "user"
		if op.workspace != op.actor {
			return invalidIdentity("invalid user receipt scope")
		}
	} else {
		if err := s.ensureWorkspaceAccessWithQueries(ctx, q, op.workspace, op.actor); err != nil {
			return err
		}
	}
	if op.mutation.Valid {
		key := fmt.Sprintf("%d:%s:%d:%x", op.actor, scopeKind, op.workspace, op.mutation.Bytes)
		if err := q.LockPersistenceReceipt(ctx, key); err != nil {
			return err
		}
		receipt, err := q.GetMutationReceipt(ctx, db.GetMutationReceiptParams{ActorUserID: op.actor, ScopeKind: scopeKind, ScopeID: op.workspace, MutationID: op.mutation})
		if err == nil {
			return replayDocumentReceipt(receipt, op, response)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	// Exact replay precedes existence checks. A fresh operation cannot authorize
	// a foreign document via its otherwise valid workspace envelope.
	if op.id != 0 {
		doc, err := q.GetDocument(ctx, op.id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && doc.WorkspaceID != op.workspace) {
			return connect.NewError(connect.CodeNotFound, errors.New("document not found in workspace"))
		}
		if err != nil {
			return err
		}
	}
	if err := apply(tx, q); err != nil {
		return err
	}
	if op.mutation.Valid {
		payload, err := proto.Marshal(response)
		if err != nil {
			return err
		}
		targets := []int64{}
		if op.id != 0 {
			targets = append(targets, int64(op.id))
		}
		if pull, ok := response.(*secretaryv1.PullOnDeckTodosToTodayResponse); ok {
			targets = append(targets, pull.DocumentId)
		}
		if result, ok := response.(todoCommandResult); ok {
			for _, updated := range result.GetEffects().GetUpdatedDocuments() {
				targets = append(targets, updated.DocumentId)
			}
		}
		if result, ok := response.(*structpb.Struct); ok {
			for _, value := range result.GetFields()["target_ids"].GetListValue().GetValues() {
				id, err := strconv.ParseInt(value.GetStringValue(), 10, 64)
				if err != nil || !validDatabaseID(id, false) {
					return invalidIdentity("invalid command receipt target")
				}
				targets = append(targets, id)
			}
		}
		slices.Sort(targets)
		_, err = q.CreateMutationReceipt(ctx, db.CreateMutationReceiptParams{ActorUserID: op.actor, ScopeKind: scopeKind, ScopeID: op.workspace,
			MutationID: op.mutation, ProtocolVersion: 1, Operation: op.name, PayloadSha256: op.hash[:], TargetIds: slices.Compact(targets), CreationKey: pgtype.Text{String: op.creationKey, Valid: op.creationKey != ""},
			ResultType: string(response.ProtoReflect().Descriptor().FullName()), ResultVersion: 1, ResultPayload: payload})
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
