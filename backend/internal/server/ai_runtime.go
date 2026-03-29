package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
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
	"google.golang.org/protobuf/types/known/structpb"
)

const (
	defaultAIModel         = "gpt-5-mini"
	defaultAIMaxIterations = 8
	defaultAIContextTokens = 12000
	defaultAIMaxRecordings = 8
	defaultAISearchDocs    = 8
	agentDirectoryName     = "AI"
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
	skills          []runtimeSkill
}

type runtimeSkill struct {
	Name    string
	Content string
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

type rewriteDocumentRequest struct {
	DocumentID int64  `json:"document_id"`
	Content    string `json:"content"`
}

type appendDocumentRequest struct {
	DocumentID int64  `json:"document_id"`
	Content    string `json:"content"`
}

type mutateDocumentResponse struct {
	DocumentID int64  `json:"document_id"`
	Title      string `json:"title"`
	Applied    bool   `json:"applied"`
	Message    string `json:"message"`
}

type listSkillsResponse struct {
	Skills []string `json:"skills"`
}

type getSkillRequest struct {
	Name string `json:"name"`
}

type getSkillResponse struct {
	Name    string `json:"name"`
	Content string `json:"content"`
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
	skills, err := loadRuntimeSkills(cfg.SkillsDir)
	if err != nil {
		return err
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
		skills:          skills,
	}
	return nil
}

func loadRuntimeSkills(explicitDir string) ([]runtimeSkill, error) {
	candidates := []string{}
	if strings.TrimSpace(explicitDir) != "" {
		candidates = append(candidates, explicitDir)
	}
	candidates = append(candidates, ".agents/skills", filepath.Join("..", ".agents", "skills"))
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || !info.IsDir() {
			continue
		}
		return readSkillsFromDir(candidate)
	}
	return nil, nil
}

