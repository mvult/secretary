package whatsapp

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow"
)

func TestExpiredPairingCannotOverwriteFreshQR(t *testing.T) {
	s := New(nil, "", nil)
	oldCtx, cancel := context.WithCancel(context.Background())
	s.handleQRItem(oldCtx, whatsmeow.QRChannelTimeout)
	if s.status.LastError != "qr: timeout" {
		t.Fatal("expected initial pairing timeout")
	}
	cancel()
	ctx := context.Background()
	s.handleQRItem(ctx, whatsmeow.QRChannelItem{Event: "code", Code: "fresh-code"})
	// The previous listener may already have dequeued an event when cancelled.
	s.handleQRItem(oldCtx, whatsmeow.QRChannelTimeout)
	s.handleQRItem(oldCtx, whatsmeow.QRChannelItem{Event: "code", Code: "expired-code"})
	qr, status := s.QR()
	if qr != "fresh-code" || status.LastError != "" || !status.Pairing || !status.HasQR {
		t.Fatalf("expired session overwrote fresh pairing: qr=%q status=%+v", qr, status)
	}
	s.handleQRItem(ctx, whatsmeow.QRChannelSuccess)
	qr, status = s.QR()
	if qr != "" || status.HasQR || status.Pairing || status.LastError != "" {
		t.Fatalf("successful pairing retained QR state: qr=%q status=%+v", qr, status)
	}
}
