/**
 * Test BreakpointGroups save/restore trace-state integration.
 * Run with:  node out/test/testBreakpointGroupsTraceState.js
 */

import { BreakpointGroups, IBreakpointGroupsSession, IDebuggerBackend } from '../breakpointGroups';
import { Breakpoint } from '../backend/backend';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// Mock backend that records sendCliCommand calls
// ---------------------------------------------------------------------------
class MockBackend implements IDebuggerBackend {
    clearBreakPoints(_source?: string): Promise<any> { return Promise.resolve(); }
    addBreakPoint(_bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        return Promise.resolve([true, { id: 1, file: '', line: 1, condition: '' }]);
    }
    addSymbolFile(_fp: string, _ta?: string): Promise<any> { return Promise.resolve(true); }
    removeSymbolFile(_fp: string): Promise<any> { return Promise.resolve(true); }
    continue(_reverse?: boolean): Promise<boolean> { return Promise.resolve(true); }

    public cliCalls: string[] = [];
    sendCliCommand(command: string): Promise<any> {
        this.cliCalls.push(command);
        return Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// Test: IDebuggerBackend requires sendCliCommand
// ---------------------------------------------------------------------------
{
    const backend = new MockBackend();
    assert(typeof backend.sendCliCommand === 'function',
        'IDebuggerBackend has sendCliCommand method');
    assert(backend.cliCalls.length === 0,
        'MockBackend starts with empty call log');
}

// ---------------------------------------------------------------------------
// Test: sendCliCommand records calls correctly
// ---------------------------------------------------------------------------
{
    const backend = new MockBackend();
    backend.sendCliCommand('ardb-save-trace-state kernel');
    backend.sendCliCommand('ardb-restore-trace-state user');
    assert(backend.cliCalls[0] === 'ardb-save-trace-state kernel',
        'save command recorded');
    assert(backend.cliCalls[1] === 'ardb-restore-trace-state user',
        'restore command recorded');
    assert(backend.cliCalls.length === 2,
        'exactly two calls recorded');
}

// ---------------------------------------------------------------------------
// Test: BreakpointGroups can be constructed with mock session
// ---------------------------------------------------------------------------
{
    const backend = new MockBackend();
    const session: IBreakpointGroupsSession = {
        miDebugger: backend,
        filePathToBreakpointGroupNames: '(function(fp) { return [fp.includes("kernel") ? "kernel" : "user"]; })',
        breakpointGroupNameToDebugFilePaths: '(function(gn) { return []; })',
        showInformationMessage: (_msg: string) => {},
        onBreakpointsRestored: (_results: Array<[boolean, Breakpoint]>) => {},
    };
    const groups = new BreakpointGroups('kernel', session, 'user');
    assert(groups.getCurrentBreakpointGroupName() === 'kernel',
        'initial group name is kernel');
}

// ---------------------------------------------------------------------------
// Test: updateCurrentBreakpointGroup triggers save and restore
// ---------------------------------------------------------------------------
async function testUpdateWithSaveRestore(): Promise<void> {
    const backend = new MockBackend();
    const session: IBreakpointGroupsSession = {
        miDebugger: backend,
        filePathToBreakpointGroupNames: '(function(fp) { return [fp.includes("kernel") ? "kernel" : "user"]; })',
        breakpointGroupNameToDebugFilePaths: '(function(gn) { return []; })',
        showInformationMessage: (_msg: string) => {},
        onBreakpointsRestored: (_results: Array<[boolean, Breakpoint]>) => {},
    };
    const groups = new BreakpointGroups('kernel', session, 'user');

    // Switch from kernel to user (without continue).
    groups.updateCurrentBreakpointGroup('user', false);

    // save call is best-effort + fire-and-forget (no await in the method).
    // The Promise chain is internal.  Wait a tick for microtasks to flush.
    await new Promise(r => setTimeout(r, 50));

    // We expect at least the save command was issued.
    // The restore happens deep in the chain after symbol swap + re-insert,
    // and in this mock those resolve immediately, so all calls should be done.
    const saveCalls = backend.cliCalls.filter(c => c.startsWith('ardb-save-trace-state'));
    const restoreCalls = backend.cliCalls.filter(c => c.startsWith('ardb-restore-trace-state'));

    assert(saveCalls.length >= 1,
        `save called at least once (got ${saveCalls.length})`);
    assert(restoreCalls.length >= 1,
        `restore called at least once (got ${restoreCalls.length})`);

    // The save should target the old group.
    assert(saveCalls.some(c => c.includes('kernel')),
        'save targets old group "kernel"');
    // The restore should target the new group.
    assert(restoreCalls.some(c => c.includes('user')),
        'restore targets new group "user"');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
async function main() {
    await testUpdateWithSaveRestore();

    console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
