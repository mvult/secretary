package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	db        *pgxpool.Pool
	jwtSecret []byte
	tokenTTL  time.Duration
}

func New(db *pgxpool.Pool, jwtSecret []byte, tokenTTL time.Duration) *Server {
	return &Server{db: db, jwtSecret: jwtSecret, tokenTTL: tokenTTL}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/recordings", s.handleRecordings)
	mux.HandleFunc("/api/recordings/", s.handleRecordingByID)
	mux.HandleFunc("/api/users", s.handleUsers)
	mux.HandleFunc("/api/todos", s.handleTodos)
	mux.HandleFunc("/api/todos/", s.handleTodoByID)
	return s.authMiddleware(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

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

	var user User
	var passwordHash string
	err := s.db.QueryRow(r.Context(), `
    SELECT id, first_name, last_name, role, email, password_hash
    FROM "user"
    WHERE email = $1
  `, req.Email).Scan(
		&user.ID,
		&user.FirstName,
		&user.LastName,
		&user.Role,
		&user.Email,
		&passwordHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to login")
		return
	}
	if passwordHash == "" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := s.issueToken(user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  user,
	})
}

func (s *Server) handleRecordings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rows, err := s.db.Query(r.Context(), `
    SELECT
      r.id,
      r.created_at,
      r.name,
      r.audio_url,
      r.transcript,
      r.summary,
      r.duration
    FROM recording r
    ORDER BY r.created_at DESC
  `)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list recordings")
		return
	}
	defer rows.Close()

	recordings := make([]Recording, 0)
	for rows.Next() {
		var rec Recording
		var createdAt pgtype.Timestamptz
		var duration pgtype.Int4
		if err := rows.Scan(
			&rec.ID,
			&createdAt,
			&rec.Name,
			&rec.AudioURL,
			&rec.Transcript,
			&rec.Summary,
			&duration,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read recording")
			return
		}
		rec.CreatedAt = formatTime(createdAt)
		if duration.Valid {
			v := int32(duration.Int32)
			rec.Duration = &v
		}
		rec.HasAudio = rec.AudioURL != ""
		recordings = append(recordings, rec)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "failed to list recordings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recordings": recordings})
}

func (s *Server) handleRecordingByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id, ok := parseID(r.URL.Path, "/api/recordings/")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid recording id")
		return
	}
	var rec Recording
	var createdAt pgtype.Timestamptz
	var duration pgtype.Int4
	err := s.db.QueryRow(r.Context(), `
    SELECT
      r.id,
      r.created_at,
      r.name,
      r.audio_url,
      r.transcript,
      r.summary,
      r.duration
    FROM recording r
    WHERE r.id = $1
  `, id).Scan(
		&rec.ID,
		&createdAt,
		&rec.Name,
		&rec.AudioURL,
		&rec.Transcript,
		&rec.Summary,
		&duration,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "recording not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch recording")
		return
	}
	rec.CreatedAt = formatTime(createdAt)
	if duration.Valid {
		v := int32(duration.Int32)
		rec.Duration = &v
	}
	rec.HasAudio = rec.AudioURL != ""
	writeJSON(w, http.StatusOK, map[string]any{"recording": rec})
}

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rows, err := s.db.Query(r.Context(), `
    SELECT id, first_name, last_name, role
    FROM "user"
    ORDER BY id ASC
  `)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	defer rows.Close()

	users := make([]User, 0)
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.FirstName, &u.LastName, &u.Role); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read user")
			return
		}
		users = append(users, u)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) handleTodos(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListTodos(w, r)
	case http.MethodPost:
		s.handleCreateTodo(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleTodoByID(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if strings.HasSuffix(path, "/history") {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleListTodoHistory(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleGetTodo(w, r)
	case http.MethodPut:
		s.handleUpdateTodo(w, r)
	case http.MethodDelete:
		s.handleDeleteTodo(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleListTodos(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Query().Get("user_id")
	if userIDStr == "" {
		writeError(w, http.StatusBadRequest, "user_id is required")
		return
	}
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user_id")
		return
	}
	rows, err := s.db.Query(r.Context(), `
    SELECT
      t.id,
      t.name,
      t."desc",
      t.status,
      t.user_id,
      t.created_at_recording_id,
      t.updated_at_recording_id
    FROM todo t
    WHERE t.user_id = $1
    ORDER BY t.id DESC
  `, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list todos")
		return
	}
	defer rows.Close()

	todos := make([]Todo, 0)
	for rows.Next() {
		var todo Todo
		if err := rows.Scan(
			&todo.ID,
			&todo.Name,
			&todo.Desc,
			&todo.Status,
			&todo.UserID,
			&todo.CreatedAtRecordingID,
			&todo.UpdatedAtRecordingID,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read todo")
			return
		}
		todos = append(todos, todo)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "failed to list todos")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"todos": todos})
}

func (s *Server) handleGetTodo(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.URL.Path, "/api/todos/")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid todo id")
		return
	}
	var todo Todo
	err := s.db.QueryRow(r.Context(), `
    SELECT
      t.id,
      t.name,
      t."desc",
      t.status,
      t.user_id,
      t.created_at_recording_id,
      t.updated_at_recording_id
    FROM todo t
    WHERE t.id = $1
  `, id).Scan(
		&todo.ID,
		&todo.Name,
		&todo.Desc,
		&todo.Status,
		&todo.UserID,
		&todo.CreatedAtRecordingID,
		&todo.UpdatedAtRecordingID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "todo not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch todo")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"todo": todo})
}

