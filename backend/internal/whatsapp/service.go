package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	_ "github.com/mattn/go-sqlite3"
	db "github.com/mvult/secretary/backend/internal/db/gen"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/encoding/protojson"
)

type Queries interface {
	UpsertWhatsAppChat(context.Context, db.UpsertWhatsAppChatParams) (db.WhatsappChat, error)
	InsertWhatsAppMessage(context.Context, db.InsertWhatsAppMessageParams) (db.WhatsappMessage, error)
}

type MessageHandler func(context.Context, db.WhatsappMessage)

type Service struct {
	queries       Queries
	sessionDBPath string
	onMessage     MessageHandler

	mu        sync.Mutex
	client    *whatsmeow.Client
	container *sqlstore.Container
	status    Status
	latestQR  string
}

type Status struct {
	Connected   bool   `json:"connected"`
	LoggedIn    bool   `json:"logged_in"`
	JID         string `json:"jid,omitempty"`
	Pairing     bool   `json:"pairing"`
	HasQR       bool   `json:"has_qr"`
	LastError   string `json:"last_error,omitempty"`
	SessionDB   string `json:"session_db"`
	LastEvent   string `json:"last_event,omitempty"`
	LastEventAt string `json:"last_event_at,omitempty"`
}

func New(queries Queries, sessionDBPath string, onMessage MessageHandler) *Service {
	if strings.TrimSpace(sessionDBPath) == "" {
		sessionDBPath = filepath.Join("var", "whatsapp-session.db")
	}
	return &Service{queries: queries, sessionDBPath: sessionDBPath, onMessage: onMessage}
}

func (s *Service) Start(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(s.sessionDBPath), 0o755); err != nil {
		return err
	}

	container, err := sqlstore.New(ctx, "sqlite3", "file:"+s.sessionDBPath+"?_foreign_keys=on", waLog.Stdout("WhatsAppDB", "WARN", false))
	if err != nil {
		return err
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		container.Close()
		return err
	}
	client := whatsmeow.NewClient(device, waLog.Stdout("WhatsApp", "INFO", false))
	client.EnableAutoReconnect = true
	client.InitialAutoReconnect = true
	client.AddEventHandler(s.handleEvent)

	s.mu.Lock()
	s.container = container
	s.client = client
	s.status.SessionDB = s.sessionDBPath
	s.markEventLocked("initialized")
	s.mu.Unlock()

	if client.Store.ID == nil {
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			s.setError("qr channel: " + err.Error())
		} else {
			s.setPairing(true)
			go s.consumeQR(ctx, qrChan)
		}
	}

	if err := client.ConnectContext(ctx); err != nil {
		s.setError("connect: " + err.Error())
		return err
	}

	go func() {
		<-ctx.Done()
		s.Stop()
	}()
	return nil
}

func (s *Service) Stop() {
	s.mu.Lock()
	client := s.client
	container := s.container
	s.client = nil
	s.container = nil
	s.status.Connected = false
	s.status.Pairing = false
	s.markEventLocked("stopped")
	s.mu.Unlock()
	if client != nil {
		client.Disconnect()
	}
	if container != nil {
		if err := container.Close(); err != nil {
			log.Printf("whatsapp session db close failed: %v", err)
		}
	}
}

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshClientStateLocked()
	return s.status
}

func (s *Service) QR() (string, Status) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshClientStateLocked()
	return s.latestQR, s.status
}

func (s *Service) Reconnect(ctx context.Context) error {
	client := s.currentClient()
	if client == nil {
		return errors.New("whatsapp service is not started")
	}
	client.Disconnect()
	if err := client.ConnectContext(ctx); err != nil {
		s.setError("reconnect: " + err.Error())
		return err
	}
	return nil
}

func (s *Service) Logout(ctx context.Context) error {
	client := s.currentClient()
	if client == nil {
		return errors.New("whatsapp service is not started")
	}
	if err := client.Logout(ctx); err != nil {
		s.setError("logout: " + err.Error())
		return err
	}
	s.mu.Lock()
	s.latestQR = ""
	s.status.LoggedIn = false
	s.status.Connected = false
	s.status.JID = ""
	s.markEventLocked("logged_out")
	s.mu.Unlock()
	return nil
}

func (s *Service) currentClient() *whatsmeow.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

func (s *Service) consumeQR(ctx context.Context, ch <-chan whatsmeow.QRChannelItem) {
	for {
		select {
		case <-ctx.Done():
			return
		case item, ok := <-ch:
			if !ok {
				return
			}
			s.handleQRItem(item)
		}
	}
}

func (s *Service) handleQRItem(item whatsmeow.QRChannelItem) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.markEventLocked("qr_" + item.Event)
	s.status.LastError = ""
	s.status.Pairing = true
	s.status.HasQR = false
	s.latestQR = ""

	switch item.Event {
	case "code":
		s.latestQR = item.Code
		s.status.HasQR = item.Code != ""
		log.Printf("whatsapp pairing QR available")
	case "success":
		s.status.Pairing = false
	case "timeout", "err-unexpected-state", "err-client-outdated", "err-scanned-without-multidevice", "error":
		message := item.Event
		if item.Error != nil {
			message = item.Error.Error()
		}
		s.status.LastError = "qr: " + message
		s.status.Pairing = false
	default:
		if item.Error != nil {
			s.status.LastError = "qr: " + item.Error.Error()
		}
	}
}

