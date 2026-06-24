#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-/home/user/embassy/examples/std}
BIN_NAME=${1:-tick}
PORT=${2:-1234}
BINARY="$EMBASSY_STD_DIR/target/debug/$BIN_NAME"

if [[ ! -x "$BINARY" ]]; then
  "$ROOT/testcases/embassy-std/build_examples.sh" "$BIN_NAME"
fi

if command -v gdbserver >/dev/null 2>&1; then
  echo "[embassy-std] starting: gdbserver :$PORT $BINARY"
  exec gdbserver ":$PORT" "$BINARY"
fi

echo "[embassy-std] gdbserver is not installed; cannot provide target remote :$PORT." >&2
echo "[embassy-std] fallback: gdb -q $BINARY" >&2
echo "[embassy-std] install gdbserver for VS Code/GDB remote attach, or run ./verify_local_gdb.sh for the local-GDB validation path." >&2
exec gdb -q "$BINARY"
