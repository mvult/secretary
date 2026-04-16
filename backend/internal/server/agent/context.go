package agent

import (
	"fmt"
	"strings"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func (s *session) buildInstruction() (string, error) {
	parts := []string{
		"You are Secretary's integrated workspace assistant.",
		"Use the available tools to inspect documents, recordings, todos, and skills before answering when tool output would materially improve correctness.",
		"When you cite concrete workspace information, rely on the most relevant tool outputs for this run.",
	}
	if s.thread.DocumentID.Valid {
		doc, blocks, err := s.services.LoadAuthorizedDocument(s.ctx, s.thread.DocumentID.Int32, s.userID)
		if err == nil {
			parts = append(parts, "Current thread document:\n"+renderDocumentOutline(doc, blocks))
			_ = s.addSourceRef("document", int64(doc.ID), doc.Title, firstNonEmptyDocumentText(blocks))
		}
	}
	systemDoc, err := s.loadSystemDocument()
	if err != nil {
		return "", err
	}
	if systemDoc != nil {
		parts = append(parts, "Workspace System document:\n"+systemDoc.Content)
		_ = s.addSourceRef("document", systemDoc.DocumentID, systemDoc.Title, systemDoc.Content)
	}
	parts = append(parts, fmt.Sprintf("Thread title: %s", firstNonEmpty(s.thread.Title.String, untitledThreadName(s.thread))))
	parts = append(parts, fmt.Sprintf("Run mode: %s", s.mode))
	if s.mode == "ask" {
		parts = append(parts, "Do not modify documents or todos unless the user explicitly asks. Prefer retrieval and explanation.")
	}
	if len(s.skills) > 0 {
		names := make([]string, 0, len(s.skills))
		for _, skill := range s.skills {
			names = append(names, skill.Name)
		}
		parts = append(parts, "Available workspace skills: "+strings.Join(names, ", "))
	}
	return strings.Join(parts, "\n\n"), nil
}

func untitledThreadName(thread db.AiThread) string {
	if thread.DocumentID.Valid {
		return "Document thread"
	}
	if thread.Title.String == systemThreadName || thread.Title.String == workspaceThreadName {
		return thread.Title.String
	}
	return "Workspace thread"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
