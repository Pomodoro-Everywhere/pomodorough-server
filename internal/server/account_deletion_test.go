package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"pomodorough/internal/store"
)

func TestHTTPDeleteAccountRequiresExactConfirmationAndPreservesDataOnFailure(t *testing.T) {
	fixture := newServerFixture(t)
	for _, confirmation := range []string{"", "delete", "DELETE "} {
		request, response := newJSONRequest(t, http.MethodDelete, "https://pomodorough.egigoka.me/api/v1/account", map[string]string{"confirmation": confirmation})
		addWebAuthentication(request, fixture)
		addValidCSRF(request, fixture)
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("confirmation %q status = %d body=%s", confirmation, response.Code, response.Body.String())
		}
		db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
		if err != nil {
			t.Fatalf("confirmation %q removed account: %v", confirmation, err)
		}
		db.Close()
	}
}

func TestHTTPDeleteAccountErasesDataRevokesSessionsAndClearsWebCookies(t *testing.T) {
	fixture := newServerFixture(t)
	updates, unsubscribe := fixture.application.hub.subscribe(fixture.userID)
	defer unsubscribe()
	request, response := newJSONRequest(t, http.MethodDelete, "https://pomodorough.egigoka.me/api/v1/account", map[string]string{"confirmation": "DELETE"})
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete account status = %d body=%s", response.Code, response.Body.String())
	}
	if _, open := <-updates; open {
		t.Fatal("account deletion left an authenticated revision stream open")
	}
	if _, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted account open error = %v, want ErrNotFound", err)
	}
	cookies := strings.Join(response.Header().Values("Set-Cookie"), "\n")
	if !strings.Contains(cookies, "pomodorough_session=") || !strings.Contains(cookies, "pomodorough_csrf=") || !strings.Contains(cookies, "Max-Age=0") {
		t.Fatalf("delete account cookies = %q", cookies)
	}

	me, meResponse := newJSONRequest(t, http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(me, fixture)
	fixture.handler.ServeHTTP(meResponse, me)
	if meResponse.Code != http.StatusUnauthorized {
		t.Fatalf("old web session status = %d", meResponse.Code)
	}
	if refresh := postRefresh(t, fixture, fixture.refreshToken); refresh.Code != http.StatusUnauthorized {
		t.Fatalf("old refresh token status = %d body=%s", refresh.Code, refresh.Body.String())
	}
}
