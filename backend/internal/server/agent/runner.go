package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type runner struct {
	services        Services
	apiKey          string
	baseURL         string
	modelName       string
	maxIterations   int
	maxContextChars int
	client          providerClient
}

func New(services Services, apiKey string, baseURL string, modelName string, skillsDir string, maxIterations int, maxTokens int64) (Runner, error) {
	_ = skillsDir
	if strings.TrimSpace(apiKey) == "" {
		return nil, nil
	}
	if strings.TrimSpace(modelName) == "" {
		modelName = defaultModel
	}
	if maxIterations <= 0 {
		maxIterations = defaultMaxIterations
	}
	maxContextChars := int(maxTokens * 4)
	if maxContextChars <= 0 {
		maxContextChars = defaultContextTokens * 4
	}
	client, err := newProviderClient(apiKey, baseURL)
	if err != nil {
		return nil, err
	}
	return &runner{
		services:        services,
		apiKey:          strings.TrimSpace(apiKey),
		baseURL:         strings.TrimSpace(baseURL),
		modelName:       strings.TrimSpace(modelName),
		maxIterations:   maxIterations,
		maxContextChars: maxContextChars,
		client:          client,
	}, nil
}

func (r *runner) RunThreadTurn(ctx context.Context, req Request) (*Result, error) {
	log.Printf("AI agent turn start: thread_id=%d run_id=%d workspace_id=%d user_id=%d mode=%s", req.Thread.ID, req.RunID, req.Thread.WorkspaceID, req.UserID, req.Mode)
	s := &session{ctx: ctx, services: r.services, workspaceID: req.Thread.WorkspaceID, userID: req.UserID, thread: req.Thread, runID: req.RunID, mode: req.Mode}
	if err := s.loadSkills(); err != nil {
		return nil, fmt.Errorf("load workspace skills: %w", err)
	}
	threadMessages, err := r.services.ListThreadMessages(ctx, req.Thread.ID)
	if err != nil {
		return nil, fmt.Errorf("list thread messages: %w", err)
	}
	instruction, err := s.buildInstruction()
	if err != nil {
		return nil, err
	}
	tools, err := s.buildToolbox()
	if err != nil {
		return nil, err
	}
	conversation, compaction := r.buildConversation(threadMessages)
	messages := append([]chatMessage{{Role: "system", Content: instruction}}, conversation...)
	debug := map[string]any{"provider": "openai", "model": r.modelName, "compaction": compaction, "iterations": []map[string]any{}}
	var totalInputTokens int64
	var totalOutputTokens int64

	for iteration := 1; iteration <= r.maxIterations; iteration++ {
		response, err := r.client.createChatCompletion(ctx, r.modelName, messages, tools.modelTools)
		if err != nil {
			return nil, err
		}
		totalInputTokens += response.Usage.PromptTokens
		totalOutputTokens += response.Usage.CompletionTokens
		if len(response.Choices) == 0 {
			return nil, errors.New("model returned no choices")
		}
		choice := response.Choices[0]
		assistantContent := normalizeModelContent(choice.Message.Content)
		assistantMessage := chatMessage{Role: "assistant", Content: assistantContent, ToolCalls: choice.Message.ToolCalls}
		iterationDebug := map[string]any{
			"iteration":      iteration,
			"finish_reason":  choice.FinishReason,
			"assistant_text": clampString(assistantContent, maxDebugContentChars),
			"request":        debugMessages(messages),
			"tool_calls":     debugToolCalls(choice.Message.ToolCalls),
		}
		if len(choice.Message.ToolCalls) == 0 {
			debug["iterations"] = append(debug["iterations"].([]map[string]any), iterationDebug)
			return &Result{
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
			output, toolErr := tools.execute(ctx, call.Function.Name, json.RawMessage(call.Function.Arguments))
			if toolErr != nil {
				output = fmt.Sprintf(`{"error":%q}`, toolErr.Error())
			}
			toolOutputs = append(toolOutputs, map[string]any{"id": call.ID, "name": call.Function.Name, "output": clampString(output, maxDebugContentChars)})
			messages = append(messages, chatMessage{Role: "tool", ToolCallID: call.ID, Content: output})
		}
		iterationDebug["tool_outputs"] = toolOutputs
		debug["iterations"] = append(debug["iterations"].([]map[string]any), iterationDebug)
	}
	return nil, fmt.Errorf("ai run exceeded max iterations (%d)", r.maxIterations)
}

func (r *runner) buildConversation(threadMessages []db.AiMessage) ([]chatMessage, map[string]any) {
	if len(threadMessages) == 0 {
		return nil, map[string]any{"compacted": false}
	}
	all := make([]chatMessage, 0, len(threadMessages))
	totalChars := 0
	for _, message := range threadMessages {
		entry := chatMessage{Role: normalizeChatRole(message.Role), Content: message.Content}
		all = append(all, entry)
		totalChars += len(entry.Content)
	}
	if totalChars <= r.maxContextChars || len(all) <= keepRecentMessages {
		return all, map[string]any{"compacted": false, "message_count": len(all)}
	}
	older := all[:len(all)-keepRecentMessages]
	recent := all[len(all)-keepRecentMessages:]
	compact := chatMessage{Role: "system", Content: "Earlier conversation summary:\n" + summarizeMessages(older, r.maxContextChars/2)}
	return append([]chatMessage{compact}, recent...), map[string]any{
		"compacted":      true,
		"original_count": len(all),
		"kept_recent":    len(recent),
		"summarized":     len(older),
	}
}
