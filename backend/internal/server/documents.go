package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
)

var documentLinkPattern = regexp.MustCompile(`\[\[doc:(\d+)\|([^\]]+)\]\]`)

const (
	documentHistoryMinInterval = 15 * time.Minute
	documentHistoryRetention   = 90 * 24 * time.Hour
)

type documentHistorySnapshot struct {
	Title string                        `json:"title,omitempty"`
	Kind  string                        `json:"kind"`
	Date  string                        `json:"date,omitempty"`
	Nodes []documentHistorySnapshotNode `json:"nodes"`
}

type documentHistorySnapshotNode struct {
	ParentIndex int32  `json:"parent_index"`
	Text        string `json:"text"`
	TodoStatus  string `json:"todo_status,omitempty"`
	TodoID      int64  `json:"todo_id,omitempty"`
}

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

	directories, err := s.queries.ListDirectoriesByWorkspace(ctx, int32(workspaceID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list directories"))
	}

	docs, err := s.queries.ListDocumentsByWorkspace(ctx, int32(workspaceID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list documents"))
	}

	directoryResult := make([]*secretaryv1.Directory, 0, len(directories))
	for _, directory := range directories {
		directoryResult = append(directoryResult, directoryToProto(directory))
	}

	result := make([]*secretaryv1.Document, 0, len(docs))
	for _, doc := range docs {
		blocks, err := s.queries.ListBlocksByDocument(ctx, doc.ID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list document blocks"))
		}
		blockTodoStatuses, err := s.loadBlockTodoStatuses(ctx, s.queries, blocks)
		if err != nil {
			return nil, err
		}
		result = append(result, documentToProto(doc, blocks, blockTodoStatuses, nil))
	}

	return connect.NewResponse(&secretaryv1.ListDocumentsResponse{Documents: result, Directories: directoryResult}), nil
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
	blockTodoStatuses, err := s.loadBlockTodoStatuses(ctx, s.queries, blocks)
	if err != nil {
		return nil, err
	}

	return connect.NewResponse(&secretaryv1.GetDocumentResponse{Document: documentToProto(doc, blocks, blockTodoStatuses, nil)}), nil
}

func (s *Server) ListDocumentHistory(ctx context.Context, req *connect.Request[secretaryv1.ListDocumentHistoryRequest]) (*connect.Response[secretaryv1.ListDocumentHistoryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.DocumentId <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document_id is required"))
	}

	doc, err := s.queries.GetDocument(ctx, int32(req.Msg.DocumentId))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document"))
	}
	if err := s.ensureWorkspaceAccess(ctx, doc.WorkspaceID, int32(userID)); err != nil {
		return nil, err
	}

	history, err := s.queries.ListDocumentHistoryByDocument(ctx, doc.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list document history"))
	}

	result := make([]*secretaryv1.DocumentHistoryEntry, 0, len(history))
	for _, entry := range history {
		result = append(result, documentHistoryEntryToProto(entry))
	}

	return connect.NewResponse(&secretaryv1.ListDocumentHistoryResponse{History: result}), nil
}

func (s *Server) GetDocumentHistoryEntry(ctx context.Context, req *connect.Request[secretaryv1.GetDocumentHistoryEntryRequest]) (*connect.Response[secretaryv1.GetDocumentHistoryEntryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}

	entry, err := s.queries.GetDocumentHistoryEntry(ctx, req.Msg.Id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("document history entry not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document history entry"))
	}

	doc, err := s.queries.GetDocument(ctx, entry.DocumentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch document"))
	}
	if err := s.ensureWorkspaceAccess(ctx, doc.WorkspaceID, int32(userID)); err != nil {
		return nil, err
	}

	return connect.NewResponse(&secretaryv1.GetDocumentHistoryEntryResponse{History: documentHistoryEntryToProto(entry)}), nil
}

