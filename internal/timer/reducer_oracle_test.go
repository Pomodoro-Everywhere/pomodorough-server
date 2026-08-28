package timer

import "time"

// Reduce is the historical Go policy oracle retained only for compatibility tests.
func Reduce(input []Command, now time.Time) Result {
	state := newReductionState(len(input))
	for _, command := range sortedCommands(input) {
		state.apply(command)
	}
	return state.result(now)
}
