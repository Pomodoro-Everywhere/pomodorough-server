package irohsync

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const (
	ALPN           = "me.egigoka.pomodorough/sync/1"
	InvitePrefix   = "pomodorough1."
	Version        = 1
	MaxFrameBytes  = 16 << 20
	MaxTicketBytes = 16 << 10
)

var (
	roomIDDomain = []byte("pomodorough-room-v1\x00")
	frameDomain  = []byte("pomodorough-iroh-frame-v1\x00")
)

type Invite struct {
	Version        int    `json:"v"`
	RoomID         string `json:"roomId"`
	RoomName       string `json:"roomName,omitempty"`
	EndpointTicket string `json:"endpointTicket"`
	RoomSecret     string `json:"roomSecret"`
}

func NewInvite(roomName, endpointTicket string, secret []byte) (string, error) {
	if err := validateInviteFields(roomName, endpointTicket, secret); err != nil {
		return "", err
	}
	invite := Invite{
		Version:        Version,
		RoomID:         RoomID(secret),
		RoomName:       roomName,
		EndpointTicket: endpointTicket,
		RoomSecret:     base64.RawURLEncoding.EncodeToString(secret),
	}
	body, err := json.Marshal(invite)
	if err != nil {
		return "", fmt.Errorf("encode invite: %w", err)
	}
	return InvitePrefix + base64.RawURLEncoding.EncodeToString(body), nil
}

func ParseInvite(value string) (Invite, []byte, error) {
	if !strings.HasPrefix(value, InvitePrefix) {
		return Invite{}, nil, errors.New("invalid invite prefix")
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, InvitePrefix))
	if err != nil {
		return Invite{}, nil, errors.New("invalid invite encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var invite Invite
	if err := decoder.Decode(&invite); err != nil {
		return Invite{}, nil, fmt.Errorf("invalid invite JSON: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Invite{}, nil, errors.New("invalid trailing invite data")
	}
	if invite.Version != Version {
		return Invite{}, nil, errors.New("unsupported invite version")
	}
	secret, err := base64.RawURLEncoding.DecodeString(invite.RoomSecret)
	if err != nil {
		return Invite{}, nil, errors.New("invalid room secret encoding")
	}
	if err := validateInviteFields(invite.RoomName, invite.EndpointTicket, secret); err != nil {
		return Invite{}, nil, err
	}
	if !hmac.Equal([]byte(invite.RoomID), []byte(RoomID(secret))) {
		return Invite{}, nil, errors.New("room ID does not match room secret")
	}
	return invite, secret, nil
}

func RoomID(secret []byte) string {
	digest := sha256.New()
	digest.Write(roomIDDomain)
	digest.Write(secret)
	return base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
}

func EncodeFrame(secret, body []byte) ([]byte, error) {
	if len(secret) != 32 {
		return nil, errors.New("room secret must contain 32 bytes")
	}
	if len(body) == 0 || len(body) > MaxFrameBytes {
		return nil, errors.New("frame body length is outside limits")
	}
	mac := frameMAC(secret, body)
	frame := make([]byte, 4+sha256.Size+len(body))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(body)))
	copy(frame[4:4+sha256.Size], mac)
	copy(frame[4+sha256.Size:], body)
	return frame, nil
}

func DecodeFrame(reader io.Reader, secret []byte) ([]byte, error) {
	if len(secret) != 32 {
		return nil, errors.New("room secret must contain 32 bytes")
	}
	header := make([]byte, 4+sha256.Size)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, fmt.Errorf("read frame header: %w", err)
	}
	size := binary.BigEndian.Uint32(header[:4])
	if size == 0 || size > MaxFrameBytes {
		return nil, errors.New("frame body length is outside limits")
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, fmt.Errorf("read frame body: %w", err)
	}
	if !hmac.Equal(header[4:], frameMAC(secret, body)) {
		return nil, errors.New("frame authentication failed")
	}
	return body, nil
}

func frameMAC(secret, body []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(frameDomain)
	mac.Write(body)
	return mac.Sum(nil)
}

func validateInviteFields(roomName, endpointTicket string, secret []byte) error {
	if len(secret) != 32 {
		return errors.New("room secret must contain 32 bytes")
	}
	if roomName != "" && (!utf8.ValidString(roomName) || utf8.RuneCountInString(roomName) > 64) {
		return errors.New("room name is outside limits")
	}
	if endpointTicket == "" || len(endpointTicket) > MaxTicketBytes || !strings.HasPrefix(endpointTicket, "endpoint") {
		return errors.New("endpoint ticket is outside limits")
	}
	return nil
}
