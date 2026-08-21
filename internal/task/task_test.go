package task

import (
	"context"
	"fmt"
	"testing"
)

func TestSharedIdentityMatchesLegacyOracle(t *testing.T) {
	identity, err := SharedIdentity(context.Background(), "\x00Cafe\u0301\x1f")
	if err != nil {
		t.Fatal(err)
	}
	if identity.Title != NormalizeTitle("\x00Cafe\u0301\x1f") || identity.ID != ID("Café") {
		t.Fatalf("SharedIdentity() = %#v", identity)
	}
}

func TestSharedIdentitiesHandlesMaximumBootstrapBatch(t *testing.T) {
	titles := make([]string, 4096)
	for index := range titles {
		titles[index] = fmt.Sprintf("Task %04d", index)
	}
	identities, err := SharedIdentities(context.Background(), titles)
	if err != nil {
		t.Fatal(err)
	}
	if len(identities) != len(titles) {
		t.Fatalf("identity count = %d, want %d", len(identities), len(titles))
	}
	for _, index := range []int{0, len(titles) - 1} {
		if identities[index].ID != ID(titles[index]) || identities[index].Title != titles[index] {
			t.Fatalf("identity %d = %#v", index, identities[index])
		}
	}
}

func TestDecodeSharedIdentityFailsClosed(t *testing.T) {
	validValue := `{"id":"aaf83054-24b2-8c0e-901f-a974147bfe82","title":"Café","utf8Bytes":5}`
	invalid := []string{
		`{"ok":true,"value":` + validValue + `,"extra":true}`,
		`{"ok":true,"value":{"id":"aaf83054-24b2-8c0e-901f-a974147bfe82","title":"Café"}}`,
		`{"ok":true,"value":{"id":"aaf83054-24b2-8c0e-901f-a974147bfe82","title":"Café","utf8Bytes":4}}`,
		`{"ok":true,"value":{"id":"aaf83054-24b2-8c0e-901f-a974147bfe82","title":"Café","utf8Bytes":5,"extra":true}}`,
	}
	for _, document := range invalid {
		if identity, err := decodeSharedIdentity([]byte(document)); err == nil {
			t.Fatalf("accepted invalid identity envelope %s as %#v", document, identity)
		}
	}
}

func TestSharedIdentityClassifiesValidationFailures(t *testing.T) {
	_, err := SharedIdentity(context.Background(), "\x00\x1f")
	if err == nil {
		t.Fatal("invalid title was accepted")
	}
	if IsSharedIdentityRuntimeError(err) {
		t.Fatalf("validation failure was classified as runtime failure: %v", err)
	}
	if _, ok := err.(*SharedIdentityValidationError); !ok {
		t.Fatalf("validation failure type = %T", err)
	}
}

func TestNormalizeTitleAndDeterministicID(t *testing.T) {
	raw := "\x00Cafe\u0301\x1f"
	if got := NormalizeTitle(raw); got != "Café" {
		t.Fatalf("NormalizeTitle() = %q, want Café", got)
	}
	if ID(raw) != ID("Café") {
		t.Fatalf("canonically equivalent titles produced different IDs: %q != %q", ID(raw), ID("Café"))
	}
	if got := ID("Café"); got != "aaf83054-24b2-8c0e-901f-a974147bfe82" {
		t.Fatalf("ID() = %q", got)
	}
}

func TestNormalizeTitlePreservesASCIIEdgeSpaces(t *testing.T) {
	if got := NormalizeTitle("\u00a0 task \u00a0"); got != " task " {
		t.Fatalf("NormalizeTitle() = %q, want ASCII spaces preserved", got)
	}
	if got := NormalizeTitle("\u00a0task\u200bname\u00a0"); got != "task\u200bname" {
		t.Fatalf("NormalizeTitle() = %q, want internal nonprintable characters preserved", got)
	}
}
