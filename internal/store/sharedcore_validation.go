package store

import (
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

const (
	minimumDurationMs      = int64(60_000)
	maximumTimerDurationMs = int64(14_400_000)
	maximumDurationMs      = int64(10_800_000)
)

func validateCoreTimerResult(output coreTimerResult, commands []timer.Command) error {
	if !output.Canonical.present || output.History == nil || output.Sessions == nil || output.Outcomes == nil {
		return errors.New("missing required timer output field")
	}
	commandByID, timerIDs, err := timerCommandIndex(commands)
	if err != nil {
		return err
	}
	if err := validateTimerOutcomes(output.Outcomes, commandByID); err != nil {
		return err
	}
	sessions, err := validateCoreTimerSessions(output.Sessions, commandByID, timerIDs)
	if err != nil {
		return err
	}
	if err := validateCoreCanonical(output.Canonical.value, sessions, commandByID); err != nil {
		return err
	}
	return validateCoreHistory(output.History, sessions, commandByID)
}

func timerCommandIndex(commands []timer.Command) (map[string]timer.Command, map[string]struct{}, error) {
	byID := make(map[string]timer.Command, len(commands))
	timerIDs := make(map[string]struct{}, len(commands))
	for _, command := range commands {
		if command.ID == "" || command.TimerID == "" {
			return nil, nil, errors.New("timer input contains empty identifier")
		}
		if _, duplicate := byID[command.ID]; duplicate {
			return nil, nil, fmt.Errorf("duplicate timer command id %q", command.ID)
		}
		byID[command.ID] = command
		timerIDs[command.TimerID] = struct{}{}
	}
	return byID, timerIDs, nil
}

func validateTimerOutcomes(outcomes map[string]coreTimerOutcome, commands map[string]timer.Command) error {
	if len(outcomes) != len(commands) {
		return errors.New("timer outcomes do not cover input commands")
	}
	for commandID, outcome := range outcomes {
		if _, exists := commands[commandID]; !exists {
			return fmt.Errorf("timer outcome references unknown command %q", commandID)
		}
		if outcome.Outcome == nil || outcome.Reason == nil {
			return fmt.Errorf("timer outcome %q is missing required fields", commandID)
		}
		switch *outcome.Outcome {
		case "applied":
			if *outcome.Reason != "" {
				return fmt.Errorf("applied timer outcome %q has reason", commandID)
			}
		case "ignored", "rejected":
			if *outcome.Reason == "" {
				return fmt.Errorf("timer outcome %q is missing reason", commandID)
			}
		default:
			return fmt.Errorf("timer outcome %q has invalid type", commandID)
		}
	}
	return nil
}

func validateCoreTimerSessions(
	input []coreTimerSession,
	commands map[string]timer.Command,
	timerIDs map[string]struct{},
) (map[string]coreTimerSession, error) {
	sessions := make(map[string]coreTimerSession, len(input))
	previousID := ""
	for _, session := range input {
		if err := validateCoreTimerSession(session, commands, timerIDs); err != nil {
			return nil, err
		}
		if _, duplicate := sessions[session.TimerID]; duplicate {
			return nil, fmt.Errorf("duplicate timer session %q", session.TimerID)
		}
		if previousID != "" && session.TimerID <= previousID {
			return nil, errors.New("timer sessions are not strictly ordered")
		}
		sessions[session.TimerID] = session
		previousID = session.TimerID
	}
	for _, session := range input {
		if session.SupersededByTimerID != "" {
			if _, exists := sessions[session.SupersededByTimerID]; !exists {
				return nil, fmt.Errorf("timer session %q references missing superseding timer", session.TimerID)
			}
		}
	}
	return sessions, nil
}

func validateCoreTimerSession(
	session coreTimerSession,
	commands map[string]timer.Command,
	timerIDs map[string]struct{},
) error {
	if _, exists := timerIDs[session.TimerID]; session.TimerID == "" || !exists {
		return fmt.Errorf("timer session references unknown timer %q", session.TimerID)
	}
	if !validTimerPhase(session.Phase) || !validTimerStatus(session.Status) {
		return fmt.Errorf("timer session %q has invalid phase or status", session.TimerID)
	}
	if session.PlannedDurationMs < minimumDurationMs || session.PlannedDurationMs > maximumTimerDurationMs ||
		session.ElapsedAtAnchorMs < 0 || session.ElapsedAtAnchorMs > session.PlannedDurationMs {
		return fmt.Errorf("timer session %q has invalid duration", session.TimerID)
	}
	if _, err := parseRequiredCoreTime("timer anchor", session.AnchorAt); err != nil {
		return err
	}
	if _, err := parseRequiredCoreTime("timer start", session.StartedAt); err != nil {
		return err
	}
	if err := validateSessionTerminalFields(session); err != nil {
		return err
	}
	if err := validateCommandReference(session.LastCommandID, commands, "last timer command"); err != nil {
		return err
	}
	if session.TerminalCommandID != "" {
		if err := validateCommandReference(session.TerminalCommandID, commands, "terminal timer command"); err != nil {
			return err
		}
	}
	return validateCoreIntent(session.LastIntent, commands)
}

func validateSessionTerminalFields(session coreTimerSession) error {
	terminal := session.Status == "completed" || session.Status == "cancelled" || session.Status == "superseded"
	if terminal == (session.EndedAt == "") {
		return fmt.Errorf("timer session %q has inconsistent end timestamp", session.TimerID)
	}
	if session.EndedAt != "" {
		if _, err := parseRequiredCoreTime("timer end", session.EndedAt); err != nil {
			return err
		}
	}
	if session.Status == "superseded" {
		if session.SupersededByTimerID == "" || session.SupersededByTimerID == session.TimerID {
			return fmt.Errorf("timer session %q has invalid superseding timer", session.TimerID)
		}
	} else if session.SupersededByTimerID != "" {
		return fmt.Errorf("timer session %q unexpectedly names a superseding timer", session.TimerID)
	}
	if (session.Status == "cancelled" || session.Status == "superseded") && session.TerminalCommandID == "" {
		return fmt.Errorf("timer session %q is missing terminal command", session.TimerID)
	}
	return nil
}

func validateCommandReference(id string, commands map[string]timer.Command, label string) error {
	if id == "" {
		return fmt.Errorf("%s is empty", label)
	}
	if _, exists := commands[id]; !exists {
		return fmt.Errorf("%s %q is unknown", label, id)
	}
	return nil
}

func validateCoreIntent(intent *timer.Intent, commands map[string]timer.Command) error {
	if intent == nil {
		return nil
	}
	if intent.Type == "" {
		return errors.New("timer intent type is empty")
	}
	if err := validateCommandReference(intent.CommandID, commands, "timer intent command"); err != nil {
		return err
	}
	_, err := parseRequiredCoreTime("timer intent", intent.OccurredAt)
	return err
}

func validateCoreCanonical(
	canonical *timer.CanonicalTimer,
	sessions map[string]coreTimerSession,
	commands map[string]timer.Command,
) error {
	if canonical == nil {
		return nil
	}
	session, exists := sessions[canonical.ID]
	if canonical.ID == "" || !exists {
		return fmt.Errorf("canonical timer references unknown session %q", canonical.ID)
	}
	if !validTimerPhase(canonical.Phase) || !validTimerStatus(canonical.Status) {
		return errors.New("canonical timer has invalid phase or status")
	}
	if canonical.PlannedDurationMs < minimumDurationMs || canonical.PlannedDurationMs > maximumTimerDurationMs ||
		canonical.ElapsedAtAnchorMs < 0 || canonical.ElapsedAtAnchorMs > canonical.PlannedDurationMs {
		return errors.New("canonical timer has invalid duration")
	}
	if _, err := parseRequiredCoreTime("canonical timer anchor", canonical.AnchorAt); err != nil {
		return err
	}
	if err := validateCoreIntent(canonical.LastIntent, commands); err != nil {
		return err
	}
	if !canonicalMatchesSession(*canonical, session) {
		return errors.New("canonical timer is inconsistent with its session")
	}
	return nil
}

func canonicalMatchesSession(canonical timer.CanonicalTimer, session coreTimerSession) bool {
	return canonical.ID == session.TimerID && canonical.TaskID == session.TaskID &&
		canonical.Phase == session.Phase && canonical.Status == session.Status &&
		canonical.PlannedDurationMs == session.PlannedDurationMs &&
		canonical.ElapsedAtAnchorMs == session.ElapsedAtAnchorMs && coreTimesEqual(canonical.AnchorAt, session.AnchorAt) &&
		canonical.StartedByDeviceID == session.StartedByDeviceID && intentsEqual(canonical.LastIntent, session.LastIntent)
}

func validateCoreHistory(
	history []timer.HistoryItem,
	sessions map[string]coreTimerSession,
	commands map[string]timer.Command,
) error {
	ids := make(map[string]struct{}, len(history))
	var previous time.Time
	previousTimerID := ""
	for _, item := range history {
		endedAt, err := validateCoreHistoryItem(item, sessions, commands)
		if err != nil {
			return err
		}
		if _, duplicate := ids[item.ID]; item.ID == "" || duplicate {
			return fmt.Errorf("duplicate or empty timer history id %q", item.ID)
		}
		if !previous.IsZero() && (endedAt.After(previous) || endedAt.Equal(previous) && item.TimerID <= previousTimerID) {
			return errors.New("timer history is not strictly ordered")
		}
		ids[item.ID] = struct{}{}
		previous, previousTimerID = endedAt, item.TimerID
	}
	return nil
}

func validateCoreHistoryItem(
	item timer.HistoryItem,
	sessions map[string]coreTimerSession,
	commands map[string]timer.Command,
) (time.Time, error) {
	session, exists := sessions[item.TimerID]
	if item.TimerID == "" || !exists {
		return time.Time{}, fmt.Errorf("history references unknown timer %q", item.TimerID)
	}
	if item.Status != "completed" && item.Status != "cancelled" && item.Status != "superseded" {
		return time.Time{}, errors.New("timer history has non-terminal status")
	}
	endedAt, err := parseRequiredCoreTime("timer history end", item.EndedAt)
	if err != nil {
		return time.Time{}, err
	}
	if item.CommandID != "" {
		if err := validateCommandReference(item.CommandID, commands, "timer history command"); err != nil {
			return time.Time{}, err
		}
	}
	if !historyMatchesSession(item, session) {
		return time.Time{}, errors.New("timer history is inconsistent with its session")
	}
	return endedAt, validateHistoryCompletion(item)
}

func validateHistoryCompletion(item timer.HistoryItem) error {
	if item.Status == "completed" {
		completedAt, err := parseRequiredCoreTime("timer completion", item.CompletedAt)
		if err != nil {
			return err
		}
		endedAt, _ := time.Parse(time.RFC3339Nano, item.EndedAt)
		if !completedAt.Equal(endedAt) {
			return errors.New("timer completion and end timestamps differ")
		}
	} else if item.CompletedAt != "" {
		return errors.New("non-completed timer has completion timestamp")
	}
	return nil
}

func historyMatchesSession(item timer.HistoryItem, session coreTimerSession) bool {
	return item.TimerID == session.TimerID && item.TaskID == session.TaskID && item.CommandID == session.TerminalCommandID &&
		item.Phase == session.Phase && item.Status == session.Status &&
		item.PlannedDurationMs == session.PlannedDurationMs && coreTimesEqual(item.EndedAt, session.EndedAt)
}

func intentsEqual(left, right *timer.Intent) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Type == right.Type && left.CommandID == right.CommandID && coreTimesEqual(left.OccurredAt, right.OccurredAt)
}