func (s *Server) CreateDirectory(ctx context.Context, req *connect.Request[secretaryv1.CreateDirectoryRequest]) (*connect.Response[secretaryv1.CreateDirectoryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	workspaceID := int32(req.Msg.WorkspaceId)
	if workspaceID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
	}
	if err := s.ensureWorkspaceAccess(ctx, workspaceID, int32(userID)); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Msg.Name)
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("directory name is required"))
	}
	parentID := toNullInt4(req.Msg.ParentId)
	if err := validateDirectoryParent(ctx, s.queries, workspaceID, parentID); err != nil {
		return nil, err
	}
	directory, err := s.queries.CreateDirectory(ctx, db.CreateDirectoryParams{
		WorkspaceID: workspaceID,
		ParentID:    parentID,
		Name:        name,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create directory"))
	}
	return connect.NewResponse(&secretaryv1.CreateDirectoryResponse{Directory: directoryToProto(directory)}), nil
}

func (s *Server) UpdateDirectory(ctx context.Context, req *connect.Request[secretaryv1.UpdateDirectoryRequest]) (*connect.Response[secretaryv1.UpdateDirectoryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	name := strings.TrimSpace(req.Msg.Name)
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("directory name is required"))
	}
	parentID := toNullInt4(req.Msg.ParentId)
	directory, err := s.queries.GetDirectory(ctx, int32(req.Msg.Id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("directory not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch directory"))
	}
	if err := s.ensureWorkspaceAccess(ctx, directory.WorkspaceID, int32(userID)); err != nil {
		return nil, err
	}
	if err := validateDirectoryParent(ctx, s.queries, directory.WorkspaceID, parentID); err != nil {
		return nil, err
	}
	if err := validateDirectoryMove(ctx, s.queries, directory.ID, parentID); err != nil {
		return nil, err
	}
	updatedDirectory, err := s.queries.UpdateDirectory(ctx, db.UpdateDirectoryParams{ID: directory.ID, Name: name, ParentID: parentID})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update directory"))
	}
	return connect.NewResponse(&secretaryv1.UpdateDirectoryResponse{Directory: directoryToProto(updatedDirectory)}), nil
}

