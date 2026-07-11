#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
TESTCASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BINARY="$TESTCASE_DIR/target/debug/no_runtime_futures"
LOG_DIR="$TESTCASE_DIR/temp/logs"
LOG="$LOG_DIR/whitelist_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR" "$TESTCASE_DIR/temp"

if [[ ! -x "$BINARY" ]]; then
  cargo build --manifest-path "$TESTCASE_DIR/Cargo.toml"
fi

PYTHONPATH="$ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$TESTCASE_DIR/temp" \
gdb -q --batch "$BINARY" \
  -ex 'set pagination off' \
  -ex 'set debuginfod enabled off' \
  -ex 'python import async_rust_debugger' \
  -ex 'ardb-gen-whitelist' \
  -ex quit 2>&1 | tee "$LOG"

echo "$TESTCASE_DIR/temp/poll_functions.txt"
