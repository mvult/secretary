package server

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/gen/secretary/v1/secretaryv1connect"
	"github.com/mvult/secretary/backend/internal/db/gen"
	"github.com/mvult/secretary/backend/internal/server/agent"
	whatsappsvc "github.com/mvult/secretary/backend/internal/whatsapp"
	"github.com/rs/cors"
	"golang.org/x/crypto/bcrypt"
)

//go:embed dist/*
var content embed.FS

type contextKey string

const userIdKey contextKey = "user_id"

type Server struct {
	db        *pgxpool.Pool
	queries   *db.Queries
	jwtSecret []byte
	tokenTTL  time.Duration
	aiRunner  agent.Runner
	aiAPIKey  string
	aiBaseURL string
	aiModel   string
	whatsapp  *whatsappsvc.Service

	s400Mu       sync.Mutex
	s400Sessions map[string]s400ScaleSession
	s400Recent   map[string]s400RecentMeasurement
}

func New(pool *pgxpool.Pool, jwtSecret []byte, tokenTTL time.Duration) *Server {
	return &Server{
		db:           pool,
		queries:      db.New(pool),
		jwtSecret:    jwtSecret,
		tokenTTL:     tokenTTL,
		s400Sessions: map[string]s400ScaleSession{},
		s400Recent:   map[string]s400RecentMeasurement{},
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/activity-events", s.handleActivityEvent)
	mux.Handle("/api/whatsapp/status", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppStatus)))
	mux.Handle("/api/whatsapp/qr", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppQR)))
	mux.Handle("/api/whatsapp/reconnect", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppReconnect)))
	mux.Handle("/api/whatsapp/logout", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppLogout)))
	mux.Handle("/api/whatsapp/settings", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppSettings)))
	mux.Handle("/api/whatsapp/notifications/pending", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppPendingNotifications)))
	mux.Handle("/api/whatsapp/notifications/mark-notified", s.authMiddleware(http.HandlerFunc(s.handleWhatsAppMarkNotified)))
	mux.Handle("/api/pomodoro/approve", s.authMiddleware(http.HandlerFunc(s.handlePomodoroApprove)))

	// Mount ConnectRPC handlers
	recPath, recHandler := secretaryv1connect.NewRecordingsServiceHandler(s)
	mux.Handle(recPath, s.authMiddleware(recHandler))

	todoPath, todoHandler := secretaryv1connect.NewTodosServiceHandler(s)
	mux.Handle(todoPath, s.authMiddleware(todoHandler))

	userPath, userHandler := secretaryv1connect.NewUsersServiceHandler(s)
	mux.Handle(userPath, s.authMiddleware(userHandler))

	workspacePath, workspaceHandler := secretaryv1connect.NewWorkspacesServiceHandler(s)
	mux.Handle(workspacePath, s.authMiddleware(workspaceHandler))

	documentPath, documentHandler := secretaryv1connect.NewDocumentsServiceHandler(s)
	mux.Handle(documentPath, s.authMiddleware(documentHandler))

	activityPath, activityHandler := secretaryv1connect.NewActivitiesServiceHandler(s)
	mux.Handle(activityPath, s.authMiddleware(activityHandler))

	aiPath, aiHandler := secretaryv1connect.NewAIServiceHandler(s)
	mux.Handle(aiPath, s.authMiddleware(aiHandler))

	c := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Accept", "Content-Type", "Content-Length", "Accept-Encoding", "X-CSRF-Token", "Authorization", "Connect-Protocol-Version", "Connect-Timeout-Ms", "Grpc-Timeout", "X-User-Agent", "X-Grpc-Web"},
		ExposedHeaders: []string{"Grpc-Status", "Grpc-Message", "Grpc-Status-Details-Bin"},
	})

	return c.Handler(mux)
}