func (s *Server) DeleteDirectory(ctx context.Context, req *connect.Request[secretaryv1.DeleteDirectoryRequest]) (*connect.Response[secretaryv1.DeleteDirectoryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}
	directory, err := s.queries.GetDirectory(ctx, int32(req.Msg.Id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("directory not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch directory"))
	}
	if err := s.ensureWorkspaceAccess(ctx, directory.WorkspaceID, int32(userID)); err != nil {
		return nil, err
	}
	directoryID := pgtype.Int4{Int32: directory.ID, Valid: true}
	childCount, err := s.queries.CountChildDirectories(ctx, directoryID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to check child directories"))
	}
	if childCount > 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("directory is not empty"))
	}
	documentCount, err := s.queries.CountDocumentsInDirectory(ctx, directoryID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to check directory documents"))
	}
	if documentCount > 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("directory is not empty"))
	}
	if err := s.queries.DeleteDirectory(ctx, directory.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete directory"))
	}
	return connect.NewResponse(&secretaryv1.DeleteDirectoryResponse{}), nil
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
	directoryID := toNullInt4(incoming.DirectoryId)

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
		if err := validateDocumentDirectory(ctx, qtx, existingDoc.WorkspaceID, kind, directoryID); err != nil {
			return nil, err
		}

		savedDoc, err = qtx.UpdateDocument(ctx, db.UpdateDocumentParams{
			ID:          existingDoc.ID,
			DirectoryID: directoryID,
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
		if err := validateDocumentDirectory(ctx, qtx, int32(incoming.WorkspaceId), kind, directoryID); err != nil {
			return nil, err
		}

		savedDoc, err = qtx.CreateDocument(ctx, db.CreateDocumentParams{
			WorkspaceID: int32(incoming.WorkspaceId),
			DirectoryID: directoryID,
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

	tempSortOrder := int32(-1)
	for _, existingBlock := range existingBlocks {
		updatedBlock, err := qtx.UpdateBlock(ctx, db.UpdateBlockParams{
			ID:            existingBlock.ID,
			DocumentID:    existingBlock.DocumentID,
			ParentBlockID: existingBlock.ParentBlockID,
			SortOrder:     tempSortOrder,
			Text:          existingBlock.Text,
			TodoID:        existingBlock.TodoID,
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to prepare block %d for save: %w", existingBlock.ID, err))
		}
		existingByID[existingBlock.ID] = updatedBlock
		tempSortOrder--
	}

	serverIDByClientKey := map[string]int32{}
	clientKeyByServerID := map[int32]string{}
	keptIDs := make([]int32, 0, len(incoming.Blocks))
	type savedBlockRecord struct {
		msg   *secretaryv1.Block
		block db.Block
	}
	savedRecords := make([]savedBlockRecord, 0, len(incoming.Blocks))

	for _, blockMsg := range incoming.Blocks {
		if err := validateBlockMessage(blockMsg); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}

		parentID, err := resolveParentBlockID(blockMsg, existingByID, serverIDByClientKey)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}

		todoID := pgtype.Int4{}
		if blockMsg.Id > 0 {
			todoID = existingByID[int32(blockMsg.Id)].TodoID
		}

		params := db.CreateBlockParams{
			DocumentID:    savedDoc.ID,
			ParentBlockID: parentID,
			SortOrder:     blockMsg.SortOrder,
			Text:          blockMsg.Text,
			TodoID:        todoID,
		}

		var savedBlock db.Block
		if blockMsg.Id > 0 {
			existingBlock, ok := existingByID[int32(blockMsg.Id)]
			if !ok {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("block %d does not belong to document", blockMsg.Id))
			}
			if blockMatchesParams(existingBlock, params) {
				savedBlock = existingBlock
			} else {
				savedBlock, err = qtx.UpdateBlock(ctx, db.UpdateBlockParams{
					ID:            int32(blockMsg.Id),
					DocumentID:    params.DocumentID,
					ParentBlockID: params.ParentBlockID,
					SortOrder:     params.SortOrder,
					Text:          params.Text,
					TodoID:        params.TodoID,
				})
			}
		} else {
			savedBlock, err = qtx.CreateBlock(ctx, params)
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to save block %d: %w", blockMsg.Id, err))
		}

		keptIDs = append(keptIDs, savedBlock.ID)
		clientKey := blockMsg.ClientKey
		if clientKey == "" {
			clientKey = defaultBlockClientKey(int64(savedBlock.ID))
		}
		serverIDByClientKey[clientKey] = savedBlock.ID
		clientKeyByServerID[savedBlock.ID] = clientKey
		savedRecords = append(savedRecords, savedBlockRecord{msg: blockMsg, block: savedBlock})
	}

	removedBlocks := removedBlocksByID(existingBlocks, keptIDs)
	for _, block := range removedBlocks {
		if !block.TodoID.Valid {
			continue
		}
		if err := deleteTodoWithHistory(ctx, qtx, block.TodoID.Int32, userID); err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete todo for removed block"))
		}
	}

	for index, record := range savedRecords {
		updatedBlock, err := s.reconcileBlockTodo(ctx, qtx, savedDoc, record.block, record.msg, userID)
		if err != nil {
			var connectErr *connect.Error
			if errors.As(err, &connectErr) {
				return nil, err
			}
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		if err := reconcileBlockDocumentLinks(ctx, qtx, savedDoc, updatedBlock); err != nil {
			return nil, err
		}
		savedRecords[index].block = updatedBlock
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
	blockTodoStatuses, err := s.loadBlockTodoStatuses(ctx, qtx, finalBlocks)
	if err != nil {
		return nil, err
	}
	if err := maybeCreateDocumentHistorySnapshot(ctx, qtx, finalDoc, finalBlocks, blockTodoStatuses); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit document transaction"))
	}

	clientKey := incoming.ClientKey
	if clientKey == "" {
		clientKey = defaultDocumentClientKey(int64(finalDoc.ID))
	}
	protoDoc := documentToProto(finalDoc, finalBlocks, blockTodoStatuses, clientKeyByServerID)
	protoDoc.ClientKey = clientKey

	return connect.NewResponse(&secretaryv1.SaveDocumentResponse{Document: protoDoc}), nil
}

func (s *Server) DeleteDocument(ctx context.Context, req *connect.Request[secretaryv1.DeleteDocumentRequest]) (*connect.Response[secretaryv1.DeleteDocumentResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id is required"))
	}

	doc, _, err := s.loadAuthorizedDocument(ctx, int32(req.Msg.Id), int32(userID))
	if err != nil {
		return nil, err
	}
	if doc.Kind != "note" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("only notes can be deleted"))
	}

	if err := s.queries.DeleteDocument(ctx, doc.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete document"))
	}

	return connect.NewResponse(&secretaryv1.DeleteDocumentResponse{}), nil
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

