package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"github.com/mvult/secretary/backend/internal/server/agent"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

type aiMutationArgs struct {
	Title         string `json:"title"`
	Content       string `json:"content"`
	DocumentID    int64  `json:"document_id"`
	BlockID       int64  `json:"block_id"`
	ParentBlockID int64  `json:"parent_block_id"`
	AfterBlockID  int64  `json:"after_block_id"`
	Text          string `json:"text"`
}

func aiCallEnvelope(call agent.MutationCall, phase string) (documentMutation, error) {
	if call.RunID <= 0 || strings.TrimSpace(call.CallID) == "" || !validDatabaseID(int64(call.UserID), false) || !validDatabaseID(int64(call.WorkspaceID), false) {
		return documentMutation{}, invalidIdentity("AI mutation requires run, call, actor and workspace identity")
	}
	// Operation and arguments are deliberately excluded from the identity: reusing
	// a provider call ID for different intent must fail the receipt fingerprint.
	identity, _ := json.Marshal([]string{"secretary.ai.tool.v1", phase, strconv.FormatInt(call.RunID, 10), call.CallID})
	mutation := uuid.NewSHA1(uuid.NameSpaceOID, identity).String()
	operation := "ai.tool." + phase
	if phase == "apply" && call.Name == "create_document" {
		// Creation-key reservations share the document.save namespace and constraint.
		operation = "document.save"
	}
	return commandEnvelope(int64(call.UserID), int64(call.WorkspaceID), 1, mutation, operation, map[string]any{
		"run_id": strconv.FormatInt(call.RunID, 10), "call_id": call.CallID, "tool": call.Name, "arguments": call.Arguments,
	})
}

func parseAIMutation(call agent.MutationCall) (aiMutationArgs, error) {
	var args aiMutationArgs
	decoder := json.NewDecoder(strings.NewReader(call.Arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return args, invalidIdentity("invalid AI mutation arguments")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return args, invalidIdentity("trailing AI mutation arguments")
	}
	if !validDatabaseID(args.ParentBlockID, true) || !validDatabaseID(args.AfterBlockID, true) {
		return args, invalidIdentity("invalid AI block placement")
	}
	switch call.Name {
	case "create_document":
		if strings.TrimSpace(args.Title) == "" || strings.EqualFold(strings.TrimSpace(args.Title), lockedSystemDocument) {
			return args, invalidIdentity("invalid or locked document title")
		}
	case "insert_block":
		if !validDatabaseID(args.DocumentID, false) || strings.TrimSpace(args.Text) == "" {
			return args, invalidIdentity("document ID and text are required")
		}
	case "move_block":
		if !validDatabaseID(args.BlockID, false) {
			return args, invalidIdentity("block ID is required")
		}
	default:
		return args, invalidIdentity("unsupported AI mutation tool")
	}
	return args, nil
}

func (s *Server) executeAIMutationCall(ctx context.Context, call agent.MutationCall) (string, error) {
	actor, err := requireUserID(ctx)
	if err != nil {
		return "", err
	}
	if actor != int64(call.UserID) {
		return "", invalidIdentity("AI mutation actor does not match session")
	}
	prepare, err := aiCallEnvelope(call, "prepare")
	if err != nil {
		return "", err
	}
	args, err := parseAIMutation(call)
	if err != nil {
		return "", err
	}
	// Authorize the durable run, its originating actor, and its workspace before
	// either receipt can replay. A run ID is not an authorization credential.
	run, err := s.getAuthorizedAIRun(ctx, call.RunID, actor)
	if err != nil {
		return "", err
	}
	message, err := s.queries.GetAIMessage(ctx, run.TriggerMessageID.Int64)
	if err != nil {
		return "", err
	}
	thread, err := s.queries.GetAIThread(ctx, message.ThreadID)
	if err != nil {
		return "", err
	}
	if !message.CreatedByUserID.Valid || message.CreatedByUserID.Int32 != call.UserID || thread.WorkspaceID != call.WorkspaceID {
		return "", invalidIdentity("AI mutation does not match its originating run")
	}
	// The existing immutable receipt store doubles as the intent log. Its result
	// retains exact argument bytes before any domain write, without a new schema.
	retained := &structpb.Struct{}
	err = s.runReceiptedCommand(ctx, prepare, retained, func(_ pgx.Tx, _ *db.Queries) error {
		value, err := structpb.NewStruct(map[string]any{"version": "1", "run_id": strconv.FormatInt(call.RunID, 10),
			"call_id": call.CallID, "tool": call.Name, "arguments": call.Arguments,
			"actor_id": strconv.Itoa(int(call.UserID)), "workspace_id": strconv.Itoa(int(call.WorkspaceID))})
		if err == nil {
			proto.Merge(retained, value)
		}
		return err
	})
	if err != nil {
		return "", err
	}
	op, err := aiCallEnvelope(call, "apply")
	if err != nil {
		return "", err
	}
	if call.Name == "create_document" {
		op.creationKey = "tool-" + uuid.UUID(op.mutation.Bytes).String()
	}
	result := &structpb.Struct{}
	err = s.runReceiptedCommand(ctx, op, result, func(tx pgx.Tx, q *db.Queries) error {
		env := &aiToolMutationEnv{ctx: ctx, server: s, workspaceID: call.WorkspaceID, userID: call.UserID}
		var documentID, blockID int64
		var message string
		if call.Name == "create_document" {
			mutationID := uuid.UUID(op.mutation.Bytes).String()
			id, err := env.createDocument(tx, q, mutationID, args.Title, args.Content)
			if err != nil {
				return err
			}
			documentID, message = id, "Document created."
		} else {
			docID := int32(args.DocumentID)
			block := db.Block{ID: int32(args.BlockID)}
			if call.Name == "move_block" {
				if err := tx.QueryRow(ctx, `SELECT document_id FROM block WHERE id=$1`, block.ID).Scan(&docID); err != nil {
					return err
				}
			}
			doc, err := q.GetDocument(ctx, docID)
			if err != nil {
				return err
			}
			if doc.WorkspaceID != call.WorkspaceID {
				return errors.New("AI target is outside the run workspace")
			}
			if call.Name == "insert_block" {
				block, err = env.insertDocumentBlock(q, doc, args.ParentBlockID, args.AfterBlockID, strings.TrimSpace(args.Text))
				message = "Block inserted."
			} else {
				block, err = env.moveDocumentBlock(q, block, doc, args.ParentBlockID, args.AfterBlockID)
				message = "Block moved."
			}
			if err != nil {
				return err
			}
			documentID, blockID = int64(doc.ID), int64(block.ID)
		}
		// Preserve the tool's existing JSON result, wrapped in a versioned typed receipt.
		output := fmt.Sprintf(`{"document_id":%d,"block_id":%d,"applied":true,"message":%q}`, documentID, blockID, message)
		targets := []any{strconv.FormatInt(documentID, 10)}
		for _, id := range env.targetIDs {
			targets = append(targets, strconv.FormatInt(id, 10))
		}
		value, err := structpb.NewStruct(map[string]any{"output": output, "target_ids": targets})
		if err != nil {
			return err
		}
		proto.Merge(result, value)
		return nil
	})
	if err != nil {
		return "", err
	}
	output := result.GetFields()["output"].GetStringValue()
	if output == "" {
		return "", errors.New("invalid retained AI mutation result")
	}
	return output, nil
}
