package agent

import (
	"errors"
	"strings"
)

func (s *session) listTodos(req listTodosRequest) (listTodosResponse, error) {
	rows, err := s.services.ListTodos(s.ctx, s.userID)
	if err != nil {
		return listTodosResponse{}, err
	}
	limit := req.Limit
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	statusFilter := strings.TrimSpace(strings.ToLower(req.Status))
	items := make([]Todo, 0, limit)
	for _, row := range rows {
		if statusFilter != "" && row.Status != statusFilter {
			continue
		}
		items = append(items, row)
		_ = s.addSourceRef("todo", row.ID, row.Name, row.Desc)
		if len(items) >= limit {
			break
		}
	}
	return listTodosResponse{Todos: items}, nil
}

func (s *session) listRecordings(req listRecordingsRequest) (listRecordingsResponse, error) {
	rows, err := s.services.ListRecordings(s.ctx)
	if err != nil {
		return listRecordingsResponse{}, err
	}
	limit := req.Limit
	if limit <= 0 || limit > defaultMaxRecordings {
		limit = defaultMaxRecordings
	}
	items := make([]Recording, 0, limit)
	for _, row := range rows {
		entry := Recording{ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt, Summary: clampString(row.Summary, 1200)}
		items = append(items, entry)
		_ = s.addSourceRef("recording", row.ID, row.Name, clampString(row.Summary, 240))
		if len(items) >= limit {
			break
		}
	}
	return listRecordingsResponse{Recordings: items}, nil
}

func (s *session) getRecording(req getRecordingRequest) (getRecordingResponse, error) {
	row, err := s.services.GetRecording(s.ctx, req.RecordingID)
	if err != nil {
		return getRecordingResponse{}, err
	}
	_ = s.addSourceRef("recording", row.ID, row.Name, clampString(row.Summary, 240))
	return getRecordingResponse{RecordingID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt, Summary: row.Summary, Transcript: clampString(row.Transcript, 12000)}, nil
}

func (s *session) createDocument(req createDocumentRequest) (mutateBlockResponse, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return mutateBlockResponse{}, errors.New("title is required")
	}
	if strings.EqualFold(title, lockedSystemDocument) {
		return mutateBlockResponse{}, errors.New("the System document is locked")
	}
	documentID, err := s.services.CreateDocument(s.ctx, s.workspaceID, title, req.Content)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	return mutateBlockResponse{DocumentID: documentID, Applied: true, Message: "Document created."}, nil
}

func (s *session) insertBlock(req insertBlockRequest) (mutateBlockResponse, error) {
	text := strings.TrimSpace(req.Text)
	if req.DocumentID <= 0 {
		return mutateBlockResponse{}, errors.New("document_id is required")
	}
	if text == "" {
		return mutateBlockResponse{}, errors.New("text is required")
	}
	documentID, blockID, err := s.services.InsertBlock(s.ctx, s.userID, req.DocumentID, req.ParentBlockID, req.AfterBlockID, text)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	return mutateBlockResponse{DocumentID: documentID, BlockID: blockID, Applied: true, Message: "Block inserted."}, nil
}

func (s *session) moveBlock(req moveBlockRequest) (mutateBlockResponse, error) {
	if req.BlockID <= 0 {
		return mutateBlockResponse{}, errors.New("block_id is required")
	}
	documentID, blockID, err := s.services.MoveBlock(s.ctx, s.userID, req.BlockID, req.ParentBlockID, req.AfterBlockID)
	if err != nil {
		return mutateBlockResponse{}, err
	}
	return mutateBlockResponse{DocumentID: documentID, BlockID: blockID, Applied: true, Message: "Block moved."}, nil
}
