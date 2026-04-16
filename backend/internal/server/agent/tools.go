package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

func (s *session) buildToolbox() (*toolbox, error) {
	definitions := []toolDefinition{
		{name: "list_directories", description: "List files and directories at a workspace path so you can browse the workspace like a human.", parameters: schemaObject(schemaString("path", "Directory path to inspect. Use '/' for root.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req listDirectoriesRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.listDirectories(req)
			return marshalToolResult(resp, err)
		}},
		{name: "search_documents", description: "Search workspace documents by title and body text.", parameters: schemaObject(schemaString("query", "Substring query to search for."), schemaInteger("limit", "Maximum number of documents to return.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req documentSearchRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.searchDocuments(req)
			return marshalToolResult(resp, err)
		}},
		{name: "get_document", description: "Load one document with its current outline content.", parameters: schemaObject(schemaInteger("document_id", "Document ID to load.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req getDocumentRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.getDocument(req)
			return marshalToolResult(resp, err)
		}},
		{name: "get_linked_documents", description: "Load documents linked from a document.", parameters: schemaObject(schemaInteger("document_id", "Document ID to inspect for links.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req getDocumentRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.getLinkedDocuments(req)
			return marshalToolResult(resp, err)
		}},
		{name: "list_todos", description: "List the current user's todos.", parameters: schemaObject(schemaString("status", "Optional status filter."), schemaInteger("limit", "Maximum number of todos to return.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req listTodosRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.listTodos(req)
			return marshalToolResult(resp, err)
		}},
		{name: "list_recordings", description: "List recent recordings with summaries.", parameters: schemaObject(schemaInteger("limit", "Maximum number of recordings to return.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req listRecordingsRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.listRecordings(req)
			return marshalToolResult(resp, err)
		}},
		{name: "get_recording", description: "Load one recording summary and transcript.", parameters: schemaObject(schemaInteger("recording_id", "Recording ID to load.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req getRecordingRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.getRecording(req)
			return marshalToolResult(resp, err)
		}},
		{name: "create_document", description: "Create a new note, usually in the AI subtree for memories or working notes.", parameters: schemaObject(schemaString("title", "Title for the new note."), schemaString("content", "Plaintext outline content for the note.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req createDocumentRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.createDocument(req)
			return marshalToolResult(resp, err)
		}},
		{name: "insert_block", description: "Insert a new block into an existing document without replacing other content.", parameters: schemaObject(schemaInteger("document_id", "Document ID to insert into."), schemaInteger("parent_block_id", "Optional parent block ID for nested insertion. Use 0 for root."), schemaInteger("after_block_id", "Optional sibling block ID to insert after. Use 0 to insert at the start."), schemaString("text", "Block text to insert.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req insertBlockRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.insertBlock(req)
			return marshalToolResult(resp, err)
		}},
		{name: "move_block", description: "Move an existing block to a new parent or sibling position without deleting content.", parameters: schemaObject(schemaInteger("block_id", "Block ID to move."), schemaInteger("parent_block_id", "Optional new parent block ID. Use 0 for root."), schemaInteger("after_block_id", "Optional sibling block ID to move after. Use 0 to move to the start.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req moveBlockRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.moveBlock(req)
			return marshalToolResult(resp, err)
		}},
		{name: "list_skills", description: "List workspace skills from the AI/skills directory.", parameters: schemaObject(), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			resp := listSkillsResponse{Skills: s.skillSummaries()}
			return marshalToolResult(resp, nil)
		}},
		{name: "get_skill", description: "Load the full document for one workspace skill by name.", parameters: schemaObject(schemaString("name", "Skill name to load.")), execute: func(ctx context.Context, raw json.RawMessage) (string, error) {
			var req getSkillRequest
			if err := decodeToolArgs(raw, &req); err != nil {
				return "", err
			}
			resp, err := s.getSkill(req)
			return marshalToolResult(resp, err)
		}},
	}
	byName := make(map[string]toolDefinition, len(definitions))
	modelTools := make([]modelTool, 0, len(definitions))
	for _, definition := range definitions {
		byName[definition.name] = definition
		modelTools = append(modelTools, modelTool{Type: "function", Function: modelToolFunction{Name: definition.name, Description: definition.description, Parameters: definition.parameters}})
	}
	return &toolbox{definitions: byName, modelTools: modelTools}, nil
}

func (t *toolbox) has(name string) bool {
	_, ok := t.definitions[name]
	return ok
}

func (t *toolbox) execute(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	definition, ok := t.definitions[name]
	if !ok {
		return "", fmt.Errorf("unknown tool %q", name)
	}
	return definition.execute(ctx, raw)
}

func schemaObject(properties ...map[string]any) map[string]any {
	props := map[string]any{}
	required := make([]string, 0, len(properties))
	for _, property := range properties {
		name, _ := property["_name"].(string)
		delete(property, "_name")
		props[name] = property
		required = append(required, name)
	}
	result := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func schemaString(name string, description string) map[string]any {
	return map[string]any{"_name": name, "type": "string", "description": description}
}

func schemaInteger(name string, description string) map[string]any {
	return map[string]any{"_name": name, "type": "integer", "description": description}
}

func decodeToolArgs(raw json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	return json.Unmarshal(trimmed, target)
}

func marshalToolResult(value any, err error) (string, error) {
	if err != nil {
		return "", err
	}
	encoded, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return "", marshalErr
	}
	return string(encoded), nil
}

func (s *session) skillSummaries() []skillSummary {
	result := make([]skillSummary, 0, len(s.skills))
	for _, entry := range s.skills {
		result = append(result, skillSummary{DocumentID: entry.DocumentID, Title: entry.Title, Name: entry.Name, Description: entry.Description, Metadata: entry.Metadata})
	}
	return result
}

func (s *session) getSkill(req getSkillRequest) (getSkillResponse, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return getSkillResponse{}, fmt.Errorf("name is required")
	}
	for _, entry := range s.skills {
		if entry.Name == name {
			_ = s.addSourceRef("document", entry.DocumentID, entry.Title, entry.Content)
			return getSkillResponse{DocumentID: entry.DocumentID, Title: entry.Title, Name: entry.Name, Description: entry.Description, Metadata: entry.Metadata, Content: entry.Content}, nil
		}
	}
	return getSkillResponse{}, fmt.Errorf("skill not found: %s", name)
}

func (s *session) addSourceRef(kind string, sourceID int64, label string, quote string) error {
	if s.runID == 0 || sourceID <= 0 {
		return nil
	}
	return s.services.CreateSourceRef(s.ctx, s.runID, kind, sourceID, label, clampString(strings.TrimSpace(quote), 400))
}