func (s *Service) handleEvent(evt any) {
	s.mu.Lock()
	s.markEventLocked(eventName(evt))
	s.mu.Unlock()

	switch v := evt.(type) {
	case *events.Connected:
		s.mu.Lock()
		s.status.Connected = true
		s.status.LastError = ""
		s.refreshClientStateLocked()
		s.mu.Unlock()
	case *events.Disconnected:
		s.mu.Lock()
		s.status.Connected = false
		s.mu.Unlock()
	case *events.LoggedOut:
		s.mu.Lock()
		s.status.LoggedIn = false
		s.status.Connected = false
		s.status.JID = ""
		s.mu.Unlock()
	case *events.Message:
		go s.storeMessage(context.Background(), v)
	}
}

func (s *Service) storeMessage(ctx context.Context, evt *events.Message) {
	if evt == nil || evt.Info.ID == "" || evt.Info.Chat.String() == "" {
		return
	}
	chatJID := evt.Info.Chat.String()
	_, err := s.queries.UpsertWhatsAppChat(ctx, db.UpsertWhatsAppChatParams{
		Jid:     chatJID,
		Name:    textOrNull(evt.Info.PushName),
		IsGroup: evt.Info.IsGroup,
	})
	if err != nil {
		log.Printf("whatsapp chat upsert failed: chat=%s err=%v", chatJID, err)
		return
	}

	rawJSON, err := rawMessageJSON(evt)
	if err != nil {
		log.Printf("whatsapp raw json marshal failed: chat=%s message_id=%s err=%v", chatJID, evt.Info.ID, err)
		rawJSON = []byte(`{}`)
	}
	inserted, err := s.queries.InsertWhatsAppMessage(ctx, db.InsertWhatsAppMessageParams{
		ChatJid:     chatJID,
		MessageID:   string(evt.Info.ID),
		SenderJid:   textOrNull(evt.Info.Sender.String()),
		SenderName:  textOrNull(evt.Info.PushName),
		IsFromMe:    evt.Info.IsFromMe,
		SentAt:      pgtype.Timestamptz{Time: evt.Info.Timestamp, Valid: !evt.Info.Timestamp.IsZero()},
		MessageType: messageType(evt),
		Text:        textOrNull(extractText(evt.Message)),
		RawJson:     rawJSON,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		log.Printf("whatsapp message insert failed: chat=%s message_id=%s err=%v", chatJID, evt.Info.ID, err)
		return
	}
	if s.onMessage != nil && inserted.ClassificationStatus == "pending" && inserted.Text.Valid && strings.TrimSpace(inserted.Text.String) != "" && !inserted.IsFromMe {
		s.onMessage(ctx, inserted)
	}
}

func extractText(msg *waProto.Message) string {
	if msg == nil {
		return ""
	}
	if text := strings.TrimSpace(msg.GetConversation()); text != "" {
		return text
	}
	if m := msg.GetExtendedTextMessage(); m != nil {
		return strings.TrimSpace(m.GetText())
	}
	if m := msg.GetImageMessage(); m != nil {
		return strings.TrimSpace(m.GetCaption())
	}
	if m := msg.GetVideoMessage(); m != nil {
		return strings.TrimSpace(m.GetCaption())
	}
	if m := msg.GetDocumentMessage(); m != nil {
		return strings.TrimSpace(m.GetCaption())
	}
	return ""
}

func messageType(evt *events.Message) string {
	if evt == nil {
		return "unknown"
	}
	if strings.TrimSpace(evt.Info.MediaType) != "" {
		return evt.Info.MediaType
	}
	if strings.TrimSpace(evt.Info.Type) != "" {
		return evt.Info.Type
	}
	if evt.Message != nil {
		switch {
		case evt.Message.GetConversation() != "":
			return "text"
		case evt.Message.GetExtendedTextMessage() != nil:
			return "extended_text"
		case evt.Message.GetImageMessage() != nil:
			return "image"
		case evt.Message.GetVideoMessage() != nil:
			return "video"
		case evt.Message.GetDocumentMessage() != nil:
			return "document"
		}
	}
	return "unknown"
}

func rawMessageJSON(evt *events.Message) ([]byte, error) {
	info := map[string]any{
		"id":         string(evt.Info.ID),
		"chat":       evt.Info.Chat.String(),
		"sender":     evt.Info.Sender.String(),
		"is_from_me": evt.Info.IsFromMe,
		"is_group":   evt.Info.IsGroup,
		"push_name":  evt.Info.PushName,
		"timestamp":  evt.Info.Timestamp.Format(time.RFC3339Nano),
		"type":       evt.Info.Type,
		"media_type": evt.Info.MediaType,
	}
	messageJSON := json.RawMessage(`null`)
	if evt.Message != nil {
		data, err := protojson.Marshal(evt.Message)
		if err != nil {
			return nil, err
		}
		messageJSON = data
	}
	return json.Marshal(map[string]any{"info": info, "message": messageJSON})
}

func textOrNull(value string) pgtype.Text {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: trimmed, Valid: true}
}

func (s *Service) setPairing(pairing bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Pairing = pairing
	if !pairing {
		s.status.HasQR = false
		s.latestQR = ""
	}
}

func (s *Service) setError(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.LastError = message
	s.markEventLocked("error")
}

func (s *Service) refreshClientStateLocked() {
	if s.client == nil {
		return
	}
	s.status.Connected = s.client.IsConnected()
	s.status.LoggedIn = s.client.IsLoggedIn()
	if s.client.Store != nil && s.client.Store.ID != nil {
		s.status.JID = s.client.Store.ID.String()
	} else {
		s.status.JID = ""
	}
	s.status.HasQR = s.latestQR != ""
}

func (s *Service) markEventLocked(name string) {
	s.status.LastEvent = name
	s.status.LastEventAt = time.Now().Format(time.RFC3339Nano)
}

func eventName(evt any) string {
	if evt == nil {
		return "unknown"
	}
	t := reflect.TypeOf(evt)
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t.Name()
}
