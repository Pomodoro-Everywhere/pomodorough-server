"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");

const scenarios = ["resignin", "field", "held"];

// The real-server leg lives in internal/server/r54_s03_browser_test.go and
// skips unless its gate is set, so `go test ./...` alone never runs it. Running
// it here keeps the deferred sign-out and re-sign-in proof in npm run test:web,
// which CI and release run with Go and Playwright Chromium installed.
function runRealServerLeg() {
  return new Promise((resolve) => {
    execFile("go", ["test", "./internal/server", "-run", "^TestBrowserR54S03ReSignIn$", "-count=1", "-v", "-timeout=200s"], {
      cwd: path.join(__dirname, ".."), maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, POMODOROUGH_R54_S03_BROWSER: "1" }
    }, (error, stdout, stderr) => resolve({ error, output: stdout + stderr }));
  });
}

test("R54-S03 real server and Chromium revoke the signed-out session and keep the new one after re-sign-in", { timeout: 240000 }, async () => {
  const { error, output } = await runRealServerLeg();
  assert.equal(error, null, output);
  assert.doesNotMatch(output, /--- SKIP/, output);
  for (const scenario of scenarios) {
    assert.match(output, new RegExp(`--- PASS: TestBrowserR54S03ReSignIn/${scenario} \\(`), output);
  }
});
