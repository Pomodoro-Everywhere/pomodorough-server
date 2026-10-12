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

func TestContentSecurityPolicyAllowsWasmWithoutJavaScriptEval(t *testing.T) {
	fixture := newServerFixture(t)
	for _, route := range []string{"/", "/app", "/api/v1/me"} {
		t.Run(route, func(t *testing.T) {
			request := httptest.NewRequest("GET", fixture.application.cfg.PublicURL+route, nil)
			addWebAuthentication(request, fixture)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			for _, directive := range strings.Split(response.Header().Get("Content-Security-Policy"), ";") {
				if strings.HasPrefix(strings.TrimSpace(directive), "script-src ") {
					want := "script-src 'self' 'wasm-unsafe-eval' https://browser.sentry-cdn.com"
					if strings.TrimSpace(directive) != want {
						t.Fatalf("script policy = %q, want %q", directive, want)
					}
					return
				}
			}
			t.Fatal("missing script-src directive")
		})
	}
}

// Run with POMODOROUGH_CSP_BROWSER=1 and an installed Playwright Chromium browser.
// POMODOROUGH_PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH can select local tools.
func TestBrowserCSPColdStartup(t *testing.T) {
	if os.Getenv("POMODOROUGH_CSP_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_CSP_BROWSER=1 to run the real-browser CSP regression")
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
	command := exec.CommandContext(ctx, "node", "../../scripts/csp-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("real-browser CSP regression: %v", err)
	}
}