// ServeHTTP implements the http.Handler interface
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// If path starts with /api, forward to the mux (API handlers)
	// We also need to handle ConnectRPC routes which might not start with /api
	// A simple check is to see if the file exists in the embedded FS
	// If it does, serve it. If it doesn't and it's not an API call, serve index.html (SPA fallback)

	// Since we are using standard http.ServeMux which doesn't support regex or easy fallback
	// We'll wrap the logic here.

	// Check if the request is for an API endpoint or ConnectRPC service
	// ConnectRPC services usually look like /secretary.v1.RecordingsService/ListRecordings
	// Our custom API endpoints start with /api
	if strings.HasPrefix(r.URL.Path, "/api") || strings.Contains(r.URL.Path, "Service/") || r.URL.Path == "/healthz" {
		s.Routes().ServeHTTP(w, r)
		return
	}

	// Try to serve static file
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}
	// dist/ is the root of our embedded FS
	fullPath := "dist" + path

	// Check if file exists in embedded FS
	f, err := content.Open(fullPath)
	if err == nil {
		defer f.Close()
		// Get content type
		ext := filepath.Ext(fullPath)
		contentType := "application/octet-stream"
		switch ext {
		case ".html":
			contentType = "text/html"
		case ".css":
			contentType = "text/css"
		case ".js":
			contentType = "application/javascript"
		case ".svg":
			contentType = "image/svg+xml"
		}
		w.Header().Set("Content-Type", contentType)

		stat, _ := f.Stat()
		http.ServeContent(w, r, fullPath, stat.ModTime(), f.(io.ReadSeeker))
		return
	}

	// Fallback to index.html for SPA
	indexFile, err := content.Open("dist/index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	defer indexFile.Close()
	stat, _ := indexFile.Stat()
	w.Header().Set("Content-Type", "text/html")
	http.ServeContent(w, r, "index.html", stat.ModTime(), indexFile.(io.ReadSeeker))
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Login remains a standard HTTP endpoint for now
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Email) == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	userRow, err := s.queries.GetUserByEmail(r.Context(), pgtype.Text{String: req.Email, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to login")
		return
	}

	if userRow.PasswordHash.String == "" || bcrypt.CompareHashAndPassword([]byte(userRow.PasswordHash.String), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := s.issueToken(int64(userRow.ID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user": map[string]any{
			"id":        userRow.ID,
			"firstName": userRow.FirstName,
			"lastName":  userRow.LastName.String,
			"role":      userRow.Role.String,
		},
	})
}

// --- RecordingsService Implementation ---

func (s *Server) ListRecordings(ctx context.Context, req *connect.Request[secretaryv1.ListRecordingsRequest]) (*connect.Response[secretaryv1.ListRecordingsResponse], error) {
	rows, err := s.queries.ListRecordings(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list recordings"))
	}

	var recordings []*secretaryv1.Recording
	for _, row := range rows {
		rec := &secretaryv1.Recording{
			Id:         int64(row.ID),
			CreatedAt:  formatTime(row.CreatedAt),
			Name:       row.Name.String,
			AudioUrl:   row.AudioUrl.String,
			Transcript: row.Transcript.String,
			Summary:    row.Summary.String,
			HasAudio:   row.AudioUrl.String != "",
		}
		if row.Duration.Valid {
			rec.Duration = row.Duration.Int32
		}
		recordings = append(recordings, rec)
	}
	return connect.NewResponse(&secretaryv1.ListRecordingsResponse{Recordings: recordings}), nil
}

func (s *Server) GetRecording(ctx context.Context, req *connect.Request[secretaryv1.GetRecordingRequest]) (*connect.Response[secretaryv1.GetRecordingResponse], error) {
	id := req.Msg.Id
	row, err := s.queries.GetRecording(ctx, int32(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("recording not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch recording"))
	}

	rec := &secretaryv1.Recording{
		Id:         int64(row.ID),
		CreatedAt:  formatTime(row.CreatedAt),
		Name:       row.Name.String,
		AudioUrl:   row.AudioUrl.String,
		Transcript: row.Transcript.String,
		Summary:    row.Summary.String,
		HasAudio:   row.AudioUrl.String != "",
	}
	if row.Duration.Valid {
		rec.Duration = row.Duration.Int32
	}

	// Fetch participants
	participants, err := s.queries.ListRecordingParticipants(ctx, int32(id))
	if err == nil {
		for _, p := range participants {
			rec.Participants = append(rec.Participants, &secretaryv1.User{
				Id:        int64(p.ID),
				FirstName: p.FirstName,
				LastName:  p.LastName.String,
				Role:      p.Role.String,
				SpeakerId: int32(p.SpeakerID),
			})
		}
	}

	return connect.NewResponse(&secretaryv1.GetRecordingResponse{Recording: rec}), nil
}

func (s *Server) DeleteRecording(ctx context.Context, req *connect.Request[secretaryv1.DeleteRecordingRequest]) (*connect.Response[secretaryv1.DeleteRecordingResponse], error) {
	userID, ok := ctx.Value(userIdKey).(int64)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("unauthenticated"))
	}
	user, err := s.queries.GetUser(ctx, int32(userID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch user"))
	}
	if user.Role.String != "admin" {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only admins can delete recordings"))
	}

	if err := s.queries.DeleteRecording(ctx, int32(req.Msg.Id)); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete recording"))
	}
	return connect.NewResponse(&secretaryv1.DeleteRecordingResponse{}), nil
}

// --- UsersService Implementation ---

func (s *Server) ListUsers(ctx context.Context, req *connect.Request[secretaryv1.ListUsersRequest]) (*connect.Response[secretaryv1.ListUsersResponse], error) {
	rows, err := s.queries.ListUsers(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list users"))
	}

	var users []*secretaryv1.User
	for _, row := range rows {
		users = append(users, &secretaryv1.User{
			Id:        int64(row.ID),
			FirstName: row.FirstName,
			LastName:  row.LastName.String,
			Role:      row.Role.String,
		})
	}
	return connect.NewResponse(&secretaryv1.ListUsersResponse{Users: users}), nil
}