func readSkillsFromDir(root string) ([]runtimeSkill, error) {
	result := make([]runtimeSkill, 0)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || !strings.EqualFold(d.Name(), "SKILL.md") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		name := filepath.Base(filepath.Dir(path))
		result = append(result, runtimeSkill{Name: name, Content: strings.TrimSpace(string(content))})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (r *secretaryAIRunner) RunThreadTurn(ctx context.Context, req aiTurnRequest) (*aiTurnResult, error) {
	log.Printf("AI runtime turn start: thread_id=%d run_id=%d workspace_id=%d user_id=%d mode=%s", req.Thread.ID, req.RunID, req.Thread.WorkspaceID, req.UserID, req.Mode)
	toolEnv := &aiToolEnv{ctx: ctx, server: r.server, workspaceID: req.Thread.WorkspaceID, userID: req.UserID, thread: req.Thread, runID: req.RunID, mode: req.Mode, skills: r.skills}
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
		"If you need repository or workflow guidance from installed skills, call list_skills and get_skill.",
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
	if e.mode == "draft" {
		parts = append(parts, "Do not apply mutations directly. If an edit would help, create a draft artifact via the mutation tools.")
	}
	if len(e.skills) > 0 {
		names := make([]string, 0, len(e.skills))
		for _, skill := range e.skills {
			names = append(names, skill.Name)
		}
		parts = append(parts, "Available skills: "+strings.Join(names, ", "))
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
			Name:        "rewrite_document",
			Description: "Rewrite a document from plaintext outline content.",
			Parameters: schemaObject(
				schemaInteger("document_id", "Document ID to rewrite."),
				schemaString("content", "Replacement plaintext outline content."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req rewriteDocumentRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.rewriteDocument(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "append_document",
			Description: "Append new root-level lines to a document.",
			Parameters: schemaObject(
				schemaInteger("document_id", "Document ID to append to."),
				schemaString("content", "Plaintext outline content to append."),
			),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req appendDocumentRequest
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp, err := e.appendDocument(ctx, req)
				return marshalToolResult(resp, err)
			},
		},
		{
			Name:        "list_skills",
			Description: "List installed skills that can provide workflow or domain guidance.",
			Parameters:  schemaObject(),
			Execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
				var req struct{}
				if err := decodeToolArgs(raw, &req); err != nil {
					return "", err
				}
				resp := listSkillsResponse{Skills: e.skillNames()}
				return marshalToolResult(resp, nil)
			},
		},
		{
			Name:        "get_skill",
			Description: "Load the full text of one installed skill by name.",
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

func (e *aiToolEnv) getSkill(req getSkillRequest) (getSkillResponse, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return getSkillResponse{}, errors.New("name is required")
	}
	for _, skill := range e.skills {
		if skill.Name == name {
			return getSkillResponse{Name: skill.Name, Content: skill.Content}, nil
		}
	}
	return getSkillResponse{}, errors.New("skill not found")
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

func (e *aiToolEnv) createDocument(_ context.Context, req createDocumentRequest) (mutateDocumentResponse, error) {
	log.Printf("AI tool create_document start: run_id=%d title=%q content_chars=%d apply=%v", e.runID, strings.TrimSpace(req.Title), len(strings.TrimSpace(req.Content)), e.allowApplyMutations())
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return mutateDocumentResponse{}, errors.New("title is required")
	}
	if strings.EqualFold(title, lockedSystemDocument) {
		return mutateDocumentResponse{}, errors.New("the System document is locked")
	}
	directoryID, err := e.ensureAIDirectory()
	if err != nil {
		log.Printf("AI tool create_document ensure dir failed: run_id=%d err=%v", e.runID, err)
		return mutateDocumentResponse{}, err
	}
	doc := &secretaryv1.Document{ClientKey: "tool-" + uuid.NewString(), WorkspaceId: int64(e.workspaceID), Kind: "note", Title: title, DirectoryId: int64(directoryID), Blocks: blocksFromPlainText(req.Content, 0)}
	artifactID, err := e.createMutationArtifact("create_document", 0, title, req.Content)
	if err != nil {
		log.Printf("AI tool create_document artifact failed: run_id=%d title=%q err=%v", e.runID, title, err)
		return mutateDocumentResponse{}, err
	}
	if !e.allowApplyMutations() {
		log.Printf("AI tool create_document drafted: run_id=%d artifact_id=%d title=%q", e.runID, artifactID, title)
		return mutateDocumentResponse{Title: title, Applied: false, Message: fmt.Sprintf("Drafted document creation as artifact %d.", artifactID)}, nil
	}
	resp, err := e.server.SaveDocument(e.ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{Document: doc}))
	if err != nil {
		log.Printf("AI tool create_document apply failed: run_id=%d title=%q err=%v", e.runID, title, err)
		return mutateDocumentResponse{}, err
	}
	saved := resp.Msg.Document
	log.Printf("AI tool create_document done: run_id=%d document_id=%d title=%q", e.runID, saved.Id, saved.Title)
	return mutateDocumentResponse{DocumentID: saved.Id, Title: saved.Title, Applied: true, Message: "Document created."}, nil
}

func (e *aiToolEnv) rewriteDocument(_ context.Context, req rewriteDocumentRequest) (mutateDocumentResponse, error) {
	log.Printf("AI tool rewrite_document start: run_id=%d document_id=%d content_chars=%d apply=%v", e.runID, req.DocumentID, len(strings.TrimSpace(req.Content)), e.allowApplyMutations())
	doc, blocks, err := e.server.loadAuthorizedDocument(e.ctx, int32(req.DocumentID), e.userID)
	if err != nil {
		log.Printf("AI tool rewrite_document load failed: run_id=%d document_id=%d err=%v", e.runID, req.DocumentID, err)
		return mutateDocumentResponse{}, err
	}
	if isLockedSystemDocument(doc) {
		return mutateDocumentResponse{}, errors.New("the System document is locked")
	}
	artifactID, err := e.createMutationArtifact("rewrite_document", int64(doc.ID), doc.Title, req.Content)
	if err != nil {
		log.Printf("AI tool rewrite_document artifact failed: run_id=%d document_id=%d err=%v", e.runID, doc.ID, err)
		return mutateDocumentResponse{}, err
	}
	if !e.allowApplyMutations() {
		log.Printf("AI tool rewrite_document drafted: run_id=%d artifact_id=%d document_id=%d", e.runID, artifactID, doc.ID)
		return mutateDocumentResponse{DocumentID: int64(doc.ID), Title: doc.Title, Applied: false, Message: fmt.Sprintf("Drafted rewrite as artifact %d.", artifactID)}, nil
	}
	protoDoc, err := e.serverDocumentProto(doc, blocks)
	if err != nil {
		return mutateDocumentResponse{}, err
	}
	protoDoc.Blocks = blocksFromPlainText(req.Content, protoDoc.Id)
	_, err = e.server.SaveDocument(e.ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{Document: protoDoc}))
	if err != nil {
		log.Printf("AI tool rewrite_document apply failed: run_id=%d document_id=%d err=%v", e.runID, doc.ID, err)
		return mutateDocumentResponse{}, err
	}
	log.Printf("AI tool rewrite_document done: run_id=%d document_id=%d", e.runID, doc.ID)
	return mutateDocumentResponse{DocumentID: int64(doc.ID), Title: doc.Title, Applied: true, Message: "Document rewritten."}, nil
}

func (e *aiToolEnv) appendDocument(_ context.Context, req appendDocumentRequest) (mutateDocumentResponse, error) {
	log.Printf("AI tool append_document start: run_id=%d document_id=%d content_chars=%d apply=%v", e.runID, req.DocumentID, len(strings.TrimSpace(req.Content)), e.allowApplyMutations())
	doc, blocks, err := e.server.loadAuthorizedDocument(e.ctx, int32(req.DocumentID), e.userID)
	if err != nil {
		log.Printf("AI tool append_document load failed: run_id=%d document_id=%d err=%v", e.runID, req.DocumentID, err)
		return mutateDocumentResponse{}, err
	}
	if isLockedSystemDocument(doc) {
		return mutateDocumentResponse{}, errors.New("the System document is locked")
	}
	appendBlocks := blocksFromPlainText(req.Content, int64(doc.ID))
	artifactID, err := e.createMutationArtifact("append_document", int64(doc.ID), doc.Title, req.Content)
	if err != nil {
		log.Printf("AI tool append_document artifact failed: run_id=%d document_id=%d err=%v", e.runID, doc.ID, err)
		return mutateDocumentResponse{}, err
	}
	if !e.allowApplyMutations() {
		log.Printf("AI tool append_document drafted: run_id=%d artifact_id=%d document_id=%d", e.runID, artifactID, doc.ID)
		return mutateDocumentResponse{DocumentID: int64(doc.ID), Title: doc.Title, Applied: false, Message: fmt.Sprintf("Drafted append as artifact %d.", artifactID)}, nil
	}
	protoDoc, err := e.serverDocumentProto(doc, blocks)
	if err != nil {
		return mutateDocumentResponse{}, err
	}
	protoDoc.Blocks = append(protoDoc.Blocks, appendBlocks...)
	resp, err := e.server.SaveDocument(e.ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{Document: protoDoc}))
	if err != nil {
		log.Printf("AI tool append_document apply failed: run_id=%d document_id=%d err=%v", e.runID, doc.ID, err)
		return mutateDocumentResponse{}, err
	}
	log.Printf("AI tool append_document done: run_id=%d document_id=%d", e.runID, resp.Msg.Document.Id)
	return mutateDocumentResponse{DocumentID: resp.Msg.Document.Id, Title: resp.Msg.Document.Title, Applied: true, Message: "Document updated."}, nil
}

