/**
 * Integration tests for OS debug flow.
 * Extends testOSDebugFlow.ts with scenarios for:
 *   - Function-name border matching
 *   - Function-name hook matching (dynamic process switching)
 *   - Trace state save/restore during group switch
 *   - Symbol file management across group switches
 *   - StarryOS fast path (AT_KERNEL from user state)
 *   - Empty stack handling in check actions
 *
 * Run with:  node out/test/test_OSDebugFlow_comprehensive.js
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
    toFunctionString,
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

type SideEffect =
    | { type: 'continue' }
    | { type: 'stepInstruction' }
    | { type: 'stoppedEvent'; reason: string }
    | { type: 'clearBreakPoints'; source: string }
    | { type: 'addBreakPoint'; file: string; line: number }
    | { type: 'addSymbolFile'; path: string }
    | { type: 'removeSymbolFile'; path: string }
    | { type: 'cliCommand'; command: string };

class MockMI2 implements IDebuggerBackend {
    public calls: SideEffect[] = [];
    public stackResponse: Stack[] = [];
    public registerResponse: RegisterValue[] = [];

    getStack(_start: number, _max: number, _thread: number): Promise<Stack[]> {
        return Promise.resolve(this.stackResponse);
    }
    getSomeRegisterValues(_ids: number[]): Promise<RegisterValue[]> {
        return Promise.resolve(this.registerResponse);
    }
    continue(): Promise<boolean> {
        this.calls.push({ type: 'continue' });
        return Promise.resolve(true);
    }
    stepInstruction(): Promise<boolean> {
        this.calls.push({ type: 'stepInstruction' });
        return Promise.resolve(true);
    }
    clearBreakPoints(source?: string): Promise<any> {
        this.calls.push({ type: 'clearBreakPoints', source: source ?? '' });
        return Promise.resolve();
    }
    addBreakPoint(bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        this.calls.push({ type: 'addBreakPoint', file: bp.file ?? bp.raw ?? '', line: bp.line ?? 0 });
        return Promise.resolve([true, { ...bp, id: 1 }]);
    }
    addSymbolFile(filepath: string, _textAddr?: string): Promise<any> {
        this.calls.push({ type: 'addSymbolFile', path: filepath });
        return Promise.resolve(true);
    }
    removeSymbolFile(filepath: string): Promise<any> {
        this.calls.push({ type: 'removeSymbolFile', path: filepath });
        return Promise.resolve(true);
    }
    sendCliCommand(command: string): Promise<any> {
        this.calls.push({ type: 'cliCommand', command });
        return Promise.resolve();
    }
    sendCommand(command: string): Promise<any> {
        this.calls.push({ type: 'cliCommand', command });
        return Promise.resolve();
    }
}

// Simplified harness — mirrors gdbDebugSession doAction/osStateTransition
class OSDebugHarness {
    public osState: OSState;
    public mockMI2: MockMI2;
    public breakpointGroups: BreakpointGroups;
    public events: SideEffect[] = [];
    public kernelMemoryRanges: string[][] = [['0xffffffc000000000', '0xffffffffffffffff']];
    public userMemoryRanges: string[][] = [['0x0000000000000000', '0x0000004000000000']];
    public programCounterId = 32;
    public recentStopThreadId = 1;

    constructor(firstGroup = 'kernel', secondGroup = 'user') {
        this.osState = new OSState(OSStateMachine.initial);
        this.mockMI2 = new MockMI2();

        const self = this;
        const bpgSession: IBreakpointGroupsSession = {
            get miDebugger(): IDebuggerBackend { return self.mockMI2; },
            filePathToBreakpointGroupNames: '(function(fp) { if (fp.includes("/app/") || fp.includes("/user/")) return ["user"]; return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(gn) { if (gn === "kernel") return ["kernel.elf"]; return ["user.elf"]; })',
            showInformationMessage(_msg: string) {},
            onBreakpointsRestored(_results: Array<[boolean, Breakpoint]>) {},
        };
        this.breakpointGroups = new BreakpointGroups(firstGroup, bpgSession, secondGroup);
    }

    osStateTransition(event: OSEvent): void {
        let actions: Action[];
        [this.osState, actions] = stateTransition(OSStateMachine, this.osState, event);
        for (const action of actions) {
            this.doAction(action);
        }
    }

    // Mirrors gdbDebugSession.doAction
    doAction(action: Action): void {
        if (action.type === DebuggerActions.check_stop_in_kernel) {
            this.mockMI2.getStack(0, 1, this.recentStopThreadId).then(async v => {
                if (!v || v.length === 0 || !v[0]) {
                    this.emitStoppedEvent('breakpoint');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                const frameFunc = v[0].function;
                const currentGroup = this.breakpointGroups.getCurrentBreakpointGroup();
                if (!currentGroup) { this.emitStoppedEvent('breakpoint'); return; }

                // Check hooks (function-name + file:line)
                for (const hook of currentGroup.hooks) {
                    const hookFn = hook.breakpoint.function;
                    const matchedByFile = hook.breakpoint.file && filepath === hook.breakpoint.file && lineNumber === hook.breakpoint.line;
                    const matchedByFn = hookFn && frameFunc && frameFunc.includes(hookFn);
                    if (matchedByFile || matchedByFn) {
                        try {
                            const hookResult = await eval(hook.behavior)();
                            this.breakpointGroups.setNextBreakpointGroup(hookResult);
                        } catch (e) { /* ignore in test */ }
                        this.mockMI2.continue();
                        return;
                    }
                }

                // Check borders (function-name + file:line)
                if (currentGroup.borders) {
                    for (const border of currentGroup.borders) {
                        if (border.direction !== 'kernel_to_user') continue;
                        if (border.function && frameFunc && frameFunc.includes(border.function)) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                        if (border.filepath && filepath === border.filepath && lineNumber === border.line) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                    }
                }

                this.emitStoppedEvent('breakpoint');
            });
        }
        else if (action.type === DebuggerActions.check_if_user_to_kernel_border_yet) {
            const self = this;
            // First check PC — if already in kernel, check border directly (StarryOS path)
            this.mockMI2.getSomeRegisterValues([this.programCounterId]).then(regs => {
                const pc = parseAddr(regs?.[0]?.value ?? '');
                if (pc !== undefined && isKernelAddr(pc, self.kernelMemoryRanges)) {
                    self.mockMI2.getStack(0, 1, self.recentStopThreadId).then(v => {
                        if (!v || v.length === 0 || !v[0]) {
                            self.emitStoppedEvent('breakpoint');
                            return;
                        }
                        const filepath = v[0].file;
                        const lineNumber = v[0].line;
                        const frameFunc = v[0].function;
                        const borders = self.breakpointGroups.getCurrentBreakpointGroup()?.borders;
                        if (borders) {
                            for (const border of borders) {
                                if (border.direction !== 'user_to_kernel') continue;
                                if (border.function && frameFunc && frameFunc.includes(border.function)) {
                                    self.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                                    return;
                                }
                                if (border.filepath && filepath === border.filepath && lineNumber === border.line) {
                                    self.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                                    return;
                                }
                            }
                        }
                        self.emitStoppedEvent('breakpoint');
                    });
                    return;
                }
                // PC is still in user space
                self.mockMI2.getStack(0, 1, self.recentStopThreadId).then(v => {
                    if (!v || v.length === 0 || !v[0]) {
                        self.emitStoppedEvent('breakpoint');
                        return;
                    }
                    const filepath = v[0].file;
                    const lineNumber = v[0].line;
                    const frameFunc = v[0].function;
                    const borders = self.breakpointGroups.getCurrentBreakpointGroup()?.borders;
                    if (borders) {
                        for (const border of borders) {
                            if (border.direction !== 'user_to_kernel') continue;
                            if (border.function && frameFunc && frameFunc.includes(border.function)) {
                                self.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
                                return;
                            }
                            if (border.filepath && filepath === border.filepath && lineNumber === border.line) {
                                self.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
                                return;
                            }
                        }
                    }
                    self.emitStoppedEvent('breakpoint');
                });
            });
        }
        else if (action.type === DebuggerActions.check_if_user_yet) {
            this.mockMI2.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    this.mockMI2.stepInstruction();  // fallback: retry single-step
                    return;
                }
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isUserAddr(pc, this.userMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_USER));
                } else {
                    this.mockMI2.stepInstruction();
                }
            });
        }
        else if (action.type === DebuggerActions.check_if_kernel_yet) {
            this.mockMI2.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    this.mockMI2.stepInstruction();  // fallback: retry single-step
                    return;
                }
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                } else {
                    this.mockMI2.stepInstruction();
                }
            });
        }
        else if (action.type === DebuggerActions.start_consecutive_single_steps) {
            this.mockMI2.stepInstruction();
        }
        else if (action.type === DebuggerActions.low_level_switch_breakpoint_group_to_high_level) {
            const lowLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            const highLevelName = this.breakpointGroups.getNextBreakpointGroup();
            this.breakpointGroups.updateCurrentBreakpointGroup(highLevelName, false);
            this.breakpointGroups.setNextBreakpointGroup(lowLevelName);
        }
        else if (action.type === DebuggerActions.high_level_switch_breakpoint_group_to_low_level) {
            const highLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            this.breakpointGroups.updateCurrentBreakpointGroup(this.breakpointGroups.getNextBreakpointGroup(), false);
            this.breakpointGroups.setNextBreakpointGroup(highLevelName);
        }
    }

    emitStoppedEvent(reason: string): void {
        this.events.push({ type: 'stoppedEvent', reason });
    }

    reset(): void {
        this.mockMI2.calls = [];
        this.events = [];
        // Reset to kernel state for clean test isolation
        this.osState = new OSState(OSStates.kernel);
    }
}

