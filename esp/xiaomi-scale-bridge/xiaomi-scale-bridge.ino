#include <Arduino.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEUtils.h>
#include <HTTPClient.h>
#include <WiFi.h>

const char *WIFI_SSID = "NairDragDown 2.4";
const char *WIFI_PASSWORD = "There!Now!";
const char *WEBHOOK_URLS[] = {
  "http://192.168.0.132:8080/api/activity-events",
  "http://192.168.0.132:5000/api/nutrition/scale-readings/ble",
};
const size_t WEBHOOK_URL_COUNT = sizeof(WEBHOOK_URLS) / sizeof(WEBHOOK_URLS[0]);

const uint32_t POST_INTERVAL_MS = 200;
const uint32_t IDENTITY_POST_INTERVAL_MS = 60000;
const uint32_t WIFI_RETRY_INTERVAL_MS = 30000;
const uint32_t BLE_SCAN_DURATION_SECONDS = 30;
const uint32_t BLE_SCAN_RETRY_INTERVAL_MS = 0;
const uint32_t MEASUREMENT_BURST_MS = 4000;
const size_t EVENT_QUEUE_SIZE = 8;
uint32_t lastPostMs = 0;
uint32_t lastIdentityPostMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t bleSeenCount = 0;
uint32_t scaleSeenCount = 0;
uint32_t scaleIdentityCount = 0;
uint32_t scaleMeasurementCount = 0;
uint32_t queuedEventCount = 0;
uint32_t droppedEventCount = 0;
uint32_t postedEventCount = 0;
uint32_t lastBleStatusMs = 0;
uint32_t nextBleScanAttemptMs = 0;
uint32_t measurementBurstUntilMs = 0;
BLEScan *bleScan = nullptr;

struct BleEvent {
  String address;
  int rssi = 0;
  String nameHex;
  String manufacturerDataHex;
  String serviceUuid;
  int serviceDataLength = 0;
  String serviceDataHex;
  bool identity = false;
};

BleEvent eventQueue[EVENT_QUEUE_SIZE];
size_t eventQueueHead = 0;
size_t eventQueueTail = 0;
size_t eventQueueLength = 0;

String bytesToHex(const uint8_t *buffer, size_t length) {
  const char *hex = "0123456789ABCDEF";
  String value;
  value.reserve(length * 2);
  for (size_t i = 0; i < length; i++) {
    value += hex[(buffer[i] >> 4) & 0x0F];
    value += hex[buffer[i] & 0x0F];
  }
  return value;
}

String stringToHex(const String &value) {
  return bytesToHex(reinterpret_cast<const uint8_t *>(value.c_str()), value.length());
}

String printableString(const String &value) {
  String printable;
  printable.reserve(value.length());
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    printable += static_cast<uint8_t>(c) >= 0x20 && static_cast<uint8_t>(c) < 0x7F ? c : '.';
  }
  return printable;
}

bool isXiaomiScaleServiceData(const String &serviceData) {
  if (serviceData.length() < 5) {
    return false;
  }
  uint16_t productId = static_cast<uint8_t>(serviceData[2]) | (static_cast<uint8_t>(serviceData[3]) << 8);
  return productId == 0x3BD5;
}

String jsonEscape(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c == '\\' || c == '"') {
      escaped += '\\';
      escaped += c;
    } else if (c == '\n') {
      escaped += "\\n";
    } else if (c == '\r') {
      escaped += "\\r";
    } else if (c == '\t') {
      escaped += "\\t";
    } else if (static_cast<uint8_t>(c) < 0x20) {
      escaped += ' ';
    } else {
      escaped += c;
    }
  }
  return escaped;
}

bool isConfigured() {
  return strcmp(WIFI_SSID, "CHANGE_ME") != 0 && strcmp(WIFI_PASSWORD, "CHANGE_ME") != 0 && WEBHOOK_URL_COUNT > 0 && strstr(WEBHOOK_URLS[0], "192.168.1.100") == nullptr;
}

