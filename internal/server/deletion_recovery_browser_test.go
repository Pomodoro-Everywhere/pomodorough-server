package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"pomodorough/internal/authn"
)

// Run with POMODOROUGH_DELETION_RECOVERY_BROWSER=1 and an installed Playwright Chromium browser.
func TestBrowserDeletionRecoveryLostResponse(t *testing.T) {
	runDeletionRecoveryBrowser(t, "deletion-recovery-browser.test.cjs", "")
}

func TestBrowserLegacyDeletionReceiptRecovery(t *testing.T) {
	runDeletionRecoveryBrowser(t, "deletion-recovery-browser.test.cjs", "legacy")
}

func TestBrowserDeletionMarkerPrerequisite(t *testing.T) {
	for _, name := range []string{"QuotaExceededError", "SecurityError", "denied-readback", "legacy-readback", "changed-readback",
		"promotion-quota", "crash-after-candidate", "crash-before-readback", "crash-after-readback", "crash-after-issued"} {
		t.Run(name, func(t *testing.T) {
			runDeletionRecoveryBrowser(t, "deletion-marker-browser.test.cjs", name)
		})
	}
}

func runDeletionRecoveryBrowser(t *testing.T, script, errorName string) {
	t.Helper()
	if os.Getenv("POMODOROUGH_DELETION_RECOVERY_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_DELETION_RECOVERY_BROWSER=1 to run the real-browser deletion recovery regression")
	}
	fixture := newServerFixture(t)
	webRoot, err := filepath.Abs("../../web")
	if err != nil {
		t.Fatal(err)
	}
	fixture.application.cfg.WebRoot = webRoot
	listener := httptest.NewTLSServer(fixture.application.Handler())
	defer listener.Close()
	defer listener.CloseClientConnections()
	fixture.application.cfg.PublicURL = listener.URL
	input, err := json.Marshal(map[string]string{
		"url": fixture.application.cfg.PublicURL, "userID": fixture.userID,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
		"errorName": errorName,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join("../../scripts", script))
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("real-browser deletion recovery regression: %v", err)
	}
}
