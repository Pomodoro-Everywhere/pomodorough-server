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

// Run with POMODOROUGH_ENLARGED_TEXT_BROWSER=1 and an installed Playwright Chromium.
func TestBrowserEnlargedTextDuration(t *testing.T) {
	if os.Getenv("POMODOROUGH_ENLARGED_TEXT_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_ENLARGED_TEXT_BROWSER=1 to run the real-browser enlarged-text regression")
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
	command := exec.CommandContext(ctx, "node", "../../scripts/enlarged-text-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("real-browser enlarged-text regression: %v", err)
	}
}
