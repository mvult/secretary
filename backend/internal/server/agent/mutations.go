package agent

import (
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
