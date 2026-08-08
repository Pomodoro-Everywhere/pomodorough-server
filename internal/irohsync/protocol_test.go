package irohsync

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestInviteRoundTrip(t *testing.T) {
	secret := make([]byte, 32)
	for index := range secret {
		secret[index] = byte(index)
	}
	encoded, err := NewInvite("Design desk", "endpoint-test-ticket", secret)
	if err != nil {
		t.Fatal(err)
	}
	invite, decodedSecret, err := ParseInvite(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if invite.RoomName != "Design desk" || invite.EndpointTicket != "endpoint-test-ticket" {
		t.Fatalf("decoded invite = %#v", invite)
	}
	if !bytes.Equal(decodedSecret, secret) {
		t.Fatal("decoded room secret differs")
	}
	if got, want := invite.RoomID, ""; want != "" && got != want {
		t.Fatalf("room ID = %q, want %q", got, want)
	}
}

func TestInviteRejectsUnknownFieldAndMismatchedRoom(t *testing.T) {
	unknown := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"roomId":"x","endpointTicket":"endpoint-test","roomSecret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","extra":true}`))
	if _, _, err := ParseInvite(InvitePrefix + unknown); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown-field error = %v", err)
	}
	mismatch := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"roomId":"wrong","endpointTicket":"endpoint-test","roomSecret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`))
	if _, _, err := ParseInvite(InvitePrefix + mismatch); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatch error = %v", err)
	}
}

func TestAuthenticatedFrameRoundTripAndTamper(t *testing.T) {
	secret := bytes.Repeat([]byte{0x5a}, 32)
	body := []byte(`{"protocolVersion":1,"kind":"hello"}`)
	frame, err := EncodeFrame(secret, body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeFrame(bytes.NewReader(frame), secret)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, body) {
		t.Fatalf("decoded body = %q, want %q", decoded, body)
	}
	frame[len(frame)-1] ^= 1
	if _, err := DecodeFrame(bytes.NewReader(frame), secret); err == nil || !strings.Contains(err.Error(), "authentication") {
		t.Fatalf("tamper error = %v", err)
	}
}

func TestAuthenticatedFrameMatchesCrossClientVector(t *testing.T) {
	secret := make([]byte, 32)
	for index := range secret {
		secret[index] = byte(index)
	}
	frame, err := EncodeFrame(secret, []byte(`{"kind":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	const expected = "00000010d9f01510c6ce30066f8318494a013c47657387a9bc3bbb81625b3cd74569d8377b226b696e64223a2268656c6c6f227d"
	if hex.EncodeToString(frame) != expected {
		t.Fatalf("frame = %x, want %s", frame, expected)
	}
}

func TestFrameRejectsInvalidLimits(t *testing.T) {
	secret := bytes.Repeat([]byte{1}, 32)
	if _, err := EncodeFrame(secret, nil); err == nil {
		t.Fatal("empty frame succeeded")
	}
	if _, err := EncodeFrame(secret[:31], []byte("x")); err == nil {
		t.Fatal("short secret succeeded")
	}
}
