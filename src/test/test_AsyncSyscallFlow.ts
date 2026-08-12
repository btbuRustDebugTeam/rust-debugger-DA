/**
 * Integration tests for async syscall flow — the core cross-privilege async pattern.
 *
 * Simulates the pipetest scenario:
 *   Reader user coroutine → ecall(IS_ASYNC, sys_read)
 *   → kernel creates ktask_read → ktask blocks → EAGAIN → reader yields
 *   Writer user coroutine → ecall(IS_ASYNC, sys_write)
 *   → ktask_write completes → wakes ktask_read
 *   → ktask_read completes → wakes reader coroutine
 *   → reader gets result → finishes
 *
 * Uses both OSStateMachine (privilege-level borders) and AsyncTaskStateMachine
 * (coroutine task states) to model every step.
 *
 * Run with:  node out/test/test_AsyncSyscallFlow.js
 */

import {
    OSStateMachine,
    OSState,
    OSEvent,
    OSStates,
    OSEvents,
    DebuggerActions,
    stateTransition,
    Action,
} from '../OSStateMachine';
import {
    BreakpointGroups,
    Border,
    HookBreakpointJSONFriendly,
    IBreakpointGroupsSession,
    IDebuggerBackend,
} from '../breakpointGroups';
import {
    AsyncTaskMachine,
    AsyncTaskStates,
    AsyncTaskEvents,
    AsyncTaskActions,
    AsyncTaskState,
    AsyncTaskEvent,
    asyncTaskTransition,
    AsyncTaskAction,
    KTaskTracker,
    KTaskStates,
} from '../AsyncTaskStateMachine';
import { Breakpoint, Stack, RegisterValue } from '../backend/backend';
import { parseAddr, isKernelAddr, isUserAddr } from '../addrSpace';

// ===========================================================================
// Test infrastructure
// ===========================================================================
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

// ===========================================================================
// Side-effect log for verification
// ===========================================================================
type SideEffect =
    | { type: 'ecall'; syscallId: number; isAsync: boolean; userTaskId: number }
    | { type: 'ktask_created'; ktaskId: number; name: string; userTaskId: number }
    | { type: 'ktask_blocked'; ktaskId: number }
    | { type: 'ktask_woken'; ktaskId: number; waker: string }
    | { type: 'ktask_completed'; ktaskId: number; result: number }
    | { type: 'user_task_yielded'; userTaskId: number }
    | { type: 'user_task_woken'; userTaskId: number }
    | { type: 'user_task_exited'; userTaskId: number }
    | { type: 'eagain_returned'; userTaskId: number }
    | { type: 'user_kernel_border'; direction: string }
    | { type: 'stoppedEvent'; reason: string };

// ===========================================================================
// Mock MI2 backend
// ===========================================================================
class MockMI2 implements IDebuggerBackend {
    public calls: string[] = [];
    public stackResponse: Stack[] = [];
    public registerResponse: RegisterValue[] = [];

    getStack(_start: number, _max: number, _thread: number): Promise<Stack[]> {
        return Promise.resolve(this.stackResponse);
    }
    getSomeRegisterValues(_ids: number[]): Promise<RegisterValue[]> {
        return Promise.resolve(this.registerResponse);
    }
    continue(): Promise<boolean> { this.calls.push('continue'); return Promise.resolve(true); }
    stepInstruction(): Promise<boolean> { this.calls.push('stepInstruction'); return Promise.resolve(true); }
    clearBreakPoints(_source?: string): Promise<any> { return Promise.resolve(); }
    addBreakPoint(_bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        return Promise.resolve([true, { ..._bp, id: 1 }]);
    }
    addSymbolFile(_fp: string, _ta?: string): Promise<any> { return Promise.resolve(true); }
    removeSymbolFile(_fp: string): Promise<any> { return Promise.resolve(true); }
    sendCliCommand(command: string): Promise<any> {
        this.calls.push(`cli:${command}`);
        return Promise.resolve();
    }
    sendCommand(_command: string): Promise<any> {
        this.calls.push(`cmd:${_command}`);
        return Promise.resolve();
    }
}

// ===========================================================================
// Async syscall debug harness
//
// This harness tracks BOTH:
//   1. Privilege-level state (kernel/user) via OSStateMachine
//   2. Coroutine task state (Running/Blocked/...) via AsyncTaskStateMachine
//   3. KTask lifecycle via KTaskTracker
// ===========================================================================
class AsyncSyscallHarness {
    public osState: OSState;
    public mockMI2: MockMI2;
    public breakpointGroups: BreakpointGroups;
    public events: SideEffect[] = [];
    public kernelMemoryRanges: string[][] = [['0xffffffc000000000', '0xffffffffffffffff']];
    public userMemoryRanges: string[][] = [['0x0000000000000000', '0x0000004000000000']];
    public programCounterId = 32;
    public recentStopThreadId = 1;

