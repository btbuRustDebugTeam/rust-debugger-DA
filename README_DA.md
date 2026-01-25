# ARD Debug Adapter (DA) Implementation

This document describes the VS Code Debug Adapter implementation for the Async Rust Debugger.

## Overview

The Debug Adapter (DA) serves as a coordinator between the VS Code interface and the GDB backend (Python scripts). Its core task is to restore "broken physical execution frames" into "continuous logical async lifelines".

## Architecture

### Components

1. **Extension Entry Point** (`src/extension.ts`)
   - Activates the extension
   - Registers commands and debug session listeners
   - Manages the async inspector panel lifecycle

2. **Debug Adapter Factory** (`src/debugAdapter.ts`)
   - Manages GDB debug session instances
   - Provides access to active sessions for UI components

3. **GDB Debug Session** (`src/gdbDebugSession.ts`)
   - Communicates with GDB via VS Code debug session API
   - Executes ARD-specific commands (ardb-reset, ardb-gen-whitelist, etc.)
   - Reads snapshot data from files
   - Manages file watchers for whitelist auto-reload

4. **Async Inspector Panel** (`src/webview/asyncInspectorPanel.ts`)
   - Webview panel for displaying async execution trees
   - Handles user interactions (buttons, node selection)
   - Updates tree visualization from snapshot data

5. **Webview UI** (`src/webview/asyncInspector.js`, `asyncInspector.css`)
   - Frontend JavaScript for tree rendering
   - CSS styling for the inspector panel
   - Event handlers for user interactions

## Features

### 1. Async Inspector Panel

The panel displays:
- **Multi-root async trees**: Multiple independent execution trees if multiple entry points are traced
- **Node types**: Color-coded (red for async coroutines, green for sync functions)
- **Metadata**: Each node shows CID, Poll Count, and State
- **Thread context**: Shows which OS thread executed the current path
- **Log preview**: Displays last few log entries for selected CID

### 2. Button Commands

| Button | Backend Command | Behavior |
|--------|---------------|----------|
| Reset | `ardb-reset` | Deletes all breakpoints, resets CID counter, clears `ardb.log` |
| Gen Whitelist | `ardb-gen-whitelist` | Triggers static analysis, generates whitelist, opens file |
| Snapshot | `ardb-get-snapshot` | Gets current async+sync call stack JSON |
| Trace | `ardb-trace <sym>` | Adds target function to trace roots |

### 3. Whitelist Management

- **Auto-generation**: Click "Gen Whitelist" to scan and generate `poll_functions.txt`
- **Auto-reload**: File watcher automatically reloads whitelist when file is saved
- **Candidates panel**: Shows all whitelist functions with Trace and Locate buttons

### 4. Frame Switching

When clicking a coroutine node in the tree:
- DA tells VS Code to switch the selected frame to the corresponding physical frame
- VS Code's native variable panel automatically refreshes
- Shows all variables within that coroutine

## Communication Protocol

### Snapshot Data Format

The DA parses JSON output from `ardb-get-snapshot`:

```json
{
  "thread_id": 1,
  "path": [
    {
      "type": "async",
      "cid": 1,
      "func": "minimal::nonleaf::{async_fn#0}",
      "addr": "0x7fffffffd0c4",
      "poll": 2,
      "state": 3
    },
    {
      "type": "sync",
      "cid": null,
      "func": "minimal::sync_a",
      "addr": "0x55555556a014",
      "state": "NON-ASYNC"
    }
  ]
}
```

### File-based Communication

Since direct GDB command output capture through DAP is limited, the implementation uses file-based communication:

- **Snapshots**: Written to `temp/ardb_snapshot.json` by the Python script
- **Logs**: Written to `temp/ardb.log` by the Python script
- **Whitelist**: Read from `temp/poll_functions.txt`

## Development Notes

### GDB Command Execution

The current implementation attempts to execute GDB commands via the debug session's `customRequest` API. However, this may not work with all debug adapters. The implementation includes fallbacks:

1. Try to execute via `customRequest('evaluate', ...)`
2. If that fails, read from files (if commands were executed manually in GDB console)
3. Use last known snapshot if file read fails

### Future Improvements

1. **Full DAP Implementation**: Implement a complete DAP server that communicates directly with GDB via MI protocol
2. **Better Command Execution**: Use GDB MI protocol directly for more reliable command execution
3. **Real-time Updates**: Implement event-driven updates instead of polling
4. **Tree History**: Maintain execution history to build accurate tree structures

## Building and Testing

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile TypeScript:
   ```bash
   npm run compile
   ```

3. Open in VS Code and press F5 to launch extension development host

4. Create a launch configuration:
   ```json
   {
     "type": "ardb",
     "request": "launch",
     "name": "Debug Rust",
     "program": "${workspaceFolder}/testcases/minimal/target/debug/minimal"
   }
   ```

5. Start debugging - the Async Inspector panel should open automatically

## Integration with GDB Backend

The DA works with the existing GDB Python scripts:

1. **Initialization**: GDB must be started with `python import async_rust_debugger`
2. **Commands**: All `ardb-*` commands are available in GDB
3. **File Output**: Python scripts write snapshots and logs to the temp directory
4. **Environment**: Set `ASYNC_RUST_DEBUGGER_TEMP_DIR` environment variable

## Limitations

- Command execution relies on debug adapter support for custom requests
- Snapshot updates are file-based and may have slight delays
- Tree building is simplified and may not capture all execution history
- Frame switching requires proper DAP frame support