String eventPayload(const BleEvent &event) {
  String payload = "{";
  payload += "\"source\":\"esp32_ble_scan\",";
  payload += "\"address\":\"" + jsonEscape(event.address) + "\",";
  payload += "\"rssi\":" + String(event.rssi) + ",";
  payload += "\"name_hex\":\"" + event.nameHex + "\",";
  payload += "\"manufacturer_data_hex\":\"" + event.manufacturerDataHex + "\",";
  payload += "\"service_uuid\":\"" + jsonEscape(event.serviceUuid) + "\",";
  payload += "\"service_data_len\":" + String(event.serviceDataLength) + ",";
  payload += "\"service_data_hex\":\"" + event.serviceDataHex + "\"";
  payload += "}";
  return payload;
}

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }
  if (lastWifiAttemptMs != 0 && millis() - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) {
    return false;
  }

  lastWifiAttemptMs = millis();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi connecting to ");
  Serial.print(WIFI_SSID);
  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000) {
    Serial.print(".");
    delay(500);
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.print("WiFi connection failed status=");
  Serial.println(WiFi.status());
  WiFi.disconnect(false);
  return false;
}

bool enqueueEvent(const BleEvent &event) {
  if (eventQueueLength >= EVENT_QUEUE_SIZE) {
    droppedEventCount++;
    return false;
  }

  eventQueue[eventQueueTail] = event;
  eventQueueTail = (eventQueueTail + 1) % EVENT_QUEUE_SIZE;
  eventQueueLength++;
  queuedEventCount++;
  return true;
}

bool hasQueuedMeasurement(const String &serviceDataHex) {
  for (size_t i = 0; i < eventQueueLength; i++) {
    size_t index = (eventQueueHead + i) % EVENT_QUEUE_SIZE;
    if (!eventQueue[index].identity && eventQueue[index].serviceDataHex == serviceDataHex) {
      return true;
    }
  }
  return false;
}

void disableWifi() {
  lastWifiAttemptMs = 0;
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  }
}

bool dequeueEvent(BleEvent &event) {
  if (eventQueueLength == 0) {
    return false;
  }

  event = eventQueue[eventQueueHead];
  eventQueueHead = (eventQueueHead + 1) % EVENT_QUEUE_SIZE;
  eventQueueLength--;
  return true;
}

bool peekEvent(BleEvent &event) {
  if (eventQueueLength == 0) {
    return false;
  }

  event = eventQueue[eventQueueHead];
  return true;
}

BleEvent makeEvent(BLEAdvertisedDevice &device, bool identity) {
  BleEvent event;
  event.address = String(device.getAddress().toString().c_str());
  event.rssi = device.getRSSI();
  event.nameHex = device.haveName() ? stringToHex(device.getName()) : "";
  event.manufacturerDataHex = device.haveManufacturerData() ? stringToHex(device.getManufacturerData()) : "";
  event.serviceUuid = device.haveServiceData() ? String(device.getServiceDataUUID().toString().c_str()) : "";
  event.serviceDataLength = device.haveServiceData() ? device.getServiceData().length() : 0;
  event.serviceDataHex = device.haveServiceData() ? stringToHex(device.getServiceData()) : "";
  event.identity = identity;
  return event;
}

bool postEvent(const BleEvent &event) {
  uint32_t now = millis();
  if (now - lastPostMs < POST_INTERVAL_MS) {
    return false;
  }

  if (!ensureWifi()) {
    return false;
  }

  lastPostMs = now;
  String payload = eventPayload(event);
  bool allSucceeded = true;

  for (size_t i = 0; i < WEBHOOK_URL_COUNT; i++) {
    HTTPClient http;
    http.begin(WEBHOOK_URLS[i]);
    http.addHeader("Content-Type", "application/json");

    int status = http.POST(payload);
    allSucceeded = allSucceeded && status >= 200 && status < 300;
    Serial.print("POST ");
    Serial.print(status);
    Serial.print(" url=");
    Serial.print(WEBHOOK_URLS[i]);
    Serial.print(" address=");
    Serial.print(event.address);
    Serial.print(" rssi=");
    Serial.print(event.rssi);
    Serial.print(" type=");
    Serial.println(event.identity ? "identity" : "measurement");
    http.end();
  }

  if (allSucceeded) {
    postedEventCount++;
  }
  return allSucceeded;
}

