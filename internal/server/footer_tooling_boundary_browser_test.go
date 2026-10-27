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

func TestBrowserFooterToolingBoundaries(t *testing.T) {
	if os.Getenv("POMODOROUGH_FOOTER_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_FOOTER_BROWSER=1 to run real-browser tooling regressions")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	input := footerToolingFixture(t, root)
	override := filepath.Join(t.TempDir(), "axe-override.js")
	script := `window.axe = { run: async () => ({ violations: [{ nodes: [{
		target: ["R53-S03 override"], failureSummary: "explicit axe override executed"
	}] }] }) };`
	if err := os.WriteFile(override, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, axePath, wantFailure string
	}{
		{"independent Playwright override with installed axe", "", ""},
		{"explicit axe override reports violations", override, "explicit axe override executed"},
		{"missing axe override does not fall back", override + ".missing", "ENOENT"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runFooterToolingBoundary(t, root, input, tc.axePath, tc.wantFailure)
		})
	}
}

func footerToolingFixture(t *testing.T, root string) []byte {
	t.Helper()
	fixture := newServerFixture(t)
	fixture.application.cfg.WebRoot = filepath.Join(root, "web")
	listener := httptest.NewTLSServer(fixture.application.Handler())
	t.Cleanup(listener.Close)
	t.Cleanup(listener.CloseClientConnections)
	fixture.application.cfg.PublicURL = listener.URL
	input, err := json.Marshal(map[string]string{
		"url":           listener.URL,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	return input
}

func runFooterToolingBoundary(t *testing.T, root string, input []byte, axePath, wantFailure string) {
	t.Helper()
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/footer-contrast-browser.test.cjs"))
	command.Stdin = bytes.NewReader(input)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "POMODOROUGH_PLAYWRIGHT_MODULE=") && !strings.HasPrefix(entry, "POMODOROUGH_AXE_PATH=") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env,
		"POMODOROUGH_PLAYWRIGHT_MODULE="+filepath.Join(root, "node_modules/playwright/index.js"),
		"POMODOROUGH_AXE_PATH="+axePath)
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("footer tooling runner timed out: %v\n%s", ctx.Err(), output)
	}
	if wantFailure == "" {
		if err != nil || !bytes.Contains(output, []byte("\naxe footer color-contrast clean\n")) {
			t.Fatalf("installed axe runner failed: %v\n%s", err, output)
		}
		return
	}
	if err == nil || !bytes.Contains(output, []byte(wantFailure)) {
		t.Fatalf("expected runner failure containing %q, got %v\n%s", wantFailure, err, output)
	}
	if !bytes.Contains(output, []byte("keyboard ok")) || bytes.Contains(output, []byte("\naxe footer color-contrast clean\n")) {
		t.Fatalf("runner must reach axe and fail without reporting success:\n%s", output)
	}
}
