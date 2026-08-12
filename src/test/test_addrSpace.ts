/**
 * Unit tests for addrSpace.ts.
 * Run with:  node out/test/test_addrSpace.js
 */

import { isKernelAddr, isUserAddr, parseAddr } from '../addrSpace';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

function assertEq(actual: any, expected: any, label: string): void {
    let ok: boolean;
    if (typeof actual === 'bigint' || typeof expected === 'bigint') {
        ok = String(actual) === String(expected);
    } else {
        ok = JSON.stringify(actual) === JSON.stringify(expected);
    }
    if (ok) { passed++; }
    else { failed++; console.error(`FAIL: ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`); }
}

const kernelRanges: string[][] = [
    ['0xffffffc000000000', '0xffffffffffffffff'],
];
const userRanges: string[][] = [
    ['0x0000000000000000', '0x0000004000000000'],
];

// ---------------------------------------------------------------------------
// parseAddr
// ---------------------------------------------------------------------------
{
    // hex string
    assertEq(parseAddr('0xffffffc000080000'), BigInt('0xffffffc000080000'), 'parseAddr: hex kernel addr');
    assertEq(parseAddr('0x0000000010000000'), BigInt('0x10000000'), 'parseAddr: hex user addr');
    assertEq(parseAddr('0x0'), 0n, 'parseAddr: zero');
    // decimal string
    assertEq(parseAddr('12345'), 12345n, 'parseAddr: decimal');
    // invalid
    assertEq(parseAddr('not_a_number'), undefined, 'parseAddr: invalid string → undefined');
    // After fix: parseAddr rejects empty string and returns undefined
    assertEq(parseAddr(''), undefined, 'parseAddr: empty string → undefined (fixed)');
}

// ---------------------------------------------------------------------------
// isKernelAddr — exact boundaries
// ---------------------------------------------------------------------------
{
    // Inside kernel range
    assert(isKernelAddr(0xffffffc000080000n, kernelRanges), 'isKernelAddr: typical kernel addr');
    assert(isKernelAddr(0xffffffc080200000n, kernelRanges), 'isKernelAddr: another kernel addr');
    // Lower bound (inclusive)
    assert(isKernelAddr(0xffffffc000000000n, kernelRanges), 'isKernelAddr: at lower bound (inclusive)');
    // Upper bound (exclusive) — NOT in range
    assert(!isKernelAddr(0xffffffffffffffffn, kernelRanges), 'isKernelAddr: at upper bound (exclusive)');
    // Just below lower bound
    assert(!isKernelAddr(0xffffffbfffffffffn, kernelRanges), 'isKernelAddr: just below kernel range');
    // User address in kernel ranges → false
    assert(!isKernelAddr(0x0000000010000000n, kernelRanges), 'isKernelAddr: user addr not kernel');
    // Zero
    assert(!isKernelAddr(0n, kernelRanges), 'isKernelAddr: zero is not kernel');
}

// ---------------------------------------------------------------------------
// isUserAddr — exact boundaries
// ---------------------------------------------------------------------------
{
    // Inside user range
    assert(isUserAddr(0x0000000010000000n, userRanges), 'isUserAddr: typical user addr');
    assert(isUserAddr(0x0000000004000000n, userRanges), 'isUserAddr: user ELF base');
    // Lower bound (inclusive)
    assert(isUserAddr(0n, userRanges), 'isUserAddr: at lower bound (inclusive, zero)');
    // Upper bound (exclusive)
    assert(!isUserAddr(0x0000004000000000n, userRanges), 'isUserAddr: at upper bound (exclusive)');
    // Kernel address in user ranges → false
    assert(!isUserAddr(0xffffffc000080000n, userRanges), 'isUserAddr: kernel addr not user');
}

// ---------------------------------------------------------------------------
// Multiple ranges
// ---------------------------------------------------------------------------
{
    const multiKernel: string[][] = [
        ['0xffffffc000000000', '0xffffffc080000000'],
        ['0xffffffc080200000', '0xffffffffffffffff'],
    ];
    // In first range
    assert(isKernelAddr(0xffffffc000080000n, multiKernel), 'multi-range: in first range');
    // In second range
    assert(isKernelAddr(0xffffffc080300000n, multiKernel), 'multi-range: in second range');
    // In gap between ranges
    assert(!isKernelAddr(0xffffffc080100000n, multiKernel), 'multi-range: in gap');
    // Before all ranges
    assert(!isKernelAddr(0xffffffbfffffffffn, multiKernel), 'multi-range: before all');
}

// ---------------------------------------------------------------------------
// Empty ranges → nothing matches
// ---------------------------------------------------------------------------
{
    assert(!isKernelAddr(0xffffffc000080000n, []), 'empty ranges: kernel never matches');
    assert(!isUserAddr(0x0000000010000000n, []), 'empty ranges: user never matches');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