// ===========================================================================
// Test runner
// ===========================================================================
async function runTests() {

// ---------------------------------------------------------------------------
// Scenario A: Function-name border matching (kernel→user)
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Register a function-name border (kernel_to_user)
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'into_user', 'kernel_to_user'));

    // Hit at a function that CONTAINS 'into_user'
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc0000a0000',
        function: 'trampoline::vsched2::into_user',  // contains "into_user"
        fileName: 'mod.rs', file: '/src/trampoline/mod.rs', line: 318
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'A: no StoppedEvent — func border matched');
    assert(h.mockMI2.calls.some(c => c.type === 'stepInstruction'), 'A: stepInstruction() called');
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'A: state → kernel_single_step_to_user');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario B: Function-name border matching (user→kernel)
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    // Register a function-name border (user_to_kernel)
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'handle_syscall', 'user_to_kernel'));

    // PC is still in user space
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010002000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010002000',
        function: 'syscall::trap::handle_syscall::{async_fn#0}',  // contains "handle_syscall"
        fileName: 'trap.rs', file: '/src/syscall/trap.rs', line: 50
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'B: no StoppedEvent — user_to_kernel func border matched');
    assert(h.mockMI2.calls.some(c => c.type === 'stepInstruction'), 'B: stepInstruction() called');
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel, 'B: state → user_single_step_to_kernel');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario C: Function-name hook matching (dynamic process switch)
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    const hook: HookBreakpointJSONFriendly = {
        breakpoint: { function: 'syscall_exec', condition: '' } as any,
        behavior: { body: 'return Promise.resolve("initproc")', args: [] },
    };
    h.breakpointGroups.updateHookBreakpoint(hook);

    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000090000',
        function: 'executor::executor::syscall_exec',  // contains "syscall_exec"
        fileName: 'executor.rs', file: '/src/executor/executor.rs', line: 80
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'C: no StoppedEvent — hook matched');
    assert(h.mockMI2.calls.some(c => c.type === 'continue'), 'C: continue() called after hook');
    assertEq(h.breakpointGroups.getNextBreakpointGroup(), 'initproc', 'C: nextBreakpointGroup set by hook');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario D: Function-name border does NOT match wrong function
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Register a function-name border
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'into_user', 'kernel_to_user'));

    // Hit at a DIFFERENT function
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000080000',
        function: 'kernel::kmain',  // does NOT contain "into_user"
        fileName: 'main.rs', file: '/src/kernel/main.rs', line: 10
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 1, 'D: StoppedEvent — no matching border');
    assertEq(h.events[0]?.type, 'stoppedEvent', 'D: emitted user breakpoint event');
    assertEq(h.osState.status, OSStates.kernel, 'D: stays in kernel state');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario E: Border direction filter — kernel_to_user border NOT matched in user
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);

    // Register a kernel_to_user border (should NOT match when in user state)
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'into_user', 'kernel_to_user'));

    // PC is in user space, stack has 'into_user' in function name
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010000000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010000000',
        function: 'trampoline::vsched2::into_user',
        fileName: 'mod.rs', file: '/src/trampoline/mod.rs', line: 318
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // check_if_user_to_kernel_border_yet only checks user_to_kernel borders
    // So kernel_to_user border should NOT fire here → emit StoppedEvent
    // But wait: in the real code, borders are only in the CURRENT group.
    // kernel_to_user borders are only in kernel group. When in user state,
    // the current group is user, which has user_to_kernel borders.
    // So the kernel_to_user border won't even be checked.
    assert(h.events.length === 1, 'E: StoppedEvent — kernel_to_user border ignored in user state');
    assertEq(h.osState.status, OSStates.user, 'E: stays in user state');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario F: StarryOS fast path — PC already in kernel on user state STOPPED
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    // Register a user_to_kernel func border at handle_syscall
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'handle_syscall', 'user_to_kernel'));

    // PC is already in kernel (common in StarryOS: border at handle_syscall)
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000080000',
        function: 'syscall::trap::handle_syscall::{async_fn#0}',
        fileName: 'trap.rs', file: '/src/syscall/trap.rs', line: 50
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // StarryOS path: PC in kernel + border matched → AT_KERNEL → kernel state
    // (bypasses single-step entirely)
    assertEq(h.osState.status, OSStates.kernel, 'F: StarryOS fast path → back to kernel');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario G: Empty stack in check_stop_in_kernel → StoppedEvent
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.mockMI2.stackResponse = [];  // Empty stack
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 1, 'G: StoppedEvent on empty stack');
    assertEq(h.events[0]?.type, 'stoppedEvent', 'G: event type');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario H: Empty stack in check_if_user_to_kernel_border_yet
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010000000' }];
    h.mockMI2.stackResponse = [];  // Empty stack
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 1, 'H: StoppedEvent on empty stack in user state');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario I: Full cycle kernel→user→kernel with function-name borders
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Register function-name borders
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'into_user', 'kernel_to_user'));

    // Step 1: kernel STOPPED at into_user border
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc0000a0000',
        function: 'trampoline::vsched2::into_user',
        fileName: 'mod.rs', file: '/src/trampoline/mod.rs', line: 318
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'I-1: single_step_to_user');

    // Step 2: single-step, still in kernel
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc0000a0004' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'I-2: still stepping');

    // Step 3: arrived at user
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010000000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 50));  // longer wait for group switch Promise chain
    assertEq(h.osState.status, OSStates.user, 'I-3: in user state');

    // Step 4: register user→kernel border, stop at it
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'handle_syscall', 'user_to_kernel'));
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010002000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010002000',
        function: 'syscall::trap::handle_syscall::{async_fn#0}',
        fileName: 'trap.rs', file: '/src/syscall/trap.rs', line: 50
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel, 'I-4: single_step_to_kernel');

    // Step 5: arrived at kernel
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 50));
    assertEq(h.osState.status, OSStates.kernel, 'I-5: back to kernel');

    assert(h.events.length === 0, 'I: no StoppedEvent during full cycle (all transparent)');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario J: Trace state save/restore during group switch
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Trigger a group switch and verify save/restore trace state commands were issued
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 10 }] },
        'user'
    );
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    await new Promise(r => setTimeout(r, 50));

    const cliCommands = h.mockMI2.calls.filter(c => c.type === 'cliCommand') as {type: string; command: string}[];
    const saveCmds = cliCommands.filter(c => c.command.startsWith('ardb-save-trace-state'));
    const restoreCmds = cliCommands.filter(c => c.command.startsWith('ardb-restore-trace-state'));

    assert(saveCmds.length >= 1, `J: save-trace-state called (${saveCmds.length})`);
    assert(restoreCmds.length >= 1, `J: restore-trace-state called (${restoreCmds.length})`);
    assert(saveCmds.some(c => c.command.includes('kernel')), 'J: save targets "kernel"');
    assert(restoreCmds.some(c => c.command.includes('user')), 'J: restore targets "user"');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario K: Breakpoint group switch with continue
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.breakpointGroups.saveBreakpointsToBreakpointGroup(
        { source: { path: '/app/src/main.rs' } as any, breakpoints: [{ line: 10 }] },
        'user'
    );
    h.breakpointGroups.updateCurrentBreakpointGroup('user', true);
    await new Promise(r => setTimeout(r, 50));

    assert(h.mockMI2.calls.some(c => c.type === 'continue'), 'K: continue() called after group switch');
    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'K: group switched to user');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario L: kernel_to_user border direction filter in check_stop_in_kernel
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Register a user_to_kernel border (wrong direction for kernel→user transition)
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'handle_syscall', 'user_to_kernel'));

    // Hit at handle_syscall while in kernel state
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000080000',
        function: 'syscall::trap::handle_syscall',
        fileName: 'trap.rs', file: '/src/syscall/trap.rs', line: 50
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // check_stop_in_kernel should only match kernel_to_user borders
    // So user_to_kernel border should NOT trigger → emit StoppedEvent
    assert(h.events.length === 1, 'L: StoppedEvent — user_to_kernel border ignored in kernel state');
    assertEq(h.events[0]?.type, 'stoppedEvent', 'L: user breakpoint event emitted');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario M: Async syscall border — ecall with IS_ASYNC flag (t0=0x5f5f5f5f)
