#!/usr/bin/env node

/**
 * GDB Debug Adapter - A minimal DAP server that launches GDB with ARD Python scripts.
 * 
 * This is a minimal implementation that implements basic DAP protocol to allow
 * VS Code to start a debug session. It communicates with GDB via MI protocol.
 */

import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

// Read configuration from environment
const program = process.env.ARDB_PROGRAM;
const argsStr = process.env.ARDB_ARGS || '[]';
const cwd = process.env.ARDB_CWD || process.cwd();

if (!program) {
    console.error('Error: ARDB_PROGRAM environment variable not set');
    process.exit(1);
}

// Get workspace folder from environment
const workspaceFolder = process.env.ASYNC_RUST_DEBUGGER_TEMP_DIR 
    ? path.dirname(process.env.ASYNC_RUST_DEBUGGER_TEMP_DIR)
    : path.dirname(program);

const pythonPath = path.join(workspaceFolder, 'async_rust_debugger');

// Minimal DAP server implementation
// This handles basic DAP protocol messages via stdin/stdout

let gdbProcess: child_process.ChildProcess | undefined;

// Handle DAP initialize request
process.stdin.on('data', (data: Buffer) => {
    const message = data.toString();
    const lines = message.split('\r\n');
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
            const request = JSON.parse(line);
            
            if (request.command === 'initialize') {
                // Respond to initialize
                const response = {
                    type: 'response',
                    request_seq: request.seq,
                    success: true,
                    command: 'initialize',
                    body: {
                        supportsConfigurationDoneRequest: true,
                        supportsEvaluateForHovers: false,
                        supportsSetVariable: false
                    }
                };
                sendResponse(response);
            } else if (request.command === 'launch') {
                // Launch GDB
                launchGDB();
                const response = {
                    type: 'response',
                    request_seq: request.seq,
                    success: true,
                    command: 'launch'
                };
                sendResponse(response);
            } else if (request.command === 'configurationDone') {
                // Configuration done
                const response = {
                    type: 'response',
                    request_seq: request.seq,
                    success: true,
                    command: 'configurationDone'
                };
                sendResponse(response);
            } else if (request.command === 'disconnect') {
                // Disconnect
                if (gdbProcess) {
                    gdbProcess.kill();
                }
                const response = {
                    type: 'response',
                    request_seq: request.seq,
                    success: true,
                    command: 'disconnect'
                };
                sendResponse(response);
                process.exit(0);
            }
        } catch (e) {
            // Ignore parse errors
        }
    }
});

function sendResponse(response: any) {
    const message = JSON.stringify(response) + '\r\n';
    process.stdout.write(message);
}

function launchGDB() {
    const args = JSON.parse(argsStr);
    
    // Build GDB command with Python script initialization
    const gdbArgs = [
        '--interpreter=mi2',
        '-ex', `python import sys; sys.path.insert(0, '${pythonPath}'); import async_rust_debugger`,
        '-ex', 'set pagination off',
        '-ex', 'set debuginfod enabled off',
        program,
        ...args
    ];

    gdbProcess = spawn('gdb', gdbArgs, {
        cwd: cwd,
        env: {
            ...process.env,
            PYTHONPATH: pythonPath,
            ASYNC_RUST_DEBUGGER_TEMP_DIR: path.join(workspaceFolder, 'temp')
        }
    });

    // Forward GDB MI output to stdout (for DAP)
    gdbProcess.stdout?.on('data', (data) => {
        process.stdout.write(data);
    });

    gdbProcess.stderr?.on('data', (data) => {
        process.stderr.write(data);
    });

    gdbProcess.on('exit', (code) => {
        // Send terminated event
        const event = {
            type: 'event',
            event: 'terminated'
        };
        sendResponse(event);
    });
}