// --- TodosService Implementation ---

func (s *Server) ListTodos(ctx context.Context, req *connect.Request[secretaryv1.ListTodosRequest]) (*connect.Response[secretaryv1.ListTodosResponse], error) {
	var todos []*secretaryv1.Todo

	if req.Msg.RecordingId != nil {
		// ... existing recording logic ...
		recordingID := *req.Msg.RecordingId
		rows, err := s.queries.ListTodosByRecording(ctx, pgtype.Int4{Int32: int32(recordingID), Valid: true})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list todos by recording"))
		}
		for _, row := range rows {
			todos = append(todos, listTodoByRecordingRowToProto(row))
		}
	} else {
		userID := req.Msg.UserId
		if userID == 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
		}

		rows, err := s.queries.ListTodosByUser(ctx, pgtype.Int4{Int32: int32(userID), Valid: true})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list todos"))
		}
		for _, row := range rows {
			todos = append(todos, listTodoByUserRowToProto(row))
		}
	}

	return connect.NewResponse(&secretaryv1.ListTodosResponse{Todos: todos}), nil
}

func (s *Server) GetTodo(ctx context.Context, req *connect.Request[secretaryv1.GetTodoRequest]) (*connect.Response[secretaryv1.GetTodoResponse], error) {
	id := req.Msg.Id
	row, err := s.queries.GetTodo(ctx, int32(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("todo not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch todo"))
	}

	todo := getTodoRowToProto(row)
	return connect.NewResponse(&secretaryv1.GetTodoResponse{Todo: todo}), nil
}

func (s *Server) CreateTodo(ctx context.Context, req *connect.Request[secretaryv1.CreateTodoRequest]) (*connect.Response[secretaryv1.CreateTodoResponse], error) {
	msg := req.Msg
	statusStr := mapStatusToString(msg.Status)
	if err := validateTodoInput(msg.Name, statusStr); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	bucket, err := normalizeTodoBucket(msg.Bucket, statusStr)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	deadline, err := parseDateOnly(msg.DeadlineDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to start transaction"))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.queries.WithTx(tx)

	// Create Todo
	arg := db.CreateTodoParams{
		Name:         msg.Name,
		Desc:         pgtype.Text{String: msg.Desc, Valid: msg.Desc != ""},
		Status:       pgtype.Text{String: statusStr, Valid: true},
		UserID:       pgtype.Int4{Int32: int32(msg.UserId), Valid: true},
		Bucket:       pgtype.Text{String: bucket, Valid: bucket != ""},
		PriorityRank: pgtype.Int4{Int32: int32(msg.PriorityRank), Valid: msg.PriorityRank != 0},
		DeadlineDate: deadline,
		GoalID:       pgtype.Int4{Int32: int32(msg.GoalId), Valid: msg.GoalId != 0},
	}
	if msg.CreatedAtRecordingId != 0 {
		arg.CreatedAtRecordingID = pgtype.Int4{Int32: int32(msg.CreatedAtRecordingId), Valid: true}
	}
	if msg.UpdatedAtRecordingId != 0 {
		arg.UpdatedAtRecordingID = pgtype.Int4{Int32: int32(msg.UpdatedAtRecordingId), Valid: true}
	}

	todoRow, err := qtx.CreateTodo(ctx, arg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create todo"))
	}

	// Create History
	actorID := msg.UserId // Defaulting to owner as actor
	historyArg := db.CreateTodoHistoryParams{
		TodoID:               todoRow.ID,
		ActorUserID:          pgtype.Int4{Int32: int32(actorID), Valid: true},
		ChangeType:           "create",
		Name:                 pgtype.Text{String: todoRow.Name, Valid: true},
		Desc:                 todoRow.Desc,
		Status:               todoRow.Status,
		UserID:               todoRow.UserID,
		CreatedAtRecordingID: todoRow.CreatedAtRecordingID,
		UpdatedAtRecordingID: todoRow.UpdatedAtRecordingID,
	}

	err = qtx.CreateTodoHistory(ctx, historyArg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create todo history"))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit todo"))
	}

	todo := todoTableRowToProto(todoRow, pgtype.Text{}, pgtype.Text{})

	return connect.NewResponse(&secretaryv1.CreateTodoResponse{Todo: todo}), nil
}