func directoryToProto(directory db.Directory) *secretaryv1.Directory {
	result := &secretaryv1.Directory{
		Id:          int64(directory.ID),
		WorkspaceId: int64(directory.WorkspaceID),
		Name:        directory.Name,
		Position:    directory.Position,
		CreatedAt:   formatTime(directory.CreatedAt),
		UpdatedAt:   formatTime(directory.UpdatedAt),
	}
	if directory.ParentID.Valid {
		result.ParentId = int64(directory.ParentID.Int32)
	}
	return result
}

func documentToProto(doc db.Document, blocks []db.Block, blockTodoStatuses map[int32]string, clientKeyByServerID map[int32]string) *secretaryv1.Document {
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
	if doc.DirectoryID.Valid {
		result.DirectoryId = int64(doc.DirectoryID.Int32)
	}
	for _, block := range blocks {
		result.Blocks = append(result.Blocks, blockToProto(block, blockTodoStatuses[block.ID], clientKeyByServerID[block.ID]))
	}
	return result
}

func documentHistoryEntryToProto(entry db.DocumentHistory) *secretaryv1.DocumentHistoryEntry {
	return &secretaryv1.DocumentHistoryEntry{
		Id:            entry.ID,
		DocumentId:    int64(entry.DocumentID),
		CaptureReason: entry.CaptureReason,
		ContentHash:   entry.ContentHash,
		SnapshotJson:  string(entry.SnapshotJson),
		CapturedAt:    formatTime(entry.CapturedAt),
	}
}

func blockToProto(block db.Block, todoStatus string, clientKey string) *secretaryv1.Block {
	if clientKey == "" {
		clientKey = defaultBlockClientKey(int64(block.ID))
	}
	result := &secretaryv1.Block{
		Id:         int64(block.ID),
		ClientKey:  clientKey,
		DocumentId: int64(block.DocumentID),
		SortOrder:  block.SortOrder,
		Text:       block.Text,
		TodoStatus: todoStatus,
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

func blockMatchesParams(block db.Block, params db.CreateBlockParams) bool {
	return block.DocumentID == params.DocumentID &&
		block.ParentBlockID == params.ParentBlockID &&
		block.SortOrder == params.SortOrder &&
		block.Text == params.Text &&
		block.TodoID == params.TodoID
}

func (s *Server) loadBlockTodoStatuses(ctx context.Context, queries *db.Queries, blocks []db.Block) (map[int32]string, error) {
	if len(blocks) == 0 {
		return map[int32]string{}, nil
	}

	statuses := make(map[int32]string, len(blocks))
	for _, block := range blocks {
		if !block.TodoID.Valid {
			continue
		}

		todo, err := queries.GetTodo(ctx, block.TodoID.Int32)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to load block todo"))
		}

		statuses[block.ID] = todo.Status.String
	}

	return statuses, nil
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

func validateDocumentDirectory(ctx context.Context, queries *db.Queries, workspaceID int32, kind string, directoryID pgtype.Int4) error {
	if kind == "journal" {
		if directoryID.Valid {
			return connect.NewError(connect.CodeInvalidArgument, errors.New("journals cannot belong to a directory"))
		}
		return nil
	}
	if !directoryID.Valid {
		return nil
	}

	directory, err := queries.GetDirectory(ctx, directoryID.Int32)
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("directory not found"))
	}
	if err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to validate directory"))
	}
	if directory.WorkspaceID != workspaceID {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("directory must belong to the same workspace as the document"))
	}
	return nil
}

