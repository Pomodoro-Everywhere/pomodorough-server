package server

import "testing"

func TestBrowserStaleDeletionRecovery(t *testing.T) {
	runDeletionRecoveryBrowser(t, "stale-deletion-recovery-browser.test.cjs", "")
}