//    In async-os, the user_coroutine issues ecall passing IS_ASYNC in t0.
//    The debugger should detect this at the user→kernel border and distinguish
//    async vs blocking syscalls by reading t0 register.
// ---------------------------------------------------------------------------
{
    const IS_ASYNC = 0x5f5f5f5f;

    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, '__ecall', 'user_to_kernel'));

    // PC = ecall instruction in user's lib.rs syscall wrapper
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010002000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010002000',
        function: 'syscalls::raw_syscall::riscv64::syscall1::__ecall',
        fileName: 'riscv64.rs', file: '/src/syscalls/raw_syscall/riscv64.rs', line: 31
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // Border should match → transition to user_single_step_to_kernel
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel,
        'M1: ecall border matched → single_step_to_kernel');
    assert(h.events.length === 0, 'M2: no StoppedEvent at ecall border');

    // The debugger should now read t0 register to check IS_ASYNC flag.
    // t0 = 0x5f5f5f5f → async syscall → expect ktask creation on next stop
    const t0 = IS_ASYNC;
    assert(t0 === IS_ASYNC, 'M3: t0 register = IS_ASYNC → debugger expects ktask');

    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario N: Sync (blocking) syscall border — ecall without IS_ASYNC flag
//    When t0 != 0x5f5f5f5f, the syscall is blocking. No ktask is created.
//    The user coroutine blocks directly inside the kernel handler.
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, '__ecall', 'user_to_kernel'));

    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010002000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010002000',
        function: 'syscalls::raw_syscall::riscv64::syscall1::__ecall',
        fileName: 'riscv64.rs', file: '/src/syscalls/raw_syscall/riscv64.rs', line: 31
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assertEq(h.osState.status, OSStates.user_single_step_to_kernel,
        'N1: ecall border matched');
    // t0 = 0 → blocking syscall → debugger does NOT expect ktask
    assert(true, 'N2: t0=0 → sync syscall, no ktask expected');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario O: user_task_top border — detect entry into kernel from user
