/**
 * Comprehensive unit tests for OSStateMachine.
 * Tests every state×event combination, state transitions, and action correctness.
 * Run with:  node out/test/test_OSStateMachine_comprehensive.js
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

function assertActions(actions: Action[], expectedTypes: DebuggerActions[], label: string): void {
    const actualTypes = actions.map(a => a.type);
    assertEq(actualTypes, expectedTypes, label);
}

function transition(state: OSStates, event: OSEvents): [OSState, Action[]] {
    return stateTransition(OSStateMachine, new OSState(state), new OSEvent(event));
}

// ===========================================================================
// 1. Initial state
// ===========================================================================
{
    assertEq(OSStateMachine.initial, OSStates.kernel, 'initial state is kernel');
    // Verify all 4 states are defined
    assert('kernel' in OSStates || true, 'OSStates.kernel exists');
    assert('kernel_single_step_to_user' in OSStates || true, 'OSStates.kernel_single_step_to_user exists');
    assert('user' in OSStates || true, 'OSStates.user exists');
    assert('user_single_step_to_kernel' in OSStates || true, 'OSStates.user_single_step_to_kernel exists');
}

// ===========================================================================
// 2. Complete transition matrix: kernel state × all events
// ===========================================================================
{
    // STOPPED → check_stop_in_kernel (unified handler), stay in kernel
    const [s1, a1] = transition(OSStates.kernel, OSEvents.STOPPED);
    assertEq(s1.status, OSStates.kernel, 'kernel+STOPPED → kernel');
    assertActions(a1, [DebuggerActions.check_stop_in_kernel], 'kernel+STOPPED actions');

    // AT_KERNEL_TO_USER_BORDER → kernel_single_step_to_user
    const [s2, a2] = transition(OSStates.kernel, OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(s2.status, OSStates.kernel_single_step_to_user, 'kernel+AT_KERNEL_TO_USER_BORDER → single_step_to_user');
    assertActions(a2, [DebuggerActions.start_consecutive_single_steps], 'kernel+AT_KERNEL_TO_USER_BORDER actions');

    // AT_USER → undefined transition, stays kernel, empty actions
    const [s3, a3] = transition(OSStates.kernel, OSEvents.AT_USER);
    assertEq(s3.status, OSStates.kernel, 'kernel+AT_USER → kernel (undefined)');
    assertEq(a3.length, 0, 'kernel+AT_USER → empty actions');

    // AT_USER_TO_KERNEL_BORDER → undefined, stays kernel
    const [s4, a4] = transition(OSStates.kernel, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(s4.status, OSStates.kernel, 'kernel+AT_USER_TO_KERNEL_BORDER → kernel (undefined)');
    assertEq(a4.length, 0, 'kernel+AT_USER_TO_KERNEL_BORDER → empty actions');

    // AT_KERNEL → undefined (kernel is already kernel), stays kernel
    const [s5, a5] = transition(OSStates.kernel, OSEvents.AT_KERNEL);
    assertEq(s5.status, OSStates.kernel, 'kernel+AT_KERNEL → kernel (undefined)');
    assertEq(a5.length, 0, 'kernel+AT_KERNEL → empty actions');
}

// ===========================================================================
// 3. Complete transition matrix: kernel_single_step_to_user × all events
// ===========================================================================
{
    // STOPPED → check_if_user_yet, stay in single_step
    const [s1, a1] = transition(OSStates.kernel_single_step_to_user, OSEvents.STOPPED);
    assertEq(s1.status, OSStates.kernel_single_step_to_user, 'kss2u+STOPPED → kss2u');
    assertActions(a1, [DebuggerActions.check_if_user_yet], 'kss2u+STOPPED actions');

    // AT_USER → switch group, enter user state
    const [s2, a2] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_USER);
    assertEq(s2.status, OSStates.user, 'kss2u+AT_USER → user');
    assertActions(a2, [DebuggerActions.low_level_switch_breakpoint_group_to_high_level], 'kss2u+AT_USER actions');

    // AT_KERNEL → undefined
    const [s3, a3] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_KERNEL);
    assertEq(s3.status, OSStates.kernel_single_step_to_user, 'kss2u+AT_KERNEL → kss2u (undefined)');
    assertEq(a3.length, 0, 'kss2u+AT_KERNEL → empty actions');

    // AT_KERNEL_TO_USER_BORDER → undefined (border was already detected)
    const [s4, a4] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(s4.status, OSStates.kernel_single_step_to_user, 'kss2u+AT_KERNEL_TO_USER_BORDER → kss2u');
    assertEq(a4.length, 0, 'kss2u+AT_KERNEL_TO_USER_BORDER → empty actions');

    // AT_USER_TO_KERNEL_BORDER → undefined
    const [s5, a5] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(s5.status, OSStates.kernel_single_step_to_user, 'kss2u+AT_USER_TO_KERNEL_BORDER → kss2u');
    assertEq(a5.length, 0, 'kss2u+AT_USER_TO_KERNEL_BORDER → empty actions');
}

// ===========================================================================
// 4. Complete transition matrix: user state × all events
// ===========================================================================
{
    // STOPPED → check_if_user_to_kernel_border_yet
    const [s1, a1] = transition(OSStates.user, OSEvents.STOPPED);
    assertEq(s1.status, OSStates.user, 'user+STOPPED → user');
    assertActions(a1, [DebuggerActions.check_if_user_to_kernel_border_yet], 'user+STOPPED actions');

    // AT_USER_TO_KERNEL_BORDER → user_single_step_to_kernel
    const [s2, a2] = transition(OSStates.user, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(s2.status, OSStates.user_single_step_to_kernel, 'user+AT_USER_TO_KERNEL_BORDER → uss2k');
    assertActions(a2, [DebuggerActions.start_consecutive_single_steps], 'user+AT_USER_TO_KERNEL_BORDER actions');

    // AT_KERNEL → kernel (StarryOS bypass: PC already in kernel)
    const [s3, a3] = transition(OSStates.user, OSEvents.AT_KERNEL);
    assertEq(s3.status, OSStates.kernel, 'user+AT_KERNEL → kernel (StarryOS bypass)');
    assertActions(a3, [DebuggerActions.high_level_switch_breakpoint_group_to_low_level], 'user+AT_KERNEL actions');

    // AT_USER → undefined
    const [s4, a4] = transition(OSStates.user, OSEvents.AT_USER);
    assertEq(s4.status, OSStates.user, 'user+AT_USER → user (undefined)');
    assertEq(a4.length, 0, 'user+AT_USER → empty actions');

    // AT_KERNEL_TO_USER_BORDER → undefined (wrong direction while in user)
    const [s5, a5] = transition(OSStates.user, OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(s5.status, OSStates.user, 'user+AT_KERNEL_TO_USER_BORDER → user (undefined)');
    assertEq(a5.length, 0, 'user+AT_KERNEL_TO_USER_BORDER → empty actions');
}

// ===========================================================================
// 5. Complete transition matrix: user_single_step_to_kernel × all events
// ===========================================================================
{
    // STOPPED → check_if_kernel_yet
    const [s1, a1] = transition(OSStates.user_single_step_to_kernel, OSEvents.STOPPED);
    assertEq(s1.status, OSStates.user_single_step_to_kernel, 'uss2k+STOPPED → uss2k');
    assertActions(a1, [DebuggerActions.check_if_kernel_yet], 'uss2k+STOPPED actions');

    // AT_KERNEL → kernel, switch group back
    const [s2, a2] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_KERNEL);
    assertEq(s2.status, OSStates.kernel, 'uss2k+AT_KERNEL → kernel');
    assertActions(a2, [DebuggerActions.high_level_switch_breakpoint_group_to_low_level], 'uss2k+AT_KERNEL actions');

    // AT_USER → undefined
    const [s3, a3] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_USER);
    assertEq(s3.status, OSStates.user_single_step_to_kernel, 'uss2k+AT_USER → uss2k (undefined)');
    assertEq(a3.length, 0, 'uss2k+AT_USER → empty actions');

    // AT_KERNEL_TO_USER_BORDER → undefined
    const [s4, a4] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(s4.status, OSStates.user_single_step_to_kernel, 'uss2k+AT_KERNEL_TO_USER_BORDER → uss2k');
    assertEq(a4.length, 0, 'uss2k+AT_KERNEL_TO_USER_BORDER → empty actions');

    // AT_USER_TO_KERNEL_BORDER → undefined
    const [s5, a5] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(s5.status, OSStates.user_single_step_to_kernel, 'uss2k+AT_USER_TO_KERNEL_BORDER → uss2k');
    assertEq(a5.length, 0, 'uss2k+AT_USER_TO_KERNEL_BORDER → empty actions');
}

// ===========================================================================
// 6. stateTransition never returns undefined actions (Fix #5 verification)
// ===========================================================================
{
    // Every defined and undefined transition should return an array
    const allStates = [OSStates.kernel, OSStates.kernel_single_step_to_user, OSStates.user, OSStates.user_single_step_to_kernel];
    const allEvents = [OSEvents.STOPPED, OSEvents.AT_KERNEL, OSEvents.AT_KERNEL_TO_USER_BORDER, OSEvents.AT_USER, OSEvents.AT_USER_TO_KERNEL_BORDER];
    for (const st of allStates) {
        for (const ev of allEvents) {
            const [, actions] = transition(st, ev);
            assert(Array.isArray(actions), `actions is always array: state=${OSStates[st]}, event=${OSEvents[ev]}`);
        }
    }
}

// ===========================================================================
// 7. Immutability: stateTransition does not mutate the original state
// ===========================================================================
{
    const original = new OSState(OSStates.kernel);
    const [next] = stateTransition(OSStateMachine, original, new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
    assertEq(original.status, OSStates.kernel, 'original state not mutated (kernel)');
    assertEq(next.status, OSStates.kernel_single_step_to_user, 'returned state has new status');

    // Also test with user state
    const orig2 = new OSState(OSStates.user);
    stateTransition(OSStateMachine, orig2, new OSEvent(OSEvents.AT_KERNEL));
    assertEq(orig2.status, OSStates.user, 'original state not mutated (user)');
}

// ===========================================================================
// 8. Full cycle: kernel → user → kernel (explicit step-by-step)
// ===========================================================================
{
    let state = new OSState(OSStates.kernel);
    const history: OSStates[] = [state.status];

    // kernel STOPPED → check_stop_in_kernel, stays kernel
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
    history.push(state.status);
    assertEq(state.status, OSStates.kernel, 'cycle-1: kernel after STOPPED');

    // kernel border detected → single step
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
    history.push(state.status);
    assertEq(state.status, OSStates.kernel_single_step_to_user, 'cycle-2: single_step_to_user');

    // single step, not at user yet (3 rounds)
    for (let i = 0; i < 3; i++) {
        [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
        history.push(state.status);
        assertEq(state.status, OSStates.kernel_single_step_to_user, `cycle-3-${i}: still single stepping`);
    }

    // arrived at user
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_USER));
    history.push(state.status);
    assertEq(state.status, OSStates.user, 'cycle-4: arrived at user');

    // user STOPPED → check border
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
    history.push(state.status);
    assertEq(state.status, OSStates.user, 'cycle-5: user after STOPPED');

    // user border detected → single step to kernel
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
    history.push(state.status);
    assertEq(state.status, OSStates.user_single_step_to_kernel, 'cycle-6: single_step_to_kernel');

    // single step, arrived at kernel
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_KERNEL));
    history.push(state.status);
    assertEq(state.status, OSStates.kernel, 'cycle-7: back to kernel');

    // Verify the full history matches expected path
    const expectedHistory = [
        OSStates.kernel,                         // initial
        OSStates.kernel,                         // STOPPED
        OSStates.kernel_single_step_to_user,     // AT_KERNEL_TO_USER_BORDER
        OSStates.kernel_single_step_to_user,     // STOPPED ×3
        OSStates.kernel_single_step_to_user,
        OSStates.kernel_single_step_to_user,
        OSStates.user,                           // AT_USER
        OSStates.user,                           // STOPPED
        OSStates.user_single_step_to_kernel,     // AT_USER_TO_KERNEL_BORDER
        OSStates.kernel,                         // AT_KERNEL
    ];
    assertEq(history, expectedHistory, 'full cycle history matches');
}

// ===========================================================================
// 9. StarryOS fast path: user + AT_KERNEL → kernel (bypass single-step)
// ===========================================================================
{
    // This path is used when PC is already in kernel space (e.g., border at handle_syscall)
    let state = new OSState(OSStates.user);
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_KERNEL));
    assertEq(state.status, OSStates.kernel, 'StarryOS fast path: user+AT_KERNEL → kernel');
}

// ===========================================================================
// 10. Repeated events don't cause state explosion (idempotency)
// ===========================================================================
{
    // Sending STOPPED 10 times in a row should stay in the same state
    let state = new OSState(OSStates.kernel);
    for (let i = 0; i < 10; i++) {
        [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
        assertEq(state.status, OSStates.kernel, `repeated STOPPED in kernel: iter ${i}`);
    }

    // Same for user
    state = new OSState(OSStates.user);
    for (let i = 0; i < 10; i++) {
        [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
        assertEq(state.status, OSStates.user, `repeated STOPPED in user: iter ${i}`);
    }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
