#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-/home/user/embassy/examples/std}
BIN_NAME=${1:-tick}
LOG_DIR="$ROOT/testcases/embassy-std/temp/logs"
LOG="$LOG_DIR/build_${BIN_NAME}_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"
{
  echo "[embassy-std] building bin=$BIN_NAME"
  cd "$EMBASSY_STD_DIR"
  cargo build --bin "$BIN_NAME"
  echo "$EMBASSY_STD_DIR/target/debug/$BIN_NAME"
} 2>&1 | tee "$LOG"
