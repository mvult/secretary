package agent

import (
	"context"
	"encoding/json"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

const (
	defaultModel         = "gpt-5-mini"
	defaultMaxIterations = 8
	defaultContextTokens = 12000
	defaultMaxRecordings = 8
	defaultSearchDocs    = 8
	agentDirectoryName   = "AI"
	agentSkillsDirectory = "skills"
	lockedSystemDocument = "System"
	workspaceThreadName  = "Workspace"
	systemThreadName     = "System"
	maxDebugContentChars = 1500
	keepRecentMessages   = 8
)

type Runner interface {
	RunThreadTurn(context.Context, Request) (*Result, error)
}

type Request struct {
	Thread  db.AiThread
	UserID  int32
	Content string
	Mode    string
	RunID   int64
}

type Result struct {
	Content      string
	Provider     string
	Model        string
	InputTokens  int64
	OutputTokens int64
	ResponseJSON map[string]any
}

type Todo struct {
	ID        int64
	Name      string
	Status    string
	Desc      string
	Source    string
	UpdatedAt string
}

type Recording struct {
	ID         int64
	Name       string
	CreatedAt  string
	Summary    string
	Transcript string
}

type Services interface {
	ListThreadMessages(context.Context, int64) ([]db.AiMessage, error)
	ListWorkspaceDocuments(context.Context, int32) ([]db.Document, error)
	ListWorkspaceDirectories(context.Context, int32) ([]db.Directory, error)
	ListDocumentBlocks(context.Context, int32) ([]db.Block, error)
	LoadAuthorizedDocument(context.Context, int32, int32) (db.Document, []db.Block, error)
	ListTodos(context.Context, int32) ([]Todo, error)
	ListRecordings(context.Context) ([]Recording, error)
	GetRecording(context.Context, int64) (Recording, error)
	CreateSourceRef(context.Context, int64, string, int64, string, string) error
	CreateDocument(context.Context, int32, string, string) (int64, error)
	InsertBlock(context.Context, int32, int64, int64, int64, string) (int64, int64, error)
	MoveBlock(context.Context, int32, int64, int64, int64) (int64, int64, error)
}

type session struct {
	ctx         context.Context
	services    Services
	workspaceID int32
	userID      int32
	thread      db.AiThread
	runID       int64
	mode        string
	skills      []skill
}

type skill struct {
	DocumentID  int64
	Title       string
	Name        string
	Description string
	Metadata    map[string]any
	Content     string
}

type toolDefinition struct {
	name        string
	description string
	parameters  map[string]any
	execute     func(context.Context, json.RawMessage) (string, error)
}

type toolbox struct {
	definitions map[string]toolDefinition
	modelTools  []modelTool
}

type documentSearchRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

type listDirectoriesRequest struct {
	Path string `json:"path,omitempty"`
}

type getDocumentRequest struct {
	DocumentID int64 `json:"document_id"`
}

type listTodosRequest struct {
	Status string `json:"status,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type listRecordingsRequest struct {
	Limit int `json:"limit,omitempty"`
}

type getRecordingRequest struct {
	RecordingID int64 `json:"recording_id"`
}

type createDocumentRequest struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

type insertBlockRequest struct {
	DocumentID    int64  `json:"document_id"`
	ParentBlockID int64  `json:"parent_block_id,omitempty"`
	AfterBlockID  int64  `json:"after_block_id,omitempty"`
	Text          string `json:"text"`
}

type moveBlockRequest struct {
	BlockID       int64 `json:"block_id"`
	ParentBlockID int64 `json:"parent_block_id,omitempty"`
	AfterBlockID  int64 `json:"after_block_id,omitempty"`
}

type getSkillRequest struct {
	Name string `json:"name"`
}

type directoryEntry struct {
	EntryType   string `json:"entry_type"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	DirectoryID int64  `json:"directory_id,omitempty"`
	DocumentID  int64  `json:"document_id,omitempty"`
	Kind        string `json:"kind,omitempty"`
	JournalDate string `json:"journal_date,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
}

type listDirectoriesResponse struct {
	Path       string           `json:"path"`
	ParentPath string           `json:"parent_path,omitempty"`
	Entries    []directoryEntry `json:"entries"`
}

type documentSearchResult struct {
	DocumentID int64  `json:"document_id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	Snippet    string `json:"snippet"`
	UpdatedAt  string `json:"updated_at"`
}

type documentSearchResponse struct {
	Results []documentSearchResult `json:"results"`
}

type getDocumentResponse struct {
	DocumentID int64  `json:"document_id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	Locked     bool   `json:"locked"`
	Content    string `json:"content"`
}

type listTodosResponse struct {
	Todos []Todo `json:"todos"`
}

type listRecordingsResponse struct {
	Recordings []Recording `json:"recordings"`
}

type getRecordingResponse struct {
	RecordingID int64  `json:"recording_id"`
	Name        string `json:"name"`
	CreatedAt   string `json:"created_at"`
	Summary     string `json:"summary"`
	Transcript  string `json:"transcript"`
}

type mutateBlockResponse struct {
	DocumentID int64  `json:"document_id"`
	BlockID    int64  `json:"block_id"`
	Applied    bool   `json:"applied"`
	Message    string `json:"message"`
}

type skillSummary struct {
	DocumentID  int64          `json:"document_id"`
	Title       string         `json:"title"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type listSkillsResponse struct {
	Skills []skillSummary `json:"skills"`
}

type getSkillResponse struct {
	DocumentID  int64          `json:"document_id"`
	Title       string         `json:"title"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	Content     string         `json:"content"`
}

type modelTool struct {
	Type     string            `json:"type"`
	Function modelToolFunction `json:"function"`
}

type modelToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
}

type toolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type,omitempty"`
	Function toolCallFunction `json:"function"`
}

type toolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
