package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	log.Printf("AI ListAIThreads start: workspace_id=%d user_id=%d", workspaceID, userID)

	rows, err := s.queries.ListAIThreadsByWorkspace(ctx, workspaceID)
	if err != nil {
		log.Printf("AI ListAIThreads failed: workspace_id=%d user_id=%d err=%v", workspaceID, userID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai threads"))
	}

	threads := make([]*secretaryv1.AIThread, 0, len(rows))
	for _, row := range rows {
		threads = append(threads, aiThreadToProto(row))
	}
	log.Printf("AI ListAIThreads done: workspace_id=%d user_id=%d thread_count=%d", workspaceID, userID, len(threads))
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
	log.Printf("AI GetAIThread start: thread_id=%d user_id=%d", thread.ID, userID)

	messages, err := s.queries.ListAIMessagesByThread(ctx, thread.ID)
	if err != nil {
		log.Printf("AI GetAIThread messages failed: thread_id=%d err=%v", thread.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai messages"))
	}
	runs, err := s.queries.ListAIRunsByThread(ctx, thread.ID)
	if err != nil {
		log.Printf("AI GetAIThread runs failed: thread_id=%d err=%v", thread.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai runs"))
	}
	artifacts, err := s.queries.ListAIArtifactsByThread(ctx, thread.ID)
	if err != nil {
		log.Printf("AI GetAIThread artifacts failed: thread_id=%d err=%v", thread.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list ai artifacts"))
	}
	sourceRefs, err := s.queries.ListAISourceRefsByThread(ctx, thread.ID)
	if err != nil {
		log.Printf("AI GetAIThread source refs failed: thread_id=%d err=%v", thread.ID, err)
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
	log.Printf("AI GetAIThread done: thread_id=%d messages=%d runs=%d artifacts=%d sources=%d", thread.ID, len(messages), len(runs), len(artifacts), len(sourceRefs))

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
	log.Printf("AI CreateAIThread start: workspace_id=%d user_id=%d document_id=%d title=%q", workspaceID, userID, req.Msg.DocumentId, strings.TrimSpace(req.Msg.Title))

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
		log.Printf("AI CreateAIThread failed: workspace_id=%d user_id=%d err=%v", workspaceID, userID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai thread"))
	}
	log.Printf("AI CreateAIThread done: thread_id=%d workspace_id=%d document_id=%d title=%q", thread.ID, thread.WorkspaceID, thread.DocumentID.Int32, thread.Title.String)

	return connect.NewResponse(&secretaryv1.CreateAIThreadResponse{Thread: aiThreadToProto(thread)}), nil
}

func (s *Server) UpdateAIThread(ctx context.Context, req *connect.Request[secretaryv1.UpdateAIThreadRequest]) (*connect.Response[secretaryv1.UpdateAIThreadResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	thread, err := s.getAuthorizedAIThread(ctx, req.Msg.Id, userID)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Msg.Title)
	log.Printf("AI UpdateAIThread start: thread_id=%d user_id=%d title=%q", thread.ID, userID, title)
	if title == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("title is required"))
	}
	updatedThread, err := s.queries.UpdateAIThread(ctx, db.UpdateAIThreadParams{
		ID:    thread.ID,
		Title: optionalText(title),
	})
	if err != nil {
		log.Printf("AI UpdateAIThread failed: thread_id=%d user_id=%d err=%v", thread.ID, userID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai thread"))
	}
	log.Printf("AI UpdateAIThread done: thread_id=%d title=%q", updatedThread.ID, updatedThread.Title.String)
	return connect.NewResponse(&secretaryv1.UpdateAIThreadResponse{Thread: aiThreadToProto(updatedThread)}), nil
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
	log.Printf("AI DeleteAIThread start: thread_id=%d user_id=%d", thread.ID, userID)
	if err := s.queries.DeleteAIThread(ctx, thread.ID); err != nil {
		log.Printf("AI DeleteAIThread failed: thread_id=%d user_id=%d err=%v", thread.ID, userID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete ai thread"))
	}
	log.Printf("AI DeleteAIThread done: thread_id=%d user_id=%d", thread.ID, userID)
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
	log.Printf("AI CreateAIMessage start: thread_id=%d user_id=%d role=%s content_preview=%q", thread.ID, userID, role, clampString(content, 120))

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
		log.Printf("AI CreateAIMessage failed: thread_id=%d user_id=%d role=%s err=%v", thread.ID, userID, role, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai message"))
	}
	if err := s.queries.TouchAIThread(ctx, thread.ID); err != nil {
		log.Printf("AI CreateAIMessage touch failed: thread_id=%d message_id=%d err=%v", thread.ID, message.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai thread timestamp"))
	}
	log.Printf("AI CreateAIMessage done: thread_id=%d message_id=%d role=%s", thread.ID, message.ID, role)

	return connect.NewResponse(&secretaryv1.CreateAIMessageResponse{Message: aiMessageToProto(message)}), nil
}

func (s *Server) RunAIThreadTurn(ctx context.Context, req *connect.Request[secretaryv1.RunAIThreadTurnRequest]) (*connect.Response[secretaryv1.RunAIThreadTurnResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if s.aiRunner == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("ai runtime is not configured on the server"))
	}
	thread, err := s.getAuthorizedAIThread(ctx, req.Msg.ThreadId, userID)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(req.Msg.Content)
	if content == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("content is required"))
	}
	mode := normalizeAIRunMode(req.Msg.Mode)
	if mode == "" {
		mode = "ask"
	}
	if !validAIRunMode(mode) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid ai run mode"))
	}
	log.Printf("AI RunAIThreadTurn start: thread_id=%d user_id=%d mode=%s content_preview=%q", thread.ID, userID, mode, clampString(content, 160))

	userMessage, err := s.queries.CreateAIMessage(ctx, db.CreateAIMessageParams{
		ThreadID:        thread.ID,
		Role:            "user",
		Content:         content,
		CreatedByUserID: pgtype.Int4{Int32: int32(userID), Valid: true},
	})
	if err != nil {
		log.Printf("AI RunAIThreadTurn user message failed: thread_id=%d user_id=%d err=%v", thread.ID, userID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai message"))
	}
	requestStruct, err := structpb.NewStruct(map[string]any{"thread_id": thread.ID, "content": content, "mode": mode})
	if err != nil {
		log.Printf("AI RunAIThreadTurn request encode failed: thread_id=%d message_id=%d err=%v", thread.ID, userMessage.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to encode ai request"))
	}
	requestJSON, err := marshalStruct(requestStruct)
	if err != nil {
		log.Printf("AI RunAIThreadTurn request persist encode failed: thread_id=%d message_id=%d err=%v", thread.ID, userMessage.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to persist ai request"))
	}
	now := time.Now().UTC()
	run, err := s.queries.CreateAIRun(ctx, db.CreateAIRunParams{
		TriggerMessageID: pgtype.Int8{Int64: userMessage.ID, Valid: true},
		Status:           "running",
		Mode:             mode,
		RequestJson:      requestJSON,
		StartedAt:        pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		log.Printf("AI RunAIThreadTurn run create failed: thread_id=%d message_id=%d err=%v", thread.ID, userMessage.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create ai run"))
	}
	log.Printf("AI RunAIThreadTurn persisted: thread_id=%d user_message_id=%d run_id=%d", thread.ID, userMessage.ID, run.ID)

	result, runErr := s.aiRunner.RunThreadTurn(ctx, newAgentRequest(thread, int32(userID), content, mode, run.ID))
	completedAt := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	if runErr != nil {
		log.Printf("RunAIThreadTurn failed: thread_id=%d run_id=%d mode=%s err=%v", thread.ID, run.ID, mode, runErr)
		_, updateErr := s.queries.UpdateAIRun(ctx, db.UpdateAIRunParams{
			ID:           run.ID,
			Status:       "failed",
			Mode:         mode,
			Provider:     optionalText("openai"),
			Model:        optionalText(""),
			RequestJson:  requestJSON,
			ErrorMessage: optionalText(runErr.Error()),
			StartedAt:    run.StartedAt,
			CompletedAt:  completedAt,
		})
		if updateErr != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ai run failed: %v (also failed to update run: %v)", runErr, updateErr))
		}
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ai run failed: %w", runErr))
	}
	responseJSON, err := marshalArbitraryJSON(result.ResponseJSON)
	if err != nil {
		log.Printf("RunAIThreadTurn response encoding failed: thread_id=%d run_id=%d err=%v", thread.ID, run.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to persist ai response"))
	}
	assistantContent := strings.TrimSpace(result.Content)
	if assistantContent == "" {
		assistantContent = "I couldn't produce a reply."
	}
	assistantMessage, err := s.queries.CreateAIMessage(ctx, db.CreateAIMessageParams{
		ThreadID: thread.ID,
		Role:     "assistant",
		Content:  assistantContent,
		RunID:    pgtype.Int8{Int64: run.ID, Valid: true},
	})
	if err != nil {
		log.Printf("RunAIThreadTurn assistant message create failed: thread_id=%d run_id=%d err=%v", thread.ID, run.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create assistant message"))
	}
	updatedRun, err := s.queries.UpdateAIRun(ctx, db.UpdateAIRunParams{
		ID:           run.ID,
		Status:       "completed",
		Mode:         mode,
		Provider:     optionalText(result.Provider),
		Model:        optionalText(result.Model),
		RequestJson:  requestJSON,
		ResponseJson: responseJSON,
		InputTokens:  optionalInt4(result.InputTokens),
		OutputTokens: optionalInt4(result.OutputTokens),
		StartedAt:    run.StartedAt,
		CompletedAt:  completedAt,
	})
	if err != nil {
		log.Printf("RunAIThreadTurn run update failed: thread_id=%d run_id=%d err=%v", thread.ID, run.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai run"))
	}
	if err := s.queries.TouchAIThread(ctx, thread.ID); err != nil {
		log.Printf("RunAIThreadTurn thread touch failed: thread_id=%d run_id=%d err=%v", thread.ID, run.ID, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update ai thread timestamp"))
	}
	log.Printf("AI RunAIThreadTurn done: thread_id=%d run_id=%d assistant_message_id=%d provider=%s model=%s input_tokens=%d output_tokens=%d", thread.ID, updatedRun.ID, assistantMessage.ID, result.Provider, result.Model, result.InputTokens, result.OutputTokens)
	return connect.NewResponse(&secretaryv1.RunAIThreadTurnResponse{UserMessage: aiMessageToProto(userMessage), AssistantMessage: aiMessageToProto(assistantMessage), Run: aiRunToProto(updatedRun)}), nil
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

func marshalArbitraryJSON(value any) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
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
	case "ask", "draft", "edit", "todo_assist", "heartbeat":
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
