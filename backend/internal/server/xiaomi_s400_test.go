package server

import (
	"testing"
	"time"
)

func TestAggregateS400PacketFinalizesDualImpedance(t *testing.T) {
	s := New(nil, []byte("test"), time.Hour)
	event := bleAdvertisementEvent{Address: "34:fa:1c:10:b9:71", RSSI: -69, ServiceUUID: "0000fe95-0000-1000-8000-00805f9b34fb"}
	now := time.Date(2026, time.June, 8, 16, 18, 0, 0, time.UTC)

	first := s.aggregateS400Packet(event, &decodedXiaomiScaleAdvertisement{
		WeightKG:       65.2,
		ImpedanceOhms:  564,
		HeartRateBPM:   66,
		PacketKind:     "weight_impedance_candidate",
		FrameCounter:   83,
		ServiceDataHex: "packet-a",
	}, now)
	if first.Finalized {
		t.Fatalf("first packet should be pending")
	}

	second := s.aggregateS400Packet(event, &decodedXiaomiScaleAdvertisement{
		WeightKG:       0,
		ImpedanceOhms:  516,
		PacketKind:     "zero_weight_impedance_candidate",
		FrameCounter:   84,
		ServiceDataHex: "packet-b",
	}, now.Add(time.Second))
	if !second.Finalized {
		t.Fatalf("second packet should finalize measurement")
	}
	if second.Session.WeightKG == nil || *second.Session.WeightKG != 65.2 {
		t.Fatalf("expected weight 65.2, got %#v", second.Session.WeightKG)
	}
	if second.Session.ImpedanceHigh == nil || *second.Session.ImpedanceHigh != 564 {
		t.Fatalf("expected high impedance 564, got %#v", second.Session.ImpedanceHigh)
	}
	if second.Session.ImpedanceLow == nil || *second.Session.ImpedanceLow != 516 {
		t.Fatalf("expected low impedance 516, got %#v", second.Session.ImpedanceLow)
	}
	if second.Session.HeartRateBPM == nil || *second.Session.HeartRateBPM != 66 {
		t.Fatalf("expected heart rate 66, got %#v", second.Session.HeartRateBPM)
	}
}

func TestCalculateS400ScaleMetricsUsesLowImpedance(t *testing.T) {
	measuredAt := time.Date(2026, time.June, 8, 16, 18, 0, 0, time.UTC)
	low := 516
	metrics := calculateXiaomiScaleMetrics(65.2, 564, &low, measuredAt)

	if metrics.ImpedanceHighOhms != 564 {
		t.Fatalf("expected high impedance 564, got %d", metrics.ImpedanceHighOhms)
	}
	if metrics.ImpedanceLowOhms == nil || *metrics.ImpedanceLowOhms != 516 {
		t.Fatalf("expected low impedance 516, got %#v", metrics.ImpedanceLowOhms)
	}
	if metrics.S400BodyCompositionV == "" {
		t.Fatalf("expected S400 body composition version")
	}
	if metrics.TotalBodyWaterKG == nil || *metrics.TotalBodyWaterKG <= 0 {
		t.Fatalf("expected total body water, got %#v", metrics.TotalBodyWaterKG)
	}
	if metrics.ExtracellularWaterKG == nil || *metrics.ExtracellularWaterKG <= 0 {
		t.Fatalf("expected extracellular water, got %#v", metrics.ExtracellularWaterKG)
	}
	if metrics.BodyFat <= 0 || metrics.MuscleMass <= 0 || metrics.BasalMetabolism <= 0 {
		t.Fatalf("expected body metrics, got body_fat=%f muscle=%f bmr=%f", metrics.BodyFat, metrics.MuscleMass, metrics.BasalMetabolism)
	}
}
