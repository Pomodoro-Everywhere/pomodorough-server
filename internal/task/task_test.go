package task

import "testing"

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
