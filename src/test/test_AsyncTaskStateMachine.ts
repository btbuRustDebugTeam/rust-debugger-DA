/**
 * Comprehensive unit tests for AsyncTaskStateMachine.
 * Covers:
 *   1. All 6 task states
 *   2. Every state×event transition (cross-product)
 *   3. The full coroutine lifecycle (spawn → yield → block → wake → exit)
 *   4. Cross-CPU wake race (Blocking → Waked → Running)
 *   5. Idempotency and immutability
 *
 * Run with:  node out/test/test_AsyncTaskStateMachine.js
 */

import {
    AsyncTaskMachine,
    AsyncTaskStates,
    AsyncTaskEvents,
    AsyncTaskActions,
    AsyncTaskState,
    AsyncTaskEvent,
    asyncTaskTransition,
    asyncOSStateFromNumber,
    asyncOSStateName,
    KTaskTracker,
    KTaskStates,
    AsyncTaskAction,
} from '../AsyncTaskStateMachine';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

function assertEq(actual: any, expected: any, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; }
    else { failed++; console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}

function assertActions(actions: AsyncTaskAction[], expectedTypes: AsyncTaskActions[], label: string): void {
    const actualTypes = actions.map(a => a.type);
    assertEq(actualTypes, expectedTypes, label);
}

function transition(state: AsyncTaskStates, event: AsyncTaskEvents): [AsyncTaskState, AsyncTaskAction[]] {
    return asyncTaskTransition(AsyncTaskMachine, new AsyncTaskState(state), new AsyncTaskEvent(event));
}

// ===========================================================================
// 1. Initial state and numeric mapping
// ===========================================================================
{
    assertEq(AsyncTaskMachine.initial, AsyncTaskStates.Running, 'initial state is Running');
    assertEq(asyncOSStateFromNumber(0), AsyncTaskStates.Running, 'numeric 0 → Running');
    assertEq(asyncOSStateFromNumber(4), AsyncTaskStates.Blocked, 'numeric 4 → Blocked');
    assertEq(asyncOSStateFromNumber(5), AsyncTaskStates.Exited, 'numeric 5 → Exited');
    assertEq(asyncOSStateFromNumber(99), undefined, 'numeric 99 → undefined');
    assertEq(asyncOSStateName(AsyncTaskStates.Blocking), 'Blocking', 'state name: Blocking');
}