func (s *Server) UpdateTodo(ctx context.Context, req *connect.Request[secretaryv1.UpdateTodoRequest]) (*connect.Response[secretaryv1.UpdateTodoResponse], error) {
	msg := req.Msg
	statusStr := mapStatusToString(msg.Status)
	if err := validateTodoInput(msg.Name, statusStr); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	bucket, err := normalizeTodoBucket(msg.Bucket, statusStr)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	deadline, err := parseDateOnly(msg.DeadlineDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to start transaction"))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.queries.WithTx(tx)

	arg := db.UpdateTodoParams{
		ID:           int32(msg.Id),
		Name:         msg.Name,
		Desc:         pgtype.Text{String: msg.Desc, Valid: msg.Desc != ""},
		Status:       pgtype.Text{String: statusStr, Valid: true},
		UserID:       pgtype.Int4{Int32: int32(msg.UserId), Valid: true},
		Bucket:       pgtype.Text{String: bucket, Valid: bucket != ""},
		PriorityRank: pgtype.Int4{Int32: int32(msg.PriorityRank), Valid: msg.PriorityRank != 0},
		DeadlineDate: deadline,
		GoalID:       pgtype.Int4{Int32: int32(msg.GoalId), Valid: msg.GoalId != 0},
	}
	if msg.UpdatedAtRecordingId != 0 {
		arg.UpdatedAtRecordingID = pgtype.Int4{Int32: int32(msg.UpdatedAtRecordingId), Valid: true}
	}

	todoRow, err := qtx.UpdateTodo(ctx, arg)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("todo not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update todo"))
	}

	actorID := msg.UserId // Defaulting to owner
	historyArg := db.CreateTodoHistoryParams{
		TodoID:               todoRow.ID,
		ActorUserID:          pgtype.Int4{Int32: int32(actorID), Valid: true},
		ChangeType:           "update",
		Name:                 pgtype.Text{String: todoRow.Name, Valid: true},
		Desc:                 todoRow.Desc,
		Status:               todoRow.Status,
		UserID:               todoRow.UserID,
		CreatedAtRecordingID: todoRow.CreatedAtRecordingID,
		UpdatedAtRecordingID: todoRow.UpdatedAtRecordingID,
	}

	err = qtx.CreateTodoHistory(ctx, historyArg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update todo history"))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit todo"))
	}

	todo := todoTableRowToProto(todoRow, pgtype.Text{}, pgtype.Text{})

	return connect.NewResponse(&secretaryv1.UpdateTodoResponse{Todo: todo}), nil
}

func (s *Server) DeleteTodo(ctx context.Context, req *connect.Request[secretaryv1.DeleteTodoRequest]) (*connect.Response[secretaryv1.DeleteTodoResponse], error) {
	id := req.Msg.Id

	userID, ok := ctx.Value(userIdKey).(int64)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("unauthenticated"))
	}
	user, err := s.queries.GetUser(ctx, int32(userID))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to fetch user"))
	}
	if user.Role.String != "admin" {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only admins can delete todos"))
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to start transaction"))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.queries.WithTx(tx)

	// Fetch existing todo to record history
	todoRow, err := qtx.GetTodo(ctx, int32(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("todo not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete todo"))
	}

	actorID := todoRow.UserID.Int32 // Defaulting to owner
	historyArg := db.CreateTodoHistoryParams{
		TodoID:               todoRow.ID,
		ActorUserID:          pgtype.Int4{Int32: actorID, Valid: true},
		ChangeType:           "delete",
		Name:                 pgtype.Text{String: todoRow.Name, Valid: true},
		Desc:                 todoRow.Desc,
		Status:               todoRow.Status,
		UserID:               todoRow.UserID,
		CreatedAtRecordingID: todoRow.CreatedAtRecordingID,
		UpdatedAtRecordingID: todoRow.UpdatedAtRecordingID,
	}

	err = qtx.CreateTodoHistory(ctx, historyArg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete todo history"))
	}

	err = qtx.DeleteTodo(ctx, int32(id))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete todo"))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit delete"))
	}
	return connect.NewResponse(&secretaryv1.DeleteTodoResponse{}), nil
}

func (s *Server) ListTodoHistory(ctx context.Context, req *connect.Request[secretaryv1.ListTodoHistoryRequest]) (*connect.Response[secretaryv1.ListTodoHistoryResponse], error) {
	id := req.Msg.TodoId
	rows, err := s.queries.ListTodoHistory(ctx, int32(id))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list todo history"))
	}

	var history []*secretaryv1.TodoHistory
	for _, row := range rows {
		item := &secretaryv1.TodoHistory{
			Id:         int64(row.ID),
			TodoId:     int64(row.TodoID),
			ChangeType: row.ChangeType,
			Name:       row.Name.String,
			Desc:       row.Desc.String,
			Status:     mapStatus(row.Status.String),
			UserId:     int64(row.UserID.Int32),
			ChangedAt:  formatTime(row.ChangedAt),
		}
		if row.ActorUserID.Valid {
			item.ActorUserId = int64(row.ActorUserID.Int32)
		}
		if row.CreatedAtRecordingID.Valid {
			item.CreatedAtRecordingId = int64(row.CreatedAtRecordingID.Int32)
		}
		if row.UpdatedAtRecordingID.Valid {
			item.UpdatedAtRecordingId = int64(row.UpdatedAtRecordingID.Int32)
		}
		history = append(history, item)
	}
	return connect.NewResponse(&secretaryv1.ListTodoHistoryResponse{History: history}), nil
}

