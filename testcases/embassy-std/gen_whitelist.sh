#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-/home/user/embassy/examples/std}
BIN_NAME=${1:-tick}
TESTCASE_DIR="$ROOT/testcases/embassy-std"
BINARY="$EMBASSY_STD_DIR/target/debug/$BIN_NAME"
LOG_DIR="$TESTCASE_DIR/temp/logs"
LOG="$LOG_DIR/whitelist_${BIN_NAME}_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR" "$TESTCASE_DIR/temp"
if [[ ! -x "$BINARY" ]]; then
  "$TESTCASE_DIR/build_examples.sh" "$BIN_NAME"
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