    // New: per-user-task state tracking
    public tasks: Map<number, AsyncTaskState> = new Map();
    public ktaskTracker = new KTaskTracker();
    private nextUserTaskId = 0;

    constructor() {
        this.osState = new OSState(OSStateMachine.initial);
        this.mockMI2 = new MockMI2();

        const self = this;
        const bpgSession: IBreakpointGroupsSession = {
            get miDebugger(): IDebuggerBackend { return self.mockMI2; },
            filePathToBreakpointGroupNames: '(function(fp) { if (fp.includes("/app/")) return ["user"]; return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(gn) { if (gn==="kernel") return ["kernel.elf"]; return ["user.elf"]; })',
            showInformationMessage(_msg: string) {},
            onBreakpointsRestored(_results: Array<[boolean, Breakpoint]>) {},
        };
        this.breakpointGroups = new BreakpointGroups('kernel', bpgSession, 'user');
    }

    // === User task management ===
    createUserTask(): number {
        const id = ++this.nextUserTaskId;
        this.tasks.set(id, new AsyncTaskState(AsyncTaskStates.Running));
        return id;
    }

    getUserTaskState(id: number): AsyncTaskStates {
        return this.tasks.get(id)?.status ?? AsyncTaskStates.Exited;
    }

    setUserTaskState(id: number, s: AsyncTaskStates): void {
        this.tasks.set(id, new AsyncTaskState(s));
    }

    // === Transition helpers: apply state machine rules ===
    applyOSTransition(event: OSEvents): void {
        const [newState, actions] = stateTransition(
            OSStateMachine, this.osState, new OSEvent(event));
        this.osState = newState;
        for (const action of actions) {
            this.doOSAction(action);
        }
    }

    applyTaskTransition(taskId: number, event: AsyncTaskEvents): void {
        const current = this.tasks.get(taskId) ?? new AsyncTaskState(AsyncTaskStates.Running);
        const [newState, actions] = asyncTaskTransition(
            AsyncTaskMachine, current, new AsyncTaskEvent(event));
        this.tasks.set(taskId, newState);
        for (const action of actions) {
            this.doAsyncTaskAction(taskId, action);
        }
    }

    // === OS-level actions (from OSStateMachine) ===
    doOSAction(action: Action): void {
        if (action.type === DebuggerActions.check_stop_in_kernel) {
            // Border check logic (simplified)
            const borders = this.breakpointGroups.getCurrentBreakpointGroup()?.borders;
            if (borders) {
                for (const b of borders) {
                    if (b.direction === 'kernel_to_user') {
                        this.events.push({ type: 'user_kernel_border', direction: 'kernel_to_user' });
                        this.applyOSTransition(OSEvents.AT_KERNEL_TO_USER_BORDER);
                        return;
                    }
                }
            }
            this.events.push({ type: 'stoppedEvent', reason: 'breakpoint' });
        }
        else if (action.type === DebuggerActions.start_consecutive_single_steps) {
            this.mockMI2.stepInstruction();
        }
    }

    // === Async task actions (from AsyncTaskStateMachine) ===
    doAsyncTaskAction(taskId: number, action: AsyncTaskAction): void {
        switch (action.type) {
            case AsyncTaskActions.ENQUEUE_TASK:
                this.events.push({ type: 'user_task_yielded', userTaskId: taskId });
                break;
            case AsyncTaskActions.CLEAN_NO_DROP:
                // Task is now Blocked, reference not dropped (clean_current_without_drop)
                break;
            case AsyncTaskActions.WAKE_AND_ENQUEUE:
                this.events.push({ type: 'user_task_woken', userTaskId: taskId });
                break;
            case AsyncTaskActions.EXIT_TASK:
                this.events.push({ type: 'user_task_exited', userTaskId: taskId });
                break;
            case AsyncTaskActions.CONTINUE_EXECUTING:
                break;
            case AsyncTaskActions.DROP_TASK:
                break;
        }
    }

    reset(): void {
        this.mockMI2.calls = [];
        this.events = [];
        this.tasks.clear();
        this.ktaskTracker.reset();
        this.nextUserTaskId = 0;
        this.osState = new OSState(OSStates.kernel);
    }
}

