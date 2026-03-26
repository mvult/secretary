package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"google.golang.org/protobuf/types/known/structpb"
)

func (s *Server) ListAIThreads(ctx context.Context, req *connect.Request[secretaryv1.ListAIThreadsRequest]) (*connect.Response[secretaryv1.ListAIThreadsResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	workspaceID := int32(req.Msg.WorkspaceId)
	if workspaceID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
	}
	if err := s.ensureWorkspaceAccess(ctx, workspaceID, int32(userID)); err != nil {
		return nil, err
	}

	rows, err := s.queries.ListAIThreadsByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai threads"))
	}

	threads := make([]*secretaryv1.AIThread, 0, len(rows))
	for _, row := range rows {
		threads = append(threads, aiThreadToProto(row))
	}
	return connect.NewResponse(&secretaryv1.ListAIThreadsResponse{Threads: threads}), nil
}

func (s *Server) GetAIThread(ctx context.Context, req *connect.Request[secretaryv1.GetAIThreadRequest]) (*connect.Response[secretaryv1.GetAIThreadResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	thread, err := s.getAuthorizedAIThread(ctx, req.Msg.Id, userID)
	if err != nil {
		return nil, err
	}

	messages, err := s.queries.ListAIMessagesByThread(ctx, thread.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai messages"))
	}
	runs, err := s.queries.ListAIRunsByThread(ctx, thread.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai runs"))
	}
	artifacts, err := s.queries.ListAIArtifactsByThread(ctx, thread.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai artifacts"))
	}
	sourceRefs, err := s.queries.ListAISourceRefsByThread(ctx, thread.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai source refs"))
	}

	resp := &secretaryv1.GetAIThreadResponse{Thread: aiThreadToProto(thread)}
	for _, message := range messages {
		resp.Messages = append(resp.Messages, aiMessageToProto(message))
	}
	for _, run := range runs {
		resp.Runs = append(resp.Runs, aiRunToProto(run))
	}
	for _, artifact := range artifacts {
		resp.Artifacts = append(resp.Artifacts, aiArtifactToProto(artifact))
	}
	for _, sourceRef := range sourceRefs {
		resp.SourceRefs = append(resp.SourceRefs, aiSourceRefToProto(sourceRef))
	}

	return connect.NewResponse(resp), nil
}

func (s *Server) CreateAIThread(ctx context.Context, req *connect.Request[secretaryv1.CreateAIThreadRequest]) (*connect.Response[secretaryv1.CreateAIThreadResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	workspaceID := int32(req.Msg.WorkspaceId)
	if workspaceID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
	}
	if err := s.ensureWorkspaceAccess(ctx, workspaceID, int32(userID)); err != nil {
		return nil, err
	}

	title := strings.TrimSpace(req.Msg.Title)
	var documentID pgtype.Int4
	if req.Msg.DocumentId != 0 {
		document, err := s.queries.GetDocument(ctx, int32(req.Msg.DocumentId))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to load document"))
		}
		if document.WorkspaceID != workspaceID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document must belong to the same workspace"))
		}
		documentID = pgtype.Int4{Int32: int32(req.Msg.DocumentId), Valid: true}
	}

	thread, err := s.queries.CreateAIThread(ctx, db.CreateAIThreadParams{
		WorkspaceID:     workspaceID,
		DocumentID:      documentID,
		Title:           optionalText(title),
		CreatedByUserID: pgtype.Int4{Int32: int32(userID), Valid: true},
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai thread"))
	}

	return connect.NewResponse(&secretaryv1.CreateAIThreadResponse{Thread: aiThreadToProto(thread)}), nil
}