func validateDirectoryParent(ctx context.Context, queries *db.Queries, workspaceID int32, parentID pgtype.Int4) error {
	if !parentID.Valid {
		return nil
	}
	parent, err := queries.GetDirectory(ctx, parentID.Int32)
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("parent directory not found"))
	}
	if err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to validate parent directory"))
	}
	if parent.WorkspaceID != workspaceID {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("parent directory must belong to the same workspace"))
	}
	return nil
}

func validateDirectoryMove(ctx context.Context, queries *db.Queries, directoryID int32, parentID pgtype.Int4) error {
	if !parentID.Valid {
		return nil
	}
	if parentID.Int32 == directoryID {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("directory cannot be its own parent"))
	}

	cursor := parentID.Int32
	seen := map[int32]struct{}{directoryID: {}}
	for cursor != 0 {
		if _, ok := seen[cursor]; ok {
			return connect.NewError(connect.CodeInvalidArgument, errors.New("directory cannot be moved into itself"))
		}
		seen[cursor] = struct{}{}
		directory, err := queries.GetDirectory(ctx, cursor)
		if errors.Is(err, pgx.ErrNoRows) {
			return connect.NewError(connect.CodeInvalidArgument, errors.New("parent directory not found"))
		}
		if err != nil {
			return connect.NewError(connect.CodeInternal, errors.New("failed to validate directory move"))
		}
		if !directory.ParentID.Valid {
			break
		}
		cursor = directory.ParentID.Int32
	}
	return nil
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
	if !validBlockTodoStatus(block.TodoStatus) {
		return fmt.Errorf("invalid block todo_status %q", block.TodoStatus)
	}
	if block.SortOrder <= 0 {
		return errors.New("sort_order must be positive")
	}
	return nil
}

func validBlockTodoStatus(status string) bool {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "":
		return true
	case "todo", "doing", "done", "blocked", "skipped":
		return true
	default:
		return false
	}
}

func parseBlockDocumentLinkTargetIDs(text string) ([]int32, error) {
	matches := documentLinkPattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil, nil
	}

	targetIDs := make([]int32, 0, len(matches))
	seen := make(map[int32]struct{}, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		parsed, err := strconv.ParseInt(match[1], 10, 32)
		if err != nil || parsed <= 0 {
			return nil, errors.New("document link id must be a positive integer")
		}
		targetID := int32(parsed)
		if _, ok := seen[targetID]; ok {
			continue
		}
		seen[targetID] = struct{}{}
		targetIDs = append(targetIDs, targetID)
	}

	return targetIDs, nil
}

func reconcileBlockDocumentLinks(ctx context.Context, queries *db.Queries, sourceDocument db.Document, block db.Block) error {
	targetIDs, err := parseBlockDocumentLinkTargetIDs(block.Text)
	if err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}

	if err := queries.DeleteBlockDocumentLinksByBlock(ctx, block.ID); err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to clear block document links"))
	}

	for _, targetID := range targetIDs {
		targetDocument, err := queries.GetDocument(ctx, targetID)
		if errors.Is(err, pgx.ErrNoRows) {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("linked document %d not found", targetID))
		}
		if err != nil {
			return connect.NewError(connect.CodeInternal, errors.New("failed to validate linked document"))
		}
		if targetDocument.WorkspaceID != sourceDocument.WorkspaceID {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("linked document %d must belong to the same workspace", targetID))
		}

		if err := queries.CreateBlockDocumentLink(ctx, db.CreateBlockDocumentLinkParams{
			BlockID:          block.ID,
			TargetDocumentID: targetID,
		}); err != nil {
			return connect.NewError(connect.CodeInternal, errors.New("failed to save block document link"))
		}
	}

	return nil
}

