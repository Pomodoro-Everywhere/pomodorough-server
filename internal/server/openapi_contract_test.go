package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type openAPIRouteContract struct {
	method       string
	operationID  string
	statuses     []string
	public       bool
	requestRef   string
	successCode  string
	successMedia string
	successRef   string
}

func TestOpenAPIRoutesSchemasStatusesAndSecurityMatchServer(t *testing.T) {
	document := loadOpenAPIDocument(t)
	paths := openAPIMap(t, document, "paths")
	contracts := map[string]openAPIRouteContract{
		"/openapi.yaml":                 {http.MethodGet, "getOpenAPISpec", []string{"200", "503"}, true, "", "200", "application/yaml", ""},
		"/healthz":                      {http.MethodGet, "getHealth", []string{"200"}, true, "", "200", "application/json", "#/components/schemas/HealthResponse"},
		"/auth/google/start":            {http.MethodGet, "startGoogleAuthentication", []string{"302", "500", "503"}, true, "", "", "", ""},
		"/auth/google/callback":         {http.MethodGet, "completeGoogleAuthentication", []string{"303", "400", "401", "500", "502", "503"}, true, "", "", "", ""},
		"/api/v1/auth/google/challenge": {http.MethodPost, "createGoogleChallenge", []string{"200", "500", "503"}, true, "", "200", "application/json", "#/components/schemas/NativeChallengeResponse"},
		"/api/v1/auth/google/exchange":  {http.MethodPost, "exchangeGoogleIDToken", []string{"200", "400", "401", "500", "503"}, true, "#/components/schemas/NativeExchangeRequest", "200", "application/json", "#/components/schemas/TokenResponse"},
		"/api/v1/auth/refresh":          {http.MethodPost, "refreshNativeTokens", []string{"200", "400", "401", "500"}, true, "#/components/schemas/RefreshRequest", "200", "application/json", "#/components/schemas/TokenResponse"},
		"/api/v1/me":                    {http.MethodGet, "getCurrentUser", []string{"200", "401", "500"}, false, "", "200", "application/json", "#/components/schemas/MeResponse"},
		"/api/v1/auth/logout":           {http.MethodPost, "logout", []string{"204", "401", "403", "500"}, false, "", "", "", ""},
		"/api/v1/auth/revoke-device":    {http.MethodPost, "revokeDevice", []string{"204", "400", "401", "403", "500"}, false, "#/components/schemas/RevokeDeviceRequest", "", "", ""},
		"/api/v1/bootstrap":             {http.MethodGet, "getBootstrapSnapshot", []string{"200", "401", "409", "500"}, false, "", "200", "application/json", "#/components/schemas/SyncResponse"},
		"/api/v1/bootstrap/resolve":     {http.MethodPost, "resolveBootstrapHistory", []string{"200", "400", "401", "403", "409", "500"}, false, "#/components/schemas/BootstrapResolutionRequest", "200", "application/json", "#/components/schemas/SyncResponse"},
		"/api/v1/sync":                  {http.MethodPost, "syncTimer", []string{"200", "400", "401", "403", "409", "500"}, false, "#/components/schemas/SyncRequest", "200", "application/json", "#/components/schemas/SyncResponse"},
		"/api/v1/history":               {http.MethodGet, "getTimerHistory", []string{"200", "401", "409", "500"}, false, "", "200", "application/json", "#/components/schemas/HistoryResponse"},
		"/api/v1/stream":                {http.MethodGet, "streamTimerRevisions", []string{"200", "401", "409", "500"}, false, "", "200", "text/event-stream", ""},
	}
	if len(paths) != len(contracts) {
		t.Fatalf("OpenAPI path count = %d, want %d", len(paths), len(contracts))
	}
	fixture := newServerFixture(t)
	seenOperationIDs := make(map[string]string, len(contracts))
	for path, contract := range contracts {
		pathObject := openAPIMap(t, paths, path)
		if len(pathObject) != 1 {
			t.Fatalf("%s methods = %#v", path, pathObject)
		}
		operation := openAPIMap(t, pathObject, strings.ToLower(contract.method))
		if operation["operationId"] != contract.operationID {
			t.Fatalf("%s operationId = %#v, want %q", path, operation["operationId"], contract.operationID)
		}
		if previous, exists := seenOperationIDs[contract.operationID]; exists {
			t.Fatalf("duplicate operationId %q on %s and %s", contract.operationID, previous, path)
		}
		seenOperationIDs[contract.operationID] = path
		assertOpenAPISecurity(t, path, operation, contract.public)
		responses := openAPIMap(t, operation, "responses")
		statuses := make([]string, 0, len(responses))
		for status := range responses {
			statuses = append(statuses, status)
		}
		sort.Strings(statuses)
		wantStatuses := append([]string(nil), contract.statuses...)
		sort.Strings(wantStatuses)
		if !reflect.DeepEqual(statuses, wantStatuses) {
			t.Fatalf("%s response statuses = %v, want %v", path, statuses, wantStatuses)
		}
		assertOpenAPIRequestRef(t, path, operation, contract.requestRef)
		assertOpenAPISuccessSchema(t, path, responses, contract.successCode, contract.successMedia, contract.successRef)

		request := httptest.NewRequest(contract.method, "https://pomodorough.egigoka.me"+path, nil)
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		if response.Code == http.StatusNotFound || response.Code == http.StatusMethodNotAllowed {
			t.Fatalf("registered %s %s status = %d", contract.method, path, response.Code)
		}
		wrongMethod := http.MethodPost
		if contract.method == http.MethodPost {
			wrongMethod = http.MethodGet
		}
		request = httptest.NewRequest(wrongMethod, "https://pomodorough.egigoka.me"+path, nil)
		response = httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed && response.Code != http.StatusNotFound {
			t.Fatalf("undocumented %s %s status = %d, want 404 or 405", wrongMethod, path, response.Code)
		}
	}
}