func (s *Server) DeleteAIThread(ctx context.Context, req *connect.Request[secretaryv1.DeleteAIThreadRequest]) (*connect.Response[secretaryv1.DeleteAIThreadResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	thread, err := s.getAuthorizedAIThread(ctx, req.Msg.Id, userID)
	if err != nil {
		return nil, err
	}
	if err := s.queries.DeleteAIThread(ctx, thread.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete ai thread"))
	}
	return connect.NewResponse(&secretaryv1.DeleteAIThreadResponse{}), nil
}

func (s *Server) CreateAIMessage(ctx context.Context, req *connect.Request[secretaryv1.CreateAIMessageRequest]) (*connect.Response[secretaryv1.CreateAIMessageResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	thread, err := s.getAuthorizedAIThread(ctx, req.Msg.ThreadId, userID)
	if err != nil {
		return nil, err
	}

	role := normalizeAIMessageRole(req.Msg.Role)
	if !validAIMessageRole(role) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai message role"))
	}
	content := strings.TrimSpace(req.Msg.Content)
	if content == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("content is required"))
	}

	runID := pgtype.Int8{}
	if req.Msg.RunId != 0 {
		run, err := s.getAuthorizedAIRun(ctx, req.Msg.RunId, userID)
		if err != nil {
			return nil, err
		}
		if !run.TriggerMessageID.Valid {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("run is not attached to a thread message"))
		}
		triggerMessage, err := s.queries.GetAIMessage(ctx, run.TriggerMessageID.Int64)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to validate ai run message"))
		}
		if triggerMessage.ThreadID != thread.ID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run belongs to a different thread"))
		}
		runID = pgtype.Int8{Int64: req.Msg.RunId, Valid: true}
	}

	createdBy := pgtype.Int4{}
	if role == "user" {
		createdBy = pgtype.Int4{Int32: int32(userID), Valid: true}
	}

	message, err := s.queries.CreateAIMessage(ctx, db.CreateAIMessageParams{
		ThreadID:        thread.ID,
		Role:            role,
		Content:         content,
		CreatedByUserID: createdBy,
		RunID:           runID,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai message"))
	}
	if err := s.queries.TouchAIThread(ctx, thread.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai thread timestamp"))
	}

	return connect.NewResponse(&secretaryv1.CreateAIMessageResponse{Message: aiMessageToProto(message)}), nil
}

func (s *Server) CreateAIRun(ctx context.Context, req *connect.Request[secretaryv1.CreateAIRunRequest]) (*connect.Response[secretaryv1.CreateAIRunResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.TriggerMessageId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("trigger_message_id is required"))
	}
	message, err := s.getAuthorizedAIMessage(ctx, req.Msg.TriggerMessageId, userID)
	if err != nil {
		return nil, err
	}
	status := normalizeAIRunStatus(req.Msg.Status)
	if !validAIRunStatus(status) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai run status"))
	}
	mode := normalizeAIRunMode(req.Msg.Mode)
	if !validAIRunMode(mode) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai run mode"))
	}

	requestJSON, err := marshalStruct(req.Msg.RequestJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid request_json: %w", err))
	}
	responseJSON, err := marshalStruct(req.Msg.ResponseJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid response_json: %w", err))
	}
	startedAt, err := parseOptionalTimestamp(req.Msg.StartedAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid started_at: %w", err))
	}
	completedAt, err := parseOptionalTimestamp(req.Msg.CompletedAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid completed_at: %w", err))
	}

	run, err := s.queries.CreateAIRun(ctx, db.CreateAIRunParams{
		TriggerMessageID: pgtype.Int8{Int64: message.ID, Valid: true},
		Status:           status,
		Mode:             mode,
		Provider:         optionalText(req.Msg.Provider),
		Model:            optionalText(req.Msg.Model),
		RequestJson:      requestJSON,
		ResponseJson:     responseJSON,
		InputTokens:      optionalInt4(req.Msg.InputTokens),
		OutputTokens:     optionalInt4(req.Msg.OutputTokens),
		LatencyMs:        optionalInt4(req.Msg.LatencyMs),
		ErrorMessage:     optionalText(req.Msg.ErrorMessage),
		StartedAt:        startedAt,
		CompletedAt:      completedAt,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai run"))
	}

	return connect.NewResponse(&secretaryv1.CreateAIRunResponse{Run: aiRunToProto(run)}), nil
}

func (s *Server) UpdateAIRun(ctx context.Context, req *connect.Request[secretaryv1.UpdateAIRunRequest]) (*connect.Response[secretaryv1.UpdateAIRunResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	run, err := s.getAuthorizedAIRun(ctx, req.Msg.Id, userID)
	if err != nil {
		return nil, err
	}
	status := normalizeAIRunStatus(req.Msg.Status)
	if !validAIRunStatus(status) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai run status"))
	}
	mode := normalizeAIRunMode(req.Msg.Mode)
	if !validAIRunMode(mode) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai run mode"))
	}

	requestJSON, err := marshalStruct(req.Msg.RequestJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid request_json: %w", err))
	}
	responseJSON, err := marshalStruct(req.Msg.ResponseJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid response_json: %w", err))
	}
	startedAt, err := parseOptionalTimestamp(req.Msg.StartedAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid started_at: %w", err))
	}
	completedAt, err := parseOptionalTimestamp(req.Msg.CompletedAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid completed_at: %w", err))
	}

	updatedRun, err := s.queries.UpdateAIRun(ctx, db.UpdateAIRunParams{
		ID:           run.ID,
		Status:       status,
		Mode:         mode,
		Provider:     optionalText(req.Msg.Provider),
		Model:        optionalText(req.Msg.Model),
		RequestJson:  requestJSON,
		ResponseJson: responseJSON,
		InputTokens:  optionalInt4(req.Msg.InputTokens),
		OutputTokens: optionalInt4(req.Msg.OutputTokens),
		LatencyMs:    optionalInt4(req.Msg.LatencyMs),
		ErrorMessage: optionalText(req.Msg.ErrorMessage),
		StartedAt:    startedAt,
		CompletedAt:  completedAt,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai run"))
	}

	return connect.NewResponse(&secretaryv1.UpdateAIRunResponse{Run: aiRunToProto(updatedRun)}), nil
}

