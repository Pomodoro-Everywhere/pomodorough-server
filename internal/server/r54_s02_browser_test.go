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

func TestBrowserR54S02UnreadablePendingQueues(t *testing.T) {
	if os.Getenv("POMODOROUGH_R54_S02_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_R54_S02_BROWSER=1 to run Chromium unreadable-queue sign-out")
	}
	for _, scenario := range []string{"refresh", "guarded", "bootstrap", "limitentry", "cancel", "recoveryretry", "crosstab"} {
		for _, locale := range []string{"en", "ar-XB"} {
			name := scenario + "@" + locale
			t.Run(name, func(t *testing.T) { runR54S02Browser(t, scenario, locale, name) })
		}
	}
}

func runR54S02Browser(t *testing.T, scenario, locale, name string) {
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
		"url": listener.URL, "scenario": scenario, "locale": locale,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/r54-s02-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatal(err)
	}
	// Exit status alone passes a script that returns before its assertions.
	if !strings.Contains(string(output), "R54-S02-OK "+name+"\n") {
		t.Fatalf("browser leg %s did not report success", name)
	}
}
