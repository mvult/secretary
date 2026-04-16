package server

import (
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

const (
	agentDirectoryName   = "AI"
	agentSkillsDirectory = "skills"
	lockedSystemDocument = "System"
)

func clampString(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if limit <= 0 || len(trimmed) <= limit {
		return trimmed
	}
	return strings.TrimSpace(trimmed[:limit]) + "..."
}

func optionalUserID(userID int32) pgtype.Int4 {
	return pgtype.Int4{Int32: userID, Valid: userID > 0}
}
