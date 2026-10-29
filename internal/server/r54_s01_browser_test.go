package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"pomodorough/internal/authn"
)

func TestBrowserR54S01MissingCSRF(t *testing.T) {
	if os.Getenv("POMODOROUGH_R54_S01_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_R54_S01_BROWSER=1 to run Chromium sign-out recovery")
	}
	for _, mode := range []string{"transient", "offline"} {
		t.Run(mode, func(t *testing.T) { runR54S01Browser(t, mode) })
	}
}

func runR54S01Browser(t *testing.T, mode string) {
	t.Helper()
	fixture := newServerFixture(t)
	root, err := filepath.Abs("../../web")
	if err != nil {
		t.Fatal(err)
	}
	fixture.application.cfg.WebRoot = root
	listener := httptest.NewTLSServer(fixture.application.Handler())
	defer listener.Close()
	defer listener.CloseClientConnections()
	fixture.application.cfg.PublicURL = listener.URL
	input, err := json.Marshal(map[string]string{
		"url": listener.URL, "mode": mode,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/r54-s01-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatal(err)
	}
	// Exit status alone passes a script that returns before its assertions.
	if !strings.Contains(string(output), "R54-S01-OK "+mode+"\n") {
		t.Fatalf("browser leg %s did not report success", mode)
	}
}