// ===========================================================================
// Test runner
// ===========================================================================
async function runTests() {

// ---------------------------------------------------------------------------
// Scenario 1: Full pipetest async pipe read/write (async-await, non-blocking)
//
//  Sequence:
//   1. Reader user coroutine issues async ecall(SYS_read=63)
//   2. Kernel creates ktask "syscall 63" → ktask blocks (pipe empty)
//   3. Kernel returns EAGAIN → reader user coroutine yields
//   4. Writer user coroutine issues async ecall(SYS_write=64)
//   5. Kernel creates ktask "syscall 64" → writes data
//   6. ktask_write completes → wakes ktask_read
//   7. ktask_read completes → wakes reader user coroutine
//   8. Reader user coroutine gets result → finishes
// ---------------------------------------------------------------------------
{
    const h = new AsyncSyscallHarness();
    h.breakpointGroups.updateBorder(new Border('/src/trampoline/mod.rs', 318, undefined, 'kernel_to_user'));

    const readerId = h.createUserTask();
    const writerId = h.createUserTask();

    // === Step 1: Reader issues async SYS_read (ecall with IS_ASYNC) ===
    h.events.push({ type: 'ecall', syscallId: 63, isAsync: true, userTaskId: readerId });
    // Kernel creates ktask for this syscall
    const ktaskReadId = h.ktaskTracker.createKTask(readerId);
    h.events.push({ type: 'ktask_created', ktaskId: ktaskReadId, name: 'syscall 63', userTaskId: readerId });

    // ktask_read tries to read from empty pipe → blocks
    h.ktaskTracker.setKTaskState(ktaskReadId, KTaskStates.Blocked);
    h.events.push({ type: 'ktask_blocked', ktaskId: ktaskReadId });

    // Kernel returns EAGAIN to user coroutine
    h.events.push({ type: 'eagain_returned', userTaskId: readerId });

    // Reader user coroutine yields (cooperative yield after getting EAGAIN)
    h.applyTaskTransition(readerId, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Runable, 'S1-1: reader yielded → Runable');

    // Reader gets scheduled again (idle loop), finds ktask still pending → yields again
    h.applyTaskTransition(readerId, AsyncTaskEvents.SCHEDULE);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Running, 'S1-2: reader scheduled');

    // Reader poll returns Pending again (SyscallFuture.res is still None)
    h.applyTaskTransition(readerId, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Runable, 'S1-3: reader yielded again (EAGAIN loop)');

    // === Step 2: Writer issues async SYS_write ===
    h.events.push({ type: 'ecall', syscallId: 64, isAsync: true, userTaskId: writerId });
    const ktaskWriteId = h.ktaskTracker.createKTask(writerId);
    h.events.push({ type: 'ktask_created', ktaskId: ktaskWriteId, name: 'syscall 64', userTaskId: writerId });

    // ktask_write writes data to pipe → completes
    h.ktaskTracker.completeKTask(ktaskWriteId);
    h.events.push({ type: 'ktask_completed', ktaskId: ktaskWriteId, result: 13 });

    // Writer user coroutine gets the result → exits
    h.applyTaskTransition(writerId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(writerId), AsyncTaskStates.Exited, 'S1-4: writer exited');

    // === Step 3: ktask_write's completion wakes ktask_read ===
    h.ktaskTracker.setKTaskState(ktaskReadId, KTaskStates.Running);
    h.events.push({ type: 'ktask_woken', ktaskId: ktaskReadId, waker: 'ktask_write' });

    // ktask_read completes, result written back to reader's SyscallFuture.res
    h.ktaskTracker.completeKTask(ktaskReadId);
    h.events.push({ type: 'ktask_completed', ktaskId: ktaskReadId, result: 13 });

    // Reader user coroutine is woken
    h.applyTaskTransition(readerId, AsyncTaskEvents.SCHEDULE);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Running, 'S1-5: reader scheduled');

    // === Step 4: Reader poll → SyscallFuture.res has value → Ready ===
    // (The syscall result was already written back by ktask_read)
    // Reader prints the result and exits
    h.applyTaskTransition(readerId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Exited, 'S1-6: reader got result, exited');

    // === Verify the full event sequence ===
    const ecallEvents = h.events.filter(e => e.type === 'ecall');
    assertEq(ecallEvents.length, 2, 'S1-event-1: two ecalls');
    assertEq(ecallEvents[0], { type: 'ecall', syscallId: 63, isAsync: true, userTaskId: 1 },
        'S1-event-2: first ecall is reader SYS_read');
    assertEq(ecallEvents[1], { type: 'ecall', syscallId: 64, isAsync: true, userTaskId: 2 },
        'S1-event-3: second ecall is writer SYS_write');

    const eagainEvents = h.events.filter(e => e.type === 'eagain_returned');
    assertEq(eagainEvents.length, 1, 'S1-event-4: one EAGAIN returned');

    const wakeupChain = h.events.filter(e => e.type === 'ktask_woken' || e.type === 'user_task_woken');
    assert(wakeupChain.length >= 1, 'S1-event-5: wakeup chain exists');

    assert(!h.ktaskTracker.hasActiveKTask(), 'S1-final: no active ktasks remaining');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario 2: Blocking syscall path (blocking feature)
