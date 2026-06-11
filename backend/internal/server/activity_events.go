package server

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/mvult/secretary/backend/internal/db/gen"
)

const defaultActivityEventUserID int32 = 1

const s400SessionTimeout = 10 * time.Second

type activityEventRequest struct {
	Source        string         `json:"source"`
	ActivityKey   string         `json:"activity_key"`
	ActivityName  string         `json:"activity_name"`
	Unit          string         `json:"unit"`
	OccurredAt    string         `json:"occurred_at"`
	MeasuredAt    string         `json:"measured_at"`
	Value         *float64       `json:"value"`
	WeightKG      *float64       `json:"weight_kg"`
	ImpedanceOhms *int           `json:"impedance_ohms"`
	ImpedanceHigh *int           `json:"impedance_high_ohms"`
	ImpedanceLow  *int           `json:"impedance_low_ohms"`
	Note          string         `json:"note"`
	Data          map[string]any `json:"data"`
}

type s400ScaleSession struct {
	WeightKG       *float64
	ImpedanceHigh  *int
	ImpedanceLow   *int
	HeartRateBPM   *int
	FirstSeenAt    time.Time
	Packets        []map[string]any
	FrameCounters  []int
	ServiceDataHex []string
}

type s400RecentMeasurement struct {
	WeightKG      float64
	ImpedanceHigh int
	SeenAt        time.Time
}

type s400AggregationResult struct {
	Finalized bool
	Duplicate bool
	TimedOut  bool
	Session   s400ScaleSession
}

type bleAdvertisementEvent struct {
	Address        string `json:"address"`
	RSSI           int    `json:"rssi"`
	ServiceUUID    string `json:"service_uuid"`
	ServiceDataHex string `json:"service_data_hex"`
}