func TestOpenAPIReferencesAndPreferenceContractsMatchServer(t *testing.T) {
	document := loadOpenAPIDocument(t)
	walkOpenAPIRefs(t, document, document)
	bootstrapOperation := openAPIMap(t, openAPIMap(t, openAPIMap(t, document, "paths"), "/api/v1/bootstrap"), "get")
	if summary, _ := bootstrapOperation["summary"].(string); !strings.Contains(summary, "Materialize") {
		t.Fatalf("bootstrap summary = %q", summary)
	}
	if description, _ := bootstrapOperation["description"].(string); !strings.Contains(description, "transactionally") || !strings.Contains(description, "increments revision once") {
		t.Fatalf("bootstrap materialization description = %q", description)
	}
	schemas := openAPIMap(t, openAPIMap(t, document, "components"), "schemas")
	syncRequest := openAPIMap(t, schemas, "SyncRequest")
	bootstrapRequest := openAPIMap(t, schemas, "BootstrapResolutionRequest")
	syncResponse := openAPIMap(t, schemas, "SyncResponse")
	autoStartOperation := openAPIMap(t, schemas, "AutoStartOperation")
	autoStartAcknowledgement := openAPIMap(t, schemas, "AutoStartAcknowledgement")
	selectedTaskOperation := openAPIMap(t, schemas, "SelectedTaskOperation")
	selectedTaskAcknowledgement := openAPIMap(t, schemas, "SelectedTaskAcknowledgement")
	const maxSafeRevision = 9_007_199_254_740_991

	assertOpenAPIOperationArray(t, syncRequest, "autoStartOperations", 256, "#/components/schemas/AutoStartOperation")
	assertOpenAPIOperationArray(t, bootstrapRequest, "autoStartOperations", 4096, "#/components/schemas/AutoStartOperation")
	assertOpenAPIOperationArray(t, syncRequest, "selectedTaskOperations", 256, "#/components/schemas/SelectedTaskOperation")
	assertOpenAPIOperationArray(t, bootstrapRequest, "selectedTaskOperations", 4096, "#/components/schemas/SelectedTaskOperation")
	if openAPIRequired(syncRequest, "autoStartOperations") || openAPIRequired(bootstrapRequest, "autoStartOperations") {
		t.Fatal("autoStartOperations must remain optional for sync and omitted-vs-empty bootstrap compatibility")
	}
	if openAPIRequired(syncRequest, "selectedTaskOperations") || openAPIRequired(bootstrapRequest, "selectedTaskOperations") {
		t.Fatal("selectedTaskOperations must remain optional for sync and omitted-vs-empty bootstrap compatibility")
	}
	bootstrapAutoStart := openAPIMap(t, openAPIMap(t, bootstrapRequest, "properties"), "autoStartOperations")
	bootstrapDescription, _ := bootstrapAutoStart["description"].(string)
	if !strings.Contains(bootstrapDescription, "Omission") || !strings.Contains(bootstrapDescription, "present empty") {
		t.Fatalf("bootstrap auto-start compatibility description = %q", bootstrapDescription)
	}
	bootstrapSelectedTask := openAPIMap(t, openAPIMap(t, bootstrapRequest, "properties"), "selectedTaskOperations")
	bootstrapSelectedTaskDescription, _ := bootstrapSelectedTask["description"].(string)
	if !strings.Contains(bootstrapSelectedTaskDescription, "Omission") || !strings.Contains(bootstrapSelectedTaskDescription, "present empty") {
		t.Fatalf("bootstrap selected-task compatibility description = %q", bootstrapSelectedTaskDescription)
	}
	for _, field := range []string{"id", "enabled", "occurredAt", "hlcWallMs", "hlcCounter"} {
		if !openAPIRequired(autoStartOperation, field) {
			t.Fatalf("AutoStartOperation missing required field %q", field)
		}
	}
	for _, field := range []string{"id", "taskId", "occurredAt", "hlcWallMs", "hlcCounter"} {
		if !openAPIRequired(selectedTaskOperation, field) {
			t.Fatalf("SelectedTaskOperation missing required field %q", field)
		}
	}
	selectedTaskID := openAPIMap(t, openAPIMap(t, selectedTaskOperation, "properties"), "taskId")
	if selectedTaskID["nullable"] != true {
		t.Fatalf("SelectedTaskOperation taskId schema = %#v", selectedTaskID)
	}
	if taskIDRef := firstOpenAPIAllOfRef(t, selectedTaskID); taskIDRef != "#/components/schemas/TaskID" {
		t.Fatalf("SelectedTaskOperation taskId reference = %q", taskIDRef)
	}
	for _, field := range []string{"operationId", "outcome", "reason"} {
		if !openAPIRequired(autoStartAcknowledgement, field) {
			t.Fatalf("AutoStartAcknowledgement missing required field %q", field)
		}
	}
	for _, field := range []string{"operationId", "outcome", "reason"} {
		if !openAPIRequired(selectedTaskAcknowledgement, field) {
			t.Fatalf("SelectedTaskAcknowledgement missing required field %q", field)
		}
	}
	for _, field := range []string{"autoStartAcknowledgements", "autoStartBreaks"} {
		if !openAPIRequired(syncResponse, field) {
			t.Fatalf("SyncResponse missing required field %q", field)
		}
	}
	for _, field := range []string{"selectedTaskAcknowledgements", "selectedTaskId"} {
		if !openAPIRequired(syncResponse, field) {
			t.Fatalf("SyncResponse missing required field %q", field)
		}
	}
	for name, property := range map[string]map[string]any{
		"lastRevision":     openAPIMap(t, openAPIMap(t, syncRequest, "properties"), "lastRevision"),
		"expectedRevision": openAPIMap(t, openAPIMap(t, bootstrapRequest, "properties"), "expectedRevision"),
		"revision":         openAPIMap(t, openAPIMap(t, syncResponse, "properties"), "revision"),
		"serverHlcWallMs":  openAPIMap(t, openAPIMap(t, syncResponse, "properties"), "serverHlcWallMs"),
		"serverHlcCounter": openAPIMap(t, openAPIMap(t, syncResponse, "properties"), "serverHlcCounter"),
	} {
		if property["maximum"] != maxSafeRevision {
			t.Fatalf("%s maximum = %#v, want %d", name, property["maximum"], maxSafeRevision)
		}
	}
	responseProperties := openAPIMap(t, syncResponse, "properties")
	acknowledgements := openAPIMap(t, responseProperties, "autoStartAcknowledgements")
	if openAPIMap(t, acknowledgements, "items")["$ref"] != "#/components/schemas/AutoStartAcknowledgement" {
		t.Fatalf("autoStartAcknowledgements schema = %#v", acknowledgements)
	}
	autoStartBreaks := openAPIMap(t, responseProperties, "autoStartBreaks")
	if autoStartBreaks["type"] != "boolean" || autoStartBreaks["default"] != false {
		t.Fatalf("autoStartBreaks schema = %#v", autoStartBreaks)
	}
	selectedTaskAcknowledgements := openAPIMap(t, responseProperties, "selectedTaskAcknowledgements")
	if openAPIMap(t, selectedTaskAcknowledgements, "items")["$ref"] != "#/components/schemas/SelectedTaskAcknowledgement" {
		t.Fatalf("selectedTaskAcknowledgements schema = %#v", selectedTaskAcknowledgements)
	}
	selectedTaskResponseID := openAPIMap(t, responseProperties, "selectedTaskId")
	if selectedTaskResponseID["nullable"] != true {
		t.Fatalf("selectedTaskId response schema = %#v", selectedTaskResponseID)
	}
	if taskIDRef := firstOpenAPIAllOfRef(t, selectedTaskResponseID); taskIDRef != "#/components/schemas/TaskID" {
		t.Fatalf("selectedTaskId response reference = %q", taskIDRef)
	}
}