func (e *aiToolEnv) serverDocumentProto(doc db.Document, blocks []db.Block) (*secretaryv1.Document, error) {
	statuses, err := e.server.loadBlockTodoStatuses(e.ctx, e.server.queries, blocks)
	if err != nil {
		return nil, err
	}
	return documentToProto(doc, blocks, statuses, nil), nil
}

func (e *aiToolEnv) createMutationArtifact(operation string, documentID int64, title string, content string) (int64, error) {
	log.Printf("AI artifact create start: run_id=%d operation=%s document_id=%d title=%q apply=%v", e.runID, operation, documentID, title, e.allowApplyMutations())
	payload, err := structpb.NewStruct(map[string]any{"operation": operation, "document_id": documentID, "title": title, "content": content, "applied": e.allowApplyMutations()})
	if err != nil {
		return 0, err
	}
	resp, err := e.server.CreateAIArtifact(e.ctx, connect.NewRequest(&secretaryv1.CreateAIArtifactRequest{RunId: e.runID, Kind: "patch", Title: title, ContentJson: payload}))
	if err != nil {
		log.Printf("AI artifact create failed: run_id=%d operation=%s document_id=%d err=%v", e.runID, operation, documentID, err)
		return 0, err
	}
	if documentID > 0 {
		_ = e.addSourceRef("document", documentID, title, clampString(content, 240))
	}
	log.Printf("AI artifact create done: run_id=%d artifact_id=%d operation=%s document_id=%d", e.runID, resp.Msg.Artifact.Id, operation, documentID)
	return resp.Msg.Artifact.Id, nil
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

func (e *aiToolEnv) allowApplyMutations() bool {
	return e.mode == "edit"
}