func (s *Server) handleActivityEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	log.Printf("Activity event raw body: %s", string(body))
	if err := s.handleBLEAdvertisement(r.Context(), body); err != nil {
		log.Printf("Activity event BLE ingest skipped: %v", err)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleBLEAdvertisement(ctx context.Context, body []byte) error {
	var event bleAdvertisementEvent
	if err := json.Unmarshal(body, &event); err != nil {
		return nil
	}
	if !strings.EqualFold(event.ServiceUUID, "0000fe95-0000-1000-8000-00805f9b34fb") || event.ServiceDataHex == "" {
		return nil
	}

	data, err := hex.DecodeString(event.ServiceDataHex)
	if err != nil || len(data) < 5 {
		log.Printf("BLE FE95 invalid address=%s rssi=%d service_data_hex=%q", event.Address, event.RSSI, event.ServiceDataHex)
		return nil
	}

	frameControl := uint16(data[0]) | uint16(data[1])<<8
	productID := uint16(data[2]) | uint16(data[3])<<8
	frameCounter := data[4]
	frameType := "identity"
	if frameControl&0x0040 != 0 {
		frameType = "measurement"
	}
	log.Printf(
		"BLE FE95 %s address=%s rssi=%d frame_control=0x%04X product_id=0x%04X counter=%d encrypted=%t mac_included=%t payload_len=%d",
		frameType,
		event.Address,
		event.RSSI,
		frameControl,
		productID,
		frameCounter,
		frameControl&0x0008 != 0,
		frameControl&0x0010 != 0,
		len(data),
	)

	if frameControl&0x0040 == 0 || frameControl&0x0008 == 0 {
		return nil
	}
	decoded, err := decodeXiaomiScaleAdvertisement(event.Address, event.ServiceDataHex)
	if err != nil {
		return err
	}
	log.Printf(
		"S400 packet decoded kind=%s address=%s counter=%d weight_kg=%.1f impedance_ohms=%d heart_rate_bpm=%d profile_id=%d raw_mass=%d raw_heart_rate=%d raw_impedance=%d object_hex=%s object_extra_hex=%s payload_hex=%s",
		decoded.PacketKind,
		event.Address,
		decoded.FrameCounter,
		decoded.WeightKG,
		decoded.ImpedanceOhms,
		decoded.HeartRateBPM,
		decoded.ProfileID,
		decoded.RawMass,
		decoded.RawHeartRate,
		decoded.RawImpedance,
		decoded.ObjectHex,
		decoded.ObjectExtraHex,
		decoded.PayloadHex,
	)
	if decoded.WeightKG == 0 {
		log.Printf("S400 low-frequency packet candidate counter=%d impedance_ohms=%d raw_impedance=%d", decoded.FrameCounter, decoded.ImpedanceOhms, decoded.RawImpedance)
	}

	agg := s.aggregateS400Packet(event, decoded, time.Now())
	if agg.Duplicate {
		log.Printf("S400 measurement duplicate ignored address=%s counter=%d", event.Address, decoded.FrameCounter)
		return nil
	}
	if !agg.Finalized {
		log.Printf("S400 measurement pending address=%s counter=%d kind=%s", event.Address, decoded.FrameCounter, decoded.PacketKind)
		return nil
	}
	if agg.TimedOut {
		log.Printf("S400 measurement finalized after timeout address=%s weight_kg=%.1f impedance_high_ohms=%d", event.Address, *agg.Session.WeightKG, *agg.Session.ImpedanceHigh)
	} else if agg.Session.ImpedanceLow != nil {
		log.Printf("S400 measurement finalized with dual impedance address=%s weight_kg=%.1f impedance_high_ohms=%d impedance_low_ohms=%d", event.Address, *agg.Session.WeightKG, *agg.Session.ImpedanceHigh, *agg.Session.ImpedanceLow)
	}

	var impedanceOhms *int
	if agg.Session.ImpedanceHigh != nil {
		impedanceOhms = agg.Session.ImpedanceHigh
	}

	req := activityEventRequest{
		Source:        "xiaomi_scale_2",
		WeightKG:      agg.Session.WeightKG,
		ImpedanceOhms: impedanceOhms,
		ImpedanceHigh: agg.Session.ImpedanceHigh,
		ImpedanceLow:  agg.Session.ImpedanceLow,
		Data: map[string]any{
			"source":              "esp32_ble_scan",
			"address":             event.Address,
			"rssi":                event.RSSI,
			"service_uuid":        event.ServiceUUID,
			"impedance_high_ohms": agg.Session.ImpedanceHigh,
			"impedance_low_ohms":  agg.Session.ImpedanceLow,
			"heart_rate_bpm":      agg.Session.HeartRateBPM,
			"frame_counters":      agg.Session.FrameCounters,
			"service_data_hexes":  agg.Session.ServiceDataHex,
			"s400_packets":        agg.Session.Packets,
			"s400_timed_out":      agg.TimedOut,
			"packet_kind":         "s400_aggregated_measurement",
			"object_hex":          decoded.ObjectHex,
			"object_extra_hex":    decoded.ObjectExtraHex,
			"payload_hex":         decoded.PayloadHex,
			"raw_service_source":  "xiaomi_fe95",
		},
	}
	_, err = s.ingestXiaomiScaleEvent(ctx, req)
	return err
}

func (s *Server) aggregateS400Packet(event bleAdvertisementEvent, decoded *decodedXiaomiScaleAdvertisement, now time.Time) s400AggregationResult {
	packet := map[string]any{
		"packet_kind":      decoded.PacketKind,
		"rssi":             event.RSSI,
		"service_data_hex": decoded.ServiceDataHex,
		"frame_control":    decoded.FrameControl,
		"product_id":       decoded.ProductID,
		"frame_counter":    decoded.FrameCounter,
		"profile_id":       decoded.ProfileID,
		"weight_kg":        decoded.WeightKG,
		"impedance_ohms":   decoded.ImpedanceOhms,
		"heart_rate_bpm":   decoded.HeartRateBPM,
		"raw_measurement":  decoded.RawMeasurement,
		"raw_mass":         decoded.RawMass,
		"raw_heart_rate":   decoded.RawHeartRate,
		"raw_impedance":    decoded.RawImpedance,
		"object_hex":       decoded.ObjectHex,
		"object_extra_hex": decoded.ObjectExtraHex,
		"payload_hex":      decoded.PayloadHex,
	}

	s.s400Mu.Lock()
	defer s.s400Mu.Unlock()

	if s.s400Sessions == nil {
		s.s400Sessions = map[string]s400ScaleSession{}
	}
	if s.s400Recent == nil {
		s.s400Recent = map[string]s400RecentMeasurement{}
	}

	session := s.s400Sessions[event.Address]
	if session.FirstSeenAt.IsZero() {
		session.FirstSeenAt = now
	}
	if decoded.WeightKG > 0 {
		weight := decoded.WeightKG
		session.WeightKG = &weight
	}
	if decoded.ImpedanceOhms > 0 {
		impedance := decoded.ImpedanceOhms
		if decoded.WeightKG > 0 {
			session.ImpedanceHigh = &impedance
		} else {
			session.ImpedanceLow = &impedance
		}
	}
	if decoded.HeartRateBPM > 0 {
		heartRate := decoded.HeartRateBPM
		session.HeartRateBPM = &heartRate
	}
	if !containsString(session.ServiceDataHex, decoded.ServiceDataHex) {
		session.Packets = append(session.Packets, packet)
		session.FrameCounters = append(session.FrameCounters, decoded.FrameCounter)
		session.ServiceDataHex = append(session.ServiceDataHex, decoded.ServiceDataHex)
	}

	if session.WeightKG == nil || session.ImpedanceHigh == nil {
		s.s400Sessions[event.Address] = session
		return s400AggregationResult{Session: session}
	}

	haveBoth := session.ImpedanceLow != nil
	timedOut := !haveBoth && now.Sub(session.FirstSeenAt) >= s400SessionTimeout
	if !haveBoth && !timedOut {
		s.s400Sessions[event.Address] = session
		return s400AggregationResult{Session: session}
	}

	if recent, ok := s.s400Recent[event.Address]; ok && now.Sub(recent.SeenAt) < s400SessionTimeout {
		weightClose := math.Abs(recent.WeightKG-*session.WeightKG) < 0.05
		impClose := math.Abs(float64(recent.ImpedanceHigh-*session.ImpedanceHigh)) < 1
		if weightClose && impClose {
			delete(s.s400Sessions, event.Address)
			return s400AggregationResult{Duplicate: true, Session: session}
		}
	}

	s.s400Recent[event.Address] = s400RecentMeasurement{WeightKG: *session.WeightKG, ImpedanceHigh: *session.ImpedanceHigh, SeenAt: now}
	delete(s.s400Sessions, event.Address)
	return s400AggregationResult{Finalized: true, TimedOut: timedOut, Session: session}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (s *Server) ingestActivityEvent(ctx context.Context, req activityEventRequest) (db.ActivityEntry, error) {
	source := strings.TrimSpace(req.Source)
	if source == "" {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInvalidArgument, errors.New("source is required"))
	}

	switch source {
	case "xiaomi_scale_2":
		return s.ingestXiaomiScaleEvent(ctx, req)
	default:
		return s.ingestGenericActivityEvent(ctx, req)
	}
}

func (s *Server) ingestXiaomiScaleEvent(ctx context.Context, req activityEventRequest) (db.ActivityEntry, error) {
	log.Printf("Xiaomi scale raw event: source=%q weight_kg=%s impedance_ohms=%s occurred_at=%q measured_at=%q", req.Source, optionalFloatLog(req.WeightKG), optionalIntLog(req.ImpedanceOhms), req.OccurredAt, req.MeasuredAt)

	if req.WeightKG == nil {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInvalidArgument, errors.New("weight_kg is required"))
	}
	if *req.WeightKG < 10 || *req.WeightKG > 250 {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInvalidArgument, errors.New("weight_kg is out of range"))
	}
	if req.ImpedanceOhms != nil && (*req.ImpedanceOhms <= 0 || *req.ImpedanceOhms > 3000) {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInvalidArgument, errors.New("impedance_ohms is out of range"))
	}

	occurredAt, measuredAt, err := eventTimestamp(req)
	if err != nil {
		return db.ActivityEntry{}, err
	}
	dataMap := map[string]any{
		"weight_kg": round2(*req.WeightKG),
		"source":    "xiaomi_scale_2",
	}
	if req.ImpedanceOhms != nil {
		metrics := calculateXiaomiScaleMetrics(*req.WeightKG, *req.ImpedanceOhms, optionalIntValue(req.ImpedanceLow), measuredAt)
		dataBytes, err := json.Marshal(metrics)
		if err != nil {
			return db.ActivityEntry{}, connect.NewError(connect.CodeInternal, errors.New("failed to encode scale metrics"))
		}
		if err := json.Unmarshal(dataBytes, &dataMap); err != nil {
			return db.ActivityEntry{}, connect.NewError(connect.CodeInternal, errors.New("failed to encode scale metrics"))
		}
	}
	for key, value := range req.Data {
		dataMap[key] = value
	}
	data, err := json.Marshal(dataMap)
	if err != nil {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInternal, errors.New("failed to encode scale metrics"))
	}

	activityType, err := s.queries.EnsureActivityType(ctx, db.EnsureActivityTypeParams{
		UserID: defaultActivityEventUserID,
		Key:    "weight",
		Name:   "Weight",
		Unit:   pgtype.Text{String: "kg", Valid: true},
	})
	if err != nil {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInternal, errors.New("failed to ensure weight activity type"))
	}

	return s.queries.CreateActivityEntry(ctx, db.CreateActivityEntryParams{
		ActivityTypeID: activityType.ID,
		OccurredAt:     occurredAt,
		Value:          pgtype.Float8{Float64: round2(*req.WeightKG), Valid: true},
		Note:           optionalText(req.Note),
		Data:           data,
	})
}