void handleBleDevice(BLEAdvertisedDevice &device) {
  bleSeenCount++;
  String address = String(device.getAddress().toString().c_str());
  String serviceData = device.haveServiceData() ? device.getServiceData() : "";
  bool isScale = isXiaomiScaleServiceData(serviceData);
  if (isScale) {
    scaleSeenCount++;
  }

  if (!isScale) {
    return;
  }

  String manufacturerData = device.haveManufacturerData() ? device.getManufacturerData() : "";
  bool isIdentityFrame = serviceData.length() == 11 && static_cast<uint8_t>(serviceData[0]) == 0x10 && static_cast<uint8_t>(serviceData[1]) == 0x59;
  if (isIdentityFrame) {
    scaleIdentityCount++;
    uint32_t now = millis();
    if (lastIdentityPostMs == 0 || now - lastIdentityPostMs >= IDENTITY_POST_INTERVAL_MS) {
      lastIdentityPostMs = now;
      Serial.print("BLE scale identity address=");
      Serial.print(address);
      Serial.print(" rssi=");
      Serial.println(device.getRSSI());
    }
    return;
  }

  scaleMeasurementCount++;
  uint32_t now = millis();
  String serviceDataHex = stringToHex(serviceData);
  if (measurementBurstUntilMs == 0) {
    measurementBurstUntilMs = now + MEASUREMENT_BURST_MS;
    Serial.print("BLE measurement burst start ms=");
    Serial.println(MEASUREMENT_BURST_MS);
  }
  Serial.print("BLE scale measurement address=");
  Serial.print(address);
  Serial.print(" rssi=");
  Serial.print(device.getRSSI());
  Serial.print(" service_uuid=");
  Serial.println(device.haveServiceData() ? device.getServiceDataUUID().toString().c_str() : "");
  Serial.print("scale service_data_len=");
  Serial.print(serviceData.length());
  Serial.print(" service_data_hex=");
  Serial.println(serviceDataHex);
  Serial.print("scale manufacturer_data_len=");
  Serial.print(manufacturerData.length());
  Serial.print(" manufacturer_data_hex=");
  Serial.println(stringToHex(manufacturerData));
  if (hasQueuedMeasurement(serviceDataHex)) {
    Serial.println("BLE duplicate measurement skipped");
  } else if (!enqueueEvent(makeEvent(device, false))) {
    Serial.println("BLE event queue full; dropped measurement");
  }

  if (bleScan != nullptr && static_cast<int32_t>(now - measurementBurstUntilMs) >= 0) {
    Serial.println("BLE measurement burst complete");
    bleScan->stop();
  }
}

class ScaleAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice device) override {
    handleBleDevice(device);
  }
};

bool startBleScan() {
  if (bleScan == nullptr) {
    return false;
  }
  if (millis() < nextBleScanAttemptMs) {
    return false;
  }

  Serial.println("BLE scan start");
  BLEScanResults *results = bleScan->start(BLE_SCAN_DURATION_SECONDS, false);
  measurementBurstUntilMs = 0;
  nextBleScanAttemptMs = millis() + BLE_SCAN_RETRY_INTERVAL_MS;
  Serial.print("BLE scan done results=");
  Serial.println(results == nullptr ? 0 : results->getCount());
  bleScan->clearResults();
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  if (!isConfigured()) {
    Serial.println("Set WIFI_SSID, WIFI_PASSWORD, and WEBHOOK_URLS before flashing.");
  }
  disableWifi();

  BLEDevice::init("secretary-scale-bridge");
  delay(1000);
  bleScan = BLEDevice::getScan();
  // The scale reuses one address for identity and measurement frames. We need
  // duplicate callbacks or an identity packet can hide a later measurement.
  bleScan->setAdvertisedDeviceCallbacks(new ScaleAdvertisedDeviceCallbacks(), true);
  // Passive scan only listens; active scan can make the scale flash its Bluetooth icon.
  bleScan->setActiveScan(false);
  bleScan->setInterval(160);
  bleScan->setWindow(120);
  startBleScan();
  Serial.println("Passive BLE scan configured");
}

void loop() {
  BleEvent event;
  if (peekEvent(event) && postEvent(event)) {
    dequeueEvent(event);
  }

  if (eventQueueLength == 0) {
    disableWifi();
    startBleScan();
  }

  if (millis() - lastBleStatusMs > 10000) {
    lastBleStatusMs = millis();
    Serial.print("BLE status seen=");
    Serial.print(bleSeenCount);
    Serial.print(" scale_seen=");
    Serial.print(scaleSeenCount);
    Serial.print(" identity=");
    Serial.print(scaleIdentityCount);
    Serial.print(" measurement=");
    Serial.print(scaleMeasurementCount);
    Serial.print(" queue=");
    Serial.print(eventQueueLength);
    Serial.print(" queued=");
    Serial.print(queuedEventCount);
    Serial.print(" posted=");
    Serial.print(postedEventCount);
    Serial.print(" dropped=");
    Serial.print(droppedEventCount);
    Serial.print(" wifi=");
    Serial.println(WiFi.status() == WL_CONNECTED ? "connected" : "disconnected");
  }
  delay(10);
}
