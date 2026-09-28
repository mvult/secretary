package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func TestRunnerStopsAfterUncertainMutation(t *testing.T) {
	svc := newFakeServices()
	svc.mutationError = errors.New("commit outcome unknown")
	requests := 0
	arguments := "{ \"title\": \"Note\", \"content\": \"original\" }"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{
			"tool_calls": []toolCall{
				{ID: "call_original", Function: toolCallFunction{Name: "create_document", Arguments: arguments}},
				{ID: "call_later", Function: toolCallFunction{Name: "move_block", Arguments: `{"block_id":1}`}},
			},
		}}}})
	}))
	defer server.Close()
	r, err := New(svc, "test-key", server.URL, "test-model", "", 3, 1000)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.RunThreadTurn(context.Background(), Request{Thread: db.AiThread{ID: 4, WorkspaceID: 7}, UserID: 9, RunID: 12})
	if err == nil || !strings.Contains(err.Error(), "call_original") {
		t.Fatalf("expected retained-call failure: %v", err)
	}
	if requests != 1 || len(svc.mutationCalls) != 1 {
		t.Fatalf("continued after uncertain write: requests=%d calls=%v", requests, svc.mutationCalls)
	}
	call := svc.mutationCalls[0]
	if call.CallID != "call_original" || call.RunID != 12 || call.UserID != 9 || call.WorkspaceID != 7 || call.Arguments != arguments {
		t.Fatalf("lost identity or exact bytes: %+v", call)
	}
}
