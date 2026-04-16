package agent

import (
	"fmt"
	"sort"
	"strings"

	db "github.com/mvult/secretary/backend/internal/db/gen"
)

func renderDocumentOutline(doc db.Document, blocks []db.Block) string {
	if len(blocks) == 0 {
		return doc.Title
	}
	childMap := make(map[int32][]db.Block)
	for _, block := range blocks {
		parent := int32(0)
		if block.ParentBlockID.Valid {
			parent = block.ParentBlockID.Int32
		}
		childMap[parent] = append(childMap[parent], block)
	}
	var lines []string
	var walk func(int32, int)
	walk = func(parent int32, depth int) {
		children := childMap[parent]
		sort.SliceStable(children, func(i, j int) bool { return children[i].SortOrder < children[j].SortOrder })
		for _, block := range children {
			lines = append(lines, strings.Repeat("  ", depth)+"- "+block.Text)
			walk(block.ID, depth+1)
		}
	}
	walk(0, 0)
	return strings.Join(lines, "\n")
}

func snippetForQuery(content string, query string) string {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return ""
	}
	if query == "" {
		return clampString(trimmed, 240)
	}
	lower := strings.ToLower(trimmed)
	idx := strings.Index(lower, strings.ToLower(query))
	if idx < 0 {
		return clampString(trimmed, 240)
	}
	start := max(idx-80, 0)
	end := min(idx+len(query)+120, len(trimmed))
	return strings.TrimSpace(trimmed[start:end])
}

func firstNonEmptyDocumentText(blocks []db.Block) string {
	for _, block := range blocks {
		if strings.TrimSpace(block.Text) != "" {
			return block.Text
		}
	}
	return ""
}

func clampString(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if limit <= 0 || len(trimmed) <= limit {
		return trimmed
	}
	return strings.TrimSpace(trimmed[:limit]) + "..."
}

func summarizeMessages(messages []chatMessage, maxChars int) string {
	if len(messages) == 0 {
		return ""
	}
	var b strings.Builder
	for _, message := range messages {
		line := fmt.Sprintf("- %s: %s\n", message.Role, clampString(strings.TrimSpace(message.Content), 240))
		if b.Len()+len(line) > maxChars {
			break
		}
		b.WriteString(line)
	}
	return strings.TrimSpace(b.String())
}

func debugMessages(messages []chatMessage) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		entry := map[string]any{"role": message.Role, "content": clampString(message.Content, maxDebugContentChars)}
		if len(message.ToolCalls) > 0 {
			entry["tool_calls"] = debugToolCalls(message.ToolCalls)
		}
		if message.ToolCallID != "" {
			entry["tool_call_id"] = message.ToolCallID
		}
		result = append(result, entry)
	}
	return result
}

func debugToolCalls(calls []toolCall) []map[string]any {
	result := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		result = append(result, map[string]any{"id": call.ID, "name": call.Function.Name, "arguments": clampString(call.Function.Arguments, maxDebugContentChars)})
	}
	return result
}

func normalizeModelContent(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			text, _ := entry["text"].(string)
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func normalizeChatRole(role string) string {
	switch strings.TrimSpace(strings.ToLower(role)) {
	case "assistant", "system", "tool":
		return strings.TrimSpace(strings.ToLower(role))
	default:
		return "user"
	}
}
