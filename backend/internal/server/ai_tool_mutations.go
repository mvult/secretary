package server

import (
	"context"
	"errors"
	"sort"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type aiToolMutationEnv struct {
	ctx         context.Context
	server      *Server
	workspaceID int32
	userID      int32
}

func (e *aiToolMutationEnv) createDocument(title string, content string) (int64, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return 0, errors.New("title is required")
	}
	if strings.EqualFold(title, lockedSystemDocument) {
		return 0, errors.New("the System document is locked")
	}
	directoryID, err := e.ensureAIDirectory()
	if err != nil {
		return 0, err
	}
	doc := &secretaryv1.Document{
		ClientKey:   "tool-" + uuid.NewString(),
		WorkspaceId: int64(e.workspaceID),
		Kind:        "note",
		Title:       title,
		DirectoryId: int64(directoryID),
		Blocks:      blocksFromPlainText(content, 0),
	}
	resp, err := e.server.SaveDocument(e.ctx, connect.NewRequest(&secretaryv1.SaveDocumentRequest{Document: doc}))
	if err != nil {
		return 0, err
	}
	return resp.Msg.Document.Id, nil
}

func (e *aiToolMutationEnv) insertBlock(documentID int64, parentBlockID int64, afterBlockID int64, text string) (int64, int64, error) {
	text = strings.TrimSpace(text)
	if documentID <= 0 {
		return 0, 0, errors.New("document_id is required")
	}
	if text == "" {
		return 0, 0, errors.New("text is required")
	}
	doc, _, err := e.server.loadAuthorizedDocument(e.ctx, int32(documentID), e.userID)
	if err != nil {
		return 0, 0, err
	}
	if isLockedSystemDocument(doc) {
		return 0, 0, errors.New("the System document is locked")
	}
	block, err := e.insertDocumentBlock(doc, parentBlockID, afterBlockID, text)
	if err != nil {
		return 0, 0, err
	}
	return int64(doc.ID), int64(block.ID), nil
}

func (e *aiToolMutationEnv) moveBlock(blockID int64, parentBlockID int64, afterBlockID int64) (int64, int64, error) {
	if blockID <= 0 {
		return 0, 0, errors.New("block_id is required")
	}
	block, doc, err := e.loadAuthorizedBlock(blockID)
	if err != nil {
		return 0, 0, err
	}
	if isLockedSystemDocument(doc) {
		return 0, 0, errors.New("the System document is locked")
	}
	moved, err := e.moveDocumentBlock(block, doc, parentBlockID, afterBlockID)
	if err != nil {
		return 0, 0, err
	}
	return int64(doc.ID), int64(moved.ID), nil
}

func (e *aiToolMutationEnv) loadAuthorizedBlock(blockID int64) (db.Block, db.Document, error) {
	if blockID <= 0 {
		return db.Block{}, db.Document{}, errors.New("block_id is required")
	}
	var block db.Block
	err := e.server.db.QueryRow(e.ctx, `
		SELECT id, document_id, parent_block_id, sort_order, text, todo_id, created_at, updated_at
		FROM block
		WHERE id = $1
	`, int32(blockID)).Scan(
		&block.ID,
		&block.DocumentID,
		&block.ParentBlockID,
		&block.SortOrder,
		&block.Text,
		&block.TodoID,
		&block.CreatedAt,
		&block.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Block{}, db.Document{}, errors.New("block not found")
	}
	if err != nil {
		return db.Block{}, db.Document{}, err
	}
	doc, _, err := e.server.loadAuthorizedDocument(e.ctx, block.DocumentID, e.userID)
	if err != nil {
		return db.Block{}, db.Document{}, err
	}
	return block, doc, nil
}