// ===========================================================================
// 2. Complete transition matrix: Running × all events
// ===========================================================================
{
    // Running + POLL_PENDING_YIELD → Runable (cooperative yield)
    const [s1, a1] = transition(AsyncTaskStates.Running, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(s1.status, AsyncTaskStates.Runable, 'Running+POLL_PENDING_YIELD → Runable');
    assertActions(a1, [AsyncTaskActions.ENQUEUE_TASK], 'Running+POLL_PENDING_YIELD actions');

    // Running + POLL_READY → Exited (task finished)
    const [s2, a2] = transition(AsyncTaskStates.Running, AsyncTaskEvents.POLL_READY);
    assertEq(s2.status, AsyncTaskStates.Exited, 'Running+POLL_READY → Exited');
    assertActions(a2, [AsyncTaskActions.EXIT_TASK, AsyncTaskActions.DROP_TASK],
        'Running+POLL_READY actions');

    // Running + WAKEN → Running (no-op, already running)
    const [s3, a3] = transition(AsyncTaskStates.Running, AsyncTaskEvents.WAKEN);
    assertEq(s3.status, AsyncTaskStates.Running, 'Running+WAKEN → Running');
    assertEq(a3.length, 0, 'Running+WAKEN → empty actions');

    // Running + SPAWN → Running (no-op)
    const [s4, a4] = transition(AsyncTaskStates.Running, AsyncTaskEvents.SPAWN);
    assertEq(s4.status, AsyncTaskStates.Running, 'Running+SPAWN → Running');

    // Running + SCHEDULE → Running (no-op)
    const [s5, a5] = transition(AsyncTaskStates.Running, AsyncTaskEvents.SCHEDULE);
    assertEq(s5.status, AsyncTaskStates.Running, 'Running+SCHEDULE → Running');
}

// ===========================================================================
// 3. Complete transition matrix: Runable × all events
// ===========================================================================
{
    // Runable + SCHEDULE → Running (picked by scheduler)
    const [s1, a1] = transition(AsyncTaskStates.Runable, AsyncTaskEvents.SCHEDULE);
    assertEq(s1.status, AsyncTaskStates.Running, 'Runable+SCHEDULE → Running');
    assertEq(a1.length, 0, 'Runable+SCHEDULE → empty actions');

    // Runable + WAKEN → Runable (already in ready queue, no-op)
    const [s2, a2] = transition(AsyncTaskStates.Runable, AsyncTaskEvents.WAKEN);
    assertEq(s2.status, AsyncTaskStates.Runable, 'Runable+WAKEN → Runable');

    // Runable should not receive poll events (not on CPU)
    // Undefined transitions return same state + empty actions
    const [s3, a3] = transition(AsyncTaskStates.Runable, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(s3.status, AsyncTaskStates.Runable, 'Runable+POLL_PENDING_YIELD → Runable (undefined)');
    assertEq(a3.length, 0, 'Runable+POLL_PENDING_YIELD → empty actions');
}

// ===========================================================================
// 4. Complete transition matrix: Blocking × all events
// ===========================================================================
{
    // Blocking + POLL_PENDING_BLOCK → Blocked (standard block path)
    const [s1, a1] = transition(AsyncTaskStates.Blocking, AsyncTaskEvents.POLL_PENDING_BLOCK);
    assertEq(s1.status, AsyncTaskStates.Blocked, 'Blocking+POLL_PENDING_BLOCK → Blocked');
    assertActions(a1, [AsyncTaskActions.CLEAN_NO_DROP], 'Blocking+POLL_PENDING_BLOCK actions');

    // Blocking + WAKEN → Waked (cross-CPU wake during yield window!)
    const [s2, a2] = transition(AsyncTaskStates.Blocking, AsyncTaskEvents.WAKEN);
    assertEq(s2.status, AsyncTaskStates.Waked, 'Blocking+WAKEN → Waked (cross-CPU race)');
    assertActions(a2, [AsyncTaskActions.CONTINUE_EXECUTING], 'Blocking+WAKEN actions');

    // Blocking + POLL_READY → Exited (finished before fully blocking)
    const [s3, a3] = transition(AsyncTaskStates.Blocking, AsyncTaskEvents.POLL_READY);
    assertEq(s3.status, AsyncTaskStates.Exited, 'Blocking+POLL_READY → Exited');
}

// ===========================================================================
// 5. Complete transition matrix: Waked × all events
// ===========================================================================
{
    // Waked + POLL_PENDING_WAKED → Running (continues execution)
    const [s1, a1] = transition(AsyncTaskStates.Waked, AsyncTaskEvents.POLL_PENDING_WAKED);
    assertEq(s1.status, AsyncTaskStates.Running, 'Waked+POLL_PENDING_WAKED → Running');
    assertActions(a1, [AsyncTaskActions.CONTINUE_EXECUTING], 'Waked+POLL_PENDING_WAKED actions');

    // Waked + POLL_READY → Exited
    const [s2, a2] = transition(AsyncTaskStates.Waked, AsyncTaskEvents.POLL_READY);
    assertEq(s2.status, AsyncTaskStates.Exited, 'Waked+POLL_READY → Exited');
}

// ===========================================================================
// 6. Complete transition matrix: Blocked × all events
// ===========================================================================
{
    // Blocked + WAKEN → Runable (move from wait queue to ready queue)
    const [s1, a1] = transition(AsyncTaskStates.Blocked, AsyncTaskEvents.WAKEN);
    assertEq(s1.status, AsyncTaskStates.Runable, 'Blocked+WAKEN → Runable');
    assertActions(a1, [AsyncTaskActions.WAKE_AND_ENQUEUE], 'Blocked+WAKEN actions');
}

// ===========================================================================
// 7. Complete transition matrix: Exited × all events
// ===========================================================================
{
    // Exited + WAKEN → Exited (panic-prevention: cannot wake exited task)
    const [s1, a1] = transition(AsyncTaskStates.Exited, AsyncTaskEvents.WAKEN);
    assertEq(s1.status, AsyncTaskStates.Exited, 'Exited+WAKEN → Exited (no-op, prevents panic)');
    assertEq(a1.length, 0, 'Exited+WAKEN → empty actions');
}

// ===========================================================================
// 8. Full lifecycle: spawn → yield → schedule → block → wake → exit
// ===========================================================================
{
    let state = new AsyncTaskState(AsyncTaskStates.Runable);

    // Scheduler picks task
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(state.status, AsyncTaskStates.Running, 'lifecycle-1: picked by scheduler');

    // Task yields cooperatively
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_YIELD));
    assertEq(state.status, AsyncTaskStates.Runable, 'lifecycle-2: yielded');

    // Picked again
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(state.status, AsyncTaskStates.Running, 'lifecycle-3: picked again');

    // Task blocks waiting for Mutex
    // (User code does: set_state(Blocking) → return Poll::Pending)
    state.status = AsyncTaskStates.Blocking;
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_BLOCK));
    assertEq(state.status, AsyncTaskStates.Blocked, 'lifecycle-4: blocked');

    // Another task releases Mutex → waker.wake() → wakeup_task()
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(state.status, AsyncTaskStates.Runable, 'lifecycle-5: woken');

    // Scheduler picks again
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(state.status, AsyncTaskStates.Running, 'lifecycle-6: running again');

    // Task finishes
    [state] = asyncTaskTransition(AsyncTaskMachine, state, new AsyncTaskEvent(AsyncTaskEvents.POLL_READY));
    assertEq(state.status, AsyncTaskStates.Exited, 'lifecycle-7: exited');
}

