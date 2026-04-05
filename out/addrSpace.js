"use strict";
// Ported from code-debug src/mibase.ts (isKernelAddr / isUserAddr)
// Fix #18: uses BigInt instead of Number to avoid precision loss on 64-bit addresses.
//
// memory_ranges format: array of [start, end] pairs as hex/decimal strings, [start, end) half-open intervals.
// Example: [["0xffffffffc0000000", "0xffffffffffffffff"], ...]
Object.defineProperty(exports, "__esModule", { value: true });
exports.isKernelAddr = isKernelAddr;
exports.isUserAddr = isUserAddr;
exports.parseAddr = parseAddr;
function isKernelAddr(addr, kernel_memory_ranges) {
    for (const range of kernel_memory_ranges) {
        const lo = BigInt(range[0]);
        const hi = BigInt(range[1]);
        if (lo <= addr && addr < hi)
            return true;
    }
    return false;
}
function isUserAddr(addr, user_memory_ranges) {
    for (const range of user_memory_ranges) {
        const lo = BigInt(range[0]);
        const hi = BigInt(range[1]);
        if (lo <= addr && addr < hi)
            return true;
    }
    return false;
}
// Parse a hex register value string (e.g. "0x80200000") to BigInt.
// Returns undefined if the string is not a valid number.
function parseAddr(valueStr) {
    try {
        return BigInt(valueStr);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=addrSpace.js.map