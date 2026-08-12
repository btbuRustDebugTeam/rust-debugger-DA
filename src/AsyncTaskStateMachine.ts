/**
 * AsyncTaskStateMachine — models the async-os coroutine task lifecycle.
 *
 * Based on async-os docs/state.md and taskctx/src/task.rs.
 *
 * async-os defines 6 task states:
 *   Running  – executing on a CPU
 *   Runable  – in the ready queue
 *   Blocking – about to yield, still on CPU (pre-yield window)
 *   Waked    – woken during the Blocking window by another CPU
 *   Blocked  – fully blocked, not in ready queue
 *   Exited   – finished
 *
 * The key insight for the debugger: when a task returns Poll::Pending from its
 * future, it doesn't always mean "blocked". It depends on the task's internal
 * state. The debugger must observe the state field (via GDB) to distinguish:
 *   - YIELD (Running → Runable): cooperative yield, task goes back to scheduler
 *   - BLOCK (Blocking → Blocked): waiting for Mutex / IO / timer
 *   - RACE (Blocking → Waked): cross-CPU wake during yield window
 *
 * This state machine is designed to be used in the debugger's stop handler
 * alongside the existing OSStateMachine (which tracks privilege-level borders).
 * While OSStateMachine answers "where is the PC (kernel/user)?",
 * AsyncTaskStateMachine answers "what is THIS coroutine doing right now?".
 */

// ===========================================================================
// Task-level states (matching async-os TaskState enum)
// ===========================================================================
export enum AsyncTaskStates {
    Running = 0,
    Runable = 1,
    Blocking = 2,
    Waked = 3,
    Blocked = 4,
    Exited = 5,
}

// ===========================================================================
// Events that drive task state transitions
// ===========================================================================
export enum AsyncTaskEvents {
    /** Future::poll returned Pending, task state was Running → yield */
    POLL_PENDING_YIELD,
    /** Future::poll returned Pending, task state was Blocking → block */
    POLL_PENDING_BLOCK,
    /** Future::poll returned Pending, task state was Waked → continue */
    POLL_PENDING_WAKED,
    /** Future::poll returned Ready → task finished */
    POLL_READY,
    /**
     * Wake event from waker (timer, mutex unlock, pipe data, etc.).
     * The effect depends on the current task state:
     *   Running  → no-op (already running)
     *   Runable  → no-op (already in ready queue)
     *   Blocking → Waked (don't yield, keep running)
     *   Blocked  → Runable (move to ready queue)
     */
    WAKEN,
    /** Task created and placed in ready queue */
    SPAWN,
    /** Scheduler picked this task from ready queue */
    SCHEDULE,
}

// ===========================================================================
// KTask (kernel coroutine) tracking for async syscalls
// ===========================================================================
export enum KTaskStates {
    /** No ktask associated (or ktask already consumed) */
    None,
    /** ktask created, executing in kernel */
    Running,
    /** ktask blocked waiting for resource */
    Blocked,
    /** ktask completed, result written back to user */
    Completed,
}

// ===========================================================================
// Action types
// ===========================================================================
export enum AsyncTaskActions {
    /** Put task into ready queue (put_prev_task) */
    ENQUEUE_TASK,
    /** Remove task from CPU without putting in ready queue (clean_current_without_drop) */
    CLEAN_NO_DROP,
    /** Task continues executing — no scheduler operation needed */
    CONTINUE_EXECUTING,
    /** Drop task reference, release resources */
    DROP_TASK,
    /** Mark task as exited and notify join-waiters */
    EXIT_TASK,
    /** Move task from wait queue to ready queue (add_task + Arc::from_raw) */
    WAKE_AND_ENQUEUE,
    /** New task created: add to ready queue */
    ADD_NEW_TASK,
}

export type AsyncTaskAction = {
    type: AsyncTaskActions;
};

export type AsyncTaskTransition = {
    target: AsyncTaskStates;
    actions?: AsyncTaskAction[];
};

export type AsyncTaskStateMachine = {
    initial: AsyncTaskStates;
    states: {
        [key in AsyncTaskStates]: {
            on: { [key in AsyncTaskEvents]?: AsyncTaskTransition };
        };
    };
};