func maybeCreateDocumentHistorySnapshot(ctx context.Context, qtx *db.Queries, doc db.Document, blocks []db.Block, blockTodoStatuses map[int32]string) error {
	snapshotBytes, contentHash, err := buildDocumentHistorySnapshot(doc, blocks, blockTodoStatuses)
	if err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to build document history snapshot"))
	}

	latestEntry, err := qtx.GetLatestDocumentHistoryEntryByDocument(ctx, doc.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeInternal, errors.New("failed to load latest document history"))
	}
	if err == nil && latestEntry.ContentHash == contentHash {
		return nil
	}

	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	dayEnd := dayStart.Add(24 * time.Hour)
	_, todayErr := qtx.GetLatestDocumentHistoryEntryForDay(ctx, db.GetLatestDocumentHistoryEntryForDayParams{
		DocumentID:   doc.ID,
		CapturedAt:   pgtype.Timestamptz{Time: dayStart, Valid: true},
		CapturedAt_2: pgtype.Timestamptz{Time: dayEnd, Valid: true},
	})
	if todayErr != nil && !errors.Is(todayErr, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeInternal, errors.New("failed to load document history for day"))
	}

	reason := "periodic"
	shouldCapture := false
	if errors.Is(todayErr, pgx.ErrNoRows) {
		reason = "day_start"
		shouldCapture = true
	} else if errors.Is(err, pgx.ErrNoRows) {
		shouldCapture = true
	} else if latestEntry.CapturedAt.Valid && now.Sub(latestEntry.CapturedAt.Time.UTC()) >= documentHistoryMinInterval {
		shouldCapture = true
	}

	if !shouldCapture {
		return nil
	}

	if _, err := qtx.CreateDocumentHistoryEntry(ctx, db.CreateDocumentHistoryEntryParams{
		DocumentID:    doc.ID,
		CaptureReason: reason,
		ContentHash:   contentHash,
		SnapshotJson:  snapshotBytes,
		CapturedAt:    pgtype.Timestamptz{Time: now, Valid: true},
	}); err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to create document history snapshot"))
	}

	if err := qtx.DeleteOldDocumentHistoryByDocument(ctx, db.DeleteOldDocumentHistoryByDocumentParams{
		DocumentID: doc.ID,
		CapturedAt: pgtype.Timestamptz{Time: now.Add(-documentHistoryRetention), Valid: true},
	}); err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("failed to prune document history"))
	}

	return nil
}

func buildDocumentHistorySnapshot(doc db.Document, blocks []db.Block, blockTodoStatuses map[int32]string) ([]byte, string, error) {
	indexByID := make(map[int32]int32, len(blocks))
	for index, block := range blocks {
		indexByID[block.ID] = int32(index)
	}

	snapshot := documentHistorySnapshot{
		Title: doc.Title,
		Kind:  doc.Kind,
		Date:  formatDate(doc.JournalDate),
		Nodes: make([]documentHistorySnapshotNode, 0, len(blocks)),
	}
	for _, block := range blocks {
		parentIndex := int32(-1)
		if block.ParentBlockID.Valid {
			if resolved, ok := indexByID[block.ParentBlockID.Int32]; ok {
				parentIndex = resolved
			}
		}
		node := documentHistorySnapshotNode{
			ParentIndex: parentIndex,
			Text:        block.Text,
			TodoStatus:  blockTodoStatuses[block.ID],
		}
		if block.TodoID.Valid {
			node.TodoID = int64(block.TodoID.Int32)
		}
		snapshot.Nodes = append(snapshot.Nodes, node)
	}

	snapshotBytes, err := json.Marshal(snapshot)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256(snapshotBytes)
	return snapshotBytes, hex.EncodeToString(hash[:]), nil
}

func removedBlocksByID(existingBlocks []db.Block, keptIDs []int32) []db.Block {
	kept := make(map[int32]struct{}, len(keptIDs))
	for _, id := range keptIDs {
		kept[id] = struct{}{}
	}
	removed := make([]db.Block, 0)
	for _, block := range existingBlocks {
		if _, ok := kept[block.ID]; ok {
			continue
		}
		removed = append(removed, block)
	}
	return removed
}