func (s *Server) ListTodoGoals(ctx context.Context, req *connect.Request[secretaryv1.ListTodoGoalsRequest]) (*connect.Response[secretaryv1.ListTodoGoalsResponse], error) {
	if req.Msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	rows, err := s.queries.ListTodoGoalsByUser(ctx, int32(req.Msg.UserId))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list todo goals"))
	}
	goals := make([]*secretaryv1.TodoGoal, 0, len(rows))
	for _, row := range rows {
		goals = append(goals, todoGoalRowToProto(row.ID, row.UserID, row.Name, row.Description, row.CreatedAt, row.UpdatedAt))
	}
	return connect.NewResponse(&secretaryv1.ListTodoGoalsResponse{Goals: goals}), nil
}

func (s *Server) CreateTodoGoal(ctx context.Context, req *connect.Request[secretaryv1.CreateTodoGoalRequest]) (*connect.Response[secretaryv1.CreateTodoGoalResponse], error) {
	if req.Msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	if strings.TrimSpace(req.Msg.Name) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	row, err := s.queries.CreateTodoGoal(ctx, db.CreateTodoGoalParams{
		UserID:      int32(req.Msg.UserId),
		Name:        strings.TrimSpace(req.Msg.Name),
		Description: req.Msg.Description,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create todo goal"))
	}
	return connect.NewResponse(&secretaryv1.CreateTodoGoalResponse{Goal: todoGoalRowToProto(row.ID, row.UserID, row.Name, row.Description, row.CreatedAt, row.UpdatedAt)}), nil
}

func (s *Server) UpdateTodoGoal(ctx context.Context, req *connect.Request[secretaryv1.UpdateTodoGoalRequest]) (*connect.Response[secretaryv1.UpdateTodoGoalResponse], error) {
	if req.Msg.Id == 0 || req.Msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id and user_id are required"))
	}
	if strings.TrimSpace(req.Msg.Name) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	row, err := s.queries.UpdateTodoGoal(ctx, db.UpdateTodoGoalParams{
		ID:          int32(req.Msg.Id),
		UserID:      int32(req.Msg.UserId),
		Name:        strings.TrimSpace(req.Msg.Name),
		Description: req.Msg.Description,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("todo goal not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to update todo goal"))
	}
	return connect.NewResponse(&secretaryv1.UpdateTodoGoalResponse{Goal: todoGoalRowToProto(row.ID, row.UserID, row.Name, row.Description, row.CreatedAt, row.UpdatedAt)}), nil
}

func (s *Server) DeleteTodoGoal(ctx context.Context, req *connect.Request[secretaryv1.DeleteTodoGoalRequest]) (*connect.Response[secretaryv1.DeleteTodoGoalResponse], error) {
	if req.Msg.Id == 0 || req.Msg.UserId == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("id and user_id are required"))
	}
	if err := s.queries.DeleteTodoGoal(ctx, db.DeleteTodoGoalParams{ID: int32(req.Msg.Id), UserID: int32(req.Msg.UserId)}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to delete todo goal"))
	}
	return connect.NewResponse(&secretaryv1.DeleteTodoGoalResponse{}), nil
}