func loadOpenAPIDocument(t *testing.T) map[string]any {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join("..", "..", "web", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("parse OpenAPI YAML: %v", err)
	}
	return document
}

func assertOpenAPISecurity(t *testing.T, path string, operation map[string]any, public bool) {
	t.Helper()
	security, ok := operation["security"].([]any)
	if !ok {
		t.Fatalf("%s security is missing", path)
	}
	if public {
		if len(security) != 0 {
			t.Fatalf("%s public security = %#v", path, security)
		}
		return
	}
	want := map[string]bool{"cookieAuth": false, "bearerAuth": false}
	for _, value := range security {
		entry, ok := value.(map[string]any)
		if !ok || len(entry) != 1 {
			t.Fatalf("%s security entry = %#v", path, value)
		}
		for name := range entry {
			if _, exists := want[name]; !exists {
				t.Fatalf("%s unknown security scheme %q", path, name)
			}
			want[name] = true
		}
	}
	for name, present := range want {
		if !present {
			t.Fatalf("%s missing security scheme %q", path, name)
		}
	}
}

func assertOpenAPIRequestRef(t *testing.T, path string, operation map[string]any, want string) {
	t.Helper()
	requestBody, exists := operation["requestBody"]
	if want == "" {
		if exists {
			t.Fatalf("%s unexpected requestBody = %#v", path, requestBody)
		}
		return
	}
	body, ok := requestBody.(map[string]any)
	if !ok || body["required"] != true {
		t.Fatalf("%s requestBody = %#v", path, requestBody)
	}
	schema := openAPIMap(t, openAPIMap(t, openAPIMap(t, body, "content"), "application/json"), "schema")
	if schema["$ref"] != want {
		t.Fatalf("%s request schema = %#v, want %s", path, schema, want)
	}
}

