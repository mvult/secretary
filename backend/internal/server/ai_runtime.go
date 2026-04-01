package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"gopkg.in/yaml.v3"
)

const (
	defaultAIModel         = "gpt-5-mini"
	defaultAIMaxIterations = 8
	defaultAIContextTokens = 12000
	defaultAIMaxRecordings = 8
	defaultAISearchDocs    = 8
	agentDirectoryName     = "AI"
	agentSkillsDirectory   = "skills"
	lockedSystemDocument   = "System"
	workspaceToplineThread = "Workspace"
	workspaceSystemThread  = "System"
	maxDebugContentChars   = 1500
	keepRecentMessages     = 8
)

type aiRunner interface {
	RunThreadTurn(context.Context, aiTurnRequest) (*aiTurnResult, error)
}

type AIConfig struct {
	APIKey        string
	BaseURL       string
	Model         string
	SkillsDir     string
	MaxIterations int
	MaxTokens     int64
}

type aiTurnRequest struct {
	Thread  db.AiThread
	UserID  int32
	Content string
	Mode    string
	RunID   int64
}

type aiTurnResult struct {
	Content      string
	Provider     string
	Model        string
	InputTokens  int64
	OutputTokens int64
	ResponseJSON map[string]any
}

type secretaryAIRunner struct {
	server          *Server
	apiKey          string
	baseURL         string
	modelName       string
	maxIterations   int
	maxContextChars int
	httpClient      *http.Client
}

type runtimeSkill struct {
	DocumentID  int64
	Title       string
	Name        string
	Description string
	Metadata    map[string]any
	Content     string
	Frontmatter string
}

type aiToolEnv struct {
	ctx         context.Context
	server      *Server
	workspaceID int32
	userID      int32
	thread      db.AiThread
	runID       int64
	mode        string
	skills      []runtimeSkill
}

type aiToolDefinition struct {
	Name        string
	Description string
	Parameters  map[string]any
	Execute     func(context.Context, json.RawMessage) (string, error)
}

type aiChatMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
	ToolCalls  []aiToolCall `json:"tool_calls,omitempty"`
}

type aiToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type,omitempty"`
	Function aiToolCallFunction `json:"function"`
}

type aiToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type aiChatCompletionRequest struct {
	Model    string          `json:"model"`
	Messages []aiChatMessage `json:"messages"`
	Tools    []aiModelTool   `json:"tools,omitempty"`
}

type aiModelTool struct {
	Type     string              `json:"type"`
	Function aiModelToolFunction `json:"function"`
}

type aiModelToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type aiChatCompletionResponse struct {
	Choices []struct {
		Message struct {
			Role      string       `json:"role"`
			Content   any          `json:"content"`
			ToolCalls []aiToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
		TotalTokens      int64 `json:"total_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type documentSearchRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
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

type getDocumentRequest struct {
	DocumentID int64 `json:"document_id"`
}

type getDocumentResponse struct {
	DocumentID int64  `json:"document_id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	Locked     bool   `json:"locked"`
	Content    string `json:"content"`
}

type listTodosRequest struct {
	Status string `json:"status,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type todoItem struct {
	TodoID    int64  `json:"todo_id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Desc      string `json:"desc,omitempty"`
	Source    string `json:"source,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

type listTodosResponse struct {
	Todos []todoItem `json:"todos"`
}

type listRecordingsRequest struct {
	Limit int `json:"limit,omitempty"`
}

type recordingItem struct {
	RecordingID int64  `json:"recording_id"`
	Name        string `json:"name"`
	CreatedAt   string `json:"created_at"`
	Summary     string `json:"summary"`
}

type listRecordingsResponse struct {
	Recordings []recordingItem `json:"recordings"`
}

type getRecordingRequest struct {
	RecordingID int64 `json:"recording_id"`
}

type getRecordingResponse struct {
	RecordingID int64  `json:"recording_id"`
	Name        string `json:"name"`
	CreatedAt   string `json:"created_at"`
	Summary     string `json:"summary"`
	Transcript  string `json:"transcript"`
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

type mutateBlockResponse struct {
	DocumentID int64  `json:"document_id"`
	BlockID    int64  `json:"block_id"`
	Applied    bool   `json:"applied"`
	Message    string `json:"message"`
}

type listSkillsResponse struct {
	Skills []skillSummary `json:"skills"`
}

type skillSummary struct {
	DocumentID  int64          `json:"document_id"`
	Title       string         `json:"title"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type getSkillRequest struct {
	Name string `json:"name"`
}

type getSkillResponse struct {
	DocumentID  int64          `json:"document_id"`
	Title       string         `json:"title"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	Content     string         `json:"content"`
}

func (s *Server) SetAIRunner(r aiRunner) {
	s.aiRunner = r
}

func (s *Server) ConfigureAI(cfg AIConfig) error {
	if strings.TrimSpace(cfg.APIKey) == "" {
		s.aiRunner = nil
		return nil
	}
	modelName := strings.TrimSpace(cfg.Model)
	if modelName == "" {
		modelName = defaultAIModel
	}
	maxIterations := cfg.MaxIterations
	if maxIterations <= 0 {
		maxIterations = defaultAIMaxIterations
	}
	maxContextChars := int(cfg.MaxTokens * 4)
	if maxContextChars <= 0 {
		maxContextChars = defaultAIContextTokens * 4
	}
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	s.aiRunner = &secretaryAIRunner{
		server:          s,
		apiKey:          strings.TrimSpace(cfg.APIKey),
		baseURL:         baseURL,
		modelName:       modelName,
		maxIterations:   maxIterations,
		maxContextChars: maxContextChars,
		httpClient:      &http.Client{Timeout: 90 * time.Second},
	}
	return nil
}

func (r *secretaryAIRunner) RunThreadTurn(ctx context.Context, req aiTurnRequest) (*aiTurnResult, error) {
	log.Printf("AI runtime turn start: thread_id=%d run_id=%d workspace_id=%d user_id=%d mode=%s", req.Thread.ID, req.RunID, req.Thread.WorkspaceID, req.UserID, req.Mode)
	toolEnv := &aiToolEnv{ctx: ctx, server: r.server, workspaceID: req.Thread.WorkspaceID, userID: req.UserID, thread: req.Thread, runID: req.RunID, mode: req.Mode}
	skills, err := toolEnv.loadWorkspaceSkills()
	if err != nil {
		log.Printf("AI runtime load skills failed: thread_id=%d run_id=%d err=%v", req.Thread.ID, req.RunID, err)
		return nil, fmt.Errorf("load workspace skills: %w", err)
	}
	toolEnv.skills = skills
	log.Printf("AI runtime loaded skills: thread_id=%d run_id=%d skill_count=%d", req.Thread.ID, req.RunID, len(skills))
	threadMessages, err := r.server.queries.ListAIMessagesByThread(ctx, req.Thread.ID)
	if err != nil {
		log.Printf("AI runtime list messages failed: thread_id=%d run_id=%d err=%v", req.Thread.ID, req.RunID, err)
		return nil, fmt.Errorf("list thread messages: %w", err)
	}
	log.Printf("AI runtime loaded thread messages: thread_id=%d run_id=%d count=%d", req.Thread.ID, req.RunID, len(threadMessages))
	instruction, err := toolEnv.buildInstruction()
	if err != nil {
		log.Printf("AI runtime build instruction failed: thread_id=%d run_id=%d err=%v", req.Thread.ID, req.RunID, err)
		return nil, err
	}
	toolsByName, modelTools, err := toolEnv.buildTools()
	if err != nil {
		log.Printf("AI runtime build tools failed: thread_id=%d run_id=%d err=%v", req.Thread.ID, req.RunID, err)
		return nil, err
	}
	conversation, compaction := r.buildConversation(threadMessages)
	log.Printf("AI runtime context ready: thread_id=%d run_id=%d instruction_chars=%d conversation_messages=%d tool_count=%d compacted=%v", req.Thread.ID, req.RunID, len(instruction), len(conversation), len(modelTools), compaction["compacted"])
	messages := append([]aiChatMessage{{Role: "system", Content: instruction}}, conversation...)
	debug := map[string]any{
		"provider":   "openai",
		"model":      r.modelName,
		"compaction": compaction,
		"iterations": []map[string]any{},
	}
	var totalInputTokens int64
	var totalOutputTokens int64
	for iteration := 1; iteration <= r.maxIterations; iteration++ {
		log.Printf("AI runtime iteration start: thread_id=%d run_id=%d iteration=%d message_count=%d", req.Thread.ID, req.RunID, iteration, len(messages))
		response, err := r.createChatCompletion(ctx, messages, modelTools)
		if err != nil {
			log.Printf("AI runtime iteration failed: thread_id=%d run_id=%d iteration=%d err=%v", req.Thread.ID, req.RunID, iteration, err)
			return nil, err
		}
		totalInputTokens += response.Usage.PromptTokens
		totalOutputTokens += response.Usage.CompletionTokens
		if len(response.Choices) == 0 {
			return nil, errors.New("model returned no choices")
		}
		choice := response.Choices[0]
		assistantContent := normalizeModelContent(choice.Message.Content)
		log.Printf("AI runtime iteration response: thread_id=%d run_id=%d iteration=%d finish_reason=%s tool_calls=%d prompt_tokens=%d completion_tokens=%d assistant_preview=%q", req.Thread.ID, req.RunID, iteration, choice.FinishReason, len(choice.Message.ToolCalls), response.Usage.PromptTokens, response.Usage.CompletionTokens, clampString(assistantContent, 120))
		assistantMessage := aiChatMessage{Role: "assistant", Content: assistantContent, ToolCalls: choice.Message.ToolCalls}
		iterationDebug := map[string]any{
			"iteration":      iteration,
			"finish_reason":  choice.FinishReason,
			"assistant_text": clampString(assistantContent, maxDebugContentChars),
			"request":        debugMessages(messages),
			"tool_calls":     debugToolCalls(choice.Message.ToolCalls),
		}
		if len(choice.Message.ToolCalls) == 0 {
			iterations := debug["iterations"].([]map[string]any)
			debug["iterations"] = append(iterations, iterationDebug)
			log.Printf("AI runtime turn complete: thread_id=%d run_id=%d iterations=%d input_tokens=%d output_tokens=%d", req.Thread.ID, req.RunID, iteration, totalInputTokens, totalOutputTokens)
			return &aiTurnResult{
				Content:      strings.TrimSpace(assistantContent),
				Provider:     "openai",
				Model:        r.modelName,
				InputTokens:  totalInputTokens,
				OutputTokens: totalOutputTokens,
				ResponseJSON: debug,
			}, nil
		}
		messages = append(messages, assistantMessage)
		toolOutputs := make([]map[string]any, 0, len(choice.Message.ToolCalls))
		for _, call := range choice.Message.ToolCalls {
			definition, ok := toolsByName[call.Function.Name]
			if !ok {
				return nil, fmt.Errorf("unknown tool %q", call.Function.Name)
			}
			log.Printf("AI runtime tool call: thread_id=%d run_id=%d iteration=%d tool=%s args=%q", req.Thread.ID, req.RunID, iteration, call.Function.Name, clampString(call.Function.Arguments, 200))
			output, toolErr := definition.Execute(ctx, json.RawMessage(call.Function.Arguments))
			if toolErr != nil {
				log.Printf("AI runtime tool failed: thread_id=%d run_id=%d iteration=%d tool=%s err=%v", req.Thread.ID, req.RunID, iteration, call.Function.Name, toolErr)
				output = fmt.Sprintf(`{"error":%q}`, toolErr.Error())
			} else {
				log.Printf("AI runtime tool complete: thread_id=%d run_id=%d iteration=%d tool=%s output_preview=%q", req.Thread.ID, req.RunID, iteration, call.Function.Name, clampString(output, 160))
			}
			toolOutputs = append(toolOutputs, map[string]any{
				"id":     call.ID,
				"name":   call.Function.Name,
				"output": clampString(output, maxDebugContentChars),
			})
			messages = append(messages, aiChatMessage{Role: "tool", ToolCallID: call.ID, Content: output})
		}
		iterationDebug["tool_outputs"] = toolOutputs
		iterations := debug["iterations"].([]map[string]any)
		debug["iterations"] = append(iterations, iterationDebug)
	}
	log.Printf("AI runtime max iterations exceeded: thread_id=%d run_id=%d max_iterations=%d", req.Thread.ID, req.RunID, r.maxIterations)
	return nil, fmt.Errorf("ai run exceeded max iterations (%d)", r.maxIterations)
}

func (r *secretaryAIRunner) buildConversation(threadMessages []db.AiMessage) ([]aiChatMessage, map[string]any) {
	if len(threadMessages) == 0 {
		return nil, map[string]any{"compacted": false}
	}
	all := make([]aiChatMessage, 0, len(threadMessages))
	for _, message := range threadMessages {
		all = append(all, aiChatMessage{Role: normalizeChatRole(message.Role), Content: message.Content})
	}
	totalChars := 0
	for _, message := range all {
		totalChars += len(message.Content)
	}
	if totalChars <= r.maxContextChars || len(all) <= keepRecentMessages {
		return all, map[string]any{"compacted": false, "message_count": len(all)}
	}
	older := all[:len(all)-keepRecentMessages]
	recent := all[len(all)-keepRecentMessages:]
	compact := aiChatMessage{Role: "system", Content: "Earlier conversation summary:\n" + summarizeMessages(older, r.maxContextChars/2)}
	return append([]aiChatMessage{compact}, recent...), map[string]any{
		"compacted":      true,
		"original_count": len(all),
		"kept_recent":    len(recent),
		"summarized":     len(older),
	}
}

func (r *secretaryAIRunner) createChatCompletion(ctx context.Context, messages []aiChatMessage, tools []aiModelTool) (*aiChatCompletionResponse, error) {
	payload := aiChatCompletionRequest{Model: r.modelName, Messages: messages, Tools: tools}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, chatCompletionsURL(r.baseURL), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Content-Type", "application/json")
	log.Printf("AI provider request start: url=%s model=%s messages=%d tools=%d", chatCompletionsURL(r.baseURL), r.modelName, len(messages), len(tools))
	resp, err := r.httpClient.Do(req)
	if err != nil {
		log.Printf("AI provider transport failed: model=%s err=%v", r.modelName, err)
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		log.Printf("AI provider request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
		return nil, fmt.Errorf("openai request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var parsed aiChatCompletionResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, err
	}
	if parsed.Error != nil {
		log.Printf("AI provider response error: model=%s message=%s", r.modelName, parsed.Error.Message)
		return nil, errors.New(parsed.Error.Message)
	}
	log.Printf("AI provider request done: model=%s choices=%d prompt_tokens=%d completion_tokens=%d", r.modelName, len(parsed.Choices), parsed.Usage.PromptTokens, parsed.Usage.CompletionTokens)
	return &parsed, nil
}

func chatCompletionsURL(baseURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "https://api.openai.com/v1/chat/completions"
	}
	if strings.HasSuffix(trimmed, "/chat/completions") {
		return trimmed
	}
	if strings.HasSuffix(trimmed, "/v1") {
		return trimmed + "/chat/completions"
	}
	return trimmed + "/v1/chat/completions"
}

func normalizeModelContent(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			text, _ := entry["text"].(string)
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func normalizeChatRole(role string) string {
	switch strings.TrimSpace(strings.ToLower(role)) {
	case "assistant", "system", "tool":
		return strings.TrimSpace(strings.ToLower(role))
	default:
		return "user"
	}
}

func summarizeMessages(messages []aiChatMessage, maxChars int) string {
	if len(messages) == 0 {
		return ""
	}
	var b strings.Builder
	for _, message := range messages {
		line := fmt.Sprintf("- %s: %s\n", message.Role, clampString(strings.TrimSpace(message.Content), 240))
		if b.Len()+len(line) > maxChars {
			break
		}
		b.WriteString(line)
	}
	return strings.TrimSpace(b.String())
}

func debugMessages(messages []aiChatMessage) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		entry := map[string]any{
			"role":    message.Role,
			"content": clampString(message.Content, maxDebugContentChars),
		}
		if len(message.ToolCalls) > 0 {
			entry["tool_calls"] = debugToolCalls(message.ToolCalls)
		}
		if message.ToolCallID != "" {
			entry["tool_call_id"] = message.ToolCallID
		}
		result = append(result, entry)
	}
	return result
}

func debugToolCalls(calls []aiToolCall) []map[string]any {
	result := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		result = append(result, map[string]any{
			"id":        call.ID,
			"name":      call.Function.Name,
			"arguments": clampString(call.Function.Arguments, maxDebugContentChars),
		})
	}
	return result
}

func (e *aiToolEnv) buildInstruction() (string, error) {
	log.Printf("AI instruction build start: thread_id=%d run_id=%d workspace_id=%d document_id=%d", e.thread.ID, e.runID, e.workspaceID, e.thread.DocumentID.Int32)
	parts := []string{
		"You are Secretary, an agent that works inside a personal notes, todos, and recordings system.",
		"Use normal documents as memory. If you want to preserve a learning, create or update a document in the AI subtree rather than inventing hidden memory.",
		"The document titled System is locked. Read it freely, but never edit it.",
		"Use tools when discussing project state, memories, recordings, or todos instead of guessing.",
		"When editing documents, preserve the user's structure as much as possible and keep changes intentional.",
		"If you need workflow guidance from workspace skills, call list_skills and get_skill.",
	}
	if e.thread.DocumentID.Valid {
		doc, blocks, err := e.server.loadAuthorizedDocument(e.ctx, e.thread.DocumentID.Int32, e.userID)
		if err == nil {
			log.Printf("AI instruction loaded thread document: thread_id=%d run_id=%d document_id=%d block_count=%d", e.thread.ID, e.runID, doc.ID, len(blocks))
			parts = append(parts, "Current thread document:\n"+renderDocumentOutline(doc, blocks))
			_ = e.addSourceRef("document", int64(doc.ID), doc.Title, firstNonEmptyDocumentText(blocks))
		} else {
			log.Printf("AI instruction thread document load skipped: thread_id=%d run_id=%d document_id=%d err=%v", e.thread.ID, e.runID, e.thread.DocumentID.Int32, err)
		}
	}
	systemDoc, err := e.loadSystemDocument()
	if err != nil {
		return "", err
	}
	if systemDoc != nil {
		log.Printf("AI instruction loaded system document: thread_id=%d run_id=%d document_id=%d", e.thread.ID, e.runID, systemDoc.DocumentID)
		parts = append(parts, "Workspace System document:\n"+systemDoc.Content)
		_ = e.addSourceRef("document", int64(systemDoc.DocumentID), systemDoc.Title, systemDoc.Content)
	} else {
		log.Printf("AI instruction no system document: thread_id=%d run_id=%d", e.thread.ID, e.runID)
	}
	parts = append(parts, fmt.Sprintf("Thread title: %s", firstNonEmpty(e.thread.Title.String, untitledThreadName(e.thread))))
	parts = append(parts, fmt.Sprintf("Run mode: %s", e.mode))
	if e.mode == "ask" {
		parts = append(parts, "Do not modify documents or todos unless the user explicitly asks. Prefer retrieval and explanation.")
	}
	if len(e.skills) > 0 {
		names := make([]string, 0, len(e.skills))
		for _, skill := range e.skills {
			names = append(names, skill.Name)
		}
		parts = append(parts, "Available workspace skills: "+strings.Join(names, ", "))
	}
	log.Printf("AI instruction build done: thread_id=%d run_id=%d parts=%d skill_count=%d", e.thread.ID, e.runID, len(parts), len(e.skills))
	return strings.Join(parts, "\n\n"), nil
}

func (e *aiToolEnv) buildTools() (map[string]aiToolDefinition, []aiModelTool, error) {
	definitions := []aiToolDefinition{
		{
			Name:        "search_documents",
			Description: "Search workspace documents by title and body text.",
			Parameters: schemaObject(
				schemaString("query", "Substring query to search for."),
				schemaInteger("limit", "Maximum number of documents to return."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req documentSearchRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.searchDocuments(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "get_document",
			Description: "Load one document with its current outline content.",
			Parameters:  schemaObject(schemaInteger("document_id", "Document ID to load.")),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req getDocumentRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.getDocument(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "get_linked_documents",
			Description: "Load documents linked from a document.",
			Parameters:  schemaObject(schemaInteger("document_id", "Document ID to inspect for links.")),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req getDocumentRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.getLinkedDocuments(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "list_todos",
			Description: "List the current user's todos.",
			Parameters: schemaObject(
				schemaString("status", "Optional status filter."),
				schemaInteger("limit", "Maximum number of todos to return."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req listTodosRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.listTodos(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "list_recordings",
			Description: "List recent recordings with summaries.",
			Parameters:  schemaObject(schemaInteger("limit", "Maximum number of recordings to return.")),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req listRecordingsRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.listRecordings(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "get_recording",
			Description: "Load one recording summary and transcript.",
			Parameters:  schemaObject(schemaInteger("recording_id", "Recording ID to load.")),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req getRecordingRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.getRecording(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "create_document",
			Description: "Create a new note, usually in the AI subtree for memories or working notes.",
			Parameters: schemaObject(
				schemaString("title", "Title for the new note."),
				schemaString("content", "Plaintext outline content for the note."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req createDocumentRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.createDocument(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "insert_block",
			Description: "Insert a new block into an existing document without replacing other content.",
			Parameters: schemaObject(
				schemaInteger("document_id", "Document ID to insert into."),
				schemaInteger("parent_block_id", "Optional parent block ID for nested insertion. Use 0 for root."),
				schemaInteger("after_block_id", "Optional sibling block ID to insert after. Use 0 to insert at the start."),
				schemaString("text", "Block text to insert."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req insertBlockRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.insertBlock(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "move_block",
			Description: "Move an existing block to a new parent or sibling position without deleting content.",
			Parameters: schemaObject(
				schemaInteger("block_id", "Block ID to move."),
				schemaInteger("parent_block_id", "Optional new parent block ID. Use 0 for root."),
				schemaInteger("after_block_id", "Optional sibling block ID to move after. Use 0 to move to the start."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req moveBlockRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.moveBlock(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "list_skills",
			Description: "List workspace skills from the AI/skills directory.",
			Parameters:  schemaObject(),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req struct{}
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp := listSkillsResponse{Skills: e.skillSummaries()}
				return marshalToolResult(resp, nil)
			},
		},
		{
			Name:        "get_skill",
			Description: "Load the full document for one workspace skill by name.",
			Parameters:  schemaObject(schemaString("name", "Skill name to load.")),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req getSkillRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.getSkill(req)
				return marshalToolResult(resp, err)
			},
		},
	}
	byName := make(map[string]aiToolDefinition, len(definitions))
	modelTools := make([]aiModelTool, 0, len(definitions))
	for _, definition := range definitions {
		byName[definition.Name] = definition
		modelTools = append(modelTools, aiModelTool{Type: "function", Function: aiModelToolFunction{Name: definition.Name, Description: definition.Description, Parameters: definition.Parameters}})
	}
	return byName, modelTools, nil
}

func schemaObject(properties ...map[string]any) map[string]any {
	props := map[string]any{}
	required := make([]string, 0, len(properties))
	for _, property := range properties {
		name, _ := property["_name"].(string)
		delete(property, "_name")
		props[name] = property
		required = append(required, name)
	}
	result := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func schemaString(name string, description string) map[string]any {
	return map[string]any{"_name": name, "type": "string", "description": description}
}

func schemaInteger(name string, description string) map[string]any {
	return map[string]any{"_name": name, "type": "integer", "description": description}
}

func decodeToolArgs(raw json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	return json.Unmarshal(trimmed, target)
}

func marshalToolResult(value any, err error) (string, error) {
	if err != nil {
		return "", err
	}
	encoded, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return "", marshalErr
	}
	return string(encoded), nil
}

func (e *aiToolEnv) skillNames() []string {
	result := make([]string, 0, len(e.skills))
	for _, skill := range e.skills {
		result = append(result, skill.Name)
	}
	return result
}

func (e *aiToolEnv) skillSummaries() []skillSummary {
	result := make([]skillSummary, 0, len(e.skills))
	for _, skill := range e.skills {
		result = append(result, skillSummary{
			DocumentID:  skill.DocumentID,
			Title:       skill.Title,
			Name:        skill.Name,
			Description: skill.Description,
			Metadata:    skill.Metadata,
		})
	}
	return result
}

func (e *aiToolEnv) getSkill(req getSkillRequest) (getSkillResponse, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return getSkillResponse{}, errors.New("name is required")
	}
	for _, skill := range e.skills {
		if skill.Name == name {
			_ = e.addSourceRef("document", skill.DocumentID, skill.Title, skill.Content)
			return getSkillResponse{DocumentID: skill.DocumentID, Title: skill.Title, Name: skill.Name, Description: skill.Description, Metadata: skill.Metadata, Content: skill.Content}, nil
		}
	}
	return getSkillResponse{}, errors.New("skill not found")
}

func (e *aiToolEnv) loadWorkspaceSkills() ([]runtimeSkill, error) {
	directories, err := e.server.queries.ListDirectoriesByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		return nil, err
	}
	documents, err := e.server.queries.ListDocumentsByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		return nil, err
	}
	aiDirectory := findDirectoryByName(directories, agentDirectoryName, 0)
	if aiDirectory == nil {
		return nil, nil
	}
	skillsDirectory := findDirectoryByName(directories, agentSkillsDirectory, aiDirectory.ID)
	if skillsDirectory == nil {
		return nil, nil
	}
	allowedDirectoryIDs := descendantDirectoryIDs(directories, skillsDirectory.ID)
	allowedDirectoryIDs[skillsDirectory.ID] = struct{}{}
	result := make([]runtimeSkill, 0)
	for _, doc := range documents {
		if doc.Kind != "note" || !doc.DirectoryID.Valid {
			continue
		}
		if _, ok := allowedDirectoryIDs[doc.DirectoryID.Int32]; !ok {
			continue
		}
		blocks, err := e.server.queries.ListBlocksByDocument(e.ctx, doc.ID)
		if err != nil {
			return nil, err
		}
		skill, ok, err := runtimeSkillFromDocument(doc, blocks)
		if err != nil {
			log.Printf("AI runtime skip invalid skill: workspace_id=%d document_id=%d title=%q err=%v", e.workspaceID, doc.ID, doc.Title, err)
			continue
		}
		if !ok {
			continue
		}
		result = append(result, skill)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].DocumentID < result[j].DocumentID
		}
		return result[i].Name < result[j].Name
	})
	return result, nil
}

func findDirectoryByName(directories []db.Directory, name string, parentID int32) *db.Directory {
	for i := range directories {
		directory := directories[i]
		actualParentID := int32(0)
		if directory.ParentID.Valid {
			actualParentID = directory.ParentID.Int32
		}
		if directory.Name == name && actualParentID == parentID {
			return &directories[i]
		}
	}
	return nil
}

func descendantDirectoryIDs(directories []db.Directory, rootID int32) map[int32]struct{} {
	childrenByParent := make(map[int32][]int32)
	for _, directory := range directories {
		if !directory.ParentID.Valid {
			continue
		}
		childrenByParent[directory.ParentID.Int32] = append(childrenByParent[directory.ParentID.Int32], directory.ID)
	}
	result := map[int32]struct{}{}
	stack := []int32{rootID}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, childID := range childrenByParent[current] {
			if _, seen := result[childID]; seen {
				continue
			}
			result[childID] = struct{}{}
			stack = append(stack, childID)
		}
	}
	return result
}

func runtimeSkillFromDocument(doc db.Document, blocks []db.Block) (runtimeSkill, bool, error) {
	frontmatterText, err := firstSkillFrontmatterBlock(blocks)
	if err != nil {
		return runtimeSkill{}, false, err
	}
	if strings.TrimSpace(frontmatterText) == "" {
		return runtimeSkill{}, false, nil
	}
	parsed, err := parseSkillFrontmatter(frontmatterText)
	if err != nil {
		return runtimeSkill{}, false, err
	}
	name := strings.TrimSpace(parsed.Name)
	if name == "" {
		return runtimeSkill{}, false, errors.New("frontmatter name is required")
	}
	return runtimeSkill{
		DocumentID:  int64(doc.ID),
		Title:       doc.Title,
		Name:        name,
		Description: strings.TrimSpace(parsed.Description),
		Metadata:    parsed.Metadata,
		Content:     renderDocumentOutline(doc, blocks),
		Frontmatter: strings.TrimSpace(frontmatterText),
	}, true, nil
}

type parsedSkillFrontmatter struct {
	Name        string         `yaml:"name"`
	Description string         `yaml:"description"`
	Metadata    map[string]any `yaml:"metadata"`
}

func firstSkillFrontmatterBlock(blocks []db.Block) (string, error) {
	rootBlocks := make([]db.Block, 0)
	for _, block := range blocks {
		if block.ParentBlockID.Valid {
			continue
		}
		rootBlocks = append(rootBlocks, block)
	}
	if len(rootBlocks) == 0 {
		return "", nil
	}
	sort.SliceStable(rootBlocks, func(i, j int) bool { return rootBlocks[i].SortOrder < rootBlocks[j].SortOrder })
	return rootBlocks[0].Text, nil
}

func parseSkillFrontmatter(raw string) (parsedSkillFrontmatter, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return parsedSkillFrontmatter{}, nil
	}
	if strings.HasPrefix(trimmed, "---") {
		trimmed = strings.TrimPrefix(trimmed, "---")
		trimmed = strings.TrimSpace(trimmed)
		if idx := strings.LastIndex(trimmed, "\n---"); idx >= 0 {
			trimmed = strings.TrimSpace(trimmed[:idx])
		} else if strings.HasSuffix(trimmed, "---") {
			trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, "---"))
		}
	}
	var parsed parsedSkillFrontmatter
	if err := yaml.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return parsedSkillFrontmatter{}, fmt.Errorf("parse skill frontmatter: %w", err)
	}
	return parsed, nil
}

func (e *aiToolEnv) searchDocuments(_ context.Context, req documentSearchRequest) (documentSearchResponse, error) {
	log.Printf("AI tool search_documents start: run_id=%d query=%q limit=%d", e.runID, clampString(req.Query, 120), req.Limit)
	rows, err := e.server.queries.ListDocumentsByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		log.Printf("AI tool search_documents failed: run_id=%d err=%v", e.runID, err)
		return documentSearchResponse{}, err
	}
	query := strings.ToLower(strings.TrimSpace(req.Query))
	limit := req.Limit
	if limit <= 0 || limit > defaultAISearchDocs {
		limit = defaultAISearchDocs
	}
	results := make([]documentSearchResult, 0, limit)
	for _, doc := range rows {
		blocks, err := e.server.queries.ListBlocksByDocument(e.ctx, doc.ID)
		if err != nil {
			return documentSearchResponse{}, err
		}
		outline := renderDocumentOutline(doc, blocks)
		if query != "" {
			haystack := strings.ToLower(doc.Title + "\n" + outline)
			if !strings.Contains(haystack, query) {
				continue
			}
		}
		results = append(results, documentSearchResult{DocumentID: int64(doc.ID), Title: doc.Title, Kind: doc.Kind, Snippet: snippetForQuery(outline, query), UpdatedAt: formatTime(doc.UpdatedAt)})
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].UpdatedAt > results[j].UpdatedAt })
	if len(results) > limit {
		results = results[:limit]
	}
	log.Printf("AI tool search_documents done: run_id=%d matched=%d returned=%d", e.runID, len(results), len(results))
	return documentSearchResponse{Results: results}, nil
}

func (e *aiToolEnv) getDocument(_ context.Context, req getDocumentRequest) (getDocumentResponse, error) {
	log.Printf("AI tool get_document start: run_id=%d document_id=%d", e.runID, req.DocumentID)
	doc, blocks, err := e.server.loadAuthorizedDocument(e.ctx, int32(req.DocumentID), e.userID)
	if err != nil {
		log.Printf("AI tool get_document failed: run_id=%d document_id=%d err=%v", e.runID, req.DocumentID, err)
		return getDocumentResponse{}, err
	}
	content := renderDocumentOutline(doc, blocks)
	_ = e.addSourceRef("document", int64(doc.ID), doc.Title, firstNonEmptyDocumentText(blocks))
	log.Printf("AI tool get_document done: run_id=%d document_id=%d block_count=%d", e.runID, doc.ID, len(blocks))
	return getDocumentResponse{DocumentID: int64(doc.ID), Title: doc.Title, Kind: doc.Kind, Locked: isLockedSystemDocument(doc), Content: content}, nil
}

func (e *aiToolEnv) getLinkedDocuments(_ context.Context, req getDocumentRequest) (documentSearchResponse, error) {
	log.Printf("AI tool get_linked_documents start: run_id=%d document_id=%d", e.runID, req.DocumentID)
	_, blocks, err := e.server.loadAuthorizedDocument(e.ctx, int32(req.DocumentID), e.userID)
	if err != nil {
		log.Printf("AI tool get_linked_documents failed: run_id=%d document_id=%d err=%v", e.runID, req.DocumentID, err)
		return documentSearchResponse{}, err
	}
	seen := map[int32]struct{}{}
	results := make([]documentSearchResult, 0, 8)
	for _, block := range blocks {
		matches := documentLinkPattern.FindAllStringSubmatch(block.Text, -1)
		for _, match := range matches {
			linkedID, convErr := parseInt32(match[1])
			if convErr != nil {
				continue
			}
			if _, ok := seen[linkedID]; ok {
				continue
			}
			seen[linkedID] = struct{}{}
			linkedDoc, linkedBlocks, err := e.server.loadAuthorizedDocument(e.ctx, linkedID, e.userID)
			if err != nil {
				continue
			}
			results = append(results, documentSearchResult{DocumentID: int64(linkedDoc.ID), Title: linkedDoc.Title, Kind: linkedDoc.Kind, Snippet: snippetForQuery(renderDocumentOutline(linkedDoc, linkedBlocks), ""), UpdatedAt: formatTime(linkedDoc.UpdatedAt)})
			_ = e.addSourceRef("document", int64(linkedDoc.ID), linkedDoc.Title, firstNonEmptyDocumentText(linkedBlocks))
		}
	}
	log.Printf("AI tool get_linked_documents done: run_id=%d document_id=%d linked_count=%d", e.runID, req.DocumentID, len(results))
	return documentSearchResponse{Results: results}, nil
}

func (e *aiToolEnv) listTodos(_ context.Context, req listTodosRequest) (listTodosResponse, error) {
	log.Printf("AI tool list_todos start: run_id=%d status=%q limit=%d", e.runID, req.Status, req.Limit)
	rows, err := e.server.queries.ListTodosByUser(e.ctx, optionalUserID(e.userID))
	if err != nil {
		log.Printf("AI tool list_todos failed: run_id=%d err=%v", e.runID, err)
		return listTodosResponse{}, err
	}
	limit := req.Limit
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	statusFilter := strings.TrimSpace(strings.ToLower(req.Status))
	items := make([]todoItem, 0, limit)
	for _, row := range rows {
		status := row.Status.String
		if statusFilter != "" && status != statusFilter {
			continue
		}
		items = append(items, todoItem{TodoID: int64(row.ID), Name: row.Name, Status: status, Desc: row.Desc.String, Source: row.SourceKind, UpdatedAt: formatTime(row.UpdatedAt)})
		_ = e.addSourceRef("todo", int64(row.ID), row.Name, row.Desc.String)
		if len(items) >= limit {
			break
		}
	}
	log.Printf("AI tool list_todos done: run_id=%d returned=%d", e.runID, len(items))
	return listTodosResponse{Todos: items}, nil
}

func (e *aiToolEnv) listRecordings(_ context.Context, req listRecordingsRequest) (listRecordingsResponse, error) {
	log.Printf("AI tool list_recordings start: run_id=%d limit=%d", e.runID, req.Limit)
	rows, err := e.server.queries.ListRecordings(e.ctx)
	if err != nil {
		log.Printf("AI tool list_recordings failed: run_id=%d err=%v", e.runID, err)
		return listRecordingsResponse{}, err
	}
	limit := req.Limit
	if limit <= 0 || limit > defaultAIMaxRecordings {
		limit = defaultAIMaxRecordings
	}
	items := make([]recordingItem, 0, limit)
	for _, row := range rows {
		items = append(items, recordingItem{RecordingID: int64(row.ID), Name: row.Name.String, CreatedAt: formatTime(row.CreatedAt), Summary: clampString(row.Summary.String, 1200)})
		_ = e.addSourceRef("recording", int64(row.ID), row.Name.String, clampString(row.Summary.String, 240))
		if len(items) >= limit {
			break
		}
	}
	log.Printf("AI tool list_recordings done: run_id=%d returned=%d", e.runID, len(items))
	return listRecordingsResponse{Recordings: items}, nil
}

func (e *aiToolEnv) getRecording(_ context.Context, req getRecordingRequest) (getRecordingResponse, error) {
	log.Printf("AI tool get_recording start: run_id=%d recording_id=%d", e.runID, req.RecordingID)
	row, err := e.server.queries.GetRecording(e.ctx, int32(req.RecordingID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			log.Printf("AI tool get_recording not found: run_id=%d recording_id=%d", e.runID, req.RecordingID)
			return getRecordingResponse{}, errors.New("recording not found")
		}
		log.Printf("AI tool get_recording failed: run_id=%d recording_id=%d err=%v", e.runID, req.RecordingID, err)
		return getRecordingResponse{}, err
	}
	_ = e.addSourceRef("recording", int64(row.ID), row.Name.String, clampString(row.Summary.String, 240))
	log.Printf("AI tool get_recording done: run_id=%d recording_id=%d", e.runID, row.ID)
	return getRecordingResponse{RecordingID: int64(row.ID), Name: row.Name.String, CreatedAt: formatTime(row.CreatedAt), Summary: row.Summary.String, Transcript: clampString(row.Transcript.String, 12000)}, nil
}

func (e *aiToolEnv) createDocument(_ context.Context, req createDocumentRequest) (mutateBlockResponse, error) {
	log.Printf("AI tool create_document start: run_id=%d title=%q", e.runID, strings.TrimSpace(req.Title))
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return mutateBlockResponse{}, errors.New("title is required")
	}
	if strings.EqualFold(title, lockedSystemDocument) {
		return mutateBlockResponse{}, errors.New("the System document is locked")
	}
	directoryID, err := e.ensureAIDirectory()
	if err != nil {
		return mutateBlockResponse{}, err
	}
	doc := &secretaryv1.Document{ClientKey: "tool-" + uuid.NewString(), WorkspaceId: int64(e.workspaceID), Kind: "note", Title: title, DirectoryId: int64(directoryID), Blocks: blocksFromPlainText(req.Content, 0)}
	resp, err := e.server.SaveDocument(e.ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{Document: doc}))
	if err != nil {
		return mutateBlockResponse{}, err
	}
	saved := resp.Msg.Document
	log.Printf("AI tool create_document done: run_id=%d document_id=%d title=%q", e.runID, saved.Id, saved.Title)
	return mutateBlockResponse{DocumentID: saved.Id, Applied: true, Message: "Document created."}, nil
}

func (e *aiToolEnv) insertBlock(_ context.Context, req insertBlockRequest) (mutateBlockResponse, error) {
	log.Printf("AI tool insert_block start: run_id=%d document_id=%d parent_block_id=%d after_block_id=%d", e.runID, req.DocumentID, req.ParentBlockID, req.AfterBlockID)
	text := strings.TrimSpace(req.Text)
	if req.DocumentID <= 0 {
		return mutateBlockResponse{}, errors.New("document_id is required")
	}
	if text == "" {
		return mutateBlockResponse{}, errors.New("text is required")
	}
	doc, _, err := e.server.loadAuthorizedDocument(e.ctx, int32(req.DocumentID), e.userID)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	if isLockedSystemDocument(doc) {
		return mutateBlockResponse{}, errors.New("the System document is locked")
	}
	block, err := e.insertDocumentBlock(doc, req.ParentBlockID, req.AfterBlockID, text)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	log.Printf("AI tool insert_block done: run_id=%d document_id=%d block_id=%d", e.runID, doc.ID, block.ID)
	return mutateBlockResponse{DocumentID: int64(doc.ID), BlockID: int64(block.ID), Applied: true, Message: "Block inserted."}, nil
}

func (e *aiToolEnv) moveBlock(_ context.Context, req moveBlockRequest) (mutateBlockResponse, error) {
	log.Printf("AI tool move_block start: run_id=%d block_id=%d parent_block_id=%d after_block_id=%d", e.runID, req.BlockID, req.ParentBlockID, req.AfterBlockID)
	if req.BlockID <= 0 {
		return mutateBlockResponse{}, errors.New("block_id is required")
	}
	block, doc, err := e.loadAuthorizedBlock(req.BlockID)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	if isLockedSystemDocument(doc) {
		return mutateBlockResponse{}, errors.New("the System document is locked")
	}
	moved, err := e.moveDocumentBlock(block, doc, req.ParentBlockID, req.AfterBlockID)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	log.Printf("AI tool move_block done: run_id=%d document_id=%d block_id=%d", e.runID, doc.ID, moved.ID)
	return mutateBlockResponse{DocumentID: int64(doc.ID), BlockID: int64(moved.ID), Applied: true, Message: "Block moved."}, nil
}

func (e *aiToolEnv) loadAuthorizedBlock(blockID int64) (db.Block, db.Document, error) {
	if blockID <= 0 {
		return db.Block{}, db.Document{}, errors.New("block_id is required")
	}
	var block db.Block
	err := e.server.db.QueryRow(e.ctx, `
		SELECT id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at
		FROM block
		WHERE id = $1
	`, int32(blockID)).Scan(
		&block.ID,
		&block.DocumentID,
		&block.ParentBlockID,
		&block.SortOrder,
		&block.Text,
		&block.TodoID,
		&block.CreatedAt,
		&block.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Block{}, db.Document{}, errors.New("block not found")
	}
	if err != nil {
		return db.Block{}, db.Document{}, err
	}
	doc, _, err := e.server.loadAuthorizedDocument(e.ctx, block.DocumentID, e.userID)
	if err != nil {
		return db.Block{}, db.Document{}, err
	}
	return block, doc, nil
}

func (e *aiToolEnv) insertDocumentBlock(doc db.Document, parentBlockID int64, afterBlockID int64, text string) (db.Block, error) {
	tx, err := e.server.db.BeginTx(e.ctx, pgx.TxOptions{})
	if err != nil {
		return db.Block{}, err
	}
	defer tx.Rollback(e.ctx)
	qtx := e.server.queries.WithTx(tx)
	blocks, err := qtx.ListBlocksByDocument(e.ctx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	blockByID := blocksByID(blocks)
	parentID, err := validateTargetParent(parentBlockID, doc.ID, blockByID)
	if err != nil {
		return db.Block{}, err
	}
	siblingIDs, insertIndex, err := insertionPosition(parentID, afterBlockID, blockByID, 0)
	if err != nil {
		return db.Block{}, err
	}
	created, err := qtx.CreateBlock(e.ctx, db.CreateBlockParams{DocumentID: doc.ID, ParentBlockID: parentID, SortOrder: 1, Text: text})
	if err != nil {
		return db.Block{}, err
	}
	ordered := insertInt32At(siblingIDs, insertIndex, created.ID)
	created, err = e.reindexSiblings(qtx, blockByID, doc, parentID, ordered, created.ID)
	if err != nil {
		return db.Block{}, err
	}
	if err := reconcileBlockDocumentLinks(e.ctx, qtx, doc, created); err != nil {
		return db.Block{}, err
	}
	finalDoc, finalBlocks, err := reloadDocumentAndBlocks(e.ctx, qtx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	statuses, err := e.server.loadBlockTodoStatuses(e.ctx, qtx, finalBlocks)
	if err != nil {
		return db.Block{}, err
	}
	if err := maybeCreateDocumentHistorySnapshot(e.ctx, qtx, finalDoc, finalBlocks, statuses); err != nil {
		return db.Block{}, err
	}
	if err := tx.Commit(e.ctx); err != nil {
		return db.Block{}, err
	}
	return created, nil
}

func (e *aiToolEnv) moveDocumentBlock(block db.Block, doc db.Document, parentBlockID int64, afterBlockID int64) (db.Block, error) {
	tx, err := e.server.db.BeginTx(e.ctx, pgx.TxOptions{})
	if err != nil {
		return db.Block{}, err
	}
	defer tx.Rollback(e.ctx)
	qtx := e.server.queries.WithTx(tx)
	blocks, err := qtx.ListBlocksByDocument(e.ctx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	blockByID := blocksByID(blocks)
	current, ok := blockByID[block.ID]
	if !ok {
		return db.Block{}, errors.New("block not found")
	}
	parentID, err := validateTargetParent(parentBlockID, doc.ID, blockByID)
	if err != nil {
		return db.Block{}, err
	}
	if parentID.Valid && (parentID.Int32 == current.ID || isDescendantBlock(current.ID, parentID.Int32, blockByID)) {
		return db.Block{}, errors.New("cannot move a block into itself or its descendants")
	}
	oldParentID := current.ParentBlockID
	targetSiblingIDs, insertIndex, err := insertionPosition(parentID, afterBlockID, blockByID, current.ID)
	if err != nil {
		return db.Block{}, err
	}
	orderedTarget := insertInt32At(targetSiblingIDs, insertIndex, current.ID)
	moved, err := e.reindexSiblings(qtx, blockByID, doc, parentID, orderedTarget, current.ID)
	if err != nil {
		return db.Block{}, err
	}
	if !sameParent(oldParentID, parentID) {
		remaining := siblingIDsForParent(oldParentID, blockByID, current.ID)
		if _, err := e.reindexSiblings(qtx, blockByID, doc, oldParentID, remaining, 0); err != nil {
			return db.Block{}, err
		}
	}
	finalDoc, finalBlocks, err := reloadDocumentAndBlocks(e.ctx, qtx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	statuses, err := e.server.loadBlockTodoStatuses(e.ctx, qtx, finalBlocks)
	if err != nil {
		return db.Block{}, err
	}
	if err := maybeCreateDocumentHistorySnapshot(e.ctx, qtx, finalDoc, finalBlocks, statuses); err != nil {
		return db.Block{}, err
	}
	if err := tx.Commit(e.ctx); err != nil {
		return db.Block{}, err
	}
	return moved, nil
}

func validateTargetParent(parentBlockID int64, documentID int32, blockByID map[int32]db.Block) (pgtype.Int4, error) {
	if parentBlockID <= 0 {
		return pgtype.Int4{}, nil
	}
	parent, ok := blockByID[int32(parentBlockID)]
	if !ok {
		return pgtype.Int4{}, errors.New("parent block not found")
	}
	if parent.DocumentID != documentID {
		return pgtype.Int4{}, errors.New("parent block must belong to the same document")
	}
	return pgtype.Int4{Int32: parent.ID, Valid: true}, nil
}

func insertionPosition(parentID pgtype.Int4, afterBlockID int64, blockByID map[int32]db.Block, excludeBlockID int32) ([]int32, int, error) {
	siblingIDs := siblingIDsForParent(parentID, blockByID, excludeBlockID)
	if afterBlockID <= 0 {
		return siblingIDs, 0, nil
	}
	after, ok := blockByID[int32(afterBlockID)]
	if !ok {
		return nil, 0, errors.New("after block not found")
	}
	if !sameParent(after.ParentBlockID, parentID) {
		return nil, 0, errors.New("after block must be a sibling under the target parent")
	}
	for index, siblingID := range siblingIDs {
		if siblingID == after.ID {
			return siblingIDs, index + 1, nil
		}
	}
	return nil, 0, errors.New("after block must be a sibling under the target parent")
}

func siblingIDsForParent(parentID pgtype.Int4, blockByID map[int32]db.Block, excludeBlockID int32) []int32 {
	siblings := make([]db.Block, 0)
	for _, block := range blockByID {
		if block.ID == excludeBlockID || !sameParent(block.ParentBlockID, parentID) {
			continue
		}
		siblings = append(siblings, block)
	}
	sort.SliceStable(siblings, func(i, j int) bool { return siblings[i].SortOrder < siblings[j].SortOrder })
	result := make([]int32, 0, len(siblings))
	for _, sibling := range siblings {
		result = append(result, sibling.ID)
	}
	return result
}

func (e *aiToolEnv) reindexSiblings(qtx *db.Queries, blockByID map[int32]db.Block, doc db.Document, parentID pgtype.Int4, orderedIDs []int32, targetBlockID int32) (db.Block, error) {
	var target db.Block
	for index, blockID := range orderedIDs {
		block := blockByID[blockID]
		updated, err := qtx.UpdateBlock(e.ctx, db.UpdateBlockParams{ID: block.ID, DocumentID: block.DocumentID, ParentBlockID: parentID, SortOrder: int32(index + 1), Text: block.Text, TodoID: block.TodoID})
		if err != nil {
			return db.Block{}, err
		}
		blockByID[blockID] = updated
		if targetBlockID == 0 || updated.ID == targetBlockID {
			target = updated
		}
		if block.ParentBlockID != parentID || block.SortOrder != int32(index+1) {
			if err := reconcileBlockDocumentLinks(e.ctx, qtx, doc, updated); err != nil {
				return db.Block{}, err
			}
		}
	}
	return target, nil
}

func reloadDocumentAndBlocks(ctx context.Context, qtx *db.Queries, documentID int32) (db.Document, []db.Block, error) {
	doc, err := qtx.GetDocument(ctx, documentID)
	if err != nil {
		return db.Document{}, nil, err
	}
	blocks, err := qtx.ListBlocksByDocument(ctx, documentID)
	if err != nil {
		return db.Document{}, nil, err
	}
	return doc, blocks, nil
}

func blocksByID(blocks []db.Block) map[int32]db.Block {
	result := make(map[int32]db.Block, len(blocks))
	for _, block := range blocks {
		result[block.ID] = block
	}
	return result
}

func isDescendantBlock(blockID int32, candidateParentID int32, blockByID map[int32]db.Block) bool {
	currentID := candidateParentID
	for currentID != 0 {
		if currentID == blockID {
			return true
		}
		current, ok := blockByID[currentID]
		if !ok || !current.ParentBlockID.Valid {
			break
		}
		currentID = current.ParentBlockID.Int32
	}
	return false
}

func insertInt32At(values []int32, index int, value int32) []int32 {
	if index < 0 {
		index = 0
	}
	if index > len(values) {
		index = len(values)
	}
	result := make([]int32, 0, len(values)+1)
	result = append(result, values[:index]...)
	result = append(result, value)
	result = append(result, values[index:]...)
	return result
}

func sameParent(a pgtype.Int4, b pgtype.Int4) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.Int32 == b.Int32
}

func (e *aiToolEnv) addSourceRef(kind string, sourceID int64, label string, quote string) error {
	if e.runID == 0 || sourceID <= 0 {
		return nil
	}
	log.Printf("AI source ref create: run_id=%d source_kind=%s source_id=%d label=%q", e.runID, kind, sourceID, clampString(label, 80))
	_, err := e.server.CreateAISourceRef(e.ctx, connect.NewRequest(&secretaryv1.CreateAISourceRefRequest{RunId: e.runID, SourceKind: kind, SourceId: sourceID, Label: label, QuoteText: clampString(strings.TrimSpace(quote), 400)}))
	return err
}

func (e *aiToolEnv) ensureAIDirectory() (int32, error) {
	directories, err := e.server.queries.ListDirectoriesByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		return 0, err
	}
	for _, directory := range directories {
		if !directory.ParentID.Valid && directory.Name == agentDirectoryName {
			return directory.ID, nil
		}
	}
	created, err := e.server.queries.CreateDirectory(e.ctx, db.CreateDirectoryParams{WorkspaceID: e.workspaceID, Name: agentDirectoryName})
	if err != nil {
		return 0, err
	}
	return created.ID, nil
}

type systemDocumentInfo struct {
	DocumentID int64
	Title      string
	Content    string
}

func (e *aiToolEnv) loadSystemDocument() (*systemDocumentInfo, error) {
	log.Printf("AI system document lookup start: run_id=%d workspace_id=%d", e.runID, e.workspaceID)
	docs, err := e.server.queries.ListDocumentsByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		log.Printf("AI system document lookup failed: run_id=%d workspace_id=%d err=%v", e.runID, e.workspaceID, err)
		return nil, err
	}
	for _, doc := range docs {
		if doc.Kind != "note" || doc.Title != lockedSystemDocument {
			continue
		}
		blocks, err := e.server.queries.ListBlocksByDocument(e.ctx, doc.ID)
		if err != nil {
			log.Printf("AI system document blocks failed: run_id=%d document_id=%d err=%v", e.runID, doc.ID, err)
			return nil, err
		}
		log.Printf("AI system document lookup done: run_id=%d document_id=%d", e.runID, doc.ID)
		return &systemDocumentInfo{DocumentID: int64(doc.ID), Title: doc.Title, Content: renderDocumentOutline(doc, blocks)}, nil
	}
	log.Printf("AI system document not found: run_id=%d workspace_id=%d", e.runID, e.workspaceID)
	return nil, nil
}

func optionalUserID(userID int32) pgtype.Int4 {
	return pgtype.Int4{Int32: userID, Valid: userID > 0}
}

func untitledThreadName(thread db.AiThread) string {
	if thread.DocumentID.Valid {
		return "Document thread"
	}
	if thread.Title.String == workspaceSystemThread || thread.Title.String == workspaceToplineThread {
		return thread.Title.String
	}
	return "Workspace thread"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func firstNonEmptyDocumentText(blocks []db.Block) string {
	for _, block := range blocks {
		if strings.TrimSpace(block.Text) != "" {
			return block.Text
		}
	}
	return ""
}

func isLockedSystemDocument(doc db.Document) bool {
	return strings.EqualFold(strings.TrimSpace(doc.Title), lockedSystemDocument)
}

func renderDocumentOutline(doc db.Document, blocks []db.Block) string {
	if len(blocks) == 0 {
		return doc.Title
	}
	childMap := make(map[int32][]db.Block)
	for _, block := range blocks {
		parent := int32(0)
		if block.ParentBlockID.Valid {
			parent = block.ParentBlockID.Int32
		}
		childMap[parent] = append(childMap[parent], block)
	}
	var lines []string
	var walk func(parent int32, depth int)
	walk = func(parent int32, depth int) {
		children := childMap[parent]
		sort.SliceStable(children, func(i, j int) bool { return children[i].SortOrder < children[j].SortOrder })
		for _, block := range children {
			prefix := strings.Repeat("  ", depth) + "- "
			lines = append(lines, prefix+block.Text)
			walk(block.ID, depth+1)
		}
	}
	walk(0, 0)
	return strings.Join(lines, "\n")
}

func blocksFromPlainText(content string, documentID int64) []*secretaryv1.Block {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	blocks := make([]*secretaryv1.Block, 0, len(lines))
	stack := []string{}
	for _, rawLine := range lines {
		if strings.TrimSpace(rawLine) == "" {
			continue
		}
		depth := indentationDepth(rawLine)
		text := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(rawLine), "-*"))
		if text == "" {
			continue
		}
		clientKey := "tool-block-" + uuid.NewString()
		block := &secretaryv1.Block{ClientKey: clientKey, DocumentId: documentID, SortOrder: int32(len(blocks)), Text: text}
		if depth > 0 && depth <= len(stack) {
			block.ParentClientKey = stack[depth-1]
		}
		if depth >= len(stack) {
			stack = append(stack, clientKey)
		} else {
			stack = append(stack[:depth], clientKey)
		}
		if depth == 0 {
			stack = []string{clientKey}
		}
		blocks = append(blocks, block)
	}
	return blocks
}

func indentationDepth(line string) int {
	depth := 0
	spaces := 0
	for _, r := range line {
		if r == '\t' {
			depth++
			spaces = 0
			continue
		}
		if r == ' ' {
			spaces++
			if spaces == 2 {
				depth++
				spaces = 0
			}
			continue
		}
		break
	}
	return depth
}

func snippetForQuery(content string, query string) string {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return ""
	}
	if query == "" {
		return clampString(trimmed, 240)
	}
	lower := strings.ToLower(trimmed)
	idx := strings.Index(lower, strings.ToLower(query))
	if idx < 0 {
		return clampString(trimmed, 240)
	}
	start := max(idx-80, 0)
	end := min(idx+len(query)+120, len(trimmed))
	return strings.TrimSpace(trimmed[start:end])
}

func clampString(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if limit <= 0 || len(trimmed) <= limit {
		return trimmed
	}
	return strings.TrimSpace(trimmed[:limit]) + "..."
}

func parseInt32(value string) (int32, error) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 32)
	if err != nil {
		return 0, err
	}
	return int32(parsed), nil
}
