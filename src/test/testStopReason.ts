/**
 * Regression tests for MI stop to DAP reason mapping.
 * Run with: node out/test/testStopReason.js
 */

import { mapMIStopToDAPReason } from '../gdbDebugSession';

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
    }
}

assertEq(
    mapMIStopToDAPReason('signal', 'SIGINT', true),
    'pause',
    'user Pause followed by SIGINT maps to pause',
);

assertEq(
    mapMIStopToDAPReason('signal', 'SIGINT', false),
    'exception',
    'target SIGINT without pending user Pause remains exception',
);

assertEq(
    mapMIStopToDAPReason('signal', 'SIGTERM', true),
    'exception',
    'non-SIGINT signal remains exception despite pending user Pause',
);

assertEq(
    mapMIStopToDAPReason('breakpoint', undefined, true),
    'breakpoint',
    'breakpoint winning a Pause race remains breakpoint',
);

assertEq(
    mapMIStopToDAPReason('step', undefined, true),
    'step',
    'step completion winning a Pause race remains step',
);

console.log(`Stop reason tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
