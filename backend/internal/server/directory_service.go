package server

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/mvult/secretary/backend/internal/db/gen"
)

type directoryCommand struct {
	operation             string
	id, workspace, parent int64
	name                  string
	patch                 bool
	patchName             *string
	patchParent           *int64
}

func (c directoryCommand) validate(actor int64) error {
	if c.patch {
		if c.operation != "update" || (c.patchName == nil && c.patchParent == nil) {
			return invalidIdentity("directory patch must contain a change")
		}
		if c.patchName != nil && strings.TrimSpace(*c.patchName) == "" {
			return invalidIdentity("directory name is required")
		}
		if c.patchParent != nil && !validDatabaseID(*c.patchParent, true) {
			return invalidIdentity("invalid directory parent ID")
		}
	}
	if !validDatabaseID(actor, false) || !validDatabaseID(c.parent, true) {
		return invalidIdentity("invalid directory actor or parent ID")
	}
	switch c.operation {
	case "create":
		if !validDatabaseID(c.workspace, false) {
			return invalidIdentity("invalid directory workspace ID")
		}
	case "update", "delete":
		if !validDatabaseID(c.id, false) {
			return invalidIdentity("invalid directory ID")
		}
	default:
		return invalidIdentity("invalid directory operation")
	}
	if c.operation != "delete" && !c.patch && strings.TrimSpace(c.name) == "" {
		return invalidIdentity("directory name is required")
	}
	return nil
}

// Online directory commands share the document-placement workspace lock. They
// change directory metadata only; document IDs, placements and bodies stay intact.
// There is no automatic retry after an ambiguous commit (in particular creation).
func (s *Server) mutateDirectory(ctx context.Context, actor int64, c directoryCommand) (db.Directory, error) {
	if err := c.validate(actor); err != nil {
		return db.Directory{}, err
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return db.Directory{}, err
	}
	defer tx.Rollback(ctx)
	result, err := s.applyDirectoryCommand(ctx, s.queries.WithTx(tx), int32(actor), c)
	if err != nil {
		return db.Directory{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Directory{}, err
	}
	return result, nil
}

func (s *Server) applyDirectoryCommand(ctx context.Context, q *db.Queries, actor int32, c directoryCommand) (db.Directory, error) {
	workspace := int32(c.workspace)
	var directory db.Directory
	if c.operation != "create" {
		var err error
		directory, err = q.GetDirectory(ctx, int32(c.id))
		if err != nil {
			return directory, directoryLookupError(err)
		}
		workspace = directory.WorkspaceID
	}
	if _, err := s.lockPersistenceWriter(ctx, q, actor, persistenceWriterScope{workspace: workspace}); err != nil {
		return db.Directory{}, err
	}
	if c.operation != "create" {
		// Discovery preceded the lock: re-read even for deletion before checking
		// emptiness, so a concurrently deleted target cannot report success.
		current, err := q.GetDirectory(ctx, directory.ID)
		if err != nil {
			return db.Directory{}, directoryLookupError(err)
		}
		if current.WorkspaceID != workspace {
			return db.Directory{}, writerContention()
		}
		directory = current
	}
	if c.patch {
		c.name, c.parent = directory.Name, int64(directory.ParentID.Int32)
		if c.patchName != nil {
			c.name = *c.patchName
		}
		if c.patchParent != nil {
			c.parent = *c.patchParent
		}
	}
	parent := toNullInt4(c.parent)
	if c.operation == "delete" {
		id := pgtype.Int4{Int32: directory.ID, Valid: true}
		children, err := q.CountChildDirectories(ctx, id)
		if err != nil {
			return db.Directory{}, err
		}
		documents, err := q.CountDocumentsInDirectory(ctx, id)
		if err != nil {
			return db.Directory{}, err
		}
		if children > 0 || documents > 0 {
			return db.Directory{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("directory is not empty"))
		}
		return directory, q.DeleteDirectory(ctx, directory.ID)
	}
	if err := validateDirectoryParent(ctx, q, workspace, parent); err != nil {
		return db.Directory{}, err
	}
	if c.operation == "create" {
		return q.CreateDirectory(ctx, db.CreateDirectoryParams{WorkspaceID: workspace, ParentID: parent, Name: strings.TrimSpace(c.name)})
	}
	if err := validateDirectoryMove(ctx, q, directory.ID, parent); err != nil {
		return db.Directory{}, err
	}
	return q.UpdateDirectory(ctx, db.UpdateDirectoryParams{ID: directory.ID, Name: strings.TrimSpace(c.name), ParentID: parent})
}

func directoryLookupError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeNotFound, errors.New("directory not found"))
	}
	return err
}
