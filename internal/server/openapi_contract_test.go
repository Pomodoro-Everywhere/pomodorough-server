package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestOpenAPIReferencesAndAutoStartContractsMatchServer(t *testing.T) {
	encoded, err := os.ReadFile(filepath.Join("..", "..", "web", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("parse OpenAPI YAML: %v", err)
	}
	walkOpenAPIRefs(t, document, document)
	schemas := openAPIMap(t, openAPIMap(t, document, "components"), "schemas")
	syncRequest := openAPIMap(t, schemas, "SyncRequest")
	bootstrapRequest := openAPIMap(t, schemas, "BootstrapResolutionRequest")
	syncResponse := openAPIMap(t, schemas, "SyncResponse")
	autoStartOperation := openAPIMap(t, schemas, "AutoStartOperation")
	autoStartAcknowledgement := openAPIMap(t, schemas, "AutoStartAcknowledgement")

	assertOpenAPIOperationArray(t, syncRequest, "autoStartOperations", 256)
	assertOpenAPIOperationArray(t, bootstrapRequest, "autoStartOperations", 4096)
	if openAPIRequired(syncRequest, "autoStartOperations") || openAPIRequired(bootstrapRequest, "autoStartOperations") {
		t.Fatal("autoStartOperations must remain optional for sync and omitted-vs-empty bootstrap compatibility")
	}
	bootstrapAutoStart := openAPIMap(t, openAPIMap(t, bootstrapRequest, "properties"), "autoStartOperations")
	bootstrapDescription, _ := bootstrapAutoStart["description"].(string)
	if !strings.Contains(bootstrapDescription, "Omission") || !strings.Contains(bootstrapDescription, "present empty") {
		t.Fatalf("bootstrap auto-start compatibility description = %q", bootstrapDescription)
	}
	for _, field := range []string{"id", "enabled", "occurredAt", "hlcWallMs", "hlcCounter"} {
		if !openAPIRequired(autoStartOperation, field) {
			t.Fatalf("AutoStartOperation missing required field %q", field)
		}
	}
	for _, field := range []string{"operationId", "outcome", "reason"} {
		if !openAPIRequired(autoStartAcknowledgement, field) {
			t.Fatalf("AutoStartAcknowledgement missing required field %q", field)
		}
	}
	for _, field := range []string{"autoStartAcknowledgements", "autoStartBreaks"} {
		if !openAPIRequired(syncResponse, field) {
			t.Fatalf("SyncResponse missing required field %q", field)
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
}

func assertOpenAPIOperationArray(t *testing.T, schema map[string]any, field string, maximum int) {
	t.Helper()
	property, ok := openAPIMap(t, schema, "properties")[field].(map[string]any)
	if !ok {
		t.Fatalf("%s property missing", field)
	}
	if property["type"] != "array" || property["maxItems"] != maximum || openAPIMap(t, property, "items")["$ref"] != "#/components/schemas/AutoStartOperation" {
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