func (s *Server) ingestGenericActivityEvent(ctx context.Context, req activityEventRequest) (db.ActivityEntry, error) {
	key := strings.TrimSpace(req.ActivityKey)
	if key == "" {
		key = strings.TrimSpace(req.Source)
	}
	name := strings.TrimSpace(req.ActivityName)
	if name == "" {
		name = key
	}
	occurredAt, _, err := eventTimestamp(req)
	if err != nil {
		return db.ActivityEntry{}, err
	}
	data := req.Data
	if data == nil {
		data = map[string]any{}
	}
	data["source"] = strings.TrimSpace(req.Source)
	encodedData, err := json.Marshal(data)
	if err != nil {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid activity data"))
	}

	activityType, err := s.queries.EnsureActivityType(ctx, db.EnsureActivityTypeParams{
		UserID: defaultActivityEventUserID,
		Key:    key,
		Name:   name,
		Unit:   optionalText(req.Unit),
	})
	if err != nil {
		return db.ActivityEntry{}, connect.NewError(connect.CodeInternal, errors.New("failed to ensure activity type"))
	}
	return s.queries.CreateActivityEntry(ctx, db.CreateActivityEntryParams{
		ActivityTypeID: activityType.ID,
		OccurredAt:     occurredAt,
		Value:          optionalFloat8(req.Value),
		Note:           optionalText(req.Note),
		Data:           encodedData,
	})
}

