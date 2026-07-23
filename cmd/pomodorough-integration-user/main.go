//go:build integration

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"pomodorough/internal/integrationuser"
)

func main() {
	dataDir := flag.String("data-dir", strings.TrimSpace(os.Getenv("POMODOROUGH_INTEGRATION_DATA_DIR")), "stopped dedicated integration server data directory")
	appSecret := flag.String("app-secret", os.Getenv("POMODOROUGH_INTEGRATION_APP_SECRET"), "server app secret (prefer environment)")
	subject := flag.String("subject", strings.TrimSpace(os.Getenv("POMODOROUGH_INTEGRATION_SUBJECT")), "synthetic integration subject")
	devicesValue := flag.String("devices", strings.TrimSpace(os.Getenv("POMODOROUGH_INTEGRATION_DEVICES")), "comma-separated name=deviceId:platform entries")
	ttlValue := flag.String("ttl", strings.TrimSpace(os.Getenv("POMODOROUGH_INTEGRATION_TTL")), "refresh/session lifetime, for example 2h")
	flag.Parse()
	if flag.NArg() != 0 {
		exitf("unexpected positional arguments")
	}
	devices, err := integrationuser.ParseDevices(*devicesValue)
	if err != nil {
		exitf("invalid devices: %v", err)
	}
	ttl, err := time.ParseDuration(*ttlValue)
	if err != nil {
		exitf("invalid TTL: %v", err)
	}
	credentials, err := integrationuser.Provision(context.Background(), integrationuser.Request{
		DataDir: *dataDir, AppSecret: []byte(*appSecret), Subject: *subject, Devices: devices, TTL: ttl,
	})
	if err != nil {
		exitf("provision integration user: %v", err)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(credentials); err != nil {
		exitf("write credentials: %v", err)
	}
}

func exitf(format string, values ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}
