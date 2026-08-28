package server

import "testing"

func TestSafeReturnPathDropsFragmentAndPreservesQuery(t *testing.T) {
	if got := safeReturnPath("/timer?view=today#ignored"); got != "/timer?view=today" {
		t.Fatalf("safeReturnPath() = %q, want query without fragment", got)
	}
}