export const AsyncTaskMachine: AsyncTaskStateMachine = {
    initial: AsyncTaskStates.Running, // tasks start in Running after SPAWN+SCHEDULE

    states: {
        [AsyncTaskStates.Running]: {
            on: {
                [AsyncTaskEvents.POLL_PENDING_YIELD]: {
                    target: AsyncTaskStates.Runable,
                    actions: [{ type: AsyncTaskActions.ENQUEUE_TASK }],
                },
                [AsyncTaskEvents.POLL_PENDING_BLOCK]: {
                    // Should not happen — Running tasks don't poll Pending with Blocking state.
                    // Blocking transitions come from the Blocking state.
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
                [AsyncTaskEvents.POLL_PENDING_WAKED]: {
                    // Should not happen in Running — Waked only from Blocking
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
                [AsyncTaskEvents.POLL_READY]: {
                    target: AsyncTaskStates.Exited,
                    actions: [
                        { type: AsyncTaskActions.EXIT_TASK },
                        { type: AsyncTaskActions.DROP_TASK },
                    ],
                },
                [AsyncTaskEvents.WAKEN]: {
                    // Already running → no-op (don't re-enqueue)
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
                [AsyncTaskEvents.SPAWN]: {
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
                [AsyncTaskEvents.SCHEDULE]: {
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
            },
        },

        [AsyncTaskStates.Runable]: {
            on: {
                [AsyncTaskEvents.SCHEDULE]: {
                    target: AsyncTaskStates.Running,
                    actions: [],
                },
                [AsyncTaskEvents.WAKEN]: {
                    // Already in ready queue → no-op
                    target: AsyncTaskStates.Runable,
                    actions: [],
                },
                // All other events are invalid for Runable (task not on CPU)
            },
        },

        [AsyncTaskStates.Blocking]: {
            on: {
                // Poll returned Pending while task was waiting for resource
                [AsyncTaskEvents.POLL_PENDING_BLOCK]: {
                    target: AsyncTaskStates.Blocked,
                    actions: [{ type: AsyncTaskActions.CLEAN_NO_DROP }],
                },
                // Cross-CPU wake during the Blocking window: task stays on CPU
                [AsyncTaskEvents.WAKEN]: {
                    target: AsyncTaskStates.Waked,
                    actions: [{ type: AsyncTaskActions.CONTINUE_EXECUTING }],
                },
                // If poll returns Ready while Blocking, task finished without blocking
                [AsyncTaskEvents.POLL_READY]: {
                    target: AsyncTaskStates.Exited,
                    actions: [
                        { type: AsyncTaskActions.EXIT_TASK },
                        { type: AsyncTaskActions.DROP_TASK },
                    ],
                },
            },
        },

        [AsyncTaskStates.Waked]: {
            on: {
                // Poll returns Pending but task was woken → continue as Running
                [AsyncTaskEvents.POLL_PENDING_WAKED]: {
                    target: AsyncTaskStates.Running,
                    actions: [{ type: AsyncTaskActions.CONTINUE_EXECUTING }],
                },
                [AsyncTaskEvents.POLL_READY]: {
                    target: AsyncTaskStates.Exited,
                    actions: [
                        { type: AsyncTaskActions.EXIT_TASK },
                        { type: AsyncTaskActions.DROP_TASK },
                    ],
                },
            },
        },

        [AsyncTaskStates.Blocked]: {
            on: {
                // Only wake can move a Blocked task
                [AsyncTaskEvents.WAKEN]: {
                    target: AsyncTaskStates.Runable,
                    actions: [{ type: AsyncTaskActions.WAKE_AND_ENQUEUE }],
                },
                // The blocked task should never be polled (it's off-CPU)
            },
        },

        [AsyncTaskStates.Exited]: {
            on: {
                // Exited tasks must not be woken
                [AsyncTaskEvents.WAKEN]: {
                    target: AsyncTaskStates.Exited,
                    actions: [], // panic in wakeup_task: "cannot wakeup Exited"
                },
            },
        },
    },
};

// ===========================================================================
// Helper: map from async-os numeric state to enum
// ===========================================================================
export function asyncOSStateFromNumber(n: number): AsyncTaskStates | undefined {
    if (n >= 0 && n <= 5) {
        return n as AsyncTaskStates;
    }
    return undefined;
}

export function asyncOSStateName(s: AsyncTaskStates): string {
    return AsyncTaskStates[s] ?? `Unknown(${s})`;
}

// ===========================================================================
// Transition function (mirrors OSStateMachine)
// ===========================================================================
export class AsyncTaskEvent {
    type: AsyncTaskEvents;
    constructor(eventType: AsyncTaskEvents) {
        this.type = eventType;
    }
}

export class AsyncTaskState {
    status: AsyncTaskStates;
    constructor(status: AsyncTaskStates) {
        this.status = status;
    }
}

export function asyncTaskTransition(
    machine: AsyncTaskStateMachine,
    state: AsyncTaskState,
    event: AsyncTaskEvent,
): [AsyncTaskState, AsyncTaskAction[]] {
    const nextStateNode = machine.states[state.status]?.on?.[event.type]
        ?? { target: state.status } as AsyncTaskTransition;

    const nextState = {
        ...state,
        status: nextStateNode.target,
    };

    return [nextState, nextStateNode.actions ?? []];
}

// ===========================================================================
// KTask lifecycle tracker (for async syscall flow)
// ===========================================================================
export class KTaskTracker {
    /** Map from user coroutine task ID → its ktask state */
    private ktasks: Map<number, KTaskStates> = new Map();
    /** The ktask ID counter */
    private nextKTaskId = 0;

    createKTask(userTaskId: number): number {
        const ktaskId = ++this.nextKTaskId;
        this.ktasks.set(ktaskId, KTaskStates.Running);
        return ktaskId;
    }

    setKTaskState(ktaskId: number, state: KTaskStates): void {
        this.ktasks.set(ktaskId, state);
    }

    getKTaskState(ktaskId: number): KTaskStates {
        return this.ktasks.get(ktaskId) ?? KTaskStates.None;
    }

    /** Called when a ktask completes: returns the result to user coroutine */
    completeKTask(ktaskId: number): void {
        this.ktasks.set(ktaskId, KTaskStates.Completed);
    }

    /** Test if there are any active ktasks */
    hasActiveKTask(): boolean {
        for (const s of this.ktasks.values()) {
            if (s === KTaskStates.Running || s === KTaskStates.Blocked) {
                return true;
            }
        }
        return false;
    }

    reset(): void {
        this.ktasks.clear();
        this.nextKTaskId = 0;
    }
}