func (s *Server) CreateAIArtifact(ctx context.Context, req *connect.Request[secretaryv1.CreateAIArtifactRequest]) (*connect.Response[secretaryv1.CreateAIArtifactResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.RunId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run_id is required"))
	}
	_, err = s.getAuthorizedAIRun(ctx, req.Msg.RunId, userID)
	if err != nil {
		return nil, err
	}
	kind := normalizeAIArtifactKind(req.Msg.Kind)
	if !validAIArtifactKind(kind) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai artifact kind"))
	}
	contentJSON, err := marshalStruct(req.Msg.ContentJson)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid content_json: %w", err))
	}
	if len(contentJSON) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("content_json is required"))
	}
	appliedAt, err := parseOptionalTimestamp(req.Msg.AppliedAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid applied_at: %w", err))
	}

	appliedByUserID := pgtype.Int4{}
	if req.Msg.AppliedByUserId != 0 {
		appliedByUserID = pgtype.Int4{Int32: int32(req.Msg.AppliedByUserId), Valid: true}
	}
	supersededBy := pgtype.Int8{}
	if req.Msg.SupersededByArtifactId != 0 {
		supersededBy = pgtype.Int8{Int64: req.Msg.SupersededByArtifactId, Valid: true}
	}

	artifact, err := s.queries.CreateAIArtifact(ctx, db.CreateAIArtifactParams{
		RunID:                  req.Msg.RunId,
		Kind:                   kind,
		Title:                  optionalText(req.Msg.Title),
		ContentJson:            contentJSON,
		AppliedAt:              appliedAt,
		AppliedByUserID:        appliedByUserID,
		SupersededByArtifactID: supersededBy,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai artifact"))
	}

	return connect.NewResponse(&secretaryv1.CreateAIArtifactResponse{Artifact: aiArtifactToProto(artifact)}), nil
}

func (s *Server) CreateAISourceRef(ctx context.Context, req *connect.Request[secretaryv1.CreateAISourceRefRequest]) (*connect.Response[secretaryv1.CreateAISourceRefResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	runID := pgtype.Int8{}
	artifactID := pgtype.Int8{}
	switch {
	case req.Msg.RunId != 0 && req.Msg.ArtifactId != 0:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("source ref may target a run or an artifact, not both"))
	case req.Msg.RunId == 0 && req.Msg.ArtifactId == 0:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run_id or artifact_id is required"))
	case req.Msg.RunId != 0:
		if _, err := s.getAuthorizedAIRun(ctx, req.Msg.RunId, userID); err != nil {
			return nil, err
		}
		runID = pgtype.Int8{Int64: req.Msg.RunId, Valid: true}
	default:
		if _, err := s.getAuthorizedAIArtifact(ctx, req.Msg.ArtifactId, userID); err != nil {
			return nil, err
		}
		artifactID = pgtype.Int8{Int64: req.Msg.ArtifactId, Valid: true}
	}

	sourceKind := normalizeAISourceKind(req.Msg.SourceKind)
	if !validAISourceKind(sourceKind) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai source kind"))
	}
	if req.Msg.SourceId <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("source_id must be positive"))
	}

	sourceRef, err := s.queries.CreateAISourceRef(ctx, db.CreateAISourceRefParams{
		RunID:      runID,
		ArtifactID: artifactID,
		SourceKind: sourceKind,
		SourceID:   int32(req.Msg.SourceId),
		Label:      optionalText(req.Msg.Label),
		QuoteText:  optionalText(req.Msg.QuoteText),
		Rank:       optionalInt4(req.Msg.Rank),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai source ref"))
	}

	return connect.NewResponse(&secretaryv1.CreateAISourceRefResponse{SourceRef: aiSourceRefToProto(sourceRef)}), nil
}

