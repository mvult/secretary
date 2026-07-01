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
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	whatsappsvc "github.com/mvult/secretary/backend/internal/whatsapp"
)

const defaultWhatsAppImportanceInstructions = "Mark a WhatsApp message as important if it likely needs my timely attention, asks me to do something, contains a commitment, includes urgent personal or work context, mentions scheduling, money, travel, family logistics, health, or anything that would be costly to miss. Mark casual chatter, reactions, memes, FYIs, and low-stakes group noise as not important."

func (s *Server) StartWhatsApp(ctx context.Context, sessionDBPath string) error {
	if strings.TrimSpace(sessionDBPath) == "" {
		sessionDBPath = os.Getenv("WHATSAPP_SESSION_DB")
	}
	service := whatsappsvc.New(s.queries, sessionDBPath, func(ctx context.Context, message db.WhatsappMessage) {
		go s.classifyWhatsAppMessage(ctx, message)
	})
	if err := service.Start(ctx); err != nil {
		return err
	}
	s.whatsapp = service
	go s.runWhatsAppClassificationLoop(ctx)
	return nil
}

func (s *Server) handleWhatsAppStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.whatsapp == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "status": s.whatsapp.Status()})
}

func (s *Server) handleWhatsAppQR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.whatsapp == nil {
		writeError(w, http.StatusServiceUnavailable, "whatsapp service is not started")
		return
	}
	qr, status := s.whatsapp.QR()
	writeJSON(w, http.StatusOK, map[string]any{"qr": qr, "status": status})
}

func (s *Server) handleWhatsAppReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.whatsapp == nil {
		writeError(w, http.StatusServiceUnavailable, "whatsapp service is not started")
		return
	}
	if err := s.whatsapp.Reconnect(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": s.whatsapp.Status()})
}

func (s *Server) handleWhatsAppLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.whatsapp == nil {
		writeError(w, http.StatusServiceUnavailable, "whatsapp service is not started")
		return
	}
	if err := s.whatsapp.Logout(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": s.whatsapp.Status()})
}

