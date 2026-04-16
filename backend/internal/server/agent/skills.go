package agent

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	db "github.com/mvult/secretary/backend/internal/db/gen"
	"gopkg.in/yaml.v3"
)

type parsedSkillFrontmatter struct {
	Name        string         `yaml:"name"`
	Description string         `yaml:"description"`
	Metadata    map[string]any `yaml:"metadata"`
}

func (s *session) loadSkills() error {
	directories, err := s.services.ListWorkspaceDirectories(s.ctx, s.workspaceID)
	if err != nil {
		return err
	}
	documents, err := s.services.ListWorkspaceDocuments(s.ctx, s.workspaceID)
	if err != nil {
		return err
	}
	aiDirectory := findDirectoryByName(directories, agentDirectoryName, 0)
	if aiDirectory == nil {
		return nil
	}
	skillsDirectory := findDirectoryByName(directories, agentSkillsDirectory, aiDirectory.ID)
	if skillsDirectory == nil {
		return nil
	}
	allowedDirectoryIDs := descendantDirectoryIDs(directories, skillsDirectory.ID)
	allowedDirectoryIDs[skillsDirectory.ID] = struct{}{}
	result := make([]skill, 0)
	for _, doc := range documents {
		if doc.Kind != "note" || !doc.DirectoryID.Valid {
			continue
		}
		if _, ok := allowedDirectoryIDs[doc.DirectoryID.Int32]; !ok {
			continue
		}
		blocks, err := s.services.ListDocumentBlocks(s.ctx, doc.ID)
		if err != nil {
			return err
		}
		entry, ok, err := skillFromDocument(doc, blocks)
		if err != nil || !ok {
			continue
		}
		result = append(result, entry)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].DocumentID < result[j].DocumentID
		}
		return result[i].Name < result[j].Name
	})
	s.skills = result
	return nil
}

func findDirectoryByName(directories []db.Directory, name string, parentID int32) *db.Directory {
	for i := range directories {
		actualParentID := int32(0)
		if directories[i].ParentID.Valid {
			actualParentID = directories[i].ParentID.Int32
		}
		if directories[i].Name == name && actualParentID == parentID {
			return &directories[i]
		}
	}
	return nil
}

func descendantDirectoryIDs(directories []db.Directory, rootID int32) map[int32]struct{} {
	childrenByParent := make(map[int32][]int32)
	for _, directory := range directories {
		if directory.ParentID.Valid {
			childrenByParent[directory.ParentID.Int32] = append(childrenByParent[directory.ParentID.Int32], directory.ID)
		}
	}
	result := map[int32]struct{}{}
	stack := []int32{rootID}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, childID := range childrenByParent[current] {
			if _, seen := result[childID]; seen {
				continue
			}
			result[childID] = struct{}{}
			stack = append(stack, childID)
		}
	}
	return result
}

func skillFromDocument(doc db.Document, blocks []db.Block) (skill, bool, error) {
	frontmatterText := firstSkillFrontmatterBlock(blocks)
	if strings.TrimSpace(frontmatterText) == "" {
		return skill{}, false, nil
	}
	parsed, err := parseSkillFrontmatter(frontmatterText)
	if err != nil {
		return skill{}, false, err
	}
	name := strings.TrimSpace(parsed.Name)
	if name == "" {
		return skill{}, false, errors.New("frontmatter name is required")
	}
	return skill{DocumentID: int64(doc.ID), Title: doc.Title, Name: name, Description: strings.TrimSpace(parsed.Description), Metadata: parsed.Metadata, Content: renderDocumentOutline(doc, blocks)}, true, nil
}

func firstSkillFrontmatterBlock(blocks []db.Block) string {
	rootBlocks := make([]db.Block, 0)
	for _, block := range blocks {
		if !block.ParentBlockID.Valid {
			rootBlocks = append(rootBlocks, block)
		}
	}
	if len(rootBlocks) == 0 {
		return ""
	}
	sort.SliceStable(rootBlocks, func(i, j int) bool { return rootBlocks[i].SortOrder < rootBlocks[j].SortOrder })
	return rootBlocks[0].Text
}

func parseSkillFrontmatter(raw string) (parsedSkillFrontmatter, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return parsedSkillFrontmatter{}, nil
	}
	if strings.HasPrefix(trimmed, "---") {
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "---"))
		if idx := strings.LastIndex(trimmed, "\n---"); idx >= 0 {
			trimmed = strings.TrimSpace(trimmed[:idx])
		} else if strings.HasSuffix(trimmed, "---") {
			trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, "---"))
		}
	}
	var parsed parsedSkillFrontmatter
	if err := yaml.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return parsedSkillFrontmatter{}, fmt.Errorf("parse skill frontmatter: %w", err)
	}
	return parsed, nil
}
