package task

import (
	"crypto/sha256"
	"encoding/hex"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const idNamespace = "pomodorough.task.v1\x00"

type Task struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type Operation struct {
	ID         string
	DeviceID   string
	TaskID     string
	Type       string
	Title      string
	OccurredAt time.Time
	HLCWallMs  int64
	HLCCounter int64
}

func NormalizeTitle(value string) string {
	runes := []rune(norm.NFC.String(value))
	start := 0
	for start < len(runes) && !isPrintable(runes[start]) {
		start++
	}
	end := len(runes)
	for end > start && !isPrintable(runes[end-1]) {
		end--
	}
	return string(runes[start:end])
}

func isPrintable(value rune) bool {
	return value == ' ' || unicode.IsLetter(value) || unicode.IsMark(value) || unicode.IsNumber(value) ||
		unicode.IsPunct(value) || unicode.IsSymbol(value)
}

func ID(title string) string {
	digest := sha256.Sum256([]byte(idNamespace + NormalizeTitle(title)))
	bytes := digest[:16]
	bytes[6] = (bytes[6] & 0x0f) | 0x80
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}