func (s *Server) MoveDocumentTodosToRepository(ctx context.Context, req *connect.Request[secretaryv1.MoveDocumentTodosToRepositoryRequest]) (*connect.Response[secretaryv1.MoveDocumentTodosToRepositoryResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.DocumentId <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("document_id is required"))
	}

	doc, blocks, err := s.loadAuthorizedDocument(ctx, int32(req.Msg.DocumentId), int32(userID))
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to begin todo move transaction"))
	}
	defer tx.Rollback(ctx)
	qtx := s.queries.WithTx(tx)

	var movedCount int64
	for _, block := range blocks {
		if !block.TodoID.Valid {
			continue
		}
		todo, err := qtx.GetTodo(ctx, block.TodoID.Int32)
		if errors.Is(err, pgx.ErrNoRows) {
			_, clearErr := qtx.ClearBlockTodo(ctx, block.ID)
			if clearErr != nil {
				return nil, connect.NewError(connect.CodeInternal, errors.New("failed to clear stale block todo"))
			}
			continue
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to load block todo"))
		}
		if todo.Status.String == "done" {
			continue
		}
		if todo.UserID.Valid && todo.UserID.Int32 != int32(userID) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("todo belongs to another user"))
		}

		movedTodo, err := qtx.MoveTodoToRepository(ctx, todo.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to move todo to repository"))
		}
		if _, err := qtx.ClearBlockTodo(ctx, block.ID); err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to detach todo block"))
		}
		if err := createTodoHistoryEntry(ctx, qtx, movedTodo.ID, userID, "move_to_repository", movedTodo.Name, movedTodo.Desc, movedTodo.Status, movedTodo.UserID, movedTodo.CreatedAtRecordingID, movedTodo.UpdatedAtRecordingID); err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create todo history"))
		}
		movedCount++
	}

	if movedCount > 0 {
		finalBlocks, err := qtx.ListBlocksByDocument(ctx, doc.ID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to reload document blocks"))
		}
		blockTodoStatuses, err := s.loadBlockTodoStatuses(ctx, qtx, finalBlocks)
		if err != nil {
			return nil, err
		}
		if err := maybeCreateDocumentHistorySnapshot(ctx, qtx, doc, finalBlocks, blockTodoStatuses); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit todo move"))
	}

	return connect.NewResponse(&secretaryv1.MoveDocumentTodosToRepositoryResponse{MovedCount: movedCount}), nil
}

func (s *Server) PullOnDeckTodosToToday(ctx context.Context, req *connect.Request[secretaryv1.PullOnDeckTodosToTodayRequest]) (*connect.Response[secretaryv1.PullOnDeckTodosToTodayResponse], error) {
	userID, err := requireUserID(ctx)
	if err != nil {
		return nil, err
	}
	workspaceID := int32(req.Msg.WorkspaceId)
	if workspaceID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("workspace_id is required"))
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to begin todo pull transaction"))
	}
	defer tx.Rollback(ctx)
	qtx := s.queries.WithTx(tx)

	if err := s.ensureWorkspaceAccessWithQueries(ctx, qtx, workspaceID, int32(userID)); err != nil {
		return nil, err
	}

	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	journalDate := pgtype.Date{Time: today, Valid: true}
	journal, err := findWorkspaceJournalByDate(ctx, qtx, workspaceID, journalDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to look up today's journal"))
	}
	if journal == nil {
		dateTitle := today.Format(time.DateOnly)
		createdJournal, err := qtx.CreateDocument(ctx, db.CreateDocumentParams{
			WorkspaceID: workspaceID,
			DirectoryID: pgtype.Int4{},
			Kind:        "journal",
			Title:       dateTitle,
			JournalDate: journalDate,
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create today's journal"))
		}
		journal = &createdJournal
	}

	onDeckTodos, err := qtx.ListOnDeckTodosForPull(ctx, db.ListOnDeckTodosForPullParams{
		UserID:      pgtype.Int4{Int32: int32(userID), Valid: true},
		WorkspaceID: pgtype.Int4{Int32: workspaceID, Valid: true},
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list on-deck todos"))
	}

	blocks, err := qtx.ListBlocksByDocument(ctx, journal.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list journal blocks"))
	}
	nextSortOrder := int32(1)
	for _, block := range blocks {
		if !block.ParentBlockID.Valid && block.SortOrder >= nextSortOrder {
			nextSortOrder = block.SortOrder + 1
		}
	}

	var pulledCount int64
	for _, todo := range onDeckTodos {
		block, err := qtx.CreateBlock(ctx, db.CreateBlockParams{
			DocumentID:    journal.ID,
			ParentBlockID: pgtype.Int4{},
			SortOrder:     nextSortOrder,
			Text:          todo.Name,
			TodoID:        pgtype.Int4{Int32: todo.ID, Valid: true},
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create journal todo block"))
		}
		nextSortOrder++

		movedTodo, err := qtx.MoveTodoToDocumentBlock(ctx, db.MoveTodoToDocumentBlockParams{
			ID:                todo.ID,
			CurrentDocumentID: pgtype.Int4{Int32: journal.ID, Valid: true},
			CurrentBlockID:    pgtype.Int4{Int32: block.ID, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to move todo into journal"))
		}
		if err := createTodoHistoryEntry(ctx, qtx, movedTodo.ID, userID, "pull_on_deck_to_today", movedTodo.Name, movedTodo.Desc, movedTodo.Status, movedTodo.UserID, movedTodo.CreatedAtRecordingID, movedTodo.UpdatedAtRecordingID); err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to create todo history"))
		}
		pulledCount++
	}

	if pulledCount > 0 {
		finalBlocks, err := qtx.ListBlocksByDocument(ctx, journal.ID)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("failed to reload journal blocks"))
		}
		blockTodoStatuses, err := s.loadBlockTodoStatuses(ctx, qtx, finalBlocks)
		if err != nil {
			return nil, err
		}
		if err := maybeCreateDocumentHistorySnapshot(ctx, qtx, *journal, finalBlocks, blockTodoStatuses); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to commit todo pull"))
	}

	return connect.NewResponse(&secretaryv1.PullOnDeckTodosToTodayResponse{PulledCount: pulledCount, DocumentId: int64(journal.ID)}), nil
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/api/login" {
			next.ServeHTTP(w, r)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "missing token")
			return
		}
		tokenStr := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if tokenStr == "" {
			writeError(w, http.StatusUnauthorized, "missing token")
			return
		}
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("unexpected signing method")
			}
			return s.jwtSecret, nil
		})
		if err != nil || !token.Valid {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			writeError(w, http.StatusUnauthorized, "invalid token claims")
			return
		}
		sub, _ := claims.GetSubject()
		userID, _ := strconv.ParseInt(sub, 10, 64)
		ctx := context.WithValue(r.Context(), userIdKey, userID)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) issueToken(userID int64) (string, error) {
	now := time.Now().UTC()
	claims := jwt.RegisteredClaims{
		Subject:   strconv.FormatInt(userID, 10),
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(s.tokenTTL)),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func formatTime(ts pgtype.Timestamptz) string {
	if !ts.Valid {
		return ""
	}
	return ts.Time.UTC().Format(time.RFC3339)
}

func parseDateOnly(value string) (pgtype.Date, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.Date{}, nil
	}
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil {
		return pgtype.Date{}, errors.New("deadline_date must be YYYY-MM-DD")
	}
	return pgtype.Date{Time: parsed, Valid: true}, nil
}