func coreTimesEqual(left, right string) bool {
	leftTime, leftErr := time.Parse(time.RFC3339Nano, left)
	rightTime, rightErr := time.Parse(time.RFC3339Nano, right)
	return leftErr == nil && rightErr == nil && leftTime.Equal(rightTime)
}

func parseRequiredCoreTime(label, value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, fmt.Errorf("%s timestamp is empty", label)
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse shared %s: %w", label, err)
	}
	return parsed, nil
}

func validTimerPhase(phase string) bool {
	return phase == "focus" || phase == "short_break" || phase == "long_break"
}

func validTimerStatus(status string) bool {
	return status == "running" || status == "paused" || status == "completed" ||
		status == "cancelled" || status == "superseded"
}

func taskResultFromCore(output coreTaskResult, operations []task.Operation) ([]task.Task, map[string]string, error) {
	if output.Tasks == nil || output.WinningOperationIDs == nil {
		return nil, nil, errors.New("shared task output is missing required fields")
	}
	operationTaskIDs := make(map[string]string, len(operations))
	for _, operation := range operations {
		operationTaskIDs[operation.ID] = operation.TaskID
	}
	if err := validateTaskWinners(output.WinningOperationIDs, operationTaskIDs); err != nil {
		return nil, nil, err
	}
	if err := validateCoreTasks(output.Tasks, output.WinningOperationIDs); err != nil {
		return nil, nil, err
	}
	return output.Tasks, output.WinningOperationIDs, nil
}