func assertOpenAPISuccessSchema(t *testing.T, path string, responses map[string]any, code, media, wantRef string) {
	t.Helper()
	if code == "" {
		return
	}
	response := openAPIMap(t, responses, code)
	schema := openAPIMap(t, openAPIMap(t, openAPIMap(t, response, "content"), media), "schema")
	if wantRef != "" && schema["$ref"] != wantRef {
		t.Fatalf("%s success schema = %#v, want %s", path, schema, wantRef)
	}
}

func assertOpenAPIOperationArray(t *testing.T, schema map[string]any, field string, maximum int, itemRef string) {
	t.Helper()
	property, ok := openAPIMap(t, schema, "properties")[field].(map[string]any)
	if !ok {
		t.Fatalf("%s property missing", field)
	}
	if property["type"] != "array" || property["maxItems"] != maximum || openAPIMap(t, property, "items")["$ref"] != itemRef {
		t.Fatalf("%s operation array = %#v", field, property)
	}
}

func openAPIRequired(schema map[string]any, field string) bool {
	required, _ := schema["required"].([]any)
	for _, item := range required {
		if item == field {
			return true
		}
	}
	return false
}

func firstOpenAPIAllOfRef(t *testing.T, schema map[string]any) string {
	t.Helper()
	allOf, ok := schema["allOf"].([]any)
	if !ok || len(allOf) != 1 {
		t.Fatalf("allOf = %#v, want one schema", schema["allOf"])
	}
	reference, ok := allOf[0].(map[string]any)
	if !ok {
		t.Fatalf("allOf schema = %#v", allOf[0])
	}
	value, _ := reference["$ref"].(string)
	return value
}

func openAPIMap(t *testing.T, object map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := object[key].(map[string]any)
	if !ok {
		t.Fatalf("OpenAPI key %q is not an object", key)
	}
	return value
}

func walkOpenAPIRefs(t *testing.T, root map[string]any, value any) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "$ref" {
				ref, ok := child.(string)
				if !ok || !strings.HasPrefix(ref, "#/") || resolveOpenAPIRef(root, ref) == nil {
					t.Fatalf("unresolved OpenAPI reference %#v", child)
				}
			}
			walkOpenAPIRefs(t, root, child)
		}
	case []any:
		for _, child := range typed {
			walkOpenAPIRefs(t, root, child)
		}
	}
}

func resolveOpenAPIRef(root map[string]any, ref string) any {
	var current any = root
	for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[part]
		if current == nil {
			return nil
		}
	}
	return current
}
