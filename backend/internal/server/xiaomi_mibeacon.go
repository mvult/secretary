package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	xiaomiScaleBLEKey = "25ca8820c464cca2e0098da376b113bd"
	xiaomiScaleProduct = 0x3BD5
)

type decodedXiaomiScaleAdvertisement struct {
	WeightKG       float64 `json:"weight_kg"`
	ImpedanceOhms  int     `json:"impedance_ohms,omitempty"`
	HeartRateBPM   int     `json:"heart_rate_bpm,omitempty"`
	ProfileID      int     `json:"profile_id"`
	FrameCounter   int     `json:"frame_counter"`
	FrameControl   string  `json:"frame_control"`
	ProductID      string  `json:"product_id"`
	ServiceDataHex string  `json:"service_data_hex"`
}

func decodeXiaomiScaleAdvertisement(address string, serviceDataHex string) (*decodedXiaomiScaleAdvertisement, error) {
	data, err := hex.DecodeString(serviceDataHex)
	if err != nil {
		return nil, fmt.Errorf("invalid service data hex: %w", err)
	}
	if len(data) < 12 {
		return nil, errors.New("service data too short")
	}

	frameControl := binary.LittleEndian.Uint16(data[0:2])
	productID := binary.LittleEndian.Uint16(data[2:4])
	if productID != xiaomiScaleProduct {
		return nil, fmt.Errorf("unexpected product id 0x%04X", productID)
	}
	if frameControl&0x0040 == 0 {
		return nil, errors.New("not an object data frame")
	}
	if frameControl&0x0008 == 0 {
		return nil, errors.New("measurement frame is not encrypted")
	}

	mac, err := parseMAC(address)
	if err != nil {
		return nil, err
	}
	key, err := hex.DecodeString(xiaomiScaleBLEKey)
	if err != nil || len(key) != 16 {
		return nil, errors.New("invalid Xiaomi scale BLE key")
	}

	payloadStart := 5
	if frameControl&0x0010 != 0 {
		payloadStart += 6
	}
	if frameControl&0x0020 != 0 {
		payloadStart++
		if len(data) >= payloadStart && data[payloadStart-1]&0x20 != 0 {
			payloadStart++
		}
	}
	if len(data) < payloadStart+8 {
		return nil, errors.New("encrypted payload too short")
	}

	nonce := make([]byte, 0, 12)
	for i := len(mac) - 1; i >= 0; i-- {
		nonce = append(nonce, mac[i])
	}
	nonce = append(nonce, data[2:5]...)
	nonce = append(nonce, data[len(data)-7:len(data)-4]...)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	payload, err := ccmDecrypt(block, nonce, data[payloadStart:len(data)-7], data[len(data)-4:], []byte{0x11}, 4)
	if err != nil {
		return nil, err
	}

	decoded, err := parseXiaomiScaleObjects(payload)
	if err != nil {
		return nil, err
	}
	decoded.FrameCounter = int(data[4])
	decoded.FrameControl = fmt.Sprintf("0x%04X", frameControl)
	decoded.ProductID = fmt.Sprintf("0x%04X", productID)
	decoded.ServiceDataHex = serviceDataHex
	return decoded, nil
}

func parseXiaomiScaleObjects(payload []byte) (*decodedXiaomiScaleAdvertisement, error) {
	for offset := 0; offset+3 <= len(payload); {
		objectType := binary.LittleEndian.Uint16(payload[offset : offset+2])
		objectLength := int(payload[offset+2])
		nextOffset := offset + 3 + objectLength
		if nextOffset > len(payload) {
			return nil, errors.New("invalid Xiaomi object length")
		}
		object := payload[offset+3 : nextOffset]
		if objectType == 0x6E16 {
			if len(object) != 9 {
				return nil, fmt.Errorf("unexpected scale object length %d", len(object))
			}
			profileID := object[0]
			measurement := binary.LittleEndian.Uint32(object[1:5])
			mass := measurement & 0x7FF
			heartRate := (measurement >> 11) & 0x7F
			impedance := measurement >> 18
			if mass == 0 {
				return nil, errors.New("scale measurement has no weight")
			}
			decoded := &decodedXiaomiScaleAdvertisement{
				WeightKG:  float64(mass) / 10,
				ProfileID: int(profileID),
			}
			if heartRate > 0 && heartRate < 127 {
				decoded.HeartRateBPM = int(heartRate) + 50
			}
			if impedance > 0 {
				decoded.ImpedanceOhms = int(impedance / 10)
			}
			return decoded, nil
		}
		offset = nextOffset
	}
	return nil, fmt.Errorf("scale object not found in decrypted payload %X", payload)
}

