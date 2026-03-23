package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
)

func (s *Server) ListWorkspaces(ctx context.Context, _ *connect.Request[secretaryv1.ListWorkspacesRequest]) (*connect.Response[secretaryv1.ListWorkspacesResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	rows, err := s.queries.ListWorkspacesByUser(ctx, int32(userID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list workspaces"))
	}

	workspaces := make([]*secretaryv1.Workspace, 0, len(rows))
	for _, row := range rows {
		workspaces = append(workspaces, workspaceToProto(row))
	}

	return connect.NewResponse(&secretaryv1.ListWorkspacesResponse{Workspaces: workspaces}), nil
}

func (s *Server) CreateWorkspace(ctx context.Context, req *connect.Request[secretaryv1.CreateWorkspaceRequest]) (*connect.Response[secretaryv1.CreateWorkspaceResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	name := strings.TrimSpace(req.Msg.Name)
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace name is required"))
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to begin workspace transaction"))
	}
	defer tx.Rollback(ctx)

	qtx := s.queries.WithTx(tx)
	workspace, err := qtx.CreateWorkspace(ctx, name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create workspace"))
	}

	err = qtx.AddWorkspaceUser(ctx, db.AddWorkspaceUserParams{
		WorkspaceID: workspace.ID,
		UserID:      int32(userID),
		Role:        pgtype.Text{String: "owner", Valid: true},
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to add workspace membership"))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit workspace transaction"))
	}

	return connect.NewResponse(&secretaryv1.CreateWorkspaceResponse{Workspace: workspaceToProto(workspace)}), nil
}

func (s *Server) ListDocuments(ctx context.Context, req *connect.Request[secretaryv1.ListDocumentsRequest]) (*connect.Response[secretaryv1.ListDocumentsResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	workspaceID := req.Msg.WorkspaceId
	if workspaceID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
	}

	if err := s.ensureWorkspaceAccess(ctx, int32(workspaceID), int32(userID)); err != nil {
		return nil, err
	}

	docs, err := s.queries.ListDocumentsByWorkspace(ctx, int32(workspaceID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list documents"))
	}

	result := make([]*secretaryv1.Document, 0, len(docs))
	for _, doc := range docs {
		blocks, err := s.queries.ListBlocksByDocument(ctx, doc.ID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list document blocks"))
		}
		result = append(result, documentToProto(doc, blocks, nil))
	}

	return connect.NewResponse(&secretaryv1.ListDocumentsResponse{Documents: result}), nil
}

func (s *Server) GetDocument(ctx context.Context, req *connect.Request[secretaryv1.GetDocumentRequest]) (*connect.Response[secretaryv1.GetDocumentResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	doc, blocks, err := s.loadAuthorizedDocument(ctx, int32(req.Msg.Id), int32(userID))
	if err != nil {
		return nil, err
	}

	return connect.NewResponse(&secretaryv1.GetDocumentResponse{Document: documentToProto(doc, blocks, nil)}), nil
}

func (s *Server) SaveDocument(ctx context.Context, req *connect.Request[secretaryv1.SaveDocumentRequest]) (*connect.Response[secretaryv1.SaveDocumentResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Document == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document is required"))
	}

	incoming := req.Msg.Document
	kind := strings.TrimSpace(incoming.Kind)
	if !validDocumentKind(kind) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid document kind"))
	}

	journalDate, err := parseJournalDate(kind, incoming.JournalDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	title := incoming.Title
	if kind == "journal" && strings.TrimSpace(title) == "" {
		title = incoming.JournalDate
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to begin document transaction"))
	}
	defer tx.Rollback(ctx)

	qtx := s.queries.WithTx(tx)

	var savedDoc db.Document
	if incoming.Id > 0 {
		existingDoc, err := qtx.GetDocument(ctx, int32(incoming.Id))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document"))
		}
		if err := s.ensureWorkspaceAccessWithQueries(ctx, qtx, existingDoc.WorkspaceID, int32(userID)); err != nil {
			return nil, err
		}
		if incoming.WorkspaceId != 0 && int32(incoming.WorkspaceId) != existingDoc.WorkspaceID {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id cannot be changed"))
		}

		savedDoc, err = qtx.UpdateDocument(ctx, db.UpdateDocumentParams{
			ID:          existingDoc.ID,
			Kind:        kind,
			Title:       title,
			JournalDate: journalDate,
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update document"))
		}
	} else {
		if incoming.WorkspaceId <= 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
		}
		if err := s.ensureWorkspaceAccessWithQueries(ctx, qtx, int32(incoming.WorkspaceId), int32(userID)); err != nil {
			return nil, err
		}

		savedDoc, err = qtx.CreateDocument(ctx, db.CreateDocumentParams{
			WorkspaceID: int32(incoming.WorkspaceId),
			Kind:        kind,
			Title:       title,
			JournalDate: journalDate,
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create document"))
		}
	}

	existingBlocks, err := qtx.ListBlocksByDocument(ctx, savedDoc.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch existing blocks"))
	}
	existingByID := make(map[int32]db.Block, len(existingBlocks))
	for _, block := range existingBlocks {
		existingByID[block.ID] = block
	}

	serverIDByClientKey := map[string]int32{}
	clientKeyByServerID := map[int32]string{}
	keptIDs := make([]int32, 0, len(incoming.Blocks))

	for _, blockMsg := range incoming.Blocks {
		if err := validateBlockMessage(blockMsg); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}

		parentID, err := resolveParentBlockID(blockMsg, existingByID, serverIDByClientKey)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}

		params := db.CreateBlockParams{
			DocumentID:    savedDoc.ID,
			ParentBlockID: parentID,
			SortOrder:     blockMsg.SortOrder,
			Text:          blockMsg.Text,
			Status:        blockMsg.Status,
			TodoID:        toNullInt4(blockMsg.TodoId),
		}

		var savedBlock db.Block
		if blockMsg.Id > 0 {
			if _, ok := existingByID[int32(blockMsg.Id)]; !ok {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("block %d does not belong to document", blockMsg.Id))
			}
			savedBlock, err = qtx.UpdateBlock(ctx, db.UpdateBlockParams{
				ID:            int32(blockMsg.Id),
				DocumentID:    params.DocumentID,
				ParentBlockID: params.ParentBlockID,
				SortOrder:     params.SortOrder,
				Text:          params.Text,
				Status:        params.Status,
				TodoID:        params.TodoID,
			})
		} else {
			savedBlock, err = qtx.CreateBlock(ctx, params)
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to save block"))
		}

		keptIDs = append(keptIDs, savedBlock.ID)
		clientKey := blockMsg.ClientKey
		if clientKey == "" {
			clientKey = defaultBlockClientKey(int64(savedBlock.ID))
		}
		serverIDByClientKey[clientKey] = savedBlock.ID
		clientKeyByServerID[savedBlock.ID] = clientKey
	}

	if err := deleteMissingBlocks(ctx, tx, savedDoc.ID, keptIDs); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete removed blocks"))
	}

	finalDoc, err := qtx.GetDocument(ctx, savedDoc.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to reload document"))
	}
	finalBlocks, err := qtx.ListBlocksByDocument(ctx, savedDoc.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to reload blocks"))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit document transaction"))
	}

	clientKey := incoming.ClientKey
	if clientKey == "" {
		clientKey = defaultDocumentClientKey(int64(finalDoc.ID))
	}
	protoDoc := documentToProto(finalDoc, finalBlocks, clientKeyByServerID)
	protoDoc.ClientKey = clientKey

	return connect.NewResponse(&secretaryv1.SaveDocumentResponse{Document: protoDoc}), nil
}