func normalizeTodoBucket(bucket string, status string) (string, error) {
	bucket = strings.TrimSpace(bucket)
	if bucket == "" {
		switch status {
		case "done":
			return "done", nil
		case "blocked":
			return "blocked", nil
		default:
			return "", nil
		}
	}
	switch bucket {
	case "inbox", "on_deck", "blocked", "done":
		return bucket, nil
	default:
		return "", errors.New("invalid bucket")
	}
}

func validateTodoInput(name, status string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("name is required")
	}
	if status == "" {
		return errors.New("status is required")
	}
	if !validStatus(status) {
		return errors.New("invalid status")
	}
	return nil
}

func validStatus(status string) bool {
	switch status {
	case "todo", "doing", "done", "blocked", "skipped":
		return true
	default:
		return false
	}
}

func listTodoByUserRowToProto(row db.ListTodosByUserRow) *secretaryv1.Todo {
	return todoFieldsToProto(row.ID, row.Name, row.Desc, row.Status, row.UserID, row.CreatedAtRecordingID, row.UpdatedAtRecordingID, row.RecordingName, row.RecordingDate, row.CreatedAt, row.UpdatedAt, row.SourceKind, row.SourceDocumentID, row.SourceBlockID, row.Bucket, row.PriorityRank, row.DeadlineDate, row.GoalID, row.GoalName, row.CurrentDocumentID, row.CurrentBlockID, row.CompletedAt, row.CompletedDocumentID, row.CompletedBlockID)
}

func listTodoByRecordingRowToProto(row db.ListTodosByRecordingRow) *secretaryv1.Todo {
	return todoFieldsToProto(row.ID, row.Name, row.Desc, row.Status, row.UserID, row.CreatedAtRecordingID, row.UpdatedAtRecordingID, row.RecordingName, row.RecordingDate, row.CreatedAt, row.UpdatedAt, row.SourceKind, row.SourceDocumentID, row.SourceBlockID, row.Bucket, row.PriorityRank, row.DeadlineDate, row.GoalID, row.GoalName, row.CurrentDocumentID, row.CurrentBlockID, row.CompletedAt, row.CompletedDocumentID, row.CompletedBlockID)
}

func getTodoRowToProto(row db.GetTodoRow) *secretaryv1.Todo {
	return todoFieldsToProto(row.ID, row.Name, row.Desc, row.Status, row.UserID, row.CreatedAtRecordingID, row.UpdatedAtRecordingID, row.RecordingName, row.RecordingDate, row.CreatedAt, row.UpdatedAt, row.SourceKind, row.SourceDocumentID, row.SourceBlockID, row.Bucket, row.PriorityRank, row.DeadlineDate, row.GoalID, row.GoalName, row.CurrentDocumentID, row.CurrentBlockID, row.CompletedAt, row.CompletedDocumentID, row.CompletedBlockID)
}

func todoTableRowToProto(row db.Todo, recordingName pgtype.Text, goalName pgtype.Text) *secretaryv1.Todo {
	return todoFieldsToProto(row.ID, row.Name, row.Desc, row.Status, row.UserID, row.CreatedAtRecordingID, row.UpdatedAtRecordingID, recordingName, pgtype.Timestamptz{}, row.CreatedAt, row.UpdatedAt, row.SourceKind, row.SourceDocumentID, row.SourceBlockID, row.Bucket, row.PriorityRank, row.DeadlineDate, row.GoalID, goalName, row.CurrentDocumentID, row.CurrentBlockID, row.CompletedAt, row.CompletedDocumentID, row.CompletedBlockID)
}