// ===========================================================================
// 9. Cross-CPU wake race: Blocking → Waked → Running
//    This is the core async-os SMP race scenario from wakeup_task()
// ===========================================================================
{
    // Task A is in Blocking state on CPU 0, about to yield.
    // Task B on CPU 1 releases a lock and calls waker.wake() on Task A.
    let stateA = new AsyncTaskState(AsyncTaskStates.Blocking);

    // wakeup_task sees Blocking → changes to Waked
    [stateA] = asyncTaskTransition(AsyncTaskMachine, stateA,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(stateA.status, AsyncTaskStates.Waked, 'SMP-race-1: wake during Blocking → Waked');

    // Task A's poll returns Pending, but state is Waked → continues as Running
    [stateA] = asyncTaskTransition(AsyncTaskMachine, stateA,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_WAKED));
    assertEq(stateA.status, AsyncTaskStates.Running, 'SMP-race-2: Waked poll → Running (no yield!)');
}

// ===========================================================================
// 10. Mutex contention pattern (coroutine_test scenario)
// ===========================================================================
{
    const mainTask = new AsyncTaskState(AsyncTaskStates.Running);
    const spawnedTask = new AsyncTaskState(AsyncTaskStates.Runable);

    // Main locks Mutex → success
    assertEq(mainTask.status, AsyncTaskStates.Running, 'mutex-1: main holds lock');

    // Spawned starts, tries to lock → blocks
    [spawnedTask.status] = [AsyncTaskStates.Blocking];
    const [s2] = asyncTaskTransition(AsyncTaskMachine, spawnedTask,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_BLOCK));
    assertEq(s2.status, AsyncTaskStates.Blocked, 'mutex-2: spawned blocked on lock');

    // Main unlocks → wakes spawned
    const [s3] = asyncTaskTransition(AsyncTaskMachine, s2,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(s3.status, AsyncTaskStates.Runable, 'mutex-3: spawned woken');

    // Spawned scheduled
    const [s4] = asyncTaskTransition(AsyncTaskMachine, s3,
        new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(s4.status, AsyncTaskStates.Running, 'mutex-4: spawned running');

    // Spawned finishes
    const [s5] = asyncTaskTransition(AsyncTaskMachine, s4,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_READY));
    assertEq(s5.status, AsyncTaskStates.Exited, 'mutex-5: spawned exited');

    // Main finishes
    const [s6] = asyncTaskTransition(AsyncTaskMachine, mainTask,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_READY));
    assertEq(s6.status, AsyncTaskStates.Exited, 'mutex-6: main exited');
}