func eventTimestamp(req activityEventRequest) (pgtype.Timestamptz, time.Time, error) {
	value := strings.TrimSpace(req.OccurredAt)
	if value == "" {
		value = strings.TrimSpace(req.MeasuredAt)
	}
	if value == "" {
		now := time.Now().UTC()
		return pgtype.Timestamptz{Time: now, Valid: true}, now, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return pgtype.Timestamptz{}, time.Time{}, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid occurred_at"))
	}
	parsed = parsed.UTC()
	return pgtype.Timestamptz{Time: parsed, Valid: true}, parsed, nil
}

func connectCodeHTTPStatus(code connect.Code) int {
	switch code {
	case connect.CodeInvalidArgument:
		return http.StatusBadRequest
	case connect.CodeNotFound:
		return http.StatusNotFound
	case connect.CodeUnauthenticated:
		return http.StatusUnauthorized
	case connect.CodePermissionDenied:
		return http.StatusForbidden
	default:
		return http.StatusInternalServerError
	}
}

func optionalFloatLog(value *float64) string {
	if value == nil {
		return "<nil>"
	}
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(*value, 'f', 6, 64), "0"), ".")
}

func optionalIntLog(value *int) string {
	if value == nil {
		return "<nil>"
	}
	return strconv.Itoa(*value)
}

func optionalIntValue(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