func validateTaskWinners(winners, operationTaskIDs map[string]string) error {
	for taskID, operationID := range winners {
		if taskID == "" || operationID == "" || operationTaskIDs[operationID] != taskID {
			return fmt.Errorf("task winner %q references inconsistent operation %q", taskID, operationID)
		}
	}
	return nil
}

func validateCoreTasks(tasks []task.Task, winners map[string]string) error {
	seen := make(map[string]struct{}, len(tasks))
	for index, current := range tasks {
		if current.ID == "" || current.Title == "" || !utf8.ValidString(current.Title) {
			return errors.New("shared task output contains invalid task")
		}
		if _, duplicate := seen[current.ID]; duplicate {
			return fmt.Errorf("shared task output duplicates task %q", current.ID)
		}
		if _, exists := winners[current.ID]; !exists {
			return fmt.Errorf("shared task %q has no winning operation", current.ID)
		}
		if index > 0 && !taskBefore(tasks[index-1], current) {
			return errors.New("shared tasks are not strictly ordered")
		}
		seen[current.ID] = struct{}{}
	}
	return nil
}

func taskBefore(left, right task.Task) bool {
	return left.Title < right.Title || left.Title == right.Title && left.ID < right.ID
}

func durationResultFromCore(
	output coreDurationResult,
	operations []DurationOperation,
) (DurationsMs, map[string]struct{}, error) {
	if err := validateCoreDurations(output, operations); err != nil {
		return DurationsMs{}, nil, err
	}
	winners := make(map[string]struct{}, len(output.WinningOperationIDs))
	for _, id := range output.WinningOperationIDs {
		winners[id] = struct{}{}
	}
	result := DurationsMs{
		Focus:      output.DurationsMs["focus"],
		ShortBreak: output.DurationsMs["short_break"],
		LongBreak:  output.DurationsMs["long_break"],
	}
	return result, winners, nil
}

