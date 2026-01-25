#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
// 从环境变量读取配置
const program = process.env.ARDB_PROGRAM;
const argsStr = process.env.ARDB_ARGS || '[]';
const cwd = process.env.ARDB_CWD || process.cwd();
const pythonPath = process.env.PYTHONPATH || '';
if (!program) {
    console.error('Error: ARDB_PROGRAM environment variable not set');
    process.exit(1);
}
let gdbProcess;
let rawData = Buffer.alloc(0);
// --- 核心：DAP 协议消息解析器 ---
process.stdin.on('data', (data) => {
    rawData = Buffer.concat([rawData, data]);
    while (true) {
        // 查找头部和正文的分隔符
        const contentStartIndex = rawData.indexOf('\r\n\r\n');
        if (contentStartIndex === -1)
            break;
        // 解析 Content-Length
        const header = rawData.toString('utf8', 0, contentStartIndex);
        const match = header.match(/Content-Length: (\d+)/);
        if (!match)
            break;
        const contentLength = parseInt(match[1], 10);
        const totalLength = contentStartIndex + 4 + contentLength;
        // 如果缓冲区数据不够一个完整的消息，继续等待
        if (rawData.length < totalLength)
            break;
        // 提取真正的 JSON 正文
        const messageStr = rawData.toString('utf8', contentStartIndex + 4, totalLength);
        rawData = rawData.slice(totalLength);
        try {
            const request = JSON.parse(messageStr);
            handleRequest(request);
        }
        catch (e) {
            console.error("DAP Parse Error:", e);
        }
    }
});
function handleRequest(request) {
    switch (request.command) {
        case 'initialize':
            sendResponse({
                type: 'response',
                request_seq: request.seq,
                success: true,
                command: 'initialize',
                body: {
                    supportsConfigurationDoneRequest: true,
                    supportsEvaluateForHovers: false
                }
            });
            // 发送初始化完成事件
            sendEvent('initialized');
            break;
        case 'launch':
            launchGDB();
            sendResponse({
                type: 'response',
                request_seq: request.seq,
                success: true,
                command: 'launch'
            });
            break;
        case 'disconnect':
            if (gdbProcess)
                gdbProcess.kill();
            sendResponse({
                type: 'response',
                request_seq: request.seq,
                success: true,
                command: 'disconnect'
            });
            process.exit(0);
            break;
        default:
            // 对所有不认识的请求也必须给予回复，防止 VS Code 挂起
            sendResponse({
                type: 'response',
                request_seq: request.seq,
                success: true,
                command: request.command
            });
    }
}
// --- 核心：带头部的消息发送函数 ---
function sendResponse(response) {
    const json = JSON.stringify(response);
    const message = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    process.stdout.write(message);
}
function sendEvent(event, body = {}) {
    const message = JSON.stringify({
        type: 'event',
        event: event,
        body: body
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}
function launchGDB() {
    const args = JSON.parse(argsStr);
    const gdbArgs = [
        '--interpreter=mi2',
        '-ex', `python import sys; sys.path.insert(0, '${pythonPath}'); import async_rust_debugger`,
        '-ex', 'set pagination off',
        program,
        ...args
    ];
    gdbProcess = (0, child_process_1.spawn)('gdb', gdbArgs, { cwd });
    // 注意：GDB 的输出绝不能直接转发到 process.stdout
    // 否则会破坏 DAP 协议。我们改用 console.error 打印到调试控制台
    gdbProcess.stdout?.on('data', (data) => {
        console.error(`[GDB Output]: ${data}`);
    });
    gdbProcess.stderr?.on('data', (data) => {
        console.error(`[GDB Error]: ${data}`);
    });
    gdbProcess.on('exit', () => {
        sendEvent('terminated');
    });
}
//# sourceMappingURL=gdbAdapter.js.map