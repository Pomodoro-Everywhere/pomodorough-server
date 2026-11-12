package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

// The Node test runner's summary of a run in which tests ran and none failed.
var uxRound2PassSummary = regexp.MustCompile(`(?m)^ℹ pass [1-9][0-9]*$`)
var uxRound2FailSummary = regexp.MustCompile(`(?m)^ℹ fail 0$`)

// A second web session of the fixture user: the browser signs out of the
// first one and signs in again with this one.
func uxRound2SecondWebSession(t *testing.T, fixture serverFixture) (string, string) {
	t.Helper()
	ctx := context.Background()
	db, err := fixture.userStore.OpenUser(ctx, fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	token, tokenHash, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	csrfToken := "csrf-token-second"
	csrfHash := authn.HashString(csrfToken)
	now := time.Now().UTC()
	if err := store.CreateSession(ctx, db, store.Session{
		ID: "web-session-second", Kind: "web", Platform: "web", CSRFHash: csrfHash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []store.TokenRecord{{Hash: tokenHash, Kind: "web", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	return token, csrfToken
}

// Run with POMODOROUGH_UX_ROUND2_BROWSER=1 and an installed Playwright Chromium.
// POMODOROUGH_UX_ROUND2_WEBROOT serves another copy of the web client, which
// is how the regression is shown red against the client before the change.
// POMODOROUGH_UX_ROUND2_SHOTS names a folder for evidence screenshots.
func TestBrowserUXRound2(t *testing.T) {
	if os.Getenv("POMODOROUGH_UX_ROUND2_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_UX_ROUND2_BROWSER=1 to run the real-browser undo, notice and timer dock regression")
	}
	fixture := newServerFixture(t)
	webRoot := os.Getenv("POMODOROUGH_UX_ROUND2_WEBROOT")
	if webRoot == "" {
		webRoot = "../../web"
	}
	webRoot, err := filepath.Abs(webRoot)
	if err != nil {
		t.Fatal(err)
	}
	fixture.application.cfg.WebRoot = webRoot
	listener := httptest.NewTLSServer(fixture.application.Handler())
	defer listener.Close()
	defer listener.CloseClientConnections()
	fixture.application.cfg.PublicURL = listener.URL
	secondToken, secondCSRF := uxRound2SecondWebSession(t, fixture)
	input, err := json.Marshal(map[string]string{
		"url": fixture.application.cfg.PublicURL, "userID": fixture.userID,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
		"secondSessionToken": secondToken, "secondCsrfToken": secondCSRF,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/ux-round2-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatalf("real-browser UX round 2 regression: %v", err)
	}
	// An exit code of zero is not enough: a run that selected no test also exits with zero.
	if !uxRound2PassSummary.Match(output) || !uxRound2FailSummary.Match(output) {
		t.Fatal("real-browser UX round 2 regression: the test runner printed no passing summary")
	}
}
