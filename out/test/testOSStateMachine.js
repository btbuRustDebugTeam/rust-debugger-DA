"use strict";
/**
 * Unit tests for OSStateMachine.
 * Run with:  node out/test/testOSStateMachine.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
const OSStateMachine_1 = require("../OSStateMachine");
let passed = 0;
let failed = 0;
function assert(condition, message) {
    if (condition) {
        passed++;
    }
    else {
        failed++;
        console.error(`FAIL: ${message}`);
    }
}
function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    }
    else {
        failed++;
        console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
    }
}
function assertActions(actions, expectedTypes, label) {
    const actualTypes = actions.map(a => a.type);
    assertEq(actualTypes, expectedTypes, label);
}
// Helper: run a single transition and return [newState, actions]
function transition(state, event) {
    return (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, new OSStateMachine_1.OSState(state), new OSStateMachine_1.OSEvent(event));
}
// ---------------------------------------------------------------------------
// stateTransition always returns an array (never undefined) — fix #5
// ---------------------------------------------------------------------------
{
    // AT_USER_TO_KERNEL_BORDER is not defined for kernel state → should return []
    const [, actions] = transition(OSStateMachine_1.OSStates.kernel, OSStateMachine_1.OSEvents.AT_USER_TO_KERNEL_BORDER);
    assert(Array.isArray(actions), 'actions is always an array (never undefined)');
    assertEq(actions.length, 0, 'undefined transition yields empty actions array');
}
// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
{
    assertEq(OSStateMachine_1.OSStateMachine.initial, OSStateMachine_1.OSStates.kernel, 'initial state is kernel');
}
// ---------------------------------------------------------------------------
// kernel state
// ---------------------------------------------------------------------------
{
    // STOPPED in kernel → stays in kernel, runs try_get_next + check_if_kernel_to_user_border
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel, OSStateMachine_1.OSEvents.STOPPED);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel, 'kernel + STOPPED → stays kernel');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.try_get_next_breakpoint_group_name,
        OSStateMachine_1.DebuggerActions.check_if_kernel_to_user_border_yet,
    ], 'kernel + STOPPED actions');
}
{
    // AT_KERNEL_TO_USER_BORDER → moves to kernel_single_step_to_user, starts single stepping
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel, OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel_single_step_to_user, 'kernel + AT_KERNEL_TO_USER_BORDER → kernel_single_step_to_user');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.start_consecutive_single_steps,
    ], 'kernel + AT_KERNEL_TO_USER_BORDER actions');
}
{
    // AT_USER not defined for kernel → stays kernel, empty actions
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel, OSStateMachine_1.OSEvents.AT_USER);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel, 'kernel + undefined event → stays kernel');
    assertEq(actions.length, 0, 'kernel + undefined event → empty actions');
}
// ---------------------------------------------------------------------------
// kernel_single_step_to_user state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at user
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel_single_step_to_user, OSStateMachine_1.OSEvents.STOPPED);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel_single_step_to_user, 'kernel_single_step_to_user + STOPPED → stays');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.check_if_user_yet,
    ], 'kernel_single_step_to_user + STOPPED actions');
}
{
    // AT_USER → moves to user, switches breakpoint group to high level
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel_single_step_to_user, OSStateMachine_1.OSEvents.AT_USER);
    assertEq(next.status, OSStateMachine_1.OSStates.user, 'kernel_single_step_to_user + AT_USER → user');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.low_level_switch_breakpoint_group_to_high_level,
    ], 'kernel_single_step_to_user + AT_USER actions');
}
{
    // AT_KERNEL not defined here → stays, empty actions
    const [next, actions] = transition(OSStateMachine_1.OSStates.kernel_single_step_to_user, OSStateMachine_1.OSEvents.AT_KERNEL);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel_single_step_to_user, 'kernel_single_step_to_user + undefined event → stays');
    assertEq(actions.length, 0, 'kernel_single_step_to_user + undefined event → empty actions');
}
// ---------------------------------------------------------------------------
// user state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at kernel border
    const [next, actions] = transition(OSStateMachine_1.OSStates.user, OSStateMachine_1.OSEvents.STOPPED);
    assertEq(next.status, OSStateMachine_1.OSStates.user, 'user + STOPPED → stays user');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.check_if_user_to_kernel_border_yet,
    ], 'user + STOPPED actions');
}
{
    // AT_USER_TO_KERNEL_BORDER → moves to user_single_step_to_kernel, starts single stepping
    const [next, actions] = transition(OSStateMachine_1.OSStates.user, OSStateMachine_1.OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(next.status, OSStateMachine_1.OSStates.user_single_step_to_kernel, 'user + AT_USER_TO_KERNEL_BORDER → user_single_step_to_kernel');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.start_consecutive_single_steps,
    ], 'user + AT_USER_TO_KERNEL_BORDER actions');
}
{
    // AT_KERNEL not defined for user → stays, empty actions
    const [next, actions] = transition(OSStateMachine_1.OSStates.user, OSStateMachine_1.OSEvents.AT_KERNEL);
    assertEq(next.status, OSStateMachine_1.OSStates.user, 'user + undefined event → stays user');
    assertEq(actions.length, 0, 'user + undefined event → empty actions');
}
// ---------------------------------------------------------------------------
// user_single_step_to_kernel state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at kernel
    const [next, actions] = transition(OSStateMachine_1.OSStates.user_single_step_to_kernel, OSStateMachine_1.OSEvents.STOPPED);
    assertEq(next.status, OSStateMachine_1.OSStates.user_single_step_to_kernel, 'user_single_step_to_kernel + STOPPED → stays');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.check_if_kernel_yet,
    ], 'user_single_step_to_kernel + STOPPED actions');
}
{
    // AT_KERNEL → moves back to kernel, switches breakpoint group to low level
    const [next, actions] = transition(OSStateMachine_1.OSStates.user_single_step_to_kernel, OSStateMachine_1.OSEvents.AT_KERNEL);
    assertEq(next.status, OSStateMachine_1.OSStates.kernel, 'user_single_step_to_kernel + AT_KERNEL → kernel');
    assertActions(actions, [
        OSStateMachine_1.DebuggerActions.high_level_switch_breakpoint_group_to_low_level,
    ], 'user_single_step_to_kernel + AT_KERNEL actions');
}
{
    // AT_USER not defined here → stays, empty actions
    const [next, actions] = transition(OSStateMachine_1.OSStates.user_single_step_to_kernel, OSStateMachine_1.OSEvents.AT_USER);
    assertEq(next.status, OSStateMachine_1.OSStates.user_single_step_to_kernel, 'user_single_step_to_kernel + undefined event → stays');
    assertEq(actions.length, 0, 'user_single_step_to_kernel + undefined event → empty actions');
}
// ---------------------------------------------------------------------------
// Full cycle: kernel → user → kernel
// ---------------------------------------------------------------------------
{
    let state = new OSStateMachine_1.OSState(OSStateMachine_1.OSStates.kernel);
    // kernel receives STOPPED → check border
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
    assertEq(state.status, OSStateMachine_1.OSStates.kernel, 'cycle: kernel after STOPPED');
    // border detected → start single stepping
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER));
    assertEq(state.status, OSStateMachine_1.OSStates.kernel_single_step_to_user, 'cycle: entered single-step to user');
    // a few STOPPED events while single-stepping (still not at user yet)
    for (let i = 0; i < 3; i++) {
        [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
        assertEq(state.status, OSStateMachine_1.OSStates.kernel_single_step_to_user, `cycle: still single-stepping step ${i + 1}`);
    }
    // finally arrived at user space
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER));
    assertEq(state.status, OSStateMachine_1.OSStates.user, 'cycle: arrived at user');
    // user receives STOPPED → check border
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
    assertEq(state.status, OSStateMachine_1.OSStates.user, 'cycle: user after STOPPED');
    // border detected → single step back to kernel
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER_TO_KERNEL_BORDER));
    assertEq(state.status, OSStateMachine_1.OSStates.user_single_step_to_kernel, 'cycle: entered single-step to kernel');
    // arrived at kernel
    [state] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, state, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL));
    assertEq(state.status, OSStateMachine_1.OSStates.kernel, 'cycle: back to kernel');
}
// ---------------------------------------------------------------------------
// stateTransition does not mutate the original state object
// ---------------------------------------------------------------------------
{
    const original = new OSStateMachine_1.OSState(OSStateMachine_1.OSStates.kernel);
    (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, original, new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER));
    assertEq(original.status, OSStateMachine_1.OSStates.kernel, 'original state is not mutated by transition');
}
// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    process.exit(1);
}
//# sourceMappingURL=testOSStateMachine.js.map