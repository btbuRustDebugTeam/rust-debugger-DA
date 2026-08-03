// src/debugAdapterStandalone.ts
// Standalone entry point for GDBDebugSession, following the @vscode/debugadapter
// runDebugAdapter pattern.
//
// Usage:
//   stdin/stdout mode:  node out/debugAdapterStandalone.js
//   TCP server mode:    node out/debugAdapterStandalone.js --server=4711
//
// Server mode is the recommended way to "调试调试器" (debug the debugger):
//   1. Launch this config in VS Code debug mode → adapter listens on port 4711
//   2. In the Extension Host window, add "debugServer": "localhost:4711" to
//      your launch.json (VS Code natively connects to the adapter, bypassing
//      the DebugAdapterDescriptorFactory)
//   3. Set breakpoints in GDBDebugSession, OSStateMachine, breakpointGroups, etc.

import * as Net from 'net';
import { GDBDebugSession } from './gdbDebugSession';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const pythonPath = process.env.PYTHONPATH || process.cwd();
const tempDir = process.env.ARDB_TEMP_DIR || process.cwd();

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
let port = 0;
const args = process.argv.slice(2);
args.forEach((val) => {
    const portMatch = /^--server=(\d{4,5})$/.exec(val);
    if (portMatch) {
        port = parseInt(portMatch[1], 10);
    }
});

// ---------------------------------------------------------------------------
// Start adapter
// ---------------------------------------------------------------------------
if (port > 0) {
    // TCP server mode — VS Code connects via "debugServer" in launch.json
    console.error(`[ARD Adapter] waiting for debug protocol on port ${port}`);
    Net.createServer((socket) => {
        console.error('[ARD Adapter] >> accepted connection from client');
        socket.on('end', () => {
            console.error('[ARD Adapter] >> client connection closed\n');
        });
        const session = new GDBDebugSession({ pythonPath, tempDir });
        session.setRunAsServer(true);
        session.start(socket, socket);
    }).listen(port);
} else {
    // stdin/stdout mode — VS Code launches this as an executable adapter
    console.error('[ARD Adapter] waiting for debug protocol on stdin/stdout');
    const session = new GDBDebugSession({ pythonPath, tempDir });
    process.on('SIGTERM', () => {
        session.shutdown();
    });
    session.start(process.stdin, process.stdout);
}
