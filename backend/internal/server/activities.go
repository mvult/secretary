package server

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/internal/db/gen"
)

func (s *Server) ListActivityTypes(ctx context.Context, _ *connect.Request[secretaryv1.ListActivityTypesRequest]) (*connect.Response[secretaryv1.ListActivityTypesResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	rows, err := s.queries.ListActivityTypesByUser(ctx, int32(userID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list activity types"))
	}

	activityTypes := make([]*secretaryv1.ActivityType, 0, len(rows))
	for _, row := range rows {
		activityTypes = append(activityTypes, activityTypeToProto(row))
	}
	return connect.NewResponse(&secretaryv1.ListActivityTypesResponse{ActivityTypes: activityTypes}), nil
}

func (s *Server) CreateActivityType(ctx context.Context, req *connect.Request[secretaryv1.CreateActivityTypeRequest]) (*connect.Response[secretaryv1.CreateActivityTypeResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	key := strings.TrimSpace(req.Msg.Key)
	name := strings.TrimSpace(req.Msg.Name)
	if key == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("activity type key is required"))
	}
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("activity type name is required"))
	}

	row, err := s.queries.CreateActivityType(ctx, db.CreateActivityTypeParams{
		UserID: int32(userID),
		Key:    key,
		Name:   name,
		Unit:   optionalText(req.Msg.Unit),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create activity type"))
	}

	return connect.NewResponse(&secretaryv1.CreateActivityTypeResponse{ActivityType: activityTypeToProto(row)}), nil
}

func (s *Server) DeleteActivityType(ctx context.Context, req *connect.Request[secretaryv1.DeleteActivityTypeRequest]) (*connect.Response[secretaryv1.DeleteActivityTypeResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("activity type id is required"))
	}

	if err := s.queries.DeleteActivityTypeForUser(ctx, db.DeleteActivityTypeForUserParams{ID: int32(req.Msg.Id), UserID: int32(userID)}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete activity type"))
	}
	return connect.NewResponse(&secretaryv1.DeleteActivityTypeResponse{}), nil
}

func (s *Server) ListActivityEntries(ctx context.Context, req *connect.Request[secretaryv1.ListActivityEntriesRequest]) (*connect.Response[secretaryv1.ListActivityEntriesResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	startAt, err := parseOptionalTimestamp(req.Msg.StartAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid start_at"))
	}
	endAt, err := parseOptionalTimestamp(req.Msg.EndAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid end_at"))
	}

	limit := req.Msg.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.queries.ListActivityEntriesForUser(ctx, db.ListActivityEntriesForUserParams{
		UserID:          int32(userID),
		ActivityTypeID:  optionalInt4(req.Msg.ActivityTypeId),
		ActivityTypeKey: optionalText(req.Msg.ActivityTypeKey),
		StartAt:         startAt,
		EndAt:           endAt,
		LimitCount:      limit,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list activity entries"))
	}

	entries := make([]*secretaryv1.ActivityEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, listActivityEntryToProto(row))
	}
	return connect.NewResponse(&secretaryv1.ListActivityEntriesResponse{ActivityEntries: entries}), nil
}

func (s *Server) CreateActivityEntry(ctx context.Context, req *connect.Request[secretaryv1.CreateActivityEntryRequest]) (*connect.Response[secretaryv1.CreateActivityEntryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}

	activityType, err := s.resolveActivityType(ctx, int32(userID), req.Msg.ActivityTypeId, req.Msg.ActivityTypeKey)
	if err != nil {
		return nil, err
	}
	occurredAt, err := parseOptionalTimestamp(req.Msg.OccurredAt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid occurred_at"))
	}
	data, err := marshalStruct(req.Msg.Data)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid activity data"))
	}

	row, err := s.queries.CreateActivityEntry(ctx, db.CreateActivityEntryParams{
		ActivityTypeID: activityType.ID,
		OccurredAt:     occurredAt,
		Value:          optionalFloat8(req.Msg.Value),
		Note:           optionalText(req.Msg.Note),
		Data:           data,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create activity entry"))
	}

	return connect.NewResponse(&secretaryv1.CreateActivityEntryResponse{ActivityEntry: activityEntryToProto(row, activityType.Key)}), nil
}

func (s *Server) UpdateActivityEntry(ctx context.Context, req *connect.Request[secretaryv1.UpdateActivityEntryRequest]) (*connect.Response[secretaryv1.UpdateActivityEntryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("activity entry id is required"))
	}
	occurredAt, err := parseOptionalTimestamp(req.Msg.OccurredAt)
	if err != nil || !occurredAt.Valid {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("valid occurred_at is required"))
	}
	data, err := marshalStruct(req.Msg.Data)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid activity data"))
	}

	row, err := s.queries.UpdateActivityEntryForUser(ctx, db.UpdateActivityEntryForUserParams{
		ID:         req.Msg.Id,
		UserID:     int32(userID),
		OccurredAt: occurredAt,
		Value:      optionalFloat8(req.Msg.Value),
		Note:       optionalText(req.Msg.Note),
		Data:       data,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("activity entry not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update activity entry"))
	}

	return connect.NewResponse(&secretaryv1.UpdateActivityEntryResponse{ActivityEntry: updatedActivityEntryToProto(row)}), nil
}

