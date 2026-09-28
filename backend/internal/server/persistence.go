package server

import (
	"errors"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
)

// Unsupported clients must retain their drafts/requests rather than bypassing
// the versioned write contract. Also used for unknown receipt result versions.
func persistenceProtocolNotEnabled() *connect.Error {
	err := connect.NewError(connect.CodeFailedPrecondition, errors.New("persistence protocol v1 is required; upgrade the client and retain the pending request"))
	detail, detailErr := connect.NewErrorDetail(&secretaryv1.PersistenceError{
		Reason: secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_PROTOCOL_UPGRADE_REQUIRED,
	})
	if detailErr == nil {
		err.AddDetail(detail)
	}
	return err
}
