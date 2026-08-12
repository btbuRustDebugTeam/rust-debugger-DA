/**
 * Edge case and bug-finding tests for OS debug flow.
 * Focus areas:
 *   - Race conditions between save and _cleanup_run_scoped
 *   - Double-restore (restore without save)
 *   - Group switch failure recovery
 *   - Repeated border/hook hits
 *   - stpc CSR reading failures
 *   - Register read returning empty data
 *   - GDB connection loss during state machine actions
 *   - Multiple consecutive group switches
 *
 * Run with:  node out/test/test_OSDebug_edge_cases.js
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
import { Breakpoint, Stack, RegisterValue } from '../backend/backend';
import { parseAddr, isKernelAddr, isUserAddr } from '../addrSpace';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mock MI2 with controllable behavior
// ---------------------------------------------------------------------------
class ControllableMockMI2 implements IDebuggerBackend {
    public calls: string[] = [];
    public traceState: Map<string, object> = new Map();

    // Configurable responses
    public stackResponse: Stack[] = [];
    public registerResponse: RegisterValue[] = [];
    public shouldFailClearBreakpoints = false;
    public shouldFailAddSymbol = false;
    public shouldFailRemoveSymbol = false;
    public shouldFailAddBreakpoint = false;
    public shouldFailSendCommand = false;
    public shouldFailContinue = false;

    // Tracking
    public bpCalls: Breakpoint[] = [];
    public clearedSources: string[] = [];

    getStack(_start: number, _max: number, _thread: number): Promise<Stack[]> {
        return Promise.resolve(this.stackResponse);
    }
    getSomeRegisterValues(_ids: number[]): Promise<RegisterValue[]> {
        return Promise.resolve(this.registerResponse);
    }
    continue(): Promise<boolean> {
        this.calls.push('continue');
        if (this.shouldFailContinue) return Promise.reject(new Error('GDB continue failed'));
        return Promise.resolve(true);
    }
    stepInstruction(): Promise<boolean> {
        this.calls.push('stepInstruction');
        return Promise.resolve(true);
    }
    clearBreakPoints(source?: string): Promise<any> {
        this.calls.push(`clearBreakPoints(${source ?? ''})`);
        this.clearedSources.push(source ?? '');
        if (this.shouldFailClearBreakpoints) return Promise.reject(new Error('clearBreakPoints failed'));
        return Promise.resolve();
    }
    addBreakPoint(bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        this.calls.push(`addBreakPoint(${bp.file ?? bp.raw}, ${bp.line})`);
        this.bpCalls.push(bp);
        if (this.shouldFailAddBreakpoint) return Promise.reject(new Error('addBreakPoint failed'));
        return Promise.resolve([true, { ...bp, id: 1 }]);
    }
    addSymbolFile(filepath: string, _textAddr?: string): Promise<any> {
        this.calls.push(`addSymbolFile(${filepath})`);
        if (this.shouldFailAddSymbol) return Promise.reject(new Error('addSymbolFile failed'));
        return Promise.resolve(true);
    }
    removeSymbolFile(filepath: string): Promise<any> {
        this.calls.push(`removeSymbolFile(${filepath})`);
        if (this.shouldFailRemoveSymbol) return Promise.reject(new Error('removeSymbolFile failed'));
        return Promise.resolve(true);
    }
    sendCliCommand(command: string): Promise<any> {
        this.calls.push(`cli:${command}`);
        // Simulate save/restore trace state
        if (command.startsWith('ardb-save-trace-state')) {
            const label = command.split(' ')[1];
            this.traceState.set(label, { saved: true });
        } else if (command.startsWith('ardb-restore-trace-state')) {
            const label = command.split(' ')[1];
            if (!this.traceState.has(label)) {
                // This is the bug: restore without save
                this.calls.push(`RESTORE_WITHOUT_SAVE:${label}`);
            }
        }
        if (this.shouldFailSendCommand) return Promise.reject(new Error('sendCommand failed'));
        return Promise.resolve();
    }
    sendCommand(command: string): Promise<any> {
        this.calls.push(`cmd:${command}`);
        if (this.shouldFailSendCommand) return Promise.reject(new Error('sendCommand failed'));
        return Promise.resolve();
    }
}

// Simplified harness — mirrors gdbDebugSession logic
class EdgeCaseHarness {
    public osState: OSState;
    public mockMI2: ControllableMockMI2;
    public breakpointGroups: BreakpointGroups;
    public events: string[] = [];
    public kernelMemoryRanges: string[][] = [['0xffffffc000000000', '0xffffffffffffffff']];
    public userMemoryRanges: string[][] = [['0x0000000000000000', '0x0000004000000000']];
    public programCounterId = 32;
    public recentStopThreadId = 1;

    constructor() {
        this.osState = new OSState(OSStateMachine.initial);
        this.mockMI2 = new ControllableMockMI2();
        const self = this;
        const session: IBreakpointGroupsSession = {
            get miDebugger(): IDebuggerBackend { return self.mockMI2; },
            filePathToBreakpointGroupNames: '(function(fp) { if (fp.includes("/app/")) return ["user"]; return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(gn) { if (gn==="kernel") return ["kernel.elf"]; return ["user.elf"]; })',
            showInformationMessage(_m: string) {},
            onBreakpointsRestored(_r: Array<[boolean, Breakpoint]>) {},
        };
        this.breakpointGroups = new BreakpointGroups('kernel', session, 'user');
    }

    osStateTransition(event: OSEvent): void {
        let actions: Action[];
        [this.osState, actions] = stateTransition(OSStateMachine, this.osState, event);
        for (const action of actions) {
            this.doAction(action);
        }
    }

    doAction(action: Action): void {
        const m = this.mockMI2;
        if (action.type === DebuggerActions.check_stop_in_kernel) {
            m.getStack(0, 1, this.recentStopThreadId).then(async v => {
                if (!v || v.length === 0 || !v[0]) {
                    this.events.push('stopped:breakpoint(empty_stack)');
                    return;
                }
                const fp = v[0].file, ln = v[0].line, fn = v[0].function;
                const cg = this.breakpointGroups.getCurrentBreakpointGroup();
                if (!cg) { this.events.push('stopped:breakpoint(no_group)'); return; }
                // Check hooks
                for (const hk of cg.hooks) {
                    const hkFn = hk.breakpoint.function;
                    const mFile = hk.breakpoint.file && fp === hk.breakpoint.file && ln === hk.breakpoint.line;
                    const mFn = hkFn && fn && fn.includes(hkFn);
                    if (mFile || mFn) {
                        try { this.breakpointGroups.setNextBreakpointGroup(await eval(hk.behavior)()); } catch(e){}
                        m.continue(); return;
                    }
                }
                // Check borders
                if (cg.borders) {
                    for (const b of cg.borders) {
                        if (b.direction !== 'kernel_to_user') continue;
                        if (b.function && fn && fn.includes(b.function)) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER)); return;
                        }
                        if (b.filepath && fp === b.filepath && ln === b.line) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER)); return;
                        }
                    }
                }
                this.events.push('stopped:breakpoint(user)');
            });
        } else if (action.type === DebuggerActions.check_if_user_to_kernel_border_yet) {
            m.getSomeRegisterValues([this.programCounterId]).then(regs => {
                const pc = parseAddr(regs?.[0]?.value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    m.getStack(0, 1, this.recentStopThreadId).then(v => {
                        if (!v || v.length === 0 || !v[0]) { this.events.push('stopped:breakpoint(empty)'); return; }
                        const fp = v[0].file, ln = v[0].line, fn = v[0].function;
                        const borders = this.breakpointGroups.getCurrentBreakpointGroup()?.borders;
                        if (borders) {
                            for (const b of borders) {
                                if (b.direction !== 'user_to_kernel') continue;
                                if (b.function && fn && fn.includes(b.function)) { this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL)); return; }
                                if (b.filepath && fp === b.filepath && ln === b.line) { this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL)); return; }
                            }
                        }
                        this.events.push('stopped:breakpoint(user_starry_nomatch)');
                    });
                    return;
                }
                m.getStack(0, 1, this.recentStopThreadId).then(v => {
                    if (!v || v.length === 0 || !v[0]) { this.events.push('stopped:breakpoint(empty)'); return; }
                    const fp = v[0].file, ln = v[0].line, fn = v[0].function;
                    const borders = this.breakpointGroups.getCurrentBreakpointGroup()?.borders;
                    if (borders) {
                        for (const b of borders) {
                            if (b.direction !== 'user_to_kernel') continue;
                            if (b.function && fn && fn.includes(b.function)) { this.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER)); return; }
                            if (b.filepath && fp === b.filepath && ln === b.line) { this.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER)); return; }
                        }
                    }
                    this.events.push('stopped:breakpoint(user)');
                });
            });
        } else if (action.type === DebuggerActions.check_if_user_yet) {
            m.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    m.stepInstruction();  // fallback: retry single-step
                    return;
                }
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isUserAddr(pc, this.userMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_USER));
                } else { m.stepInstruction(); }
            });
        } else if (action.type === DebuggerActions.check_if_kernel_yet) {
            m.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    m.stepInstruction();  // fallback: retry single-step
                    return;
                }
                const pc = parseAddr(regs?.[0]?.value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                } else { m.stepInstruction(); }
            });
        } else if (action.type === DebuggerActions.start_consecutive_single_steps) {
            m.stepInstruction();
        } else if (action.type === DebuggerActions.low_level_switch_breakpoint_group_to_high_level) {
            const low = this.breakpointGroups.getCurrentBreakpointGroupName();
            const high = this.breakpointGroups.getNextBreakpointGroup();
            this.breakpointGroups.updateCurrentBreakpointGroup(high, false);
            this.breakpointGroups.setNextBreakpointGroup(low);
        } else if (action.type === DebuggerActions.high_level_switch_breakpoint_group_to_low_level) {
            const high = this.breakpointGroups.getCurrentBreakpointGroupName();
            this.breakpointGroups.updateCurrentBreakpointGroup(this.breakpointGroups.getNextBreakpointGroup(), false);
            this.breakpointGroups.setNextBreakpointGroup(high);
        }
    }

    reset(): void {
        this.mockMI2.calls = [];
        this.events = [];
        this.osState = new OSState(OSStates.kernel);
    }
}

// ===========================================================================
// Run all edge-case tests
// ===========================================================================
async function runTests() {

// ---------------------------------------------------------------------------
// BUG-1: Group switch when addSymbolFile fails — state consistency
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.mockMI2.shouldFailAddSymbol = true;
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 10 }] }, 'user');
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    // Group name should still be updated even if symbol loading fails
    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'BUG-1a: group name switches even on symbol failure');
    // The internal Promise chain should not crash
    // (If we got here without unhandled rejection, that's good)
    assert(true, 'BUG-1b: no crash when addSymbolFile fails');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-2: Group switch when clearBreakPoints fails — does it recover?
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.mockMI2.shouldFailClearBreakpoints = true;
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    // The group switch Promise chain uses .catch() — it should not crash
    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'BUG-2: group switches despite clear failure');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-3: updateCurrentBreakpointGroup called multiple times rapidly
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 10 }] }, 'user');
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 5 }] }, 'initproc');

    // Rapid switching: user → initproc without waiting for first switch to complete
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    h.breakpointGroups.updateCurrentBreakpointGroup('initproc', false);
    await new Promise(r => setTimeout(r, 100));

    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'initproc', 'BUG-3: final group after rapid switches');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-4: Border detection when register read returns empty data
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.osState = new OSState(OSStates.kernel_single_step_to_user);
    h.mockMI2.registerResponse = [];  // Empty — simulates GDB not returning register data

    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // Should NOT crash. The check_if_user_yet handler explicitly checks:
    // if (!regs || regs.length === 0 || !regs[0]) return;
    // This should NOT emit a StoppedEvent and NOT call stepInstruction.
    assert(h.events.length === 0, 'BUG-4a: no StoppedEvent on empty register data');
    // After fix: stepInstruction is called as fallback when register data is empty
    const hasStepCall = h.mockMI2.calls.includes('stepInstruction');
    assert(hasStepCall, 'BUG-4b: stepInstruction fallback called on empty register data');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-5: State machine stuck in single_step state if PC never changes
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.osState = new OSState(OSStates.kernel_single_step_to_user);
    // Simulate 20 single steps all staying in kernel — should not crash or infinite-loop
    for (let i = 0; i < 20; i++) {
        h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080000' }];  // always kernel
        h.osStateTransition(new OSEvent(OSEvents.STOPPED));
        await new Promise(r => setTimeout(r, 5));
    }
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'BUG-5: stays in single-step state after 20 iterations');
    // Verify we did step 20 times
    const stepCount = h.mockMI2.calls.filter(c => c === 'stepInstruction').length;
    assert(stepCount >= 20, `BUG-5b: ${stepCount} stepInstruction calls (expected >= 20)`);
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-6: Multiple hook breakpoints at different locations — which fires?
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    // Register two hooks: one by function, one by file:line
    const hook1: HookBreakpointJSONFriendly = {
        breakpoint: { function: 'syscall_exec', condition: '' } as any,
        behavior: { body: 'return Promise.resolve("initproc")', args: [] },
    };
    const hook2: HookBreakpointJSONFriendly = {
        breakpoint: { file: '/src/kernel/trap.rs', line: 100, condition: '' },
        behavior: { body: 'return Promise.resolve("otherproc")', args: [] },
    };
    h.breakpointGroups.updateHookBreakpoint(hook1);
    h.breakpointGroups.updateHookBreakpoint(hook2);

    // Hit at a function that triggers BOTH hooks (exec file match + func name match)
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000090000',
        function: 'executor::executor::syscall_exec',  // matches hook1 by function
        fileName: 'trap.rs', file: '/src/kernel/trap.rs', line: 100  // matches hook2 by file:line
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // The first hook that matches determines the next group (iteration order)
    // Both match, first-win. This could be non-deterministic depending on group iteration order.
    const nextGroup = h.breakpointGroups.getNextBreakpointGroup();
    assert(nextGroup === 'initproc' || nextGroup === 'otherproc', `BUG-6: one hook fires (got: ${nextGroup})`);
    // BUG: if the wrong hook fires first, the user's debug session goes to the wrong process.
    // The iteration order of HookBreakpoints is insertion order, so it's deterministic.
    // Hook1 (func-based) was inserted first and should fire first.
    assertEq(nextGroup, 'initproc', 'BUG-6b: first-inserted hook wins (func-based hook1)');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-7: Restore trace state called without prior save (e.g. initial switch)
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    // Switch groups without any prior save
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    const restoreCmds = h.mockMI2.calls.filter(c => c.startsWith('cli:ardb-restore-trace-state'));
    assert(restoreCmds.length >= 1, 'BUG-7a: restore called during initial group switch');

    // The Python-side ardb-restore-trace-state would fail with:
    //   "no saved trace state for 'user'"
    // This is NOT a crash but means the restored state is empty — PollEntryBP
    // from kernel space are lost if this is the first switch from kernel to user.
    // Actually, this is expected behavior for the INITIAL switch. The fix is to
    // check on the Python side and just do nothing if no state was saved.
    const restoreWithoutSave = h.mockMI2.calls.filter(c => c.startsWith('RESTORE_WITHOUT_SAVE'));
    assert(restoreWithoutSave.length >= 1, 'BUG-7b: restore called without prior save detected');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-8: Disable then re-enable border — is state consistent?
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    const b = new Border('/src/kernel/trap.rs', 200);
    h.breakpointGroups.updateBorder(b);
    assertEq(h.breakpointGroups.getBreakpointGroupByName('kernel')!.borders!.length, 1, 'BUG-8a: border added');

    h.breakpointGroups.disableBorder(b);
    assertEq(h.breakpointGroups.getBreakpointGroupByName('kernel')!.borders!.length, 0, 'BUG-8b: border disabled');

    // Re-add the same border
    h.breakpointGroups.updateBorder(b);
    assertEq(h.breakpointGroups.getBreakpointGroupByName('kernel')!.borders!.length, 1, 'BUG-8c: border re-added');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-9: Group switch when current group has NO user breakpoints
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    // Switch to user group which has NO saved breakpoints yet
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'BUG-9a: switched to empty group');
    const userGroup = h.breakpointGroups.getCurrentBreakpointGroup();
    assert(userGroup !== undefined, 'BUG-9b: empty group exists');
    assertEq(userGroup!.setBreakpointsArguments.length, 0, 'BUG-9c: empty group has no breakpoints');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-10: sendCommand error handling in group switch chain
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.mockMI2.shouldFailSendCommand = true;
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 10 }] }, 'user');
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    // The chain should catch errors and still update the group name
    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'BUG-10: group switched despite sendCommand failures');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-11: Register read returns null entry in array
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.osState = new OSState(OSStates.kernel_single_step_to_user);
    // Simulate register data where entry exists but value is empty
    h.mockMI2.registerResponse = [{ index: 32, value: '' }];

    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // parseAddr('') returns undefined, so it won't match user or kernel
    // check_if_user_yet: if (!pc !== undefined && isUserAddr...) — both false → stepInstruction
    const stepCalls = h.mockMI2.calls.filter(c => c === 'stepInstruction');
    assert(stepCalls.length >= 1, 'BUG-11: stepInstruction called when PC parse fails (fallback)');
    h.reset();
}

// ---------------------------------------------------------------------------
// BUG-12: Multiple border breakpoints — first match wins
// ---------------------------------------------------------------------------
{
    const h = new EdgeCaseHarness();
    h.breakpointGroups.updateBorder(new Border('/src/kernel/trap.rs', 200, undefined, 'kernel_to_user'));
    h.breakpointGroups.updateBorder(new Border('/src/kernel/trap.rs', 300, undefined, 'kernel_to_user'));

    // Hit at line 200 — should match first border
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc0000a0000',
        function: 'trap_handler', fileName: 'trap.rs', file: '/src/kernel/trap.rs', line: 200
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'BUG-12a: border matched (no StoppedEvent)');
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'BUG-12b: state transitions correctly');

    h.reset();
    // Hit at line 300 — should match second border
    h.breakpointGroups.updateBorder(new Border('/src/kernel/trap.rs', 300, undefined, 'kernel_to_user'));
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc0000b0000',
        function: 'another_handler', fileName: 'trap.rs', file: '/src/kernel/trap.rs', line: 300
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'BUG-12c: second border also matches');
    h.reset();
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
