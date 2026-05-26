package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const pomodoroApprovalPrompt = "You are deciding whether a work-hours distraction unlock should be approved. Return JSON only with shape {\"decision\":\"approve\"|\"deny\",\"time\":<integer minutes>,\"reason\":<short string>}. Approve only if the rationale is specific, work-related, and time-bounded. Deny vague reasons.  In general however, if the reason is valid, allot as much time as is requestion, but never approve more than 120 minutes."

type pomodoroApprovalRequest struct {
	Alias     string `json:"alias"`
	Rationale string `json:"rationale"`
}

type pomodoroApprovalResponse struct {
	Decision string `json:"decision"`
	Time     int    `json:"time"`
	Reason   string `json:"reason"`
}

type pomodoroChatCompletionRequest struct {
	Model    string                `json:"model"`
	Messages []pomodoroChatMessage `json:"messages"`
	Response map[string]any        `json:"response_format,omitempty"`
}

type pomodoroChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type pomodoroChatCompletionResponse struct {
	Choices []struct {
		Message struct {
			Content any `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (s *Server) handlePomodoroApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if strings.TrimSpace(s.aiAPIKey) == "" {
		writeError(w, http.StatusServiceUnavailable, "AI approvals are not configured")
		return
	}

	var req pomodoroApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Alias = strings.ToLower(strings.TrimSpace(req.Alias))
	req.Rationale = strings.TrimSpace(req.Rationale)
	if req.Alias != "youtube" {
		writeError(w, http.StatusBadRequest, "only youtube requires approval right now")
		return
	}
	if req.Rationale == "" {
		writeError(w, http.StatusBadRequest, "rationale is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	approval, err := s.requestPomodoroApproval(ctx, req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, approval)
}

func (s *Server) requestPomodoroApproval(ctx context.Context, req pomodoroApprovalRequest) (pomodoroApprovalResponse, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(s.aiBaseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if !strings.HasSuffix(baseURL, "/chat/completions") {
		if strings.HasSuffix(baseURL, "/v1") {
			baseURL += "/chat/completions"
		} else {
			baseURL += "/v1/chat/completions"
		}
	}
	model := strings.TrimSpace(s.aiModel)
	if model == "" {
		model = "gpt-5-mini"
	}

	payload := pomodoroChatCompletionRequest{
		Model: model,
		Messages: []pomodoroChatMessage{
			{Role: "system", Content: pomodoroApprovalPrompt},
			{Role: "user", Content: fmt.Sprintf("Alias: %s\nWork hours: active\nRequested default unlock: 10 minutes\nRationale: %s", req.Alias, req.Rationale)},
		},
		Response: map[string]any{"type": "json_object"},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("encode approval request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL, bytes.NewReader(body))
	if err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("create approval request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(s.aiAPIKey))
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("approval request failed: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("read approval response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return pomodoroApprovalResponse{}, fmt.Errorf("approval request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(responseBody)))
	}

	var parsed pomodoroChatCompletionResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("parse approval response: %w", err)
	}
	if parsed.Error != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("approval provider error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return pomodoroApprovalResponse{}, fmt.Errorf("approval model returned no choices")
	}
	content := normalizePomodoroResponseContent(parsed.Choices[0].Message.Content)
	content = strings.TrimSpace(strings.TrimPrefix(strings.TrimSuffix(content, "```"), "```json"))

	var approval pomodoroApprovalResponse
	if err := json.Unmarshal([]byte(content), &approval); err != nil {
		return pomodoroApprovalResponse{}, fmt.Errorf("parse approval decision: %w", err)
	}
	approval.Decision = strings.ToLower(strings.TrimSpace(approval.Decision))
	if approval.Decision != "approve" {
		approval.Decision = "deny"
		approval.Time = 0
	}
	if approval.Time < 0 {
		approval.Time = 0
	}
	if approval.Time > 120 {
		approval.Time = 30
	}
	approval.Reason = strings.TrimSpace(approval.Reason)
	return approval, nil
}

func normalizePomodoroResponseContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var builder strings.Builder
		for _, item := range typed {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				builder.WriteString(text)
			}
		}
		return builder.String()
	default:
		return ""
	}
}