// ===========================================================================
// 11. Sleep / timer wakeup pattern
// ===========================================================================
{
    const task = new AsyncTaskState(AsyncTaskStates.Running);

    // Task calls sleep(1s)
    task.status = AsyncTaskStates.Blocking;
    const [s1] = asyncTaskTransition(AsyncTaskMachine, task,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_BLOCK));
    assertEq(s1.status, AsyncTaskStates.Blocked, 'sleep-1: blocked');

    // Timer interrupt fires → waker.wake()
    const [s2] = asyncTaskTransition(AsyncTaskMachine, s1,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(s2.status, AsyncTaskStates.Runable, 'sleep-2: timer woke task');

    // Scheduler picks task
    const [s3] = asyncTaskTransition(AsyncTaskMachine, s2,
        new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(s3.status, AsyncTaskStates.Running, 'sleep-3: running again');
}

// ===========================================================================
// 12. spawn + join pattern (parent waits for child)
// ===========================================================================
{
    const child = new AsyncTaskState(AsyncTaskStates.Runable);
    const parent = new AsyncTaskState(AsyncTaskStates.Running);

    // Child starts running
    [child.status] = [AsyncTaskStates.Running];

    // Parent calls join(child) → sets state to Blocking, registers waker
    parent.status = AsyncTaskStates.Blocking;
    const [p1] = asyncTaskTransition(AsyncTaskMachine, parent,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_BLOCK));
    assertEq(p1.status, AsyncTaskStates.Blocked, 'join-1: parent blocked on join');

    // Child finishes → notify_waker_for_exit → wakes parent
    const [c1] = asyncTaskTransition(AsyncTaskMachine, child,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_READY));
    assertEq(c1.status, AsyncTaskStates.Exited, 'join-2: child exited');

    const [p2] = asyncTaskTransition(AsyncTaskMachine, p1,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(p2.status, AsyncTaskStates.Runable, 'join-3: parent woken');

    // Parent scheduled → gets child's exit code
    const [p3] = asyncTaskTransition(AsyncTaskMachine, p2,
        new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
    assertEq(p3.status, AsyncTaskStates.Running, 'join-4: parent running, gets exit code');
}

// ===========================================================================
// 13. Every defined transition returns an array (Fix #5 pattern)
// ===========================================================================
{
    const allStates = [
        AsyncTaskStates.Running, AsyncTaskStates.Runable,
        AsyncTaskStates.Blocking, AsyncTaskStates.Waked,
        AsyncTaskStates.Blocked, AsyncTaskStates.Exited,
    ];
    const allEvents = [
        AsyncTaskEvents.POLL_PENDING_YIELD, AsyncTaskEvents.POLL_PENDING_BLOCK,
        AsyncTaskEvents.POLL_PENDING_WAKED, AsyncTaskEvents.POLL_READY,
        AsyncTaskEvents.WAKEN, AsyncTaskEvents.SPAWN, AsyncTaskEvents.SCHEDULE,
    ];
    for (const st of allStates) {
        for (const ev of allEvents) {
            const [, actions] = transition(st, ev);
            assert(Array.isArray(actions),
                `actions is always array: state=${AsyncTaskStates[st]}, event=${AsyncTaskEvents[ev]}`);
        }
    }
}

// ===========================================================================
// 14. Immutability: asyncTaskTransition does not mutate the original state
// ===========================================================================
{
    const original = new AsyncTaskState(AsyncTaskStates.Blocking);
    const [next] = asyncTaskTransition(AsyncTaskMachine, original,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_BLOCK));
    assertEq(original.status, AsyncTaskStates.Blocking, 'original state not mutated');
    assertEq(next.status, AsyncTaskStates.Blocked, 'returned state has new status');
}