func (e *aiToolMutationEnv) insertDocumentBlock(doc db.Document, parentBlockID int64, afterBlockID int64, text string) (db.Block, error) {
	tx, err := e.server.db.BeginTx(e.ctx, pgx.TxOptions{})
	if err != nil {
		return db.Block{}, err
	}
	defer tx.Rollback(e.ctx)
	qtx := e.server.queries.WithTx(tx)
	blocks, err := qtx.ListBlocksByDocument(e.ctx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	blockByID := blocksByID(blocks)
	parentID, err := validateTargetParent(parentBlockID, doc.ID, blockByID)
	if err != nil {
		return db.Block{}, err
	}
	siblingIDs, insertIndex, err := insertionPosition(parentID, afterBlockID, blockByID, 0)
	if err != nil {
		return db.Block{}, err
	}
	created, err := qtx.CreateBlock(e.ctx, db.CreateBlockParams{DocumentID: doc.ID, ParentBlockID: parentID, SortOrder: 1, Text: text})
	if err != nil {
		return db.Block{}, err
	}
	ordered := insertInt32At(siblingIDs, insertIndex, created.ID)
	created, err = e.reindexSiblings(qtx, blockByID, doc, parentID, ordered, created.ID)
	if err != nil {
		return db.Block{}, err
	}
	if err := reconcileBlockDocumentLinks(e.ctx, qtx, doc, created); err != nil {
		return db.Block{}, err
	}
	finalDoc, finalBlocks, err := reloadDocumentAndBlocks(e.ctx, qtx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	statuses, err := e.server.loadBlockTodoStatuses(e.ctx, qtx, finalBlocks)
	if err != nil {
		return db.Block{}, err
	}
	if err := maybeCreateDocumentHistorySnapshot(e.ctx, qtx, finalDoc, finalBlocks, statuses); err != nil {
		return db.Block{}, err
	}
	if err := tx.Commit(e.ctx); err != nil {
		return db.Block{}, err
	}
	return created, nil
}

func (e *aiToolMutationEnv) moveDocumentBlock(block db.Block, doc db.Document, parentBlockID int64, afterBlockID int64) (db.Block, error) {
	tx, err := e.server.db.BeginTx(e.ctx, pgx.TxOptions{})
	if err != nil {
		return db.Block{}, err
	}
	defer tx.Rollback(e.ctx)
	qtx := e.server.queries.WithTx(tx)
	blocks, err := qtx.ListBlocksByDocument(e.ctx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	blockByID := blocksByID(blocks)
	current, ok := blockByID[block.ID]
	if !ok {
		return db.Block{}, errors.New("block not found")
	}
	parentID, err := validateTargetParent(parentBlockID, doc.ID, blockByID)
	if err != nil {
		return db.Block{}, err
	}
	if parentID.Valid && (parentID.Int32 == current.ID || isDescendantBlock(current.ID, parentID.Int32, blockByID)) {
		return db.Block{}, errors.New("cannot move a block into itself or its descendants")
	}
	oldParentID := current.ParentBlockID
	targetSiblingIDs, insertIndex, err := insertionPosition(parentID, afterBlockID, blockByID, current.ID)
	if err != nil {
		return db.Block{}, err
	}
	orderedTarget := insertInt32At(targetSiblingIDs, insertIndex, current.ID)
	moved, err := e.reindexSiblings(qtx, blockByID, doc, parentID, orderedTarget, current.ID)
	if err != nil {
		return db.Block{}, err
	}
	if !sameParent(oldParentID, parentID) {
		remaining := siblingIDsForParent(oldParentID, blockByID, current.ID)
		if _, err := e.reindexSiblings(qtx, blockByID, doc, oldParentID, remaining, 0); err != nil {
			return db.Block{}, err
		}
	}
	finalDoc, finalBlocks, err := reloadDocumentAndBlocks(e.ctx, qtx, doc.ID)
	if err != nil {
		return db.Block{}, err
	}
	statuses, err := e.server.loadBlockTodoStatuses(e.ctx, qtx, finalBlocks)
	if err != nil {
		return db.Block{}, err
	}
	if err := maybeCreateDocumentHistorySnapshot(e.ctx, qtx, finalDoc, finalBlocks, statuses); err != nil {
		return db.Block{}, err
	}
	if err := tx.Commit(e.ctx); err != nil {
		return db.Block{}, err
	}
	return moved, nil
}

func validateTargetParent(parentBlockID int64, documentID int32, blockByID map[int32]db.Block) (pgtype.Int4, error) {
	if parentBlockID <= 0 {
		return pgtype.Int4{}, nil
	}
	parent, ok := blockByID[int32(parentBlockID)]
	if !ok {
		return pgtype.Int4{}, errors.New("parent block not found")
	}
	if parent.DocumentID != documentID {
		return pgtype.Int4{}, errors.New("parent block must belong to the same document")
	}
	return pgtype.Int4{Int32: parent.ID, Valid: true}, nil
}

func insertionPosition(parentID pgtype.Int4, afterBlockID int64, blockByID map[int32]db.Block, excludeBlockID int32) ([]int32, int, error) {
	siblingIDs := siblingIDsForParent(parentID, blockByID, excludeBlockID)
	if afterBlockID <= 0 {
		return siblingIDs, 0, nil
	}
	after, ok := blockByID[int32(afterBlockID)]
	if !ok {
		return nil, 0, errors.New("after block not found")
	}
	if !sameParent(after.ParentBlockID, parentID) {
		return nil, 0, errors.New("after block must be a sibling under the target parent")
	}
	for index, siblingID := range siblingIDs {
		if siblingID == after.ID {
			return siblingIDs, index + 1, nil
		}
	}
	return nil, 0, errors.New("after block must be a sibling under the target parent")
}

func siblingIDsForParent(parentID pgtype.Int4, blockByID map[int32]db.Block, excludeBlockID int32) []int32 {
	siblings := make([]db.Block, 0)
	for _, block := range blockByID {
		if block.ID == excludeBlockID || !sameParent(block.ParentBlockID, parentID) {
			continue
		}
		siblings = append(siblings, block)
	}
	sort.SliceStable(siblings, func(i, j int) bool { return siblings[i].SortOrder < siblings[j].SortOrder })
	result := make([]int32, 0, len(siblings))
	for _, sibling := range siblings {
		result = append(result, sibling.ID)
	}
	return result
}

func (e *aiToolMutationEnv) reindexSiblings(qtx *db.Queries, blockByID map[int32]db.Block, doc db.Document, parentID pgtype.Int4, orderedIDs []int32, targetBlockID int32) (db.Block, error) {
	var target db.Block
	for index, blockID := range orderedIDs {
		block := blockByID[blockID]
		updated, err := qtx.UpdateBlock(e.ctx, db.UpdateBlockParams{ID: block.ID, DocumentID: block.DocumentID, ParentBlockID: parentID, SortOrder: int32(index + 1), Text: block.Text, TodoID: block.TodoID})
		if err != nil {
			return db.Block{}, err
		}
		blockByID[blockID] = updated
		if targetBlockID == 0 || updated.ID == targetBlockID {
			target = updated
		}
		if block.ParentBlockID != parentID || block.SortOrder != int32(index+1) {
			if err := reconcileBlockDocumentLinks(e.ctx, qtx, doc, updated); err != nil {
				return db.Block{}, err
			}
		}
	}
	return target, nil
}

func reloadDocumentAndBlocks(ctx context.Context, qtx *db.Queries, documentID int32) (db.Document, []db.Block, error) {
	doc, err := qtx.GetDocument(ctx, documentID)
	if err != nil {
		return db.Document{}, nil, err
	}
	blocks, err := qtx.ListBlocksByDocument(ctx, documentID)
	if err != nil {
		return db.Document{}, nil, err
	}
	return doc, blocks, nil
}

func blocksByID(blocks []db.Block) map[int32]db.Block {
	result := make(map[int32]db.Block, len(blocks))
	for _, block := range blocks {
		result[block.ID] = block
	}
	return result
}

func isDescendantBlock(blockID int32, candidateParentID int32, blockByID map[int32]db.Block) bool {
	currentID := candidateParentID
	for currentID != 0 {
		if currentID == blockID {
			return true
		}
		current, ok := blockByID[currentID]
		if !ok || !current.ParentBlockID.Valid {
			break
		}
		currentID = current.ParentBlockID.Int32
	}
	return false
}

func insertInt32At(values []int32, index int, value int32) []int32 {
	if index < 0 {
		index = 0
	}
	if index > len(values) {
		index = len(values)
	}
	result := make([]int32, 0, len(values)+1)
	result = append(result, values[:index]...)
	result = append(result, value)
	result = append(result, values[index:]...)
	return result
}

func sameParent(a pgtype.Int4, b pgtype.Int4) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.Int32 == b.Int32
}

func (e *aiToolMutationEnv) ensureAIDirectory() (int32, error) {
	directories, err := e.server.queries.ListDirectoriesByWorkspace(e.ctx, e.workspaceID)
	if err != nil {
		return 0, err
	}
	for _, directory := range directories {
		if !directory.ParentID.Valid && directory.Name == agentDirectoryName {
			return directory.ID, nil
		}
	}
	created, err := e.server.queries.CreateDirectory(e.ctx, db.CreateDirectoryParams{WorkspaceID: e.workspaceID, Name: agentDirectoryName})
	if err != nil {
		return 0, err
	}
	return created.ID, nil
}

func blocksFromPlainText(content string, documentID int64) []*secretaryv1.Block {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	blocks := make([]*secretaryv1.Block, 0, len(lines))
	stack := []string{}
	for _, rawLine := range lines {
		if strings.TrimSpace(rawLine) == "" {
			continue
		}
		depth := indentationDepth(rawLine)
		text := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(rawLine), "-*"))
		if text == "" {
			continue
		}
		clientKey := "tool-block-" + uuid.NewString()
		block := &secretaryv1.Block{ClientKey: clientKey, DocumentId: documentID, SortOrder: int32(len(blocks)), Text: text}
		if depth > 0 && depth <= len(stack) {
			block.ParentClientKey = stack[depth-1]
		}
		if depth >= len(stack) {
			stack = append(stack, clientKey)
		} else {
			stack = append(stack[:depth], clientKey)
		}
		if depth == 0 {
			stack = []string{clientKey}
		}
		blocks = append(blocks, block)
	}
	return blocks
}

func indentationDepth(line string) int {
	depth := 0
	spaces := 0
	for _, r := range line {
		if r == '\t' {
			depth++
			spaces = 0
			continue
		}
		if r == ' ' {
			spaces++
			if spaces == 2 {
				depth++
				spaces = 0
			}
			continue
		}
		break
	}
	return depth
}

func isLockedSystemDocument(doc db.Document) bool {
	return strings.EqualFold(strings.TrimSpace(doc.Title), lockedSystemDocument)
}
