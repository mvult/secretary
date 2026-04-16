package server

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"github.com/mvult/secretary/backend/internal/server/agent"
)

func (s *Server) SetAIRunner(r agent.Runner) {
	s.aiRunner = r
}

func (s *Server) ConfigureAI(apiKey string, baseURL string, modelName string, skillsDir string, maxIterations int, maxTokens int64) error {
	runner, err := agent.New(agentServices{server: s}, apiKey, baseURL, modelName, skillsDir, maxIterations, maxTokens)
	if err != nil {
		return err
	}
	s.aiRunner = runner
	return nil
}

func newAgentRequest(thread db.AiThread, userID int32, content string, mode string, runID int64) agent.Request {
	return agent.Request{Thread: thread, UserID: userID, Content: content, Mode: mode, RunID: runID}
}

type agentServices struct {
	server *Server
}

func (s agentServices) ListThreadMessages(ctx context.Context, threadID int64) ([]db.AiMessage, error) {
	return s.server.queries.ListAIMessagesByThread(ctx, threadID)
}

func (s agentServices) ListWorkspaceDocuments(ctx context.Context, workspaceID int32) ([]db.Document, error) {
	return s.server.queries.ListDocumentsByWorkspace(ctx, workspaceID)
}

func (s agentServices) ListWorkspaceDirectories(ctx context.Context, workspaceID int32) ([]db.Directory, error) {
	return s.server.queries.ListDirectoriesByWorkspace(ctx, workspaceID)
}

func (s agentServices) ListDocumentBlocks(ctx context.Context, documentID int32) ([]db.Block, error) {
	return s.server.queries.ListBlocksByDocument(ctx, documentID)
}

func (s agentServices) LoadAuthorizedDocument(ctx context.Context, documentID int32, userID int32) (db.Document, []db.Block, error) {
	return s.server.loadAuthorizedDocument(ctx, documentID, userID)
}

func (s agentServices) ListTodos(ctx context.Context, userID int32) ([]agent.Todo, error) {
	rows, err := s.server.queries.ListTodosByUser(ctx, optionalUserID(userID))
	if err != nil {
		return nil, err
	}
	result := make([]agent.Todo, 0, len(rows))
	for _, row := range rows {
		result = append(result, agent.Todo{ID: int64(row.ID), Name: row.Name, Status: row.Status.String, Desc: row.Desc.String, Source: row.SourceKind, UpdatedAt: formatTime(row.UpdatedAt)})
	}
	return result, nil
}

func (s agentServices) ListRecordings(ctx context.Context) ([]agent.Recording, error) {
	rows, err := s.server.queries.ListRecordings(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]agent.Recording, 0, len(rows))
	for _, row := range rows {
		result = append(result, agent.Recording{ID: int64(row.ID), Name: row.Name.String, CreatedAt: formatTime(row.CreatedAt), Summary: row.Summary.String})
	}
	return result, nil
}

func (s agentServices) GetRecording(ctx context.Context, recordingID int64) (agent.Recording, error) {
	row, err := s.server.queries.GetRecording(ctx, int32(recordingID))
	if errors.Is(err, pgx.ErrNoRows) {
		return agent.Recording{}, errors.New("recording not found")
	}
	if err != nil {
		return agent.Recording{}, err
	}
	return agent.Recording{ID: int64(row.ID), Name: row.Name.String, CreatedAt: formatTime(row.CreatedAt), Summary: row.Summary.String, Transcript: row.Transcript.String}, nil
}

func (s agentServices) CreateSourceRef(ctx context.Context, runID int64, kind string, sourceID int64, label string, quote string) error {
	_, err := s.server.CreateAISourceRef(ctx, connect.NewRequest(&secretaryv1.CreateAISourceRefRequest{RunId: runID, SourceKind: kind, SourceId: sourceID, Label: label, QuoteText: clampString(strings.TrimSpace(quote), 400)}))
	return err
}

func (s agentServices) CreateDocument(ctx context.Context, workspaceID int32, title string, content string) (int64, error) {
	env := &aiToolMutationEnv{ctx: ctx, server: s.server, workspaceID: workspaceID}
	return env.createDocument(title, content)
}

func (s agentServices) InsertBlock(ctx context.Context, userID int32, documentID int64, parentBlockID int64, afterBlockID int64, text string) (int64, int64, error) {
	env := &aiToolMutationEnv{ctx: ctx, server: s.server, userID: userID}
	return env.insertBlock(documentID, parentBlockID, afterBlockID, text)
}

func (s agentServices) MoveBlock(ctx context.Context, userID int32, blockID int64, parentBlockID int64, afterBlockID int64) (int64, int64, error) {
	env := &aiToolMutationEnv{ctx: ctx, server: s.server, userID: userID}
	return env.moveBlock(blockID, parentBlockID, afterBlockID)
}
