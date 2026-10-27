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

// From the server root, run npm ci and npx playwright install chromium first.
// Run with POMODOROUGH_FOOTER_BROWSER=1; package-lock.json pins Playwright and axe-core.
// POMODOROUGH_PLAYWRIGHT_MODULE and POMODOROUGH_AXE_PATH override their modules independently;
// CHROMIUM_EXECUTABLE_PATH can select an existing Chromium binary instead of the installed browser.
func TestBrowserFooterContrast(t *testing.T) {
	if os.Getenv("POMODOROUGH_FOOTER_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_FOOTER_BROWSER=1 to run the real-browser footer regression")
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
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/footer-contrast-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("real-browser footer regression: %v", err)
	}
}
