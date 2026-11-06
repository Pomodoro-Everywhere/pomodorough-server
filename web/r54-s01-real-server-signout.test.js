"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");

// The real-server leg lives in internal/server/r54_s01_browser_test.go and
// skips unless its gate is set, so `go test ./...` alone never runs it. Running
// it here keeps the real revoke and cookie-rejection proof in npm run test:web,
// which CI and release run with Go and Playwright Chromium installed.
function runRealServerLeg() {
  return new Promise((resolve) => {
    execFile("go", ["test", "./internal/server", "-run", "^TestBrowserR54S01MissingCSRF$", "-count=1", "-v", "-timeout=200s"], {
      cwd: path.join(__dirname, ".."), maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, POMODOROUGH_R54_S01_BROWSER: "1" }
    }, (error, stdout, stderr) => resolve({ error, output: stdout + stderr }));
  });
}

test("R54-S01 real server and Chromium revoke a CSRF-less sign-out after recovery", { timeout: 240000 }, async () => {
  const { error, output } = await runRealServerLeg();
  assert.equal(error, null, output);
  assert.doesNotMatch(output, /--- SKIP/, output);
  for (const mode of ["transient", "offline"]) {
    assert.match(output, new RegExp(`--- PASS: TestBrowserR54S01MissingCSRF/${mode} \\(`), output);
  }
});