func (s *Server) handleCreateTodo(w http.ResponseWriter, r *http.Request) {
	var req CreateTodoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateTodoInput(req.Name, req.Status); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.UserID == 0 {
		writeError(w, http.StatusBadRequest, "user_id is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var todo Todo
	err = tx.QueryRow(r.Context(), `
    INSERT INTO todo (
      name,
      "desc",
      status,
      user_id,
      created_at_recording_id,
      updated_at_recording_id
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, name, "desc", status, user_id, created_at_recording_id, updated_at_recording_id
  `, req.Name, req.Desc, req.Status, req.UserID, nullInt(req.CreatedAtRecordingID), nullInt(req.UpdatedAtRecordingID)).Scan(
		&todo.ID,
		&todo.Name,
		&todo.Desc,
		&todo.Status,
		&todo.UserID,
		&todo.CreatedAtRecordingID,
		&todo.UpdatedAtRecordingID,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create todo")
		return
	}

	actorID := req.ActorUserID
	if actorID == 0 {
		actorID = req.UserID
	}
	_, err = tx.Exec(r.Context(), `
    INSERT INTO todo_history (
      todo_id,
      actor_user_id,
      change_type,
      name,
      "desc",
      status,
      user_id,
      created_at_recording_id,
      updated_at_recording_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, todo.ID, nullInt(actorID), "create", todo.Name, todo.Desc, todo.Status, todo.UserID, nullInt(todo.CreatedAtRecordingID), nullInt(todo.UpdatedAtRecordingID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create todo history")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit todo")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"todo": todo})
}

func (s *Server) handleUpdateTodo(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.URL.Path, "/api/todos/")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid todo id")
		return
	}
	var req UpdateTodoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateTodoInput(req.Name, req.Status); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.UserID == 0 {
		writeError(w, http.StatusBadRequest, "user_id is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var todo Todo
	err = tx.QueryRow(r.Context(), `
    UPDATE todo
    SET
      name = $2,
      "desc" = $3,
      status = $4,
      user_id = $5,
      updated_at_recording_id = $6
    WHERE id = $1
    RETURNING id, name, "desc", status, user_id, created_at_recording_id, updated_at_recording_id
  `, id, req.Name, req.Desc, req.Status, req.UserID, nullInt(req.UpdatedAtRecordingID)).Scan(
		&todo.ID,
		&todo.Name,
		&todo.Desc,
		&todo.Status,
		&todo.UserID,
		&todo.CreatedAtRecordingID,
		&todo.UpdatedAtRecordingID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "todo not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update todo")
		return
	}

	actorID := req.ActorUserID
	if actorID == 0 {
		actorID = req.UserID
	}
	_, err = tx.Exec(r.Context(), `
    INSERT INTO todo_history (
      todo_id,
      actor_user_id,
      change_type,
      name,
      "desc",
      status,
      user_id,
      created_at_recording_id,
      updated_at_recording_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, todo.ID, nullInt(actorID), "update", todo.Name, todo.Desc, todo.Status, todo.UserID, nullInt(todo.CreatedAtRecordingID), nullInt(todo.UpdatedAtRecordingID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update todo history")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit todo")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"todo": todo})
}

func (s *Server) handleDeleteTodo(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.URL.Path, "/api/todos/")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid todo id")
		return
	}
	var req DeleteTodoRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var todo Todo
	err = tx.QueryRow(r.Context(), `
    SELECT
      t.id,
      t.name,
      t."desc",
      t.status,
      t.user_id,
      t.created_at_recording_id,
      t.updated_at_recording_id
    FROM todo t
    WHERE t.id = $1
  `, id).Scan(
		&todo.ID,
		&todo.Name,
		&todo.Desc,
		&todo.Status,
		&todo.UserID,
		&todo.CreatedAtRecordingID,
		&todo.UpdatedAtRecordingID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "todo not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete todo")
		return
	}

	actorID := req.ActorUserID
	if actorID == 0 {
		actorID = todo.UserID
	}
	_, err = tx.Exec(r.Context(), `
    INSERT INTO todo_history (
      todo_id,
      actor_user_id,
      change_type,
      name,
      "desc",
      status,
      user_id,
      created_at_recording_id,
      updated_at_recording_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, todo.ID, nullInt(actorID), "delete", todo.Name, todo.Desc, todo.Status, todo.UserID, nullInt(todo.CreatedAtRecordingID), nullInt(todo.UpdatedAtRecordingID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete todo history")
		return
	}

	_, err = tx.Exec(r.Context(), `DELETE FROM todo WHERE id = $1`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete todo")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit delete")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListTodoHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(strings.TrimSuffix(r.URL.Path, "/history"), "/api/todos/")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid todo id")
		return
	}
	rows, err := s.db.Query(r.Context(), `
    SELECT
      h.id,
      h.todo_id,
      h.actor_user_id,
      h.change_type,
      h.name,
      h."desc",
      h.status,
      h.user_id,
      h.created_at_recording_id,
      h.updated_at_recording_id,
      h.changed_at
    FROM todo_history h
    WHERE h.todo_id = $1
    ORDER BY h.changed_at DESC
  `, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list todo history")
		return
	}
	defer rows.Close()

	history := make([]TodoHistory, 0)
	for rows.Next() {
		var item TodoHistory
		var changedAt pgtype.Timestamptz
		if err := rows.Scan(
			&item.ID,
			&item.TodoID,
			&item.ActorUserID,
			&item.ChangeType,
			&item.Name,
			&item.Desc,
			&item.Status,
			&item.UserID,
			&item.CreatedAtRecordingID,
			&item.UpdatedAtRecordingID,
			&changedAt,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read todo history")
			return
		}
		item.ChangedAt = formatTime(changedAt)
		history = append(history, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "failed to list todo history")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": history})
}

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
		next.ServeHTTP(w, r)
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

func parseID(path, prefix string) (int64, bool) {
	if !strings.HasPrefix(path, prefix) {
		return 0, false
	}
	raw := strings.TrimPrefix(path, prefix)
	if raw == "" || strings.Contains(raw, "/") {
		raw = strings.Split(raw, "/")[0]
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
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

func nullInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

type Recording struct {
	ID         int64  `json:"id"`
	Name       string `json:"name,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	Duration   *int32 `json:"duration,omitempty"`
	Summary    string `json:"summary,omitempty"`
	Transcript string `json:"transcript,omitempty"`
	AudioURL   string `json:"audio_url,omitempty"`
	HasAudio   bool   `json:"has_audio"`
}

