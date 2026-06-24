#!/usr/bin/env bash
set -euo pipefail

ARD_ROOT=${ARD_ROOT:-/home/user/RustDebug/rust-debugger-DA}
LILOS_ROOT=${LILOS_ROOT:-/home/user/lilos}
LILOS_TESTSUITE_SRC=${LILOS_TESTSUITE_SRC:-$LILOS_ROOT/testsuite/src}
LILOS_ELF=${LILOS_ELF:-$LILOS_ROOT/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965}
TESTCASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMP_DIR="$TESTCASE_DIR/temp"
RAW="$TEMP_DIR/poll_functions.ardb-generated.$(date +%Y%m%d_%H%M%S).txt"
OUT="$TEMP_DIR/poll_functions.txt"

if [[ ! -d "$LILOS_TESTSUITE_SRC" ]]; then
    echo "[lilos] source directory not found: $LILOS_TESTSUITE_SRC" >&2
    exit 1
fi

if [[ ! -x "$LILOS_ELF" ]]; then
    echo "[lilos] debug ELF not found: $LILOS_ELF" >&2
    exit 1
fi

mkdir -p "$TEMP_DIR/logs"
echo "[lilos] source: $LILOS_TESTSUITE_SRC"
echo "[lilos] ELF:    $LILOS_ELF"

PYTHONPATH="$ARD_ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$TEMP_DIR" \
gdb-multiarch -q -batch "$LILOS_ELF" \
    -ex 'set pagination off' \
    -ex 'python import async_rust_debugger' \
    -ex 'ardb-gen-whitelist'

cp "$OUT" "$RAW"

# Keep only GDB-resolved observation points for the entry, executor, wake,
# task, and nested poll chain. The raw generator output remains beside it.
printf '%s\n' \
    '0 lilos_testsuite::run_test_suite' \
    '1 lilos::exec::run_tasks' \
    '2 lilos::exec::Notify::notify' \
    '3 lilos::exec::{impl#6}::poll' \
    '4 lilos_testsuite::task_coordinator::{async_fn#0}::{async_block#0}' \
    '5 lilos::time::{impl#8}::poll<lilos::time::sleep_until::{async_fn_env#0}, lilos_testsuite::task_coordinator::{async_fn#0}::{async_block_env#0}>' \
    > "$OUT"

echo "[lilos] raw Poll candidates: $RAW"
echo "[lilos] curated whitelist:  $OUT"