func (s *Server) getAuthorizedAIThread(ctx context.Context, threadID int64, userID int64) (db.AiThread, error) {
	if threadID <= 0 {
		return db.AiThread{}, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	thread, err := s.queries.GetAIThread(ctx, threadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AiThread{}, connect.NewError(connect.CodeNotFound, errors.New("ai thread not found"))
	}
	if err != nil {
		return db.AiThread{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch ai thread"))
	}
	if err := s.ensureWorkspaceAccess(ctx, thread.WorkspaceID, int32(userID)); err != nil {
		return db.AiThread{}, err
	}
	return thread, nil
}

func (s *Server) getAuthorizedAIMessage(ctx context.Context, messageID int64, userID int64) (db.AiMessage, error) {
	if messageID <= 0 {
		return db.AiMessage{}, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	message, err := s.queries.GetAIMessage(ctx, messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AiMessage{}, connect.NewError(connect.CodeNotFound, errors.New("ai message not found"))
	}
	if err != nil {
		return db.AiMessage{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch ai message"))
	}
	_, err = s.getAuthorizedAIThread(ctx, message.ThreadID, userID)
	if err != nil {
		return db.AiMessage{}, err
	}
	return message, nil
}

func (s *Server) getAuthorizedAIRun(ctx context.Context, runID int64, userID int64) (db.AiRun, error) {
	if runID <= 0 {
		return db.AiRun{}, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	run, err := s.queries.GetAIRun(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AiRun{}, connect.NewError(connect.CodeNotFound, errors.New("ai run not found"))
	}
	if err != nil {
		return db.AiRun{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch ai run"))
	}
	if !run.TriggerMessageID.Valid {
		return db.AiRun{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("ai run is not associated with a thread message"))
	}
	if _, err := s.getAuthorizedAIMessage(ctx, run.TriggerMessageID.Int64, userID); err != nil {
		return db.AiRun{}, err
	}
	return run, nil
}

func (s *Server) getAuthorizedAIArtifact(ctx context.Context, artifactID int64, userID int64) (db.AiArtifact, error) {
	if artifactID <= 0 {
		return db.AiArtifact{}, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	artifact, err := s.queries.GetAIArtifact(ctx, artifactID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AiArtifact{}, connect.NewError(connect.CodeNotFound, errors.New("ai artifact not found"))
	}
	if err != nil {
		return db.AiArtifact{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch ai artifact"))
	}
	if _, err := s.getAuthorizedAIRun(ctx, artifact.RunID, userID); err != nil {
		return db.AiArtifact{}, err
	}
	return artifact, nil
}

func aiThreadToProto(thread db.AiThread) *secretaryv1.AIThread {
	result := &secretaryv1.AIThread{
		Id:              thread.ID,
		WorkspaceId:     int64(thread.WorkspaceID),
		Title:           thread.Title.String,
		CreatedByUserId: int64(thread.CreatedByUserID.Int32),
		CreatedAt:       formatTime(thread.CreatedAt),
		UpdatedAt:       formatTime(thread.UpdatedAt),
	}
	if thread.DocumentID.Valid {
		result.DocumentId = int64(thread.DocumentID.Int32)
	}
	if !thread.CreatedByUserID.Valid {
		result.CreatedByUserId = 0
	}
	return result
}

func aiMessageToProto(message db.AiMessage) *secretaryv1.AIMessage {
	result := &secretaryv1.AIMessage{
		Id:              message.ID,
		ThreadId:        message.ThreadID,
		Role:            message.Role,
		Content:         message.Content,
		CreatedByUserId: int64(message.CreatedByUserID.Int32),
		CreatedAt:       formatTime(message.CreatedAt),
	}
	if message.RunID.Valid {
		result.RunId = message.RunID.Int64
	}
	if !message.CreatedByUserID.Valid {
		result.CreatedByUserId = 0
	}
	return result
}

func aiRunToProto(run db.AiRun) *secretaryv1.AIRun {
	result := &secretaryv1.AIRun{
		Id:           run.ID,
		Status:       run.Status,
		Mode:         run.Mode,
		Provider:     run.Provider.String,
		Model:        run.Model.String,
		InputTokens:  int64(run.InputTokens.Int32),
		OutputTokens: int64(run.OutputTokens.Int32),
		LatencyMs:    int64(run.LatencyMs.Int32),
		ErrorMessage: run.ErrorMessage.String,
		StartedAt:    formatTime(run.StartedAt),
		CompletedAt:  formatTime(run.CompletedAt),
		CreatedAt:    formatTime(run.CreatedAt),
	}
	if run.TriggerMessageID.Valid {
		result.TriggerMessageId = run.TriggerMessageID.Int64
	}
	if run.RequestJson != nil {
		result.RequestJson = structFromJSON(run.RequestJson)
	}
	if run.ResponseJson != nil {
		result.ResponseJson = structFromJSON(run.ResponseJson)
	}
	if !run.InputTokens.Valid {
		result.InputTokens = 0
	}
	if !run.OutputTokens.Valid {
		result.OutputTokens = 0
	}
	if !run.LatencyMs.Valid {
		result.LatencyMs = 0
	}
	return result
}

func aiArtifactToProto(artifact db.AiArtifact) *secretaryv1.AIArtifact {
	result := &secretaryv1.AIArtifact{
		Id:              artifact.ID,
		RunId:           artifact.RunID,
		Kind:            artifact.Kind,
		Title:           artifact.Title.String,
		CreatedAt:       formatTime(artifact.CreatedAt),
		AppliedAt:       formatTime(artifact.AppliedAt),
		AppliedByUserId: int64(artifact.AppliedByUserID.Int32),
	}
	if artifact.ContentJson != nil {
		result.ContentJson = structFromJSON(artifact.ContentJson)
	}
	if artifact.SupersededByArtifactID.Valid {
		result.SupersededByArtifactId = artifact.SupersededByArtifactID.Int64
	}
	if !artifact.AppliedByUserID.Valid {
		result.AppliedByUserId = 0
	}
	return result
}

func aiSourceRefToProto(sourceRef db.AiSourceRef) *secretaryv1.AISourceRef {
	result := &secretaryv1.AISourceRef{
		Id:         sourceRef.ID,
		SourceKind: sourceRef.SourceKind,
		SourceId:   int64(sourceRef.SourceID),
		Label:      sourceRef.Label.String,
		QuoteText:  sourceRef.QuoteText.String,
		Rank:       int64(sourceRef.Rank.Int32),
		CreatedAt:  formatTime(sourceRef.CreatedAt),
	}
	if sourceRef.RunID.Valid {
		result.RunId = sourceRef.RunID.Int64
	}
	if sourceRef.ArtifactID.Valid {
		result.ArtifactId = sourceRef.ArtifactID.Int64
	}
	if !sourceRef.Rank.Valid {
		result.Rank = 0
	}
	return result
}

func marshalStruct(value *structpb.Struct) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value.AsMap())
}

func structFromJSON(value []byte) *structpb.Struct {
	if len(value) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(value, &payload); err != nil {
		return nil
	}
	result, err := structpb.NewStruct(payload)
	if err != nil {
		return nil
	}
	return result
}

func parseOptionalTimestamp(value string) (pgtype.Timestamptz, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return pgtype.Timestamptz{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return pgtype.Timestamptz{}, err
	}
	return pgtype.Timestamptz{Time: parsed.UTC(), Valid: true}, nil
}

func optionalText(value string) pgtype.Text {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: trimmed, Valid: true}
}

func optionalInt4(value int64) pgtype.Int4 {
	if value == 0 {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(value), Valid: true}
}

func normalizeAIMessageRole(role string) string {
	return strings.ToLower(strings.TrimSpace(role))
}

func validAIMessageRole(role string) bool {
	switch role {
	case "user", "assistant", "system":
		return true
	default:
		return false
	}
}

func normalizeAIRunStatus(status string) string {
	return strings.ToLower(strings.TrimSpace(status))
}

func validAIRunStatus(status string) bool {
	switch status {
	case "queued", "running", "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func normalizeAIRunMode(mode string) string {
	return strings.ToLower(strings.TrimSpace(mode))
}

func validAIRunMode(mode string) bool {
	switch mode {
	case "ask", "draft", "edit", "todo_assist":
		return true
	default:
		return false
	}
}

func normalizeAIArtifactKind(kind string) string {
	return strings.ToLower(strings.TrimSpace(kind))
}

func validAIArtifactKind(kind string) bool {
	switch kind {
	case "draft", "patch", "retrieval_manifest", "summary", "todo_proposal":
		return true
	default:
		return false
	}
}

func normalizeAISourceKind(kind string) string {
	return strings.ToLower(strings.TrimSpace(kind))
}

func validAISourceKind(kind string) bool {
	switch kind {
	case "document", "block", "todo", "recording":
		return true
	default:
		return false
	}
}