type User struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Role      string `json:"role,omitempty"`
	Email     string `json:"email,omitempty"`
}

type Todo struct {
	ID                   int64  `json:"id"`
	Name                 string `json:"name"`
	Desc                 string `json:"desc,omitempty"`
	Status               string `json:"status"`
	UserID               int64  `json:"user_id"`
	CreatedAtRecordingID int64  `json:"created_at_recording_id,omitempty"`
	UpdatedAtRecordingID int64  `json:"updated_at_recording_id,omitempty"`
}

type TodoHistory struct {
	ID                   int64  `json:"id"`
	TodoID               int64  `json:"todo_id"`
	ActorUserID          int64  `json:"actor_user_id,omitempty"`
	ChangeType           string `json:"change_type"`
	Name                 string `json:"name,omitempty"`
	Desc                 string `json:"desc,omitempty"`
	Status               string `json:"status,omitempty"`
	UserID               int64  `json:"user_id,omitempty"`
	CreatedAtRecordingID int64  `json:"created_at_recording_id,omitempty"`
	UpdatedAtRecordingID int64  `json:"updated_at_recording_id,omitempty"`
	ChangedAt            string `json:"changed_at,omitempty"`
}

type CreateTodoRequest struct {
	Name                 string `json:"name"`
	Desc                 string `json:"desc"`
	Status               string `json:"status"`
	UserID               int64  `json:"user_id"`
	CreatedAtRecordingID int64  `json:"created_at_recording_id"`
	UpdatedAtRecordingID int64  `json:"updated_at_recording_id"`
	ActorUserID          int64  `json:"actor_user_id"`
}

type UpdateTodoRequest struct {
	Name                 string `json:"name"`
	Desc                 string `json:"desc"`
	Status               string `json:"status"`
	UserID               int64  `json:"user_id"`
	UpdatedAtRecordingID int64  `json:"updated_at_recording_id"`
	ActorUserID          int64  `json:"actor_user_id"`
}

type DeleteTodoRequest struct {
	ActorUserID int64 `json:"actor_user_id"`
}

type ListTodoHistoryRequest struct {
	TodoID int64 `json:"todo_id"`
}

type ListTodosRequest struct {
	UserID int64 `json:"user_id"`
}

type ListRecordingsRequest struct{}

type GetRecordingRequest struct {
	ID int64 `json:"id"`
}

type GetTodoRequest struct {
	ID int64 `json:"id"`
}

type ListUsersRequest struct{}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
