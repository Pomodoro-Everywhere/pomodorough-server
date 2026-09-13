package server

import (
	"bytes"
	"encoding/json"
)

// Preserve legacy string construction while distinguishing retarget null from
// omission. Decode through an alias so strict unknown-field checks still run.
func (command *syncCommandJSON) UnmarshalJSON(payload []byte) error {
	type wire syncCommandJSON
	var decoded wire
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return err
	}
	decoded.TaskIDExplicitNull = bytes.Equal(bytes.TrimSpace(fields["taskId"]), []byte("null"))
	*command = syncCommandJSON(decoded)
	return nil
}
