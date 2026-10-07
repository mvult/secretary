package whatsapp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLibraryUpdateCheck(t *testing.T) {
	const current = "v0.0.0-20261007111105-c386243a72ba"
	for _, tc := range []struct {
		name, latest, date string
		status             int
		available, fails   bool
	}{
		{"newer", "v0.0.0-20261008111105-123456789abc", "2026-10-08T11:11:05Z", 200, true, false},
		{"installed", current, "2026-10-07T11:11:05Z", 200, false, false},
		{"older proxy", "v0.0.0-20261006111105-123456789abc", "2026-10-06T11:11:05Z", 200, false, false},
		{"unavailable", "", "", 503, false, true},
		{"invalid metadata", "", "", 200, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/@latest" {
					w.WriteHeader(tc.status)
					fmt.Fprintf(w, `{"Version":%q,"Time":%q}`, tc.latest, tc.date)
				} else if r.URL.Path == "/@v/"+current+".info" {
					fmt.Fprintf(w, `{"Version":%q,"Time":"2026-10-07T11:11:05Z"}`, current)
				} else {
					t.Errorf("unexpected lookup: %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			got, err := checkLibraryUpdate(context.Background(), server.Client(), server.URL, current)
			if (err != nil) != tc.fails || got.Available != tc.available || got.Current != current {
				t.Fatalf("update=%+v error=%v", got, err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := checkLibraryUpdate(ctx, server.Client(), server.URL, current); err == nil {
				t.Fatal("cancelled check succeeded")
			}
		})
	}
}