func (s *Server) DeleteActivityEntry(ctx context.Context, req *connect.Request[secretaryv1.DeleteActivityEntryRequest]) (*connect.Response[secretaryv1.DeleteActivityEntryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.Id <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("activity entry id is required"))
	}

	if err := s.queries.DeleteActivityEntryForUser(ctx, db.DeleteActivityEntryForUserParams{ID: req.Msg.Id, UserID: int32(userID)}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete activity entry"))
	}
	return connect.NewResponse(&secretaryv1.DeleteActivityEntryResponse{}), nil
}

func (s *Server) resolveActivityType(ctx context.Context, userID int32, id int64, key string) (db.ActivityType, error) {
	if id > 0 {
		row, err := s.queries.GetActivityTypeForUser(ctx, db.GetActivityTypeForUserParams{ID: int32(id), UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ActivityType{}, connect.NewError(connect.CodeNotFound, errors.New("activity type not found"))
		}
		if err != nil {
			return db.ActivityType{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch activity type"))
		}
		return row, nil
	}

	trimmedKey := strings.TrimSpace(key)
	if trimmedKey == "" {
		return db.ActivityType{}, connect.NewError(connect.CodeInvalidArgument, errors.New("activity_type_id or activity_type_key is required"))
	}
	row, err := s.queries.GetActivityTypeByKeyForUser(ctx, db.GetActivityTypeByKeyForUserParams{Key: trimmedKey, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.ActivityType{}, connect.NewError(connect.CodeNotFound, errors.New("activity type not found"))
	}
	if err != nil {
		return db.ActivityType{}, connect.NewError(connect.CodeInternal, errors.New("failed to fetch activity type"))
	}
	return row, nil
}

func activityTypeToProto(row db.ActivityType) *secretaryv1.ActivityType {
	return &secretaryv1.ActivityType{
		Id:        int64(row.ID),
		Key:       row.Key,
		Name:      row.Name,
		Unit:      row.Unit.String,
		CreatedAt: formatTime(row.CreatedAt),
	}
}

func activityEntryToProto(row db.ActivityEntry, activityTypeKey string) *secretaryv1.ActivityEntry {
	result := &secretaryv1.ActivityEntry{
		Id:              row.ID,
		ActivityTypeId:  int64(row.ActivityTypeID),
		ActivityTypeKey: activityTypeKey,
		OccurredAt:      formatTime(row.OccurredAt),
		Note:            row.Note.String,
		Data:            structFromJSON(row.Data),
		CreatedAt:       formatTime(row.CreatedAt),
	}
	if row.Value.Valid {
		result.Value = &row.Value.Float64
	}
	return result
}

func listActivityEntryToProto(row db.ListActivityEntriesForUserRow) *secretaryv1.ActivityEntry {
	result := &secretaryv1.ActivityEntry{
		Id:              row.ID,
		ActivityTypeId:  int64(row.ActivityTypeID),
		ActivityTypeKey: row.ActivityTypeKey,
		OccurredAt:      formatTime(row.OccurredAt),
		Note:            row.Note.String,
		Data:            structFromJSON(row.Data),
		CreatedAt:       formatTime(row.CreatedAt),
	}
	if row.Value.Valid {
		result.Value = &row.Value.Float64
	}
	return result
}

func updatedActivityEntryToProto(row db.UpdateActivityEntryForUserRow) *secretaryv1.ActivityEntry {
	result := &secretaryv1.ActivityEntry{
		Id:              row.ID,
		ActivityTypeId:  int64(row.ActivityTypeID),
		ActivityTypeKey: row.ActivityTypeKey,
		OccurredAt:      formatTime(row.OccurredAt),
		Note:            row.Note.String,
		Data:            structFromJSON(row.Data),
		CreatedAt:       formatTime(row.CreatedAt),
	}
	if row.Value.Valid {
		result.Value = &row.Value.Float64
	}
	return result
}

func optionalFloat8(value *float64) pgtype.Float8 {
	if value == nil {
		return pgtype.Float8{}
	}
	return pgtype.Float8{Float64: *value, Valid: true}
}
