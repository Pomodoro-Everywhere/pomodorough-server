package server

import (
	"fmt"
)

// S6: server ingestion tolerates clock skew with a corrective HLC tick.
// When incoming physical time is less than or equal to last observed,
// clamp forward to last observed plus one logical bump and continue
// processing instead of rejecting. Only malformed payloads (bad shape or
// missing fields) reject. Ordering stays (wallMs, counter).
//
// Authoritative tick lives in pomodorough-core/src/clock.rs tick_json;
// this helper mirrors that policy at the Go ingestion boundary without
// changing stored wire values.

// correctHLCTick mirrors core hlc.tick.v1 without I/O.
// Nil means a missing wire field and always rejects.
func correctHLCTick(localWall, localCounter, physicalNow, remoteWall, remoteCounter *int64) (int64, int64, error) {
	localWallMs, err := tickComponent("local wallMs", localWall)
	if err != nil {
		return 0, 0, err
	}
	localCount, err := tickComponent("local counter", localCounter)
	if err != nil {
		return 0, 0, err
	}
	physicalMs, err := tickComponent("physicalNowMs", physicalNow)
	if err != nil {
		return 0, 0, err
	}
	remote, err := tickRemote(remoteWall, remoteCounter)
	if err != nil {
		return 0, 0, err
	}
	wallMs := maxTickWall(localWallMs, physicalMs, remote)
	counter, err := tickCounter(localWallMs, localCount, wallMs, remote)
	if err != nil {
		return 0, 0, err
	}
	return wallMs, counter, nil
}

func tickComponent(name string, value *int64) (int64, error) {
	if value == nil {
		return 0, fmt.Errorf("invalid HLC tick: missing %s", name)
	}
	if *value < 0 || *value > maxSafeInteger {
		return 0, fmt.Errorf("invalid HLC tick: %s outside safe range", name)
	}
	return *value, nil
}

func tickRemote(wall, counter *int64) (*[2]int64, error) {
	if wall == nil && counter == nil {
		return nil, nil
	}
	if wall == nil || counter == nil {
		return nil, fmt.Errorf("invalid HLC tick: partial remote clock")
	}
	wallMs, err := tickComponent("remote wallMs", wall)
	if err != nil {
		return nil, err
	}
	count, err := tickComponent("remote counter", counter)
	if err != nil {
		return nil, err
	}
	return &[2]int64{wallMs, count}, nil
}

func maxTickWall(localWall, physicalNow int64, remote *[2]int64) int64 {
	wallMs := localWall
	if physicalNow > wallMs {
		wallMs = physicalNow
	}
	if remote != nil && remote[0] > wallMs {
		wallMs = remote[0]
	}
	return wallMs
}

func tickCounter(localWall, localCounter, wallMs int64, remote *[2]int64) (int64, error) {
	if remote != nil && wallMs == localWall && wallMs == remote[0] {
		return incrementTickCounter(maxInt64(localCounter, remote[1]))
	}
	if wallMs == localWall {
		return incrementTickCounter(localCounter)
	}
	if remote != nil && wallMs == remote[0] {
		return incrementTickCounter(remote[1])
	}
	return 0, nil
}

func incrementTickCounter(value int64) (int64, error) {
	if value < 0 || value >= maxSafeInteger {
		return 0, fmt.Errorf("invalid HLC tick: counter overflow")
	}
	return value + 1, nil
}

func maxInt64(left, right int64) int64 {
	if right > left {
		return right
	}
	return left
}