// ===========================================================================
// 15. Idempotency: repeated events don't cause state explosion
// ===========================================================================
{
    // 10 consecutive YIELDs without SCHEDULE in between:
    // First YIELD: Running → Runable. Remaining 9 YIELDs on Runable are
    // undefined transitions → stay Runable (no state explosion).
    let state = new AsyncTaskState(AsyncTaskStates.Running);
    for (let i = 0; i < 10; i++) {
        [state] = asyncTaskTransition(AsyncTaskMachine, state,
            new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_YIELD));
    }
    assertEq(state.status, AsyncTaskStates.Runable, 'idempotent: 10 consecutive yields → Runable');

    // 10 full YIELD+SCHEDULE cycles: Runable→Running→Runable→...
    // Each cycle: Running+YIELD→Runable, Runable+SCHEDULE→Running.
    // After 10 cycles, ends at Running (last SCHEDULE).
    state = new AsyncTaskState(AsyncTaskStates.Running);
    for (let i = 0; i < 10; i++) {
        [state] = asyncTaskTransition(AsyncTaskMachine, state,
            new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_YIELD));
        assertEq(state.status, AsyncTaskStates.Runable, `yield cycle ${i}: → Runable`);
        [state] = asyncTaskTransition(AsyncTaskMachine, state,
            new AsyncTaskEvent(AsyncTaskEvents.SCHEDULE));
        assertEq(state.status, AsyncTaskStates.Running, `schedule cycle ${i}: → Running`);
    }
    assertEq(state.status, AsyncTaskStates.Running, '10 full yield+schedule cycles → Running');

    // 10 WAKENs on a Blocked task → stays Runable after first, no-ops after
    state = new AsyncTaskState(AsyncTaskStates.Blocked);
    [state] = asyncTaskTransition(AsyncTaskMachine, state,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(state.status, AsyncTaskStates.Runable, 'idempotent: first wake → Runable');
    for (let i = 0; i < 9; i++) {
        [state] = asyncTaskTransition(AsyncTaskMachine, state,
            new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    }
    assertEq(state.status, AsyncTaskStates.Runable, 'idempotent: 9 more wakes → still Runable');
}

// ===========================================================================
// 16. KTaskTracker: lifecycle tests
// ===========================================================================
{
    const tracker = new KTaskTracker();

    // Create ktask for user task 3
    const ktId = tracker.createKTask(3);
    assert(ktId > 0, 'KTask-1: ktask created with positive ID');
    assertEq(tracker.getKTaskState(ktId), KTaskStates.Running, 'KTask-2: initial state Running');

    // Block ktask
    tracker.setKTaskState(ktId, KTaskStates.Blocked);
    assertEq(tracker.getKTaskState(ktId), KTaskStates.Blocked, 'KTask-3: blocked');
    assert(tracker.hasActiveKTask(), 'KTask-4: has active ktask');

    // Complete ktask
    tracker.completeKTask(ktId);
    assertEq(tracker.getKTaskState(ktId), KTaskStates.Completed, 'KTask-5: completed');
    assert(!tracker.hasActiveKTask(), 'KTask-6: no active ktasks');

    // Reset
    tracker.reset();
    assertEq(tracker.getKTaskState(ktId), KTaskStates.None, 'KTask-7: reset clears state');
}

// ===========================================================================
// 17. KTaskTracker: multiple concurrent ktasks
// ===========================================================================
{
    const tracker = new KTaskTracker();

    // User task 3 issues two async syscalls → two ktasks
    const kt1 = tracker.createKTask(3);
    const kt2 = tracker.createKTask(3);

    assert(kt1 !== kt2, 'KTask-multi-1: distinct ktask IDs');
    assert(tracker.hasActiveKTask(), 'KTask-multi-2: has active ktasks');

    tracker.completeKTask(kt1);
    assert(tracker.hasActiveKTask(), 'KTask-multi-3: still has kt2 active');

    tracker.completeKTask(kt2);
    assert(!tracker.hasActiveKTask(), 'KTask-multi-4: all complete');
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
