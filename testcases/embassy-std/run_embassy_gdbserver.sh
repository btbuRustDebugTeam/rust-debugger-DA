#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
TESTCASE_DIR="$ROOT/testcases/embassy-std"
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-/home/user/embassy/examples/std}
BIN_NAME=${1:-tick}
PORT=${2:-1234}

echo "[embassy-std] building bin=$BIN_NAME"
cd "$EMBASSY_STD_DIR"
cargo build --bin "$BIN_NAME"

cd "$TESTCASE_DIR"
echo "[embassy-std] generating whitelist for bin=$BIN_NAME"
"$TESTCASE_DIR/gen_whitelist.sh" "$BIN_NAME"

echo "[embassy-std] starting gdbserver for bin=$BIN_NAME on port=$PORT"
"$TESTCASE_DIR/run_example_gdbserver.sh" "$BIN_NAME" "$PORT"