func (s *Server) reconcileBlockTodo(ctx context.Context, qtx *db.Queries, doc db.Document, block db.Block, msg *secretaryv1.Block, userID int64) (db.Block, error) {
	status := strings.ToLower(strings.TrimSpace(msg.TodoStatus))
	if status == "" {
		if block.TodoID.Valid {
			if err := deleteTodoWithHistory(ctx, qtx, block.TodoID.Int32, userID); err != nil {
				return db.Block{}, err
			}
			block.TodoID = pgtype.Int4{}
		}
		return block, nil
	}

	name := strings.TrimSpace(msg.Text)
	if err := validateTodoInput(name, status); err != nil {
		return db.Block{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("task block %q is invalid: %w", msg.ClientKey, err))
	}

	desc := pgtype.Text{}
	workspaceID := pgtype.Int4{Int32: doc.WorkspaceID, Valid: true}
	sourceDocumentID := pgtype.Int4{Int32: doc.ID, Valid: true}
	sourceBlockID := pgtype.Int4{Int32: block.ID, Valid: true}
	userIDValue := pgtype.Int4{Int32: int32(userID), Valid: true}
	statusValue := pgtype.Text{String: status, Valid: true}

	if block.TodoID.Valid {
		todo, err := qtx.UpdateCanonicalTodoForBlock(ctx, db.UpdateCanonicalTodoForBlockParams{
			ID:               block.TodoID.Int32,
			Name:             name,
			Desc:             desc,
			Status:           statusValue,
			UserID:           userIDValue,
			WorkspaceID:      workspaceID,
			SourceDocumentID: sourceDocumentID,
			SourceBlockID:    sourceBlockID,
		})
		if err == nil {
			if err := createTodoHistoryEntry(ctx, qtx, todo.ID, userID, "update", todo.Name, todo.Desc, todo.Status, todo.UserID, todo.CreatedAtRecordingID, todo.UpdatedAtRecordingID); err != nil {
				return db.Block{}, err
			}
			return block, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return db.Block{}, err
		}
		block.TodoID = pgtype.Int4{}
	}

	todo, err := qtx.CreateCanonicalTodoForBlock(ctx, db.CreateCanonicalTodoForBlockParams{
		Name:             name,
		Desc:             desc,
		Status:           statusValue,
		UserID:           userIDValue,
		WorkspaceID:      workspaceID,
		SourceDocumentID: sourceDocumentID,
		SourceBlockID:    sourceBlockID,
	})
	if err != nil {
		return db.Block{}, err
	}
	if err := createTodoHistoryEntry(ctx, qtx, todo.ID, userID, "create", todo.Name, todo.Desc, todo.Status, todo.UserID, todo.CreatedAtRecordingID, todo.UpdatedAtRecordingID); err != nil {
		return db.Block{}, err
	}

	updatedBlock, err := qtx.UpdateBlock(ctx, db.UpdateBlockParams{
		ID:            block.ID,
		DocumentID:    block.DocumentID,
		ParentBlockID: block.ParentBlockID,
		SortOrder:     block.SortOrder,
		Text:          block.Text,
		TodoID:        pgtype.Int4{Int32: todo.ID, Valid: true},
	})
	if err != nil {
		return db.Block{}, err
	}
	return updatedBlock, nil
}

func deleteTodoWithHistory(ctx context.Context, qtx *db.Queries, todoID int32, userID int64) error {
	todo, err := qtx.GetTodo(ctx, todoID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := createTodoHistoryEntry(ctx, qtx, todo.ID, userID, "delete", todo.Name, todo.Desc, todo.Status, todo.UserID, todo.CreatedAtRecordingID, todo.UpdatedAtRecordingID); err != nil {
		return err
	}
	return qtx.DeleteTodo(ctx, todoID)
}

func createTodoHistoryEntry(ctx context.Context, qtx *db.Queries, todoID int32, actorUserID int64, changeType string, name string, desc pgtype.Text, status pgtype.Text, userID pgtype.Int4, createdAtRecordingID pgtype.Int4, updatedAtRecordingID pgtype.Int4) error {
	return qtx.CreateTodoHistory(ctx, db.CreateTodoHistoryParams{
		TodoID:               todoID,
		ActorUserID:          pgtype.Int4{Int32: int32(actorUserID), Valid: actorUserID > 0},
		ChangeType:           changeType,
		Name:                 pgtype.Text{String: name, Valid: strings.TrimSpace(name) != ""},
		Desc:                 desc,
		Status:               status,
		UserID:               userID,
		CreatedAtRecordingID: createdAtRecordingID,
		UpdatedAtRecordingID: updatedAtRecordingID,
	})
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
