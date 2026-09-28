package server

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
)

func TestDocumentIndexRejectsInvalidRequestsBeforeDatabaseAccess(t *testing.T) {
	s := &Server{}
	if _, err := s.ListDocumentIndex(context.Background(), connect.NewRequest(&secretaryv1.ListDocumentIndexRequest{WorkspaceId: 1})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("unauthenticated index read: %v", err)
	}
	ctx := context.WithValue(context.Background(), userIdKey, int64(1))
	for _, req := range []*secretaryv1.ListDocumentIndexRequest{
		{}, {WorkspaceId: 1, BeforeId: -1}, {WorkspaceId: 1, BeforeId: 1 << 32},
		{WorkspaceId: 1 << 32}, {WorkspaceId: 1, PageSize: -1}, {WorkspaceId: 1, Query: strings.Repeat("x", 513)},
	} {
		if _, err := s.ListDocumentIndex(ctx, connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("invalid index request %v: %v", req, err)
		}
	}
}
