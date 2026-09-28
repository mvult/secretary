package server

import (
	"context"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func indexPageSize(size int32) int32 {
	if size <= 0 {
		return 100
	}
	if size > 200 {
		return 200
	}
	return size
}

func (s *Server) ListDocumentIndex(ctx context.Context, req *connect.Request[secretaryv1.ListDocumentIndexRequest]) (*connect.Response[secretaryv1.ListDocumentIndexResponse], error) {
	actor, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if !validDatabaseID(actor, false) || !validDatabaseID(req.Msg.WorkspaceId, false) || !validDatabaseID(req.Msg.BeforeId, true) || req.Msg.PageSize < 0 {
		return nil, invalidIdentity("invalid document index scope or pagination")
	}
	query := strings.TrimSpace(req.Msg.Query)
	if len(query) > 512 {
		return nil, invalidIdentity("search query is too long")
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if err := s.ensureWorkspaceAccessWithQueries(ctx, q, int32(req.Msg.WorkspaceId), int32(actor)); err != nil {
		return nil, err
	}
	size := indexPageSize(req.Msg.PageSize)
	rows, err := q.ListDocumentIndex(ctx, db.ListDocumentIndexParams{WorkspaceID: int32(req.Msg.WorkspaceId), BeforeID: int32(req.Msg.BeforeId), PageLimit: size + 1, Query: query})
	if err != nil {
		return nil, err
	}
	result := &secretaryv1.ListDocumentIndexResponse{PersistenceProtocolVersion: 1}
	if len(rows) > int(size) {
		rows = rows[:size]
		result.NextBeforeId = int64(rows[len(rows)-1].ID)
	}
	for _, d := range rows {
		result.Entries = append(result.Entries, &secretaryv1.DocumentIndexEntry{Id: int64(d.ID), ClientKey: d.ClientKey,
			WorkspaceId: int64(d.WorkspaceID), DirectoryId: int64(d.DirectoryID.Int32), Kind: d.Kind, Title: d.Title,
			JournalDate: formatDate(d.JournalDate), CreatedAt: formatTime(d.CreatedAt), UpdatedAt: formatTime(d.UpdatedAt), Revision: d.Revision, Snippet: d.Snippet})
	}
	if req.Msg.BeforeId == 0 && query == "" {
		dirs, err := q.ListDirectoriesByWorkspace(ctx, int32(req.Msg.WorkspaceId))
		if err != nil {
			return nil, err
		}
		for _, dir := range dirs {
			result.Directories = append(result.Directories, directoryToProto(dir))
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(result), nil
}
