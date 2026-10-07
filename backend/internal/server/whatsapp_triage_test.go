package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type triageTransport func(*http.Request) (*http.Response, error)

func (f triageTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWhatsAppTriageOpenRouter(t *testing.T) {
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	for _, model := range []string{"", "  ", " custom/model "} {
		s := &Server{aiAPIKey: "unrelated-key", aiModel: "unrelated-model", aiBaseURL: "https://unrelated.test"}
		s.ConfigureMessageTriage(" router-key ", model)
		wantModel := strings.TrimSpace(model)
		if wantModel == "" {
			wantModel = "~openai/gpt-luna-latest"
		}
		http.DefaultTransport = triageTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != "https://openrouter.ai/api/v1/chat/completions" || r.Method != http.MethodPost {
				t.Fatalf("unexpected request: %s %s", r.Method, r.URL)
			}
			if r.Header.Get("Authorization") != "Bearer router-key" {
				t.Fatal("triage used the wrong API key")
			}
			var body struct {
				Model string `json:"model"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Model != wantModel {
				t.Fatalf("model=%q want=%q", body.Model, wantModel)
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"important\":true,\"reason\":\"Needs attention\"}"}}]}`))}, nil
		})
		result, err := s.classifyWhatsAppText(context.Background(), "instructions", db.WhatsappMessage{Text: pgtype.Text{String: "Please call", Valid: true}})
		if err != nil || !result.Important || result.Reason != "Needs attention" {
			t.Fatalf("result=%+v err=%v", result, err)
		}
	}
}