func parseMAC(value string) ([]byte, error) {
	cleaned := strings.ReplaceAll(strings.ReplaceAll(value, ":", ""), "-", "")
	mac, err := hex.DecodeString(cleaned)
	if err != nil || len(mac) != 6 {
		return nil, fmt.Errorf("invalid BLE MAC %q", value)
	}
	return mac, nil
}

func ccmDecrypt(block cipher.Block, nonce []byte, ciphertext []byte, tag []byte, aad []byte, tagSize int) ([]byte, error) {
	if tagSize != len(tag) || tagSize < 4 || tagSize > 16 || tagSize%2 != 0 {
		return nil, errors.New("invalid CCM tag size")
	}
	if len(nonce) < 7 || len(nonce) > 13 {
		return nil, errors.New("invalid CCM nonce size")
	}
	lSize := 15 - len(nonce)
	if uint64(len(ciphertext)) >= 1<<(8*lSize) {
		return nil, errors.New("CCM ciphertext too long")
	}

	plaintext := make([]byte, len(ciphertext))
	ccmCrypt(block, nonce, plaintext, ciphertext)

	expectedTag := ccmAuthTag(block, nonce, plaintext, aad, tagSize)
	if subtle.ConstantTimeCompare(expectedTag, tag) != 1 {
		return nil, errors.New("CCM tag verification failed")
	}
	return plaintext, nil
}

func ccmCrypt(block cipher.Block, nonce []byte, dst []byte, src []byte) {
	lSize := 15 - len(nonce)
	counter := make([]byte, aes.BlockSize)
	counter[0] = byte(lSize - 1)
	copy(counter[1:], nonce)

	stream := make([]byte, aes.BlockSize)
	for offset, blockNumber := 0, 1; offset < len(src); offset, blockNumber = offset+aes.BlockSize, blockNumber+1 {
		putCCMLength(counter[len(counter)-lSize:], uint64(blockNumber))
		block.Encrypt(stream, counter)
		for i := 0; i < aes.BlockSize && offset+i < len(src); i++ {
			dst[offset+i] = src[offset+i] ^ stream[i]
		}
	}
}

func ccmAuthTag(block cipher.Block, nonce []byte, plaintext []byte, aad []byte, tagSize int) []byte {
	lSize := 15 - len(nonce)
	macBlock := make([]byte, aes.BlockSize)
	macBlock[0] = byte(((tagSize-2)/2)<<3) | byte(lSize-1)
	if len(aad) > 0 {
		macBlock[0] |= 0x40
	}
	copy(macBlock[1:], nonce)
	putCCMLength(macBlock[len(macBlock)-lSize:], uint64(len(plaintext)))

	y := make([]byte, aes.BlockSize)
	block.Encrypt(y, macBlock)
	if len(aad) > 0 {
		encodedAAD := []byte{byte(len(aad) >> 8), byte(len(aad))}
		encodedAAD = append(encodedAAD, aad...)
		ccmCBCMAC(block, y, encodedAAD)
	}
	ccmCBCMAC(block, y, plaintext)

	counter := make([]byte, aes.BlockSize)
	counter[0] = byte(lSize - 1)
	copy(counter[1:], nonce)
	s0 := make([]byte, aes.BlockSize)
	block.Encrypt(s0, counter)

	tag := make([]byte, tagSize)
	for i := 0; i < tagSize; i++ {
		tag[i] = y[i] ^ s0[i]
	}
	return tag
}

func ccmCBCMAC(block cipher.Block, y []byte, data []byte) {
	for offset := 0; offset < len(data); offset += aes.BlockSize {
		for i := 0; i < aes.BlockSize && offset+i < len(data); i++ {
			y[i] ^= data[offset+i]
		}
		block.Encrypt(y, y)
	}
}

func putCCMLength(dst []byte, value uint64) {
	for i := len(dst) - 1; i >= 0; i-- {
		dst[i] = byte(value)
		value >>= 8
	}
}
