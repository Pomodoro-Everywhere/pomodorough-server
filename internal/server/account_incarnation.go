package server

import (
	"crypto/sha256"
	"fmt"
	"net/http"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

const accountIncarnationHeader = "X-Pomodorough-Account-Incarnation"

func accountIncarnation(identity principal) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("account:v1:%s:%d", identity.UserID, identity.Generation))))
}

func validAccountIncarnation(w http.ResponseWriter, r *http.Request, identity principal) bool {
	values, present := r.Header[http.CanonicalHeaderKey(accountIncarnationHeader)]
	if !present || len(values) == 1 && authn.EqualString(values[0], accountIncarnation(identity)) {
		return true
	}
	writeAPIError(w, r, http.StatusConflict, "account incarnation changed")
	return false
}

func writeAccountSnapshot(w http.ResponseWriter, r *http.Request, identity principal, result store.SyncResult) {
	writeJSON(w, r, http.StatusOK, struct {
		store.SyncResult
		AccountIncarnation string `json:"accountIncarnation"`
	}{result, accountIncarnation(identity)})
}