func (s *Server) loadAuthorizedDocument(ctx context.Context, documentID int32, userID int32) (db.Document, []db.Block, error) {
	doc, err := s.queries.GetDocument(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Document{}, nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
	}
	if err != nil {
		return db.Document{}, nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document"))
	}
	if err := s.ensureWorkspaceAccess(ctx, doc.WorkspaceID, userID); err != nil {
		return db.Document{}, nil, err
	}
	blocks, err := s.queries.ListBlocksByDocument(ctx, documentID)
	if err != nil {
		return db.Document{}, nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document blocks"))
	}
	return doc, blocks, nil
}

func (s *Server) ensureWorkspaceAccess(ctx context.Context, workspaceID int32, userID int32) error {
	return s.ensureWorkspaceAccessWithQueries(ctx, s.queries, workspaceID, userID)
}

func (s *Server) ensureWorkspaceAccessWithQueries(ctx context.Context, queries *db.Queries, workspaceID int32, userID int32) error {
	_, err := queries.GetWorkspaceMembership(ctx, db.GetWorkspaceMembershipParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodePermissionDenied, errors.New("workspace access denied"))
	}
	if err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to validate workspace access"))
	}
	return nil
}

func requireUserID(ctx context.Context) (int64, error) {
	userID, ok := ctx.Value(userIdKey).(int64)
	if !ok || userID == 0 {
		return 0, connect.NewError(connect.CodeUnauthenticated, errors.New("unauthenticated"))
	}
	return userID, nil
}

func workspaceToProto(workspace db.Workspace) *secretaryv1.Workspace {
	return &secretaryv1.Workspace{
		Id:        int64(workspace.ID),
		Name:      workspace.Name,
		CreatedAt: formatTime(workspace.CreatedAt),
	}
}