func (s *Server) handleWhatsAppSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		instructions, err := s.getWhatsAppImportanceInstructions(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load whatsapp settings")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"importance_instructions": instructions, "default_importance_instructions": defaultWhatsAppImportanceInstructions})
	case http.MethodPut:
		var req struct {
			ImportanceInstructions string `json:"importance_instructions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		instructions := strings.TrimSpace(req.ImportanceInstructions)
		if instructions == "" {
			instructions = defaultWhatsAppImportanceInstructions
		}
		settings, err := s.queries.UpsertWhatsAppSettings(r.Context(), instructions)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to save whatsapp settings")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"importance_instructions": settings.ImportanceInstructions, "updated_at": formatTime(settings.UpdatedAt)})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleWhatsAppPendingNotifications(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rows, err := s.queries.ListPendingWhatsAppNotifications(r.Context(), 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list pending notifications")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, whatsappMessagePayload(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (s *Server) handleWhatsAppMarkNotified(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(req.IDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}})
		return
	}
	rows, err := s.queries.MarkWhatsAppMessagesNotified(r.Context(), req.IDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to mark notifications")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, whatsappMessagePayload(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (s *Server) runWhatsAppClassificationLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		s.classifyPendingWhatsAppMessages(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) classifyPendingWhatsAppMessages(ctx context.Context) {
	rows, err := s.queries.ListPendingWhatsAppClassifications(ctx, 20)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("whatsapp pending classification load failed: %v", err)
		}
		return
	}
	for _, row := range rows {
		if row.IsFromMe {
			continue
		}
		s.classifyWhatsAppMessage(ctx, row)
	}
}

func (s *Server) classifyWhatsAppMessage(ctx context.Context, message db.WhatsappMessage) {
	text := strings.TrimSpace(message.Text.String)
	if text == "" {
		_, _ = s.queries.UpdateWhatsAppMessageClassification(ctx, db.UpdateWhatsAppMessageClassificationParams{
			ID:                      message.ID,
			ClassificationStatus:    "classified",
			ClassificationImportant: pgtype.Bool{Bool: false, Valid: true},
			ClassificationReason:    pgtype.Text{String: "No text content to classify", Valid: true},
		})
		return
	}
	if strings.TrimSpace(s.aiAPIKey) == "" {
		_, _ = s.queries.UpdateWhatsAppMessageClassification(ctx, db.UpdateWhatsAppMessageClassificationParams{
			ID:                   message.ID,
			ClassificationStatus: "error",
			ClassificationError:  pgtype.Text{String: "OPENAI_API_KEY is not configured", Valid: true},
		})
		return
	}
	instructions, err := s.getWhatsAppImportanceInstructions(ctx)
	if err != nil {
		_, _ = s.queries.UpdateWhatsAppMessageClassification(ctx, db.UpdateWhatsAppMessageClassificationParams{
			ID:                   message.ID,
			ClassificationStatus: "error",
			ClassificationError:  pgtype.Text{String: "failed to load importance instructions", Valid: true},
		})
		return
	}
	result, err := s.classifyWhatsAppText(ctx, instructions, message)
	if err != nil {
		_, _ = s.queries.UpdateWhatsAppMessageClassification(ctx, db.UpdateWhatsAppMessageClassificationParams{
			ID:                   message.ID,
			ClassificationStatus: "error",
			ClassificationModel:  pgtype.Text{String: s.aiModelOrDefault(), Valid: true},
			ClassificationError:  pgtype.Text{String: err.Error(), Valid: true},
		})
		return
	}
	_, err = s.queries.UpdateWhatsAppMessageClassification(ctx, db.UpdateWhatsAppMessageClassificationParams{
		ID:                      message.ID,
		ClassificationStatus:    "classified",
		ClassificationImportant: pgtype.Bool{Bool: result.Important, Valid: true},
		ClassificationReason:    pgtype.Text{String: strings.TrimSpace(result.Reason), Valid: strings.TrimSpace(result.Reason) != ""},
		ClassificationModel:     pgtype.Text{String: s.aiModelOrDefault(), Valid: true},
	})
	if err != nil {
		log.Printf("whatsapp classification update failed: message_id=%d err=%v", message.ID, err)
	}
}

type whatsAppClassificationResult struct {
	Important bool   `json:"important"`
	Reason    string `json:"reason"`
}

func (s *Server) classifyWhatsAppText(ctx context.Context, instructions string, message db.WhatsappMessage) (whatsAppClassificationResult, error) {
	prompt := "You classify incoming WhatsApp messages for local notifications. Use these user instructions:\n" + instructions + "\nReturn only JSON with keys important and reason."
	user := fmt.Sprintf("Sender: %s\nChat: %s\nMessage:\n%s", textValue(message.SenderName), message.ChatJid, strings.TrimSpace(message.Text.String))
	body, err := json.Marshal(map[string]any{
		"model": s.aiModelOrDefault(),
		"messages": []map[string]string{
			{"role": "system", "content": prompt},
			{"role": "user", "content": user},
		},
	})
	if err != nil {
		return whatsAppClassificationResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, openAIChatCompletionsURL(s.aiBaseURL), bytes.NewReader(body))
	if err != nil {
		return whatsAppClassificationResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.aiAPIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 45 * time.Second}).Do(req)
	if err != nil {
		return whatsAppClassificationResult{}, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return whatsAppClassificationResult{}, err
	}
	if resp.StatusCode >= 400 {
		return whatsAppClassificationResult{}, fmt.Errorf("openai request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return whatsAppClassificationResult{}, err
	}
	if parsed.Error != nil {
		return whatsAppClassificationResult{}, errors.New(parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return whatsAppClassificationResult{}, errors.New("model returned no choices")
	}
	content := normalizeWhatsAppModelContent(parsed.Choices[0].Message.Content)
	content = strings.TrimSpace(strings.TrimPrefix(strings.TrimSuffix(content, "```"), "```json"))
	var result whatsAppClassificationResult
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		return whatsAppClassificationResult{}, fmt.Errorf("invalid classifier json: %w", err)
	}
	if strings.TrimSpace(result.Reason) == "" {
		result.Reason = "No reason provided"
	}
	return result, nil
}

func (s *Server) getWhatsAppImportanceInstructions(ctx context.Context) (string, error) {
	settings, err := s.queries.GetWhatsAppSettings(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultWhatsAppImportanceInstructions, nil
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(settings.ImportanceInstructions) == "" {
		return defaultWhatsAppImportanceInstructions, nil
	}
	return settings.ImportanceInstructions, nil
}

func (s *Server) aiModelOrDefault() string {
	if strings.TrimSpace(s.aiModel) != "" {
		return strings.TrimSpace(s.aiModel)
	}
	return "gpt-4o-mini"
}

func openAIChatCompletionsURL(baseURL string) string {
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

func normalizeWhatsAppModelContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var builder strings.Builder
		for _, part := range value {
			if m, ok := part.(map[string]any); ok {
				if text, ok := m["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
		return builder.String()
	default:
		return ""
	}
}

func whatsappMessagePayload(row db.WhatsappMessage) map[string]any {
	return map[string]any{
		"id":                       row.ID,
		"chat_jid":                 row.ChatJid,
		"message_id":               row.MessageID,
		"sender_jid":               textValue(row.SenderJid),
		"sender_name":              textValue(row.SenderName),
		"is_from_me":               row.IsFromMe,
		"sent_at":                  formatTime(row.SentAt),
		"received_at":              formatTime(row.ReceivedAt),
		"message_type":             row.MessageType,
		"text":                     textValue(row.Text),
		"classification_status":    row.ClassificationStatus,
		"classification_important": boolPtr(row.ClassificationImportant),
		"classification_reason":    textValue(row.ClassificationReason),
		"classification_model":     textValue(row.ClassificationModel),
		"classification_error":     textValue(row.ClassificationError),
		"classified_at":            formatTime(row.ClassifiedAt),
		"notified_at":              formatTime(row.NotifiedAt),
	}
}

func textValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func boolPtr(value pgtype.Bool) *bool {
	if !value.Valid {
		return nil
	}
	return &value.Bool
}
