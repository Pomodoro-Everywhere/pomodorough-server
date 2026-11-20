package store

import (
	"sort"

	"pomodorough/internal/task"
)

// Historical Go reducers remain test-only compatibility fixtures. SharedCore owns production policy.
//
// reduceTasks decides which tasks survive, not where they are listed. The task
// list order belongs to SharedCore, so the result is in tasksByID order and
// callers compare it with tasksByID of the SharedCore or fixture task list.
func reduceTasks(operations []task.Operation) ([]task.Task, map[string]string) {
	winners := make(map[string]task.Operation)
	for _, operation := range operations {
		winners[operation.TaskID] = operation
	}
	tasks := make([]task.Task, 0, len(winners))
	winningIDs := make(map[string]string, len(winners))
	for taskID, operation := range winners {
		winningIDs[taskID] = operation.ID
		if operation.Type == "upsert" {
			tasks = append(tasks, task.Task{ID: taskID, Title: operation.Title})
		}
	}
	return tasksByID(tasks), winningIDs
}

// tasksByID returns a copy in task ID order, so two task lists can be compared
// as sets without stating a task list order.
func tasksByID(tasks []task.Task) []task.Task {
	ordered := append([]task.Task{}, tasks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	return ordered
}

func reduceDurations(operations []DurationOperation) (DurationsMs, map[string]struct{}) {
	durations := DurationsMs{Focus: 1_500_000, ShortBreak: 300_000, LongBreak: 900_000}
	winnersByPhase := make(map[string]string, 3)
	for _, operation := range operations {
		winnersByPhase[operation.Phase] = operation.ID
		switch operation.Phase {
		case "focus":
			durations.Focus = operation.DurationMs
		case "short_break":
			durations.ShortBreak = operation.DurationMs
		case "long_break":
			durations.LongBreak = operation.DurationMs
		}
	}
	winners := make(map[string]struct{}, len(winnersByPhase))
	for _, operationID := range winnersByPhase {
		winners[operationID] = struct{}{}
	}
	return durations, winners
}

func reduceAutoStart(operations []AutoStartOperation) (bool, string) {
	if len(operations) == 0 {
		return false, ""
	}
	winner := operations[len(operations)-1]
	return winner.Enabled, winner.ID
}

func reduceSelectedTask(operations []SelectedTaskOperation, tasks []task.Task) (*string, string) {
	if len(operations) == 0 {
		return nil, ""
	}
	winner := operations[len(operations)-1]
	if winner.TaskID == nil {
		return nil, winner.ID
	}
	for _, current := range tasks {
		if current.ID == *winner.TaskID {
			selectedTaskID := *winner.TaskID
			return &selectedTaskID, winner.ID
		}
	}
	return nil, winner.ID
}