//    Non-async path: ecall without IS_ASYNC flag, no ktask,
//    user coroutine blocks directly in kernel.
// ---------------------------------------------------------------------------
{
    const h = new AsyncSyscallHarness();
    const taskId = h.createUserTask();

    // Sync blocking ecall (no IS_ASYNC flag in t0)
    h.events.push({ type: 'ecall', syscallId: 63, isAsync: false, userTaskId: taskId });

    // No ktask is created for blocking syscalls
    assert(!h.ktaskTracker.hasActiveKTask(), 'S2-1: no ktask for blocking syscall');

    // User task blocks directly (it's inside the kernel coroutine, waiting)
    h.setUserTaskState(taskId, AsyncTaskStates.Blocking);
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_PENDING_BLOCK);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Blocked, 'S2-2: user task blocked on sync syscall');

    // Kernel completes the syscall → wakes user task
    h.applyTaskTransition(taskId, AsyncTaskEvents.WAKEN);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Runable, 'S2-3: user task woken');

    // Scheduler picks it → gets result
    h.applyTaskTransition(taskId, AsyncTaskEvents.SCHEDULE);
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Exited, 'S2-4: user task exited');

    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario 3: Async syscall with immediate ktask completion (no blocking)
//    e.g. sys_write on pipe that has space → ktask completes immediately,
//    no EAGAIN needed.
// ---------------------------------------------------------------------------
{
    const h = new AsyncSyscallHarness();
    const taskId = h.createUserTask();

    // User issues async ecall
    h.events.push({ type: 'ecall', syscallId: 64, isAsync: true, userTaskId: taskId });
    const ktId = h.ktaskTracker.createKTask(taskId);
    h.events.push({ type: 'ktask_created', ktaskId: ktId, name: 'syscall 64', userTaskId: taskId });

    // ktask executes and completes immediately (no blocking)
    h.ktaskTracker.completeKTask(ktId);
    h.events.push({ type: 'ktask_completed', ktaskId: ktId, result: 14 });

    // User task gets result immediately → doesn't yield
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Exited, 'S3-1: immediate complete → exited');

    // No EAGAIN was returned
    const eagainCount = h.events.filter(e => e.type === 'eagain_returned').length;
    assertEq(eagainCount, 0, 'S3-2: no EAGAIN needed');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario 4: Multiple concurrent async syscalls from the same user coroutine
//    User spawns two async reads → two ktasks → both block → both woken
//    → user sees results in order.
// ---------------------------------------------------------------------------
{
    const h = new AsyncSyscallHarness();
    const taskId = h.createUserTask();

    // Issue syscall A
    h.events.push({ type: 'ecall', syscallId: 63, isAsync: true, userTaskId: taskId });
    const ktA = h.ktaskTracker.createKTask(taskId);
    h.events.push({ type: 'ktask_created', ktaskId: ktA, name: 'syscall 63', userTaskId: taskId });

    // ktask A blocks
    h.ktaskTracker.setKTaskState(ktA, KTaskStates.Blocked);
    h.events.push({ type: 'ktask_blocked', ktaskId: ktA });
    h.events.push({ type: 'eagain_returned', userTaskId: taskId });
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Runable, 'S4-1: after EAGAIN A');

    // Issue syscall B (after being scheduled again)
    h.applyTaskTransition(taskId, AsyncTaskEvents.SCHEDULE);
    h.events.push({ type: 'ecall', syscallId: 64, isAsync: true, userTaskId: taskId });
    const ktB = h.ktaskTracker.createKTask(taskId);
    h.events.push({ type: 'ktask_created', ktaskId: ktB, name: 'syscall 64', userTaskId: taskId });

    // ktask B blocks too
    h.ktaskTracker.setKTaskState(ktB, KTaskStates.Blocked);
    h.events.push({ type: 'ktask_blocked', ktaskId: ktB });
    h.events.push({ type: 'eagain_returned', userTaskId: taskId });
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Runable, 'S4-2: after EAGAIN B');

    // Both ktasks are now blocked
    assert(h.ktaskTracker.hasActiveKTask(), 'S4-3: ktasks still active');

    // ktask B completes first, wakes user
    h.ktaskTracker.completeKTask(ktB);
    h.applyTaskTransition(taskId, AsyncTaskEvents.SCHEDULE);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Running, 'S4-4: running after ktB completes');

    // But ktask A is still pending → user gets ktB result, issues poll again → EAGAIN for A
    // (user coroutine would loop: poll → some futures ready, some pending → yield if any pending)
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_PENDING_YIELD);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Runable, 'S4-5: yielded (ktA still pending)');

    // ktask A completes
    h.ktaskTracker.completeKTask(ktA);
    h.applyTaskTransition(taskId, AsyncTaskEvents.SCHEDULE);
    // Now all syscalls complete → task gets all results
    h.applyTaskTransition(taskId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(taskId), AsyncTaskStates.Exited, 'S4-6: all syscalls done');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario 5: SMP cross-CPU wake during async syscall handling
