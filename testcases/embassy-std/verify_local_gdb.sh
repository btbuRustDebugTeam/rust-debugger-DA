#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-/home/user/embassy/examples/std}
TESTCASE_DIR="$ROOT/testcases/embassy-std"
BINARY="$EMBASSY_STD_DIR/target/debug/tick"
LOG_DIR="$TESTCASE_DIR/temp/logs"
LOG="$LOG_DIR/local_gdb_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR" "$TESTCASE_DIR/temp"
if [[ ! -x "$BINARY" ]]; then
  "$TESTCASE_DIR/build_examples.sh" tick
fi

PYTHONPATH="$ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$TESTCASE_DIR/temp" \
timeout 30s gdb -q "$BINARY" -x "$TESTCASE_DIR/verify_tick.gdb" 2>&1 | tee "$LOG"
