package server

import (
	"errors"

	"connectrpc.com/connect"
	secretaryv1 "github.com/mvult/secretary/backend/gen/secretary/v1"
)

// The additive schema/wire foundation must not silently treat a versioned
// request as a legacy write. Remove this gate only when every writer participates
// in the shared locking/revision/receipt contract and reads are snapshot-consistent.
func persistenceProtocolNotEnabled() *connect.Error {
	err := connect.NewError(connect.CodeFailedPrecondition, errors.New("versioned persistence is not enabled on this server; retain the pending request"))
	detail, detailErr := connect.NewErrorDetail(&secretaryv1.PersistenceError{
		Reason: secretaryv1.PersistenceErrorReason_PERSISTENCE_ERROR_REASON_PROTOCOL_UPGRADE_REQUIRED,
	})
	if detailErr == nil {
		err.AddDetail(detail)
	}
	return err
}