func validateCoreDurations(output coreDurationResult, operations []DurationOperation) error {
	if output.DurationsMs == nil || output.WinningOperationIDs == nil || len(output.DurationsMs) != 3 {
		return errors.New("shared duration output is missing required phases")
	}
	for _, phase := range []string{"focus", "short_break", "long_break"} {
		value, exists := output.DurationsMs[phase]
		if !exists || value < minimumDurationMs || value > maximumDurationMs || value%minimumDurationMs != 0 {
			return fmt.Errorf("shared duration for %q is invalid", phase)
		}
	}
	operationPhases := make(map[string]string, len(operations))
	for _, operation := range operations {
		operationPhases[operation.ID] = operation.Phase
	}
	for phase, operationID := range output.WinningOperationIDs {
		if !validTimerPhase(phase) || operationID == "" || operationPhases[operationID] != phase {
			return fmt.Errorf("duration winner %q references inconsistent operation %q", phase, operationID)
		}
	}
	return nil
}

func autoStartResultFromCore(output coreAutoStartResult, operations []AutoStartOperation) (bool, string, error) {
	if output.AutoStartBreaks == nil || !output.WinningOperationID.present {
		return false, "", errors.New("shared auto-start output is missing required fields")
	}
	winner := nullableCoreString(output.WinningOperationID)
	if winner != "" && !autoStartOperationExists(operations, winner) {
		return false, "", fmt.Errorf("auto-start winner references unknown operation %q", winner)
	}
	return *output.AutoStartBreaks, winner, nil
}

func autoStartOperationExists(operations []AutoStartOperation, id string) bool {
	for _, operation := range operations {
		if operation.ID == id {
			return true
		}
	}
	return false
}

func selectedTaskResultFromCore(
	output coreSelectedTaskResult,
	operations []SelectedTaskOperation,
	tasks []task.Task,
) (*string, string, error) {
	if !output.SelectedTaskID.present || !output.WinningOperationID.present {
		return nil, "", errors.New("shared selected-task output is missing required fields")
	}
	winner := nullableCoreString(output.WinningOperationID)
	if winner != "" && !selectedTaskOperationExists(operations, winner) {
		return nil, "", fmt.Errorf("selected-task winner references unknown operation %q", winner)
	}
	if output.SelectedTaskID.value != nil && !activeTaskExists(tasks, *output.SelectedTaskID.value) {
		return nil, "", fmt.Errorf("selected task %q is not active", *output.SelectedTaskID.value)
	}
	return output.SelectedTaskID.value, winner, nil
}

func selectedTaskOperationExists(operations []SelectedTaskOperation, id string) bool {
	for _, operation := range operations {
		if operation.ID == id {
			return true
		}
	}
	return false
}

func activeTaskExists(tasks []task.Task, id string) bool {
	for _, current := range tasks {
		if current.ID == id {
			return true
		}
	}
	return false
}

func nullableCoreString(value coreNullable[string]) string {
	if value.value == nil {
		return ""
	}
	return *value.value
}
