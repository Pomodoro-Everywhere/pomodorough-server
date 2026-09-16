package server

import (
	"strings"
	"testing"
)

func tickPointer(value int64) *int64 { return &value }

func assertTick(t *testing.T, name string, wall, counter int64, err error, wantWall, wantCounter int64) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: unexpected error: %v", name, err)
	}
	if wall != wantWall || counter != wantCounter {
		t.Fatalf("%s: got (%d,%d), want (%d,%d)", name, wall, counter, wantWall, wantCounter)
	}
}

func TestCorrectHLCTickBackwardCorrectedNotRejected(t *testing.T) {
	wall, counter, err := correctHLCTick(tickPointer(100), tickPointer(2), tickPointer(99), nil, nil)
	assertTick(t, "backward physical", wall, counter, err, 100, 3)
}

func TestCorrectHLCTickEqualBumpsLogical(t *testing.T) {
	wall, counter, err := correctHLCTick(tickPointer(100), tickPointer(2), tickPointer(100), nil, nil)
	assertTick(t, "equal physical", wall, counter, err, 100, 3)
}

func TestCorrectHLCTickMatchesCorePolicy(t *testing.T) {
	cases := []struct {
		name                              string
		localWall, localCounter, physical int64
		remoteWall, remoteCounter         *int64
		wantWall, wantCounter             int64
	}{
		{"future resets", 100, 2, 101, nil, nil, 101, 0},
		{"remote tie takes max", 100, 2, 99, tickPointer(100), tickPointer(7), 100, 8},
		{"remote future wins", 100, 2, 110, tickPointer(120), tickPointer(4), 120, 5},
		{"local future wins", 120, 4, 110, tickPointer(100), tickPointer(9), 120, 5},
		{"physical future resets", 100, 2, 120, tickPointer(110), tickPointer(9), 120, 0},
	}
	for _, test := range cases {
		wall, counter, err := correctHLCTick(tickPointer(test.localWall), tickPointer(test.localCounter), tickPointer(test.physical), test.remoteWall, test.remoteCounter)
		assertTick(t, test.name, wall, counter, err, test.wantWall, test.wantCounter)
	}
}

func TestCorrectHLCTickPreservesOrdering(t *testing.T) {
	wall, counter, err := correctHLCTick(tickPointer(100), tickPointer(2), tickPointer(99), tickPointer(100), tickPointer(7))
	if err != nil {
		t.Fatal(err)
	}
	if !(wall > 100 || (wall == 100 && counter > 2)) {
		t.Fatalf("output (%d,%d) does not follow local (100,2)", wall, counter)
	}
	if !(wall > 100 || (wall == 100 && counter > 7)) {
		t.Fatalf("output (%d,%d) does not follow remote (100,7)", wall, counter)
	}
}

func TestCorrectHLCTickMalformedStillInvalid(t *testing.T) {
	good := int64(100)
	badNegative := int64(-1)
	badUnsafe := maxSafeInteger + 1
	exhausted := maxSafeInteger
	cases := []struct {
		name                              string
		localWall, localCounter, physical *int64
		remoteWall, remoteCounter         *int64
	}{
		{"missing local wall", nil, &good, &good, nil, nil},
		{"missing local counter", &good, nil, &good, nil, nil},
		{"missing physical", &good, &good, nil, nil, nil},
		{"negative local wall", &badNegative, &good, &good, nil, nil},
		{"negative counter", &good, &badNegative, &good, nil, nil},
		{"unsafe wall", &badUnsafe, &good, &good, nil, nil},
		{"partial remote", &good, &good, &good, &good, nil},
		{"negative remote", &good, &good, &good, &badNegative, &good},
		{"counter exhaustion", &good, &exhausted, &good, nil, nil},
	}
	for _, test := range cases {
		_, _, err := correctHLCTick(test.localWall, test.localCounter, test.physical, test.remoteWall, test.remoteCounter)
		if err == nil || !strings.Contains(err.Error(), "invalid HLC tick") {
			t.Fatalf("%s: err = %v, want invalid HLC tick", test.name, err)
		}
	}
}