func todoFieldsToProto(
	id int32, name string, desc pgtype.Text, status pgtype.Text, userID pgtype.Int4,
	createdAtRecordingID pgtype.Int4, updatedAtRecordingID pgtype.Int4, recordingName pgtype.Text,
	recordingDate pgtype.Timestamptz, createdAt pgtype.Timestamptz, updatedAt pgtype.Timestamptz,
	sourceKind string, sourceDocumentID pgtype.Int4, sourceBlockID pgtype.Int4,
	bucket pgtype.Text, priorityRank pgtype.Int4, deadlineDate pgtype.Date, goalID pgtype.Int4, goalName pgtype.Text,
	currentDocumentID pgtype.Int4, currentBlockID pgtype.Int4, completedAt pgtype.Timestamptz,
	completedDocumentID pgtype.Int4, completedBlockID pgtype.Int4,
) *secretaryv1.Todo {
	todo := &secretaryv1.Todo{
		Id:                     int64(id),
		Name:                   name,
		Desc:                   desc.String,
		Status:                 mapStatus(status.String),
		UserId:                 int64(userID.Int32),
		CreatedAtRecordingName: recordingName.String,
		CreatedAtRecordingDate: formatTime(recordingDate),
		CreatedAt:              formatTime(createdAt),
		UpdatedAt:              formatTime(updatedAt),
		SourceKind:             sourceKind,
		Bucket:                 bucket.String,
		DeadlineDate:           formatDate(deadlineDate),
		GoalName:               goalName.String,
		CompletedAt:            formatTime(completedAt),
	}
	if priorityRank.Valid {
		todo.PriorityRank = int64(priorityRank.Int32)
	}
	if goalID.Valid {
		todo.GoalId = int64(goalID.Int32)
	}
	if createdAtRecordingID.Valid {
		todo.CreatedAtRecordingId = int64(createdAtRecordingID.Int32)
	}
	if updatedAtRecordingID.Valid {
		todo.UpdatedAtRecordingId = int64(updatedAtRecordingID.Int32)
	}
	if sourceDocumentID.Valid {
		todo.SourceDocumentId = int64(sourceDocumentID.Int32)
	}
	if sourceBlockID.Valid {
		todo.SourceBlockId = int64(sourceBlockID.Int32)
	}
	if currentDocumentID.Valid {
		todo.CurrentDocumentId = int64(currentDocumentID.Int32)
	}
	if currentBlockID.Valid {
		todo.CurrentBlockId = int64(currentBlockID.Int32)
	}
	if completedDocumentID.Valid {
		todo.CompletedDocumentId = int64(completedDocumentID.Int32)
	}
	if completedBlockID.Valid {
		todo.CompletedBlockId = int64(completedBlockID.Int32)
	}
	return todo
}

func todoGoalRowToProto(id int32, userID int32, name string, description string, createdAt pgtype.Timestamptz, updatedAt pgtype.Timestamptz) *secretaryv1.TodoGoal {
	return &secretaryv1.TodoGoal{
		Id:          int64(id),
		UserId:      int64(userID),
		Name:        name,
		Description: description,
		CreatedAt:   formatTime(createdAt),
		UpdatedAt:   formatTime(updatedAt),
	}
}

func mapStatus(status string) secretaryv1.TodoStatus {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "todo":
		return secretaryv1.TodoStatus_TODO_STATUS_TODO
	case "doing":
		return secretaryv1.TodoStatus_TODO_STATUS_DOING
	case "done":
		return secretaryv1.TodoStatus_TODO_STATUS_DONE
	case "blocked":
		return secretaryv1.TodoStatus_TODO_STATUS_BLOCKED
	case "skipped":
		return secretaryv1.TodoStatus_TODO_STATUS_SKIPPED
	default:
		return secretaryv1.TodoStatus_TODO_STATUS_UNSPECIFIED
	}
}

func mapStatusToString(status secretaryv1.TodoStatus) string {
	switch status {
	case secretaryv1.TodoStatus_TODO_STATUS_TODO:
		return "todo"
	case secretaryv1.TodoStatus_TODO_STATUS_DOING:
		return "doing"
	case secretaryv1.TodoStatus_TODO_STATUS_DONE:
		return "done"
	case secretaryv1.TodoStatus_TODO_STATUS_BLOCKED:
		return "blocked"
	case secretaryv1.TodoStatus_TODO_STATUS_SKIPPED:
		return "skipped"
	default:
		return ""
	}
}

func nullInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

// Local Request struct for Login (not in proto)
type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