func documentToProto(doc db.Document, blocks []db.Block, clientKeyByServerID map[int32]string) *secretaryv1.Document {
	clientKey := defaultDocumentClientKey(int64(doc.ID))
	result := &secretaryv1.Document{
		Id:          int64(doc.ID),
		ClientKey:   clientKey,
		WorkspaceId: int64(doc.WorkspaceID),
		Kind:        doc.Kind,
		Title:       doc.Title,
		JournalDate: formatDate(doc.JournalDate),
		CreatedAt:   formatTime(doc.CreatedAt),
		UpdatedAt:   formatTime(doc.UpdatedAt),
	}
	for _, block := range blocks {
		result.Blocks = append(result.Blocks, blockToProto(block, clientKeyByServerID[block.ID]))
	}
	return result
}

func blockToProto(block db.Block, clientKey string) *secretaryv1.Block {
	if clientKey == "" {
		clientKey = defaultBlockClientKey(int64(block.ID))
	}
	result := &secretaryv1.Block{
		Id:         int64(block.ID),
		ClientKey:  clientKey,
		DocumentId: int64(block.DocumentID),
		SortOrder:  block.SortOrder,
		Text:       block.Text,
		Status:     block.Status,
		CreatedAt:  formatTime(block.CreatedAt),
		UpdatedAt:  formatTime(block.UpdatedAt),
	}
	if block.ParentBlockID.Valid {
		result.ParentBlockId = int64(block.ParentBlockID.Int32)
	}
	if block.TodoID.Valid {
		result.TodoId = int64(block.TodoID.Int32)
	}
	return result
}

func validDocumentKind(kind string) bool {
	switch kind {
	case "journal", "note":
		return true
	default:
		return false
	}
}

func parseJournalDate(kind, value string) (pgtype.Date, error) {
	trimmed := strings.TrimSpace(value)
	if kind == "journal" {
		if trimmed == "" {
			return pgtype.Date{}, errors.New("journal_date is required for journals")
		}
		parsed, err := time.Parse("2006-01-02", trimmed)
		if err != nil {
			return pgtype.Date{}, errors.New("journal_date must use YYYY-MM-DD")
		}
		return pgtype.Date{Time: parsed, Valid: true}, nil
	}
	if trimmed != "" {
		return pgtype.Date{}, errors.New("journal_date must be empty for notes")
	}
	return pgtype.Date{}, nil
}

func formatDate(value pgtype.Date) string {
	if !value.Valid {
		return ""
	}
	return value.Time.Format("2006-01-02")
}

func validateBlockMessage(block *secretaryv1.Block) error {
	if block == nil {
		return errors.New("block is required")
	}
	if !validBlockStatus(block.Status) {
		return fmt.Errorf("invalid block status %q", block.Status)
	}
	if block.SortOrder <= 0 {
		return errors.New("sort_order must be positive")
	}
	return nil
}

func validBlockStatus(status string) bool {
	switch status {
	case "note", "todo", "doing", "done":
		return true
	default:
		return false
	}
}

func resolveParentBlockID(block *secretaryv1.Block, existingByID map[int32]db.Block, serverIDByClientKey map[string]int32) (pgtype.Int4, error) {
	if block.ParentBlockId > 0 {
		parentID := int32(block.ParentBlockId)
		if _, ok := existingByID[parentID]; !ok {
			if _, ok := serverIDByClientKey[block.ParentClientKey]; !ok {
				return pgtype.Int4{}, fmt.Errorf("parent block %d is not available in document", block.ParentBlockId)
			}
		}
		return pgtype.Int4{Int32: parentID, Valid: true}, nil
	}
	if block.ParentClientKey != "" {
		parentID, ok := serverIDByClientKey[block.ParentClientKey]
		if !ok {
			return pgtype.Int4{}, fmt.Errorf("parent client key %q was not found earlier in the save", block.ParentClientKey)
		}
		return pgtype.Int4{Int32: parentID, Valid: true}, nil
	}
	return pgtype.Int4{}, nil
}

func deleteMissingBlocks(ctx context.Context, tx pgx.Tx, documentID int32, keptIDs []int32) error {
	if len(keptIDs) == 0 {
		_, err := tx.Exec(ctx, `DELETE FROM block WHERE document_id = $1`, documentID)
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM block WHERE document_id = $1 AND NOT (id = ANY($2::int4[]))`, documentID, keptIDs)
	return err
}

func toNullInt4(value int64) pgtype.Int4 {
	if value <= 0 {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(value), Valid: true}
}

func defaultDocumentClientKey(id int64) string {
	return fmt.Sprintf("document-%d", id)
}

func defaultBlockClientKey(id int64) string {
	return fmt.Sprintf("block-%d", id)
}
