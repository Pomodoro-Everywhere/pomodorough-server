package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

func TestHLCStreamExactPageBoundariesPreserveEarlyMaximum(t *testing.T) {
	cases := []struct {
		count int
		pages []int
	}{
		{0, []int{0}}, {1, []int{1}}, {9999, []int{9999}}, {10000, []int{10000}},
		{10001, []int{10000, 2}}, {19999, []int{10000, 10000}},
		{20000, []int{10000, 10000, 2}}, {20001, []int{10000, 10000, 3}},
	}
	for _, test := range cases {
		t.Run(fmt.Sprint(test.count), func(t *testing.T) {
			var pages []int
			call := func(ctx context.Context, name string, input, output any) error {
				pages = append(pages, len(input.(coreHLCHeadInput).Observed))
				return callAccountSharedCore(ctx, name, input, output)
			}
			sequence := func(yield func(coreHLC) bool) {
				for index := 0; index < test.count; index++ {
					clock := coreHLC{WallMs: 200, Counter: 1}
					if index == 0 {
						clock.Counter = 99
					}
					if !yield(clock) {
						return
					}
				}
			}
			head, err := hlcHeadSequenceWithCore(context.Background(), call, 100, sequence)
			expected := coreHLC{WallMs: 200, Counter: 99}
			if test.count == 0 {
				expected = coreHLC{WallMs: 100}
			}
			if err != nil || head != expected || !reflect.DeepEqual(pages, test.pages) {
				t.Fatalf("head=%#v, pages=%v, err=%v", head, pages, err)
			}
		})
	}
}

func TestHLCStreamIncludesMaximumFromEveryDomainAndRequest(t *testing.T) {
	for domain := 0; domain < 10; domain++ {
		t.Run(fmt.Sprint(domain), func(t *testing.T) {
			reduction, request := completeHLCInputs()
			padding := make([]timer.Command, 10000)
			for index := range padding {
				padding[index].HLCWallMs = 1
			}
			reduction.commands = append(padding, reduction.commands...)
			clocks := domainClockPointers(&reduction, &request)
			*clocks[domain][0], *clocks[domain][1] = 999, 77
			head, err := serverHLCFromReductionWithCore(context.Background(), callAccountSharedCore,
				reduction, time.UnixMilli(100), &request)
			if err != nil || head != (coreHLC{WallMs: 999, Counter: 77}) {
				t.Fatalf("domain %d: head=%#v, err=%v", domain, head, err)
			}
		})
	}
}

func domainClockPointers(r *accountReduction, q *SyncRequest) [][2]*int64 {
	command := &r.commands[len(r.commands)-1]
	return [][2]*int64{
		{&command.HLCWallMs, &command.HLCCounter},
		{&r.taskOperations[0].HLCWallMs, &r.taskOperations[0].HLCCounter},
		{&r.durationOperations[0].HLCWallMs, &r.durationOperations[0].HLCCounter},
		{&r.autoStartOperations[0].HLCWallMs, &r.autoStartOperations[0].HLCCounter},
		{&r.selectedTaskOperations[0].HLCWallMs, &r.selectedTaskOperations[0].HLCCounter},
		{&q.Commands[0].HLCWallMs, &q.Commands[0].HLCCounter},
		{&q.TaskOperations[0].HLCWallMs, &q.TaskOperations[0].HLCCounter},
		{&q.DurationOperations[0].HLCWallMs, &q.DurationOperations[0].HLCCounter},
		{&q.AutoStartOperations[0].HLCWallMs, &q.AutoStartOperations[0].HLCCounter},
		{&q.SelectedTaskOperations[0].HLCWallMs, &q.SelectedTaskOperations[0].HLCCounter},
	}
}

func TestHLCStreamIntermediateFailureStopsConsumptionAndDiscardsPartialHead(t *testing.T) {
	injected := errors.New("intermediate Core failure")
	calls, consumed := 0, 0
	call := func(ctx context.Context, name string, input, output any) error {
		calls++
		if calls == 2 {
			return injected
		}
		return callAccountSharedCore(ctx, name, input, output)
	}
	sequence := func(yield func(coreHLC) bool) {
		for index := 0; index < 25000; index++ {
			consumed++
			if !yield(coreHLC{WallMs: 200, Counter: int64(index)}) {
				return
			}
		}
	}
	head, err := hlcHeadSequenceWithCore(context.Background(), call, 100, sequence)
	if !errors.Is(err, injected) || head != (coreHLC{}) || calls != 2 || consumed != 20000 {
		t.Fatalf("head=%#v, calls=%d, consumed=%d, err=%v", head, calls, consumed, err)
	}
}
