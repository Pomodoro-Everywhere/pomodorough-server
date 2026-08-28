package server

import "testing"

func TestSafeReturnPathRejectsEncodedSchemeRelativePath(t *testing.T) {
	if got := safeReturnPath("/%2f%2fevil.example/account"); got != "/" {
		t.Fatalf("safeReturnPath() = %q, want /", got)
	}
}