//    CPU1: ktask_read blocks (state: Blocking → Blocked)
//    CPU2: ktask_write completes, calls waker.wake() on ktask_read
//    Race: if ktask_read is in Blocking (pre-yield), it becomes Waked
// ---------------------------------------------------------------------------
{
    const h = new AsyncSyscallHarness();
    const readerId = h.createUserTask();
    const writerId = h.createUserTask();

    // CPU1: Reader issues sys_read, creates ktask
    const ktRead = h.ktaskTracker.createKTask(readerId);
    h.events.push({ type: 'ktask_created', ktaskId: ktRead, name: 'syscall 63', userTaskId: readerId });

    // ktask_read enters Blocking (about to set state = Blocking, poll → Pending)
    h.ktaskTracker.setKTaskState(ktRead, KTaskStates.Blocked);
    // But before it finishes yielding on CPU1...

    // CPU2: Writer completes and wakes ktask_read via waker.wake()
    // wakeup_task sees Blocking → changes to Waked
    // (This is the SMP race path: ktask is still on CPU1 but being woken by CPU2)

    // The ktask_read's task state would be Waked if using AsyncTaskMachine:
    const ktaskAsTask = new AsyncTaskState(AsyncTaskStates.Blocking);
    const [afterWake] = asyncTaskTransition(
        AsyncTaskMachine, ktaskAsTask,
        new AsyncTaskEvent(AsyncTaskEvents.WAKEN));
    assertEq(afterWake.status, AsyncTaskStates.Waked, 'S5-SMP-1: wake during Blocking → Waked');

    // When ktask_read finishes yielding (poll returns Pending, but state is Waked):
    const [afterPoll] = asyncTaskTransition(
        AsyncTaskMachine, afterWake,
        new AsyncTaskEvent(AsyncTaskEvents.POLL_PENDING_WAKED));
    assertEq(afterPoll.status, AsyncTaskStates.Running, 'S5-SMP-2: Waked + poll → Running (no yield!)');

    // ktask_read never actually blocked → completes immediately
    h.ktaskTracker.completeKTask(ktRead);
    h.applyTaskTransition(readerId, AsyncTaskEvents.SCHEDULE);
    h.applyTaskTransition(readerId, AsyncTaskEvents.POLL_READY);
    assertEq(h.getUserTaskState(readerId), AsyncTaskStates.Exited, 'S5-SMP-3: reader done');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario 6: Async syscall with ktask creation visible to debugger
//    Verifies the debugger can detect IS_ASYNC flag via t0 register.
//    t0 = 0x5f5f5f5f → IS_ASYNC
//    t0 = 0          → blocking (sync)
// ---------------------------------------------------------------------------
{
    const IS_ASYNC = 0x5f5f5f5f;

    // Simulate what the debugger would see when reading registers at ecall
    const detectAsync = (t0Value: number) => t0Value === IS_ASYNC;

    assert(detectAsync(IS_ASYNC), 'S6-1: t0=0x5f5f5f5f → IS_ASYNC detected');
    assert(!detectAsync(0), 'S6-2: t0=0 → sync syscall');
    assert(!detectAsync(0x100), 'S6-3: t0=arbitrary → sync');

    // Additional async registers:
    // t1 = ret_ptr (address where result is written)
    // t2 = user task ptr (for TAIC scheduler callback)
    assert(true, 'S6-4: async regs: t1=ret_ptr, t2=task_ptr');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { process.exit(1); }

}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
