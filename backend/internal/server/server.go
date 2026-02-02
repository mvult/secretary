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
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	"github.com/mvult/secretary/backend/gen/secretary/v1/secretaryv1connect"
	"github.com/mvult/secretary/backend/internal/db/gen"
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
}

func New(pool *pgxpool.Pool, jwtSecret []byte, tokenTTL time.Duration) *Server {
	return &Server{
		db:        pool,
		queries:   db.New(pool),
		jwtSecret: jwtSecret,
		tokenTTL:  tokenTTL,
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/login", s.handleLogin)

	// Mount ConnectRPC handlers
	recPath, recHandler := secretaryv1connect.NewRecordingsServiceHandler(s)
	mux.Handle(recPath, s.authMiddleware(recHandler))

	todoPath, todoHandler := secretaryv1connect.NewTodosServiceHandler(s)
	mux.Handle(todoPath, s.authMiddleware(todoHandler))

	userPath, userHandler := secretaryv1connect.NewUsersServiceHandler(s)
	mux.Handle(userPath, s.authMiddleware(userHandler))

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
		path = "index.html"
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
			todo := &secretaryv1.Todo{
				Id:                     int64(row.ID),
				Name:                   row.Name,
				Desc:                   row.Desc.String,
				Status:                 mapStatus(row.Status.String),
				UserId:                 int64(row.UserID.Int32),
				CreatedAtRecordingName: row.RecordingName.String,
				CreatedAtRecordingDate: formatTime(row.RecordingDate),
			}
			if row.CreatedAtRecordingID.Valid {
				todo.CreatedAtRecordingId = int64(row.CreatedAtRecordingID.Int32)
			}
			if row.UpdatedAtRecordingID.Valid {
				todo.UpdatedAtRecordingId = int64(row.UpdatedAtRecordingID.Int32)
			}
			todos = append(todos, todo)
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
			todo := &secretaryv1.Todo{
				Id:                     int64(row.ID),
				Name:                   row.Name,
				Desc:                   row.Desc.String,
				Status:                 mapStatus(row.Status.String),
				UserId:                 int64(row.UserID.Int32),
				CreatedAtRecordingName: row.RecordingName.String,
				CreatedAtRecordingDate: formatTime(row.RecordingDate),
			}
			if row.CreatedAtRecordingID.Valid {
				todo.CreatedAtRecordingId = int64(row.CreatedAtRecordingID.Int32)
			}
			if row.UpdatedAtRecordingID.Valid {
				todo.UpdatedAtRecordingId = int64(row.UpdatedAtRecordingID.Int32)
			}
			todos = append(todos, todo)
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

	todo := &secretaryv1.Todo{
		Id:                     int64(row.ID),
		Name:                   row.Name,
		Desc:                   row.Desc.String,
		Status:                 mapStatus(row.Status.String),
		UserId:                 int64(row.UserID.Int32),
		CreatedAtRecordingName: row.RecordingName.String,
		CreatedAtRecordingDate: formatTime(row.RecordingDate),
	}
	if row.CreatedAtRecordingID.Valid {
		todo.CreatedAtRecordingId = int64(row.CreatedAtRecordingID.Int32)
	}
	if row.UpdatedAtRecordingID.Valid {
		todo.UpdatedAtRecordingId = int64(row.UpdatedAtRecordingID.Int32)
	}

	return connect.NewResponse(&secretaryv1.GetTodoResponse{Todo: todo}), nil
}

func (s *Server) CreateTodo(ctx context.Context, req *connect.Request[secretaryv1.CreateTodoRequest]) (*connect.Response[secretaryv1.CreateTodoResponse], error) {
	msg := req.Msg
	statusStr := mapStatusToString(msg.Status)
	if err := validateTodoInput(msg.Name, statusStr); err != nil {
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
		Name:   msg.Name,
		Desc:   pgtype.Text{String: msg.Desc, Valid: msg.Desc != ""},
		Status: pgtype.Text{String: statusStr, Valid: true},
		UserID: pgtype.Int4{Int32: int32(msg.UserId), Valid: true},
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

	todo := &secretaryv1.Todo{
		Id:     int64(todoRow.ID),
		Name:   todoRow.Name,
		Desc:   todoRow.Desc.String,
		Status: mapStatus(todoRow.Status.String),
		UserId: int64(todoRow.UserID.Int32),
	}
	if todoRow.CreatedAtRecordingID.Valid {
		todo.CreatedAtRecordingId = int64(todoRow.CreatedAtRecordingID.Int32)
	}
	if todoRow.UpdatedAtRecordingID.Valid {
		todo.UpdatedAtRecordingId = int64(todoRow.UpdatedAtRecordingID.Int32)
	}

	return connect.NewResponse(&secretaryv1.CreateTodoResponse{Todo: todo}), nil
}

func (s *Server) UpdateTodo(ctx context.Context, req *connect.Request[secretaryv1.UpdateTodoRequest]) (*connect.Response[secretaryv1.UpdateTodoResponse], error) {
	msg := req.Msg
	statusStr := mapStatusToString(msg.Status)
	if err := validateTodoInput(msg.Name, statusStr); err != nil {
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
		ID:     int32(msg.Id),
		Name:   msg.Name,
		Desc:   pgtype.Text{String: msg.Desc, Valid: msg.Desc != ""},
		Status: pgtype.Text{String: statusStr, Valid: true},
		UserID: pgtype.Int4{Int32: int32(msg.UserId), Valid: true},
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

	todo := &secretaryv1.Todo{
		Id:     int64(todoRow.ID),
		Name:   todoRow.Name,
		Desc:   todoRow.Desc.String,
		Status: mapStatus(todoRow.Status.String),
		UserId: int64(todoRow.UserID.Int32),
	}
	if todoRow.CreatedAtRecordingID.Valid {
		todo.CreatedAtRecordingId = int64(todoRow.CreatedAtRecordingID.Int32)
	}
	if todoRow.UpdatedAtRecordingID.Valid {
		todo.UpdatedAtRecordingId = int64(todoRow.UpdatedAtRecordingID.Int32)
	}

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
	case "not_started", "partial", "done", "blocked", "skipped":
		return true
	default:
		return false
	}
}

func mapStatus(status string) secretaryv1.TodoStatus {
	// Normalize status to handle potential case/whitespace issues
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "not_started", "pending": // Handle legacy "pending"
		return secretaryv1.TodoStatus_TODO_STATUS_PARTIAL
	case "partial", "in_progress", "in progress": // Handle variations
		return secretaryv1.TodoStatus_TODO_STATUS_PARTIAL
	case "done", "completed":
		return secretaryv1.TodoStatus_TODO_STATUS_DONE
	case "blocked":
		return secretaryv1.TodoStatus_TODO_STATUS_BLOCKED
	case "skipped":
		return secretaryv1.TodoStatus_TODO_STATUS_SKIPPED
	default:
		// Fallback for unknown status strings
		return secretaryv1.TodoStatus_TODO_STATUS_UNSPECIFIED
	}
}

func mapStatusToString(status secretaryv1.TodoStatus) string {
	switch status {
	case secretaryv1.TodoStatus_TODO_STATUS_NOT_STARTED:
		return "not_started"
	case secretaryv1.TodoStatus_TODO_STATUS_PARTIAL:
		return "partial"
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
