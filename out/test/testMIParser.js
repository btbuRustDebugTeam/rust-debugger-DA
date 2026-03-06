"use strict";
/**
 * Quick smoke test for miParser.
 * Run with:  node out/test/testMIParser.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
const miParser_1 = require("../miParser");
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
// --- Prompt ---
{
    const r = (0, miParser_1.parseMILine)('(gdb)');
    assert(r !== undefined, 'prompt should parse');
    assertEq(r?.type, 'prompt', 'prompt type');
}
// --- Console stream ---
{
    const r = (0, miParser_1.parseMILine)('~"Hello world\\n"');
    assert(r !== undefined, 'console stream should parse');
    assertEq(r?.type, 'console-stream', 'console stream type');
    assertEq(r?.data.msg, 'Hello world\n', 'console stream content');
}
// --- Log stream ---
{
    const r = (0, miParser_1.parseMILine)('&"warning: something\\n"');
    assert(r !== undefined, 'log stream should parse');
    assertEq(r?.type, 'log-stream', 'log stream type');
    assertEq(r?.data.msg, 'warning: something\n', 'log stream content');
}
// --- Target stream ---
{
    const r = (0, miParser_1.parseMILine)('@"target output"');
    assert(r !== undefined, 'target stream should parse');
    assertEq(r?.type, 'target-stream', 'target stream type');
}
// --- Result: ^done (no data) ---
{
    const r = (0, miParser_1.parseMILine)('^done');
    assert(r !== undefined, '^done should parse');
    assertEq(r?.type, 'result', '^done type');
    assertEq(r?.cls, 'done', '^done class');
    assertEq(r?.token, undefined, '^done no token');
}
// --- Result: with token ---
{
    const r = (0, miParser_1.parseMILine)('42^done');
    assert(r !== undefined, 'token ^done should parse');
    assertEq(r?.token, 42, 'token value');
    assertEq(r?.cls, 'done', 'token ^done class');
}
// --- Result: ^error with msg ---
{
    const r = (0, miParser_1.parseMILine)('^error,msg="No symbol table"');
    assert(r !== undefined, '^error should parse');
    assertEq(r?.cls, 'error', '^error class');
    assertEq(r?.data.msg, 'No symbol table', '^error msg');
}
// --- Exec async: *stopped ---
{
    const r = (0, miParser_1.parseMILine)('*stopped,reason="breakpoint-hit",bkptno="1",frame={func="main",line="5"}');
    assert(r !== undefined, '*stopped should parse');
    assertEq(r?.type, 'exec-async', '*stopped type');
    assertEq(r?.cls, 'stopped', '*stopped class');
    assertEq(r?.data.reason, 'breakpoint-hit', '*stopped reason');
    assertEq(r?.data.bkptno, '1', '*stopped bkptno');
    assert(r?.data.frame !== undefined, '*stopped has frame');
    assertEq(r?.data.frame.func, 'main', '*stopped frame func');
    assertEq(r?.data.frame.line, '5', '*stopped frame line');
}
// --- Exec async: *running ---
{
    const r = (0, miParser_1.parseMILine)('*running,thread-id="all"');
    assert(r !== undefined, '*running should parse');
    assertEq(r?.type, 'exec-async', '*running type');
    assertEq(r?.cls, 'running', '*running class');
    assertEq(r?.data['thread-id'], 'all', '*running thread-id');
}
// --- Notify async: =thread-created ---
{
    const r = (0, miParser_1.parseMILine)('=thread-created,id="1",group-id="i1"');
    assert(r !== undefined, '=thread-created should parse');
    assertEq(r?.type, 'notify-async', '=thread-created type');
    assertEq(r?.cls, 'thread-created', '=thread-created class');
    assertEq(r?.data.id, '1', '=thread-created id');
}
// --- Result with list ---
{
    const r = (0, miParser_1.parseMILine)('5^done,threads=[{id="1",name="main"},{id="2",name="worker"}]');
    assert(r !== undefined, 'threads list should parse');
    assertEq(r?.token, 5, 'threads token');
    assert(Array.isArray(r?.data.threads), 'threads is array');
    assertEq(r?.data.threads.length, 2, 'threads count');
    assertEq(r?.data.threads[0].id, '1', 'thread 0 id');
    assertEq(r?.data.threads[1].name, 'worker', 'thread 1 name');
}
// --- Result with nested tuples ---
{
    const r = (0, miParser_1.parseMILine)('^done,frame={level="0",func="main",file="main.rs",fullname="/home/user/main.rs",line="10"}');
    assert(r !== undefined, 'nested frame should parse');
    assertEq(r?.data.frame.level, '0', 'frame level');
    assertEq(r?.data.frame.func, 'main', 'frame func');
    assertEq(r?.data.frame.file, 'main.rs', 'frame file');
    assertEq(r?.data.frame.line, '10', 'frame line');
}
// --- Escaped string with quotes ---
{
    const r = (0, miParser_1.parseMILine)('^error,msg="No symbol \\"foo\\" in scope"');
    assert(r !== undefined, 'escaped msg should parse');
    assertEq(r?.data.msg, 'No symbol "foo" in scope', 'escaped quotes');
}
// --- Stack frames list ---
{
    const r = (0, miParser_1.parseMILine)('10^done,stack=[frame={level="0",func="leaf"},frame={level="1",func="nonleaf"}]');
    assert(r !== undefined, 'stack list should parse');
    assertEq(r?.token, 10, 'stack token');
    assert(Array.isArray(r?.data.stack), 'stack is array');
    assertEq(r?.data.stack.length, 2, 'stack count');
    assertEq(r?.data.stack[0].level, '0', 'frame 0 level');
    assertEq(r?.data.stack[1].func, 'nonleaf', 'frame 1 func');
}
// --- Empty line ---
{
    const r = (0, miParser_1.parseMILine)('');
    assertEq(r, undefined, 'empty line returns undefined');
}
// --- Unrecognised line ---
{
    const r = (0, miParser_1.parseMILine)('some random text');
    assertEq(r, undefined, 'unrecognised line returns undefined');
}
// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    process.exit(1);
}
//# sourceMappingURL=testMIParser.js.map