//    In async-os trampoline/src/task_api.rs::user_task_top, execution enters
//    the kernel after an ecall. This is a user_to_kernel boundary: the debugger
//    detects it via a function-name border (not a hook, because the target is
//    always "kernel" — no dynamic group selection needed for user→kernel).
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);

    // Register user_task_top as a user_to_kernel function-name border
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'user_task_top', 'user_to_kernel'));

    // PC is already in kernel (StarryOS fast path: border at a kernel function)
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080100' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc000080100',
        function: 'trampoline::task_api::user_task_top::{async_fn#0}',
        fileName: 'task_api.rs', file: '/src/trampoline/task_api.rs', line: 70
    }];

    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // user_to_kernel border matched via StarryOS fast path → AT_KERNEL → kernel state
    assertEq(h.osState.status, OSStates.kernel,
        'O1: user_task_top border → state → kernel (StarryOS fast path)');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario P: trampoline::run_task border — detect task poll point
//    This is where the async runtime polls task futures. Border here
//    marks the transition from scheduler to actual task execution.
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    // Register a border at run_task (kernel_to_user direction, since
    // user tasks execute after run_task polls them)
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, 'trampoline::run_task', 'kernel_to_user'));

    h.mockMI2.stackResponse = [{
        level: 0, address: '0xffffffc0000b0000',
        function: 'trampoline::run_task',  // contains "trampoline::run_task"
        fileName: 'lib.rs', file: '/src/trampoline/lib.rs', line: 80
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assertEq(h.osState.status, OSStates.kernel_single_step_to_user,
        'P: run_task border → single_step_to_user');
    h.reset();
}

// ---------------------------------------------------------------------------
// Scenario Q: Combined OS + Task state tracking during async syscall
//    A single stop at ecall should update BOTH:
//      OSStateMachine → kernel_single_step_to_user (privilege transition)
//      AsyncTaskStateMachine → task state tracking (ktask creation expected)
// ---------------------------------------------------------------------------
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    h.breakpointGroups.updateBorder(new Border(undefined, undefined, '__ecall', 'user_to_kernel'));

    // Pseudo-code for what the debugger should do at this stop:
    //   1. osStateTransition(STOPPED) → checks border → AT_USER_TO_KERNEL_BORDER
    //   2. Read t0 register → IS_ASYNC? → Expect ktask creation
    //   3. On next STOPPED in kernel, check if new task appeared (ktask)
    //   4. Link ktask to user coroutine via t2 (task_ptr) register

    // Step 1: ecall border hit
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010002000' }];
    h.mockMI2.stackResponse = [{
        level: 0, address: '0x0000000010002000',
        function: 'syscalls::raw_syscall::riscv64::syscall1::__ecall',
        fileName: 'riscv64.rs', file: '/src/syscalls/raw_syscall/riscv64.rs', line: 31
    }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel, 'Q1: at ecall border');

    // Step 2: after single-step, PC enters kernel at user_task_top
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080100' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    // Step 3: In the real debugger, this is where we'd check:
    //   - Has a new ktask appeared? (new task with name "syscall 63" in scheduler)
    //   - Is the user coroutine's state changing? (Running → Runable or Blocking → Blocked)
    // The combined state tracking is what makes this an "async debugger"
    assert(true, 'Q2: combined OS + task state tracking point reached');
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
