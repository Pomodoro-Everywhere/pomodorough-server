package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
)

func TestBrowserR54S03ReSignIn(t *testing.T) {
	if os.Getenv("POMODOROUGH_R54_S03_BROWSER") != "1" {
		t.Skip("set POMODOROUGH_R54_S03_BROWSER=1 to run Chromium re-sign-in after a deferred sign-out")
	}
	for _, scenario := range []string{"resignin", "field", "held"} {
		t.Run(scenario, func(t *testing.T) { runR54S03Browser(t, scenario) })
	}
}

func runR54S03Browser(t *testing.T, scenario string) {
	t.Helper()
	fixture := newServerFixture(t)
	application := fixture.application
	root, err := filepath.Abs("../../web")
	if err != nil {
		t.Fatal(err)
	}
	application.cfg.WebRoot = root
	google := newR54S03Chooser(t, application)
	defer google.server.Close()
	listener := httptest.NewTLSServer(application.Handler())
	defer listener.Close()
	defer listener.CloseClientConnections()
	application.cfg.PublicURL = listener.URL
	application.oauthConfig.RedirectURL = listener.URL + "/auth/google/callback"
	input, err := json.Marshal(map[string]string{
		"url": listener.URL, "google": google.url, "scenario": scenario,
		"sessionCookie": authn.WebSessionCookie, "sessionToken": fixture.webToken,
		"csrfCookie": authn.CSRFCookie, "csrfToken": fixture.csrfToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := serverTestContext(t)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "../../scripts/r54-s03-browser.test.cjs")
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	t.Logf("%s", output)
	if err != nil {
		t.Fatal(err)
	}
	// Exit status alone passes a script that returns before its assertions.
	if !strings.Contains(string(output), "R54-S03-OK "+scenario+"\n") {
		t.Fatalf("browser leg %s did not report success", scenario)
	}
}

// r54S03Chooser is a fake Google on http://localhost, a different site from
// the 127.0.0.1 HTTPS server, so the callback is a real cross-site top-level
// GET. It serves an account chooser for the fixture subject, a token endpoint
// that signs the nonce of the matching start request, and /control/session,
// which reports whether a web session token still authenticates.
type r54S03Chooser struct {
	t           *testing.T
	application *Server
	sign        func(map[string]any) string
	server      *httptest.Server
	url         string
	mu          sync.Mutex
	nonces      map[string]string
}

func newR54S03Chooser(t *testing.T, application *Server) *r54S03Chooser {
	t.Helper()
	verifier, sign := testGoogleVerifier(t)
	chooser := &r54S03Chooser{t: t, application: application, sign: sign, nonces: map[string]string{}}
	chooser.server = httptest.NewServer(chooser)
	chooser.url = strings.Replace(chooser.server.URL, "127.0.0.1", "localhost", 1)
	application.cfg.GoogleWebClientID = "web-client"
	application.cfg.GoogleWebClientSecret = "web-secret"
	application.webVerifier = verifier
	application.oauthConfig.ClientID = "web-client"
	application.oauthConfig.ClientSecret = "web-secret"
	application.oauthConfig.Endpoint = oauth2.Endpoint{
		AuthURL: chooser.url + "/authorize", TokenURL: chooser.server.URL + "/token", AuthStyle: oauth2.AuthStyleInParams,
	}
	return chooser
}

func (c *r54S03Chooser) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/authorize":
		c.authorize(w, r)
	case "/token":
		c.token(w, r)
	case "/control/session":
		c.session(w, r)
	default:
		http.NotFound(w, r)
	}
}

// authorize offers one account. Each chooser issues a new code that remembers
// the nonce its start request sent.
func (c *r54S03Chooser) authorize(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	c.mu.Lock()
	code := fmt.Sprintf("code-%d", len(c.nonces))
	c.nonces[code] = query.Get("nonce")
	c.mu.Unlock()
	target := query.Get("redirect_uri") + "?" + url.Values{"code": {code}, "state": {query.Get("state")}}.Encode()
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprintf(w, `<!doctype html><title>Fake chooser</title><a id="pick" href="%s">test-subject</a>`, html.EscapeString(target))
}

func (c *r54S03Chooser) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		c.t.Error(err)
	}
	c.mu.Lock()
	nonce, ok := c.nonces[r.Form.Get("code")]
	c.mu.Unlock()
	if !ok {
		http.Error(w, "unknown code", http.StatusBadRequest)
		return
	}
	claims := testGoogleClaims("web-client", nonce, time.Now().Add(time.Hour))
	claims["sub"] = "test-subject"
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "provider-access", "token_type": "Bearer", "id_token": c.sign(claims)})
}

func (c *r54S03Chooser) session(w http.ResponseWriter, r *http.Request) {
	request := httptest.NewRequest(http.MethodGet, "https://chooser.invalid/api/v1/me", nil)
	request.AddCookie(&http.Cookie{Name: authn.WebSessionCookie, Value: r.URL.Query().Get("token")})
	_, err := c.application.authenticate(request)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"valid": err == nil})
}
